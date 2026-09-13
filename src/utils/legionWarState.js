/**
 * 盐场战场状态：纯函数实现（无 WebSocket、无 Vue 依赖）
 *
 * 用途：把 `War_EnterBattlefieldResp` 的全量快照与后续增量帧，归一化成一份可查询的战场状态。
 * 之所以单独抽出来，是因为「每支队伍一条连接」（见 docs/saltfield-auto-ui-design.md §1.5）——
 * roleMap 是按"连接所属俱乐部"下发的，所以状态必须按连接隔离。
 * legionWarStore（单连接只读页）与 tasksSaltField（多队编排）共用本文件。
 */

/** 需要按 key 逐条合并的战场子表（服务端下发的是增量） */
const DELTA_KEYED_TABLES = [
  "roles",
  "teamMap",
  "buildingData",
  "marches",
  "legions",
  "bList",
];

/** 战场顶层需要保留的标量字段 */
const BATTLEFIELD_META_KEYS = [
  "id",
  "arenaId",
  "name",
  "state",
  "confId",
  "legionWarMap",
  "mapName",
  "type",
  "subType",
  "roleNum",
  "openTime",
  "readyTime",
  "endTime",
  "timeoutTime",
  "fCLegionId",
];

/** 新建一份空状态 */
export function createInitialState() {
  return {
    battlefieldId: "",
    /** 本连接自身的战场 codeId（来自 body.roleCodeId） */
    roleCodeId: null,
    /** roleId(string) -> { rId, cId, n, h, s } —— 只覆盖本连接所属俱乐部 */
    roleMap: {},
    /** cId(string) -> role 对象 */
    roles: {},
    /** leaderCid(string) -> { lCodeId, state, mCodeIds: [], position } */
    teamMap: {},
    /** legionId(string) -> legion 对象 */
    legions: {},
    /** 战场常量：TeamCd / Time / MoveTime ... */
    constant: {},
    /** 战场顶层元信息 */
    meta: {},
    /** 是否已收到过全量快照 */
    hasSnapshot: false,
    updatedAt: 0,
  };
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array);
}

function mergeKeyedTable(target, patch) {
  if (!isPlainObject(patch)) return;
  for (const key of Object.keys(patch)) {
    const next = patch[key];
    const prev = target[key];
    // 服务端用 null 表示"移除该条目"（例如 memberV2 里清空）
    if (next === null) {
      delete target[key];
      continue;
    }
    target[key] = isPlainObject(next) && isPlainObject(prev) ? { ...prev, ...next } : next;
  }
}

/**
 * 应用一帧战场数据。
 * @param {object} state 由 createInitialState 创建的状态（会被就地修改）
 * @param {object} body  外层信封的 body（即 msg.rawData）
 * @returns {object} state
 */
export function applyBattlefieldFrame(state, body) {
  if (!isPlainObject(body)) return state;

  if (body.battlefieldId) state.battlefieldId = body.battlefieldId;
  if (body.roleCodeId !== undefined && body.roleCodeId !== null) {
    state.roleCodeId = Number(body.roleCodeId);
  }

  // roleMap：全量快照里带，增量帧不带。整份替换（它是本连接所属俱乐部的完整映射）
  if (isPlainObject(body.roleMap) && Object.keys(body.roleMap).length > 0) {
    state.roleMap = { ...body.roleMap };
  }

  const bf = body.battlefield;
  if (!isPlainObject(bf)) {
    state.updatedAt = Date.now();
    return state;
  }

  // 全量快照：battlefield 里带 meta 标量 + 各子表
  const incomingMeta = {};
  for (const key of BATTLEFIELD_META_KEYS) {
    if (bf[key] !== undefined) incomingMeta[key] = bf[key];
  }
  if (Object.keys(incomingMeta).length > 0) {
    state.meta = { ...state.meta, ...incomingMeta };
  }
  if (isPlainObject(bf.constant) && Object.keys(bf.constant).length > 0) {
    state.constant = { ...state.constant, ...bf.constant };
  }

  for (const key of DELTA_KEYED_TABLES) {
    if (bf[key] !== undefined) {
      if (!isPlainObject(state[key])) state[key] = {};
      mergeKeyedTable(state[key], bf[key]);
    }
  }

  if (!state.hasSnapshot && isPlainObject(bf.roles) && Object.keys(bf.roles).length > 10) {
    state.hasSnapshot = true;
  }
  state.updatedAt = Date.now();
  return state;
}

/** roleId -> cId（查不到返回 null） */
export function roleIdToCid(state, roleId) {
  const entry = state?.roleMap?.[String(roleId)];
  return entry ? Number(entry.cId) : null;
}

/** cId -> roleId（反查，用于展示） */
export function cidToRoleId(state, cid) {
  const target = String(cid);
  for (const roleId of Object.keys(state?.roleMap || {})) {
    if (String(state.roleMap[roleId].cId) === target) return Number(roleId);
  }
  return null;
}

/** 取某支队伍的成员 cId 列表（队长 cId 为键） */
export function getTeamMemberCids(state, leaderCid) {
  const team = state?.teamMap?.[String(leaderCid)];
  return Array.isArray(team?.mCodeIds) ? team.mCodeIds.map(Number) : [];
}

/** 取某 battle 角色的当前状态（state / position / isOnline / power） */
export function getRole(state, cid) {
  return state?.roles?.[String(cid)] || null;
}

/**
 * 活动窗口是否已开放（用于 UI 置灰「一键执行」）
 * 战场时间来自 body.battlefield.{readyTime,openTime,endTime}（秒）
 */
export function getActivityWindow(state, nowSec = Math.floor(Date.now() / 1000)) {
  const meta = state?.meta || {};
  const start = Number(meta.openTime || meta.readyTime || 0);
  const end = Number(meta.endTime || 0);
  if (!start || !end) {
    return { known: false, open: false, state: meta.state || "", remainSec: 0 };
  }
  return {
    known: true,
    open: nowSec >= start && nowSec < end,
    state: meta.state || "",
    start,
    end,
    remainSec: Math.max(0, end - nowSec),
  };
}

/** 由业务侧放置的补充信息（例如 legion_getinfo 拿到的本俱乐部名册） */
export function summarizeSnapshot(state) {
  return {
    battlefieldId: state.battlefieldId,
    roleCodeId: state.roleCodeId,
    roleMapSize: Object.keys(state.roleMap || {}).length,
    rolesSize: Object.keys(state.roles || {}).length,
    teamMapSize: Object.keys(state.teamMap || {}).length,
    hasSnapshot: state.hasSnapshot,
    updatedAt: state.updatedAt,
  };
}
