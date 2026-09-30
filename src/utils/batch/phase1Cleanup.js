/**
 * 第一阶段金鱼流水线 · 通用「清理 + 升星」能力（单一来源，tasksItem 与 tasksGoldenfish 共用）
 *
 * 包含两件事：
 *   1. `clearInventoryByPacks` —— 一键清空道具（清单 = master 30a 抓包实证）
 *   2. `runHeroBookUpgradeChain` —— 英雄升星 → 图鉴升星 → 领图鉴奖励（因果链，按序）
 *
 * ⚠️ 本模块被 tasksGoldenfish 引用，而 `tasksGoldenfishConsume.test.js` 在**裸 node 环境**
 * 直接 import ⇒ 必须用**相对路径**（`@/` 别名会 ERR_MODULE_NOT_FOUND），且不得引入
 * 浏览器专属依赖（Vue / pinia / localStorage）。
 * 所有副作用通过注入的 `send` / `sleep` / `log` / `shouldStop` 回调完成。
 */

import { HERO_DICT } from "../HeroList.js";

/** item_openpack 单次 number 上限 = **999**（master 2026-09-28 强调；抓包实证 3005 开 6207 = 6×999 + 213） */
export const ITEM_OPENPACK_MAX_PER_CALL = 999;

/**
 * 🔴 术语定义（master 2026-09-30 拍板）：
 *   - **普通道具**   = 非金鱼道具（下面 `NON_GOLDFISH_CLEAR_ITEM_IDS`）
 *   - **金鱼普通道具** = **5287**（产出硬通货；开完才轮到清空普通道具）
 *   - **金鱼特殊道具** = **5288**（兑换金鱼的硬通货，250 个兑换）
 *
 * `CLEAR_ITEM_IDS`（全清单）用于**手动**的「一键清空道具（资源兑现）」——
 *   master 的收尾清扫工具：金鱼收尾后连 52xx/5287 一起扫掉。
 * `NON_GOLDFISH_CLEAR_ITEM_IDS`（非金鱼段）用于**金鱼第一阶段流水线的第 4 步「清空普通道具」**——
 *   按定义只清非金鱼道具，**不碰 52xx 段**（金鱼道具留给收尾/手动）。
 *
 * 清单来源：master 30a 抓包（local-data/misc/clear_inventory.jsonl）实际开过的 itemId：
 *   - 3002~3012：英雄碎片包 / 资源包（产出英雄碎片 1xx/2xx/3xx，自动进图鉴进度）
 *   - 35011 / 36001 / 37005 / 40008：杂项礼包
 *   - 5264~5287（52xx 段）：**金鱼活动道具**（只进全清单，不进第一阶段清空段）
 *   ⚠️ 同次抓包还开过 5506 / 5507 / 5508（各 ×2）但未收录（待 master 确认后补）
 */
export const CLEAR_ITEM_IDS = Object.freeze([
  3002, 3005, 3006, 3007, 3008, 3009, 3010, 3011, 3012,
  35011, 36001, 37005, 40008,
  5264, 5265, 5268, 5269, 5271, 5272, 5273, 5275, 5276, 5277, 5279, 5280,
  5283, 5287,
]);

/** 非金鱼段（第一阶段第 4 步「清空普通道具」的清单；不含任何 52xx 金鱼道具） */
export const NON_GOLDFISH_CLEAR_ITEM_IDS = Object.freeze([
  3002, 3005, 3006, 3007, 3008, 3009, 3010, 3011, 3012,
  35011, 36001, 37005, 40008,
]);

/**
 * 🔴 保护名单（代码层最后防线）：这些**永不清空**，即使被误加进清单。
 *   5288 = 金鱼特殊道具（兑换金鱼的硬通货，250 个兑换；抓包实证 5287×684 → 5288×174）
 *   5286 = 金鱼投道具用道具（每日投币） / 1013 = 珍珠 / 1001 = 招募令 /
 *   1012 = 黄金鱼竿 / 2001~2005 = 宝箱（开箱任务的原材料）。
 */
export const PROTECTED_ITEM_IDS = Object.freeze(new Set([
  5288, 5286, 1013, 1001, 1012, 2001, 2002, 2003, 2004, 2005,
]));

const defaultSleep = (ms = 0) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));

/**
 * 一键清空道具：把背包里清单内道具全部用掉（资源兑现）
 *
 * @param {object} ctx
 * @param {string} ctx.tokenId
 * @param {string} [ctx.tokenName]
 * @param {object} ctx.items        role.items 快照（{[itemId]:{quantity}}）
 * @param {Function} ctx.send       (tokenId, cmd, params, timeout) => Promise
 * @param {Array<number>} [ctx.itemIds]  清空清单（默认全清单 `CLEAR_ITEM_IDS`；
 *                  金鱼第一阶段第 4 步传 `NON_GOLDFISH_CLEAR_ITEM_IDS`）
 * @param {Function} [ctx.shouldStop]
 * @param {Function} [ctx.log]      (message, type) => void
 * @param {Function} [ctx.sleep]    () => Promise
 * @returns {Promise<{kinds:number,batches:number,count:number}>}
 */
export async function clearInventoryByPacks({
  tokenId,
  tokenName = "",
  items = {},
  itemIds = CLEAR_ITEM_IDS,
  send,
  shouldStop = () => false,
  log = () => {},
  sleep = defaultSleep,
} = {}) {
  let kinds = 0;
  let batches = 0;
  let count = 0;

  for (const itemId of itemIds) {
    if (shouldStop()) break;
    if (PROTECTED_ITEM_IDS.has(itemId)) continue; // 双保险，理论上不会命中

    const quantity = Math.floor(Number(items?.[String(itemId)]?.quantity) || 0);
    if (quantity <= 0) continue;

    let left = quantity;
    while (left > 0 && !shouldStop()) {
      const batch = Math.min(ITEM_OPENPACK_MAX_PER_CALL, left);
      await send(
        tokenId,
        "item_openpack",
        { itemId, number: batch, index: 0 },
        5000,
      );
      left -= batch;
      batches += 1;
      count += batch;
      await sleep();
    }

    kinds += 1;
    log(
      `${tokenName} itemId ${itemId} 已用 ${quantity} 个（${Math.ceil(quantity / ITEM_OPENPACK_MAX_PER_CALL)} 批）`,
      "success",
    );
  }

  return { kinds, batches, count };
}

/**
 * 英雄升星 → 图鉴升星 → 领取图鉴奖励 完整链（**因果链，必须按此顺序**）
 * master 2026-09-28：英雄升星之后会得到图鉴，图鉴升星之后会得到奖励；
 * 对当前角色**一次连接按序做完**，避免按功能遍历角色来回连断触发限流。
 * 单步循环与 tasksItem 的 batchHeroUpgrade / batchBookUpgrade / batchClaimStarRewards
 * 单角色部分逐字段一致（升星每英雄最多 10 次：成功继续、失败跳下一个英雄）。
 *
 * @returns {Promise<{heroUp:number, bookUp:number, claims:number}>}
 */
export async function runHeroBookUpgradeChain({
  tokenId,
  tokenName = "",
  send,
  shouldStop = () => false,
  log = () => {},
  sleep = defaultSleep,
} = {}) {
  const name = tokenName || tokenId;
  const heroIds = Object.keys(HERO_DICT).map(Number);
  const isOk = (res) =>
    res && (res.code === 0 || res.success === true || res.result === 0);

  /** 升星循环（cmd + 文案参数化；英雄升星与图鉴升星同构） */
  const upgradeLoop = async (cmd, okLabel, failLabel) => {
    let okCount = 0;
    for (const heroId of heroIds) {
      if (shouldStop()) break;
      for (let i = 1; i <= 10; i += 1) {
        if (shouldStop()) break;
        try {
          const res = await send(tokenId, cmd, { heroId }, 5000);
          if (!isOk(res)) throw new Error(failLabel);
          okCount += 1;
          log(`${name} 英雄ID:${heroId} ${okLabel} (第${i}次)`, "success");
        } catch {
          // 失败说明该英雄无法继续（碎片不足/满星），停止当前英雄、换下一个
          break;
        }
        await sleep();
      }
    }
    return okCount;
  };

  log(`${name} 【1/3】英雄升星开始`, "info");
  const heroUp = await upgradeLoop("hero_heroupgradestar", "升星成功", "升星失败");
  log(`${name} 【1/3】英雄升星完成，共成功 ${heroUp} 次`, "success");

  log(`${name} 【2/3】图鉴升星开始`, "info");
  const bookUp = await upgradeLoop("book_upgrade", "图鉴升星成功", "图鉴升星失败");
  log(`${name} 【2/3】图鉴升星完成，共成功 ${bookUp} 次`, "success");

  log(`${name} 【3/3】领取图鉴奖励开始`, "info");
  let claims = 0;
  for (let i = 1; i <= 10; i += 1) {
    if (shouldStop()) break;
    try {
      const res = await send(tokenId, "book_claimpointreward", {}, 5000);
      if (!isOk(res)) throw new Error("领取奖励失败");
      claims += 1;
      log(`${name} 领取图鉴奖励成功 (第${i}次)`, "success");
    } catch {
      // 没有更多奖励可领，停止
      break;
    }
    await sleep();
  }
  log(`${name} 【3/3】领取图鉴奖励完成，共成功 ${claims} 次`, "success");

  return { heroUp, bookUp, claims };
}
