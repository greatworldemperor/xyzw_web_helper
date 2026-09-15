import assert from "node:assert/strict";
import { test } from "node:test";

import { createTasksCampChallengeStrategy } from "../src/utils/batch/tasksCampChallengeStrategy.js";
import { getCampTodayKey } from "../src/utils/batch/campChallengePlanner.js";

const todayKey = () => getCampTodayKey(new Date());

const ref = (value) => ({ value });

/**
 * 构造一个最小可用的 deps：tokenStore.sendMessageWithPromise 按命令返回应答，
 * 并把每次请求记录下来供断言。
 */
const createHarness = ({ respond }) => {
  const calls = [];
  const logs = [];
  const deps = {
    selectedTokens: ref(["t1"]),
    tokens: ref([{ id: "t1", name: "角色1", roleId: 1 }]),
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
  };

  const strategy = createTasksCampChallengeStrategy(deps);
  return { strategy, calls, logs, deps };
};

const baseRespond =
  ({ attackMap = {}, claimedMap = {} } = {}) =>
  (command) => {
    switch (command) {
      case "role_getroleinfo":
        return { role: { roleId: 1, lordWeaponId: 3, power: 100 } };
      case "presetteam_getinfo":
        return {
          presetTeamInfo: {
            useTeamId: 1,
            presetTeamInfo: {
              1: { teamInfo: { 0: { heroId: 116 }, 1: { heroId: 102 } } },
            },
          },
        };
      case "club_getinfo":
        return {
          club: { legionId: 99 },
          siege: { attackMap, taskClaimedMap: claimedMap },
        };
      case "hero_calcpowerbyteam":
        return { power: 100 };
      case "club_attackmonster":
        return {
          siege: { attackMap: { [todayKey()]: { attackCnt: 3, aSuccessCnt: 3 } } },
          battleData: { result: { isWin: true } },
        };
      case "club_taskclaim":
        return { siege: { taskClaimedMap: {} } };
      default:
        return {};
    }
  };

const commandsOf = (calls, command) =>
  calls.filter((call) => call.command === command);

test("简版宠物挑战：无当日记录时攻击 3 次，并按 taskClaimedMap 过滤后领奖", async () => {
  const { strategy, calls } = createHarness({ respond: baseRespond() });

  await strategy.batchCampChallengePet();

  const attacks = commandsOf(calls, "club_attackmonster");
  assert.equal(attacks.length, 3);

  // 每次攻击前都要先算战力，且报文体与真实客户端一致。
  assert.equal(commandsOf(calls, "hero_calcpowerbyteam").length, 3);
  for (const attack of attacks) {
    assert.deepEqual(Object.keys(attack.params).sort(), [
      "teamSetParams",
      "useItem",
    ]);
    assert.deepEqual(Object.keys(attack.params.teamSetParams).sort(), [
      "battleTeam",
      "lordWeaponId",
      "petUId",
    ]);
    assert.equal(attack.params.useItem, false);
    assert.deepEqual(attack.params.teamSetParams.battleTeam, {
      0: 116,
      1: 102,
    });
    assert.equal(attack.params.teamSetParams.petUId, "");
  }

  // confId=1 与 5..13 都会尝试；已领取的不再重复请求。
  const claimConfIds = commandsOf(calls, "club_taskclaim").map(
    (call) => call.params.confId,
  );
  assert.deepEqual(claimConfIds, [1, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test("简版宠物挑战：已领取的奖励不重复请求", async () => {
  const { strategy, calls } = createHarness({
    respond: baseRespond({ claimedMap: { 1: 1788939946, 5: 1789008064 } }),
  });

  await strategy.batchCampChallengePet();

  const claimConfIds = commandsOf(calls, "club_taskclaim").map(
    (call) => call.params.confId,
  );
  assert.deepEqual(claimConfIds, [6, 7, 8, 9, 10, 11, 12, 13]);
});

test("简版宠物挑战：按服务端剩余成功额度收敛攻击次数", async () => {
  const { strategy, calls } = createHarness({
    respond: baseRespond({
      attackMap: { [todayKey()]: { attackCnt: 1, aSuccessCnt: 2 } },
    }),
  });

  await strategy.batchCampChallengePet();

  // 每日成功上限 3，已成功 2 → 只应再打 1 次。
  assert.equal(commandsOf(calls, "club_attackmonster").length, 1);
});

test("简版宠物挑战：额度用尽时跳过攻击但仍领奖", async () => {
  const { strategy, calls } = createHarness({
    respond: baseRespond({
      attackMap: { [todayKey()]: { attackCnt: 10, aSuccessCnt: 3 } },
    }),
  });

  await strategy.batchCampChallengePet();

  assert.equal(commandsOf(calls, "club_attackmonster").length, 0);
  assert.equal(commandsOf(calls, "club_taskclaim").length, 10);
});

test("简版宠物挑战：攻击失败不阻塞领奖", async () => {
  const respond = baseRespond();
  const { strategy, calls } = createHarness({
    respond: (command, params, allCalls) => {
      if (command === "club_attackmonster") {
        const error = new Error("每日挑战次数已用完");
        error.code = 3000070;
        throw error;
      }
      return respond(command, params, allCalls);
    },
  });

  await strategy.batchCampChallengePet();

  assert.equal(commandsOf(calls, "club_attackmonster").length, 1);
  assert.equal(commandsOf(calls, "club_taskclaim").length, 10);
});

test("只领取营地奖励：同样按 taskClaimedMap 过滤", async () => {
  const { strategy, calls } = createHarness({
    respond: baseRespond({ claimedMap: { 1: 1788939946 } }),
  });

  await strategy.batchCampClaimTasks();

  const claimConfIds = commandsOf(calls, "club_taskclaim").map(
    (call) => call.params.confId,
  );
  assert.deepEqual(claimConfIds, [5, 6, 7, 8, 9, 10, 11, 12, 13]);
});
