/**
 * 周一白玉 / PK 房预约 回归测试
 *
 * fixture 字段**逐字取自真实抓包**：
 *   - local-data/misc/monday_white_jade.jsonl  （世界国皇帝，重复领）
 *   - local-data/misc/monday_white_jade1.jsonl （特别单纯，首次领）
 *   - local-data/misc/watch.jsonl              （世界国皇帝，重复预约）
 *   - local-data/misc/watch1.jsonl             （特别单纯，**首次预约**）
 *
 * ⚠️ 两个账号的预约都是「首次」性质的活动名额（该活动不定期出现），
 *    所以 11900050 在首次预约时同样返回 —— 这是本测试最需要锁住的点。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PKROOM_APPOINT_ACCEPTED_CODE,
  PKROOM_APPOINT_ROOM_KEY,
  describePkroomAppointResult,
  extractAppointedRoomId,
  isPkroomAppointAcceptedNotice,
} from "../src/utils/pkroomAppoint.js";

import {
  WHITE_JADE_ITEM_ID,
  WHITE_JADE_PACK_ID,
  WHITE_JADE_PER_CLAIM,
  describeWhiteJadeClaim,
  whiteJadeStatKey,
} from "../src/utils/whiteJade.js";

/* ------------------------------------------------------------------ *
 * 白玉
 * ------------------------------------------------------------------ */

// monday_white_jade.jsonl id=905 请求体（明文解码后）
const JADE_REQ = { ack: 0, body: { id: 17 }, time: 1790532755867, seq: 45, cmd: "activity_claimrolluppack" };

// monday_white_jade.jsonl id=907 响应
const JADE_RESP_REPEAT = {
  seq: 46,
  ack: 0,
  time: 1790532755978,
  resp: 45,
  cmd: "Activity_ClaimRollUpPackResp",
  body: {
    role: {
      items: { "1022": { quantity: 180281 } },
      statisticsTime: { "night:mare:buy:17": 1790532755 },
    },
    reward: [{ type: 3, itemId: 1022, value: 100, ext: 0 }],
  },
};

// monday_white_jade1.jsonl id=2238 响应（另一账号，首次领）
const JADE_RESP_FIRST = {
  seq: 48,
  ack: 0,
  time: 1790533593259,
  resp: 44,
  cmd: "Activity_ClaimRollUpPackResp",
  body: {
    role: {
      items: { "1022": { quantity: 192352 } },
      statisticsTime: { "night:mare:buy:17": 1790533593 },
    },
    reward: [{ type: 3, itemId: 1022, value: 100, ext: 0 }],
  },
};

test("白玉：卡包 id 17 / 每包 100 个 / 道具 1022", () => {
  assert.equal(WHITE_JADE_PACK_ID, 17);
  assert.equal(WHITE_JADE_PER_CLAIM, 100);
  assert.equal(WHITE_JADE_ITEM_ID, 1022);
  assert.equal(whiteJadeStatKey(17), "night:mare:buy:17");
  assert.equal(whiteJadeStatKey(), "night:mare:buy:17");
});

test("白玉：两个账号的请求体完全一致（都是 {id:17}）", () => {
  // 同一字段结构必须原样可重建 → id 是 number，不能是 "17"
  assert.deepEqual(JADE_REQ.body, { id: 17 });
  assert.equal(typeof JADE_REQ.body.id, "number");
});

test("白玉：重复领取的响应可解析出 1022 + 100", () => {
  const r = describeWhiteJadeClaim(JADE_RESP_REPEAT.body);
  assert.equal(r.ok, true);
  assert.equal(r.itemId, 1022);
  assert.equal(r.quantity, 100);
  assert.equal(r.lastClaimAt, 1790532755);
});

test("白玉：首次领取与重复领取的响应结构完全相同", () => {
  const first = describeWhiteJadeClaim(JADE_RESP_FIRST.body);
  const repeat = describeWhiteJadeClaim(JADE_RESP_REPEAT.body);

  assert.equal(first.ok, true);
  assert.equal(repeat.ok, true);
  // 结构一致：都是 1022 + 100，只有角色背包数量与时间戳不同
  assert.equal(first.itemId, repeat.itemId);
  assert.equal(first.quantity, repeat.quantity);
  assert.notEqual(first.lastClaimAt, repeat.lastClaimAt);
});

test("白玉：statisticsTime 的时间戳与领取时刻吻合（证明闸门在服务端）", () => {
  const r = describeWhiteJadeClaim(JADE_RESP_REPEAT.body);
  // 请求 time=1790532755867(ms)，statisticsTime=1790532755(s) → 同一秒
  assert.equal(Math.floor(JADE_REQ.time / 1000), r.lastClaimAt);
});

test("白玉：无 reward 时不误判成功", () => {
  assert.equal(describeWhiteJadeClaim({}).ok, false);
  assert.equal(describeWhiteJadeClaim({ reward: [] }).ok, false);
  assert.equal(describeWhiteJadeClaim({ reward: [] }).quantity, 0);
  assert.equal(describeWhiteJadeClaim({}).lastClaimAt, null);
});

test("白玉：发的是别的东西（非 1022）不算成功", () => {
  const other = { reward: [{ type: 3, itemId: 1023, value: 100, ext: 0 }] };
  assert.equal(describeWhiteJadeClaim(other).ok, false);
});

/* ------------------------------------------------------------------ *
 * PK 房预约
 * ------------------------------------------------------------------ */

// watch1.jsonl id=2336 —— **首次预约**也回这个「错误信封」，且无 cmd / 无 body / 无 resp
const APPOINT_NOTICE_FIRST = {
  seq: 58,
  ack: 0,
  time: 1790533633073,
  code: 11900050,
  error: "感谢您预约本场比赛，开赛后可领取奖励",
};

// watch.jsonl id=1041 —— 重复预约，字段与上面**逐字相同**（仅 seq/time 不同）
const APPOINT_NOTICE_REPEAT = {
  seq: 56,
  ack: 0,
  time: 1790532844481,
  code: 11900050,
  error: "感谢您预约本场比赛，开赛后可领取奖励",
};

// watch1.jsonl id=2339 SyncResp
const APPOINT_SYNC = {
  seq: 59,
  ack: 0,
  time: 1790533633075,
  resp: 54,
  cmd: "SyncResp",
  body: { role: { statistics: { "pk:appoint:room:id": 119131529 } } },
};

test("预约：11900050 是「已受理」通知，不是失败", () => {
  assert.equal(PKROOM_APPOINT_ACCEPTED_CODE, 11900050);
  assert.equal(isPkroomAppointAcceptedNotice(APPOINT_NOTICE_FIRST), true);
  assert.equal(isPkroomAppointAcceptedNotice(APPOINT_NOTICE_REPEAT), true);
});

test("预约：首次预约与重复预约回**完全相同**的 code 与文案", () => {
  // 这是本测试的核心断言：首次预约也走这条信封，
  // 所以绝不能把它当失败处理（否则首次预约必然误报失败）。
  assert.equal(APPOINT_NOTICE_FIRST.code, APPOINT_NOTICE_REPEAT.code);
  assert.equal(APPOINT_NOTICE_FIRST.error, APPOINT_NOTICE_REPEAT.error);
});

test("预约：该信封没有 cmd、没有 body、也没有 resp", () => {
  // 没有 resp → _handlePromiseResponse 的 resp 分支不会命中，
  // 也不会误删 pending；随后 SyncResp 正常 resolve。
  assert.equal("cmd" in APPOINT_NOTICE_FIRST, false);
  assert.equal("body" in APPOINT_NOTICE_FIRST, false);
  assert.equal("resp" in APPOINT_NOTICE_FIRST, false);
});

test("预约：成敗看 SyncResp 的 statistics，不看 code", () => {
  const r = describePkroomAppointResult(APPOINT_SYNC.body);
  assert.equal(r.ok, true);
  assert.equal(r.roomId, "119131529");
});

test("预约：房号是字符串（与 pkroom_getfightroomdetail 的 roomId 同类型）", () => {
  const roomId = extractAppointedRoomId(APPOINT_SYNC.body);
  assert.equal(typeof roomId, "string");
  assert.equal(roomId, "119131529");
  // 数字入参也归一化成字符串
  assert.equal(
    extractAppointedRoomId({ role: { statistics: { "pk:appoint:room:id": 42 } } }),
    "42",
  );
});

test("预约：statistics 键名与抓包一致", () => {
  assert.equal(PKROOM_APPOINT_ROOM_KEY, "pk:appoint:room:id");
});

test("预约：未拿到房号时判为未成功", () => {
  assert.equal(describePkroomAppointResult({}).ok, false);
  assert.equal(describePkroomAppointResult({}).roomId, null);
  assert.equal(describePkroomAppointResult({ role: { statistics: {} } }).ok, false);
  assert.equal(extractAppointedRoomId(undefined), null);
});

test("预约：房号 0 是合法值，不能被当空值丢掉", () => {
  // 防御 Number(null)===0 之类的坑：显式判 null/undefined
  assert.equal(
    extractAppointedRoomId({ role: { statistics: { "pk:appoint:room:id": 0 } } }),
    "0",
  );
});
