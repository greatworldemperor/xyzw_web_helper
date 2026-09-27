/**
 * 金鱼消耗任务规划（纯逻辑，node 可直接 import，无网络依赖）
 *
 * 需求来源：local-data/goldenfish/a_brief_introduction.txt（2026-09-26 master 整理）
 * 目标（第一步「初步消耗」，金砖消耗与收尾功能后续单独设计）：
 *   - 招募消耗：先做到累积 3900 次（最后 100 次由每日日常 + 收尾补全）
 *   - 宝箱消耗：先做到累积 99000 分（最后 1000 分由每日任务 + 收尾补全）
 *   - 钓鱼消耗：先做到累积 1150 次（最后量由收尾按开道具结果估算）
 *   - 金砖消耗：10月1日收尾时做，本轮不做；收罐子自然完成，无需处理
 *
 * 2026-09-26 master 拍板口径：
 *   - 钓鱼只用黄金鱼竿（itemId 1012，artifact_lottery type:2）
 *   - 钻石宝箱（2005）一律不开（两个阶段都不开）
 *   - 木制宝箱（2001）全程保留 200 个不动
 *   - 限流 400340：弹框换 IP 后继续；长时间无确认则自动重试
 *
 * 消耗任务档位表（每 5 轮一档；钓鱼共 20 轮分 6 档）：
 *   招募  80×5 / 160×5 / 240×5 / 320×5  → 全满 4000
 *   宝箱  2000×5 / 4000×5 / 6000×5 / 8000×5（积分）→ 全满 100000
 *   钓鱼  25×3 / 50×3 / 75×4 / 100×4 / 125×3 / 150×3 → 全满 1750
 *
 * 宝箱迭代循环（master 伪代码，docs/goldenfish-autumn-protocol.md 同源）：
 *   while (累积积分 + 手里宝箱可开分 < 目标) { 全开 → 积分全兑成宝箱 → 重查 }
 *   退出循环后差值精确开箱（铂金→黄金→青铜→木箱），剩余积分不兑换（利润最大化）
 */

// ------------------------------------------------------------------ 常量

/** 消耗目标（master 2026-09-26 口径，页面可调） */
export const GOLDENFISH_CONSUME_DEFAULTS = {
  recruitTarget: 3900,
  boxTarget: 99000,
  fishTarget: 1150,
};

/** 宝箱分值（itemId → 开出积分；钻石宝箱 0 分） */
export const CHEST_POINTS = { 2001: 1, 2002: 10, 2003: 20, 2004: 50, 2005: 0 };

export const WOODEN_BOX_ID = 2001;
export const DIAMOND_BOX_ID = 2005;
/** 木制宝箱保留数量（全程不动，master 2026-09-26 口径） */
export const WOODEN_RESERVE = 200;

/** 开箱命令单发上限（与 batchOpenBox 一致：10 个/发 + 余数一发） */
export const OPENBOX_BATCH_SIZE = 10;
/** 招募命令单发数量（hero_recruit recruitNumber，抓包口径 10） */
export const RECRUIT_BATCH_SIZE = 10;
/** 钓鱼命令单发数量（artifact_lottery lotteryNumber，抓包口径 10） */
export const FISH_BATCH_SIZE = 10;

/** 宝箱积分兑换：一轮 9 档成本（合计 500 分），第 9 档必得钻石宝箱 */
export const BOX_POINT_STEP_COSTS = [10, 20, 30, 40, 80, 100, 70, 50, 100];
export const BOX_POINT_ROUND_TOTAL = 500;

// ------------------------------------------------------------------ 通用工具

/** 把总次数切成批量发送序列（如 3900 → 390 个 10；7 → [7]） */
export const chunkBatches = (count, size = OPENBOX_BATCH_SIZE) => {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const step = Math.max(1, Math.floor(Number(size) || 1));
  const out = [];
  let left = total;
  while (left > 0) {
    const n = Math.min(step, left);
    out.push(n);
    left -= n;
  }
  return out;
};

/** 消耗类任务（招募/钓鱼）差值规划：进度未知时拒绝执行（断点续跑基准） */
export const planCountConsume = ({ done, target, stock, batchSize }) => {
  if (done == null || !Number.isFinite(Number(done))) {
    return { ok: false, reason: "progress-unknown" };
  }
  const tgt = Math.max(0, Math.floor(Number(target) || 0));
  const doneNum = Math.max(0, Math.floor(Number(done)));
  const remaining = Math.max(0, tgt - doneNum);
  if (remaining === 0) {
    return { ok: true, remaining: 0, willDo: 0, batches: [], stockShort: false, reached: true };
  }
  const stockNum = stock == null ? Infinity : Math.max(0, Math.floor(Number(stock) || 0));
  const willDo = Math.min(remaining, stockNum);
  return {
    ok: true,
    remaining,
    willDo,
    batches: chunkBatches(willDo, batchSize),
    stockShort: willDo < remaining,
    reached: false,
  };
};

// ------------------------------------------------------------------ 宝箱库存

/** 从 role.items 读宝箱库存（{ itemId: quantity } / 数组皆兼容，缺项补 0） */
export const readChestInventory = (items) => {
  const out = {};
  for (const id of Object.keys(CHEST_POINTS)) {
    out[id] = 0;
  }
  if (!items) return out;
  if (Array.isArray(items)) {
    for (const it of items) {
      const id = Number(it?.id ?? it?.itemId);
      if (id in out) out[id] = Number(it?.num ?? it?.count ?? it?.quantity ?? 0) || 0;
    }
    return out;
  }
  if (typeof items !== "object") return out;
  for (const id of Object.keys(CHEST_POINTS)) {
    const node = items[id] ?? items[Number(id)];
    if (node == null) continue;
    out[id] =
      typeof node === "object"
        ? Number(node.quantity ?? node.num ?? node.count ?? 0) || 0
        : Number(node) || 0;
  }
  return out;
};

/** 手里宝箱可开总分：不含钻石箱；木箱扣除保留量（Number(null)===0 陷阱，显式判） */
export const chestScoreAvailable = (inventory, { woodenReserve = WOODEN_RESERVE } = {}) => {
  if (!inventory) return 0;
  const inv = readChestInventory(inventory);
  const wooden = Math.max(0, inv[WOODEN_BOX_ID] - Math.max(0, woodenReserve));
  return (
    inv[2004] * CHEST_POINTS[2004] +
    inv[2003] * CHEST_POINTS[2003] +
    inv[2002] * CHEST_POINTS[2002] +
    wooden * CHEST_POINTS[WOODEN_BOX_ID]
  );
};

/**
 * 推进期一轮「全开」清单（master 伪代码 open_all_boxes 的可用版）：
 * 铂金 → 黄金 → 青铜 → 木箱（超出保留量的部分）；钻石宝箱一律不开。
 * 返回 [{ itemId, number }]（number 为该箱型开箱总数，发送时按 10/发切片）。
 */
export const planOpenAll = (inventory, { woodenReserve = WOODEN_RESERVE } = {}) => {
  const inv = readChestInventory(inventory);
  const steps = [];
  const push = (itemId, count) => {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n > 0) steps.push({ itemId, number: n });
  };
  push(2004, inv[2004]);
  push(2003, inv[2003]);
  push(2002, inv[2002]);
  push(WOODEN_BOX_ID, Math.max(0, inv[WOODEN_BOX_ID] - Math.max(0, woodenReserve)));
  return steps;
};

/**
 * 差值精确开箱（master 伪代码 open_boxes）：从铂金往下，每档
 *   planned_score = min(remaining, 该档可开总分)
 *   planned_boxes = ceil(planned_score / 单箱分)   ← ceil 保证目标达成，
 *     超出部分留在未兑换积分里（不兑换即不损失，与利润最大化一致）
 * @returns {{ steps: [{itemId, number}], remainingScore: number }}
 *   remainingScore = 全部开完后仍差的积分（0 = 目标可达）
 */
export const planPreciseOpen = (remainingScore, inventory, { woodenReserve = WOODEN_RESERVE } = {}) => {
  const inv = readChestInventory(inventory);
  const steps = [];
  let remaining = Math.max(0, Math.floor(Number(remainingScore) || 0));
  const tiers = [2004, 2003, 2002, WOODEN_BOX_ID];
  for (const itemId of tiers) {
    if (remaining <= 0) break;
    const pts = CHEST_POINTS[itemId];
    let count = inv[itemId];
    if (itemId === WOODEN_BOX_ID) {
      count = Math.max(0, count - Math.max(0, woodenReserve));
    }
    if (count <= 0) continue;
    const totalScore = count * pts;
    const plannedScore = Math.min(remaining, totalScore);
    const plannedBoxes = Math.min(count, Math.ceil(plannedScore / pts));
    steps.push({ itemId, number: plannedBoxes });
    remaining -= plannedBoxes * pts;
  }
  return { steps, remainingScore: Math.max(0, remaining) };
};

/** 推进循环是否继续：累积 + 手里可开分 < 目标（master 伪代码 while 条件） */
export const shouldKeepLooping = (accumulated, inventory, target, opts) =>
  Math.floor(Number(accumulated) || 0) +
    chestScoreAvailable(inventory, opts) <
  Math.floor(Number(target) || 0);

/**
 * 预计兑换次数（日志用）：从下一档 pos 开始连续兑到付不起下一档为止的成本序列。
 * 实际兑换以响应驱动（boxPoint / boxPointLastReward 每次从 resp 更新）。
 */
export const estimateExchangeSteps = (boxPoint, pos = 0) => {
  let point = Math.max(0, Math.floor(Number(boxPoint) || 0));
  let idx = Math.floor(Number(pos) || 0);
  const steps = [];
  const MAX = 3000; // 安全阀：99000 分全程最多约 1782 档
  while (idx >= 0 && idx < BOX_POINT_STEP_COSTS.length && steps.length < MAX) {
    const cost = BOX_POINT_STEP_COSTS[idx];
    if (point < cost) break;
    steps.push(cost);
    point -= cost;
    idx = (idx + 1) % BOX_POINT_STEP_COSTS.length;
  }
  return { count: steps.length, totalCost: steps.reduce((s, c) => s + c, 0), steps };
};

// ------------------------------------------------------------------ 活动进度读取（占位）

/**
 * 读取五类消耗任务的活动累积进度（断点续跑的差值基准）。
 *
 * ⚠️ 占位实现：字段来源待「金鱼活动面板」抓包确认（2026-09-26 master 将提供），
 *    现有抓包（use_one_item.jsonl / shop_list.jsonl）里没有任务进度结构。
 *    拿到抓包后在此实现，从活动数据 / role.statistics 里解析：
 *      { recruitDone, boxScoreDone, fishDone, goldDone }
 *    在此之前返回 null → 调用方必须中止对应消耗步骤（宁可不跑，不可盲跑）。
 *
 * @param {Object} role role_getroleinfo 响应里的 role 对象
 * @returns {{ recruitDone?: number, boxScoreDone?: number, fishDone?: number, goldDone?: number } | null}
 */
export const readActivityProgress = (role) => {
  // TODO(阶段B): 解码活动面板抓包后填充真实字段。
  // 候选位置：role.statistics（如 "au:f:le:id:<期号>" 一类的活动 key）、
  // role 上的活动结构、或活动面板专用查询命令的响应。
  void role;
  return null;
};

export default {
  GOLDENFISH_CONSUME_DEFAULTS,
  CHEST_POINTS,
  WOODEN_RESERVE,
  chunkBatches,
  planCountConsume,
  readChestInventory,
  chestScoreAvailable,
  planOpenAll,
  planPreciseOpen,
  shouldKeepLooping,
  estimateExchangeSteps,
  readActivityProgress,
};
