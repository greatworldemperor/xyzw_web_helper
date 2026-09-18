/**
 * 逍遥津（限时临时活动）批量任务
 *
 * 协议：见 `docs/xiaoyaojin-activity-protocol.md`（2026-09-18 抓包，SEND 15/15 逐字节精确复现）
 * 纯逻辑：`src/utils/xiaoyaojinPlan.js`（活动实例探测 / 奖励清单推导，有回归测试）
 *
 * 覆盖 master 指定的 4 件事：
 *   1. 每日任务奖励   activity_warordertaskclaim { actId, missionId }
 *   2. 一次性奖励     activity_commonbuygoods { goodsId }        （免费礼包，掉落抽奖券 5283）
 *   3. 7 天登录奖励   activity_claimsignreward { activityId, patchDay: 0 }
 *   4. 抽奖           activity_getlotteryinfo → activity_lottery { times: 1 } × N
 *
 * 设计要点：
 * - 全部 ID 都从 `activity_get` 现场探测（不写死活动 ID），逐账号独立解析；
 * - 每次调用只发 1 次 `activity_lottery`（与抓包逐字节一致），循环次数受抽奖券余额约束；
 * - 已领取 / 未达成 / 活动未开 都算「正常结束」，不记错误、不打断其他账号。
 */
import {
  XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID,
  buildXiaoyaojinPlan,
  resolveLotteryDraws,
} from "../xiaoyaojinPlan.js";

const nowText = () => new Date().toLocaleTimeString();

/** 服务端错误信封 → 判定文本（createServerError 会把 error / message 都挂上） */
const errorText = (error) =>
  String(error?.error || error?.message || error || "");

/** 已领过 / 已买过 / 超上限：属于幂等重跑的常态，不算失败 */
const isAlreadyDoneError = (error) =>
  /已领取|已经领取|领取过|重复领取|已购买|已买|本期已|超出限购|超出上限|达到上限|次数已满|已参与/.test(
    errorText(error),
  );

/** 活动未开 / ID 无效：提示为主，不算失败 */
const isInactiveError = (error) =>
  /未开启|未开始|已结束|活动不存在|无效的ID/.test(errorText(error));

/** 奖励字段 → 可读文案 */
const rewardText = (response) => {
  const list = Array.isArray(response?.reward) ? response.reward : [];
  if (list.length === 0) return "奖励已同步";
  return list
    .map((item) => `itemId ${item.itemId} ×${item.value}`)
    .join("、");
};

export function createTasksXiaoyaojin(deps) {
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

  const sendRoleInfo =
    typeof deps.sendRoleInfo === "function"
      ? deps.sendRoleInfo
      : (tokenId, params = {}) =>
          typeof tokenStore.sendGetRoleInfo === "function"
            ? tokenStore.sendGetRoleInfo(tokenId, params)
            : tokenStore.sendMessageWithPromise(
                tokenId,
                "role_getroleinfo",
                params,
                delayConfig?.command,
              );

  /** 界面选项（抽奖次数 / 手工指定活动 ID）；容忍 ref、plain object 与缺失三种情况 */
  const readOptions = () => {
    const source = deps.xiaoyaojinOptions;
    let value = source;
    if (typeof source === "function") {
      value = source();
    } else if (source && typeof source === "object" && "value" in source) {
      value = source.value;
    }
    return value && typeof value === "object" ? value : {};
  };

  const actionDelay = () => {
    const raw = Number(delayConfig?.action);
    return Number.isFinite(raw) && raw > 0 ? raw : 300;
  };
  const sleep = (ms = actionDelay()) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  const log = (tokenName, text, type = "info") =>
    addLog({ time: nowText(), message: `${tokenName} ${text}`, type });

  // ---------------------------------------------------------------- 计划加载

  /** activity_get → 逍遥津执行计划；拿不到就跳过该账号 */
  const loadPlan = async (tokenId, tokenName) => {
    const response = await tokenStore.sendMessageWithPromise(
      tokenId,
      "activity_get",
      {},
      8000,
    );
    const options = readOptions();
    const plan = buildXiaoyaojinPlan(response, {
      overrides: options.overrides || {},
    });

    if (!plan.ok) {
      log(tokenName, `${plan.reason}，跳过`, "warning");
      return null;
    }

    log(
      tokenName,
      `活动实例 ${plan.warOrderActivityId}（${
        plan.source === "manual"
          ? "手工指定"
          : `自动探测，开启于 ${plan.ageDays} 天前`
      }），签到 ${plan.ids.signActivityId} / 礼包 ${plan.ids.giftGoodsId}`,
    );
    if (plan.passRewards.pending > 0) {
      log(
        tokenName,
        `另有战令等级奖励 ${plan.passRewards.pending} 个可领（不在本次范围，需在游戏内领取）`,
      );
    }
    return plan;
  };

  // ------------------------------------------------------------------ 四个步骤

  /** 1) 每日任务奖励：complete>=1 且未领取的每日任务（序号 01~30） */
  const claimDailyTasks = async ({ tokenId, token, plan }) => {
    const pending = plan.dailyClaims || [];
    if (pending.length === 0) {
      log(token.name, "没有待领取的每日任务");
      return;
    }

    const claimable = pending.filter((item) => item.completed);
    const notDone = pending.filter((item) => !item.completed);
    if (notDone.length > 0) {
      log(
        token.name,
        `每日任务未达成 ${notDone.length} 个（${notDone
          .map((item) => String(item.missionId).slice(-2))
          .join("/")}），跳过`,
      );
    }
    if (claimable.length === 0) {
      log(token.name, "每日任务暂无可领奖励（等任务达成后再跑）");
      return;
    }

    for (const item of claimable) {
      if (shouldStop.value) break;
      try {
        const response = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_warordertaskclaim",
          {
            actId: Number(plan.warOrderActivityId),
            missionId: Number(item.missionId),
          },
          8000,
        );
        log(
          token.name,
          `每日任务 ${String(item.missionId).slice(-2)} 领取成功（${rewardText(response)}）`,
          "success",
        );
      } catch (error) {
        if (isAlreadyDoneError(error)) {
          log(token.name, `每日任务 ${String(item.missionId).slice(-2)} 已领取过，跳过`);
        } else if (isInactiveError(error)) {
          log(
            token.name,
            `每日任务 ${String(item.missionId).slice(-2)} 领取失败：${errorText(error)}`,
            "warning",
          );
        } else {
          log(
            token.name,
            `每日任务 ${String(item.missionId).slice(-2)} 领取失败：${errorText(error)}`,
            "error",
          );
          tokenStatus.value[tokenId] = "failed";
        }
      }
      await sleep();
    }
  };

  /** 2) 一次性奖励：免费礼包 activity_commonbuygoods { goodsId } */
  const claimOneTimeGift = async ({ tokenId, token, plan }) => {
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        "activity_commonbuygoods",
        { goodsId: Number(plan.ids.giftGoodsId) },
        8000,
      );
      log(token.name, `一次性奖励领取成功（${rewardText(response)}）`, "success");
    } catch (error) {
      if (isAlreadyDoneError(error)) {
        log(token.name, "一次性奖励本期已领取，跳过");
      } else if (isInactiveError(error)) {
        log(token.name, `一次性奖励领取失败：${errorText(error)}`, "warning");
      } else {
        log(token.name, `一次性奖励领取失败：${errorText(error)}`, "error");
        tokenStatus.value[tokenId] = "failed";
      }
    }
    await sleep();
  };

  /**
   * 3) 7 天登录奖励：activity_claimsignreward { activityId, patchDay: 0 }
   * patchDay=0 = 领取「当天」那一份（抓包实证：第 1 天领取后 record 写入键 "1"）。
   * 缺签需补签的天数语义未知，本工具不代为补签。
   */
  const claimSignReward = async ({ tokenId, token, plan }) => {
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        "activity_claimsignreward",
        { activityId: Number(plan.ids.signActivityId), patchDay: 0 },
        8000,
      );
      log(token.name, `7 天登录奖励领取成功（${rewardText(response)}）`, "success");
    } catch (error) {
      if (isAlreadyDoneError(error)) {
        log(token.name, "7 天登录奖励今天已领取，跳过");
      } else if (isInactiveError(error)) {
        log(token.name, `7 天登录奖励领取失败：${errorText(error)}`, "warning");
      } else {
        log(token.name, `7 天登录奖励领取失败：${errorText(error)}`, "error");
        tokenStatus.value[tokenId] = "failed";
      }
    }
    await sleep();
  };

  /**
   * 4) 抽奖：先查状态与抽奖券，再逐次 activity_lottery { times: 1 }
   * 抽奖券不足时由服务端拒绝，循环遇错即停。
   */
  const runLottery = async ({ tokenId, token, plan }) => {
    try {
      const info = await tokenStore.sendMessageWithPromise(
        tokenId,
        "activity_getlotteryinfo",
        {},
        8000,
      );
      const lotteryInfo =
        info?.lotteryInfo || info?.data?.lotteryInfo || info || {};
      log(token.name, `抽奖状态：${JSON.stringify(lotteryInfo)}`);
    } catch (error) {
      log(token.name, `抽奖状态查询失败（继续尝试抽奖）：${errorText(error)}`);
    }
    await sleep();

    let ticketCount = null;
    try {
      const roleInfo = await sendRoleInfo(tokenId);
      const role = roleInfo?.role || roleInfo?.data?.role || {};
      ticketCount = Number(role?.items?.[XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID]?.quantity ?? 0);
      log(token.name, `抽奖券(${XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID}) 余额 ${ticketCount}`);
    } catch (error) {
      log(
        token.name,
        `读取抽奖券余额失败（按配置次数尝试）：${errorText(error)}`,
        "warning",
      );
    }

    const requested = readOptions().draws;
    const { draws, cappedByTickets } = resolveLotteryDraws({
      requested,
      ticketCount,
    });

    if (cappedByTickets) {
      log(token.name, `抽奖券不足，本次只抽 ${draws} 次`, "warning");
    }
    if (draws <= 0) {
      log(token.name, "没有抽奖券，跳过抽奖", "warning");
      return;
    }

    for (let index = 1; index <= draws; index++) {
      if (shouldStop.value) break;
      try {
        const response = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_lottery",
          { times: 1 },
          10000,
        );
        log(token.name, `第 ${index} 次抽奖：${rewardText(response)}`, "success");
      } catch (error) {
        log(token.name, `第 ${index} 次抽奖失败，停止：${errorText(error)}`, "warning");
        break;
      }
      await sleep();
    }
  };

  const STEPS = {
    dailyTask: claimDailyTasks,
    oneTimeGift: claimOneTimeGift,
    signReward: claimSignReward,
    lottery: runLottery,
  };

  // ------------------------------------------------------------------ 批量框架

  const runXiaoyaojin = async (stepIds, title) => {
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
        const plan = await loadPlan(tokenId, tokenName);
        if (!plan) {
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        for (const stepId of stepIds) {
          if (shouldStop.value) break;
          const step = STEPS[stepId];
          if (!step) continue;
          await step({ tokenId, token, plan });
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

  /** 一键全套：每日任务 → 一次性礼包 → 7 天登录 → 抽奖 */
  const xiaoyaojinAll = () =>
    runXiaoyaojin(
      ["dailyTask", "oneTimeGift", "signReward", "lottery"],
      "逍遥津一键全套",
    );
  const xiaoyaojinDailyTask = () =>
    runXiaoyaojin(["dailyTask"], "逍遥津每日任务奖励");
  const xiaoyaojinOneTimeGift = () =>
    runXiaoyaojin(["oneTimeGift"], "逍遥津一次性奖励");
  const xiaoyaojinSignReward = () =>
    runXiaoyaojin(["signReward"], "逍遥津7天登录奖励");
  const xiaoyaojinLottery = () => runXiaoyaojin(["lottery"], "逍遥津抽奖");

  return {
    xiaoyaojinAll,
    xiaoyaojinDailyTask,
    xiaoyaojinOneTimeGift,
    xiaoyaojinSignReward,
    xiaoyaojinLottery,
    // 供界面「探测活动实例」预览用
    inspectXiaoyaojin: async (tokenId) =>
      buildXiaoyaojinPlan(
        await tokenStore.sendMessageWithPromise(tokenId, "activity_get", {}, 8000),
        { overrides: readOptions().overrides || {} },
      ),
  };
}

export default { createTasksXiaoyaojin };
