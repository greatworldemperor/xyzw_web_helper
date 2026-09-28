/**
 * 金鱼模拟器 · 引擎（2026-09-28 修订版，照 master 补充后的 a_brief_introduction.txt）
 *
 * 设计目标：**跑的就是生产逻辑，不是我另写一份**。
 *   - 纯逻辑一律 import 真实源码：
 *       src/utils/goldenfishConsumePlan.js  （阶段 B 已上线：进度解析 / 活动识别 / 消耗规划 / 宝箱计划）
 *       src/utils/goldenfishFinishPlan.js    （收尾：档位表 / 领奖 / 开箱 / 买鱼竿规划）
 *   - 命令顺序、命令名、参数严格照抄 src/utils/batch/tasksGoldenfish.js：
 *       activity_get {} → role_getroleinfo {} → 招募 hero_recruit{recruitType:1,recruitNumber}
 *       → 宝箱（item_openbox + item_claimboxpointreward 循环 + 精确开箱）
 *       → 钓鱼 artifact_lottery{type:2,lotteryNumber,newFree:true}
 *       → 收尾 activity_claimtaskreward / item_openpack / **购买原价鱼竿（金砖消耗）**
 *   - 只有「虚拟服务端」是我写的（它扮演游戏服务器）。
 *
 * ✅ 原文补充后**已解除**的推断：
 *   1. 宝箱积分兑换产出 —— 附录1 给了逐档明细：
 *      9 档成本 [10,20,30,40,80,100,70,50,100]（一轮 500 分）
 *      产出 [青铜,青铜,黄金,铂金,铂金,铂金,黄金,铂金,钻石] 各 **1 个**
 *      ⇒ 一轮回收 10+10+20+50+50+50+20+50+0 = **260 分**（回收率 52%，兑换是**亏的**）。
 *   2. 金砖消耗命令 —— 原文第 135 行：**金砖消耗 = 购买 600 一根的原价鱼竿**。
 *      一笔支出**同时**推进「金砖消耗」与「钓鱼消耗」两个任务 ⇒ 唯一决策变量 = 买多少根。
 *   3. 开普通道具的返还 —— 原文第 118-120 行（期望值，master 明确用期望简化）：
 *      每 1 个普通道具 = 0.5 招募令 / 0.205 铂金宝箱 / 0.25 特殊道具 / 107.304 金砖。
 *      ✅ master 2026-09-28 确认 **0.205 为准**（第 80 行那个 0.2 只是简化写法，差 2.5%）。
 *
 * 🔴 master 2026-09-28 四条澄清（**推翻此前三处理解**）：
 *   1. **「开箱」= 开普通道具（5287）**，不是开宝箱 —— 宝箱只产宝箱积分，对「拿金鱼」无直接产出。
 *      开普通道具产出特殊道具（5286）**有保底**，用简单公式：
 *      `特殊道具数 = round(普通道具数 × 0.25 + bias)`，`bias ∈ [-5,5]` 的整数、概率**线性**（峰在 0）。
 *      ⇒ 模拟器**没有 `packGuarantee` 参数**，也**不再用正态分布**（`normalRandom` 已删）。
 *      **这不是精确还原，只是验证逻辑**（master 明确）。
 *   2. **「达成一轮就能领一轮」** ⇒ 已完成但未领的档位可以**逐轮补领**（`planClaimSweep`）。
 *   3. **买鱼竿的金砖计入活动进度**，这正是完成金砖消耗任务的**主要手段**（原文第 135 行）。
 *   4. **周四钓鱼先补到 1300（下限），再「看情况决定是否继续做下去」** ⇒ 上限是
 *      **1750（钓鱼全满 20 轮）**，不是 1300。⇒ 本期普通道具上限 = **1050**（不是 978），
 *      250 个特殊道具的成功率因此**大幅提升**。
 *
 * ⚠️ 仍然未知：买鱼竿花的金砖是否**计入**活动金砖消耗进度 —— master 已明确：**计入**（第 3 条）。
 */

import {
  GOLDENFISH_CONSUME_DEFAULTS,
  GOLDENFISH_TASK_SLOTS,
  CHEST_POINTS,
  WOODEN_RESERVE,
  PLATINUM_BOX_ID,
  BOX_POINT_STEP_COSTS,
  BOX_POINT_STEP_ITEMS,
  BOX_POINT_ROUND_TOTAL,
  BOX_POINT_ROUND_RETURN,
  chunkBatches,
  planCountConsume,
  readChestInventory,
  chestScoreAvailable,
  planOpenAll,
  planPreciseOpen,
  shouldKeepLooping,
  readActivityProgress,
  resolveGoldenfishActivity,
  extractCommonActivityInfo,
} from "../../src/utils/goldenfishConsumePlan.js";

import {
  GOLDENFISH_UNIT_LABELS,
  GOLDENFISH_ROD_PRICE,
  GOLDENFISH_FISH_MIN_TARGET,
  GOLDENFISH_FISH_FULL,
  GOLDENFISH_PACK_BIAS_MAX,
  fishesToRods,
  rodsToFishes,
  buildRoundTable,
  completedRounds,
  taskTotals,
  totalRewardAllTasks,
  rewardFromRoundTo,
  planClaimSweep,
  openPacks,
  packsNeededForGap,
  openPackReturns,
  planRodPurchase,
  twoForOneCandidate,
} from "../../src/utils/goldenfishFinishPlan.js";

export const ITEM_RECRUIT = 1001;
export const ITEM_GOLD_ROD = 1012;
export const ITEM_PACK_NORMAL = 5287; // 本期普通道具（旧期 5261）
export const ITEM_PACK_SPECIAL = 5286; // 本期特殊道具（旧期 5262）
export const ITEM_GOLD = 3; // 金砖（按游戏惯例）

/** 折算口径（与项目既有 GOLDENFISH_CHECK_RULES.rodUnit 一致） */
export const ROD_UNIT = 600;

/** 本期活动实例 ID（抓包实测；同一期全服一致） */
export const ACTIVITY_ID = "2609251";

// ================================================================== 虚拟服务端

/**
 * 虚拟服务端
 *
 * 内部状态 = 一个真实账号的快照：
 *   items{}         库存（1001 招募令 / 1012 鱼竿 / 2001-2005 宝箱 / 5286 5287 道具 …）
 *   task{}          五类活动进度（task.5 量纲 = 实际金砖数）
 *   record{}        missionId → 领取时间戳
 *   boxPoint        未兑换宝箱积分
 *   boxPointPos     下一档兑换位置
 *   gold            金砖数
 */
export const createSimServer = (preset = {}) => {
  const items = { ...(preset.items || {}) };
  const task = { ...(preset.task || {}) };
  const record = { ...(preset.record || {}) };
  let boxPoint = Math.max(0, Math.floor(Number(preset.boxPoint) || 0));
  let boxPointPos = Math.max(0, Math.floor(Number(preset.boxPointLastReward) || 0));
  let gold = Math.max(0, Math.floor(Number(preset.gold) || 0));
  /**
   * 开普通道具返还的**小数累加器**（跨批次延续）
   *
   * 返还走期望值（0.5 招募令 / 0.205 铂金箱 / 107.304 金砖），每次开包得到的是小数。
   * 游戏物品必须是整数，但**不能在每次开包后各自 floor** ——
   * 那样每开一批就丢最多 3 个小数（如 0.205 × 3 = 0.615 → 丢 0.615），
   * 收尾阶段要开好几批，累积误差可观。
   * 改为「小数累加 → 按累计值 floor → 只发放还没发过的整数部分」。
   */
  const returnAcc = { recruit: 0, platinum: 0, gold: 0 };
  const issuedReturn = { recruit: 0, platinum: 0, gold: 0 };
  /** 累加一笔小数返还，返回**本次应发放的整数增量**（可能为 0） */
  const issueReturn = (kind, amount) => {
    const add = Number(amount);
    if (!Number.isFinite(add) || add <= 0) return 0;
    returnAcc[kind] += add;
    const target = Math.floor(returnAcc[kind]);
    const gain = target - issuedReturn[kind];
    if (gain > 0) issuedReturn[kind] = target;
    return gain > 0 ? gain : 0;
  };

  const rng = preset.rng || (() => 0.5); // 由 runner 注入，保证可复现

  /** 命令调用记录（帧明细，供报表统计） */
  const calls = [];
  const bump = (itemId, delta) => {
    const cur = Number(items[itemId]) || 0;
    items[itemId] = Math.max(0, cur + delta);
  };
  const take = (itemId, want) => {
    const cur = Math.max(0, Math.floor(Number(items[itemId]) || 0));
    const got = Math.min(cur, Math.max(0, Math.floor(want || 0)));
    items[itemId] = cur - got;
    return got;
  };

  /** 活动响应：结构与真实一致（含同期干扰活动，用来验证识别逻辑真的在干活） */
  const activityResponse = () => ({
    body: {
      activity: {
        commonActivityInfo: {
          // 干扰项 1：同为 7 位、无 task
          "2609252": { openTime: 1, closeTime: 2 },
          // 干扰项 2：有 task 但键是负数
          "2609255": { task: { "-1": 10, "-2": 20, "-4": 30, "-5": 40 } },
          [ACTIVITY_ID]: {
            task: { ...task },
            record: { ...record },
          },
        },
      },
    },
  });

  const roleResponse = () => ({
    role: {
      items: { ...items },
      gold,
      boxPoint,
      boxPointLastReward: boxPointPos,
    },
  });

  /** 收下 1 个任务槽位的进度 */
  const addTask = (slot, amount) => {
    const cur = Math.max(0, Math.floor(Number(task[slot]) || 0));
    task[slot] = cur + Math.max(0, Math.floor(Number(amount) || 0));
  };

  const handle = (cmd, params = {}) => {
    calls.push({ cmd, params: { ...params } });
    switch (cmd) {
      case "activity_get":
        return activityResponse();

      case "role_getroleinfo":
        return roleResponse();

      case "hero_recruit": {
        const want = Math.max(0, Math.floor(Number(params.recruitNumber) || 0));
        const got = take(ITEM_RECRUIT, want);
        addTask(GOLDENFISH_TASK_SLOTS.recruit, got);
        return { role: { items: { ...items } }, recruited: got };
      }

      case "artifact_lottery": {
        // 🔴 鱼竿 10% 返还（master 2026-09-28）：x 根期望可钓 x/0.9 次 ⇒
        //    钓 want 次**净消耗** ceil(want×0.9) 根，账目自洽（返还即时回库存的期望版）。
        const want = Math.max(0, Math.floor(Number(params.lotteryNumber) || 0));
        const cost = fishesToRods(want); // ceil(want × 0.9)
        const got = take(ITEM_GOLD_ROD, cost);
        // 实际拿到的杆能钓多少次（库存不足时按实拿折算）
        const fished = rodsToFishes(got);
        addTask(GOLDENFISH_TASK_SLOTS.fish, fished);
        return { role: { items: { ...items } }, fished, rodsCost: cost };
      }

      case "item_openbox": {
        const itemId = Number(params.itemId);
        const want = Math.max(0, Math.floor(Number(params.number) || 0));
        const pts = CHEST_POINTS[itemId];
        if (!pts) return { role: { items: { ...items }, boxPoint, boxPointLastReward: boxPointPos } };
        const got = take(itemId, want);
        const score = got * pts;
        addTask(GOLDENFISH_TASK_SLOTS.box, score);
        boxPoint += score; // 开箱积分同时进活动进度与兑换池（游戏设计如此）
        return { role: { items: { ...items }, boxPoint, boxPointLastReward: boxPointPos } };
      }

      case "item_claimboxpointreward": {
        const pos = boxPointPos;
        const cost = BOX_POINT_STEP_COSTS[pos];
        if (boxPoint < cost) {
          return { code: 400999, error: "积分不足" };
        }
        boxPoint -= cost;
        // 附录1：每档给 **1 个**宝箱（青铜/青铜/黄金/铂金×3/黄金/铂金/钻石），
        // 一轮 9 档共 500 分成本 → 260 分回收（52%，兑换是亏的）
        const rewardItem = BOX_POINT_STEP_ITEMS[pos];
        boxPointPos = (pos + 1) % BOX_POINT_STEP_COSTS.length;
        if (rewardItem) bump(rewardItem, 1);
        return {
          role: { items: { ...items }, boxPoint, boxPointLastReward: boxPointPos },
          rewardItemId: rewardItem,
          cost,
        };
      }

      case "activity_claimtaskreward": {
        const missionId = Math.floor(Number(params.missionId) || 0);
        if (record[missionId] != null) {
          return { code: 400998, error: "该档位奖励已领取" };
        }
        const slot = Math.floor((missionId - 1) / 20) + 1;
        const round = ((missionId - 1) % 20) + 1;
        const rows = buildRoundTable(slot);
        const row = rows[round - 1];
        if (!row) return { code: 400997, error: "档位不存在" };
        const cur = Math.max(0, Math.floor(Number(task[slot]) || 0));
        if (cur < row.threshold) return { code: 400996, error: "档位未达成" };
        record[missionId] = 1759000000 + missionId;
        bump(ITEM_PACK_NORMAL, row.reward);
        return {
          body: { record: { ...record } },
          reward: { itemId: ITEM_PACK_NORMAL, count: row.reward },
        };
      }

      case "item_openpack": {
        const want = Math.max(0, Math.floor(Number(params.number) || 0));
        const got = take(ITEM_PACK_NORMAL, want);
        /**
         * 开普通道具产出特殊道具：**期望值 + 有界线性 bias**（master 2026-09-28 口径，**有保底**）
         *   特殊道具数 = round(普通道具数 × 0.25 + bias)，bias ∈ [-5,5] 的整数，概率线性（峰在 0）
         * ⚠️ 这不是开宝箱 —— 宝箱只产宝箱积分，对「拿金鱼」无直接产出。
         */
        const res = openPacks({
          count: got,
          rate: preset.packRate,
          rng,
        });
        if (res.special > 0) bump(ITEM_PACK_SPECIAL, res.special);
        /**
         * 原文第 118-120 行：开道具**同时**返还四项资源（期望值，master 明确用期望简化）
         *   0.5 招募令 / 0.205 铂金宝箱 / 107.304 金砖（特殊道具另由 openPacks 走有界 bias）
         *
         * 🔴 master 2026-09-28 澄清：四项是**同时获取**，不是多选一 ⇒ 四项都要累加。
         * ⚠️ 不能每次 `Math.floor` —— 单次方差极大（铂金箱只有 6.2% 的道具会掉，
         * 见 `GOLDENFISH_PLATINUM_BOX_DROPS`），逐次丢小数会累积误差。
         * 改成**小数累加、按累计值 floor**，只发放「还没发过的整数部分」。
         */
        const exact = openPackReturns(got);
        const recruitGain = issueReturn("recruit", exact.recruitToken);
        const platGain = issueReturn("platinum", exact.platinumBox);
        const goldGain = issueReturn("gold", exact.gold);
        if (recruitGain > 0) bump(ITEM_RECRUIT, recruitGain);
        if (platGain > 0) bump(PLATINUM_BOX_ID, platGain);
        if (goldGain > 0) gold += goldGain;
        return {
          role: { items: { ...items }, gold },
          special: res.special,
          // 保底口径的诊断量：本批的期望基线 / 抽到的 bias / 实际偏移
          packBias: { base: res.base, bias: res.bias, deviation: res.deviation, openedCount: res.openedCount },
          returns: { recruitGain, platGain, goldGain, exact },
        };
      }

      /**
       * 金砖消耗 = **购买原价鱼竿**（原文第 135 行）
       *
       * 一笔支出同时推进两个任务：花掉的金砖进「金砖消耗」进度，买到手的鱼竿进「钓鱼消耗」进度。
       * 这也是为什么收尾补档的唯一决策变量是「买多少根」。
       */
      case "buy_rod": {
        const want = Math.max(0, Math.floor(Number(params.count) || 0));
        const affordable = Math.floor(gold / GOLDENFISH_ROD_PRICE);
        const got = Math.min(want, affordable);
        const spend = got * GOLDENFISH_ROD_PRICE;
        gold -= spend;
        bump(ITEM_GOLD_ROD, got);
        addTask(GOLDENFISH_TASK_SLOTS.gold, spend);
        return { role: { items: { ...items }, gold }, bought: got, spend };
      }

      default:
        return { code: 400000, error: `模拟器未实现的命令：${cmd}` };
    }
  };

  return {
    handle,
    calls,
    /**
     * 直接写任务进度（**只用于模拟「自然完成」**）。
     *
     * 🔴 罐子（slot 4）的消耗命令尚未抓包 ⇒ 引擎的「罐子白送」步只发奖开包、
     * 没有命令可推进 task.4。若不把它写满，后续每轮 `planRodPurchase` 都会把
     * 罐子剩余轮次的 `freeItems`(20) 重复计入 totalItems ⇒ `minimal` 恒为 0 根
     * ⇒ 补档循环空转到迭代上限（fresh 预设 + twoForOne 实测卡 248/250）。
     * 纯逻辑版 `simulateFinish` 早就写了 `progress[4] = maxThreshold`，引擎漏了对齐。
     */
    forceTask: (slot, value) => {
      task[slot] = Math.max(0, Math.floor(Number(value) || 0));
    },
    get items() {
      return { ...items };
    },
    get task() {
      return { ...task };
    },
    get record() {
      return { ...record };
    },
    get boxPoint() {
      return boxPoint;
    },
    get gold() {
      return gold;
    },
  };
};

// ================================================================== 日志

const fmt = (v) => Number(v || 0).toLocaleString("zh-CN");

const createLogger = () => {
  const lines = [];
  const push = (level, text, extra) => lines.push({ level, text, ...(extra || {}) });
  return {
    lines,
    info: (t, extra) => push("info", t, extra),
    success: (t, extra) => push("success", t, extra),
    warning: (t, extra) => push("warning", t, extra),
    error: (t, extra) => push("error", t, extra),
  };
};

// ================================================================== 消耗阶段（照抄生产顺序）

/**
 * 消耗阶段：招募 → 宝箱 → 钓鱼（与 `goldenfishConsumeAll` 的 STEPS 顺序一致）
 * @returns {{logs:Array, stats:object}}
 */
export const runConsumePhase = (server, config = {}) => {
  const log = createLogger();
  /** 结构化事件流（JSONL 的直接来源，与 `runFinishPhase` 的 events 同一 schema） */
  const events = [];
  const ev = (event, data) => {
    events.push({ phase: "consume", event, seq: events.length, ...data });
  };
  const targets = {
    recruit: Math.max(0, Math.floor(Number(config.recruitTarget ?? GOLDENFISH_CONSUME_DEFAULTS.recruitTarget))),
    box: Math.max(0, Math.floor(Number(config.boxTarget ?? GOLDENFISH_CONSUME_DEFAULTS.boxTarget))),
    fish: Math.max(0, Math.floor(Number(config.fishTarget ?? GOLDENFISH_CONSUME_DEFAULTS.fishTarget))),
  };
  const stats = { frames: 0, recruitFrames: 0, boxFrames: 0, fishFrames: 0, exchangeFrames: 0 };
  /**
   * 只跑指定的步骤（默认三步全跑）。
   *
   * 周四是「宝箱做满 + 招募做满 + 钓鱼做满 1300」，
   * 但**钓鱼那 160 次必须由第 6 步买的鱼竿顺带完成**（原文第 134-135 行：
   * 「如果上一步安排了钓鱼，那就要求购买数量同时满足钓鱼任务的需求和金砖任务的需求」）
   * ⇒ 补满阶段默认只跑 recruit + box。
   */
  const ALL_STEPS = ["recruit", "box", "fish"];
  const steps = Array.isArray(config.steps)
    ? ALL_STEPS.filter((s) => config.steps.includes(s))
    : ALL_STEPS;
  const want = (s) => steps.includes(s);

  const send = (cmd, params) => {
    stats.frames += 1;
    return server.handle(cmd, params);
  };

  // ---------------------------------------------------------------- 1. 招募
  if (want("recruit")) {
    const activity = send("activity_get", {});
    const progress = readActivityProgress(activity);
    if (!progress) {
      const diag = resolveGoldenfishActivity(extractCommonActivityInfo(activity));
      log.warning(`招募消耗跳过：活动累积进度不可读（${diag.reason}）`);
    } else if (progress.recruitDone == null) {
      log.warning(`招募消耗跳过：活动 ${progress.activityId} 缺 task.1（招募）进度字段`);
    } else {
      const role = send("role_getroleinfo", {});
      const stock = Math.max(0, Math.floor(Number(role?.role?.items?.[ITEM_RECRUIT]) || 0));
      const plan = planCountConsume({
        done: progress.recruitDone,
        target: targets.recruit,
        stock,
        batchSize: 10,
      });
      if (plan.reached) {
        log.success(
          `招募消耗已达目标（目标 ${fmt(targets.recruit)} / 已做 ${fmt(progress.recruitDone)} / 差值 0 / 招募令库存 ${fmt(stock)}）`,
        );
      } else {
        log.info(
          `招募消耗开始（活动 ${progress.activityId}）：目标 ${fmt(targets.recruit)} / 已做 ${fmt(progress.recruitDone)} / 差值 ${fmt(plan.remaining)} / 招募令库存 ${fmt(stock)}`,
        );
        let done = progress.recruitDone;
        let sent = 0;
        for (const n of plan.batches) {
          send("hero_recruit", { recruitType: 1, recruitNumber: n });
          stats.recruitFrames += 1;
          done += n;
          sent += 1;
          if (sent % 50 === 0) log.info(`招募消耗进度：${fmt(done)}/${fmt(targets.recruit)}（已发 ${sent} 帧）`);
        }
        log[plan.stockShort ? "warning" : "success"](
          `招募消耗结束：本次 ${fmt(plan.willDo)}，累计 ${fmt(done)}/${fmt(targets.recruit)}` +
            (plan.stockShort
              ? `；⚠️ 招募令不足，还差 ${fmt(plan.remaining - plan.willDo)} 次，等黑市补货后再跑`
              : ""),
        );
        ev("fillup", { step: "recruit", done, target: targets.recruit, stockShort: !!plan.stockShort });
      }
    }
  }

  // ---------------------------------------------------------------- 2. 宝箱
  if (want("box")) {
    const activity = send("activity_get", {});
    const progress = readActivityProgress(activity);
    if (!progress || progress.boxScoreDone == null) {
      log.warning(
        progress
          ? `宝箱消耗跳过：活动 ${progress.activityId} 缺 task.2（宝箱）进度字段`
          : "宝箱消耗跳过：活动累积进度不可读",
      );
    } else {
      let role = send("role_getroleinfo", {});
      let accumulated = progress.boxScoreDone;
      log.info(
        `宝箱消耗开始（活动 ${progress.activityId}）：目标 ${fmt(targets.box)} / 已做 ${fmt(accumulated)} / 差值 ${fmt(Math.max(0, targets.box - accumulated))} / 宝箱库存 -`,
      );

      let round = 0;
      let noGrowthRounds = 0;
      const MAX_ROUNDS = 200;

      while (shouldKeepLooping(accumulated, role?.role?.items, targets.box)) {
        round += 1;
        if (round > MAX_ROUNDS) {
          log.warning(`宝箱推进循环超 ${MAX_ROUNDS} 轮，中止（当前累积 ${fmt(accumulated)}）`);
          break;
        }
        const openPlan = planOpenAll(role?.role?.items);
        if (openPlan.length === 0) {
          log.warning(
            `宝箱消耗暂停：积分不足且无箱可开（累积 ${fmt(accumulated)}/${fmt(targets.box)}），等商店补货后再跑`,
          );
          break;
        }
        // 全开
        let lastResp = null;
        for (const step of openPlan) {
          for (const n of chunkBatches(step.number, 10)) {
            lastResp = send("item_openbox", { itemId: step.itemId, number: n });
            stats.boxFrames += 1;
          }
        }
        // 积分全兑
        let claimed = 0;
        for (;;) {
          const r = lastResp?.role ?? {};
          const boxPoint = Number(r.boxPoint ?? 0) || 0;
          const pos = Number(r.boxPointLastReward ?? 0) || 0;
          if (pos < 0 || pos >= BOX_POINT_STEP_COSTS.length || claimed >= 3000) break;
          if (boxPoint < BOX_POINT_STEP_COSTS[pos]) break;
          lastResp = send("item_claimboxpointreward", {});
          stats.exchangeFrames += 1;
          claimed += 1;
        }
        if (claimed > 0) log.info(`宝箱推进第 ${round} 轮：开箱 ${fmt(openPlan.reduce((s, x) => s + x.number, 0))} 个，兑换 ${claimed} 档`);

        role = send("role_getroleinfo", {});
        const nextActivity = send("activity_get", {});
        const p2 = readActivityProgress(nextActivity);
        if (!p2 || p2.boxScoreDone == null) {
          log.warning("宝箱消耗中止：循环中进度变得不可读");
          break;
        }
        const next = p2.boxScoreDone;
        if (next === accumulated) {
          noGrowthRounds += 1;
          if (noGrowthRounds >= 2) {
            log.warning(`宝箱累积积分两轮无增长（仍 ${fmt(accumulated)}），中止以防死循环`);
            break;
          }
        } else {
          noGrowthRounds = 0;
        }
        accumulated = next;
        log.info(`宝箱推进第 ${round} 轮完成：累积 ${fmt(accumulated)}/${fmt(targets.box)}`);
      }

      // 差值精确开箱
      if (accumulated < targets.box) {
        const remaining = targets.box - accumulated;
        const { steps, remainingScore } = planPreciseOpen(remaining, role?.role?.items);
        log.info(
          `宝箱差值精确开箱：差 ${fmt(remaining)} 分，计划开 ${steps.map((s) => `${s.itemId}×${s.number}`).join("、") || "无"}`,
        );
        for (const step of steps) {
          for (const n of chunkBatches(step.number, 10)) {
            send("item_openbox", { itemId: step.itemId, number: n });
            stats.boxFrames += 1;
          }
        }
        if (remainingScore > 0) {
          log.warning(`宝箱消耗暂停：库存不足，还差 ${fmt(remainingScore)} 分，等商店补货后再跑`);
        } else {
          const after = send("activity_get", {});
          const p3 = readActivityProgress(after);
          accumulated = p3?.boxScoreDone ?? accumulated;
        }
      }
      if (accumulated >= targets.box) {
        log.success(`宝箱消耗结束：累积 ${fmt(accumulated)}/${fmt(targets.box)}（剩余积分保留不兑换）`);
        ev("fillup", { step: "box", done: accumulated, target: targets.box, stockShort: false });
      }
    }
  }

  // ---------------------------------------------------------------- 3. 钓鱼
  if (want("fish")) {
    const activity = send("activity_get", {});
    const progress = readActivityProgress(activity);
    if (!progress || progress.fishDone == null) {
      log.warning(
        progress
          ? `钓鱼消耗跳过：活动 ${progress.activityId} 缺 task.3（钓鱼）进度字段`
          : "钓鱼消耗跳过：活动累积进度不可读",
      );
    } else {
      const role = send("role_getroleinfo", {});
      const stock = Math.max(0, Math.floor(Number(role?.role?.items?.[ITEM_GOLD_ROD]) || 0));
      // 🔴 10% 返还：x 根可钓 x/0.9 次 —— 库存折算成「可钓次数」再判够不够
      const stockFishes = rodsToFishes(stock);
      const plan = planCountConsume({
        done: progress.fishDone,
        target: targets.fish,
        stock: stockFishes,
        batchSize: 10,
      });
      if (plan.reached) {
        log.success(
          `钓鱼消耗已达目标（目标 ${fmt(targets.fish)} / 已做 ${fmt(progress.fishDone)} / 差值 0 / 黄金鱼竿库存 ${fmt(stock)} 根 ≈ 可钓 ${fmt(stockFishes)} 次）`,
        );
      } else {
        log.info(
          `钓鱼消耗开始（活动 ${progress.activityId}）：目标 ${fmt(targets.fish)} / 已做 ${fmt(progress.fishDone)} / 差值 ${fmt(plan.remaining)} / 黄金鱼竿库存 ${fmt(stock)} 根 ≈ 可钓 ${fmt(stockFishes)} 次（10% 返还）`,
        );
        let done = progress.fishDone;
        let sent = 0;
        for (const n of plan.batches) {
          send("artifact_lottery", { type: 2, lotteryNumber: n, newFree: true });
          stats.fishFrames += 1;
          done += n;
          sent += 1;
          if (sent % 20 === 0) log.info(`钓鱼消耗进度：${fmt(done)}/${fmt(targets.fish)}（已发 ${sent} 帧）`);
        }
        log[plan.stockShort ? "warning" : "success"](
          `钓鱼消耗结束：本次 ${fmt(plan.willDo)}，累计 ${fmt(done)}/${fmt(targets.fish)}` +
            (plan.stockShort
              ? `；⚠️ 黄金鱼竿不足，还差 ${fmt(plan.remaining - plan.willDo)} 次，等商店补货后再跑`
              : ""),
        );
        ev("fillup", { step: "fish", done, target: targets.fish, stockShort: !!plan.stockShort });
      }
    }
  }

  ev("summary", { targets, stats });
  return { logs: log.lines, events, stats, targets };
};

// ================================================================== 收尾阶段

/**
 * 收尾阶段（原文第 129-137 行「完整的流程」）
 *
 * 周四(10月1日) 按顺序执行（master 2026-09-28 第 4 条澄清的顺序）：
 *   0. **补满**：宝箱 → 100000 分 / 招募 → 4000 次 / **钓鱼 → 1300 次（下限）**
 *   1. **领奖**：全量扫描「已完成未领」的档位，逐条 activity_claimtaskreward（「达成一轮领一轮」）
 *   2. **开全部普通道具**：item_openpack（**同时**返还招募令/铂金箱/金砖，期望值口径）
 *   3. **算缺口**：差 n 个特殊道具 → 按 25% 估算再要 4n 个普通道具
 *   4. **买鱼竿**：`planRodPurchase` 给出「买多少根原价鱼竿」——
 *      一笔金砖支出同时满足金砖任务与钓鱼任务（原文第 135 行）。**钓鱼继续往 1750 推**。
 *   5. **做钓鱼**：把新买的鱼竿用掉，推进钓鱼任务（`fishCap` = 1750 封顶）
 *   6. **再领奖 → 再开道具**，直到满 250 或资源耗尽
 *   7. 仍不够 → 报错 + 标记需要导出完整记录（原文第 136 行）
 */
export const runFinishPhase = (server, config = {}) => {
  const log = createLogger();
  /**
   * 结构化事件流（JSONL 的直接来源）。
   *
   * 🔴 master 2026-09-28：「如果搞不清楚，你可以生成一个更加可以结构化读取的 log，
   * 例如 jsonl，我下载了直接给你分析。」
   *
   * 设计原则：
   *   - 每行一个 JSON 对象、字段**全平铺**（jq / 肉眼都能直接读，不用先猜 schema）；
   *   - 人读日志（`log.*`）负责讲故事，事件流负责**对账**——两边不重复解析；
   *   - 关键诊断量（ledger / plan / postmortem）必须进事件流，文本日志只是它们的渲染。
   */
  const events = [];
  const ev = (event, data) => {
    events.push({ phase: "finish", event, seq: events.length, ...data });
  };
  const targetSpecial = Math.max(1, Math.floor(Number(config.targetSpecial) || 250));
  const packRate = Number.isFinite(Number(config.packRate)) ? Number(config.packRate) : 0.25;
  const rodPrice = Number.isFinite(Number(config.rodPrice))
    ? Number(config.rodPrice)
    : GOLDENFISH_ROD_PRICE;
  /**
   * 钓鱼任务的**硬上限** = 1750（20 轮全满）。
   * 🔴 master 第 4 条澄清：1300 只是**下限**，不是上限 —— 之前把它当上限，
   * 导致钓鱼只做 17 轮、本期道具上限被算成 978（实际 1050）。
   */
  const fishCap = Number.isFinite(Number(config.fishCap))
    ? Math.max(0, Math.floor(Number(config.fishCap)))
    : GOLDENFISH_FISH_FULL;
  /** 周四「先补满」这一步的钓鱼目标 = **1300 下限**（master 原话「首先把钓鱼补满 1300 次」） */
  const fillupFishTarget = Number.isFinite(Number(config.fillupFishTarget))
    ? Math.max(0, Math.floor(Number(config.fillupFishTarget)))
    : GOLDENFISH_FISH_MIN_TARGET;
  /**
   * 补档策略：
   *   - "master"：金砖先做满（原文第 134-135 行口径）
   *   - "minimal"：满足缺口的最小金砖支出
   *   - "twoForOne"：**2 轮金砖换 1 轮钓鱼**（master 2026-09-28 拍板）——
   *     可行解若满足「金砖可做 ≥2 轮 && 钓鱼还有档」，把 2 轮金砖（8 万）的份额
   *     改买 1 轮钓鱼的杆（135 根 = 8.1 万）：杆钱计入金砖任务 ⇒ 金砖进度不减、
   *     钓鱼白捡一档（24 道具）。判定/执行见 `twoForOneCandidate` + `plan.buildAt`。
   */
  const strategy =
    config.strategy === "minimal"
      ? "minimal"
      : config.strategy === "twoForOne"
        ? "twoForOne"
        : "master";
  const doFillup = config.fillup !== false;
  /**
   * 周四是否**先把钓鱼补到 1300**。
   *
   * 🔴 master 2026-09-28 第 4 条明确「**周四首先把钓鱼补满 1300 次**，然后看情况决定是否
   * 继续做下去」⇒ 默认 **true**（此前默认 false 是错的读法）。
   * ⚠️ 1300 是**下限**：之后由补档循环「买鱼竿」继续往 `fishCap`（1750）推，
   * 不会浪费 —— 买来的鱼竿照样要消耗掉，只是消耗上限从 1300 变成 1750。
   */
  const fillupFish = config.fillupFish !== false && Number(config.fillupFish) !== 0;

  const stats = {
    frames: 0,
    fillupFrames: 0,
    claimFrames: 0,
    claimFailures: 0,
    openpackFrames: 0,
    buyRodFrames: 0,
    lotteryFrames: 0,
    boughtRods: 0,
    goldSpent: 0,
    /** 兜底「补一轮金砖」执行的轮数（master 2026-09-28 口径：通常 1 次必够） */
    topups: 0,
    returns: { recruit: 0, platinumBox: 0, gold: 0, special: 0 },
    /** 期望值的小数总量（用来核对「实发整数」与「期望」的差，应 < 1 个/项） */
    returnsExact: { recruit: 0, platinumBox: 0, gold: 0 },
    /** 每批开包抽到的 bias（保底口径的诊断量，`runFinishPhase` 用） */
    packBiases: [],
    /** 每批开包的期望基线之和（= 本场「普通道具数 × 0.25」） */
    packBase: 0,
  };
  const send = (cmd, params) => {
    stats.frames += 1;
    return server.handle(cmd, params);
  };

  const readProgress = () => readActivityProgress(send("activity_get", {}));
  const slotMap = (p) => ({
    1: p.recruitDone ?? 0,
    2: p.boxScoreDone ?? 0,
    3: p.fishDone ?? 0,
    4: p.jarDone ?? 0,
    5: p.goldDone ?? 0,
  });
  const readSpecial = () => {
    const role = send("role_getroleinfo", {});
    return Math.max(0, Math.floor(Number(role?.role?.items?.[ITEM_PACK_SPECIAL]) || 0));
  };

  /** 全量领奖（已完成未领的档位逐条领） */
  const claimSweep = (label) => {
    const p = readProgress();
    if (!p) {
      log.warning(`${label}领奖中止：活动进度不可读`);
      return null;
    }
    const sweep = planClaimSweep(slotMap(p), p.record);
    let okCount = 0;
    let failCount = 0;
    for (const item of sweep.pending) {
      const resp = send("activity_claimtaskreward", {
        activityId: Number(p.activityId),
        missionId: item.missionId,
      });
      stats.claimFrames += 1;
      if (resp?.code) {
        failCount += 1;
        if (failCount === 1) {
          log.warning(`${label}领奖失败示例：missionId ${item.missionId} → ${resp.code} ${resp.error}`);
        }
      } else {
        okCount += 1;
      }
    }
    stats.claimFailures += failCount;
    log.success(
      `${label}领奖：待领 ${sweep.detected} 个档位（合计 ${sweep.items} 个普通道具），成功 ${okCount}，失败 ${failCount}`,
    );
    ev("claim", {
      label,
      detected: sweep.detected,
      items: sweep.items,
      okCount,
      failCount,
      firstFailure: failCount > 0 ? sweep.pending.find((x) => x.missionId) : null,
    });
    return sweep;
  };

  /** 开掉手上全部普通道具（**同时**返还招募令/铂金箱/金砖，期望值口径） */
  const openAllPacks = (label) => {
    const role = send("role_getroleinfo", {});
    const packs = Math.max(0, Math.floor(Number(role?.role?.items?.[ITEM_PACK_NORMAL]) || 0));
    if (packs <= 0) {
      log.info(`${label}：手上没有普通道具可开`);
      return { packs: 0, special: 0 };
    }
    const resp = send("item_openpack", { itemId: ITEM_PACK_NORMAL, index: 0, number: packs });
    stats.openpackFrames += 1;
    const r = resp.returns || {};
    const ex = r.exact || {};
    stats.returns.recruit += r.recruitGain || 0;
    stats.returns.platinumBox += r.platGain || 0;
    stats.returns.gold += r.goldGain || 0;
    stats.returns.special += resp.special || 0;
    stats.returnsExact.recruit += ex.recruitToken || 0;
    stats.returnsExact.platinumBox += ex.platinumBox || 0;
    stats.returnsExact.gold += ex.gold || 0;
    // 保底口径的诊断量：本批的期望基线 + 抽到的 bias
    const pb = resp.packBias || {};
    stats.packBiases.push(Number(pb.bias) || 0);
    stats.packBase += Number(pb.base) || 0;
    log.info(
      `${label}开掉普通道具 ${packs} 个 → 特殊道具 +${resp.special || 0}；` +
        `返还：招募令 +${r.recruitGain || 0} / 铂金箱 +${r.platGain || 0} / 金砖 +${r.goldGain || 0}`,
    );
    ev("open", {
      label,
      packs,
      gained: resp.special || 0,
      bias: Number(pb.bias) || 0,
      base: Number(pb.base) || 0,
      returns: {
        recruit: r.recruitGain || 0,
        platinumBox: r.platGain || 0,
        gold: r.goldGain || 0,
      },
    });
    return { packs, special: resp.special || 0 };
  };

  // ---------------------------------------------------------------- 步骤 0：补满
  if (doFillup) {
    log.info(
      fillupFish
        ? `周四补满三项：宝箱 → 100000 分、招募 → 4000 次、` +
            `钓鱼 → ${fillupFishTarget} 次（**下限**，之后「看情况」由买鱼竿继续推到 ${fishCap}）`
        : `周四补满：宝箱 → 100000 分、招募 → 4000 次（钓鱼不单独做，` +
            `留给第 6 步「买原价鱼竿」顺带完成 → ${fishCap}，见原文第 134-135 行）`,
    );
    const fillup = runConsumePhase(server, {
      recruitTarget: 4000,
      boxTarget: 100000,
      fishTarget: fillupFishTarget,
      steps: fillupFish ? ["recruit", "box", "fish"] : ["recruit", "box"],
    });
    for (const l of fillup.logs) {
      const text = `（补满）${l.text}`;
      if (l.level === "success") log.success(text);
      else if (l.level === "warning") log.warning(text);
      else log.info(text);
    }
    stats.fillupFrames = fillup.stats.frames;
    stats.frames += fillup.stats.frames;
  }

  /**
   * 档位总账 —— 让 master 一眼看出「还能拿多少」，不用自己拿 1050 去减。
   *
   * ⚠️ 2026-09-28 现场教训：日志只报「本次领了 N 个」，master 用 `1050 − N` 推断剩余，
   * 但 1050 里还有**更早时候已经领过**的那部分（`record` 里的档位），于是剩余被算多了，
   * 进一步误判成「明明还有空间，你为什么说凑不够」。⇒ 三段必须拆开、且必须**同量纲**。
   *
   * ⚠️ 位置很关键：必须在「步骤 1：领奖」**之前**算。否则本次待领的档位刚被领掉，
   * 「本次待领」会永远显示 0，`1050 = 已领 + 待领 + 剩余` 这条等式也就失去意义。
   */
  let ledger = null;
  {
    const p0 = readProgress();
    if (p0) {
      const sm = slotMap(p0);
      const pending = planClaimSweep(sm, p0.record);
      let restItems = 0;
      let restRounds = 0;
      for (const s of [1, 2, 3, 4, 5]) {
        const done = completedRounds(s, sm[s]);
        const total = taskTotals(s).rounds;
        restItems += rewardFromRoundTo(s, done, total);
        restRounds += Math.max(0, total - done);
      }
      const totalItems = totalRewardAllTasks();
      const sum = pending.claimedItems + pending.items + restItems;
      ledger = {
        total: totalItems,
        claimedItems: pending.claimedItems,
        claimedRounds: pending.alreadyClaimed,
        pendingItems: pending.items,
        pendingRounds: pending.detected,
        restItems,
        restRounds,
        /** 本次实际可用 = 待领 + 剩余（**不含**历次已领） */
        usable: pending.items + restItems,
        sum,
        consistent: sum === totalItems,
      };
      log.info(
        `档位总账：本期上限 ${totalItems} 个普通道具 = 历次已领 ${pending.claimedItems} 个（${pending.alreadyClaimed} 档）` +
          ` + 本次待领 ${pending.items} 个（${pending.detected} 档）` +
          ` + 剩余档位还能做 ${restItems} 个（${restRounds} 档）` +
          (sum === totalItems ? "" : `  ⚠️ 三段相加 ${sum} ≠ ${totalItems}（record 里有超出当前进度的档位，属异常）`),
      );
      log.info(
        `⇒ 本次实际可用 = 待领 ${pending.items} + 剩余 ${restItems} = ${pending.items + restItems} 个普通道具` +
          `（≈ ${Math.floor((pending.items + restItems) * packRate)} 个特殊道具）；` +
          `历次已领的 ${pending.claimedItems} 个早在之前的运行里发过了，**不在本次可用量里**` +
          ` —— 所以不要用 ${totalItems} − 本次领到的数 来反推剩余`,
      );
      ev("ledger", { ...ledger });
    }
  }

  /**
   * 罐子（slot 4）档位「自然完成」→ 白送的普通道具直接开掉。
   *
   * 与纯逻辑 `simulateFinish` 的 free 步同源：罐子不靠买鱼竿推进（原文口径：自然完成），
   * 剩余轮次的奖励是白送的，判定「能不能凑够」时必须算进来（`plan.freeItems`），
   * 开包时也必须真的开掉 —— 否则判可行了却没开，平白少一批道具。
   * 罐子消耗命令尚未抓包 ⇒ 这里只做「发放 + 开包」的模拟，不发帧。
   */
  {
    const pFree = readProgress();
    if (pFree) {
      const freeItems = rewardFromRoundTo(
        4,
        completedRounds(4, slotMap(pFree)[4]),
        taskTotals(4).rounds,
      );
      if (freeItems > 0) {
        const r = openAllPacks(`罐子自然完成白送 ${freeItems} 个 → `);
        // 🔴 罐子视作「自然完成」：把 task.4 写满（与纯逻辑 simulateFinish 的 free 步对齐），
        //    否则 freeItems 会被后续每轮 planRodPurchase 重复计入 ⇒ minimal 恒 0 根 ⇒ 空转。
        server.forceTask(GOLDENFISH_TASK_SLOTS.jar, taskTotals(4).maxThreshold);
        ev("free", { packs: freeItems, gained: r.special });
      }
    }
  }

  // ---------------------------------------------------------------- 步骤 1：领奖
  claimSweep("补满后");

  // ---------------------------------------------------------------- 步骤 2：开全部普通道具
  openAllPacks("收尾第一步");
  let special = readSpecial();
  log.info(`当前特殊道具 ${special}/${targetSpecial}（目标 250）`);

  // ---------------------------------------------------------------- 步骤 3-6：补档循环
  const rounds = [];
  /** 最后一轮的购买计划（诊断用：失败时看 blockedBy / goldShortfall 就知道卡在哪） */
  let lastPlan = null;
  let reason = special >= targetSpecial ? "reached" : "";
  let iteration = 0;
  /**
   * 🔴 迭代上限 12（2026-09-28 从 5 上调）：twoForOne 是「半步」节奏——
   * 每轮固定买 1 轮钓鱼的杆（135 根 → 48 道具 → 特殊 +12 左右），
   * 缺口 ~50 个特殊时需要 ~5 轮，5 次上限会在 248/250 处假性失败（UI 冒烟实测踩到）。
   * 12 = 最坏情况（每轮 fallback 小步补 + bias 波动）也留足余量。
   * ⚠️ 可用 config.maxIterations 覆盖（冒烟用 1 来强测「兜底补金砖」路径）。
   */
  const MAX_ITER = Math.max(1, Math.floor(Number(config.maxIterations) || 12));

  while (special < targetSpecial && iteration < MAX_ITER) {
    iteration += 1;
    const gap = targetSpecial - special;
    const needItems = packsNeededForGap(gap, packRate);
    const p = readProgress();
    if (!p) {
      reason = "活动进度不可读";
      break;
    }
    const role = send("role_getroleinfo", {});
    const goldStock = Math.max(0, Math.floor(Number(role?.role?.gold) || 0));
    const rodStock = Math.max(0, Math.floor(Number(role?.role?.items?.[ITEM_GOLD_ROD]) || 0));
    const plan = planRodPurchase({
      progressBySlot: slotMap(p),
      needItems,
      rodPrice,
      fishCap,
      goldInStock: goldStock,
      rodsInStock: rodStock,
    });
    let picked = null;
    let traded = false;
    let tradeInfo = null; // 2 换 1 判定上下文（换/不换都留痕，master 对账要用）
    if (strategy === "minimal") {
      picked = plan.minimal;
    } else if (strategy === "twoForOne") {
      // 🔴 master 2026-09-28 拍板：可行解若满足「金砖可做 ≥2 轮 && 钓鱼还有档」，
      //    就用 2 轮金砖（8 万）的份额换 1 轮钓鱼（135 根 = 8.1 万）——
      //    杆钱计入金砖任务 ⇒ 金砖进度不减、钓鱼白捡一档。
      //    换出的方案可能不满足本轮 needItems（半步），循环重估缺口即可。
      tradeInfo = twoForOneCandidate(slotMap(p), { rodPrice });
      const candidate = tradeInfo.apply && plan.buildAt ? plan.buildAt(tradeInfo.rods) : null;
      const fallback = plan.minimal ?? plan.master;
      if (
        candidate &&
        (!fallback || candidate.goldSpend <= fallback.goldSpend) &&
        goldStock >= candidate.goldSpend
      ) {
        picked = candidate;
        traded = true;
      } else {
        picked = fallback;
      }
    } else {
      picked = plan.master;
    }
    lastPlan = plan; // 留档，收尾失败时随结果一起返回
    /**
     * 三件事必须分开报，否则 master 无法判断「到底卡在哪」：
     *   ① 档位还有多少空间（买杆能拿 + 罐子白送）
     *   ② 「做满」需要多少金砖、手上多少、差多少
     *   ③ 本次实际买得起多少根、能拿多少
     */
    log.info(
      `缺口 ${gap} 个特殊道具（≈ 需 ${needItems} 个普通道具）｜` +
        `档位上限：买杆可拿 ${plan.maxItems} + 罐子白送 ${plan.freeItems} = ${plan.maxTotal} 个`,
    );
    log.info(
      `金砖预算：做满金砖任务需买 ${plan.rodsWanted} 根 = ${plan.goldNeeded} 金砖，` +
        `手上只有 ${goldStock}` +
        (plan.goldShortfall > 0
          ? `（**差 ${plan.goldShortfall}**）→ 只买得起 ${plan.rodsAffordable ?? "∞"} 根`
          : `（够）`),
    );
    log.info(
      `按「${traded ? "2换1" : strategy === "minimal" ? "最小代价" : strategy === "twoForOne" ? "最小代价（窗口不足退回）" : "金砖做满"}」` +
        `方案买 ${picked?.rods ?? 0} 根原价鱼竿` +
        `（花 ${picked?.goldSpend ?? 0} 金砖）→ 可得 ${picked?.items ?? 0} 个普通道具` +
        `（含罐子白送 ${plan.freeItems} 共 ${picked?.totalItems ?? 0} 个）` +
        (traded ? "｜2 轮金砖份额 → 1 轮钓鱼（杆钱计入金砖任务，白捡一档）" : ""),
    );
    ev("plan", {
      iteration,
      gap,
      needItems,
      strategy,
      traded,
      // 2 换 1 的判定上下文（换/不换都要留痕：goldLeft/fishLeft/reason）
      tradeGoldLeft: tradeInfo?.goldLeft ?? null,
      tradeFishLeft: tradeInfo?.fishLeft ?? null,
      tradeApply: tradeInfo?.apply ?? null,
      tradeReason: tradeInfo?.reason ?? null,
      goldInStock: goldStock,
      rodsInStock: rodStock,
      blockedBy: plan.blockedBy,
      ok: plan.ok,
      reason: plan.reason,
      rodsWanted: plan.rodsWanted,
      goldNeeded: plan.goldNeeded,
      goldShortfall: plan.goldShortfall,
      rodsAffordable: plan.rodsAffordable,
      maxItems: plan.maxItems,
      freeItems: plan.freeItems,
      maxTotal: plan.maxTotal,
      picked: picked
        ? {
            rods: picked.rods,
            goldSpend: picked.goldSpend,
            items: picked.items,
            totalItems: picked.totalItems,
            goldAfter: picked.goldAfter,
            fishAfter: picked.fishAfter,
          }
        : null,
    });
    // 已经无档位可推进（双满 / 库存耗尽 / 真榨干）→ 立即中止，别空转
    if (!picked || picked.totalItems <= 0) {
      reason = plan.reason || "已无可推进的档位";
      log.warning(`补档中止：${reason}`);
      break;
    }
    if (!plan.ok) {
      if (plan.blockedBy === "gold") {
        // 🔴 卡在金砖 —— 不是档位榨干，报错文案必须区分（见 2026-09-28 master 反馈）。
        //    仍然把**买得起**的那部分档位换掉，别浪费；但别指望「返还金砖再买一轮」：
        //    一根鱼竿 600 金砖，134 根只产出 41 个道具、每个返 107.304 ⇒ 每根杆回收 ~32 金砖，
        //    远不够再买一根 ⇒ 返还**不成自给**，这轮做完就收工。
        log.warning(`金砖不足，凑不够：${plan.reason} —— 仍先把买得起的档位换掉（返还自给不了，做完这轮收工）`);
      } else {
        log.warning(`即使把金砖做满 + 钓鱼补到上限也凑不够：${plan.reason} —— 仍先执行剩余档位`);
      }
    }

    // 买鱼竿（同时推进金砖任务）
    if (picked.rods > 0) {
      const resp = send("buy_rod", { count: picked.rods });
      stats.buyRodFrames += 1;
      stats.boughtRods += resp.bought || 0;
      stats.goldSpent += resp.spend || 0;
      log.info(
        `购买原价鱼竿 ${resp.bought} 根（花 ${resp.spend} 金砖，单价 ${rodPrice}）` +
          `→ 金砖消耗任务进度 ${picked.goldAfter}`,
      );
      ev("buyRod", {
        iteration,
        rods: resp.bought || 0,
        spend: resp.spend || 0,
        goldProgressAfter: picked.goldAfter,
      });
    }

    // 做钓鱼（把鱼竿用掉，同时推进钓鱼任务）
    const beforeFish = slotMap(p)[3] || 0;
    const needFish = Math.max(0, Math.min(picked.fishAfter, fishCap) - beforeFish);
    if (needFish > 0) {
      for (const n of chunkBatches(needFish, 10)) {
        send("artifact_lottery", { type: 2, lotteryNumber: n, newFree: true });
        stats.lotteryFrames += 1;
      }
      log.info(`钓鱼消耗 ${needFish} 次 → 钓鱼任务进度 ${picked.fishAfter}/${fishCap}`);
      ev("fish", { iteration, count: needFish, progressAfter: picked.fishAfter, cap: fishCap });
    } else if (picked.rods > 0 && beforeFish >= fishCap) {
      // 周四「补满」已把钓鱼推到上限，这轮买的鱼竿对钓鱼任务没有额外增益
      log.warning(
        `本轮买的 ${picked.rods} 根鱼竿对钓鱼任务**无增益**（钓鱼已封顶 ${fishCap}）` +
          `→ 只有金砖任务那头在产出道具`,
      );
    }

    claimSweep(`补档第 ${iteration} 轮`);
    const opened = openAllPacks(`补档第 ${iteration} 轮`);
    special = readSpecial();
    rounds.push({
      iteration,
      gap,
      needItems,
      traded,
      rods: picked.rods,
      goldSpend: picked.goldSpend,
      goldAfter: picked.goldAfter,
      fishAfter: picked.fishAfter,
      items: picked.items,
      packs: opened.packs,
      gained: opened.special,
      special,
    });
    log.info(`补档第 ${iteration} 轮完成：特殊道具 ${special}/${targetSpecial}`);
    ev("round", { iteration, packs: opened.packs, gained: opened.special, specialAfter: special });
    // 这一轮已经是「榨干上限」的最后一轮 ⇒ 再循环也只会拿到 0 个道具，直接收工报错
    if (!plan.ok && special < targetSpecial) {
      reason = plan.reason;
      break;
    }
  }

  // ---------------------------------------------------------------- 步骤 6.5：兜底补金砖
  /**
   * 🔴 最后兜底（master 2026-09-28 原话）：「最后的兜底手段——如果运气不好还差几个
   *     特殊道具的话，就补一轮金砖……补一轮金砖一定会够的，不存在补不够的情况」。
   *
   * 依据：游戏对特殊道具出率有**强控制**（实际紧贴 25%，偏差极小），按 25% 找到的
   * 可行解落地后缺口只剩几个 ⇒ 一轮金砖（≈4 万金砖 → 12 个道具 → 期望 +3 特殊）必过线。
   *
   * 触发条件：主循环结束仍未达标，但金砖**还有档**且买得起跨过下一轮阈值。
   * 这是金砖 46 万收敛线的**合法例外**（第 20 轮平时不做，保命时随叫随到）；
   * 但不会越过 50 万 —— 20 轮做完还缺就是真·无解，兜底也无能为力。
   * 与纯逻辑 `simulateFinish` 的 topup 步同源；可用 config.goldTopUp:false 关闭做对照。
   */
  if (config.goldTopUp !== false) {
    while (special < targetSpecial && stats.topups < 3) {
      const pTop = readProgress();
      if (!pTop) break;
      const smTop = slotMap(pTop);
      const goldDoneNow = completedRounds(5, smTop[5]);
      const nextRow = buildRoundTable(5)[goldDoneNow];
      if (!nextRow) break; // 金砖 20 轮已榨干 → 真·无解
      const goldNeeded = Math.max(0, nextRow.threshold - smTop[5]);
      const rodsWant = Math.ceil(goldNeeded / rodPrice);
      if (rodsWant <= 0) break;
      const roleTop = send("role_getroleinfo", {});
      const goldAvail = Math.max(0, Math.floor(Number(roleTop?.role?.gold) || 0));
      if (goldAvail < rodsWant * rodPrice) {
        log.warning(
          `【兜底】金砖不足：跨过第 ${goldDoneNow + 1} 轮需买 ${rodsWant} 根（${rodsWant * rodPrice} 金砖），手上只有 ${goldAvail}`,
        );
        break;
      }
      stats.topups += 1;
      const gapBefore = Math.max(0, targetSpecial - special);
      log.info(
        `【兜底】还差 ${gapBefore} 个特殊道具 → 补第 ${stats.topups} 轮金砖：` +
          `买 ${rodsWant} 根原价鱼竿（${rodsWant * rodPrice} 金砖）跨过第 ${goldDoneNow + 1} 轮` +
          `（游戏强控制出率贴 25%，一轮必够 —— master 2026-09-28 拍板）`,
      );
      const respTop = send("buy_rod", { count: rodsWant });
      stats.buyRodFrames += 1;
      stats.boughtRods += respTop.bought || 0;
      stats.goldSpent += respTop.spend || 0;
      ev("buyRod", {
        iteration: iteration + stats.topups,
        topup: true,
        rods: respTop.bought || 0,
        spend: respTop.spend || 0,
        goldProgressAfter: smTop[5] + (respTop.spend || 0),
      });
      // 买来的杆照例消耗掉（钓鱼有余量就顺带推进，没有就只吃金砖任务）
      const fishNowTop = smTop[3] || 0;
      const fishAfterTop = Math.min(fishCap, fishNowTop + rodsToFishes(respTop.bought || 0));
      const needFishTop = Math.max(0, fishAfterTop - fishNowTop);
      if (needFishTop > 0) {
        for (const n of chunkBatches(needFishTop, 10)) {
          send("artifact_lottery", { type: 2, lotteryNumber: n, newFree: true });
          stats.lotteryFrames += 1;
        }
        ev("fish", {
          iteration: iteration + stats.topups,
          topup: true,
          count: needFishTop,
          progressAfter: fishAfterTop,
          cap: fishCap,
        });
      }
      claimSweep(`兜底第 ${stats.topups} 轮`);
      const openedTop = openAllPacks(`兜底第 ${stats.topups} 轮`);
      special = readSpecial();
      const goldRoundAfterTop = completedRounds(5, smTop[5] + (respTop.spend || 0));
      const itemsTop =
        rewardFromRoundTo(5, goldDoneNow, goldRoundAfterTop) +
        rewardFromRoundTo(3, completedRounds(3, fishNowTop), completedRounds(3, fishAfterTop));
      rounds.push({
        iteration: iteration + stats.topups,
        topup: true,
        gap: gapBefore,
        rods: respTop.bought || 0,
        goldSpend: respTop.spend || 0,
        items: itemsTop,
        packs: openedTop.packs,
        gained: openedTop.special,
        special,
      });
      log.info(`【兜底】第 ${stats.topups} 轮完成：特殊道具 ${special}/${targetSpecial}`);
      ev("round", {
        iteration: iteration + stats.topups,
        topup: true,
        packs: openedTop.packs,
        gained: openedTop.special,
        specialAfter: special,
      });
    }
  }

  if (special >= targetSpecial) reason = "reached";
  else if (iteration >= MAX_ITER) reason = `迭代上限 ${MAX_ITER} 次`;
  else if (!reason) reason = "资源不足";

  const ok = special >= targetSpecial;
  log[ok ? "success" : "error"](
    ok
      ? `收尾完成：特殊道具 ${special}/${targetSpecial} ✅ 可以召唤金鱼`
      : `收尾失败：特殊道具 ${special}/${targetSpecial}（${reason}）` +
          `→ 按原文第 136 行，应向用户报错并提供**完整记录下载**`,
  );

  /**
   * 失败时必须回答 master 必问的那一句：「**做满到底能不能拿鱼？**」
   *
   * 做法：把金砖设成 ∞ 再跑一次同一套购买计划（纯函数、零成本）——
   *   - `ideal.ok === true`  ⇒ **做满本可以拿到鱼**，这次唯一卡点是**金砖不够**，
   *                            并报出「做满还差多少金砖」，这才是用户能行动的信息；
   *   - `ideal.ok === false` ⇒ 即使金砖管够也凑不够，这是**真·无解**（档位上限就不够），
   *                            别再让用户去攒金砖白忙。
   *
   * 2026-09-28 现场教训：没有这段时，日志只会说「凑不够」，master 无从区分是「钱不够」还是「路走死了」。
   */
  if (!ok) {
    const pEnd = readProgress();
    if (pEnd) {
      const roleEnd = send("role_getroleinfo", {});
      const goldNow = Math.max(0, Math.floor(Number(roleEnd?.role?.gold) || 0));
      const rodNow = Math.max(0, Math.floor(Number(roleEnd?.role?.items?.[ITEM_GOLD_ROD]) || 0));
      const gapNow = Math.max(0, targetSpecial - special);
      const needNow = packsNeededForGap(gapNow, packRate);
      const ideal = planRodPurchase({
        progressBySlot: slotMap(pEnd),
        needItems: needNow,
        rodPrice,
        fishCap,
        goldInStock: Infinity,
        rodsInStock: rodNow,
      });
      const reach = ledger?.usable ?? 0;
      const reachable = reach * packRate >= targetSpecial;
      log.info(
        `复盘·理论上限：把手上所有档位榨干 = ${ledger?.pendingItems ?? 0}（待领）+ ${ledger?.restItems ?? 0}（剩余）= ` +
          `${reach} 个普通道具 ≈ ${Math.floor(reach * packRate)} 个特殊道具` +
          `（目标 ${targetSpecial}）⇒ ${reachable ? "**做满本可以拿鱼**" : "做满也不够"}`,
      );
      if (ideal.ok) {
        log.info(
          `复盘·卡点：**金砖不足**是唯一原因 —— 把剩余档位做满还需 ${ideal.goldNeeded} 金砖` +
            `（≈ ${ideal.rodsWanted} 根鱼竿 × ${rodPrice}），手上只有 ${goldNow}` +
            `（差 ${Math.max(0, ideal.goldNeeded - goldNow)}）；` +
            `金砖管够的话本次可再拿 ${ideal.maxTotal} 个道具 → 预计特殊道具 ` +
            `${Math.floor(special + ideal.maxTotal * packRate)}/${targetSpecial} ✅`,
        );
      } else {
        log.warning(
          `复盘·卡点：**即使金砖管够也凑不够**（真·无解）—— ${ideal.reason}` +
            `；档位上限只有 ${ideal.maxTotal} 个道具，缺口需要 ${needNow} 个`,
        );
      }
      ev("postmortem", {
        ok,
        reachable, // true = 做满本可以拿鱼（缺钱）；false = 真·无解（档位榨干）
        usableItems: reach,
        expectedSpecialIfAll: Math.floor(reach * packRate),
        targetSpecial,
        specialNow: special,
        remainingGap: gapNow,
        goldInStock: goldNow,
        idealGoldNeeded: ideal.goldNeeded,
        idealGoldShortfall: Math.max(0, ideal.goldNeeded - goldNow),
        idealRodsWanted: ideal.rodsWanted,
        idealMaxTotal: ideal.maxTotal,
        idealItemsPerGold: ideal.maxTotal > 0 ? ideal.goldNeeded / ideal.maxTotal : null,
        verdict: ideal.ok ? "gold-blocked" : "unsolvable",
      });
    }
  }

  ev("summary", {
    ok,
    special,
    targetSpecial,
    reason,
    strategy,
    fishCap,
    goldSpent: stats.goldSpent,
    rodsBought: stats.boughtRods,
    topups: stats.topups,
    packBase: stats.packBase,
    packBiases: stats.packBiases,
    ledger,
  });

  return {
    logs: log.lines,
    events,
    stats,
    ok,
    reason,
    special,
    targetSpecial,
    rounds,
    strategy,
    /** 兜底「补一轮金砖」执行轮数（0 = 主循环自己收敛，没用到保命手段） */
    topups: stats.topups,
    fillupFish,
    fillupFishTarget,
    fishCap,
    packBiases: stats.packBiases,
    packBase: stats.packBase,
    /** 档位总账（三段同量纲：已领 / 待领 / 剩余，合计 = 1050） */
    ledger,
    lastPlan,
    needsManualDump: !ok,
  };
};

// ================================================================== 全流程

/**
 * 开包模型摘要
 *
 * 🔴 master 2026-09-28 口径：**有保底** ⇒ `特殊道具数 = round(普通道具数 × rate + bias)`，
 * `bias ∈ [-5, 5]` 的整数、概率**线性**（峰在 0），不引入正态分布。
 * `rate` 是单次期望（0.25）；`bias` 每次开包调用各抽一次。
 */
const buildPackModel = (preset = {}) => {
  const rate = Number.isFinite(Number(preset.packRate)) ? Number(preset.packRate) : 0.25;
  return { rate, model: "bounded-linear-bias", biasMax: GOLDENFISH_PACK_BIAS_MAX };
};

/**
 * 全流程：消耗（招募→宝箱→钓鱼）→ 收尾（领奖→开道具→补档）
 * @returns {{timeline:Array, report:object, ok:boolean}}
 */
export const runFullSimulation = (preset = {}) => {
  const seed = Math.floor(Number(preset.seed) || 20260928);
  // 可复现 RNG（与 goldenfishFinishPlan.createRng 同族，独立实例避免与虚拟服务端互相消耗）
  let state = seed >>> 0 || 1;
  const rng = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const server = createSimServer({
    ...preset,
    rng,
    packRate: preset.packRate,
  });

  const phase1 = runConsumePhase(server, preset);
  const phase2 = runFinishPhase(server, preset);

  const items = server.items;
  const task = server.task;
  const roundInfo = {};
  for (const slot of [1, 2, 3, 4, 5]) {
    const done = completedRounds(slot, task[slot]);
    roundInfo[slot] = {
      name: GOLDENFISH_UNIT_LABELS[slot],
      progress: Math.max(0, Math.floor(Number(task[slot]) || 0)),
      rounds: done,
      maxRounds: taskTotals(slot).rounds,
      maxThreshold: taskTotals(slot).maxThreshold,
    };
  }

  const timeline = [
    ...phase1.logs.map((l) => ({ phase: "消耗", ...l })),
    ...phase2.logs.map((l) => ({ phase: "收尾", ...l })),
  ];

  /**
   * 本期**实际可得**的普通道具上限。
   *
   * 五类档位全满名义上是 1050（原文第 85 行）。🔴 master 2026-09-28 第 4 条澄清后，
   * 钓鱼的硬上限是 `fishCap`（默认 **1750** = 20 轮全满）⇒ 五类全满 ⇒ 上限 = **1050**。
   *
   * ⚠️ 曾经的错误：把 1300 当钓鱼上限 ⇒ 钓鱼只到 17/20 轮 ⇒ 上限被算成 978，
   * 进而错误地得出「凑 250 只有 ~20% 成功率」。这个数才是「够不够凑 250」的分母。
   */
  const fishCapUsed = Number.isFinite(Number(preset.fishCap))
    ? Math.max(0, Math.floor(Number(preset.fishCap)))
    : GOLDENFISH_FISH_FULL;
  const capRounds = {
    1: taskTotals(1).rounds,
    2: taskTotals(2).rounds,
    3: completedRounds(3, fishCapUsed),
    4: taskTotals(4).rounds,
    5: taskTotals(5).rounds,
  };
  const itemsCeiling = [1, 2, 3, 4, 5].reduce(
    (sum, slot) => sum + rewardFromRoundTo(slot, 0, capRounds[slot]),
    0,
  );

  const report = {
    targets: phase1.targets,
    rounds: roundInfo,
    items: {
      recruitToken: Math.max(0, Math.floor(Number(items[ITEM_RECRUIT]) || 0)),
      goldRod: Math.max(0, Math.floor(Number(items[ITEM_GOLD_ROD]) || 0)),
      gold: Math.max(0, Math.floor(Number(server.gold) || 0)),
      packNormal: Math.max(0, Math.floor(Number(items[ITEM_PACK_NORMAL]) || 0)),
      packSpecial: Math.max(0, Math.floor(Number(items[ITEM_PACK_SPECIAL]) || 0)),
      chests: Object.fromEntries(
        Object.keys(CHEST_POINTS).map((id) => [id, Math.max(0, Math.floor(Number(items[id]) || 0))]),
      ),
    },
    boxPoint: server.boxPoint,
    totalItemsFromTasks: totalRewardAllTasks(),
    itemsCeiling,
    itemsCeilingBySlot: capRounds,
    commandStats: {
      consume: phase1.stats,
      finish: phase2.stats,
      totalFrames: phase1.stats.frames + phase2.stats.frames,
    },
    calls: server.calls,
    packModel: buildPackModel(preset),
    /** 结构化事件流（JSONL 导出的数据源，master 直接下载给我分析的那种）。
     *  两段事件合并后**统一重编 seq**，保证 JSONL 里 seq 严格连续（对账用）。 */
    events: (() => {
      const all = [...(phase1.events || []), ...(phase2.events || [])];
      all.forEach((e, i) => {
        e.seq = i;
      });
      return all;
    })(),
    finishResult: {
      ok: phase2.ok,
      reason: phase2.reason,
      special: phase2.special,
      targetSpecial: phase2.targetSpecial,
      strategy: phase2.strategy,
      fillupFish: phase2.fillupFish,
      fillupFishTarget: phase2.fillupFishTarget,
      fishCap: phase2.fishCap,
      rounds: phase2.rounds,
      goldSpent: phase2.stats.goldSpent,
      rodsBought: phase2.stats.boughtRods,
      topups: phase2.stats.topups,
      returns: phase2.stats.returns,
      returnsExact: phase2.stats.returnsExact,
      packBiases: phase2.stats.packBiases,
      packBase: phase2.stats.packBase,
      /** 档位总账（已领 / 待领 / 剩余，同量纲）—— UI 与冒烟都靠它回答「还能拿多少」 */
      ledger: phase2.ledger,
      /** 最后一轮购买计划：`blockedBy` 区分「金砖不足」与「档位榨干」 */
      lastPlan: phase2.lastPlan,
      needsManualDump: phase2.needsManualDump,
    },
  };

  return { timeline, report, ok: phase2.ok };
};

export default {
  createSimServer,
  runConsumePhase,
  runFinishPhase,
  runFullSimulation,
  ITEM_RECRUIT,
  ITEM_GOLD_ROD,
  ITEM_PACK_NORMAL,
  ITEM_PACK_SPECIAL,
  ROD_UNIT,
  ACTIVITY_ID,
};
