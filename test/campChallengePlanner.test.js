import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectCampEnemies,
  findCampOwnNodeId,
  getCampAttackStats,
  getCampGroupId,
  mergeCampOppoMaps,
  planCampGroup,
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
