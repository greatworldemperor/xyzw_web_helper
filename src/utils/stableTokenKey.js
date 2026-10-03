/**
 * 稳定身份键（serverId:roleId）
 *
 * 项目里所有需要「跨 token 重导稳定」的持久化身份都用它：
 * token id 是 bin 内容的 MD5，token 一刷新/重导就变；稳定键不会。
 *
 * 独立成零依赖模块的原因：token.ts 带着 axios / crypto-js 等重依赖，
 * node 环境（测试 / bin-test）import 它会因 CJS 命名导出探测失败而崩，
 * 而身份键本身应该是任何环境都能用的最底层基建（2026-10-03）。
 */

export const getStableTokenKey = (
  serverId, // string | number | null | undefined
  roleId, // string | number | null | undefined
) => {
  const normalizedServerId = String(serverId ?? "").trim();
  const normalizedRoleId = String(roleId ?? "").trim();

  if (!normalizedServerId || !normalizedRoleId) return null;

  return `${normalizedServerId}:${normalizedRoleId}`;
};

export default getStableTokenKey;
