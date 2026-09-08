/**
 * 商店类任务
 * 包含: legion_storebuygoods, legionStoreBuySkinCoins, store_purchase, collection_claimfreereward, activityBuyRecruitWeekReward, activityClaimBoxWeekFreeRewards
 */
import { executeSmartBlackMarketPurchase } from "../smartBlackMarket.js";

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
    store_purchase,
    collection_claimfreereward,
  };
}
