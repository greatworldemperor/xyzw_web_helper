/**
 * 周年庆每日奖励（临时活动）协议常量回归测试
 *
 * 证据：local-data/ann_daily/（2026-10-16 HttpCanary wss 抓包，_decode.mjs 解码）
 *   - 请求体实测 {actId:2610169, missionId:261016901 / 261016903 / 261016905}
 *   - 响应 taskClaimed 快照证实序号 01~05 为每日奖励（06+ 进度为 0）
 * 命令注册/响应映射见 src/utils/xyzwWebSocket.js（activity_warordertaskclaim）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANN_DAILY_ACT_ID,
  ANN_DAILY_MISSION_IDS,
  ANN_DAILY_MISSION_SEQS,
  createTasksAnnDaily,
} from "../src/utils/batch/tasksAnnDaily.js";

test("周年庆每日奖励：actId 与抓包一致（2610169）", () => {
  assert.equal(ANN_DAILY_ACT_ID, 2610169);
});

test("周年庆每日奖励：共 5 个奖励（序号 01~05）", () => {
  assert.deepEqual([...ANN_DAILY_MISSION_SEQS], [1, 2, 3, 4, 5]);
  assert.equal(ANN_DAILY_MISSION_IDS.length, 5);
});

test("周年庆每日奖励：missionId = actId×100 + 序号，与抓包请求逐条一致", () => {
  assert.deepEqual([...ANN_DAILY_MISSION_IDS], [
    261016901, 261016902, 261016903, 261016904, 261016905,
  ]);
  // 抓包里实际出现过的三条领取请求
  for (const id of [261016901, 261016903, 261016905]) {
    assert.ok(ANN_DAILY_MISSION_IDS.includes(id), `缺少抓包实证的 ${id}`);
  }
});

test("批量：单个序号硬失败不短路后面的序号（master：每天分几次领）", async () => {
  const commands = [];
  const logs = [];
  const tasks = createTasksAnnDaily({
    selectedTokens: { value: ["token-1"] },
    tokens: { value: [{ id: "token-1", name: "测试角色" }] },
    tokenStatus: { value: {} },
    isRunning: { value: false },
    shouldStop: { value: false },
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 1 },
    batchSettings: { maxActive: 1 },
    reconnectWithFreshToken: async () => {},
    tokenStore: {
      async sendMessageWithPromise(_tokenId, command, body) {
        commands.push({ command, body });
        if (command !== "activity_warordertaskclaim") return {};
        // 序号 02 硬失败（未分类错误），其余成功
        if (String(body.missionId).slice(-2) === "02") {
          throw new Error("某种未知错误");
        }
        return { reward: [{ type: 3, itemId: 5290, value: 1 }] };
      },
      closeWebSocketConnection() {},
    },
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {} },
    currentRunningTokenId: { value: null },
  });

  await tasks.batchAnnDailyClaim();

  // 5 个序号全部发过（02 失败后 03/04/05 照发）
  assert.deepEqual(
    commands.filter((c) => c.command === "activity_warordertaskclaim").map((c) => c.body.missionId),
    [261016901, 261016902, 261016903, 261016904, 261016905],
  );
  // 硬失败让账号状态可见，但 01/03/04/05 都领到了
  assert.equal(logs.filter((l) => l.message.includes("领取成功")).length, 4);
  assert.ok(logs.some((l) => l.message.includes("02 领取失败") && l.message.includes("继续领下一个")));
});

test("批量：200020（当前不可领）= 良性跳过不算失败", async () => {
  const commands = [];
  const logs = [];
  const tasks = createTasksAnnDaily({
    selectedTokens: { value: ["token-1"] },
    tokens: { value: [{ id: "token-1", name: "测试角色" }] },
    tokenStatus: { value: {} },
    isRunning: { value: false },
    shouldStop: { value: false },
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 1 },
    batchSettings: { maxActive: 1 },
    reconnectWithFreshToken: async () => {},
    tokenStore: {
      async sendMessageWithPromise(_tokenId, command, body) {
        commands.push({ command, body });
        if (command !== "activity_warordertaskclaim") return {};
        // 复刻 wss-diag 实证：200020「出了点小问题」
        throw Object.assign(new Error("服务器错误: 200020 - 出了点小问题，请尝试重启游戏解决～"), { code: 200020 });
      },
      closeWebSocketConnection() {},
    },
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {} },
    currentRunningTokenId: { value: null },
  });

  await tasks.batchAnnDailyClaim();

  assert.equal(commands.filter((c) => c.command === "activity_warordertaskclaim").length, 5);
  assert.equal(logs.filter((l) => l.message.includes("200020")).length, 5);
  // 全部 benign 跳过 ⇒ 账号 completed 而非 failed
  assert.equal(logs.filter((l) => l.type === "error").length, 0);
});
