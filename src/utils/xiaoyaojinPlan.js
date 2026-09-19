/**
 * 逍遥津（限时临时活动）纯逻辑：活动实例探测 + 奖励清单推导
 *
 * ⚠️ 本模块只做「解析与推导」，不做任何网络请求，可被 node --test 直接导入。
 *
 * 协议结论来自 2026-09-18 抓包（`local-data/xiaoyaojin/xyzw-runtime-wss-*.jsonl`，
 * `verify_roundtrip.mjs --dir send` 实测 15/15 逐字节精确复现，0 失败）：
 *
 *   activity_get {}                                  → Activity_GetResp（根在 body.activity）
 *   activity_warorderget { actId }                    → Activity_WarOrderGetResp（战令状态）
 *   activity_warordertaskclaim { actId, missionId }   → Activity_WarOrderClaimResp（每日任务奖励）
 *   activity_commonbuygoods { goodsId }               → SyncRewardResp（一次性礼包，免费）
 *   activity_claimsignreward { activityId, patchDay }  → Activity_RewardResp（7 天登录）
 *   activity_getlotteryinfo {}                        → Activity_GetLotteryInfoResp
 *   activity_lottery { times }                        → Activity_LotteryResp（消耗抽奖券 5283 ×times）
 *
 * 活动实例 ID 规则（同一期全服一致、跨账号一致；详见 docs/xiaoyaojin-activity-protocol.md）：
 *
 *   YYMMDD + 功能位    1 = 战令（= warOrderActivityInfo 的键）/ 2 = 抽奖奖池 pack /
 *                      4 = 一次性礼包 / 5 = 7 天登录
 *
 *   例：#2026-09-19 期 → 战令 2609191 / 礼包活动 2609194（商品 26091941）/ 签到 2609195
 *
 * 战令内部 ID = 战令实例 ID + 2 位序号：
 *   01~30 → 每日任务（出现在 `taskClaimed` 里，`complete[id] >= 1` 才可领）
 *   41+   → 战令等级奖励（出现在 `rewardClaimed` 里；本工具暂不处理）
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 北京时间相对 UTC 的固定偏移（游戏服务器按北京 00:00 切日，见 dailyTime 字段） */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 活动实例 ID 的功能位（YYMMDD + 该位） */
export const XIAOYAOJIN_SLOTS = Object.freeze({
  warOrder: "1",
  lottery: "2",
  gift: "4",
  sign: "5",
});

/** 一次性礼包商品号 = 礼包活动 ID + 该序号（2609194 → 26091941） */
export const XIAOYAOJIN_GIFT_GOODS_SUFFIX = "1";

/** 抽奖券道具 ID（抓包实证：礼包掉落 5283 ×1，抽奖后 5283 归零） */
export const XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID = 5283;

/**
 * 战令「积分」道具 ID（master 截图右下角那个数）
 *
 * ⚠️ **结论已修正（2026-09-19 16:57）**：不能用它算档数来自动筛选候选。
 * - 两份抓包里 `role.items[5282]` **都是 3100**（每日任务 +300 / 档位奖励 +400 给的道具）
 * - 但**两个账号各领了 4 个档位奖励**（`141/147/148/149`）→ 若积分真是 3100 就只能领 3 档 → 自相矛盾
 * - 说明 **5282 ≠ 档位积分解锁口径**（它只是奖励物品），或「领取」不只领档位
 * → 该常量仅用于**日志展示**，**绝不用于筛选候选**（筛选一律用 `complete > 0 && !taskClaimed` + 服务端裁定）
 */
export const XIAOYAOJIN_POINTS_ITEM_ID = 5282;

/** 每多少积分解锁一档（master 口述：3100 分 → 3 档 + 第 4 档 100/1000）——仅供日志估算 */
export const XIAOYAOJIN_POINTS_PER_TIER = 1000;

/**
 * 积分 → 已解锁档数（`floor(积分/1000)`；非法/非正数 → 0）。**仅用于日志/估算，不用于筛选候选。**
 */
export function resolvePassTierCount(points) {
  const value = Number(points);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value / XIAOYAOJIN_POINTS_PER_TIER)
    : 0;
}

/**
 * 活动实例最长存活天数。
 * 一次逍遥津为期 7 天（7 天签到），实例 ID 的日期头 = 开启日，
 * 所以活动期内所有日期头都「过去 N 天」，放宽到 21 天并取最新者即可。
 */
export const XIAOYAOJIN_MAX_ACTIVITY_AGE_DAYS = 21;

/** 每日任务序号上界（01~30 为每日任务，41+ 为战令等级奖励） */
export const XIAOYAOJIN_DAILY_MISSION_SUFFIX_MAX = 30;

export const XIAOYAOJIN_DEFAULT_DRAWS = 1;
export const XIAOYAOJIN_MAX_DRAWS = 10;

/**
 * 「一键全套」的步骤顺序 —— ⚠️ **这是协议约束，不是偏好，别顺手调换**
 *
 * 1. `passRewards`（逐个领战令等级奖励）**必须在** `passChest` 之前：
 *    一键宝箱 `activity_warorderrewardclaim` 的可领集合**取决于等级奖励是否已领**。
 *    09-19 两份抓包对比实证 —— 账号A「先宝箱后等级」需要调两次才拿全（1221 → 1222/1223），
 *    账号B「先等级后宝箱」一次就拿全 1221+1222+1223。
 * 2. `oneTimeGift`（礼包）与 `passChest`（宝箱）都产抽奖券 5283，**都必须在 `lottery` 之前**。
 */
export const XIAOYAOJIN_ALL_STEPS = Object.freeze([
  "dailyTask",
  "passRewards",
  "passChest",
  "oneTimeGift",
  "signReward",
  "lottery",
]);

const toText = (value) =>
  value === null || value === undefined ? "" : String(value).trim();

/**
 * 取活动实例 ID 的 6 位日期头（`2609191` → `260919`）；不是 7 位纯数字则返回 null
 */
export function getActivityDateHead(activityId) {
  const text = toText(activityId);
  return /^\d{7}$/.test(text) ? text.slice(0, 6) : null;
}

/**
 * 解析 YYMMDD 日期头为该日「北京 00:00」的绝对毫秒时间戳；非法返回 null。
 * 全部用 UTC 数学计算，结果与运行机器的时区无关。
 */
export function parseActivityDateHead(head) {
  const text = toText(head);
  if (!/^\d{6}$/.test(text)) return null;

  const year = 2000 + Number(text.slice(0, 2));
  const month = Number(text.slice(2, 4));
  const day = Number(text.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const utcMidnight = Date.UTC(year, month - 1, day);
  const check = new Date(utcMidnight);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    // 2 月 30 日这类会被 Date.UTC 顺延的非法日期
    return null;
  }
  return utcMidnight - BEIJING_OFFSET_MS;
}

/** 某时刻所属「北京自然日」的起点毫秒时间戳 */
export function beijingDayStart(now) {
  const value = Number(now);
  if (!Number.isFinite(value)) return null;
  return (
    Math.floor((value + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS
  );
}

/** 活动实例 ID 的 2 位序号（`260919101` → 1） */
export function getMissionSuffix(missionId) {
  const text = toText(missionId);
  return /^\d{3,}$/.test(text) ? Number(text.slice(-2)) : null;
}

/** 是否逍遥津「每日任务」（序号 01~30），与战令等级奖励（41+）区分 */
export function isDailyMissionId(missionId) {
  const suffix = getMissionSuffix(missionId);
  return suffix !== null && suffix >= 1 && suffix <= XIAOYAOJIN_DAILY_MISSION_SUFFIX_MAX;
}

/**
 * 从 `warOrderActivityInfo` 的键里挑出最可能属于「当前这一期」的逍遥津战令实例。
 *
 * 战令表里可能混着其它战令实例（历史上出现过 `1` / `1003` 等非 YYMMDD 形式的键），
 * 因此只接受 7 位纯数字、且日期头落在 [今天-21 天, 今天+1 天] 窗口内的键，取日期头最大者。
 *
 * @returns {{activityId:string, head:string, ageDays:number, startedAtMs:number}|null}
 */
export function resolveXiaoyaojinActivityId(warOrderActivityInfo, options = {}) {
  if (!warOrderActivityInfo || typeof warOrderActivityInfo !== "object") {
    return null;
  }
  const now = Number(options.now ?? Date.now());
  const today = beijingDayStart(Number.isFinite(now) ? now : Date.now());
  if (today === null) return null;

  const maxAgeDays = Number.isFinite(Number(options.maxAgeDays))
    ? Number(options.maxAgeDays)
    : XIAOYAOJIN_MAX_ACTIVITY_AGE_DAYS;

  let best = null;
  for (const key of Object.keys(warOrderActivityInfo)) {
    const head = getActivityDateHead(key);
    if (!head) continue;

    const startedAtMs = parseActivityDateHead(head);
    if (startedAtMs === null) continue;

    const ageDays = Math.round((today - startedAtMs) / DAY_MS);
    if (ageDays < -1 || ageDays > maxAgeDays) continue;

    const entry = warOrderActivityInfo[key];
    if (!entry || typeof entry !== "object") continue;

    if (!best || head > best.head) {
      best = { activityId: key, head, ageDays, startedAtMs };
    }
  }
  return best;
}

/**
 * 由日期头派生同族活动 ID（可用 overrides 逐项覆盖，供界面手工兜底）
 */
export function deriveXiaoyaojinIds(head, overrides = {}) {
  const base = toText(head);
  const manual = (value) => toText(value) || null;
  const { warOrder, lottery, gift, sign } = XIAOYAOJIN_SLOTS;

  return {
    head: base,
    warOrderActivityId:
      manual(overrides.warOrderActivityId) || `${base}${warOrder}`,
    lotteryPackId: manual(overrides.lotteryPackId) || `${base}${lottery}`,
    giftActivityId: manual(overrides.giftActivityId) || `${base}${gift}`,
    giftGoodsId:
      manual(overrides.giftGoodsId) ||
      `${base}${gift}${XIAOYAOJIN_GIFT_GOODS_SUFFIX}`,
    signActivityId: manual(overrides.signActivityId) || `${base}${sign}`,
  };
}

/**
 * 从 activity_get 的返回值里取出「活动根对象」。
 * 兼容 Promise 解析出的裸 body（`{ activity: {...} }`）与已取出的根对象两种形态。
 */
export function pickActivityRoot(response) {
  if (!response || typeof response !== "object") return null;
  const candidates = [
    response.activity,
    response.data?.activity,
    response.body?.activity,
    response,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    if (
      candidate.warOrderActivityInfo ||
      candidate.commonActivityInfo ||
      Array.isArray(candidate.activity)
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * 列出「待领取」的每日任务（含未达成项，调用方按 completed 自行过滤）
 *
 * ⚠️ `complete[missionId]` 是**进度数值**而不是布尔标记（实测 `101:41 / 103:3 / 104:13 / 105:2 / 106:3`，
 * 未达成的 `102:0`）→ 用 `> 0` 判「有进度」。真正的「是否达标」由服务端裁定
 * （未达成会返回 `700010 任务未达成完成条件`，按 info 跳过即可），本地不猜阈值。
 *
 * @returns {Array<{missionId:string, completed:boolean, claimed:boolean}>}
 */
export function listPendingDailyClaims(warOrderInfo) {
  const { complete, taskClaimed } = readClaimMaps(warOrderInfo);

  const missionIds = new Set();
  Object.keys(taskClaimed).forEach((id) => missionIds.add(id));
  Object.keys(complete).forEach((id) => {
    if (isDailyMissionId(id)) missionIds.add(id);
  });

  return [...missionIds]
    .filter(isDailyMissionId)
    .sort()
    .map((missionId) => ({
      missionId,
      completed: Number(complete[missionId]) > 0,
      claimed: taskClaimed[missionId] === true,
    }))
    .filter((item) => !item.claimed);
}

/** 战令内部 ID：9 位 = 7 位活动实例 ID + 2 位序号 */
const PASS_MISSION_ID_RE = /^\d{9}$/;

const readClaimMaps = (warOrderInfo) => {
  const info = warOrderInfo && typeof warOrderInfo === "object" ? warOrderInfo : {};
  return {
    complete:
      info.complete && typeof info.complete === "object" ? info.complete : {},
    taskClaimed:
      info.taskClaimed && typeof info.taskClaimed === "object"
        ? info.taskClaimed
        : {},
  };
};

/**
 * 列出「待领取」的战令等级奖励（序号 41+，与每日任务共用 `taskClaimed` 字段）
 *
 * ⚠️ 判定「已领」必须看 **`taskClaimed`**，不能看 `rewardClaimed` ——
 * `rewardClaimed` 是**另一套奖励**（4 位奖励 ID，如 `{"1221":1,"1222":1}`，
 * 由 `activity_warorderrewardclaim` 一键领取），与 `complete` 里的 9 位 missionId 完全不对应。
 * v1 曾用 `rewardClaimed` 判定 → 会把 `141`（`complete:4000` 且 `taskClaimed:true`）误算成「可领」。
 *
 * @returns {string[]} 待尝试领取的 missionId（升序）
 */
export function listPendingPassRewards(warOrderInfo) {
  const { complete, taskClaimed } = readClaimMaps(warOrderInfo);

  return Object.keys(complete)
    .filter(
      (id) => PASS_MISSION_ID_RE.test(id) && !isDailyMissionId(id),
    )
    .filter((id) => Number(complete[id]) > 0)
    .filter((id) => taskClaimed[id] !== true)
    .sort();
}

/**
 * 战令等级奖励统计（total = 全部等级条目；unlocked = complete>0；pending = 未领取）
 */
export function summarizePassRewards(warOrderInfo) {
  const { complete } = readClaimMaps(warOrderInfo);
  const pendingIds = listPendingPassRewards(warOrderInfo);
  const ids = Object.keys(complete).filter(
    (id) => PASS_MISSION_ID_RE.test(id) && !isDailyMissionId(id),
  );

  return {
    total: ids.length,
    unlocked: ids.filter((id) => Number(complete[id]) > 0).length,
    pending: pendingIds.length,
    pendingIds,
  };
}

/**
 * 抽奖次数：受「配置次数」与「抽奖券余额」双重约束
 * @returns {{draws:number, tickets:number|null, cappedByTickets:boolean}}
 */
export function resolveLotteryDraws(options = {}) {
  const requested = Number(options.requested);
  const want = Number.isFinite(requested)
    ? Math.min(
        XIAOYAOJIN_MAX_DRAWS,
        Math.max(1, Math.trunc(requested)),
      )
    : XIAOYAOJIN_DEFAULT_DRAWS;

  const rawTickets = options.ticketCount;
  // ⚠️ null / undefined / "" 必须视为「读不到余额」，不能走 Number() 变成 0（否则会误判成零券而跳过抽奖）
  const hasTicketValue =
    rawTickets !== null && rawTickets !== undefined && rawTickets !== "";
  const tickets = hasTicketValue && Number.isFinite(Number(rawTickets))
    ? Math.max(0, Math.trunc(Number(rawTickets)))
    : null;

  if (tickets === null) {
    // 读不到背包时不拦（服务端没券会直接拒绝，循环遇到失败即停）
    return { draws: want, tickets: null, cappedByTickets: false };
  }
  return { draws: Math.min(want, tickets), tickets, cappedByTickets: want > tickets };
}

/**
 * 汇总 activity_get → 逍遥津执行计划
 *
 * @param {object} response  activity_get 的 Promise 返回值
 * @param {object} [options]
 * @param {number} [options.now]           当前时间戳（测试注入）
 * @param {object} [options.overrides]     手工覆盖的 ID（warOrderActivityId / giftGoodsId / signActivityId …）
 * @param {number} [options.maxAgeDays]    活动实例最大存活天数
 * @returns {{ok:boolean, reason?:string, ...}}
 */
export function buildXiaoyaojinPlan(response, options = {}) {
  const now = Number.isFinite(Number(options.now))
    ? Number(options.now)
    : Date.now();
  const overrides =
    options.overrides && typeof options.overrides === "object"
      ? options.overrides
      : {};

  const root = pickActivityRoot(response);
  if (!root) {
    return { ok: false, reason: "未取到活动数据（activity_get 返回异常）" };
  }

  const warOrderActivityInfo =
    root.warOrderActivityInfo && typeof root.warOrderActivityInfo === "object"
      ? root.warOrderActivityInfo
      : {};
  const commonActivityInfo =
    root.commonActivityInfo && typeof root.commonActivityInfo === "object"
      ? root.commonActivityInfo
      : {};

  const manualWarOrderId = toText(overrides.warOrderActivityId) || null;
  const detected = resolveXiaoyaojinActivityId(warOrderActivityInfo, {
    now,
    maxAgeDays: options.maxAgeDays,
  });

  const warOrderActivityId = manualWarOrderId || detected?.activityId || null;
  const head =
    getActivityDateHead(warOrderActivityId) ||
    (toText(overrides.head).length === 6 ? toText(overrides.head) : null);

  if (!head) {
    return {
      ok: false,
      reason: warOrderActivityId
        ? `活动实例 ${warOrderActivityId} 不是 YYMMDD+功能位 形式，且未手工指定签到/礼包 ID`
        : "未在 warOrderActivityInfo 中找到逍遥津活动实例（活动可能未开启或已结束）",
    };
  }

  const ids = deriveXiaoyaojinIds(head, overrides);
  const warOrderInfo = warOrderActivityInfo[warOrderActivityId] || null;
  const commonKeys = Object.keys(commonActivityInfo);

  // ⚠️ commonActivityInfo 的**外层键是活动实例 ID**（2609194 / 2609195），
  // goodsId(26091941) 只是礼包活动自己 record 里的内层键 —— 别拿 goodsId 去查外层，
  // 实测抓包结构：{"2609194": {"record": {"26091941": 1}, "task": {}, "isBought": false}}
  const giftRecord = commonActivityInfo[ids.giftActivityId]?.record || {};
  const signRecord = commonActivityInfo[ids.signActivityId]?.record || {};
  const recordDays = (record) =>
    Object.keys(record || {})
      .map((key) => Number(key))
      .filter((value) => Number.isFinite(value));

  return {
    ok: true,
    source: manualWarOrderId ? "manual" : "auto",
    head,
    ageDays: detected?.ageDays ?? null,
    warOrderActivityId,
    ids,
    warOrderInfo,
    dailyClaims: listPendingDailyClaims(warOrderInfo),
    passRewards: summarizePassRewards(warOrderInfo),
    // commonActivityInfo 是服务端推送的状态分片；键存在即为「该派生 ID 正确」的强证据
    commonConfirmed: {
      gift: commonKeys.includes(ids.giftActivityId),
      sign: commonKeys.includes(ids.signActivityId),
      /** 一次性礼包本期是否已领（服务端 record 里已有该商品记录） */
      giftBought: Number(giftRecord[ids.giftGoodsId]) >= 1,
      /** 7 天登录已记录的日期序号（1 起） */
      signDays: recordDays(signRecord),
      keys: commonKeys,
    },
  };
}

export default {
  XIAOYAOJIN_SLOTS,
  XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID,
  buildXiaoyaojinPlan,
  deriveXiaoyaojinIds,
  getActivityDateHead,
  isDailyMissionId,
  listPendingDailyClaims,
  resolveLotteryDraws,
  resolveXiaoyaojinActivityId,
  summarizePassRewards,
};
