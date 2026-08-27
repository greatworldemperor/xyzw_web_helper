import assert from "node:assert/strict";
import { test } from "node:test";

import { createTasksTower } from "../src/utils/batch/tasksTower.js";
import { getTowerActId } from "../src/utils/towerActId.js";

test("skinChallenge reports exhausted 400340 retries explicitly", async () => {
  const selectedTokens = { value: ["token-1"] };
  const tokens = { value: [{ id: "token-1", name: "测试角色" }] };
  const tokenStatus = { value: {} };
  const isRunning = { value: false };
  const shouldStop = { value: false };
  const currentRunningTokenId = { value: null };
  const logs = [];

  const tokenStore = {
    async sendMessageWithPromise(_tokenId, command) {
      if (command === "towers_start") {
        throw new Error("服务器错误: 400340 - 未知错误");
      }

      return {
        actId: getTowerActId(),
        levelRewardMap: {},
      };
    },
    closeWebSocketConnection() {},
  };

  const tasks = createTasksTower({
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 1 },
    batchSettings: { maxActive: 1 },
    tokenStore,
    addLog: (entry) => logs.push(entry),
    message: { success: () => {} },
    currentRunningTokenId,
  });

  await tasks.skinChallenge();

  assert.equal(tokenStatus.value["token-1"], "failed");
  assert.equal(
    logs.some((entry) =>
      entry.message.includes("触发400340限流，已按每秒重试100次仍失败"),
    ),
    true,
  );
});

test("smart item handling claims first and alternates use with merge", async () => {
  const commands = [];
  let mergeInfoCalls = 0;
  let towerInfoCalls = 0;
  let openBoxCalls = 0;
  const selectedTokens = { value: ["token-1"] };
  const tokens = { value: [{ id: "token-1", name: "测试角色" }] };
  const tokenStatus = { value: {} };
  const isRunning = { value: false };
  const shouldStop = { value: false };
  const currentRunningTokenId = { value: null };
  const pairGrid = {
    1: {
      1: { gridConfId: 0, gridItemId: 1001, isLock: false },
      2: { gridConfId: 0, gridItemId: 1001, isLock: false },
    },
  };

  const tokenStore = {
    async sendMessageWithPromise(_tokenId, command) {
      commands.push(command);

      if (command === "mergebox_getinfo") {
        mergeInfoCalls++;
        if (mergeInfoCalls === 1) {
          return { mergeBox: { freeEnergy: 1 } };
        }
        if (mergeInfoCalls === 2) {
          return { mergeBox: { costTotalCnt: 0 } };
        }
        if (mergeInfoCalls === 3 || mergeInfoCalls === 6) {
          return { mergeBox: { gridMap: pairGrid, taskMap: {} } };
        }
        if (mergeInfoCalls === 5) {
          return { mergeBox: { costTotalCnt: 1 } };
        }
        return { mergeBox: { gridMap: {}, taskMap: {} } };
      }

      if (command === "evotower_getinfo") {
        towerInfoCalls++;
        return { evoTower: { lotteryLeftCnt: towerInfoCalls === 1 ? 2 : 1 } };
      }

      if (command === "mergebox_openbox") {
        openBoxCalls++;
        if (openBoxCalls === 2) {
          throw new Error("服务器错误: 12300040 - 没有空格子了");
        }
      }

      return { ok: true };
    },
    closeWebSocketConnection() {},
  };

  const tasks = createTasksTower({
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 0 },
    batchSettings: { maxActive: 1 },
    tokenStore,
    addLog: () => {},
    message: { success: () => {} },
    currentRunningTokenId,
  });

  await tasks.batchSmartItemHandling();

  assert.equal(tokenStatus.value["token-1"], "completed");
  assert.deepEqual(
    commands.filter((command) =>
      [
        "mergebox_claimfreeenergy",
        "mergebox_openbox",
        "mergebox_mergeitem",
      ].includes(command),
    ),
    [
      "mergebox_claimfreeenergy",
      "mergebox_openbox",
      "mergebox_openbox",
      "mergebox_mergeitem",
      "mergebox_openbox",
      "mergebox_mergeitem",
    ],
  );
});