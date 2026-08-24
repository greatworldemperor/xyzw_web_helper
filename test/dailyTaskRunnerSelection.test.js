import assert from "node:assert/strict";
import test from "node:test";

import { DailyTaskRunner } from "../src/utils/dailyTaskRunner.js";

const createTokenStore = () => {
  const commands = [];
  const tokenStore = {
    gameTokens: [{ id: "role-1", name: "测试角色" }],
    sendGetRoleInfo: async () => ({
      role: {
        dailyTask: { complete: {} },
        statistics: {},
        statisticsTime: {},
      },
    }),
    sendMessageWithPromise: async (_tokenId, command) => {
      commands.push(command);
      if (command === "presetteam_getinfo") {
        return { presetTeamInfo: { useTeamId: 1 } };
      }
      return {};
    },
  };

  return { tokenStore, commands };
};

test("DailyTaskRunner only queues selected daily tasks", async () => {
  const { tokenStore, commands } = createTokenStore();
  const runner = new DailyTaskRunner(tokenStore, {
    commandDelay: 0,
    taskDelay: 0,
  });

  const result = await runner.run(
    "role-1",
    {},
    { selectedTaskIds: ["daily.share"] },
  );

  assert.equal(result.success, true);
  assert.deepEqual(commands, ["presetteam_getinfo", "system_mysharecallback"]);
});

test("DailyTaskRunner accepts an empty task selection", async () => {
  const { tokenStore, commands } = createTokenStore();
  const runner = new DailyTaskRunner(tokenStore, {
    commandDelay: 0,
    taskDelay: 0,
  });

  const result = await runner.run(
    "role-1",
    {},
    { selectedTaskIds: [] },
  );

  assert.equal(result.success, true);
  assert.deepEqual(commands, ["presetteam_getinfo"]);
});