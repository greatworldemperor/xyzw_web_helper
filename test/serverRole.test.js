import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectTokenServers,
  decodeServerRoleId,
  filterTokensByServerNumbers,
  formatImportedRoleName,
  getTokenServerNumber,
  matchServerNumbersByInput,
  parseServerNumberInput,
} from "../src/utils/serverRole.js";

test("decodeServerRoleId handles all three role slots", () => {
  assert.deepEqual(decodeServerRoleId(66), {
    serverNumber: 39,
    roleIndex: 0,
  });
  assert.deepEqual(decodeServerRoleId(1000066), {
    serverNumber: 39,
    roleIndex: 1,
  });
  assert.deepEqual(decodeServerRoleId(2000066), {
    serverNumber: 39,
    roleIndex: 2,
  });
});

test("formatImportedRoleName expands the established template variables", () => {
  assert.equal(
    formatImportedRoleName("{server}-{name}-{index}-{id}", {
      name: "测试角色",
      roleId: 123456,
      serverId: 1000066,
    }),
    "39服-测试角色-1-123456",
  );

  assert.equal(
    formatImportedRoleName("{name}-{id}", {
      name: "$&测试",
      roleId: 123456,
      serverId: 66,
    }),
    "$&测试-123456",
  );
});

test("parseServerNumberInput tolerates 服 suffixes and rejects empty input", () => {
  assert.equal(parseServerNumberInput("39"), 39);
  assert.equal(parseServerNumberInput("39服"), 39);
  assert.equal(parseServerNumberInput(" 39 区 "), 39);
  assert.equal(parseServerNumberInput(66), 66);
  assert.equal(parseServerNumberInput(null), null);
  assert.equal(parseServerNumberInput(undefined), null);
  assert.equal(parseServerNumberInput(""), null);
  assert.equal(parseServerNumberInput("没有数字"), null);
});

test("getTokenServerNumber decodes serverId and falls back to server name", () => {
  // serverId 三个角色位都指向 39 服
  assert.equal(getTokenServerNumber({ serverId: 66 }), 39);
  assert.equal(getTokenServerNumber({ serverId: 1000066 }), 39);
  assert.equal(getTokenServerNumber({ serverId: "2000066" }), 39);
  // 没有 serverId 时退回解析 server 名称
  assert.equal(getTokenServerNumber({ server: "39服" }), 39);
  assert.equal(getTokenServerNumber({ serverId: "", server: "12服" }), 12);
  // 无效输入一律返回 null，不能因为 Number(null) === 0 而算成 -27 服
  assert.equal(getTokenServerNumber({}), null);
  assert.equal(getTokenServerNumber({ serverId: 0, server: "" }), null);
  assert.equal(getTokenServerNumber(null), null);
});

test("matchServerNumbersByInput matches 服号 by substring, not exact equality", () => {
  const tokens = [
    { id: "a", server: "6509服" },
    { id: "b", server: "26501服" },
    { id: "c", server: "39服" },
  ];

  // 输入 650 同时命中 6509 服和 26501 服
  assert.deepEqual(matchServerNumbersByInput("650", tokens), [6509, 26501]);
  // 输入完整服号只命中自己
  assert.deepEqual(matchServerNumbersByInput("39", tokens), [39]);
  assert.deepEqual(matchServerNumbersByInput("26501服", tokens), [26501]);
  // 没命中 / 没有数字
  assert.deepEqual(matchServerNumbersByInput("777", tokens), []);
  assert.deepEqual(matchServerNumbersByInput("", tokens), []);
  assert.deepEqual(matchServerNumbersByInput("没有数字", tokens), []);
  assert.deepEqual(matchServerNumbersByInput("650", []), []);
});

test("matchServerNumbersByInput is substring based even when an exact 服号 exists", () => {
  const tokens = [
    { id: "a", server: "39服" },
    { id: "b", server: "139服" },
  ];

  // 有意为之：139 服也包含 "39"，输入 39 会同时命中两个服
  assert.deepEqual(matchServerNumbersByInput("39", tokens), [39, 139]);
});

test("matchServerNumbersByInput falls back to decoding a full serverId", () => {
  const tokens = [
    { id: "a", serverId: 66, server: "39服" },
    { id: "b", serverId: 1000066, server: "39服" },
  ];

  // 1000066 作为子串匹配不到任何服号，再按编码解出 39 服
  assert.deepEqual(matchServerNumbersByInput("1000066", tokens), [39]);
});

test("filterTokensByServerNumbers accepts a single 服号 or an array", () => {
  const tokens = [
    { id: "a", serverId: 66, server: "39服" },
    { id: "b", serverId: 1000066, server: "39服" },
    { id: "c", serverId: 105, server: "78服" },
    { id: "d" },
  ];

  assert.deepEqual(
    filterTokensByServerNumbers(tokens, [39, 78]).map((token) => token.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    filterTokensByServerNumbers(tokens, 39).map((token) => token.id),
    ["a", "b"],
  );
  assert.deepEqual(filterTokensByServerNumbers(tokens, []), []);
  assert.deepEqual(filterTokensByServerNumbers(tokens, [null]), []);
});

test("collectTokenServers groups tokens by 服号 in ascending order", () => {
  const tokens = [
    { id: "a", serverId: 66, server: "39服" },
    { id: "b", serverId: 1000066, server: "39服" },
    { id: "c", serverId: 105, server: "78服" },
    { id: "d" },
  ];

  assert.deepEqual(
    collectTokenServers(tokens).map((group) => ({
      serverNumber: group.serverNumber,
      ids: group.tokens.map((token) => token.id),
    })),
    [
      { serverNumber: 39, ids: ["a", "b"] },
      { serverNumber: 78, ids: ["c"] },
    ],
  );
});
