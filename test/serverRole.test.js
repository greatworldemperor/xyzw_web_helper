import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeServerRoleId,
  formatImportedRoleName,
} from "../src/utils/serverRole.js";

test("decodeServerRoleId handles all three role slots", () => {
  assert.deepEqual(decodeServerRoleId(66), {
    serverNumber: 39,
    roleIndex: 0,
  });
  assert.deepEqual(decodeServerRoleId(1000066), {
    serverNumber: 39,
    roleIndex: 1,
  });
  assert.deepEqual(decodeServerRoleId(2000066), {
    serverNumber: 39,
    roleIndex: 2,
  });
});

test("formatImportedRoleName expands the established template variables", () => {
  assert.equal(
    formatImportedRoleName("{server}-{name}-{index}-{id}", {
      name: "测试角色",
      roleId: 123456,
      serverId: 1000066,
    }),
    "39服-测试角色-1-123456",
  );

  assert.equal(
    formatImportedRoleName("{name}-{id}", {
      name: "$&测试",
      roleId: 123456,
      serverId: 66,
    }),
    "$&测试-123456",
  );
});
