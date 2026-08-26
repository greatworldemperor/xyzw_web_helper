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