/**
 * 逍遥津「券兑换」端到端测试 —— **用抓包真实数据驱动，断言发出的命令与抓包一致**
 *
 * 抓包：`local-data/xiaoyaojin/xiaoyaojin_redemption.jsonl`（21a @9721，2026-09-25 16:02Z）
 *
 *   SEND activity_exchange {activityId:2609193, goodsId:260919302, quantity:8}
 *     → 5285 43→3，reward 15001×40000（饼干）
 *   SEND activity_exchange {activityId:2609193, goodsId:260919303, quantity:1}
 *     → 5285 3→null，reward 1017×1（复活丹）
 *
 * 为什么要这个测试：券兑换跑在 `createTasksXiaoyaojin` 里，纯逻辑单测覆盖不到
 * 「import 漏了」这类低级错误（实测踩过：`XIAOYAOJIN_REVIVE_PRICE is not defined`
 * 直接让整个任务崩掉，而纯逻辑测试全绿）。这里用 mock 的 tokenStore 真跑一遍，
 * 命令序列必须逐字段对上。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTasksXiaoyaojin } from "../src/utils/batch/tasksXiaoyaojin.js";

/** 抓包里的两条真实请求体（顺序敏感） */
const CAPTURED_EXCHANGES = [
  { activityId: 2609193, goodsId: 260919302, quantity: 8 },
  { activityId: 2609193, goodsId: 260919303, quantity: 1 },
];

/** 活动结束后（战令表被清空，只剩 commonActivityInfo）的 activity_get 快照 */
const ACTIVITY_GET_ENDED = {
  activity: {
    warOrderActivityInfo: {},
    commonActivityInfo: {
      2609193: { record: {}, task: {}, isBought: false },
      2609194: { record: {}, task: {}, isBought: false },
      2609195: { record: {}, task: {}, isBought: false },
      2609196: { record: {}, task: {}, isBought: false },
    },
  },
};

/**
 * 搭一个最小的批量任务运行环境
 *
 * @param {object} options
 * @param {object} options.activityGet activity_get 的返回
 * @param {object} options.roleItems   role.items 快照（券 5285 / 材料 5284）
 * @param {object} [options.overrides] 界面选项（如 { head: "260919" }）
 * @param {(params:object)=>object|Error} [options.onExchange] 兑换回调（抛错模拟服务端拒绝）
 */
function createHarness({
  activityGet,
  roleItems,
  overrides = {},
  onExchange = () => ({}),
} = {}) {
  const sent = [];
  const logs = [];

  const tokenStore = {
    sendMessageWithPromise: async (tokenId, cmd, params) => {
      sent.push({ cmd, params });
      if (cmd === "activity_get") return activityGet;
      if (cmd === "role_getroleinfo") return { role: { items: roleItems } };
      if (cmd === "activity_exchange") {
        const result = onExchange(params);
        if (result instanceof Error) throw result;
        return result;
      }
      return {};
    },
    closeWebSocketConnection: () => {},
    sendGetRoleInfo: async () => ({ role: { items: roleItems } }),
  };

  const ref = (value) => ({ value });
  const xiaoyaojinOptions = { draws: 10, overrides: { ...overrides } };
  const deps = {
    selectedTokens: ref(["t1"]),
    tokens: ref([{ id: "t1", name: "测试号" }]),
    tokenStatus: ref({}),
    isRunning: ref(false),
    shouldStop: ref(false),
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 0 },
    batchSettings: { maxActive: 2 },
    tokenStore,
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {}, error: () => {} },
    currentRunningTokenId: ref(null),
    delayConfig: { action: 0, command: 0 },
    xiaoyaojinOptions,
  };

  const tasks = createTasksXiaoyaojin(deps);
  return {
    sent,
    logs,
    tasks,
    options: xiaoyaojinOptions,
    exchanges: () =>
      sent
        .filter((item) => item.cmd === "activity_exchange")
        .map((item) => item.params),
    text: () => logs.map((item) => item.message).join("\n"),
  };
}

/** 按抓包如实模拟：饼干扣 40 券，复活丹扣 3 券 */
const capturedExchange = (params) => {
  if (params.goodsId === 260919302) {
    return {
      role: { items: { 5285: { quantity: 3 }, 15001: { quantity: 66900 } } },
      reward: [{ type: 3, itemId: 15001, value: 40000, ext: 0 }],
    };
  }
  return {
    role: { items: { 1017: { quantity: 1 }, 5285: null } },
    reward: [{ type: 3, itemId: 1017, value: 1, ext: 0 }],
  };
};

test("★ 复刻抓包：43 券 → 饼干 quantity:8 → 复活丹 quantity:1，命令逐字段一致", async () => {
  const harness = createHarness({
    activityGet: ACTIVITY_GET_ENDED,
    roleItems: { 5285: { quantity: 43 }, 5284: { quantity: 0 } },
    onExchange: capturedExchange,
  });

  await harness.tasks.xiaoyaojinCoupon();

  assert.deepEqual(harness.exchanges(), CAPTURED_EXCHANGES);
  assert.match(harness.text(), /余额 43/);
  assert.match(harness.text(), /买饼干 ×8/);
  assert.match(harness.text(), /换复活丹 ×1 成功/);
  // 正常路径不该出现任何「失败」字样（这条能挡住 import 漏了之类的运行时崩溃）
  assert.ok(!/失败/.test(harness.text()), `不该有失败日志：\n${harness.text()}`);
});

test("券不够 5 → 不买饼干；够 3 → 只换复活丹", async () => {
  const harness = createHarness({
    activityGet: ACTIVITY_GET_ENDED,
    roleItems: { 5285: { quantity: 4 } },
    onExchange: capturedExchange,
  });

  await harness.tasks.xiaoyaojinCoupon();

  assert.deepEqual(harness.exchanges(), [
    { activityId: 2609193, goodsId: 260919303, quantity: 1 },
  ]);
  assert.match(harness.text(), /剩余 4 券/);
});

test("余额读不到（背包里没有 5285）→ 一条兑换都不发", async () => {
  const harness = createHarness({
    activityGet: ACTIVITY_GET_ENDED,
    roleItems: {},
    onExchange: capturedExchange,
  });

  await harness.tasks.xiaoyaojinCoupon();

  assert.deepEqual(harness.exchanges(), []);
  assert.match(harness.text(), /余额失败/);
});

test("余券不足 3 → 只买饼干，不换复活丹", async () => {
  const harness = createHarness({
    activityGet: ACTIVITY_GET_ENDED,
    roleItems: { 5285: { quantity: 7 } }, // 1 个饼干（5）余 2
    onExchange: (params) =>
      params.goodsId === 260919302
        ? { role: { items: { 5285: { quantity: 2 } } }, reward: [] }
        : { role: { items: {} }, reward: [] },
  });

  await harness.tasks.xiaoyaojinCoupon();

  assert.deepEqual(harness.exchanges(), [
    { activityId: 2609193, goodsId: 260919302, quantity: 1 },
  ]);
  assert.match(harness.text(), /不足 3/);
});

test("★ 手工日期头压过自动探测：填 260919 就按 260919 发（不会跑到新一期）", async () => {
  // 上一期 260919 兑券延时未过、新一期 260925 已开 → 自动探测「取日期头最大者」会选 260925
  const both = {
    activity: {
      warOrderActivityInfo: {},
      commonActivityInfo: {
        2609193: { record: {}, task: {}, isBought: false },
        2609253: { record: {}, task: {}, isBought: false },
        2609255: { record: {}, task: {}, isBought: false },
      },
    },
  };

  const auto = createHarness({
    activityGet: both,
    roleItems: { 5285: { quantity: 43 } },
    onExchange: capturedExchange,
  });
  await auto.tasks.xiaoyaojinCoupon();
  assert.deepEqual(
    [...new Set(auto.exchanges().map((item) => item.activityId))],
    [2609253],
    "自动探测会选新一期 —— 这正是 01:03 那次「物品不存在」的现场",
  );

  const manual = createHarness({
    activityGet: both,
    roleItems: { 5285: { quantity: 43 } },
    overrides: { head: "260919" },
    onExchange: capturedExchange,
  });
  await manual.tasks.xiaoyaojinCoupon();
  assert.deepEqual(manual.exchanges(), CAPTURED_EXCHANGES);
  assert.match(manual.text(), /日期头 260919/);
});

test("整批报「超上限」→ 降级逐个买，能买几个算几个", async () => {
  let single = 0;
  const harness = createHarness({
    activityGet: ACTIVITY_GET_ENDED,
    roleItems: { 5285: { quantity: 43 } },
    onExchange: (params) => {
      if (params.quantity > 1) {
        return Object.assign(new Error("兑换数量超上限"), { code: 700010 });
      }
      single += 1;
      if (single > 3) return new Error("兑换数量超上限"); // 限购 3 个
      return { role: { items: { 5285: { quantity: 43 - single * 5 } } }, reward: [] };
    },
  });

  await harness.tasks.xiaoyaojinCoupon();

  const cookieCalls = harness
    .exchanges()
    .filter((item) => item.goodsId === 260919302);
  assert.equal(cookieCalls[0].quantity, 8, "第一次仍是整批");
  assert.equal(cookieCalls.length, 5, "整批1 + 逐个3成功 + 第4个失败");
  assert.equal(cookieCalls[1].quantity, 1);
  assert.match(harness.text(), /降级逐个买/);
});
