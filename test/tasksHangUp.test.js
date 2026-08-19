import assert from "node:assert/strict";
import { test } from "node:test";

import { createTasksHangUp } from "../src/utils/batch/tasksHangUp.js";

test("batchAddHangUpTime refreshes the token after initialization timeout", async () => {
  const selectedTokens = { value: ["token-1"] };
  const tokens = { value: [{ id: "token-1", name: "测试角色" }] };
  const tokenStatus = { value: {} };
  const isRunning = { value: false };
  const shouldStop = { value: false };
  const currentRunningTokenId = { value: null };
  const connectionQueue = { active: 1 };
  const batchSettings = { maxActive: 1, reconnectDelay: 0 };
  const batchResult = {
    completedCount: 0,
    totalCount: 0,
    failedTokenIds: [],
  };
  const showBatchResultModal = { value: false };
  const logs = [];
  const ensureCalls = [];
  const sentCommands = [];
  let shouldFailInitialization = true;

  const tokenStore = {
    async sendMessageWithPromise(_tokenId, command) {
      sentCommands.push(command);
      return { ok: true };
    },
    async closeWebSocketConnection() {},
  };

  const tasks = createTasksHangUp({
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    waitForConnectionSlot: async () => {},
    ensureConnection: async (...args) => {
      ensureCalls.push(args);
      if (shouldFailInitialization) {
        shouldFailInitialization = false;
        throw new Error("请求超时: role_getroleinfo (5000ms)");
      }
    },
    releaseConnectionSlot: () => {},
    connectionQueue,
    batchSettings,
    tokenStore,
    addLog: (entry) => logs.push(entry),
    message: { success: () => {} },
    currentRunningTokenId,
    batchResult,
    showBatchResultModal,
  });

  await tasks.batchAddHangUpTime();

  assert.equal(ensureCalls.length, 2);
  assert.deepEqual(ensureCalls[0], ["token-1", 2, true, true]);
  assert.deepEqual(ensureCalls[1], ["token-1", 2, true, true]);
  assert.equal(
    sentCommands.filter((command) => command === "system_mysharecallback").length,
    4,
  );
  assert.equal(tokenStatus.value["token-1"], "completed");
  assert.equal(batchResult.completedCount, 1);
  assert.deepEqual(batchResult.failedTokenIds, []);
  assert.equal(showBatchResultModal.value, true);
  assert.equal(
    logs.some((entry) => entry.message.includes("等待1秒后重试")),
    true,
  );
});

test("claimHangUpRewards retries 400340 before continuing the task", async () => {
  const selectedTokens = { value: ["token-1"] };
  const tokens = { value: [{ id: "token-1", name: "测试角色" }] };
  const tokenStatus = { value: {} };
  const isRunning = { value: false };
  const shouldStop = { value: false };
  const currentRunningTokenId = { value: null };
  const connectionQueue = { active: 1 };
  const logs = [];
  const commands = [];
  let claimAttempts = 0;

  const tokenStore = {
    async sendMessageWithPromise(_tokenId, command) {
      commands.push(command);
      if (
        command === "system_claimhangupreward" &&
        claimAttempts++ === 0
      ) {
        throw new Error("服务器错误: 400340 - 未知错误");
      }
      return { ok: true };
    },
    async closeWebSocketConnection() {},
  };

  const tasks = createTasksHangUp({
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection: async () => {},
    waitForConnectionSlot: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue,
    batchSettings: { maxActive: 1 },
    tokenStore,
    addLog: (entry) => logs.push(entry),
    message: { success: () => {} },
    currentRunningTokenId,
    batchResult: { completedCount: 0, totalCount: 0, failedTokenIds: [] },
    showBatchResultModal: { value: false },
    delayConfig: { retry: 0 },
  });

  await tasks.claimHangUpRewards();

  assert.equal(
    commands.filter((command) => command === "system_claimhangupreward").length,
    2,
  );
  assert.equal(
    commands.filter((command) => command === "system_mysharecallback").length,
    4,
  );
  assert.equal(tokenStatus.value["token-1"], "completed");
  assert.equal(logs.some((entry) => entry.message.includes("第1/100次")), true);
});

test("claimHangUpRewards retries system claim timeouts before continuing the task", async () => {
  const selectedTokens = { value: ["token-1"] };
  const tokens = { value: [{ id: "token-1", name: "测试角色" }] };
  const tokenStatus = { value: {} };
  const isRunning = { value: false };
  const shouldStop = { value: false };
  const currentRunningTokenId = { value: null };
  const connectionQueue = { active: 1 };
  const logs = [];
  const commands = [];
  let claimAttempts = 0;

  const tokenStore = {
    async sendMessageWithPromise(_tokenId, command) {
      commands.push(command);
      if (
        command === "system_claimhangupreward" &&
        claimAttempts++ === 0
      ) {
        throw new Error("请求超时: system_claimhangupreward (5000ms)");
      }
      return { ok: true };
    },
    async closeWebSocketConnection() {},
  };

  const tasks = createTasksHangUp({
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection: async () => {},
    waitForConnectionSlot: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue,
    batchSettings: { maxActive: 1 },
    tokenStore,
    addLog: (entry) => logs.push(entry),
    message: { success: () => {} },
    currentRunningTokenId,
    batchResult: { completedCount: 0, totalCount: 0, failedTokenIds: [] },
    showBatchResultModal: { value: false },
    delayConfig: { retry: 0 },
  });

  await tasks.claimHangUpRewards();

  assert.equal(
    commands.filter((command) => command === "system_claimhangupreward").length,
    2,
  );
  assert.equal(
    commands.filter((command) => command === "system_mysharecallback").length,
    4,
  );
  assert.equal(tokenStatus.value["token-1"], "completed");
  assert.equal(logs.some((entry) => entry.message.includes("第1/100次")), true);
});