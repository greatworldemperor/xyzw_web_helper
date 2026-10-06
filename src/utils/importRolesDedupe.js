/**
 * 导入角色列表 · 同角色稳定键查重 + 新 BIN 补存到旧 id 键
 *
 * 背景（master 2026-10-07 bug）：token id = bin 内容 MD5，角色重新登录/重导后
 * bin 必变 → id 必变 → 按 id 查重永远查不到旧记录 → 追加，同角色新老两条并存
 * （旧的那份 BIN 已过期）。各导入页（bin/singlebin/mobile/wxqrcode）统一走本函数。
 *
 * 规则：
 *   1. 查重键 = 稳定键 serverId:roleId（缺稳定键的记录退回按 id 判定，行为同旧版）
 *   2. 命中旧记录 → 保留旧 id 原地更新：按 token id 记录的外部配置
 *      （蟠桃勾选/俱乐部缓存/盐场队伍等）自动接上，不再悬空
 *   3. 新 BIN 已由调用方按新 MD5 键存 IndexedDB；运行时刷新链路按 token.id 读
 *      BIN → 补存一份到旧 id 键，保证按旧 id 也能读到新 BIN
 *
 * @returns {{addedCount:number, updatedCount:number}}
 */
import { getStableTokenKey } from "./stableTokenKey.js";

export async function importRolesWithDedupe(tokenStore, roles, idb) {
  const { getArrayBuffer, storeArrayBuffer } = idb || {};
  let addedCount = 0;
  let updatedCount = 0;

  for (const role of roles) {
    const sKey = getStableTokenKey(role.serverId, role.roleId);
    const existing =
      // ① 完全相同的 BIN 重复导入（id 相同）→ 原地更新
      tokenStore.gameTokens.find((t) => t.id === role.id) ||
      // ② 同角色的过期 BIN（稳定键相同、id 不同）→ 保留旧 id 更新
      (sKey
        ? tokenStore.gameTokens.find(
            (t) => t.id !== role.id && getStableTokenKey(t.serverId, t.roleId) === sKey,
          )
        : undefined);

    if (existing) {
      // BIN 补缺：新 BIN 按「旧 token id」再存一份（不覆盖已有也无害——内容相同）
      try {
        if (existing.id !== role.id && getArrayBuffer && storeArrayBuffer) {
          const buf = await getArrayBuffer(role.id);
          if (buf) await storeArrayBuffer(existing.id, buf);
        }
      } catch (e) {
        console.warn("补存新 BIN 到旧 token id 失败（不影响导入）", e);
      }
      tokenStore.updateToken(existing.id, { ...role, id: existing.id });
      updatedCount++;
    } else {
      tokenStore.addToken({ ...role });
      addedCount++;
    }
  }

  return { addedCount, updatedCount };
}
