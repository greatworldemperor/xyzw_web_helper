/**
 * 怪异塔助力的持久化状态
 *
 * 分两层存（见 docs/weird-tower-share-assist-design.md §2）：
 *   1. 关系表 `weirdTowerAssistPlan`：接受助力角色 → 3 个槽位 + 助力角色池。
 *      **跨周期保留**（关系是低频变化的）。
 *   2. 本周期执行状态 `weirdTowerAssistRuntime`：按周期键存
 *      「谁已用掉助力机会 / 谁已被助力满 / 已取到的助力码缓存」。**换周期即作废**。
 *
 * 角色标识统一用 src/utils/token.ts 的稳定键 `getStableTokenKey(serverId, roleId)`
 * （形如 "9724:130301444"），这样重新导入 token、tokenId 变化时关系不会丢。
 */
import { useLocalStorage } from "@vueuse/core";

import { getStableTokenKey } from "../utils/token";
import {
  createEmptyAssistPlan,
  normalizeAssistPlan,
} from "../utils/weirdTowerSharePlan.js";

export const WEIRD_TOWER_ASSIST_PLAN_KEY = "weirdTowerAssistPlan";
export const WEIRD_TOWER_ASSIST_RUNTIME_KEY = "weirdTowerAssistRuntime";

/** 只保留最近几个周期的执行状态，避免 localStorage 无限增长 */
const RUNTIME_KEEP_CYCLES = 6;

/** 关系表（持久） */
export const weirdTowerAssistPlan = useLocalStorage(
  WEIRD_TOWER_ASSIST_PLAN_KEY,
  createEmptyAssistPlan(),
);

/** 本周期执行状态（持久，但按周期键隔离） */
export const weirdTowerAssistRuntime = useLocalStorage(
  WEIRD_TOWER_ASSIST_RUNTIME_KEY,
  {},
);

/** 取 token 的稳定身份键；缺 serverId/roleId 时返回 null（无法持久化） */
export function tokenKeyOfToken(token) {
  if (!token) return null;
  return getStableTokenKey(token.serverId, token.roleId);
}

/** 把 tokenId 列表映射成稳定键（顺带丢掉无法映射的） */
export function tokenKeysOfTokens(tokens = []) {
  const keys = [];
  for (const token of tokens) {
    const key = tokenKeyOfToken(token);
    if (key) keys.push(key);
  }
  return keys;
}

/** 用稳定键反查当前 token（tokenId 会变，键不会） */
export function findTokenByKey(tokens = [], key) {
  if (!key) return null;
  return (
    tokens.find((token) => tokenKeyOfToken(token) === key) || null
  );
}

/** 当前关系表（已规范化） */
export function readAssistPlan() {
  return normalizeAssistPlan(weirdTowerAssistPlan.value);
}

/** 写入关系表（写入前规范化） */
export function writeAssistPlan(nextPlan) {
  const normalized = normalizeAssistPlan(nextPlan);
  weirdTowerAssistPlan.value = normalized;
  return normalized;
}

const emptyCycleRuntime = () => ({
  usedInitiators: [],
  fullReceivers: [],
  shareCodes: {},
  updatedAt: null,
});

function pruneRuntime(runtime) {
  const keys = Object.keys(runtime);
  if (keys.length <= RUNTIME_KEEP_CYCLES) return runtime;
  const sorted = keys.sort((a, b) => {
    const aTime = runtime[a]?.updatedAt || "";
    const bTime = runtime[b]?.updatedAt || "";
    return aTime < bTime ? 1 : -1; // 新的在前
  });
  const kept = {};
  for (const key of sorted.slice(0, RUNTIME_KEEP_CYCLES)) kept[key] = runtime[key];
  return kept;
}

/** 取某个周期的执行状态（不存在则创建） */
export function readCycleRuntime(cycleKey) {
  if (!cycleKey) return emptyCycleRuntime();
  const runtime = weirdTowerAssistRuntime.value || {};
  const entry = runtime[cycleKey];
  if (!entry || typeof entry !== "object") return emptyCycleRuntime();
  return {
    ...emptyCycleRuntime(),
    ...entry,
    usedInitiators: Array.isArray(entry.usedInitiators) ? entry.usedInitiators : [],
    fullReceivers: Array.isArray(entry.fullReceivers) ? entry.fullReceivers : [],
    shareCodes:
      entry.shareCodes && typeof entry.shareCodes === "object" ? entry.shareCodes : {},
  };
}

/** 更新某个周期的执行状态 */
export function updateCycleRuntime(cycleKey, updater) {
  if (!cycleKey) return emptyCycleRuntime();
  const current = readCycleRuntime(cycleKey);
  const next = updater({ ...current }) || current;
  next.updatedAt = new Date().toISOString();
  const runtime = { ...(weirdTowerAssistRuntime.value || {}) };
  runtime[cycleKey] = next;
  weirdTowerAssistRuntime.value = pruneRuntime(runtime);
  return next;
}

/** 标记某角色本周期已用掉助力机会（收到 12200100 后） */
export function markInitiatorUsed(cycleKey, key) {
  if (!key) return;
  updateCycleRuntime(cycleKey, (entry) => {
    if (!entry.usedInitiators.includes(key)) entry.usedInitiators.push(key);
    return entry;
  });
}

/** 标记某接受角色本周期已被助力满（收到 12200090 后） */
export function markReceiverFull(cycleKey, key) {
  if (!key) return;
  updateCycleRuntime(cycleKey, (entry) => {
    if (!entry.fullReceivers.includes(key)) entry.fullReceivers.push(key);
    return entry;
  });
}

/** 缓存助力码（同周期内稳定不变，可复用） */
export function cacheShareCode(cycleKey, receiverKey, shareCode) {
  if (!cycleKey || !receiverKey || !shareCode) return;
  updateCycleRuntime(cycleKey, (entry) => {
    entry.shareCodes[receiverKey] = shareCode;
    return entry;
  });
}

export function getCachedShareCode(cycleKey, receiverKey) {
  if (!cycleKey || !receiverKey) return null;
  return readCycleRuntime(cycleKey).shareCodes[receiverKey] || null;
}

/** 清空某个周期的执行状态（本周期重新来过） */
export function clearCycleRuntime(cycleKey) {
  if (!cycleKey) return;
  const runtime = { ...(weirdTowerAssistRuntime.value || {}) };
  delete runtime[cycleKey];
  weirdTowerAssistRuntime.value = runtime;
}

export default {
  WEIRD_TOWER_ASSIST_PLAN_KEY,
  WEIRD_TOWER_ASSIST_RUNTIME_KEY,
  weirdTowerAssistPlan,
  weirdTowerAssistRuntime,
  tokenKeyOfToken,
  tokenKeysOfTokens,
  findTokenByKey,
  readAssistPlan,
  writeAssistPlan,
  readCycleRuntime,
  updateCycleRuntime,
  markInitiatorUsed,
  markReceiverFull,
  cacheShareCode,
  getCachedShareCode,
  clearCycleRuntime,
};
