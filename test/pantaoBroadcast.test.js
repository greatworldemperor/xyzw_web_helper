// 蟠桃战场广播帧污染回归（2026-10-18 蟠桃实战 23号战士假阳性根因）
//
// 基准：local-data/pantao/paotao20261018/pantao-wss-2026-10-18-12-36-41.jsonl
//   · 23号战士-0-139080738 在 6766 战场 payload_setbattleteam 被 3000070 秒拒（12:14:12.097 seq=2）
//   · 2 秒后（12:14:14.189）收到 setbattleteamresp code=0，但 body.roleId=139084096 = 21号战士
//     （master 官方客户端手动操作的角色，同战场登场广播）
//   · 旧实现 applyPantaoFrame 用帧内 roleId 覆盖 state.myRoleId → getMyRole 返回 21号战士
//     （state=idle ≠ watching）→ setBattleTeam 误判「已登场」
// 修复：myRoleId 只允许为空时补齐，固定值以 createPantaoState 为准。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyPantaoFrame,
  createPantaoState,
  getMyRole,
} from "../src/utils/pantaoState.js";

test("广播 setbattleteamresp 不劫持 myRoleId、不误判登场", () => {
  const state = createPantaoState({ bfId: "261018:6766", myRoleId: 139080738 });

  // 自己的 enterbfresp（全量首帧，state=watching）
  applyPantaoFrame(
    state,
    {
      body: {
        bf: { id: "261018:6766", state: "started", roles: { "139080738": { state: "watching", power: 1 } } },
        roleId: 139080738,
        bfId: "261018:6766",
      },
    },
    { cmd: "payload_enterbfresp" },
  );
  assert.equal(state.myRoleId, 139080738);
  assert.equal(getMyRole(state)?.state, "watching");

  // 21号战士（139084096，同战场别人）的 setbattleteamresp 广播
  applyPantaoFrame(
    state,
    {
      body: {
        bf: { roles: { "139084096": { state: "idle", power: 2 } } },
        roleId: 139084096,
        bfId: "261018:6766",
      },
    },
    { cmd: "payload_setbattleteamresp" },
  );

  // 🔴 修复点：myRoleId 不被广播劫持
  assert.equal(state.myRoleId, 139080738);
  // 自己仍是 watching（未登场）——setBattleTeam 的 waitForState 必须继续等/超时
  assert.equal(getMyRole(state)?.state, "watching");
  // 广播者的 role 正常并入战场快照（不丢数据）
  assert.equal(state.bf.roles["139084096"]?.state, "idle");
});

test("myRoleId 为空时仍允许首帧补齐（向后兼容）", () => {
  const state = createPantaoState({ bfId: "261018:6766", myRoleId: 0 });
  applyPantaoFrame(
    state,
    { body: { bf: { roles: { "42": { state: "watching" } } }, roleId: 42, bfId: "261018:6766" } },
    { cmd: "payload_enterbfresp" },
  );
  assert.equal(state.myRoleId, 42);
  assert.equal(getMyRole(state)?.state, "watching");
});

test("3000070 错误帧（无 cmd、无 body.roleId）不改变状态只记错误", () => {
  const state = createPantaoState({ bfId: "261018:6869", myRoleId: 625243919 });
  applyPantaoFrame(state, { code: 3000070 }, { cmd: "" });
  assert.equal(state.myRoleId, 625243919);
  assert.equal(state.lastError?.code, 3000070);
});
