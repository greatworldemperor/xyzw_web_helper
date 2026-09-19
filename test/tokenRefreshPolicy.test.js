import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BIN_BACKED_IMPORT_METHODS,
  hasRefreshSource,
  isBinBackedToken,
  isUsableTokenString,
  shouldRefreshTokenOnDemand,
} from "../src/utils/tokenRefreshPolicy.js";

// role token 生命周期很短：导入时为空、下次用时再刷新，是这套策略的核心约定。
const validToken = JSON.stringify({
  roleToken: "0123456789abcdef",
  sessId: 1,
  connId: 2,
  isRestore: 0,
});

test("isUsableTokenString rejects empty / placeholder tokens", () => {
  assert.equal(isUsableTokenString(""), false);
  assert.equal(isUsableTokenString("   "), false);
  assert.equal(isUsableTokenString(undefined), false);
  assert.equal(isUsableTokenString(null), false);
  assert.equal(isUsableTokenString("short"), false);
  assert.equal(isUsableTokenString(validToken), true);
});

test("bin imported tokens are refreshable and must refresh while token is empty", () => {
  const token = { id: "hash", name: "角色-1-100", importMethod: "bin", token: "" };

  assert.equal(isBinBackedToken(token), true);
  assert.equal(hasRefreshSource(token), true);
  assert.equal(shouldRefreshTokenOnDemand(token), true);

  // 已经拿到 token（尚未过期）时不必再刷一次
  assert.equal(
    shouldRefreshTokenOnDemand({ ...token, token: validToken }),
    false,
  );
});

test("all bin-backed import methods share the same on-demand policy", () => {
  for (const importMethod of BIN_BACKED_IMPORT_METHODS) {
    assert.equal(
      shouldRefreshTokenOnDemand({ importMethod, token: "" }),
      true,
      `${importMethod} 应支持按需刷新`,
    );
  }
});

test("url tokens refresh only when sourceUrl exists", () => {
  assert.equal(
    shouldRefreshTokenOnDemand({
      importMethod: "url",
      sourceUrl: "https://example.com/token",
      token: "",
    }),
    true,
  );
  assert.equal(
    shouldRefreshTokenOnDemand({ importMethod: "url", token: "" }),
    false,
  );
});

test("manual tokens without a refresh source are left to the legacy flow", () => {
  const manual = { importMethod: "manual", token: "" };

  assert.equal(hasRefreshSource(manual), false);
  assert.equal(shouldRefreshTokenOnDemand(manual), false);
  // 手动 token 仍然可以正常连接
  assert.equal(
    shouldRefreshTokenOnDemand({ importMethod: "manual", token: validToken }),
    false,
  );
});
