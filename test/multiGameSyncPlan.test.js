import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  describeSyncRole,
  normalizeSyncMode,
  orderSyncGroups,
  planMultiGameSync,
  resolveGroupMaster,
  SYNC_MODE_GLOBAL,
  SYNC_MODE_GROUP,
  SYNC_MODE_NONE,
} from "../src/utils/multiGameSyncPlan.js";

const frames = (...scopeIds) =>
  scopeIds.map((scopeId) => ({ scopeId, name: `账号${scopeId}` }));

test("normalizeSyncMode 只认识 group / global，其余一律视为不同步", () => {
  assert.equal(normalizeSyncMode(SYNC_MODE_GROUP), SYNC_MODE_GROUP);
  assert.equal(normalizeSyncMode(SYNC_MODE_GLOBAL), SYNC_MODE_GLOBAL);
  assert.equal(normalizeSyncMode("GLOBAL"), SYNC_MODE_NONE);
  assert.equal(normalizeSyncMode(undefined), SYNC_MODE_NONE);
  assert.equal(normalizeSyncMode(null), SYNC_MODE_NONE);
});

test("resolveGroupMaster 默认取组内第一个，手动指定优先但必须仍在组内", () => {
  assert.equal(resolveGroupMaster(["a", "b"], undefined), "a");
  assert.equal(resolveGroupMaster(["a", "b"], "b"), "b");
  // 指定的窗口已经不在该组（关窗 / 改分组）时回退到第一个
  assert.equal(resolveGroupMaster(["a", "b"], "c"), "a");
  assert.equal(resolveGroupMaster([], "a"), null);
  assert.equal(resolveGroupMaster(undefined, "a"), null);
});

test("orderSyncGroups 按保存的顺序重排，没记录过的分组稳定追加在后面", () => {
  const groups = [{ id: "g1" }, { id: "g2" }, { id: "g3" }];
  assert.deepEqual(
    orderSyncGroups(groups, ["g3", "g1", "g2"]).map((group) => group.id),
    ["g3", "g1", "g2"],
  );
  assert.deepEqual(
    orderSyncGroups(groups, ["g2"]).map((group) => group.id),
    ["g2", "g1", "g3"],
  );
  assert.deepEqual(
    orderSyncGroups(groups, []).map((group) => group.id),
    ["g1", "g2", "g3"],
  );
});

test("不同步模式：所有窗口都没有同步角色（但分组信息仍然可用）", () => {
  const plan = planMultiGameSync({
    mode: SYNC_MODE_NONE,
    frames: frames("a", "b"),
    groups: [{ id: "g1", name: "第一组", scopeIds: ["a", "b"] }],
  });
  assert.equal(plan.mode, SYNC_MODE_NONE);
  assert.equal(plan.active, false);
  assert.deepEqual(plan.roles, {
    a: { send: false, receive: false },
    b: { send: false, receive: false },
  });
  assert.equal(plan.groups[0].masterScopeId, "a");
});

test("分组同步：每组组长只驱动本组其他窗口", () => {
  const plan = planMultiGameSync({
    mode: SYNC_MODE_GROUP,
    frames: frames("a", "b", "c", "d"),
    groups: [
      { id: "g1", scopeIds: ["a", "b"] },
      { id: "g2", scopeIds: ["c", "d"] },
    ],
  });
  assert.equal(plan.active, true);
  assert.deepEqual(plan.roles, {
    a: { send: true, receive: false },
    b: { send: false, receive: true },
    c: { send: true, receive: false },
    d: { send: false, receive: true },
  });
  assert.deepEqual(plan.targets, { a: ["b"], c: ["d"] });
  assert.deepEqual(plan.sources, [
    { groupId: "g1", scopeId: "a" },
    { groupId: "g2", scopeId: "c" },
  ]);
  assert.equal(plan.sourceScopeId, null);
});

test("分组同步：单人分组没有同步对象，手动指定的组长生效", () => {
  const plan = planMultiGameSync({
    mode: SYNC_MODE_GROUP,
    frames: frames("a", "b", "c"),
    groups: [
      { id: "g1", scopeIds: ["a", "b"] },
      { id: "g2", scopeIds: ["c"] },
    ],
    masters: { g1: "b" },
  });
  assert.deepEqual(plan.roles, {
    a: { send: false, receive: true },
    b: { send: true, receive: false },
    c: { send: false, receive: false },
  });
  assert.deepEqual(plan.targets, { b: ["a"] });
  assert.equal(plan.groups[1].masterScopeId, "c");
});

test("分组同步：窗口同时属于两个分组时可以既驱动又跟随", () => {
  const plan = planMultiGameSync({
    mode: SYNC_MODE_GROUP,
    frames: frames("a", "b", "c"),
    groups: [
      { id: "g1", scopeIds: ["a", "b"] },
      { id: "g2", scopeIds: ["b", "c"] },
    ],
  });
  assert.deepEqual(plan.roles, {
    a: { send: true, receive: false },
    b: { send: true, receive: true },
    c: { send: false, receive: true },
  });
  assert.deepEqual(plan.targets, { a: ["b"], b: ["c"] });
  assert.deepEqual(describeSyncRole(plan.roles.b), {
    label: "组长 + 跟随",
    tone: "both",
  });
});

test("分组同步：组长窗口关闭后自动回退为组内下一个窗口", () => {
  const plan = planMultiGameSync({
    mode: SYNC_MODE_GROUP,
    frames: frames("b", "c"),
    groups: [{ id: "g1", scopeIds: ["a", "b"] }],
    masters: { g1: "a" },
  });
  assert.deepEqual(plan.groups[0].scopeIds, ["b"]);
  assert.equal(plan.groups[0].masterScopeId, "b");
  assert.equal(plan.active, false);
});

test("全局同步：第一个分组的组长驱动全部窗口，其余窗口只接收", () => {
  const plan = planMultiGameSync({
    mode: SYNC_MODE_GLOBAL,
    frames: frames("a", "b", "c", "d"),
    groups: [
      { id: "g1", name: "第二组", scopeIds: ["c", "d"] },
      { id: "g2", name: "第一组", scopeIds: ["a", "b"] },
    ],
  });
  assert.equal(plan.sourceScopeId, "c");
  assert.deepEqual(plan.targets, { c: ["a", "b", "d"] });
  assert.deepEqual(plan.roles, {
    a: { send: false, receive: true },
    b: { send: false, receive: true },
    c: { send: true, receive: false },
    d: { send: false, receive: true },
  });
  assert.equal(plan.active, true);
});

test("全局同步：分组顺序变化会改变同步源", () => {
  const input = {
    mode: SYNC_MODE_GLOBAL,
    frames: frames("a", "b", "c", "d"),
    groups: [
      { id: "g1", scopeIds: ["c", "d"] },
      { id: "g2", scopeIds: ["a", "b"] },
    ],
  };
  assert.equal(planMultiGameSync(input).sourceScopeId, "c");
  assert.equal(
    planMultiGameSync({
      ...input,
      groups: orderSyncGroups(input.groups, ["g2", "g1"]),
    }).sourceScopeId,
    "a",
  );
});

test("全局同步：没有分组时不生效（分组只能来自 Token 管理，页面不兜底）", () => {
  const plan = planMultiGameSync({
    mode: SYNC_MODE_GLOBAL,
    frames: frames("a", "b"),
    groups: [],
  });
  assert.equal(plan.sourceScopeId, null);
  assert.equal(plan.active, false);
  assert.deepEqual(plan.targets, {});
  assert.deepEqual(plan.roles, {
    a: { send: false, receive: false },
    b: { send: false, receive: false },
  });
});

test("只显示有已打开窗口的分组（Token 管理里没选中的分组不会出现）", () => {
  const plan = planMultiGameSync({
    mode: SYNC_MODE_GROUP,
    frames: frames("a", "b"),
    groups: [
      { id: "g1", name: "已选中组", scopeIds: ["a", "b"] },
      { id: "g2", name: "没选中的组", scopeIds: [] },
      { id: "g3", name: "账号未打开的组", scopeIds: [] },
    ],
  });
  assert.deepEqual(
    plan.groups.map((group) => group.id),
    ["g1"],
  );
});

test("没有任何窗口时不产生同步角色", () => {
  const plan = planMultiGameSync({
    mode: SYNC_MODE_GLOBAL,
    frames: [],
    groups: [{ id: "g1", scopeIds: ["a"] }],
  });
  assert.equal(plan.active, false);
  assert.equal(plan.sourceScopeId, null);
  assert.deepEqual(plan.groups, []);
});

test("describeSyncRole 区分同步源 / 跟随 / 双向 / 无角色", () => {
  assert.deepEqual(describeSyncRole({ send: true, receive: false }), {
    label: "同步源",
    tone: "source",
  });
  assert.deepEqual(describeSyncRole({ send: false, receive: true }), {
    label: "跟随",
    tone: "target",
  });
  assert.equal(describeSyncRole({ send: false, receive: false }), null);
  assert.equal(describeSyncRole(undefined), null);
});

test("同步桥接脚本按 send / receive 两个方向控制事件流", async () => {
  const bridge = await readFile(
    new URL("../public/game/multi-game-sync-bridge.js", import.meta.url),
    "utf8",
  );
  assert.match(bridge, /let sendEnabled = false;/);
  assert.match(bridge, /let receiveEnabled = false;/);
  // 只有同步源上报本地事件
  assert.match(bridge, /if \(!sendEnabled\) return;/);
  // 只有同步从回放远程事件
  assert.match(bridge, /receiveEnabled\b[\s\S]{0,40}\)\s*\{/);
  assert.match(bridge, /setRole: \(send, receive\) => applySyncRole\(send, receive\)/);
});
