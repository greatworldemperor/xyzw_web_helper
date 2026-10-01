/**
 * 宝箱周「达标」奖励（4 轮 → 4×珍珠）协议回归测试
 *
 * 价值：这条命令的 body 里有一个**极易写错**的点 ——
 *   `selectRewardsMap` 的 key 在 BON 里是 **整数 5**（`01 05 00 00 00`），
 *   不是字符串 "5"（`05 01 35`）。抓包解码工具把 int key 显示成 `"5"`，
 *   肉眼审查代码（`{ 5: 4 }`）完全看不出问题，但发出去的帧服务端不认。
 *   ⇒ 只有「复现成字节」才是真证据。这里把抓包字节固化下来当哨兵。
 *
 * 证据来源：local-data/misc/clear_inventory.jsonl（2026-09-28 真实客户端抓包，
 *   token 世界国皇帝-0-130301444 @9724服，scheme=x，125 bytes）。
 *   复现脚本：local-data/misc/_verify_weekact.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { g_utils } from "../src/utils/bonProtocol.js";

// ⚠️ `src/utils/xyzwWebSocket.js` 顶部 import 了 vite 别名 `@/stores`，裸 node 解析不了。
//    先装项目自带的别名钩子（local-data/_alias_loader.mjs）再动态 import，
//    这样 `node --test test/*.test.js` 这条标准命令仍能整体跑通。
await import("../local-data/_alias_loader.mjs");
const { CommandRegistry, registerDefaultCommands } = await import(
  "../src/utils/xyzwWebSocket.js"
);

/** 抓包里的原始 body（BON 明文，42 bytes） */
const CAPTURED_BODY_HEX =
  "080205037479700102000000051073656c656374526577617264734d6170080101050000000104000000";

/** 抓包整帧明文（解密后，121 bytes）—— 用于验证外框 */
const CAPTURED_FRAME_HEX =
  "0805050361636b01000000000504626f6479072a080205037479700102000000051073656c656374" +
  "526577617264734d6170080101050000000104000000050474696d65022bc373e8a0010000050373" +
  "657101270000000503636d64051b61637469766974795f636c61696d7765656b6163747265776172" +
  "64";

const toHex = (u8) => Buffer.from(u8).toString("hex");

const buildRegistry = () => {
  const reg = new CommandRegistry(g_utils, null);
  registerDefaultCommands(reg);
  return reg;
};

test("activity_claimweekactreward 已注册（未注册 = 帧发不出去 = 请求超时）", () => {
  const reg = buildRegistry();
  assert.ok(
    reg.commands.has("activity_claimweekactreward"),
    "activity_claimweekactreward 必须在 registerDefaultCommands 里注册",
  );
});

test("activity_claimweekactreward 默认 body 逐字节复现抓包（Map 整数键）", () => {
  const reg = buildRegistry();
  const build = reg.commands.get("activity_claimweekactreward");
  const { body } = build(0, 39, {});
  assert.equal(
    toHex(body),
    CAPTURED_BODY_HEX,
    "body 必须与抓包逐字节一致（selectRewardsMap 的 key 是 BON 整数，必须用 Map）",
  );
});

test("selectRewardsMap 用对象字面量写会编码成字符串键（反例哨兵）", () => {
  // 这条不是测生产代码，而是把「错误写法」的字节差别固化下来，
  // 让后来改代码的人一眼看到为什么不能用 { 5: 4 }。
  const wrong = g_utils.bon.encode({ typ: 2, selectRewardsMap: { 5: 4 } });
  const right = g_utils.bon.encode({
    typ: 2,
    selectRewardsMap: new Map([[5, 4]]),
  });
  assert.notEqual(toHex(wrong), CAPTURED_BODY_HEX);
  assert.equal(toHex(right), CAPTURED_BODY_HEX);
  // 差异点：字符串 "5" = 05 01 35；整数 5 = 01 05 00 00 00
  assert.ok(toHex(wrong).includes("050135"), "对象键写法应产出 05 01 35");
  assert.ok(toHex(right).includes("0105000000"), "Map 写法应产出 01 05 00 00 00");
});

test("activity_claimweekactreward 整帧逐字节复现抓包", () => {
  const reg = buildRegistry();
  const build = reg.commands.get("activity_claimweekactreward");
  // 抓包：seq=39, time=1790606295851, ack=0
  const frame = build(0, 39, {});
  frame.time = 1790606295851;
  const plain = g_utils.bon.encode({
    ack: frame.ack,
    body: frame.body,
    time: frame.time,
    seq: frame.seq,
    cmd: frame.cmd,
  });
  assert.equal(
    toHex(plain),
    CAPTURED_FRAME_HEX,
    "整帧明文必须与抓包逐字节一致",
  );
});
