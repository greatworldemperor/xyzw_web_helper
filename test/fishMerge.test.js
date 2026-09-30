/**
 * 养鱼/神器（鱼）自动合并测试 —— 规划器口径以两份真实抓包为准
 *
 * 依据 docs/fish-merge-and-artifactbook-protocol.md：
 *   - momo222 抓包（merge_fish_claim_rewards.jsonl，120 次 artifact_upgradestar）：
 *     1302 起始 1级×10 → 8 步合并 → 5级×2，1级清零
 *   - 海王抓包（fish_auto_merge.jsonl，服务端切阵容自动合并）：
 *     1301: L1×5+L3×1+L5×1 → L5×2+L3×1 / 1402: L1×5+L3×1+L5×5 → L5×6+L1×1
 *     1601: L1×21+L2×1 → L3×1（16011 恰 -20）
 * 断言口径：规划步骤逐条断言 + 终态数量断言 + 15001/15002 货币排除。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FISH_TIER_COST,
  FISH_MAX_LEVEL,
  isFishItemId,
  fishTierCost,
  fishTotalCost,
  readFishStock,
  nextFishMergeStep,
  applyStepToStock,
  applyItemDelta,
  planFishMerges,
  runFishAutoMerge,
} from "../src/utils/batch/fishMerge.js";

const stockFrom = (items, books = {}) =>
  readFishStock({ items, artifactBooks: books });

const runPlanner = (items, books = {}) => {
  const { steps, stockAfter } = planFishMerges({ items, artifactBooks: books });
  return { steps, final: stockAfter };
};

test("k 表与总消耗公式（抓包实证）", () => {
  assert.deepEqual(FISH_TIER_COST, { 13: 1, 14: 2, 15: 5, 16: 20 });
  assert.equal(FISH_MAX_LEVEL, 5);
  assert.equal(fishTotalCost(13, 3), 3); // 红：1+2×1
  assert.equal(fishTotalCost(14, 3), 5); // 橙：1+2×2（master 口径）
  assert.equal(fishTotalCost(15, 3), 11); // 蓝：1+2×5（master 口径）
  assert.equal(fishTotalCost(16, 2), 21); // 新发现档：1+20
  assert.equal(fishTotalCost(13, 5), 5);
  assert.equal(fishTierCost("13011"), 1);
  assert.equal(fishTierCost("15063"), 5);
  assert.equal(fishTierCost("16011"), 20);
});

test("鱼 itemId 识别：货币与 11xx 档排除", () => {
  for (const id of [13011, 13055, 14121, 15063, 16011, 16013]) {
    assert.equal(isFishItemId(id), true, `${id} 应识别为鱼`);
  }
  for (const id of [15001, 15002, 1003, 5287, 11185, 13000]) {
    assert.equal(isFishItemId(id), false, `${id} 不应识别为鱼`);
  }
  // 品种段 01~99 都算鱼（新品靠 artifactBooks ∪ 背包识别兜底；13991 若真实存在也按鱼处理）
});

test("readFishStock：品种来自 artifactBooks ∪ 背包识别，全 0 剔除", () => {
  const stock = stockFrom(
    { 13021: { quantity: 10 }, 15001: { quantity: 68900 } },
    { 1302: { artifactId: 13021, claimedStar: 1 }, 1118: { artifactId: 11185 } },
  );
  assert.ok(stock.has("1302"));
  assert.deepEqual(stock.get("1302"), [10, 0, 0, 0, 0]);
  // 货币 15001（品种段 00）不入池；1118 档不在 13~16 范围
  assert.ok(!stock.has("1500"));
  assert.ok(!stock.has("1118"));
});

test("momo222 实证：1302 起始 1级×10 → 8 步 → 5级×2", () => {
  const { steps, final } = runPlanner({ 13021: { quantity: 10 } });
  assert.equal(steps.length, 8);
  assert.deepEqual(
    steps.map((s) => s.itemId),
    [13021, 13022, 13023, 13024, 13021, 13022, 13023, 13024],
  );
  assert.deepEqual(final.get("1302"), [0, 0, 0, 0, 2]);
});

test("海王实证①：1301 L1×5+L3×1+L5×1 → L5×2+L3×1（高位种子优先）", () => {
  const { steps, final } = runPlanner({
    13011: { quantity: 5 },
    13013: { itemId: 13013, quantity: 1 },
    13015: { quantity: 1 },
  });
  assert.deepEqual(
    steps.map((s) => s.itemId),
    [13013, 13014, 13011, 13012],
  );
  assert.deepEqual(final.get("1301"), [0, 0, 1, 0, 2]);
});

test("海王实证②：1402（k=2）L1×5+L3×1+L5×5 → L5×6+L1×1", () => {
  const { steps, final } = runPlanner({
    14021: { quantity: 5 },
    14023: { itemId: 14023, quantity: 1 },
    14025: { quantity: 5 },
  });
  assert.deepEqual(
    steps.map((s) => s.itemId),
    [14023, 14024],
  );
  assert.deepEqual(final.get("1402"), [1, 0, 0, 0, 6]);
});

test("海王实证③：1601（k=20）L1×21+L2×1 → L3×1 且剩 1 条 1 级", () => {
  const { steps, final } = runPlanner({
    16011: { quantity: 21 },
    16012: { itemId: 16012, quantity: 1 },
  });
  assert.deepEqual(steps.map((s) => s.itemId), [16012]);
  assert.deepEqual(final.get("1601"), [1, 0, 1, 0, 0]);
});

test("材料不足时规划器自然终止（余 1 条 1 级不再合并）", () => {
  const { steps } = runPlanner({ 13021: { quantity: 1 } });
  assert.equal(steps.length, 0);
  const { steps: steps2 } = runPlanner({ 14021: { quantity: 2 } });
  assert.equal(steps2.length, 0); // k=2：1→2 需要 3 条
});

test("applyItemDelta：服务端增量覆盖本地推算（含 null 归零）", () => {
  const stock = stockFrom({ 13021: { quantity: 10 } });
  const step = nextFishMergeStep(stock);
  applyStepToStock(stock, step);
  assert.deepEqual(stock.get("1302"), [8, 1, 0, 0, 0]);
  applyItemDelta(stock, {
    13021: { quantity: 7 },
    13022: { itemId: 13022, quantity: 1, ext: null },
    13011: null,
  });
  assert.deepEqual(stock.get("1302"), [7, 1, 0, 0, 0]);
});

test("执行器端到端：合并序列 + 图鉴点亮 + 领奖（mock send）", async () => {
  const responses = [];
  const planResponse = () => ({ role: { items: {} } });
  for (let i = 0; i < 8; i += 1) responses.push(planResponse);
  // book_batchupgrade：第 1 轮有推进、第 2 轮无增量
  responses.push(() => ({ role: { artifactBooks: { 1302: { claimedStar: 2 } } } }));
  responses.push(() => ({ role: { artifactBooks: {} } }));
  // book_claimpointreward：3 档可领，之后拒绝
  responses.push(() => ({ role: { reward: [{ type: 2, itemId: 0, value: 8200 }] } }));
  responses.push(() => ({ role: { reward: [{ type: 3, itemId: 1003, value: 65000 }] } }));
  responses.push(() => ({ role: { reward: [{ type: 2, itemId: 0, value: 8400 }] } }));

  const calls = [];
  const send = async (tokenId, cmd, params) => {
    calls.push({ cmd, params });
    const fn = responses.shift();
    if (!fn) throw new Error("no more rewards");
    return fn();
  };
  const logs = [];
  const stats = await runFishAutoMerge({
    tokenId: "t1",
    tokenName: "测试号",
    role: { items: { 13021: { quantity: 10 } }, artifactBooks: { 1302: {} } },
    send,
    log: (msg, type) => logs.push({ msg, type }),
  });

  assert.equal(stats.merges, 8);
  assert.equal(stats.bookBatches, 1);
  assert.equal(stats.rewards, 3);

  const mergeCalls = calls.filter((c) => c.cmd === "artifact_upgradestar");
  assert.deepEqual(
    mergeCalls.map((c) => c.params.itemId),
    [13021, 13022, 13023, 13024, 13021, 13022, 13023, 13024],
  );
  for (const c of mergeCalls) {
    assert.equal(c.params.heroId, -1);
    assert.equal(typeof c.params.itemId, "number");
  }
  const batchCalls = calls.filter((c) => c.cmd === "book_batchupgrade");
  assert.equal(batchCalls.length, 2);
  assert.deepEqual(batchCalls[0].params, { club: 0, isArtifact: true, isSkin: false });
  // 第 4 次领奖请求被 mock 拒绝后终止（3 档成功 + 1 次探测失败）
  assert.equal(calls.filter((c) => c.cmd === "book_claimpointreward").length, 4);

  // 无 error 级日志（挡运行时崩溃）
  assert.ok(!logs.some((l) => l.type === "error"), logs.join("\n"));
  // 计划预览日志存在
  assert.ok(logs.some((l) => l.msg.includes("合并计划")));
});

test("执行器：无可合并的鱼时只发图鉴相关请求（不发 upgradestar）", async () => {
  const calls = [];
  const send = async (tokenId, cmd) => {
    calls.push({ cmd });
    if (cmd === "book_batchupgrade") throw new Error("nothing");
    if (cmd === "book_claimpointreward") throw new Error("nothing");
    return { role: {} };
  };
  const stats = await runFishAutoMerge({
    tokenId: "t2",
    role: { items: { 1003: { quantity: 5 } }, artifactBooks: {} },
    send,
  });
  assert.equal(stats.merges, 0);
  assert.ok(!calls.some((c) => c.cmd === "artifact_upgradestar"));
});
