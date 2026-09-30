/**
 * 养鱼/神器（鱼）自动合并 · 纯逻辑 + 执行器（单一来源）
 *
 * 协议依据：docs/fish-merge-and-artifactbook-protocol.md（2026-09-30 两份抓包实证）
 *   - 合并请求   artifact_upgradestar { heroId: -1, itemId }（itemId = 本级那条鱼）
 *                响应不是专用 Resp，而是通用 SyncResp，走 resp=请求seq 匹配，role.items 带 delta
 *   - 消耗规则   V(L) = 1 + (L-1)*k；单次升级 = 吃「本级鱼 1 条 + 同品种 1 级鱼 k 条」
 *                （1→2 时本级就是 1 级鱼，合计 k+1 条 1 级鱼）
 *   - k 表       13xx=1（红） / 14xx=2（橙） / 15xx=5（蓝） / 16xx=20
 *                铁证：16011 21→1（恰 -20）+ 16012 消失 + 16013 新建；
 *                     14021 5→1（-4 = 14023→14024、14024→14025 两步 ×2）
 *   - 图鉴点亮   book_batchupgrade { club:0, isArtifact:true, isSkin:false }
 *                一次调用所有合规品种 +1 星，连发至 4 星全满（响应无增量即停）
 *   - 点数奖励   book_claimpointreward {} → 响应 cmd 是 Item_OpenBoxResp（resp 序号匹配）
 *
 * 规划器口径：**高位种子优先**（先用现存的高等级鱼当种子往上合，再用 1 级鱼开新链）——
 * 与服务端切阵容自动合并的行为逐鱼一致（fish_auto_merge.jsonl 两个品种复盘验证）：
 *   1301: L1×5 + L3×1 + L5×1 → L5×2 + L3×1（L1 清零）
 *   1402: L1×5 + L3×1 + L5×5 → L5×6 + L1×1
 *
 * ⚠️ 裸 node 测试直接 import ⇒ 相对路径 + 无浏览器依赖（与 phase1Cleanup.js 同规矩）。
 * 副作用全部通过注入的 send / sleep / log / shouldStop 完成。
 */

/** 每升一级额外消耗的 1 级鱼数量（itemId 前两位 → k） */
export const FISH_TIER_COST = Object.freeze({ 13: 1, 14: 2, 15: 5, 16: 20 });

/** 鱼最高等级（itemId 末位 1..5；协议层面 5 以上未验证，按 master 口径封顶） */
export const FISH_MAX_LEVEL = 5;

/** 单角色合并步数保险丝（momo222 全背包 120 步；留 5 倍余量） */
export const FISH_MERGE_MAX_STEPS = 600;

/** 图鉴点亮最多轮数（1 星 → 5 星只需 4 轮） */
export const FISH_BOOK_BATCH_MAX = 4;

/** 点数奖励最多连领次数（momo222 实测连领 5 次） */
export const FISH_BOOK_REWARD_MAX = 10;

/**
 * 是否鱼/神器道具：5 位、档位 13~16、品种段非 00、等级 1~5。
 * ⚠️ 15001/15002 是货币（数量 ~万级），品种段 "00" 被此规则排除。
 */
export function isFishItemId(itemId) {
  const s = String(itemId);
  if (!/^1[3-6]\d{3}$/.test(s)) return false;
  const species = Number(s.slice(2, 4));
  const level = Number(s.slice(4, 5));
  return species > 0 && level >= 1 && level <= FISH_MAX_LEVEL;
}

/** 档位 k 值（非鱼返回 null） */
export function fishTierCost(itemId) {
  const s = String(itemId);
  if (!isFishItemId(s)) return null;
  return FISH_TIER_COST[s.slice(0, 2)] ?? null;
}

/** 养出一条 L 级鱼总共要吃掉的 1 级鱼条数 V(L) = 1 + (L-1)*k */
export function fishTotalCost(tier, level) {
  const k = FISH_TIER_COST[tier];
  if (!k || level < 1 || level > FISH_MAX_LEVEL) return null;
  return 1 + (level - 1) * k;
}

/** 兼容多种 role 响应形状（与 tasksGoldenfish.extractRole 同口径） */
export function extractFishRole(response) {
  return (
    response?.role || response?.body?.role || response?.body || response || {}
  );
}

/**
 * 从 role（items + artifactBooks）读出各品种当前背包库存
 * @returns {Map<string, number[]>} speciesId("1301") → [q1..q5]（下标 0 = 1 级）
 *
 * 品种清单 = artifactBooks 的 key（权威，过滤 13~16 档）∪ 背包里能识别出的鱼 itemId。
 * ⚠️ 只统计背包：英雄身上已装备的鱼不在 role.items 里（不参与合并，与客户端行为一致）。
 */
export function readFishStock(role) {
  const items = role?.items || {};
  const stock = new Map();

  const ensure = (speciesId) => {
    if (!stock.has(speciesId)) stock.set(speciesId, [0, 0, 0, 0, 0]);
    return stock.get(speciesId);
  };

  // 1) 图鉴 key 是权威品种清单（artifactBooks: { "1302": {artifactId, claimedStar} }）
  const books = role?.artifactBooks || {};
  for (const speciesId of Object.keys(books)) {
    if (FISH_TIER_COST[String(speciesId).slice(0, 2)] && /^\d{4}$/.test(String(speciesId))) {
      ensure(String(speciesId));
    }
  }

  // 2) 背包里能识别出的鱼（覆盖图鉴缺失的新品种）
  for (const [itemId, node] of Object.entries(items)) {
    if (!isFishItemId(itemId)) continue;
    const qty =
      node == null
        ? 0
        : Number(
            typeof node === "number" ? node : (node.quantity ?? node.num ?? node.count ?? 0),
          );
    if (!Number.isFinite(qty) || qty < 0) continue;
    const speciesId = String(itemId).slice(0, 4);
    const level = Number(String(itemId).slice(4, 5));
    ensure(speciesId)[level - 1] = qty;
  }

  // 剔除全 0 品种，减少无效日志
  for (const [speciesId, q] of [...stock.entries()]) {
    if (q.every((n) => n <= 0)) stock.delete(speciesId);
  }
  return stock;
}

/**
 * 规划下一步合并（高位种子优先）
 *
 * 候选 = 存在种子的等级 L（1..4），且材料够：
 *   L=1：需要 q1 ≥ k+1（种子本身就是一条 1 级鱼）
 *   L≥2：需要 q1 ≥ k（种子是 L 级鱼那条）
 * 多个候选时**取最高等级**（先用掉现存高阶鱼 —— 服务端同款行为）。
 *
 * @param {Map<string, number[]>} stock readFishStock 的产物（会被原地更新）
 * @returns {{itemId:number, speciesId:string, fromLevel:number, toLevel:number, consumeLv1:number}|null}
 */
export function nextFishMergeStep(stock) {
  let best = null;
  for (const [speciesId, q] of stock.entries()) {
    const tier = Number(speciesId.slice(0, 2));
    const k = FISH_TIER_COST[tier];
    if (!k) continue;
    for (let level = 1; level <= FISH_MAX_LEVEL - 1; level += 1) {
      if (q[level - 1] <= 0) continue;
      const need = level === 1 ? k + 1 : k;
      if (q[0] < need) continue;
      // 同品种内取更高种子；跨品种保持遍历序（品种间互不影响，顺序无关）
      if (!best || level > best.fromLevel) {
        best = {
          itemId: Number(`${speciesId}${level}`),
          speciesId,
          fromLevel: level,
          toLevel: level + 1,
          consumeLv1: need,
        };
      }
    }
  }
  return best;
}

/** 把一步合并的预期消耗/产出原地写回 stock（规划器推进用） */
export function applyStepToStock(stock, step) {
  const q = stock.get(step.speciesId);
  if (!q) return;
  const k = FISH_TIER_COST[Number(step.speciesId.slice(0, 2))];
  q[step.fromLevel - 1] -= 1;
  q[0] -= k;
  q[step.toLevel - 1] += 1;
}

/**
 * 响应 items delta 回写（防御性校准：以服务端为准，覆盖本地推算）
 * delta 形态：{ "13021": {"quantity":7} | {"itemId","quantity","ext"} | null }
 */
export function applyItemDelta(stock, roleItems) {
  if (!roleItems || typeof roleItems !== "object") return;
  for (const [itemId, node] of Object.entries(roleItems)) {
    if (!isFishItemId(itemId)) continue;
    const speciesId = String(itemId).slice(0, 4);
    const q = stock.get(speciesId);
    if (!q) continue;
    const level = Number(String(itemId).slice(4, 5));
    const qty =
      node == null
        ? 0
        : Number(
            typeof node === "number" ? node : (node.quantity ?? node.num ?? node.count ?? 0),
          );
    if (Number.isFinite(qty) && qty >= 0) q[level - 1] = qty;
  }
}

/** 规划整包合并（不动 stock 的纯预览）：返回步骤数组 + 按品种汇总 */
export function planFishMerges(role) {
  const stock = readFishStock(role);
  const steps = [];
  for (;;) {
    const step = nextFishMergeStep(stock);
    if (!step) break;
    applyStepToStock(stock, step);
    steps.push(step);
  }
  return { steps, stockAfter: stock };
}

const LEVEL_NAMES = ["", "1级", "2级", "3级", "4级", "5级"];

/** 按品种汇总合并计划（日志用） */
export function summarizePlan(steps) {
  const bySpecies = new Map();
  for (const s of steps) {
    if (!bySpecies.has(s.speciesId)) bySpecies.set(s.speciesId, []);
    bySpecies.get(s.speciesId).push(s);
  }
  const lines = [];
  for (const [speciesId, list] of bySpecies.entries()) {
    const tier = speciesId.slice(0, 2);
    const top = Math.max(...list.map((s) => s.toLevel));
    const lv1 = list.reduce((sum, s) => sum + s.consumeLv1, 0);
    lines.push(
      `${speciesId}(k=${FISH_TIER_COST[tier]}) ${list.length} 步 → 最高${LEVEL_NAMES[top]}，耗1级鱼${lv1}`,
    );
  }
  return lines;
}

const defaultSleep = () => new Promise((r) => setTimeout(r, 0));

/**
 * 单角色自动合并执行器（调用方必须已建立连接）
 *
 * 流程：规划 → 逐步 artifact_upgradestar（每步后用响应 delta 校准本地库存）
 *      → （可选）book_batchupgrade 图鉴点亮 ×≤4 → book_claimpointreward 领奖 ×≤10
 *
 * @param {object} ctx
 * @param {string} ctx.tokenId
 * @param {string} [ctx.tokenName]
 * @param {object} ctx.role           role_getroleinfo 的 role（items + artifactBooks）
 * @param {Function} ctx.send         (tokenId, cmd, params, timeout) => Promise<responseBody>
 * @param {boolean} [ctx.claimBook]   合并后是否顺带图鉴点亮 + 领奖（默认 true）
 * @param {Function} [ctx.shouldStop]
 * @param {Function} [ctx.log]        (message, type) => void
 * @param {Function} [ctx.sleep]
 * @returns {Promise<{merges:number, bookBatches:number, rewards:number, skipped:string[]}>}
 */
export async function runFishAutoMerge({
  tokenId,
  tokenName = "",
  role,
  send,
  claimBook = true,
  shouldStop = () => false,
  log = () => {},
  sleep = defaultSleep,
} = {}) {
  const name = tokenName || tokenId;
  const stock = readFishStock(role);

  // —— 预览计划（只读，不影响执行用的 stock）——
  const preview = planFishMerges(role);
  if (preview.steps.length === 0) {
    log(`${name} 背包没有可合并的鱼（13xx~16xx）`, "info");
  } else {
    for (const line of summarizePlan(preview.steps)) {
      log(`${name} 合并计划：${line}`, "info");
    }
  }

  let merges = 0;
  while (!shouldStop() && merges < FISH_MERGE_MAX_STEPS) {
    const step = nextFishMergeStep(stock);
    if (!step) break;

    let res = null;
    try {
      res = await send(
        tokenId,
        "artifact_upgradestar",
        { heroId: -1, itemId: step.itemId },
        8000,
      );
    } catch (err) {
      // 请求失败 = 意外（材料不足在规划层已挡住）；保住已完成的步数，停止该角色
      log(`${name} 合并 ${step.itemId} 请求失败：${err.message}`, "error");
      break;
    }
    if (res == null) {
      log(`${name} 合并 ${step.itemId} 无响应，停止合并`, "error");
      break;
    }

    merges += 1;
    applyStepToStock(stock, step);
    // 服务端增量优先（覆盖本地推算，防材料挑选策略与预期不一致导致漂移）
    applyItemDelta(stock, extractFishRole(res)?.items);
  }
  if (merges >= FISH_MERGE_MAX_STEPS) {
    log(`${name} 已达单角色合并步数上限 ${FISH_MERGE_MAX_STEPS}，停止`, "warn");
  }

  const result = { merges, bookBatches: 0, rewards: 0 };

  // —— 图鉴点亮：一次调用全体 +1 星，最多 4 轮 ——
  if (claimBook && !shouldStop()) {
    for (let i = 1; i <= FISH_BOOK_BATCH_MAX; i += 1) {
      if (shouldStop()) break;
      let res = null;
      try {
        res = await send(
          tokenId,
          "book_batchupgrade",
          { club: 0, isArtifact: true, isSkin: false },
          8000,
        );
      } catch {
        break; // 没有可点亮的星级 / 服务端拒绝 → 停
      }
      const advanced = Object.keys(
        extractFishRole(res)?.artifactBooks || {},
      ).length;
      if (!advanced) break;
      result.bookBatches += 1;
      log(`${name} 图鉴点亮第 ${i} 轮：${advanced} 个品种推进`, "success");
      await sleep();
    }

    // —— 点数奖励（响应是 Item_OpenBoxResp，走 resp 序号匹配）——
    for (let i = 1; i <= FISH_BOOK_REWARD_MAX; i += 1) {
      if (shouldStop()) break;
      let res = null;
      try {
        res = await send(tokenId, "book_claimpointreward", {}, 8000);
      } catch {
        break; // 没有更多奖励可领 → 停
      }
      const rewards = extractFishRole(res)?.reward;
      result.rewards += 1;
      const gain = Array.isArray(rewards)
        ? rewards
            .map((r) => `${r.type === 2 ? "钻石" : `#${r.itemId}`}×${r.value}`)
            .join(" + ")
        : "";
      log(`${name} 领取图鉴点数奖励(第${i}档)${gain ? `：${gain}` : ""}`, "success");
      await sleep();
    }
  }

  return result;
}
