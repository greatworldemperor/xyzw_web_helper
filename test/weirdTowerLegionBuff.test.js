import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LEGION_PRIVILEGE_THRESHOLDS,
  LEGION_PRIVILEGE_TIER_COUNT,
  TIER_STATE,
  buildTierStates,
  canClaim,
  countParticipants,
  countPendingClaims,
  countToNextTier,
  isEmptyClaim,
  nextTierThreshold,
  pickClaimedThisTime,
  pickUnlockedTiers,
  resolveReachedTier,
  summarizeBuff,
} from "../src/utils/weirdTowerLegionBuff.js";

// 真实抓包 evotower_get_buff.jsonl #526 的 memberScores（21 人）
const REAL_MEMBER_SCORES = {
  135107854: 319,
  139056393: 9,
  139057210: 9,
  139063046: 9,
  139066197: 9,
  139067888: 9,
  139069314: 9,
  436730758: 9,
  436731190: 9,
  436733214: 9,
  436733582: 9,
  436741450: 9,
  436741844: 9,
  436742288: 9,
  436742908: 9,
  436743574: 9,
  436744052: 9,
  436744943: 9,
  436745723: 9,
  616736676: 1,
  703935668: 176,
};

// 抓包三次 claim 响应（seq 50 / 52 / 53）
const CLAIM_SEQ50 = { legionPrivilege: { 1: 1, 2: 1, 3: 1 }, evoTower: { legionPrivilege: { 1: 1 } } };
const CLAIM_SEQ52 = { legionPrivilege: { 1: 1, 2: 1, 3: 1 }, evoTower: { legionPrivilege: { 2: 1 } } };
const CLAIM_SEQ53 = { legionPrivilege: { 1: 1, 2: 1, 3: 1 }, evoTower: { legionPrivilege: { 3: 1 } } };

test("档位阈值表：4 档 10/15/20/25", () => {
  assert.equal(LEGION_PRIVILEGE_TIER_COUNT, 4);
  assert.deepEqual([...LEGION_PRIVILEGE_THRESHOLDS], [0, 10, 15, 20, 25]);
});

test("countParticipants：真实 21 人名单 = 21", () => {
  assert.equal(countParticipants(REAL_MEMBER_SCORES), 21);
});

test("countParticipants：只打了第 1 层（towerCount=1）也算 1 个人", () => {
  // 616736676 只打了 towerId=1，但 key 存在 → 计入人数
  assert.equal(countParticipants({ 616736676: 1 }), 1);
});

test("countParticipants：异常输入安全", () => {
  assert.equal(countParticipants(null), 0);
  assert.equal(countParticipants(undefined), 0);
  assert.equal(countParticipants({}), 0);
  assert.equal(countParticipants("notanobject"), 0);
});

test("resolveReachedTier：边界值（阈值本身算达成）", () => {
  assert.equal(resolveReachedTier(0), 0);
  assert.equal(resolveReachedTier(9), 0);
  assert.equal(resolveReachedTier(10), 1);
  assert.equal(resolveReachedTier(14), 1);
  assert.equal(resolveReachedTier(15), 2);
  assert.equal(resolveReachedTier(20), 3);
  assert.equal(resolveReachedTier(21), 3);
  assert.equal(resolveReachedTier(24), 3);
  assert.equal(resolveReachedTier(25), 4);
  assert.equal(resolveReachedTier(100), 4);
});

test("resolveReachedTier：21 人 → 第 3 档（抓包实证）", () => {
  assert.equal(resolveReachedTier(countParticipants(REAL_MEMBER_SCORES)), 3);
});

test("resolveReachedTier：非法入参归零", () => {
  assert.equal(resolveReachedTier(-5), 0);
  assert.equal(resolveReachedTier(NaN), 0);
  assert.equal(resolveReachedTier(undefined), 0);
  assert.equal(resolveReachedTier("abc"), 0);
});

test("countToNextTier：距下一档差几人", () => {
  assert.equal(countToNextTier(0), 10);
  assert.equal(countToNextTier(9), 1);
  assert.equal(countToNextTier(21), 4); // 距 25 差 4
  assert.equal(countToNextTier(25), 0); // 满级
  assert.equal(countToNextTier(99), 0);
});

test("nextTierThreshold：满级返回 null", () => {
  assert.equal(nextTierThreshold(9), 10);
  assert.equal(nextTierThreshold(21), 25);
  assert.equal(nextTierThreshold(25), null);
});

test("🔴 pickUnlockedTiers：顶层 legionPrivilege = 已解锁全量（三次恒定）", () => {
  assert.deepEqual(pickUnlockedTiers(CLAIM_SEQ50), [1, 2, 3]);
  assert.deepEqual(pickUnlockedTiers(CLAIM_SEQ52), [1, 2, 3]);
  assert.deepEqual(pickUnlockedTiers(CLAIM_SEQ53), [1, 2, 3]);
});

test("🔴 pickClaimedThisTime：本次结果在嵌套 evoTower里（逐档变化）", () => {
  assert.deepEqual(pickClaimedThisTime(CLAIM_SEQ50), [1]);
  assert.deepEqual(pickClaimedThisTime(CLAIM_SEQ52), [2]);
  assert.deepEqual(pickClaimedThisTime(CLAIM_SEQ53), [3]);
});

test("🔴 顶层与嵌套必须区分：否则会误判「第一次就全领完」", () => {
  // 顶层三次都一样（3 档），若拿顶层当本次结果 → 第一次就以为领了 3 档
  assert.equal(pickUnlockedTiers(CLAIM_SEQ50).length, 3);
  assert.equal(pickClaimedThisTime(CLAIM_SEQ50).length, 1);
  // 累计三次 = 3 档，与顶层一致
  const acc = [
    ...pickClaimedThisTime(CLAIM_SEQ50),
    ...pickClaimedThisTime(CLAIM_SEQ52),
    ...pickClaimedThisTime(CLAIM_SEQ53),
  ];
  assert.deepEqual([...new Set(acc)].sort((a, b) => a - b), [1, 2, 3]);
});

test("pickUnlockedTiers / pickClaimedThisTime：空响应安全", () => {
  assert.deepEqual(pickUnlockedTiers({}), []);
  assert.deepEqual(pickUnlockedTiers(null), []);
  assert.deepEqual(pickClaimedThisTime({}), []);
  assert.deepEqual(pickClaimedThisTime({ evoTower: {} }), []);
  // 只有顶层没有嵌套 → 本次啥也没领到
  assert.deepEqual(pickClaimedThisTime(CLAIM_SEQ50), [1]);
  assert.deepEqual(pickClaimedThisTime({ legionPrivilege: { 1: 1 } }), []);
});

test("pickUnlockedTiers：越界档位号被剔除", () => {
  assert.deepEqual(pickUnlockedTiers({ legionPrivilege: { 0: 1, 1: 1, 5: 1, x: 1 } }), [1]);
});

test("isEmptyClaim：领完时返回 true（循环终止条件）", () => {
  assert.equal(isEmptyClaim(CLAIM_SEQ50), false);
  assert.equal(isEmptyClaim({ evoTower: { legionPrivilege: {} } }), true);
  assert.equal(isEmptyClaim({}), true);
});

test("buildTierStates：21 人未领 → 1/2/3 可领、4锁定", () => {
  const rows = buildTierStates({ participantCount: 21, claimedTiers: [] });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.tier), [1, 2, 3, 4]);
  assert.deepEqual(rows.map((r) => r.state), [
    TIER_STATE.CLAIMABLE,
    TIER_STATE.CLAIMABLE,
    TIER_STATE.CLAIMABLE,
    TIER_STATE.LOCKED,
  ]);
  assert.deepEqual(rows.map((r) => r.threshold), [10, 15, 20, 25]);
  assert.match(rows[3].desc, /还差 4 人/);
});

test("buildTierStates：25 人满级全解锁", () => {
  const rows = buildTierStates({ participantCount: 25, claimedTiers: [] });
  assert.deepEqual(rows.map((r) => r.state), Array(4).fill(TIER_STATE.CLAIMABLE));
});

test("buildTierStates：已领档位标CLAIMED", () => {
  const rows = buildTierStates({ participantCount: 21, claimedTiers: [1, 2, 3] });
  assert.deepEqual(rows.map((r) => r.state), [
    TIER_STATE.CLAIMED,
    TIER_STATE.CLAIMED,
    TIER_STATE.CLAIMED,
    TIER_STATE.LOCKED,
  ]);
  assert.match(rows[0].desc, /已领取/);
});

test("buildTierStates：人数不足时全部 LOCKED", () => {
  const rows = buildTierStates({ participantCount: 9, claimedTiers: [] });
  assert.deepEqual(rows.map((r) => r.state), Array(4).fill(TIER_STATE.LOCKED));
});

test("buildTierStates：claimedTiers 含未解锁档位时仍显示 LOCKED（不越权）", () => {
  const rows = buildTierStates({ participantCount: 12, claimedTiers: [1, 2, 3, 4] });
  assert.deepEqual(rows.map((r) => r.state), [
    TIER_STATE.CLAIMED,
    TIER_STATE.LOCKED,
    TIER_STATE.LOCKED,
    TIER_STATE.LOCKED,
  ]);
});

test("buildTierStates：无人参与（0 人）全 LOCKED", () => {
  const rows = buildTierStates({});
  assert.deepEqual(rows.map((r) => r.state), Array(4).fill(TIER_STATE.LOCKED));
});

test("countPendingClaims：21 人未领 = 3（循环 3 次）", () => {
  assert.equal(countPendingClaims({ participantCount: 21, claimedTiers: [] }), 3);
  assert.equal(countPendingClaims({ participantCount: 21, claimedTiers: [1, 2, 3] }), 0);
  assert.equal(countPendingClaims({ participantCount: 21, claimedTiers: [1] }), 2);
  assert.equal(countPendingClaims({ participantCount: 25, claimedTiers: [] }), 4);
  assert.equal(countPendingClaims({ participantCount: 9, claimedTiers: [] }), 0);
});

test("countPendingClaims：不受 unlockedTiers 误导（顶层恒为全量）", () => {
  // 传抓包顶层值 {1,2,3} + 未领 → 仍应算出 3 档可领
  assert.equal(
    countPendingClaims({ participantCount: 21, unlockedTiers: [1, 2, 3], claimedTiers: [] }),
    3,
  );
});

test("summarizeBuff：21 人未领", () => {
  const s = summarizeBuff({ participantCount: 21, claimedTiers: [] });
  assert.equal(s.participantCount, 21);
  assert.equal(s.reachedTier, 3);
  assert.equal(s.pending, 3);
  assert.equal(s.nextThreshold, 25);
  assert.equal(s.remaining, 4);
  assert.match(s.headline, /21 人/);
  assert.match(s.headline, /3\/4 档/);
  assert.match(s.headline, /3 档待领取/);
});

test("summarizeBuff：满级已领完", () => {
  const s = summarizeBuff({ participantCount: 30, claimedTiers: [1, 2, 3, 4] });
  assert.equal(s.reachedTier, 4);
  assert.equal(s.pending, 0);
  assert.equal(s.nextThreshold, null);
  assert.match(s.headline, /全部已领取/);
});

test("summarizeBuff：0 人给出不可领提示", () => {
  const s = summarizeBuff({ participantCount: 0 });
  assert.equal(s.pending, 0);
  assert.match(s.headline, /暂无成员参与战斗/);
});

test("canClaim：未绑定俱乐部（bindLegionId=0）不可领", () => {
  const r = canClaim({ bindLegionId: 0, participantCount: 21 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /未绑定俱乐部|尚未绑定俱乐部/);
});

test("canClaim：已绑定 + 21 人 → 可领（抓包实证 7203672）", () => {
  const r = canClaim({ bindLegionId: 7203672, participantCount: 21 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "");
});

test("canClaim：已绑定但 0 人参与 → 不可领", () => {
  const r = canClaim({ bindLegionId: 7203672, participantCount: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /暂无成员参与战斗/);
});

test("canClaim：入参缺失安全", () => {
  assert.equal(canClaim().ok, false);
  assert.equal(canClaim({}).ok, false);
});

// ============ autoClaimLegionBuffDuringClimb（爬塔时自动领取）============

import { autoClaimLegionBuffDuringClimb } from "../src/utils/weirdTowerLegionBuff.js";

/** 构造一个假 send，按脚本返回 */
const makeSend = (script) => {
  const calls = [];
  let i = 0;
  const send = async (cmd) => {
    calls.push(cmd);
    const item = script[i++];
    if (typeof item === "function") return item(cmd);
    if (item instanceof Error) throw item;
    return item;
  };
  return { send, calls };
};

const GETINFO_BOUND = { evoTower: { bindLegionId: 7203672 } };
const GETINFO_UNBOUND = { evoTower: { bindLegionId: 0 } };
const CLAIM_1 = { legionPrivilege: { 1: 1, 2: 1, 3: 1 }, evoTower: { legionPrivilege: { 1: 1 } } };
const CLAIM_2 = { legionPrivilege: { 1: 1, 2: 1, 3: 1 }, evoTower: { legionPrivilege: { 2: 1 } } };
const CLAIM_3 = { legionPrivilege: { 1: 1, 2: 1, 3: 1 }, evoTower: { legionPrivilege: { 3: 1 } } };
const CLAIM_EMPTY = { legionPrivilege: { 1: 1, 2: 1, 3: 1 }, evoTower: { legionPrivilege: {} } };
const NO_TIMING = { timing: { perClaim: 0, perRound: 0 } };

test("autoClaim：未绑定俱乐部 → 跳过，不发 claim", async () => {
  const { send, calls } = makeSend([GETINFO_UNBOUND]);
  const r = await autoClaimLegionBuffDuringClimb({ send, ...NO_TIMING });
  assert.equal(r.skipped, "not-bound");
  assert.deepEqual(r.claimedTiers, []);
  assert.deepEqual(calls, ["evotower_getinfo"], "只应发 getinfo");
});

test("autoClaim：已领完 → 只发 1 次 claim 就收手", async () => {
  const { send, calls } = makeSend([GETINFO_BOUND, CLAIM_EMPTY]);
  const r = await autoClaimLegionBuffDuringClimb({ send, ...NO_TIMING });
  assert.deepEqual(r.claimedTiers, []);
  assert.equal(r.skipped, "all-claimed");
  assert.deepEqual(calls, ["evotower_getinfo", "evotower_claimlegionprivilege"]);
  assert.equal(calls.filter((c) => c === "evotower_claimlegionprivilege").length, 1,
    "已领完时只应试探 1 次，不多发");
});

test("autoClaim：21 人未领 → 连发 4 次（3 次领到 + 1 次探测收手）", async () => {
  const { send, calls } = makeSend([GETINFO_BOUND, CLAIM_1, CLAIM_2, CLAIM_3, CLAIM_EMPTY]);
  const r = await autoClaimLegionBuffDuringClimb({ send, ...NO_TIMING });
  assert.deepEqual(r.claimedTiers, [1, 2, 3]);
  assert.deepEqual(r.unlockedTiers, [1, 2, 3]);
  assert.equal(r.skipped, "all-claimed");
  assert.equal(calls.filter((c) => c === "evotower_claimlegionprivilege").length, 4);
});

test("autoClaim：🔴 靠嵌套字段判断，服务端给全量顶层时也不会误判", async () => {
  // 每次响应的顶层都是 {1,2,3}（已解锁全量），但只有嵌套是本次结果。
  // 若错用顶层判断，第 1 轮就会认为「全领完」→ 只发 1 次。
  const { send, calls } = makeSend([GETINFO_BOUND, CLAIM_1, CLAIM_2, CLAIM_3, CLAIM_EMPTY]);
  const r = await autoClaimLegionBuffDuringClimb({ send, ...NO_TIMING });
  assert.equal(calls.filter((c) => c === "evotower_claimlegionprivilege").length, 4,
    "必须发满 4 次，不能被顶层全量字段骗到只发 1 次");
  assert.deepEqual(r.claimedTiers, [1, 2, 3]);
});

test("autoClaim：4 档全解锁 → 领满 4 档后收手（不超发）", async () => {
  const c1 = { legionPrivilege: { 1:1,2:1,3:1,4:1 }, evoTower: { legionPrivilege: { 1: 1 } } };
  const c2 = { evoTower: { legionPrivilege: { 2: 1 } } };
  const c3 = { evoTower: { legionPrivilege: { 3: 1 } } };
  const c4 = { evoTower: { legionPrivilege: { 4: 1 } } };
  const { send, calls } = makeSend([GETINFO_BOUND, c1, c2, c3, c4, CLAIM_EMPTY]);
  const r = await autoClaimLegionBuffDuringClimb({ send, ...NO_TIMING });
  assert.deepEqual(r.claimedTiers, [1, 2, 3, 4]);
  // 上界 4 档：领满 4 档后循环自然结束（i=4 时退出），不会发第 5 次
  assert.equal(calls.filter((c) => c === "evotower_claimlegionprivilege").length, 4,
    "最多 4 次，绝不超发");
});

test("autoClaim：getinfo 失败 → 跳过，不阻塞爬塔", async () => {
  const { send, calls } = makeSend([new Error("timeout")]);
  const r = await autoClaimLegionBuffDuringClimb({ send, ...NO_TIMING });
  assert.equal(r.skipped, "getinfo-failed");
  assert.deepEqual(calls, ["evotower_getinfo"], "失败后不该继续发 claim");
});

test("autoClaim：claim 中途失败 → 保留已领档位，不抛异常（不阻塞爬塔）", async () => {
  const { send } = makeSend([GETINFO_BOUND, CLAIM_1, CLAIM_2, new Error("400340")]);
  const r = await autoClaimLegionBuffDuringClimb({ send, ...NO_TIMING });
  assert.equal(r.skipped, "claim-failed");
  assert.deepEqual(r.claimedTiers, [1, 2], "已领的 2 档要保留下来");
});

test("autoClaim：首次 claim 就失败 → 正常返回", async () => {
  const { send } = makeSend([GETINFO_BOUND, new Error("boom")]);
  const r = await autoClaimLegionBuffDuringClimb({ send, ...NO_TIMING });
  assert.equal(r.skipped, "claim-failed");
  assert.deepEqual(r.claimedTiers, []);
});

test("autoClaim：日志回调能拿到每次领取的档位", async () => {
  const logs = [];
  const { send } = makeSend([GETINFO_BOUND, CLAIM_1, CLAIM_2, CLAIM_3, CLAIM_EMPTY]);
  await autoClaimLegionBuffDuringClimb({
    send,
    onLog: (m, t) => logs.push([t, m]),
    ...NO_TIMING,
  });
  const successLogs = logs.filter(([t]) => t === "success").map(([, m]) => m);
  assert.equal(successLogs.length, 3);
  assert.ok(successLogs[0].includes("第 1 档"));
  assert.ok(successLogs[2].includes("第 3 档"));
});

test("autoClaim：未注入 send → 安全返回，不抛", async () => {
  const r = await autoClaimLegionBuffDuringClimb({});
  assert.equal(r.skipped, "no-send");
  assert.deepEqual(r.claimedTiers, []);
});

test("autoClaim：服务端末给嵌套字段（脏响应）→ 视为已领完，不死循环", async () => {
  // 只有顶层没有嵌套：不能把顶层当本次结果
  const dirty = { legionPrivilege: { 1: 1, 2: 1, 3: 1 } };
  const { send, calls } = makeSend([GETINFO_BOUND, dirty]);
  const r = await autoClaimLegionBuffDuringClimb({ send, ...NO_TIMING });
  assert.deepEqual(r.claimedTiers, []);
  assert.equal(calls.filter((c) => c === "evotower_claimlegionprivilege").length, 1);
});
