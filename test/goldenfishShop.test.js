/**
 * 金鱼商店购物列表（store_getpurchase / store_setpurchase）回归测试
 *
 * 协议来源：local-data/goldenfish/shop_list.jsonl（2026-09-25 抓包）。
 * 核心断言：用「金鱼模式」默认配置经 bon.encode 构造的 store_setpurchase 内层 body，
 * 与 master 当日手工设置的抓包帧（#525，青铜5/黄金5/铂金8/招募令10/黄金鱼竿8）
 * 逐字节一致 —— 请求体结构/字段序/折扣编码全部回归锁定。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  GOLDENFISH_SHOP_DEFAULTS,
  buildShopPurchaseItems,
} from "../src/utils/batch/tasksGoldenfish.js";
import { bon } from "../src/utils/bonProtocol.js";

const CAPTURE =
  "local-data/goldenfish/shop_list.jsonl";

/** px（x 方案）帧解密：保留原 4 字节头，数据段 XOR 8bit key */
function xDecrypt(input) {
  const e = Uint8Array.from(input);
  const key =
    (((e[2] >> 6) & 1) << 7) |
    (((e[2] >> 4) & 1) << 6) |
    (((e[2] >> 2) & 1) << 5) |
    ((e[2] & 1) << 4) |
    (((e[3] >> 6) & 1) << 3) |
    (((e[3] >> 4) & 1) << 2) |
    (((e[3] >> 2) & 1) << 1) |
    (e[3] & 1);
  for (let n = e.length; --n >= 4;) e[n] ^= key;
  return e.subarray(4);
}

const hexToBytes = (hex) => {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

const toHex = (u8) => Buffer.from(u8).toString("hex");

/** 从抓包 jsonl 里取指定 seq 的 store_setpurchase 发送帧内层 body 字节 */
function capturedSetPurchaseBody(seq) {
  const lines = fs
    .readFileSync(CAPTURE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const d = o.payload?.decoded;
    if (o.event !== "ws:send" || d?.cmd !== "store_setpurchase") continue;
    if (d?.seq !== seq) continue;
    const frame = o.payload.frame;
    const hex =
      frame.rawHex && frame.rawHex.length >= frame.byteLength * 2
        ? frame.rawHex
        : frame.headHex;
    assert.equal(
      hex.length,
      frame.byteLength * 2,
      "抓包帧完整才可做逐字节回归",
    );
    const root = bon.decode(xDecrypt(hexToBytes(hex)));
    assert.equal(root.cmd, "store_setpurchase");
    return root.body;
  }
  throw new Error(`抓包中未找到 seq=${seq} 的 store_setpurchase 帧`);
}

test("金鱼模式默认配置：构造的 setpurchase body 与抓包 #525 逐字节一致", () => {
  const items = buildShopPurchaseItems({ items: GOLDENFISH_SHOP_DEFAULTS });
  assert.deepEqual(
    items.map((it) => [it.itemId, it.discount]),
    [
      [2002, 5],
      [2003, 5],
      [2004, 8],
      [1001, 10],
      [1012, 8],
    ],
    "金鱼模式口径：青铜5/黄金5/铂金8/招募令10/黄金鱼竿8",
  );
  const built = bon.encode({ purchaseCnt: 15, purchaseItemList: items });
  const captured = capturedSetPurchaseBody(45);
  assert.equal(toHex(built), toHex(captured));
});

test("buildShopPurchaseItems：未启用/非法折扣/非法 itemId 被剔除", () => {
  const items = buildShopPurchaseItems({
    items: [
      { itemId: 2002, discount: 5, enabled: true },
      { itemId: 2003, discount: 5, enabled: false }, // 未启用 → 剔除
      { itemId: 2004, discount: 0, enabled: true }, // 折扣<1 → 剔除
      { itemId: 1001, discount: 11, enabled: true }, // 折扣>10 → 剔除
      { itemId: 1012, discount: 7.9, enabled: true }, // 非整数折 → floor 后保留
      { itemId: null, discount: 5, enabled: true }, // itemId 非法 → 剔除
      { itemId: 9999, discount: 5, enabled: true }, // 未知商品不拦（itemId 合法即下发）
    ],
  });
  assert.deepEqual(items, [
    { itemId: 2002, discount: 5 },
    { itemId: 1012, discount: 7 },
    { itemId: 9999, discount: 5 },
  ]);
});

test("buildShopPurchaseItems：null/非数组配置安全返回空", () => {
  assert.deepEqual(buildShopPurchaseItems(null), []);
  assert.deepEqual(buildShopPurchaseItems({ items: null }), []);
  assert.deepEqual(buildShopPurchaseItems("x"), []);
});
