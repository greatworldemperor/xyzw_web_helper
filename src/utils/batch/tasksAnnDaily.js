/**
 * 周年庆每日奖励（临时活动批量任务，2026-10-16 接入）
 *
 * 协议证据：`local-data/ann_daily/`（HttpCanary 抓的 wss bin，x 加密 + BON，
 * 用 `local-data/ann_daily/_decode.mjs` 走生产 `bonProtocol.js` 解码，24 帧全部零错位）：
 *
 *   请求  activity_warordertaskclaim { actId: 2610169, missionId: 2610169XX }
 *         → Activity_WarOrderClaimResp（带 warOrderActivityInfo[2610169] 快照）
 *   快照  complete:      {01:21, 02:3, 03:3, 04:3, 05:10, 06~14:0}
 *         taskClaimed:   {01:true, 03:true, 04:true, 05:true, 02/06~14:false}
 *   奖励  每领一次 = 道具 5290 ×1（响应 body.reward[0] = {type:3, itemId:5290, value:1}）
 *
 * 本期每日奖励共 5 个（序号 01~05，与 master 口径一致）；序号 06+ 服务端进度为 0。
 *
 * 实现口径（master 2026-10-16 拍板：很单纯的领取指令，别搞复杂）：
 *   - actId / 5 个 missionId 全硬编码（临时活动，下期轮换再改常量）；
 *   - 不前置 activity_get 探测，直接领 5 个；服务端拒绝（已领取 / 未达成 /
 *     活动未开 / 200020 不可领）算 benign，只记日志不算失败；
 *   - 🔴 单个序号的错误**不短路**后面的序号（master 2026-10-17 口径：每天分几次领，
 *     某个未达成/被拒不该影响其余领取）——全部序号跑完才结算账号状态；
 *   - 触发限流(400340)立即停本账号剩余领取（下次再跑）；
 *   - **超时/断连恢复**：强制刷新 Token + 重建 WSS → 重发（deps.reconnectWithFreshToken，
 *     master 口径：超时重试不是固定次数盲发；与 tasksAnnBoss.sendWithRecovery 同款）；
 *   - 连接生命周期与助威模块同口径：ensureConnection → finally close + releaseSlot。
 */

import {
  getErrorMessage,
  isConnectionError,
  isRateLimitError as isProjectRateLimitError,
} from "../helperTaskRunner.js";

const nowText = () => new Date().toLocaleTimeString();

/** 服务端错误信封 → 判定文本（createServerError 会把 error / message 都挂上） */
const errorText = (error) =>
  String(error?.error || error?.message || error || "");

/** 已领过：属于幂等重跑的常态，不算失败 */
const isAlreadyDoneError = (error) =>
  /已领取|已经领取|领取过|重复领取|本期已/.test(errorText(error));

/** 任务未达成完成条件（序号有进度但不够 / 纯未达成）：正常跳过 */
const isNotCompletedError = (error) =>
  /未达成|未完成|条件不满足/.test(errorText(error));

/** 活动未开 / ID 无效：提示为主，不算失败 */
const isInactiveError = (error) =>
  /未开启|未开始|已结束|活动不存在|无效的ID|未开放/.test(errorText(error));

/** 服务端限流（沿用项目通用码）：不是失败，是「这次别连发了」 */
const isRateLimitError = (error) => Number(error?.code) === 400340;

/**
 * 领取类 `200020`：服务端「出了点小问题，请尝试重启游戏解决～」= 该奖励当前不可领
 * （已领过 / 未解锁）。wss-diag-2026-10-17T09-11-50.jsonl 实证（momo222 被拒）。
 * 对领取类是 benign——跳过并带码记日志，不当失败。
 */
const isClaimUnavailableError = (error) =>
  Number(error?.code) === 200020 || /出了点小问题/.test(errorText(error));

/** 奖励字段 → 可读文案 */
const rewardText = (response) => {
  const list = Array.isArray(response?.reward) ? response.reward : [];
  if (list.length === 0) return "奖励已同步";
  return list
    .map((item) => `itemId ${item.itemId} ×${item.value}`)
    .join("、");
};

/** 本期周年庆战令活动实例 ID（抓包实证：warOrderActivityInfo 的键） */
export const ANN_DAILY_ACT_ID = 2610169;

/** 本期每日奖励序号（01~05，共 5 个） */
export const ANN_DAILY_MISSION_SEQS = Object.freeze([1, 2, 3, 4, 5]);

/**
 * 5 个每日奖励的 missionId（= actId×100 + 序号）
 * 抓包实证：`261016901 / 261016903 / 261016905` 三条请求逐字节复现一致。
 */
export const ANN_DAILY_MISSION_IDS = Object.freeze(
  ANN_DAILY_MISSION_SEQS.map((seq) => ANN_DAILY_ACT_ID * 100 + seq),
);

/** 两条领取指令之间的间隔（ms）：比抓包里手点的 ~2s 快，但不连发 */
const CLAIM_INTERVAL_MS = 500;

export function createTasksAnnDaily(deps) {
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
    // 「超时/断连」恢复：强制刷新 Token + 重建 WSS（视图层注入）
    reconnectWithFreshToken,
    addLog,
    message,
    currentRunningTokenId,
  } = deps;

  const log = (tokenName, text, type = "info") =>
    addLog({ time: nowText(), message: `${tokenName} ${text}`, type });

  const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  /**
   * 带「刷新 Token 后重试」能力的发送（master 2026-10-17 口径：
   * 超时重试不是固定次数盲发，而是刷新 token 后重试；与 tasksAnnBoss 同款）。
   * 连接类错误 → 强制刷新 Token + 重建 WSS → 重发（最多 2 轮）；
   * 限流 / 业务拒绝原样抛出。
   */
  const sendWithRecovery = async (tokenId, tokenName, cmd, params, timeout, label) => {
    for (let round = 0; ; round += 1) {
      try {
        return await tokenStore.sendMessageWithPromise(tokenId, cmd, params, timeout);
      } catch (error) {
        if (
          shouldStop.value ||
          round >= 2 ||
          !isConnectionError(error) ||
          isProjectRateLimitError(error)
        ) {
          throw error;
        }
        log(
          tokenName,
          `${label}失败（${getErrorMessage(error)}），强制刷新Token并重建WSS后重试（第${round + 1}/2次）`,
          "warning",
        );
        await reconnectWithFreshToken?.(tokenId, `${label}失败（第${round + 1}次）`);
      }
    }
  };

  /**
   * 单个账号：依次领 5 个每日奖励
   * 🔴 单个序号的错误不短路后面的序号（master：每天分几次领），
   *    全部跑完才结算；有硬失败记 "failed" 让账号状态可见（重跑幂等）。
   * @returns {"claimed"|"nothing"|"failed"}
   */
  const claimForToken = async ({ tokenId, token }) => {
    const tokenName = token?.name || tokenId;
    let claimed = 0;
    let hardFailed = false;

    for (const missionId of ANN_DAILY_MISSION_IDS) {
      if (shouldStop.value) break;
      const seqText = String(missionId).slice(-2);
      try {
        const response = await sendWithRecovery(
          tokenId,
          tokenName,
          "activity_warordertaskclaim",
          { actId: ANN_DAILY_ACT_ID, missionId },
          8000,
          `周年庆每日奖励 ${seqText}`,
        );
        claimed += 1;
        log(
          tokenName,
          `周年庆每日奖励 ${seqText} 领取成功（${rewardText(response)}）`,
          "success",
        );
      } catch (error) {
        if (isRateLimitError(error)) {
          // ⚠️ 不能 continue（会跳过末尾 sleep 变成连发）→ 直接结束本账号
          log(tokenName, "触发限流(400340)，周年庆每日奖励下次再领", "warning");
          break;
        }
        const text = errorText(error);
        if (isClaimUnavailableError(error)) {
          log(tokenName, `周年庆每日奖励 ${seqText} 当前不可领（200020：已领过/未解锁），跳过`);
        } else if (isAlreadyDoneError(error)) {
          log(tokenName, `周年庆每日奖励 ${seqText} 已领取过，跳过`);
        } else if (isNotCompletedError(error)) {
          log(tokenName, `周年庆每日奖励 ${seqText} 任务未达成，跳过`);
        } else if (isInactiveError(error)) {
          log(tokenName, `周年庆每日奖励暂未开放：${text}`, "warning");
        } else {
          // 硬失败：记日志 + 账号标 failed，但**继续领后面的序号**
          log(tokenName, `周年庆每日奖励 ${seqText} 领取失败：${text}（继续领下一个）`, "error");
          hardFailed = true;
        }
      }
      await sleep(CLAIM_INTERVAL_MS);
    }

    if (hardFailed) return "failed";
    return claimed > 0 ? "claimed" : "nothing";
  };

  /** 批量领取周年庆每日奖励（对所有选中账号） */
  const batchAnnDailyClaim = async () => {
    if (selectedTokens.value.length === 0) {
      message.warning("请先选择账号");
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
      const token = tokens.value.find((item) => item.id === tokenId);
      const tokenName = token?.name || tokenId;

      try {
        addLog({
          time: nowText(),
          message: `=== 开始领取周年庆每日奖励: ${tokenName} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        const outcome = await claimForToken({ tokenId, token });
        if (outcome === "failed") {
          tokenStatus.value[tokenId] = "failed";
        } else {
          // claimed / nothing（全已领或未达成）都算正常结束
          tokenStatus.value[tokenId] = "completed";
        }
      } catch (error) {
        if (isRateLimitError(error)) {
          tokenStatus.value[tokenId] = "completed";
          log(tokenName, "触发限流(400340)，周年庆每日奖励下次再试", "warning");
        } else if (isInactiveError(error)) {
          tokenStatus.value[tokenId] = "completed";
          log(tokenName, `周年庆活动暂未开放：${errorText(error)}`, "warning");
        } else {
          tokenStatus.value[tokenId] = "failed";
          log(tokenName, `周年庆每日奖励失败：${errorText(error)}`, "error");
        }
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: nowText(),
          message: `${tokenName} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;
    message.success("批量领取周年庆每日奖励结束");
  };

  return { batchAnnDailyClaim };
}
