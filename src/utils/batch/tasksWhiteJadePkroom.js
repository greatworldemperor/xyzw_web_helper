/**
 * 资源类批量任务：周一白玉 + 预约比赛
 *
 * 协议：见 `docs/monday-jade-and-pkroom-appoint-protocol.md`
 *       （4 份抓包交叉验证，SEND 帧 21/21 逐字节精确复现）
 * 纯逻辑：`src/utils/whiteJade.js`、`src/utils/pkroomAppoint.js`（均有回归测试）
 *
 * 两个命令的语义都比较反直觉，要点：
 *
 * 1. **领取周一白玉** `activity_claimrolluppack { id: 17 }`
 *    - 只有 17 号卡包是**免费**的（其余收费，本工具不做）。
 *    - 「每周一」的闸门在**服务端**（`statisticsTime["night:mare:buy:17"]`），
 *      客户端**不需要判断星期几**，直接调用即可；重复领由服务端拦。
 *      → 因此本任务不需要任何「今天是不是周一」的前置判断。
 *
 * 2. **预约比赛拿金砖** `pkroom_appoint {}`
 *    - body 全空，服务端自行认定当前 PK 房，客户端**无法指定目标房**。
 *    - 成功回 `SyncResp`（不是 `*Resp`），房号在 `statistics["pk:appoint:room:id"]`。
 *    - ⚠️ 伴随一条 `{code:11900050, error:"感谢您预约本场比赛，开赛后可领取奖励"}`
 *      信封 —— 实测**首次与重复预约返回完全相同**，是「已受理」而非失败。
 *      该信封无 `resp` 无 `cmd`，会被 `_handlePromiseResponse` 直接忽略，
 *      所以正常情况下业务层根本看不到它；这里只做防御性兜底。
 */
import {
  WHITE_JADE_PACK_ID,
  describeWhiteJadeClaim,
} from "../whiteJade.js";
import {
  PKROOM_APPOINT_ACCEPTED_CODE,
  describePkroomAppointResult,
} from "../pkroomAppoint.js";

const nowText = () => new Date().toLocaleTimeString();

/** 服务端错误信封 → 判定文本 */
const errorText = (error) =>
  String(error?.error || error?.message || error || "");

/** 服务端限流：不是失败，是「这次别连发了」 */
const isRateLimitError = (error) => Number(error?.code) === 400340;

/** 「已受理 / 已领取」这类幂等常态，不算失败 */
const isBenignError = (error) =>
  Number(error?.code) === PKROOM_APPOINT_ACCEPTED_CODE ||
  /已领取|已经领取|领取过|重复领取|已预约|已受理|已参与|次数已满|超出上限|达到上限/.test(
    errorText(error),
  );

/** 「活动未开」：提示为主，不算失败 */
const isInactiveError = (error) =>
  /未开启|未开始|已结束|活动不存在|不在活动|无可预约|没有可预约/.test(
    errorText(error),
  );

export function createTasksWhiteJadePkroom(deps) {
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

  // 2026-09-28：0 是合法值（= 不限速；命令本身是「发→await 响应」串行，0 即纯 RTT 速度）。
  // 旧实现 `raw > 0 ? raw : 300` 会把 0 当成未配置回退 300ms，反而更慢 —— 已修。
  const DEFAULT_ACTION_DELAY = 0;
  const actionDelay = () => {
    const raw = Number(delayConfig?.action);
    return Number.isFinite(raw) ? Math.max(0, raw) : DEFAULT_ACTION_DELAY;
  };
  const sleep = (ms = actionDelay()) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  const log = (tokenName, text, type = "info") =>
    addLog({ time: nowText(), message: `${tokenName} ${text}`, type });

  // ------------------------------------------------------------------ 步骤实现

  /**
   * 领取周一白玉（id=17，唯一免费卡包）
   * 无需判星期 —— 闸门在服务端；重复领服务端会拦。
   */
  const claimWhiteJade = async ({ tokenId, token }) => {
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        "activity_claimrolluppack",
        { id: WHITE_JADE_PACK_ID },
        8000,
      );
      const result = describeWhiteJadeClaim(response);
      if (result.ok) {
        log(token.name, `领取周一白玉成功（+${result.quantity} 白玉）`, "success");
      } else {
        // 响应里没有白玉奖励：多半是本周已领过，服务端只回了个同步包
        log(token.name, "本周白玉已领取过（服务端未再发放）");
      }
    } catch (error) {
      if (isRateLimitError(error)) {
        log(token.name, "触发限流(400340)，周一白玉下次再领", "warning");
        return;
      }
      if (isBenignError(error)) {
        log(token.name, `本周白玉已领取过（${errorText(error)}）`);
        return;
      }
      if (isInactiveError(error)) {
        log(token.name, `周一白玉暂不可领：${errorText(error)}`, "warning");
        return;
      }
      log(token.name, `领取周一白玉失败：${errorText(error)}`, "error");
      tokenStatus.value[tokenId] = "failed";
    }
  };

  /**
   * 预约比赛拿金砖
   * body 全空（服务端自行认定当前房）；成功看 SyncResp 的 statistics 房号。
   */
  const appointPkRoom = async ({ tokenId, token }) => {
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        "pkroom_appoint",
        {},
        8000,
      );
      const result = describePkroomAppointResult(response);
      if (result.ok) {
        log(
          token.name,
          `预约比赛成功（房号 ${result.roomId}），开赛后邮件可领奖励`,
          "success",
        );
      } else {
        // SyncResp 里没有房号：可能是当前没有可预约的比赛
        log(token.name, "当前没有可预约的比赛（或已预约）");
      }
    } catch (error) {
      if (isRateLimitError(error)) {
        log(token.name, "触发限流(400340)，预约比赛下次再试", "warning");
        return;
      }
      // 防御性兜底：11900050 是「已受理」不是失败。
      // （实测该信封无 resp 无 cmd，会被直接忽略，正常走不到这里）
      if (isBenignError(error)) {
        log(token.name, `比赛已预约（${errorText(error)}）`);
        return;
      }
      if (isInactiveError(error)) {
        log(token.name, `暂无可预约的比赛：${errorText(error)}`, "warning");
        return;
      }
      log(token.name, `预约比赛失败：${errorText(error)}`, "error");
      tokenStatus.value[tokenId] = "failed";
    }
  };

  const STEPS = {
    whiteJade: claimWhiteJade,
    pkroomAppoint: appointPkRoom,
  };

  // ------------------------------------------------------------------ 批量框架

  const runBySteps = async (stepIds, title) => {
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
          await step({ tokenId, token });
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

  const claimMondayWhiteJade = () => runBySteps(["whiteJade"], "领取周一白玉");
  const appointPkRoomForGoldBrick = () =>
    runBySteps(["pkroomAppoint"], "预约比赛拿金砖");

  return {
    claimMondayWhiteJade,
    appointPkRoomForGoldBrick,
  };
}
