/**
 * 周一白玉（免费卡包领取）
 *
 * 抓包依据：local-data/misc/monday_white_jade.jsonl（重复领）、
 *          local-data/misc/monday_white_jade1.jsonl（首次领）。
 * 详见 docs/monday-jade-and-pkroom-appoint-protocol.md。
 *
 * 请求：`activity_claimrolluppack`，body 仅 `{ id: 17 }`
 * 响应：`Activity_ClaimRollUpPackResp`
 *   {
 *     role: { items: { "1022": { quantity } },
 *             statisticsTime: { "night:mare:buy:17": <秒级时间戳> } },
 *     reward: [{ type: 3, itemId: 1022, value: 100, ext: 0 }]
 *   }
 *
 * 关键结论：
 * - `itemId 1022` = 白玉；`value 100` = 每次 100 个。
 * - **「每周一」的闸门在服务端**（记在 `statisticsTime["night:mare:buy:<id>"]`），
 *   客户端**不需要判断星期几**，直接调用即可，重复领由服务端拦。
 * - 只有 `id: 17` 这一个卡包是**免费**的，其余均为收费，本工具只做 17。
 */

/** 白玉道具 ID */
export const WHITE_JADE_ITEM_ID = 1022;

/** 每周一免费白玉卡包 ID（唯一免费卡包，其余收费不用） */
export const WHITE_JADE_PACK_ID = 17;

/** 该卡包每次发放的白玉数量 */
export const WHITE_JADE_PER_CLAIM = 100;

/** statisticsTime 里记录「上次领取时刻」的键前缀 */
export const WHITE_JADE_STAT_PREFIX = "night:mare:buy:";

/**
 * 构造 statisticsTime 的键，例如 id=17 → "night:mare:buy:17"
 * @param {number} packId
 * @returns {string}
 */
export function whiteJadeStatKey(packId = WHITE_JADE_PACK_ID) {
  return `${WHITE_JADE_STAT_PREFIX}${packId}`;
}

/**
 * 从领取响应里解析结果。
 *
 * @param {object} body Activity_ClaimRollUpPackResp 的 body（或整个 packet）
 * @param {number} packId 期望的卡包 ID
 * @returns {{ok: boolean, itemId: number|null, quantity: number, lastClaimAt: number|null}}
 *   - ok：本次是否确实发了白玉
 *   - quantity：本次发放数量
 *   - lastClaimAt：服务端记录的上次领取时间戳（秒）
 */
export function describeWhiteJadeClaim(body, packId = WHITE_JADE_PACK_ID) {
  const rewards = Array.isArray(body?.reward) ? body.reward : [];
  const jade = rewards.find((r) => r?.itemId === WHITE_JADE_ITEM_ID) || null;

  const stats = body?.role?.statisticsTime || {};
  const lastClaimAtRaw = stats[whiteJadeStatKey(packId)];

  return {
    ok: jade !== null,
    itemId: jade ? jade.itemId : null,
    quantity: jade ? Number(jade.value) || 0 : 0,
    lastClaimAt:
      lastClaimAtRaw === undefined || lastClaimAtRaw === null
        ? null
        : Number(lastClaimAtRaw),
  };
}
