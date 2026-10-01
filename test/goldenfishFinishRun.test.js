import test from "node:test";
import assert from "node:assert/strict";
import {
  GOLDENFISH_FINISH_TARGETS,
  remainingRoundRows,
  remainingRoundCount,
  remainingRewardPerRound,
  remainingCostPerRound,
  solveTopUpRounds,
  goldToRods,
  buildTopUpExecution,
  planFinishTopUp,
  classifyFinishOutcome,
  summarizeFinishResults,
  describeFinishReason,
} from "../src/utils/goldenfishFinishRun.js";

test("第5步口径：金砖 42 万时只剩 2 档（轮 19/20，每档 4 万金砖、产 12 个）", () => {
  const rows = remainingRoundRows(5, 420000);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.round),
    [19, 20],
  );
  assert.equal(remainingCostPerRound(5, 420000), 40000);
  assert.equal(remainingRewardPerRound(5, 420000), 12);
});

test("第6步口径：钓鱼 1300 次时只剩 3 档（轮 18/19/20，每档 150 次、产 24 个）", () => {
  const rows = remainingRoundRows(3, 1300);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.round),
    [18, 19, 20],
  );
  assert.equal(remainingCostPerRound(3, 1300), 150);
  assert.equal(remainingRewardPerRound(3, 1300), 24);
});

test("第11步：并列最优时 y 尽可能大（(2,0) 与 (1,2) 都零浪费 → 取 (1,2)）", () => {
  const r = solveTopUpRounds(48, { maxX: 3, maxY: 2, itemsPerFishRound: 24, itemsPerGoldRound: 12 });
  assert.equal(r.feasible, true);
  assert.equal(r.waste, 0);
  assert.equal(r.y, 2);
  assert.equal(r.x, 1);
});

test("第11步：m=0 → 0 轮 0 轮，零浪费", () => {
  const r = solveTopUpRounds(0, { maxX: 3, maxY: 2 });
  assert.equal(r.feasible, true);
  assert.deepEqual([r.x, r.y, r.waste], [0, 0, 0]);
});

test("第11步：无法覆盖 → infeasible，并给出可达上限", () => {
  const r = solveTopUpRounds(24 * 3 + 12 * 2 + 1, { maxX: 3, maxY: 2 });
  assert.equal(r.feasible, false);
  assert.equal(r.maxItems, 24 * 3 + 12 * 2);
});

test("第11步：浪费优先于 y（宁可 y 小也不多浪费）", () => {
  // m=25：选项 (2,0)=48 waste23 / (1,1)=36 waste11 / (0,1)=12 不足 / (1,0)=24 不足
  const r = solveTopUpRounds(25, { maxX: 3, maxY: 2, itemsPerFishRound: 24, itemsPerGoldRound: 12 });
  assert.equal(r.feasible, true);
  assert.equal(r.waste, 11);
  assert.equal(r.items, 36);
});

test("鱼竿折算：钓 1300 次 → 1170 根（×0.9，不是 ÷0.9）", () => {
  const ex = buildTopUpExecution({ x: 0, y: 0, fishProgress: 1300, goldProgress: 420000 });
  assert.equal(ex.fishPerRound, 150);
  assert.equal(ex.goldPerRound, 40000);
  // 3 轮钓鱼 = 450 次 → ceil(450 × 0.9) = 405 根
  const ex3 = buildTopUpExecution({ x: 3, y: 0, fishProgress: 1300, goldProgress: 420000 });
  assert.equal(ex3.fishTimes, 450);
  assert.equal(ex3.rodsForFish, 405);
});

test("金砖档：4 万金砖 = ceil(40000/600) = 67 根原价竿", () => {
  assert.equal(goldToRods(40000), 67);
  const ex = buildTopUpExecution({ x: 0, y: 2, fishProgress: 1300, goldProgress: 420000 });
  assert.equal(ex.goldSpend, 80000);
  assert.equal(ex.rodsForGold, 134);
});

test("规划：n=250 已达标 → done，不再买竿钓鱼", () => {
  const p = planFinishTopUp({ specialCount: 250, progressBySlot: { 3: 1300, 5: 420000 } });
  assert.equal(p.done, true);
  assert.equal(p.reason, "already-reached");
  assert.equal(p.packsNeeded, 0);
});

test("规划：n=240 → r=10 → m=40，可行域 3/2，产出 ≥40 的最省解", () => {
  const p = planFinishTopUp({
    specialCount: 240,
    progressBySlot: { 3: 1300, 5: 420000 },
    rodStock: 0,
  });
  assert.equal(p.remain, 10);
  assert.equal(p.packsNeeded, 40);
  assert.equal(p.feasible, true);
  assert.equal(p.maxX, 3);
  assert.equal(p.maxY, 2);
  assert.equal(p.itemsPerFishRound, 24);
  assert.equal(p.itemsPerGoldRound, 12);
  // 40 的最省解：24×1+12×2 = 48（waste 8，y=2）；24×0+12×2 = 24 不够；
  // 24×2+12×0 = 48（waste 8，y=0）→ 并列取 y 大 → (1,2)
  assert.deepEqual(p.best, { x: 1, y: 2, items: 48, waste: 8 });
});

test("规划：目标过大 → tiers-exhausted（不硬凑，交调用方标记失败）", () => {
  const p = planFinishTopUp({ specialCount: 150, progressBySlot: { 3: 1300, 5: 420000 } });
  assert.equal(p.feasible, false);
  assert.equal(p.reason, "tiers-exhausted");
  assert.equal(p.maxItems, 96); // 3×24 + 2×12
});

test("目标常量与档位表自洽", () => {
  assert.equal(GOLDENFISH_FINISH_TARGETS.rodPrice, 600);
  assert.equal(GOLDENFISH_FINISH_TARGETS.specialTarget, 250);
  assert.equal(GOLDENFISH_FINISH_TARGETS.packsPerSpecial, 4);
  // 第1/2 步目标正好是这两槽的满值
  assert.equal(remainingRoundCount(1, 0), 20);
  assert.equal(remainingRoundCount(2, 0), 20);
  assert.equal(remainingRoundCount(1, GOLDENFISH_FINISH_TARGETS.recruit), 0);
  assert.equal(remainingRoundCount(2, GOLDENFISH_FINISH_TARGETS.boxScore), 0);
});

test("第15步判定：250 成功、249 失败且差 1", () => {
  const ok = classifyFinishOutcome(250);
  assert.equal(ok.success, true);
  assert.equal(ok.outcome, "success");
  assert.equal(ok.shortfall, 0);

  const bad = classifyFinishOutcome(249);
  assert.equal(bad.success, false);
  assert.equal(bad.outcome, "failed");
  assert.equal(bad.shortfall, 1);
});

test("第16步：失败清单只收失败账号，且文本可直接下载", () => {
  const summary = summarizeFinishResults([
    { name: "21a", serverId: 9748, roleId: 383887742, specialCount: 250, outcome: "success" },
    { name: "28a", serverId: 9755, roleId: 383953507, specialCount: 231, outcome: "failed", reason: "gold-shortfall" },
    { name: "39b", serverId: 9760, roleId: 383960000, specialCount: 190, outcome: "failed", reason: "tiers-exhausted" },
    { name: "40a", serverId: 9767, roleId: 383969046, specialCount: 250, outcome: "skipped" },
  ]);

  assert.equal(summary.total, 4);
  assert.equal(summary.successCount, 1);
  assert.equal(summary.failedCount, 2);
  assert.equal(summary.skippedCount, 1);
  assert.deepEqual(
    summary.failures.map((f) => f.name),
    ["28a", "39b"],
  );
  assert.equal(summary.failures[0].shortfall, 19);
  assert.equal(summary.failures[0].reasonText, "金砖不够");
  assert.match(summary.text, /28a/);
  assert.match(summary.text, /服9755/);
  assert.match(summary.text, /5288=231（差19）/);
  assert.match(summary.text, /金砖不够/);
  // 成功/跳过的账号不进失败清单正文
  assert.doesNotMatch(summary.text, /21a/);
});

test("第16步：全成功时也要给出可下载文本（写明无失败账号）", () => {
  const summary = summarizeFinishResults([
    { name: "a", specialCount: 251, outcome: "success" },
  ]);
  assert.equal(summary.failedCount, 0);
  assert.match(summary.text, /（无失败账号）/);
});

test("未知原因码原样透出，便于暴露新码", () => {
  assert.equal(describeFinishReason("brand-new-code"), "brand-new-code");
  assert.equal(describeFinishReason("gold-shortfall"), "金砖不够");
});
