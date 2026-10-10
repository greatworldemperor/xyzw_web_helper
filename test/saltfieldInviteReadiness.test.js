/**
 * 「不在观战态就别拉」即时态判定回归测试（2026-10-11）
 *
 * 背景：10-10 晚盐场实跑，3 支队伍反复邀请同一批已被拉走/已登场的队员，
 * 每次都白发一个 war_invitejointeam 再干等 inviteJoinTeam 的 15s 超时，
 * 服务端回的是 3000430「被邀请玩家不在观战状态」。
 * 立即模式原先缺这层前置校验（等待模式一直有，见 tasksSaltField 里对
 * getInviteReadiness 的既有调用），现补上同款判定：非 watching 直接放弃。
 *
 * 本文件锁的就是这个判定赖以成立的纯函数语义 —— 它若漂移，
 * 会导致「该拉的不拉」或「不该拉的白等」两种事故，任一都很贵。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { getInviteReadiness } from "../src/utils/legionWarState.js";

const MY = 457; // 我方队长 cId
const A = 443; // 目标队员 cId

/** 最小可用 state（只需满足 getRole / getTeamMemberCids 的取值路径） */
const mkState = (targetState, { inMyTeam = false, absent = false } = {}) => ({
  roles: absent ? {} : { [String(A)]: { codeIdV2: A, state: targetState } },
  teamMap: inMyTeam ? { [String(MY)]: { lCodeId: MY, mCodeIds: [MY, A] } } : {},
});

test("★ watching = 唯一可邀请状态", () => {
  assert.deepEqual(getInviteReadiness(mkState("watching"), A, MY), {
    ready: true,
    reason: "",
  });
});

test("★ 这些状态一律不可邀请 → 编排层直接放弃，不再发 war_invitejointeam", () => {
  for (const st of ["teaming", "idle", "combat", "march", "die"]) {
    const r = getInviteReadiness(mkState(st), A, MY);
    assert.equal(r.ready, false, `${st} 竟然判定为可邀请`);
    assert.equal(r.reason, st, `${st} 的 reason 应回传状态本身`);
  }
});

test("已在我队名单内 → ready=false 且 reason=in_my_team（按已入队处理，不再邀）", () => {
  const r = getInviteReadiness(mkState("teaming", { inMyTeam: true }), A, MY);
  assert.deepEqual(r, { ready: false, reason: "in_my_team" });
});

test("战场名单里查无此人 → not_in_field（编排层仍会试一次邀请，多半是快照滞后）", () => {
  const r = getInviteReadiness(mkState("watching", { absent: true }), A, MY);
  assert.deepEqual(r, { ready: false, reason: "not_in_field" });
});

test("cId 非法时不应崩，回 bad_cid", () => {
  const r = getInviteReadiness(mkState("watching"), Number.NaN, MY);
  assert.deepEqual(r, { ready: false, reason: "bad_cid" });
});
