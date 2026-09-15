/**
 * 批量运行时（多开页面）同步模型 —— 纯计算逻辑，便于单测。
 *
 * 三种模式：
 *   1) 不同步（默认）：任何窗口都不参与同步。
 *   2) 分组同步：以 Token 管理里的分组为单位，**每组只有组长能作为同步源**，
 *      组长的输入转发给本组其他窗口；组与组之间互不影响。
 *   3) 全局同步：所有窗口视为一个大组，同步源 = 第一个分组的组长
 *      （没有任何分组时不生效），其余窗口只接收、不发送。
 *
 * **分组只有 Token 管理一个来源**：批量运行时页面直接引用 Token 管理里的分组，
 * 只显示「本次已打开窗口所在」的分组；页面自己不会造固定槽位，也不会在没分组时兜底。
 *
 * 组长默认 = 该组窗口顺序第一个；可以在批量运行时页面手动指定，
 * 指定的组长必须仍在该组内，否则回退为默认值。
 *
 * 分组顺序由页面上拖动分组标签决定，它同时决定「第一个分组」——也就是全局同步源。
 */

export const SYNC_MODE_NONE = "none";
export const SYNC_MODE_GROUP = "group";
export const SYNC_MODE_GLOBAL = "global";

export const SYNC_MODE_OPTIONS = [
  { value: SYNC_MODE_NONE, label: "不同步", hint: "各窗口互不影响（默认）" },
  {
    value: SYNC_MODE_GROUP,
    label: "分组同步",
    hint: "每个分组内只有组长能驱动本组其他窗口",
  },
  {
    value: SYNC_MODE_GLOBAL,
    label: "全局同步",
    hint: "所有窗口跟随第一个分组的组长",
  },
];

export function normalizeSyncMode(value) {
  return value === SYNC_MODE_GROUP || value === SYNC_MODE_GLOBAL
    ? value
    : SYNC_MODE_NONE;
}

/** 组内成员按窗口顺序排列后的第一个；手动指定优先，但必须仍在本组内。 */
export function resolveGroupMaster(scopeIds, requestedScopeId) {
  if (!Array.isArray(scopeIds) || scopeIds.length === 0) return null;
  if (
    typeof requestedScopeId === "string" &&
    scopeIds.includes(requestedScopeId)
  ) {
    return requestedScopeId;
  }
  return scopeIds[0];
}

/** 按保存的顺序重排分组；没记录过顺序的分组按原相对顺序追加在后面。 */
export function orderSyncGroups(groups, order) {
  const list = Array.isArray(groups) ? groups.filter(Boolean) : [];
  const rank = new Map();
  (Array.isArray(order) ? order : []).forEach((id, index) => {
    const key = String(id);
    if (!rank.has(key)) rank.set(key, index);
  });
  const unranked = list.length;
  return [...list].sort((left, right) => {
    const leftRank = rank.has(String(left.id)) ? rank.get(String(left.id)) : unranked;
    const rightRank = rank.has(String(right.id))
      ? rank.get(String(right.id))
      : unranked;
    return leftRank - rightRank;
  });
}

/**
 * 计算每个窗口在同步里扮演的角色。
 *
 * @param {object} input
 * @param {string} input.mode 同步模式
 * @param {Array<{scopeId: string}>} input.frames 窗口（按页面顺序）
 * @param {Array<{id: string, scopeIds: string[]}>} input.groups 已完成排序的分组
 * @param {Record<string, string>} [input.masters] 分组 id → 指定组长 scopeId
 * @returns {{
 *   mode: string,
 *   groups: Array<object>,
 *   roles: Record<string, {send: boolean, receive: boolean}>,
 *   sources: Array<{groupId: string|null, scopeId: string}>,
 *   sourceScopeId: string|null,
 *   targets: Record<string, string[]>,
 *   active: boolean,
 * }}
 */
export function planMultiGameSync({ mode, frames, groups, masters } = {}) {
  const normalizedMode = normalizeSyncMode(mode);
  const frameList = (Array.isArray(frames) ? frames : []).filter(
    (frame) => frame && frame.scopeId,
  );
  const frameIds = frameList.map((frame) => frame.scopeId);

  const roles = {};
  for (const scopeId of frameIds) roles[scopeId] = { send: false, receive: false };

  const groupList = (Array.isArray(groups) ? groups : [])
    .filter((group) => group && group.id != null)
    .map((group) => {
      // 只保留当前仍然存在的窗口，避免关窗后残留死引用
      const scopeIds = (Array.isArray(group.scopeIds) ? group.scopeIds : []).filter(
        (scopeId) => roles[scopeId],
      );
      return {
        ...group,
        scopeIds,
        masterScopeId: resolveGroupMaster(scopeIds, masters?.[group.id]),
      };
    })
    .filter((group) => group.scopeIds.length > 0);

  const plan = {
    mode: normalizedMode,
    groups: groupList,
    roles,
    sources: [],
    sourceScopeId: null,
    targets: {},
    active: false,
  };

  if (normalizedMode === SYNC_MODE_NONE || frameIds.length === 0) return plan;

  const markSend = (scopeId, groupId) => {
    roles[scopeId].send = true;
    plan.sources.push({ groupId, scopeId });
  };

  const linkTargets = (sourceScopeId, candidateIds) => {
    const next = new Set(plan.targets[sourceScopeId] || []);
    for (const scopeId of candidateIds) {
      if (scopeId && scopeId !== sourceScopeId) next.add(scopeId);
    }
    plan.targets[sourceScopeId] = [...next];
    for (const scopeId of next) roles[scopeId].receive = true;
  };

  if (normalizedMode === SYNC_MODE_GROUP) {
    for (const group of groupList) {
      // 单人分组没有同步对象，直接跳过
      if (group.scopeIds.length < 2 || !group.masterScopeId) continue;
      markSend(group.masterScopeId, group.id);
      linkTargets(group.masterScopeId, group.scopeIds);
    }
  } else {
    // 全局同步：所有窗口一起跟随第一个分组的组长。
    // 同步源**只能**来自 Token 管理里的分组，页面自己不会造组兜底。
    const sourceGroup = groupList[0] || null;
    const sourceScopeId = sourceGroup ? sourceGroup.masterScopeId : null;
    if (sourceScopeId) {
      markSend(sourceScopeId, sourceGroup.id);
      linkTargets(sourceScopeId, frameIds);
      plan.sourceScopeId = sourceScopeId;
    }
  }

  plan.active = Object.values(roles).some(
    (role) => role.send || role.receive,
  );
  return plan;
}

/** 顶层窗口的同步角色标签（用于窗口卡片上的角标）。 */
export function describeSyncRole(role) {
  if (!role) return null;
  if (role.send && role.receive) return { label: "组长 + 跟随", tone: "both" };
  if (role.send) return { label: "同步源", tone: "source" };
  if (role.receive) return { label: "跟随", tone: "target" };
  return null;
}
