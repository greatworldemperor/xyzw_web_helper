/**
 * 盐场「赛季淘汰赛助威」（天工投票）纯逻辑
 *
 * 协议证据：`local-data/tiangong_vote/vote.jsonl`（2026-10-15 抓包，SEND 帧逐字节精确复现）
 *   - `saltroad_getseasonoutrank {}` → `SaltRoad_GetSeasonOutRankResp { round, legionList[] }`
 *   - `saltroad_outcheer { legionId }` → `SyncResp { role.statistics["sr:out:cheer:<phase>"] = legionId }`
 *
 * 客户端语义（游戏 bundle `local-data/game_bundle_dump/game_index.plain.js` 还原）：
 *   - 助威面板 = `legionList` 按 `sOWinCnt` 降序（同胜场保持原序，稳定排序）取前 64 家；
 *   - 助威记录 = `ROLE.statistics.get("sr:out:cheer:" + betPhase)`，
 *     `betPhase` = 赛季首个赛程（SEASON_SWISS_ROUND_OF_1）的日期串（yyMMdd），
 *     ⇒ **一个账号每届赛季只能助威一家俱乐部**，键在整届内不变；
 *   - 已助威的账号 UI 不再展示助威按钮；重复助威由服务端拒绝。
 *
 * 本模块不依赖任何 Vue / WS 运行时，可被 node --test 直接回归。
 */

/** 助威记录统计键前缀（完整键 = 前缀 + 赛季首轮日期，如 sr:out:cheer:261003） */
export const SEASON_OUT_CHEER_STAT_PREFIX = "sr:out:cheer:";

/** 助威面板展示的俱乐部数量上限（对齐游戏客户端 slice(0, 64)） */
export const SEASON_OUT_CHEER_LIST_LIMIT = 64;

/**
 * 从 statistics 对象里读出已助威的俱乐部ID。
 * @param {Object} statistics - role.statistics（BON map 解出的普通对象）
 * @returns {number|null} 已助威的 legionId；没有记录返回 null
 */
export function readCheeredLegionId(statistics) {
  if (!statistics || typeof statistics !== "object") return null;
  for (const [key, value] of Object.entries(statistics)) {
    if (!key.startsWith(SEASON_OUT_CHEER_STAT_PREFIX)) continue;
    const legionId = Number(value);
    return Number.isFinite(legionId) ? legionId : null;
  }
  return null;
}

/**
 * 判定一次 saltroad_outcheer 的结果。
 *
 * 成功路径：服务端回 SyncResp，body.role.statistics 里带 sr:out:cheer:* 键。
 * 失败路径：服务端回错误信封（无 cmd 无 body，带 resp），Promise 已 reject，
 * 业务层走 catch —— 本函数只处理「拿到了响应体」的情况。
 *
 * @param {Object} response - sendMessageWithPromise resolve 出来的 body
 * @param {number} legionId - 本次请求助威的俱乐部ID
 * @returns {{ok: boolean, state: "voted"|"already-same"|"already-other"|"unknown", cheeredLegionId: number|null}}
 */
export function describeSeasonOutCheerResult(response, legionId) {
  const statistics = response?.role?.statistics;
  const cheeredLegionId = readCheeredLegionId(statistics);
  const target = Number(legionId);

  if (cheeredLegionId === null) {
    return { ok: false, state: "unknown", cheeredLegionId: null };
  }
  if (cheeredLegionId === target) {
    return { ok: true, state: "voted", cheeredLegionId };
  }
  return { ok: true, state: "already-other", cheeredLegionId };
}

/**
 * 助威面板名单：按 sOWinCnt 降序、同胜场保持服务端原序（稳定排序），取前 64。
 * 与游戏客户端 getBetList 的排序口径逐条对齐。
 *
 * @param {Array<Object>} legionList - SaltRoad_GetSeasonOutRankResp.body.legionList
 * @param {number} [limit] - 截断长度，默认 64
 * @returns {Array<Object>} 新数组（不改入参）
 */
export function selectTopSeasonOutLegions(legionList, limit = SEASON_OUT_CHEER_LIST_LIMIT) {
  if (!Array.isArray(legionList)) return [];
  const indexed = legionList.map((legion, index) => ({ legion, index }));
  indexed.sort(
    (a, b) =>
      (Number(b.legion?.sOWinCnt) || 0) - (Number(a.legion?.sOWinCnt) || 0) ||
      a.index - b.index,
  );
  return indexed.slice(0, limit).map((item) => item.legion);
}

/**
 * 淘汰赛是否在进行中（服务端口径）：赛季排行返回了非空俱乐部名单。
 * 注意助威开放窗口（开赛前一段时间内可投票）以服务端为准，
 * 客户端拿不到赛程配置（SeasonLegionScheduleConf），不做本地时间猜测。
 * @param {Object} rankResponse - SaltRoad_GetSeasonOutRankResp 的 body
 * @returns {boolean}
 */
export function isSeasonOutRankActive(rankResponse) {
  return (
    Array.isArray(rankResponse?.legionList) &&
    rankResponse.legionList.length > 0
  );
}

/**
 * 服务端错误文案 → 是否属于「已助威 / 窗口未开」这类非失败语义。
 * 与 tasksWhiteJadePkroom.js 的 isBenignError/isInactiveError 同口径。
 */
const BENIGN_CHEER_PATTERN =
  /已助威|已经助威|助威过|已参与|已投票|投票过|次数已满|已达上限/;
const INACTIVE_CHEER_PATTERN =
  /未开启|未开始|已结束|活动不存在|不在活动|未开放|尚未开放/;

export function isBenignCheerError(error) {
  const text = String(error?.error || error?.message || error || "");
  return BENIGN_CHEER_PATTERN.test(text);
}

export function isInactiveCheerError(error) {
  const text = String(error?.error || error?.message || error || "");
  return INACTIVE_CHEER_PATTERN.test(text);
}
