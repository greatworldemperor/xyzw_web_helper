/**
 * 日志环形缓冲测试
 *
 * 关键口径（2026-09-30 实测后才加的这个数据结构）：
 * 「写满之后继续进日志」时，保留下来的那些行必须是**同一个对象引用**，
 * 渲染层才能做到只更新真正被覆盖的那一行；一旦整体位移，
 * 1000 行文字会被逐个重写（手机 4x 降频实测 77.5ms/条 → 环形 6.5ms/条）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createLogRing } from "../src/utils/batch/logRing.js";

const mkLog = (message, type = "info") => ({ time: "12:00:00", message, type });

test("未满容量时按时间正序输出", () => {
  const ring = createLogRing(5);
  ring.push(mkLog("a"));
  ring.push(mkLog("b"));
  ring.push(mkLog("c"));
  assert.equal(ring.size, 3);
  assert.deepEqual(
    ring.toArray().map((l) => l.message),
    ["a", "b", "c"],
  );
});

test("写满后继续写入：只丢最早的，保留最新 N 条且顺序正确", () => {
  const ring = createLogRing(3);
  for (const m of ["1", "2", "3", "4", "5"]) ring.push(mkLog(m));
  assert.equal(ring.size, 3);
  assert.deepEqual(
    ring.toArray().map((l) => l.message),
    ["3", "4", "5"],
  );
});

test("核心：溢出后保留下来的行保持同一对象引用（不是一个新数组的新对象）", () => {
  const ring = createLogRing(3);
  const before = [mkLog("1"), mkLog("2"), mkLog("3")];
  before.forEach((l) => ring.push(l));

  const kept = ring.toArray();
  assert.deepEqual(kept, ["1", "2", "3"].map((m, i) => before[i]));

  // 再写一条：2、3 应该还是原来那两个对象
  ring.push(mkLog("4"));
  const after = ring.toArray();
  assert.deepEqual(
    after.map((l) => l.message),
    ["2", "3", "4"],
  );
  assert.equal(after[0], before[1], "第 2 行必须仍是同一个对象引用");
  assert.equal(after[1], before[2], "第 3 行必须仍是同一个对象引用");
  assert.notEqual(after[2], before[0]);
});

test("每条日志分配稳定且唯一的 id（渲染层做 :key 用）", () => {
  const ring = createLogRing(3);
  const a = mkLog("a");
  const b = mkLog("b");
  ring.push(a);
  ring.push(b);
  ring.push(mkLog("c"));
  ring.push(mkLog("d")); // 覆盖 a，分配的 id 不应复用
  const ids = ring.toArray().map((l) => l.id);
  assert.equal(new Set(ids).size, 3, "id 必须互不相同");
  assert.equal(b.id, ring.toArray()[0].id, "留存行的 id 不能被改写");
});

test("errorCount 随覆盖自动加减，不需要每次全量遍历", () => {
  const ring = createLogRing(3);
  ring.push(mkLog("e1", "error"));
  ring.push(mkLog("i1", "info"));
  assert.equal(ring.errorCount, 1);

  ring.push(mkLog("e2", "error"));
  assert.equal(ring.errorCount, 2);

  ring.push(mkLog("i2", "info")); // 覆盖最早的错误行
  assert.equal(ring.errorCount, 1);
  assert.deepEqual(
    ring.toArray().map((l) => l.type),
    ["info", "error", "info"],
  );

  ring.clear();
  assert.equal(ring.errorCount, 0);
  assert.equal(ring.size, 0);
});

test("version 每次写入自增（用来驱动 computed 失效）", () => {
  const ring = createLogRing(2);
  const v0 = ring.version;
  ring.push(mkLog("a"));
  assert.equal(ring.version, v0 + 1);
  ring.push(mkLog("b"));
  assert.equal(ring.version, v0 + 2);
});

test("setMax 缩容保留最新 N 条，扩容保留全部", () => {
  const ring = createLogRing(5);
  for (const m of ["1", "2", "3", "4", "5"]) ring.push(mkLog(m));

  ring.setMax(2);
  assert.equal(ring.capacity, 2);
  assert.deepEqual(
    ring.toArray().map((l) => l.message),
    ["4", "5"],
  );

  ring.setMax(4);
  ring.push(mkLog("6"));
  assert.deepEqual(
    ring.toArray().map((l) => l.message),
    ["4", "5", "6"],
  );
  assert.equal(ring.size, 3);
});

test("setMax 后 errorCount 仍然正确", () => {
  const ring = createLogRing(4);
  ring.push(mkLog("e", "error"));
  ring.push(mkLog("i", "info"));
  ring.push(mkLog("e2", "error"));
  ring.push(mkLog("i2", "info"));
  assert.equal(ring.errorCount, 2);

  ring.setMax(2); // 只留最后两条：e2 + i2
  assert.equal(ring.errorCount, 1);
});

test("clear 后可以继续写入", () => {
  const ring = createLogRing(2);
  ring.push(mkLog("a"));
  ring.clear();
  ring.push(mkLog("b"));
  assert.deepEqual(
    ring.toArray().map((l) => l.message),
    ["b"],
  );
});

test("非对象入参兜底，不抛错", () => {
  const ring = createLogRing(2);
  ring.push("纯字符串日志");
  assert.equal(ring.toArray()[0].message, "纯字符串日志");
});

test("模拟 1000 行满载后继续写 300 条：容量恒定、顺序正确、引用稳定", () => {
  const ring = createLogRing(1000);
  const all = [];
  for (let i = 0; i < 1000; i += 1) {
    const l = mkLog(`line-${i}`, i % 17 === 0 ? "error" : "info");
    all.push(l);
    ring.push(l);
  }
  assert.equal(ring.size, 1000);

  const idsBefore = new Set(ring.toArray().map((l) => l.id));
  for (let i = 1000; i < 1300; i += 1) ring.push(mkLog(`line-${i}`));

  const view = ring.toArray();
  assert.equal(ring.size, 1000, "容量必须恒定");
  assert.equal(view[0].message, "line-300");
  assert.equal(view[999].message, "line-1299");

  const survivors = view.filter((l) => idsBefore.has(l.id));
  assert.equal(survivors.length, 700, "最早的 300 条被覆盖，其余 700 条应是同一批对象");
  assert.equal(all[300], view[0], "留存首行必须是原对象引用");
});
