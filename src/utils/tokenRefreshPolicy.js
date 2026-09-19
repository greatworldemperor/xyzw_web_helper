/**
 * Token 按需刷新策略（纯逻辑，便于单测）
 *
 * 背景：role token 生命周期很短，导入时逐个预取再持久化基本没有意义
 * （下次真正要用的时候大概率已经过期，还得重新刷）。
 *
 * 因此：
 *   · 导入时只落库长寿命来源（BIN 存 IndexedDB / URL 存 sourceUrl），role token 字段留空；
 *   · 真正要建立连接时，如果 token 为空 / 无效 / 过期，再按需换一份新的。
 */

/** 可重复换取 role token 的导入方式（BIN 系：数据在 IndexedDB，key = token.id） */
export const BIN_BACKED_IMPORT_METHODS = ["bin", "wxQrcode", "mobile", "import"];

/** token 字符串本身是否可用（与 tokenStore.validateToken 判定一致） */
export const isUsableTokenString = (token) =>
  typeof token === "string" && token.trim().length >= 10;

/** 该 token 是否由 BIN 派生（可用 IndexedDB 里的 BIN 重新换取） */
export const isBinBackedToken = (token) =>
  !!token && BIN_BACKED_IMPORT_METHODS.includes(token.importMethod);

/** 是否持有可重复换取 role token 的来源（URL 源地址或 BIN） */
export const hasRefreshSource = (token) => {
  if (!token) return false;
  if (token.importMethod === "url") return !!token.sourceUrl;
  return isBinBackedToken(token);
};

/** 建立连接前是否需要按需刷新（空 / 无效且存在可刷新来源） */
export const shouldRefreshTokenOnDemand = (token) =>
  !!token && !isUsableTokenString(token.token) && hasRefreshSource(token);

/** 按需刷新失败时的用户提示文案 */
export const buildOnDemandRefreshMessage = (token) =>
  `账号“${token?.name || token?.id || "未知"}”的 Token 已失效，自动刷新失败，请重新导入 BIN`;
