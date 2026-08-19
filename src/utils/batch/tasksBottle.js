/**
 * 罐子类任务
 * 包含: resetBottles, batchlingguanzi
 */

import {
  getErrorMessage,
  isRateLimitError,
  RATE_LIMIT_MAX_RETRIES,
  RATE_LIMIT_RETRY_DELAY_MS,
  runWithRateLimitRetry,
} from "../helperTaskRunner.js";

function isBottleStartTimeoutError(error) {
  const message = getErrorMessage(error);
  return message.includes("请求超时") && message.includes("bottlehelper_start");
}

/**
 * 创建罐子类任务执行器
 * @param {Object} deps - 依赖项
 * @returns {Object} 任务函数集合
 */
export function createTasksBottle(deps) {
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
  } = deps;

  /**
   * 重置罐子
   */
  const resetBottles = async () => {
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
        await ensureConnection(tokenId);

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始重置罐子: ${token.name} ===`,
          type: "info",
        });

        // Execute commands
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 停止计时...`,
          type: "info",
        });
        await tokenStore.sendMessageWithPromise(
          tokenId,
          "bottlehelper_stop",
          {},
          5000,
        );

        await new Promise((r) => setTimeout(r, 500));

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 开始计时...`,
          type: "info",
        });
        await runWithRateLimitRetry({
          execute: () =>
            tokenStore.sendMessageWithPromise(
              tokenId,
              "bottlehelper_start",
              {},
              5000,
            ),
          retryDelayMs: RATE_LIMIT_RETRY_DELAY_MS,
          maxRetries: RATE_LIMIT_MAX_RETRIES,
          shouldRetry: (error) =>
            isRateLimitError(error) || isBottleStartTimeoutError(error),
          onRetry: ({ error, retryCount, maxRetries }) => {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 开始计时失败: ${getErrorMessage(error)}，1秒后重试（第${retryCount}/${maxRetries}次）`,
              type: "warning",
            });
          },
        });

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 重置完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 重置失败: ${error.message}`,
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
    message.success("批量重置罐子结束");
  };

  /**
   * 一键领取盐罐
   */
  const batchlingguanzi = async () => {
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
          message: `=== 开始一键领取盐罐: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId);
        if (shouldStop.value) return;
        await tokenStore.sendMessageWithPromise(
          tokenId,
          "bottlehelper_claim",
          {},
          5000,
        );
        await new Promise((r) => setTimeout(r, 500));
        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 领取盐罐已完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 领取盐罐失败: ${error.message || "未知错误"}`,
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
    message.success("批量领取盐罐结束");
  };

  return {
    resetBottles,
    batchlingguanzi,
  };
}
