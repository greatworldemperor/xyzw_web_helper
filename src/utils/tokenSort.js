function toNumericValue(value) {
  const match = String(value ?? "")
    .trim()
    .match(/-?\d+(?:\.\d+)?/);

  if (!match) return null;

  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

export function getTokenServerSortValue(token) {
  const serverId = toNumericValue(token?.serverId ?? token?.server_id);
  if (serverId !== null) {
    if (serverId >= 2_000_000) return serverId - 2_000_000;
    if (serverId >= 1_000_000) return serverId - 1_000_000;
    return serverId;
  }

  return toNumericValue(token?.server);
}

export function getTokenRoleSortValue(token) {
  const roleId = toNumericValue(
    token?.roleId ?? token?.role_id ?? token?.role?.roleId,
  );
  if (roleId !== null) return roleId;

  const nameNumbers = String(token?.name ?? "").match(/\d{6,12}/g);
  if (!nameNumbers || nameNumbers.length === 0) return null;

  return toNumericValue(nameNumbers[nameNumbers.length - 1]);
}

function compareNumericValues(left, right, direction) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  if (left === right) return 0;

  const result = left < right ? -1 : 1;
  return direction === "desc" ? -result : result;
}

function compareTextValues(left, right, direction) {
  const result = String(left ?? "").localeCompare(String(right ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });

  return direction === "desc" ? -result : result;
}

export function compareTokensByServerAndRole(
  tokenA,
  tokenB,
  direction = "asc",
) {
  const serverComparison = compareNumericValues(
    getTokenServerSortValue(tokenA),
    getTokenServerSortValue(tokenB),
    direction,
  );
  if (serverComparison !== 0) return serverComparison;

  const roleComparison = compareNumericValues(
    getTokenRoleSortValue(tokenA),
    getTokenRoleSortValue(tokenB),
    direction,
  );
  if (roleComparison !== 0) return roleComparison;

  const nameComparison = compareTextValues(tokenA?.name, tokenB?.name, direction);
  if (nameComparison !== 0) return nameComparison;

  return compareTextValues(tokenA?.id, tokenB?.id, direction);
}