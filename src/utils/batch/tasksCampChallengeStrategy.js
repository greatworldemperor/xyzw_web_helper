import {
  CAMP_MAX_ATTACKS,
  CAMP_MAX_SUCCESS,
  collectCampEnemies,
  findCampOwnNodeId,
  getCampAttackStats,
  getCampOppoKey,
  getCampRewardConfIds,
  getCampSuccessCount,
  getCampTodayKey,
  isCampBattleDay,
  planPartialCampAttacks,
  selectBestCampGroup,
  selectCampProbeTargets,
  selectTodayCampOppo,
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

/**
 * 目标战力低于我方战力的这个比例才值得打（对应「战力低于我方 75% 才挑战」）。
 * 可用批量设置 `campPowerThreshold` 覆盖。
 */
const CAMP_DEFAULT_POWER_THRESHOLD = 0.75;

/**
 * 当天的目标战力缓存：key = `${clubId}:${YYMMDD}`。
 * 同一天内跨运行复用已知战力，并记住被服务端拒绝（200020 等）的目标，避免每次运行都重复撞。
 */
const campTargetPowerCache = new Map();

const getCampCacheBucket = (clubId, date = new Date()) => {
  const key = `${clubId ?? "-"}:${getCampTodayKey(date)}`;
  let bucket = campTargetPowerCache.get(key);
  if (!bucket) {
    bucket = { powers: {}, unavailable: {} };
    campTargetPowerCache.set(key, bucket);
  }
  return bucket;
};

/**
 * 从错误对象里取服务端业务码。协议层的错误经常只把码写在 message 里
 * （例如"服务器错误: 200020 - 出了点小问题"），此时 error.code 为空。
 */
const readCampErrorCode = (error) => {
  const explicit = error?.code;
  if (explicit !== undefined && explicit !== null && explicit !== "-") {
    return String(explicit);
  }
  const match = String(error?.message || "").match(/\b(\d{5,7})\b/);
  return match ? match[1] : null;
};

/** 从目标查询结果里取某个节点的战力（镜像节点与其原版共用同一个 targetId）。 */
const targetQueryPower = (query, enemy) => {
  const roleId = enemy?.roleId;
  if (roleId === undefined || roleId === null) return null;
  const numeric = Number(query?.targetPowers?.[String(roleId)]);
  return Number.isFinite(numeric) ? numeric : null;
};

const getRoleData = (roleInfo) => roleInfo?.role || roleInfo?.roleInfo || {};

const getRolePower = (roleInfo) => {
  const role = getRoleData(roleInfo);
  const power = Number(role.power ?? role.role?.power);
  return Number.isFinite(power) ? power : null;
};

/** 把 `{ 0: { heroId } }` 形式的阵容统一成 `teamSetParams.battleTeam` 需要的 `{ 0: heroId }`。 */
const readBattleTeamHeroIds = (battleTeam) => {
  const heroIds = {};
  for (const [position, hero] of Object.entries(battleTeam || {})) {
    const heroId = hero?.heroId ?? hero?.id;
    if (heroId === undefined || heroId === null) continue;
    heroIds[position] = Number(heroId);
  }
  return heroIds;
};

/**
 * 用 `rank_getroleinfo` 摘要直接组装 `teamSetParams`（省掉一次 presetteam_getinfo）。
 * 只在"使用当前阵容"（`arenaFormation` 为 `current` 或 `1`）时可用；
 * 指定其它预设队伍时返回 null，由执行阶段读 `presetteam_getinfo` 兜底。
 */
const buildTeamSetParamsFromSummary = (summary, batchSettings) => {
  if (!summary) return null;
  const formation = String(batchSettings?.arenaFormation ?? 1);
  if (formation !== "current" && formation !== "1") return null;
  const battleTeam = summary.battleTeam || {};
  if (Object.keys(battleTeam).length === 0) return null;
  if (summary.lordWeaponId === null || summary.lordWeaponId === undefined) {
    return null;
  }
  return {
    lordWeaponId: Number(summary.lordWeaponId || 0),
    petUId: summary.petUId || "",
    battleTeam,
  };
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
  const battleTeam = readBattleTeamHeroIds(teamInfoData);

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

const CAMP_PROTOCOL_LOG_LIMIT = 50000;

const normalizeCampLogValue = (value, seen = new WeakSet(), depth = 0) => {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return {
      type: "Uint8Array",
      length: value.length,
      headHex: Array.from(value.slice(0, 64))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  }
  if (value instanceof ArrayBuffer) {
    return normalizeCampLogValue(new Uint8Array(value), seen, depth);
  }
  if (typeof value !== "object") return value;
  if (depth >= 10) return "[MaxDepth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCampLogValue(item, seen, depth + 1));
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = normalizeCampLogValue(item, seen, depth + 1);
  }
  return output;
};

const stringifyCampLogValue = (value) => {
  let text;
  try {
    text = JSON.stringify(normalizeCampLogValue(value));
  } catch (error) {
    text = `[Unserializable: ${error?.message || error}]`;
  }
  if (text === undefined) return "undefined";
  if (text.length <= CAMP_PROTOCOL_LOG_LIMIT) return text;
  return `${text.slice(0, CAMP_PROTOCOL_LOG_LIMIT)}...[truncated ${text.length - CAMP_PROTOCOL_LOG_LIMIT} chars]`;
};

const serializeCampError = (error) => ({
  name: error?.name,
  code: error?.code,
  message: error?.message || String(error),
  hint: error?.hint,
  response: error?.response,
  data: error?.data,
  body: error?.body,
});

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

  const sendCampCommand = async (
    tokenId,
    command,
    params = {},
    timeout = 10000,
    context = "",
  ) => {
    const token = tokens.value.find((item) => item.id === tokenId);
    const tokenName = token?.name || tokenId;
    const label = context ? `${command} [${context}]` : command;
    const startedAt = Date.now();
    log(
      `[营地协议][请求] ${tokenName} ${label} body=${stringifyCampLogValue(params)}`,
      "info",
    );
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenId,
        command,
        params,
        timeout,
      );
      log(
        `[营地协议][响应] ${tokenName} ${label} elapsed=${Date.now() - startedAt}ms ` +
          `body=${stringifyCampLogValue(response)}`,
        "info",
      );
      return response;
    } catch (error) {
      log(
        `[营地协议][失败] ${tokenName} ${label} elapsed=${Date.now() - startedAt}ms ` +
          `request=${stringifyCampLogValue(params)} ` +
          `error=${stringifyCampLogValue(serializeCampError(error))}`,
        "error",
      );
      throw error;
    }
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

  /**
   * 读取一个角色的完整战斗上下文（角色信息、阵容、俱乐部状态）。
   * 必须在该角色自己的连接上执行，调用方负责连接生命周期。
   */
  const readMemberContextOnConnection = async (tokenId, options = {}) => {
    const token = tokens.value.find((item) => item.id === tokenId);
    if (!token) throw new Error(`未找到角色 ${tokenId}`);
    const contextLabel = options.contextLabel || "snapshot";

    return (async () => {
      const sendSnapshotCommand = async (command, timeout, params = {}) => {
        const response = await sendCampCommand(
          tokenId,
          command,
          params,
          timeout,
          contextLabel,
        );
        log(
          `[营地诊断] ${token.name} 响应 ${command}: ` +
            `topKeys=${getKeys(response).join(",") || "-"}`,
          "info",
        );
        return response;
      };

      const roleInfo = await sendSnapshotCommand("role_getroleinfo", 15000);
      const usePresetTeam = options.usePresetTeam !== false;
      const presetTeam = usePresetTeam
        ? await sendSnapshotCommand("presetteam_getinfo", 8000)
        : null;
      await sendSnapshotCommand("legion_getinfo", 10000);
      await sendSnapshotCommand("saltroad_getwartype", 10000, {
        date: getSaltRoadDate(),
      });
      const clubInfo = await sendSnapshotCommand("club_getinfo", 15000);

      const clubId = getClubId(clubInfo);
      if (!clubId) throw new Error("club_getinfo 缺少 club.legionId");

      const teamSetParams = options.teamSetParams || buildTeamSetParams(
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
    })();
  };

  /**
   * 用一个连接为所有选中角色取 `rank_getroleinfo` 摘要。
   * 响应里的 `legionId` 直接给出俱乐部分组，`power`/`lordWeaponId`/`pet.petUId`/`battleTeam`
   * 就是规划所需的我方数据，因此不必为每个角色单独建连，也不必按俱乐部逐个探测。
   * 抓包确认：local-data/misc/xianchen_search.jsonl（7/7 逐字节复现）。
   */
  const readRoleSummaries = async (tokenIds) => {
    const summaries = new Map();
    const pending = tokenIds
      .map((tokenId) => ({
        tokenId,
        token: tokens.value.find((item) => item.id === tokenId),
      }))
      .filter((entry) => entry.token)
      .map((entry) => ({
        ...entry,
        roleId: Number(entry.token.roleId),
      }))
      .filter((entry) => Number.isFinite(entry.roleId));

    if (pending.length === 0) return summaries;

    const summaryDelayMs = Math.max(
      80,
      Math.min(300, Number(batchSettings?.commandDelay ?? 500)),
    );
    const connTokenId = pending[0].tokenId;
    log(
      `[营地诊断] 用 ${pending[0].token.name} 的连接批量查询 ${pending.length} 个角色的 rank_getroleinfo` +
        "（单连接完成分组与我方战力/阵容，不再逐角色登录）",
      "info",
    );

    await withTokenConnection(connTokenId, async () => {
      let index = 0;
      for (const entry of pending) {
        if (shouldStop.value) break;
        if (index > 0) {
          await new Promise((resolve) => setTimeout(resolve, summaryDelayMs));
        }
        index += 1;
        try {
          const response = await sendCampCommand(
            connTokenId,
            "rank_getroleinfo",
            {
              roleId: entry.roleId,
              bottleType: 0,
              includeBottleTeam: false,
              isSearch: false,
            },
            10000,
            `role-summary roleId=${entry.roleId}`,
          );
          const roleInfo = response?.roleInfo || {};
          const power = Number(roleInfo.power);
          summaries.set(entry.tokenId, {
            roleId: entry.roleId,
            legionId: roleInfo.legionId ?? response?.legionInfo?.id ?? null,
            clubName: response?.legionInfo?.name || "",
            name: roleInfo.name || entry.token.name,
            serverName: roleInfo.serverName || "",
            power: Number.isFinite(power) ? power : null,
            lordWeaponId: Number.isFinite(Number(roleInfo.lordWeaponId))
              ? Number(roleInfo.lordWeaponId)
              : null,
            petUId: roleInfo.pet?.petUId ?? "",
            battleTeam: readBattleTeamHeroIds(roleInfo.battleTeam),
          });
        } catch (error) {
          log(
            `[营地诊断] rank_getroleinfo 失败 roleId=${entry.roleId}: ${error?.message || error}，` +
              "该角色退回按俱乐部探测",
            "warning",
          );
        }
      }
    });

    return summaries;
  };

  /**
   * 俱乐部级信息探测：一个俱乐部只需要用任一成员探测一次。
   * `legion_getinfo` 的成员表同时给出全俱乐部战力（与 role.power 一致），
   * `club_getinfo` 给出当天对手的 oppoMap 和该角色的每日计数。
   * 必须在该角色自己的连接上执行，调用方负责连接生命周期。
   */
  const readClubHeaderOnConnection = async (tokenId) => {
    const token = tokens.value.find((item) => item.id === tokenId);
    if (!token) throw new Error(`未找到角色 ${tokenId}`);

    const legionInfo = await sendCampCommand(
      tokenId,
      "legion_getinfo",
      {},
      10000,
      "club-header",
    );
    await sendCampCommand(
      tokenId,
      "saltroad_getwartype",
      { date: getSaltRoadDate() },
      10000,
      "club-header",
    );
    const clubInfo = await sendCampCommand(
      tokenId,
      "club_getinfo",
      {},
      15000,
      "club-header",
    );

    const club = legionInfo?.info || {};
    const clubId = getClubId(clubInfo) ?? club.id ?? null;
    const members = {};
    for (const [roleId, member] of Object.entries(club.members || {})) {
      const power = Number(member?.power);
      members[String(member?.roleId ?? roleId)] = {
        roleId: member?.roleId ?? Number(roleId),
        name: member?.name || "",
        power: Number.isFinite(power) ? power : null,
      };
    }
    const attackStats = getCampAttackStats(clubInfo?.siege);
    const oppoMap = clubInfo?.club?.oppoMap || {};

    log(
      `[营地诊断] 俱乐部探测 ${token.name} club=${clubId ?? "-"} ` +
        `成员=${Object.keys(members).length} ` +
        `oppoKeys=${Object.keys(oppoMap).filter((key) => key !== "null").join("/") || "-"} ` +
        `今日对手key=${getCampOppoKey()} ` +
        `本角色 attackCnt=${attackStats.attackCnt} aSuccessCnt=${attackStats.aSuccessCnt}`,
      "info",
    );

    return {
      probeTokenId: tokenId,
      probeToken: token,
      clubId,
      clubName: club.name || "",
      members,
      oppoMap,
      clubInfo,
      probeAttackStats: attackStats,
    };
  };

  const readClubHeader = async (tokenId) =>
    withTokenConnection(tokenId, () => readClubHeaderOnConnection(tokenId));

  /**
   * 按俱乐部去重分组：
   * 首选 `rank_getroleinfo` 的 `legionId`（一个连接搞定全部角色）；
   * 查不到摘要的角色退回"用它的连接探测 legion_getinfo 成员表"的旧路径。
   */
  const discoverClubGroups = async (tokenIds) => {
    const groups = new Map();
    const summaries = await readRoleSummaries(tokenIds);

    const ensureGroup = (clubKey, clubName) => {
      let group = groups.get(clubKey);
      if (!group) {
        group = {
          clubId: clubKey === "null" ? null : clubKey,
          clubName: clubName || "",
          tokens: [],
          summaries: new Map(),
          header: null,
        };
        groups.set(clubKey, group);
      }
      if (!group.clubName && clubName) group.clubName = clubName;
      return group;
    };

    const unresolved = [];
    for (const tokenId of tokenIds) {
      const token = tokens.value.find((item) => item.id === tokenId);
      if (!token) continue;
      const summary = summaries.get(tokenId);
      const legionId = summary?.legionId;
      if (legionId === undefined || legionId === null || summary?.legionId === -1) {
        unresolved.push(token);
        continue;
      }
      const group = ensureGroup(String(legionId), summary.clubName);
      group.tokens.push(token);
      group.summaries.set(tokenId, summary);
    }

    for (const [clubKey, group] of groups.entries()) {
      log(
        `俱乐部分组 club=${clubKey}${group.clubName ? `（${group.clubName}）` : ""} ` +
          `选中角色=${group.tokens.length}（来源 rank_getroleinfo.legionId）`,
        "success",
      );
    }

    // 兜底：拿不到 legionId 的角色用旧探测路径（一次连接拿俱乐部成员表）。
    for (const token of unresolved) {
      if (shouldStop.value) break;
      tokenStatus.value[token.id] = "running";
      let header;
      try {
        header = await readClubHeader(token.id);
      } catch (error) {
        tokenStatus.value[token.id] = "failed";
        log(
          `俱乐部探测失败 ${token.name}: ${error?.message || error}，跳过该角色`,
          "error",
        );
        continue;
      }
      const clubKey = String(header.clubId ?? `unknown-${token.id}`);
      const group = ensureGroup(clubKey, header.clubName);
      group.header = group.header || header;
      if (!group.tokens.some((item) => item.id === token.id)) {
        group.tokens.push(token);
      }
      log(
        `俱乐部分组 club=${clubKey}（探测兜底）选中角色=${group.tokens.length}`,
        "success",
      );
    }

    return [...groups.values()];
  };

  /**
   * 在当前**已建立**的连接上完成目标查询：可选刷新俱乐部上下文 → 等上下文稳定 → 逐个查目标。
   * 就地修改 `pendingRoleIds` / `targetPowers` / `cacheBucket.unavailable` / `completedNodeIds` / `lastErrors`。
   * 供 `queryTargetPowers`（自己管理连接）和俱乐部级流程（复用同一条连接）共同使用。
   */
  const runTargetQueriesInsideConnection = async (queryMember, options) => {
    const {
      queryableEnemies,
      pendingRoleIds,
      targetPowers,
      cacheBucket,
      completedNodeIds,
      lastErrors,
      queryDelayMs,
      retryDelayMs,
      noRetryOnRejected,
      contextReady = false,
    } = options;

    // The game establishes the club target context through getinfo on
    // the same connection before accepting gettargetteam requests.
    let queryClubInfo = options.clubInfo || null;
    if (!(contextReady && queryClubInfo)) {
      log(
        `[营地诊断] ${queryMember.token.name} 查询目标前刷新 club_getinfo 上下文`,
        "info",
      );
      await sendCampCommand(
        queryMember.tokenId,
        "legion_getinfo",
        {},
        10000,
        "target-context",
      );
      await sendCampCommand(
        queryMember.tokenId,
        "saltroad_getwartype",
        { date: getSaltRoadDate() },
        10000,
        "target-context",
      );
      queryClubInfo = await sendCampCommand(
        queryMember.tokenId,
        "club_getinfo",
        {},
        10000,
        "target-context",
      );
    }

    const queryRoleIds = new Set();
    const queryNodeIds = new Set();
    const queryDefendersByRole = new Map();
    // 只使用"当天对手"这一个来源组的快照：跨来源组的 nodeId 会互相污染。
    const todayOpponent = (queryClubInfo?.club?.oppoMap || {})[getCampOppoKey()];
    for (const [nodeId, defender] of Object.entries(
      todayOpponent?.defenders || {},
    )) {
      if (nodeId === "null") continue;
      queryNodeIds.add(String(nodeId));
      if (defender?.roleId !== undefined && defender?.roleId !== null) {
        queryRoleIds.add(String(defender.roleId));
        const roleMatches = queryDefendersByRole.get(String(defender.roleId)) || [];
        roleMatches.push({ nodeId, defender });
        queryDefendersByRole.set(String(defender.roleId), roleMatches);
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
          targetTeam = await sendCampCommand(
            queryMember.tokenId,
            "club_gettargetteam",
            { targetId: Number(roleId) },
            8000,
            `target nodeId=${enemy?.nodeId ?? "-"}`,
          );
          break;
        } catch (error) {
          lastError = error;
          const rejectedCode = readCampErrorCode(error);
          // 服务端明确拒绝（200020 等）是确定性结论，重试没有意义。
          if (noRetryOnRejected && rejectedCode) break;
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
        const code = readCampErrorCode(lastError);
        if (code) {
          // 记入当天缓存：同一天后续运行不再重复撞这个目标。
          cacheBucket.unavailable[String(roleId)] = {
            nodeId: enemy?.nodeId ?? null,
            targetIsMirror: enemy?.targetIsMirror ?? null,
            code,
            message: lastError?.message || "目标查询失败",
          };
        }
        continue;
      }

      const power = Number(targetTeam?.roleBattleTeam?.role?.power);
      if (!Number.isFinite(power)) {
        lastErrors.set(String(roleId), new Error("缺少 roleBattleTeam.role.power"));
        continue;
      }

      targetPowers[String(roleId)] = power;
      cacheBucket.powers[String(roleId)] = power;
      pendingRoleIds.delete(String(roleId));
      log(
        `[营地诊断] ${queryMember.token.name} club_gettargetteam 成功: ` +
          `targetId=${roleId} nodeId=${enemy?.nodeId ?? "-"} power=${power}`,
        "info",
      );
    }
  };

  /**
   * 查询目标阵容战力。
   * 只应传入"当天对手"的节点（跨来源组的节点会被服务端以 200020 拒绝）。
   * 已知战力与当天被拒绝的目标都会写入当天缓存，避免重复撞击。
   */
  const queryTargetPowers = async (members, enemies, options = {}) => {
    const cacheBucket = options.clubId === undefined || options.clubId === null
      ? { powers: {}, unavailable: {} }
      : getCampCacheBucket(options.clubId);
    const initialTargetPowers = {
      ...(options.ignorePowerCache ? {} : cacheBucket.powers),
      ...(options.initialTargetPowers || {}),
    };
    const ignoreUnavailableCache = options.ignoreUnavailableCache === true;
    const noRetryOnRejected = options.noRetryOnRejected === true;
    const queryAllNodes = options.queryAllNodes === true;
    const maxTargets = Number.isFinite(Number(options.maxTargets))
      ? Math.max(1, Number(options.maxTargets))
      : null;
    const probeSelection = selectCampProbeTargets(enemies);
    const candidateTargets = queryAllNodes
      ? (() => {
        const byRoleId = new Map();
        for (const enemy of enemies || []) {
          const roleId = enemy?.roleId;
          if (roleId === undefined || roleId === null) continue;
          const key = String(roleId);
          const existing = byRoleId.get(key);
          // 镜像与原版共用同一个 targetId，优先用原版节点（nodeId 稳定）。
          if (!existing || (existing.targetIsMirror && !enemy.targetIsMirror)) {
            byRoleId.set(key, enemy);
          }
        }
        return [...byRoleId.values()];
      })()
      : probeSelection.targets;
    const queryableEnemies = maxTargets === null ||
      candidateTargets.length <= maxTargets
      ? candidateTargets
      : maxTargets === 1
        ? [candidateTargets[0]]
        : Array.from({ length: maxTargets }, (_, index) =>
            candidateTargets[
              Math.round(
                (index * (candidateTargets.length - 1)) /
                  (maxTargets - 1),
              )
            ],
          );
    const reusedMirrorNodes = queryAllNodes ? [] : probeSelection.reusedMirrorNodes;
    const mirrorOnlyNodes = queryAllNodes ? [] : probeSelection.mirrorOnlyNodes;
    const activeEnemies = enemies.filter(
      (enemy) => enemy.remainingTo5 > 0 && enemy.defeated !== true,
    );
    const roleIds = [
      ...new Set(
        queryableEnemies
          .map((enemy) => enemy.roleId)
          .filter((roleId) => roleId !== undefined && roleId !== null),
      ),
    ].filter((roleId) => !Object.prototype.hasOwnProperty.call(
      initialTargetPowers,
      String(roleId),
    ));
    const targetPowers = { ...initialTargetPowers };
    const unavailableTargets = [];

    log(
      `[营地诊断] 敌方目标查询：总节点=${enemies.length}，` +
        `剩余节点=${activeEnemies.length}，探测原版=${queryableEnemies.length}，` +
        `跳过已完成节点=${enemies.length - activeEnemies.length}，` +
        `镜像复用=${reusedMirrorNodes.length}，镜像无原版跳过=${mirrorOnlyNodes.length}，` +
        `待查询角色=${roleIds.length}` +
        `${queryAllNodes ? "（含已完成节点）" : ""}`,
      "info",
    );

    // 同一天内已经被服务端拒绝的目标不再重复请求，直接沿用上次结论。
    const cachedUnavailable = [];
    const freshRoleIds = [];
    for (const roleId of roleIds) {
      const cached = cacheBucket.unavailable[String(roleId)];
      if (!ignoreUnavailableCache && cached) {
        cachedUnavailable.push({ roleId, ...cached });
      } else {
        freshRoleIds.push(roleId);
      }
    }
    if (cachedUnavailable.length > 0) {
      log(
        `[营地诊断] ${cachedUnavailable.length} 个目标当天已确认不可查询，本次不重复请求：` +
          cachedUnavailable
            .map((item) => `${item.nodeId ?? "-"}/targetId=${item.roleId}`)
            .join(","),
        "warning",
      );
    }

    const completedNodeIds = new Set();
    if (freshRoleIds.length === 0) {
      unavailableTargets.push(
        ...cachedUnavailable.map((item) => ({
          roleId: item.roleId,
          nodeId: item.nodeId ?? null,
          targetIsMirror: item.targetIsMirror ?? null,
          code: item.code ?? null,
          message: item.message || "当天已确认不可查询",
        })),
      );
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

    const reuseConnection = options.connection || null;
    if (!reuseConnection && queryCandidates.length === 0) {
      throw new Error("该 club 没有剩余攻击/成功容量可用于查询目标阵容");
    }

    const queryDelayMs = Math.max(
      300,
      Number(batchSettings?.commandDelay ?? 500),
    );
    const retryDelayMs = Math.max(1000, queryDelayMs * 2);
    const pendingRoleIds = new Set(freshRoleIds.map((roleId) => String(roleId)));
    const lastErrors = new Map();

    if (reuseConnection) {
      // 调用方已经建好连接并刷好了俱乐部上下文，这里直接在同一连接上查目标。
      log(
        `[营地诊断] 复用 ${reuseConnection.token.name} 的俱乐部连接查询 ${pendingRoleIds.size} 个目标`,
        "info",
      );
      await runTargetQueriesInsideConnection(
        { tokenId: reuseConnection.tokenId, token: reuseConnection.token },
        {
          queryableEnemies,
          pendingRoleIds,
          targetPowers,
          cacheBucket,
          completedNodeIds,
          lastErrors,
          queryDelayMs,
          retryDelayMs,
          noRetryOnRejected,
          contextReady: true,
          clubInfo: reuseConnection.clubInfo,
        },
      );
    }

    for (const queryMember of reuseConnection ? [] : queryCandidates) {
      if (pendingRoleIds.size === 0) break;

      log(
        `[营地诊断] 使用 ${queryMember.token.name} 查询敌方阵容：` +
          `attackCnt=${queryMember.attackCnt} aSuccessCnt=${queryMember.aSuccessCnt} ` +
          `待查询=${pendingRoleIds.size}`,
        "info",
      );

      try {
        await withTokenConnection(queryMember.tokenId, () =>
          runTargetQueriesInsideConnection(queryMember, {
            queryableEnemies,
            pendingRoleIds,
            targetPowers,
            cacheBucket,
            completedNodeIds,
            lastErrors,
            queryDelayMs,
            retryDelayMs,
            noRetryOnRejected,
          }));
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
        code: readCampErrorCode(error),
        message: error?.message || "目标查询失败",
      });
    }

    for (const item of cachedUnavailable) {
      unavailableTargets.push({
        roleId: item.roleId,
        nodeId: item.nodeId ?? null,
        targetIsMirror: item.targetIsMirror ?? null,
        code: item.code ?? null,
        message: item.message || "当天已确认不可查询",
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
        // 执行阶段才校验实时额度；阵容若已由 rank_getroleinfo 给出就不再读 presetteam_getinfo。
        const liveContext = await readMemberContextOnConnection(member.tokenId, {
          contextLabel: "attack-context",
          usePresetTeam: !member.teamSetParams,
          teamSetParams: member.teamSetParams,
        });
        member.teamSetParams = liveContext.teamSetParams || member.teamSetParams;
        member.clubId = liveContext.clubId ?? member.clubId;
        if (liveContext.power !== null) member.power = liveContext.power;
        if (liveContext.attackStatsKnown) {
          member.attackCnt = liveContext.attackCnt;
          member.aSuccessCnt = liveContext.aSuccessCnt;
          member.attackStatsKnown = true;
        } else {
          log(
            `${member.token.name} 未从 club_getinfo 读到今日计数，本次攻击不设额度闸门（仅记录）`,
            "warning",
          );
        }

        const remainingAttacks = Math.max(0, CAMP_MAX_ATTACKS - member.attackCnt);
        const remainingWins = Math.max(0, CAMP_MAX_SUCCESS - member.aSuccessCnt);
        if (remainingAttacks <= 0 || remainingWins <= 0) {
          log(
            `${member.token.name} [club ${clubContext.clubId}] 今日额度已用尽` +
              `（发起 ${member.attackCnt}/10、成功 ${member.aSuccessCnt}/3），跳过其 ${plan.assignments
                .filter((item) => item.tokenId === member.tokenId)
                .reduce((sum, item) => sum + item.count, 0)} 次计划攻击`,
            "warning",
          );
          return;
        }
        member.remainingAttacks = remainingAttacks;
        member.remainingWins = remainingWins;

        for (const assignment of assignments) {
          for (let attempt = 0; attempt < assignment.count; attempt += 1) {
            if (shouldStop.value) return;
            const enemy = enemiesByNodeId.get(assignment.nodeId);
            if (!enemy) throw new Error(`计划中的 nodeId 不存在: ${assignment.nodeId}`);

            if (
              member.attackStatsKnown &&
              (member.attackCnt >= CAMP_MAX_ATTACKS || member.aSuccessCnt >= CAMP_MAX_SUCCESS)
            ) {
              log(
                `${member.token.name} [club ${clubContext.clubId}] ` +
                  `额度到顶（发起 ${member.attackCnt}/10、成功 ${member.aSuccessCnt}/3），停止该角色剩余攻击`,
                "warning",
              );
              return;
            }
            await sendCampCommand(
              member.tokenId,
              "club_gettargetteam",
              { targetId: Number(enemy.targetId) },
              8000,
              `attack-target nodeId=${enemy.nodeId}`,
            );
            await sendCampCommand(
              member.tokenId,
              "hero_calcpowerbyteam",
              member.teamSetParams,
              8000,
              `attack-target nodeId=${enemy.nodeId}`,
            );

            const attackResponse = await sendCampCommand(
              member.tokenId,
              "club_attack",
              {
                nodeId: enemy.nodeId,
                targetId: Number(enemy.targetId),
                targetIsMirror: enemy.targetIsMirror,
                challengeCnt: enemy.challengeCnt,
                failCnt: enemy.failCnt,
                useItem: false,
                teamSetParams: member.teamSetParams,
              },
              10000,
              `attack nodeId=${enemy.nodeId} targetId=${enemy.targetId} mirror=${enemy.targetIsMirror}`,
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

  const claimMemberRewards = async (member, options = {}) => {
    const { groupId, stage, claimAll = false, quiet = false } = options;
    const groupConfIds = claimAll
      ? [1, 2, 3].flatMap((id) => getCampRewardConfIds(id))
      : getCampRewardConfIds(groupId).slice(0, Math.max(0, (stage ?? 0) - 2));
    const confIds = [
      ...(member.attackCnt >= 3 ? [1] : []),
      ...groupConfIds,
    ];
    let claimed = 0;

    await withTokenConnection(member.tokenId, async () => {
      await sendCampCommand(
        member.tokenId,
        "legion_getinfo",
        {},
        10000,
        "reward-context",
      );
      await sendCampCommand(
        member.tokenId,
        "saltroad_getwartype",
        { date: getSaltRoadDate() },
        10000,
        "reward-context",
      );
      const clubInfo = await sendCampCommand(
        member.tokenId,
        "club_getinfo",
        {},
        10000,
        "reward-context",
      );
      const claimedMap = clubInfo?.siege?.taskClaimedMap || {};
      for (const confId of confIds) {
        if (shouldStop.value) break;
        if (Object.prototype.hasOwnProperty.call(claimedMap, String(confId))) {
          log(`${member.token.name} [club ${member.clubId}] 奖励 ${confId} 已领取，跳过`, "info");
          continue;
        }
        try {
          await sendCampCommand(
            member.tokenId,
            "club_taskclaim",
            { confId },
            8000,
            `claim confId=${confId}`,
          );
          claimed += 1;
          log(`${member.token.name} [club ${member.clubId}] 已领取营地奖励 ${confId}`, "success");
        } catch (error) {
          log(
            `${member.token.name} [club ${member.clubId}] 奖励 ${confId} 未领取: ${error.message || "服务端拒绝"}`,
            quiet ? "info" : "warning",
          );
        }
      }
    });

    return claimed;
  };

  /**
   * 宠物保底：普通攻击之后仍有成功额度没拿满时，用必胜的宠物补齐，保证每人每天拿满 3 次获胜。
   *
   * ⚠️ 口径（master 2026-09-17 02:27 澄清，**以此为准**）：攻击宠物**同样消耗每日的战斗次数与获胜次数**
   * （宠物必胜）。所以：
   * - 宠物保底要同时受"剩余发起次数"和"剩余成功次数"约束；
   * - 规划层必须保留最后 `remainingWins` 次发起额度给宠物（`reserveWinsForPet`），
   *   否则中途打普通怪失败会挤掉必胜名额，拿不满 3 次获胜。
   * 实现上按"宠物也占发起额度"保守记账（即使服务端 `attackCnt` 未随之增长，也不会超发）。
   */
  const runPetInsurance = async (members, clubId) => {
    let totalWins = 0;

    for (const member of members) {
      if (shouldStop.value) break;
      try {
        const wins = await withTokenConnection(member.tokenId, async () => {
          const live = await readMemberContextOnConnection(member.tokenId, {
            contextLabel: "pet-insurance",
            usePresetTeam: !member.teamSetParams,
            teamSetParams: member.teamSetParams,
          });
          member.teamSetParams = live.teamSetParams || member.teamSetParams;
          if (live.attackStatsKnown) {
            member.attackCnt = live.attackCnt;
            member.aSuccessCnt = live.aSuccessCnt;
          }

          const remainingWins = Math.max(0, CAMP_MAX_SUCCESS - member.aSuccessCnt);
          if (remainingWins === 0) {
            log(
              `${member.token.name} [club ${clubId}] 成功额度已满（${member.aSuccessCnt}/${CAMP_MAX_SUCCESS}），无需宠物保底`,
              "info",
            );
            return 0;
          }
          if (!member.teamSetParams) {
            log(
              `${member.token.name} [club ${clubId}] 缺少阵容参数，跳过宠物保底`,
              "warning",
            );
            return 0;
          }

          // 宠物也占发起额度：按保守口径本地记账，避免超发。
          let attemptsRemaining = Math.max(
            0,
            CAMP_MAX_ATTACKS - member.attackCnt,
          );
          const plannedPetAttacks = Math.min(remainingWins, attemptsRemaining);
          if (plannedPetAttacks < remainingWins) {
            log(
              `${member.token.name} [club ${clubId}] 剩余发起额度只有 ${attemptsRemaining} 次，` +
                `宠物保底只能补 ${plannedPetAttacks} 次（目标 ${remainingWins} 次）`,
              "warning",
            );
          }
          if (plannedPetAttacks === 0) {
            log(
              `${member.token.name} [club ${clubId}] 发起额度已用尽，本次无法补满获胜次数`,
              "warning",
            );
            return 0;
          }

          log(
            `${member.token.name} [club ${clubId}] 宠物保底开始：今日发起 ${member.attackCnt}/10、` +
              `已成功 ${member.aSuccessCnt}/${CAMP_MAX_SUCCESS}，准备用宠物补 ${plannedPetAttacks} 次`,
            "info",
          );

          let wins = 0;
          for (let index = 0; index < plannedPetAttacks; index += 1) {
            if (shouldStop.value) break;
            attemptsRemaining -= 1;
            await sendCampCommand(
              member.tokenId,
              "hero_calcpowerbyteam",
              member.teamSetParams,
              8000,
              "pet-insurance",
            );
            const response = await sendCampCommand(
              member.tokenId,
              "club_attackmonster",
              { useItem: false, teamSetParams: member.teamSetParams },
              15000,
              "pet-insurance",
            );
            const won = isCampWin(response);
            const stats = getCampAttackStats(response?.siege);
            if (stats.known) {
              member.attackCnt = stats.attackCnt;
              member.aSuccessCnt = stats.aSuccessCnt;
            } else if (won) {
              member.aSuccessCnt += 1;
            }
            if (won) wins += 1;
            log(
              `${member.token.name} [club ${clubId}] 宠物保底第 ${index + 1}/${plannedPetAttacks} 次` +
                `${won ? "成功" : "失败"}（今日发起 ${member.attackCnt}/10、成功 ${member.aSuccessCnt}/3，` +
                `本次剩余可发起 ${attemptsRemaining} 次）`,
              won ? "success" : "warning",
            );
            if (member.aSuccessCnt >= CAMP_MAX_SUCCESS || attemptsRemaining <= 0) break;
          }
          return wins;
        });
        totalWins += wins;
      } catch (error) {
        log(
          `${member.token.name} [club ${clubId}] 宠物保底失败: ${error?.message || error}`,
          "warning",
        );
      }
    }

    if (totalWins > 0) {
      log(`[club ${clubId}] 宠物保底共拿到 ${totalWins} 次成功`, "success");
    }
    return totalWins;
  };

  /**
   * 一个俱乐部的完整规划执行。
   * 该俱乐部只开**一条**信息连接：俱乐部上下文（legion/club_getinfo）与目标战力查询共用它；
   * 参战角色与领奖才各自建连。
   */
  const runOneClub = async (group) => {
    const clubId = group.clubId ?? "-";
    const logClub = (text, type = "info") => log(`[club ${clubId}] ${text}`, type);

    if (!isCampBattleDay()) {
      logClub(
        `今天（周${"日一二三四五六"[new Date().getDay()]}）不是营地战斗日` +
          "（战斗日为周二/三/四），跳过自动战斗；如需领奖请用「只领取营地奖励」",
        "warning",
      );
      return;
    }

    const probeTokenId = group.tokens[0]?.id;
    if (!probeTokenId) {
      logClub("该俱乐部没有可用角色，跳过", "warning");
      return;
    }

    // 俱乐部级信息：一次连接完成上下文 + 目标战力查询。
    const info = await withTokenConnection(probeTokenId, async () => {
      const header = await readClubHeaderOnConnection(probeTokenId);
      const todayBoard = selectTodayCampOppo(header.oppoMap);
      if (!todayBoard.opponent) {
        return { header, todayBoard, targetQuery: null };
      }
      const targetQuery = await queryTargetPowers([], todayBoard.enemies, {
        clubId,
        connection: {
          tokenId: probeTokenId,
          token: header.probeToken,
          clubInfo: header.clubInfo,
        },
      });
      return { header, todayBoard, targetQuery };
    });

    const today = info.todayBoard;
    logClub(
      `今日对手 key=${today.sourceGroupKey}（星期${today.sourceGroupKey}）` +
        `${today.opponent ? `：${today.opponent.name || "-"} (${today.opponent.legionId ?? "-"})` : "：未生成"}` +
        `，节点=${today.enemies.length}`,
      today.opponent ? "success" : "warning",
    );
    if (!today.opponent) {
      logClub(
        `oppoMap 中没有今天（key=${today.sourceGroupKey}）的对手，跳过；` +
          `可见键=${Object.keys(info.header.oppoMap || {}).filter((key) => key !== "null").join(",") || "-"}`,
        "warning",
      );
      return;
    }

    const members = group.tokens.map((token) => {
      const roleId = token.roleId === undefined || token.roleId === null
        ? null
        : String(token.roleId);
      const summary = group.summaries?.get(token.id);
      const owned = roleId ? info.header.members[roleId] : null;
      return {
        tokenId: token.id,
        token,
        clubId,
        roleId: roleId ? Number(roleId) : null,
        // 战力优先用 rank_getroleinfo，其次用俱乐部成员表。
        power: summary?.power ?? owned?.power ?? null,
        teamSetParams: buildTeamSetParamsFromSummary(summary, batchSettings),
        // 俱乐部级信息只带回探测角色自己的每日计数；其余角色在执行阶段用自己的连接校正。
        attackCnt: 0,
        aSuccessCnt: 0,
        attackStatsKnown: false,
      };
    });
    const powerKnown = members.filter((member) => member.power !== null).length;
    const teamKnown = members.filter((member) => member.teamSetParams).length;
    logClub(
      `参战角色=${members.length}（战力已知 ${powerKnown} 个，阵容已知 ${teamKnown} 个），` +
        `每日额度将在各自连接上实时校验`,
      "info",
    );

    const powerThreshold = Number(batchSettings?.campPowerThreshold);
    const threshold = Number.isFinite(powerThreshold) && powerThreshold > 0
      ? powerThreshold
      : CAMP_DEFAULT_POWER_THRESHOLD;

    const targetQuery = info.targetQuery;
    const unavailableCount = targetQuery.unavailableTargets.length;
    if (unavailableCount > 0) {
      logClub(
        `${unavailableCount} 个目标无法查询，这些节点不参与本次可达性评估：` +
          targetQuery.unavailableTargets
            .map((target) => `nodeId=${target.nodeId}/targetId=${target.roleId}`)
            .join(","),
        "warning",
      );
    }

    const enemies = collectCampEnemies(
      { [today.sourceGroupKey]: today.opponent },
      targetQuery.targetPowers,
    );
    for (const enemy of enemies) {
      if (!targetQuery.completedNodeIds.has(enemy.nodeId)) continue;
      enemy.successCount = 5;
      enemy.remainingTo5 = 0;
      enemy.defeated = true;
    }

    const planning = selectBestCampGroup({
      enemies,
      members,
      powerThreshold: threshold,
      requireCompleteNodes: true,
    });
    logClub(
      `评估结果: ${formatPlanSummary(planning.groups)}（阈值=我方战力 ${Math.round(threshold * 100)}%）`,
      "info",
    );

    let plan = planning.selected;
    // 整组都清不掉时降级为"部分攻击"：30 个节点（含镜像）统一排序，打打得赢的对手，
    // 剩余成功额度再用宠物保底（见 runPetInsurance）。
    let claimAll = false;
    if (!plan) {
      const partial = planPartialCampAttacks({
        enemies,
        members,
        powerThreshold: threshold,
        reserveWinsForPet: true,
      });
      const plannedAttacks = partial.assignments.reduce(
        (sum, item) => sum + item.count,
        0,
      );
      if (plannedAttacks === 0) {
        logClub(
          "三组均不可达，也没有打得赢的目标：跳过普通攻击，只用宠物保底补满成功额度",
          "warning",
        );
      } else {
        logClub(
          `三组均不可达 → 降级为部分攻击：${plannedAttacks} 次普通攻击、覆盖 ` +
            `${new Set(partial.assignments.map((item) => item.nodeId)).size} 个节点，` +
            `打不动的节点 ${partial.skipped.length} 个，额度不足未补满的节点 ${partial.capacityStopped.length} 个`,
          "success",
        );
        plan = partial;
        claimAll = true;
      }
    }

    if (plan) {
      const clubContext = {
        clubId,
        members,
        enemies,
        sourceGroupKey: today.sourceGroupKey,
        groupId: plan.groupId ?? null,
      };
      if (planning.selected) {
        logClub(
          `选择第${plan.groupId}组，最高可达 ${plan.stage} 层，` +
            `计划攻击 ${plan.assignments.reduce((sum, item) => sum + item.count, 0)} 次`,
          "success",
        );
      }
      try {
        await executePlan(clubContext, plan);
      } catch (error) {
        // 计划中途中止（例如目标没按计划获胜）也要继续做保底与领奖，别浪费当天额度。
        logClub(
          `计划执行中止: ${error?.message || error}；继续执行宠物保底与领奖`,
          "error",
        );
      }
    }

    await runPetInsurance(members, clubId);

    for (const member of members) {
      if (shouldStop.value) break;
      await claimMemberRewards(member, {
        groupId: plan?.groupId ?? null,
        stage: plan?.stage ?? 0,
        claimAll: claimAll || !planning.selected,
        quiet: claimAll || !planning.selected,
      });
    }
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
      // 步骤 0：按俱乐部去重分组，一个俱乐部只用任一成员探测一次。
      const groups = await discoverClubGroups(tokenIds);
      log(
        `共 ${tokenIds.length} 个选中角色，归并为 ${groups.length} 个俱乐部：` +
          groups
            .map((group) => `${group.clubId ?? "-"}(${group.tokens.length})`)
            .join("、"),
        "success",
      );

      for (const group of groups) {
        if (shouldStop.value) break;
        group.tokens.forEach((token) => {
          tokenStatus.value[token.id] = "running";
        });
        try {
          await runOneClub(group);
          group.tokens.forEach((token) => {
            if (tokenStatus.value[token.id] === "running") {
              tokenStatus.value[token.id] = "completed";
            }
          });
        } catch (error) {
          group.tokens.forEach((token) => {
            tokenStatus.value[token.id] = "failed";
          });
          log(
            `[club ${group.clubId ?? "-"}] 规划执行中止: ${error?.message || "未知错误"}`,
            "error",
          );
        }
      }

      message?.success("批量营地挑战结束");
    } finally {
      isRunning.value = false;
      currentRunningTokenId.value = null;
    }
  };

  /**
   * 测试模式：读取当天对手 30 个位置的全部战力（只读，不攻击、不领奖）。
   * 每个俱乐部只开一条连接：俱乐部上下文与目标查询共用它。
   */
  const diagnoseClub = async (group) => {
    const clubId = group.clubId ?? "-";
    const logClub = (text, type = "info") => log(`[营地测试][club ${clubId}] ${text}`, type);
    const probeTokenId = group.tokens[0]?.id;
    if (!probeTokenId) {
      logClub("该俱乐部没有可用角色，跳过", "warning");
      return {
        clubId,
        opponent: null,
        positions: 0,
        targets: 0,
        okTargets: 0,
        okPositions: 0,
        failTargets: 0,
        failPositions: 0,
        unavailable: [],
      };
    }

    const startedAt = Date.now();
    const result = await withTokenConnection(probeTokenId, async () => {
      const header = await readClubHeaderOnConnection(probeTokenId);
      const availableKeys = Object.keys(header.oppoMap || {}).filter(
        (key) => key !== "null",
      );
      const todayBoard = selectTodayCampOppo(header.oppoMap);
      logClub(
        `今日 key=${todayBoard.sourceGroupKey}（星期${todayBoard.sourceGroupKey}）` +
          `，oppoMap 可见键=${availableKeys.join(",") || "-"}`,
        "info",
      );
      if (!todayBoard.opponent) {
        return { header, todayBoard, query: null };
      }
      const allNodes = todayBoard.enemies;
      const distinctRoleIds = new Set(
        allNodes
          .filter((enemy) => enemy.roleId !== undefined && enemy.roleId !== null)
          .map((enemy) => String(enemy.roleId)),
      );
      logClub(
        `今日对手 ${todayBoard.opponent.name || "-"}（${todayBoard.opponent.legionId ?? "-"}）` +
          `位置=${allNodes.length} 去重目标=${distinctRoleIds.size}`,
        "info",
      );
      const query = await queryTargetPowers([], allNodes, {
        clubId,
        queryAllNodes: true,
        ignoreUnavailableCache: true,
        ignorePowerCache: true,
        noRetryOnRejected: true,
        connection: {
          tokenId: probeTokenId,
          token: header.probeToken,
          clubInfo: header.clubInfo,
        },
      });
      return { header, todayBoard, query };
    });

    const today = result.todayBoard;
    if (!today.opponent || !result.query) {
      logClub(
        `oppoMap 中没有今天（key=${today.sourceGroupKey}）的对手，无法测试（非战斗日或对手未生成）`,
        "warning",
      );
      return {
        clubId,
        opponent: null,
        positions: 0,
        targets: 0,
        okTargets: 0,
        okPositions: 0,
        failTargets: 0,
        failPositions: 0,
        unavailable: [],
      };
    }

    const allNodes = today.enemies;
    const distinctRoleIds = new Set(
      allNodes
        .filter((enemy) => enemy.roleId !== undefined && enemy.roleId !== null)
        .map((enemy) => String(enemy.roleId)),
    );
    const query = result.query;

    const unavailableRoleIds = new Set(
      query.unavailableTargets.map((target) => String(target.roleId)),
    );
    const powerText = (power) =>
      `${power}（约 ${(Number(power) / 1e8).toFixed(2)} 亿）`;
    let okPositions = 0;
    let failPositions = 0;
    const groupStats = new Map();

    for (const enemy of allNodes) {
      const power = targetQueryPower(query, enemy);
      const failed = unavailableRoleIds.has(String(enemy.roleId));
      const groupId = enemy.groupId;
      const stats = groupStats.get(groupId) || { ok: 0, fail: 0 };
      if (power !== null) {
        okPositions += 1;
        stats.ok += 1;
      } else if (failed) {
        failPositions += 1;
        stats.fail += 1;
      }
      groupStats.set(groupId, stats);
      logClub(
        `nodeId=${String(enemy.nodeId).padStart(2)} roleId=${enemy.roleId} ` +
          `mirror=${enemy.targetIsMirror} 进度=${enemy.successCount}/5 ` +
          `defeated=${enemy.defeated} → ` +
          `${power !== null ? powerText(power) : failed ? "查询失败(200020?)" : "未查询"}` +
          `${enemy.name ? ` ${enemy.name}` : ""}`,
        power !== null ? "info" : "warning",
      );
    }

    const groupText = [...groupStats.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([groupId, stats]) => `第${groupId}组 ${stats.ok}/${stats.ok + stats.fail}`)
      .join("，");
    logClub(
      `结果：位置成功=${okPositions}/${allNodes.length} 失败=${failPositions} ` +
        `去重目标成功=${Object.keys(query.targetPowers).length}/${distinctRoleIds.size} ` +
        `耗时=${Date.now() - startedAt}ms；${groupText}`,
      failPositions === 0 ? "success" : "warning",
    );

    return {
      clubId,
      opponent: today.opponent,
      positions: allNodes.length,
      targets: distinctRoleIds.size,
      okTargets: Object.keys(query.targetPowers).length,
      okPositions,
      failTargets: unavailableRoleIds.size,
      failPositions,
      unavailable: query.unavailableTargets,
    };
  };

  const batchCampDiagnose = async () => {
    const tokenIds = [...selectedTokens.value];
    if (tokenIds.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;
    tokenIds.forEach((tokenId) => {
      tokenStatus.value[tokenId] = "waiting";
    });

    const summaries = [];
    try {
      const groups = await discoverClubGroups(tokenIds);
      log(
        `[营地测试] ${tokenIds.length} 个选中角色归并为 ${groups.length} 个俱乐部，` +
          "开始读取今日对手 30 个位置战力（只读，不攻击、不领奖）",
        "success",
      );

      for (const group of groups) {
        if (shouldStop.value) break;
        group.tokens.forEach((token) => {
          tokenStatus.value[token.id] = "running";
        });
        try {
          const summary = await diagnoseClub(group);
          summaries.push(summary);
          group.tokens.forEach((token) => {
            if (tokenStatus.value[token.id] === "running") {
              tokenStatus.value[token.id] = "completed";
            }
          });
        } catch (error) {
          group.tokens.forEach((token) => {
            tokenStatus.value[token.id] = "failed";
          });
          log(
            `[营地测试] club ${group.clubId ?? "-"} 读取失败: ${error?.message || error}`,
            "error",
          );
        }
      }

      const withOpponent = summaries.filter((summary) => summary.opponent);
      if (withOpponent.length === 0) {
        message?.warning("营地测试结束：今天没有可测试的对手");
      } else {
        const totalPositions = withOpponent.reduce((sum, item) => sum + item.positions, 0);
        const totalOkPositions = withOpponent.reduce((sum, item) => sum + item.okPositions, 0);
        const totalTargets = withOpponent.reduce((sum, item) => sum + item.targets, 0);
        const totalOkTargets = withOpponent.reduce((sum, item) => sum + item.okTargets, 0);
        const text =
          `读取 ${totalOkPositions}/${totalPositions} 个位置、` +
          `${totalOkTargets}/${totalTargets} 个去重目标成功`;
        log(`[营地测试] 汇总：${text}`, totalOkPositions === totalPositions ? "success" : "warning");
        if (totalOkPositions === totalPositions) message?.success(`营地测试结束：${text}`);
        else message?.warning(`营地测试结束：${text}（有失败目标，详见日志）`);
      }
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
        await sendCampCommand(
          tokenId,
          "club_taskclaim",
          { confId },
          8000,
          `claim confId=${confId}`,
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
              sendCampCommand(tokenId, command, params, timeout, "pet-simple");
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
          await sendCampCommand(
            tokenId,
            "legion_getinfo",
            {},
            10000,
            "claim-context",
          );
          await sendCampCommand(
            tokenId,
            "saltroad_getwartype",
            { date: getSaltRoadDate() },
            10000,
            "claim-context",
          );
          const clubInfo = await sendCampCommand(
            tokenId,
            "club_getinfo",
            {},
            15000,
            "claim-context",
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
    batchCampDiagnose,
  };
}

export {
  CAMP_DEFAULT_POWER_THRESHOLD,
  CAMP_MAX_ATTACKS,
  CAMP_MAX_SUCCESS,
  CAMP_SIMPLE_PET_ATTEMPTS,
};
