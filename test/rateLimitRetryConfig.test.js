import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getRateLimitRetryMs,
  isRateLimitError,
  isRetryableRefreshError,
  RATE_LIMIT_RETRY_DEFAULT_MS,
} from "../src/utils/helperTaskRunner.js";

// node 测试环境没有 localStorage ⇒ 恒为默认值
test("getRateLimitRetryMs: 无 localStorage 环境返回默认 60s", () => {
  assert.equal(getRateLimitRetryMs(), RATE_LIMIT_RETRY_DEFAULT_MS);
  assert.equal(getRateLimitRetryMs(), 60000);
});

test("getRateLimitRetryMs: localStorage 配置被读取并夹紧 5~600 秒", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    // 正常读取
    store.set("rateLimitRetrySec", "30");
    assert.equal(getRateLimitRetryMs(), 30000);
    // 下限夹紧：5s
    store.set("rateLimitRetrySec", "1");
    assert.equal(getRateLimitRetryMs(), 5000);
    // 上限夹紧：600s
    store.set("rateLimitRetrySec", "9999");
    assert.equal(getRateLimitRetryMs(), 600000);
    // 非法值 → 默认
    store.set("rateLimitRetrySec", "abc");
    assert.equal(getRateLimitRetryMs(), 60000);
    store.set("rateLimitRetrySec", "-5");
    assert.equal(getRateLimitRetryMs(), 60000);
  } finally {
    delete globalThis.localStorage;
  }
});

test("isRetryableRefreshError: 限流类错误可重试", () => {
  assert.equal(isRetryableRefreshError(new Error("服务器限流（响应码 400340）")), true);
  assert.equal(isRetryableRefreshError(new Error("Request failed with status code 429")), true);
  assert.equal(isRetryableRefreshError(new Error("操作太快，请稍后再试")), true);
});

test("isRetryableRefreshError: 登录限流形态可重试（2026-11-03 实锤）", () => {
  // token.ts 转换后的可识别错误
  assert.equal(
    isRetryableRefreshError(
      new Error("登录限流：authuser 响应未返回 roleToken（服务器返回: null）"),
    ),
    true,
  );
  // 历史裸 TypeError 形态
  assert.equal(
    isRetryableRefreshError(
      new Error("Cannot read properties of undefined (reading 'roleToken')"),
    ),
    true,
  );
  // 200350 属于 isRateLimitError（登录通道限流，切 IP 有效）
  assert.equal(isRetryableRefreshError(new Error("服务器错误: 200350 - 登录异常，请稍后再试")), true);
  assert.equal(isRateLimitError(new Error("服务器错误: 200350 - 登录异常，请稍后再试")), true);
});

test("isRetryableRefreshError: 连接类错误（切 IP 瞬断）可重试", () => {
  // axios 的 "Network Error"（带空格）
  assert.equal(isRetryableRefreshError(new Error("Network Error")), true);
  // fetch 的 TypeError
  assert.equal(isRetryableRefreshError(new Error("Failed to fetch")), true);
  // AbortSignal.timeout 的 DOMException
  assert.equal(
    isRetryableRefreshError(new Error("The operation was aborted due to timeout")),
    true,
  );
  assert.equal(isRetryableRefreshError(new Error("socket hang up")), true);
  assert.equal(isRetryableRefreshError(new Error("ECONNRESET")), true);
});

test("isRetryableRefreshError: HTTP 5xx 网关抖动可重试", () => {
  assert.equal(
    isRetryableRefreshError(
      Object.assign(new Error("Request failed with status code 502"), {
        response: { status: 502 },
      }),
    ),
    true,
  );
  assert.equal(
    isRetryableRefreshError(new Error("Token刷新接口请求失败: 503")),
    true,
  );
});

test("isRetryableRefreshError: 明确判死的错误不可重试", () => {
  assert.equal(isRetryableRefreshError(new Error("未找到可用的Token刷新来源")), false);
  assert.equal(isRetryableRefreshError(new Error("未找到BIN数据")), false);
  assert.equal(
    isRetryableRefreshError(new Error("BIN转换结果不是有效的加密Token")),
    false,
  );
  assert.equal(
    isRetryableRefreshError(new Error("刷新接口返回的Token不是有效的加密Token")),
    false,
  );
  assert.equal(
    isRetryableRefreshError(new Error("Token刷新接口请求失败: 403")),
    false,
  );
  assert.equal(
    isRetryableRefreshError(
      Object.assign(new Error("Request failed with status code 404"), {
        response: { status: 404 },
      }),
    ),
    false,
  );
});
