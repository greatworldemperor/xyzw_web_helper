import assert from "node:assert/strict";
import test from "node:test";

import { createTasksXianMaster } from "../src/utils/batch/tasksXianMaster.js";

function createFixture() {
  const selectedTokens = { value: ["account-a", "account-b", "account-c"] };
  const tokens = {
    value: [
      { id: "account-a", name: "账号A", roleId: 1001 },
      { id: "account-b", name: "账号B", roleId: 1002 },
      { id: "account-c", name: "账号C", roleId: 1003 },
      { id: "existing-boss", name: "已添加咸主", roleId: 9001 },
    ],
  };
  const responses = {
    "account-a": { role: { roleId: 1001, bossId: 9001 } },
    "account-b": { role: { roleId: 1002, bossId: 9002 } },
    "account-c": { role: { roleId: 1003, bossId: 0 } },
  };
  const tokenStatus = { value: {} };
  const isRunning = { value: false };
  const shouldStop = { value: false };
  const currentRunningTokenId = { value: null };
  const connectionQueue = { active: 1 };
  const commands = [];
  const logs = [];

  const task = createTasksXianMaster({
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue,
    batchSettings: { maxActive: 3 },
    tokenStore: {
      gameTokens: tokens.value,
      closeWebSocketConnection: async () => {},
    },
    sendRoleInfo: async (tokenId) => {
      commands.push(tokenId);
      return responses[tokenId];
    },
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {} },
    currentRunningTokenId,
  });

  return { task, tokenStatus, isRunning, commands, logs };
}

test("detectXianMasters ignores a boss already in the full token list", async () => {
  const fixture = createFixture();

  const summary = await fixture.task.detectXianMasters(false);

  assert.deepEqual(summary, {
    detected: 1,
    detectedRoles: [
      {
        tokenId: "account-b",
        tokenName: "账号B",
        roleId: "1002",
        roleName: "账号B",
        bossId: "9002",
        bossName: "",
      },
    ],
    ignored: 1,
    withoutBoss: 1,
    failed: 0,
  });
  assert.deepEqual(fixture.commands.sort(), ["account-a", "account-b", "account-c"]);
  assert.equal(fixture.tokenStatus.value["account-a"], "completed");
  assert.equal(fixture.isRunning.value, false);
  assert.equal(
    fixture.logs.some((entry) => entry.message.includes("已在 Token 列表中")),
    true,
  );
});

test("detectXianMasters includes an existing boss when requested", async () => {
  const fixture = createFixture();

  const summary = await fixture.task.detectXianMasters(true);

  assert.deepEqual(summary, {
    detected: 2,
    detectedRoles: [
      {
        tokenId: "account-a",
        tokenName: "账号A",
        roleId: "1001",
        roleName: "账号A",
        bossId: "9001",
        bossName: "",
      },
      {
        tokenId: "account-b",
        tokenName: "账号B",
        roleId: "1002",
        roleName: "账号B",
        bossId: "9002",
        bossName: "",
      },
    ],
    ignored: 0,
    withoutBoss: 1,
    failed: 0,
  });
});