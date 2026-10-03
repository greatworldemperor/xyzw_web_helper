/**
 * 工具协议客户端在 `role_getroleinfo` 首帧上报的口径（唯一来源）。
 *
 * 格式 = {app版本}-{构建hash}-wx。构建 hash 取自 09-19 对模拟器真机（2.21.2）的抓包，
 * 尚未随新版本实测更新 —— 若服务端做全串白名单比对，需抓真机首帧补齐新 hash。
 *
 * ⚠️ 版本史与 3000070（「客户端数据异常」）实验记录：
 *   - 2.21.2（09-19 真机口径）：盐场 war_setbattleteam ✅（10-03 实战）/ 盐场 war_startbattle ❌ /
 *     蟠桃 payload_setbattleteam 未实测（09-20 被拒的是 runtime h5/1.89.8 口径）。
 *   - 2.48.2（10-04 起）：模拟器实测当前版本（游戏每周五更新，2.21.2 已落后 27 个版本）。
 *     版本假设：服务端对「战斗类」命令按 clientVersion 判旧 —— 明日蟠桃 payload_setbattleteam 直接实测。
 *   - 已知例外：盐场 war_startbattle 在 2.21.2 还是最新版时（09-19）就被拒 ⇒ PVP 的门不只是版本。
 *
 * 回退：改回 "2.21.2-fa918e1997301834-wx" 即恢复 09-27~10-03 已验证状态。
 */
export const CLIENT_VERSION = "2.48.2-fa918e1997301834-wx";

/** 旧版本号（回退/对照用） */
export const CLIENT_VERSION_PREV = "2.21.2-fa918e1997301834-wx";
