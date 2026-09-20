/**
 * 蟠桃（payload）自动化 —— 纯决策逻辑（不含任何网络/UI 依赖，便于回归测试）
 *
 * 数据来源：`Payload_EnterBfResp`（含增量广播，同一个 cmd 会反复下发）：
 *   body = { bf, roleId, bfId, tileDataMap }
 *   bf   = { id, state, mapId, readyTime, openTime, endTime,
 *            legions, roleIds, roles, carMap, nextCarTimes,
 *            nextResurrectTime, itemMap, battleMap, rTimeoutTime, noResurrect }
 *   car  = { id, position:{x,y}, pathId, progress, beginTime, endTime,
 *            memberMap, score, scoreSpeed, scoreBeginTime, scoreEndTime,
 *            state, belongLegionId, carItemId }
 *   march= { id, codeId, legionId, group, from, to, startTime, endTime, carId, path[] }
 *
 * 玩法要点（master 2026-09-20 口述）：
 *   - 蟠桃不能组队，必须一个角色一个角色分别上场 → 轮询式、分批并发
 *   - 抢船：船定时刷新，向目的地移动；抵达时按势力值判归属
 *   - 势力值 score：±100000（负=红方、正=蓝方），随船上双方人数此消彼长（scoreSpeed）
 *   - 位置重叠（同船 / 同地块）即可互相攻击
 *   - 粗放策略：登场 → 向「抵达目的地最近」的船移动 → 上船即完成 → 换下一个角色
 *     上船后若敌人战力 < 我方 70% 则攻击，否则不动
 */

// ---------------------------------------------------------------- 常量

export const ROLE_STATE = {
  WATCHING: "watching", // 未登场
  IDLE: "idle", // 已登场、静止
  MARCH: "march", // 行军中
  DIE: "die", // 阵亡等复活
};

export const CAR_STATE = {
  MOVING: "moving",
  END: "end",
};

/** 船已抵达时 state 为 "end"；其余视为行进中 */
export const DEFAULT_ATTACK_RATIO = 0.7;
/** 实测：玩家行军每一格约 2000ms（march.endTime - march.startTime） */
export const DEFAULT_MS_PER_MARCH_STEP = 2000;

// ---------------------------------------------------------------- 取值小工具

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 从 Payload_EnterBfResp 的 body 里取出战场快照（兼容 bf 增量广播帧） */
export function normalizeSnapshot(body) {
  if (!isObj(body)) return null;
  const bf = isObj(body.bf) ? body.bf : null;
  return {
    bf,
    myRoleId: num(body.roleId, 0),
    bfId: body.bfId || (bf && bf.id) || "",
    tileData: (isObj(body.tileDataMap) && isObj(body.tileDataMap.tileData) && body.tileDataMap.tileData) || {},
  };
}

// ---------------------------------------------------------------- 角色状态

export function getRole(bf, roleId) {
  if (!isObj(bf) || !isObj(bf.roles)) return null;
  const r = bf.roles[String(roleId)];
  return isObj(r) ? r : null;
}

export function getRoleState(bf, roleId) {
  const r = getRole(bf, roleId);
  return r ? String(r.state || "") : "";
}

/** 已登场 = 任何非 watching 的状态（idle / march / die / 战斗中） */
export function isDeployed(bf, roleId) {
  const s = getRoleState(bf, roleId);
  return s !== "" && s !== ROLE_STATE.WATCHING;
}

export function isDead(bf, roleId) {
  return getRoleState(bf, roleId) === ROLE_STATE.DIE;
}

export function isMarching(bf, roleId) {
  return getRoleState(bf, roleId) === ROLE_STATE.MARCH;
}

/** 我方军团 ID（用自己角色的 legionId 兜底 refLegionId） */
export function resolveMyLegionId(bf, roleId) {
  const r = getRole(bf, roleId);
  if (r && num(r.legionId, 0)) return num(r.legionId, 0);
  return num(bf && bf.refLegionId, 0);
}

/** 老家坐标（登场点） */
export function getHomePosition(bf, legionId) {
  if (!isObj(bf) || !isObj(bf.legions)) return null;
  const l = bf.legions[String(legionId)];
  return isObj(l) && isObj(l.position) ? { x: num(l.position.x), y: num(l.position.y) } : null;
}

// ---------------------------------------------------------------- 几何

/** 曼哈顿距离（粗放玩法够用；真实路径由服务端 path 给出） */
export function manhattan(a, b) {
  if (!isObj(a) || !isObj(b)) return Infinity;
  return Math.abs(num(a.x) - num(b.x)) + Math.abs(num(a.y) - num(b.y));
}

/** 角色当前所在地块：优先 tileData.memberMap 命中，其次老家 */
export function getRolePosition(snapshot, roleId) {
  const { tileData, bf } = snapshot;
  for (const [tile, t] of Object.entries(tileData || {})) {
    if (isObj(t) && isObj(t.memberMap) && t.memberMap[String(roleId)] !== undefined) {
      const [x, y] = tile.split("_").map((v) => num(v));
      return { x, y, tile };
    }
  }
  const home = getHomePosition(bf, resolveMyLegionId(bf, roleId));
  return home ? { x: home.x, y: home.y, tile: home.x + "_" + home.y } : null;
}

// ---------------------------------------------------------------- 船（carMap）

export function listCars(bf) {
  if (!isObj(bf) || !isObj(bf.carMap)) return [];
  return Object.values(bf.carMap).filter(isObj);
}

/** 未抵达的船（可抢） */
export function listActiveCars(bf) {
  return listCars(bf).filter((c) => String(c.state || "") !== CAR_STATE.END);
}

export function isCarEnded(car) {
  return String((car && car.state) || "") === CAR_STATE.END;
}

/**
 * 船距离目的地还剩多少步。
 * 协议里只有 progress（已走步数）与 state，总步数不在响应里 —— 由调用方
 * 通过 totalStepsByPathId 注入（抓到行进中的船后即可标定）；拿不到时返回 null，
 * 交给上层按「仅按距离」降级处理。
 */
export function getCarStepsLeft(car, { totalStepsByPathId = null } = {}) {
  if (!isObj(car)) return null;
  const done = num(car.progress, 0);
  const total = isObj(totalStepsByPathId) ? num(totalStepsByPathId[String(car.pathId)], 0) : 0;
  if (total > 0) return Math.max(0, total - done);
  return null;
}

/** 船上的人（roleId 列表） */
export function getCarMemberIds(car) {
  if (!isObj(car) || !isObj(car.memberMap)) return [];
  return Object.keys(car.memberMap).map((v) => num(v, 0));
}

export function isRoleOnCar(car, roleId) {
  return getCarMemberIds(car).includes(num(roleId, 0));
}

/** 船上的敌人（排除同军团） */
export function getEnemiesOnCar(bf, car, myLegionId) {
  const ids = getCarMemberIds(car);
  const out = [];
  for (const id of ids) {
    const r = getRole(bf, id);
    if (!r) continue;
    if (myLegionId && num(r.legionId, 0) === num(myLegionId, 0)) continue;
    out.push({ roleId: id, power: num(r.power, 0), name: r.name || "", state: r.state || "" });
  }
  return out.sort((a, b) => a.power - b.power);
}

/** 势力值归属倾向：负=敌方占优、正=我方占优（belongLegionId 为当前归属） */
export function describeCarScore(car, myLegionId) {
  const score = num(car && car.score, 0);
  const belong = num(car && car.belongLegionId, 0);
  const mine = myLegionId > 0 && belong === num(myLegionId, 0);
  return {
    score,
    belong,
    mine,
    contested: Math.abs(score) < 30000,
    speed: num(car && car.scoreSpeed, 0),
  };
}

// ---------------------------------------------------------------- 选船

export const CAR_STRATEGY = {
  /** 抵达目的地最近（剩余步数最少），且我赶得上；赶不上则退而求其次挑最近的船 */
  NEAREST_ARRIVAL: "nearest-arrival",
  /** 只按距离：离我最近的船 */
  NEAREST_ME: "nearest-me",
  /** 胶着的船优先（|score| 最小，最值得抢） */
  CONTESTED: "contested",
};

/**
 * 选目标船。
 * @returns { car, stepsLeft, mySteps, reachable, reason }
 */
export function pickTargetCar({
  bf,
  myPosition,
  strategy = CAR_STRATEGY.NEAREST_ARRIVAL,
  totalStepsByPathId = null,
  excludeCarIds = [],
} = {}) {
  const cars = listActiveCars(bf).filter((c) => !excludeCarIds.includes(num(c.id, 0)));
  if (!cars.length) return { car: null, reason: "当前没有行进中的船" };

  const scored = cars.map((car) => {
    const stepsLeft = getCarStepsLeft(car, { totalStepsByPathId });
    const mySteps = manhattan(myPosition, car.position);
    return {
      car,
      stepsLeft,
      mySteps,
      // 船剩余步数 >= 我到船的距离 → 赶得上（都按「步」粗算）
      reachable: stepsLeft === null ? true : stepsLeft >= mySteps,
      absScore: Math.abs(num(car.score, 0)),
    };
  });

  let picked;
  if (strategy === CAR_STRATEGY.NEAREST_ME) {
    picked = scored.slice().sort((a, b) => a.mySteps - b.mySteps)[0];
  } else if (strategy === CAR_STRATEGY.CONTESTED) {
    picked = scored.slice().sort((a, b) => a.absScore - b.absScore || a.mySteps - b.mySteps)[0];
  } else {
    // 默认：先挑赶得上的，其中剩余步数最少（最紧迫、最不容易错过）
    const reachable = scored.filter((s) => s.reachable);
    const pool = reachable.length ? reachable : scored;
    picked = pool.slice().sort((a, b) => {
      const av = a.stepsLeft === null ? Infinity : a.stepsLeft;
      const bv = b.stepsLeft === null ? Infinity : b.stepsLeft;
      return av - bv || a.mySteps - b.mySteps;
    })[0];
  }

  return {
    car: picked.car,
    stepsLeft: picked.stepsLeft,
    mySteps: picked.mySteps,
    reachable: picked.reachable,
    reason: picked.reachable
      ? `船${num(picked.car.id, 0)}：剩 ${picked.stepsLeft ?? "?"} 步、我距 ${picked.mySteps} 格`
      : `船${num(picked.car.id, 0)}：赶不上（剩 ${picked.stepsLeft ?? "?"} 步 / 我距 ${picked.mySteps} 格），仍选最近`,
  };
}

// ---------------------------------------------------------------- 攻击决策

/**
 * 敌人战力低于我方 70% 才打。
 * @returns {boolean} 是否攻击
 */
export function shouldAttack(myPower, enemyPower, ratio = DEFAULT_ATTACK_RATIO) {
  const mine = num(myPower, 0);
  const foe = num(enemyPower, 0);
  if (mine <= 0 || foe <= 0) return false;
  return foe < mine * num(ratio, DEFAULT_ATTACK_RATIO);
}

/** 在敌人列表里挑一个打得过的（优先战力最低，避免越级） */
export function pickAttackTarget(enemies, myPower, ratio = DEFAULT_ATTACK_RATIO) {
  const list = (Array.isArray(enemies) ? enemies : []).filter((e) => shouldAttack(myPower, e.power, ratio));
  return list.length ? list[0] : null;
}

// ---------------------------------------------------------------- 单角色回合决策

export const ACTION = {
  ENTER: "enter", // 进场（payload_enterbf）
  DEPLOY: "deploy", // 布阵登场（payload_setbattleteam）
  WAIT_CAR: "wait-car", // 等船刷新
  WAIT_REVIVE: "wait-revive", // 等复活
  WAIT_MARCH: "wait-march", // 行军中
  MARCH: "march", // 发起行军（payload_startmarch）
  ATTACK: "attack", // 攻击同位置敌人
  DONE: "done", // 本轮完成，切换下一个角色
};

/**
 * 单个角色的下一步动作。
 * @param {object} snapshot  normalizeSnapshot(Payload_EnterBfResp.body)
 * @param {object} opts      { roleId, attackRatio, strategy, totalStepsByPathId, nowMs, boardedCarId }
 * @returns {{ action:string, reason:string, car?:object, target?:object }}
 */
export function planTurn(snapshot, opts = {}) {
  const { bf } = snapshot || {};
  if (!isObj(bf)) return { action: ACTION.ENTER, reason: "还没有战场快照，需要先进场" };

  const roleId = num(opts.roleId || snapshot.myRoleId, 0);
  const role = getRole(bf, roleId);
  if (!role) return { action: ACTION.ENTER, reason: `战场里查不到角色 ${roleId}` };

  const state = String(role.state || "");
  const myLegionId = resolveMyLegionId(bf, roleId);
  const myPower = num(role.power, 0);

  if (state === ROLE_STATE.WATCHING) {
    return { action: ACTION.DEPLOY, reason: "尚未登场，先布阵上场" };
  }
  if (state === ROLE_STATE.DIE) {
    return { action: ACTION.WAIT_REVIVE, reason: "阵亡，等待复活", reviveAt: num(bf.nextResurrectTime, 0) };
  }
  if (state === ROLE_STATE.MARCH) {
    return { action: ACTION.WAIT_MARCH, reason: "行军中" };
  }

  // 已登场且静止：认领自己所在的船
  const boardedCarId = num(opts.boardedCarId, 0);
  const boarded = boardedCarId
    ? listCars(bf).find((c) => num(c.id, 0) === boardedCarId)
    : listCars(bf).find((c) => isRoleOnCar(c, roleId));

  if (!boarded) {
    const myPos = getRolePosition(snapshot, roleId);
    const pick = pickTargetCar({
      bf,
      myPosition: myPos,
      strategy: opts.strategy,
      totalStepsByPathId: opts.totalStepsByPathId,
      excludeCarIds: opts.excludeCarIds,
    });
    if (!pick.car) {
      const next = Array.isArray(bf.nextCarTimes) ? bf.nextCarTimes[0] : 0;
      return { action: ACTION.WAIT_CAR, reason: "没有行进中的船，等待刷新", nextCarAt: num(next, 0) };
    }
    return { action: ACTION.MARCH, car: pick.car, reason: pick.reason, stepsLeft: pick.stepsLeft, mySteps: pick.mySteps };
  }

  // 已上船：粗放策略里「上船即完成」，但先看有没有白给的敌人
  const enemies = getEnemiesOnCar(bf, boarded, myLegionId);
  const target = pickAttackTarget(enemies, myPower, opts.attackRatio);
  if (target) {
    return {
      action: ACTION.ATTACK,
      car: boarded,
      target,
      reason: `已上船${num(boarded.id, 0)}；敌人 ${target.name || target.roleId} 战力 ${target.power} < 我方 ${myPower} 的 ${num(opts.attackRatio, DEFAULT_ATTACK_RATIO) * 100}%`,
    };
  }
  return {
    action: ACTION.DONE,
    car: boarded,
    reason: enemies.length
      ? `已上船${num(boarded.id, 0)}；船上 ${enemies.length} 个敌人都打不过（战力均 ≥ 我方 70%），本轮完成`
      : `已上船${num(boarded.id, 0)}，船上无敌，本轮完成`,
  };
}

// ---------------------------------------------------------------- 布阵（预设队伍）

/**
 * 从 `presetteam_getinfo` 的响应里取出出战阵容（纯逻辑，编排层与测试共用）。
 *
 * 响应形状（PresetTeam_GetInfoResp）：
 *   { presetTeamInfo: { roleId, useTeamId,
 *       presetTeamInfo: { "1": { teamName, teamInfo:{0..4:{heroId,…}}, weapon:{weaponId}, petUId } } } }
 *
 * @returns {{battleTeam:object, petUId:string, weaponId:number, teamId:number}|null}
 */
export function buildBattleTeamFromPreset(resp) {
  const root = isObj(resp?.presetTeamInfo) ? resp.presetTeamInfo : isObj(resp?.body?.presetTeamInfo) ? resp.body.presetTeamInfo : resp;
  if (!isObj(root)) return null;
  const teamId = num(root.useTeamId, 1) || 1;
  const team = isObj(root.presetTeamInfo) ? root.presetTeamInfo[String(teamId)] || root.presetTeamInfo[teamId] : null;
  if (!isObj(team)) return null;

  const battleTeam = {};
  const info = isObj(team.teamInfo) ? team.teamInfo : {};
  for (const slot of Object.keys(info)) {
    const heroId = num(info[slot]?.heroId, 0);
    if (heroId > 0) battleTeam[String(slot)] = heroId;
  }
  if (!Object.keys(battleTeam).length) return null;

  return {
    battleTeam,
    petUId: team.petUId || "",
    weaponId: num(team.weapon?.weaponId, 0),
    teamId,
  };
}

// ---------------------------------------------------------------- 轮询调度

/**
 * 轮询分批：蟠桃不能组队，只能一批一批上（受并发与 IP 限流约束）。
 * @param {Array} roleIds 全部待办角色
 * @param {number} concurrency 每批并发数
 * @returns {Array<Array>} 分批后的角色数组
 */
export function planPollingBatches(roleIds, concurrency = 1) {
  const list = Array.isArray(roleIds) ? roleIds.slice() : [];
  const size = Math.max(1, Math.floor(num(concurrency, 1)));
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 一轮轮询的节奏控制：批间间隔（毫秒），用于规避 IP 频次限流。
 */
export function batchIntervalMs({ concurrency = 1, minIntervalMs = 1200 } = {}) {
  const c = Math.max(1, Math.floor(num(concurrency, 1)));
  return Math.max(num(minIntervalMs, 1200), Math.round(num(minIntervalMs, 1200) * Math.log2(c + 1)));
}
