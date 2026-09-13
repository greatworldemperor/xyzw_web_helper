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
   * @returns {object} 结果对象（不再抛错，失败信息在结果里）
   */
  const runOneSaltFieldTeam = async (team) => {
    const t = tag(team);
    const startedAt = Date.now();
    const result = {
      teamId: team.id,
      legionId: team.legionId,
      leaderTokenId: team.leaderTokenId,
      ok: false,
      stage: "init",
      invited: [],
      failed: [],
      teamMembers: [],
      error: "",
    };

    let probe = null;
    try {
      // 1) 连接 + 定俱乐部 + 拿阵容 + 建候选池（复用探测流程，避免逻辑分叉）
      result.stage = "probe";
      probe = await probeSaltFieldTeam(team);
      const { legionId, legionName, roster, lineup, roleMap, myCid, roleId } = probe;
      const ownRoleId = Number(roleId || 0);

      log(`${t} 进入战场 ${probe.battlefieldId} · ${legionName || legionId} · 自身 cId ${myCid}`, "info");
      log(`${t} roleMap ${Object.keys(roleMap).length} 人（本俱乐部）`, "info");

      if (!lineup.battleTeam) {
        throw new Error("角色没有可用的主阵容（battleTeam 为空），请先在游戏里配置阵容");
      }

      // 2) 解析队员：先取指定队员，机动则在本俱乐部候选池内补齐
      const teams = cfg.getTeams();
      const siblingOccupied = teams
        .filter((x) => String(x.leaderTokenId) !== String(team.leaderTokenId))
        .filter((x) => Number(x.legionId) === Number(legionId))
        .flatMap((x) => [...(x.memberRoleIds || [])]);

      const specified = [...new Set((team.memberRoleIds || []).map(Number))].filter(
        (r) => r && r !== ownRoleId,
      );

      let memberRoleIds = [...specified];
      const fillLog = [];
      if (team.mobile) {
        const pool = cfg.buildCandidatePool({
          roster,
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
        }
      }

      // 3) roleId -> cId（只能查本连接自己的 roleMap）
      const targets = [];
      for (const roleId of memberRoleIds) {
        const cId = Number(roleMap[String(roleId)]?.cId ?? NaN);
        if (!Number.isFinite(cId)) {
          result.failed.push({ roleId, reason: "不在本俱乐部 roleMap（跨俱乐部或本场未参战）" });
          log(`${t} 队员 ${roleId} 不在本俱乐部 roleMap，已跳过`, "error");
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

      // 4) 选阵容
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

      // 5) 逐个邀请（间隔可配，避免触发限流）
      result.stage = "invite";
      const gap = Math.max(300, Number(settings().inviteIntervalMs) || 1200);
      for (let i = 0; i < targets.length; i++) {
        if (shouldStop?.value) {
          result.error = "已手动停止";
          break;
        }
        const { roleId, cId } = targets[i];
        const inv = await probe.session.inviteJoinTeam(cId);
        const r = inv.role;
        if (inv.ok) {
          log(`${t} 邀请 cId ${cId} ${r?.name || roleId} ✓（队伍 ${inv.members.length} 人）`, "success");
        } else {
          result.failed.push({ roleId, cId, reason: "邀请未确认（超时）" });
          log(`${t} 邀请 cId ${cId} ${r?.name || roleId} 未确认（队伍 ${inv.members.length} 人）`, "warning");
        }
        if (i < targets.length - 1) await sleep(gap);
      }

      // 6) 登场
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

      // 7) 校验
      result.stage = "verify";
      const expected = 1 + targets.length;
      result.ok = result.teamMembers.length === expected;
      if (!result.ok) {
        result.error = `队伍人数 ${result.teamMembers.length} ≠ 预期 ${expected}`;
        log(`${t} 校验失败：teamMap[${myCid}].mCodeIds = [${result.teamMembers.join(",")}]，预期 ${expected} 人`, "error");
      } else {
        log(`${t} 校验通过：${result.teamMembers.length} 人 [${result.teamMembers.join(",")}]`, "success");
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
    probeSaltFieldTeam,
    closeProbe,
    previewSaltFieldTeamCandidates,
    runOneSaltFieldTeam,
    runSaltFieldTeams,
  };
}

export default createTasksSaltField;
