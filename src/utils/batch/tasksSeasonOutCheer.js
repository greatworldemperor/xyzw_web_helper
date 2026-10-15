/**
 * 盐场「赛季淘汰赛助威」批量任务（天工投票）
 *
 * 协议证据：`local-data/tiangong_vote/vote.jsonl`（2026-10-15 抓包，SEND 帧逐字节精确复现），
 * 完整分析见 `docs/saltroad-season-out-cheer-protocol.md`。
 *
 * 玩法（游戏客户端 bundle 还原）：
 *   - 赛季淘汰赛（64 强瑞士轮+淘汰轮）期间，玩家可给一家俱乐部助威；
 *   - 助威面板 = `saltroad_getseasonoutrank` 返回的 legionList 按 sOWinCnt 降序取前 64；
 *   - `saltroad_outcheer { legionId }` 投票，成功回 SyncResp，
 *     记录落在 `role.statistics["sr:out:cheer:<赛季首轮日期>"]` ⇒ **每账号每届一次**；
 *   - 重复助威 / 窗口未开由服务端拒绝（错误信封带中文 error 文案）。
 *
 * 设计取舍：
 *   - 不做本地时间闸门（客户端拿不到 SeasonLegionScheduleConf 赛程配置），
 *     活跃度以 `getseasonoutrank` 返回非空名单为准，窗口以服务端错误为准；
 *   - 前置一次 getseasonoutrank 顺带确认活动在进行中，空名单直接跳过（记 completed）。
 */
import {
  describeSeasonOutCheerResult,
  isBenignCheerError,
  isInactiveCheerError,
  isSeasonOutRankActive,
} from "../seasonOutCheer.js";

const nowText = () => new Date().toLocaleTimeString();

/** 服务端错误信封 → 判定文本（与 tasksWhiteJadePkroom 同口径） */
const errorText = (error) =>
  String(error?.error || error?.message || error || "");

/** 服务端限流：不是失败，是「这次别连发了」 */
const isRateLimitError = (error) => Number(error?.code) === 400340;

export function createTasksSeasonOutCheer(deps) {
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

  const log = (tokenName, text, type = "info") =>
    addLog({ time: nowText(), message: `${tokenName} ${text}`, type });

  /**
   * 单个账号的助威流程。
   * @returns {"voted"|"already-same"|"already-other"|"inactive"|"failed"|"skipped"}
   */
  const cheerForToken = async ({ tokenId, token, legionId }) => {
    const tokenName = token?.name || tokenId;

    // 1) 前置确认淘汰赛在进行中（服务端口径：非空俱乐部名单）
    const rankResponse = await tokenStore.sendMessageWithPromise(
      tokenId,
      "saltroad_getseasonoutrank",
      {},
      8000,
    );
    if (!isSeasonOutRankActive(rankResponse)) {
      log(tokenName, "赛季淘汰赛未在进行中（排行名单为空），跳过助威", "warning");
      return "inactive";
    }

    // 2) 投票（legionId 必须是 number：BON Int tag，字符串会被服务端拒）
    const response = await tokenStore.sendMessageWithPromise(
      tokenId,
      "saltroad_outcheer",
      { legionId: Number(legionId) },
      8000,
    );

    // 3) 读 SyncResp 的 statistics 判定（成功回包不带 code）
    const result = describeSeasonOutCheerResult(response, legionId);
    if (result.state === "voted") {
      log(tokenName, `淘汰赛助威成功（俱乐部 ${result.cheeredLegionId}）`, "success");
      return "voted";
    }
    if (result.state === "already-same") {
      log(tokenName, `已助威过该俱乐部（${result.cheeredLegionId}）`);
      return "already-same";
    }
    if (result.state === "already-other") {
      log(
        tokenName,
        `该账号本届已助威其他俱乐部（${result.cheeredLegionId}），每届仅一次`,
        "warning",
      );
      return "already-other";
    }
    log(tokenName, "助威响应中未找到助威记录（statistics 无 sr:out:cheer 键）", "error");
    return "failed";
  };

  /**
   * 批量赛季淘汰赛助威
   * @param {number} legionId - 要助威的俱乐部ID
   */
  const batchSeasonOutCheer = async (legionId) => {
    if (selectedTokens.value.length === 0) {
      message.warning("请先选择账号");
      return;
    }
    const targetLegionId = Number(legionId);
    if (!Number.isFinite(targetLegionId) || targetLegionId <= 0) {
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
      const token = tokens.value.find((item) => item.id === tokenId);
      const tokenName = token?.name || tokenId;

      try {
        addLog({
          time: nowText(),
          message: `=== 开始淘汰赛助威: ${tokenName} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        const outcome = await cheerForToken({
          tokenId,
          token,
          legionId: targetLegionId,
        });

        if (outcome === "failed") {
          tokenStatus.value[tokenId] = "failed";
        } else {
          // inactive / already-* / voted 都算「本届无需再投」
          tokenStatus.value[tokenId] = "completed";
        }
      } catch (error) {
        if (isRateLimitError(error)) {
          tokenStatus.value[tokenId] = "completed";
          log(tokenName, "触发限流(400340)，淘汰赛助威下次再试", "warning");
        } else if (isInactiveCheerError(error)) {
          tokenStatus.value[tokenId] = "completed";
          log(tokenName, `淘汰赛助威暂未开放：${errorText(error)}`, "warning");
        } else if (isBenignCheerError(error)) {
          tokenStatus.value[tokenId] = "completed";
          log(tokenName, `该账号本届已助威过（${errorText(error)}）`);
        } else if (
          errorText(error).includes("400000") ||
          Number(error?.code) === 400000
        ) {
          // 未解锁该功能（俱乐部相关玩法未开），与月赛助威同口径：跳过不算失败
          tokenStatus.value[tokenId] = "completed";
          log(tokenName, "助威失败: 未解锁该功能", "warning");
        } else {
          tokenStatus.value[tokenId] = "failed";
          log(tokenName, `淘汰赛助威失败：${errorText(error)}`, "error");
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
    message.success("批量淘汰赛助威结束");
  };

  return { batchSeasonOutCheer };
}
