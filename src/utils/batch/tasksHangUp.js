/**
 * 挂机、答题、签到类任务
 * 包含: claimHangUpRewards, batchAddHangUpTime, batchStudy, batchclubsign
 */

import {
  getErrorMessage,
  isRateLimitError,
  RATE_LIMIT_MAX_RETRIES,
  RATE_LIMIT_RETRY_DELAY_MS,
  runWithRateLimitRetry,
} from "../helperTaskRunner.js";
import {
  getStudyStatus,
  resetStudyStatus,
  waitStudyFinish,
} from "../studyStatusStore.js";

// 一轮答题的完整耗时上限：10 题 ×300ms + 1500ms + 10 个奖励 ×200ms ≈ 6.5s，
// 留足余量到 60s；超过即判定失败，不再干等。
const STUDY_FINISH_TIMEOUT_MS = 60000;

function isHangUpRewardTimeoutError(error) {
  const message = getErrorMessage(error);
  return (
    message.includes("请求超时") &&
    message.includes("system_claimhangupreward")
  );
}

/**
 * 创建挂机、答题、签到类任务执行器
 * @param {Object} deps - 依赖项
 * @returns {Object} 任务函数集合
 */
export function createTasksHangUp(deps) {
  const {
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    waitForConnectionSlot,
    ensureConnection,
    releaseConnectionSlot,
    connectionQueue,
    batchSettings,
    tokenStore,
    addLog,
    message,
    currentRunningTokenId,
    batchResult,
    showBatchResultModal,
    delayConfig,
  } = deps;

  const hangUpRetryDelayMs = Number.isFinite(Number(delayConfig?.retry))
    ? Number(delayConfig.retry)
    : RATE_LIMIT_RETRY_DELAY_MS;

  const sendHangUpCommand = (
    tokenId,
    tokenName,
    command,
    params,
    timeout,
    operation,
    shouldRetry = isRateLimitError,
  ) =>
    runWithRateLimitRetry({
      execute: () =>
        tokenStore.sendMessageWithPromise(tokenId, command, params, timeout),
      retryDelayMs: hangUpRetryDelayMs,
      maxRetries: RATE_LIMIT_MAX_RETRIES,
      shouldRetry,
      onRetry: ({ error, retryCount }) => {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${tokenName} ${operation}暂时失败: ${getErrorMessage(error)}，${
            Math.round(hangUpRetryDelayMs / 1000)
          }秒后重试（第${retryCount}次）`,
          type: "warning",
        });
      },
    });

  /**
   * 领取挂机奖励
   */
  const claimHangUpRewards = async () => {
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
          message: `=== 开始领取挂机: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        // 1. Claim reward
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 领取挂机奖励`,
          type: "info",
        });
        await sendHangUpCommand(
          tokenId,
          token.name,
          "system_claimhangupreward",
          {},
          5000,
          "领取挂机奖励",
          (error) =>
            isRateLimitError(error) || isHangUpRewardTimeoutError(error),
        );
        await new Promise((r) => setTimeout(r, 500));

        // 2. Add time 4 times
        for (let i = 0; i < 4; i++) {
          if (shouldStop.value) break;
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 挂机加钟 ${i + 1}/4`,
            type: "info",
          });
          await sendHangUpCommand(
            tokenId,
            token.name,
            "system_mysharecallback",
            { isSkipShareCard: true, type: 2 },
            5000,
            `挂机加钟 ${i + 1}/4`,
          );
          await new Promise((r) => setTimeout(r, 500));
        }

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 领取挂机奖励完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 领取挂机奖励失败: ${error.message}`,
          type: "error",
        });
      } finally {
        await tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量领取挂机结束");
  };

  /**
   * 一键加钟
   */
  const batchAddHangUpTime = async () => {
    if (selectedTokens.value.length === 0) return;
    const batchTokenIds = [...selectedTokens.value];

    batchResult.completedCount = 0;
    batchResult.totalCount = batchTokenIds.length;
    batchResult.failedTokenIds = [];
    isRunning.value = true;
    shouldStop.value = false;

    batchTokenIds.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = batchTokenIds.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);
      const tokenName = token?.name || tokenId;
      let retryCount = 0;
      let success = false;
      let slotAcquired = false;

      try {
        await waitForConnectionSlot();
        slotAcquired = true;

        while (!success && !shouldStop.value) {
          try {
            addLog({
              time: new Date().toLocaleTimeString(),
              message:
                retryCount === 0
                  ? `=== 开始一键加钟: ${tokenName} ===`
                  : `=== 尝试重试加钟: ${tokenName} (第${retryCount}次) ===`,
              type: "info",
            });

            await ensureConnection(tokenId, 2, true, true);

            for (let i = 0; i < 4; i++) {
              if (shouldStop.value) break;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${tokenName} 执行加钟 ${i + 1}/4`,
                type: "info",
              });
              await sendHangUpCommand(
                tokenId,
                tokenName,
                "system_mysharecallback",
                { isSkipShareCard: true, type: 2 },
                5000,
                `加钟 ${i + 1}/4`,
              );
              await new Promise((r) => setTimeout(r, 500));
            }

            if (shouldStop.value) break;

            success = true;
            tokenStatus.value[tokenId] = "completed";
            batchResult.completedCount++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== ${tokenName} 加钟完成 ===`,
              type: "success",
            });
          } catch (error) {
            console.error(error);
            if (shouldStop.value) {
              tokenStatus.value[tokenId] = "failed";
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${tokenName} 加钟失败: ${error.message || "未知错误"}`,
                type: "error",
              });
              break;
            }

            retryCount++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${tokenName} 加钟出错: ${error.message || "未知错误"}，等待5秒后重试第${retryCount}次...`,
              type: "warning",
            });
            await new Promise((r) => setTimeout(r, 5000));
          } finally {
            await tokenStore.closeWebSocketConnection(tokenId);
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${tokenName} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
              type: "info",
            });
          }
        }

        if (!success && tokenStatus.value[tokenId] === "running") {
          tokenStatus.value[tokenId] = "failed";
        }
      } finally {
        if (slotAcquired) {
          releaseConnectionSlot();
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${tokenName} 任务槽位已释放 (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
            type: "info",
          });
        }
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    batchResult.failedTokenIds = batchTokenIds.filter(
      (tokenId) => tokenStatus.value[tokenId] === "failed",
    );
    showBatchResultModal.value = true;
    message.success("批量加钟结束");
  };

  /**
   * 一键答题
   */
  const batchStudy = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    // Preload questions
    const { preloadQuestions } = await import("@/utils/studyQuestionsFromJSON.js");
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `正在加载题库...`,
      type: "info",
    });
    await preloadQuestions();

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始答题: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        // 🔴 重置当前角色的答题状态（按 tokenId 隔离，不能用全局 gameData.studyStatus，
        // 否则并发角色互相覆盖：A 误读 B 的 completed → 提前关连接 → 答案/奖励丢失）
        resetStudyStatus(tokenId);

        // Send start command
        await tokenStore.sendMessageWithPromise(
          tokenId,
          "study_startgame",
          {},
          5000,
        );

        // 阶段日志：只做展示，判定交给 waitStudyFinish 的 Promise 握手
        let lastStatus = "";
        const statusLogger = setInterval(() => {
          const status = getStudyStatus(tokenId);
          if (status.status === lastStatus) return;
          lastStatus = status.status;
          if (status.status === "answering") {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 开始答题...`,
              type: "info",
            });
          } else if (status.status === "claiming_rewards") {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 领取奖励...`,
              type: "info",
            });
          }
        }, 500);

        let stopTimer = null;
        const stopWatcher = new Promise((_, reject) => {
          stopTimer = setInterval(() => {
            if (shouldStop.value) {
              reject(new Error("已手动停止"));
            }
          }, 500);
        });

        let completed = false;
        try {
          await Promise.race([
            waitStudyFinish(tokenId, STUDY_FINISH_TIMEOUT_MS),
            stopWatcher,
          ]);
          completed = true;
        } finally {
          clearInterval(statusLogger);
          if (stopTimer) clearInterval(stopTimer);
        }

        if (completed) {
          const status = getStudyStatus(tokenId);
          const claimed = status.claimedRewardIds?.length || 0;
          const missed = status.failedRewardIds?.length || 0;
          tokenStatus.value[tokenId] = "completed";
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== ${token.name} 答题完成（${status.answeredCount}/${status.questionCount} 题，奖励 ${claimed}/${claimed + missed}） ===`,
            type: missed > 0 ? "warning" : "success",
          });
          if (missed > 0) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 有 ${missed} 档奖励未确认领取（档位 ${status.failedRewardIds.join("、")}），建议手动补领`,
              type: "warning",
            });
          }
        }
      } catch (error) {
        console.error(error);
        if (shouldStop.value) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 已停止`,
            type: "warning",
          });
        } else {
          tokenStatus.value[tokenId] = "failed";
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 答题失败: ${error.message || "未知错误"}`,
            type: "error",
          });
        }
      } finally {
        await tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量答题结束");
  };

  /**
   * 一键俱乐部签到
   */
  const batchclubsign = async () => {
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
          message: `=== 开始一键俱乐部签到: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId);
        if (shouldStop.value) return;
        await tokenStore.sendMessageWithPromise(
          tokenId,
          "legion_signin",
          {},
          5000,
        );
        await new Promise((r) => setTimeout(r, 500));
        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 俱乐部签到已完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 俱乐部签到失败: ${error.message || "未知错误"}`,
          type: "error",
        });
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
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量俱乐部签到结束");
  };

  /**
   * 月赛助威
   * @param {number} legionId - 俱乐部ID
   * @param {number} guessCoin - 竞猜币数量
   */
  const batchWarGuessCheer = async (legionId, guessCoin) => {
    if (selectedTokens.value.length === 0) {
      message.warning("请先选择账号");
      return;
    }
    if (!legionId) {
      message.warning("请选择要助威的俱乐部");
      return;
    }
    
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
          message: `=== 开始助威: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId);
        
        // 尝试领取拍手器
        try {
          const rewardRes = await tokenStore.sendMessageWithPromise(
            tokenId,
            "warguess_getguesscoinreward",
            {},
            3000 // 短超时，因为这不是关键步骤
          );
          if (rewardRes && rewardRes.reward) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== ${token.name} 领取拍手器成功 ===`,
              type: "success",
            });
          }
        } catch (e) {
          // 忽略领取失败
          // console.warn("领取拍手器失败", e);
        }

        // 获取助威数据以判断次数
        const rankRes = await tokenStore.sendMessageWithPromise(
          tokenId,
          "warguess_getrank",
          { bfId: '' },
          5000,
        );

        let totalGuessNum = 0;
        if (rankRes && rankRes.list) {
          let list = [];
          if (Array.isArray(rankRes.list)) {
            list = rankRes.list;
          } else {
            list = Object.values(rankRes.list);
          }
          totalGuessNum = list.reduce((sum, item) => sum + (item.guessNum || 0), 0);
        }

        if (totalGuessNum === 20) {
             addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 助威次数已满 (${totalGuessNum}/20)，跳过 ===`,
                type: "warning",
              });
             tokenStatus.value[tokenId] = "completed";
             return;
        }

        let coinToUse = Number(guessCoin);
        const remaining = 20 - totalGuessNum;
        
        if (coinToUse > remaining) {
            addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 剩余助威次数不足，调整为 ${remaining} 次 (原计划: ${coinToUse}) ===`,
                type: "info",
            });
            coinToUse = remaining;
        }

        if (coinToUse <= 0) {
             tokenStatus.value[tokenId] = "completed";
             return;
        }

        const result = await tokenStore.sendMessageWithPromise(
          tokenId,
          "warguess_startguess",
          { guessCoin: coinToUse, legionId: legionId },
          5000,
        );

        if (result && result.guessLegion) {
             addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 助威成功 (当前次数: ${result.guessLegion.guessNum}/20) ===`,
                type: "success",
              });
             tokenStatus.value[tokenId] = "completed";
        } else {
             addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 助威失败 ===`,
                type: "error",
              });
             tokenStatus.value[tokenId] = "failed";
        }
      } catch (error) {
        console.error(error);
        
        // Handle specific error: 400000 - Item does not exist (feature locked)
        if (error.code === 400000 || (error.message && error.message.includes("400000"))) {
          tokenStatus.value[tokenId] = "completed"; // Mark as completed (skipped)
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== ${token.name} 助威失败: 未解锁该功能===`,
            type: "warning",
          });
        } else {
          tokenStatus.value[tokenId] = "failed";
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 助威失败: ${error.message || "未知错误"}`,
            type: "error",
          });
        }
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量助威结束");
  };

  return {
    claimHangUpRewards,
    batchAddHangUpTime,
    batchStudy,
    batchclubsign,
    batchWarGuessCheer,
  };
}
