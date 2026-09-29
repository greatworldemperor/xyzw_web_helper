import test from "node:test";
import assert from "node:assert/strict";

import {
  clearStudyStatusStore,
  getStudyStatus,
  patchStudyStatus,
  resetStudyStatus,
  waitStudyFinish,
} from "../src/utils/studyStatusStore.js";

test.beforeEach(() => {
  clearStudyStatusStore();
});

test("不同 tokenId 的状态互相隔离，不会覆盖", () => {
  resetStudyStatus("A");
  resetStudyStatus("B");

  patchStudyStatus("A", { status: "answering", questionCount: 10 });
  patchStudyStatus("B", { status: "claiming_rewards" });

  assert.equal(getStudyStatus("A").status, "answering");
  assert.equal(getStudyStatus("A").questionCount, 10);
  assert.equal(getStudyStatus("B").status, "claiming_rewards");
  assert.equal(getStudyStatus("B").questionCount, 0);

  // A 完成后不影响 B
  patchStudyStatus("A", { status: "completed" });
  assert.equal(getStudyStatus("A").status, "completed");
  assert.equal(getStudyStatus("B").status, "claiming_rewards");
});

test("waitStudyFinish 在 completed 时 resolve，且只唤醒对应 token 的等待者", async () => {
  resetStudyStatus("A");
  resetStudyStatus("B");

  const waitA = waitStudyFinish("A", 2000);
  const waitB = waitStudyFinish("B", 2000);

  patchStudyStatus("A", { status: "claiming_rewards" });
  patchStudyStatus("A", { status: "completed", answeredCount: 10, questionCount: 10 });

  const statusA = await waitA;
  assert.equal(statusA.status, "completed");
  assert.equal(statusA.answeredCount, 10);

  // B 仍未结束
  assert.equal(getStudyStatus("B").status, "");

  patchStudyStatus("B", { status: "completed" });
  const statusB = await waitB;
  assert.equal(statusB.status, "completed");
});

test("failed 会 reject 并带上原因", async () => {
  resetStudyStatus("A");
  const waiting = waitStudyFinish("A", 2000);

  patchStudyStatus("A", { status: "failed", error: "未找到题目列表" });

  await assert.rejects(waiting, (error) => {
    assert.equal(error.message, "未找到题目列表");
    assert.equal(error.studyStatus.status, "failed");
    return true;
  });
});

test("超时会 reject", async () => {
  resetStudyStatus("A");
  const waiting = waitStudyFinish("A", 50);
  await assert.rejects(waiting, /答题超时/);
});

test("reset 会清除终态，并让上一轮遗留的等待者失败", async () => {
  resetStudyStatus("A");
  const stale = waitStudyFinish("A", 5000);

  resetStudyStatus("A");

  await assert.rejects(stale, /已重置/);
  assert.equal(getStudyStatus("A").status, "");
});

test("已完成状态下再 wait 会立即 resolve（不漏唤醒）", async () => {
  resetStudyStatus("A");
  patchStudyStatus("A", { status: "completed" });

  // 模拟批量侧轮询慢了一拍，终态仍在
  const status = await waitStudyFinish("A", 1000);
  assert.equal(status.status, "completed");
});

test("并发 3 个角色按各自节奏完成，互不串台", async () => {
  ["A", "B", "C"].forEach(resetStudyStatus);

  const waits = {
    A: waitStudyFinish("A", 3000),
    B: waitStudyFinish("B", 3000),
    C: waitStudyFinish("C", 3000),
  };

  // 乱序完成：B 先、C 次、A 最后
  patchStudyStatus("B", { status: "completed", answeredCount: 8 });
  patchStudyStatus("C", { status: "completed", answeredCount: 9 });
  patchStudyStatus("A", { status: "completed", answeredCount: 10 });

  const [a, b, c] = await Promise.all([waits.A, waits.B, waits.C]);
  assert.equal(a.answeredCount, 10);
  assert.equal(b.answeredCount, 8);
  assert.equal(c.answeredCount, 9);
});
