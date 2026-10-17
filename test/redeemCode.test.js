/**
 * 批量兑换码（system_claimcdkreward）回归测试
 *
 * 协议证据：local-data/misc/redemption_code.jsonl（2026-10-17 master 手工兑换
 * wuzhounian2026 抓包，SEND 帧逐字节复现精确）：
 *   请求 body = { key: "<兑换码>", platformType: "h5" } → 响应 SyncRewardResp
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { parseRedeemCodes } from "../src/utils/batch/tasksRedeemCode.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const WS_SRC = fs.readFileSync(
  path.join(ROOT, "src/utils/xyzwWebSocket.js"),
  "utf8",
);

test("parseRedeemCodes：按换行分割、trim、滤空行", () => {
  assert.deepEqual(parseRedeemCodes("wuzhounian2026\nxyzw666\n"), [
    "wuzhounian2026",
    "xyzw666",
  ]);
  assert.deepEqual(parseRedeemCodes("  a \n\n  b\t\n c  "), ["a", "b", "c"]);
  assert.deepEqual(parseRedeemCodes("\r\n\r\n"), []);
});

test("parseRedeemCodes：兼容空格/逗号/分号（中英文）混合分割", () => {
  assert.deepEqual(parseRedeemCodes("a b,c；d，e;f"), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(parseRedeemCodes("a,,b, ,c"), ["a", "b", "c"]);
});

test("parseRedeemCodes：去重保序、大小写敏感", () => {
  assert.deepEqual(parseRedeemCodes("b\na\nb\nA\na"), ["b", "a", "A"]);
  // 大小写是兑换码的一部分，不得互相合并
  assert.deepEqual(parseRedeemCodes("ABC\nabc"), ["ABC", "abc"]);
});

test("parseRedeemCodes：非法输入安全兜底", () => {
  assert.deepEqual(parseRedeemCodes(""), []);
  assert.deepEqual(parseRedeemCodes(null), []);
  assert.deepEqual(parseRedeemCodes(undefined), []);
  assert.deepEqual(parseRedeemCodes(123), []);
});

test("system_claimcdkreward 已注册（未注册 = 帧发不出去 = 请求超时）", () => {
  assert.ok(
    /\.register\(\s*"system_claimcdkreward"/.test(WS_SRC),
    "system_claimcdkreward 未在 registerDefaultCommands 注册",
  );
});

test("system_claimcdkreward 默认 body 口径与抓包一致", () => {
  const m = WS_SRC.match(
    /\.register\(\s*"system_claimcdkreward"\s*,\s*(\{[^}]*\})\s*\)/,
  );
  assert.ok(m, "未找到 system_claimcdkreward 的默认 body");
  const defaults = JSON.parse(
    m[1].replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":'),
  );
  assert.deepEqual(defaults, { key: "", platformType: "h5" });
});

test("SyncRewardResp 响应映射包含 system_claimcdkreward", () => {
  // responseToCommandMap 的 syncrewardresp 数组是请求 cmd 的归属表（小写 key）。
  // 注：数组元素间有中文注释（含 reward[] 字样），正则取「到 ], 为止」避开注释里的孤立 ]
  const m = WS_SRC.match(/syncrewardresp:\s*\[([\s\S]*?)\],/);
  assert.ok(m, "未找到 syncrewardresp 响应映射");
  assert.ok(
    m[1].includes('"system_claimcdkreward"'),
    "syncrewardresp 响应映射未包含 system_claimcdkreward",
  );
});
