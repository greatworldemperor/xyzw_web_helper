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

export const findCampOwnNodeId = (club, roleId) => {
  if (roleId === undefined || roleId === null) return null;

  for (const [rawNodeId, member] of Object.entries(club?.members || {})) {
    if (rawNodeId === "null" || String(member?.roleId) !== String(roleId)) {
      continue;
    }
    const nodeId = toFiniteNumber(rawNodeId);
    return nodeId !== null && Number.isInteger(nodeId) ? nodeId : null;
  }

  return null;
};

export const getCampTodayKey = (date = new Date()) => {
  const year = String(date.getFullYear() % 100).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
};

/**
 * 营地战斗日是每周二、三、四，每天只匹配一个敌方俱乐部。
 * `oppoMap` 的键就是星期几（周二=2、周三=3、周四=4），与 `Date.getDay()` 一致。
 * 只允许查询当天那一个键的对手，其它键的目标会被服务端以 200020 拒绝。
 */
export const getCampOppoKey = (date = new Date()) => String(date.getDay());

export const isCampBattleDay = (date = new Date()) => {
  const weekday = date.getDay();
  return weekday >= 2 && weekday <= 4;
};

export const getCampAttackStats = (siege, date = new Date()) => {
  const attackMap = siege?.attackMap || {};
  const todayKey = getCampTodayKey(date);
  const stats = attackMap[todayKey] || {};
  const todayRecordPresent = Object.prototype.hasOwnProperty.call(
    attackMap,
    todayKey,
  );
  const todayCountersPresent =
    Object.prototype.hasOwnProperty.call(stats, "attackCnt") &&
    Object.prototype.hasOwnProperty.call(stats, "aSuccessCnt");
  // The server stores daily entries only after an attack. Historical entries
  // prove that an omitted current-day key means zero attacks today.
  const known = todayRecordPresent
    ? todayCountersPresent
    : Object.keys(attackMap).length > 0;
  return {
    known,
    todayRecordPresent,
    todayCountersPresent,
    todayKey,
    attackMapKeys: Object.keys(attackMap),
    statsKeys: Object.keys(stats),
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

export const selectCampProbeTargets = (enemies) => {
  const byTargetId = new Map();
  const reusedMirrorNodes = [];
  const mirrorOnlyNodes = [];

  for (const enemy of enemies || []) {
    if (enemy.roleId === undefined || enemy.roleId === null) continue;
    const key = String(enemy.roleId);
    const current = byTargetId.get(key) || [];
    current.push(enemy);
    byTargetId.set(key, current);
  }

  const targets = [];
  for (const enemiesWithTarget of byTargetId.values()) {
    const activeNodes = enemiesWithTarget.filter(
      (enemy) => enemy.remainingTo5 > 0 && enemy.defeated !== true,
    );
    if (activeNodes.length === 0) continue;

    const original = enemiesWithTarget.find((enemy) => !enemy.targetIsMirror);
    if (original) {
      // The original is the probe source even when its own node is complete;
      // an active mirror with the same targetId can reuse its power/team.
      targets.push(original);
      reusedMirrorNodes.push(
        ...activeNodes.filter((enemy) => enemy.targetIsMirror),
      );
    } else {
      mirrorOnlyNodes.push(...activeNodes);
    }
  }

  return {
    targets,
    reusedMirrorNodes,
    mirrorOnlyNodes,
  };
};

/**
 * 把 oppoMap 转成节点列表。
 *
 * ⚠️ 只能传入**单个来源组**（`{ [sourceGroupKey]: opponent }`，或当天对手那一个键）。
 * 不同来源组的 nodeId 都是 1..30，跨组传进来会按 nodeId 互相覆盖，拼出一张"混合棋盘"；
 * 服务端只接受当天对手的目标，其余目标会返回 200020。
 */
export const collectCampEnemies = (oppoMap, targetPowers = {}) => {
  const enemiesByNodeId = new Map();

  for (const [sourceGroupKey, opponent] of Object.entries(oppoMap || {})) {
    if (sourceGroupKey === "null" || !opponent?.defenders) continue;

    for (const [rawNodeId, defender] of Object.entries(opponent.defenders)) {
      const nodeId = toFiniteNumber(rawNodeId);
      const groupId = getCampGroupId(nodeId);
      if (!defender || groupId === null) continue;

      const rawRoleId = defender.roleId ?? defender.targetId;
      const roleId = toFiniteNumber(rawRoleId) ?? rawRoleId;
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

/**
 * 取"当天唯一对手"的棋盘。每天只匹配一个敌方俱乐部，因此只读 `oppoMap[今天星期几]`；
 * 不存在则返回 null（非战斗日或当天对手未生成），调用方应跳过而不是去猜其它来源组。
 */
export const selectTodayCampOppo = (oppoMap, date = new Date()) => {
  const sourceGroupKey = getCampOppoKey(date);
  const opponent = oppoMap?.[sourceGroupKey];
  if (!opponent?.defenders) {
    return { sourceGroupKey, opponent: null, enemies: [], missing: true };
  }

  return {
    sourceGroupKey,
    opponent,
    enemies: collectCampEnemies({ [sourceGroupKey]: opponent }),
    missing: false,
  };
};

export const collectCampEnemyBoards = (oppoMap, targetPowers = {}) =>
  Object.entries(oppoMap || {})
    .filter(([sourceGroupKey, opponent]) =>
      sourceGroupKey !== "null" && opponent?.defenders,
    )
    .map(([sourceGroupKey, opponent]) => ({
      sourceGroupKey,
      opponent,
      enemies: collectCampEnemies({ [sourceGroupKey]: opponent }, targetPowers),
    }));

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

/**
 * 部分攻击计划：当三个区域组都无法整组全清时的降级方案。
 *
 * 规则（2026-09-17 与 master 确认）：
 * - 把当天对手的 30 个节点（**含镜像**）统一排序，优先推进"最接近清掉"的节点（剩余可击败次数少者优先）；
 * - 每个节点由"打得赢且最省额度"的我方角色补足，直到所有成员的成功额度用尽；
 * - `reserveWinsForPet` 保留每个成员最后 `remainingWins` 次发起额度给宠物保底
 *   （宠物攻击不计入服务端的 `attackCnt`，所以普通攻击要优先用掉发起次数）。
 *
 * 每个节点的剩余可击败次数来自 `5 - successCount`，见 `getCampSuccessCount`。
 */
export const planPartialCampAttacks = ({
  enemies,
  members,
  powerThreshold = 1,
  reserveWinsForPet = true,
}) => {
  const memberStates = (members || []).map(normalizeCampMember);
  if (memberStates.length === 0) {
    return {
      assignments: [],
      requiredWins: 0,
      skipped: [],
      reason: "missing-members",
    };
  }

  const targets = (enemies || [])
    .filter((enemy) => enemy && enemy.remainingTo5 > 0 && enemy.defeated !== true)
    .sort((left, right) => {
      const remainingDifference = left.remainingTo5 - right.remainingTo5;
      if (remainingDifference !== 0) return remainingDifference;
      const powerDifference = (left.power ?? -1) - (right.power ?? -1);
      if (powerDifference !== 0) return powerDifference;
      return left.nodeId - right.nodeId;
    });

  const assignmentsByKey = new Map();
  const skipped = [];
  const capacityStopped = [];
  let requiredWins = 0;

  for (const enemy of targets) {
    const neededWins = Math.max(0, enemy.remainingTo5 ?? 0);
    let assignedForThisEnemy = 0;
    let lastFailureReason = null;

    for (let attempt = 0; attempt < neededWins; attempt += 1) {
      const candidates = memberStates
        .filter((member) => {
          if (member.remainingWins <= 0 || member.power === null) return false;
          const normalBudget = reserveWinsForPet
            ? Math.max(0, member.remainingAttacks - member.remainingWins)
            : member.remainingAttacks;
          if (normalBudget <= 0) {
            lastFailureReason = "no-normal-budget";
            return false;
          }
          if (enemy.power === null || enemy.power === undefined) {
            lastFailureReason = "missing-target-power";
            return false;
          }
          if (enemy.power > member.power * powerThreshold) return false;
          return true;
        })
        .sort((left, right) => {
          const powerDifference = left.power - right.power;
          if (powerDifference !== 0) return powerDifference;
          return String(left.tokenId).localeCompare(String(right.tokenId));
        });

      const member = candidates[0];
      if (!member) break;

      member.remainingAttacks -= 1;
      member.remainingWins -= 1;
      requiredWins += 1;
      assignedForThisEnemy += 1;
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

    if (assignedForThisEnemy === 0) {
      skipped.push({
        nodeId: enemy.nodeId,
        power: enemy.power ?? null,
        remainingTo5: enemy.remainingTo5,
        reason: lastFailureReason || "unbeatable",
      });
    } else if (assignedForThisEnemy < neededWins) {
      capacityStopped.push({
        nodeId: enemy.nodeId,
        assigned: assignedForThisEnemy,
        remainingTo5: enemy.remainingTo5,
      });
    }
  }

  return {
    partial: true,
    assignments: [...assignmentsByKey.values()],
    requiredWins,
    skipped,
    capacityStopped,
    members: memberStates,
  };
};
