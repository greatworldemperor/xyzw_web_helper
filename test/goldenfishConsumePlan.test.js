/**
 * 金鱼消耗任务规划（goldenfishConsumePlan）纯逻辑测试
 *
 * 需求来源：local-data/goldenfish/a_brief_introduction.txt（2026-09-26）。
 * 覆盖：批量切片、招募/钓鱼差值规划（含进度未知拒绝）、宝箱库存读取、
 * 推进期全开清单（钻石箱不开/木箱留 200）、差值精确开箱（ceil 语义）、
 * 推进循环判定、积分兑换次数估算。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chunkBatches,
  planCountConsume,
  readChestInventory,
  chestScoreAvailable,
  planOpenAll,
  planPreciseOpen,
  shouldKeepLooping,
  estimateExchangeSteps,
  readActivityProgress,
  GOLDENFISH_CONSUME_DEFAULTS,
  CHEST_POINTS,
  BOX_POINT_ROUND_TOTAL,
} from "../src/utils/goldenfishConsumePlan.js";

// ---------------------------------------------------------------- 批量切片

test("chunkBatches: 3900 招募按 10/发切 390 批", () => {
  const batches = chunkBatches(3900, 10);
  assert.equal(batches.length, 390);
  assert.ok(batches.every((n) => n === 10));
  assert.equal(batches.reduce((s, n) => s + n, 0), 3900);
});

test("chunkBatches: 余数收尾/零/空", () => {
  assert.deepEqual(chunkBatches(25, 10), [10, 10, 5]);
  assert.deepEqual(chunkBatches(7, 10), [7]);
  assert.deepEqual(chunkBatches(0, 10), []);
  assert.deepEqual(chunkBatches(null, 10), []);
  assert.deepEqual(chunkBatches(-5, 10), []);
});

// ------------------------------------------------- 招募/钓鱼差值规划

test("planCountConsume: 进度未知必须拒绝（宁可不跑不可盲跑）", () => {
  const plan = planCountConsume({ done: null, target: 3900, stock: 5000 });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "progress-unknown");
});

test("planCountConsume: 已达标 skipped/reached", () => {
  const plan = planCountConsume({ done: 3900, target: 3900, stock: 5000 });
  assert.equal(plan.ok, true);
  assert.equal(plan.remaining, 0);
  assert.equal(plan.willDo, 0);
  assert.equal(plan.reached, true);
});

test("planCountConsume: 差值全量可做", () => {
  const plan = planCountConsume({ done: 0, target: 3900, stock: 5000, batchSize: 10 });
  assert.equal(plan.willDo, 3900);
  assert.equal(plan.batches.length, 390);
  assert.equal(plan.stockShort, false);
});

test("planCountConsume: 库存不足只做现有量并标记 stockShort", () => {
  const plan = planCountConsume({ done: 0, target: 3900, stock: 1505, batchSize: 10 });
  assert.equal(plan.willDo, 1505);
  assert.deepEqual(chunkBatches(1505, 10), plan.batches);
  assert.equal(plan.stockShort, true);
});

test("planCountConsume: 尾差 50 次切 5 批", () => {
  const plan = planCountConsume({ done: 3850, target: 3900, stock: 5000 });
  assert.equal(plan.willDo, 50);
  assert.deepEqual(plan.batches, [10, 10, 10, 10, 10]);
});

// ------------------------------------------------------- 宝箱库存读取

test("readChestInventory: 对象形式 + 缺项补 0", () => {
  const inv = readChestInventory({ 2002: { quantity: 7 }, 2004: 3 });
  assert.equal(inv[2001], 0);
  assert.equal(inv[2002], 7);
  assert.equal(inv[2003], 0);
  assert.equal(inv[2004], 3);
  assert.equal(inv[2005], 0);
});

test("readChestInventory: 数组形式", () => {
  const inv = readChestInventory([
    { id: 2001, quantity: 5 },
    { itemId: 2003, count: 9 },
  ]);
  assert.equal(inv[2001], 5);
  assert.equal(inv[2003], 9);
  assert.equal(inv[2002], 0);
});

// --------------------------------------------------- 推进期全开清单

const INV_A = { 2001: 300, 2002: 100, 2003: 50, 2004: 10, 2005: 30 };

test("chestScoreAvailable: 钻石箱不计、木箱扣 200", () => {
  // 10×50 + 50×20 + 100×10 + (300-200)×1 = 2600
  assert.equal(chestScoreAvailable(INV_A), 2600);
});

test("planOpenAll: 顺序铂金→黄金→青铜→木箱，钻石不开，木箱留 200", () => {
  const steps = planOpenAll(INV_A);
  assert.deepEqual(steps, [
    { itemId: 2004, number: 10 },
    { itemId: 2003, number: 50 },
    { itemId: 2002, number: 100 },
    { itemId: 2001, number: 100 },
  ]);
});

test("planOpenAll: 木箱不超保留量则不开木箱", () => {
  const steps = planOpenAll({ 2001: 150, 2004: 2 });
  assert.deepEqual(steps, [{ itemId: 2004, number: 2 }]);
});

// --------------------------------------------------- 差值精确开箱

test("planPreciseOpen: ceil 保证达标，超出留在未兑换积分", () => {
  // 差 990：铂金 10 个(500) 后剩 490 → 黄金 ceil(490/20)=25 个(500分，超 10 分)
  const { steps, remainingScore } = planPreciseOpen(990, INV_A);
  assert.deepEqual(steps, [
    { itemId: 2004, number: 10 },
    { itemId: 2003, number: 25 },
  ]);
  assert.equal(remainingScore, 0);
});

test("planPreciseOpen: 跨三档组合", () => {
  // 差 2000：铂金 500 → 黄金 1000(50个) → 青铜 500(50个)
  const { steps, remainingScore } = planPreciseOpen(2000, INV_A);
  assert.deepEqual(steps, [
    { itemId: 2004, number: 10 },
    { itemId: 2003, number: 50 },
    { itemId: 2002, number: 50 },
  ]);
  assert.equal(remainingScore, 0);
});

test("planPreciseOpen: 库存不够时 remainingScore 保留差值", () => {
  // 可开总分 2600 < 5000 → 全开，仍差 2400
  const { steps, remainingScore } = planPreciseOpen(5000, INV_A);
  assert.deepEqual(steps, planOpenAll(INV_A));
  assert.equal(remainingScore, 2400);
});

test("planPreciseOpen: 差值为 0/负数返回空计划", () => {
  const { steps, remainingScore } = planPreciseOpen(0, INV_A);
  assert.deepEqual(steps, []);
  assert.equal(remainingScore, 0);
});

// ------------------------------------------------------- 推进循环判定

test("shouldKeepLooping: 伪代码 while 条件", () => {
  // 96000 + 2600 = 98600 < 99000 → 继续
  assert.equal(shouldKeepLooping(96000, INV_A, 99000), true);
  // 96400 + 2600 = 99000 → 退出循环进差值精确开
  assert.equal(shouldKeepLooping(96400, INV_A, 99000), false);
});

// ------------------------------------------------------- 兑换次数估算

test("estimateExchangeSteps: 5200 分从 0 档兑到付不起", () => {
  const { count, totalCost } = estimateExchangeSteps(5200, 0);
  // 10 整轮(4500) + 第 11 轮兑 10/20/30/40/80 后剩 20 < 100 停
  assert.equal(count, 95);
  assert.equal(totalCost, 5180);
});

test("estimateExchangeSteps: 首档即付不起 / 从 pos 起步", () => {
  assert.deepEqual(estimateExchangeSteps(30, 5), { count: 0, totalCost: 0, steps: [] });
  const r = estimateExchangeSteps(150, 5); // pos5=100 → 剩 50 < 70(pos6)
  assert.deepEqual({ count: r.count, totalCost: r.totalCost }, { count: 1, totalCost: 100 });
});

// ------------------------------------------------------- 常量与占位

test("档位表/分值/兑换轮成本与介绍文档一致", () => {
  assert.deepEqual(CHEST_POINTS, { 2001: 1, 2002: 10, 2003: 20, 2004: 50, 2005: 0 });
  assert.equal(BOX_POINT_ROUND_TOTAL, 500);
  assert.deepEqual(GOLDENFISH_CONSUME_DEFAULTS, { recruitTarget: 3900, boxTarget: 99000, fishTarget: 1150 });
});

test("readActivityProgress: 阶段B 前占位返回 null（调用方须中止）", () => {
  assert.equal(readActivityProgress({ statistics: {} }), null);
});
