/**
 * 自动盐场 · 编排层
 *
 * 执行单位是「队伍」（= 一个队长角色 = 一条主连接 + 一条战场连接）。
 * 为什么不是「俱乐部」或「账号」：roleMap 按「连接所属俱乐部」下发，
 * 一个连接只覆盖它自己俱乐部的成员，所以一支队伍必须有自己的连接。
 * 见 docs/saltfield-auto-ui-design.md §1.5 / §2。
 *
 * 本文件遵守项目既有的 createTasksXxx(deps) 契约，直接复用批量日常的
 * 连接排队、超时重连、日志、停止开关，不重复造轮子。
 */
import { LegionWarSession, buildLegionWarUrl } from "@/utils/legionWarSession";
import { getInviteReadiness } from "@/utils/legionWarState";
import * as cfg from "@/utils/saltFieldConfig";

/** 战场连接槽位（与批量主连接的 maxActive 分开限流） */
export const battlefieldQueue = { active: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 兼容 ref / 裸数组 */
const toArray = (v) => (Array.isArray(v) ? v : v?.value || []);

/** 把 role_getroleinfo 的响应归一化成 role 对象（项目里存在 res.role 与 res 两种形态） */
function pickRole(resp) {
  return resp?.role || resp || null;
}

/** 把 role_getroleinfo 的主阵容转成 wire 需要的 Map<位置, 英雄ID> */
function toBattleTeamMap(battleTeam) {
  if (!battleTeam) return null;
  const map = new Map();
  for (const key of Object.keys(battleTeam)) {
    const slot = Number(key);
    const v = battleTeam[key];
    const heroId = Number(v && typeof v === "object" ? v.heroId : v);
    if (Number.isFinite(slot) && Number.isFinite(heroId) && heroId > 0) map.set(slot, heroId);
  }
  return map.size > 0 ? map : null;
}

/** 从 role 对象提取布阵三件套 */
function pickLineup(role) {
  const battleTeam = toBattleTeamMap(role?.battleTeam);
  const lordWeaponId = Number(role?.lordWeaponId ?? role?.lordWeapon?.id ?? 0);
  const petUId = role?.pet?.petUId || role?.petUId || "";
  return { battleTeam, lordWeaponId, petUId };
}

/** info.members（对象，key=roleId）→ 数组 */
function rosterToArray(members) {
  if (!members) return [];
  return Object.keys(members).map((roleId) => {
    const m = members[roleId] || {};
    return {
      roleId: Number(roleId),
      name: m.name || "",
      power: Number(m.power || 0),
      online: m.online,
    };
  });
}

/** 取某个 token 的主连接；返回该连接上的 role 对象 */
async function loadRoleInfo(tokenStore, tokenId) {
  const resp = await tokenStore.sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 8000);
  return pickRole(resp);
}

/** 取某个 token 所属俱乐部的信息（legion_getinfo 无参数，返回的就是调用者自己的俱乐部） */
async function loadOwnLegion(tokenStore, tokenId) {
  const resp = await tokenStore.sendMessageWithPromise(tokenId, "legion_getinfo", {}, 8000);
  return resp?.info || resp?.legionData || pickRole(resp) || null;
}

export function createTasksSaltField(deps) {
  const {
    tokens = null,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot,
    connectionQueue,
    batchSettings = {},
    tokenStore,
    addLog,
    message,
  } = deps;

  const settings = () => cfg.getSettings();
  const tokenList = () => toArray(tokens) || [];
  const findToken = (tokenId) =>
    tokenList().find((t) => String(t.id) === String(tokenId)) ||
    toArray(tokenStore?.gameTokens).find((t) => String(t.id) === String(tokenId)) ||
    null;

  const log = (text, type = "info") =>
    addLog?.({ time: new Date().toLocaleTimeString(), message: text, type });

  const tag = (team) => `[${team?.legionId ?? "?"} / ${team?.name || team?.leaderTokenId}]`;

  /* -------------------- 战场连接槽位 -------------------- */

  const waitBattlefieldSlot = async () => {
    const max = Math.max(1, Number(settings().maxActiveBattlefield) || 3);
    while (battlefieldQueue.active >= max) {
      await sleep(500);
    }
    battlefieldQueue.active++;
  };

  const releaseBattlefieldSlot = () => {
    if (battlefieldQueue.active > 0) battlefieldQueue.active--;
  };

  /* -------------------- ① 同步角色信息 -------------------- */

  /**
   * 遍历「队长清单」里的 token，读取 roleId / legionId / legionName / 角色名并写入缓存。
   * 这是把「俱乐部」推导出来的唯一来源，用户不需要手填 legionId。
   */
  const syncSaltFieldRoles = async () => {
    const leaderIds = cfg.getLeaderTokenIds();
    if (leaderIds.length === 0) {
      message?.warning?.("还没有选择任何队长角色，请先在 Token 管理里勾选");
      return { ok: 0, failed: 0 };
    }

    if (isRunning) isRunning.value = true;
    if (shouldStop) shouldStop.value = false;

    log(`=== 开始同步 ${leaderIds.length} 个队长角色 ===`, "info");
    let ok = 0;
    let failed = 0;

    await Promise.all(
      leaderIds.map(async (tokenId) => {
        if (shouldStop?.value) return;
        const token = findToken(tokenId);
        const label = token?.name || tokenId;
        try {
          await ensureConnection(tokenId);
          const role = await loadRoleInfo(tokenStore, tokenId);
          if (!role) throw new Error("role_getroleinfo 未返回角色");

          let legionName = "";
          let legionId = Number(role.legionId || 0);
          try {
            const legion = await loadOwnLegion(tokenStore, tokenId);
            if (legion) {
              legionId = Number(legion.id ?? legionId) || legionId;
              legionName = legion.name || "";
            }
          } catch (e) {
            log(`${label} 读取俱乐部名失败（不致命）: ${e?.message || e}`, "warning");
          }

          cfg.setRoleCacheEntry(tokenId, {
            roleId: Number(role.roleId || 0),
            roleName: role.name || token?.name || "",
            legionId,
            legionName,
            serverId: Number(role.serverId || 0),
            serverName: role.serverName || "",
          });
          ok++;
          log(`${label} → ${role.name} (roleId ${role.roleId}) · 俱乐部 ${legionId} ${legionName}`, "success");
        } catch (e) {
          failed++;
          log(`${label} 同步失败: ${e?.message || e}`, "error");
        } finally {
          try {
            tokenStore.closeWebSocketConnection(tokenId);
          } catch {
            /* ignore */
          }
          releaseConnectionSlot?.();
        }
      }),
    );

    const { teams, added, removed } = cfg.reconcileTeams();
    if (added.length) log(`新增 ${added.length} 支队伍（按新队长）`, "info");
    if (removed.length) log(`移除 ${removed.length} 支队伍（队长已取消）`, "info");
    log(`=== 同步完成：成功 ${ok} / 失败 ${failed}，当前 ${teams.length} 支队伍 ===`, ok ? "success" : "warning");

    if (isRunning) isRunning.value = false;
    return { ok, failed, teams };
  };

  /* -------------------- ①½ 只读名册（不依赖战场，开战前后都可用） -------------------- */

  /**
   * 用「常规方式」拉本俱乐部成员名单：主连接 legion_getinfo（无参数，返回调用者自己的俱乐部）。
   *
   * master 2026-09-16 定稿：提前编队发生在开战之前，此时进不了战场
   * （legion_getbattlefield / war_enterbattlefield 都不可用），所以编辑弹窗的
   * 「加载俱乐部成员」绝不能走战场探测（probeSaltFieldTeam）。
   * cId 不在这里取 —— 执行时用本场 roleMap 现算（抓包证实开战时按名册全量分配）。
   */
  const loadSaltFieldRoster = async (team) => {
    const t = tag(team);
    const tokenId = team.leaderTokenId;
    const token = findToken(tokenId);
    if (!token) throw new Error(`找不到队长 token: ${tokenId}`);

    try {
      await ensureConnection(tokenId);
      const role = await loadRoleInfo(tokenStore, tokenId);
      if (!role) throw new Error("role_getroleinfo 未返回角色");

      const legion = await loadOwnLegion(tokenStore, tokenId);
      if (!legion) throw new Error("legion_getinfo 未返回俱乐部信息");

      const legionId = Number(legion.id || role.legionId || 0);
      const legionName = legion.name || "";
      const roster = rosterToArray(legion.members);

      cfg.setRoleCacheEntry(tokenId, {
        roleId: Number(role.roleId || 0),
        roleName: role.name || token.name,
        legionId,
        legionName,
        serverId: Number(role.serverId || 0),
        serverName: role.serverName || "",
      });

      log(`${t} 名册加载完成：${legionName || legionId} 共 ${roster.length} 人（仅主连接，未进战场）`, "info");
      return { tokenId, roleId: Number(role.roleId || 0), legionId, legionName, roster };
    } finally {
      try {
        tokenStore.closeWebSocketConnection(tokenId);
      } catch {
        /* ignore */
      }
      releaseConnectionSlot?.();
    }
  };

  /* -------------------- ② 探测：连接 + 进战场 + 建候选池（不改状态） -------------------- */

  /**
   * 只做「连接 → 读角色/名册 → 进战场 → 读 roleMap」，不发送任何组队/布阵命令。
   * 用于界面预览候选池，以及正式执行前的前置校验。
   */
  const probeSaltFieldTeam = async (team, { logPrefix = "" } = {}) => {
    const t = tag(team);
    const tokenId = team.leaderTokenId;
    const token = findToken(tokenId);
    if (!token) throw new Error(`找不到队长 token: ${tokenId}`);

    await ensureConnection(tokenId);
    const role = await loadRoleInfo(tokenStore, tokenId);
    if (!role) throw new Error("role_getroleinfo 未返回角色");

    const legion = await loadOwnLegion(tokenStore, tokenId);
    const legionId = Number(legion?.id || role.legionId || 0);
    const legionName = legion?.name || "";
    const roster = rosterToArray(legion?.members);
    const lineup = pickLineup(role);

    const bf = await tokenStore.sendMessageWithPromise(tokenId, "legion_getbattlefield", {}, 10000);
    const info = bf?.info || null;
    if (!info?.battlefieldId) throw new Error("legion_getbattlefield 未返回 battlefieldId");
    if (info.canEnterWar === false) {
      throw new Error(`本场未开放进入（canEnterWar=false），battlefieldId=${info.battlefieldId}`);
    }

    await waitBattlefieldSlot();
    const session = new LegionWarSession({
      url: buildLegionWarUrl(token.token, info.sid),
      battlefieldId: info.battlefieldId,
      heartbeatMs: 5000,
      onTimeout: (label) => logPrefix && log(`${t} 等待 ${label} 超时`, "warning"),
    });

    try {
      await session.init();
      const entered = await session.enterBattlefield(Number(settings().enterTimeoutMs) || 15000);
      if (!entered.ok) throw new Error("进入战场超时（未拿到 roleCodeId）");

      const myCid = session.roleCodeId;
      const ownRoleId = Number(role.roleId || 0);
      const roleMap = session.roleMap || {};

      cfg.setRoleCacheEntry(tokenId, {
        roleId: ownRoleId,
        roleName: role.name || token.name,
        legionId,
        legionName,
        serverId: Number(role.serverId || 0),
        serverName: role.serverName || "",
      });

      return {
        ok: true,
        tokenId,
        tokenName: token.name,
        roleId: ownRoleId,
        roleName: role.name,
        legionId,
        legionName,
        roster,
        lineup,
        roleMap,
        myCid,
        battlefieldId: info.battlefieldId,
        activityWindow: {
          start: Number(info.startTime || 0),
          end: Number(info.endTime || 0),
          phase: info.phase || "",
        },
        teamMemberCids: session.teamMemberCids(myCid),
        session,
      };
    } catch (e) {
      session.close();
      releaseBattlefieldSlot();
      try {
        tokenStore.closeWebSocketConnection(tokenId);
      } catch {
        /* ignore */
      }
      releaseConnectionSlot?.();
      throw e;
    }
  };

  /** 探测完请务必收尾，释放两条连接的槽位 */
  const closeProbe = (probe) => {
    try {
      probe?.session?.close();
    } catch {
      /* ignore */
    }
    releaseBattlefieldSlot();
    try {
      tokenStore.closeWebSocketConnection(probe.tokenId);
    } catch {
      /* ignore */
    }
    releaseConnectionSlot?.();
  };

  /** 仅预览候选池（界面用）：探测 + 计算 + 立刻收尾 */
  const previewSaltFieldTeamCandidates = async (team) => {
    const probe = await probeSaltFieldTeam(team);
    try {
      const teams = cfg.getTeams();
      const siblingOccupied = teams
        .filter((x) => String(x.leaderTokenId) !== String(team.leaderTokenId))
        .filter((x) => Number(x.legionId) === Number(probe.legionId))
        .flatMap((x) => [...(x.memberRoleIds || [])]);
      const cache = cfg.getRoleCache();
      const ownRoleId = Number(cache[String(team.leaderTokenId)]?.roleId || 0);
      const pool = cfg.buildCandidatePool({
        roster: probe.roster,
        roleMap: probe.roleMap,
        excludeRoleIds: [ownRoleId, ...(team.memberRoleIds || []), ...siblingOccupied],
      });
      return { probe, pool, siblingOccupied };
    } finally {
      closeProbe(probe);
    }
  };

  /* -------------------- ③ 执行单支队伍 -------------------- */

  /**
   * 一支队伍的完整流程：进战场 → 选阵容 → 组队 → 登场 → 校验。
   *
   * 执行模式（team.mode，master 2026-09-16 定稿）：
   *   · immediate 立即：拉一次可组队清单；指定队员不在清单的直接放弃；
   *     开机动则按优先级从候选池补人（不强制补满 5 人），不开机动不补人；组完即登场。
   *   · wait 等待：持续刷新可组队清单，指定队员「出现」（未登场且未被任何队伍组走，
   *     即战场 state=watching）一个就组一个，直到全部组上再登场；一直等，不自动收尾
   *     （手动停止 = 按当前已组队伍登场）；忽略机动开关。
   *
   * @returns {object} 结果对象（不再抛错，失败信息在结果里）
   */
  const runOneSaltFieldTeam = async (team) => {
    const t = tag(team);
    const mode = team.mode === "wait" ? "wait" : "immediate";
    const startedAt = Date.now();
    const result = {
      teamId: team.id,
      legionId: team.legionId,
      leaderTokenId: team.leaderTokenId,
      mode,
      ok: false,
      stage: "init",
      invited: [],
      failed: [],
      teamMembers: [],
      error: "",
    };

    let probe = null;
    try {
      // 1) 连接 + 定俱乐部 + 拿阵容 + roleMap（复用探测流程，避免逻辑分叉）
      result.stage = "probe";
      probe = await probeSaltFieldTeam(team);
      const { legionId, legionName, lineup, roleMap, myCid, roleId } = probe;
      const ownRoleId = Number(roleId || 0);

      log(
        `${t} 进入战场 ${probe.battlefieldId} · ${legionName || legionId} · 自身 cId ${myCid}` +
          ` · 模式：${mode === "wait" ? "等待" : "立即"}`,
        "info",
      );
      log(`${t} roleMap ${Object.keys(roleMap).length} 人（本俱乐部）`, "info");

      if (!lineup.battleTeam) {
        throw new Error("角色没有可用的主阵容（battleTeam 为空），请先在游戏里配置阵容");
      }

      const teams = cfg.getTeams();
      const siblingOccupied = teams
        .filter((x) => String(x.leaderTokenId) !== String(team.leaderTokenId))
        .filter((x) => Number(x.legionId) === Number(legionId))
        .flatMap((x) => [...(x.memberRoleIds || [])]);

      const specifiedAll = [...new Set((team.memberRoleIds || []).map(Number))].filter(
        (r) => r && r !== ownRoleId,
      );
      // 队伍硬上限 5 人 = 1 队长 + 4 队员（master 2026-09-16 强调）；配置写超时这里兜底截断
      const specified = specifiedAll.slice(0, 4);
      if (specifiedAll.length > 4) {
        for (const roleId of specifiedAll.slice(4)) {
          result.failed.push({ roleId, reason: "超过队员上限 4 人，被忽略（请修正队伍配置）" });
        }
        log(
          `${t} 指定队员 ${specifiedAll.length} 人 > 上限 4，只取前 4 个（cId ${specified
            .map((r) => roleMap[String(r)]?.cId ?? "?")
            .join(",")}），多余的被忽略`, "warning",
        );
      }

      const cidOf = (roleId) => {
        const v = Number(roleMap[String(roleId)]?.cId ?? NaN);
        return Number.isFinite(v) ? v : null;
      };

      /** 发一次邀请并记日志；不写 result（失败处理交给调用方） */
      const doInvite = async (roleId, cId) => {
        const inv = await probe.session.inviteJoinTeam(cId);
        const r = inv.role;
        if (inv.ok) {
          log(`${t} 邀请 cId ${cId} ${r?.name || roleId} ✓（队伍 ${inv.members.length} 人）`, "success");
        } else {
          log(`${t} 邀请 cId ${cId} ${r?.name || roleId} 未确认（队伍 ${inv.members.length} 人）`, "warning");
        }
        return inv;
      };

      // 2) 选阵容（两种模式都先布阵）
      result.stage = "setBattleTeam";
      const bt = await probe.session.setBattleTeam({
        battleTeam: lineup.battleTeam,
        lordWeaponId: lineup.lordWeaponId,
        petUId: lineup.petUId,
      });
      log(
        `${t} 提交阵容 ${[...lineup.battleTeam.values()].join("/")} ${bt.ok ? "✓" : "（未收到确认帧，继续）"}`,
        bt.ok ? "success" : "warning",
      );

      // 3) 组队
      let targets = []; // 实际发过邀请的 {roleId, cId}
      const fillLog = [];

      if (mode === "immediate") {
        /* ---------- 立即模式：一次清单，缺席放弃，机动可选补齐 ---------- */
        result.stage = "prepare";
        let memberRoleIds = [...specified];
        if (team.mobile) {
          const pool = cfg.buildCandidatePool({
            roster: probe.roster,
            roleMap,
            excludeRoleIds: [ownRoleId, ...specified, ...siblingOccupied],
          });
          const picked = cfg.pickMobileFill({
            candidatePoolAvailable: pool.available,
            team: { leaderRoleId: ownRoleId, memberRoleIds: specified },
            occupiedRoleIds: siblingOccupied,
          });
          if (picked.length) {
            memberRoleIds = [...specified, ...picked.map((p) => p.roleId)];
            fillLog.push(...picked.map((p) => `cId ${p.cId} ${p.name}(${p.isOffline ? "离线" : "在线"})`));
          } else {
            log(`${t} 机动开启但候选池无人可补，按现有队员登场`, "info");
          }
        }

        for (const roleId of memberRoleIds) {
          const cId = cidOf(roleId);
          if (cId === null) {
            result.failed.push({ roleId, reason: "不在本俱乐部 roleMap（跨俱乐部或本场未参战）" });
            log(`${t} 队员 ${roleId} 不在本俱乐部 roleMap，已放弃`, "error");
            continue;
          }
          targets.push({ roleId, cId });
        }

        log(
          `${t} 队伍构成：队长 cId ${myCid}` +
            (targets.length ? ` + 队员 ${targets.map((x) => `cId ${x.cId}`).join(", ")}` : "（无队员）") +
            (fillLog.length ? `｜机动补齐 ${fillLog.join("、")}` : ""),
          "info",
        );
        result.invited = targets.map((x) => x.cId);

        result.stage = "invite";
        const gap = Math.max(300, Number(settings().inviteIntervalMs) || 1200);
        for (let i = 0; i < targets.length; i++) {
          if (shouldStop?.value) {
            result.error = "已手动停止";
            break;
          }
          const { roleId, cId } = targets[i];
          const inv = await doInvite(roleId, cId);
          if (!inv.ok) result.failed.push({ roleId, cId, reason: "邀请未确认（超时）" });
          if (i < targets.length - 1) await sleep(gap);
        }
        result.expectedMembers = 1 + targets.length;
      } else {
        /* ---------- 等待模式：持续刷新清单，出现一个组一个，全部组上再登场 ---------- */
        result.stage = "wait";
        if (specified.length === 0) {
          log(`${t} 等待模式未指定任何队员，直接登场`, "warning");
        } else {
          log(
            `${t} 等待开始：等 ${specified.length} 名指定队员「出现」（未登场且未被其它队伍组走，即战场 watching）` +
              `；一直等，手动停止 = 按当前已组队伍登场`,
            "info",
          );
          log(
            `${t} 提示：等待期间持续占用 1 个战场连接槽位（当前上限 ${settings().maxActiveBattlefield}，等待队伍多时请调大）`,
            "info",
          );

          const pollMs = Math.max(3000, Number(settings().waitPollMs) || 12000);
          const gap = Math.max(300, Number(settings().inviteIntervalMs) || 1200);
          const mine = () => new Set(probe.session.teamMemberCids(myCid).map(Number));
          const warned = new Set();
          const warnOnce = (key, fn) => {
            if (!warned.has(key)) {
              warned.add(key);
              fn();
            }
          };

          // cId 缺失的队员永远等不到，提前说清楚
          for (const roleId of specified) {
            if (cidOf(roleId) === null) {
              warnOnce(`nocid:${roleId}`, () =>
                log(`${t} 队员 ${roleId} 不在本俱乐部 roleMap（跨俱乐部或本场未参战），将一直等待`, "warning"),
              );
            }
          }

          const waitStart = Date.now();
          for (;;) {
            if (shouldStop?.value) {
              result.error = "已手动停止（按当前已组队伍登场收尾）";
              log(`${t} 手动停止：按当前已组队伍登场收尾`, "warning");
              break;
            }

            // 主动拉快照：观测外部变化（被别人组走 / 自行登场）+ 补漏掉的增量帧
            const rf = await probe.session.refreshBattlefieldInfo();
            if (!rf.ok) warnOnce("refresh", () => log(`${t} 拉取战场快照超时（继续轮询）`, "warning"));

            const mineSet = mine();
            const pending = specified.filter((roleId) => {
              const cId = cidOf(roleId);
              return cId === null || !mineSet.has(cId);
            });

            if (pending.length === 0) break;

            for (const roleId of pending) {
              if (shouldStop?.value) break;
              const cId = cidOf(roleId);
              if (cId === null) continue; // 已警告过
              const rd = getInviteReadiness(probe.session.state, cId, myCid);
              if (rd.ready) {
                const inv = await doInvite(roleId, cId);
                if (inv.ok && !targets.some((x) => x.roleId === roleId)) targets.push({ roleId, cId });
                await sleep(gap);
              } else if (rd.reason !== "in_my_team") {
                warnOnce(`state:${roleId}:${rd.reason}`, () => {
                  const why =
                    rd.reason === "not_in_field"
                      ? "尚未出现在战场"
                      : rd.reason === "teaming"
                        ? "已被其它队伍组走"
                        : rd.reason === "idle"
                          ? "已自行登场"
                          : `状态 ${rd.reason}`;
                  log(`${t} 队员 ${roleId}（cId ${cId}）未出现：${why}，继续等待`, "info");
                });
              }
            }

            // 完成判定：全部指定队员都已在自己队里
            const mineNow = mine();
            const done = specified.every((roleId) => {
              const cId = cidOf(roleId);
              return cId !== null && mineNow.has(cId);
            });
            if (done) break;

            await sleep(pollMs);
          }

          const waitedSec = ((Date.now() - waitStart) / 1000).toFixed(0);
          const confirmed = specified.filter((roleId) => {
            const cId = cidOf(roleId);
            return cId !== null && mine().has(cId);
          });
          result.waitedMs = Date.now() - waitStart;
          result.invited = confirmed.map((roleId) => cidOf(roleId));
          result.expectedMembers = 1 + confirmed.length;
          for (const roleId of specified) {
            if (!confirmed.includes(roleId)) {
              result.failed.push({ roleId, cId: cidOf(roleId), reason: "等待中止/未出现" });
            }
          }
          log(
            `${t} 等待结束：用时 ${waitedSec}s，确认入队 ${confirmed.length}/${specified.length}` +
              (confirmed.length === specified.length ? "（全员到齐）" : "（未到齐）"),
            confirmed.length === specified.length ? "success" : "warning",
          );
        }
      }

      // 4) 登场
      result.stage = "deploy";
      const dp = await probe.session.deploy({
        battleTeam: lineup.battleTeam,
        lordWeaponId: lineup.lordWeaponId,
        petUId: lineup.petUId,
      });
      result.teamMembers = probe.session.teamMemberCids(myCid);
      if (dp.ok) {
        const pos = dp.role?.position || {};
        log(`${t} 登场完成 ${dp.role?.state || "?"}(${pos.x ?? "?"}, ${pos.y ?? "?"})`, "success");
      } else {
        log(`${t} 登场未确认（角色仍是 ${dp.role?.state || "watching"}）`, "warning");
      }

      // 5) 校验
      result.stage = "verify";
      const expected = result.expectedMembers ?? 1 + targets.length;
      if (specified.length === 0 && targets.length === 0) {
        // 单人队（master 明确支持"有多少人组多少人"，最少 1 人）：从未发过邀请。
        // teamMap 的组队条目由组队动作创建，此时可能没有自己的条目
        // （teamMemberCids 返回 []），人数校验无意义 —— 以登场结果为准。
        result.ok = !!dp.ok;
        if (result.ok) {
          log(`${t} 校验通过：单人登场，无队员（未发过邀请）`, "success");
        } else {
          result.error = result.error || "单人登场未确认";
          log(`${t} 校验失败：单人登场未确认（角色仍是 ${dp.role?.state || "watching"}）`, "error");
        }
      } else {
        result.ok = result.teamMembers.length === expected;
        if (!result.ok) {
          result.error = result.error || `队伍人数 ${result.teamMembers.length} ≠ 预期 ${expected}`;
          log(`${t} 校验失败：teamMap[${myCid}].mCodeIds = [${result.teamMembers.join(",")}]，预期 ${expected} 人`, "error");
        } else {
          log(`${t} 校验通过：${result.teamMembers.length} 人 [${result.teamMembers.join(",")}]`, "success");
        }
      }
    } catch (e) {
      result.error = e?.message || String(e);
      log(`${t} 执行失败（阶段 ${result.stage}）: ${result.error}`, "error");
    } finally {
      if (probe) closeProbe(probe);
      result.elapsedMs = Date.now() - startedAt;
      log(`${t} 结束，用时 ${(result.elapsedMs / 1000).toFixed(1)}s，${result.ok ? "成功" : "未完全成功"}`, result.ok ? "success" : "warning");
    }
    return result;
  };

  /* -------------------- ④ 批量执行 -------------------- */

  /**
   * 执行队伍。传 teamIds 则只跑指定的，否则跑全部启用的。
   * 同一俱乐部的队伍串行（避免自己抢自己的名额），不同俱乐部之间并行。
   */
  const runSaltFieldTeams = async (teamIds = null) => {
    const all = cfg.getTeams();
    const picked = all.filter((t) => (teamIds ? teamIds.includes(t.id) : t.enabled !== false));
    if (picked.length === 0) {
      message?.warning?.("没有可执行的队伍");
      return [];
    }

    const groups = cfg.groupTeamsByLegion(picked);
    const runnable = groups.filter((g) => g.enabled !== false);
    const skipped = groups.filter((g) => g.enabled === false);
    skipped.forEach((g) => log(`俱乐部 ${g.legionId} ${g.legionName} 已禁用，跳过 ${g.teams.length} 支队伍`, "warning"));

    if (isRunning) isRunning.value = true;
    if (shouldStop) shouldStop.value = false;

    log(`=== 开始执行：${runnable.length} 个俱乐部 / ${runnable.reduce((n, g) => n + g.teams.length, 0)} 支队伍 ===`, "info");

    const results = [];
    // 俱乐部内串行，俱乐部间并行
    await Promise.all(
      runnable.map(async (g) => {
        for (const team of g.teams) {
          if (shouldStop?.value) break;
          const r = await runOneSaltFieldTeam(team);
          results.push(r);
        }
      }),
    );

    const okCount = results.filter((r) => r.ok).length;
    log(`=== 执行结束：成功 ${okCount} / ${results.length} 支队伍 ===`, okCount === results.length ? "success" : "warning");

    if (isRunning) isRunning.value = false;
    message?.success?.(`自动盐场完成：${okCount}/${results.length} 支队伍成功`);
    return results;
  };

  return {
    battlefieldQueue,
    syncSaltFieldRoles,
    loadSaltFieldRoster,
    probeSaltFieldTeam,
    closeProbe,
    previewSaltFieldTeamCandidates,
    runOneSaltFieldTeam,
    runSaltFieldTeams,
  };
}

export default createTasksSaltField;
