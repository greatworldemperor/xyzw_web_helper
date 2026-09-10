export const CAMP_NODE_MIN = 1;
export const CAMP_NODE_MAX = 30;
export const CAMP_GROUP_SIZE = 10;
export const CAMP_GROUP_COUNT = 3;
export const CAMP_MAX_ATTACKS = 10;
export const CAMP_MAX_SUCCESS = 3;
export const CAMP_STAGES = [5, 4, 3];

export const CAMP_REWARD_CONF_IDS = Object.freeze({
  1: Object.freeze([5, 6, 7]),
  2: Object.freeze([8, 9, 10]),
  3: Object.freeze([11, 12, 13]),
});

const toFiniteNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const readTargetPower = (targetPowers, roleId) => {
  if (!targetPowers || roleId === undefined || roleId === null) return null;
  const value = targetPowers instanceof Map
    ? targetPowers.get(String(roleId)) ?? targetPowers.get(roleId)
    : targetPowers[String(roleId)];
  return toFiniteNumber(value);
};

export const getCampGroupId = (nodeId) => {
  const numericNodeId = toFiniteNumber(nodeId);
  if (
    numericNodeId === null ||
    !Number.isInteger(numericNodeId) ||
    numericNodeId < CAMP_NODE_MIN ||
    numericNodeId > CAMP_NODE_MAX
  ) {
    return null;
  }
  return Math.floor((numericNodeId - CAMP_NODE_MIN) / CAMP_GROUP_SIZE) + 1;
};

export const getCampTodayKey = (date = new Date()) => {
  const year = String(date.getFullYear() % 100).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
};

export const getCampAttackStats = (siege, date = new Date()) => {
  const attackMap = siege?.attackMap || {};
  const todayKey = getCampTodayKey(date);
  const stats = attackMap[todayKey] || {};
  const known =
    Object.prototype.hasOwnProperty.call(stats, "attackCnt") &&
    Object.prototype.hasOwnProperty.call(stats, "aSuccessCnt");
  return {
    known,
    attackCnt: Math.max(0, toFiniteNumber(stats.attackCnt) ?? 0),
    aSuccessCnt: Math.max(0, toFiniteNumber(stats.aSuccessCnt) ?? 0),
  };
};

export const mergeCampOppoMaps = (maps = []) => {
  const merged = {};

  for (const map of maps) {
    for (const [sourceGroupKey, opponent] of Object.entries(map || {})) {
      if (sourceGroupKey === "null" || !opponent?.defenders) continue;

      const current = merged[sourceGroupKey] || {
        ...opponent,
        defenders: {},
      };
      current.defenders = { ...current.defenders };

      for (const [nodeId, defender] of Object.entries(opponent.defenders)) {
        const previous = current.defenders[nodeId];
        if (!previous) {
          current.defenders[nodeId] = defender;
          continue;
        }

        const previousSuccess = getCampSuccessCount(previous);
        const nextSuccess = getCampSuccessCount(defender);
        current.defenders[nodeId] = nextSuccess >= previousSuccess
          ? { ...previous, ...defender }
          : previous;
      }

      merged[sourceGroupKey] = current;
    }
  }

  return merged;
};

export const getCampSuccessCount = (defender) => {
  const explicitSuccessCount = toFiniteNumber(defender?.successCount);
  if (explicitSuccessCount !== null) return Math.max(0, explicitSuccessCount);

  const challengeCnt = toFiniteNumber(defender?.challengeCnt);
  const failCnt = toFiniteNumber(defender?.failCnt);
  if (challengeCnt !== null || failCnt !== null) {
    return Math.max(0, (challengeCnt ?? 0) - (failCnt ?? 0));
  }

  return defender?.defeated === true ? 5 : 0;
};

export const collectCampEnemies = (oppoMap, targetPowers = {}) => {
  const enemiesByNodeId = new Map();

  for (const [sourceGroupKey, opponent] of Object.entries(oppoMap || {})) {
    if (sourceGroupKey === "null" || !opponent?.defenders) continue;

    for (const [rawNodeId, defender] of Object.entries(opponent.defenders)) {
      const nodeId = toFiniteNumber(rawNodeId);
      const groupId = getCampGroupId(nodeId);
      if (!defender || groupId === null) continue;

      const roleId = defender.roleId ?? defender.targetId;
      const candidate = {
        nodeId,
        groupId,
        sourceGroupKey,
        sourceGroupKeys: [sourceGroupKey],
        roleId,
        targetId: roleId,
        targetIsMirror: Boolean(defender.mirror),
        name: defender.name || `node-${nodeId}`,
        power: toFiniteNumber(defender.power) ?? readTargetPower(targetPowers, roleId),
        challengeCnt: Math.max(0, toFiniteNumber(defender.challengeCnt) ?? 0),
        failCnt: Math.max(0, toFiniteNumber(defender.failCnt) ?? 0),
        defeated: defender.defeated === true,
        successCount: getCampSuccessCount(defender),
      };
      candidate.remainingTo5 = Math.max(0, 5 - candidate.successCount);

      const existing = enemiesByNodeId.get(nodeId);
      if (!existing) {
        enemiesByNodeId.set(nodeId, candidate);
        continue;
      }

      existing.sourceGroupKeys = [
        ...new Set([...existing.sourceGroupKeys, sourceGroupKey]),
      ];
      if (existing.power === null && candidate.power !== null) {
        existing.power = candidate.power;
      }
      if (candidate.successCount > existing.successCount) {
        enemiesByNodeId.set(nodeId, {
          ...existing,
          ...candidate,
          sourceGroupKeys: existing.sourceGroupKeys,
        });
      }
    }
  }

  return [...enemiesByNodeId.values()].sort((left, right) => left.nodeId - right.nodeId);
};

export const normalizeCampMember = (member) => {
  const attackCnt = Math.max(0, toFiniteNumber(member?.attackCnt) ?? 0);
  const aSuccessCnt = Math.max(0, toFiniteNumber(member?.aSuccessCnt) ?? 0);
  const remainingAttacks = Math.max(0, CAMP_MAX_ATTACKS - attackCnt);
  const remainingWins = Math.max(0, CAMP_MAX_SUCCESS - aSuccessCnt);

  return {
    ...member,
    power: toFiniteNumber(member?.power),
    attackCnt,
    aSuccessCnt,
    remainingAttacks,
    remainingWins,
    remainingCapacity: Math.min(remainingAttacks, remainingWins),
  };
};

const makeUnreachablePlan = (groupId, stage, reason, details = {}) => ({
  groupId,
  stage,
  reachable: false,
  reason,
  assignments: [],
  requiredWins: 0,
  minPowerMargin: null,
  ...details,
});

export const planCampGroup = ({
  enemies,
  members,
  groupId,
  stage,
  powerThreshold = 1,
  requireCompleteNodes = true,
}) => {
  const groupEnemies = (enemies || [])
    .filter((enemy) => enemy.groupId === groupId)
    .sort((left, right) => {
      const powerDifference = (right.power ?? -1) - (left.power ?? -1);
      return powerDifference || left.nodeId - right.nodeId;
    });

  const expectedNodeIds = Array.from({ length: CAMP_GROUP_SIZE }, (_, index) =>
    (groupId - 1) * CAMP_GROUP_SIZE + index + 1,
  );
  const actualNodeIds = new Set(groupEnemies.map((enemy) => enemy.nodeId));
  const missingNodeIds = expectedNodeIds.filter((nodeId) => !actualNodeIds.has(nodeId));
  if (requireCompleteNodes && missingNodeIds.length > 0) {
    return makeUnreachablePlan(groupId, stage, "missing-nodes", { missingNodeIds });
  }

  const demands = [];
  for (const enemy of groupEnemies) {
    const successCount = Math.min(5, Math.max(0, enemy.successCount ?? getCampSuccessCount(enemy)));
    const requiredWins = Math.max(0, stage - successCount);
    if (requiredWins === 0) continue;
    if (enemy.power === null || enemy.power === undefined) {
      return makeUnreachablePlan(groupId, stage, "missing-target-power", {
        nodeId: enemy.nodeId,
      });
    }
    demands.push({ enemy, requiredWins });
  }

  const memberStates = (members || []).map(normalizeCampMember);
  if (memberStates.length === 0) {
    return makeUnreachablePlan(groupId, stage, "missing-members");
  }

  const assignmentsByKey = new Map();
  let requiredWins = 0;
  let minPowerMargin = null;

  for (const { enemy, requiredWins: enemyRequiredWins } of demands) {
    for (let attempt = 0; attempt < enemyRequiredWins; attempt++) {
      const candidates = memberStates
        .filter((member) => {
          if (member.remainingCapacity <= 0 || member.power === null) return false;
          return enemy.power <= member.power * powerThreshold;
        })
        .sort((left, right) => {
          const powerDifference = left.power - right.power;
          if (powerDifference !== 0) return powerDifference;
          return String(left.tokenId).localeCompare(String(right.tokenId));
        });

      const member = candidates[0];
      if (!member) {
        const strongestPower = memberStates.reduce(
          (highest, current) => Math.max(highest, current.power ?? -1),
          -1,
        );
        const reason = strongestPower < enemy.power * powerThreshold
          ? "unbeatable"
          : "insufficient-capacity";
        return makeUnreachablePlan(groupId, stage, reason, {
          nodeId: enemy.nodeId,
          requiredWins,
        });
      }

      member.remainingAttacks -= 1;
      member.remainingWins -= 1;
      member.remainingCapacity = Math.min(
        member.remainingAttacks,
        member.remainingWins,
      );
      requiredWins += 1;
      const powerMargin = member.power * powerThreshold - enemy.power;
      minPowerMargin = minPowerMargin === null
        ? powerMargin
        : Math.min(minPowerMargin, powerMargin);

      const key = `${member.tokenId}:${enemy.nodeId}`;
      const assignment = assignmentsByKey.get(key) || {
        tokenId: member.tokenId,
        nodeId: enemy.nodeId,
        targetId: enemy.targetId,
        targetIsMirror: enemy.targetIsMirror,
        count: 0,
      };
      assignment.count += 1;
      assignmentsByKey.set(key, assignment);
    }
  }

  return {
    groupId,
    stage,
    reachable: true,
    reason: null,
    assignments: [...assignmentsByKey.values()],
    requiredWins,
    minPowerMargin,
    remainingMembers: memberStates,
    missingNodeIds,
  };
};

export const selectBestCampGroup = ({
  enemies,
  members,
  powerThreshold = 1,
  requireCompleteNodes = true,
}) => {
  const groups = [];
  for (let groupId = 1; groupId <= CAMP_GROUP_COUNT; groupId += 1) {
    let selectedPlan = null;
    const stagePlans = [];
    for (const stage of CAMP_STAGES) {
      const plan = planCampGroup({
        enemies,
        members,
        groupId,
        stage,
        powerThreshold,
        requireCompleteNodes,
      });
      stagePlans.push(plan);
      if (!selectedPlan && plan.reachable) selectedPlan = plan;
    }
    groups.push({
      groupId,
      selectedStage: selectedPlan?.stage ?? 0,
      selectedPlan,
      stagePlans,
    });
  }

  const reachableGroups = groups
    .filter((group) => group.selectedPlan)
    .sort((left, right) => {
      const stageDifference = right.selectedStage - left.selectedStage;
      if (stageDifference !== 0) return stageDifference;
      const winsDifference =
        left.selectedPlan.requiredWins - right.selectedPlan.requiredWins;
      if (winsDifference !== 0) return winsDifference;
      const marginDifference =
        (right.selectedPlan.minPowerMargin ?? -Infinity) -
        (left.selectedPlan.minPowerMargin ?? -Infinity);
      return marginDifference || left.groupId - right.groupId;
    });

  return {
    selected: reachableGroups[0]?.selectedPlan ?? null,
    groups,
  };
};

export const getCampRewardConfIds = (groupId) =>
  CAMP_REWARD_CONF_IDS[groupId] ? [...CAMP_REWARD_CONF_IDS[groupId]] : [];
