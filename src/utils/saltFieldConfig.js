/**
 * 自动盐场 · 配置与派生
 *
 * 设计依据：docs/saltfield-auto-ui-design.md
 *   · 入口是「选角色」而不是「选俱乐部」——勾选的角色即队长
 *   · 俱乐部由队长角色的 legionId 反推，不手动增删（§1.6）
 *   · 队伍 ⇔ 队长 1:1
 *   · 配置态持久化到 localStorage；运行态（cId / sid / roleMap）一律不落盘（§4）
 */

export const KEYS = {
  leaders: "saltFieldAutoLeaderTokenIds",
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

/* ------------------------------ 队长清单 ------------------------------ */

export function getLeaderTokenIds() {
  const list = readJson(KEYS.leaders, []);
  return Array.isArray(list) ? list.map(String) : [];
}

export function setLeaderTokenIds(ids) {
  const uniq = [...new Set((ids || []).map(String))];
  return writeJson(KEYS.leaders, uniq);
}

export function addLeaderTokenIds(ids) {
  return setLeaderTokenIds([...getLeaderTokenIds(), ...(ids || [])]);
}

export function removeLeaderTokenId(id) {
  return setLeaderTokenIds(getLeaderTokenIds().filter((x) => x !== String(id)));
}

/* ------------------------------ 角色缓存 ------------------------------ */

export function getRoleCache() {
  const cache = readJson(KEYS.roleCache, {});
  return cache && typeof cache === "object" ? cache : {};
}

export function setRoleCacheEntry(tokenId, info) {
  const cache = getRoleCache();
  cache[String(tokenId)] = { ...(cache[String(tokenId)] || {}), ...info, updatedAt: Date.now() };
  return writeJson(KEYS.roleCache, cache);
}

export function clearRoleCache() {
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
  const list = readJson(KEYS.teams, []);
  return Array.isArray(list) ? list : [];
}

export function setTeams(teams) {
  return writeJson(KEYS.teams, Array.isArray(teams) ? teams : []);
}

export function makeTeamId(legionId, leaderTokenId) {
  return `${legionId}-${leaderTokenId}`;
}

/**
 * 依据「队长清单 + 角色缓存」重建队伍表：一队长一队。
 * 已不是队长的会被移除；新队长会补一条；已有队伍保留其队员与开关。
 * @returns {{teams: Array, added: Array, removed: Array}}
 */
export function reconcileTeams() {
  const leaders = getLeaderTokenIds();
  const cache = getRoleCache();
  const existing = getTeams();
  const byLeader = new Map(existing.map((t) => [String(t.leaderTokenId), t]));

  const teams = [];
  const added = [];
  // 先按当前队长清单顺序重建（保证顺序稳定 = 用户在 token 页勾选的顺序）
  for (const leaderTokenId of leaders) {
    const info = cache[leaderTokenId] || {};
    const legionId = info.legionId ?? null;
    const prev = byLeader.get(leaderTokenId);
    if (prev) {
      teams.push({ ...prev, legionId: legionId ?? prev.legionId ?? null });
    } else {
      const t = {
        id: makeTeamId(legionId ?? "unknown", leaderTokenId),
        legionId,
        leaderTokenId,
        name: info.roleName || "队伍",
        enabled: true,
        memberRoleIds: [],
        mobile: false,
      };
      teams.push(t);
      added.push(t);
    }
  }

  const leaderSet = new Set(leaders);
  const removed = existing.filter((t) => !leaderSet.has(String(t.leaderTokenId)));

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
    const legionId = team.legionId ?? cache[String(team.leaderTokenId)]?.legionId ?? null;
    const key = legionId === null || legionId === undefined ? "unknown" : String(legionId);
    if (!groups.has(key)) {
      groups.set(key, {
        legionId: key === "unknown" ? null : Number(key),
        legionName: cache[String(team.leaderTokenId)]?.legionName || (key === "unknown" ? "未同步" : `俱乐部 ${key}`),
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
  return { ...DEFAULT_SETTINGS, ...readJson(KEYS.settings, {}) };
}

export function setSettings(patch) {
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

  // 排序：① 离线优先 ② 势力降序
  available.sort((a, b) => {
    if (a.isOffline !== b.isOffline) return a.isOffline ? -1 : 1;
    return b.power - a.power;
  });

  return { all, available, unavailable, excluded: excludedList };
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
