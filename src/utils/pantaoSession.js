/**
 * 蟠桃战场会话：一条连接 = 一个角色（蟠桃不能组队，所以没有「队伍」概念）
 *
 * 与盐场会话（legionWarSession）的关系：
 *   · 复用同一个底层客户端（BON + px/x 加密已在盐场验证与抓包逐字节一致）
 *   · 命令命名空间不同：war_* → payload_*；心跳 war_ping → payload_ping（20s）
 *   · 信封 hint 同样 = bfId
 *
 * 连接地址**由服务端下发**（`legion_getpayloadbf` → `info.domainName` + `info.sid`），
 * 不要硬编码；这里只留兜底常量。
 */
import { CommandRegistry, XyzwLegionWarWebSocketClient } from "./xyzwLegionWarWebSocket.js";
import { describeServerError } from "./protocolError.js";
import {
  applyPantaoFrame,
  createPantaoState,
  getMyMarch,
  getMyRole,
  summarizePantao,
} from "./pantaoState.js";
import { ACTION, planTurn } from "./pantaoPlan.js";

/** 兜底地址：真实地址取自 legion_getpayloadbf 的 info.domainName */
export const PAYLOAD_WS_FALLBACK = "wss://xxz-xyzw-new.hortorgames.com/agent";

/**
 * 战场连接地址（与盐场同构：`?p=<token>&e=x&sid2=<sid>&lang=chinese`）
 * ⚠️ sid 是一次性票据，每次连接都要重新向主连接要。
 * ⚠️ token 必须取**刷新后**的最新值（BIN 导入时 token 为空，建连时才按需刷新）。
 */
export function buildPayloadUrl({ domainName, token, sid }) {
  const base = domainName || PAYLOAD_WS_FALLBACK;
  return (
    base +
    `?p=${encodeURIComponent(token)}` +
    `&e=x&sid2=${encodeURIComponent(sid)}&lang=chinese`
  );
}

/**
 * 蟠桃命令注册。
 * ⚠️ `payload_startmarch` / `payload_startbattle` 的**请求体尚未抓到**（HttpCanary 漏了客户端帧），
 *    这里的 body 是按响应结构反推的**最佳猜测**，已做成可覆写（见 PantaoSession.startMarch / attack），
 *    抓到真实帧后只需改默认值，不用改调用方。见 docs/pantao-protocol-catalog.md §8。
 */
export function registerPayloadCommands(reg) {
  reg
    .register("payload_enterbf")
    .register("payload_setbattleteam")
    .register("payload_startmarch")
    .register("payload_startbattle")
    .register("payload_useitem")
    .register("payload_getbattlefieldinfo");

  // 心跳：蟠桃是 payload_ping {bfId}（20 秒一次），不是 war_ping
  reg.commands.set("heart_beat", (ack, seq) => ({
    cmd: "payload_ping",
    ack,
    seq,
    hint: reg.hint,
    time: Date.now(),
    body: reg.encoder?.bon?.encode ? reg.encoder.bon.encode({ bfId: reg.hint }) : { bfId: reg.hint },
  }));
  return reg;
}

export class XyzwPayloadWebSocketClient extends XyzwLegionWarWebSocketClient {
  constructor({ url, utils, hint, heartbeatMs = 20000 }) {
    super({ url, utils, hint, heartbeatMs });
    this.registry = registerPayloadCommands(new CommandRegistry(this.utils, this.enc, hint));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PantaoSession {
  /**
   * @param {object} options
   * @param {string} options.url            完整 wss 地址（含 token 与 sid2）
   * @param {string} options.bfId           战场 ID，用于信封 hint
   * @param {number} [options.ownerRoleId]  本连接对应的角色 roleId
   * @param {number} [options.heartbeatMs]  心跳间隔，默认 20000（蟠桃实测 20s）
   * @param {function} [options.onFrame]    每帧回调 (msg, state)，用于 WSS 录制
   * @param {function} [options.onUpdate]
   * @param {function} [options.onTimeout]
   */
  constructor({
    url,
    bfId,
    ownerRoleId = 0,
    heartbeatMs = 20000,
    onFrame,
    onUpdate,
    onTimeout,
  } = {}) {
    this.bfId = bfId || "";
    this.ownerRoleId = Number(ownerRoleId) || 0;
    this.onFrame = onFrame || null;
    this.onUpdate = onUpdate || null;
    this.onTimeout = onTimeout || null;

    this.state = createPantaoState({ bfId, myRoleId: this.ownerRoleId });
    this.frameWaiters = [];

    this.client = new XyzwPayloadWebSocketClient({
      url,
      utils: null,
      hint: bfId,
      heartbeatMs,
    });
    this.client.setMessageListener((msg) => this._onMessage(msg));
  }

  get connected() {
    return !!this.client?.connected;
  }

  get summary() {
    return summarizePantao(this.state);
  }

  /** 交给 pantaoPlan 的决策对象（{bf, myRoleId, bfId, tileData}） */
  get snapshot() {
    return {
      bf: this.state.bf,
      myRoleId: this.state.myRoleId || this.ownerRoleId,
      bfId: this.state.bfId || this.bfId,
      tileData: this.state.tileData,
    };
  }

  init(timeoutMs = 15000) {
    const prevConnect = this.client.onConnect;
    const prevError = this.client.onError;
    const prevDisconnect = this.client.onDisconnect;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`蟠桃战场连接超时 (${timeoutMs}ms)`));
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
          reject(new Error(`蟠桃战场连接错误: ${e?.message || e}`));
        }
        if (prevError) prevError(e);
      };
      this.client.onDisconnect = (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`蟠桃战场连接已断开 (${e?.code ?? "?"})`));
        }
        if (prevDisconnect) prevDisconnect(e);
      };

      this.client.init();
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
    const raw = msg?.rawData !== undefined ? msg.rawData : msg?.body;
    if (raw !== undefined && raw !== null) {
      const before = this.state.updatedAt;
      applyPantaoFrame(this.state, raw, { cmd: msg?.cmd || "" });
      if (this.state.updatedAt !== before && this.onUpdate) this.onUpdate(this.state);
    }
    if (msg?.code && Number(msg.code) !== 0) {
      this.state.lastError = {
        cmd: msg?.cmd || "",
        code: Number(msg.code),
        text: describeServerError(msg),
      };
    }

    if (this.onFrame) this.onFrame(msg, this.state);

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

  /** 等待满足条件的帧；超时返回 null（不抛错） */
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

  /** 最近一次错误的可读文案（没有则空串） */
  lastErrorText() {
    const e = this.state.lastError;
    return e ? `${e.cmd || "?"}: ${e.text || e.code}` : "";
  }

  /* ------------------------------ 业务动作 ------------------------------ */

  /** 进战场。成功判据：拿到包含自己的 bf.roles */
  async enterBattlefield(timeoutMs = 15000) {
    this.client.send("payload_enterbf", { bfId: this.bfId });
    const ok = await this.waitForState(
      (s) => !!s.bf && (!!getMyRole(s) || Number(s.myRoleId || 0) > 0),
      timeoutMs,
    );
    return { ok, summary: this.summary };
  }

  /**
   * 布阵/登场（蟠桃没有「只提交阵容」与「登场」的区分，一条命令同时完成）。
   * 成功判据：自己的 role.state 从 watching 变为非 watching（实测响应里是 idle，
   * 并会带上 tileData 里老家格子的 memberMap）。
   */
  async setBattleTeam({ battleTeam, lordWeaponId, petUId }, timeoutMs = 10000) {
    this.client.send("payload_setbattleteam", {
      bfId: this.bfId,
      battleTeam,
      lordWeaponId,
      petUId,
    });
    const ok = await this.waitForState((s) => {
      const r = getMyRole(s);
      return !!r && !!r.state && r.state !== "watching";
    }, timeoutMs);
    return { ok, role: getMyRole(this.state), error: ok ? "" : this.lastErrorText() };
  }

  /**
   * 向目标行军。
   * @param {object} target { carId } 或 { x, y }（UI 上是「选中船 → 点移动」，
   *   所以默认是 carId；真实请求体还没抓到，见文件头注释）
   * @param {object} [bodyOverride] 抓到真实帧后直接覆写请求体
   */
  async startMarch(target = {}, bodyOverride = null, timeoutMs = 8000) {
    const body = bodyOverride || { bfId: this.bfId, ...target };
    this.client.send("payload_startmarch", body);
    const ok = await this.waitForState((s) => !!getMyMarch(s), timeoutMs);
    return { ok, march: getMyMarch(this.state), error: ok ? "" : this.lastErrorText() };
  }

  /**
   * 攻击同位置的敌人（命令名/参数未抓到，默认 `payload_startbattle {bfId, targetRoleId}`）。
   * ⚠️ 若实测是「位置重叠自动开战」（Payload_StartBattleResp 的 ack=0 更像广播），
   *   则这里应改为「行军到敌人所在格」——见 docs/pantao-protocol-catalog.md §8。
   */
  async attack(targetRoleId, bodyOverride = null, timeoutMs = 8000) {
    const body = bodyOverride || { bfId: this.bfId, targetRoleId: Number(targetRoleId) };
    this.client.send("payload_startbattle", body);
    const msg = await this.waitForFrame(
      (m) => /startbattle/i.test(m?.cmd || ""),
      timeoutMs,
      "Payload_StartBattleResp",
    );
    return { ok: !!msg, frame: msg, error: msg ? "" : this.lastErrorText() };
  }

  /** 用道具（payload_useitem），参数语义未抓到，按需覆写 */
  async useItem(body = {}, timeoutMs = 6000) {
    this.client.send("payload_useitem", { bfId: this.bfId, ...body });
    const msg = await this.waitForFrame((m) => /useitem/i.test(m?.cmd || ""), timeoutMs, "Payload_UseItemResp");
    return { ok: !!msg, frame: msg };
  }

  /* ------------------------------ 决策 ------------------------------ */

  /** 用 pantaoPlan.planTurn 跑一次决策（默认带上看船/位置等上下文） */
  decide(opts = {}) {
    const s = this.summary;
    return planTurn(this.snapshot, {
      roleId: this.ownerRoleId || this.state.myRoleId,
      boardedCarId: opts.boardedCarId ?? s.carId,
      ...opts,
    });
  }

  /** 是否还有未完成的事（用于轮询调度判断要不要继续占用连接） */
  isBusy() {
    const r = getMyRole(this.state);
    const state = String(r?.state || "");
    return state === "march" || state === "combat" || state === "die";
  }
}

export { ACTION };
export default PantaoSession;
