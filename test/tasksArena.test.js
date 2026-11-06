import assert from "node:assert/strict";
import { test } from "node:test";

import { createTasksArena } from "../src/utils/batch/tasksArena.js";

const ARENA_REJECTED = new Error(
  "服务器错误: 200020 - 出了点小问题，请尝试重启游戏解决～",
);

/**
 * 造一个「arena_startarea 必被 200020 拒绝」的批量环境。
 * master 2026-11-06 口径：这类角色属于「不能打的号」，不是「漏打的号」——
 * 必须标 completed（不进失败清单）、一帧都不重试、不再打任何一场，
 * 并且要恢复之前切换过的阵容、正常释放连接槽位。
 */
function makeDeps() {
  const sent = [];
  const logs = [];
  let closed = 0;
  let released = 0;

  const tokenStore = {
    gameData: {
      roleInfo: { role: { items: { 1007: { quantity: 20 } } } },
    },
    async sendMessageWithPromise(_tokenId, cmd, params = {}) {
      sent.push({ cmd, params });
      if (cmd === "arena_startarea") throw ARENA_REJECTED;
      if (cmd === "presetteam_getinfo") {
        return { presetTeamInfo: { useTeamId: 2 } };
      }
      if (cmd === "activity_get") {
        return { activity: { myArenaInfo: { num: 0 } } };
      }
      return { ok: true };
    },
    closeWebSocketConnection() {
      closed += 1;
    },
  };

  const deps = {
    selectedTokens: { value: ["token-1"] },
    tokens: { value: [{ id: "token-1", name: "测试角色" }] },
    tokenStatus: { value: {} },
    isRunning: { value: false },
    shouldStop: { value: false },
    currentRunningTokenId: { value: null },
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {
      released += 1;
    },
    connectionQueue: { active: 1 },
    // 与当前阵容 2 不同 → 会先切换，跳过时必须切回 2
    batchSettings: {
      maxActive: 1,
      arenaFormation: 1,
      smartArenaMode: "lowestPower",
    },
    tokenStore,
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, error: () => {} },
    pickArenaTargetId: () => null,
    calculateMonthProgress: () => 1,
    delayConfig: { battle: 0, action: 0, refresh: 0 },
  };

  return { deps, sent, logs, stats: () => ({ closed, released }) };
}

function assertSkipped({ deps, sent, logs, stats }, label) {
  assert.equal(deps.tokenStatus.value["token-1"], "completed", label);
  assert.equal(
    sent.filter((entry) => entry.cmd === "arena_startarea").length,
    1,
    `${label}: 只发一次入场，绝不重试`,
  );
  assert.equal(
    sent.some((entry) => entry.cmd === "arena_getareatarget"),
    false,
    `${label}: 不再取对手`,
  );
  assert.equal(
    sent.some((entry) => entry.cmd === "fight_startareaarena"),
    false,
    `${label}: 不再打任何一场`,
  );
  const saves = sent.filter((entry) => entry.cmd === "presetteam_saveteam");
  assert.equal(saves.length, 2, `${label}: 切换 + 跳过时恢复`);
  assert.equal(saves[1].params.teamId, 2, `${label}: 恢复原阵容`);
  assert.equal(
    logs.some(
      (entry) =>
        entry.message.includes("跳过") && entry.message.includes("200020"),
    ),
    true,
    `${label}: 日志明确标记跳过原因`,
  );
  assert.equal(
    logs.some((entry) => entry.message.includes("秒后重试")),
    false,
    `${label}: 200020 不等待限流重试`,
  );
  assert.deepEqual(stats(), { closed: 1, released: 1 }, label);
}

test("batcharenafight: 200020 拒绝入场 → 跳过、标 completed、不进失败清单", async () => {
  const env = makeDeps();
  const tasks = createTasksArena(env.deps);

  await tasks.batcharenafight();

  assertSkipped(env, "一键打三次");
});

test("batchTopUpArena / batchSmartTopUpArena: 200020 立即停止补齐，不空转硬打", async () => {
  for (const name of ["batchTopUpArena", "batchSmartTopUpArena"]) {
    const env = makeDeps();
    const tasks = createTasksArena(env.deps);

    await tasks[name]();

    assertSkipped(env, name);
  }
});
