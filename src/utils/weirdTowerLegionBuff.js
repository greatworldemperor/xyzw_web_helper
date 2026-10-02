/**
 * 怪异塔 · 俱乐部 legion buff（俱乐部人数档位）
 *
 * 协议来源：local-data/weird_tower/evotower_get_buff.jsonl
 *   文档：docs/weird-tower-legion-privilege-analysis.md
 *
 * 规则（master 2026-10-02 口述 + 抓包实证）：
 *   · buff 档位由「本俱乐部本期已参与怪异塔战斗的角色数量」决定
 *   · 一共 4 档，阈值 10 / 15 / 20 / 25 人
 *   · 俱乐部归属在首次战斗时绑定（bindLegionId 由0 变真实 id），绑定前拿不到 buff
 *
 * 🔴 两条抓包实证的关键口径（写代码前务必记住）：
 *   1. `evotower_claimlegionprivilege` 请求体是**空{}**，**一次只领一档**，
 *      要领满N 档必须连调 N 次。服务端决定给哪一档，前端不能指定。
 *   2. 响应里**顶层 `legionPrivilege` 是「已解锁全量档位」**（三次调用恒为 {1,2,3}），
 *      **本次新领的档位在 `body.evoTower.legionPrivilege`**（seq50={1:1}/52={2:1}/53={3:1}）。
 *      拿顶层做增量判断会误判成「第一次就全领完了」。
 *
 * ⚠️ 阈值 10/15/20/25 来自活动规则说明，**协议本身不下发阈值**（服务端内部维护）。
 *    抓到 21 人只验证到「命中 1/2/3 档、未命中第 4 档」。
 */

/** 档位总数（4 档） */
export const LEGION_PRIVILEGE_TIER_COUNT = 4;

/**
 * 各档人数阈值。索引 0 = 未达成，1..4 = 档位 1..4。
 * 🔴 来源：活动规则（master 口述），**非协议下发**。改动前先与游戏 UI 对齐。
 */
export const LEGION_PRIVILEGE_THRESHOLDS = Object.freeze([0, 10, 15, 20, 25]);

/** 领取命令（body 为空对象，服务端决定发哪一档） */
export const CMD_CLAIM_LEGION_PRIVILEGE = "evotower_claimlegionprivilege";
/** 查询已参战成员（人数唯一数据源） */
export const CMD_GET_LEGION_JOIN_MEMBERS = "evotower_getlegionjoinmembers";
/** 查自身怪异塔信息（读 bindLegionId / legionPrivilege） */
export const CMD_GET_EVOTOWER_INFO = "evotower_getinfo";

/** 档位状态 */
export const TIER_STATE = Object.freeze({
  /** 人数不够，未解锁 */
  LOCKED: "locked",
  /** 已解锁但还没领 */
  CLAIMABLE: "claimable",
  /** 已解锁且已领取 */
  CLAIMED: "claimed",
});

/** 人数 → 命中档位号（0 = 未达任何档）。人数为负/非数按 0 处理 */
export function resolveReachedTier(participantCount) {
  const n = Number(participantCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  let tier = 0;
  for (let i = 1; i < LEGION_PRIVILEGE_THRESHOLDS.length; i++) {
    if (n >= LEGION_PRIVILEGE_THRESHOLDS[i]) tier = i;
    else break;
  }
  return tier;
}

/** 距下一档还差几人（已满级返回 0） */
export function countToNextTier(participantCount) {
  const tier = resolveReachedTier(participantCount);
  if (tier >= LEGION_PRIVILEGE_TIER_COUNT) return 0;
  return Math.max(0, LEGION_PRIVILEGE_THRESHOLDS[tier + 1] - (Number(participantCount) || 0));
}

/** 下一档的阈值（已满级返回 null） */
export function nextTierThreshold(participantCount) {
  const tier = resolveReachedTier(participantCount);
  if (tier >= LEGION_PRIVILEGE_TIER_COUNT) return null;
  return LEGION_PRIVILEGE_THRESHOLDS[tier + 1];
}

/** 从 `evotower_getlegionjoinmembers` 响应里数参与人数 */
export function countParticipants(memberScores) {
  if (!memberScores || typeof memberScores !== "object") return 0;
  return Object.keys(memberScores).length;
}

/**
 * 从 `EvoTower_ClaimLegionPrivilegeResp` 里取「已解锁全量档位」。
 * 🔴 这是顶层字段，**不是本次结果**。
 */
export function pickUnlockedTiers(resp) {
  const src = resp?.legionPrivilege;
  if (!src || typeof src !== "object") return [];
  return Object.keys(src)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= LEGION_PRIVILEGE_TIER_COUNT)
    .sort((a, b) => a - b);
}

/**
 * 从 `EvoTower_ClaimLegionPrivilegeResp` 里取「本次新领到的档位」。
 * 🔴 必须读嵌套 `body.evoTower.legionPrivilege`。
 * @returns {number[]} 本次新领的档位号（空数组 = 本次没领到任何东西）
 */
export function pickClaimedThisTime(resp) {
  const src = resp?.evoTower?.legionPrivilege;
  if (!src || typeof src !== "object") return [];
  return Object.keys(src)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= LEGION_PRIVILEGE_TIER_COUNT)
    .sort((a, b) => a - b);
}

/** 本次领取是否「啥也没领到」（= 全部档位已领完 / 无可领） */
export function isEmptyClaim(resp) {
  return pickClaimedThisTime(resp).length === 0;
}

/**
 * 计算每一档的展示状态。
 *
 * @param {object} p
 * @param {number} p.participantCount  已参战人数（memberScores 的key 数）
 * @param {number[]} [p.claimedTiers]  已领取档位（来自顶层 legionPrivilege，即已解锁且已领）
 * @returns {Array<{tier:number,threshold:number,state:string,label:string,desc:string}>}
 */
export function buildTierStates({ participantCount, claimedTiers = [] } = {}) {
  const reached = resolveReachedTier(participantCount);
  const claimed = new Set(claimedTiers.map(Number));
  const rows = [];
  for (let tier = 1; tier <= LEGION_PRIVILEGE_TIER_COUNT; tier++) {
    const threshold = LEGION_PRIVILEGE_THRESHOLDS[tier];
    let state = TIER_STATE.LOCKED;
    if (tier <= reached) {
      state = claimed.has(tier) ? TIER_STATE.CLAIMED : TIER_STATE.CLAIMABLE;
    }
    rows.push({
      tier,
      threshold,
      state,
      label: `第 ${tier} 档`,
      desc:
        state === TIER_STATE.CLAIMED
          ? `已领取（${threshold} 人达成）`
          : state === TIER_STATE.CLAIMABLE
            ? `可领取（${threshold} 人达成）`
            : `需 ${threshold} 人（还差 ${Math.max(0, threshold - (Number(participantCount) || 0))} 人）`,
    });
  }
  return rows;
}

/**
 * 还有几档没领。用于「一键领取」的循环次数上界。
 * @param {object} p
 * @param {number} p.participantCount
 * @param {number[]} [p.unlockedTiers] 已解锁档位（顶层 legionPrivilege）
 * @param {number[]} [p.claimedTiers]  已领取档位
 */
export function countPendingClaims({ participantCount, unlockedTiers = [], claimedTiers = [] } = {}) {
  const rows = buildTierStates({ participantCount, claimedTiers });
  return rows.filter((r) => r.state === TIER_STATE.CLAIMABLE).length;
}

/**
 * 汇总一句话，用于 UI 顶部提示。
 * @returns {{participantCount:number,reachedTier:number,pending:number,nextThreshold:number|null,remaining:number,headline:string}}
 */
export function summarizeBuff({ participantCount, claimedTiers = [] } = {}) {
  const n = Number(participantCount) || 0;
  const reached = resolveReachedTier(n);
  const next = nextTierThreshold(n);
  const remaining = countToNextTier(n);
  const pending = countPendingClaims({ participantCount: n, claimedTiers });
  const headline =
    n <= 0
      ? "暂无成员参与战斗，无法领取俱乐部 buff"
      : next === null
        ? `共 ${n} 人参与，已满 ${LEGION_PRIVILEGE_TIER_COUNT} 档${pending > 0 ? `，${pending} 档待领取` : "，全部已领取"}`
        : `共 ${n} 人参与，已达 ${reached}/${LEGION_PRIVILEGE_TIER_COUNT} 档（还差 ${remaining} 人到第 ${reached + 1} 档）${pending > 0 ? ` · ${pending} 档待领取` : ""}`;
  return {
    participantCount: n,
    reachedTier: reached,
    pending,
    nextThreshold: next,
    remaining,
    headline,
  };
}

/**
 * 判断能否发起领取。
 * 规则：必须已绑定俱乐部（bindLegionId 非 0）+ 有人参与过战斗。
 *
 * @param {object} p
 * @param {number} p.bindLegionId  evotower_getinfo → evoTower.bindLegionId
 * @param {number} p.participantCount
 * @returns {{ok:boolean, reason:string}}
 */
export function canClaim({ bindLegionId, participantCount } = {}) {
  const n = Number(participantCount) || 0;
  if (!Number(bindLegionId)) {
    return { ok: false, reason: "尚未绑定俱乐部（首次战斗后才会绑定），无法领取" };
  }
  if (n <= 0) {
    return { ok: false, reason: "本俱乐部暂无成员参与战斗，未达最低档位" };
  }
  return { ok: true, reason: "" };
}

/**
 * 爬塔流程中自动补领俱乐部 legion buff（master 2026-10-03 业务口径）
 *
 * 业务规则：每次爬塔都会拿到 memberScores（即人数数据）。既然数据已经在手，
 * 那就把「领取」做成爬塔流程的**前置步骤**——能领就领，领不到就直接爬塔，
 * 不需要用户手动点独立按钮。
 *
 * 🔴 为什么不用「对比自己是否已领取最高档」这个判据：
 *   抓包实证（evotower_get_buff.jsonl）：
 *     · getinfo 领取前→ `legionPrivilege: {}`（空，看不出任何档位）
 *     · 首次 claim 响应 → 顶层已是 `{1:2:3}`，但本次只领到第 1 档
 *   ⇒ 顶层 `legionPrivilege` **无法区分「已解锁」与「已领取」**，
 *     用它做增量判断会误判成「第一次就全领完」。
 *   ⇒ 唯一可靠的判据是**服务端自己的响应**：body.evoTower.legionPrivilege 非空 = 本次真领到了。
 *
 * 策略：发空body 试探一次。
 *   · 服务端给了档位 → 说明有未领的，继续领到服务端不再给为止
 *   · 服务端给空 → 说明已领完/无资格，直接返回去爬塔
 * 这样不需要在本地推断「我该领第几档」，把判断权完全交给服务端。
 *
 * @param {Object} p
 * @param {Function} p.send  (cmd, body, timeout) => Promise<any>，注入以便测试
 * @param {Function} [p.onLog] (message, type) => void
 * @param {Object} [p.timing]
 * @param {number} [p.timing.perClaim] 每次领取后的间隔ms
 * @param {number} [p.timing.perRound]  每轮（getinfo+领取）后的间隔ms
 * @returns {Promise<{claimedTiers:number[], unlockedTiers:number[], rounds:number, skipped:string|null}>}
 */
export async function autoClaimLegionBuffDuringClimb({ send, onLog, timing } = {}) {
  const result = { claimedTiers: [], unlockedTiers: [], rounds: 0, skipped: null };
  if (typeof send !== "function") {
    result.skipped = "no-send";
    return result;
  }
  const perClaim = timing?.perClaim ?? 300;
  const perRound = timing?.perRound ?? 500;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 前置：查绑定状态。未绑定（首次战斗前）直接跳过，不浪费往返。
  let bindLegionId = 0;
  try {
    const info = await send("evotower_getinfo", {}, 5000);
    bindLegionId = Number(info?.evoTower?.bindLegionId) || 0;
  } catch (error) {
    // getinfo 失败不致命：可能是限流/断连，交给统一控制器处理，这里不阻塞爬塔
    result.skipped = "getinfo-failed";
    onLog?.(`查询怪异塔信息失败，跳过俱乐部 buff 自动领取：${error?.message || error}`, "warning");
    return result;
  }
  if (!bindLegionId) {
    result.skipped = "not-bound";
    onLog?.("尚未绑定俱乐部（首次战斗后才绑定），跳过俱乐部 buff 自动领取", "info");
    return result;
  }

  // 领取：反复发空 body，拿到服务端给的档位就继续，领不到就收手。
  // 上界 = 4 档（协议实证一次一档，4 档到顶），双保险防异常死循环。
  const MAX_ROUNDS = LEGION_PRIVILEGE_TIER_COUNT;
  const got = new Set();
  for (let i = 0; i < MAX_ROUNDS; i++) {
    let resp;
    try {
      resp = await send("evotower_claimlegionprivilege", {}, 5000);
    } catch (error) {
      // 领取失败（限流等）不阻塞爬塔：buff 是加成，不是爬塔的前置条件
      result.skipped = "claim-failed";
      onLog?.(
        `领取俱乐部 buff 失败（不影响爬塔）：${error?.message || error}` +
          (got.size ? `，已领 ${[...got].join("、")} 档` : ""),
        "warning",
      );
      break;
    }
    result.rounds++;

    // 🔴 本次结果在嵌套 evoTower.legionPrivilege，不是顶层
    const claimedNow = pickClaimedThisTime(resp);
    const unlockedNow = pickUnlockedTiers(resp);
    if (unlockedNow.length) result.unlockedTiers = unlockedNow;

    if (claimedNow.length === 0) {
      // 服务端不再给档位 = 已领完 / 无资格，正常收手
      result.skipped = result.skipped || "all-claimed";
      break;
    }
    for (const t of claimedNow) got.add(t);
    onLog?.(`已领取俱乐部 buff 第 ${claimedNow.join("、")} 档`, "success");
    await sleep(perClaim);
  }

  result.claimedTiers = [...got].sort((a, b) => a - b);
  if (!result.claimedTiers.length && result.skipped === "all-claimed") {
    onLog?.("俱乐部 buff 已全部领取", "info");
  }
  await sleep(perRound);
  return result;
}
