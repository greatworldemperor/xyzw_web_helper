/**
 * 智能补齐目标（master 2026-11-01 需求）
 *
 * 与「一键补齐」的区别：
 *   - 一键补齐（原有，**不改**）：按日历线性摊平 —— `dayOfMonth / daysInMonth × 目标`，
 *     只看"平均进度"，越到月底越接近满额，但月初就要补很多（例：11-01 要补到 11 次）。
 *   - 智能补齐（新增）：按「每日任务底线」倒推 —— 只补到"剩下的日子靠每日任务刚好做满"
 *     为止，今天不用多做，后面也不会做不满。
 *
 * 口径（master 明确给出）：
 *   - 钓鱼：每日任务 3 次免费钓鱼 ⇒ 剩余 N 天可自然完成 3N 次
 *   - 竞技场：每日 3 场全胜 = 6 分 ⇒ 剩余 N 天可自然完成 6N 分
 *   - 今天应完成 = 目标 − 剩余天数 × 每日量（下限 0；最后一天剩余 0 ⇒ 满额）
 *
 * 例（11 月 30 天，11-10）：
 *   剩余 20 天 ⇒ 钓鱼 320 − 20×3 = 260；竞技场 240 − 20×6 = 120
 *
 * 「剩余天数」不含当天：当天还有一次每日任务机会，算进"自然完成"里就会少补一天。
 */

import { ARENA_TARGET, FISH_TARGET } from "./constants.js";

/** 每日免费钓鱼次数（月度钓鱼任务的自然增长量） */
export const FISH_PER_DAY = 3;

/** 每日竞技场可得积分（3 场全胜 × 2 分） */
export const ARENA_POINTS_PER_DAY = 6;

/** 合法日期就用它，非法/缺省一律按“现在”处理，避免 NaN 把目标算成 0 */
const normalizeDate = (date) =>
  date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();

const toNonNegativeNumber = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
};

/** 当月总天数 */
export function getDaysInMonth(date = new Date()) {
  const d = normalizeDate(date);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/**
 * 今天之后的剩余天数（不含当天）
 * 11-10 / 30 天月 ⇒ 20；最后一天 ⇒ 0
 */
export function getRemainingDaysAfterToday(date = new Date()) {
  const d = normalizeDate(date);
  return Math.max(0, getDaysInMonth(d) - d.getDate());
}

/**
 * 钓鱼今日底线
 * @param {Date} [date]
 * @param {{fishTarget?: number, fishPerDay?: number}} [options]
 * @returns {number} 今天结束前应达到的累计钓鱼次数
 */
export function calcSmartFishTarget(date = new Date(), options = {}) {
  const fishTarget = toNonNegativeNumber(options.fishTarget, FISH_TARGET);
  const fishPerDay = toNonNegativeNumber(options.fishPerDay, FISH_PER_DAY);
  return Math.max(0, fishTarget - getRemainingDaysAfterToday(date) * fishPerDay);
}

/**
 * 竞技场今日底线
 * @param {Date} [date]
 * @param {{arenaTarget?: number, arenaPointsPerDay?: number}} [options]
 * @returns {number} 今天结束前应达到的累计积分
 */
export function calcSmartArenaTarget(date = new Date(), options = {}) {
  const arenaTarget = toNonNegativeNumber(options.arenaTarget, ARENA_TARGET);
  const arenaPointsPerDay = toNonNegativeNumber(
    options.arenaPointsPerDay,
    ARENA_POINTS_PER_DAY,
  );
  return Math.max(
    0,
    arenaTarget - getRemainingDaysAfterToday(date) * arenaPointsPerDay,
  );
}

/**
 * 一次性拿到两条线的今日底线 + 中间量（日志里要展示剩余天数/每日量）
 * @param {Date} [date]
 * @param {{fishTarget?: number, arenaTarget?: number, fishPerDay?: number, arenaPointsPerDay?: number}} [options]
 */
export function calcSmartTopUpTargets(date = new Date(), options = {}) {
  const d = normalizeDate(date);
  const fishTarget = toNonNegativeNumber(options.fishTarget, FISH_TARGET);
  const arenaTarget = toNonNegativeNumber(options.arenaTarget, ARENA_TARGET);
  const fishPerDay = toNonNegativeNumber(options.fishPerDay, FISH_PER_DAY);
  const arenaPointsPerDay = toNonNegativeNumber(
    options.arenaPointsPerDay,
    ARENA_POINTS_PER_DAY,
  );
  const remainingDays = getRemainingDaysAfterToday(d);

  return {
    daysInMonth: getDaysInMonth(d),
    dayOfMonth: d.getDate(),
    remainingDays,
    fishTarget,
    fishPerDay,
    fishShouldBe: Math.max(0, fishTarget - remainingDays * fishPerDay),
    arenaTarget,
    arenaPointsPerDay,
    arenaShouldBe: Math.max(0, arenaTarget - remainingDays * arenaPointsPerDay),
  };
}
