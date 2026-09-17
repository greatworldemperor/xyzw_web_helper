/**
 * 怪异塔（幻塔 / EvoTower）活动周期与「助力窗口」判定
 *
 * 纯逻辑模块，不依赖 Vue / store，便于单测。
 * 协议与业务依据见 docs/weird-tower-share-code-protocol.md
 *
 * 核心规则（master 确认）：
 *   1. 活动三周一轮，每轮三个活动周：黑市周 → 招募周 → 宝箱周。
 *   2. **游戏的活动周 = 周五 12:00 开 → 周四 24:00 关，只有 6.5 天**，
 *      不是 7 天。
 *   3. 怪异塔**只在黑市周开放**；战斗与助力在**周四 24:00（= 周五 00:00）截止**。
 *   4. 黑市周结束后到下一个周五 12:00 之间的 **12 小时是「尾巴期」**：
 *      只能使用道具 / 领奖励（批量任务的自动智能道具处理、领取免费道具），
 *      **战斗和助力都已经关闭**。
 *   5. 一次活动周期内**不重置**：每角色发起 1 次、接收 3 次都是周期内总量。
 *
 * ⚠️ 因此**不能用「是不是黑市周」来判断助力能不能做** —— 黑市周窗口（7 天）
 * 覆盖了尾巴期（12 小时），是个**超集**。判定助力必须额外排除尾巴期。
 */

/** 周期锚点：2025-12-12 12:00（黑市周开始）。与 components/Tower/WeirdTowerStatus.vue 保持一致。 */
export const WEIRD_TOWER_CYCLE_ANCHOR = "2025-12-12T12:00:00";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
export const CYCLE_MS = 3 * WEEK_MS;

/**
 * 战斗 / 助力窗口长度：6.5 天。
 * 周五 12:00 起算，到周四 24:00 截止（= 下一个周五 00:00）。
 */
export const SHARE_WINDOW_MS = 6.5 * DAY_MS;

/** 三周轮换的活动周，索引即周期内的第几周 */
export const ACTIVITY_PHASES = ["黑市周", "招募周", "宝箱周"];

/** 怪异塔（含助力）开放的活动周 */
export const WEIRD_TOWER_PHASE = "黑市周";

const ANCHOR_MS = new Date(WEIRD_TOWER_CYCLE_ANCHOR).getTime();

const toMs = (date) => (date instanceof Date ? date.getTime() : Number(date));

/**
 * 取指定时刻所处的周期信息。
 * @param {Date|number} [date]
 * @returns {null | {
 *   cycleIndex: number, phase: string, isBlackMarketWeek: boolean,
 *   cycleStartMs: number, cycleEndMs: number,
 *   weekStartMs: number, weekEndMs: number,
 *   shareOpenMs: number, shareCloseMs: number, shareWindowOpen: boolean,
 * }} 锚点之前返回 null
 */
export function getWeirdTowerCycleInfo(date = new Date()) {
  const now = toMs(date);
  if (!Number.isFinite(now)) return null;

  const elapsed = now - ANCHOR_MS;
  if (elapsed < 0) return null; // 活动尚未开始

  const cycleIndex = Math.floor(elapsed / CYCLE_MS);
  const cycleStartMs = ANCHOR_MS + cycleIndex * CYCLE_MS;
  const cyclePosition = now - cycleStartMs;
  const weekIndex = Math.min(
    ACTIVITY_PHASES.length - 1,
    Math.floor(cyclePosition / WEEK_MS),
  );

  const weekStartMs = cycleStartMs + weekIndex * WEEK_MS;
  const shareOpenMs = cycleStartMs; // 助力窗口从黑市周起点开始
  const shareCloseMs = cycleStartMs + SHARE_WINDOW_MS; // 周四 24:00

  return {
    cycleIndex,
    phase: ACTIVITY_PHASES[weekIndex],
    isBlackMarketWeek: weekIndex === 0,
    cycleStartMs,
    cycleEndMs: cycleStartMs + CYCLE_MS,
    weekStartMs,
    weekEndMs: weekStartMs + WEEK_MS,
    shareOpenMs,
    shareCloseMs,
    shareWindowOpen: now >= shareOpenMs && now < shareCloseMs,
  };
}

/**
 * 周期键：用于给「本周期已用掉额度」这类执行状态做缓存键。
 * 每三周变一次，**不要用日期键**（一次活动内不重置，按日会让黑名单反复过期）。
 * @returns {null|string} 形如 "c13"；活动未开始返回 null
 */
export function getWeirdTowerCycleKey(date = new Date()) {
  const info = getWeirdTowerCycleInfo(date);
  return info ? `c${info.cycleIndex}` : null;
}

/** 助力是否可用（黑市周 且 未进入尾巴期） */
export function isWeirdTowerShareWindowOpen(date = new Date()) {
  const info = getWeirdTowerCycleInfo(date);
  return info ? info.shareWindowOpen : false;
}

/**
 * 是否处于「尾巴期」：黑市周最后 12 小时。
 * 此时怪异塔仍开放（可道具 / 领奖），但战斗与助力都已关闭。
 */
export function isWeirdTowerTailWindow(date = new Date()) {
  const info = getWeirdTowerCycleInfo(date);
  if (!info || !info.isBlackMarketWeek) return false;
  return toMs(date) >= info.shareCloseMs;
}

/**
 * 给 UI 用的窗口状态描述。
 * @returns {null | {
 *   state: "open"|"tail"|"not-black-market"|"before-start",
 *   open: boolean, cycleIndex: number|null, phase: string|null,
 *   closeAtMs: number|null, nextOpenMs: number|null, reason: string,
 * }}
 */
export function describeWeirdTowerShareState(date = new Date()) {
  const now = toMs(date);
  if (!Number.isFinite(now)) return null;

  const info = getWeirdTowerCycleInfo(date);
  if (!info) {
    return {
      state: "before-start",
      open: false,
      cycleIndex: null,
      phase: null,
      closeAtMs: null,
      nextOpenMs: ANCHOR_MS,
      reason: "活动尚未开始",
    };
  }

  const cycleLabel = `周期 #${info.cycleIndex} ${info.phase}`;

  if (info.shareWindowOpen) {
    return {
      state: "open",
      open: true,
      cycleIndex: info.cycleIndex,
      phase: info.phase,
      closeAtMs: info.shareCloseMs,
      nextOpenMs: null,
      reason: `${cycleLabel}：助力窗口开放中`,
    };
  }

  if (info.isBlackMarketWeek) {
    // 黑市周内但已过 6.5 天 → 尾巴期
    return {
      state: "tail",
      open: false,
      cycleIndex: info.cycleIndex,
      phase: info.phase,
      closeAtMs: null,
      nextOpenMs: info.cycleStartMs + CYCLE_MS,
      reason: `${cycleLabel}：已进入尾巴期（12 小时内只能使用道具 / 领奖励），战斗与助力均已关闭`,
    };
  }

  return {
    state: "not-black-market",
    open: false,
    cycleIndex: info.cycleIndex,
    phase: info.phase,
    closeAtMs: null,
    nextOpenMs: info.cycleStartMs + CYCLE_MS,
    reason: `${cycleLabel}：助力只在黑市周开放`,
  };
}

export default {
  WEIRD_TOWER_CYCLE_ANCHOR,
  CYCLE_MS,
  WEEK_MS,
  SHARE_WINDOW_MS,
  ACTIVITY_PHASES,
  getWeirdTowerCycleInfo,
  getWeirdTowerCycleKey,
  isWeirdTowerShareWindowOpen,
  isWeirdTowerTailWindow,
  describeWeirdTowerShareState,
};
