/**
 * 自动蟠桃 · 配置与派生
 *
 * 设计要点（master 2026-09-20 口述）：
 *   · 蟠桃**不能组队** → 一个角色一条连接，只能「一批一批轮询」
 *   · 同一 IP 有操作频次限流（冷却很短）→ 批间要有间隔，并发越大间隔越长
 *   · 粗放玩法：登场 → 向「抵达目的地最近」的船移动 → 上船即本轮完成 → 换下一个角色
 *     上船后敌人战力 < 我方 70% 才攻击，否则不动
 */

export const KEYS = {
  roles: "pantaoAutoRoleTokenIds",
  roleCache: "pantaoAutoRoleCache",
  settings: "pantaoAutoSettings",
};

export const DEFAULT_SETTINGS = {
  /** 每批并发数（同时在线的角色数） */
  concurrency: 3,
  /** 批间最小间隔（ms）——规避同 IP 频次限流 */
  minIntervalMs: 1200,
  /** 攻击阈值：敌人战力 < 我方 × ratio 才打 */
  attackRatio: 0.7,
  /** 选船策略：nearest-arrival（默认，抵达最近）/ nearest-me / contested */
  strategy: "nearest-arrival",
  /** 单个角色一轮最多占用多久（ms），超时就换下一个 */
  turnTimeoutMs: 90000,
  /** 一轮结束后到下一轮开始的间隔（ms） */
  roundIntervalMs: 30000,
  /** 主连接（legion_getpayloadbf）超时 */
  probeTimeoutMs: 10000,
  /** 战场连接超时 */
  enterTimeoutMs: 15000,
  /** 战场连接并发上限 */
  maxActiveBattlefield: 3,
  /** 行军每格耗时（ms）——实测 2000 */
  msPerMarchStep: 2000,
  /** 是否只探测不行动（dry run） */
  dryRun: false,
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn(`[蟠桃] 写入 ${key} 失败`, e?.message || e);
    return false;
  }
}

/* ------------------------------ 参与角色 ------------------------------ */

export function getRoleTokenIds() {
  const list = readJson(KEYS.roles, []);
  return Array.isArray(list) ? list.map(String) : [];
}

export function setRoleTokenIds(ids) {
  return writeJson(KEYS.roles, [...new Set((ids || []).map(String))]);
}

export function addRoleTokenIds(ids) {
  return setRoleTokenIds([...getRoleTokenIds(), ...(ids || [])]);
}

export function removeRoleTokenId(id) {
  return setRoleTokenIds(getRoleTokenIds().filter((x) => x !== String(id)));
}

/* ------------------------------ 角色缓存 ------------------------------ */

export function getRoleCache() {
  const obj = readJson(KEYS.roleCache, {});
  return obj && typeof obj === "object" ? obj : {};
}

export function setRoleCacheEntry(tokenId, entry) {
  const cache = getRoleCache();
  cache[String(tokenId)] = { ...(cache[String(tokenId)] || {}), ...entry, updatedAt: Date.now() };
  return writeJson(KEYS.roleCache, cache);
}

/* ------------------------------ 设置 ------------------------------ */

export function getSettings() {
  const s = readJson(KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...(s && typeof s === "object" ? s : {}) };
}

export function setSettings(patch = {}) {
  return writeJson(KEYS.settings, { ...getSettings(), ...patch });
}

export function resetSettings() {
  return writeJson(KEYS.settings, { ...DEFAULT_SETTINGS });
}

export default {
  KEYS,
  DEFAULT_SETTINGS,
  getRoleTokenIds,
  setRoleTokenIds,
  addRoleTokenIds,
  removeRoleTokenId,
  getRoleCache,
  setRoleCacheEntry,
  getSettings,
  setSettings,
  resetSettings,
};
