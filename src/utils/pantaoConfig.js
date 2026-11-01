/**
 * 自动蟠桃 · 配置与派生
 *
 * 设计要点（master 2026-09-20 口述）：
 *   · 蟠桃**不能组队** → 一个角色一条连接，只能「一批一批轮询」
 *   · 同一 IP 有操作频次限流（冷却很短）→ 批间要有间隔，并发越大间隔越长
 *   · 粗放玩法：登场 → 向「抵达目的地最近」的船移动 → 上船即本轮完成 → 换下一个角色
 *     上船后敌人战力 < 我方 70% 才攻击，否则不动
 */

/**
 * 🔴 蟠桃会话专用首帧口径（2026-11-01 官方模拟器抓包 pantao_1101.pcap s01 主连接首帧实证）：
 *   platform=hortor / platformExt=mix / clientVersion=0.36.0-android
 *
 * 为什么必须切：`payload_setbattleteam`（参赛布阵）只认 App（mix）口径——
 * 2026-11-01 自动蟠桃 101 号实测：enterbf（查询）h5 放行、setbattleteam h5 会话
 * 全部 3000070 拒绝（服务端按会话创建时的首帧口径判定）。
 *
 * 🔴 仅蟠桃会话使用（tokenStore.setRoleInfoOverride 按号注入）：全局 registry 仍是
 *   h5/1.89.8-wx（金鱼 activity_claimtaskreward 双因素口径，**勿动**）。
 * 真串可能随 App 版本更新——每次比赛前用 tools/mumu_capture.cmd 重抓 role_getroleinfo 校验。
 */
export const PANTAO_PLATFORM_OVERRIDE = Object.freeze({
  platform: "hortor",
  platformExt: "mix",
  clientVersion: "0.36.0-android",
  inviteUid: 0,
  scene: "",
});

export const KEYS = {
  roles: "pantaoAutoRoleTokenIds",
  roleCache: "pantaoAutoRoleCache",
  settings: "pantaoAutoSettings",
  /** 俱乐部分组折叠状态（组名数组）——UI 偏好，刷新页面不丢 */
  collapsedClubs: "pantaoAutoCollapsedClubs",
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
  /**
   * 战场连接并发上限（下限兜底）。
   * 2026-11-01 起 runPantaoRoles 实际生效值 = max(此值, 每批并发 concurrency)——
   * 「每批并发」是唯一旋钮，同时驱动主连接槽位（PantaoAuto.vue maxActive）与战场闸门。
   */
  maxActiveBattlefield: 3,
  /**
   * 批次看门狗（ms）：单批次超过此时长未完成即按失败计并继续下一批。
   * 2026-10-11 事故兜底（fix C）——当日第一批卡死 33 分钟零输出。
   */
  batchWatchdogMs: 180000,
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

/* ------------------------------ 分组折叠状态 ------------------------------ */

export function getCollapsedClubs() {
  const list = readJson(KEYS.collapsedClubs, []);
  return Array.isArray(list) ? list.map(String) : [];
}

export function setCollapsedClubs(names) {
  return writeJson(KEYS.collapsedClubs, [...new Set(names || []).values()].map(String));
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
  getCollapsedClubs,
  setCollapsedClubs,
  getSettings,
  setSettings,
  resetSettings,
};
