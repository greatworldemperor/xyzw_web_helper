/**
 * 商店类任务
 * 包含: legion_storebuygoods, legionStoreBuySkinCoins, store_purchase, collection_claimfreereward, activityBuyRecruitWeekReward, activityClaimBoxWeekFreeRewards, activityBuyBlackMarketWeek, fetchBlackMarketGoods, activityBuyBlackMarketWeek
 */
import { executeSmartBlackMarketPurchase } from "../smartBlackMarket.js";

/**
 * 解析 Activity_GetResp 中的黑市周商品计划（模块级，供勾选弹窗与批量任务共用）
 * 免费商品（price<=0，黑市 9 / 金砖回馈商店 5）；付费商品（price>0，仅江湖黑市 9）
 * 返回全量商品（含已购满的，用 soldOut 标记），由调用方决定过滤策略
 */
export function parseBlackMarketPlan(actRoot) {
  // 实测结构（2026-09-13 probe 验证）：body.activity 是一个大对象，
  // 商品表在 body.activity.activity[]，myStoreInfo / myTotalInfo 也在 body.activity 下。
  // 兼容传入内层对象（activity 已是数组）的情况。
  const outer = actRoot?.activity;
  const root =
    outer && !Array.isArray(outer) && Array.isArray(outer.activity)
      ? outer
      : actRoot;
  const activityList = Array.isArray(root?.activity) ? root.activity : [];
  const storeInfo = root?.myStoreInfo ?? {};
  const boughtCount = (storeId, goodsIndex) =>
    Number(storeInfo?.[String(storeId)]?.complete?.[String(goodsIndex)]) || 0;

  const toEntries = (store, onlyFree) => {
    const goodsList = Array.isArray(store?.data?.goodsList)
      ? store.data.goodsList
      : [];
    const entries = [];
    goodsList.forEach((goods, goodsIndex) => {
      const price = Number(goods?.price) || 0;
      if (onlyFree && price > 0) return;
      if (!onlyFree && price <= 0) return;
      const limit = Number(goods?.limit) || 1;
      const bought = boughtCount(store.id, goodsIndex);
      const diamondGain = Array.isArray(goods?.rewardList)
        ? goods.rewardList
            .filter(
              (item) =>
                Number(item?.type) === 2 && Number(item?.itemId) === 2,
            )
            .reduce((sum, item) => sum + (Number(item?.value) || 0), 0)
        : 0;
      entries.push({
        key: `${store.id}:${goodsIndex}`,
        activityId: store.id,
        goodsIndex,
        title: goods?.title || `商品${goodsIndex}`,
        price,
        limit,
        bought,
        soldOut: bought >= limit,
        diamondGain,
      });
    });
    return entries;
  };

  const blackMarket = activityList.find((item) => item?.id === 9);
  const goldStore = activityList.find((item) => item?.id === 5);
  const milestone = root?.myTotalInfo?.["11"];

  return {
    blackMarket,
    goldStore,
    freeEntries: [
      ...toEntries(blackMarket, true),
      ...toEntries(goldStore, true),
    ],
    paidEntries: toEntries(blackMarket, false),
    milestoneNum: Number(milestone?.num) || 0,
  };
}

/**
 * 黑市周默认购买清单（master 指定）：免费件 + 常买 4 件付费商品
 * （见面礼600 / 惊喜礼1200 / 中级黑市包5000 / 顶级鱼竿包12000，与抓包购买记录一致）
 * 按商品标题匹配（而非 goodsIndex），避免官方调整商品顺序后 index 漂移买错商品
 */
export const DEFAULT_BLACK_MARKET_PAID_TITLES = [
  "黑市见面礼",
  "黑市惊喜礼",
  "中级黑市包",
  "顶级鱼竿包",
];

/**
 * 从商品列表解析默认勾选集：所有未购满的免费件 + 标题命中默认清单的付费件
 * @param {Array} goods parseBlackMarketPlan 产出的商品条目（含 key/price/title/soldOut）
 * @returns {string[]} key 数组（activityId:goodsIndex）
 */
export const resolveDefaultBlackMarketKeys = (goods) =>
  (Array.isArray(goods) ? goods : [])
    .filter(
      (goodsItem) =>
        !goodsItem.soldOut &&
        (Number(goodsItem.price) <= 0 ||
          (Number(goodsItem.activityId) === 9 &&
            DEFAULT_BLACK_MARKET_PAID_TITLES.includes(goodsItem.title))),
    )
    .map((goodsItem) => goodsItem.key);

/**
 * 创建商店类任务执行器
 * @param {Object} deps - 依赖项
 * @returns {Object} 任务函数集合
 */
export function createTasksStore(deps) {
  const {
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot,
    connectionQueue,
    batchSettings,
    tokenStore,
    addLog,
    message,
    currentRunningTokenId,
    delayConfig,
  } = deps;

  /**
   * 一键购买四圣碎片
   */
  const legion_storebuygoods = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始购买四圣碎片: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 发送购买请求...`,
          type: "info",
        });
        const result = await tokenStore.sendMessageWithPromise(
          tokenId,
          "legion_storebuygoods",
          { id: 6 },
          5000,
        );

        await new Promise((r) => setTimeout(r, delayConfig.action));

        if (result.error) {
          if (result.error.includes("俱乐部商品购买数量超出上限")) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 本周已购买过四圣碎片，跳过`,
              type: "info",
            });
          } else if (result.error.includes("物品不存在")) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 盐锭不足或未加入军团，购买失败`,
              type: "error",
            });
            tokenStatus.value[tokenId] = "failed";
          } else {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 购买失败: ${result.error}`,
              type: "error",
            });
            tokenStatus.value[tokenId] = "failed";
          }
        } else {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 购买成功，获得四圣碎片`,
            type: "success",
          });
          tokenStatus.value[tokenId] = "completed";
        }
      } catch (error) {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 购买过程出错: ${error.message}`,
          type: "error",
        });
        tokenStatus.value[tokenId] = "failed";
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;
  };

  /**
   * 一键购买俱乐部5皮肤币
   */
  const legionStoreBuySkinCoins = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始购买俱乐部5皮肤币: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 发送购买请求...`,
          type: "info",
        });

        let result = null;
        for (let i = 0; i < 5; i++) {
          if (shouldStop.value) break;
          result = await tokenStore.sendMessageWithPromise(
            tokenId,
            "legion_storebuygoods",
            { id: 1 },
            5000,
          );

          await new Promise((r) => setTimeout(r, delayConfig.action));
        }

        if (result && result.error) {
          if (result.error.includes("俱乐部商品购买数量超出上限")) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 本周已购买过皮肤币，跳过`,
              type: "info",
            });
          } else if (result.error.includes("物品不存在")) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 盐锭不足或未加入军团，购买失败`,
              type: "error",
            });
            tokenStatus.value[tokenId] = "failed";
          } else {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 购买失败: ${result.error}`,
              type: "error",
            });
            tokenStatus.value[tokenId] = "failed";
          }
        } else {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 购买成功，获得皮肤币`,
            type: "success",
          });
          tokenStatus.value[tokenId] = "completed";
        }
      } catch (error) {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 购买过程出错: ${error.message}`,
          type: "error",
        });
        tokenStatus.value[tokenId] = "failed";
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;
  };

  /**
   * 招募周一次性奖励（活动商店购买，5个招募令）
   * cmd: activity_buystoregoods { activityId: 6, goodsIndex: 0, buyNum: 1 }
   */
  const activityBuyRecruitWeekReward = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始领取招募周一次性奖励: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 发送购买请求...`,
          type: "info",
        });
        const result = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_buystoregoods",
          { activityId: 6, goodsIndex: 0, buyNum: 1 },
          5000,
        );

        await new Promise((r) => setTimeout(r, delayConfig.action));

        // 成功：服务器通过 SyncRewardResp 推送奖励，rawData 即响应 body
        const rewardText = Array.isArray(result.reward)
          ? result.reward.map((r) => `itemId ${r.itemId} ×${r.value}`).join("、")
          : "招募令×5";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 招募周一次性奖励领取成功（${rewardText}）`,
          type: "success",
        });
        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        // 服务器错误走 reject（"服务器错误: 1100010 - 招募周奖励本期已领取"）
        const msg = error.message || "";
        if (
          msg.includes("1100010") ||
          msg.includes("已领取") ||
          msg.includes("重复领取") ||
          msg.includes("超出上限")
        ) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 本期已领取过招募周奖励，跳过`,
            type: "info",
          });
        } else {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 招募周奖励领取过程出错: ${msg}`,
            type: "error",
          });
          tokenStatus.value[tokenId] = "failed";
        }
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;
  };

  const activityClaimBoxWeekFreeRewards = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);
      let hasActionError = false;
      let completedActionCount = 0;

      const isAlreadyClaimed = (messageText) =>
        ["1100010", "已领取", "重复领取", "超出上限"].some((text) =>
          messageText.includes(text),
        );

      const claimReward = async (label, command, params) => {
        try {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 发送${label}请求...`,
            type: "info",
          });

          const result = await tokenStore.sendMessageWithPromise(
            tokenId,
            command,
            params,
            5000,
          );

          await new Promise((resolve) =>
            setTimeout(resolve, delayConfig.action),
          );

          if (result?.error) {
            throw new Error(result.error);
          }

          const rewardText = Array.isArray(result?.reward)
            ? result.reward
                .map((reward) => `itemId ${reward.itemId} ×${reward.value}`)
                .join("、")
            : "奖励已同步";

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} ${label}成功（${rewardText}）`,
            type: "success",
          });
          completedActionCount += 1;
        } catch (error) {
          const errorMessage = error?.message || String(error);
          if (isAlreadyClaimed(errorMessage)) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} ${label}本期已领取，跳过`,
              type: "info",
            });
            completedActionCount += 1;
          } else {
            hasActionError = true;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} ${label}失败: ${errorMessage}`,
              type: "error",
            });
          }
        }
      };

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始领取宝箱周免费奖励: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        await claimReward("宝箱周活动福利", "activity_buystoregoods", {
          activityId: 7,
          goodsIndex: 0,
          buyNum: 1,
        });

        try {
          const discountInfo =
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "discount_getdiscountinfo",
              {},
              5000,
            );
          await new Promise((resolve) =>
            setTimeout(resolve, delayConfig.action),
          );
          const discount = Array.isArray(discountInfo?.discountList)
            ? discountInfo.discountList.find(
                (item) => item.discountId === 1,
              )
            : null;
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 红淬免费奖励状态: ${discount?.discountState ?? "未知"}`,
            type: "info",
          });
        } catch (error) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 红淬奖励状态查询失败，继续尝试领取: ${error?.message || String(error)}`,
            type: "info",
          });
        }

        if (!shouldStop.value) {
          await claimReward(
            "宝箱周红淬免费奖励",
            "activity_claimredquenchreward",
            {},
          );
        }

        tokenStatus.value[tokenId] =
          hasActionError || completedActionCount === 0
            ? "failed"
            : "completed";
      } catch (error) {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 宝箱周免费奖励过程出错: ${error?.message || String(error)}`,
          type: "error",
        });
        tokenStatus.value[tokenId] = "failed";
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;
  };

  /**
   * 黑市周奖励（江湖黑市 activityId=9 + 金砖商店免费项 activityId=5/0）
   *
   * 协议（见 docs/weekly-event-blackmarket-analysis.md，抓包已逐字节验证）：
   * - activity_get {} → Activity_GetResp：activity.activity[]（商品表+开放时间窗）、
   *   myStoreInfo（已购状态 goodsIndex→次数）、myTotalInfo["11"].num（金砖达标进度）
   * - activity_buystoregoods { activityId, goodsIndex, buyNum } → SyncRewardResp（resp=seq 可匹配）
   * - role_getroleinfo → body.role.diamond（金砖余额）
   * - bottlehelper_claim → 领取盐罐（产出自动折算金砖）
   *
   * 预算策略：金砖不够先领罐子；领完仍不够，从最贵的付费商品开始放弃，
   * 直到剩余商品买得起。免费商品永远保留（净赚金砖）。
   * 金砖商店的付费档位是充值礼包，永不购买。
   */
  const activityBuyBlackMarketWeek = async (selectedGoodsKeys) => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const isAlreadyBought = (messageText) =>
      ["1100010", "已领取", "已购买", "重复领取", "超出限购", "超出上限"].some(
        (text) => messageText.includes(text),
      );

    const queryDiamond = async (tokenId) => {
      const res = await tokenStore.sendMessageWithPromise(
        tokenId,
        "role_getroleinfo",
        {},
        8000,
      );
      const role = res?.role ?? res;
      const diamond = Number(role?.diamond);
      return Number.isFinite(diamond) ? diamond : null;
    };

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);
      let hasActionError = false;
      let boughtCount = 0;
      let skippedCount = 0;

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始黑市周奖励: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        // 1) 活动状态：商品表 + 已购状态 + 开放时间窗
        const actResp = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_get",
          {},
          8000,
        );
        const plan = parseBlackMarketPlan(actResp);

        // 按弹窗勾选过滤（未传 = 全部购买）；已购满的直接剔除
        const selection =
          Array.isArray(selectedGoodsKeys) && selectedGoodsKeys.length > 0
            ? new Set(selectedGoodsKeys)
            : null;
        const filterEntries = (entries) => {
          let list = entries.filter((entry) => !entry.soldOut);
          if (selection) {
            list = list.filter((entry) => selection.has(entry.key));
          }
          return list;
        };
        plan.freeEntries = filterEntries(plan.freeEntries);
        plan.paidEntries = filterEntries(plan.paidEntries);

        if (!plan.blackMarket || plan.blackMarket === undefined) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 未找到江湖黑市活动（可能不在黑市周），跳过`,
            type: "info",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        const openTime = plan.blackMarket.openTime
          ? Date.parse(plan.blackMarket.openTime)
          : null;
        const endTime = plan.blackMarket.endTime
          ? Date.parse(plan.blackMarket.endTime)
          : null;
        if (
          (openTime && Date.now() < openTime) ||
          (endTime && Date.now() > endTime)
        ) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 江湖黑市不在开放时间内，跳过`,
            type: "info",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        if (plan.freeEntries.length === 0 && plan.paidEntries.length === 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 本期黑市/金砖回馈已全部购买，跳过`,
            type: "info",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        // 2) 金砖余额与达标进度
        let balance = await queryDiamond(tokenId);
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 当前金砖 ${balance ?? "未知"}，金砖达标进度 ${plan.milestoneNum}；待购买：免费 ${plan.freeEntries.length} 件，付费 ${plan.paidEntries.length} 件`,
          type: "info",
        });

        // 3) 预算规划：免费净赚金砖，付费按价格升序，不够则放弃最贵
        const freeGain = plan.freeEntries.reduce(
          (sum, entry) => sum + entry.diamondGain,
          0,
        );
        const paidEntries = [...plan.paidEntries].sort(
          (a, b) => a.price - b.price,
        );
        const netCost = (list) =>
          list.reduce((sum, entry) => sum + entry.price, 0) - freeGain;

        if (balance !== null && balance < netCost(paidEntries)) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 金砖不足（净支出需 ${netCost(paidEntries)}，含免费项返还 ${freeGain}），先领取罐子...`,
            type: "info",
          });
          try {
            const claimResult = await tokenStore.sendMessageWithPromise(
              tokenId,
              "bottlehelper_claim",
              {},
              5000,
            );
            await new Promise((resolve) =>
              setTimeout(resolve, delayConfig.action),
            );
            const claimText = Array.isArray(claimResult?.reward)
              ? claimResult.reward
                  .map((item) => `itemId ${item.itemId} ×${item.value}`)
                  .join("、")
              : "奖励已同步";
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 罐子领取成功（${claimText}）`,
              type: "success",
            });
          } catch (error) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 领取罐子失败（可能本期无可领），按现有余额继续: ${error?.message || String(error)}`,
              type: "info",
            });
          }
          const refreshed = await queryDiamond(tokenId);
          if (refreshed !== null) balance = refreshed;
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 领罐子后金砖 ${balance ?? "未知"}`,
            type: "info",
          });
        }

        const chosen = [...paidEntries];
        const dropped = [];
        while (
          chosen.length > 0 &&
          balance !== null &&
          balance < netCost(chosen)
        ) {
          dropped.push(chosen.pop());
        }
        if (dropped.length > 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 金砖仅够 ${chosen.length}/${paidEntries.length} 件付费商品，放弃最贵：${dropped
              .map((entry) => `${entry.title}(${entry.price})`)
              .join("、")}`,
            type: "warning",
          });
        }

        // 4) 执行：价格升序（免费在前）
        const executionList = [...plan.freeEntries, ...chosen].sort(
          (a, b) => a.price - b.price,
        );
        for (const entry of executionList) {
          if (shouldStop.value) break;
          try {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 购买 ${entry.title}${entry.price > 0 ? `（${entry.price} 金砖）` : "（免费）"}...`,
              type: "info",
            });
            const result = await tokenStore.sendMessageWithPromise(
              tokenId,
              "activity_buystoregoods",
              {
                activityId: entry.activityId,
                goodsIndex: entry.goodsIndex,
                buyNum: 1,
              },
              5000,
            );
            await new Promise((resolve) =>
              setTimeout(resolve, delayConfig.action),
            );

            const latestDiamond = Number(result?.role?.diamond);
            if (Number.isFinite(latestDiamond)) balance = latestDiamond;

            const rewardText = Array.isArray(result?.reward)
              ? result.reward
                  .map((item) => `itemId ${item.itemId} ×${item.value}`)
                  .join("、")
              : "奖励已同步";
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} ${entry.title} 购买成功（${rewardText}${Number.isFinite(latestDiamond) ? `，余 ${latestDiamond}` : ""}）`,
              type: "success",
            });
            boughtCount += 1;
          } catch (error) {
            const errorMessage = error?.message || String(error);
            if (isAlreadyBought(errorMessage)) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} ${entry.title} 本期已购买，跳过`,
                type: "info",
              });
              skippedCount += 1;
            } else {
              hasActionError = true;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} ${entry.title} 购买失败: ${errorMessage}`,
                type: "error",
              });
            }
          }
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 黑市周奖励结束：购买 ${boughtCount} 件${skippedCount ? `，已购跳过 ${skippedCount} 件` : ""}${balance !== null ? `，剩余金砖 ${balance}` : ""} ===`,
          type: hasActionError ? "warning" : "success",
        });

        tokenStatus.value[tokenId] = hasActionError ? "failed" : "completed";
      } catch (error) {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 黑市周奖励过程出错: ${error?.message || String(error)}`,
          type: "error",
        });
        tokenStatus.value[tokenId] = "failed";
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;
  };

  /**
   * 拉取黑市周商品列表（供勾选弹窗展示）
   * 商品定义全服一致；已购状态为第一个选中账号的视角，
   * 执行时各账号会再按自身已购状态过滤。
   */
  const fetchBlackMarketGoods = async () => {
    if (selectedTokens.value.length === 0) {
      throw new Error("请先选择账号");
    }
    const tokenId = selectedTokens.value[0];
    const token = tokens.value.find((t) => t.id === tokenId);
    try {
      await ensureConnection(tokenId);
      const actResp = await tokenStore.sendMessageWithPromise(
        tokenId,
        "activity_get",
        {},
        8000,
      );
      const plan = parseBlackMarketPlan(actResp);
      if (!plan.blackMarket) {
        throw new Error("未找到江湖黑市活动（可能不在黑市周）");
      }
      return {
        previewTokenName: token?.name || String(tokenId),
        goods: [...plan.freeEntries, ...plan.paidEntries],
      };
    } finally {
      tokenStore.closeWebSocketConnection(tokenId);
      releaseConnectionSlot();
    }
  };

  /**
   * 免费领取珍宝阁每日奖励
   */
  const collection_claimfreereward = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;
    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始免费领取珍宝阁: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 发送珍宝阁免费领取请求...`,
          type: "info",
        });
        const result = await tokenStore.sendMessageWithPromise(
          tokenId,
          "collection_claimfreereward",
          {},
          5000,
        );

        await new Promise((r) => setTimeout(r, delayConfig.action));

        if (result.error) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 珍宝阁领取失败: ${result.error}`,
            type: "error",
          });
          tokenStatus.value[tokenId] = "failed";
        } else {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 珍宝阁领取成功`,
            type: "success",
          });
          tokenStatus.value[tokenId] = "completed";
        }
      } catch (error) {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 珍宝阁领取过程出错: ${error.message}`,
          type: "error",
        });
        tokenStatus.value[tokenId] = "failed";
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;
  };

  /**
   * 智能黑市购物（原一键黑市采购）
   */
  const store_purchase = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始智能黑市购物: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        const result = await executeSmartBlackMarketPurchase({
          sendCommand: async (cmd, params) => {
            const resp = await tokenStore.sendMessageWithPromise(
              tokenId,
              cmd,
              params,
              5000,
            );
            await new Promise((r) => setTimeout(r, delayConfig.action));
            return resp;
          },
          log: (msg, type) =>
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} ${msg}`,
              type: type || "info",
            }),
        });

        if (result.success) {
          tokenStatus.value[tokenId] = "completed";
        } else {
          tokenStatus.value[tokenId] = "failed";
        }
      } catch (error) {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 智能黑市购物过程出错: ${error.message}`,
          type: "error",
        });
        tokenStatus.value[tokenId] = "failed";
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;
  };

  return {
    legion_storebuygoods,
    legionStoreBuySkinCoins,
    activityBuyRecruitWeekReward,
    activityClaimBoxWeekFreeRewards,
    activityBuyBlackMarketWeek,
    fetchBlackMarketGoods,
    store_purchase,
    collection_claimfreereward,
  };
}
