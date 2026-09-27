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
 *                      4 = 一次性礼包 / 5 = 7 天登录 / 6 = 兑换商店
 *
 *   例：#2026-09-19 期 → 战令 2609191 / 礼包活动 2609194（商品 26091941）/ 签到 2609195 /
 *                        兑换 2609196（商品 260919602）
 *
 * 战令内部 ID = 战令实例 ID + 2 位序号：
 *   01~30 → 每日任务（出现在 `taskClaimed` 里，`complete[id] >= 1` 才可领）
 *   41+   → 战令等级奖励（出现在 `rewardClaimed` 里；本工具暂不处理）
 *
 * ## 玄武灵契（抽奖券 5283）的「领 → 耗 → 再领」闭环（2026-09-25 抓包实证）
 *
 *   activity_lottery { times: N }           → 扣 5283 ×N（**N=10 十连实测可行**）
 *   activity_claimlotterycumulative { id }  → **每档固定 +2 张 5283**（id 11~15 全部 5283×2）+ 5285×5
 *   activity_exchange { activityId, goodsId, quantity } → 消耗 5284 换道具（1023×10）
 *
 * 所以「抽光为止」= 反复 { 抽 → 券尽 → 扫累计奖励补券 → 再抽 }，
 * 其中累计奖励的门槛随 id 递增 → **第一个不可领的 id 之后必然也都不可领，可安全停止**。
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 北京时间相对 UTC 的固定偏移（游戏服务器按北京 00:00 切日，见 dailyTime 字段） */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 活动实例 ID 的功能位（YYMMDD + 该位） */
export const XIAOYAOJIN_SLOTS = Object.freeze({
  warOrder: "1",
  lottery: "2",
  /** 券兑换商店：花 5285「兑换券」买道具（2026-09-25 `xiaoyaojin_redemption.jsonl` 实证） */
  coupon: "3",
  gift: "4",
  sign: "5",
  /** 碎片兑换：花 5284（每 50 抽产出 1 个）换道具（activityId = 2609196） */
  exchange: "6",
});

/**
 * 券兑换商店的两个商品号后缀（= 券活动 ID + 两位序号）
 *
 * 实证：`260919302` = 饼干（单价 5 券，`quantity:8` 一次买 8 个，得 15001×40000）；
 *       `260919303` = 复活丹（单价 3 券，`quantity:1` 买 1 个，得 1017×1）。
 */
export const XIAOYAOJIN_COUPON_COOKIE_SUFFIX = "02";
export const XIAOYAOJIN_COUPON_REVIVE_SUFFIX = "03";

/** 一次性礼包商品号 = 礼包活动 ID + 该序号（2609194 → 26091941） */
export const XIAOYAOJIN_GIFT_GOODS_SUFFIX = "1";

/** 兑换商店商品号 = 兑换活动 ID + 该序号（2609196 → 260919602） */
export const XIAOYAOJIN_EXCHANGE_GOODS_SUFFIX = "02";

/** 抽奖券道具 ID（抓包实证：礼包掉落 5283 ×1，抽奖后 5283 归零） */
export const XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID = 5283;

/**
 * 兑换材料道具 ID（5284）
 *
 * 实证（2026-09-25）：`role.pack[奖池ID][5284]` 与 `lotteryInfo.fragProgress` 同步，**每抽 1 次 +1**；
 * 满 50 归零并把 1 个 5284 发进背包（`num 99/frag 49 → 抽 1 次 → num 100/frag 0，reward 5284×1`）。
 * `activity_exchange` 消耗的就是背包里的 5284（响应里 `role.items["5284"] = null`）。
 */
export const XIAOYAOJIN_EXCHANGE_ITEM_ID = 5284;

/**
 * **兑换券道具 ID（5285）** —— 券兑换商店（功能位 3）的货币
 *
 * 2026-09-25 `xiaoyaojin_redemption.jsonl` 实证（账号 21a @9721）：
 *   43 张券 → 买 8 个饼干（`quantity:8` 一次搞定）→ `5285: 3`（43 − 8×5）
 *           → 再买 1 个复活丹 → `5285: null`（3 − 3 = 0）
 * 来源：抽奖掉落 + 累计抽奖奖励每档 ×5。
 * ⚠️ v1 曾把它标注成「抽奖副产物」，其实是**兑换券**。
 */
export const XIAOYAOJIN_COUPON_ITEM_ID = 5285;

/** 饼干单价（兑换券/个） */
export const XIAOYAOJIN_COOKIE_PRICE = 5;

/** 复活丹单价（兑换券/个） */
export const XIAOYAOJIN_REVIVE_PRICE = 3;

/**
 * 累计抽奖奖励（`activity_claimlotterycumulative`）的 id 扫描上界
 *
 * 已领的 id 能从 `lotteryInfo.cumulativeClaimedMap` 读到；未领的只能逐个试。
 * 本期实证见到 1~15，门槛随 id 递增 → 遇到第一个不可领的 id 即停，不会刷到 30。
 */
export const XIAOYAOJIN_CUMULATIVE_ID_MAX = 30;

/** 「抽光为止」循环的迭代上限（防死循环；正常跑不到） */
export const XIAOYAOJIN_LOTTERY_LOOP_MAX_ROUNDS = 200;

/**
 * 「一键全套」的**外层轮次上限**
 *
 * 为什么需要外层循环（2026-09-25 抓包实证 #105→#127）：
 *   抽奖把 `lotteryNum` 推高 → 战令「累计抽奖次数」档位（序号 50~69）解锁 →
 *   领战令档位奖励 → 战令宝箱又给 5283 → **又有券了，可以再抽** → 再出兑换材料 → 再兑换。
 * 所以「一套」跑完可能又冒出新的可领项，必须再转一轮；零进展才停。
 */
export const XIAOYAOJIN_ALL_ROUNDS_MAX = 3;

/** 单次「抽光为止」最多发多少次兑换请求（防死循环） */
export const XIAOYAOJIN_EXCHANGE_MAX_TIMES = 50;

/**
 * 战令「积分」道具 ID（= master 截图右下角那个数）
 *
 * 实证（2026-09-19）：`role.items[5282].quantity` 与 UI 上看得见的**总积分完全一致**（两账号都是 3100），
 * 每日任务给 +300 / 档位奖励给 +400；`3100 = 3×1000 + 100` ↔ UI 第 4 档进度 `100/1000`。
 * 注意：积分**不在** `warOrderActivityInfo` 里（那 13 个字段没有积分，`itemNum` 恒为 0）→ 只能从背包读。
 */
export const XIAOYAOJIN_POINTS_ITEM_ID = 5282;

/** 每多少积分解锁一档（master：3100 分 → 3 档 + 第 4 档 100/1000） */
export const XIAOYAOJIN_POINTS_PER_TIER = 1000;

/**
 * 档位 → missionId 序号偏移：**档 1 = 序号 47**（missionId = `actId` + (46 + 档号)）
 *
 * 实证：UI 上 3100 分 = **3 档已领**，而抓包里 `taskClaimed` 恰好多出 `147 / 148 / 149` 三个连续 ID
 * → 档1=147、档2=148、档3=149、档4=150（`150` 在 3100 分时未领 = 第 4 档还没到）✓
 * ⚠️ 别把抓包里那 4 次领取全当档位：`141` 属于**另一类**奖励（`complete:4000`，与档位组的 21/1 不同量级），
 * 它是客户端在同一次「领取」里顺带发的第 4 条命令。
 */
export const XIAOYAOJIN_PASS_TIER_OFFSET = 46;

/** 档位号上界（序号到 73 → 档 27；再往上服务端的 `complete` 里没有条目） */
export const XIAOYAOJIN_PASS_TIER_MAX = 27;

/** 积分 → 已解锁（可达）档数：`floor(积分/1000)`；非法/非正数 → 0 */
export function resolvePassTierCount(points) {
  const value = Number(points);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value / XIAOYAOJIN_POINTS_PER_TIER)
    : 0;
}

/** 档号 → missionId（档 1 → `${actId}47`） */
export function resolvePassTierMissionId(actId, tier) {
  const seq = XIAOYAOJIN_PASS_TIER_OFFSET + Number(tier);
  return `${toText(actId)}${String(seq).padStart(2, "0")}`;
}

/**
 * 把「战令档位」读成人类可读的进度摘要（**纯读，不发请求**）
 *
 * @param {object} warOrderInfo `warOrderActivityInfo[actId]`
 * @param {{actId:string, points:number}} options
 * @returns {{points:number|null, reachable:number, tiers:Array<{tier:number,missionId:string,claimed:boolean}>,
 *            claimedTiers:number[], pendingTiers:object[], nextTier:object|null}}
 *
 * 例（真实数据：积分 3100）→ reachable 3、三档全 claimed、nextTier = {tier:4, missionId:'260919150', pointsNeeded:900}
 * 其中 `pointsNeeded = 4×1000 - 3100 = 900` ↔ UI 上「第 4 档 100/1000」
 */
export function describePassTiers(warOrderInfo, options = {}) {
  const actId = toText(options.actId);
  // ⚠️ `Number(null) === 0`：null/undefined/"" 必须视为「读不到积分」，否则会把「未知」显示成「积分 0」
  const rawPoints = options.points;
  const hasPoints =
    rawPoints !== null && rawPoints !== undefined && rawPoints !== "";
  const points =
    hasPoints && Number.isFinite(Number(rawPoints)) ? Number(rawPoints) : null;
  const reachable = points === null ? 0 : resolvePassTierCount(points);
  const reachableSafe = Math.min(reachable, XIAOYAOJIN_PASS_TIER_MAX);

  const { taskClaimed } = readClaimMaps(warOrderInfo);

  const tiers = [];
  for (let tier = 1; tier <= reachableSafe; tier += 1) {
    const missionId = resolvePassTierMissionId(actId, tier);
    tiers.push({ tier, missionId, claimed: taskClaimed[missionId] === true });
  }

  const claimedTiers = tiers
    .filter((item) => item.claimed)
    .map((item) => item.tier);
  const pendingTiers = tiers.filter((item) => !item.claimed);

  let nextTier = null;
  const nextTierNo = reachableSafe + 1;
  if (nextTierNo <= XIAOYAOJIN_PASS_TIER_MAX && points !== null) {
    nextTier = {
      tier: nextTierNo,
      missionId: resolvePassTierMissionId(actId, nextTierNo),
      pointsNeeded: nextTierNo * XIAOYAOJIN_POINTS_PER_TIER - points,
    };
  }

  return { points, reachable, tiers, claimedTiers, pendingTiers, nextTier };
}

/**
 * 活动实例最长存活天数。
 * 一次逍遥津为期 7 天（7 天签到），实例 ID 的日期头 = 开启日，
 * 所以活动期内所有日期头都「过去 N 天」，放宽到 21 天并取最新者即可。
 */
export const XIAOYAOJIN_MAX_ACTIVITY_AGE_DAYS = 21;

/**
 * 逍遥津活动时长（天）。`ageDays >= 7` = 抽奖/战令等玩法已结束，
 * 只剩兑换延时（通常还有 4 小时）→ 全套应自动只跑两个兑换步骤，别再抽奖。
 */
export const XIAOYAOJIN_ACTIVITY_DAYS = 7;

/** 活动结束后（只剩兑换延时）仍要跑的步骤 */
export const XIAOYAOJIN_EXCHANGE_ONLY_STEPS = Object.freeze([
  "exchange",
  "couponExchange",
]);

/**
 * 活动是否已结束（只剩兑换延时）
 * @param {number|null} ageDays `buildXiaoyaojinPlan` 探测出的「开启于 N 天前」
 */
export function isXiaoyaojinEnded(ageDays) {
  const value = Number(ageDays);
  return Number.isFinite(value) && value >= XIAOYAOJIN_ACTIVITY_DAYS;
}

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
 * 3. `exchange`（碎片兑换，花 5284）与 `couponExchange`（券兑换，花 5285）都消耗
 *    **抽奖产出**（5284 每 50 抽 1 个；5285 抽奖掉落 + 累计奖励每档 ×5）
 *    → **都必须排在 `lottery` 之后**，且排在最后。
 */
export const XIAOYAOJIN_ALL_STEPS = Object.freeze([
  "dailyTask",
  "passRewards",
  "passChest",
  "oneTimeGift",
  "signReward",
  "lottery",
  "exchange",
  "couponExchange",
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

/**
 * 日期头往前/往后挪 N 天（`260925` - 6 → `260919`）
 *
 * 用途：**上一期遗留的券要回上一期商店花**。逍遥津两期间隔实测 6 天
 * （260919 开 → 260925 开），自动探测只会拿到最新的那一期，兑换会报
 * 「物品不存在 / 兑换数量超上限」→ 需要能自动回退到更早的期。
 *
 * @param {string} head 6 位 YYMMDD
 * @param {number} days 正数向后、负数向前
 * @returns {string|null}
 */
export function shiftActivityDateHead(head, days) {
  const base = parseActivityDateHead(head);
  const offset = Number(days);
  if (base === null || !Number.isFinite(offset)) return null;
  const utcMidnight = base + BEIJING_OFFSET_MS + Math.trunc(offset) * DAY_MS;
  const date = new Date(utcMidnight);
  const year = date.getUTCFullYear() % 100;
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return `${String(year).padStart(2, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

/**
 * 券兑换找不到能用的商品时，往前回退多少天再试（覆盖「间隔 6 天」和「间隔 7 天」两种排期）
 */
export const XIAOYAOJIN_COUPON_HEAD_FALLBACK_DAYS = Object.freeze([6, 7]);

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
  const { warOrder, lottery, coupon, gift, sign, exchange } = XIAOYAOJIN_SLOTS;

  return {
    head: base,
    warOrderActivityId:
      manual(overrides.warOrderActivityId) || `${base}${warOrder}`,
    lotteryPackId: manual(overrides.lotteryPackId) || `${base}${lottery}`,
    couponActivityId: manual(overrides.couponActivityId) || `${base}${coupon}`,
    couponCookieGoodsId:
      manual(overrides.couponCookieGoodsId) ||
      `${base}${coupon}${XIAOYAOJIN_COUPON_COOKIE_SUFFIX}`,
    couponReviveGoodsId:
      manual(overrides.couponReviveGoodsId) ||
      `${base}${coupon}${XIAOYAOJIN_COUPON_REVIVE_SUFFIX}`,
    giftActivityId: manual(overrides.giftActivityId) || `${base}${gift}`,
    giftGoodsId:
      manual(overrides.giftGoodsId) ||
      `${base}${gift}${XIAOYAOJIN_GIFT_GOODS_SUFFIX}`,
    signActivityId: manual(overrides.signActivityId) || `${base}${sign}`,
    exchangeActivityId:
      manual(overrides.exchangeActivityId) || `${base}${exchange}`,
    exchangeGoodsId:
      manual(overrides.exchangeGoodsId) ||
      `${base}${exchange}${XIAOYAOJIN_EXCHANGE_GOODS_SUFFIX}`,
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
 * 读响应里的道具数量（`body.role.items[itemId].quantity`）
 *
 * ⚠️ 三个坑（都踩过）：
 * - `Number(null) === 0` → 「读不到」必须返回 `null`，不能返回 0（会把未知当成「没有券」而跳过抽奖）
 * - **键存在且值为 `null` = 归零**（2026-09-25 实证：券抽光时 `items["5283"] = null`，
 *   兑换材料用光时 `items["5284"] = null`）→ 这种情况必须返回 **0**，不是「未知」
 * - **键不存在** = 服务端这次没报告这个道具（BON 省略未变化字段）→ 返回 `null`
 *
 * 兼容 `role` / `body.role` / `data.role` 三种形态。
 *
 * @returns {number|null}
 */
export function readItemQuantity(response, itemId) {
  if (!response || typeof response !== "object") return null;
  const candidates = [
    response.role,
    response.data?.role,
    response.body?.role,
    response.body?.data?.role,
    response.role?.role,
  ];
  const key = String(itemId);
  for (const role of candidates) {
    if (!role || typeof role !== "object") continue;
    const items = role.items;
    if (!items || typeof items !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(items, key)) continue;

    const entry = items[key];
    // 显式 null = 该道具已归零（patch 语义里的「删除」）
    if (entry === null || entry === undefined) return 0;
    const raw = entry && typeof entry === "object" ? entry.quantity : entry;
    if (raw === null || raw === undefined || raw === "") return 0;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }
  return null; // 键不存在 = 未知
}

/**
 * 读响应 `body.reward[]` 里某道具的**总数量**（抽奖/领取都用它算「这次拿到了多少券」）
 * @returns {number} 没有该道具 → 0
 */
export function readRewardQuantity(response, itemId) {
  if (!response || typeof response !== "object") return 0;
  const lists = [response.reward, response.body?.reward, response.data?.reward];
  let total = 0;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      if (String(item.itemId) !== String(itemId)) continue;
      const value = Number(item.value ?? item.num ?? item.quantity);
      if (Number.isFinite(value)) total += value;
    }
  }
  return total;
}

/**
 * 从各类响应里取 `lotteryInfo`
 * （`Activity_GetLotteryInfoResp` 与 `Activity_LotteryResp` 都带，键就在 `body.lotteryInfo`）
 */
export function pickLotteryInfo(response) {
  if (!response || typeof response !== "object") return null;
  const candidates = [
    response.lotteryInfo,
    response.data?.lotteryInfo,
    response.body?.lotteryInfo,
    response.body?.data?.lotteryInfo,
  ];
  for (const info of candidates) {
    if (info && typeof info === "object") return info;
  }
  return null;
}

/**
 * 已领取的累计抽奖奖励 id 集合（`lotteryInfo.cumulativeClaimedMap`）
 *
 * 实证：`{"1":true,…,"10":true}` = 前 10 档已领；`activity_claimlotterycumulative`
 * 的响应只回**本次领的那一个** id（`{"11":true}`）→ 调用方必须自己累积，不能拿新响应覆盖。
 *
 * @returns {Set<number>}
 */
export function readCumulativeClaimed(lotteryInfo) {
  const info = lotteryInfo && typeof lotteryInfo === "object" ? lotteryInfo : {};
  const map =
    info.cumulativeClaimedMap && typeof info.cumulativeClaimedMap === "object"
      ? info.cumulativeClaimedMap
      : {};
  const claimed = new Set();
  for (const key of Object.keys(map)) {
    const id = Number(key);
    if (Number.isFinite(id) && map[key] === true) claimed.add(Math.trunc(id));
  }
  return claimed;
}

/**
 * 待尝试领取的累计抽奖奖励 id（升序，跳过已领）
 *
 * 门槛随 id 递增 → 调用方在**第一个失败**的 id 上停即可（后面的必然也不可领）。
 *
 * @param {object|null} lotteryInfo
 * @param {Set<number>} [claimed] 会话内自己累积的已领集合（会与 `cumulativeClaimedMap` 取并集）
 * @param {{max?:number}} [options]
 * @returns {number[]}
 */
export function listPendingCumulativeIds(lotteryInfo, claimed, options = {}) {
  const fromServer = readCumulativeClaimed(lotteryInfo);
  const merged = new Set(fromServer);
  if (claimed instanceof Set) {
    claimed.forEach((id) => merged.add(id));
  }
  const max = Number.isFinite(Number(options.max))
    ? Math.trunc(Number(options.max))
    : XIAOYAOJIN_CUMULATIVE_ID_MAX;
  const ids = [];
  for (let id = 1; id <= max; id += 1) {
    if (!merged.has(id)) ids.push(id);
  }
  return ids;
}

/**
 * 把「券余额」拆成一串抽奖批次 —— **十连优先**
 *
 * 实证：`activity_lottery {times:10}` 一次扣 10 张（40→30→20→10→0），与抓包逐字节一致。
 *
 * @param {number|null|undefined} ticketCount 券余额；`null/undefined/""` = 未知
 * @param {{perBatch?:number}} [options] 每批张数（1~10，默认 10）
 * @returns {{batches:number[], tickets:number|null}}
 *          余额未知时给一批 `perBatch`（由服务端裁定，循环靠响应里的余额变化收敛）
 */
export function planLotteryBatches(ticketCount, options = {}) {
  const per = Math.min(
    XIAOYAOJIN_MAX_DRAWS,
    Math.max(1, Math.trunc(Number(options.perBatch) || XIAOYAOJIN_MAX_DRAWS)),
  );

  const raw = ticketCount;
  const hasValue = raw !== null && raw !== undefined && raw !== "";
  const tickets =
    hasValue && Number.isFinite(Number(raw))
      ? Math.max(0, Math.trunc(Number(raw)))
      : null;

  if (tickets === null) return { batches: [per], tickets: null };
  if (tickets <= 0) return { batches: [], tickets };

  const batches = [];
  for (let left = tickets; left > 0; left -= per) {
    batches.push(Math.min(per, left));
  }
  return { batches, tickets };
}

/**
 * 券兑换商店的购买方案：**先尽量多买饼干，余券够 3 就再换 1 个复活丹**
 *
 * 实证（43 张券）：43 ÷ 5 = **8 个饼干**（花 40）→ 余 3 ≥ 3 → **1 个复活丹**（花 3）→ 余 0。
 *
 * ⚠️ `quantity` 支持一次买多个（抓包 `quantity:8` 一次买 8 个饼干）→ 饼干**一条请求发完**，
 * 不用逐个买。复活丹固定 1 个（master 口径：只换一个）。
 *
 * @param {number|null|undefined} ticketCount 兑换券（5285）余额
 * @returns {{tickets:number|null, cookies:number, cookieCost:number,
 *            remaining:number|null, revive:number, reviveCost:number}}
 *          余额未知（null）→ cookies/revive 都是 0（**不能瞎买**）
 */
export function planCouponPurchase(ticketCount) {
  const raw = ticketCount;
  const hasValue = raw !== null && raw !== undefined && raw !== "";
  const tickets =
    hasValue && Number.isFinite(Number(raw))
      ? Math.max(0, Math.trunc(Number(raw)))
      : null;

  if (tickets === null) {
    return {
      tickets: null,
      cookies: 0,
      cookieCost: 0,
      remaining: null,
      revive: 0,
      reviveCost: 0,
    };
  }

  const cookies = Math.floor(tickets / XIAOYAOJIN_COOKIE_PRICE);
  const cookieCost = cookies * XIAOYAOJIN_COOKIE_PRICE;
  const remaining = tickets - cookieCost;
  const revive =
    remaining >= XIAOYAOJIN_REVIVE_PRICE ? 1 : 0;

  return {
    tickets,
    cookies,
    cookieCost,
    remaining,
    revive,
    reviveCost: revive * XIAOYAOJIN_REVIVE_PRICE,
  };
}

/**
 * 兑换次数：有多少 5284 换多少次
 *
 * @param {number|null|undefined} fragCount
 * @returns {number|null} null = 读不到余额（调用方按 1 次试探）
 */
export function resolveExchangeTimes(fragCount) {
  const raw = fragCount;
  const hasValue = raw !== null && raw !== undefined && raw !== "";
  if (!hasValue || !Number.isFinite(Number(raw))) return null;
  const value = Math.max(0, Math.trunc(Number(raw)));
  return Math.min(value, XIAOYAOJIN_EXCHANGE_MAX_TIMES);
}

/**
 * 抽奖状态人类可读摘要（纯读，用于日志）
 * @returns {{draws:number|null, frag:number|null, claimedCumulative:number[], pendingCumulative:number}}
 */
export function summarizeLottery(lotteryInfo, claimed) {
  const info = lotteryInfo && typeof lotteryInfo === "object" ? lotteryInfo : {};
  const num = Number(info.lotteryNum);
  const frag = Number(info.fragProgress);
  const fromServer = readCumulativeClaimed(info);
  const merged = new Set(fromServer);
  if (claimed instanceof Set) claimed.forEach((id) => merged.add(id));
  return {
    draws: Number.isFinite(num) ? num : null,
    frag: Number.isFinite(frag) ? frag : null,
    claimedCumulative: [...merged].sort((a, b) => a - b),
    pendingCumulative: listPendingCumulativeIds(info, claimed).length,
  };
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

  /**
   * ⚠️ 兜底：活动结束后 `warOrderActivityInfo` 会被服务端清掉（战令数据没了），
   * 但 **`commonActivityInfo` 里券兑换(…3)/礼包(…4)/签到(…5)/碎片兑换(…6) 的键还在**。
   *
   * 实证（2026-09-26 00:44 `xiaoyaojin_redemption1.jsonl`）：兑换延时期内
   * `activity_exchange` 仍然成功（响应回 `commonActivityInfo["2609193"]`），
   * 但 `activity_get` 已经拿不到战令实例 → 旧实现直接判「未找到活动实例」而跳过兑换。
   * → 日期头可以从 `commonActivityInfo` 的 7 位键反推（同一套 YYMMDD+功能位 规则）。
   */
  const detectedCommon = detected
    ? null
    : resolveXiaoyaojinActivityId(commonActivityInfo, {
        now,
        maxAgeDays: options.maxAgeDays,
      });

  /**
   * ⚠️ 手工填的日期头**优先级最高**。
   *
   * 实证（2026-09-26 00:52）：上一期（260919）的兑换延时还剩几小时，但新一期（260925）
   * 已经开了 → `commonActivityInfo` 里两期的键都有，而「取日期头最大者」会选中**新一期**，
   * 于是券被拿去换新一期的商品 → `兑换数量超上限`（新一期限购更严）。
   * 用户手工填 `260919` 就是「我要花上一期的券」这一明确意图，必须压过自动探测。
   */
  const headFromManual =
    getActivityDateHead(manualWarOrderId) ||
    (toText(overrides.head).length === 6 ? toText(overrides.head) : null);
  const head = headFromManual || detected?.head || detectedCommon?.head;

  if (!head) {
    return {
      ok: false,
      reason: manualWarOrderId
        ? `活动实例 ${manualWarOrderId} 不是 YYMMDD+功能位 形式，且未手工指定日期头`
        : "未在 warOrderActivityInfo / commonActivityInfo 中找到逍遥津活动实例（活动可能未开启或已结束）；可手工填「活动日期头」",
    };
  }

  const ids = deriveXiaoyaojinIds(head, overrides);
  // 探测到日期头后，战令 ID 也随之派生（战令数据可能已被清空，但 ID 规则不变）
  const warOrderActivityId = manualWarOrderId || ids.warOrderActivityId;
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

  const ageDays = detected?.ageDays ?? detectedCommon?.ageDays ?? null;

  return {
    ok: true,
    source: headFromManual
      ? "manual"
      : detected
        ? "auto"
        : "common",
    head,
    ageDays,
    /**
     * 活动是否已结束（只剩兑换延时）
     * 判据二选一：① 开启日已过 ≥7 天 ② **战令数据已被服务端清掉**
     * —— 第 ② 条是关键：活动结束后 warOrderActivityInfo 里就没这个实例了。
     */
    ended: isXiaoyaojinEnded(ageDays) || !warOrderInfo,
    warOrderActivityId,
    ids,
    warOrderInfo,
    dailyClaims: listPendingDailyClaims(warOrderInfo),
    passRewards: summarizePassRewards(warOrderInfo),
    // commonActivityInfo 是服务端推送的状态分片；键存在即为「该派生 ID 正确」的强证据
    commonConfirmed: {
      gift: commonKeys.includes(ids.giftActivityId),
      sign: commonKeys.includes(ids.signActivityId),
      exchange: commonKeys.includes(ids.exchangeActivityId),
      coupon: commonKeys.includes(ids.couponActivityId),
      /** 一次性礼包本期是否已领（服务端 record 里已有该商品记录） */
      giftBought: Number(giftRecord[ids.giftGoodsId]) >= 1,
      /** 7 天登录已记录的日期序号（1 起） */
      signDays: recordDays(signRecord),
      /**
       * 兑换商店本期已兑换次数（`commonActivityInfo[兑换活动ID].record[goodsId]`）
       * 实证：连换两次 → 1 → 2。仅作日志佐证，兑换次数由背包 5284 余额决定。
       */
      exchangeTimes: Number(
        (commonActivityInfo[ids.exchangeActivityId]?.record || {})[
          ids.exchangeGoodsId
        ],
      ) || 0,
      keys: commonKeys,
    },
  };
}

export default {
  XIAOYAOJIN_SLOTS,
  XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID,
  XIAOYAOJIN_COUPON_ITEM_ID,
  XIAOYAOJIN_EXCHANGE_ITEM_ID,
  buildXiaoyaojinPlan,
  deriveXiaoyaojinIds,
  getActivityDateHead,
  isDailyMissionId,
  isXiaoyaojinEnded,
  listPendingCumulativeIds,
  listPendingDailyClaims,
  pickLotteryInfo,
  planCouponPurchase,
  planLotteryBatches,
  readCumulativeClaimed,
  readItemQuantity,
  readRewardQuantity,
  resolveExchangeTimes,
  shiftActivityDateHead,
  resolveLotteryDraws,
  resolveXiaoyaojinActivityId,
  summarizeLottery,
  summarizePassRewards,
};
