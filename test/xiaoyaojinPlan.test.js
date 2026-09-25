import assert from "node:assert/strict";
import { test } from "node:test";

import {
  XIAOYAOJIN_ALL_STEPS,
  XIAOYAOJIN_CUMULATIVE_ID_MAX,
  XIAOYAOJIN_DEFAULT_DRAWS,
  XIAOYAOJIN_EXCHANGE_ITEM_ID,
  XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID,
  XIAOYAOJIN_MAX_ACTIVITY_AGE_DAYS,
  XIAOYAOJIN_MAX_DRAWS,
  XIAOYAOJIN_POINTS_ITEM_ID,
  XIAOYAOJIN_POINTS_PER_TIER,
  buildXiaoyaojinPlan,
  beijingDayStart,
  deriveXiaoyaojinIds,
  describePassTiers,
  getActivityDateHead,
  isDailyMissionId,
  listPendingCumulativeIds,
  listPendingDailyClaims,
  listPendingPassRewards,
  parseActivityDateHead,
  pickLotteryInfo,
  planLotteryBatches,
  readCumulativeClaimed,
  readItemQuantity,
  readRewardQuantity,
  resolveExchangeTimes,
  resolveLotteryDraws,
  resolvePassTierCount,
  resolvePassTierMissionId,
  resolveXiaoyaojinActivityId,
  summarizeLottery,
  summarizePassRewards,
} from "../src/utils/xiaoyaojinPlan.js";

// ---------------------------------------------------------------------------
// 真实抓包快照（local-data/xiaoyaojin/xyzw-runtime-wss-2026-09-18T17-58-18-440Z.jsonl）
// 战令实例 2609191：每日任务 01~06，战令等级奖励 41~73（共 33 级）
// ---------------------------------------------------------------------------
const ACT_ID = "2609191";

/** 战令内部 ID = 战令实例 ID + 2 位序号（2609191 → 260919101 / 260919150） */
const missionId = (index) => `${ACT_ID}${String(index).padStart(2, "0")}`;

const buildWarOrderInfo = ({ completeOverrides = {}, claimed = [] } = {}) => {
  const complete = {};
  for (let i = 1; i <= 6; i++) {
    complete[missionId(i)] = 0;
  }
  for (let i = 41; i <= 73; i++) {
    complete[missionId(i)] = 0;
  }
  Object.assign(complete, completeOverrides);

  const taskClaimed = {};
  for (let i = 1; i <= 6; i++) {
    taskClaimed[missionId(i)] = claimed.includes(i);
  }
  return {
    purchased: false,
    complete,
    taskClaimed,
    rewardClaimed: {},
    dailyTime: 1789747200,
    weekTime: 1789315200,
    itemNum: 0,
    unlockClaimed: false,
  };
};

/** 抓包时刻：2026-09-18T18:00Z = 北京 2026-09-19 02:00 */
const CAPTURE_NOW = Date.parse("2026-09-18T18:00:00.000Z");

const activityResponse = (warOrderActivityInfo, commonActivityInfo = {}) => ({
  activity: { warOrderActivityInfo, commonActivityInfo },
});

test("日期头解析：活动实例 ID 取 6 位日期头，非 7 位一律拒绝", () => {
  assert.equal(getActivityDateHead("2609191"), "260919");
  assert.equal(getActivityDateHead(2609191), "260919");
  assert.equal(getActivityDateHead("1003"), null); // 历史战令实例，非 YYMMDD
  assert.equal(getActivityDateHead("1"), null);
  assert.equal(getActivityDateHead(""), null);
  assert.equal(getActivityDateHead(null), null);
});

test("日期头 → 北京 00:00 时刻；非法日期返回 null", () => {
  assert.equal(
    new Date(parseActivityDateHead("260919")).toISOString(),
    "2026-09-18T16:00:00.000Z", // 北京 09-19 00:00
  );
  assert.equal(parseActivityDateHead("260230"), null); // 2 月 30 日
  assert.equal(parseActivityDateHead("261301"), null); // 13 月
  assert.equal(parseActivityDateHead("2609"), null);

  // beijingDayStart 与 head 解析在同一套 UTC 数学下，跨时区稳定
  assert.equal(beijingDayStart(CAPTURE_NOW), parseActivityDateHead("260919"));
});

test("活动 ID 派生：YYMMDD + 功能位（战令 1 / 抽奖 2 / 礼包 4 / 签到 5）", () => {
  const ids = deriveXiaoyaojinIds("260919");
  assert.equal(ids.warOrderActivityId, "2609191");
  assert.equal(ids.lotteryPackId, "2609192");
  assert.equal(ids.giftActivityId, "2609194");
  assert.equal(ids.giftGoodsId, "26091941"); // 礼包商品 = 活动 ID + "1"
  assert.equal(ids.signActivityId, "2609195");
});

test("活动 ID 派生：overrides 可逐项手工覆盖（兜底用）", () => {
  const ids = deriveXiaoyaojinIds("260919", {
    giftGoodsId: "99000001",
    signActivityId: "99000005",
  });
  assert.equal(ids.warOrderActivityId, "2609191");
  assert.equal(ids.giftGoodsId, "99000001");
  assert.equal(ids.signActivityId, "99000005");
});

test("活动实例探测：从混合战令表里挑出本期的 7 位 YYMMDD 键", () => {
  const detected = resolveXiaoyaojinActivityId(
    { 1: buildWarOrderInfo(), 1003: {}, 2609191: buildWarOrderInfo() },
    { now: CAPTURE_NOW },
  );
  assert.equal(detected.activityId, "2609191");
  assert.equal(detected.head, "260919");
  assert.equal(detected.ageDays, 0);
});

test("活动实例探测：活动期中间（第 5 天）仍能识别——日期头是开启日不是当天", () => {
  const day5 = Date.parse("2026-09-23T04:00:00.000Z"); // 北京 09-23 12:00
  const detected = resolveXiaoyaojinActivityId(
    { 2609191: buildWarOrderInfo() },
    { now: day5 },
  );
  assert.equal(detected.activityId, "2609191");
  assert.equal(detected.ageDays, 4);
});

test("活动实例探测：超过存活窗口或只有非 YYMMDD 键 → 判定未开启", () => {
  const farFuture = Date.parse("2026-12-01T00:00:00.000Z");
  assert.equal(
    resolveXiaoyaojinActivityId({ 2609191: buildWarOrderInfo() }, { now: farFuture }),
    null,
  );
  assert.equal(
    resolveXiaoyaojinActivityId({ 1: {}, 1003: {} }, { now: CAPTURE_NOW }),
    null,
  );

  // 窗口边界：恰好 21 天前仍在窗口内，22 天前排除
  const edge = parseActivityDateHead("260919") + XIAOYAOJIN_MAX_ACTIVITY_AGE_DAYS * 86400000;
  assert.ok(resolveXiaoyaojinActivityId({ 2609191: {} }, { now: edge }));
  assert.equal(
    resolveXiaoyaojinActivityId({ 2609191: {} }, { now: edge + 86400000 }),
    null,
  );
});

test("每日任务序号：01~30 为每日任务，41+ 为战令等级奖励", () => {
  assert.equal(isDailyMissionId("260919101"), true);
  assert.equal(isDailyMissionId("260919130"), true);
  assert.equal(isDailyMissionId("260919141"), false);
  assert.equal(isDailyMissionId("260919173"), false);
  assert.equal(isDailyMissionId("abc"), false);
  assert.equal(isDailyMissionId(null), false);
});

test("待领取每日任务：只取未领取项，并标出是否达成", () => {
  // 抓包第一帧：complete[101]=1（登录），其余 0；全部未领取
  const pending = listPendingDailyClaims(
    buildWarOrderInfo({ completeOverrides: { [missionId(1)]: 1 } }),
  );
  assert.equal(pending.length, 6);
  assert.deepEqual(
    pending.filter((item) => item.completed).map((item) => item.missionId),
    [missionId(1)],
  );

  // 领取 101 之后：只剩 5 个待领，且都未达成 → 不应再发请求
  const after = listPendingDailyClaims(
    buildWarOrderInfo({ completeOverrides: { [missionId(1)]: 1 }, claimed: [1] }),
  );
  assert.equal(after.length, 5);
  assert.equal(after.filter((item) => item.completed).length, 0);
});

test("战令等级奖励：以 taskClaimed 判已领，complete 是进度值不是布尔（真实抓包快照）", () => {
  // 09-19 16:20 抓包（some_new_data.jsonl，账号 momo @9724服）的原始状态
  const info = {
    purchased: false,
    purchased2: false,
    purchased3: false,
    unlockClaimed: false,
    itemNum: 0,
    // 完整的原始 complete：只有部分条目 >0，144~146 / 170~173 为 0
    complete: {
      260919101: 41,
      260919102: 0,
      260919103: 3,
      260919104: 13,
      260919105: 2,
      260919106: 3,
      260919141: 4000,
      260919142: 4000,
      260919143: 4000,
      260919144: 0,
      260919145: 0,
      260919146: 0,
      260919147: 21,
      260919148: 21,
      260919149: 21,
      ...Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`2609191${50 + i}`, 2]),
      ),
      260919170: 0,
      260919171: 0,
      260919172: 0,
      260919173: 0,
    },
    taskClaimed: {
      260919101: true,
      260919102: false,
      260919103: true,
      260919104: true,
      260919105: true,
      260919106: true,
      260919141: true,
      260919147: true,
      260919148: true,
      260919149: true,
    },
    // ⚠️ 另一套奖励（4 位 ID），由 activity_warorderrewardclaim 领取，**不能**用来判等级奖励是否已领
    rewardClaimed: { 1221: 1, 1222: 1, 1223: 1 },
  };

  const pending = listPendingPassRewards(info);
  assert.equal(pending.length, 22); // 142/143 + 150~169
  assert.deepEqual(pending.slice(0, 3), [
    "260919142",
    "260919143",
    "260919150",
  ]);
  // 已领的 141/147/148/149 与 progress=0 的 144~146、170~173 都必须在候选外
  ["260919141", "260919147", "260919148", "260919149", "260919144", "260919170"].forEach(
    (id) => assert.equal(pending.includes(id), false, `不应包含 ${id}`),
  );

  assert.deepEqual(summarizePassRewards(info), {
    total: 33,
    unlocked: 26,
    pending: 22,
    pendingIds: pending,
  });

  // 反面用例：旧实现用 rewardClaimed 判已领，会把已领的 141 当成「可领」（rewardClaimed 里根本没有 9 位键）
  assert.equal(Object.keys(info.rewardClaimed).some((k) => k.length === 9), false);
});

test("战令等级奖励：全部未解锁 / 空对象都不产生候选", () => {
  assert.deepEqual(summarizePassRewards(buildWarOrderInfo()), {
    total: 33,
    unlocked: 0,
    pending: 0,
    pendingIds: [],
  });
  assert.deepEqual(listPendingPassRewards(null), []);
  assert.deepEqual(listPendingPassRewards({}), []);
  // 7 位活动实例 ID 本身不是 9 位 missionId → 不能混进候选
  assert.deepEqual(listPendingPassRewards({ complete: { 2609191: 5 } }), []);
});

test("完整计划：自动探测 + 派生同族 ID + 清单汇总", () => {
  const plan = buildXiaoyaojinPlan(
    activityResponse(
      { 2609191: buildWarOrderInfo({ completeOverrides: { [missionId(1)]: 1 } }) },
      // 真实结构（取自抓包）：外层键 = 活动实例 ID，商品号是礼包 record 里的内层键
      {
        "2609194": { record: { 26091941: 1 }, task: {}, isBought: false },
        "2609195": { record: { 1: 1789754264 }, task: {}, isBought: false },
      },
    ),
    { now: CAPTURE_NOW },
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.source, "auto");
  assert.equal(plan.warOrderActivityId, "2609191");
  assert.equal(plan.ageDays, 0);
  assert.equal(plan.ids.giftActivityId, "2609194");
  assert.equal(plan.ids.giftGoodsId, "26091941");
  assert.equal(plan.ids.signActivityId, "2609195");
  assert.deepEqual(
    {
      gift: plan.commonConfirmed.gift,
      sign: plan.commonConfirmed.sign,
      giftBought: plan.commonConfirmed.giftBought,
      signDays: plan.commonConfirmed.signDays,
    },
    { gift: true, sign: true, giftBought: true, signDays: [1] },
  );
  assert.deepEqual(plan.commonConfirmed.keys.slice().sort(), [
    "2609194",
    "2609195",
  ]);
  assert.equal(plan.dailyClaims.filter((item) => item.completed).length, 1);
});

test("commonActivityInfo 嵌套语义：外层按活动 ID 查（写错成 goodsId 会永远查不到）", () => {
  // 礼包活动已推送但本期未领：外层键仍是 2609194，record 为空
  const notBought = buildXiaoyaojinPlan(
    activityResponse(
      { 2609191: buildWarOrderInfo() },
      { "2609194": { record: {}, task: {}, isBought: false } },
    ),
    { now: CAPTURE_NOW },
  );
  assert.equal(notBought.commonConfirmed.gift, true);
  assert.equal(notBought.commonConfirmed.giftBought, false);

  // 只推送了 goodsId 当作外层键（错误结构）→ 不应被认成「礼包活动已确认」
  const wrongShape = buildXiaoyaojinPlan(
    activityResponse(
      { 2609191: buildWarOrderInfo() },
      { "26091941": { record: { 26091941: 1 } } },
    ),
    { now: CAPTURE_NOW },
  );
  assert.equal(wrongShape.commonConfirmed.gift, false);
  assert.equal(wrongShape.commonConfirmed.giftBought, false);

  // 服务端还没推送任何 commonActivityInfo → 两个确认位为 false，但计划仍成立（照常尝试）
  const noPush = buildXiaoyaojinPlan(
    activityResponse({ 2609191: buildWarOrderInfo() }),
    { now: CAPTURE_NOW },
  );
  assert.equal(noPush.ok, true);
  assert.equal(noPush.commonConfirmed.gift, false);
  assert.equal(noPush.commonConfirmed.sign, false);
  assert.deepEqual(noPush.commonConfirmed.signDays, []);
});

test("完整计划：手工指定活动实例时 source=manual 且优先于自动探测", () => {
  const plan = buildXiaoyaojinPlan(
    activityResponse({ 2609191: buildWarOrderInfo(), 2610011: buildWarOrderInfo() }),
    { now: CAPTURE_NOW, overrides: { warOrderActivityId: "2609191" } },
  );
  assert.equal(plan.source, "manual");
  assert.equal(plan.warOrderActivityId, "2609191");
  assert.equal(plan.ids.signActivityId, "2609195");
});

test("完整计划：活动未开启时给出可读原因，不抛异常", () => {
  const plan = buildXiaoyaojinPlan(activityResponse({ 1: {}, 1003: {} }), {
    now: CAPTURE_NOW,
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /未在 warOrderActivityInfo 中找到逍遥津活动实例/);
});

test("抽奖次数：受配置与抽奖券余额双重约束", () => {
  assert.equal(XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID, 5283);

  // 抓包场景：1 张券，1 次
  assert.deepEqual(resolveLotteryDraws({ requested: 1, ticketCount: 1 }), {
    draws: 1,
    tickets: 1,
    cappedByTickets: false,
  });

  // 券不够 → 收紧并标记
  assert.deepEqual(resolveLotteryDraws({ requested: 5, ticketCount: 2 }), {
    draws: 2,
    tickets: 2,
    cappedByTickets: true,
  });

  // 没券 → 0 次
  assert.equal(resolveLotteryDraws({ requested: 3, ticketCount: 0 }).draws, 0);

  // 读不到余额 → 不拦（服务端无券会直接拒绝，循环遇错即停）
  assert.deepEqual(resolveLotteryDraws({ requested: 3, ticketCount: null }), {
    draws: 3,
    tickets: null,
    cappedByTickets: false,
  });

  // 缺省与上限
  assert.equal(resolveLotteryDraws({}).draws, XIAOYAOJIN_DEFAULT_DRAWS);
  assert.equal(resolveLotteryDraws({ requested: 999, ticketCount: 100 }).draws, XIAOYAOJIN_MAX_DRAWS);
  assert.equal(resolveLotteryDraws({ requested: 0, ticketCount: 100 }).draws, 1);
});

test("一键全套的步骤顺序是协议约束：先等级奖励、后一键宝箱；券类步骤都在抽奖前", () => {
  const steps = [...XIAOYAOJIN_ALL_STEPS];
  const at = (id) => steps.indexOf(id);

  // 09-19 双账号抓包对比实证：宝箱可领集合取决于等级奖励是否已领
  assert.ok(at("passRewards") < at("passChest"), "等级奖励必须在宝箱之前");
  // 宝箱与礼包都产抽奖券 5283
  assert.ok(at("passChest") < at("lottery"), "宝箱必须在抽奖之前");
  assert.ok(at("oneTimeGift") < at("lottery"), "礼包必须在抽奖之前");
  // 兑换消耗的是**抽奖产出**的 5284（每 50 抽 1 个）→ 必须排在抽奖之后、且是最后一步
  assert.ok(at("lottery") < at("exchange"), "兑换必须在抽奖之后");
  assert.equal(steps[steps.length - 1], "exchange");
  // 步骤集合固定为这 7 步
  assert.deepEqual([...steps].sort(), [
    "dailyTask",
    "exchange",
    "lottery",
    "oneTimeGift",
    "passChest",
    "passRewards",
    "signReward",
  ]);
  // 冻结：防止运行时被就地改序
  assert.equal(Object.isFrozen(XIAOYAOJIN_ALL_STEPS), true);
});

test("真实初始快照（some_new_data1 首帧）：本地圈出 26 个等级候选，但实际只有 4 个可领", () => {
  // 08:23:33 首帧 = 进入界面后、任何领取动作之前的原始状态
  const initial = {
    complete: {
      260919101: 38,
      260919102: 0,
      260919103: 3,
      260919104: 13,
      260919105: 1,
      260919106: 3,
      260919141: 4000,
      260919142: 4000,
      260919143: 4000,
      260919144: 0,
      260919145: 0,
      260919146: 0,
      260919147: 21,
      260919148: 21,
      260919149: 21,
      ...Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`2609191${50 + i}`, 1]),
      ),
      260919170: 0,
      260919171: 0,
      260919172: 0,
      260919173: 0,
    },
    taskClaimed: {
      260919101: true,
      260919102: false,
      260919103: true,
      260919104: false,
      260919105: false,
      260919106: true,
    },
    rewardClaimed: {},
  };

  // 每日任务候选 3 个（104/105 有进度，102 是 0），其中能领的 2 个
  const daily = listPendingDailyClaims(initial);
  assert.deepEqual(
    daily.map((item) => item.missionId.slice(-3)),
    ["102", "104", "105"],
  );
  assert.equal(daily.filter((item) => item.completed).length, 2);

  // 等级奖励候选 26 个：141/142/143 + 147/148/149 + 150~169（144~146、170~173 的 complete=0 被排除）
  const pass = listPendingPassRewards(initial);
  assert.equal(pass.length, 26);
  assert.deepEqual(summarizePassRewards(initial), {
    total: 33,
    unlocked: 26,
    pending: 26,
    pendingIds: pass,
  });

  // ⚠️ 这 26 个里 master 实际只领到 4 个（141/147/148/149）——142/143 与 150~169 的 complete 同样 >0 却领不到，
  //    证明「本地无法判定可领性」，只能逐个交服务端裁定（错误码分类就是为了看清这一点）
  const actuallyClaimable = ["260919141", "260919147", "260919148", "260919149"];
  assert.equal(actuallyClaimable.every((id) => pass.includes(id)), true);
  assert.equal(pass.length - actuallyClaimable.length, 22);
});

test("档位积分的估算函数：3100 分 → 3 档（**仅供日志显示，不用于筛选候选**）", () => {
  assert.equal(resolvePassTierCount(3100), 3); // master 截图：3100 分 → 已领 3 档 + 第 4 档 100/1000
  assert.equal(resolvePassTierCount(4000), 4);
  assert.equal(resolvePassTierCount(999), 0);
  assert.equal(resolvePassTierCount(0), 0);
  assert.equal(resolvePassTierCount(null), 0);
  assert.equal(resolvePassTierCount("3100"), 3);
  assert.equal(XIAOYAOJIN_POINTS_PER_TIER, 1000);
  assert.equal(XIAOYAOJIN_POINTS_ITEM_ID, 5282);
});

test("★ 档位进度可读：积分 / 可达档数 / 已领哪些 / 下一档还差多少（与 UI 完全一致）", () => {
  // 真实最终状态：积分 3100、档 1/2/3（= …147/…148/…149）已领
  const finalState = {
    complete: { 260919147: 21, 260919148: 21, 260919149: 21, 260919150: 1 },
    taskClaimed: {
      260919141: true, // 注意：141 不是档位（另一类奖励）
      260919147: true,
      260919148: true,
      260919149: true,
    },
  };
  const actId = "2609191";

  const summary = describePassTiers(finalState, { actId, points: 3100 });
  assert.equal(summary.points, 3100);
  assert.equal(summary.reachable, 3); // floor(3100/1000)
  assert.deepEqual(summary.claimedTiers, [1, 2, 3]);
  assert.deepEqual(summary.pendingTiers, []);
  // 3100 分 → 第 4 档进度 100/1000 → **还差 900 分**（截图 `100/1000` 的算术等价）
  assert.deepEqual(summary.nextTier, {
    tier: 4,
    missionId: "260919150",
    pointsNeeded: 900,
  });

  // 档号 → missionId：档1=147、档4=150（与抓包里客户端实发的 ID 对上）
  assert.equal(resolvePassTierMissionId(actId, 1), "260919147");
  assert.equal(resolvePassTierMissionId(actId, 2), "260919148");
  assert.equal(resolvePassTierMissionId(actId, 3), "260919149");
  assert.equal(resolvePassTierMissionId(actId, 4), "260919150");
  // 抓包里客户端在第 4 档尚未解锁时**没有**发 150，只发了 147/148/149（+非档位的 141）
  assert.equal(summary.pendingTiers.some((item) => item.missionId === "260919150"), false);

  // 有档未领时 → pendingTiers 列出，且 claimedTiers 只含已领的
  const partial = {
    complete: finalState.complete,
    taskClaimed: { 260919147: true },
  };
  const partialSummary = describePassTiers(partial, { actId, points: 3100 });
  assert.deepEqual(partialSummary.claimedTiers, [1]);
  assert.deepEqual(
    partialSummary.pendingTiers.map((item) => item.tier),
    [2, 3],
  );

  // 积分不足 1000 → 0 档可达，下一档还是档 1（还差 100 分）
  const low = describePassTiers(partial, { actId, points: 900 });
  assert.equal(low.reachable, 0);
  assert.deepEqual(low.nextTier, {
    tier: 1,
    missionId: "260919147",
    pointsNeeded: 100,
  });

  // 读不到积分 → points=null、可达 0，不抛异常
  const unknown = describePassTiers(partial, { actId, points: null });
  assert.equal(unknown.points, null);
  assert.equal(unknown.reachable, 0);
  assert.deepEqual(unknown.tiers, []);
  assert.deepEqual(unknown.nextTier, null);

  // 档号上界：超大积分不会无限枚举
  const huge = describePassTiers(partial, { actId, points: 999999 });
  assert.equal(huge.tiers.length, 27);
  assert.equal(huge.tiers[26].missionId, "260919173");
  assert.equal(huge.nextTier, null); // 已到最高档
  assert.deepEqual(describePassTiers(null, { actId, points: 3100 }).claimedTiers, []);
});

test("非法输入不抛异常", () => {
  assert.equal(buildXiaoyaojinPlan(null).ok, false);
  assert.equal(buildXiaoyaojinPlan(undefined).ok, false);
  assert.equal(buildXiaoyaojinPlan({}).ok, false);
  assert.equal(resolveXiaoyaojinActivityId(null), null);
  assert.equal(resolveXiaoyaojinActivityId("x"), null);
  assert.deepEqual(listPendingDailyClaims(null), []);
  assert.deepEqual(summarizePassRewards(undefined), {
    total: 0,
    unlocked: 0,
    pending: 0,
    pendingIds: [],
  });
  assert.equal(deriveXiaoyaojinIds("").warOrderActivityId, "1");
});

test("兼容裸 body 形态：res.activity / res.data.activity / 已取出的根对象", () => {
  const warOrderActivityInfo = { 2609191: buildWarOrderInfo() };
  const shapes = [
    { activity: { warOrderActivityInfo } }, // Promise 解析出的裸 body
    { data: { activity: { warOrderActivityInfo } } },
    { body: { activity: { warOrderActivityInfo } } },
    { warOrderActivityInfo }, // 已取出的根对象
  ];
  shapes.forEach((shape) => {
    const plan = buildXiaoyaojinPlan(shape, { now: CAPTURE_NOW });
    assert.equal(plan.ok, true);
    assert.equal(plan.warOrderActivityId, "2609191");
  });
});

// ---------------------------------------------------------------------------
// 玄武灵契（抽奖券 5283）闭环 —— 2026-09-25 抓包 local-data/xiaoyaojin/xiaoyaojin_full.jsonl
// 账号「特别老实」@9724，本期 2609191（活动第 7 天）
//   activity_lottery {times:10} → 扣 5283 ×10（40→30→20→10→0）
//   activity_claimlotterycumulative {id} → 每档固定 +2 张 5283（id 11~15 全是 ×2）
//   activity_exchange {activityId:2609196, goodsId:260919602, quantity:1} → 消耗 5284 得 1023×10
// ---------------------------------------------------------------------------

test("★ 十连优先：券余额拆成 [10,10,10,...] 批次（40 张 → 4 批十连）", () => {
  assert.deepEqual(planLotteryBatches(40).batches, [10, 10, 10, 10]);
  assert.deepEqual(planLotteryBatches(23).batches, [10, 10, 3]);
  assert.deepEqual(planLotteryBatches(3).batches, [3]);
  assert.deepEqual(planLotteryBatches(1).batches, [1]);
  // 单抽模式（界面把每批调成 1）
  assert.deepEqual(planLotteryBatches(5, { perBatch: 1 }).batches, [
    1, 1, 1, 1, 1,
  ]);
  // 每批张数被夹到 1~10
  assert.deepEqual(planLotteryBatches(30, { perBatch: 99 }).batches, [
    10, 10, 10,
  ]);
  assert.deepEqual(planLotteryBatches(30, { perBatch: 0 }).batches, [10, 10, 10]);
});

test("★ 券余额为 0 → 不抽奖（[]）；余额未知 → 给一批试探（不能误判成 0）", () => {
  assert.deepEqual(planLotteryBatches(0).batches, []);
  assert.equal(planLotteryBatches(0).tickets, 0);
  // ⚠️ Number(null)===0 陷阱：null/undefined/"" 必须是「未知」而不是 0
  assert.deepEqual(planLotteryBatches(null).batches, [10]);
  assert.equal(planLotteryBatches(null).tickets, null);
  assert.equal(planLotteryBatches(undefined).tickets, null);
  assert.equal(planLotteryBatches("").tickets, null);
});

test("★ 读道具数量：显式 null = 归零，键缺失 = 未知（两种都踩过坑）", () => {
  // 券抽光：items["5283"] = null（BON patch 的删除语义）
  assert.equal(
    readItemQuantity({ role: { items: { 5283: null } } }, 5283),
    0,
  );
  // 兑换材料换光：items["5284"] = null
  assert.equal(
    readItemQuantity(
      { body: { role: { items: { 1023: { quantity: 4957 }, 5284: null } } } },
      XIAOYAOJIN_EXCHANGE_ITEM_ID,
    ),
    0,
  );
  // 键缺失 → 未知（不能当 0，否则会被误判成「没券」而跳过抽奖）
  assert.equal(readItemQuantity({ role: { items: {} } }, 5283), null);
  assert.equal(readItemQuantity({ role: {} }, 5283), null);
  assert.equal(readItemQuantity(null, 5283), null);
  // 正常值
  assert.equal(
    readItemQuantity(
      { role: { items: { 5283: { itemId: 5283, quantity: 2, ext: null } } } },
      5283,
    ),
    2,
  );
});

test("累计抽奖奖励：已领 id 从 cumulativeClaimedMap 读，响应只回本次那一个", () => {
  // 抓包首帧 15:03:49：累计 59 次、前 10 档已领
  const info = {
    lotteryNum: 59,
    fragProgress: 9,
    boxPackIdList: [],
    cumulativeClaimedMap: {
      1: true, 2: true, 3: true, 4: true, 5: true,
      6: true, 7: true, 8: true, 9: true, 10: true,
    },
  };
  const claimed = readCumulativeClaimed(info);
  assert.equal(claimed.size, 10);
  assert.equal(claimed.has(10), true);
  assert.equal(claimed.has(11), false);

  // ⚠️ 响应只回本次领的那一个（{"11":true}）→ 不能拿新响应覆盖，必须并集
  const justClaimed = readCumulativeClaimed({ cumulativeClaimedMap: { 11: true } });
  assert.equal(justClaimed.size, 1);
  const merged = new Set(claimed);
  justClaimed.forEach((id) => merged.add(id));
  assert.equal(merged.size, 11);

  // 待试 id：跳过已领的（1~11），从第一个未领的 12 开始
  const pending = listPendingCumulativeIds(null, merged);
  assert.equal(pending[0], 12);
  assert.equal(pending.length, XIAOYAOJIN_CUMULATIVE_ID_MAX - 11);
  // 上界可配（测试用小上界，别把 30 写死在断言里）
  assert.deepEqual(listPendingCumulativeIds(null, merged, { max: 14 }), [
    12, 13, 14,
  ]);
  // 没有 map 时从 1 开始
  assert.equal(listPendingCumulativeIds(null, new Set())[0], 1);
  assert.equal(listPendingCumulativeIds(null, undefined)[0], 1);
});

test("★ 抽奖摘要：累计次数 / 碎片 / 已领档位（抓包首帧与末帧对照）", () => {
  const first = {
    lotteryNum: 59,
    fragProgress: 9,
    cumulativeClaimedMap: { 1: true, 2: true, 3: true },
  };
  const s1 = summarizeLottery(first, null);
  assert.equal(s1.draws, 59);
  assert.equal(s1.frag, 9);
  assert.deepEqual(s1.claimedCumulative, [1, 2, 3]);
  assert.equal(s1.pendingCumulative, XIAOYAOJIN_CUMULATIVE_ID_MAX - 3);

  // 会话内累积：领到 15 档后
  const accumulated = new Set([1, 2, 3, 11, 12, 13, 14, 15]);
  const s2 = summarizeLottery(first, accumulated);
  assert.deepEqual(s2.claimedCumulative, [1, 2, 3, 11, 12, 13, 14, 15]);
  assert.equal(s2.pendingCumulative, XIAOYAOJIN_CUMULATIVE_ID_MAX - 8);

  // 空/非法输入不抛
  assert.equal(summarizeLottery(null, null).draws, null);
  assert.equal(summarizeLottery(null, null).frag, null);
  assert.deepEqual(summarizeLottery(null, null).claimedCumulative, []);
  // pickLotteryInfo 兼容 body 层
  assert.equal(pickLotteryInfo({ body: { lotteryInfo: first } }).lotteryNum, 59);
  assert.equal(pickLotteryInfo({ lotteryInfo: first }).lotteryNum, 59);
  assert.equal(pickLotteryInfo(null), null);
});

test("★ 奖励解析：累计奖励每档给 2 张玄武灵契（id 11~15 实测）", () => {
  const resp = {
    role: { items: { 5283: { quantity: 2 }, 5285: { quantity: 28 } } },
    reward: [
      { type: 3, itemId: 5283, value: 2, ext: 0 },
      { type: 3, itemId: 5285, value: 5, ext: 0 },
    ],
    lotteryInfo: { cumulativeClaimedMap: { 11: true } },
  };
  assert.equal(readRewardQuantity(resp, XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID), 2);
  assert.equal(readRewardQuantity(resp, 5285), 5);
  // 没有该道具 → 0（不是 null）
  assert.equal(readRewardQuantity(resp, 9999), 0);
  assert.equal(readRewardQuantity(null, 5283), 0);
  assert.equal(readRewardQuantity({}, 5283), 0);
  // 多个条目累加（十连里 5285 出现多次）
  assert.equal(
    readRewardQuantity(
      { reward: [{ itemId: 5285, value: 1 }, { itemId: 5285, value: 4 }] },
      5285,
    ),
    5,
  );
});

test("兑换次数：有多少 5284 换多少次；读不到余额 → null（由调用方试探 1 次）", () => {
  assert.equal(resolveExchangeTimes(3), 3);
  assert.equal(resolveExchangeTimes(0), 0);
  assert.equal(resolveExchangeTimes(null), null);
  assert.equal(resolveExchangeTimes(undefined), null);
  assert.equal(resolveExchangeTimes(""), null);
  assert.equal(resolveExchangeTimes("5"), 5);
  // 上限保护（防死循环）
  assert.equal(resolveExchangeTimes(99999), 50);
});

test("派生 ID 含兑换商店（功能位 6）：2609196 / 商品 260919602", () => {
  const ids = deriveXiaoyaojinIds("260919");
  assert.equal(ids.exchangeActivityId, "2609196");
  assert.equal(ids.exchangeGoodsId, "260919602");
  // 与抓包里 activity_exchange 的请求体逐字段一致
  assert.deepEqual(
    {
      activityId: Number(ids.exchangeActivityId),
      goodsId: Number(ids.exchangeGoodsId),
      quantity: 1,
    },
    { activityId: 2609196, goodsId: 260919602, quantity: 1 },
  );
  // 手工覆盖
  const manual = deriveXiaoyaojinIds("260919", {
    exchangeGoodsId: "260919603",
  });
  assert.equal(manual.exchangeGoodsId, "260919603");
});

test("交换记录：commonActivityInfo 里能读到本期已兑换次数", () => {
  const plan = buildXiaoyaojinPlan(
    {
      activity: {
        warOrderActivityInfo: { 2609191: buildWarOrderInfo() },
        commonActivityInfo: {
          2609196: { record: { 260919602: 2 }, task: {}, isBought: false },
        },
      },
    },
    { now: CAPTURE_NOW },
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.commonConfirmed.exchange, true);
  assert.equal(plan.commonConfirmed.exchangeTimes, 2);
});
