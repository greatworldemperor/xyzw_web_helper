import {
  CAMP_MAX_ATTACKS,
  CAMP_MAX_SUCCESS,
  collectCampEnemies,
  getCampAttackStats,
  getCampRewardConfIds,
  mergeCampOppoMaps,
  selectBestCampGroup,
} from "./campChallengePlanner.js";

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

  return {
    lordWeaponId: Number(role.lordWeaponId || 0),
    petUId: "",
    battleTeam,
    formationId,
  };
};

const getClubId = (clubInfo) => {
  const value = clubInfo?.club?.legionId;
  return value === undefined || value === null || value === ""
    ? null
    : String(value);
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
    try {
      slotAttempted = true;
      await ensureConnection(tokenId);
      return await callback();
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
      const [roleInfo, presetTeam, clubInfo] = await Promise.all([
        tokenStore.sendMessageWithPromise(
          tokenId,
          "role_getroleinfo",
          {},
          15000,
        ),
        tokenStore.sendMessageWithPromise(
          tokenId,
          "presetteam_getinfo",
          {},
          8000,
        ),
        tokenStore.sendMessageWithPromise(
          tokenId,
          "club_getinfo",
          {},
          15000,
        ),
      ]);

      const clubId = getClubId(clubInfo);
      if (!clubId) throw new Error("club_getinfo 缺少 club.legionId");

      const teamSetParams = buildTeamSetParams(
        presetTeam,
        roleInfo,
        batchSettings,
      );
      const attackStats = getCampAttackStats(clubInfo?.siege);

      return {
        tokenId,
        token,
        clubId,
        roleId: getRoleData(roleInfo)?.roleId ?? token.roleId,
        power: getRolePower(roleInfo),
        attackCnt: attackStats.attackCnt,
        aSuccessCnt: attackStats.aSuccessCnt,
        attackStatsKnown: attackStats.known,
        teamSetParams,
        oppoMap: clubInfo?.club?.oppoMap || {},
        clubInfo,
      };
    });
  };

  const queryTargetPowers = async (member, enemies) => {
    const roleIds = [
      ...new Set(
        enemies
          .map((enemy) => enemy.roleId)
          .filter((roleId) => roleId !== undefined && roleId !== null),
      ),
    ];
    const targetPowers = {};

    await withTokenConnection(member.tokenId, async () => {
      for (const roleId of roleIds) {
        const targetTeam = await tokenStore.sendMessageWithPromise(
          member.tokenId,
          "club_gettargetteam",
          { targetId: roleId },
          8000,
        );
        const power = Number(targetTeam?.roleBattleTeam?.role?.power);
        if (!Number.isFinite(power)) {
          throw new Error(`目标 ${roleId} 缺少 roleBattleTeam.role.power`);
        }
        targetPowers[String(roleId)] = power;
      }
    });

    return targetPowers;
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
        for (const assignment of assignments) {
          for (let attempt = 0; attempt < assignment.count; attempt += 1) {
            if (shouldStop.value) return;
            const enemy = enemiesByNodeId.get(assignment.nodeId);
            if (!enemy) throw new Error(`计划中的 nodeId 不存在: ${assignment.nodeId}`);

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
          const targetPowers = await queryTargetPowers(
            clubContext.members[0],
            preliminaryEnemies,
          );
          clubContext.enemies = collectCampEnemies(mergedOppoMap, targetPowers);
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

  const batchCampChallengePet = async () => {
    message?.warning("宠物挑战尚未接入 club 级虚拟规划，当前未执行");
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
          for (const confId of [1, ...Array.from({ length: 9 }, (_, index) => index + 5)]) {
            if (shouldStop.value) break;
            try {
              await tokenStore.sendMessageWithPromise(
                tokenId,
                "club_taskclaim",
                { confId },
                8000,
              );
              log(`${token.name} 尝试领取营地奖励 ${confId}`, "success");
            } catch (error) {
              log(`${token.name} 跳过营地奖励 ${confId}: ${error.message || "未满足条件"}`, "warning");
            }
          }
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

export { CAMP_MAX_ATTACKS, CAMP_MAX_SUCCESS };
