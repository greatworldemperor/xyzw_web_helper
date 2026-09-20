/**
 * 自动蟠桃 · 编排层
 *
 * 执行单位是「角色」（蟠桃不能组队 → 一个角色 = 一条主连接 + 一条战场连接）。
 *
 * 单角色流程：
 *   主连接: ensureConnection(tokenId)            ← 内部按需刷新 role token
 *           legion_getpayloadbf  {}   → info.{bfId, sid, domainName, readyTime, startTime, endTime}
 *           role_getroleinfo     {}   → roleId（ownerRoleId）
 *           presetteam_getinfo       → battleTeam（5 个 heroId）
 *   战场连接: buildPayloadUrl(domainName, token, sid)
 *           payload_enterbf      {bfId}
 *           payload_setbattleteam{bfId, battleTeam, lordWeaponId, petUId}   ← 登场
 *           循环 planTurn → march / attack / wait / done
 *
 * ⚠️ 已知风险：`payload_setbattleteam` 在网页 h5 口径下会被 3000070 拒绝（见
 *    docs/pantao-protocol-catalog.md §7）。本项目协议客户端注册口径是 mix，理论上不受影响，
 *    但需要 09-27 那场实测确认；失败时会在日志里原样报出 code，不做无脑重试。
 */
// 用相对路径（保持纯 node 下可单测；@/ 别名只有 vite 能解析）
import * as cfg from "../pantaoConfig.js";
import { ACTION, batchIntervalMs, buildBattleTeamFromPreset, planPollingBatches } from "../pantaoPlan.js";
import { PantaoSession, buildPayloadUrl } from "../pantaoSession.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickRole(resp) {
  return resp?.role || resp?.roleInfo || resp?.info?.role || resp?.info || null;
}

/** 兼容旧调用方：阵容解析已下沉到纯逻辑层 pantaoPlan */
export { buildBattleTeamFromPreset };

/** 战场并发闸门（与批量任务的 maxActive 分开，避免主连接被占满） */
function createGate(max) {
  let active = 0;
  return {
    async acquire() {
      while (active >= Math.max(1, max)) await sleep(500);
      active++;
    },
    release() {
      if (active > 0) active--;
    },
    get active() {
      return active;
    },
  };
}

export function createTasksPantao(deps = {}) {
  const {
    tokens = null,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot,
    tokenStore,
    addLog,
    message,
    /** 战场 WS 帧录制钩子（页面注入）：(meta, {dir, cmd, ...}) => void */
    onWarFrame = null,
  } = deps;

  const settings = () => cfg.getSettings();
  const tokenList = () => (Array.isArray(tokens?.value) ? tokens.value : Array.isArray(tokens) ? tokens : []) || [];

  const findToken = (tokenId) =>
    tokenList().find((t) => String(t.id) === String(tokenId)) ||
    (tokenStore?.gameTokens || []).find((t) => String(t.id) === String(tokenId)) ||
    null;

  /** token 可能是建连前才刷新出来的，必须取最新引用（同盐场） */
  const findFreshToken = (tokenId) =>
    (tokenStore?.gameTokens || []).find((t) => String(t.id) === String(tokenId)) ||
    findToken(tokenId) ||
    null;

  const log = (text, type = "info") =>
    addLog?.({ time: new Date().toLocaleTimeString(), message: text, type });

  const gate = createGate(settings().maxActiveBattlefield);

  /* -------------------- ① 探测：主连接拿战场门票 -------------------- */

  /**
   * @returns {{ok:boolean, info?:object, tokenId?:string, reason?:string}}
   */
  const probePantao = async (tokenId) => {
    const label = findToken(tokenId)?.name || tokenId;
    try {
      await ensureConnection(tokenId);
      const resp = await tokenStore.sendMessageWithPromise(
        tokenId,
        "legion_getpayloadbf",
        {},
        Number(settings().probeTimeoutMs) || 10000,
      );
      const info = resp?.info;
      if (!info?.bfId || !info?.sid) {
        return { ok: false, tokenId, reason: `legion_getpayloadbf 没返回 bfId/sid（roleBfState=${resp?.roleBfState ?? "?"}）` };
      }
      return {
        ok: true,
        tokenId,
        info,
        label,
        roleBfState: resp?.roleBfState || "",
      };
    } catch (e) {
      return { ok: false, tokenId, reason: `${label} 探测失败: ${e?.message || e}` };
    }
  };

  /* -------------------- ② 单个角色的完整一轮 -------------------- */

  const runOnePantaoRole = async ({ tokenId, info: presetInfo } = {}) => {
    const s = settings();
    const token = findToken(tokenId);
    const label = token?.name || tokenId;
    const result = { tokenId, name: label, ok: false, stage: "init", reason: "", actions: [] };
    let session = null;

    try {
      /* --- 主连接：门票 / roleId / 阵容 --- */
      await ensureConnection(tokenId);

      const info = presetInfo || (await probePantao(tokenId)).info;
      if (!info?.bfId || !info?.sid) {
        result.stage = "probe";
        result.reason = "拿不到 bfId/sid（可能未报名或不在开放时段）";
        log(`${label} ${result.reason}`, "warning");
        return result;
      }
      result.bfId = info.bfId;
      result.stage = "probe";
      log(
        `${label} 战场 ${info.bfId}（phase=${info.phase || "?"}，战前准备 ${fmtTime(info.readyTime)} / 开打 ${fmtTime(info.startTime)} / 结束 ${fmtTime(info.endTime)}）`,
        "info",
      );

      let roleId = Number(cfg.getRoleCache()[String(tokenId)]?.roleId || 0);
      if (!roleId) {
        const roleResp = await tokenStore.sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 8000);
        roleId = Number(pickRole(roleResp)?.roleId || 0);
      }
      if (!roleId) {
        result.reason = "拿不到 roleId";
        log(`${label} ${result.reason}`, "error");
        return result;
      }

      let preset = null;
      try {
        const presetResp = await tokenStore.sendMessageWithPromise(tokenId, "presetteam_getinfo", {}, 8000);
        preset = buildBattleTeamFromPreset(presetResp);
      } catch (e) {
        log(`${label} presetteam_getinfo 失败（不致命）: ${e?.message || e}`, "warning");
      }
      if (!preset) {
        result.stage = "preset";
        result.reason = "读不到预设队伍，无法布阵";
        log(`${label} ${result.reason}`, "error");
        return result;
      }

      const fresh = findFreshToken(tokenId);
      if (!fresh?.token) {
        result.stage = "token";
        result.reason = "role token 为空（请重新导入 BIN）";
        log(`${label} ${result.reason}`, "error");
        return result;
      }

      /* --- 战场连接 --- */
      await gate.acquire();
      result.stage = "connect";
      const url = buildPayloadUrl({ domainName: info.domainName, token: fresh.token, sid: info.sid });
      const meta = { tokenId, name: label, roleId, bfId: info.bfId };

      session = new PantaoSession({
        url,
        bfId: info.bfId,
        ownerRoleId: roleId,
        heartbeatMs: 20000,
        onFrame: (msg) => {
          if (!onWarFrame) return;
          if ((msg?.cmd || "") === "payload_ping") return; // 心跳不录
          try {
            onWarFrame(meta, { dir: "recv", cmd: msg?.cmd, code: msg?.code, seq: msg?.seq, ack: msg?.ack, rawData: msg?.rawData });
          } catch {
            /* 录制失败不影响执行 */
          }
        },
      });
      session.client.onSendFrame = (raw) => {
        if (!onWarFrame || raw?.cmd === "payload_ping") return;
        try {
          onWarFrame(meta, { dir: "send", cmd: raw?.cmd, seq: raw?.seq, ack: raw?.ack, body: raw?.body });
        } catch {
          /* ignore */
        }
      };

      await session.init(Number(s.enterTimeoutMs) || 15000);
      result.stage = "enterbf";
      const entered = await session.enterBattlefield(Number(s.enterTimeoutMs) || 15000);
      if (!entered.ok) {
        result.reason = `进战场失败：${session.lastErrorText() || "超时未拿到战场数据"}`;
        log(`${label} ${result.reason}`, "error");
        return result;
      }
      log(`${label} 已进战场（state=${session.summary.phase}，我的状态 ${session.summary.myState || "?"}）`, "success");

      /* --- 登场（布阵） --- */
      result.stage = "deploy";
      const myRole = session.summary;
      const lordWeaponId = Number(myRole?.lordWeaponId || preset.weaponId || 0);
      const deployed = await session.setBattleTeam({
        battleTeam: preset.battleTeam,
        lordWeaponId,
        petUId: preset.petUId || "",
      });
      if (!deployed.ok) {
        const errText = session.lastErrorText();
        result.reason = `登场失败：${errText || "超时未离开 watching"}`;
        log(`${label} ${result.reason}${/3000070/.test(errText) ? "（疑似客户端口径被拦，见 docs §7）" : ""}`, "error");
        return result;
      }
      log(`${label} 已登场（阵容 ${Object.values(preset.battleTeam).join("/")}，lordWeaponId ${lordWeaponId}）`, "success");
      result.actions.push("deploy");

      if (settings().dryRun) {
        result.ok = true;
        result.reason = "dry-run：只探测不行动";
        log(`${label} ${result.reason}`, "info");
        return result;
      }

      /* --- 决策循环 --- */
      result.stage = "play";
      const deadline = Date.now() + (Number(s.turnTimeoutMs) || 90000);
      let done = false;
      while (!done && Date.now() < deadline) {
        if (shouldStop?.value) {
          result.reason = "已手动停止";
          break;
        }
        const turn = session.decide({
          attackRatio: Number(s.attackRatio) || 0.7,
          strategy: s.strategy,
          totalStepsByPathId: s.totalStepsByPathId || {},
        });

        switch (turn.action) {
          case ACTION.DEPLOY: {
            const r = await session.setBattleTeam({
              battleTeam: preset.battleTeam,
              lordWeaponId,
              petUId: preset.petUId || "",
            });
            if (!r.ok) {
              result.reason = `重新登场失败：${session.lastErrorText()}`;
              log(`${label} ${result.reason}`, "error");
              done = true;
            }
            break;
          }
          case ACTION.MARCH: {
            const carId = Number(turn.car?.id || 0);
            log(`${label} 向船 ${carId} 行军（${turn.reason}）`, "info");
            const r = await session.startMarch({ carId });
            if (!r.ok) {
              result.reason = `行军失败：${session.lastErrorText() || "未产生行军"}`;
              log(`${label} ${result.reason}`, "warning");
              done = true;
            } else {
              result.actions.push(`march:${carId}`);
              // 等行军结束（每格约 msPerMarchStep）
              await session.waitForState(
                (st) => !hasMyMarch(st),
                Math.max(8000, Number(r.march?.path?.length || 8) * (Number(s.msPerMarchStep) || 2000) + 4000),
                500,
              );
            }
            break;
          }
          case ACTION.ATTACK: {
            log(`${label} 攻击 ${turn.target?.name || turn.target?.roleId}（战力 ${turn.target?.power}）`, "info");
            const r = await session.attack(turn.target?.roleId);
            result.actions.push(`attack:${turn.target?.roleId}${r.ok ? "" : "(失败)"}`);
            if (!r.ok) log(`${label} 攻击失败：${session.lastErrorText() || "无响应"}`, "warning");
            await sleep(1500);
            break;
          }
          case ACTION.DONE: {
            done = true;
            result.ok = true;
            result.reason = turn.reason;
            log(`${label} 本轮完成：${turn.reason}`, "success");
            break;
          }
          case ACTION.WAIT_REVIVE: {
            result.reason = "阵亡等待复活";
            log(`${label} ${result.reason}（${fmtTime(session.summary.reviveAt)}）`, "warning");
            done = true;
            break;
          }
          case ACTION.WAIT_CAR: {
            log(`${label} 暂无行进中的船，等待刷新（${fmtTime(session.summary.nextCarAt)}）`, "warning");
            await sleep(Math.min(10000, Number(s.roundIntervalMs) || 30000));
            break;
          }
          case ACTION.WAIT_MARCH: {
            await session.waitForState((st) => !hasMyMarch(st), 30000, 500);
            break;
          }
          default: {
            log(`${label} 需要重新进场（${turn.reason}）`, "warning");
            done = true;
            break;
          }
        }
      }

      if (!result.ok && !result.reason) result.reason = "本轮超时";
      return result;
    } catch (e) {
      result.reason = `${e?.message || e}`;
      log(`${label} 执行异常（${result.stage}）: ${result.reason}`, "error");
      return result;
    } finally {
      try {
        session?.close();
      } catch {
        /* ignore */
      }
      gate.release();
      try {
        tokenStore?.closeWebSocketConnection?.(tokenId);
      } catch {
        /* ignore */
      }
      releaseConnectionSlot?.();
    }
  };

  /* -------------------- ③ 批量：分批轮询 -------------------- */

  /**
   * @param {object} opts
   * @param {string[]} opts.tokenIds 全部待办角色
   * @param {number} [opts.concurrency] 每批并发
   * @param {number} [opts.rounds] 轮询轮数（0/1 表示只跑一轮）
   */
  const runPantaoRoles = async ({ tokenIds, concurrency, rounds = 1 } = {}) => {
    const s = settings();
    const list = (tokenIds && tokenIds.length ? tokenIds : cfg.getRoleTokenIds()).map(String);
    if (!list.length) {
      message?.warning?.("还没有选择任何角色，请先在 Token 管理里勾选");
      return { ok: 0, failed: 0, results: [] };
    }

    const size = Math.max(1, Number(concurrency ?? s.concurrency) || 1);
    const batches = planPollingBatches(list, size);
    const interval = batchIntervalMs({ concurrency: size, minIntervalMs: Number(s.minIntervalMs) || 1200 });

    if (isRunning) isRunning.value = true;
    if (shouldStop) shouldStop.value = false;

    log(
      `=== 自动蟠桃开始：${list.length} 个角色 / 每批 ${size} / ${batches.length} 批，批间 ${interval}ms，共 ${rounds} 轮 ===`,
      "info",
    );

    const results = [];
    for (let round = 1; round <= Math.max(1, Number(rounds) || 1); round++) {
      if (shouldStop?.value) break;
      if (round > 1) log(`--- 第 ${round} 轮 ---`, "info");

      for (let bi = 0; bi < batches.length; bi++) {
        if (shouldStop?.value) break;
        const batch = batches[bi];
        log(`批次 ${bi + 1}/${batches.length}：${batch.map((id) => findToken(id)?.name || id).join("、")}`, "info");

        const batchResults = await Promise.all(batch.map((id) => runOnePantaoRole({ tokenId: id })));
        results.push(...batchResults);

        if (bi < batches.length - 1) await sleep(interval);
      }

      const totalRounds = Math.max(1, Number(rounds) || 1);
      if (round < totalRounds) await sleep(Number(s.roundIntervalMs) || 30000);
    }

    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    log(`=== 自动蟠桃结束：成功 ${ok} / 失败 ${failed} ===`, failed ? "warning" : "success");

    if (isRunning) isRunning.value = false;
    return { ok, failed, results };
  };

  return {
    probePantao,
    runOnePantaoRole,
    runPantaoRoles,
    buildBattleTeamFromPreset,
  };
}

/* ------------------------------ 小工具 ------------------------------ */

function hasMyMarch(state) {
  const me = Number(state?.myRoleId || 0);
  const td = state?.tileData;
  if (!me || !td) return false;
  for (const t of Object.values(td)) {
    const ms = t?.marches;
    if (!ms) continue;
    for (const m of Object.values(ms)) {
      if (m && Number(m.codeId) === me) return true;
    }
  }
  return false;
}

function fmtTime(sec) {
  const n = Number(sec || 0);
  if (!n) return "-";
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(sec) : d.toLocaleTimeString();
}

export default createTasksPantao;
