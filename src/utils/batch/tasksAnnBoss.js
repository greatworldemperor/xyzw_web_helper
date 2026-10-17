/**
 * 周年庆「一次性奖励 + 每日签到助力 + 闯关打BOSS」批量任务（临时活动，2026-10-17 接入）
 *
 * 协议证据：`local-data/anniversary/ann_daily_boss_full.jsonl`（2026-10-17 01:32-01:35
 *   runtime 抓包，角色 9736服-139073239-法王，158 帧全解码；配套脚本：
 *   `_decode_boss_jsonl.mjs` 解 SEND / `_decode_boss_recv.mjs` 解 RECV /
 *   `_check_iswin.mjs` 验胜负字段 / `_verify_reencode.mjs` 逐字段复现 11/11 一致）。
 * 补充证据：`local-data/anniversary/ann_reward.jsonl`（2026-10-17 14:36 抓包，
 *   9729服-29号战士，弱号连败场；`_extract_reward.mjs` 解出两条关键口径）：
 *   ① **失败场 `result.isWin` 字段缺失**（胜场才带 isWin:true）⇒ 胜负判定必须
 *      `isWin → accept.ext.curHP===0 → winCnt/层数上涨` 三级兜底；
 *   ② **`todayUseTickCnt` 只由 towers_start 消耗**（getinfo=5 → start=6 → fight 不变）
 *      ⇒ 每日 10 次机会是**账号级**预算，不是每 BOSS 10 次；弱号连败时预算耗尽即停。
 *
 * ── 与「换皮闯关」（SkinChallengeCard.vue / tasksTower.js skinChallenge）的差异 ──
 * 游戏界面形式相同（towers_* 六宫格 BOSS 挑战），但旧功能在本活动**无法执行**：
 *   ① actId 不同：换皮闯关 actId 由 `getTowerActId()` 按「本周五」推算（2026-10-17 当周
 *      = 2610161）；周年庆闯关是独立活动 **actId 2610163**。旧功能拿 2610161 去
 *      towers_getinfo ⇒ 服务端空响应 ⇒ 「活动信息获取失败」直接 return；
 *   ② 领奖机制不同：旧功能通关后 `activity_startactegame` 轮领（actId+1）；
 *      周年庆 levelRewardMap 抓包时 1001~1008 已全 true（每层奖励随战斗自动到账），
 *      无需也**没有**对应的轮领命令，本任务不碰；
 *   ③ 周年庆同屏还有 celebrate（签到/全服助力/读卡/个人奖励）与
 *      common_claimtotalreward（一次性奖励），换皮闯关页面没有这些。
 *
 * ── 抓包实测口径（master 2026-10-17 手动全流程） ──
 *   一次性奖励  common_claimtotalreward {activityId:2610167, configId:261016701}
 *               → Common_RewardResp：item 5292 ×1 + 37011 ×1
 *   每日签到    celebrate_sign {} → 回 Celebrate_GetCelebrateInfoResp
 *               （personalSignMap 写入 {261017: 签到时间戳}，当日键 = 日期 26-10-17）
 *   全服助力    celebrate_claimfullserver {idList:[1]} → Celebrate_ClaimResp：
 *               集卡 item 90111 ×1（type 21）；{idList:[2]} → 金币 1001 ×10
 *   集卡读卡    linkcard_readcard {cardId:90111, readNum:1} → SyncResp
 *               （body.role.linkCard["90111"].readNum 0→1）
 *   个人奖励    celebrate_claimpersonal {idList:[1]} → 金币 1001 ×3
 *               （personalClaimMap["1"].signState 1→2）
 *   攻打BOSS    towers_getinfo {actId:2610163} → Towers_GetInfoResp（towerData 六宫格，
 *               每格 {fighting, actTowerLv, winCnt, pass, ...}；注意**外层 towerData 内还有
 *               一层 towerData Map**，取数要归一化）
 *               towers_start {actId, towerType} → Towers_StartResp（fighting:true）
 *               towers_fight {actId, towerType} → Towers_FightResp：
 *                 towerData.actTowerLv +1 / winCnt +1 / 第 8 层 pass:true（通关）
 *                 battleData.result.isWin=true、accept.ext.curHP=0（怪物全灭）
 *               抓包里 1 次 start + 8 次 fight 直接通关（无失败）；
 *               每次 fight 奖励 金币 1001 + 券 40009，数量随层数涨。
 *
 * 实现口径（与 tasksAnnDaily 同风格：很单纯的领取/战斗指令，服务端拒绝算 benign）：
 *   - actId / missionId / cardId 全硬编码（临时活动，下期轮换再改常量）；
 *   - 领取类：不前置探测，按抓包顺序直接发；已领取/未达成/未开/已结束 全算跳过；
 *     瞬时失败（超时等）重试 2 次（领取幂等，重试不会重复到账）；
 *   - 攻打类：前置一次 towers_getinfo 探活 + 选目标；今日开放（周五 BOSS1 / 周六 BOSS2 /
 *     周日 BOSS3 / 周一 BOSS4 / 周二 BOSS5 / 周三 BOSS6 / 周四全开，与换皮闯关同口径）
 *     且未通关的 BOSS 逐个打；**没通关就一直打**，直到 ① 通关（pass）② 今日次数用完
 *     （todayUseTickCnt 日上限 10，**账号级**、只由 towers_start 消耗，抓包实证；
 *     周四全开 6 BOSS 共享这 10 次）③ 用户停止 ④ 瞬时错误重试耗尽；
 *     start/fight 瞬时失败各重试 2 次；每战日志带「今日 X/10 次」预算状态；
 *   - 触发限流(400340)立即停该账号剩余动作（下次再跑）；
 *   - 连接生命周期与助威/每日奖励模块同口径：ensureConnection → finally close + releaseSlot。
 */

const nowText = () => new Date().toLocaleTimeString();

/** 服务端错误信封 → 判定文本（createServerError 会把 error / message 都挂上） */
const errorText = (error) =>
  String(error?.error || error?.message || error || "");

/** 服务端限流（项目通用码）：不是失败，是「这次别连发了」 */
export const isRateLimitError = (error) => Number(error?.code) === 400340;

/** 已领过：幂等重跑的常态，不算失败 */
export const isAlreadyDoneError = (error) =>
  /已领取|已经领取|领取过|重复领取|本期已|已领完|领完|已达上限|已兑换|已签到|已阅读|已读取/.test(
    errorText(error),
  );

/** 任务未达成 / 条件不满足 / 不可领：正常跳过 */
export const isNotCompletedError = (error) =>
  /未达成|未完成|条件不满足|未满足|不可领取|无法领取|未达到/.test(errorText(error));

/** 活动未开 / 已结束 / ID 无效：提示为主，不算失败 */
export const isInactiveError = (error) =>
  /未开启|未开始|已结束|活动不存在|无效的ID|未开放|活动已过期/.test(errorText(error));

/**
 * 「今日次数已用完」类拒绝（抓包未取到原文，按常见服务端文案宽匹配）；
 * 命中即干净停（不算失败、不重试风暴）。拒绝语义最终以服务端为准。
 */
export const isDailyLimitError = (error) =>
  /次数|上限|已用完|已达|明日| exhausted|limit/i.test(errorText(error));

/** 奖励字段 → 可读文案（Common_RewardResp / Celebrate_ClaimResp 同构：body.reward[]） */
export const rewardText = (response) => {
  const list = Array.isArray(response?.reward) ? response.reward : [];
  if (list.length === 0) return "奖励已同步";
  return list
    .map((item) => `itemId ${item.itemId} ×${item.value}`)
    .join("、");
};

// ── 活动实例 ID（抓包实证，下期轮换再改这里）────────────────────────────────────

/** 一次性奖励活动（commonActivityInfo 的键 2610167，configId = actId×100+01） */
export const ANN_ONETIME_ACT_ID = 2610167;
export const ANN_ONETIME_CONFIG_ID = 261016701;

/** 全服助力奖励档位（fullServerClaimMap 里出现过的 id；未领的档位服务端会拒，算 benign） */
export const ANN_CELEBRATE_FULLSERVER_IDS = Object.freeze([1, 2]);

/** 个人每日奖励档位（personalClaimMap 的键 "1"） */
export const ANN_CELEBRATE_PERSONAL_IDS = Object.freeze([1]);

/** 集卡：全服助力第 1 档给的卡（type 21 item 90111），每日可读 1 次 */
export const ANN_LINKCARD_CARD_ID = 90111;
export const ANN_LINKCARD_READ_NUM = 1;

/** 闯关活动 actId（ Towers_GetInfoResp.towerData.actId 实证） */
export const ANN_BOSS_ACT_ID = 2610163;

/** 六宫格 BOSS 编号 */
export const ANN_BOSS_TYPES = Object.freeze([1, 2, 3, 4, 5, 6]);

/** 每个 BOSS 的最大战斗次数：8 关 + 失败冗余 = 10 次机会（master 2026-10-17 口径） */
export const ANN_BOSS_MAX_FIGHTS = 10;

/**
 * 每日挑战次数上限（**账号级**，不是每 BOSS）：UI「今日挑战 X/10」+ 抓包实证
 * （ann_reward.jsonl：getinfo todayUseTickCnt=5 → towers_start 后=6 → fight 不变）
 * ⇒ tick 只由 `towers_start` 消耗，战斗本身不耗次数；周四全开时 6 BOSS 共享这 10 次。
 */
export const ANN_BOSS_DAILY_LIMIT = 10;

/** start/fight 瞬时失败（超时等）重试次数 */
const REQUEST_RETRY = 2;

/**
 * 今日开放 BOSS（与换皮闯关同口径：周五 1 / 周六 2 / 周日 3 / 周一 4 / 周二 5 /
 * 周三 6 / 周四全开）。抓包日 2026-10-17 是周六，master 打的正是 BOSS 2，吻合。
 */
const ANN_BOSS_OPEN_BY_WEEKDAY = Object.freeze({
  5: [1], // 周五
  6: [2], // 周六
  0: [3], // 周日
  1: [4], // 周一
  2: [5], // 周二
  3: [6], // 周三
  4: [1, 2, 3, 4, 5, 6], // 周四全开
});

/** 今日开放的 BOSS 编号列表 */
export const getTodayOpenBossTypes = (date = new Date()) => [
  ...(ANN_BOSS_OPEN_BY_WEEKDAY[date.getDay()] ?? []),
];

/**
 * towers_getinfo 响应归一化。抓包实证形态是**嵌套**的：
 *   {towerData: {actId, season, useTickCnt, todayUseTickCnt, towerData: {"1": {...}}, levelRewardMap}}
 * 旧功能代码还遇到过平铺形态（actId 在根上）。按「根 actId → 嵌套 towerData.actId」择一返回，
 * 两种形态归一后都有 {actId, towerData: <六宫格 Map>}。
 */
export const normalizeTowerInfo = (response) => {
  if (!response || typeof response !== "object") return null;
  if (response.actId !== undefined) return response;
  const outer = response.towerData;
  if (outer && typeof outer === "object" && outer.actId !== undefined) {
    return outer;
  }
  return null;
};

/** 单格 BOSS 状态 */
const bossStateOf = (towerInfo, type) => {
  const map = towerInfo?.towerData;
  if (!map || typeof map !== "object") return null;
  return map[String(type)] ?? map[type] ?? null;
};

/**
 * 选今天要打的 BOSS：今日开放 且 未通关（pass !== true）。
 * 昨日已通关的 BOSS 服务端每日重置 towerData（抓包实证：levelRewardMap 全 true 但
 * towerData 回到 lv1/0 胜），次日会重新出现在目标里，属于每日重复拿奖励的正常行为。
 */
export const pickBossTargets = (towerInfo, date = new Date()) => {
  if (!towerInfo?.actId) return [];
  const open = new Set(getTodayOpenBossTypes(date));
  return ANN_BOSS_TYPES.filter((type) => {
    if (!open.has(type)) return false;
    const state = bossStateOf(towerInfo, type);
    if (!state) return false;
    return state.pass !== true;
  });
};

/**
 * 单场战斗是否获胜。主判 battleData.result.isWin（抓包 8/8 为 true）；
 * 兜底旧口径 accept.ext.curHP === 0（怪物方全员血量归零）；
 * 再兜底 winCnt 比打之前涨了（调用方传 prevWinCnt）。
 */
export const isFightWin = (fightRes, prevWinCnt = null) => {
  const result = fightRes?.battleData?.result;
  if (result && typeof result.isWin === "boolean") return result.isWin;
  if (result?.accept?.ext?.curHP === 0) return true;
  const winCnt = fightRes?.towerData?.winCnt;
  if (typeof prevWinCnt === "number" && typeof winCnt === "number") {
    return winCnt > prevWinCnt;
  }
  return false;
};

/** 战斗间隔（ms）：抓包里手点约 15s（含看动画），自动跑不需要等那么久 */
const FIGHT_INTERVAL_MS = 1000;
const START_INTERVAL_MS = 500;
/** 领取类指令间隔（ms） */
const CLAIM_INTERVAL_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export function createTasksAnnBoss(deps) {
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
   * 批量执行骨架（与 tasksAnnDaily 同口径：连接生命周期 / 状态 / 限流处理）。
   * perToken.run 返回 "failed" 时该账号记 failed，其余（含全跳过）记 completed。
   */
  const runForSelectedTokens = async (perToken, doneMessage) => {
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
          message: `=== 开始${perToken.label}: ${tokenName} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        const outcome = await perToken.run({ tokenId, token });
        tokenStatus.value[tokenId] = outcome === "failed" ? "failed" : "completed";
      } catch (error) {
        if (isRateLimitError(error)) {
          tokenStatus.value[tokenId] = "completed";
          log(tokenName, "触发限流(400340)，下次再试", "warning");
        } else if (isInactiveError(error)) {
          tokenStatus.value[tokenId] = "completed";
          log(tokenName, `活动暂未开放：${errorText(error)}`, "warning");
        } else {
          tokenStatus.value[tokenId] = "failed";
          log(tokenName, `${perToken.label}失败：${errorText(error)}`, "error");
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
    message.success(doneMessage);
  };

  // ── ① 一次性奖励 ────────────────────────────────────────────────────────────

  const claimOneTimeForToken = async ({ tokenId, token }) => {
    const tokenName = token?.name || tokenId;
    // 瞬时失败（超时等）重试：领取指令是幂等的，重试不会重复到账
    for (let attempt = 1; attempt <= REQUEST_RETRY; attempt += 1) {
      try {
        const response = await tokenStore.sendMessageWithPromise(
          tokenId,
          "common_claimtotalreward",
          { activityId: ANN_ONETIME_ACT_ID, configId: ANN_ONETIME_CONFIG_ID },
          8000,
        );
        log(
          tokenName,
          `周年庆一次性奖励领取成功（${rewardText(response)}）`,
          "success",
        );
        return "claimed";
      } catch (error) {
        if (isRateLimitError(error)) throw error;
        const isLast = attempt >= REQUEST_RETRY;
        if (!isLast) {
          log(
            tokenName,
            `周年庆一次性奖励无响应，第 ${attempt}/${REQUEST_RETRY} 次重试……`,
            "warning",
          );
          await sleep(1000);
          continue;
        }
        if (isAlreadyDoneError(error)) {
          log(tokenName, "周年庆一次性奖励已领取过，跳过");
          return "nothing";
        }
        if (isNotCompletedError(error)) {
          log(tokenName, "周年庆一次性奖励条件未达成，跳过");
          return "nothing";
        }
        if (isInactiveError(error)) {
          log(tokenName, `周年庆一次性奖励暂未开放：${errorText(error)}`, "warning");
          return "nothing";
        }
        log(
          tokenName,
          `周年庆一次性奖励领取失败：${errorText(error)}（请求 {activityId:${ANN_ONETIME_ACT_ID}, configId:${ANN_ONETIME_CONFIG_ID}}，如持续失败请把此条日志给开发）`,
          "error",
        );
        return "failed";
      }
    }
    return "nothing";
  };

  const batchAnnOneTimeReward = async () =>
    runForSelectedTokens(
      { label: "周年庆一次性奖励", run: claimOneTimeForToken },
      "批量领取周年庆一次性奖励结束",
    );

  // ── ② 每日奖励 / 每日助力（celebrate：签到 + 全服助力 + 读卡 + 个人奖励）──────

  const claimCelebrateForToken = async ({ tokenId, token }) => {
    const tokenName = token?.name || tokenId;
    let claimed = 0;

    // 1) 每日签到（当日键 261017 形式；已签到服务端会拒，算 benign）
    try {
      await tokenStore.sendMessageWithPromise(tokenId, "celebrate_sign", {}, 8000);
      claimed += 1;
      log(tokenName, "周年庆每日签到成功", "success");
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      if (isAlreadyDoneError(error)) {
        log(tokenName, "周年庆今日已签到，跳过");
      } else if (isInactiveError(error)) {
        log(tokenName, `周年庆签到暂未开放：${errorText(error)}`, "warning");
      } else {
        log(tokenName, `周年庆签到失败：${errorText(error)}`, "error");
        return "failed";
      }
    }
    await sleep(CLAIM_INTERVAL_MS);

    // 2) 全服助力第 1 档（给集卡 90111；必须先领到卡才能读卡，顺序按抓包）
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        "celebrate_claimfullserver",
        { idList: [ANN_CELEBRATE_FULLSERVER_IDS[0]] },
        8000,
      );
      claimed += 1;
      log(
        tokenName,
        `周年庆全服助力奖励 ${ANN_CELEBRATE_FULLSERVER_IDS[0]} 领取成功（${rewardText(response)}）`,
        "success",
      );
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      if (isAlreadyDoneError(error)) {
        log(tokenName, `周年庆全服助力奖励 ${ANN_CELEBRATE_FULLSERVER_IDS[0]} 已领取过，跳过`);
      } else if (isNotCompletedError(error)) {
        log(tokenName, `周年庆全服助力奖励 ${ANN_CELEBRATE_FULLSERVER_IDS[0]} 未达成，跳过`);
      } else if (isInactiveError(error)) {
        log(tokenName, `周年庆全服助力暂未开放：${errorText(error)}`, "warning");
      } else {
        log(
          tokenName,
          `周年庆全服助力奖励 ${ANN_CELEBRATE_FULLSERVER_IDS[0]} 领取失败：${errorText(error)}`,
          "error",
        );
        return "failed";
      }
    }
    await sleep(CLAIM_INTERVAL_MS);

    // 3) 集卡读卡（每日助力；卡不在手上 / 今日已读都会被拒，算 benign）
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        "linkcard_readcard",
        { cardId: ANN_LINKCARD_CARD_ID, readNum: ANN_LINKCARD_READ_NUM },
        8000,
      );
      claimed += 1;
      const readNum = response?.role?.linkCard?.[String(ANN_LINKCARD_CARD_ID)]?.readNum;
      log(
        tokenName,
        `周年庆读卡成功（cardId ${ANN_LINKCARD_CARD_ID}，累计阅读 ${readNum ?? "?"} 次）`,
        "success",
      );
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      if (isAlreadyDoneError(error)) {
        log(tokenName, "周年庆今日已读过卡，跳过");
      } else if (isNotCompletedError(error)) {
        log(tokenName, "周年庆读卡条件未达成（卡未到手？），跳过");
      } else if (isInactiveError(error)) {
        log(tokenName, `周年庆读卡暂未开放：${errorText(error)}`, "warning");
      } else {
        log(tokenName, `周年庆读卡失败：${errorText(error)}`, "error");
        return "failed";
      }
    }
    await sleep(CLAIM_INTERVAL_MS);

    // 4) 全服助力第 2 档
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        "celebrate_claimfullserver",
        { idList: [ANN_CELEBRATE_FULLSERVER_IDS[1]] },
        8000,
      );
      claimed += 1;
      log(
        tokenName,
        `周年庆全服助力奖励 ${ANN_CELEBRATE_FULLSERVER_IDS[1]} 领取成功（${rewardText(response)}）`,
        "success",
      );
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      if (isAlreadyDoneError(error)) {
        log(tokenName, `周年庆全服助力奖励 ${ANN_CELEBRATE_FULLSERVER_IDS[1]} 已领取过，跳过`);
      } else if (isNotCompletedError(error)) {
        log(tokenName, `周年庆全服助力奖励 ${ANN_CELEBRATE_FULLSERVER_IDS[1]} 未达成，跳过`);
      } else if (isInactiveError(error)) {
        log(tokenName, `周年庆全服助力暂未开放：${errorText(error)}`, "warning");
      } else {
        log(
          tokenName,
          `周年庆全服助力奖励 ${ANN_CELEBRATE_FULLSERVER_IDS[1]} 领取失败：${errorText(error)}`,
          "error",
        );
        return "failed";
      }
    }
    await sleep(CLAIM_INTERVAL_MS);

    // 5) 个人每日奖励（签到后 signState 1→2；未签到会被拒，算 benign）
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        "celebrate_claimpersonal",
        { idList: [...ANN_CELEBRATE_PERSONAL_IDS] },
        8000,
      );
      claimed += 1;
      log(
        tokenName,
        `周年庆个人每日奖励 ${ANN_CELEBRATE_PERSONAL_IDS[0]} 领取成功（${rewardText(response)}）`,
        "success",
      );
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      if (isAlreadyDoneError(error)) {
        log(tokenName, `周年庆个人每日奖励 ${ANN_CELEBRATE_PERSONAL_IDS[0]} 已领取过，跳过`);
      } else if (isNotCompletedError(error)) {
        log(tokenName, `周年庆个人每日奖励 ${ANN_CELEBRATE_PERSONAL_IDS[0]} 未达成（未签到？），跳过`);
      } else if (isInactiveError(error)) {
        log(tokenName, `周年庆个人奖励暂未开放：${errorText(error)}`, "warning");
      } else {
        log(
          tokenName,
          `周年庆个人每日奖励 ${ANN_CELEBRATE_PERSONAL_IDS[0]} 领取失败：${errorText(error)}`,
          "error",
        );
        return "failed";
      }
    }

    return claimed > 0 ? "claimed" : "nothing";
  };

  const batchAnnCelebrateClaim = async () =>
    runForSelectedTokens(
      { label: "周年庆每日奖励/助力", run: claimCelebrateForToken },
      "批量领取周年庆每日奖励/助力结束",
    );

  // ── ③ 攻打 BOSS（towers：start + fight，没通关就一直打到日预算用完）──────────

  /**
   * 单个 BOSS：开打 → 战斗 → **没通关就继续打**，直到
   * ① 通关（pass）② 日预算用完（todayUseTickCnt 达 10 / start 被拒）
   * ③ 用户停止 ④ 瞬时错误重试耗尽。
   * @returns {{cleared: boolean, fights: number, usedTicks: number, stop: string}}
   *   stop ∈ cleared | daily-limit | user-stop | exhausted | request-error | inactive
   */
  const fightOneBoss = async ({
    tokenId,
    tokenName,
    towerType,
    initialState,
    usedTicks,
  }) => {
    let fights = 0;
    let prevWinCnt = initialState?.winCnt ?? 0;
    // 上次有未打完的战斗（fighting:true）直接续打，否则先 start
    let needStart = initialState?.fighting !== true;
    let stop = "exhausted";

    while (fights < ANN_BOSS_MAX_FIGHTS && !shouldStop.value) {
      if (needStart) {
        // 预算预检（服务端权威值）：已满就不白发请求
        if (usedTicks >= ANN_BOSS_DAILY_LIMIT) {
          stop = "daily-limit";
          break;
        }
        let startOk = false;
        for (let attempt = 1; attempt <= REQUEST_RETRY && !startOk; attempt += 1) {
          try {
            const startRes = await tokenStore.sendMessageWithPromise(
              tokenId,
              "towers_start",
              { actId: ANN_BOSS_ACT_ID, towerType },
              8000,
            );
            startOk = true;
            // StartResp.towerData.todayUseTickCnt = 服务端权威 tick 数
            const tick = startRes?.towerData?.todayUseTickCnt;
            if (Number.isFinite(tick)) usedTicks = tick;
          } catch (error) {
            if (isRateLimitError(error)) throw error;
            if (isInactiveError(error)) {
              log(tokenName, `BOSS ${towerType} 暂未开放：${errorText(error)}`, "warning");
              return { cleared: false, fights, usedTicks, stop: "inactive" };
            }
            if (isDailyLimitError(error)) {
              log(
                tokenName,
                `BOSS ${towerType} 今日次数已用完（服务端：${errorText(error)}）`,
                "info",
              );
              stop = "daily-limit";
              break;
            }
            if (attempt >= REQUEST_RETRY) {
              log(
                tokenName,
                `BOSS ${towerType} 开打失败（重试 ${REQUEST_RETRY} 次仍不行）：${errorText(error)}`,
                "error",
              );
              stop = "request-error";
              break;
            }
            log(
              tokenName,
              `BOSS ${towerType} 开打无响应，第 ${attempt}/${REQUEST_RETRY} 次重试……`,
              "warning",
            );
            await sleep(1000);
          }
        }
        if (!startOk) break;
        await sleep(START_INTERVAL_MS);
      }

      let fightRes = null;
      for (let attempt = 1; attempt <= REQUEST_RETRY && !fightRes; attempt += 1) {
        try {
          fightRes = await tokenStore.sendMessageWithPromise(
            tokenId,
            "towers_fight",
            { actId: ANN_BOSS_ACT_ID, towerType },
            15000,
          );
        } catch (error) {
          if (isRateLimitError(error)) throw error;
          if (isInactiveError(error)) {
            log(tokenName, `BOSS ${towerType} 暂未开放：${errorText(error)}`, "warning");
            return { cleared: false, fights, usedTicks, stop: "inactive" };
          }
          if (isDailyLimitError(error)) {
            log(
              tokenName,
              `BOSS ${towerType} 战斗被拒，今日次数已用完（服务端：${errorText(error)}）`,
              "info",
            );
            stop = "daily-limit";
            break;
          }
          if (attempt >= REQUEST_RETRY) break;
          log(
            tokenName,
            `BOSS ${towerType} 战斗响应超时，第 ${attempt}/${REQUEST_RETRY} 次重试……`,
            "warning",
          );
          await sleep(1500);
        }
      }
      if (!fightRes) {
        if (stop !== "daily-limit") {
          stop = "request-error";
          log(
            tokenName,
            `BOSS ${towerType} 战斗请求失败（已重试 ${REQUEST_RETRY} 次），下次再跑会接着打`,
            "error",
          );
        }
        break;
      }
      // 战斗响应里的 tick 同样是权威值（fight 本身不耗 tick，防服务端改口径）
      const tickInFight = fightRes?.todayUseTickCnt;
      if (Number.isFinite(tickInFight)) usedTicks = Math.max(usedTicks, tickInFight);

      fights += 1;
      const towerState = fightRes?.towerData ?? {};
      const level = towerState.actTowerLv ?? "?";
      // 胜负判定（服务端权威字段交叉验证，不用层数——层数会受 getinfo 时效影响）：
      // isWin → 怪物 curHP 归零 → winCnt 比打之前涨了
      const won =
        isFightWin(fightRes, prevWinCnt) ||
        (Number.isFinite(towerState.winCnt) && towerState.winCnt > prevWinCnt);
      prevWinCnt = towerState.winCnt ?? prevWinCnt;

      const budgetText = `今日 ${usedTicks}/${ANN_BOSS_DAILY_LIMIT} 次`;
      if (won) {
        log(
          tokenName,
          `BOSS ${towerType} 第 ${level} 层挑战成功（第 ${fights} 战，${budgetText}）`,
          "success",
        );
        needStart = false; // 同一轮里连胜不需要重新 start
      } else {
        log(
          tokenName,
          `BOSS ${towerType} 第 ${level} 层挑战失败（第 ${fights} 战，${budgetText}）`,
          "warning",
        );
        needStart = true; // 失败重新开打
      }

      if (towerState.pass === true) {
        log(tokenName, `BOSS ${towerType} 已通关（共 ${fights} 战）`, "success");
        return { cleared: true, fights, usedTicks, stop: "cleared" };
      }

      await sleep(FIGHT_INTERVAL_MS);
    }

    if (shouldStop.value) stop = "user-stop";
    else if (fights >= ANN_BOSS_MAX_FIGHTS) stop = "exhausted";
    return { cleared: false, fights, usedTicks, stop };
  };

  const fightBossesForToken = async ({ tokenId, token }) => {
    const tokenName = token?.name || tokenId;

    // 前置探测：拿六宫格状态 + 今日已用次数（活动未开时服务端拒/空响应，直接跳过）
    let info;
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        "towers_getinfo",
        { actId: ANN_BOSS_ACT_ID },
        5000,
      );
      info = normalizeTowerInfo(response);
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      if (isInactiveError(error)) {
        log(tokenName, `周年庆闯关暂未开放：${errorText(error)}`, "warning");
        return "nothing";
      }
      log(tokenName, `周年庆闯关信息获取失败：${errorText(error)}`, "error");
      return "failed";
    }

    if (!info?.actId) {
      log(tokenName, "周年庆闯关信息异常（无 actId），跳过", "warning");
      return "nothing";
    }

    // 今日剩余次数（服务端权威：todayUseTickCnt 只由 towers_start 消耗）
    let usedTicks = Number.isFinite(info.todayUseTickCnt)
      ? info.todayUseTickCnt
      : 0;
    const remainTicks = Math.max(0, ANN_BOSS_DAILY_LIMIT - usedTicks);
    if (remainTicks <= 0) {
      log(
        tokenName,
        `今日挑战次数已用完（${usedTicks}/${ANN_BOSS_DAILY_LIMIT}），跳过`,
        "info",
      );
      return "nothing";
    }

    const targets = pickBossTargets(info);
    if (targets.length === 0) {
      log(tokenName, "今日开放 BOSS 均已通关（或无开放 BOSS），跳过", "info");
      return "nothing";
    }

    log(
      tokenName,
      `今日开放 BOSS ${targets.join(", ")}；次数已用 ${usedTicks}/${ANN_BOSS_DAILY_LIMIT}、剩 ${remainTicks} 次——没通关就一直打到用完为止`,
      "info",
    );

    let cleared = 0;
    for (const towerType of targets) {
      if (shouldStop.value) break;
      if (usedTicks >= ANN_BOSS_DAILY_LIMIT) {
        log(tokenName, `今日 ${ANN_BOSS_DAILY_LIMIT} 次机会已用完，跳过剩余 BOSS`, "info");
        break;
      }
      const result = await fightOneBoss({
        tokenId,
        tokenName,
        towerType,
        initialState: bossStateOf(info, towerType),
        usedTicks,
      });
      usedTicks = result.usedTicks;
      if (result.cleared) cleared += 1;
      await sleep(FIGHT_INTERVAL_MS);
    }

    log(
      tokenName,
      `周年庆闯关结束：${cleared > 0 ? `通关 ${cleared} 个 BOSS` : "未有通关"}（今日次数 ${usedTicks}/${ANN_BOSS_DAILY_LIMIT}）`,
      cleared > 0 ? "success" : "info",
    );
    return "done";
  };

  const batchAnnBossFight = async () =>
    runForSelectedTokens(
      { label: "周年庆闯关打BOSS", run: fightBossesForToken },
      "批量攻打周年庆 BOSS 结束",
    );

  return {
    batchAnnOneTimeReward,
    batchAnnCelebrateClaim,
    batchAnnBossFight,
  };
}
