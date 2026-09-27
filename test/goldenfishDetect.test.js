import assert from "node:assert/strict";
import test from "node:test";

import {
  createTasksGoldenfish,
  GOLDENFISH_GROUP_NAME,
  DEFAULT_GOLDENFISH_EXCLUDE_SERVERS,
  parseServerIdList,
} from "../src/utils/batch/tasksGoldenfish.js";

const stableKey = (serverId, roleId) => `${serverId}:${roleId}`;

function createFixture() {
  const tokens = [
    { id: "t1", name: "达标号", serverId: 1001, roleId: 11 },
    { id: "t2", name: "招募令不够", serverId: 1001, roleId: 12 },
    { id: "t3", name: "例外服", serverId: 9724, roleId: 13 },
    { id: "t4", name: "积分不够", serverId: 1002, roleId: 14 },
  ];
  // 响应结构对齐 role_getroleinfo：role.items = { itemId: { quantity } }
  // 有效宝箱积分 = 未兑换积分×0.52 + 木1/青铜10/黄金20/铂金50/钻石0
  const responses = {
    t1: {
      role: {
        diamond: 400000,
        boxPoint: 25000, // 25000×0.52 = 13000
        items: {
          1001: { quantity: 3000 },
          1012: { quantity: 400 },
          2001: { quantity: 2000 }, // 木 2000×1
          2002: { quantity: 100 }, // 青 100×10
          2003: { quantity: 50 }, // 黄 50×20
          2004: { quantity: 340 }, // 铂 340×50 = 17000
          2005: { quantity: 999 }, // 钻石不计分
        },
      },
    },
    t2: {
      role: {
        diamond: 640000,
        boxPoint: 25000,
        items: { 1001: { quantity: 2999 }, 1012: { quantity: 0 }, 2004: { quantity: 340 } },
      },
    },
    t3: {
      role: {
        diamond: 900000,
        boxPoint: 90000,
        items: { 1001: { quantity: 9999 }, 1012: { quantity: 999 } },
      },
    },
    t4: {
      role: {
        diamond: 640000,
        boxPoint: 25000, // 13000 + 339×50 = 16950 → 29950 < 30000
        items: { 1001: { quantity: 5000 }, 1012: { quantity: 0 }, 2004: { quantity: 339 } },
      },
    },
  };

  const selectedTokens = { value: tokens.map((item) => item.id) };
  const tokenStatus = { value: {} };
  const isRunning = { value: false };
  const shouldStop = { value: false };
  const currentRunningTokenId = { value: null };
  const connectionQueue = { active: 1 };
  const commands = [];
  const logs = [];

  // 精简版 tokenStore：只实现分组相关方法（键为 serverId:roleId）
  const tokenGroups = [];
  const tokenStore = {
    tokenGroups,
    gameTokens: tokens,
    createTokenGroup: (name, color) => {
      const group = {
        id: `group_${tokenGroups.length + 1}`,
        name,
        color,
        tokenKeys: [],
      };
      tokenGroups.push(group);
      return group;
    },
    addTokenToGroup: (groupId, tokenId) => {
      const group = tokenGroups.find((item) => item.id === groupId);
      const token = tokens.find((item) => item.id === tokenId);
      if (!group || !token) return false;
      const key = stableKey(token.serverId, token.roleId);
      if (!group.tokenKeys.includes(key)) group.tokenKeys.push(key);
      return true;
    },
    removeTokenFromGroup: (groupId, tokenId) => {
      const group = tokenGroups.find((item) => item.id === groupId);
      const token = tokens.find((item) => item.id === tokenId);
      if (!group || !token) return false;
      const key = stableKey(token.serverId, token.roleId);
      const index = group.tokenKeys.indexOf(key);
      if (index !== -1) group.tokenKeys.splice(index, 1);
      return true;
    },
    getGroupTokenIds: (groupId) => {
      const group = tokenGroups.find((item) => item.id === groupId);
      if (!group) return [];
      return tokens
        .filter((token) =>
          group.tokenKeys.includes(stableKey(token.serverId, token.roleId)),
        )
        .map((token) => token.id);
    },
    closeWebSocketConnection: async () => {},
    sendMessageWithPromise: async () => ({}),
  };

  const task = createTasksGoldenfish({
    selectedTokens,
    tokens: { value: tokens },
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue,
    batchSettings: { maxActive: 3 },
    tokenStore,
    sendRoleInfo: async (tokenId) => {
      commands.push(tokenId);
      return responses[tokenId];
    },
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {} },
    currentRunningTokenId,
  });

  return { task, tokenStatus, isRunning, commands, logs, tokenGroups };
}

test("parseServerIdList 支持中英文逗号/分号/空格", () => {
  assert.deepEqual(
    [...parseServerIdList("9724, 9736,26501")],
    ["9724", "9736", "26501"],
  );
  assert.deepEqual(
    [...parseServerIdList(DEFAULT_GOLDENFISH_EXCLUDE_SERVERS)],
    ["9724", "9736", "26501"],
  );
  assert.deepEqual([...parseServerIdList("6509；39 1")], ["6509", "39", "1"]);
  assert.equal(parseServerIdList(null).size, 0);
});

test("检测金鱼号：达标入组，不达标/例外服不入组", async () => {
  const fixture = createFixture();

  const summary = await fixture.task.detectGoldenfishAccounts({
    excludeServers: DEFAULT_GOLDENFISH_EXCLUDE_SERVERS,
  });

  // 例外服（9724）不建连、不发 role_getroleinfo
  assert.deepEqual(fixture.commands.sort(), ["t1", "t2", "t4"]);

  assert.equal(summary.qualified.length, 1);
  assert.equal(summary.qualified[0].tokenName, "达标号");
  assert.equal(summary.qualified[0].recruit, 3000);
  assert.equal(summary.qualified[0].diamond, 400000);
  assert.equal(summary.qualified[0].goldRod, 400);
  assert.equal(summary.qualified[0].diamondTotal, 640000);
  // 有效宝箱积分 = 25000×0.52 + (2000×1 + 100×10 + 50×20 + 340×50) = 13000 + 21000
  assert.equal(summary.qualified[0].chestScore, 21000);
  assert.equal(summary.qualified[0].boxScore, 34000);

  assert.deepEqual(
    summary.unqualified.map((row) => row.tokenName).sort((a, b) =>
      a.localeCompare(b, "zh-CN"),
    ),
    ["积分不够", "招募令不够"],
  );
  // t4：13000 + 339×50 = 29950，差 50 分不达标
  const t4 = summary.unqualified.find((row) => row.tokenName === "积分不够");
  assert.equal(t4.boxScore, 29950);
  assert.equal(t4.reasons.length, 1);
  assert.ok(t4.reasons[0].includes("有效宝箱积分"));
  assert.deepEqual(summary.excluded.map((row) => row.tokenName), ["例外服"]);
  assert.equal(summary.failed.length, 0);

  // 固定分组名「金鱼组」里只有达标号
  assert.equal(fixture.tokenGroups.length, 1);
  assert.equal(fixture.tokenGroups[0].name, GOLDENFISH_GROUP_NAME);
  assert.deepEqual(fixture.tokenGroups[0].tokenKeys, ["1001:11"]);
  assert.equal(summary.groupSize, 1);

  assert.equal(fixture.isRunning.value, false);
  assert.equal(fixture.tokenStatus.value.t3, "completed");
});

test("检测金鱼号：合并语义，老成员（含本次不达标/例外服）不会被移出", async () => {
  const fixture = createFixture();
  // 预置「金鱼组」：老成员含本次不达标的 t2 与例外服 t3
  fixture.tokenGroups.push({
    id: "group_preset",
    name: GOLDENFISH_GROUP_NAME,
    color: "#f5a623",
    tokenKeys: ["1001:12", "9724:13"],
  });

  const summary = await fixture.task.detectGoldenfishAccounts({
    excludeServers: ["9724", "9736", "26501"],
  });

  assert.equal(fixture.tokenGroups.length, 1); // 复用同名组，不新建
  // 合并：老的 1001:12 / 9724:13 保留，新增达标的 1001:11
  assert.deepEqual(
    [...fixture.tokenGroups[0].tokenKeys].sort(),
    ["1001:11", "1001:12", "9724:13"],
  );
  assert.equal(summary.groupSize, 3);
  assert.ok(
    fixture.logs.some((entry) => entry.message.includes("合并完成")),
  );
});
