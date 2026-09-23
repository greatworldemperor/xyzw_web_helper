/**
 * 批量运行时（多开页面）同步模型 —— 纯计算逻辑，便于单测。
 *
 * 三种模式：
 *   1) 不同步（默认）：任何窗口都不参与同步。
 *   2) 分组同步：以 Token 管理里的分组为单位，**每组只有组长能作为同步源**，
 *      组长的输入转发给本组其他窗口；组与组之间互不影响。
 *   3) 全局同步：所有窗口视为一个大组，其余窗口只接收、不发送。
 *      同步源优先取**手动指定的窗口**（页面上点窗口标题），没有手动指定时
 *      才回退到「第一个分组的组长」。
 *
 * **分组只有 Token 管理一个来源**：批量运行时页面直接引用 Token 管理里的分组，
 * 只显示「本次已打开窗口所在」的分组；页面自己不会造固定槽位。
 * 唯一的例外是全局同步的手动同步源：它按窗口指定、不依赖分组，
 * 这样临时拼起来的一批窗口没分过组也能同步。
 *
 * 组长默认 = 该组窗口顺序第一个；可以在批量运行时页面手动指定，
 * 指定的组长必须仍在该组内，否则回退为默认值。
 *
 * 分组顺序由页面上拖动分组标签决定，它同时决定「第一个分组」——也就是全局同步的默认源。
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
    hint: "所有窗口跟随同步源（点窗口标题指定，默认是第一个分组的组长）",
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

/**
 * 全局同步源解析。
 *
 * 手动指定的窗口（点窗口标题选出来的那个）优先，但它必须仍在本次打开的窗口里，
 * 关窗后自动作废；没有手动指定时回退到「第一个分组的组长」。
 * 两者都没有就返回 null —— 分组只来自 Token 管理，页面不造源兜底。
 */
export function resolveGlobalSource(scopeIds, groups, requestedScopeId) {
  const frameIds = Array.isArray(scopeIds) ? scopeIds : [];
  if (
    typeof requestedScopeId === "string" &&
    requestedScopeId &&
    frameIds.includes(requestedScopeId)
  ) {
    return requestedScopeId;
  }
  const sourceGroup = (Array.isArray(groups) ? groups : [])[0] || null;
  const fallback = sourceGroup?.masterScopeId ?? null;
  // 组长本身也必须还在已打开窗口里（组里只剩关掉的窗口时等于没有源）
  return fallback && frameIds.includes(fallback) ? fallback : null;
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
 * @param {string} [input.globalSourceScopeId] 全局同步下手动指定的同步源窗口
 * @returns {{
 *   mode: string,
 *   groups: Array<object>,
 *   roles: Record<string, {send: boolean, receive: boolean}>,
 *   sources: Array<{groupId: string|null, scopeId: string}>,
 *   sourceScopeId: string|null,
 *   globalSourceManual: boolean,
 *   globalSourceGroupId: string|null,
 *   targets: Record<string, string[]>,
 *   active: boolean,
 * }}
 */
export function planMultiGameSync({
  mode,
  frames,
  groups,
  masters,
  globalSourceScopeId,
} = {}) {
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
    globalSourceManual: false,
    globalSourceGroupId: null,
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
    // 全局同步：所有窗口一起跟随同一个同步源。
    // 同步源优先取手动指定的窗口（点窗口标题），否则回退到第一个分组的组长。
    const sourceScopeId = resolveGlobalSource(
      frameIds,
      groupList,
      globalSourceScopeId,
    );
    // 有源时记下它所在的分组（手动源不在任何分组里时为 null）；
    // 没源时把第一个分组当作候选，UI 用它提示「谁是默认源」。
    const sourceGroup = sourceScopeId
      ? (groupList.find((group) => group.scopeIds.includes(sourceScopeId)) ?? null)
      : (groupList[0] ?? null);
    plan.globalSourceManual =
      Boolean(sourceScopeId) && globalSourceScopeId === sourceScopeId;
    plan.globalSourceGroupId = sourceGroup?.id ?? null;
    if (sourceScopeId) {
      markSend(sourceScopeId, sourceGroup?.id ?? null);
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
