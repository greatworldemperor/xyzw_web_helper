/**
 * 智能补齐目标（smartTopUp）回归测试
 *
 * 口径由 master 明确给出（2026-11-01）：
 *   钓鱼每日 3 次、竞技场每日 6 分，剩余天数 = 当月总天数 − 今天（不含当天），
 *   今日底线 = 目标 − 剩余天数 × 每日量（下限 0）。
 *
 * 关键边界：master 给的例子（11-10 ⇒ 260 / 120）必须一字不差；
 * 最后一天必须回到满额；月初不能出现负数；闰年 2 月不能少算一天。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARENA_POINTS_PER_DAY,
  FISH_PER_DAY,
  calcSmartArenaTarget,
  calcSmartFishTarget,
  calcSmartTopUpTargets,
  getDaysInMonth,
  getRemainingDaysAfterToday,
} from "../src/utils/batch/smartTopUp.js";

test("常量口径：钓鱼 3 次/天、竞技场 6 分/天", () => {
  assert.equal(FISH_PER_DAY, 3);
  assert.equal(ARENA_POINTS_PER_DAY, 6);
});

test("★ master 的例子：11 月（30 天）10 日 ⇒ 钓鱼 260、竞技场 120", () => {
  const now = new Date(2026, 10, 10); // 2026-11-10
  assert.equal(getRemainingDaysAfterToday(now), 20);
  assert.equal(calcSmartFishTarget(now), 260); // 320 - 20*3
  assert.equal(calcSmartArenaTarget(now), 120); // 240 - 20*6
});

test("最后一天（剩余 0 天）必须回到满额 320 / 240", () => {
  const lastDay = new Date(2026, 10, 30); // 2026-11-30
  assert.equal(getRemainingDaysAfterToday(lastDay), 0);
  const targets = calcSmartTopUpTargets(lastDay);
  assert.equal(targets.fishShouldBe, 320);
  assert.equal(targets.arenaShouldBe, 240);
});

test("月初（11-01，剩 29 天）为 233 / 66，绝不出现负数", () => {
  const targets = calcSmartTopUpTargets(new Date(2026, 10, 1));
  assert.equal(targets.remainingDays, 29);
  assert.equal(targets.fishShouldBe, 233); // 320 - 87
  assert.equal(targets.arenaShouldBe, 66); // 240 - 174
});

test("31 天月份 1 号：230 / 60（剩 30 天）", () => {
  const targets = calcSmartTopUpTargets(new Date(2026, 0, 1)); // 2026-01-01
  assert.equal(targets.daysInMonth, 31);
  assert.equal(targets.remainingDays, 30);
  assert.equal(targets.fishShouldBe, 230);
  assert.equal(targets.arenaShouldBe, 60);
});

test("平年 2 月 28 天：14 日剩 14 天 ⇒ 278 / 156；28 日满额", () => {
  assert.equal(getDaysInMonth(new Date(2026, 1, 14)), 28);
  const mid = calcSmartTopUpTargets(new Date(2026, 1, 14));
  assert.equal(mid.remainingDays, 14);
  assert.equal(mid.fishShouldBe, 278); // 320 - 42
  assert.equal(mid.arenaShouldBe, 156); // 240 - 84

  const end = calcSmartTopUpTargets(new Date(2026, 1, 28));
  assert.equal(end.remainingDays, 0);
  assert.equal(end.fishShouldBe, 320);
});

test("闰年 2 月 29 天：14 日剩 15 天 ⇒ 275 / 150（不能按 28 天算）", () => {
  assert.equal(getDaysInMonth(new Date(2024, 1, 14)), 29);
  const targets = calcSmartTopUpTargets(new Date(2024, 1, 14));
  assert.equal(targets.remainingDays, 15);
  assert.equal(targets.fishShouldBe, 275); // 320 - 45
  assert.equal(targets.arenaShouldBe, 150); // 240 - 90
});

test("目标小于每日自然增长量时，今日底线归零（不追补）", () => {
  const now = new Date(2026, 10, 10); // 剩 20 天
  assert.equal(calcSmartFishTarget(now, { fishTarget: 10 }), 0); // 10 - 60 < 0
  assert.equal(calcSmartArenaTarget(now, { arenaTarget: 50 }), 0); // 50 - 120 < 0
});

test("自定义每日量：fishPerDay=0 等价于「没有每日任务」⇒ 直接补满目标", () => {
  const now = new Date(2026, 10, 10);
  assert.equal(calcSmartFishTarget(now, { fishTarget: 320, fishPerDay: 0 }), 320);
  assert.equal(
    calcSmartArenaTarget(now, { arenaTarget: 240, arenaPointsPerDay: 0 }),
    240,
  );
});

test("非法日期退化为「今天」，不抛异常也不给出 NaN", () => {
  const now = new Date();
  const expected = calcSmartTopUpTargets(now);
  const fromInvalid = calcSmartTopUpTargets(new Date("Invalid"));
  assert.equal(fromInvalid.fishShouldBe, expected.fishShouldBe);
  assert.equal(fromInvalid.remainingDays, expected.remainingDays);
  assert.equal(Number.isFinite(fromInvalid.arenaShouldBe), true);
});

test("返回值字段齐全（日志要用剩余天数与每日量）", () => {
  const targets = calcSmartTopUpTargets(new Date(2026, 10, 10));
  assert.deepEqual(
    {
      remainingDays: targets.remainingDays,
      fishTarget: targets.fishTarget,
      fishPerDay: targets.fishPerDay,
      fishShouldBe: targets.fishShouldBe,
      arenaTarget: targets.arenaTarget,
      arenaPointsPerDay: targets.arenaPointsPerDay,
      arenaShouldBe: targets.arenaShouldBe,
    },
    {
      remainingDays: 20,
      fishTarget: 320,
      fishPerDay: 3,
      fishShouldBe: 260,
      arenaTarget: 240,
      arenaPointsPerDay: 6,
      arenaShouldBe: 120,
    },
  );
});
