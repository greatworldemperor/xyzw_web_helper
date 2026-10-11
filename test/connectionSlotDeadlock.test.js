/**
 * 连接槽位死锁回归测试（2026-10-11 蟠桃事故）
 *
 * 事故链：runOnePantaoRole → ensureConnection（占槽1）→ probePantao →
 * ensureConnection（再要槽）→ 3 并发把 maxActive=3 占满 → 环形等待
 * → waitForConnectionSlot 无超时无日志 → 第一批卡死 33 分钟零输出。
 *
 * 本文件锁定两个修复：
 *   fix A：ensureConnection 对「已连接」token 走幂等路径，不占槽；
 *   fix B：waitForConnectionSlot 带兜底超时，超时抛可见错误。
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  createConnectionManager,
  connectionQueue,
  DEFAULT_SLOT_WAIT_TIMEOUT_MS,
} from "../src/utils/batch/connectionManager.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 构造可编程 tokenStore mock */
function makeTokenStore(initialStatuses = {}) {
  const statuses = new Map(Object.entries(initialStatuses));
  const calls = { init: 0, versions: [], logs: [] };
  const tokenStore = {
    getWebSocketStatus: (tokenId) => statuses.get(String(tokenId)) || "disconnected",
    createWebSocketConnection: (tokenId) => {
      // 模拟快速握手成功（fire-and-forget 语义下调用方只轮询状态）
      statuses.set(String(tokenId), "connected");
    },
    closeWebSocketConnection: (tokenId) => {
      statuses.set(String(tokenId), "disconnected");
    },
    sendMessageWithPromise: async (_tokenId, cmd) => {
      if (cmd === "role_getroleinfo" || cmd === "fight_startlevel") calls.init++;
      if (cmd === "fight_startlevel") return { battleData: { version: "v-test" } };
      return {};
    },
    setBattleVersion: (v) => calls.versions.push(v),
  };
  return { tokenStore, statuses, calls };
}

function makeManager(tokenStore, patch = {}) {
  const logs = [];
  const mgr = createConnectionManager({
    tokenStore,
    batchSettings: {
      maxActive: 3,
      connectionTimeout: 2000,
      connectionPrepareGraceMs: 2000,
      reconnectDelay: 50,
      ...patch,
    },
    addLog: (entry) => logs.push(entry),
  });
  return { mgr, logs };
}

const TOKENS = [{ id: "t1", token: "tok-1", wsUrl: "wss://example" }];

test("fix B 常量：槽位等待兜底超时默认 5 分钟", () => {
  assert.equal(DEFAULT_SLOT_WAIT_TIMEOUT_MS, 300000);
});

test("fix A：已连接 token 走幂等路径，不占槽（死锁根因回归）", async () => {
  connectionQueue.active = 0;
  const { tokenStore, calls } = makeTokenStore({ t1: "connected" });
  const { mgr } = makeManager(tokenStore);

  const result = await mgr.ensureConnection("t1", TOKENS);

  assert.equal(result, true);
  assert.equal(connectionQueue.active, 0, "已连接复用不得占用槽位");
  assert.ok(calls.init >= 2, "幂等路径仍要初始化会话数据");
});

test("fix A 端到端：3 槽全满时，已连接 token 的二次 ensureConnection 立即成功（复现 10-11 死锁场景）", async () => {
  connectionQueue.active = 0;
  const { tokenStore, calls } = makeTokenStore({ t1: "connected" });
  const { mgr } = makeManager(tokenStore);

  // 模拟 3 个任务各持 1 槽（10-11 事故里第一批的真实状态）
  connectionQueue.active = 3;

  // 旧实现：先等槽 → 永远等不到 → 卡死；新实现：幂等路径立即返回
  const raced = await Promise.race([
    mgr.ensureConnection("t1", TOKENS).then(() => "OK"),
    sleep(2000).then(() => "TIMEOUT"),
  ]);

  assert.equal(raced, "OK", "已连接 token 不应被槽位阻塞（死锁复现点）");
  assert.equal(connectionQueue.active, 3, "幂等路径不新增槽位占用");
  assert.ok(calls.init > 0, "幂等路径完成会话初始化");
});

test("fix B：槽位全满时 waitForConnectionSlot 按注入超时抛可见错误", async () => {
  connectionQueue.active = 0;
  const { tokenStore } = makeTokenStore({});
  const { mgr } = makeManager(tokenStore, { connectionSlotWaitTimeoutMs: 1200 });

  connectionQueue.active = 3; // 占满

  const startedAt = Date.now();
  await assert.rejects(
    () => mgr.waitForConnectionSlot(),
    (e) => /槽位.*超时|超时.*槽位|死锁/.test(e.message),
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 1100, `应等待到超时才报错（实际 ${elapsed}ms）`);
  assert.ok(elapsed < 5000, "超时后必须退出，不允许无限等待");
  assert.equal(connectionQueue.active, 3, "超时抛错不应改变槽位计数");
});

test("回归：未连接路径正常占槽建连，完成后保持占用", async () => {
  connectionQueue.active = 0;
  const { tokenStore } = makeTokenStore({ t1: "disconnected" });
  const { mgr } = makeManager(tokenStore);

  const result = await mgr.ensureConnection("t1", TOKENS);

  assert.equal(result, true);
  assert.equal(connectionQueue.active, 1, "建连路径应占用 1 槽");

  mgr.releaseConnectionSlot();
  assert.equal(connectionQueue.active, 0);
});

test("回归：waitForConnectionSlot 正常获取/释放", () => {
  connectionQueue.active = 0;
  const { tokenStore } = makeTokenStore({});
  const { mgr } = makeManager(tokenStore);

  return mgr.waitForConnectionSlot().then(() => {
    assert.equal(connectionQueue.active, 1);
    mgr.releaseConnectionSlot();
    assert.equal(connectionQueue.active, 0);
  });
});
