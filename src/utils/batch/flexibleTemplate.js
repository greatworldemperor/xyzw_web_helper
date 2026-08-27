import { normalizeSkinChallengeTargets } from "./skinChallengeUtils.js";

export const FLEXIBLE_TEMPLATE_STORAGE_KEY = "flexible-task-templates";
export const FLEXIBLE_TEMPLATE_VERSION = 1;

const dailyTask = (value, label) => ({ value, label, kind: "daily" });
const batchTask = (value, label, options = {}) => ({
  value,
  label,
  kind: "batch",
  handler: value,
  ...options,
});

export const flexibleTaskGroups = [
  {
    name: "daily",
    label: "完整日常",
    tasks: [
      dailyTask("daily.share", "分享一次游戏"),
      dailyTask("daily.friendGold", "赠送好友金币"),
      dailyTask("daily.freeRecruit", "免费招募"),
      dailyTask("daily.paidRecruit", "付费招募"),
      dailyTask("daily.freeGold", "免费点金3次"),
      dailyTask("daily.claimHangUp", "领取挂机并加钟"),
      dailyTask("daily.openBox", "开启木质宝箱10个"),
      dailyTask("daily.resetBottleTimer", "重置盐罐计时"),
      dailyTask("daily.claimBottle", "领取盐罐奖励"),
      dailyTask("daily.arena", "竞技场战斗3次"),
      dailyTask("daily.legionBoss", "军团BOSS"),
      dailyTask("daily.dailyBoss", "每日BOSS3次"),
      dailyTask("daily.welfareSignIn", "福利签到"),
      dailyTask("daily.clubSignIn", "俱乐部签到"),
      dailyTask("daily.discountGift", "领取每日礼包"),
      dailyTask("daily.freeCardGift", "领取免费礼包"),
      dailyTask("daily.permanentCardGift", "领取永久卡礼包"),
      dailyTask("daily.claimEmail", "领取邮件奖励"),
      dailyTask("daily.collectionGift", "领取珍宝阁礼包"),
      dailyTask("daily.freeGacha", "免费扭蛋"),
      dailyTask("daily.freeFishing", "免费钓鱼3次"),
      dailyTask("daily.genieSweep", "四国灯神免费扫荡"),
      dailyTask("daily.freeGenieTickets", "领取免费扫荡券3次"),
      dailyTask("daily.blackMarket", "黑市采购"),
      dailyTask("daily.dream", "咸王梦境（选择阵容）"),
      dailyTask("daily.deepSeaGenie", "深海灯神免费扫荡"),
      dailyTask("daily.restoreFormation", "还原初始阵容"),
      dailyTask("daily.dailyRewards", "领取每日任务积分及完成奖励"),
      dailyTask("daily.weeklyReward", "领取周常任务奖励"),
      dailyTask("daily.passReward", "领取通行证奖励"),
      batchTask("batchStudy", "一键答题"),
      batchTask("batchSmartSendCar", "智能发车"),
      batchTask("batchClaimCars", "一键收车"),
    ],
  },
  {
    name: "dungeon",
    label: "副本",
    tasks: [
      batchTask("climbTower", "一键爬塔"),
      batchTask("skinChallenge", "一键换皮闯关"),
      batchTask("batchClaimPeachTasks", "一键领取蟠桃园任务"),
      batchTask("batchBuyDreamItems", "梦境商店购买商品"),
      batchTask("batchFootballBet", "盐杯竞猜（使用模板选项）", {
        requires: "footballBet",
      }),
    ],
  },
  {
    name: "treasury",
    label: "宝库",
    tasks: [
      batchTask("batchbaoku13", "一键宝库前3层"),
      batchTask("batchbaoku45", "一键宝库4、5层"),
    ],
  },
  {
    name: "weirdTower",
    label: "怪异塔",
    tasks: [
      batchTask("climbWeirdTower", "一键爬怪异塔"),
      batchTask("batchSmartItemHandling", "智能领取并处理道具"),
    ],
  },
  {
    name: "resource",
    label: "资源",
    tasks: [
      batchTask("batchOpenBox", "批量开箱", { scheduledArgument: true }),
      batchTask("batchOpenBoxByPoints", "批量按积分开箱", {
        scheduledArgument: true,
      }),
      batchTask("batchClaimBoxPointReward", "领取宝箱积分"),
      batchTask("batchFish", "批量钓鱼", { scheduledArgument: true }),
      batchTask("batchRecruit", "批量招募", { scheduledArgument: true }),
      batchTask("batchHeroUpgrade", "一键英雄升星"),
      batchTask("batchBookUpgrade", "一键图鉴升星"),
      batchTask("batchClaimStarRewards", "一键领取图鉴奖励"),
      batchTask("legion_storebuygoods", "一键购买四圣碎片"),
      batchTask("legionStoreBuySkinCoins", "一键购买俱乐部5皮肤币"),
    ],
  },
  {
    name: "legacy",
    label: "功法",
    tasks: [
      batchTask("batchLegacyClaim", "批量功法残卷领取"),
      batchTask("batchLegacyGiftSendEnhanced", "批量功法残卷赠送", {
        scheduledArgument: true,
        requires: "legacyGift",
      }),
    ],
  },
  {
    name: "monthly",
    label: "月度与活动",
    tasks: [
      batchTask("batchTopUpFish", "一键钓鱼补齐"),
      batchTask("batchTopUpArena", "一键竞技场补齐"),
      batchTask("batchWarGuessCheer", "月赛助威", { requires: "warGuess" }),
    ],
  },
];

export const flexibleTasks = flexibleTaskGroups.flatMap((group) =>
  group.tasks.map((task) => ({ ...task, group: group.name })),
);

const flexibleTaskIds = new Set(flexibleTasks.map((task) => task.value));

const legacyFlexibleTaskAliases = {
  "daily.addHangUpTime": "daily.claimHangUp",
  "daily.collectionReward": "daily.collectionGift",
  claimHangUpRewards: "daily.claimHangUp",
  batchAddHangUpTime: "daily.claimHangUp",
  resetBottles: "daily.resetBottleTimer",
  batchlingguanzi: "daily.claimBottle",
  batchclubsign: "daily.clubSignIn",
  batcharenafight: "daily.arena",
  store_purchase: "daily.blackMarket",
  collection_claimfreereward: "daily.collectionGift",
  batchGenieSweep: "daily.genieSweep",
  batchmengjing: "daily.dream",
  batchClaimFreeEnergy: "batchSmartItemHandling",
  batchUseItems: "batchSmartItemHandling",
  batchMergeItems: "batchSmartItemHandling",
};

export const defaultFlexibleTemplateSettings = {
  arenaFormation: 1,
  towerFormation: 1,
  bossFormation: 1,
  bossTimes: 2,
  skinChallengeTargets: [],
  boxType: 2001,
  boxCount: 100,
  targetBoxPoints: 1000,
  fishType: 1,
  fishCount: 100,
  recruitCount: 100,
  weirdTowerMaxClimb: 100,
  footballPick: 3,
  legacyRecipientId: null,
  legacyGiftQuantity: 10,
  warGuessLegionId: null,
  warGuessCoin: 20,
};

const normalizeEnum = (value, allowedValues, fallback) => {
  const numericValue = Number(value);
  return allowedValues.includes(numericValue) ? numericValue : fallback;
};

const normalizeInteger = (value, minimum, maximum, fallback) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numericValue)));
};

const normalizeOptionalId = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numericValue = Number(value);
  if (!Number.isSafeInteger(numericValue) || numericValue <= 0) return null;
  return numericValue;
};

export const normalizeFlexibleTemplateSettings = (settings) => {
  const source = settings && typeof settings === "object" ? settings : {};
  const defaults = defaultFlexibleTemplateSettings;

  return {
    ...defaults,
    ...source,
    arenaFormation: normalizeEnum(
      source.arenaFormation,
      [1, 2, 3, 4, 5, 6],
      defaults.arenaFormation,
    ),
    towerFormation: normalizeEnum(
      source.towerFormation,
      [1, 2, 3, 4, 5, 6],
      defaults.towerFormation,
    ),
    bossFormation: normalizeEnum(
      source.bossFormation,
      [1, 2, 3, 4, 5, 6],
      defaults.bossFormation,
    ),
    bossTimes: normalizeInteger(
      source.bossTimes,
      0,
      4,
      defaults.bossTimes,
    ),
    skinChallengeTargets: normalizeSkinChallengeTargets(
      source.skinChallengeTargets,
    ),
    boxType: normalizeEnum(
      source.boxType,
      [2001, 2002, 2003, 2004],
      defaults.boxType,
    ),
    boxCount: normalizeInteger(
      source.boxCount,
      10,
      10000,
      defaults.boxCount,
    ),
    targetBoxPoints: normalizeInteger(
      source.targetBoxPoints,
      1,
      1000000,
      defaults.targetBoxPoints,
    ),
    fishType: normalizeEnum(
      source.fishType,
      [1, 2],
      defaults.fishType,
    ),
    fishCount: normalizeInteger(
      source.fishCount,
      10,
      10000,
      defaults.fishCount,
    ),
    recruitCount: normalizeInteger(
      source.recruitCount,
      10,
      10000,
      defaults.recruitCount,
    ),
    weirdTowerMaxClimb: normalizeInteger(
      source.weirdTowerMaxClimb,
      1,
      10000,
      defaults.weirdTowerMaxClimb,
    ),
    footballPick: normalizeEnum(
      source.footballPick,
      [1, 2, 3],
      defaults.footballPick,
    ),
    legacyRecipientId: normalizeOptionalId(source.legacyRecipientId),
    legacyGiftQuantity: normalizeInteger(
      source.legacyGiftQuantity,
      1,
      9999,
      defaults.legacyGiftQuantity,
    ),
    warGuessLegionId: normalizeOptionalId(source.warGuessLegionId),
    warGuessCoin: normalizeInteger(
      source.warGuessCoin,
      1,
      20,
      defaults.warGuessCoin,
    ),
  };
};

export const normalizeFlexibleTaskIds = (taskIds) => {
  if (!Array.isArray(taskIds)) return [];

  return [
    ...new Set(
      taskIds.map((taskId) => legacyFlexibleTaskAliases[taskId] || taskId),
    ),
  ].filter((taskId) => flexibleTaskIds.has(taskId));
};

export const normalizeFlexibleTemplate = (template) => {
  if (!template || typeof template !== "object") return null;

  return {
    ...template,
    version: FLEXIBLE_TEMPLATE_VERSION,
    name: typeof template.name === "string" ? template.name.trim() : "",
    selectedTasks: normalizeFlexibleTaskIds(template.selectedTasks),
    settings: normalizeFlexibleTemplateSettings(template.settings),
  };
};

export const parseFlexibleTemplates = (rawTemplates) => {
  try {
    const parsed =
      typeof rawTemplates === "string"
        ? JSON.parse(rawTemplates)
        : rawTemplates;

    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(normalizeFlexibleTemplate)
      .filter((template) => template?.id && template.name);
  } catch {
    return [];
  }
};

export const getFlexibleTask = (taskId) =>
  flexibleTasks.find((task) => task.value === taskId) || null;

export const getFlexibleTemplateTaskCount = (template) =>
  normalizeFlexibleTaskIds(template?.selectedTasks).length;

export const createSharedConnectionCoordinator = ({
  acquireSlot,
  connect,
  close,
  releaseSlot,
}) => {
  const connections = new Map();
  const acquiredTokenIds = new Set();

  const ensureConnection = (tokenId) => {
    if (!connections.has(tokenId)) {
      const connection = (async () => {
        await acquireSlot(tokenId);
        acquiredTokenIds.add(tokenId);
        try {
          return await connect(tokenId);
        } catch (error) {
          connections.delete(tokenId);
          acquiredTokenIds.delete(tokenId);
          try {
            await close(tokenId);
          } finally {
            releaseSlot(tokenId);
          }
          throw error;
        }
      })();
      connections.set(tokenId, connection);
    }

    return connections.get(tokenId);
  };

  const cleanup = async () => {
    const tokenIds = [...acquiredTokenIds];
    acquiredTokenIds.clear();
    connections.clear();

    await Promise.all(
      tokenIds.map(async (tokenId) => {
        try {
          await close(tokenId);
        } finally {
          releaseSlot(tokenId);
        }
      }),
    );
  };

  return {
    ensureConnection,
    cleanup,
  };
};