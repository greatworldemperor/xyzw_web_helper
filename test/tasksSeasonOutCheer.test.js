/**
 * 批量「赛季淘汰赛助威」任务回归测试
 *
 * 协议行为锚点来自真实抓包 local-data/tiangong_vote/vote.jsonl：
 *   - 前置 saltroad_getseasonoutrank 返回非空 legionList（活跃）；
 *   - saltroad_outcheer { legionId } 成功回 SyncResp，statistics 带 sr:out:cheer:<phase>；
 *   - 失败走错误信封（无 cmd 无 body，带 resp）→ Promise reject。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTasksSeasonOutCheer } from "../src/utils/batch/tasksSeasonOutCheer.js";

const createDeps = (overrides = {}) => {
  const logs = [];
  const sentCommands = [];
  const base = {
    selectedTokens: { value: ["token-1"] },
    tokens: { value: [{ id: "token-1", name: "测试角色" }] },
    tokenStatus: { value: {} },
    isRunning: { value: false },
    shouldStop: { value: false },
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 0 },
    batchSettings: { maxActive: 2 },
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {} },
    currentRunningTokenId: { value: null },
    tokenStore: {
      async sendMessageWithPromise(_tokenId, command, params) {
        sentCommands.push({ command, params });
        return {};
      },
      async closeWebSocketConnection() {},
    },
  };
  return { deps: { ...base, ...overrides }, logs, sentCommands };
};

test("助威全流程：先探活跃再投票，读 SyncResp statistics 判定成功", async () => {
  const { deps, logs, sentCommands } = createDeps({
    tokenStore: {
      async sendMessageWithPromise(_tokenId, command) {
        sentCommands.push(command);
        if (command === "saltroad_getseasonoutrank") {
          return { round: 2, legionList: [{ id: 942724, sOWinCnt: 1 }] };
        }
        return {
          role: { statistics: { "sr:out:cheer:261003": 942724 } },
        };
      },
      async closeWebSocketConnection() {},
    },
  });

  const tasks = createTasksSeasonOutCheer(deps);
  await tasks.batchSeasonOutCheer(942724);

  assert.deepEqual(sentCommands, [
    "saltroad_getseasonoutrank",
    "saltroad_outcheer",
  ]);
  assert.equal(deps.tokenStatus.value["token-1"], "completed");
  assert.equal(
    logs.some((entry) => entry.message.includes("淘汰赛助威成功")),
    true,
  );
  assert.equal(deps.isRunning.value, false);
});

test("outcheer 请求体的 legionId 必须是 number（BON Int tag）", async () => {
  const bodies = [];
  const { deps } = createDeps({
    tokenStore: {
      async sendMessageWithPromise(_tokenId, command, params) {
        bodies.push({ command, params });
        if (command === "saltroad_getseasonoutrank") {
          return { round: 2, legionList: [{ id: 1 }] };
        }
        return { role: { statistics: { "sr:out:cheer:261003": 378071 } } };
      },
      async closeWebSocketConnection() {},
    },
  });

  const tasks = createTasksSeasonOutCheer(deps);
  await tasks.batchSeasonOutCheer("378071"); // 字符串入参也要转成 number 发出

  assert.deepEqual(bodies[1], {
    command: "saltroad_outcheer",
    params: { legionId: 378071 },
  });
  assert.equal(typeof bodies[1].params.legionId, "number");
});

test("排行名单为空 ⇒ 判定不在进行中，跳过且不发 outcheer", async () => {
  const { deps, logs, sentCommands } = createDeps({
    tokenStore: {
      async sendMessageWithPromise(_tokenId, command) {
        sentCommands.push(command);
        return { round: 0, legionList: [] };
      },
      async closeWebSocketConnection() {},
    },
  });

  const tasks = createTasksSeasonOutCheer(deps);
  await tasks.batchSeasonOutCheer(942724);

  assert.deepEqual(sentCommands, ["saltroad_getseasonoutrank"]);
  assert.equal(deps.tokenStatus.value["token-1"], "completed");
  assert.equal(
    logs.some((entry) => entry.message.includes("未在进行中")),
    true,
  );
});

test("已助威过的服务端错误 ⇒ 记 completed 不算失败", async () => {
  const { deps, logs } = createDeps({
    tokenStore: {
      async sendMessageWithPromise(_tokenId, command) {
        if (command === "saltroad_getseasonoutrank") {
          return { round: 2, legionList: [{ id: 1 }] };
        }
        const error = new Error("服务器错误: 12200100 - 本届已助威过");
        error.code = 12200100;
        error.error = "本届已助威过";
        throw error;
      },
      async closeWebSocketConnection() {},
    },
  });

  const tasks = createTasksSeasonOutCheer(deps);
  await tasks.batchSeasonOutCheer(942724);

  assert.equal(deps.tokenStatus.value["token-1"], "completed");
  assert.equal(
    logs.some((entry) => entry.message.includes("本届已助威过")),
    true,
  );
});

test("SyncResp 显示已助威其他俱乐部 ⇒ 记 completed 并提示", async () => {
  const { deps, logs } = createDeps({
    tokenStore: {
      async sendMessageWithPromise(_tokenId, command) {
        if (command === "saltroad_getseasonoutrank") {
          return { round: 2, legionList: [{ id: 1 }] };
        }
        return { role: { statistics: { "sr:out:cheer:261003": 378071 } } };
      },
      async closeWebSocketConnection() {},
    },
  });

  const tasks = createTasksSeasonOutCheer(deps);
  await tasks.batchSeasonOutCheer(942724);

  assert.equal(deps.tokenStatus.value["token-1"], "completed");
  assert.equal(
    logs.some((entry) => entry.message.includes("已助威其他俱乐部")),
    true,
  );
});

test("未登录/未解锁（400000）⇒ 跳过不算失败", async () => {
  const { deps, logs } = createDeps({
    tokenStore: {
      async sendMessageWithPromise(_tokenId, command) {
        if (command === "saltroad_getseasonoutrank") {
          return { round: 2, legionList: [{ id: 1 }] };
        }
        const error = new Error("服务器错误: 400000 - 物品不存在");
        error.code = 400000;
        throw error;
      },
      async closeWebSocketConnection() {},
    },
  });

  const tasks = createTasksSeasonOutCheer(deps);
  await tasks.batchSeasonOutCheer(942724);

  assert.equal(deps.tokenStatus.value["token-1"], "completed");
  assert.equal(
    logs.some((entry) => entry.message.includes("未解锁该功能")),
    true,
  );
});

test(" legionId 缺省 ⇒ 直接告警不跑批", async () => {
  const { deps, sentCommands } = createDeps();
  const warnings = [];
  deps.message = { success: () => {}, warning: (text) => warnings.push(text) };

  const tasks = createTasksSeasonOutCheer(deps);
  await tasks.batchSeasonOutCheer(null);

  assert.deepEqual(sentCommands, []);
  assert.equal(warnings.length, 1);
  assert.equal(deps.isRunning.value, false);
});

test("未选账号 ⇒ 直接告警不跑批", async () => {
  const { deps } = createDeps({ selectedTokens: { value: [] } });
  const warnings = [];
  deps.message = { success: () => {}, warning: (text) => warnings.push(text) };

  const tasks = createTasksSeasonOutCheer(deps);
  await tasks.batchSeasonOutCheer(942724);

  assert.equal(warnings.length, 1);
  assert.equal(deps.isRunning.value, false);
});
