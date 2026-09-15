import {
  CAMP_MAX_ATTACKS,
  CAMP_MAX_SUCCESS,
  collectCampEnemies,
  findCampOwnNodeId,
  getCampAttackStats,
  getCampSuccessCount,
  getCampRewardConfIds,
  mergeCampOppoMaps,
  selectCampProbeTargets,
  selectBestCampGroup,
} from "./campChallengePlanner.js";

/** 简化版固定对宠物发起 3 次挑战（与智能规划并列的另一条路径）。 */
const CAMP_SIMPLE_PET_ATTEMPTS = 3;

/**
 * 领奖顺序：confId=1 是累计战斗 3 次奖励，其余为三组的普通/困难/炼狱全清奖励。
 * 抓包确认第一组 5/6/7、第二组 8/9/10、第三组 11/12/13。
 */
const CAMP_REWARD_CLAIM_ORDER = [
  1,
  ...[1, 2, 3].flatMap((groupId) => getCampRewardConfIds(groupId)),
];

const getRoleData = (roleInfo) => roleInfo?.role || roleInfo?.roleInfo || {};

const getRolePower = (roleInfo) => {
  const role = getRoleData(roleInfo);
  const power = Number(role.power ?? role.role?.power);
  return Number.isFinite(power) ? power : null;
};

const buildTeamSetParams = (presetTeamResult, roleInfo, batchSettings) => {
  const role = getRoleData(roleInfo);
  const configuredFormation = batchSettings?.arenaFormation ?? 1;
  const formationId = String(
    configuredFormation === "current"
      ? (presetTeamResult?.presetTeamInfo?.useTeamId ?? 1)
      : configuredFormation,
  );
  const root =
    presetTeamResult?.presetTeamInfo?.presetTeamInfo ||
    presetTeamResult?.presetTeamInfo ||
    {};
  const teamInfoData =
    root[formationId]?.teamInfo || root["1"]?.teamInfo || {};
  const battleTeam = {};

  for (const [position, hero] of Object.entries(teamInfoData)) {
    const heroId = hero?.heroId ?? hero?.id;
    if (heroId !== undefined && heroId !== null) {
      battleTeam[position] = Number(heroId);
    }
  }

  if (Object.keys(battleTeam).length === 0) {
    throw new Error(`无法获取阵容${formationId}数据`);
  }

  // 抓包确认（local-data/camp_data/camp_data.jsonl，13/13 逐字节复现）：
  // hero_calcpowerbyteam 与 club_attack/club_attackmonster 的 teamSetParams
  // 只含 lordWeaponId / petUId / battleTeam 三个字段，不能带上本地辅助字段。
  return {
    lordWeaponId: Number(role.lordWeaponId || 0),
    petUId: "",
    battleTeam,
  };
};

const getClubId = (clubInfo) => {
  const value = clubInfo?.club?.legionId;
  return value === undefined || value === null || value === ""
    ? null
    : String(value);
};

const getKeys = (value) =>
  value && typeof value === "object" ? Object.keys(value) : [];

const getDefenderNodeCount = (oppoMap) => {
  const nodeIds = new Set();
  for (const opponent of Object.values(oppoMap || {})) {
    for (const nodeId of Object.keys(opponent?.defenders || {})) {
      if (nodeId !== "null") nodeIds.add(nodeId);
    }
  }
  return nodeIds.size;
};

const getTodayAttackStats = (member, response) => {
  const stats = getCampAttackStats(response?.siege);
  if (stats.known) {
    member.attackCnt = stats.attackCnt;
    member.aSuccessCnt = stats.aSuccessCnt;
    return;
  }

  member.attackCnt += 1;
  if (response?.battleData?.result?.accept?.ext?.curHP === 0) {
    member.aSuccessCnt += 1;
  }
};

const isCampWin = (response) =>
  response?.battleData?.result?.accept?.ext?.curHP === 0;

const formatPlanSummary = (groups) =>
  groups
    .map((group) => `第${group.groupId}组:${group.selectedStage || "不可达"}`)
    .join("，");

const getSaltRoadDate = (date = new Date()) => {
  const saturdayOffset = date.getDay() === 0 ? -1 : 6 - date.getDay();
  const saturday = new Date(date);
  saturday.setDate(date.getDate() + saturdayOffset);
  // The game requests the most recent/current Saturday for this weekly view.
  if (saturday > date) saturday.setDate(saturday.getDate() - 7);
  return [
    saturday.getFullYear(),
    String(saturday.getMonth() + 1).padStart(2, "0"),
    String(saturday.getDate()).padStart(2, "0"),
  ].join("/");
};

/**
 * Club-scoped camp strategy. UI only triggers this task; all protocol work
 * and planning stay in this module.
 */
export function createTasksCampChallengeStrategy(deps) {
  const {
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot,
    tokenStore,
    addLog,
    message,
    currentRunningTokenId,
    batchSettings,
  } = deps;

  const log = (text, type = "info") => {
    addLog?.({
      time: new Date().toLocaleTimeString(),
      message: text,
      type,
    });
  };

  const withTokenConnection = async (tokenId, callback) => {
    let slotAttempted = false;
    const token = tokens.value.find((item) => item.id === tokenId);
    const tokenName = token?.name || tokenId;
    try {
      slotAttempted = true;
      log(`[营地诊断] ${tokenName} 开始建立连接/初始化`, "info");
      await ensureConnection(tokenId);
      log(
        `[营地诊断] ${tokenName} 连接/初始化完成，status=${tokenStore.getWebSocketStatus(tokenId)}`,
        "info",
      );
      return await callback();
    } catch (error) {
      log(
        `[营地诊断] ${tokenName} 连接或请求阶段失败: ` +
          `status=${tokenStore.getWebSocketStatus(tokenId)} ` +
          `code=${error?.code || "-"} message=${error?.message || error}`,
        "warning",
      );
      throw error;
    } finally {
      try {
        await tokenStore.closeWebSocketConnection(tokenId);
      } finally {
        if (slotAttempted) releaseConnectionSlot();
      }
    }
  };

  const readMemberSnapshot = async (tokenId) => {
    const token = tokens.value.find((item) => item.id === tokenId);
    if (!token) throw new Error(`未找到角色 ${tokenId}`);

    return withTokenConnection(tokenId, async () => {
      const sendSnapshotCommand = async (command, timeout, params = {}) => {
        log(`[营地诊断] ${token.name} 请求 ${command}`, "info");
        try {
          const response = await tokenStore.sendMessageWithPromise(
            tokenId,
            command,
            params,
            timeout,
          );
          log(
            `[营地诊断] ${token.name} 响应 ${command}: ` +
              `topKeys=${getKeys(response).join(",") || "-"}`,
            "info",
          );
          return response;
        } catch (error) {
          log(
            `[营地诊断] ${token.name} 请求 ${command} 失败: ` +
              `code=${error?.code || "-"} message=${error?.message || error}`,
            "warning",
          );
          throw error;
        }
      };

      const roleInfo = await sendSnapshotCommand("role_getroleinfo", 15000);
      const presetTeam = await sendSnapshotCommand("presetteam_getinfo", 8000);
      await sendSnapshotCommand("legion_getinfo", 10000);
      await sendSnapshotCommand("saltroad_getwartype", 10000, {
        date: getSaltRoadDate(),
      });
      const clubInfo = await sendSnapshotCommand("club_getinfo", 15000);

      const clubId = getClubId(clubInfo);
      if (!clubId) throw new Error("club_getinfo 缺少 club.legionId");

      const teamSetParams = buildTeamSetParams(
        presetTeam,
        roleInfo,
        batchSettings,
      );
      const attackStats = getCampAttackStats(clubInfo?.siege);
      const roleId = getRoleData(roleInfo)?.roleId ?? token.roleId;
      const ownNodeId = findCampOwnNodeId(clubInfo?.club, roleId);
      const oppoMap = clubInfo?.club?.oppoMap || {};
      log(
        `[营地诊断] ${token.name} club_getinfo 结构: ` +
          `topKeys=${getKeys(clubInfo).join(",") || "-"} ` +
          `clubKeys=${getKeys(clubInfo?.club).join(",") || "-"} ` +
          `siegeKeys=${getKeys(clubInfo?.siege).join(",") || "-"} ` +
          `oppoGroups=${Object.keys(oppoMap).filter((key) => key !== "null").length} ` +
          `nodes=${getDefenderNodeCount(oppoMap)} ` +
          `todayKey=${attackStats.todayKey} ` +
          `todayRecord=${attackStats.todayRecordPresent} ` +
          `statsKnown=${attackStats.known} ` +
          `attackCnt=${attackStats.attackCnt} ` +
          `aSuccessCnt=${attackStats.aSuccessCnt} ` +
          `attackMapKeys=${attackStats.attackMapKeys.join(",") || "-"} ` +
          `todayStatsKeys=${attackStats.statsKeys.join(",") || "-"} ` +
          `ownNodeId=${ownNodeId ?? "-"} ` +
          "ownMemberCounters=ignored",
        "info",
      );

      return {
        tokenId,
        token,
        clubId,
        roleId,
        ownNodeId,
        power: getRolePower(roleInfo),
        attackCnt: attackStats.attackCnt,
        aSuccessCnt: attackStats.aSuccessCnt,
        attackStatsKnown: attackStats.known,
        teamSetParams,
        oppoMap,
        clubInfo,
      };
    });
  };

  const queryTargetPowers = async (members, enemies) => {
    const probeSelection = selectCampProbeTargets(enemies);
    const queryableEnemies = probeSelection.targets;
    const reusedMirrorNodes = probeSelection.reusedMirrorNodes;
    const mirrorOnlyNodes = probeSelection.mirrorOnlyNodes;
    const activeEnemies = enemies.filter(
      (enemy) => enemy.remainingTo5 > 0 && enemy.defeated !== true,
    );
    const roleIds = [
      ...new Set(
        queryableEnemies
          .map((enemy) => enemy.roleId)
          .filter((roleId) => roleId !== undefined && roleId !== null),
      ),
    ];
    const targetPowers = {};
    const unavailableTargets = [];

    log(
      `[营地诊断] 敌方目标查询：总节点=${enemies.length}，` +
        `剩余节点=${activeEnemies.length}，探测原版=${queryableEnemies.length}，` +
        `跳过已完成节点=${enemies.length - activeEnemies.length}，` +
        `镜像复用=${reusedMirrorNodes.length}，镜像无原版跳过=${mirrorOnlyNodes.length}，` +
        `待查询角色=${roleIds.length}`,
      "info",
    );

    const completedNodeIds = new Set();
    if (roleIds.length === 0) {
      return { targetPowers, unavailableTargets, completedNodeIds };
    }

    const queryCandidates = [...(Array.isArray(members) ? members : [members])]
      .filter(Boolean)
      .map((item) => ({
        item,
        remainingCapacity: Math.max(
          0,
          Math.min(10 - item.attackCnt, 3 - item.aSuccessCnt),
        ),
      }))
      .sort((left, right) => right.remainingCapacity - left.remainingCapacity)
      .slice(0, 3)
      .map((entry) => entry.item);

    if (queryCandidates.length === 0) {
      throw new Error("该 club 没有剩余攻击/成功容量可用于查询目标阵容");
    }

    const queryDelayMs = Math.max(
      300,
      Number(batchSettings?.commandDelay ?? 500),
    );
    const retryDelayMs = Math.max(1000, queryDelayMs * 2);
    const pendingRoleIds = new Set(roleIds.map((roleId) => String(roleId)));
    const lastErrors = new Map();
    for (const queryMember of queryCandidates) {
      if (pendingRoleIds.size === 0) break;

      log(
        `[营地诊断] 使用 ${queryMember.token.name} 查询敌方阵容：` +
          `attackCnt=${queryMember.attackCnt} aSuccessCnt=${queryMember.aSuccessCnt} ` +
          `待查询=${pendingRoleIds.size}`,
        "info",
      );

      try {
        await withTokenConnection(queryMember.tokenId, async () => {
          // The game establishes the club target context through getinfo on
          // the same connection before accepting gettargetteam requests.
          log(
            `[营地诊断] ${queryMember.token.name} 查询目标前刷新 club_getinfo 上下文`,
            "info",
          );
          await tokenStore.sendMessageWithPromise(
            queryMember.tokenId,
            "legion_getinfo",
            {},
            10000,
          );
          await tokenStore.sendMessageWithPromise(
            queryMember.tokenId,
            "saltroad_getwartype",
            { date: getSaltRoadDate() },
            10000,
          );
          const queryClubInfo = await tokenStore.sendMessageWithPromise(
            queryMember.tokenId,
            "club_getinfo",
            {},
            10000,
          );
          const queryRoleIds = new Set();
          const queryNodeIds = new Set();
          const queryDefendersByRole = new Map();
          for (const opponent of Object.values(queryClubInfo?.club?.oppoMap || {})) {
            for (const [nodeId, defender] of Object.entries(opponent?.defenders || {})) {
              if (nodeId === "null") continue;
              queryNodeIds.add(String(nodeId));
              if (defender?.roleId !== undefined && defender?.roleId !== null) {
                queryRoleIds.add(String(defender.roleId));
                const roleMatches = queryDefendersByRole.get(String(defender.roleId)) || [];
                roleMatches.push({ nodeId, defender });
                queryDefendersByRole.set(String(defender.roleId), roleMatches);
              }
            }
          }
          for (const roleId of [...pendingRoleIds]) {
            const matches = queryDefendersByRole.get(String(roleId)) || [];
            const activeMatches = matches.filter(({ defender }) => {
              const successCount = getCampSuccessCount(defender);
              return defender?.defeated !== true && successCount < 5;
            });
            if (matches.length > 0 && activeMatches.length === 0) {
              for (const { nodeId } of matches) completedNodeIds.add(Number(nodeId));
              pendingRoleIds.delete(String(roleId));
            }
          }
          log(
            `[营地诊断] 查询连接 club_getinfo 上下文：` +
              `nodes=${queryNodeIds.size} roles=${queryRoleIds.size} ` +
              `requestedRoles=${pendingRoleIds.size} ` +
              `missingRoles=${[...pendingRoleIds].filter((roleId) => !queryRoleIds.has(String(roleId))).join(",") || "-"}`,
            "info",
          );

          const contextReadyDelayMs = Math.max(
            3000,
            Number(batchSettings?.commandDelay ?? 500) * 4,
          );
          log(
            `[营地诊断] 等待 club_getinfo 上下文稳定 ${contextReadyDelayMs}ms 后开始查询目标`,
            "info",
          );
          await new Promise((resolve) => setTimeout(resolve, contextReadyDelayMs));

          let index = 0;
          for (const roleId of [...pendingRoleIds]) {
            if (index > 0) {
              await new Promise((resolve) => setTimeout(resolve, queryDelayMs));
            }
            index += 1;
            const enemy = queryableEnemies.find(
              (item) => String(item.roleId) === String(roleId),
            );
            log(
              `[营地诊断] ${queryMember.token.name} 请求 club_gettargetteam ` +
                `targetId=${roleId} nodeId=${enemy?.nodeId ?? "-"} ` +
                `mirror=${enemy?.targetIsMirror ?? "-"}`,
              "info",
            );
            let targetTeam = null;
            let lastError = null;
            for (let attempt = 1; attempt <= 2; attempt += 1) {
              try {
                targetTeam = await tokenStore.sendMessageWithPromise(
                  queryMember.tokenId,
                  "club_gettargetteam",
                  { targetId: roleId },
                  8000,
                );
                break;
              } catch (error) {
                lastError = error;
                if (attempt < 2) {
                  log(
                    `[营地诊断] ${queryMember.token.name} club_gettargetteam 暂时失败，` +
                      `${retryDelayMs}ms 后重试: targetId=${roleId} ` +
                      `nodeId=${enemy?.nodeId ?? "-"} code=${error?.code || "-"}`,
                    "warning",
                  );
                  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
                }
              }
            }

            if (!targetTeam) {
              lastErrors.set(String(roleId), lastError || new Error("目标查询没有返回"));
              continue;
            }

            const power = Number(targetTeam?.roleBattleTeam?.role?.power);
            if (!Number.isFinite(power)) {
              lastErrors.set(String(roleId), new Error("缺少 roleBattleTeam.role.power"));
              continue;
            }

            targetPowers[String(roleId)] = power;
            pendingRoleIds.delete(String(roleId));
            log(
              `[营地诊断] ${queryMember.token.name} club_gettargetteam 成功: ` +
                `targetId=${roleId} nodeId=${enemy?.nodeId ?? "-"} power=${power}`,
              "info",
            );
          }
        });
      } catch (error) {
        log(
          `[营地诊断] 查询角色 ${queryMember.token.name} 连接/请求失败，` +
            `将切换同 club 查询角色: code=${error?.code || "-"} ` +
            `message=${error?.message || error}`,
          "warning",
        );
      }
    }

    for (const roleId of pendingRoleIds) {
      const enemy = queryableEnemies.find(
        (item) => String(item.roleId) === String(roleId),
      );
      const error = lastErrors.get(String(roleId));
      unavailableTargets.push({
        roleId,
        nodeId: enemy?.nodeId ?? null,
        targetIsMirror: enemy?.targetIsMirror ?? null,
        code: error?.code || null,
        message: error?.message || "目标查询失败",
      });
    }

    return { targetPowers, unavailableTargets, completedNodeIds };
  };

  const executePlan = async (clubContext, plan) => {
    const enemiesByNodeId = new Map(
      clubContext.enemies.map((enemy) => [enemy.nodeId, enemy]),
    );
    const assignmentsByToken = new Map();

    for (const assignment of plan.assignments) {
      const current = assignmentsByToken.get(assignment.tokenId) || [];
      current.push(assignment);
      assignmentsByToken.set(assignment.tokenId, current);
    }

    for (const member of clubContext.members) {
      const assignments = assignmentsByToken.get(member.tokenId) || [];
      if (assignments.length === 0) continue;

      await withTokenConnection(member.tokenId, async () => {
        await tokenStore.sendMessageWithPromise(
          member.tokenId,
          "legion_getinfo",
          {},
          10000,
        );
        await tokenStore.sendMessageWithPromise(
          member.tokenId,
          "saltroad_getwartype",
          { date: getSaltRoadDate() },
          10000,
        );
        await tokenStore.sendMessageWithPromise(
          member.tokenId,
          "club_getinfo",
          {},
          10000,
        );

        for (const assignment of assignments) {
          for (let attempt = 0; attempt < assignment.count; attempt += 1) {
            if (shouldStop.value) return;
            const enemy = enemiesByNodeId.get(assignment.nodeId);
            if (!enemy) throw new Error(`计划中的 nodeId 不存在: ${assignment.nodeId}`);

            await tokenStore.sendMessageWithPromise(
              member.tokenId,
              "club_gettargetteam",
              { targetId: enemy.targetId },
              8000,
            );
            await tokenStore.sendMessageWithPromise(
              member.tokenId,
              "hero_calcpowerbyteam",
              member.teamSetParams,
              8000,
            );

            const attackResponse = await tokenStore.sendMessageWithPromise(
              member.tokenId,
              "club_attack",
              {
                nodeId: enemy.nodeId,
                targetId: enemy.targetId,
                targetIsMirror: enemy.targetIsMirror,
                challengeCnt: enemy.challengeCnt,
                failCnt: enemy.failCnt,
                useItem: false,
                teamSetParams: member.teamSetParams,
              },
              10000,
            );

            const won = isCampWin(attackResponse);
            getTodayAttackStats(member, attackResponse);
            enemy.challengeCnt += 1;
            if (won) {
              enemy.successCount += 1;
              enemy.remainingTo5 = Math.max(0, 5 - enemy.successCount);
            } else {
              enemy.failCnt += 1;
            }

            log(
              `${member.token.name} [club ${clubContext.clubId}] ` +
                `第${clubContext.groupId}组 nodeId=${enemy.nodeId} ` +
                `${won ? "成功" : "失败"}，进度 ${enemy.successCount}`,
              won ? "success" : "error",
            );

            if (!won) {
              const error = new Error(`nodeId=${enemy.nodeId} 未按计划获胜`);
              error.code = "CAMP_PLAN_INVALIDATED";
              throw error;
            }
          }
        }
      });
    }
  };

  const claimMemberRewards = async (member, groupId, stage) => {
    const groupConfIds = getCampRewardConfIds(groupId).slice(0, stage - 2);
    const confIds = [
      ...(member.attackCnt >= 3 ? [1] : []),
      ...groupConfIds,
    ];
    let claimed = 0;

    await withTokenConnection(member.tokenId, async () => {
      await tokenStore.sendMessageWithPromise(
        member.tokenId,
        "legion_getinfo",
        {},
        10000,
      );
      await tokenStore.sendMessageWithPromise(
        member.tokenId,
        "saltroad_getwartype",
        { date: getSaltRoadDate() },
        10000,
      );
      const clubInfo = await tokenStore.sendMessageWithPromise(
        member.tokenId,
        "club_getinfo",
        {},
        10000,
      );
      const claimedMap = clubInfo?.siege?.taskClaimedMap || {};
      for (const confId of confIds) {
        if (shouldStop.value) break;
        if (Object.prototype.hasOwnProperty.call(claimedMap, String(confId))) {
          log(`${member.token.name} [club ${member.clubId}] 奖励 ${confId} 已领取，跳过`, "info");
          continue;
        }
        try {
          await tokenStore.sendMessageWithPromise(
            member.tokenId,
            "club_taskclaim",
            { confId },
            8000,
          );
          claimed += 1;
          log(`${member.token.name} [club ${member.clubId}] 已领取营地奖励 ${confId}`, "success");
        } catch (error) {
          log(
            `${member.token.name} [club ${member.clubId}] 奖励 ${confId} 未领取: ${error.message || "服务端拒绝"}`,
            "warning",
          );
        }
      }
    });

    return claimed;
  };

  const runCampChallenge = async () => {
    const tokenIds = [...selectedTokens.value];
    if (tokenIds.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;
    tokenIds.forEach((tokenId) => {
      tokenStatus.value[tokenId] = "waiting";
    });

    try {
      const snapshots = [];
      for (const tokenId of tokenIds) {
        if (shouldStop.value) break;
        tokenStatus.value[tokenId] = "running";
        try {
          const snapshot = await readMemberSnapshot(tokenId);
          snapshots.push(snapshot);
          if (!snapshot.attackStatsKnown) {
            log(
              `${snapshot.token.name} [club ${snapshot.clubId}] 未从 club_getinfo 返回今日 attackCnt/aSuccessCnt，后续将跳过自动战斗以避免错误估算剩余次数。`,
              "warning",
            );
          }
        } catch (error) {
          tokenStatus.value[tokenId] = "failed";
          log(`读取 ${tokenId} 的营地状态失败: ${error.message || "未知错误"}`, "error");
        }
      }

      const clubs = new Map();
      for (const snapshot of snapshots) {
        const context = clubs.get(snapshot.clubId) || {
          clubId: snapshot.clubId,
          members: [],
          oppoMaps: [],
        };
        context.members.push(snapshot);
        context.oppoMaps.push(snapshot.oppoMap);
        clubs.set(snapshot.clubId, context);
      }

      for (const clubContext of clubs.values()) {
        if (shouldStop.value) break;
        if (clubContext.members.some((member) => !member.attackStatsKnown)) {
          log(
            `[club ${clubContext.clubId}] club_getinfo 未返回今日 attackCnt/aSuccessCnt，无法安全计算剩余次数，跳过自动战斗`,
            "warning",
          );
          continue;
        }
        let mergedOppoMap = mergeCampOppoMaps(clubContext.oppoMaps);
        let preliminaryEnemies = collectCampEnemies(mergedOppoMap);
        for (let refresh = 0; refresh < 4 && preliminaryEnemies.length < 30; refresh += 1) {
          const refreshed = await withTokenConnection(
            clubContext.members[0].tokenId,
            () =>
              tokenStore.sendMessageWithPromise(
                clubContext.members[0].tokenId,
                "club_getinfo",
                {},
                10000,
              ),
          );
          clubContext.oppoMaps.push(refreshed?.club?.oppoMap || {});
          mergedOppoMap = mergeCampOppoMaps(clubContext.oppoMaps);
          preliminaryEnemies = collectCampEnemies(mergedOppoMap);
        }
        if (preliminaryEnemies.length === 0) {
          log(`[club ${clubContext.clubId}] 没有可用敌方节点，跳过`, "warning");
          continue;
        }
        if (preliminaryEnemies.length < 30) {
          log(
            `[club ${clubContext.clubId}] 仅获取到 ${preliminaryEnemies.length}/30 个敌方节点，无法安全评估整组奖励，跳过`,
            "warning",
          );
          continue;
        }

        try {
          const targetQuery = await queryTargetPowers(
            clubContext.members,
            preliminaryEnemies,
          );
          if (targetQuery.unavailableTargets.length > 0) {
            log(
              `[club ${clubContext.clubId}] ${targetQuery.unavailableTargets.length} 个敌方目标无法查询，将只判定其他可评估的组：` +
                targetQuery.unavailableTargets
                  .map((target) => `nodeId=${target.nodeId}/targetId=${target.roleId}`)
                  .join(","),
              "warning",
            );
          }
          const refreshedEnemies = collectCampEnemies(
            mergedOppoMap,
            targetQuery.targetPowers,
          );
          for (const enemy of refreshedEnemies) {
            if (!targetQuery.completedNodeIds.has(enemy.nodeId)) continue;
            enemy.successCount = 5;
            enemy.remainingTo5 = 0;
            enemy.defeated = true;
          }
          clubContext.enemies = refreshedEnemies;
          const planning = selectBestCampGroup({
            enemies: clubContext.enemies,
            members: clubContext.members,
            requireCompleteNodes: true,
          });
          log(
            `[club ${clubContext.clubId}] 评估结果: ${formatPlanSummary(planning.groups)}`,
            "info",
          );

          if (!planning.selected) {
            log(`[club ${clubContext.clubId}] 三组均不可达，跳过`, "warning");
            continue;
          }

          clubContext.groupId = planning.selected.groupId;
          log(
            `[club ${clubContext.clubId}] 选择第${planning.selected.groupId}组，最高可达 ${planning.selected.stage} 层`,
            "success",
          );
          await executePlan(clubContext, planning.selected);

          for (const member of clubContext.members) {
            if (shouldStop.value) break;
            await claimMemberRewards(
              member,
              planning.selected.groupId,
              planning.selected.stage,
            );
          }
        } catch (error) {
          log(
            `[club ${clubContext.clubId}] 计划执行中止: ${error.message || "未知错误"}，不会继续使用旧计划`,
            "error",
          );
        }
      }

      for (const tokenId of tokenIds) {
        if (tokenStatus.value[tokenId] === "running") {
          tokenStatus.value[tokenId] = "completed";
        }
      }
      message?.success("批量营地挑战结束");
    } finally {
      isRunning.value = false;
      currentRunningTokenId.value = null;
    }
  };

  /**
   * 按 club_getinfo 的 taskClaimedMap 过滤后逐个领取营地奖励。
   * 需要调用方已在该连接上完成 legion_getinfo / saltroad_getwartype / club_getinfo。
   */
  const claimCampRewards = async (tokenId, tokenName, clubInfo, { quiet = false } = {}) => {
    const claimedMap = clubInfo?.siege?.taskClaimedMap || {};
    let claimed = 0;

    for (const confId of CAMP_REWARD_CLAIM_ORDER) {
      if (shouldStop.value) break;
      if (Object.prototype.hasOwnProperty.call(claimedMap, String(confId))) {
        continue;
      }
      try {
        await tokenStore.sendMessageWithPromise(
          tokenId,
          "club_taskclaim",
          { confId },
          8000,
        );
        claimed += 1;
        log(`${tokenName} 领取营地奖励 confId=${confId}`, "success");
      } catch (error) {
        log(
          `${tokenName} 营地奖励 confId=${confId} 未领取: ${error?.message || "未满足条件"}`,
          quiet ? "info" : "warning",
        );
      }
    }

    return claimed;
  };

  /**
   * 营地理性宠物挑战的简化版（与智能规划并列，不做虚拟评估）。
   *
   * 抓包依据（local-data/camp_data/camp_data.jsonl，Club_AttackMonsterResp）：
   *   · 请求：club_attackmonster({ useItem:false, teamSetParams })，
   *     无 nodeId/targetId —— 宠物是全 club 共享目标；
   *   · 前置：hero_calcpowerbyteam 计算己方战力（真实 UI 每个动作前都会调用）；
   *   · 响应：siege.attackMap[YYMMDD]{attackCnt,aSuccessCnt} 与普通攻击共享额度，
   *     battleData.result.isWin 判定胜负，reward 为本次奖励。
   */
  const batchCampChallengePet = async () => {
    const tokenIds = [...selectedTokens.value];
    if (tokenIds.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;
    tokenIds.forEach((tokenId) => {
      tokenStatus.value[tokenId] = "waiting";
    });

    let totalAttacks = 0;
    let totalWins = 0;
    let totalClaims = 0;
    let failedTokens = 0;

    try {
      for (const tokenId of tokenIds) {
        if (shouldStop.value) break;
        const token = tokens.value.find((item) => item.id === tokenId);
        if (!token) continue;

        tokenStatus.value[tokenId] = "running";
        currentRunningTokenId.value = tokenId;

        try {
          const result = await withTokenConnection(tokenId, async () => {
            const send = (command, params = {}, timeout = 10000) =>
              tokenStore.sendMessageWithPromise(tokenId, command, params, timeout);
            // 上下文类命令失败不应中断整个角色：记录后继续。
            const trySend = async (command, params = {}, timeout = 10000) => {
              try {
                return await send(command, params, timeout);
              } catch (error) {
                log(
                  `${token.name} ${command} 失败（已忽略）: ${error?.message || error}`,
                  "warning",
                );
                return null;
              }
            };
            const commandDelayMs = Math.max(
              500,
              Number(batchSettings?.commandDelay ?? 500),
            );

            await trySend("legion_getinfo", {}, 10000);
            await trySend("saltroad_getwartype", { date: getSaltRoadDate() }, 10000);
            const clubInfo = await trySend("club_getinfo", {}, 15000);

            const stats = getCampAttackStats(clubInfo?.siege);
            const plannedAttacks = stats.known
              ? Math.min(
                  CAMP_SIMPLE_PET_ATTEMPTS,
                  Math.max(0, CAMP_MAX_ATTACKS - stats.attackCnt),
                  Math.max(0, CAMP_MAX_SUCCESS - stats.aSuccessCnt),
                )
              : CAMP_SIMPLE_PET_ATTEMPTS;

            log(
              `${token.name} [club ${getClubId(clubInfo) ?? "-"}] 简版宠物挑战：` +
                `今日已攻击 ${stats.attackCnt}${stats.known ? "" : "(未知)"} / ` +
                `已成功 ${stats.aSuccessCnt}，计划攻击 ${plannedAttacks} 次`,
              "info",
            );

            const summary = { attacks: 0, wins: 0, claims: 0 };

            // 阶段一：攻击宠物。失败不阻塞领奖。
            if (plannedAttacks === 0) {
              log(
                `${token.name} 今日营地次数/成功额度已用完，跳过攻击，仅尝试领奖`,
                "warning",
              );
            } else {
              try {
                const roleInfo = await send("role_getroleinfo", {}, 15000);
                const presetTeam = await send("presetteam_getinfo", {}, 8000);
                const teamSetParams = buildTeamSetParams(
                  presetTeam,
                  roleInfo,
                  batchSettings,
                );

                for (let attempt = 0; attempt < plannedAttacks; attempt += 1) {
                  if (shouldStop.value) break;
                  await trySend("hero_calcpowerbyteam", teamSetParams, 8000);
                  const response = await send(
                    "club_attackmonster",
                    { useItem: false, teamSetParams },
                    15000,
                  );
                  const won = isCampWin(response);
                  summary.attacks += 1;
                  if (won) summary.wins += 1;

                  const nextStats = getCampAttackStats(response?.siege);
                  log(
                    `${token.name} 营地宠物第 ${attempt + 1}/${plannedAttacks} 次` +
                      `${won ? "成功" : "失败"}` +
                      (nextStats.known
                        ? `（今日 ${nextStats.attackCnt} 次 / ${nextStats.aSuccessCnt} 胜）`
                        : ""),
                    won ? "success" : "warning",
                  );

                  if (attempt + 1 < plannedAttacks) {
                    await new Promise((resolve) =>
                      setTimeout(resolve, commandDelayMs),
                    );
                  }
                }
              } catch (error) {
                log(
                  `${token.name} 营地宠物攻击中止: ${error?.message || error}，继续尝试领取奖励`,
                  "warning",
                );
              }
            }

            // 阶段二：领奖。重取 club 状态，按 taskClaimedMap 过滤后逐个尝试。
            summary.claims = await claimCampRewards(
              tokenId,
              token.name,
              await trySend("club_getinfo", {}, 15000),
              { quiet: true },
            );

            return summary;
          });

          totalAttacks += result.attacks;
          totalWins += result.wins;
          totalClaims += result.claims;
          tokenStatus.value[tokenId] = "completed";
        } catch (error) {
          failedTokens += 1;
          tokenStatus.value[tokenId] = "failed";
          log(
            `${token.name} 简版营地挑战失败: ${error?.message || "未知错误"}`,
            "error",
          );
        }
      }

      log(
        `简版营地挑战结束：攻击 ${totalAttacks} 次 / 成功 ${totalWins} 次 / 领奖 ${totalClaims} 项` +
          (failedTokens > 0 ? `，失败角色 ${failedTokens} 个` : ""),
        "info",
      );
      message?.success("简版营地挑战（攻击宠物+领奖）结束");
    } finally {
      isRunning.value = false;
      currentRunningTokenId.value = null;
    }
  };

  const batchCampClaimTasks = async () => {
    const tokenIds = [...selectedTokens.value];
    if (tokenIds.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;
    try {
      for (const tokenId of tokenIds) {
        if (shouldStop.value) break;
        const token = tokens.value.find((item) => item.id === tokenId);
        if (!token) continue;
        await withTokenConnection(tokenId, async () => {
          // 与真实 UI 一致：先建立营地上下文，再按 taskClaimedMap 过滤已领取项。
          await tokenStore.sendMessageWithPromise(tokenId, "legion_getinfo", {}, 10000);
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "saltroad_getwartype",
            { date: getSaltRoadDate() },
            10000,
          );
          const clubInfo = await tokenStore.sendMessageWithPromise(
            tokenId,
            "club_getinfo",
            {},
            15000,
          );
          await claimCampRewards(tokenId, token.name, clubInfo);
        });
      }
      message?.success("营地任务奖励领取完成");
    } finally {
      isRunning.value = false;
      currentRunningTokenId.value = null;
    }
  };

  return {
    batchCampChallenge: runCampChallenge,
    batchCampChallengePet,
    batchCampClaimTasks,
  };
}

export { CAMP_MAX_ATTACKS, CAMP_MAX_SUCCESS, CAMP_SIMPLE_PET_ATTEMPTS };
