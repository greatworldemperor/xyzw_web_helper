/**
 * 连接等待「两段计时」回归测试（2026-10-10 自动盐场实跑复盘）
 *
 * 背景：10-10 晚跑盐场时，每个队长角色都必定吃一次「连接超时，尝试重连...」。
 * 根因不是网络/服务端，而是计时起点错位——
 *
 *   ensureConnection 里 fire-and-forget 触发 tokenStore.createWebSocketConnection，
 *   后者内部要先跑一串 await（连接锁最长 10s → 关闭旧连接 → 按需刷新 role token）
 *   才会把 wsConnections[tokenId] 写成 status="connecting"；在这之前
 *   getWebSocketStatus 恒返回 "disconnected"。而旧实现把 10s 的倒计时从「调用瞬间」
 *   起算，于是 WS 握手还没开始就已经判超时；等 1s 后重连时 token 已热、锁已释放，
 *   第二次才秒连 —— 所以现象是「每个角色都超时一次」。
 *
 * 修正：分成两段计时
 *   ① 准备段（status 恒为 disconnected，连接对象尚未落地）→ 用 prepareGraceMs 宽限
 *   ② 握手段（已观察到 connecting/reconnecting/error）→ 严格按 timeout
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createConnectionManager,
  DEFAULT_PREPARE_GRACE_MS,
} from "../src/utils/batch/connectionManager.js";

/** 按时间脚本回放状态的假 tokenStore：[经过毫秒数, status][] */
const makeStore = (script) => {
  const startedAt = Date.now();
  return {
    getWebSocketStatus() {
      const elapsed = Date.now() - startedAt;
      let cur = "disconnected";
      for (const [at, status] of script) {
        if (elapsed >= at) cur = status;
      }
      return cur;
    },
  };
};

const mkManager = (script, batchSettings = {}) =>
  createConnectionManager({
    tokenStore: makeStore(script),
    batchSettings,
    addLog: () => {},
  });

test("默认准备宽限是 30 秒", () => {
  assert.equal(DEFAULT_PREPARE_GRACE_MS, 30000);
});

test("★ 准备阶段不计入握手超时：连接对象 1.2s 才落地也能连上（旧实现会误报超时）", async () => {
  const startedAt = Date.now();
  const m = mkManager([
    [0, "disconnected"],
    [1200, "connected"],
  ]);
  // timeout 800ms < 对象落地的 1.2s：按旧逻辑必超时；新逻辑准备段走 grace
  const ok = await m.waitForConnection("role-1", 800, 5000);
  const cost = Date.now() - startedAt;

  assert.equal(ok, true, "准备阶段不该消耗握手超时预算");
  assert.ok(cost >= 1000, `应当真的等到对象落地才返回（实际 ${cost}ms）`);
});

test("★ 握手一经开始就严格按 timeout 收口", async () => {
  const m = mkManager([
    [0, "connecting"], // 连接对象立刻落地 → 进入握手段
  ]);
  const startedAt = Date.now();
  const ok = await m.waitForConnection("role-2", 600, 5000);
  const cost = Date.now() - startedAt;

  assert.equal(ok, false);
  assert.ok(cost < 3000, `不应被 grace 拖长（实际 ${cost}ms）`);
});

test("连接对象立刻就绪 → 立即返回 true", async () => {
  const m = mkManager([[0, "connected"]]);
  const startedAt = Date.now();
  const ok = await m.waitForConnection("role-3", 600, 5000);

  assert.equal(ok, true);
  assert.ok(Date.now() - startedAt < 500, "首帧就命中，不该空转一轮轮询");
});

test("准备阶段超期（连接对象始终不出现）→ 交给上层重连", async () => {
  const m = mkManager([[0, "disconnected"]]);
  const startedAt = Date.now();
  const ok = await m.waitForConnection("role-4", 60000, 700);
  const cost = Date.now() - startedAt;

  assert.equal(ok, false);
  assert.ok(cost >= 700 && cost < 3000, `应卡在 grace 上收口（实际 ${cost}ms）`);
});

test("默认参数回落到 batchSettings.connectionPrepareGraceMs", async () => {
  const m = mkManager([[0, "connected"]], {
    connectionTimeout: 5000,
    connectionPrepareGraceMs: 1234,
  });
  // 不传后两个参数：走 batchSettings，能连上即可
  assert.equal(await m.waitForConnection("role-5"), true);
});
