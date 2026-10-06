/**
 * 自动盐场 · 配置与派生
 *
 * 设计依据：docs/saltfield-auto-ui-design.md
 *   · 入口是「选角色」而不是「选俱乐部」——勾选的角色即队长
 *   · 俱乐部由队长角色的 legionId 反推，不手动增删（§1.6）
 *   · 队伍 ⇔ 队长 1:1
 *   · 配置态持久化到 localStorage；运行态（cId / sid / roleMap）一律不落盘（§4）
 *
 * 🔴 身份键（2026-10-03 定稿，master 拍板）：一律用稳定键 `serverId:roleId`
 *   （getStableTokenKey），**不用 token id** —— token id 是 bin 内容的 MD5，
 *   token 一刷新/重导就变，旧记录全部悬空（本次 30 支队伍 "Token not found" 事故根因）。
 *   运行时按稳定键反查当前 gameTokens 里的 token id 再建连；角色暂时没导入也没关系，
 *   导入回来即自动接上。旧版（token id 主键）数据在模块首次使用时自动迁移。
 */

import { getStableTokenKey } from "@/utils/stableTokenKey";

export const KEYS = {
  /** 队长清单：稳定键（serverId:roleId）数组 */
  leaders: "saltFieldAutoLeaderKeys",
  /** 旧版队长清单（token id 数组）：仅迁移用，迁完即删 */
  legacyLeaders: "saltFieldAutoLeaderTokenIds",
  /** 角色缓存：key = 稳定键 */
  roleCache: "saltFieldAutoRoleCache",
  clubs: "saltFieldAutoClubs",
  teams: "saltFieldAutoTeams",
  settings: "saltFieldAutoSettings",
};

export const DEFAULT_SETTINGS = {
  inviteIntervalMs: 1200, // 逐个邀请的间隔（抓包中最短业务命令间隔约 1s）
  teamCdWaitMs: 10000, // constant.TeamCd
  enterTimeoutMs: 15000,
  maxActiveBattlefield: 3, // 战场连接并发上限（与批量 maxActive 分开）
  waitPollMs: 12000, // 等待模式：轮询战场快照的间隔
  deployWindowMs: 30000, // 登场确认放弃上限（1s 重试节奏；遇限流可调大到 90000）
  saltfieldRetryRounds: 3, // 失败队伍补跑轮数上限（1s 节奏；hard/stopped 分类不补跑）
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
    console.warn(`[盐场] 写入 ${key} 失败`, e?.message || e);
    return false;
  }
}

/* ------------------------------ 旧数据迁移 ------------------------------ */

/**
 * 旧版（token id 主键）→ 稳定键主键的一次性迁移。
 * 映射来源 = 旧 roleCache 条目里的 roleId/serverId（同步成功时都会写入）；
 * 缺这两个字段的旧记录无法识别，只能丢弃（这些队长本来也连不上）。
 * 惰性执行：所有公共读写入口先调 ensureMigrated()，测试环境可先 mock localStorage。
 */
let migrated = false;

function ensureMigrated() {
  if (migrated) return;
  migrated = true;
  try {
    const legacyRaw = localStorage.getItem(KEYS.legacyLeaders);
    if (legacyRaw === null) return; // 从未用过旧版，无需迁移
    if (localStorage.getItem(KEYS.leaders) !== null) {
      // 已迁移过（新键存在）：清掉旧键即可
      localStorage.removeItem(KEYS.legacyLeaders);
      return;
    }

    const legacyLeaders = JSON.parse(legacyRaw);
    const legacyCache = readJson(KEYS.roleCache, {});

    // 旧 token id → 稳定键；roleCache 直接按稳定键重建
    const oldIdToKey = new Map();
    const newCache = {};
    for (const [oldId, info] of Object.entries(legacyCache || {})) {
      const key = getStableTokenKey(info?.serverId, info?.roleId);
      if (key) {
        oldIdToKey.set(String(oldId), key);
        newCache[key] = info;
      }
    }

    const newLeaders = [];
    let droppedLeaders = 0;
    for (const oldId of Array.isArray(legacyLeaders) ? legacyLeaders : []) {
      const key = oldIdToKey.get(String(oldId));
      if (key) newLeaders.push(key);
      else droppedLeaders++;
    }

    // 队伍表：leaderTokenId → leaderKey，保留全部业务字段
    const legacyTeams = readJson(KEYS.teams, []);
    const newTeams = [];
    let droppedTeams = 0;
    for (const t of Array.isArray(legacyTeams) ? legacyTeams : []) {
      const key = oldIdToKey.get(String(t?.leaderTokenId));
      if (!key) {
        droppedTeams++;
        continue;
      }
      const { leaderTokenId: _ignored, ...rest } = t || {};
      newTeams.push({ ...rest, leaderKey: key, id: makeTeamId(rest.legionId ?? "unknown", key) });
    }

    writeJson(KEYS.leaders, [...new Set(newLeaders)]);
    writeJson(KEYS.roleCache, newCache);
    writeJson(KEYS.teams, newTeams);
    localStorage.removeItem(KEYS.legacyLeaders);

    const parts = [`队长 ${newLeaders.length} 个`];
    if (droppedLeaders) parts.push(`无法识别的旧队长 ${droppedLeaders} 个（已丢弃）`);
    if (droppedTeams) parts.push(`无法识别的旧队伍 ${droppedTeams} 支（已丢弃）`);
    console.info(`[盐场] 队长记录已迁移到稳定键 serverId:roleId：${parts.join("，")}`);
  } catch (e) {
    console.warn("[盐场] 旧队长数据迁移失败（继续用现有数据）", e);
  }
}

/* ------------------------------ 队长清单 ------------------------------ */

/** 队长清单：稳定键（serverId:roleId）数组 */
export function getLeaderKeys() {
  ensureMigrated();
  const list = readJson(KEYS.leaders, []);
  return Array.isArray(list) ? list.map(String) : [];
}

export function setLeaderKeys(keys) {
  ensureMigrated();
  const uniq = [...new Set((keys || []).map(String))];
  return writeJson(KEYS.leaders, uniq);
}

export function addLeaderKeys(keys) {
  return setLeaderKeys([...getLeaderKeys(), ...(keys || [])]);
}

export function removeLeaderKey(key) {
  return setLeaderKeys(getLeaderKeys().filter((x) => x !== String(key)));
}

/* ------------------------------ 角色缓存 ------------------------------ */

export function getRoleCache() {
  ensureMigrated();
  const cache = readJson(KEYS.roleCache, {});
  return cache && typeof cache === "object" ? cache : {};
}

/** key = 稳定键 serverId:roleId */
export function setRoleCacheEntry(key, info) {
  ensureMigrated();
  const cache = getRoleCache();
  cache[String(key)] = { ...(cache[String(key)] || {}), ...info, updatedAt: Date.now() };
  return writeJson(KEYS.roleCache, cache);
}

export function clearRoleCache() {
  ensureMigrated();
  return writeJson(KEYS.roleCache, {});
}

/* ------------------------------ 俱乐部开关 ------------------------------ */

export function getClubSettings() {
  const s = readJson(KEYS.clubs, {});
  return s && typeof s === "object" ? s : {};
}

export function setClubEnabled(legionId, enabled) {
  const s = getClubSettings();
  s[String(legionId)] = { ...(s[String(legionId)] || {}), enabled: !!enabled };
  return writeJson(KEYS.clubs, s);
}

/* ------------------------------ 队伍 ------------------------------ */

export function getTeams() {
  ensureMigrated();
  const list = readJson(KEYS.teams, []);
  return Array.isArray(list) ? list : [];
}

export function setTeams(teams) {
  ensureMigrated();
  return writeJson(KEYS.teams, Array.isArray(teams) ? teams : []);
}

/** 队伍 id = `<legionId>-<leaderKey>`（leaderKey = 稳定键，跨 token 重导稳定） */
export function makeTeamId(legionId, leaderKey) {
  return `${legionId}-${leaderKey}`;
}

/**
 * 依据「队长清单 + 角色缓存」重建队伍表：一队长一队。
 * 已不是队长的会被移除；新队长会补一条；已有队伍保留其队员与开关。
 * @returns {{teams: Array, added: Array, removed: Array}}
 */
export function reconcileTeams() {
  ensureMigrated();
  const leaders = getLeaderKeys();
  const cache = getRoleCache();
  const existing = getTeams();
  const byLeader = new Map(existing.map((t) => [String(t.leaderKey), t]));

  const teams = [];
  const added = [];
  // 先按当前队长清单顺序重建（保证顺序稳定 = 用户在 token 页勾选的顺序）
  for (const leaderKey of leaders) {
    const info = cache[leaderKey] || {};
    const legionId = info.legionId ?? null;
    const prev = byLeader.get(leaderKey);
    if (prev) {
      teams.push({ ...prev, legionId: legionId ?? prev.legionId ?? null });
    } else {
      const t = {
        id: makeTeamId(legionId ?? "unknown", leaderKey),
        legionId,
        leaderKey,
        name: info.roleName || "队伍",
        enabled: true,
        memberRoleIds: [],
        mobile: false,
        mode: "immediate", // immediate=立即执行 | wait=等待模式（等齐指定队员再登场）
      };
      teams.push(t);
      added.push(t);
    }
  }

  const leaderSet = new Set(leaders);
  const removed = existing.filter((t) => !leaderSet.has(String(t.leaderKey)));

  setTeams(teams);
  return { teams, added, removed };
}

/** 俱乐部开关：未显式设置过的一律视为启用 */
export function isClubEnabled(legionId) {
  const s = getClubSettings()[String(legionId)];
  return s?.enabled !== false;
}

/**
 * 按 legionId 把队伍归组，得到「俱乐部 → 队伍」三层结构中的上层。
 * 俱乐部分组顺序 = 首次出现的顺序（与队伍表顺序一致，避免每次渲染抖动）。
 */
export function groupTeamsByLegion(teams = getTeams(), cache = getRoleCache()) {
  const groups = new Map();
  for (const team of teams) {
    const leaderKey = String(team.leaderKey || "");
    const legionId = team.legionId ?? cache[leaderKey]?.legionId ?? null;
    const key = legionId === null || legionId === undefined ? "unknown" : String(legionId);
    if (!groups.has(key)) {
      groups.set(key, {
        legionId: key === "unknown" ? null : Number(key),
        legionName: cache[leaderKey]?.legionName || (key === "unknown" ? "未同步" : `俱乐部 ${key}`),
        teams: [],
      });
    }
    groups.get(key).teams.push(team);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    enabled: g.legionId === null ? true : isClubEnabled(g.legionId),
  }));
}

/* ------------------------------ 设置 ------------------------------ */

export function getSettings() {
  ensureMigrated();
  return { ...DEFAULT_SETTINGS, ...readJson(KEYS.settings, {}) };
}

export function setSettings(patch) {
  ensureMigrated();
  return writeJson(KEYS.settings, { ...getSettings(), ...(patch || {}) });
}

/* ------------------------------ 候选池与排序 ------------------------------ */

/**
 * 是否离线。
 * 抓包实测语义：`online === 0` ⇒ 当前在线；`online !== 0` ⇒ 已离线，值为最近在线时间。
 * 校验方式：21 人里「online != 0 却战场在线」的反例 0 个（见设计稿 §3.2）。
 * 字段缺失时按"未知"处理，归入在线侧。
 */
export function isOfflineByFlag(online) {
  return typeof online === "number" && online !== 0;
}

/**
 * 构造某个俱乐部的候选池。
 *
 * 返回值把「可选取」与「要展示但不可选」分开，避免把排除项泄漏进机动补齐：
 *   · all        全部成员（含不可用与已排除），供 UI 渲染带标签的完整列表
 *   · available  可选取的人（有 cId 且未被排除），已按规则排序 —— 机动补齐只用这个
 *   · unavailable 不在本场 roleMap（跨俱乐部 / 本场未参战）
 *   · excluded   有 cId 但被排除（队长自己 / 已指定队员 / 同俱乐部其他队已占用）
 *
 * @param {object} params
 * @param {Array}  params.roster          legion_getinfo 的 info.members 转成的数组
 *                                        [{roleId, name, power, online}]
 * @param {object} params.roleMap         本连接所属俱乐部的 roleId -> {cId}
 * @param {Array}  params.excludeRoleIds  需要排除的 roleId
 */
export function buildCandidatePool({ roster = [], roleMap = {}, excludeRoleIds = [] } = {}) {
  const excluded = new Set(excludeRoleIds.map((x) => String(x)));
  const rm = roleMap || {};

  const all = [];
  const available = [];
  const unavailable = [];
  const excludedList = [];

  for (const m of roster) {
    const roleId = String(m.roleId ?? m.rId ?? "");
    if (!roleId) continue;
    const entry = rm[roleId];
    const rec = {
      roleId: Number(roleId),
      name: m.name || "",
      power: Number(m.power || 0),
      online: m.online,
      isOffline: isOfflineByFlag(m.online),
      cId: entry ? Number(entry.cId) : null,
      excluded: excluded.has(roleId),
    };
    all.push(rec);

    if (rec.cId === null) {
      rec.unavailable = true;
      unavailable.push(rec);
      continue;
    }
    if (rec.excluded) {
      excludedList.push(rec);
      continue;
    }
    available.push(rec);
  }

  // 排序：① 离线优先 ② 势力降序（两个候选池构造共用，避免规则漂移）
  available.sort((a, b) => {
    if (a.isOffline !== b.isOffline) return a.isOffline ? -1 : 1;
    return b.power - a.power;
  });

  return { all, available, unavailable, excluded: excludedList };
}

/**
 * 名册版候选池（master 2026-09-16：提前编队不能依赖战场 —— 开战前进不了战场）。
 *
 * 与 buildCandidatePool 的区别：数据只来自 legion_getinfo 名册（主连接，随时可拉），
 * 没有 roleMap ⇒ 没有 cId，**全员视为可选取**（同俱乐部成员开战后按名册全量分配
 * cId，这是抓包证实的机制，所以提前按名册选人是安全的）。
 * 用途：编辑弹窗加载成员、开战前的机动补齐。执行时仍按 roleMap 换算 cId。
 */
export function buildRosterCandidatePool({ roster = [], excludeRoleIds = [] } = {}) {
  const excluded = new Set(excludeRoleIds.map((x) => String(x)));

  const all = [];
  const available = [];
  const excludedList = [];

  for (const m of roster) {
    const roleId = String(m.roleId ?? m.rId ?? "");
    if (!roleId) continue;
    const rec = {
      roleId: Number(roleId),
      name: m.name || "",
      power: Number(m.power || 0),
      online: m.online,
      isOffline: isOfflineByFlag(m.online),
      cId: null, // 开战前没有战场快照；执行时用 roleMap[roleId].cId 现算
      excluded: excluded.has(roleId),
    };
    all.push(rec);
    if (rec.excluded) {
      excludedList.push(rec);
      continue;
    }
    available.push(rec);
  }

  available.sort((a, b) => {
    if (a.isOffline !== b.isOffline) return a.isOffline ? -1 : 1;
    return b.power - a.power;
  });

  return { all, available, unavailable: [], excluded: excludedList };
}

/**
 * 为一支队伍计算「机动补齐」的人选。
 * 只在本俱乐部候选池内取，且全局（本俱乐部内）去重。
 */
export function pickMobileFill({ candidatePoolAvailable = [], team, occupiedRoleIds = [] } = {}) {
  const maxTeamSize = 5;
  const current = new Set([team?.leaderRoleId, ...(team?.memberRoleIds || [])].filter(Boolean).map(Number));
  const need = Math.max(0, maxTeamSize - current.size);
  if (need === 0) return [];

  const occupied = new Set(occupiedRoleIds.map(Number));
  const picked = [];
  for (const c of candidatePoolAvailable) {
    if (picked.length >= need) break;
    if (current.has(c.roleId)) continue;
    if (occupied.has(c.roleId)) continue;
    picked.push(c);
    occupied.add(c.roleId);
  }
  return picked;
}
