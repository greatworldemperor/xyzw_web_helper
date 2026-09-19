/**
 * 逍遥津（限时临时活动）批量任务
 *
 * 协议：见 `docs/xiaoyaojin-activity-protocol.md`（2026-09-18 抓包，SEND 15/15 逐字节精确复现）
 * 纯逻辑：`src/utils/xiaoyaojinPlan.js`（活动实例探测 / 奖励清单推导，有回归测试）
 *
 * 覆盖 master 指定的 4 件事 + 09-19 新抓包补上的战令奖励：
 *   1. 每日任务奖励     activity_warordertaskclaim { actId, missionId }   （序号 01~30）
 *   1b. 战令奖励宝箱    activity_warorderrewardclaim { actId }            （一键，产抽奖券）
 *   1c. 战令等级奖励    activity_warordertaskclaim { actId, missionId }   （序号 41+，**同一个命令**）
 *   2. 一次性奖励       activity_commonbuygoods { goodsId }               （免费礼包，产抽奖券 5283）
 *   3. 7 天登录奖励     activity_claimsignreward { activityId, patchDay: 0 }
 *   4. 抽奖             activity_getlotteryinfo → activity_lottery { times: 1 } × N
 *
 * ⚠️ 每日任务与战令等级奖励**共用** `activity_warordertaskclaim` 与 `taskClaimed` 字段，
 * 靠 missionId 末两位序号区分（01~30 每日任务，41+ 等级奖励）。
 *
 * 设计要点：
 * - 全部 ID 都从 `activity_get` 现场探测（不写死活动 ID），逐账号独立解析；
 * - 每次调用只发 1 次 `activity_lottery`（与抓包逐字节一致），循环次数受抽奖券余额约束；
 * - 已领取 / 未达成 / 活动未开 都算「正常结束」，不记错误、不打断其他账号。
 */
import {
  XIAOYAOJIN_ALL_STEPS,
  XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID,
  XIAOYAOJIN_POINTS_ITEM_ID,
  buildXiaoyaojinPlan,
  resolveLotteryDraws,
  resolvePassTierCount,
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

/** 「本次没有可领取的」：一键领取类命令的正常空结果 */
const isNothingToClaimError = (error) =>
  /没有可领取|无可领取/.test(errorText(error));

/** 服务端限流（沿用项目通用码）：不是失败，是「这次别连发了」 */
const isRateLimitError = (error) => Number(error?.code) === 400340;

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
      }），签到 ${plan.ids.signActivityId}${
        plan.commonConfirmed.sign
          ? `（已记录 ${plan.commonConfirmed.signDays.length} 天）`
          : ""
      } / 礼包 ${plan.ids.giftGoodsId}${
        plan.commonConfirmed.giftBought ? "（本期已领）" : ""
      }`,
    );
    if (plan.passRewards.pending > 0) {
      log(
        tokenName,
        `战令等级奖励可领 ${plan.passRewards.pending} 个（已解锁 ${plan.passRewards.unlocked}/${plan.passRewards.total}）`,
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
        if (isRateLimitError(error)) {
          // ⚠️ 不能 `continue`（会跳过末尾的 sleep，变成连发）→ 直接结束本步
          log(
            token.name,
            `触发限流(400340)，每日任务剩余 ${claimable.length - claimable.indexOf(item) - 1} 个下次再领`,
            "warning",
          );
          break;
        }
        if (isAlreadyDoneError(error)) {
          log(token.name, `每日任务 ${String(item.missionId).slice(-2)} 已领取过，跳过`);
        } else if (isInactiveError(error) || isRateLimitError(error)) {
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

  /**
   * 读战令积分（道具 5282 的数量；截图右下角那个数）
   * @returns {number|null} 读不到（字段缺失 / 请求失败）返回 null → 调用方回退全量扫描
   */
  const readPoints = async (tokenId, tokenName) => {
    let roleInfo;
    try {
      roleInfo = await sendRoleInfo(tokenId);
    } catch (error) {
      log(tokenName, `读取战令积分失败：${errorText(error)}`, "warning");
      return null;
    }
    const role = roleInfo?.role || roleInfo?.data?.role || {};
    const rawQuantity = role?.items?.[XIAOYAOJIN_POINTS_ITEM_ID]?.quantity;
    if (rawQuantity === undefined || rawQuantity === null) {
      return null; // ⚠️ 不能把 undefined 当 0（那会被误判成「0 档」而漏领）
    }
    const value = Number(rawQuantity);
    return Number.isFinite(value) ? value : null;
  };

  /**
   * 1b) 战令奖励宝箱：activity_warorderrewardclaim { actId } —— 一键领取
   *
   * 服务端一次发完所有当前可领的宝箱（实测两次调用分别给 5283×1 + 10002×400 与 5283×2，
   * 落在 `rewardClaimed` 的 4 位奖励 ID 上）。**产抽奖券 5283**，所以排在抽奖之前。
   */
  const claimPassChest = async ({ tokenId, token, plan }) => {
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        "activity_warorderrewardclaim",
        { actId: Number(plan.warOrderActivityId) },
        8000,
      );
      log(token.name, `战令奖励宝箱领取成功（${rewardText(response)}）`, "success");
    } catch (error) {
      if (isAlreadyDoneError(error) || isNothingToClaimError(error)) {
        log(token.name, "战令奖励宝箱暂无可领，跳过");
      } else if (isInactiveError(error) || isRateLimitError(error)) {
        log(token.name, `战令奖励宝箱领取失败：${errorText(error)}`, "warning");
      } else {
        log(token.name, `战令奖励宝箱领取失败：${errorText(error)}`, "error");
        tokenStatus.value[tokenId] = "failed";
      }
    }
    await sleep();
  };

  /**
   * 1c) 战令档位奖励 —— **全量扫描候选 + 服务端裁定**
   *
   * ⚠️ master 澄清（2026-09-19 16:57）：游戏里的「领取」按钮是**一次性把当前积分能抵达的档位全领**，
   * 客户端实现为「一个档位发一条 `activity_warordertaskclaim`（按 missionId 升序）」。
   *
   * 但**档位 ID 无法本地推导**：两个抓包账号在 4 档时，客户端实际发的 4 个 ID 是
   * `141 / 147 / 148 / 149`（**不连续**，141 直接跳到 147），既不是连续序列、也与 `5282` 积分口径对不上
   * （5282 两账号都是 3100，按 1000/档只该 3 档，实际却领了 4 个）。
   * → 所以候选只能是 `complete > 0 && taskClaimed !== true` 的全集（约 26 个），
   *   逐个交给服务端裁定（未达标 `700010` / 已领 `700020`），失败按错误码汇总。
   *   代价是每账号约 13 秒，换来的是**不漏领**（这正是「把能领的全领了」要的效果）。
   *
   * 积分（5282）只写进日志供对照，**不参与筛选**。
   */
  const claimPassRewards = async ({ tokenId, token, plan }) => {
    const points = await readPoints(tokenId, token.name);
    if (points !== null) {
      log(
        token.name,
        `战令积分 ${points}（按 1000/档 估算约 ${resolvePassTierCount(points)} 档；实际档位以服务端裁定为准）`,
      );
    }

    const candidates = plan.passRewards?.pendingIds || [];
    if (candidates.length === 0) {
      log(token.name, "战令档位奖励没有待领取项");
      return;
    }

    let claimed = 0;
    let skipped = 0;
    /** 按服务端错误码归类跳过原因，便于看清「这些候选到底为什么不能领」 */
    const skipReasons = new Map();
    for (const [index, missionId] of candidates.entries()) {
      if (shouldStop.value) break;
      try {
        const response = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_warordertaskclaim",
          {
            actId: Number(plan.warOrderActivityId),
            missionId: Number(missionId),
          },
          8000,
        );
        claimed++;
        log(
          token.name,
          `战令档位奖励 ${String(missionId).slice(-3)} 领取成功（${rewardText(response)}）`,
          "success",
        );
      } catch (error) {
        if (isRateLimitError(error)) {
          // 限流不是失败：剩下的下次再领，别把「没领到」记成「已领完」
          log(
            token.name,
            `触发限流(400340)，战令档位奖励剩余 ${candidates.length - index} 个下次再领`,
            "warning",
          );
          break;
        }
        // 未达成 / 已领取 / 不可领 → 正常跳过（按码归类）
        skipped++;
        const code = Number.isFinite(Number(error?.code))
          ? Number(error.code)
          : "无码";
        skipReasons.set(code, (skipReasons.get(code) || 0) + 1);
      }
      // 节奏比默认稍慢：这段是连续多帧，贴近真人点击间隔（约 1~2s/次）
      await sleep(Math.max(500, actionDelay()));
    }
    const reasonText = [...skipReasons.entries()]
      .map(([code, count]) => `${count} 个(${code})`)
      .join("、");
    log(
      token.name,
      `战令档位奖励：${candidates.length} 个候选中成功 ${claimed} 个` +
        (skipped > 0
          ? `，跳过 ${skipped} 个${reasonText ? `：${reasonText}` : ""}`
          : ""),
    );
  };

  /** 2) 一次性奖励：免费礼包 activity_commonbuygoods { goodsId } */
  const claimOneTimeGift = async ({ tokenId, token, plan }) => {
    // 服务端 record 已记录该商品 → 本期已领，直接跳过（省一次请求 + 一条误导性的失败日志）
    if (plan.commonConfirmed?.giftBought) {
      log(token.name, "一次性奖励本期已领取（服务端记录），跳过");
      return;
    }

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
      } else if (isInactiveError(error) || isRateLimitError(error)) {
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
      } else if (isInactiveError(error) || isRateLimitError(error)) {
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
    passChest: claimPassChest,
    passRewards: claimPassRewards,
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

  /**
   * 一键全套：顺序由 `XIAOYAOJIN_ALL_STEPS` 定义（**协议约束**，回归测试锁住了
   * 「先等级奖励后宝箱」「礼包/宝箱都在抽奖前」，详见该常量注释）
   */
  const xiaoyaojinAll = () =>
    runXiaoyaojin(XIAOYAOJIN_ALL_STEPS, "逍遥津一键全套");
  const xiaoyaojinDailyTask = () =>
    runXiaoyaojin(["dailyTask"], "逍遥津每日任务奖励");
  const xiaoyaojinPassChest = () =>
    runXiaoyaojin(["passChest"], "逍遥津战令奖励宝箱");
  const xiaoyaojinPassRewards = () =>
    runXiaoyaojin(["passRewards"], "逍遥津战令等级奖励");
  const xiaoyaojinOneTimeGift = () =>
    runXiaoyaojin(["oneTimeGift"], "逍遥津一次性奖励");
  const xiaoyaojinSignReward = () =>
    runXiaoyaojin(["signReward"], "逍遥津7天登录奖励");
  const xiaoyaojinLottery = () => runXiaoyaojin(["lottery"], "逍遥津抽奖");

  return {
    xiaoyaojinAll,
    xiaoyaojinDailyTask,
    xiaoyaojinPassChest,
    xiaoyaojinPassRewards,
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
