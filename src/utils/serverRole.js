export const decodeServerRoleId = (serverId) => {
  let normalizedServerId = Number(serverId);
  let roleIndex = 0;

  if (normalizedServerId >= 2000000) {
    roleIndex = 2;
    normalizedServerId -= 2000000;
  } else if (normalizedServerId >= 1000000) {
    roleIndex = 1;
    normalizedServerId -= 1000000;
  }

  return {
    serverNumber: normalizedServerId - 27,
    roleIndex,
  };
};

export const formatImportedRoleName = (
  template,
  { name, roleId, serverId },
) => {
  const { serverNumber, roleIndex } = decodeServerRoleId(serverId);
  const roleName = name || `角色_${roleId}`;

  return (template || "{name}-{index}-{id}")
    .replace(/{name}/g, () => roleName)
    .replace(/{index}/g, () => String(roleIndex))
    .replace(/{id}/g, () => String(roleId))
    .replace(/{server}/g, () => `${serverNumber}服`);
};

/**
 * 取出「服务器号」输入里的数字。
 * 允许 "39" / "39服" / "39 区" 等写法；没有数字时返回 null。
 * 注意：显式判 null/undefined/空串，避免 Number(null) === 0 的陷阱。
 */
export const parseServerNumberInput = (input) => {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;

  const text = String(input).trim();
  if (!text) return null;

  const match = text.match(/\d+/);
  if (!match) return null;

  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
};

const isPresentValue = (value) =>
  value !== null && value !== undefined && String(value).trim() !== "";

/**
 * 取 token 所属「服号」：优先用 serverId 解码（口径同 decodeServerRoleId），
 * 没有 serverId 时退回解析 server 名称（如 "39服"）。
 */
export const getTokenServerNumber = (token) => {
  const rawServerId = token?.serverId ?? token?.server_id;
  if (isPresentValue(rawServerId)) {
    const numeric = Number(rawServerId);
    if (Number.isFinite(numeric) && numeric > 0) {
      return decodeServerRoleId(numeric).serverNumber;
    }
  }

  return parseServerNumberInput(token?.server);
};

/**
 * 把用户输入解析成一批候选服号。
 *
 * 规则：
 *  1. 按「子串」匹配服号 —— 输入 650 可以同时命中 6509 服、26501 服；
 *  2. 没人命中且输入是完整 serverId（如 1000066）时，解码成服号再做精确匹配。
 */
export const matchServerNumbersByInput = (input, tokens) => {
  const value = parseServerNumberInput(input);
  if (value === null) return [];

  const available = collectTokenServers(tokens).map(
    (group) => group.serverNumber,
  );
  if (available.length === 0) return [];

  const needle = String(value);
  const substringMatches = available.filter((serverNumber) =>
    String(serverNumber).includes(needle),
  );
  if (substringMatches.length > 0) return substringMatches;

  if (value >= 1_000_000) {
    const decoded = decodeServerRoleId(value).serverNumber;
    if (available.includes(decoded)) return [decoded];
  }

  return [];
};

/** 过滤出属于给定服号（可传单个或数组）的角色 */
export const filterTokensByServerNumbers = (tokens, serverNumbers) => {
  const targets = new Set(
    (Array.isArray(serverNumbers) ? serverNumbers : [serverNumbers])
      .map((value) =>
        typeof value === "number" ? value : parseServerNumberInput(value),
      )
      .filter((value) => Number.isFinite(value)),
  );
  if (targets.size === 0) return [];

  return (tokens || []).filter((token) =>
    targets.has(getTokenServerNumber(token)),
  );
};

/** 按服号聚拢角色，返回按服号升序排列的分组列表 */
export const collectTokenServers = (tokens) => {
  const buckets = new Map();

  for (const token of tokens || []) {
    const serverNumber = getTokenServerNumber(token);
    if (serverNumber === null) continue;
    if (!buckets.has(serverNumber)) buckets.set(serverNumber, []);
    buckets.get(serverNumber).push(token);
  }

  return [...buckets.entries()]
    .map(([serverNumber, list]) => ({ serverNumber, tokens: list }))
    .sort((left, right) => left.serverNumber - right.serverNumber);
};
