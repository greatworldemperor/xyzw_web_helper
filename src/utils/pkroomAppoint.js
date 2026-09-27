/**
 * PK 房预约（关注比赛）响应判定
 *
 * 抓包依据：local-data/misc/watch1.jsonl（2026-09-27，首次预约）、
 *          local-data/misc/watch.jsonl（同日，重复预约）。
 * 详见 docs/monday-jade-and-pkroom-appoint-protocol.md。
 *
 * ⚠️ 该活动的响应形态很反直觉，抽成独立模块是为了让回归测试锁住语义
 *    （`xyzwWebSocket.js` 依赖 `@/` 别名，node 测试无法直接导入）。
 *
 * 一次 `pkroom_appoint` 请求会收到**两条**响应：
 *
 *   1) 错误信封（先到）：
 *      { seq: 58, ack: 0, time: ..., code: 11900050,
 *        error: "感谢您预约本场比赛，开赛后可领取奖励" }
 *      —— **没有 cmd、没有 body，也没有 resp**。
 *      实测「首次预约」与「重复预约」返回完全相同的 code 与文案，
 *      所以 11900050 是**幂等的「已受理」通知，不是失败**。
 *
 *   2) SyncResp（后到，带 resp = 请求 seq）：
 *      { seq: 59, ack: 0, resp: 54, cmd: "SyncResp",
 *        body: { role: { statistics: { "pk:appoint:room:id": 119131529 } } } }
 *      —— 被预约的房号在这里，由服务端下发（请求本身零参数，无法指定目标房）。
 *
 * 结论：**成败只能看 statistics 里的 `pk:appoint:room:id`，绝不能判 code。**
 *      把 11900050 当失败写入错误处理会导致 100% 误报「预约失败」。
 */

/** 该「伪错误码」= 服务端已受理预约的幂等通知，不是失败 */
export const PKROOM_APPOINT_ACCEPTED_CODE = 11900050;

/** statistics 里记录「已预约房号」的键 */
export const PKROOM_APPOINT_ROOM_KEY = "pk:appoint:room:id";

/**
 * 判断某条错误信封是否只是「预约已受理」的幂等通知。
 *
 * @param {{code?: number, error?: string}} packet
 * @returns {boolean} true = 不是失败，可安全忽略
 */
export function isPkroomAppointAcceptedNotice(packet) {
  if (!packet || typeof packet !== "object") return false;
  return packet.code === PKROOM_APPOINT_ACCEPTED_CODE;
}

/**
 * 从 SyncResp 的 body 里取出被预约的房号。
 *
 * body 结构：{ role: { statistics: { "pk:appoint:room:id": <string|number> } } }
 *
 * ⚠️ 房号是**字符串**（抓包实测 BON tag 5），别转 number ——
 *    与 `pkroom_getfightroomdetail` 的 roomId 类型一致。
 *
 * @param {object} body SyncResp 的 body（或整个 packet）
 * @returns {string|null} 房号字符串；未预约时返回 null
 */
export function extractAppointedRoomId(body) {
  const raw = body?.role?.statistics?.[PKROOM_APPOINT_ROOM_KEY];
  if (raw === undefined || raw === null) return null;
  return String(raw);
}

/**
 * 综合判定一次预约是否成功。
 *
 * 判据：SyncResp 里出现了 `pk:appoint:room:id`。
 * 只要拿到了房号就算成功 —— 无论过程里收到过 11900050。
 *
 * @param {object} body SyncResp 的 body（或整个 packet）
 * @returns {{ok: boolean, roomId: string|null}}
 */
export function describePkroomAppointResult(body) {
  const roomId = extractAppointedRoomId(body);
  return { ok: roomId !== null, roomId };
}
