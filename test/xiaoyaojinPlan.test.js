import assert from "node:assert/strict";
import { test } from "node:test";

import {
  XIAOYAOJIN_DEFAULT_DRAWS,
  XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID,
  XIAOYAOJIN_MAX_ACTIVITY_AGE_DAYS,
  XIAOYAOJIN_MAX_DRAWS,
  buildXiaoyaojinPlan,
  beijingDayStart,
  deriveXiaoyaojinIds,
  getActivityDateHead,
  isDailyMissionId,
  listPendingDailyClaims,
  parseActivityDateHead,
  resolveLotteryDraws,
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

test("战令等级奖励统计：已解锁未领取的数量（本工具不处理，仅提示）", () => {
  assert.deepEqual(summarizePassRewards(buildWarOrderInfo()), {
    total: 33,
    pending: 0,
  });

  // 抽奖后的快照：complete[150..169] = 1（序号 50~69 已解锁），rewardClaimed 仍为空 → 20 个可领
  const unlocked = {};
  for (let i = 50; i <= 69; i++) unlocked[missionId(i)] = 1;
  assert.deepEqual(
    summarizePassRewards(buildWarOrderInfo({ completeOverrides: unlocked })),
    { total: 33, pending: 20 },
  );

  // 已领取（服务端用 2 位序号作键）也要算进去
  const info = buildWarOrderInfo({ completeOverrides: unlocked });
  info.rewardClaimed = { "50": 1 };
  assert.equal(summarizePassRewards(info).pending, 19);
});

test("完整计划：自动探测 + 派生同族 ID + 清单汇总", () => {
  const plan = buildXiaoyaojinPlan(
    activityResponse(
      { 2609191: buildWarOrderInfo({ completeOverrides: { [missionId(1)]: 1 } }) },
      { "26091941": { record: { 26091941: 1 } }, "2609195": { record: { 1: 1789754264 } } },
    ),
    { now: CAPTURE_NOW },
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.source, "auto");
  assert.equal(plan.warOrderActivityId, "2609191");
  assert.equal(plan.ageDays, 0);
  assert.equal(plan.ids.giftGoodsId, "26091941");
  assert.equal(plan.ids.signActivityId, "2609195");
  assert.deepEqual(
    { gift: plan.commonConfirmed.gift, sign: plan.commonConfirmed.sign },
    { gift: true, sign: true },
  );
  assert.deepEqual(plan.commonConfirmed.keys.slice().sort(), [
    "26091941",
    "2609195",
  ]);
  assert.equal(plan.dailyClaims.filter((item) => item.completed).length, 1);
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

test("非法输入不抛异常", () => {
  assert.equal(buildXiaoyaojinPlan(null).ok, false);
  assert.equal(buildXiaoyaojinPlan(undefined).ok, false);
  assert.equal(buildXiaoyaojinPlan({}).ok, false);
  assert.equal(resolveXiaoyaojinActivityId(null), null);
  assert.equal(resolveXiaoyaojinActivityId("x"), null);
  assert.deepEqual(listPendingDailyClaims(null), []);
  assert.deepEqual(summarizePassRewards(undefined), { total: 0, pending: 0 });
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
