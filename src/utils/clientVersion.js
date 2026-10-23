/**
 * 工具协议客户端在 `role_getroleinfo` 首帧上报的口径（唯一来源）。
 *
 * 格式 = {app版本}-{构建hash}-wx。**构建 hash 随每周五的版本更新轮换**（10-04 实锤：
 * 从 PC 微信小游戏包解出三代真串：2.21.2-fa918e1997301834-wx（03 月）/ 2.44.2-e1853b3c1fe23f57-wx（构建356）/
 * 2.48.2-cbe6e57c59db01c2-wx（构建361）—— 三个版本三个 hash）。
 *
 * 🔧 换版本流程（**每周固定机制，10-18 与 master 约定**）：PC 微信打开一次小游戏（更新包）→
 *    node tools/saltfield/wxapkg-decrypt.mjs
 *      "C:\Users\<user>\AppData\Roaming\Tencent\xwechat\radium\users\<uid>\applet\packages\wx0840558555a454ed\<新构建号>\__APP__.wxapkg"
 *      <outDir>
 *    → grep game.js 的 GAME_VERSION → 改这里 → 测试 → commit → deploy。
 *
 * ⚠️ 版本史与 3000070（「客户端数据异常」）实验记录：
 *   - 2.21.2-fa918e1997301834-wx（09-27~10-03 在用）：盐场 war_setbattleteam ✅（10-03 实战）/
 *     盐场 war_startbattle ❌（09-19）——10-05 时间线修正：2.21.2 是 03 月的版本（上游 59058ca6），
 *     09-19 时已落后 ~25 个周更版本 ⇒ PVP 拒绝与「版本新鲜度」假设一致，**此前"当时最新"的反例说法有误，撤销**。
 *   - 2.48.2-fa918e1997301834-wx（10-04 凌晨，拼装串）：从未存在于任何真实客户端 —— 蟠桃首测前被
 *     小游戏包解包推翻，未上线实测即废弃。
 *   - 2.48.2-cbe6e57c59db01c2-wx（10-04~10-18，官方 361 构建真串）：**10-18 蟠桃实战 payload_setbattleteam
 *     56/63 被 3000070 拒绝**（落后 2 个周更）⇒ 版本新鲜度门实锤，过期串在战斗类动作上不再放行。
 *   - 2.50.3-1eb1967216629ed1-wx（10-18~10-23，官方 363 构建真串）：10-18 起在用。
 *   - 2.51.5-bce92e36552b05db-wx（10-23 起，官方 364 构建真串）：当前。
 *
 * 另：游戏内还有 globalThis.BATTLE_VERSION="7f91491b47"（356/361/363 三代同值 ⇒ 轮换频率低于版本号，
 * 首帧不上报，暂不跟进）。
 *
 * 回退：改回 "2.50.3-1eb1967216629ed1-wx" 即恢复 10-18 状态。
 */
export const CLIENT_VERSION = "2.51.5-bce92e36552b05db-wx";

/** 旧版本号（回退/对照用） */
export const CLIENT_VERSION_PREV = "2.50.3-1eb1967216629ed1-wx";
