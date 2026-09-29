/**
 * 金鱼消耗任务规划（纯逻辑，node 可直接 import，无网络依赖）
 *
 * 需求来源：local-data/goldenfish/a_brief_introduction.txt（2026-09-26 master 整理）
 * 目标（第一步「初步消耗」，金砖消耗与收尾功能后续单独设计）：
 *   - 招募消耗：先做到累积 3900 次（最后 100 次由每日日常 + 收尾补全）
 *   - 宝箱消耗：先做到累积 99000 分（最后 1000 分由每日任务 + 收尾补全）
 *   - 钓鱼消耗：先做到累积 1140 次（最后量由收尾按开道具结果估算）
 *   - 金砖消耗：10月1日收尾时做，本轮不做；收罐子自然完成，无需处理
 *
 * ⚠️ 钓鱼为什么是 1140 而不是档位满值：原文第 31 行明确「绝对不能 9 月份就做完，一定要至少
 * 给 10 月留下 160 次的额度，所以这里是 1140，因为 1140+160=1300，正好是拿金鱼理论上最低
 * 钓鱼次数」；抓包实测进度也正好是 `task.3 = 1140`。**不是 1150**（旧文档/旧代码的笔误）。
 *
 * 2026-09-26 master 拍板口径：
 *   - 钓鱼只用黄金鱼竿（itemId 1012，artifact_lottery type:2）
 *   - 钻石宝箱（2005）一律不开（两个阶段都不开）
 *   - 木制宝箱（2001）全程保留 200 个不动
 *   - 限流 400340：弹框换 IP 后继续；长时间无确认则自动重试
 *
 * 2026-09-28 阶段 B：**活动累积进度的真实字段已查明**（抓包
 * `local-data/goldenfish/goldenfish_task_and_rewards1.jsonl`）——
 *   activity_get {}  →  Activity_GetResp
 *     body.activity.commonActivityInfo[<活动ID>].task = { 1:招募, 2:宝箱, 3:钓鱼, 4:收罐子, 5:金砖 }
 *     body.activity.commonActivityInfo[<活动ID>].record = { <missionId>: 领取时间戳 }
 *   实测：`{"2609251": {record:{1,21,41,61,81}, task:{1:3685, 2:96530, 3:1140, 4:632, 5:20389}}}`
 *   ⚠️ 旧的「候选位置 role.statistics」结论**已证伪**（那是旧手写 BON 解码器 tag4 不读 8 字节
 *      导致错位所产生的假结论）；进度**不在 role 上**，必须发 `activity_get`。
 *   ⚠️ 同期 `commonActivityInfo` 里有 5 个 7 位键（2609251~2609255），只有 2609251 是真的金鱼
 *      活动：2609252/3/4 的 task 为空、2609255 的 task 键是负数（-1/-2/-4/-5）。
 *      识别签名 = **task 的键全部落在 1..5**（见 isGoldenfishTaskMap）。
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

/** 消耗目标（master 2026-09-26 口径，页面可调；钓鱼 1140 见文件头说明） */
export const GOLDENFISH_CONSUME_DEFAULTS = {
  recruitTarget: 3900,
  boxTarget: 99000,
  fishTarget: 1140,
};

/**
 * 金鱼消耗活动的五类任务槽位 = `commonActivityInfo[<活动ID>].task` 的键
 *
 * **实证来源**：抓包里 5 次 `activity_claimtaskreward{activityId:2609251, missionId:1/21/41/61/81}`
 * 分别返回普通道具 ×8 / ×4 / ×4 / ×1 / ×3，正好等于需求原文档位表里金鱼五类任务的
 * 「每轮道具」列（招募 8 / 宝箱 4 / 钓鱼 4 / 罐子 1 / 金砖 3）——不是猜测。
 */
export const GOLDENFISH_TASK_SLOTS = Object.freeze({
  recruit: 1, // 招募（消耗招募令 1001）
  box: 2, // 宝箱（积分）
  fish: 3, // 钓鱼（黄金鱼竿 1012）
  jar: 4, // 收罐子（自然完成）
  gold: 5, // 金砖（收尾当天做）
});

/** 槽位 → 中文名（日志/UI 用） */
export const GOLDENFISH_TASK_NAMES = Object.freeze({
  1: "招募",
  2: "宝箱",
  3: "钓鱼",
  4: "收罐子",
  5: "金砖",
});


/** 宝箱分值（itemId → 开出积分；钻石宝箱 0 分） */
export const CHEST_POINTS = { 2001: 1, 2002: 10, 2003: 20, 2004: 50, 2005: 0 };

export const WOODEN_BOX_ID = 2001;
export const BRONZE_BOX_ID = 2002;
export const GOLD_BOX_ID = 2003;
export const PLATINUM_BOX_ID = 2004;
export const DIAMOND_BOX_ID = 2005;
/** 木制宝箱保留数量（全程不动，master 2026-09-26 口径） */
export const WOODEN_RESERVE = 200;

/**
 * 开箱命令单发数量。**服务端只接受整批（恰好 10）**，不是「上限」—— 2026-09-29 定案：
 *
 * 证据链（`local-data/goldenfish/batch_log1.txt` 18:14 那轮 + 抓包）：
 *   1. 全部被拒帧的 number ∈ {2,3,4,5,6,7,8}，**无一 ≥ 10**；全部成功帧的 number = 10。
 *   2. `28c-2-625238513` 计划 885 → `chunkBatches(885,10)` = `[10×88, 5]` →
 *      日志「已发 89 帧/已开 880 个，被拒帧 2001 × 5」：**前 88 帧全成，只有最后那个剩 5 个的尾帧被拒**。
 *      （该号服务端计数器 today:open:box 1,768→1,856 = +88，与本机成功帧数精确吻合，锁定不是并发。）
 *   3. 真实客户端抓包 `consumption_tasks.jsonl`：item_openbox 的 body 恒为
 *      `...6e756d626572 01 0a000000`（number = 0x0a = 10），2002/2003/2004/2001 一律 10，从不发余数。
 *   4. 同类规则已在招募侧实证：`recruitNumber:3` 被服务端拒（见 planCountConsume 的 alignDown）。
 *
 * ⇒ 每档「真正可开数量」= `alignDownToBatch(可用数)`；余数（<10）**根本开不动**，
 *    与「差 3 次不做就不做了」同一口径（master 2026-09-29）。
 */
export const OPENBOX_BATCH_SIZE = 10;

/**
 * 向下对齐到整批（服务端开箱/招募/钓鱼都只认整批）。
 * 例：`alignDownToBatch(208-200=8)` → 0（开不动）；`alignDownToBatch(885)` → 880。
 */
export const alignDownToBatch = (count, size = OPENBOX_BATCH_SIZE) => {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const s = Math.max(1, Math.floor(Number(size) || 1));
  return Math.floor(n / s) * s;
};
/** 招募命令单发数量（hero_recruit recruitNumber，抓包口径 10） */
export const RECRUIT_BATCH_SIZE = 10;
/** 钓鱼命令单发数量（artifact_lottery lotteryNumber，抓包口径 10） */
export const FISH_BATCH_SIZE = 10;

/** 宝箱积分兑换：一轮 9 档成本（合计 500 分），第 9 档必得钻石宝箱 */
export const BOX_POINT_STEP_COSTS = [10, 20, 30, 40, 80, 100, 70, 50, 100];
export const BOX_POINT_ROUND_TOTAL = 500;

/**
 * 「一键兑换」的最小积分门槛（2026-09-29 master 口径）。
 *
 * `boxPoint ≥ 1000` 时直接发 `item_batchclaimboxpointreward`（**无参数**）一次把能兑的档位
 * 全兑掉，不再「一档一帧」——省掉几十帧往返、显著提速。低于门槛仍走逐档
 * `item_claimboxpointreward`（游戏里一键按钮本身也要够门槛才可用）。
 *
 * 抓包实证 `local-data/goldenfish/consumption_tasks.jsonl`（id 1284 发送 / 1286 响应）：
 *   发送 `item_batchclaimboxpointreward`，请求体 2 字节 `0800`（空参数）；
 *   响应为 `Item_OpenBoxResp`（`resp` = 请求 `seq`），带 `role.boxPoint`（1638 → 38）
 *   与 `role.boxPointLastReward` ⇒ 与逐档 claim 读的是同一组字段。
 * 该命令在 `xyzwWebSocket.js` 已注册，`BoxHelperCard.vue` / `tasksItem.js` 也早就在用。
 */
export const BOX_POINT_BATCH_MIN = 1000;

/**
 * 每档兑换的**产出**（2026-09-28 master 补充，原文附录1「宝箱积分回收数据」）
 *
 * | Turn | 消耗 | 产出 | 内容 | | Turn | 消耗 | 产出 | 内容 | | Turn | 消耗 | 产出 | 内容 |
 * |  1 |  10 | 10 | 青铜 | |  4 |  40 | 50 | 铂金 | |  7 |  70 | 20 | 黄金 |
 * |  2 |  20 | 10 | 青铜 | |  5 |  80 | 50 | 铂金 | |  8 |  50 | 50 | 铂金 |
 * |  3 |  30 | 20 | 黄金 | |  6 | 100 | 50 | 铂金 | |  9 | 100 |  0 | 钻石 |
 *
 * **每档只给 1 个宝箱**，数字是它的积分价值（10 分 = 1 个青铜 = itemId 2002 …）。
 * 一轮合计 **500 分成本 → 260 分回收（52%）** ⇒ 兑换是**亏的**，
 * 所以原文第 41 行要求「尽量减少兑换」，把未兑换积分留到活动结束后慢慢兑（利润最大化）。
 */
export const BOX_POINT_STEP_ITEMS = [2002, 2002, 2003, 2004, 2004, 2004, 2003, 2004, 2005];
/** 每档产出的积分价值（= CHEST_POINTS[产出箱型]） */
export const BOX_POINT_STEP_RETURN = [10, 10, 20, 50, 50, 50, 20, 50, 0];
/** 一轮兑换的总回收分（260 / 500 = 52%） */
export const BOX_POINT_ROUND_RETURN = 260;

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

/**
 * 消耗类任务（招募/钓鱼）差值规划：进度未知时拒绝执行（断点续跑基准）
 *
 * alignDown（2026-09-29 master 口径）：招募/钓鱼抓包口径单发固定 10（recruitNumber /
 * lotteryNumber 余数批次会被服务端 200020 拒绝 —— 实测差 3 发 recruitNumber:3 直接报
 * 「出了点小问题」）。开启后 willDo 向下取整到 batchSize 的整批倍数，余数不做：
 * 「差 3 次不做就不做了，没必要非做不可，本来就是留一点点余量等着最后一天补满的」。
 * alignedShort = 因对齐被跳过的余数（区别于库存不足）。
 */
export const planCountConsume = ({ done, target, stock, batchSize, alignDown = false }) => {
  if (done == null || !Number.isFinite(Number(done))) {
    return { ok: false, reason: "progress-unknown" };
  }
  const tgt = Math.max(0, Math.floor(Number(target) || 0));
  const doneNum = Math.max(0, Math.floor(Number(done)));
  const remaining = Math.max(0, tgt - doneNum);
  if (remaining === 0) {
    return { ok: true, remaining: 0, willDo: 0, batches: [], stockShort: false, alignedShort: false, reached: true };
  }
  const stockNum = stock == null ? Infinity : Math.max(0, Math.floor(Number(stock) || 0));
  let willDo = Math.min(remaining, stockNum);
  let alignedShort = false;
  if (alignDown) {
    const step = Math.max(1, Math.floor(Number(batchSize) || 1));
    const aligned = Math.floor(willDo / step) * step;
    alignedShort = aligned < willDo;
    willDo = aligned;
  }
  return {
    ok: true,
    remaining,
    willDo,
    batches: chunkBatches(willDo, batchSize),
    stockShort: willDo < remaining,
    alignedShort,
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

/**
 * 手里宝箱**真正可开**的总分：不含钻石箱；木箱扣除保留量；每档再向下对齐到整批
 * （服务端只认整批开箱，余数开不动 —— 见 OPENBOX_BATCH_SIZE）。
 * `Number(null)===0` 陷阱：显式判。
 */
export const chestScoreAvailable = (
  inventory,
  { woodenReserve = WOODEN_RESERVE, batchSize = OPENBOX_BATCH_SIZE } = {},
) => {
  if (!inventory) return 0;
  const inv = readChestInventory(inventory);
  const wooden = alignDownToBatch(
    Math.max(0, inv[WOODEN_BOX_ID] - Math.max(0, woodenReserve)),
    batchSize,
  );
  return (
    alignDownToBatch(inv[2004], batchSize) * CHEST_POINTS[2004] +
    alignDownToBatch(inv[2003], batchSize) * CHEST_POINTS[2003] +
    alignDownToBatch(inv[2002], batchSize) * CHEST_POINTS[2002] +
    wooden * CHEST_POINTS[WOODEN_BOX_ID]
  );
};

/**
 * 推进期一轮「全开」清单（master 伪代码 open_all_boxes 的可用版）：
 * 铂金 → 黄金 → 青铜 → 木箱（超出保留量的部分）；钻石宝箱一律不开。
 * 每档数量**向下对齐到整批**，返回 [{ itemId, number }]（number 已是 10 的整数倍，
 * 发送时按 10/发切片，绝不会产生 <10 的尾帧）。
 */
export const planOpenAll = (
  inventory,
  { woodenReserve = WOODEN_RESERVE, batchSize = OPENBOX_BATCH_SIZE } = {},
) => {
  const inv = readChestInventory(inventory);
  const steps = [];
  const push = (itemId, count) => {
    const n = alignDownToBatch(count, batchSize);
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
 *   planned_batches = ceil(planned_score / 单批分)   ← ceil 保证目标达成，
 *     超出部分留在未兑换积分里（不兑换即不损失，与利润最大化一致）
 *   ⚠️ 只能整批开：每档可开数先向下对齐，需求量再**向上**取整到整批
 *      （代价是超开 ≤ 一批；实践里推进循环已把铂金/黄金/青铜开光，这里基本只用木箱，
 *        一批木箱 = 10 分，超开 ≤ 9 分，可忽略）
 * @returns {{ steps: [{itemId, number}], remainingScore: number }}
 *   remainingScore = 全部开完后仍差的积分（0 = 目标可达）
 */
export const planPreciseOpen = (
  remainingScore,
  inventory,
  { woodenReserve = WOODEN_RESERVE, batchSize = OPENBOX_BATCH_SIZE } = {},
) => {
  const inv = readChestInventory(inventory);
  const size = Math.max(1, Math.floor(Number(batchSize) || 1));
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
    count = alignDownToBatch(count, size);
    if (count <= 0) continue;
    const totalScore = count * pts;
    const plannedScore = Math.min(remaining, totalScore);
    const batches = Math.min(count / size, Math.ceil(plannedScore / (size * pts)));
    const plannedBoxes = batches * size;
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

// ------------------------------------------------------------------ 活动实例探测
//
// 活动实例 ID 规则（与逍遥津同族）：`YYMMDD + 功能位`，7 位纯数字。
// 同一期全服一致、跨账号一致，所以「取 7 位键里最大的那个」= 最新一期
// （YYMMDD+功能位 的字典序 == 时间序，不需要解析日期）。

/** 活动实例 ID：7 位纯数字（YYMMDD + 功能位） */
export const isActivityInstanceId = (id) => /^\d{7}$/.test(String(id ?? "").trim());

/**
 * 判「这个 task 表是不是金鱼的五类消耗任务」
 *
 * 判据 = **键全部落在 1..5**（≥1 个）。
 * 实证（2026-09-25 抓包 `commonActivityInfo`）：
 *   2609251 → {1,2,3,4,5}  ✅ 金鱼
 *   2609252/3/4 → 无 task  ❌
 *   2609255 → {-1,-2,-4,-5} ❌（负数直接否决）
 * 注意必须用「全部落在」而不是「存在一个落在」，否则 2609255 这类混入负数键的活动也可能命中。
 */
export const isGoldenfishTaskMap = (task) => {
  if (!task || typeof task !== "object" || Array.isArray(task)) return false;
  const keys = Object.keys(task);
  if (keys.length === 0) return false;
  return keys.every((key) => {
    const n = Number(key);
    return Number.isInteger(n) && n >= 1 && n <= GOLDENFISH_TASK_SLOTS.gold;
  });
};

/** 最强签名：task 的键**恰好**是 {1,2,3,4,5}（优先级高于部分命中） */
export const isFullGoldenfishTaskMap = (task) => {
  if (!isGoldenfishTaskMap(task)) return false;
  const unique = new Set(Object.keys(task).map((key) => Number(key)));
  return unique.size === Object.keys(GOLDENFISH_TASK_SLOTS).length;
};

/**
 * 从任意形态的响应里取出 `commonActivityInfo`
 * （兼容 activity_get 的 Promise 返回值各层级；取不到返回 null）
 */
export const extractCommonActivityInfo = (response) => {
  if (!response || typeof response !== "object") return null;
  const candidates = [
    response.commonActivityInfo,
    response.activity?.commonActivityInfo,
    response.body?.commonActivityInfo,
    response.body?.activity?.commonActivityInfo,
    response.data?.commonActivityInfo,
    response.data?.activity?.commonActivityInfo,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate;
    }
  }
  return null;
};

/**
 * 定位本期的金鱼消耗活动实例（纯读，不发请求）
 *
 * 规则：
 *   1. `options.manualId`（7 位数字）优先级最高 —— 用户手填即明确意图（自动探测可能撞上
 *      同期其它活动的脏数据 / 上一期未清理的键）；
 *   2. 自动：7 位键 ∩ task 是金鱼任务表；**优先「键恰好 {1..5} 的完整签名」**，
 *      再在其中取最大键（= 最新一期）；
 *   3. 全部失败返回 `ok:false` + reason（调用方据此写日志，不要盲跑）。
 *
 * @param {object} commonActivityInfo `body.activity.commonActivityInfo`
 * @param {{ manualId?: string|number }} [options]
 * @returns {{ok:true, activityId:string, source:"manual"|"auto",
 *            entry:object, task:object, record:object, candidates:string[]}
 *          | {ok:false, reason:string, candidates:string[]}}
 */
export const resolveGoldenfishActivity = (commonActivityInfo, options = {}) => {
  const info =
    commonActivityInfo && typeof commonActivityInfo === "object"
      ? commonActivityInfo
      : null;
  if (!info) {
    return { ok: false, reason: "未取到活动数据（activity_get 返回里没有 commonActivityInfo）", candidates: [] };
  }

  const ids = Object.keys(info);
  const candidates = ids.filter((id) => {
    if (!isActivityInstanceId(id)) return false;
    return isGoldenfishTaskMap(info[id]?.task);
  });

  // 手工指定：只认「7 位数字 + 该键存在」，task 表不完整也认（用户说了算，缺项由调用方跳过）
  const manualId = options.manualId === null || options.manualId === undefined
    ? ""
    : String(options.manualId).trim();
  if (manualId) {
    if (!isActivityInstanceId(manualId)) {
      return { ok: false, reason: `手工指定的活动 ID「${manualId}」不是 7 位数字（YYMMDD+功能位）`, candidates };
    }
    const entry = info[manualId];
    if (!entry || typeof entry !== "object") {
      return { ok: false, reason: `commonActivityInfo 里没有活动 ${manualId}（该期可能未开启或已清理）`, candidates };
    }
    return {
      ok: true,
      activityId: manualId,
      source: "manual",
      entry,
      task: entry.task && typeof entry.task === "object" ? entry.task : {},
      record: entry.record && typeof entry.record === "object" ? entry.record : {},
      candidates,
    };
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "未找到金鱼活动实例（task 键全部落在 1..5 的活动）；活动可能未开启/已结束，或需要手工指定活动 ID",
      candidates,
    };
  }

  // 完整签名优先，其次取键最大者（最新一期）
  const full = candidates.filter((id) => isFullGoldenfishTaskMap(info[id]?.task));
  const pool = full.length > 0 ? full : candidates;
  const activityId = pool.reduce((best, id) => (best === null || id > best ? id : best), null);
  const entry = info[activityId];

  return {
    ok: true,
    activityId,
    source: "auto",
    entry,
    task: entry.task && typeof entry.task === "object" ? entry.task : {},
    record: entry.record && typeof entry.record === "object" ? entry.record : {},
    candidates,
  };
};

/** 读单个任务槽位的进展值；缺失/非法 → **null**（不是 0！`Number(null)===0` 陷阱） */
const readTaskValue = (task, slot) => {
  if (!task || typeof task !== "object") return null;
  const raw = task[slot] ?? task[String(slot)];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
};

/**
 * 读取五类消耗任务的**活动累积进度**（断点续跑的差值基准）
 *
 * 数据源：`activity_get` 的响应 → `body.activity.commonActivityInfo[<活动ID>].task`
 * （实测结构见文件头；**不在 `role` 上**）。
 *
 * 返回值约定（调用方按此决定跑/跳过）：
 *   - 整体读不到（没有 commonActivityInfo / 找不到金鱼活动实例）→ **返回 `null`**
 *     ⇒ 调用方必须中止对应消耗步骤（宁可不跑，不可盲跑）；
 *   - 单个槽位缺失 → 该字段为 `null`（**不能用 0 冒充**，否则会当成「进度 0」而盲跑一遍）。
 *
 * @param {object} response `activity_get` 的 Promise 返回值（各层级形态皆可）
 * @param {{ manualId?: string|number }} [options] 手工指定的活动实例 ID
 * @returns {{ activityId:string, source:string, recruitDone:number|null,
 *             boxScoreDone:number|null, fishDone:number|null,
 *             jarDone:number|null, goldDone:number|null,
 *             record:object, candidates:string[] } | null}
 */
export const readActivityProgress = (response, options = {}) => {
  const resolved = resolveGoldenfishActivity(extractCommonActivityInfo(response), options);
  if (!resolved.ok) return null;

  const { task } = resolved;
  return {
    activityId: resolved.activityId,
    source: resolved.source,
    recruitDone: readTaskValue(task, GOLDENFISH_TASK_SLOTS.recruit),
    boxScoreDone: readTaskValue(task, GOLDENFISH_TASK_SLOTS.box),
    fishDone: readTaskValue(task, GOLDENFISH_TASK_SLOTS.fish),
    jarDone: readTaskValue(task, GOLDENFISH_TASK_SLOTS.jar),
    goldDone: readTaskValue(task, GOLDENFISH_TASK_SLOTS.gold),
    record: resolved.record,
    candidates: resolved.candidates,
  };
};

export default {
  GOLDENFISH_CONSUME_DEFAULTS,
  GOLDENFISH_TASK_SLOTS,
  GOLDENFISH_TASK_NAMES,
  CHEST_POINTS,
  WOODEN_RESERVE,
  OPENBOX_BATCH_SIZE,
  BOX_POINT_BATCH_MIN,
  alignDownToBatch,
  chunkBatches,
  planCountConsume,
  readChestInventory,
  chestScoreAvailable,
  planOpenAll,
  planPreciseOpen,
  shouldKeepLooping,
  estimateExchangeSteps,
  isActivityInstanceId,
  isGoldenfishTaskMap,
  isFullGoldenfishTaskMap,
  extractCommonActivityInfo,
  resolveGoldenfishActivity,
  readActivityProgress,
};

