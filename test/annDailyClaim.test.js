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
