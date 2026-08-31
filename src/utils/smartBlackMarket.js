/**
 * 智能黑市购物核心逻辑（每日任务12「黑市购买1次物品」）
 *
 * 规则：
 * 1. 执行一次批量购买 store_purchase（空参数，按账号采购清单购买符合折扣的商品）
 * 2. 如果批量购买有成交（响应 body 中存在 reward 数组，或任意 goodsList.*.buy_quantity > 0，
 *    或 role.dailyTask.complete["12"] === 1），则停止
 * 3. 否则用 store_buy { goodsId: 1 } 直接购买1次青铜宝箱（商品位1）作为保底
 *
 * 重要（抓包+实测结论）：
 * - store_purchase 会忽略 goodsId 参数，始终按采购清单批量购买；
 *   且每次调用都会刷新黑市商品（首次为每日免费刷新，之后消耗付费刷新次数），
 *   因此全程只允许调用一次，避免浪费付费刷新
 * - 保底购买必须用 store_buy（手动购买指定商品位，不触发刷新）
 * - 商品位1固定为青铜宝箱（一次购买2个）
 * - 批量购买无成交时，服务器不返回错误码，而是返回正常的 Store_BuyResp
 *   （无 reward 字段、所有 buy_quantity 为 0、dailyTask.12 为 0），
 *   因此必须解析响应 body 判断是否成交
 */

// 已知黑市商品/奖励道具名称（未知项显示为 道具{itemId}）
const ITEM_NAMES = {
  1012: "黄金鱼竿",
  2001: "木质宝箱",
  2002: "青铜宝箱",
  2003: "黄金宝箱",
  2004: "铂金宝箱",
  2005: "钻石宝箱",
};

// 汇总 reward 数组为可读文本（type 2 = 钻石，type 3 = 道具）
const summarizeRewards = (rewards) => {
  if (!Array.isArray(rewards) || rewards.length === 0) return "无奖励";
  const diamondTotal = rewards
    .filter((r) => r.type === 2)
    .reduce((sum, r) => sum + (r.value || 0), 0);
  const itemCounts = {};
  rewards
    .filter((r) => r.type === 3 && r.itemId)
    .forEach((r) => {
      itemCounts[r.itemId] = (itemCounts[r.itemId] || 0) + (r.value || 0);
    });
  const parts = [];
  if (diamondTotal > 0) parts.push(`钻石×${diamondTotal}`);
  for (const [itemId, count] of Object.entries(itemCounts)) {
    parts.push(`${ITEM_NAMES[itemId] || `道具${itemId}`}×${count}`);
  }
  return parts.length > 0 ? parts.join(", ") : "无奖励";
};

/**
 * 分析 Store_BuyResp 响应 body，判断是否成交
 *
 * @param {object} resp - store_purchase / store_buy 的响应 body
 * @returns {{ success: boolean, hasReward: boolean, boughtGoods: Array, dailyTaskDone: boolean, summary: string }}
 */
export const analyzeStoreBuyResp = (resp) => {
  const reward = Array.isArray(resp?.reward) ? resp.reward : [];
  const hasReward = reward.length > 0;
  const boughtGoods = Object.entries(resp?.goodsList || {})
    .filter(([, goods]) => (goods?.buy_quantity || 0) > 0)
    .map(([goodsId, goods]) => ({
      goodsId: Number(goodsId),
      buyQuantity: goods.buy_quantity,
    }));
  // 每日任务12 = 黑市购买1次物品
  const dailyTaskDone = resp?.role?.dailyTask?.complete?.["12"] === 1;

  return {
    // 满足任一条件即视为成交（成功）；
    // dailyTaskDone 兼容「今日任务此前已完成」的场景，此时无需再买
    success: hasReward || boughtGoods.length > 0 || dailyTaskDone,
    hasReward,
    boughtGoods,
    dailyTaskDone,
    summary: summarizeRewards(reward),
  };
};

/**
 * 执行智能黑市购物流程
 *
 * @param {object} options
 * @param {(cmd: string, params: object) => Promise<object>} options.sendCommand - 发送游戏命令（需返回响应 body）
 * @param {(message: string, type?: string) => void} options.log - 日志输出
 * @returns {Promise<{ success: boolean, via: "batch"|"bronze"|"none", response: object, analysis: object }>}
 */
export const executeSmartBlackMarketPurchase = async ({
  sendCommand,
  log,
}) => {
  // 第一步：批量购买（只执行一次，无成交时服务器已消耗当日免费刷新）
  log("智能黑市购物: 第一步，尝试批量购买", "info");
  const batchResp = await sendCommand("store_purchase", {});
  log(`黑市批量购买响应: ${JSON.stringify(batchResp)}`, "info");
  const batchAnalysis = analyzeStoreBuyResp(batchResp);
  if (batchAnalysis.success) {
    log(
      `智能黑市购物: 批量购买有成交，停止（${batchAnalysis.summary}）`,
      "success",
    );
    return {
      success: true,
      via: "batch",
      response: batchResp,
      analysis: batchAnalysis,
    };
  }

  // 第二步：保底购买1次青铜宝箱（store_buy 指定商品位，不触发刷新）
  log(
    "智能黑市购物: 批量购买无成交，第二步保底购买青铜宝箱",
    "warning",
  );
  const bronzeResp = await sendCommand("store_buy", { goodsId: 1 });
  log(`黑市保底购买响应: ${JSON.stringify(bronzeResp)}`, "info");
  const bronzeAnalysis = analyzeStoreBuyResp(bronzeResp);
  if (bronzeAnalysis.success) {
    log(
      `智能黑市购物: 保底购买成功（${bronzeAnalysis.summary}）`,
      "success",
    );
    return {
      success: true,
      via: "bronze",
      response: bronzeResp,
      analysis: bronzeAnalysis,
    };
  }

  log(
    "智能黑市购物: 失败，批量购买与保底购买均无成交",
    "error",
  );
  return {
    success: false,
    via: "none",
    response: bronzeResp,
    analysis: bronzeAnalysis,
  };
};
