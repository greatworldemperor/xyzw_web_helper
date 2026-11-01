/**
 * 月度任务「月末检查」（master 2026-11-01 需求）
 *
 * 背景：月度任务（钓鱼 320 次 / 竞技场 240 次）是**账号维度**的常驻任务，
 * 但批量页只在用户主动点「一键钓鱼补齐 / 一键竞技场补齐」时才管它，
 * 于是很多人到月底最后一天才发现没做，任务直接作废。
 *
 * 需求：批量页面在**每个自然月最后一天**打开时，自动连上 roleId 最小的角色，
 * 读一次 `activity_get` 判断月度任务是否完成；未完成则弹一个**强制提醒框**
 * （必须点按钮关闭才能继续操作页面）。
 *
 * 为什么用「roleId 最小的角色」代表整个账号：月度进度由
 * `activity.myMonthInfo` / `activity.myArenaInfo` 下发，不区分角色（同账号
 * 任意角色读到的进度完全一致）。固定取 roleId 最小只是为了让每次检查落在
 * 同一个角色上，不随排序/选择漂移，也方便用户核对。
 *
 * 本模块只放**纯逻辑**（不碰 WSS / store），连接与请求由 BatchDailyTasks.vue
 * 编排，便于 `node --test` 离线覆盖判定边界。
 */

import { ARENA_TARGET, FISH_TARGET } from "./constants.js";

/** 月度钓鱼任务在 myMonthInfo 里的槽位键（2 = 钓鱼，见 tasksArena.js 同口径） */
export const MONTH_END_FISH_SLOT = "2";

/** 把任意值转成安全数字：非有限值一律按 0 处理，避免 NaN 让比较恒为 false */
const toSafeNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

/** 进度值：除 NaN 容错外还要把负数归零（服务端不会下发负数，防的是脏数据） */
const toProgressValue = (value) => {
  const num = toSafeNumber(value);
  return num > 0 ? num : 0;
};

/**
 * 今天是否为本自然月最后一天（本地时区，与页面其它日期判断一致）
 * @param {Date} [date]
 * @returns {boolean}
 */
export function isLastDayOfMonth(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const daysInMonth = new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    0,
  ).getDate();
  return date.getDate() === daysInMonth;
}

/**
 * 取 roleId 最小的角色 token
 *
 * - roleId 可能是字符串（老数据）→ 统一 Number() 后比较
 * - roleId 缺失 / 非法 → 视为 +∞ 排最后
 * - 全部都没有 roleId（手工导入的老 token）→ 退化取列表第一个可用 token，
 *   宁可查一次也不要静默跳过提醒
 *
 * @param {Array<{id?: string, roleId?: string|number, name?: string}>} tokens
 * @returns {object|null}
 */
export function pickLowestRoleIdToken(tokens = []) {
  const list = Array.isArray(tokens) ? tokens : [];
  let best = null;
  let bestRoleId = Number.POSITIVE_INFINITY;

  for (const token of list) {
    if (!token || !token.id) continue;
    const roleId = Number(token.roleId);
    if (Number.isFinite(roleId) && roleId < bestRoleId) {
      best = token;
      bestRoleId = roleId;
    }
  }

  if (best) return best;
  return list.find((token) => token && token.id) || null;
}

/**
 * 从 `activity_get` 响应里取出活动体
 *
 * 现网响应有两种形态（见 tasksArena.js / MonthlyTasksCard.vue 的两种读法）：
 *   { activity: {...} }  或  { body: { activity: {...} } }
 * 直连 store 时拿到的是前者，经某些封装可能是后者。
 *
 * @param {unknown} result
 * @returns {object|null}
 */
export function extractActivityPayload(result) {
  if (!result || typeof result !== "object") return null;
  const direct = result.activity;
  if (direct && typeof direct === "object") return direct;
  const nested = result.body?.activity;
  if (nested && typeof nested === "object") return nested;
  return result;
}

/**
 * 判定月度任务完成情况
 *
 * @param {object|null} activity - activity_get 的活动体
 * @param {{fishTarget?: number, arenaTarget?: number}} [options]
 * @returns {{
 *   valid: boolean,
 *   fishNum: number, fishTarget: number, fishDone: boolean,
 *   arenaNum: number, arenaTarget: number, arenaDone: boolean,
 *   allDone: boolean,
 *   items: Array<{key: string, label: string, num: number, target: number, done: boolean, percent: number}>,
 *   missingItems: Array<object>
 * }}
 */
export function evaluateMonthlyProgress(activity, options = {}) {
  const fishTarget =
    toSafeNumber(options.fishTarget) || toSafeNumber(FISH_TARGET) || 320;
  const arenaTarget =
    toSafeNumber(options.arenaTarget) || toSafeNumber(ARENA_TARGET) || 240;

  const isObject = !!activity && typeof activity === "object";
  const myMonthInfo = isObject ? activity.myMonthInfo : null;
  const myArenaInfo = isObject ? activity.myArenaInfo : null;

  // 两个字段都不在 ⇒ 响应结构不认识（多半是活动未开放 / 服务端换字段）。
  // 这种情况**不算未完成**，否则会误锁用户，交由调用方降级为「不提醒」。
  const valid =
    isObject &&
    ((!!myMonthInfo && typeof myMonthInfo === "object") ||
      (!!myArenaInfo && typeof myArenaInfo === "object"));

  const fishNum = toProgressValue(
    myMonthInfo && typeof myMonthInfo === "object"
      ? myMonthInfo[MONTH_END_FISH_SLOT]?.num
      : 0,
  );
  const arenaNum = toProgressValue(
    myArenaInfo && typeof myArenaInfo === "object" ? myArenaInfo.num : 0,
  );

  const fishDone = fishNum >= fishTarget;
  const arenaDone = arenaNum >= arenaTarget;

  const items = [
    {
      key: "fish",
      label: "月度钓鱼",
      num: fishNum,
      target: fishTarget,
      done: fishDone,
      percent: Math.min(100, Math.round((fishNum / fishTarget) * 100)),
    },
    {
      key: "arena",
      label: "月度竞技场",
      num: arenaNum,
      target: arenaTarget,
      done: arenaDone,
      percent: Math.min(100, Math.round((arenaNum / arenaTarget) * 100)),
    },
  ];

  return {
    valid,
    fishNum,
    fishTarget,
    fishDone,
    arenaNum,
    arenaTarget,
    arenaDone,
    allDone: fishDone && arenaDone,
    items,
    missingItems: items.filter((item) => !item.done),
  };
}
