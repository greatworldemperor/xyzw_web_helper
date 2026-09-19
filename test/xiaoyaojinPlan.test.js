import assert from "node:assert/strict";
import { test } from "node:test";

import {
  XIAOYAOJIN_ALL_STEPS,
  XIAOYAOJIN_DEFAULT_DRAWS,
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
  listPendingDailyClaims,
  listPendingPassRewards,
  parseActivityDateHead,
  resolveLotteryDraws,
  resolvePassTierCount,
  resolvePassTierMissionId,
  resolveXiaoyaojinActivityId,
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
  // 抽奖排最后（用券的都在它前面）
  assert.equal(steps[steps.length - 1], "lottery");
  // 步骤集合固定为这 6 步
  assert.deepEqual([...steps].sort(), [
    "dailyTask",
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
