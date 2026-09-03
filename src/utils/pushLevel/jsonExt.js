/**
 * JSONExt 的最小兼容实现。
 * 官方实现会先把 Map 转成普通对象，再使用 JSON.stringify。
 */
const mapReplacer = (_key, value) => {
  if (value instanceof Map) {
    return Object.fromEntries(value.entries());
  }

  return value;
};

export const jsonExtStringify = (value) => JSON.stringify(value, mapReplacer);

export default jsonExtStringify;