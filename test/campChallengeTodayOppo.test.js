import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectCampEnemies,
  getCampOppoKey,
  getCampTodayKey,
  isCampBattleDay,
  selectTodayCampOppo,
} from "../src/utils/batch/campChallengePlanner.js";
import { createTasksCampChallengeStrategy } from "../src/utils/batch/tasksCampChallengeStrategy.js";

const ref = (value) => ({ value });

const withInstantTimers = async (fn) => {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 0;
  };
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = original;
  }
};

const buildDefenders = (roleIdBase) => {
  const defenders = {};
  for (let nodeId = 1; nodeId <= 30; nodeId += 1) {
    // 与真实数据一致：25~29 是 1~5 的镜像复制，30 号仍是原版。
    const mirror = nodeId >= 25 && nodeId <= 29;
    const sourceNodeId = mirror ? nodeId - 24 : nodeId;
    defenders[nodeId] = {
      roleId: roleIdBase + sourceNodeId,
      name: `防守${nodeId}`,
      mirror,
      challengeCnt: 0,
      failCnt: 0,
      defeated: false,
    };
  }
  return defenders;
};

const createHarness = ({ respond, tokens = [{ id: "t1", name: "角色1", roleId: 1 }], extraDeps = {} }) => {
  const calls = [];
  const logs = [];
  const deps = {
    selectedTokens: ref(tokens.map((token) => token.id)),
    tokens: ref(tokens),
    tokenStatus: ref({}),
    isRunning: ref(false),
    shouldStop: ref(false),
    currentRunningTokenId: ref(null),
    tokenStore: {
      sendMessageWithPromise: async (tokenId, command, params = {}) => {
        calls.push({ tokenId, command, params });
        return respond(command, params, calls);
      },
      closeWebSocketConnection: async () => {},
      getWebSocketStatus: () => "connected",
    },
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {}, error: () => {} },
    batchSettings: { arenaFormation: 1, commandDelay: 1 },
    ...extraDeps,
  };

  return {
    strategy: createTasksCampChallengeStrategy(deps),
    calls,
    logs,
  };
};

const commandsOf = (calls, command) =>
  calls.filter((call) => call.command === command);

test("营地战斗日的键就是星期几", () => {
  assert.equal(getCampOppoKey(new Date(2026, 8, 15)), "2"); // 周二
  assert.equal(getCampOppoKey(new Date(2026, 8, 16)), "3"); // 周三
  assert.equal(getCampOppoKey(new Date(2026, 8, 17)), "4"); // 周四
  assert.equal(getCampOppoKey(new Date(2026, 8, 20)), "0"); // 周日
});

test("战斗日只有周二、周三、周四", () => {
  assert.equal(isCampBattleDay(new Date(2026, 8, 14)), false); // 周一
  assert.equal(isCampBattleDay(new Date(2026, 8, 15)), true);
  assert.equal(isCampBattleDay(new Date(2026, 8, 16)), true);
  assert.equal(isCampBattleDay(new Date(2026, 8, 17)), true);
  assert.equal(isCampBattleDay(new Date(2026, 8, 18)), false); // 周五
  assert.equal(isCampBattleDay(new Date(2026, 8, 19)), false); // 周六
});

test("当天只取一个来源组的棋盘，不跨战斗日合并同 nodeId", () => {
  const oppoMap = {
    "2": {
      legionId: 200,
      defenders: { 4: { roleId: 111, challengeCnt: 5, failCnt: 4 } },
    },
    "3": {
      legionId: 300,
      defenders: { 4: { roleId: 222, challengeCnt: 0, failCnt: 0 } },
    },
  };

  const today = selectTodayCampOppo(oppoMap, new Date(2026, 8, 16));
  assert.equal(today.sourceGroupKey, "3");
  assert.equal(today.missing, false);
  assert.deepEqual(
    today.enemies.map((enemy) => [enemy.nodeId, enemy.roleId, enemy.sourceGroupKey]),
    [[4, 222, "3"]],
  );

  // 旧的合并实现会因为 key 2 的成功次数更高而把 nodeId=4 换成 111，这正是 200020 的根因。
  const merged = collectCampEnemies(oppoMap);
  assert.equal(merged[0].roleId, 111);
});

test("当天对手未生成时返回 missing 而不是退回其它来源组", () => {
  const oppoMap = {
    "2": { legionId: 200, defenders: { 4: { roleId: 111 } } },
  };
  const today = selectTodayCampOppo(oppoMap, new Date(2026, 8, 16));
  assert.equal(today.missing, true);
  assert.equal(today.opponent, null);
  assert.deepEqual(today.enemies, []);
});

test("测试模式：读取当天对手 30 个位置的全部战力，且不发送任何攻击", async () => {
  const todayKey = getCampOppoKey();
  const otherKey = todayKey === "2" ? "3" : "2";
  const todayRoleBase = 700000000;
  const otherRoleBase = 900000000;
  const oppoMap = {
    [otherKey]: {
      legionId: 200,
      name: "其它战斗日对手",
      dayScore: 0,
      defenders: buildDefenders(otherRoleBase),
    },
    [todayKey]: {
      legionId: 300,
      name: "当天对手",
      dayScore: 185,
      defenders: buildDefenders(todayRoleBase),
    },
  };

  const { strategy, calls, logs } = createHarness({
    respond: (command, params) => {
      switch (command) {
        case "legion_getinfo":
          return {
            info: {
              id: 300,
              name: "我方俱乐部",
              members: {
                1: { roleId: 1, name: "角色1", power: 123456789 },
              },
            },
          };
        case "club_getinfo":
          return {
            club: { legionId: 300, oppoMap },
            siege: { attackMap: {}, taskClaimedMap: {} },
          };
        case "club_gettargetteam": {
          const targetId = Number(params.targetId);
          return {
            roleBattleTeam: {
              role: { roleId: targetId, power: targetId * 10 },
            },
          };
        }
        default:
          return {};
      }
    },
  });

  await withInstantTimers(() => strategy.batchCampDiagnose());

  const targetQueries = commandsOf(calls, "club_gettargetteam");
  // 30 个位置里有 5 个镜像与原版共用 targetId，因此去重后应查询 25 个目标。
  assert.equal(targetQueries.length, 25);
  const queriedIds = targetQueries.map((call) => Number(call.params.targetId));
  assert.equal(new Set(queriedIds).size, 25);
  for (const targetId of queriedIds) {
    assert.ok(
      targetId >= todayRoleBase && targetId < todayRoleBase + 100,
      `只应查询当天对手的目标，实际查询了 ${targetId}`,
    );
  }
  // 测试模式必须只读。
  assert.equal(commandsOf(calls, "club_attack").length, 0);
  assert.equal(commandsOf(calls, "club_attackmonster").length, 0);
  assert.equal(commandsOf(calls, "club_taskclaim").length, 0);

  const summary = logs
    .map((entry) => entry.message)
    .find((message) => message.includes("位置成功="));
  assert.ok(summary, "应输出位置成功统计");
  assert.match(summary, /位置成功=30\/30/);
  assert.match(summary, /去重目标成功=25\/25/);
});

test("单连接 rank_getroleinfo 完成俱乐部分组，每个俱乐部只探测一次", async () => {
  const todayKey = getCampOppoKey();
  const tokens = [
    { id: "t1", name: "角色1", roleId: 101 },
    { id: "t2", name: "角色2", roleId: 102 },
    { id: "t3", name: "角色3", roleId: 103 },
  ];
  // 101/102 同属俱乐部 900，103 属于俱乐部 901。
  const legionByRoleId = { 101: 900, 102: 900, 103: 901 };

  const { strategy, calls, logs } = createHarness({
    tokens,
    respond: (command, params) => {
      switch (command) {
        case "rank_getroleinfo":
          return {
            roleInfo: {
              roleId: params.roleId,
              legionId: legionByRoleId[params.roleId],
              power: 1000 + params.roleId,
              lordWeaponId: 3,
              battleTeam: { 0: { heroId: 116 }, 1: { heroId: 102 } },
              pet: { petId: 501, petUId: "109-Ple" },
              name: `角色${params.roleId}`,
            },
            legionInfo: {
              id: legionByRoleId[params.roleId],
              name: `俱乐部${legionByRoleId[params.roleId]}`,
            },
          };
        case "legion_getinfo":
          return { info: { id: 900, name: "兜底", members: {} } };
        case "club_getinfo":
          return {
            club: {
              legionId: 900,
              oppoMap: {
                [todayKey]: {
                  legionId: 500,
                  name: "当天对手",
                  defenders: buildDefenders(700000000),
                },
              },
            },
            siege: { attackMap: {}, taskClaimedMap: {} },
          };
        case "club_gettargetteam":
          return {
            roleBattleTeam: { role: { roleId: Number(params.targetId), power: 8000000000 } },
          };
        default:
          return {};
      }
    },
  });

  await withInstantTimers(() => strategy.batchCampDiagnose());

  // 每个选中角色一次 rank_getroleinfo，且全部在同一个连接上完成。
  const rankCalls = commandsOf(calls, "rank_getroleinfo");
  assert.deepEqual(
    rankCalls.map((call) => call.params.roleId).sort((a, b) => a - b),
    [101, 102, 103],
  );
  assert.equal(new Set(rankCalls.map((call) => call.tokenId)).size, 1);
  assert.deepEqual(rankCalls[0].params, {
    roleId: 101,
    bottleType: 0,
    includeBottleTeam: false,
    isSearch: false,
  });

  // 分组不依赖"按俱乐部探测"：legion_getinfo 只作为拿不到 legionId 时的兜底。
  const messages = logs.map((entry) => entry.message);
  assert.ok(
    messages.some((message) => message.includes("归并为 2 个俱乐部")),
    "应按 rank_getroleinfo.legionId 归并成 2 个俱乐部",
  );

  // 每个俱乐部只做一次俱乐部级上下文 + 一次目标查询（25 个去重目标）：
  // 3 个角色 / 2 个俱乐部 → legion_getinfo、club_getinfo 各 2 次。
  assert.equal(commandsOf(calls, "legion_getinfo").length, 2);
  assert.equal(commandsOf(calls, "club_getinfo").length, 2);
  assert.equal(commandsOf(calls, "club_gettargetteam").length, 50);
  assert.equal(commandsOf(calls, "club_attack").length, 0);
});

test("计划确认：弹框清单包含角色/战力/目标/次数；取消则不发起任何攻击", async () => {
  const oppoKey = getCampOppoKey(); // oppoMap 的键 = 星期几
  const statsKey = getCampTodayKey(); // attackMap 的键 = YYMMDD
  const unbeatable = new Set([1, 11, 21]);
  const defenders = {};
  for (let nodeId = 1; nodeId <= 30; nodeId += 1) {
    defenders[nodeId] = {
      roleId: 800000000 + nodeId,
      name: `防守${nodeId}`,
      mirror: false,
      challengeCnt: 0,
      failCnt: 0,
      defeated: false,
      power: unbeatable.has(nodeId) ? 200 : 50,
    };
  }

  let capturedPreview = null;
  const attackMap = {};
  const { strategy, calls } = createHarness({
    tokens: [{ id: "t1", name: "角色1", roleId: 101 }],
    extraDeps: {
      confirmCampPlan: async (preview) => {
        capturedPreview = preview;
        return false; // 拒绝执行
      },
    },
    respond: (command, params) => {
      switch (command) {
        case "rank_getroleinfo":
          return {
            roleInfo: {
              roleId: params.roleId,
              legionId: 300,
              power: 10000000000,
              lordWeaponId: 3,
              battleTeam: { 0: { heroId: 116 } },
              pet: { petId: 501, petUId: "109-Ple" },
              name: "角色1",
            },
            legionInfo: { id: 300, name: "我方俱乐部" },
          };
        case "legion_getinfo":
          return { info: { id: 300, name: "我方俱乐部", members: {} } };
        case "club_getinfo":
          return {
            club: { legionId: 300, oppoMap: { [oppoKey]: { legionId: 500, name: "当天对手", defenders } } },
            siege: { attackMap, taskClaimedMap: {} },
          };
        case "club_gettargetteam":
          return {
            roleBattleTeam: { role: { roleId: Number(params.targetId), power: 5000000000 } },
          };
        case "club_attack":
          attackMap[statsKey] = { attackCnt: (attackMap[statsKey]?.attackCnt || 0) + 1, aSuccessCnt: attackMap[statsKey]?.aSuccessCnt || 0 };
          return { siege: { attackMap }, battleData: { result: { accept: { ext: { curHP: 0 } } } } };
        case "club_taskclaim":
          return { siege: { taskClaimedMap: {} } };
        default:
          return {};
      }
    },
  });

  await withInstantTimers(() => strategy.batchCampChallenge());

  assert.ok(capturedPreview, "应弹出计划确认");
  assert.match(capturedPreview.title, /部分攻击/);
  assert.equal(capturedPreview.members.length, 1);
  const member = capturedPreview.members[0];
  assert.equal(member.roleName, "角色1");
  assert.equal(member.power, 10000000000);
  assert.ok(member.targets.length > 0, "清单应包含攻击目标");
  const firstTarget = member.targets[0];
  assert.equal(firstTarget.targetName, "防守2");
  assert.equal(firstTarget.targetPower, 50);
  assert.ok(firstTarget.count >= 1);

  // 拒绝后：不攻击、不宠物保底，但领奖照常尝试（confId=1 + 5..13 共 10 项）。
  assert.equal(commandsOf(calls, "club_attack").length, 0);
  assert.equal(commandsOf(calls, "club_attackmonster").length, 0);
  assert.equal(commandsOf(calls, "club_taskclaim").length, 10);
});

test("计划确认：同意后按计划执行", async () => {
  const oppoKey = getCampOppoKey();
  const statsKey = getCampTodayKey();
  const unbeatable = new Set([1, 11, 21]);
  const defenders = {};
  for (let nodeId = 1; nodeId <= 30; nodeId += 1) {
    defenders[nodeId] = {
      roleId: 800000000 + nodeId,
      name: `防守${nodeId}`,
      mirror: false,
      challengeCnt: 0,
      failCnt: 0,
      defeated: false,
      power: unbeatable.has(nodeId) ? 200 : 50,
    };
  }

  const attackMap = {};
  const { strategy, calls } = createHarness({
    tokens: [{ id: "t1", name: "角色1", roleId: 101 }],
    extraDeps: {
      confirmCampPlan: async () => true,
    },
    respond: (command, params) => {
      switch (command) {
        case "rank_getroleinfo":
          return {
            roleInfo: {
              roleId: params.roleId,
              legionId: 300,
              power: 10000000000,
              lordWeaponId: 3,
              battleTeam: { 0: { heroId: 116 } },
              pet: { petId: 501, petUId: "109-Ple" },
              name: "角色1",
            },
            legionInfo: { id: 300, name: "我方俱乐部" },
          };
        case "legion_getinfo":
          return { info: { id: 300, name: "我方俱乐部", members: {} } };
        case "club_getinfo":
          return {
            club: { legionId: 300, oppoMap: { [oppoKey]: { legionId: 500, name: "当天对手", defenders } } },
            siege: { attackMap, taskClaimedMap: {} },
          };
        case "club_gettargetteam":
          return {
            roleBattleTeam: { role: { roleId: Number(params.targetId), power: 5000000000 } },
          };
        case "club_attack":
          attackMap[statsKey] = {
            attackCnt: (attackMap[statsKey]?.attackCnt || 0) + 1,
            aSuccessCnt: (attackMap[statsKey]?.aSuccessCnt || 0) + 1,
          };
          return { siege: { attackMap }, battleData: { result: { accept: { ext: { curHP: 0 } } } } };
        case "club_taskclaim":
          return { siege: { taskClaimedMap: {} } };
        default:
          return {};
      }
    },
  });

  await withInstantTimers(() => strategy.batchCampChallenge());

  assert.ok(commandsOf(calls, "club_attack").length > 0, "确认后应执行攻击");
  // 3 次成功额度拿满后不再需要宠物保底。
  assert.equal(commandsOf(calls, "club_attackmonster").length, 0);
});

test("智能规划：当天没有对手时不发起任何目标查询", async () => {
  const todayKey = getCampOppoKey();
  const otherKey = todayKey === "2" ? "3" : "2";
  const oppoMap = {
    [otherKey]: { legionId: 200, name: "其它战斗日对手", defenders: buildDefenders(900000000) },
  };

  const { strategy, calls, logs } = createHarness({
    respond: (command) => {
      switch (command) {
        case "legion_getinfo":
          return { info: { id: 300, name: "我方俱乐部", members: {} } };
        case "club_getinfo":
          return { club: { legionId: 300, oppoMap }, siege: { attackMap: {} } };
        default:
          return {};
      }
    },
  });

  await withInstantTimers(() => strategy.batchCampChallenge());

  assert.equal(commandsOf(calls, "club_gettargetteam").length, 0);
  assert.equal(commandsOf(calls, "club_attack").length, 0);
  const messages = logs.map((entry) => entry.message);
  assert.ok(
    messages.some(
      (message) =>
        message.includes(`oppoMap 中没有今天（key=${todayKey}）的对手`) ||
        message.includes("不是营地战斗日"),
    ),
    "应说明今天没有对手（或今天不是战斗日）并跳过",
  );
});

test("三组不可达时降级为部分攻击，普通攻击失败后用宠物补满 3 胜", async () => {
  const oppoKey = getCampOppoKey();
  const statsKey = getCampTodayKey();
  // 每个区域组各留一个打不动的强节点 → 三组都无法整组全清。
  const unbeatable = new Set([1, 11, 21]);
  const defenders = {};
  for (let nodeId = 1; nodeId <= 30; nodeId += 1) {
    defenders[nodeId] = {
      roleId: 800000000 + nodeId,
      name: `防守${nodeId}`,
      mirror: false,
      challengeCnt: 0,
      failCnt: 0,
      defeated: false,
      // 我方战力 100 → 阈值 0.75 → 能打 ≤75；强节点 200 打不动。
      power: unbeatable.has(nodeId) ? 200 : 50,
    };
  }

  const attackMap = {};
  let petAttacks = 0;
  const { strategy, calls, logs } = createHarness({
    tokens: [{ id: "t1", name: "角色1", roleId: 101 }],
    respond: (command, params) => {
      const todayStats = attackMap[statsKey] || { attackCnt: 0, aSuccessCnt: 0 };
      switch (command) {
        case "rank_getroleinfo":
          return {
            roleInfo: {
              roleId: params.roleId,
              legionId: 300,
              power: 10000000000,
              lordWeaponId: 3,
              battleTeam: { 0: { heroId: 116 } },
              pet: { petId: 501, petUId: "109-Ple" },
              name: "角色1",
            },
            legionInfo: { id: 300, name: "我方俱乐部" },
          };
        case "legion_getinfo":
          return { info: { id: 300, name: "我方俱乐部", members: {} } };
        case "club_getinfo":
          return {
            club: { legionId: 300, oppoMap: { [oppoKey]: { legionId: 500, name: "当天对手", defenders } } },
            siege: { attackMap, taskClaimedMap: {} },
          };
        case "club_gettargetteam":
          return {
            roleBattleTeam: { role: { roleId: Number(params.targetId), power: 5000000000 } },
          };
        case "club_attack": {
          // 故意让它全部失败：验证宠物保底会补上 3 次获胜。
          attackMap[statsKey] = {
            attackCnt: todayStats.attackCnt + 1,
            aSuccessCnt: todayStats.aSuccessCnt,
          };
          return {
            siege: { attackMap },
            battleData: { result: { accept: { ext: { curHP: 12345 } } } },
          };
        }
        case "club_attackmonster": {
          petAttacks += 1;
          attackMap[statsKey] = {
            attackCnt: todayStats.attackCnt + 1,
            aSuccessCnt: todayStats.aSuccessCnt + 1,
          };
          return {
            siege: { attackMap },
            battleData: { result: { accept: { ext: { curHP: 0 } } } },
          };
        }
        default:
          return {};
      }
    },
  });

  await withInstantTimers(() => strategy.batchCampChallenge());

  // 部分攻击：能打赢的节点被覆盖，且不碰三个强节点。
  const attackedNodes = commandsOf(calls, "club_attack").map(
    (call) => call.params.nodeId,
  );
  assert.ok(attackedNodes.length > 0, "应产生部分攻击计划");
  for (const nodeId of attackedNodes) {
    assert.equal(unbeatable.has(nodeId), false, `不该攻击打不动的 nodeId=${nodeId}`);
  }

  // 普通攻击全失败 → 宠物保底必须补满 3 次获胜（宠物也占发起额度）。
  assert.equal(petAttacks, 3);
  const totalAttacks =
    commandsOf(calls, "club_attack").length + petAttacks;
  assert.ok(totalAttacks <= 10, `每日发起不应超过 10 次，实际 ${totalAttacks}`);

  const messages = logs.map((entry) => entry.message);
  assert.ok(
    messages.some((message) => message.includes("降级为部分攻击")),
    "应记录降级为部分攻击",
  );
  assert.ok(
    messages.some((message) => message.includes("宠物保底共拿到 3 次成功")),
    "宠物保底应补满 3 次成功",
  );
});
