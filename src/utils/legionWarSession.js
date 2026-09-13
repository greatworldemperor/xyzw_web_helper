/**
 * 盐场战场会话：一条连接 = 一个角色 = 一个俱乐部的 roleMap
 *
 * 为什么需要这一层：
 *   `roleMap` 是按「连接所属俱乐部」下发的（见 docs/saltfield-auto-ui-design.md §1.5），
 *   所以「一支队伍」就是「一个会话」。多俱乐部/多队伍必须各持一个实例，不能共享。
 *
 * 职责：
 *   · 包装 XyzwLegionWarWebSocketClient（BON 编码 + x 加密已在客户端内验证一致）
 *   · 用 legionWarState 的纯函数维护可查询的战场状态
 *   · 把「广播式响应」的确认逻辑收敛成可 await 的语义
 *     （这些 war_* 响应不带 resp、ack 常为 0，无法用序号匹配，只能按内容/状态确认）
 */
import { XyzwLegionWarWebSocketClient } from "./xyzwLegionWarWebSocket";
import {
  createInitialState,
  applyBattlefieldFrame,
  roleIdToCid,
  getRole,
  getTeamMemberCids,
  getActivityWindow,
  summarizeSnapshot,
} from "./legionWarState";

/** 战场专用连接地址（sid 是每个角色各自的一次性票据） */
export const LEGION_WAR_WS_BASE = "wss://xxz-xyzw-new.hortorgames.com/agent";

export function buildLegionWarUrl(token, sid) {
  return (
    LEGION_WAR_WS_BASE +
    `?p=${encodeURIComponent(token)}` +
    `&e=x&sid2=${encodeURIComponent(sid)}&lang=chinese`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LegionWarSession {
  /**
   * @param {object} options
   * @param {string} options.url           完整 wss 地址（含 token 与 sid2）
   * @param {string} options.battlefieldId 用于信封 hint
   * @param {number} [options.heartbeatMs]  心跳间隔，默认 5000
   * @param {function} [options.onFrame]    每帧回调 (msg, state)
   * @param {function} [options.onUpdate]   状态变化回调 (state)
   * @param {function} [options.onTimeout]  等待超时回调 (label, timeoutMs)
   */
  constructor({ url, battlefieldId, heartbeatMs = 5000, onFrame, onUpdate, onTimeout } = {}) {
    this.battlefieldId = battlefieldId;
    this.onFrame = onFrame || null;
    this.onUpdate = onUpdate || null;
    this.onTimeout = onTimeout || null;

    this.state = createInitialState();
    this.state.battlefieldId = battlefieldId || "";

    /** 待匹配的帧等待器 */
    this.frameWaiters = [];
    /** 最近一次非 0 错误码 */
    this.lastError = null;

    this.client = new XyzwLegionWarWebSocketClient({
      url,
      utils: null, // 内部会回落到 g_utils，编码与抓包一致
      hint: battlefieldId,
      heartbeatMs,
    });

    this.client.setMessageListener((msg) => this._onMessage(msg));
  }

  get connected() {
    return !!this.client?.connected;
  }

  get roleCodeId() {
    return this.state.roleCodeId;
  }

  get roleMap() {
    return this.state.roleMap;
  }

  get teamMap() {
    return this.state.teamMap;
  }

  get roles() {
    return this.state.roles;
  }

  get constant() {
    return this.state.constant;
  }

  get summary() {
    return summarizeSnapshot(this.state);
  }

  /**
   * 建立连接；resolve 表示 WebSocket 已 open
   * 注意：会链式调用外部已设置的 onConnect/onError/onDisconnect（不覆盖），
   *      因为调用方通常先挂好自己的回调再调 init()。
   */
  init(timeoutMs = 15000) {
    const prevConnect = this.client.onConnect;
    const prevError = this.client.onError;
    const prevDisconnect = this.client.onDisconnect;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`战场连接超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };

      this.client.onConnect = () => {
        done();
        if (prevConnect) prevConnect();
      };

      this.client.onError = (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`战场连接错误: ${e?.message || e}`));
        }
        if (prevError) prevError(e);
      };

      this.client.onDisconnect = (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`战场连接已断开 (${e?.code ?? "?"})`));
        }
        if (prevDisconnect) prevDisconnect(e);
      };

      this.client.init();

      // 兜底：实现层可能已处于 connected 状态
      if (this.client.connected) done();
    });
  }

  close() {
    try {
      this.client.disconnect();
    } catch {
      /* ignore */
    }
    this.frameWaiters.length = 0;
  }

  /* ------------------------------ 内部 ------------------------------ */

  _onMessage(msg) {
    const cmd = msg?.cmd || "";

    // 记录非 0 错误码（例如攻击被拒的 3000070）
    if (msg?.code && msg.code !== 0) {
      this.lastError = { cmd, code: msg.code, error: msg.error || "" };
    }

    // 战场数据统一走 rawData（= bon.decode(body)）
    if (msg?.rawData !== undefined) {
      const before = this.state.updatedAt;
      applyBattlefieldFrame(this.state, msg.rawData);
      if (this.state.updatedAt !== before && this.onUpdate) {
        this.onUpdate(this.state);
      }
    }

    if (this.onFrame) this.onFrame(msg, this.state);

    // 唤醒帧等待器
    for (let i = this.frameWaiters.length - 1; i >= 0; i--) {
      const w = this.frameWaiters[i];
      let hit = false;
      try {
        hit = !!w.test(msg, this.state);
      } catch {
        hit = false;
      }
      if (hit) {
        this.frameWaiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  }

  /** 等待满足条件的帧到达；超时返回 null（不抛错，调用方按需降级） */
  waitForFrame(test, timeoutMs = 5000, label = "frame") {
    return new Promise((resolve) => {
      let w;
      const timer = setTimeout(() => {
        const idx = this.frameWaiters.indexOf(w);
        if (idx >= 0) this.frameWaiters.splice(idx, 1);
        if (this.onTimeout) this.onTimeout(label, timeoutMs);
        resolve(null);
      }, timeoutMs);
      w = { test, resolve, timer, label };
      this.frameWaiters.push(w);
    });
  }

  /** 轮询等待状态满足条件；超时返回 false */
  async waitForState(test, timeoutMs = 8000, intervalMs = 120) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let ok = false;
      try {
        ok = !!test(this.state);
      } catch {
        ok = false;
      }
      if (ok) return true;
      if (Date.now() >= deadline) return false;
      await sleep(intervalMs);
    }
  }

  /* ------------------------------ 业务动作 ------------------------------ */

  /** 进入战场。以「拿到自身的 roleCodeId」作为成功判据 */
  async enterBattlefield(timeoutMs = 15000) {
    this.client.send("war_enterbattlefield", {
      battlefieldId: this.battlefieldId,
      useGzip: true,
    });
    const ok = await this.waitForState(
      (s) => s.roleCodeId !== null && s.roleCodeId !== undefined,
      timeoutMs,
    );
    return { ok, roleCodeId: this.state.roleCodeId };
  }

  /** 选阵容（布阵）：只提交阵容，不改变角色位置 */
  async setBattleTeam({ battleTeam, lordWeaponId, petUId }, timeoutMs = 6000) {
    this.client.send("war_teamsetbattleteam", {
      battlefieldId: this.battlefieldId,
      battleTeam,
      lordWeaponId,
      petUId,
    });
    const msg = await this.waitForFrame(
      (m) =>
        /teamsetbattleteamresp/.test(m?.cmd || "") &&
        Number(m?.rawData?.roleCodeId) === Number(this.state.roleCodeId),
      timeoutMs,
    );
    return { ok: !!msg, frame: msg };
  }

  /** 登场：提交阵容并让角色从 watching(-1,-1) 落到地图上 */
  async deploy({ battleTeam, lordWeaponId, petUId }, timeoutMs = 10000) {
    this.client.send("war_setbattleteam", {
      battlefieldId: this.battlefieldId,
      battleTeam,
      lordWeaponId,
      petUId,
    });
    const myCid = this.state.roleCodeId;
    const ok = await this.waitForState((s) => {
      const r = getRole(s, myCid);
      return !!r && r.state && r.state !== "watching";
    }, timeoutMs);
    return { ok, role: getRole(this.state, myCid) };
  }

  /**
   * 邀请组队。
   * 服务端会向全场广播 War_InviteJoinTeamResp（ack 为 0），所以只能靠
   * 「自己队伍的 mCodeIds 是否包含目标」来确认。
   */
  async inviteJoinTeam(targetCodeId, timeoutMs = 6000) {
    this.client.send("war_invitejointeam", {
      battlefieldId: this.battlefieldId,
      targetCodeId,
    });
    const target = Number(targetCodeId);
    const myCid = this.state.roleCodeId;
    const ok = await this.waitForState(
      (s) => getTeamMemberCids(s, myCid).includes(target),
      timeoutMs,
    );
    return {
      ok,
      members: getTeamMemberCids(this.state, myCid),
      role: getRole(this.state, target),
    };
  }

  /* ------------------------------ 查询辅助 ------------------------------ */

  cidOfRoleId(roleId) {
    return roleIdToCid(this.state, roleId);
  }

  teamMemberCids(leaderCid = this.state.roleCodeId) {
    return getTeamMemberCids(this.state, leaderCid);
  }

  activityWindow(nowSec) {
    return getActivityWindow(this.state, nowSec);
  }
}

export default LegionWarSession;
