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
 *   4. 抽奖（含玄武灵契闭环） activity_getlotteryinfo → { activity_lottery × N ⇄ activity_claimlotterycumulative }
 *   5. 兑换               activity_exchange { activityId, goodsId, quantity: 1 }（消耗 5284）
 *
 * ⚠️ 每日任务与战令等级奖励**共用** `activity_warordertaskclaim` 与 `taskClaimed` 字段，
 * 靠 missionId 末两位序号区分（01~30 每日任务，41+ 等级奖励）。
 *
 * ## 玄武灵契（抽奖券 5283）闭环 —— 2026-09-25 抓包实证
 *
 *   activity_lottery { times: N }           → 扣 5283 ×N（**N=10 十连实测可行**）
 *   activity_claimlotterycumulative { id }  → **每档固定 +2 张 5283**（id 11~15 全是 ×2）+ 5285×5
 *
 * 所以「抽光为止」= 反复 { 十连优先地抽 → 券尽 → 扫累计奖励补券 → 再抽 }，
 * 直到「券尽且累计奖励也领不出券」。累计奖励的门槛随 id 递增 →
 * **第一个不可领的 id 之后必然也都不可领**，扫到失败即停（不会傻扫 30 次）。
 *
 * 兑换（5284）消耗的是**抽奖产出**（每 50 抽给 1 个）→ 必须排在抽奖之后。
 *
 * 设计要点：
 * - 全部 ID 都从 `activity_get` 现场探测（不写死活动 ID），逐账号独立解析；
 * - 券余额优先从**抽奖响应里**读（省一次 role_getroleinfo），读不到才回退主动查询；
 * - 已领取 / 未达成 / 活动未开 都算「正常结束」，不记错误、不打断其他账号。
 */
import {
  XIAOYAOJIN_ALL_ROUNDS_MAX,
  XIAOYAOJIN_ALL_STEPS,
  XIAOYAOJIN_COOKIE_PRICE,
  XIAOYAOJIN_COUPON_ITEM_ID,
  XIAOYAOJIN_CUMULATIVE_ID_MAX,
  XIAOYAOJIN_EXCHANGE_ITEM_ID,
  XIAOYAOJIN_LOTTERY_LOOP_MAX_ROUNDS,
  XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID,
  XIAOYAOJIN_MAX_DRAWS,
  XIAOYAOJIN_POINTS_ITEM_ID,
  buildXiaoyaojinPlan,
  describePassTiers,
  listPendingCumulativeIds,
  pickLotteryInfo,
  planCouponPurchase,
  readCumulativeClaimed,
  readItemQuantity,
  readRewardQuantity,
  resolveExchangeTimes,
  summarizeLottery,
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
  const claimDailyTasks = async ({ tokenId, token, plan, progress }) => {
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
        progress.count += 1;
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
  const claimPassChest = async ({ tokenId, token, plan, progress }) => {
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        "activity_warorderrewardclaim",
        { actId: Number(plan.warOrderActivityId) },
        8000,
      );
      progress.count += 1;
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
  const claimPassRewards = async ({ tokenId, token, plan, progress }) => {
    const points = await readPoints(tokenId, token.name);
    // 先把「积分 / 可达档数 / 已领档 / 下一档还差多少」读出来打进日志（纯读，不发写请求）
    const tiers = describePassTiers(plan.warOrderInfo, {
      actId: plan.warOrderActivityId,
      points,
    });
    if (tiers.points !== null) {
      const claimedText =
        tiers.claimedTiers.length > 0 ? tiers.claimedTiers.join("/") : "无";
      const pendingText =
        tiers.pendingTiers.length > 0
          ? `待领 ${tiers.pendingTiers.map((item) => item.tier).join("/")}；`
          : "";
      const nextText = tiers.nextTier
        ? `下一档 ${tiers.nextTier.tier}（${tiers.nextTier.missionId.slice(-3)}）还差 ${tiers.nextTier.pointsNeeded} 分`
        : "已到最高档";
      log(
        token.name,
        `战令积分 ${tiers.points} → 可达 ${tiers.reachable} 档；已领 ${claimedText}；${pendingText}${nextText}`,
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
    progress.count += claimed;
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
  const claimOneTimeGift = async ({ tokenId, token, plan, progress }) => {
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
      progress.count += 1;
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
  const claimSignReward = async ({ tokenId, token, plan, progress }) => {
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        "activity_claimsignreward",
        { activityId: Number(plan.ids.signActivityId), patchDay: 0 },
        8000,
      );
      progress.count += 1;
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
   * 读背包里某个道具的数量（券 5283 / 兑换材料 5284 都走它）
   * @returns {number|null} 读不到返回 null（**不是 0** —— 0 会让人误以为「没券」而跳过）
   */
  const readItemCount = async (tokenId, tokenName, itemId) => {
    try {
      const roleInfo = await sendRoleInfo(tokenId);
      return readItemQuantity(roleInfo, itemId);
    } catch (error) {
      log(tokenName, `读取道具 ${itemId} 数量失败：${errorText(error)}`, "warning");
      return null;
    }
  };

  /**
   * 扫一遍「累计抽奖奖励」—— **玄武灵契的主要来源**
   *
   * 每档固定 +2 张 5283（实证 id 11~15）+ 5285×5，门槛随 id 递增：
   * 抓包里 11/12/13/14 在累计 99 次时连领，15 要等到 107 次才够。
   *
   * ⚠️ `claimedIds` 必须跨调用累积：服务端的 `cumulativeClaimedMap` 每次只回**本次领的那一个**，
   * 拿新响应覆盖会把历史已领的档位忘掉 → 每轮都从 id 1 重发一遍。
   *
   * @param {Set<number>} claimedIds 会话内累积的已领 id（**原地更新**）
   * @returns {{count:number, tickets:number}} 新领档数 / 新拿到的券数
   */
  const claimCumulative = async ({ tokenId, token, claimedIds }) => {
    const ids = listPendingCumulativeIds(null, claimedIds, {
      max: XIAOYAOJIN_CUMULATIVE_ID_MAX,
    });
    let count = 0;
    let tickets = 0;

    for (const id of ids) {
      if (shouldStop.value) break;
      try {
        const response = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_claimlotterycumulative",
          { id },
          8000,
        );
        claimedIds.add(id);
        count += 1;
        tickets += readRewardQuantity(
          response,
          XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID,
        );
        log(
          token.name,
          `累计抽奖奖励 第 ${id} 档领取成功（${rewardText(response)}）`,
          "success",
        );
      } catch (error) {
        if (isRateLimitError(error)) {
          log(
            token.name,
            `触发限流(400340)，累计抽奖奖励剩余 ${ids.length - ids.indexOf(id)} 档下次再领`,
            "warning",
          );
          break;
        }
        if (isAlreadyDoneError(error)) {
          // 已领过（但本地 map 里没有）→ 记下来继续看下一档
          claimedIds.add(id);
          continue;
        }
        // 未达标 / 档位不存在 / 其它：门槛随 id 递增 → 后面的必然也不可领，停止本轮扫描
        break;
      }
      await sleep(Math.max(300, actionDelay()));
    }
    return { count, tickets };
  };

  /**
   * 4) 抽奖 —— **「抽光为止」闭环**：抽 → 券尽 → 扫累计奖励补券 → 再抽
   *
   * 十连优先（`times:10` 实测可行）；券余额优先从抽奖响应里读，读不到才查背包。
   * 界面上的「抽奖次数」= **每批张数**（1~10），不再是「总共抽几次」。
   */
  const runLottery = async ({ tokenId, token, plan, progress }) => {
    const perBatch = Math.min(
      XIAOYAOJIN_MAX_DRAWS,
      Math.max(1, Math.trunc(Number(readOptions().draws) || XIAOYAOJIN_MAX_DRAWS)),
    );

    // 4.1 抽奖状态：累计次数 / 已领累计奖励档
    let lotteryInfo = null;
    try {
      const info = await tokenStore.sendMessageWithPromise(
        tokenId,
        "activity_getlotteryinfo",
        {},
        8000,
      );
      lotteryInfo = pickLotteryInfo(info);
    } catch (error) {
      log(token.name, `抽奖状态查询失败（继续尝试抽奖）：${errorText(error)}`);
    }
    await sleep();

    const claimedIds = readCumulativeClaimed(lotteryInfo);
    const summary = summarizeLottery(lotteryInfo, claimedIds);
    log(
      token.name,
      `抽奖状态：累计 ${summary.draws ?? "?"} 次，碎片 ${summary.frag ?? "?"}，` +
        `累计奖励已领 ${summary.claimedCumulative.length} 档（待试 ${summary.pendingCumulative} 档）`,
    );

    // 4.2 券余额（读不到 → null，循环里按「未知」处理，靠响应收敛）
    let balance = await readItemCount(
      tokenId,
      token.name,
      XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID,
    );
    if (balance === null) {
      log(
        token.name,
        `读取玄武灵契(${XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID})余额失败，按每批 ${perBatch} 张试探`,
        "warning",
      );
    } else {
      log(token.name, `玄武灵契(抽奖券 ${XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID}) 余额 ${balance}`);
    }
    if (balance !== null && balance <= 0) {
      // 一张都没有也别急，先看累计奖励能不能领出券
      const first = await claimCumulative({ tokenId, token, claimedIds });
      if (first.tickets <= 0) {
        log(token.name, "没有玄武灵契，也没有可领的累计抽奖奖励，跳过抽奖", "warning");
        return;
      }
      balance = first.tickets;
    }

    let drawRequests = 0;
    let drawnTickets = 0;
    let cumulativeCount = 0;
    let cumulativeTickets = 0;
    let rounds = 0;

    while (
      !shouldStop.value &&
      rounds < XIAOYAOJIN_LOTTERY_LOOP_MAX_ROUNDS
    ) {
      rounds += 1;

      // A. 券尽 → 补券（累计奖励是唯一稳定的券来源）
      if (balance !== null && balance <= 0) {
        const gained = await claimCumulative({ tokenId, token, claimedIds });
        cumulativeCount += gained.count;
        cumulativeTickets += gained.tickets;
        if (gained.tickets <= 0) break;
        balance += gained.tickets;
        continue;
      }

      // B. 发一批抽奖（十连优先）
      const batch = balance === null ? perBatch : Math.min(perBatch, balance);
      try {
        const response = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_lottery",
          { times: batch },
          10000,
        );
        drawRequests += 1;
        drawnTickets += batch;
        // 响应里带了余额就用它（省一次 role_getroleinfo）；没带就按扣减推算
        const fromResponse = readItemQuantity(
          response,
          XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID,
        );
        if (fromResponse !== null) {
          balance = fromResponse;
        } else if (balance !== null) {
          balance = Math.max(0, balance - batch);
        }
        log(
          token.name,
          `抽奖 ×${batch}：${rewardText(response)}（余券 ${balance ?? "?"}）`,
          "success",
        );
      } catch (error) {
        log(token.name, `抽奖 ×${batch} 失败，停止：${errorText(error)}`, "warning");
        break;
      }
      await sleep();

      // C. 抽完顺手补券（累计门槛可能刚被跨过）
      const gained = await claimCumulative({ tokenId, token, claimedIds });
      cumulativeCount += gained.count;
      cumulativeTickets += gained.tickets;
      if (gained.tickets > 0) {
        balance = balance === null ? gained.tickets : balance + gained.tickets;
      }

      // D. 收敛：券尽 / 余额未知又补不到券 → 停（防死循环）
      if (balance !== null && balance <= 0) break;
      if (balance === null && gained.tickets <= 0) break;
    }

    progress.count += drawnTickets + cumulativeCount;
    log(
      token.name,
      `抽奖结束：共 ${drawnTickets} 抽 / ${drawRequests} 次请求；` +
        `累计抽奖奖励补券 ${cumulativeTickets} 张（${cumulativeCount} 档）`,
      drawnTickets > 0 ? "success" : "info",
    );
  };

  /**
   * 5) 兑换：activity_exchange { activityId, goodsId, quantity: 1 }
   *
   * 消耗 5284（**每 50 次抽奖产出 1 个**，实证 `fragProgress` 满 50 归零并发 1 个进背包）
   * 换道具（抓包实证：1023×10）。有多少材料换多少次，换光为止。
   */
  const runExchange = async ({ tokenId, token, plan, progress }) => {
    const activityId = Number(plan.ids.exchangeActivityId);
    const goodsId = Number(plan.ids.exchangeGoodsId);

    let frag = await readItemCount(
      tokenId,
      token.name,
      XIAOYAOJIN_EXCHANGE_ITEM_ID,
    );
    if (frag === null) {
      log(
        token.name,
        `读取兑换材料(${XIAOYAOJIN_EXCHANGE_ITEM_ID})余额失败，试探兑换 1 次`,
        "warning",
      );
    } else if (frag <= 0) {
      log(token.name, `没有兑换材料(${XIAOYAOJIN_EXCHANGE_ITEM_ID})，跳过兑换`);
      return;
    } else {
      log(token.name, `兑换材料(${XIAOYAOJIN_EXCHANGE_ITEM_ID}) 余额 ${frag}`);
    }

    const planned = resolveExchangeTimes(frag);
    const times = planned === null ? 1 : Math.max(1, planned);

    let done = 0;
    for (let index = 1; index <= times; index += 1) {
      if (shouldStop.value) break;
      try {
        const response = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_exchange",
          { activityId, goodsId, quantity: 1 },
          8000,
        );
        done += 1;
        log(
          token.name,
          `兑换 第 ${done} 次成功（${rewardText(response)}）`,
          "success",
        );
        // 材料换光（响应里显式 null）→ 收工
        const left = readItemQuantity(response, XIAOYAOJIN_EXCHANGE_ITEM_ID);
        if (left !== null && left <= 0) break;
      } catch (error) {
        if (isRateLimitError(error)) {
          log(token.name, "触发限流(400340)，兑换剩余次数下次再换", "warning");
        } else if (isInactiveError(error)) {
          log(token.name, `兑换活动未开启或商品无效：${errorText(error)}`, "warning");
        } else {
          log(token.name, `兑换失败，停止：${errorText(error)}`, "warning");
        }
        break;
      }
      await sleep();
    }
    progress.count += done;
    log(token.name, `兑换结束：成功 ${done} 次`);
  };

  /**
   * 6) 券兑换商店：activity_exchange { activityId: 券活动ID, goodsId, quantity }
   *
   * 货币是 **5285「兑换券」**（来源：抽奖掉落 + 累计抽奖奖励每档 ×5）。
   * 策略（master 口径，抓包实证 43 张券）：
   *   1. 尽量多买**饼干**（单价 5 券，`quantity` 支持一次买多个 → 一条请求买完）
   *   2. 买完剩下的券 **≥ 3** → 再换 **1 个复活丹**（单价 3 券）
   *
   * 实证：`quantity:8` 一次买 8 个饼干（43→3 张券），再 `quantity:1` 买复活丹（3→0）。
   */
  const runCouponExchange = async ({ tokenId, token, plan, progress }) => {
    const activityId = Number(plan.ids.couponActivityId);
    const cookieGoodsId = Number(plan.ids.couponCookieGoodsId);
    const reviveGoodsId = Number(plan.ids.couponReviveGoodsId);

    let tickets = await readItemCount(
      tokenId,
      token.name,
      XIAOYAOJIN_COUPON_ITEM_ID,
    );
    const purchase = planCouponPurchase(tickets);

    if (tickets === null) {
      log(
        token.name,
        `读取兑换券(${XIAOYAOJIN_COUPON_ITEM_ID})余额失败，跳过券兑换（不瞎买）`,
        "warning",
      );
      return;
    }
    log(token.name, `兑换券(${XIAOYAOJIN_COUPON_ITEM_ID}) 余额 ${tickets}`);

    if (purchase.cookies <= 0 && purchase.revive <= 0) {
      log(
        token.name,
        `兑换券 ${tickets} 张不足 ${XIAOYAOJIN_COOKIE_PRICE}（饼干单价），跳过券兑换`,
      );
      return;
    }

    // ① 饼干：一条请求买完（实测 quantity:8 可行）
    if (purchase.cookies > 0) {
      try {
        const response = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_exchange",
          {
            activityId,
            goodsId: cookieGoodsId,
            quantity: purchase.cookies,
          },
          10000,
        );
        progress.count += purchase.cookies;
        log(
          token.name,
          `买饼干 ×${purchase.cookies}（花 ${purchase.cookieCost} 券）成功（${rewardText(response)}）`,
          "success",
        );
        // 以服务端回的余额为准（可能有限购，实际买的比计划少）
        const left = readItemQuantity(response, XIAOYAOJIN_COUPON_ITEM_ID);
        if (left !== null) tickets = left;
      } catch (error) {
        if (isRateLimitError(error)) {
          log(token.name, "触发限流(400340)，饼干下次再买", "warning");
        } else {
          log(token.name, `买饼干失败，停止券兑换：${errorText(error)}`, "warning");
        }
        return;
      }
      await sleep();
    }

    // ② 复活丹：余券够 3 才换 1 个（用**服务端回的最新余额**判断，别用本地推算）
    if (tickets >= XIAOYAOJIN_REVIVE_PRICE) {
      try {
        const response = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_exchange",
          { activityId, goodsId: reviveGoodsId, quantity: 1 },
          8000,
        );
        progress.count += 1;
        log(
          token.name,
          `剩余 ${tickets} 券 → 换复活丹 ×1 成功（${rewardText(response)}）`,
          "success",
        );
      } catch (error) {
        if (isRateLimitError(error)) {
          log(token.name, "触发限流(400340)，复活丹下次再换", "warning");
        } else {
          log(token.name, `换复活丹失败：${errorText(error)}`, "warning");
        }
      }
      await sleep();
    } else {
      log(token.name, `余券 ${tickets} 不足 ${XIAOYAOJIN_REVIVE_PRICE}，不换复活丹`);
    }
  };

  /**
   * 4b) 单独跑一遍「累计抽奖奖励」（不抽奖）—— 只想补券时用
   */
  const claimCumulativeRewards = async ({ tokenId, token }) => {
    let lotteryInfo = null;
    try {
      lotteryInfo = pickLotteryInfo(
        await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_getlotteryinfo",
          {},
          8000,
        ),
      );
    } catch (error) {
      log(token.name, `抽奖状态查询失败（继续尝试领取）：${errorText(error)}`);
    }
    const claimedIds = readCumulativeClaimed(lotteryInfo);
    const summary = summarizeLottery(lotteryInfo, claimedIds);
    log(
      token.name,
      `抽奖状态：累计 ${summary.draws ?? "?"} 次，累计奖励已领 ${summary.claimedCumulative.length} 档`,
    );
    const gained = await claimCumulative({ tokenId, token, claimedIds });
    log(
      token.name,
      `累计抽奖奖励：新领 ${gained.count} 档，拿到玄武灵契 ${gained.tickets} 张`,
      gained.count > 0 ? "success" : "info",
    );
  };

  const STEPS = {
    dailyTask: claimDailyTasks,
    passChest: claimPassChest,
    passRewards: claimPassRewards,
    oneTimeGift: claimOneTimeGift,
    signReward: claimSignReward,
    lottery: runLottery,
    cumulative: claimCumulativeRewards,
    exchange: runExchange,
    couponExchange: runCouponExchange,
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

        /**
         * 「一键全套」有**外层轮次循环** —— 单步任务不循环
         *
         * 实证（2026-09-25 抓包 #105→#127）：抽奖把累计次数推高 → 战令「累计抽奖次数」
         * 档位解锁 → 领档位奖励 → 宝箱又给 5283 → **又有券了** → 再抽 → 再出 5284 → 再兑换。
         * 所以跑完一整套可能又冒出新的可领项，必须再转一轮；某轮「零进展」才停。
         *
         * ⚠️ 每轮重新 `activity_get` 拉一次计划：否则第二轮拿的还是旧快照，
         * 会把刚领掉的档位当候选再发一遍（白跑 20+ 个请求）。
         */
        const isFullSet =
          stepIds.length === XIAOYAOJIN_ALL_STEPS.length &&
          XIAOYAOJIN_ALL_STEPS.every((id, index) => id === stepIds[index]);
        const maxRounds = isFullSet ? XIAOYAOJIN_ALL_ROUNDS_MAX : 1;
        const progress = { count: 0 };

        let plan = await loadPlan(tokenId, tokenName);
        if (!plan) {
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        for (let round = 1; round <= maxRounds; round += 1) {
          if (shouldStop.value) break;
          if (round > 1) {
            // 第二轮起刷新计划（上面的原因）；拉不到就沿用上一轮的
            const refreshed = await loadPlan(tokenId, tokenName);
            if (refreshed) plan = refreshed;
          }
          const before = progress.count;

          for (const stepId of stepIds) {
            if (shouldStop.value) break;
            const step = STEPS[stepId];
            if (!step) continue;
            await step({ tokenId, token, plan, progress });
          }

          if (!isFullSet) break;
          const gained = progress.count - before;
          if (gained <= 0) {
            log(tokenName, `第 ${round} 轮无新进展，全套结束`);
            break;
          }
          if (round < maxRounds) {
            log(tokenName, `第 ${round} 轮有进展（+${gained}），再转一轮看有没有新解锁`);
          }
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
  const xiaoyaojinLottery = () =>
    runXiaoyaojin(["lottery"], "逍遥津抽奖（抽光为止）");
  const xiaoyaojinCumulative = () =>
    runXiaoyaojin(["cumulative"], "逍遥津累计抽奖奖励");
  const xiaoyaojinExchange = () => runXiaoyaojin(["exchange"], "逍遥津兑换");
  const xiaoyaojinCoupon = () =>
    runXiaoyaojin(["couponExchange"], "逍遥津券兑换（饼干/复活丹）");

  return {
    xiaoyaojinAll,
    xiaoyaojinDailyTask,
    xiaoyaojinPassChest,
    xiaoyaojinPassRewards,
    xiaoyaojinOneTimeGift,
    xiaoyaojinSignReward,
    xiaoyaojinLottery,
    xiaoyaojinCumulative,
    xiaoyaojinExchange,
    xiaoyaojinCoupon,
    // 供界面「探测活动实例」预览用：把战令档位进度也读出来（纯读）
    inspectXiaoyaojin: async (tokenId, tokenName = "") => {
      const plan = buildXiaoyaojinPlan(
        await tokenStore.sendMessageWithPromise(tokenId, "activity_get", {}, 8000),
        { overrides: readOptions().overrides || {} },
      );
      if (!plan.ok) return plan;
      const points = await readPoints(tokenId, tokenName);

      // 抽奖侧状态（纯读）：累计次数 / 已领累计奖励档 / 券与材料余额
      let lottery = null;
      try {
        lottery = summarizeLottery(
          pickLotteryInfo(
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "activity_getlotteryinfo",
              {},
              8000,
            ),
          ),
          null,
        );
      } catch (error) {
        log(tokenName, `抽奖状态查询失败：${errorText(error)}`, "warning");
      }
      const tickets = await readItemCount(
        tokenId,
        tokenName,
        XIAOYAOJIN_LOTTERY_TICKET_ITEM_ID,
      );
      const frag = await readItemCount(
        tokenId,
        tokenName,
        XIAOYAOJIN_EXCHANGE_ITEM_ID,
      );
      const coupons = await readItemCount(
        tokenId,
        tokenName,
        XIAOYAOJIN_COUPON_ITEM_ID,
      );

      return {
        ...plan,
        passTiers: describePassTiers(plan.warOrderInfo, {
          actId: plan.warOrderActivityId,
          points,
        }),
        lottery: { ...lottery, tickets, frag },
        coupon: { tickets: coupons, purchase: planCouponPurchase(coupons) },
      };
    },
  };
}

export default { createTasksXiaoyaojin };
