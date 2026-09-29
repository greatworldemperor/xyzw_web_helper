/**
 * 金鱼「收尾」纯逻辑回归测试（阶段 C 的档位表 / 领奖 / 开箱 / 补档组合）
 *
 * 需求来源：`local-data/goldenfish/a_brief_introduction.txt`
 * 抓包实证：`local-data/goldenfish/goldenfish_task_and_rewards1.jsonl`
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ROUNDS_PER_TASK,
  GOLDENFISH_TIERS,
  GOLDENFISH_GOLD_UNIT,
  GOLDENFISH_UNIT_LABELS,
  GOLDENFISH_ROD_PRICE,
  GOLDENFISH_FISH_MIN_TARGET,
  GOLDENFISH_FISH_FULL,
  buildRoundTable,
  taskTotals,
  totalRewardAllTasks,
  completedRounds,
  costToReachRound,
  rewardFromRoundTo,
  toMissionId,
  fromMissionId,
  readClaimedMissionIds,
  planClaimSweep,
  createRng,
  GOLDENFISH_PACK_BIAS_MAX,
  GOLDENFISH_PACK_BIAS_WEIGHTS,
  GOLDENFISH_PACK_BIAS_TOTAL,
  packBias,
  openPacks,
  packsNeededForGap,
  openPackReturns,
  GOLDENFISH_PACK_RETURNS,
  GOLDENFISH_PLATINUM_BOX_DROPS,
  GOLDENFISH_PLATINUM_BOX_HIT_RATE,
  planRodPurchase,
  twoForOneCandidate,
  simulateFinish,
  GOLDENFISH_ROD_RETURN_RATE,
  GOLDENFISH_OBSERVE_GOLD,
  GOLDENFISH_GOLD_TARGET,
} from "../src/utils/goldenfishFinishPlan.js";

// ------------------------------------------------------------------ 夹具

/** 真实抓包快照（local-data/goldenfish/goldenfish_task_and_rewards1.jsonl） */
const CAPTURE_TASK = { 1: 3685, 2: 96530, 3: 1140, 4: 632, 5: 20389 };
/** 抓包时手动点了 5 次领取：每类任务的第 1 轮 */
const CAPTURE_RECORD = { 1: 1, 21: 1, 41: 1, 61: 1, 81: 1 };

// ------------------------------------------------------------------ 1. 档位表

test("档位表：五类任务全满累计与原文逐条一致", () => {
  assert.deepEqual(taskTotals(1), { maxThreshold: 4000, maxReward: 400, rounds: 20 });
  assert.deepEqual(taskTotals(2), { maxThreshold: 100000, maxReward: 200, rounds: 20 });
  assert.deepEqual(taskTotals(3), { maxThreshold: 1750, maxReward: 280, rounds: 20 });
  assert.deepEqual(taskTotals(4), { maxThreshold: 60, maxReward: 20, rounds: 20 });
  // slot 5 的量纲是**实际金砖数**（50 个「万金砖」单位）——这是最易错的一处
  assert.deepEqual(taskTotals(5), { maxThreshold: 500000, maxReward: 150, rounds: 20 });
});

test("档位表：五类全满道具总数 = 1050（原文第 85 行交叉验证）", () => {
  assert.equal(totalRewardAllTasks(), 1050);
  // 也等于逐槽位相加
  const sum = [1, 2, 3, 4, 5].reduce((s, slot) => s + taskTotals(slot).maxReward, 0);
  assert.equal(sum, 1050);
});

test("档位表：每任务恰好 20 轮，轮次连续", () => {
  for (const slot of [1, 2, 3, 4, 5]) {
    const rows = buildRoundTable(slot);
    assert.equal(rows.length, ROUNDS_PER_TASK, `slot ${slot}`);
    rows.forEach((row, i) => assert.equal(row.round, i + 1));
    // 阈值严格递增
    for (let i = 1; i < rows.length; i += 1) {
      assert.ok(rows[i].threshold > rows[i - 1].threshold);
    }
  }
});

test("档位表：slot 5 的 unit 与 cost 相差 10000 倍（量纲分离）", () => {
  const rows = buildRoundTable(5);
  for (const row of rows) {
    assert.equal(row.cost, row.unit * GOLDENFISH_GOLD_UNIT);
  }
  assert.equal(rows[0].unit, 1);
  assert.equal(rows[0].cost, 10000);
  assert.equal(rows[19].unit, 4);
  assert.equal(rows[19].cost, 40000);
});

test("档位表：单位标签覆盖 5 类", () => {
  assert.deepEqual(Object.keys(GOLDENFISH_UNIT_LABELS).sort(), ["1", "2", "3", "4", "5"]);
  assert.equal(Object.keys(GOLDENFISH_TIERS).length, 5);
});

test("completedRounds：抓包进度反查轮次", () => {
  assert.equal(completedRounds(1, 3685), 19);
  assert.equal(completedRounds(2, 96530), 19);
  assert.equal(completedRounds(3, 1140), 15);
  assert.equal(completedRounds(4, 632), 20); // 罐子 632 早已超 60
  assert.equal(completedRounds(5, 20389), 2); // 20389 ≥ 20000（第 2 轮）
  // 边界
  assert.equal(completedRounds(1, 0), 0);
  assert.equal(completedRounds(1, -5), 0);
  assert.equal(completedRounds(1, 4000), 20);
  assert.equal(completedRounds(1, 999999), 20);
});

test("completedRounds：进度恰好等于阈值算达标", () => {
  const rows = buildRoundTable(1);
  for (const row of rows) {
    assert.equal(completedRounds(1, row.threshold), row.round);
    if (row.threshold > 0) assert.equal(completedRounds(1, row.threshold - 1), row.round - 1);
  }
});

test("抓包进度累计道具 = 746（档位表与进度的交叉验证）", () => {
  let items = 0;
  for (const slot of [1, 2, 3, 4, 5]) {
    items += rewardFromRoundTo(slot, 0, completedRounds(slot, CAPTURE_TASK[slot]));
  }
  assert.equal(items, 746);
});

test("costToReachRound / rewardFromRoundTo：前缀推进自洽", () => {
  // 招募前 5 轮 = 5×80 = 400，道具 5×8 = 40
  assert.equal(costToReachRound(1, 0, 5), 400);
  assert.equal(rewardFromRoundTo(1, 0, 5), 40);
  // 从第 5 轮推到第 10 轮 = 5×160 = 800
  assert.equal(costToReachRound(1, 5, 10), 800);
  assert.equal(rewardFromRoundTo(1, 5, 10), 80);
  // 全量
  assert.equal(costToReachRound(3, 0, 20), taskTotals(3).maxThreshold);
  assert.equal(rewardFromRoundTo(3, 0, 20), taskTotals(3).maxReward);
  // 反向/越界不产生负值
  assert.equal(costToReachRound(1, 10, 5), 0);
});

// ------------------------------------------------------------------ 2. missionId 与领奖

test("toMissionId：实测 5 次连发 = 1/21/41/61/81", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((slot) => toMissionId(slot, 1)), [1, 21, 41, 61, 81]);
  assert.equal(toMissionId(5, 20), 100);
});

test("fromMissionId：往返一致，越界返回 null", () => {
  for (let id = 1; id <= 100; id += 1) {
    const { slot, round } = fromMissionId(id);
    assert.equal(toMissionId(slot, round), id);
  }
  assert.equal(fromMissionId(0), null);
  assert.equal(fromMissionId(101), null);
  assert.equal(fromMissionId("x"), null);
});

test("readClaimedMissionIds：过滤非法键，兼容数组键名", () => {
  const set = readClaimedMissionIds({ 1: 1, "21": 1, 101: 1, abc: 1, "-3": 1 });
  assert.deepEqual([...set].sort((a, b) => a - b), [1, 21]);
  assert.equal(readClaimedMissionIds(null).size, 0);
  assert.equal(readClaimedMissionIds(undefined).size, 0);
});

test("planClaimSweep：抓包场景 70 条待领（18/18/14/19/1）", () => {
  const sweep = planClaimSweep(CAPTURE_TASK, CAPTURE_RECORD);
  assert.equal(sweep.pending.length, 70);
  assert.equal(sweep.alreadyClaimed, 5);
  const bySlot = {};
  for (const p of sweep.pending) bySlot[p.slot] = (bySlot[p.slot] || 0) + 1;
  assert.deepEqual(bySlot, { 1: 18, 2: 18, 3: 14, 4: 19, 5: 1 });
  // 首条 = slot1 第 2 轮（第 1 轮已领）
  assert.deepEqual(sweep.pending[0], { slot: 1, round: 2, missionId: 2, reward: 8 });
  // items = 各条 reward 之和
  assert.equal(sweep.items, sweep.pending.reduce((s, p) => s + p.reward, 0));
});

test("planClaimSweep：已领全部时 pending 为空", () => {
  const record = {};
  for (const slot of [1, 2, 3, 4, 5]) {
    for (let r = 1; r <= 20; r += 1) record[toMissionId(slot, r)] = 1;
  }
  const sweep = planClaimSweep({ 1: 4000, 2: 100000, 3: 1750, 4: 60, 5: 500000 }, record);
  assert.equal(sweep.pending.length, 0);
  assert.equal(sweep.items, 0);
});

test("planClaimSweep：maxRound 可截断扫描范围", () => {
  const full = planClaimSweep({ 1: 4000 }, {}, { maxRound: 5 });
  assert.equal(full.pending.length, 5);
  assert.ok(full.pending.every((p) => p.round <= 5));
});

test("planClaimSweep：全空进度不产生待领项", () => {
  const sweep = planClaimSweep({}, {});
  assert.equal(sweep.pending.length, 0);
  assert.equal(sweep.detected, 0);
});

// ------------------------------------------------------------------ 3. 开普通道具（有保底：期望 + 有界线性 bias）
//
// 🔴 master 2026-09-28 定口径（**有保底**）：
//   特殊道具数 = round(普通道具数 × 0.25 + bias)，bias ∈ [-5,5] 的整数、概率**线性**（峰在 0）
//   —— 不用正态分布，只是**验证逻辑**，不追求精确还原。
// （⚠️ 不是开宝箱：宝箱只产宝箱积分，对拿金鱼没有直接产出。）

test("createRng：同种子可复现，不同种子不同", () => {
  const a = createRng(42);
  const b = createRng(42);
  const c = createRng(43);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  const seqC = [c(), c(), c()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

test("bias 权重：线性递减、对称、总和 36", () => {
  assert.equal(GOLDENFISH_PACK_BIAS_MAX, 5);
  assert.equal(GOLDENFISH_PACK_BIAS_WEIGHTS.length, 11); // -5..5
  assert.equal(GOLDENFISH_PACK_BIAS_TOTAL, 36);
  // 峰在 0（下标 5），两端最小（权重 1）⇒ 对 |b| 线性递减
  for (let i = 0; i <= 5; i += 1) {
    const expected = 6 - i;
    assert.equal(GOLDENFISH_PACK_BIAS_WEIGHTS[5 - i], expected, `bias=-${i}`);
    assert.equal(GOLDENFISH_PACK_BIAS_WEIGHTS[5 + i], expected, `bias=+${i}`);
  }
  // 对称 ⇒ E[bias] = 0
  let weighted = 0;
  for (let i = 0; i < 11; i += 1) weighted += (i - 5) * GOLDENFISH_PACK_BIAS_WEIGHTS[i];
  assert.equal(weighted, 0);
});

test("packBias：取值恒为 [-5,5] 的整数，且分布近似线性", () => {
  const rng = createRng(4242);
  const n = 36000;
  const hist = new Array(11).fill(0);
  for (let i = 0; i < n; i += 1) {
    const b = packBias(rng);
    assert.ok(Number.isInteger(b) && b >= -5 && b <= 5, `实际 ${b}`);
    hist[b + 5] += 1;
  }
  // p(b) = (6-|b|)/36 —— 用 36000 次采样核对（容差 ~5%）
  for (let i = 0; i < 11; i += 1) {
    const expected = GOLDENFISH_PACK_BIAS_WEIGHTS[i] / 36;
    assert.ok(
      Math.abs(hist[i] / n - expected) < 0.02,
      `bias=${i - 5} 实测 ${(hist[i] / n).toFixed(4)} vs 理论 ${expected.toFixed(4)}`,
    );
  }
  // rng 恰好返回 1 时也要落在范围内（浮点兜底）
  assert.equal(packBias(() => 1), 0);
});

test("openPacks：同种子结果完全一致（可复现）", () => {
  const r1 = openPacks({ count: 500, seed: 7 });
  const r2 = openPacks({ count: 500, seed: 7 });
  assert.deepEqual(r1, r2);
  assert.equal(r1.packs, 500);
});

test("openPacks：结果 = round(n×p + bias)，且 base/bias 都被返回", () => {
  const r = openPacks({ count: 1000, rate: 0.25, seed: 1 });
  assert.equal(r.base, 250);
  assert.equal(r.mean, 250); // 兼容旧字段名
  assert.ok(Number.isInteger(r.bias) && Math.abs(r.bias) <= 5, `bias=${r.bias}`);
  assert.equal(r.special, Math.max(0, Math.min(1000, Math.round(r.base + r.bias))));
  assert.equal(r.deviation, r.special - r.base);
  assert.equal(r.biasMax, GOLDENFISH_PACK_BIAS_MAX);
});

test("openPacks：多种子样本均值仍收敛到 n×p（bias 对称 ⇒ 期望不漂）", () => {
  const n = 1000;
  const p = 0.25;
  const trials = 400;
  let sum = 0;
  for (let i = 0; i < trials; i += 1) sum += openPacks({ count: n, rate: p, seed: 1000 + i }).special;
  const mean = sum / trials;
  // 单次偏差 |bias| ≤ 5 ⇒ 400 次的样本均值标准误 ≈ 5/√400 的几分之一，容差 3 足够
  assert.ok(Math.abs(mean - n * p) < 3, `样本均值 ${mean} 应贴近 ${n * p}`);
});

test("openPacks：偏差**绝对有界**（|special − round(base)| ≤ 5，正是「保底」）", () => {
  for (const count of [100, 500, 1050, 4000]) {
    for (let seed = 1; seed <= 120; seed += 1) {
      const r = openPacks({ count, seed });
      assert.ok(
        Math.abs(r.special - Math.round(r.base)) <= GOLDENFISH_PACK_BIAS_MAX,
        `count=${count} seed=${seed} → special=${r.special}, base=${r.base}`,
      );
    }
  }
  // 相对偏差随数量增大而收窄 —— 这跟「开得越多越接近 25%」的保底直觉一致
  const rel = (count) => GOLDENFISH_PACK_BIAS_MAX / (count * 0.25);
  assert.ok(rel(1050) < 0.02, `1050 个道具时的相对偏差上界 ${rel(1050)}`);
});

test("openPacks：截断到 [0, count]，不会出现负数或超过道具数", () => {
  for (const count of [0, 1, 2, 3, 5, 10]) {
    for (let seed = 1; seed <= 60; seed += 1) {
      const r = openPacks({ count, seed });
      assert.ok(
        Number.isInteger(r.special) && r.special >= 0 && r.special <= count,
        `count=${count} seed=${seed} → special=${r.special}`,
      );
    }
  }
});

test("openPacks：count=0 / 负数不产出、也不抽 bias", () => {
  const r = openPacks({ count: 0, seed: 1 });
  assert.equal(r.special, 0);
  assert.equal(r.packs, 0);
  assert.equal(r.base, 0);
  assert.equal(r.mean, 0);
  assert.equal(r.bias, 0, "count=0 时不应消耗 rng 去抽 bias");
  assert.equal(openPacks({ count: -5, seed: 1 }).special, 0);
  assert.equal(openPacks({ count: NaN, seed: 1 }).special, 0);
});

test("openPacks：openedCount 跨批次累加（每批各抽一次 bias）", () => {
  const p1 = openPacks({ count: 100, seed: 1 });
  assert.equal(p1.openedCount, 100);
  const p2 = openPacks({ count: 50, seed: 2, openedCount: p1.openedCount });
  assert.equal(p2.openedCount, 150);
});

test("openPacks：rate 非法时回落到 0.25；rate=0 时 base=0（只剩 bias，会被截断）", () => {
  assert.equal(openPacks({ count: 400, rate: NaN, seed: 1 }).base, 100);
  assert.equal(openPacks({ count: 400, rate: 1.5, seed: 1 }).base, 100);
  const zero = openPacks({ count: 400, rate: 0, seed: 1 });
  assert.equal(zero.base, 0);
  assert.equal(zero.mean, 0);
});

test("packsNeededForGap：差 n 个 → 4n 个（原文第 87 行口径）", () => {
  assert.equal(packsNeededForGap(10, 0.25), 40);
  assert.equal(packsNeededForGap(1, 0.25), 4);
  assert.equal(packsNeededForGap(0, 0.25), 0);
  assert.equal(packsNeededForGap(10, 0.5), 20);
});

// ------------------------------------------------------------------ 4. 买鱼竿补档（原文第 135 行）

test("GOLDENFISH_ROD_PRICE：原价鱼竿 600 金砖/根（原文第 135 行）", () => {
  assert.equal(GOLDENFISH_ROD_PRICE, 600);
});

test("openPackReturns：开 1 个道具的返还期望（原文第 119 行）", () => {
  assert.deepEqual(openPackReturns(1), {
    recruitToken: 0.5,
    platinumBox: 0.205,
    gold: 107.304,
    special: 0.25,
  });
  const many = openPackReturns(1050);
  assert.equal(many.recruitToken, 525);
  assert.ok(Math.abs(many.platinumBox - 215.25) < 1e-9);
  assert.ok(Math.abs(many.gold - 112669.2) < 1e-6);
  // 0 / 负数 / 非数字都不产生返还
  assert.equal(openPackReturns(0).gold, 0);
  assert.equal(openPackReturns(-5).gold, 0);
  assert.equal(openPackReturns(NaN).gold, 0);
});

test("openPackReturns：四项是「同时获取」不是多选一（master 2026-09-28 澄清）", () => {
  // 只开 1 个道具时，四项期望**全部非零** ⇒ 必须同时累加四项，
  // 若实现成「按概率选一项」则这里只会有一项非零。
  const one = openPackReturns(1);
  for (const key of ["recruitToken", "platinumBox", "gold", "special"]) {
    assert.ok(one[key] > 0, `${key} 应为正数（四项同时获取）`);
  }
  // 四项都随数量线性增长，且各自独立（比值恒等于 GOLDENFISH_PACK_RETURNS）
  for (const n of [1, 7, 100, 774, 1050]) {
    const r = openPackReturns(n);
    assert.ok(Math.abs(r.recruitToken - n * GOLDENFISH_PACK_RETURNS.recruitToken) < 1e-9);
    assert.ok(Math.abs(r.platinumBox - n * GOLDENFISH_PACK_RETURNS.platinumBox) < 1e-12);
    assert.ok(Math.abs(r.gold - n * GOLDENFISH_PACK_RETURNS.gold) < 1e-6);
    assert.ok(Math.abs(r.special - n * GOLDENFISH_PACK_RETURNS.special) < 1e-9);
  }
});

test("铂金箱真实掉落分布：三项期望 = 0.205，命中率仅 6.2%", () => {
  // master 给的真实分布：4.5% → 2 个 / 1.1% → 5 个 / 0.6% → 10 个
  const expected = GOLDENFISH_PLATINUM_BOX_DROPS.reduce(
    (sum, d) => sum + d.rate * d.count,
    0,
  );
  assert.ok(
    Math.abs(expected - 0.205) < 1e-12,
    `分布期望 ${expected} 应精确等于 0.205`,
  );
  // 与返还常量自洽（这是「0.205 不是一个拍脑袋的数」的证据）
  assert.equal(GOLDENFISH_PACK_RETURNS.platinumBox, 0.205);
  assert.ok(Math.abs(expected - GOLDENFISH_PACK_RETURNS.platinumBox) < 1e-12);

  // 命中率：三个概率相加 = 6.2%（master 口述 6.1%，是心算滑了一下；以给定概率为准）
  const hit = GOLDENFISH_PLATINUM_BOX_DROPS.reduce((s, d) => s + d.rate, 0);
  assert.ok(Math.abs(hit - 0.062) < 1e-12, `命中率 ${hit} 应为 6.2%`);
  assert.equal(GOLDENFISH_PLATINUM_BOX_HIT_RATE, 0.062);
  // 93.8% 的道具开出来没有铂金箱 —— 这就是「单次方差极大」的来源
  assert.ok(Math.abs(1 - hit - 0.938) < 1e-12);
});

test("返还期望的小数不能逐次 floor（跨批次精度回归）", () => {
  // 模拟「小数累加 + 按累计 floor」的正确做法
  const sumFloor = (ns) => {
    let acc = 0;
    let issued = 0;
    for (const n of ns) {
      acc += openPackReturns(n).platinumBox;
      issued = Math.floor(acc); // 只发放累计值的整数部分
    }
    return issued;
  };
  // 错误做法：每批各自 floor 后相加
  const floorEach = (ns) =>
    ns.reduce((s, n) => s + Math.floor(openPackReturns(n).platinumBox), 0);
  const batches = [3, 3, 3, 3, 3]; // 各批 0.615 个 → 逐次 floor 全变 0
  assert.equal(floorEach(batches), 0);
  assert.equal(sumFloor(batches), 3); // 0.205 × 15 = 3.075 → 3
  // 大批量下两者应一致（说明差异只来自小数丢弃）
  assert.ok(Math.abs(sumFloor([1000, 200]) - 246) < 1e-9);
  assert.equal(floorEach([1000, 200]), 246);
});

test("planRodPurchase：一笔金砖支出同时推进金砖+钓鱼（不重复计费）", () => {
  const res = planRodPurchase({
    progressBySlot: { 3: 1140, 5: 20389 },
    needItems: 1,
    goldInStock: 1000000,
    rodsInStock: 0,
  });
  assert.ok(res.ok);
  // 金砖做满还需 500000-20389 = 479611 ⇒ ceil(479611/600) = 800 根
  assert.equal(res.rodsForGoldFull, 800);
  const m = res.master;
  assert.equal(m.rods, 800);
  assert.equal(m.goldSpend, 480000); // 唯一代价 = 金砖支出
  assert.equal(m.weight, m.goldSpend); // 不再有「鱼竿×600」的二次计费
  assert.equal(m.goldAfter, 500389);
  assert.ok(m.goldFull);
  // 1140 + 800（钓鱼只吃到 1750 封顶）= 1750 ⇒ 钓鱼做满 20 轮
  assert.equal(m.fishAfter, 1750);
  assert.ok(m.fishCapped);
  // 金砖 2 轮 → 20 轮 = 150-6 = 144；钓鱼 15 轮 → 20 轮 = 280-168 = 112
  assert.equal(m.items, 256);
});

test("planRodPurchase：钓鱼 1300 是下限、1750 才是硬上限（master 第 4 条澄清）", () => {
  // 同一份进度，两个 fishCap 的产出对比 —— 这是「978 → 1050」修正的微观证据
  const base = { progressBySlot: { 3: 1140, 5: 20389 }, needItems: 1, goldInStock: 1000000 };
  const at1300 = planRodPurchase({ ...base, fishCap: 1300 });
  const at1750 = planRodPurchase({ ...base, fishCap: 1750 });
  assert.equal(at1300.master.fishAfter, 1300);
  assert.equal(at1750.master.fishAfter, 1750);
  // 1300 → 17 轮（钓鱼得 40），1750 → 20 轮（钓鱼得 112）⇒ 多 72 个道具
  assert.equal(at1300.master.items, 184);
  assert.equal(at1750.master.items, 256);
  assert.equal(at1750.master.items - at1300.master.items, 72);
  // 默认就是全满上限
  assert.equal(planRodPurchase(base).master.fishAfter, GOLDENFISH_FISH_FULL);
});

test("planRodPurchase：收尾起点未必是 1140（库存不足少做的号，缺口/竿数按实际起点算）", () => {
  // 🔴 master 2026-09-29 收尾口径：「最后一天：① 宝箱和招募全部做满；② 鱼竿和金砖维持当前策略，
  //    但注意，起点未必是 1140」——
  //    9 月若因鱼竿库存不足只做到 1000（消耗阶段「有多少做多少」），收尾必须按 1000 起算缺口，
  //    不能假设 1140/1300。引擎以 progressBySlot[3] 为起点，本用例把这条口径钉死。
  const at = (start, fishCap) =>
    planRodPurchase({
      progressBySlot: { 3: start, 5: 20389 },
      needItems: 1,
      goldInStock: 1000000,
      rodsInStock: 0,
      fishCap,
    });

  // 起点 1000（完成 14 轮）：补到 1300 下限还差 300 次 → ceil(300×0.9) = 270 根
  const low = at(1000, GOLDENFISH_FISH_MIN_TARGET);
  assert.equal(completedRounds(3, 1000), 14);
  assert.equal(low.fishRoom, 300);
  assert.equal(low.rodsForFishCap, 270);

  // 同一 1000 起点、若推满 1750：还差 750 次 → 675 根
  const lowFull = at(1000, GOLDENFISH_FISH_FULL);
  assert.equal(lowFull.fishRoom, 750);
  assert.equal(lowFull.rodsForFishCap, 675);

  // 对照抓包起点 1140：补到 1300 只需 144 根 —— 起点低 140 次 ⇒ 多买 126 根
  const cap = at(1140, GOLDENFISH_FISH_MIN_TARGET);
  assert.equal(cap.rodsForFishCap, 144);
  assert.equal(low.rodsForFishCap - cap.rodsForFishCap, 126);

  // 起点已越过 1300 下限（库存充足做到 1400）⇒ 下限无需再补，room 归零
  const over = at(1400, GOLDENFISH_FISH_MIN_TARGET);
  assert.equal(over.fishRoom, 0);
  assert.equal(over.rodsForFishCap, 0);
});

test("钓鱼常量：1300 下限 / 1750 全满（20 轮）", () => {
  assert.equal(GOLDENFISH_FISH_MIN_TARGET, 1300); // 1140 + 160，原文第 31 行
  assert.equal(GOLDENFISH_FISH_FULL, 1750); // 档位表 20 轮累计
  assert.equal(taskTotals(3).maxThreshold, GOLDENFISH_FISH_FULL);
  assert.equal(completedRounds(3, GOLDENFISH_FISH_MIN_TARGET), 17); // 只到 17/20 轮
  assert.equal(completedRounds(3, GOLDENFISH_FISH_FULL), 20);
  // 全满道具 1050 = 本期上限（钓鱼做满 20 轮才拿得到全部 280 个）
  assert.equal(totalRewardAllTasks(), 1050);
});

test("planRodPurchase：minimal 是最小代价且确实满足 needItems", () => {
  const res = planRodPurchase({
    progressBySlot: { 3: 1140, 5: 20389 },
    needItems: 88,
    goldInStock: 1000000,
    rodsInStock: 0,
  });
  assert.ok(res.ok);
  // 🔴 判定口径是 totalItems（买杆收益 items + 罐子白送 freeItems），不是单独的 items
  //    （2026-09-28 修正：只用 items 会漏掉罐子那份，从而低估可达上限）
  assert.equal(res.freeItems, 20); // progressBySlot 未给 slot 4 ⇒ 视为罐子 20 轮全没做
  assert.ok(res.minimal.totalItems >= 88);
  assert.ok(res.minimal.goldSpend <= res.master.goldSpend);
  for (const p of res.plans) {
    if (p.goldSpend < res.minimal.goldSpend) {
      assert.ok(p.totalItems < 88, `rods=${p.rods} 也满足 88，说明 minimal 不是最小`);
    }
  }
});

test("planRodPurchase：金砖做满也不够时给出诚实上限", () => {
  const res = planRodPurchase({
    progressBySlot: { 3: 1140, 5: 20389 },
    needItems: 400,
    goldInStock: 1000000,
    rodsInStock: 0,
  });
  assert.equal(res.ok, false);
  assert.equal(res.best, null);
  assert.equal(res.maxItems, 256); // 金砖 144 + 钓鱼 112（1300 → 1750 全满）
  assert.equal(res.freeItems, 20); // 罐子自然完成白送的 20 个
  assert.equal(res.maxTotal, 276); // 判定分母 = 256 + 20
  assert.ok(res.reason.includes("276"), res.reason);
  // 金砖管够（100 万）却仍不够 ⇒ 这不是「金砖不足」，而是真·档位榨干
  assert.equal(res.blockedBy, "tiers");
  assert.equal(res.goldShortfall, 0);
});

test("planRodPurchase：金砖不足 ≠ 档位榨干（reason 必须区分，master 2026-09-28 实测踩到）", () => {
  const res = planRodPurchase({
    progressBySlot: { 3: 1140, 5: 20389 },
    needItems: 228,
    goldInStock: 80907, // 只买得起 134 根
    rodsInStock: 0,
  });
  assert.equal(res.ok, false);
  assert.equal(res.blockedBy, "gold"); // 🔴 旧版这里谎报成「档位榨干」
  assert.equal(res.rodsAffordable, 134);
  // 「做满」需要 800 根 = 480000 金砖，手上只有 80907
  assert.equal(res.rodsWanted, 800);
  assert.equal(res.goldNeeded, 480000);
  assert.equal(res.goldShortfall, 480000 - 80907);
  assert.ok(res.reason.startsWith("金砖不足"), res.reason);
  assert.ok(res.reason.includes("480000"), res.reason);
  assert.ok(res.reason.includes(String(480000 - 80907)), res.reason);
  // 报的「最多再拿」应是被预算截断后的数（134 根能换到的），不是一个假的「做满上限」
  assert.ok(res.maxTotal < 276, `实际 ${res.maxTotal}`);
});

test("planRodPurchase：金砖库存不足时买不满", () => {
  const res = planRodPurchase({
    progressBySlot: { 3: 0, 5: 0 },
    needItems: 1,
    goldInStock: 60000, // 只够买 100 根
    rodsInStock: 0,
  });
  assert.equal(res.rodsForGoldFull, 834); // ceil(500000/600)
  assert.equal(res.master.rods, 100);
  assert.equal(res.master.goldSpend, 60000);
  assert.equal(res.master.goldFull, false);
});

test("planRodPurchase：rodsInStock 默认 0（不假设手上已有鱼竿）", () => {
  const res = planRodPurchase({ progressBySlot: { 3: 1140, 5: 500000 }, needItems: 1 });
  assert.equal(res.caps.rodsInStock, 0);
  assert.equal(res.freeFish, 0);
  assert.equal(res.fishRoom, 610); // 1750 - 1140
  // 金砖已满 ⇒ 「做满」只能靠买鱼竿推钓鱼。
  // 🔴 10% 返还：钓 610 次只需 ceil(610×0.9) = 549 根（master 2026-09-28 补充口径）
  assert.equal(res.rodsForFishCap, 549);
  assert.equal(res.rodsWanted, 549);
  // 但 needItems=1 太容易满足：罐子自然完成白送 20 个 ⇒ 一根都不用买（不是 bug）
  assert.equal(res.freeItems, 20);
  assert.equal(res.master.rods, 0);
  // 需求超过白送量时才真的掏金砖
  const need = planRodPurchase({ progressBySlot: { 3: 1140, 5: 500000 }, needItems: 100 });
  assert.ok(need.master.rods > 0);
  assert.equal(need.master.rods, 549); // 金砖已满 ⇒ 一把推到钓鱼上限
});

test("planRodPurchase：手上已有鱼竿先抵扣（freeFish 不花金砖）", () => {
  const res = planRodPurchase({
    progressBySlot: { 3: 1140, 5: 500000 }, // 金砖已满
    needItems: 1,
    rodsInStock: 500,
    goldInStock: 1000000,
  });
  assert.equal(res.fishRoom, 610); // 钓鱼还差 610 次才到 1750
  assert.equal(res.freeFish, 500); // 手上 500 根可直接用（≤ 把钓鱼推满所需的 549 根）
  assert.equal(res.rodsForFishCap, 49); // 还需买的根数 = ceil(610×0.9) − 500
  assert.equal(res.master.rods, 0); // 金砖已满 + 罐子白送已满足 needItems ⇒ 不必买
  // 🔴 10% 返还：500 根 ≈ 可钓 floor(500/0.9) = 555 次 ⇒ fishAfter = 1140 + 555 = 1695
  assert.equal(res.master.fishAfter, 1695);
  assert.equal(res.master.items, 88); // 钓鱼 15 → 19 轮（1695 ≥ 1600），恰好 4 轮 = 20+20+24+24
  // 返还率可覆盖：传 0 关闭 ⇒ 回到旧口径（500 根 = 500 次）
  const noReturn = planRodPurchase({
    progressBySlot: { 3: 1140, 5: 500000 },
    needItems: 1,
    rodsInStock: 500,
    goldInStock: 1000000,
    rodReturnRate: 0,
  });
  assert.equal(noReturn.master.fishAfter, 1640); // 1140 + 500
  assert.equal(noReturn.rodsForFishCap, 110);
});

test("planRodPurchase：所有档位都已满 → 无可推进", () => {
  // ⚠️ 必须把 slot 4（罐子）也写满：否则「罐子自然完成白送 20 个」会满足 needItems=1，
  //    函数据此判 ok=true —— 那本身是对的，但就测不到「榨干」这条分支了。
  const res = planRodPurchase({
    progressBySlot: { 3: 1750, 4: 60, 5: 500000 }, // 钓鱼全满 + 罐子全满 + 金砖做满
    needItems: 1,
  });
  assert.equal(res.ok, false);
  assert.equal(res.maxItems, 0);
  assert.equal(res.freeItems, 0);
  assert.equal(res.maxTotal, 0);
  assert.equal(res.blockedBy, "tiers");
  assert.ok(res.reason.length > 0, res.reason);
});

test("planRodPurchase：needItems 非法值不崩", () => {
  assert.doesNotThrow(() => planRodPurchase({ needItems: NaN }));
  assert.doesNotThrow(() => planRodPurchase({ progressBySlot: null, needItems: "x" }));
  const r = planRodPurchase({ progressBySlot: { 3: 0, 5: 0 }, needItems: 0 });
  assert.equal(r.ok, true);
  assert.ok(r.best.totalItems >= 1);
  // needItems=0 会被抬到 1，且此时「不买杆」几乎总能满足（罐子白送）⇒ 零代价解
  assert.equal(r.best.goldSpend, 0);
});

// ------------------------------------------------------------------ 5. 收尾模拟

test("simulateFinish：开库存道具 + 返还金砖回流（返还金砖可再买鱼竿）", () => {
  const res = simulateFinish({
    specialOwned: 0,
    packsOwned: 746,
    progressBySlot: { 3: 1140, 5: 20389 },
    goldInStock: 1000000,
    rodsInStock: 2000,
    seed: 20260928,
  });
  assert.equal(res.iterations[0].kind, "open");
  assert.equal(res.iterations[0].packs, 746);
  // 逐轮返还记在 iterations 上（res.returns 是全流程累计）
  assert.ok(Math.abs(res.iterations[0].returns.gold - 746 * 107.304) < 1e-6);
  assert.ok(Math.abs(res.iterations[0].returns.platinumBox - 746 * 0.205) < 1e-9);
  // 本期道具上限 = 746（库存）+ 256（金砖做满 + 钓鱼全满）+ 20（罐子自然完成白送）= 1022
  assert.ok(res.packsOpened >= 746, `实际 ${res.packsOpened}`);
  assert.ok(res.packsOpened <= 1022, `不应超过道具上限，实际 ${res.packsOpened}`);
  assert.equal(res.freeItems, 20);
  assert.ok(Number.isInteger(res.special) && res.special >= 0);
});

test("simulateFinish：minimal 策略按「最小金砖代价」补档（不是金砖做满）", () => {
  const res = simulateFinish({
    specialOwned: 240,
    packsOwned: 0,
    progressBySlot: { 1: 4000, 2: 100000, 3: 1140, 4: 60, 5: 20389 },
    goldInStock: 1000000,
    rodsInStock: 0,
    seed: 7,
    strategy: "minimal",
  });
  assert.equal(res.strategy, "minimal");
  const rodStep = res.iterations.find((it) => it.kind === "rod");
  assert.ok(rodStep, "应出现买鱼竿步骤");
  assert.equal(rodStep.gap, 10);
  assert.equal(rodStep.needItems, 40);
  assert.ok(rodStep.items >= rodStep.needItems, `items=${rodStep.items}`);
  assert.ok(rodStep.rods > 0);
  assert.ok(res.rodsBought > 0);
  assert.ok(res.goldSpent > 0);
  // 关键区别：minimal 远小于「金砖做满」的 500400
  assert.ok(rodStep.goldSpend < 500000, `实际 ${rodStep.goldSpend}`);
  assert.equal(
    res.packsOpened,
    res.iterations.reduce((s, it) => s + (it.packs || 0), 0),
  );
});

test("simulateFinish：master 策略 = 金砖先做满", () => {
  const res = simulateFinish({
    specialOwned: 240,
    packsOwned: 0,
    progressBySlot: { 1: 4000, 2: 100000, 3: 1140, 4: 60, 5: 0 },
    goldInStock: 1000000,
    rodsInStock: 0,
    seed: 3,
    strategy: "master",
  });
  assert.equal(res.strategy, "master");
  const rodStep = res.iterations.find((it) => it.kind === "rod");
  assert.ok(rodStep, "应出现买鱼竿步骤");
  assert.ok(rodStep.goldSpend >= 500000, `实际 ${rodStep.goldSpend}`);
  assert.equal(rodStep.goldRound, 20);
});

test("simulateFinish：档位双满 + 手里没货 ⇒ 诚实报不可行，且不空花金砖", () => {
  const res = simulateFinish({
    specialOwned: 100,
    packsOwned: 0,
    progressBySlot: { 3: 1750, 4: 60, 5: 500000 }, // 钓鱼全满 + 罐子全满 + 金砖做满
    goldInStock: 2000000,
    rodsInStock: 0,
    seed: 5,
  });
  assert.equal(res.ok, false);
  assert.ok(res.reason.length > 0, res.reason);
  assert.equal(res.goldSpent, 0);
  assert.equal(res.rodsBought, 0);
  assert.equal(res.freeItems, 0); // 罐子也满了 ⇒ 白送 0 个，确实「无货可开」
  assert.equal(res.iterations.length, 0);
});

test("simulateFinish：罐子未做满 ⇒ 先白开罐子那份（不花金砖，也不买杆）", () => {
  const res = simulateFinish({
    specialOwned: 100,
    packsOwned: 0,
    progressBySlot: { 3: 1750, 5: 500000 }, // 罐子（slot 4）完全没做
    goldInStock: 0,
    rodsInStock: 0,
    seed: 11,
  });
  assert.ok(res.freeItems > 0, `freeItems=${res.freeItems}`);
  assert.equal(res.iterations[0].kind, "free");
  assert.equal(res.iterations[0].packs, res.freeItems);
  assert.equal(res.goldSpent, 0); // 罐子那份不花金砖
  assert.equal(res.rodsBought, 0);
});

test("simulateFinish：同种子结果可复现", () => {
  const opts = {
    specialOwned: 150,
    packsOwned: 200,
    progressBySlot: { 3: 1140, 5: 20389 },
    goldInStock: 1000000,
    seed: 999,
  };
  assert.deepEqual(simulateFinish(opts), simulateFinish(opts));
});

// ------------------------------------------------------------------ 6. 2 轮金砖换 1 轮钓鱼（master 2026-09-28 拍板）
//
// master 原话：「首先找到一个可行的方案，按照 25% 的比例出特殊道具计算。
//   然后如果可行方案中，金砖可做轮数大于等于 2，并且钓鱼轮数不为 0，
//   那么就用 2 轮金砖换一轮钓鱼。」
// 「最后一天先做到宝箱招募做满，金砖 38 万 / 钓鱼 1300 次的状态，
//   然后判断后续差距，找到任意一个可行解，然后判断，如果存在用 2 轮金砖换一轮钓鱼的机会，那就换。」

test("2换1 常量：观察点 38 万（轮 17）/ 收敛参考线 46 万（轮 19）", () => {
  assert.equal(GOLDENFISH_OBSERVE_GOLD, 380000);
  assert.equal(GOLDENFISH_GOLD_TARGET, 460000);
  assert.equal(completedRounds(5, GOLDENFISH_OBSERVE_GOLD), 17);
  assert.equal(completedRounds(5, GOLDENFISH_GOLD_TARGET), 19);
  assert.equal(completedRounds(3, 1300), 17);
});

test("twoForOneCandidate：观察点触发（135 根 = 8.1 万 ≈ 2 轮金砖 8 万）", () => {
  const c = twoForOneCandidate({ 3: 1300, 5: 380000 });
  assert.equal(c.apply, true);
  assert.equal(c.goldLeft, 3); // 金砖 38 万 → 还剩轮 18/19/20
  assert.equal(c.fishLeft, 3); // 钓鱼 1300 → 还剩轮 18/19/20
  // 下一轮钓鱼（轮 18）= 150 次 → 10% 返还 ⇒ ceil(150×0.9) = 135 根
  assert.equal(c.rods, 135);
  assert.equal(c.fishRoundCost, 150);
  assert.equal(c.goldSpend, 81000);
  assert.ok(c.reason.includes("135"));
});

test("twoForOneCandidate：金砖窗口 < 2 轮不换（杆钱会大量溢出）", () => {
  // 金砖 46.1 万 = 轮 19 已过 ⇒ 窗口只剩轮 20（4 万）
  const c = twoForOneCandidate({ 3: 1450, 5: 461000 });
  assert.equal(c.apply, false);
  assert.equal(c.goldLeft, 1);
  assert.ok(c.reason.includes("1 轮"));
  // 边界：恰好 2 轮窗口 → 可以换（最多溢出 1,000）
  const edge = twoForOneCandidate({ 3: 1300, 5: 420000 });
  assert.equal(edge.apply, true);
  assert.equal(edge.goldLeft, 2);
});

test("twoForOneCandidate：钓鱼无档可做不换；返还率可覆盖", () => {
  const full = twoForOneCandidate({ 3: 1750, 5: 380000 });
  assert.equal(full.apply, false);
  assert.equal(full.fishLeft, 0);
  assert.ok(full.reason.includes("钓鱼"));
  // 关闭返还 ⇒ 1 轮钓鱼要 150 根（旧口径）
  const noReturn = twoForOneCandidate({ 3: 1300, 5: 380000 }, { rodReturnRate: 0 });
  assert.equal(noReturn.apply, true);
  assert.equal(noReturn.rods, 150);
  assert.equal(noReturn.goldSpend, 90000);
  // 默认就是 10% 返还口径
  assert.equal(GOLDENFISH_ROD_RETURN_RATE, 0.1);
});

test("planRodPurchase：buildAt 按任意杆数构造方案（2 换 1 的执行器）", () => {
  const res = planRodPurchase({
    progressBySlot: { 1: 4000, 2: 100000, 3: 1300, 4: 60, 5: 380000 },
    needItems: 56,
    goldInStock: 300000,
    rodsInStock: 0,
  });
  assert.ok(res.ok);
  assert.equal(typeof res.buildAt, "function");
  // buildAt(135)：金砖 38 万 + 8.1 万 = 46.1 万 → 跨轮 18+19（+24 道具）
  //               钓鱼 1300 + 150 = 1450 → 跨轮 18（+24 道具）
  const cand = res.buildAt(135);
  assert.equal(cand.rods, 135);
  assert.equal(cand.goldSpend, 81000);
  assert.equal(cand.goldAfter, 461000);
  assert.equal(cand.goldRound, 19);
  assert.equal(cand.fishAfter, 1450);
  assert.equal(cand.fishRound, 18);
  assert.equal(cand.items, 48); // 24 + 24 —— 一笔支出双任务各拿一档
  // 与 plans 内的元素同构（对照：rods=135 的枚举项应完全一致）
  assert.deepEqual(cand, res.plans[135]);
});

test("simulateFinish：twoForOne 策略从观察点起步 —— 交换触发、金砖推过 46 万", () => {
  const res = simulateFinish({
    specialOwned: 0,
    packsOwned: 942, // 观察点五类累计道具 → 先开掉（= 观察动作）
    progressBySlot: { 1: 4000, 2: 100000, 3: 1300, 4: 60, 5: 380000 },
    goldInStock: 300000,
    rodsInStock: 0,
    seed: 20260928,
    strategy: "twoForOne",
  });
  assert.equal(res.strategy, "twoForOne");
  assert.equal(res.ok, true, res.reason);
  const tradeStep = res.iterations.find((it) => it.kind === "rod" && it.traded);
  assert.ok(tradeStep, "应出现 traded=true 的买杆步骤");
  assert.equal(tradeStep.rods, 135);
  assert.equal(tradeStep.goldSpend, 81000);
  assert.equal(tradeStep.goldRound, 19); // 杆钱顺带把金砖推到 46.1 万
  assert.equal(tradeStep.fishRound, 18); // 钓鱼白捡一档
  // 对照：同起点 master 策略要花更多（金砖做满 50 万）
  const master = simulateFinish({
    specialOwned: 0,
    packsOwned: 942,
    progressBySlot: { 1: 4000, 2: 100000, 3: 1300, 4: 60, 5: 380000 },
    goldInStock: 300000,
    rodsInStock: 0,
    seed: 20260928,
    strategy: "master",
  });
  assert.equal(master.ok, true);
  assert.ok(
    res.goldSpent <= master.goldSpent,
    `2换1 支出 ${res.goldSpent} 应 ≤ master 支出 ${master.goldSpent}`,
  );
});

test("simulateFinish：twoForOne 在金砖窗口耗尽后自动退回可行解（能自愈）", () => {
  // 故意让 bias 走低（多试种子取一个需要多轮的），验证 fallback 链不空转、最终成功
  let done = null;
  for (let seed = 1; seed <= 40 && !done; seed += 1) {
    const res = simulateFinish({
      specialOwned: 0,
      packsOwned: 942,
      progressBySlot: { 1: 4000, 2: 100000, 3: 1300, 4: 60, 5: 380000 },
      goldInStock: 400000,
      rodsInStock: 0,
      seed,
      strategy: "twoForOne",
    });
    if (res.rounds >= 2) done = res; // 找一个至少跑了两轮的样本
  }
  assert.ok(done, "40 个种子里应有需要多轮补档的样本");
  assert.equal(done.ok, true, done.reason);
  // 多轮样本里：后续轮的金砖窗口必然 < 2 ⇒ 后续不应再出现交换
  const trades = done.iterations.filter((it) => it.kind === "rod" && it.traded);
  assert.ok(trades.length >= 1);
  for (const it of done.iterations.filter((it) => it.kind === "rod")) {
    if (it !== trades[0]) assert.notEqual(it.traded, true, "交换只应发生在金砖窗口充足的前几轮");
  }
  assert.ok(done.goldSpent > 0);
});

// ------------------------------------------------------------------ 兜底：补一轮金砖

test("兜底：观察点 + twoForOne + maxIterations=1 —— 主循环 1 轮后由补金砖救场（seed 2 确定性）", () => {
  const res = simulateFinish({
    specialOwned: 0,
    packsOwned: 942,
    progressBySlot: { 1: 4000, 2: 100000, 3: 1300, 4: 60, 5: 380000 },
    goldInStock: 300000,
    rodsInStock: 0,
    seed: 2,
    strategy: "twoForOne",
    maxIterations: 1, // 强制主循环只跑一轮 → 剩下缺口交给兜底
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.topups, 1);
  const topup = res.iterations.find((it) => it.kind === "topup");
  assert.ok(topup, "应出现 kind=topup 的兜底步骤");
  assert.equal(topup.rods, 65); // 跨过第 20 轮（50 万）只差 39,000 → 65 根
  assert.equal(topup.goldSpend, 39000);
  assert.equal(topup.goldRound, 20); // 恰好跨过，不多买
  assert.equal(topup.items, 12); // 第 20 轮 = 12 个普通道具
  assert.equal(topup.label.includes("【兜底】"), true);
  // 主循环那轮是 2换1（135 根 81,000），兜底 39,000 → 总支出 120,000
  assert.equal(res.goldSpent, 81000 + 39000);
  assert.ok(res.special >= 250, `兜底后应达标，实际 ${res.special}`);
  // 金砖任务最终恰好推满（或只多出不跨档的零头），不越过 50 万档太多
  assert.ok(topup.goldSpend <= 40000 + 600, "兜底只做 1 轮金砖的量");
});

test("兜底对照：同起点 goldTopUp:false —— 迭代上限退出，失败在 250 之下", () => {
  const res = simulateFinish({
    specialOwned: 0,
    packsOwned: 942,
    progressBySlot: { 1: 4000, 2: 100000, 3: 1300, 4: 60, 5: 380000 },
    goldInStock: 300000,
    rodsInStock: 0,
    seed: 2,
    strategy: "twoForOne",
    maxIterations: 1,
    goldTopUp: false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.topups, 0);
  assert.equal(res.reason.includes("迭代上限"), true);
  assert.ok(res.special < 250);
  assert.ok(
    res.iterations.every((it) => it.kind !== "topup"),
    "关闭兜底后不应出现 topup 步骤",
  );
});

test("兜底：默认迭代下不触发（主循环自己收敛），金砖档榨干时兜底无能为力", () => {
  // ① 回归：默认参数 40 种子全部达标且 0 次兜底 —— 兜底是保命手段，不是常规路径
  let okCount = 0;
  let topupFired = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const res = simulateFinish({
      specialOwned: 0,
      packsOwned: 942,
      progressBySlot: { 1: 4000, 2: 100000, 3: 1300, 4: 60, 5: 380000 },
      goldInStock: 300000,
      rodsInStock: 0,
      seed,
      strategy: "twoForOne",
    });
    if (res.ok) okCount += 1;
    if (res.topups > 0) topupFired += 1;
  }
  assert.equal(okCount, 40, "默认迭代下 40 种子应全部达标");
  assert.equal(topupFired, 0, "默认迭代下不应触发兜底");

  // ② 档位全榨干（金砖 50 万 + 钓鱼满）缺口仍在 → 兜底正确放弃（不是假成功）
  const exhausted = simulateFinish({
    progressBySlot: { 1: 4000, 2: 100000, 3: 1750, 4: 60, 5: 500000 },
    specialOwned: 246,
    goldInStock: Infinity,
    strategy: "twoForOne",
    seed: 7,
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.topups, 0);
  assert.ok(exhausted.reason.length > 0, "失败必须有 reason（金砖与钓鱼档位都已做满）");
});
