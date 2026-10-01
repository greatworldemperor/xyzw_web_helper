/**
 * 金鱼收尾阶段 · 纯逻辑（master 2026-10-01 12 步口径，**以此为准**）
 *
 * 与 `goldenfishFinishPlan.js` 的关系：那个文件是**旧的收尾模型**（2 换 1 + 兜底补金砖 +
 * simulateFinish 蒙特卡洛），信号复杂、含历史包袱。本模块按 master 2026-10-01 明确重申的
 * **12 步流程**重新实现，作为收尾执行的唯一权威口径；旧模型保留仅供对照，不再驱动生产。
 *
 * ── 12 步（原文，以此为准） ─────────────────────────────────────────────
 *  1. 宝箱做到 10 万积分
 *  2. 招募做到 4000 个
 *  3. 领取所有金鱼消耗任务的进度奖励
 *  4. 打开所有普通金鱼道具(5287)
 *  5. 购买原价鱼竿(600/根)，把总金砖消费进度拉到 42 万
 *     （不精确也行，步长 600 金砖本来就不可能精确到 1 金砖）
 *  6. 钓鱼任务进度拉到 1300 次
 *  7. 领取所有金鱼消耗任务的进度奖励
 *  8. 打开所有普通金鱼道具(5287)
 *  9. 观察 5288 数量 n，计算 r = 250 − n
 * 10. 按 4 个普通道具出 1 个特殊道具估算：m = r × 4
 * 11. 用「一档钓鱼 24 个 / 一档金砖 12 个」凑整数解 x,y 使 24x + 12y ≥ m，
 *     求 argmin(24x + 12y − m)（浪费尽量少）；并列时 **y 尽可能大**。
 *     可行域极小：做到 42 万后剩余金砖档 y ≤ 2，做到 1300 后剩余钓鱼档 x ≤ 3。
 * 12. 按最优解执行：x 轮钓鱼（每轮 150 次）+ y 轮金砖（每轮 4 万金砖 ≈ ceil(40000/600)=67 根原价竿）
 *     ⚠️ 每轮做完就补一次「13+14」，并检查是否已达标 ⇒ **达成即停**。
 * 13. 再次领取全部进度任务奖励
 * 14. 再次打开全部金鱼普通道具(5287)
 * 15. 判断 5288 是否满 250：满了 = 成功，否则 = **失败**
 * 16. 所有失败角色汇总成**失败列表**并支持**下载**（master 手动补做）
 *
 * ── master 2026-10-01 补充口径（问答确认） ──────────────────────────────
 *  - 鱼竿折算：**钓 n 次净耗 n × 0.9 根**（10% 返还）。复用 `fishesToRods`，不要写 1/0.9。
 *  - 钓鱼竿来源：**优先用背包现有库存**；不够就用金砖多买（金砖进度可继续推到 46 万甚至拉满 50 万）；
 *    若仍不够或金砖也不够 ⇒ **标记为失败**（不硬凑）。
 *  - **达成即停**：任一时刻读出 5288 ≥ 250 就立刻结束，不再买竿/钓鱼/凑数。
 */

import {
  GOLDENFISH_TIERS,
  GOLDENFISH_ROD_PRICE,
  GOLDENFISH_FISH_FULL,
  GOLDENFISH_GOLD_UNIT,
  buildRoundTable,
  completedRounds,
  fishesToRods,
  taskTotals,
  toMissionId,
} from "./goldenfishFinishPlan.js";

/** 收尾目标常量（12 步里出现的所有数字集中在这一处，改口径只改这里） */
export const GOLDENFISH_FINISH_TARGETS = Object.freeze({
  /** 第 1 步：宝箱积分 */
  boxScore: 100000,
  /** 第 2 步：招募次数 */
  recruit: 4000,
  /** 第 5 步：金砖消费进度目标 */
  goldProgress: 420000,
  /** 第 5 步兜底：鱼竿不够时允许把金砖继续推到这一档 */
  goldProgressFallback: 460000,
  /** 金砖任务满值（拉满 50 万） */
  goldProgressMax: 500000,
  /** 第 6 步：钓鱼次数 */
  fishCount: 1300,
  /** 第 9 步：金鱼特殊道具目标 */
  specialTarget: 250,
  /** 第 10 步：多少个普通道具折 1 个特殊道具 */
  packsPerSpecial: 4,
  /** 原价鱼竿单价 */
  rodPrice: GOLDENFISH_ROD_PRICE, // 600
  /** 金砖任务槽位 */
  goldSlot: 5,
  /** 钓鱼任务槽位 */
  fishSlot: 3,
  /** 宝箱任务槽位 */
  boxSlot: 2,
  /** 招募任务槽位 */
  recruitSlot: 1,
});

/**
 * 某槽位在 `(fromProgress, toProgress]` 区间内**尚未完成**的轮次明细
 *
 * 用途：第 11 步要按「现在还剩几档」划定 x/y 的可行域，以及每档的消耗与产出。
 * 例：金砖 42 万 → 还剩轮 19/20（2 档，每档 4 万金砖、产 12 个）；
 *     钓鱼 1300 → 还剩轮 18/19/20（3 档，每档 150 次、产 24 个）。
 *
 * @param {number} slot
 * @param {number} fromProgress 起点进度（含）
 * @param {number} [toProgress] 上限进度（含），默认该槽位满值
 * @returns {Array<{round:number, cost:number, reward:number, threshold:number}>}
 */
export const remainingRoundRows = (slot, fromProgress, toProgress) => {
  const total = taskTotals(slot);
  const capProgress = Number.isFinite(Number(toProgress))
    ? Number(toProgress)
    : total.maxThreshold;
  const done = completedRounds(slot, fromProgress);
  const cap = completedRounds(slot, capProgress);
  if (cap <= done) return [];
  return buildRoundTable(slot).slice(done, cap);
};

/** 某槽位当前进度下**还能拿到的档数** */
export const remainingRoundCount = (slot, fromProgress, toProgress) =>
  remainingRoundRows(slot, fromProgress, toProgress).length;

/** 某槽位剩余档位的统一产出（取最小值，保守）；无剩余档返回 0 */
export const remainingRewardPerRound = (slot, fromProgress, toProgress) => {
  const rows = remainingRoundRows(slot, fromProgress, toProgress);
  if (rows.length === 0) return 0;
  return rows.reduce((min, row) => Math.min(min, row.reward), rows[0].reward);
};

/** 某槽位剩余档位的统一消耗（取最大值，保守）；无剩余档返回 0 */
export const remainingCostPerRound = (slot, fromProgress, toProgress) => {
  const rows = remainingRoundRows(slot, fromProgress, toProgress);
  if (rows.length === 0) return 0;
  return rows.reduce((max, row) => Math.max(max, row.cost), rows[0].cost);
};

/**
 * 第 11 步：凑整数解 `x`（钓鱼档）`y`（金砖档）
 *
 * 目标：`24x + 12y ≥ m`，先最小化浪费 `24x + 12y − m`，**并列时 y 尽可能大**。
 *
 * 为什么并列时取 y 大：两档产出是 2 倍关系 ⇒ `(x, y)` 与 `(x+1, y−2)` 等价，
 * 取 y 大 = 少钓鱼、多花金砖，把「钓鱼次数」这种更稀缺的时间成本省下来（master 口径）。
 *
 * 可行域极小（x ≤ 3 / y ≤ 2），穷举 4×3 = 12 组即可，不需任何技巧。
 *
 * @param {number} m 还需要的普通道具数（可 ≤ 0，此时直接返回 0/0）
 * @param {{maxX?:number, maxY?:number, itemsPerFishRound?:number, itemsPerGoldRound?:number}} [options]
 * @returns {{feasible:boolean, x:number, y:number, items:number, target:number, waste:number,
 *            maxItems:number, grid:Array<{x:number,y:number,items:number,waste:number,feasible:boolean}>}}
 */
export const solveTopUpRounds = (m, options = {}) => {
  const target = Math.max(0, Math.ceil(Number(m) || 0));
  const maxX = Math.max(0, Math.floor(Number(options.maxX) || 0));
  const maxY = Math.max(0, Math.floor(Number(options.maxY) || 0));
  const perFish = Number.isFinite(Number(options.itemsPerFishRound))
    ? Math.max(0, Number(options.itemsPerFishRound))
    : 24;
  const perGold = Number.isFinite(Number(options.itemsPerGoldRound))
    ? Math.max(0, Number(options.itemsPerGoldRound))
    : 12;

  const grid = [];
  let best = null;
  let maxItems = 0;

  for (let x = 0; x <= maxX; x += 1) {
    for (let y = 0; y <= maxY; y += 1) {
      const items = perFish * x + perGold * y;
      if (items > maxItems) maxItems = items;
      const feasible = items >= target;
      const waste = items - target;
      grid.push({ x, y, items, waste, feasible });
      if (!feasible) continue;
      if (
        best === null ||
        waste < best.waste ||
        // 并列时 y 尽可能大（再并列取 x 小，行为确定）
        (waste === best.waste && (y > best.y || (y === best.y && x < best.x)))
      ) {
        best = { x, y, items, waste };
      }
    }
  }

  if (!best) {
    return {
      feasible: false,
      x: 0,
      y: 0,
      items: 0,
      target,
      waste: 0,
      maxItems,
      grid,
    };
  }

  return {
    feasible: true,
    x: best.x,
    y: best.y,
    items: best.items,
    target,
    waste: best.waste,
    maxItems,
    grid,
  };
};

/** 金砖数 → 原价鱼竿根数（向上取整；买竿步长 600 金砖） */
export const goldToRods = (gold, price = GOLDENFISH_FINISH_TARGETS.rodPrice) => {
  const p = Number.isFinite(Number(price)) && Number(price) > 0 ? Number(price) : 600;
  return Math.max(0, Math.ceil((Number(gold) || 0) / p));
};

/** 金砖档位（万金砖单位）→ 实际金砖数 */
export const goldTierToGold = (tierCost) =>
  Math.max(0, Number(tierCost) || 0) * GOLDENFISH_GOLD_UNIT;

/**
 * 第 12 步执行清单：由 x/y 推出「要钓多少次、要买多少根竿、要花多少金砖」
 *
 * @param {{x:number, y:number,
 *          fishProgress:number, goldProgress:number,
 *          rodStock?:number, goldInStock?:number}} input
 */
export const buildTopUpExecution = (input = {}) => {
  const T = GOLDENFISH_FINISH_TARGETS;
  const x = Math.max(0, Math.floor(Number(input.x) || 0));
  const y = Math.max(0, Math.floor(Number(input.y) || 0));

  const fishPerRound = remainingCostPerRound(T.fishSlot, input.fishProgress, GOLDENFISH_FISH_FULL) || 150;
  const goldPerRound = remainingCostPerRound(T.goldSlot, input.goldProgress, taskTotals(T.goldSlot).maxThreshold) || 40000;

  const fishTimes = fishPerRound * x;
  const goldSpend = goldPerRound * y;
  const rodsForFish = fishesToRods(fishTimes);
  const rodsForGold = goldToRods(goldSpend);
  const rodsNeeded = rodsForFish + rodsForGold;

  const rodStock = Math.max(0, Math.floor(Number(input.rodStock) || 0));
  const goldInStock = Number.isFinite(Number(input.goldInStock))
    ? Math.max(0, Number(input.goldInStock))
    : Infinity;

  return {
    x,
    y,
    fishPerRound,
    goldPerRound,
    fishTimes,
    goldSpend,
    rodsForFish,
    rodsForGold,
    rodsNeeded,
    rodsToBuy: Math.max(0, rodsForFish - rodStock) + rodsForGold,
    rodStock,
    goldShortfall: Number.isFinite(goldInStock) ? Math.max(0, goldSpend - goldInStock) : 0,
  };
};

/**
 * 收尾总规划：给当前进度与库存，产出「第 9~12 步」的完整计划（纯函数，不联网）
 *
 * @param {object} input
 * @param {number} input.specialCount 当前 5288 数量 n
 * @param {object} input.progressBySlot `{1,2,3,4,5}` 当前进度
 * @param {number} [input.rodStock] 背包现有黄金鱼竿
 * @param {number} [input.goldInStock] 背包现有金砖
 * @returns {{done:boolean, n:number, remain:number, packsNeeded:number,
 *            feasible:boolean, reason:string|null, best:object|null,
 *            maxX:number, maxY:number, itemsPerFishRound:number, itemsPerGoldRound:number,
 *            execution:object|null, maxItems:number}}
 */
export const planFinishTopUp = (input = {}) => {
  const T = GOLDENFISH_FINISH_TARGETS;
  const progress = input.progressBySlot || {};
  const n = Math.max(0, Math.floor(Number(input.specialCount) || 0));

  // 第 9 步：r = 250 − n
  const remain = Math.max(0, T.specialTarget - n);
  if (remain === 0) {
    return {
      done: true,
      n,
      remain: 0,
      packsNeeded: 0,
      feasible: true,
      reason: "already-reached",
      best: null,
      maxX: 0,
      maxY: 0,
      itemsPerFishRound: 0,
      itemsPerGoldRound: 0,
      execution: null,
      maxItems: 0,
    };
  }

  // 第 10 步：m = r × 4
  const packsNeeded = remain * T.packsPerSpecial;

  // 第 11 步：可行域 = 各自剩余档数
  const fishProgress = Number(progress[T.fishSlot]) || 0;
  const goldProgress = Number(progress[T.goldSlot]) || 0;
  const maxX = remainingRoundCount(T.fishSlot, fishProgress, GOLDENFISH_FISH_FULL);
  const maxY = remainingRoundCount(T.goldSlot, goldProgress, taskTotals(T.goldSlot).maxThreshold);
  const itemsPerFishRound = remainingRewardPerRound(T.fishSlot, fishProgress, GOLDENFISH_FISH_FULL);
  const itemsPerGoldRound = remainingRewardPerRound(T.goldSlot, goldProgress, taskTotals(T.goldSlot).maxThreshold);

  const solved = solveTopUpRounds(packsNeeded, {
    maxX,
    maxY,
    itemsPerFishRound,
    itemsPerGoldRound,
  });

  if (!solved.feasible) {
    return {
      done: false,
      n,
      remain,
      packsNeeded,
      feasible: false,
      reason: "tiers-exhausted",
      best: null,
      maxX,
      maxY,
      itemsPerFishRound,
      itemsPerGoldRound,
      execution: null,
      maxItems: solved.maxItems,
    };
  }

  const execution = buildTopUpExecution({
    x: solved.x,
    y: solved.y,
    fishProgress,
    goldProgress,
    rodStock: input.rodStock,
    goldInStock: input.goldInStock,
  });

  return {
    done: false,
    n,
    remain,
    packsNeeded,
    feasible: true,
    reason: null,
    best: { x: solved.x, y: solved.y, items: solved.items, waste: solved.waste },
    maxX,
    maxY,
    itemsPerFishRound,
    itemsPerGoldRound,
    execution,
    maxItems: solved.maxItems,
  };
};

// ──────────────────── 第 15 / 16 步：结果判定与失败清单（下载） ────────────────────

/** 单个账号的收尾结果三态 */
export const GOLDENFISH_FINISH_OUTCOME = Object.freeze({
  SUCCESS: "success",
  FAILED: "failed",
  SKIPPED: "skipped",
});

/** 失败原因码 → 中文（日志与下载清单共用同一份文案） */
export const GOLDENFISH_FINISH_REASON_LABELS = Object.freeze({
  "not-reached": "15 步判定未满 250",
  "tiers-exhausted": "档位做满仍不够",
  "gold-shortfall": "金砖不够",
  "rods-shortfall": "鱼竿不够",
  "claim-failed": "领取进度奖励失败",
  "open-packs-failed": "打开普通道具失败",
  "buy-rods-failed": "购买鱼竿失败",
  "conn-failed": "连接/初始化失败",
  "run-error": "执行异常",
  "already-reached": "已达标（跳过）",
});

/** 原因码 → 中文；未知码原样返回，便于日志暴露新码 */
export const describeFinishReason = (reason) =>
  GOLDENFISH_FINISH_REASON_LABELS[reason] || String(reason || "未标注");

/**
 * 第 15 步：按最终 5288 数量判定单个账号成功/失败
 *
 * @param {number} specialCount 收尾结束后读到的 5288 数量
 * @param {number} [target] 目标（默认 250）
 * @returns {{outcome:string, success:boolean, specialCount:number, target:number, shortfall:number}}
 */
export const classifyFinishOutcome = (
  specialCount,
  target = GOLDENFISH_FINISH_TARGETS.specialTarget,
) => {
  const n = Math.max(0, Math.floor(Number(specialCount) || 0));
  const t = Math.max(0, Math.floor(Number(target) || 0));
  const success = n >= t;
  return {
    outcome: success ? GOLDENFISH_FINISH_OUTCOME.SUCCESS : GOLDENFISH_FINISH_OUTCOME.FAILED,
    success,
    specialCount: n,
    target: t,
    shortfall: Math.max(0, t - n),
  };
};

/**
 * 第 16 步：汇总失败清单 + 生成可下载文本
 *
 * @param {Array<{name?:string, serverId?:number|string, roleId?:number|string,
 *                specialCount?:number, outcome?:string, reason?:string, detail?:string}>} results
 * @param {{target?:number, now?:string}} [options]
 * @returns {{total:number, successCount:number, failedCount:number, skippedCount:number,
 *            failures:Array<object>, text:string}}
 */
export const summarizeFinishResults = (results = [], options = {}) => {
  const target = Math.max(
    0,
    Math.floor(Number(options.target ?? GOLDENFISH_FINISH_TARGETS.specialTarget) || 0),
  );
  const list = Array.isArray(results) ? results : [];
  const failures = [];
  let successCount = 0;
  let skippedCount = 0;

  for (const row of list) {
    const n = Math.max(0, Math.floor(Number(row?.specialCount) || 0));
    const outcome = row?.outcome || (n >= target ? GOLDENFISH_FINISH_OUTCOME.SUCCESS : GOLDENFISH_FINISH_OUTCOME.FAILED);
    if (outcome === GOLDENFISH_FINISH_OUTCOME.SUCCESS) {
      successCount += 1;
    } else if (outcome === GOLDENFISH_FINISH_OUTCOME.SKIPPED) {
      skippedCount += 1;
    } else {
      failures.push({
        name: String(row?.name ?? ""),
        serverId: row?.serverId ?? "",
        roleId: row?.roleId ?? "",
        specialCount: n,
        shortfall: Math.max(0, target - n),
        reason: row?.reason || "not-reached",
        reasonText: describeFinishReason(row?.reason || "not-reached"),
        detail: String(row?.detail ?? ""),
      });
    }
  }

  const header = [
    `金鱼收尾失败清单`,
    `生成时间：${options.now || new Date().toISOString()}`,
    `总计 ${list.length} 个账号：成功 ${successCount} / 失败 ${failures.length} / 跳过 ${skippedCount}`,
    `判定口径：金鱼特殊道具(5288) ≥ ${target}`,
    "=".repeat(60),
  ].join("\n");

  const body = failures.length
    ? failures
        .map((f, i) => {
          const parts = [
            `${String(i + 1).padStart(3, " ")}. ${f.name || "(未命名)"}`,
            f.serverId !== "" ? `服${f.serverId}` : "",
            f.roleId !== "" ? `roleId=${f.roleId}` : "",
            `5288=${f.specialCount}（差${f.shortfall}）`,
            `原因=${f.reasonText}`,
          ].filter(Boolean);
          const line = parts.join("  ");
          return f.detail ? `${line}\n      ↳ ${f.detail}` : line;
        })
        .join("\n")
    : "（无失败账号）";

  return {
    total: list.length,
    successCount,
    failedCount: failures.length,
    skippedCount,
    failures,
    text: `${header}\n${body}\n`,
  };
};

export { toMissionId, completedRounds, fishesToRods };
