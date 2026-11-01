/**
 * 月度任务月末检查（monthEndCheck）离线回归测试
 *
 * 覆盖三个关键判定的边界：
 *   ① 「今天是本月最后一天」——大月/小月/闰年 2 月，误判会天天弹框或该弹不弹；
 *   ② 「roleId 最小的角色」——roleId 可能是字符串、可能缺失，选错角色等于查错账号；
 *   ③ 「月度任务是否完成」——319/320、239/240 这种差 1 次的边界必须判未完成。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateMonthlyProgress,
  extractActivityPayload,
  isLastDayOfMonth,
  pickLowestRoleIdToken,
} from "../src/utils/batch/monthEndCheck.js";

test("isLastDayOfMonth：大月 30 日算月底，29/1 日不算", () => {
  assert.equal(isLastDayOfMonth(new Date(2026, 10, 30)), true); // 11-30
  assert.equal(isLastDayOfMonth(new Date(2026, 10, 29)), false);
  assert.equal(isLastDayOfMonth(new Date(2026, 10, 1)), false);
});

test("isLastDayOfMonth：31 天月份与跨年 12-31", () => {
  assert.equal(isLastDayOfMonth(new Date(2026, 0, 31)), true); // 1-31
  assert.equal(isLastDayOfMonth(new Date(2026, 0, 30)), false);
  assert.equal(isLastDayOfMonth(new Date(2026, 11, 31)), true); // 12-31
});

test("isLastDayOfMonth：闰年 2-29 vs 平年 2-28", () => {
  assert.equal(isLastDayOfMonth(new Date(2024, 1, 29)), true); // 2024 闰年
  assert.equal(isLastDayOfMonth(new Date(2024, 1, 28)), false);
  assert.equal(isLastDayOfMonth(new Date(2026, 1, 28)), true); // 2026 平年
  assert.equal(isLastDayOfMonth(new Date(2026, 1, 27)), false);
});

test("isLastDayOfMonth：非法日期一律 false，不抛异常", () => {
  assert.equal(isLastDayOfMonth(new Date("Invalid")), false);
  assert.equal(isLastDayOfMonth(null), false);
  // 缺省参数 = 今天，只校验返回布尔值，不断言具体真假（避免测试与运行日期耦合）
  assert.equal(typeof isLastDayOfMonth(), "boolean");
});

test("pickLowestRoleIdToken：取数值最小的 roleId（含字符串混排）", () => {
  const tokens = [
    { id: "a", roleId: "10086", name: "大号" },
    { id: "b", roleId: 42, name: "小号" },
    { id: "c", roleId: "777", name: "中号" },
  ];
  assert.equal(pickLowestRoleIdToken(tokens)?.id, "b");
});

test("pickLowestRoleIdToken：缺失/非法 roleId 排最后，不被选中", () => {
  const tokens = [
    { id: "a", name: "无 roleId" },
    { id: "b", roleId: "abc", name: "非法 roleId" },
    { id: "c", roleId: 500, name: "正常" },
  ];
  assert.equal(pickLowestRoleIdToken(tokens)?.id, "c");
});

test("pickLowestRoleIdToken：全部无 roleId 时退化取第一个可用 token", () => {
  const tokens = [{ id: "x" }, { id: "y", roleId: "not-a-number" }];
  assert.equal(pickLowestRoleIdToken(tokens)?.id, "x");
  assert.equal(pickLowestRoleIdToken([]), null);
  assert.equal(pickLowestRoleIdToken(null), null);
});

test("extractActivityPayload：兼容 {activity} / {body:{activity}} / 裸对象", () => {
  const act = { myMonthInfo: { "2": { num: 1 } } };
  assert.deepEqual(extractActivityPayload({ activity: act }), act);
  assert.deepEqual(extractActivityPayload({ body: { activity: act } }), act);
  assert.deepEqual(extractActivityPayload(act), act);
  assert.equal(extractActivityPayload(null), null);
  assert.equal(extractActivityPayload("oops"), null);
});

test("evaluateMonthlyProgress：满额 320 / 240 ⇒ allDone", () => {
  const progress = evaluateMonthlyProgress({
    myMonthInfo: { "2": { num: 320 } },
    myArenaInfo: { num: 240 },
  });
  assert.equal(progress.valid, true);
  assert.equal(progress.fishDone, true);
  assert.equal(progress.arenaDone, true);
  assert.equal(progress.allDone, true);
  assert.equal(progress.missingItems.length, 0);
});

test("evaluateMonthlyProgress：差 1 次也算未完成（319 / 239 边界）", () => {
  const progress = evaluateMonthlyProgress({
    myMonthInfo: { "2": { num: 319 } },
    myArenaInfo: { num: 239 },
  });
  assert.equal(progress.fishDone, false);
  assert.equal(progress.arenaDone, false);
  assert.equal(progress.allDone, false);
  assert.deepEqual(
    progress.missingItems.map((item) => item.key),
    ["fish", "arena"],
  );
  assert.equal(progress.items[0].percent, 100); // 319/320 四舍五入仍是 100%，但 done 必须是 false
});

test("evaluateMonthlyProgress：单项未完成也能识别", () => {
  const progress = evaluateMonthlyProgress({
    myMonthInfo: { "2": { num: 320 } },
    myArenaInfo: { num: 12 },
  });
  assert.equal(progress.allDone, false);
  assert.equal(progress.fishDone, true);
  assert.deepEqual(
    progress.missingItems.map((item) => item.key),
    ["arena"],
  );
});

test("evaluateMonthlyProgress：字符串数字 / 缺字段的容错", () => {
  const fromString = evaluateMonthlyProgress({
    myMonthInfo: { "2": { num: "320" } },
    myArenaInfo: { num: "240" },
  });
  assert.equal(fromString.allDone, true);

  // myArenaInfo 缺失 ⇒ 竞技场按 0 计（未完成），但整体仍 valid
  const partial = evaluateMonthlyProgress({ myMonthInfo: { "2": { num: 320 } } });
  assert.equal(partial.valid, true);
  assert.equal(partial.arenaNum, 0);
  assert.equal(partial.allDone, false);

  // 明显异常值（NaN / 负数）不参与「完成」判定
  const weird = evaluateMonthlyProgress({
    myMonthInfo: { "2": { num: "abc" } },
    myArenaInfo: { num: -5 },
  });
  assert.equal(weird.fishNum, 0);
  assert.equal(weird.arenaNum, 0);
  assert.equal(weird.allDone, false);
});

test("evaluateMonthlyProgress：结构不认识时 valid=false（不得误判为未完成）", () => {
  assert.equal(evaluateMonthlyProgress(null).valid, false);
  assert.equal(evaluateMonthlyProgress({}).valid, false);
  assert.equal(evaluateMonthlyProgress({ other: 1 }).valid, false);
});
