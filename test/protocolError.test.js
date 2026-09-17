import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createServerError,
  describeServerError,
  serverErrorCodeMap,
} from "../src/utils/protocolError.js";

/**
 * 幻塔（EvoTower）助力的两个失败信封，字段逐字节取自抓包：
 *   local-data/weird_tower/share_code_full1.jsonl（发起方已助力过别人）
 *   local-data/weird_tower/share_code_full2.jsonl（被助力方已满 3 次）
 *
 * 注意：失败响应**不带 cmd、不带 body**，只有 code + error，
 * 所以不能走基于 cmd 的匹配路径，只能靠 resp 匹配序号。
 */
const ASSIST_ALREADY_USED = {
  seq: 69,
  ack: 0,
  time: 1789660557392,
  resp: 68,
  code: 12200100,
  error: "本次活动已参与助力，无法助力其他伙伴",
};

const ASSIST_TARGET_FULL = {
  seq: 51,
  ack: 50,
  time: 1789660696956,
  resp: 51,
  code: 12200090,
  error: "对方已到最大助力人数",
};

test("幻塔助力：发起方已用过助力机会（12200100）给出服务端文案", () => {
  assert.equal(
    describeServerError(ASSIST_ALREADY_USED),
    "本次活动已参与助力，无法助力其他伙伴",
  );

  const error = createServerError(ASSIST_ALREADY_USED);
  assert.equal(
    error.message,
    "服务器错误: 12200100 - 本次活动已参与助力，无法助力其他伙伴",
  );
  assert.equal(error.code, 12200100);
});

test("幻塔助力：目标已满 3 次（12200090）给出服务端文案", () => {
  assert.equal(
    describeServerError(ASSIST_TARGET_FULL),
    "对方已到最大助力人数",
  );

  const error = createServerError(ASSIST_TARGET_FULL);
  assert.equal(error.message, "服务器错误: 12200090 - 对方已到最大助力人数");
  assert.equal(error.code, 12200090);
});

test("两个助力错误码都在本地映射表里，且与抓包文案一致", () => {
  assert.equal(serverErrorCodeMap[12200090], "对方已到最大助力人数");
  assert.equal(
    serverErrorCodeMap[12200100],
    "本次活动已参与助力，无法助力其他伙伴",
  );
});

test("未知错误码优先采用服务端自带 error 文案（不再丢成兜底文案）", () => {
  const packet = { code: 99999999, error: "服务端的新提示文案" };

  assert.equal(describeServerError(packet), "服务端的新提示文案");
  assert.equal(
    createServerError(packet).message,
    "服务器错误: 99999999 - 服务端的新提示文案",
  );
});

test("未知错误码无 error 时回退到 hint，再回退到未知错误", () => {
  assert.equal(describeServerError({ code: 1, hint: "来自 hint 的提示" }), "来自 hint 的提示");
  assert.equal(describeServerError({ code: 1 }), "未知错误");
  assert.equal(describeServerError({}), "未知错误");
  assert.equal(describeServerError(), "未知错误");
});

test("本地映射表文案优先于服务端 error，避免服务端文案漂移影响既有判定", () => {
  const packet = {
    code: 200160,
    error: "服务端改了措辞",
  };

  assert.equal(describeServerError(packet), "模块未开启");
});

test("携带 hint 时会挂到错误对象上，且不因缺字段而抛异常", () => {
  const withHint = createServerError({ code: 200400, hint: "battlefield-1" });
  assert.equal(withHint.hint, "battlefield-1");
  assert.equal(withHint.code, 200400);

  const bare = createServerError({ code: 700010 });
  assert.equal(bare.hint, undefined);
  assert.equal(bare.error, undefined);
  assert.equal(bare.message, "服务器错误: 700010 - 任务未达成完成条件");
});
