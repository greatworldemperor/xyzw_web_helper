import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RECEIVER_MODE_AUTO,
  RECEIVER_MODE_MANUAL,
  SHARE_ERROR_SELF_EXHAUSTED,
  SHARE_ERROR_TARGET_FULL,
  SHARE_SLOT_COUNT,
  autoAssignSlots,
  classifyShareError,
  collectAssignments,
  createEmptyAssistPlan,
  diffPoolSelection,
  findInitiatorOwner,
  normalizeAssistPlan,
  occupiedInitiatorKeys,
  releaseInitiator,
  removeReceivers,
  setAssistPool,
  setReceiverMode,
  setSlot,
  upsertReceivers,
  validateAssistPlan,
} from "../src/utils/weirdTowerSharePlan.js";

// 便于书写：真实抓包里的三个身份键
const R_MAIN = "9724:130301444"; // 世界国皇帝（主号）
const A_HAIWANG = "26501:666543015"; // 海王
const A_38 = "9738:139075590"; // 38号战士
const A_OTHER = "9724:139073239";

const planWith = (overrides = {}) => ({
  ...createEmptyAssistPlan(),
  assistPool: [A_HAIWANG, A_38, A_OTHER],
  ...overrides,
});

const receiversOf = () => [
  { key: R_MAIN, name: "世界国皇帝", server: "9724服" },
];

test("空计划结构与槽位数", () => {
  const plan = createEmptyAssistPlan();
  assert.deepEqual(plan.receivers, []);
  assert.deepEqual(plan.assistPool, []);
  assert.equal(SHARE_SLOT_COUNT, 3);
});

test("按钮 1.1：追加接受助力角色（已存在的跳过，不覆盖）", () => {
  const first = upsertReceivers(createEmptyAssistPlan(), receiversOf());
  assert.deepEqual(first.added, [R_MAIN]);
  assert.equal(first.plan.receivers[0].mode, RECEIVER_MODE_MANUAL);
  assert.deepEqual(first.plan.receivers[0].slots, [null, null, null]);

  const second = upsertReceivers(first.plan, [
    ...receiversOf(),
    { key: A_38, name: "38号战士" },
  ]);
  assert.deepEqual(second.added, [A_38]);
  assert.equal(second.plan.receivers.length, 2);
});

test("按钮 1.2：设置助力池是覆盖而不是合并", () => {
  const before = planWith();
  const after = setAssistPool(before, [A_38]);
  assert.deepEqual(after.assistPool, [A_38]);
});

test("规范化：去重、补足 3 个槽、丢弃非法项", () => {
  const plan = normalizeAssistPlan({
    receivers: [
      { key: R_MAIN, slots: [A_HAIWANG] },
      { key: R_MAIN, slots: [] }, // 重复，丢弃
      { key: "", slots: [] }, // 非法，丢弃
      { key: A_38, mode: "auto", slots: [null, null, null, "extra"] },
    ],
    assistPool: [A_HAIWANG, A_HAIWANG, "", A_38],
  });

  assert.equal(plan.receivers.length, 2);
  assert.deepEqual(plan.receivers[0].slots, [A_HAIWANG, null, null]);
  assert.equal(plan.receivers[1].mode, RECEIVER_MODE_AUTO);
  assert.equal(plan.receivers[1].slots.length, SHARE_SLOT_COUNT);
  assert.deepEqual(plan.assistPool, [A_HAIWANG, A_38]);
});

test("规范化自愈：同一助力者占多个槽时只保留最早的一个", () => {
  const plan = normalizeAssistPlan({
    receivers: [
      { key: R_MAIN, slots: [A_HAIWANG, A_HAIWANG, null] },
      { key: A_38, slots: [A_HAIWANG, null, null] },
    ],
    assistPool: [A_HAIWANG],
  });

  assert.deepEqual(plan.receivers[0].slots, [A_HAIWANG, null, null]);
  assert.deepEqual(plan.receivers[1].slots, [null, null, null]);
  assert.equal(occupiedInitiatorKeys(plan).size, 1);
});

test("手动指定槽位：全局唯一 —— 同一助力者会被从旧槽位腾走", () => {
  let plan = upsertReceivers(planWith(), [
    ...receiversOf(),
    { key: A_38, name: "38号战士" },
  ]).plan;

  plan = setSlot(plan, R_MAIN, 0, A_HAIWANG).plan;
  assert.equal(plan.receivers[0].slots[0], A_HAIWANG);

  // 再把同一个助力者指给另一个角色的槽位 → 旧槽位应被腾空
  const moved = setSlot(plan, A_38, 2, A_HAIWANG);
  assert.equal(moved.error, undefined);
  assert.equal(moved.plan.receivers[1].slots[2], A_HAIWANG);
  assert.equal(moved.plan.receivers[0].slots[0], null);
  assert.equal(occupiedInitiatorKeys(moved.plan).size, 1);

  const owner = findInitiatorOwner(moved.plan, A_HAIWANG);
  assert.deepEqual(owner, { receiverKey: A_38, slotIndex: 2 });
});

test("手动指定槽位：拒绝给自己助力、拒绝池外角色", () => {
  const plan = upsertReceivers(planWith(), receiversOf()).plan;

  assert.equal(setSlot(plan, R_MAIN, 0, R_MAIN).error, "self");
  assert.equal(setSlot(plan, R_MAIN, 0, "9999:111").error, "not-in-pool");

  // 清空槽位
  const filled = setSlot(plan, R_MAIN, 1, A_HAIWANG).plan;
  const cleared = setSlot(filled, R_MAIN, 1, null).plan;
  assert.equal(cleared.receivers[0].slots[1], null);
});

test("模式切换：手动 → 自动 清空该角色的槽位；自动 → 手动 保留", () => {
  let plan = upsertReceivers(planWith(), receiversOf()).plan;
  plan = setSlot(plan, R_MAIN, 0, A_HAIWANG).plan;

  const toAuto = setReceiverMode(plan, R_MAIN, RECEIVER_MODE_AUTO);
  assert.equal(toAuto.receivers[0].mode, RECEIVER_MODE_AUTO);
  assert.deepEqual(toAuto.receivers[0].slots, [null, null, null]);

  const filledByAuto = autoAssignSlots(toAuto, {
    random: () => 0,
  }).plan;
  assert.ok(filledByAuto.receivers[0].slots[0]);

  const backToManual = setReceiverMode(filledByAuto, R_MAIN, RECEIVER_MODE_MANUAL);
  assert.equal(backToManual.receivers[0].mode, RECEIVER_MODE_MANUAL);
  assert.deepEqual(backToManual.receivers[0].slots, filledByAuto.receivers[0].slots);
});

test("自动分配：只填 auto 角色，跳过已占用的池成员，不给自己助力", () => {
  // 主号既在池中又是接受者 → 不能给自己助力
  const plan = {
    ...planWith({ assistPool: [R_MAIN, A_HAIWANG, A_38, A_OTHER] }),
    receivers: [
      { key: R_MAIN, name: "主号", mode: RECEIVER_MODE_AUTO, slots: [null, null, null] },
      { key: A_38, name: "38号", mode: RECEIVER_MODE_MANUAL, slots: [A_OTHER, null, null] },
    ],
  };

  const result = autoAssignSlots(plan, { random: () => 0 });

  // A_OTHER 已被手动占用 → 不会分给别人（全局只出现一次）
  const allSlots = result.plan.receivers.flatMap((r) => r.slots).filter(Boolean);
  assert.equal(allSlots.filter((k) => k === A_OTHER).length, 1);

  // 候选 = 池内未被占用者 = {R_MAIN, A_HAIWANG, A_38}，其中给自己要排除
  // → 主号填到 A_HAIWANG、A_38 两个；R_MAIN 自己不会被分给自己
  assert.equal(result.plan.receivers[0].slots[0], A_HAIWANG);
  assert.equal(result.plan.receivers[0].slots[1], A_38);
  assert.ok(!result.plan.receivers[0].slots.includes(R_MAIN));
  assert.equal(result.assigned.length, 2);
  // 候选用尽 → 剩 1 个空槽报缺
  assert.deepEqual(result.shortages, [{ receiverKey: R_MAIN, missing: 1 }]);
  // 手动角色不受影响
  assert.deepEqual(result.plan.receivers[1].slots, [A_OTHER, null, null]);
});

test("自动分配：候选充足时每个 auto 角色填满 3 个且互不重复", () => {
  const pool = ["1:1", "1:2", "1:3", "1:4", "1:5", "1:6"];
  const plan = {
    version: 1,
    assistPool: pool,
    receivers: [
      { key: "9:1", name: "甲", mode: RECEIVER_MODE_AUTO, slots: [null, null, null] },
      { key: "9:2", name: "乙", mode: RECEIVER_MODE_AUTO, slots: [null, null, null] },
    ],
  };

  const result = autoAssignSlots(plan, { random: () => 0.5 });
  const used = result.plan.receivers.flatMap((r) => r.slots);
  assert.equal(used.length, 6);
  assert.equal(new Set(used).size, 6, "助力者不能重复占用");
  assert.deepEqual(result.shortages, []);
});

test("自动分配：排除本周期已用掉额度的角色", () => {
  const plan = {
    ...planWith({ assistPool: [A_HAIWANG, A_38] }),
    receivers: [
      { key: "9:1", name: "甲", mode: RECEIVER_MODE_AUTO, slots: [null, null, null] },
    ],
  };

  const result = autoAssignSlots(plan, {
    usedInitiators: [A_HAIWANG],
    random: () => 0,
  });

  assert.equal(result.plan.receivers[0].slots[0], A_38);
  assert.ok(result.skippedPool.includes(A_HAIWANG));
  assert.deepEqual(result.shortages, [{ receiverKey: "9:1", missing: 2 }]);
});

test("自动分配：排除已不在角色列表的池成员", () => {
  const plan = {
    ...planWith({ assistPool: [A_HAIWANG, A_38] }),
    receivers: [
      { key: "9:1", name: "甲", mode: RECEIVER_MODE_AUTO, slots: [null, null, null] },
    ],
  };

  const result = autoAssignSlots(plan, {
    validKeys: new Set([A_38]),
    random: () => 0,
  });

  assert.equal(result.plan.receivers[0].slots[0], A_38);
  assert.ok(result.skippedPool.includes(A_HAIWANG));
});

test("collectAssignments：按选中范围收集待执行动作", () => {
  let plan = upsertReceivers(planWith(), [
    ...receiversOf(),
    { key: A_38, name: "38号战士" },
  ]).plan;
  plan = setSlot(plan, R_MAIN, 0, A_HAIWANG).plan;
  plan = setSlot(plan, A_38, 1, A_OTHER).plan;

  assert.equal(collectAssignments(plan).length, 2);
  assert.deepEqual(collectAssignments(plan, [R_MAIN]), [
    { receiverKey: R_MAIN, initiatorKey: A_HAIWANG, slotIndex: 0 },
  ]);
  assert.equal(collectAssignments(plan, ["9724:404"]).length, 0);
});

test("releaseInitiator：某助力者额度用尽后从所有槽位清掉", () => {
  let plan = upsertReceivers(planWith(), receiversOf()).plan;
  plan = setSlot(plan, R_MAIN, 0, A_HAIWANG).plan;

  const released = releaseInitiator(plan, A_HAIWANG);
  assert.deepEqual(released.receivers[0].slots, [null, null, null]);
});

test("classifyShareError：按错误码分流，不匹配文案", () => {
  assert.equal(classifyShareError({ code: SHARE_ERROR_SELF_EXHAUSTED }), "self_exhausted");
  assert.equal(classifyShareError({ code: SHARE_ERROR_TARGET_FULL }), "target_full");
  assert.equal(classifyShareError({ code: 999 }), "other");
  assert.equal(classifyShareError(new Error("服务器错误: 12200090 - 对方已到最大助力人数")), "other");
  assert.equal(classifyShareError(null), "other");
});

test("校验：池内角色失效/额度已用、槽位引用池外角色都能报出来", () => {
  let plan = upsertReceivers(planWith(), receiversOf()).plan;
  plan = setSlot(plan, R_MAIN, 0, A_HAIWANG).plan;
  // 构造一个「引用了池外角色」的脏数据（正常路径进不来）
  plan = {
    ...plan,
    receivers: [
      { ...plan.receivers[0], slots: [A_HAIWANG, "8888:1", null] },
    ],
  };

  const items = validateAssistPlan(plan, {
    validKeys: new Set([R_MAIN, A_38, A_OTHER]), // A_HAIWANG 已不在角色列表
    usedInitiators: [A_38],
  });

  const codes = items.map((item) => item.code);
  assert.ok(codes.includes("pool-not-in-token-list"));
  assert.ok(codes.includes("pool-used-this-cycle"));
  assert.ok(codes.includes("slot-not-in-pool"));
  assert.ok(codes.includes("slot-not-in-token-list"));
  assert.ok(codes.includes("summary"));

  const summary = items.find((item) => item.code === "summary");
  assert.match(summary.message, /已分配 2 个槽位/);
});

test("校验：重叠角色与已满角色只报 info 不报 warning", () => {
  const plan = {
    ...planWith({ assistPool: [A_HAIWANG] }),
    receivers: [
      { key: A_HAIWANG, name: "海王", mode: RECEIVER_MODE_MANUAL, slots: [null, null, null] },
    ],
  };

  const items = validateAssistPlan(plan, { fullReceivers: [A_HAIWANG] });
  assert.equal(items.find((i) => i.code === "pool-overlaps-receiver").level, "info");
  assert.equal(items.find((i) => i.code === "receiver-full-this-cycle").level, "info");
});

test("diffPoolSelection：该选没选 / 选了不该选的", () => {
  const diff = diffPoolSelection([A_HAIWANG, A_38], [A_HAIWANG, A_OTHER]);
  assert.deepEqual(diff.missing, [A_38]);
  assert.deepEqual(diff.extra, [A_OTHER]);
});

test("removeReceivers：移除后不留残影", () => {
  const plan = upsertReceivers(planWith(), [
    ...receiversOf(),
    { key: A_38, name: "38号战士" },
  ]).plan;

  const next = removeReceivers(plan, [R_MAIN]);
  assert.equal(next.receivers.length, 1);
  assert.equal(next.receivers[0].key, A_38);
});
