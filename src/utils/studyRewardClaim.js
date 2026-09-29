/**
 * 答题奖励领取（1-10 档）
 *
 * 🔴 背景（2026-09-29 修复「答对了但后面几档漏领」）：
 * 旧实现是 `client.send('study_claimreward')` 裸发 + 200ms 间隔 —— 不等 ack、
 * 不重试、不感知限流。批量跑时每个角色要发 10 题答案 + 10 档奖励 ≈ 20 帧，
 * 很容易在后面几档撞上服务器限流，被拒的帧静默丢失，表现为
 * 「题目明明都答对了，后面几个奖励却没领到」。
 *
 * 现在改为：带 ack 发送 → 可重试的错误退避重试 → 首轮未确认的档位再补领一轮。
 */

import { isRateLimitError } from "./helperTaskRunner.js";

export const STUDY_REWARD_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const CLAIM_INTERVAL_MS = 350;
export const CLAIM_MAX_ATTEMPTS = 3;
export const CLAIM_ACK_TIMEOUT_MS = 4000;
export const CLAIM_RETRY_BACKOFF_MS = 2000;

const noop = () => {};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const getClaimErrorText = (error) =>
  [error?.message, error?.error, error?.hint, error?.msg]
    .filter(Boolean)
    .join(" ");

/**
 * 只有「这一帧可能压根没被服务端处理」的错误才重试：限流 / 超时 / 断连。
 * 业务拒绝（已领取、未达标、参数错）重试也没用，直接判终态。
 */
export const isRetryableClaimError = (error) => {
  const text = getClaimErrorText(error);
  return (
    isRateLimitError(error) ||
    text.includes("请求超时") ||
    text.includes("WebSocket") ||
    text.includes("连接已关闭")
  );
};

/**
 * 领取全部答题奖励
 * @param {Object} client - WebSocket 客户端（需支持 send / sendWithPromise）
 * @param {Object} [options] - 可调参数（便于测试）
 * @returns {Promise<{claimed: number[], failed: number[]}>}
 */
export const claimAllStudyRewards = async (client, options = {}) => {
  const {
    rewardIds = STUDY_REWARD_IDS,
    intervalMs = CLAIM_INTERVAL_MS,
    maxAttempts = CLAIM_MAX_ATTEMPTS,
    ackTimeoutMs = CLAIM_ACK_TIMEOUT_MS,
    backoffMs = CLAIM_RETRY_BACKOFF_MS,
    sleepFn = defaultSleep,
    logVerbose = noop,
    logWarn = noop,
  } = options;

  const claimed = [];
  const failed = [];
  // ack 可用性：某档连试 maxAttempts 次都收不到响应（服务端不回 resp）时
  // 降级为裸发，避免后续每档都白等 ackTimeoutMs。
  let useAck = true;

  const attemptClaim = async (rewardId) => {
    if (!client) return false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!useAck) {
        client.send("study_claimreward", { rewardId });
        return true;
      }

      try {
        await client.sendWithPromise(
          "study_claimreward",
          { rewardId },
          ackTimeoutMs,
        );
        return true;
      } catch (error) {
        if (!isRetryableClaimError(error)) {
          logVerbose(
            `奖励 ${rewardId} 领取被拒（业务错误，不重试）: ${getClaimErrorText(error)}`,
          );
          return false;
        }
        if (attempt < maxAttempts) {
          await sleepFn(backoffMs);
          continue;
        }
        logWarn(
          `奖励 ${rewardId} 连续 ${maxAttempts} 次无响应，降级为直接发送`,
        );
        useAck = false;
        client.send("study_claimreward", { rewardId });
        return true;
      }
    }
    return false;
  };

  for (const rewardId of rewardIds) {
    const ok = await attemptClaim(rewardId);
    if (ok) {
      claimed.push(rewardId);
    } else {
      failed.push(rewardId);
    }
    await sleepFn(intervalMs);
  }

  // 补领：第一轮没确认到的档位再走一遍（限流通常是瞬时的，第二轮基本能补上）
  if (failed.length) {
    logWarn(
      `第一轮有 ${failed.length} 档奖励未确认领取，补领一遍: ${failed.join(",")}`,
    );
    await sleepFn(backoffMs);
    const retryIds = [...failed];
    failed.length = 0;
    for (const rewardId of retryIds) {
      const ok = await attemptClaim(rewardId);
      if (ok) {
        claimed.push(rewardId);
      } else {
        failed.push(rewardId);
      }
      await sleepFn(intervalMs);
    }
  }

  claimed.sort((a, b) => a - b);
  return { claimed, failed };
};
