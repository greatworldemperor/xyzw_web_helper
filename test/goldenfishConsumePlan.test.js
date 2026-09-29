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
  alignDownToBatch,
  planCountConsume,
  readChestInventory,
  chestScoreAvailable,
  planOpenAll,
  planPreciseOpen,
  shouldKeepLooping,
  estimateExchangeSteps,
  readActivityProgress,
  resolveGoldenfishActivity,
  isGoldenfishTaskMap,
  isFullGoldenfishTaskMap,
  GOLDENFISH_CONSUME_DEFAULTS,
  OPENBOX_BATCH_SIZE,
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

// --------------------------------------- alignDown：余数不足一批不做（2026-09-29 master 口径）
// 抓包口径：招募/钓鱼单发固定 10，余数批次（如 recruitNumber:3）会被服务端 200020 拒绝。

test("planCountConsume alignDown: 差 3 次不足一批 → 不发（留待最后补满）", () => {
  const plan = planCountConsume({
    done: 3897,
    target: 3900,
    stock: 351,
    batchSize: 10,
    alignDown: true,
  });
  assert.equal(plan.willDo, 0);
  assert.deepEqual(plan.batches, []);
  assert.equal(plan.alignedShort, true);
  assert.equal(plan.stockShort, true); // 有未完成量
  assert.equal(plan.reached, false);
});

test("planCountConsume alignDown: 差 17 → 只发一批 10，余 7 留待补满", () => {
  const plan = planCountConsume({
    done: 3883,
    target: 3900,
    stock: 351,
    batchSize: 10,
    alignDown: true,
  });
  assert.equal(plan.willDo, 10);
  assert.deepEqual(plan.batches, [10]);
  assert.equal(plan.alignedShort, true);
});

test("planCountConsume alignDown: 差值恰为整批 → 全量发不受影响", () => {
  const plan = planCountConsume({
    done: 3850,
    target: 3900,
    stock: 351,
    batchSize: 10,
    alignDown: true,
  });
  assert.equal(plan.willDo, 50);
  assert.deepEqual(plan.batches, [10, 10, 10, 10, 10]);
  assert.equal(plan.alignedShort, false);
  assert.equal(plan.stockShort, false);
});

test("planCountConsume alignDown: 库存不足整批 → 一批也不发", () => {
  const plan = planCountConsume({
    done: 3893,
    target: 3900,
    stock: 5,
    batchSize: 10,
    alignDown: true,
  });
  assert.equal(plan.willDo, 0); // 库存 5 不够一批 10，发 5 也会被 200020 拒
  assert.deepEqual(plan.batches, []);
  assert.equal(plan.alignedShort, true);
  assert.equal(plan.stockShort, true);
});

test("planCountConsume alignDown: 未开启时不影响既有行为", () => {
  const plan = planCountConsume({ done: 3897, target: 3900, stock: 351, batchSize: 10 });
  assert.equal(plan.willDo, 3); // 既有口径：余数照发（开箱等场景仍需要）
  assert.deepEqual(plan.batches, [3]);
  assert.equal(plan.alignedShort, false);
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
  const steps = planOpenAll({ 2001: 150, 2004: 12 });
  assert.deepEqual(steps, [{ itemId: 2004, number: 10 }]);
});

test("planOpenAll: 每档向下对齐到整批（服务端只认整批开箱，余数开不动）", () => {
  // 铂金 12→10、黄金 5→0、青铜 27→20、木箱 208−200=8→0
  const steps = planOpenAll({ 2001: 208, 2002: 27, 2003: 5, 2004: 12 });
  assert.deepEqual(steps, [
    { itemId: 2004, number: 10 },
    { itemId: 2002, number: 20 },
  ]);
  // 全部 number 必为整批倍数 → chunkBatches 切出来绝不会出现 <10 的尾帧
  assert.ok(steps.every((s) => s.number % OPENBOX_BATCH_SIZE === 0));
  // 只剩余数（<10）时：开不动 → 空清单（正是线上失败号的画像）
  assert.deepEqual(planOpenAll({ 2001: 208, 2002: 7, 2003: 0, 2004: 0 }), []);
});

test("alignDownToBatch: 向下对齐到整批", () => {
  assert.equal(alignDownToBatch(0), 0);
  assert.equal(alignDownToBatch(7), 0);
  assert.equal(alignDownToBatch(10), 10);
  assert.equal(alignDownToBatch(885), 880);
  assert.equal(alignDownToBatch(208), 200);
  assert.equal(alignDownToBatch(null), 0);
});

// --------------------------------------------------- 差值精确开箱

test("planPreciseOpen: ceil 保证达标，超出留在未兑换积分", () => {
  // 差 990：铂金 10 个(500) 后剩 490 → 黄金需 25 个，但只能整批 → 取 30 个（600 分，超 110）
  const { steps, remainingScore } = planPreciseOpen(990, INV_A);
  assert.deepEqual(steps, [
    { itemId: 2004, number: 10 },
    { itemId: 2003, number: 30 },
  ]);
  assert.equal(remainingScore, 0);
});

test("planPreciseOpen: 每档 number 必为整批倍数（余数批会被服务端拒）", () => {
  // 差 45：铂金 0（INV 里铂金 2 → 不足一批，开不动）→ 青铜需 5 个 → 补齐到 10 个
  const { steps, remainingScore } = planPreciseOpen(45, { 2004: 2, 2002: 100 });
  assert.deepEqual(steps, [{ itemId: 2002, number: 10 }]);
  assert.ok(steps.every((s) => s.number % OPENBOX_BATCH_SIZE === 0));
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
  // 钓鱼 1140 而非 1150：给 10 月留 160 次额度（1140+160=1300），需求原文第 31 行 + 抓包实测
  assert.deepEqual(GOLDENFISH_CONSUME_DEFAULTS, { recruitTarget: 3900, boxTarget: 99000, fishTarget: 1140 });
});

// ------------------------------------------- 活动实例识别与进度读取（阶段 B）

/**
 * 真实抓包夹具（`local-data/goldenfish/goldenfish_task_and_rewards1.jsonl` 的
 * `Activity_GetResp` → `body.activity.commonActivityInfo`，2026-09-25）
 *
 * 关键点：同期有 5 个 7 位键，只有 2609251 是真金鱼 ——
 *   2609252/3/4 无 task；2609255 的 task 键是**负数**（-1/-2/-4/-5）。
 */
const CAPTURE_COMMON = {
  2609251: {
    record: { 1: 1790578205, 21: 1790578207, 41: 1790578208, 61: 1790578212, 81: 1790578214 },
    task: { 1: 3685, 2: 96530, 3: 1140, 4: 632, 5: 20389 },
    isBought: false,
  },
  2609252: { isBought: false },
  2609253: { isBought: false },
  2609254: { isBought: false },
  2609255: { record: null, task: { "-2": 0, "-1": 0, "-4": 0, "-5": 0 }, isBought: false },
};

test("isGoldenfishTaskMap: 键全部落在 1..5 才算；负数/混合键否决", () => {
  assert.equal(isGoldenfishTaskMap({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }), true);
  assert.equal(isGoldenfishTaskMap({ 3: 1140 }), true); // 部分命中也算（该步缺字段会单独跳过）
  assert.equal(isGoldenfishTaskMap({ "-1": 0, "-2": 0 }), false); // 2609255
  assert.equal(isGoldenfishTaskMap({ 1: 0, 7: 0 }), false); // 7 超界
  assert.equal(isGoldenfishTaskMap({}), false);
  assert.equal(isGoldenfishTaskMap(null), false);
  assert.equal(isFullGoldenfishTaskMap({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }), true);
  assert.equal(isFullGoldenfishTaskMap({ 3: 1140 }), false);
});

test("resolveGoldenfishActivity: 同期 5 个键里挑出 2609251（否定 2609255 的负数键）", () => {
  const r = resolveGoldenfishActivity(CAPTURE_COMMON);
  assert.equal(r.ok, true);
  assert.equal(r.activityId, "2609251");
  assert.equal(r.source, "auto");
  assert.deepEqual(r.candidates, ["2609251"]);
});

test("readActivityProgress: 读真实抓包 → 五类进度逐字段一致", () => {
  const p = readActivityProgress({ body: { activity: { commonActivityInfo: CAPTURE_COMMON } } });
  assert.equal(p.activityId, "2609251");
  assert.equal(p.recruitDone, 3685);
  assert.equal(p.boxScoreDone, 96530);
  assert.equal(p.fishDone, 1140);
  assert.equal(p.jarDone, 632);
  assert.equal(p.goldDone, 20389);
  // record = 已领奖的 missionId → 时间戳（收尾补领用）
  assert.deepEqual(Object.keys(p.record), ["1", "21", "41", "61", "81"]);
});

test("readActivityProgress: 兼容裸 body / activity 两种层级", () => {
  const bare = readActivityProgress({ activity: { commonActivityInfo: CAPTURE_COMMON } });
  assert.equal(bare.activityId, "2609251");
  const flat = readActivityProgress({ commonActivityInfo: CAPTURE_COMMON });
  assert.equal(flat.activityId, "2609251");
});

test("readActivityProgress: 找不到金鱼活动一律返回 null（宁可不跑不可盲跑）", () => {
  assert.equal(readActivityProgress({ statistics: {} }), null);
  assert.equal(readActivityProgress({}), null);
  assert.equal(readActivityProgress(null), null);
  // 只有 2609255 这类非金鱼活动 → 仍然 null
  assert.equal(
    readActivityProgress({ commonActivityInfo: { 2609255: CAPTURE_COMMON[2609255] } }),
    null,
  );
  // 键不是 7 位数字（历史脏数据）→ 不入选
  assert.equal(
    readActivityProgress({ commonActivityInfo: { 1003: { task: { 1: 1 } } } }),
    null,
  );
});

test("readActivityProgress: 缺槽位 → 该字段 null 而不冒充 0", () => {
  const p = readActivityProgress({
    commonActivityInfo: { 2609251: { task: { 1: 3685 } } },
  });
  assert.equal(p.recruitDone, 3685);
  assert.equal(p.boxScoreDone, null);
  assert.equal(p.fishDone, null);
  assert.equal(p.jarDone, null);
  assert.equal(p.goldDone, null);
  // 显式 null 值同样视为「读不到」（Number(null)===0 陷阱）
  const p2 = readActivityProgress({
    commonActivityInfo: { 2609251: { task: { 1: null, 2: "" } } },
  });
  assert.equal(p2.recruitDone, null);
  assert.equal(p2.boxScoreDone, null);
});

test("resolveGoldenfishActivity: 多期残留取最大 ID（最新一期）", () => {
  const r = resolveGoldenfishActivity({
    ...CAPTURE_COMMON,
    2609181: { task: { 1: 100, 2: 200, 3: 300, 4: 1, 5: 2 } }, // 上一期残留
  });
  assert.equal(r.activityId, "2609251");
  assert.deepEqual([...r.candidates].sort(), ["2609181", "2609251"]);
});

test("resolveGoldenfishActivity: 完整签名（恰好 1..5）优先于部分签名", () => {
  const r = resolveGoldenfishActivity({
    2609251: { task: { 1: 1, 2: 2 } }, // 部分签名但 ID 更大
    2609181: { task: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 } }, // 完整签名
  });
  assert.equal(r.activityId, "2609181");
});

test("resolveGoldenfishActivity: 手工 ID 优先级最高（哪怕 task 表不完整）", () => {
  const r = resolveGoldenfishActivity(
    { 2609251: { task: { 1: 3685, 2: 96530, 3: 1140, 4: 632, 5: 20389 } }, 2609255: { task: {} } },
    { manualId: "2609255" },
  );
  assert.equal(r.ok, true);
  assert.equal(r.activityId, "2609255");
  assert.equal(r.source, "manual");
  assert.equal(readActivityProgress({ commonActivityInfo: { 2609251: { task: { 3: 1140 } } } }, { manualId: "2609251" }).fishDone, 1140);
});

test("resolveGoldenfishActivity: 手工 ID 非法/不存在时给明确原因", () => {
  const bad = resolveGoldenfishActivity(CAPTURE_COMMON, { manualId: "abc" });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /不是 7 位数字/);
  const missing = resolveGoldenfishActivity(CAPTURE_COMMON, { manualId: "2601011" });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /没有活动 2601011/);
});
