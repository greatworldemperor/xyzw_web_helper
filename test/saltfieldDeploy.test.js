/**
 * 盐场登场判据回归测试（2026-09-26 复盘定稿）
 *
 * 背景：09-26 自动盐场 16 支队伍 0 登场。根因 = deploy() 旧判据 state!=='watching'
 * 把队长自身的 teaming 当成已登场（自动流在最后一个队员就位的瞬间调 deploy，
 * 队长翻 watching 的通知晚 ~1s 才到）→ dp.ok 同步 true → 毫秒级 closeProbe →
 * 50ms 发送队列 tick 没跑到 → war_setbattleteam 从未上线。
 *
 * 帧序列结构照抄 09-26 runtime 抓包（官方客户端真实成功流程）：
 *   invite → 两人 teaming(倒计时+10s) → +10s 队员自动同意(watching, 倒计时清0)
 *   → +1s 队长翻 watching → war_setbattleteam 确认（全队 idle@21,5）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createInitialState,
  applyBattlefieldFrame,
  isMemberSettled,
  getUnsettledMembers,
  getTeamMemberCids,
  getRole,
  isDeployedState,
  isRoleDeployed,
  DEPLOYED_STATES,
} from "../src/utils/legionWarState.js";

const OWNER_ROLE_ID = 119532574; // 队长 roleId（roleMap 反查 cId 用，值任意）
const MY = 457; // 队长战场 cId
const M1 = 443; // 队员战场 cId
const T_INVITE = 1790424000; // 邀请时刻（epoch 秒，与抓包同时段）

/** 旧判据（今天线上代码）：故意留在这里做「bug 存在性」回归锚点 */
const oldDeploySaysDeployed = (state, cid) => {
  const r = getRole(state, cid);
  return !!r && !!r.state && r.state !== "watching";
};

function buildFrames() {
  return [
    // ① 全量快照（进战场）：自己+队员都是 watching（未组队未登场）
    {
      name: "enterbattlefieldresp",
      body: {
        battlefieldId: "WEEK-260926:1882",
        roleCodeId: MY,
        battlefield: {
          id: "WEEK-260926:1882",
          state: "started",
          roles: {
            [MY]: { codeIdV2: MY, state: "watching", position: { x: -1, y: -1 }, isOnline: true },
            [M1]: { codeIdV2: M1, state: "watching", position: { x: -1, y: -1 }, isOnline: false },
          },
        },
        roleMap: { [OWNER_ROLE_ID]: { cId: MY }, 111: { cId: M1 } },
      },
    },
    // ② 邀请响应：两人进 teaming，队员倒计时 = 邀请+10s；mCodeIds 收人（占位）
    {
      name: "invitejointeamresp",
      body: {
        battlefield: {
          roles: {
            [M1]: { state: "teaming", teamLimitTime: T_INVITE + 10 },
            [MY]: { state: "teaming", teamLimitTime: 0 },
          },
          teamMap: {
            [MY]: { lCodeId: MY, state: "teaming", mCodeIds: [MY, M1], position: { x: -1, y: -1 } },
          },
        },
      },
    },
    // ③ +10s：离线队员自动同意（teaming → watching，倒计时清 0，mCodeIds 保留）
    {
      name: "invitejointeamnotify(队员自动同意)",
      body: { battlefield: { roles: { [M1]: { state: "watching", teamLimitTime: 0 } } } },
    },
    // ④ +1s：队长也翻 watching（队伍就绪，可点登场）
    {
      name: "invitejointeamnotify(队长翻watching)",
      body: {
        battlefield: {
          roles: { [MY]: { state: "watching", teamLimitTime: 0 } },
          teamMap: { [MY]: { state: "watching" } },
        },
      },
    },
    // ⑤ 登场确认：全队 idle@21,5（war_setbattleteam 被服务端接受）
    {
      name: "setbattleteamresp(登场成功)",
      body: {
        battlefield: {
          roles: {
            [MY]: { state: "idle", position: { x: 21, y: 5 } },
            [M1]: { state: "idle", position: { x: 21, y: 5 } },
          },
          teamMap: { [MY]: { state: "idle", position: { x: 21, y: 5 } } },
        },
      },
    },
  ];
}

function replayTo(index) {
  const state = createInitialState();
  const frames = buildFrames();
  for (let i = 0; i <= index; i++) applyBattlefieldFrame(state, frames[i].body, OWNER_ROLE_ID);
  return { state, frames };
}

test("isDeployedState 真值表：只有 idle/combat/march 算已登场", () => {
  assert.deepEqual([...DEPLOYED_STATES].sort(), ["combat", "idle", "march"]);
  for (const s of DEPLOYED_STATES) assert.equal(isDeployedState(s), true, s);
  for (const s of ["watching", "teaming", "", undefined, null]) {
    assert.equal(isDeployedState(s), false, String(s));
  }
});

test("邀请后放置期：isMemberSettled 为 false（倒计时未过）", () => {
  const { state } = replayTo(1);
  assert.equal(isMemberSettled(state, MY, M1, T_INVITE + 3), false);
  assert.equal(getTeamMemberCids(state, MY).includes(M1), true, "占位即入 mCodeIds");
});

test("+10s 自动同意：isMemberSettled 变 true（真就位），全员就位判定通过", () => {
  const { state } = replayTo(2);
  assert.equal(isMemberSettled(state, MY, M1, T_INVITE + 11), true);
  const u = getUnsettledMembers(state, MY, [M1], T_INVITE + 11);
  assert.equal(u.notInTeam.length, 0);
  assert.equal(u.stillPreparing.length, 0);
});

test("核心回归：就位瞬间（队长仍 teaming）新判据必须 false，旧判据会误报 true", () => {
  const { state } = replayTo(2); // 队员已自动同意，队长还在 teaming
  const snap = getRole(state, MY);
  assert.equal(snap.state, "teaming", "此刻队长自身 state=teaming（09-26 现场状态）");
  // 旧判据在这里误报「已登场」——这正是 09-26 的 bug，留作锚点
  assert.equal(oldDeploySaysDeployed(state, MY), true, "旧判据 bug 锚点：teaming 被当成已登场");
  // 新判据必须诚实
  assert.equal(isRoleDeployed(state, MY), false);
});

test("队长翻 watching：仍是未登场（已组队·未登场）", () => {
  const { state } = replayTo(3);
  assert.equal(getRole(state, MY).state, "watching");
  assert.equal(isRoleDeployed(state, MY), false, "watching = 已组队未登场，不是登场");
});

test("登场确认帧（idle@21,5）：新判据 true，旧判据也 true", () => {
  const { state } = replayTo(4);
  assert.equal(getRole(state, MY).state, "idle");
  assert.equal(isRoleDeployed(state, MY), true);
  assert.equal(oldDeploySaysDeployed(state, MY), true);
  assert.equal(getRole(state, M1).state, "idle", "队员随全队一起登场");
});

test("登场后的战斗/行军状态仍算已登场（重试不误发第二轮）", () => {
  const { state } = replayTo(4);
  state.roles[String(MY)].state = "combat";
  assert.equal(isRoleDeployed(state, MY), true);
  state.roles[String(MY)].state = "march";
  assert.equal(isRoleDeployed(state, MY), true);
});
