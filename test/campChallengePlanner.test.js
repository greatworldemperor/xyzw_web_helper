import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectCampEnemyBoards,
  collectCampEnemies,
  findCampOwnNodeId,
  getCampAttackStats,
  getCampGroupId,
  mergeCampOppoMaps,
  planCampGroup,
  planPartialCampAttacks,
  selectCampProbeTargets,
  selectBestCampGroup,
} from "../src/utils/batch/campChallengePlanner.js";

test("daily attack stats are unknown unless both server counters are present", () => {
  assert.equal(getCampAttackStats({}).known, false);
  const noAttackToday = getCampAttackStats(
    {
      attackMap: {
        "260909": { attackCnt: 4, aSuccessCnt: 3 },
      },
    },
    new Date(2026, 8, 10),
  );
  assert.equal(noAttackToday.known, true);
  assert.equal(noAttackToday.todayRecordPresent, false);
  assert.equal(noAttackToday.attackCnt, 0);
  assert.equal(noAttackToday.aSuccessCnt, 0);
  assert.equal(
    getCampAttackStats({
      attackMap: {
        "260910": { attackCnt: 2, aSuccessCnt: 1 },
      },
    }, new Date(2026, 8, 10)).known,
    true,
  );
  assert.equal(
    getCampAttackStats({
      attackMap: {
        "260910": { attackCnt: 2 },
      },
    }, new Date(2026, 8, 10)).known,
    false,
  );
});

const createDefenders = ({
  groupPower = { 1: 100, 2: 80, 3: 200 },
  successCount = { 1: 3, 2: 4, 3: 0 },
} = {}) => {
  const defenders = {};
  for (let nodeId = 1; nodeId <= 30; nodeId += 1) {
    const groupId = getCampGroupId(nodeId);
    defenders[nodeId] = {
      roleId: 1000 + nodeId,
      power: groupPower[groupId],
      challengeCnt: successCount[groupId],
      failCnt: 0,
      mirror: nodeId % 2 === 0,
    };
  }
  return defenders;
};

test("camp node ids map to three groups without using zero", () => {
  assert.equal(getCampGroupId(0), null);
  assert.equal(getCampGroupId(1), 1);
  assert.equal(getCampGroupId(10), 1);
  assert.equal(getCampGroupId(11), 2);
  assert.equal(getCampGroupId(20), 2);
  assert.equal(getCampGroupId(21), 3);
  assert.equal(getCampGroupId(30), 3);
});

test("normalizes target role ids to numbers at the protocol boundary", () => {
  const enemies = collectCampEnemies({
    source: {
      defenders: {
        4: { roleId: "82712825", mirror: false, challengeCnt: 0, failCnt: 0 },
      },
    },
  });

  assert.equal(enemies[0].roleId, 82712825);
  assert.equal(enemies[0].targetId, 82712825);
  assert.equal(typeof enemies[0].targetId, "number");
});

test("maps a selected role to its own club node without using member counters", () => {
  assert.equal(
    findCampOwnNodeId(
      { members: { 2: { roleId: 139076719, challengeCnt: 0, failCnt: 0, score: 26 } } },
      139076719,
    ),
    2,
  );
  assert.equal(findCampOwnNodeId({ members: {} }, 139076719), null);
});

test("probe targets deduplicate mirrors by target id and prefer the original node", () => {
  const result = selectCampProbeTargets([
    { nodeId: 16, roleId: 704821233, targetIsMirror: true, remainingTo5: 5 },
    { nodeId: 8, roleId: 704821233, targetIsMirror: false, remainingTo5: 0 },
    { nodeId: 21, roleId: 700118197, targetIsMirror: true, remainingTo5: 5 },
    { nodeId: 22, roleId: 105811792, targetIsMirror: false, remainingTo5: 5 },
  ]);

  assert.deepEqual(result.targets.map((enemy) => enemy.nodeId), [8, 22]);
  assert.deepEqual(result.reusedMirrorNodes.map((enemy) => enemy.nodeId), [16]);
  assert.deepEqual(result.mirrorOnlyNodes.map((enemy) => enemy.nodeId), [21]);
});

test("merging club snapshots keeps mirror nodes with duplicate role ids", () => {
  const enemies = collectCampEnemies(
    mergeCampOppoMaps([
      {
        first: {
          defenders: {
            6: { roleId: 42, challengeCnt: 1, failCnt: 0 },
          },
        },
      },
      {
        second: {
          defenders: {
            20: { roleId: 42, mirror: true, challengeCnt: 0, failCnt: 0 },
          },
        },
      },
    ]),
  );

  assert.deepEqual(
    enemies.map((enemy) => [enemy.nodeId, enemy.roleId, enemy.targetIsMirror]),
    [
      [6, 42, false],
      [20, 42, true],
    ],
  );
});

test("keeps enemy clubs as separate 30-node boards", () => {
  const boards = collectCampEnemyBoards({
    "2": {
      legionId: 200,
      defenders: { 1: { roleId: 201 } },
    },
    "3": {
      legionId: 300,
      defenders: { 1: { roleId: 301 } },
    },
  });

  assert.deepEqual(
    boards.map((board) => [
      board.sourceGroupKey,
      board.opponent.legionId,
      board.enemies[0].nodeId,
      board.enemies[0].roleId,
    ]),
    [
      ["2", 200, 1, 201],
      ["3", 300, 1, 301],
    ],
  );
});

test("selects the highest reachable group instead of the first group", () => {
  const enemies = collectCampEnemies({
    source: { defenders: createDefenders() },
  });
  const members = [1, 2, 3, 4].map((id) => ({
    tokenId: `member-${id}`,
    power: 100,
    attackCnt: 0,
    aSuccessCnt: 0,
  }));
  const result = selectBestCampGroup({ enemies, members });

  assert.equal(result.groups[0].selectedStage, 4);
  assert.equal(result.groups[1].selectedStage, 5);
  assert.equal(result.groups[2].selectedStage, 0);
  assert.equal(result.selected.groupId, 2);
  assert.equal(result.selected.stage, 5);
});

test("manual progress reduces required wins for a lower reward stage", () => {
  const defenders = createDefenders({
    groupPower: { 1: 100, 2: 100, 3: 100 },
    successCount: { 1: 3, 2: 0, 3: 0 },
  });
  const enemies = collectCampEnemies({ source: { defenders } });
  const plan = planCampGroup({
    enemies,
    members: [
      { tokenId: "member", power: 100, attackCnt: 0, aSuccessCnt: 0 },
    ],
    groupId: 1,
    stage: 3,
  });

  assert.equal(plan.reachable, true);
  assert.equal(plan.requiredWins, 0);
  assert.deepEqual(plan.assignments, []);
});

test("an insufficient success budget makes a whole group unreachable", () => {
  const enemies = collectCampEnemies({
    source: { defenders: createDefenders({ successCount: { 1: 0, 2: 0, 3: 0 } }) },
  });
  const plan = planCampGroup({
    enemies,
    members: [
      { tokenId: "member", power: 100, attackCnt: 0, aSuccessCnt: 0 },
    ],
    groupId: 1,
    stage: 3,
  });

  assert.equal(plan.reachable, false);
  assert.equal(plan.reason, "insufficient-capacity");
});

test("部分攻击计划：整组清不掉时集中打能打赢的节点，并按剩余次数与战力排序", () => {
  const enemies = collectCampEnemies({
    source: {
      defenders: {
        // 9.71 亿（最弱、0 进度）优先；nodeId=2 更接近清掉（剩 2 次）；nodeId=3 打不动。
        1: { roleId: 11, power: 971000000, challengeCnt: 0, failCnt: 0 },
        2: { roleId: 12, power: 1000000000, challengeCnt: 3, failCnt: 0 },
        3: { roleId: 13, power: 9000000000, challengeCnt: 0, failCnt: 0 },
      },
    },
  });
  const plan = planPartialCampAttacks({
    enemies,
    members: [
      { tokenId: "weak", power: 1500000000, attackCnt: 0, aSuccessCnt: 0 },
    ],
    powerThreshold: 0.75,
  });

  // 只有 1.5 亿 × 75% = 1.125 亿以上的目标能打；9 亿的 nodeId=3 打不动。
  assert.deepEqual(
    plan.assignments.map((item) => [item.nodeId, item.count]),
    [[2, 2], [1, 1]],
    "先补剩余 2 次的 nodeId=2，再用剩余成功额度打最弱的 nodeId=1",
  );
  assert.deepEqual(plan.skipped.map((item) => item.nodeId), [3]);
  // nodeId=1 只分到 1 次就被成功额度限制住，不算"打不动"，单独记录。
  assert.deepEqual(plan.capacityStopped.map((item) => item.nodeId), [1]);
  assert.equal(plan.requiredWins, 3);
});

test("部分攻击计划：保留剩余成功额度给宠物保底，不把发起次数全打光", () => {
  const enemies = collectCampEnemies({
    source: {
      defenders: {
        1: { roleId: 11, power: 100000000, challengeCnt: 0, failCnt: 0 },
        2: { roleId: 12, power: 100000000, challengeCnt: 0, failCnt: 0 },
      },
    },
  });
  const plan = planPartialCampAttacks({
    enemies,
    members: [
      // 已发起 8 次、成功 0 次：剩余发起 2 次，剩余成功 3 次。
      { tokenId: "member", power: 1000000000, attackCnt: 8, aSuccessCnt: 0 },
    ],
    powerThreshold: 0.75,
    reserveWinsForPet: true,
  });

  // 剩余发起少于剩余成功，普通攻击必须留出给宠物保底，因此一次都不打。
  assert.deepEqual(plan.assignments, []);
  assert.equal(plan.requiredWins, 0);

  const withoutReserve = planPartialCampAttacks({
    enemies,
    members: [
      { tokenId: "member", power: 1000000000, attackCnt: 8, aSuccessCnt: 0 },
    ],
    powerThreshold: 0.75,
    reserveWinsForPet: false,
  });
  assert.equal(withoutReserve.requiredWins, 2);
});
