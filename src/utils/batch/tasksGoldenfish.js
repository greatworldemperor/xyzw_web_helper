/**
 * 金鱼（秋季活动 autumn_*）批量任务
 *
 * 协议来源：`local-data/goldenfish/use_one_item.jsonl`（2026-09-25 抓包，wss://xxz-xyzw.hortorgames.com/agent）
 *
 * 抓包结论：
 *   - 投一个道具：`autumn_useitem { itemNum: 1 }`（请求体只有数量，服务端自动扣道具）
 *   - 响应 `Autumn_UseItemResp`：
 *       reward: [{ type, itemId, value, ext }]        —— 本次投掷奖励
 *       roleAutumn: { areaId, itemNum, distance, lastUseItemTime, lastUseItemNum, ... }
 *                                                    —— 投掷后进度（distance = 前进距离）
 *       role.items: { "1006": { quantity }, ... }     —— 道具余额快照
 *   - 排行榜：`autumn_getrolerank {}` → `Autumn_GetRoleRankResp`（本次任务用不到）
 *
 * 设计要点（与 tasksXiaoyaojin 一致）：
 * - 每次调用每账号只投 1 个道具（与抓包逐字节一致），道具不足 / 活动未开都是「正常结束」；
 * - 已知限流码 400340：不是失败，是「这次别连发了」。
 */

const nowText = () => new Date().toLocaleTimeString();

/** 服务端错误信封 → 判定文本 */
const errorText = (error) =>
  String(error?.error || error?.message || error || "");

/** 活动未开 / 无效参数：提示为主，不算失败 */
const isInactiveError = (error) =>
  /未开启|未开始|已结束|活动不存在|无效的/.test(errorText(error));

/** 道具不足：提示为主 */
const isNoItemError = (error) =>
  /道具不足|数量不足|不足/.test(errorText(error));

/** 服务端限流（沿用项目通用码） */
const isRateLimitError = (error) => Number(error?.code) === 400340;

/** 奖励字段 → 可读文案 */
const rewardText = (response) => {
  const list = Array.isArray(response?.reward) ? response.reward : [];
  if (list.length === 0) return "无奖励";
  return list.map((item) => `itemId ${item.itemId} ×${item.value}`).join("、");
};

export function createTasksGoldenfish(deps) {
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

  const actionDelay = () => {
    const raw = Number(delayConfig?.action);
    return Number.isFinite(raw) && raw > 0 ? raw : 300;
  };
  const sleep = (ms = actionDelay()) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  const log = (tokenName, text, type = "info") =>
    addLog({ time: nowText(), message: `${tokenName} ${text}`, type });

  /** 投一个道具：autumn_useitem { itemNum: 1 }，响应里带回进度与奖励 */
  const useOneItem = async ({ tokenId, token }) => {
    const response = await tokenStore.sendMessageWithPromise(
      tokenId,
      "autumn_useitem",
      { itemNum: 1 },
      8000,
    );
    const distance = Number(response?.distance ?? response?.roleAutumn?.distance);
    const areaId = Number(response?.roleAutumn?.areaId);
    const progress =
      Number.isFinite(distance) && distance > 0
        ? `，前进 ${distance} 格` + (Number.isFinite(areaId) ? `（区域 ${areaId}）` : "")
        : "";
    log(token.name, `投出 1 个道具${progress}（${rewardText(response)}）`, "success");
  };

  const STEPS = { useOneItem };

  // ------------------------------------------------------------------ 批量框架

  const runGoldenfish = async (stepIds, title) => {
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
          message: `=== 开始${title}: ${tokenName} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        for (const stepId of stepIds) {
          if (shouldStop.value) break;
          const step = STEPS[stepId];
          if (!step) continue;
          try {
            await step({ tokenId, token });
          } catch (error) {
            if (isRateLimitError(error)) {
              log(tokenName, `触发限流(400340)，下次再试`, "warning");
              break;
            }
            if (isInactiveError(error)) {
              log(tokenName, `金鱼活动未开启（${errorText(error)}），跳过`, "warning");
              break;
            }
            if (isNoItemError(error)) {
              log(tokenName, `投掷道具不足（${errorText(error)}），跳过`, "warning");
              break;
            }
            throw error;
          }
          await sleep();
        }

        if (tokenStatus.value[tokenId] !== "failed") {
          tokenStatus.value[tokenId] = "completed";
        }
        addLog({
          time: nowText(),
          message: `=== ${tokenName} ${title}结束 ===`,
          type: "success",
        });
      } catch (error) {
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: nowText(),
          message: `${title}失败: ${error?.message || String(error)}`,
          type: "error",
        });
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
    message.success(`${title}结束`);
  };

  const goldenfishUseItem = () => runGoldenfish(["useOneItem"], "金鱼投道具");

  return { goldenfishUseItem };
}

export default { createTasksGoldenfish };
