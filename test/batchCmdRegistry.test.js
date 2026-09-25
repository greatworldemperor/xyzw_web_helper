/**
 * 批量任务命令注册回归测试
 *
 * 根因（2026-09-25 商店购物列表「请求超时」）：
 *   站点 WS 客户端发送帧走 CommandRegistry.build(cmd)，未注册的命令直接 throw
 *   "Unknown cmd"（被 catch 吞掉），帧根本不会发出去 → Promise 只能等到超时。
 *   store_getpurchase / store_setpurchase / autumn_useitem 当时就漏在注册表外。
 *
 * 注册有两种写法：链式 .register("cmd", ...) 和收尾的
 * registry.commands.set("cmd", ...)（如 fight_startareaarena 的专用构建器），
 * 本测试两种都认，静态扫描批量任务代码里所有字面量 cmd 逐一断言已注册。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

// 扫描范围：批量任务模块 + 批量页内联调用
const SCAN_FILES = [
  ...fs
    .readdirSync(path.join(ROOT, "src/utils/batch"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(ROOT, "src/utils/batch", f)),
  path.join(ROOT, "src/views/BatchDailyTasks.vue"),
];

const WS_SRC = fs.readFileSync(
  path.join(ROOT, "src/utils/xyzwWebSocket.js"),
  "utf8",
);

// sendMessageWithPromise(tokenId, "cmd", ...) / sendWithPromise("cmd", ...)
const CMD_RE =
  /(?:sendMessageWithPromise|sendWithPromise)\(\s*[\w.$]+\s*,\s*"([a-z0-9_]+)"/g;

const isRegistered = (cmd) =>
  new RegExp(`\\.register\\(\\s*"${cmd}"\\s*[,)]`).test(WS_SRC) ||
  new RegExp(`commands\\.set\\(\\s*"${cmd}"\\s*,`).test(WS_SRC);

test("批量任务里出现的每个字面量 cmd 都已注册到 CommandRegistry", () => {
  const used = new Map(); // cmd -> [file:line]
  for (const file of SCAN_FILES) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);
    for (const m of src.matchAll(CMD_RE)) {
      const line = src.slice(0, m.index).split("\n").length;
      if (!used.has(m[1])) used.set(m[1], []);
      used.get(m[1]).push(`${rel}:${line}`);
    }
  }
  assert.ok(used.size > 10, `应扫描到足够的命令（实际 ${used.size} 个）`);

  const missing = [...used.keys()].filter((cmd) => !isRegistered(cmd));
  assert.deepEqual(
    missing,
    [],
    `以下命令被批量任务使用但未在 xyzwWebSocket.js 注册（未注册 = 帧发不出去 = 请求超时）:\n` +
      missing.map((c) => `  - ${c}  用于 ${used.get(c).join(", ")}`).join("\n"),
  );
});

test("关键命令显式断言（金鱼/商店自动购买）", () => {
  for (const cmd of [
    "store_getpurchase",
    "store_setpurchase",
    "autumn_useitem",
    "autumn_getrolerank",
  ]) {
    assert.ok(isRegistered(cmd), `${cmd} 未注册`);
  }
});
