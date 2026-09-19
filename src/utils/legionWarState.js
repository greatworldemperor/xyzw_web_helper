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
export function applyBattlefieldFrame(state, body, ownerRoleId = 0) {
  if (!isPlainObject(body)) return state;

  if (body.battlefieldId) state.battlefieldId = body.battlefieldId;
  // ⚠️ roleCodeId 是「本连接自身」的语义，绝不能跟随广播帧的 body.roleCodeId
  // （广播帧里那是别人的 cId：实测每条连接涉及 15~182 个不同 cId，且首帧也未必是自己的）。
  // 正确判据：用「自己的 roleId」在 roleMap（本俱乐部 roleId→cId）里反查自己的 cId。
  // roleMap 只在全量快照帧带（增量广播不带）→ 身份永不漂移。
  const roleMapSnapshot = isPlainObject(body.roleMap) ? body.roleMap : null;
  if (ownerRoleId && roleMapSnapshot) {
    const entry = roleMapSnapshot[String(ownerRoleId)];
    const cid = entry ? Number(entry.cId) : NaN;
    if (Number.isFinite(cid) && cid > 0) state.roleCodeId = cid;
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

/**
 * 取某队员的「准备期截止时间戳」teamLimitTime（没有/已过准备期返回 null）。
 * 2026-09-19 首战实锤：邀请响应里该字段 = 邀请时刻 + 8 秒（260 样本中位 8s），
 * 正式入队后字段消失。
 */
export function getTeamLimitTime(state, cid) {
  const r = getRole(state, cid);
  const t = Number(r?.teamLimitTime || 0);
  return t > 0 ? t : null;
}

/**
 * 某队员是否已「正式入队」（就位）：
 *   在队伍名单中 且（无 teamLimitTime 或 已过准备期）
 * ⚠️ mCodeIds 满员只是「占位」，占位 ≠ 正式入队；含未就位成员时全队无法登场。
 */
export function isMemberSettled(
  state,
  leaderCid,
  cid,
  nowSec = Math.floor(Date.now() / 1000),
  slackSec = 1,
) {
  const inTeam = getTeamMemberCids(state, leaderCid).includes(Number(cid));
  if (!inTeam) return false;
  const t = getTeamLimitTime(state, cid);
  return t === null || nowSec >= t + slackSec;
}

/**
 * 队伍里尚未就位的成员（用于登场前判定）：
 * 返回 { notInTeam: number[], stillPreparing: number[], readySecLeft: number }
 */
export function getUnsettledMembers(state, leaderCid, memberCids, nowSec = Math.floor(Date.now() / 1000)) {
  const members = getTeamMemberCids(state, leaderCid);
  const notInTeam = [];
  const stillPreparing = [];
  let readySecLeft = 0;
  for (const c of memberCids || []) {
    const cid = Number(c);
    if (!members.includes(cid)) { notInTeam.push(cid); continue; }
    const t = getTeamLimitTime(state, cid);
    if (t !== null && nowSec < t + 1) {
      stillPreparing.push(cid);
      readySecLeft = Math.max(readySecLeft, t + 1 - nowSec);
    }
  }
  return { notInTeam, stillPreparing, readySecLeft };
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

/**
 * 队员「出现」（可被邀请）判定 —— 等待模式的核心条件。
 *
 * master 定义的游戏规则（2026-09-16）：一个角色「不出现在可组队目标中」当且仅当：
 *   ① 他已登场；② 他虽未登场，但已被其它角色组队（入队后、队伍尚未登场）。
 * 两种情况对应战场状态就是 `roles[cId].state !== "watching"`
 *   · watching  = 在战场、未登场、未入队 —— 可组队（离线号也是 watching，可邀请）
 *   · teaming   = 已入队、队伍未登场 —— 不可组队
 *   · idle 等   = 已登场 —— 不可组队
 *
 * @param {object} state  战场状态
 * @param {number} cid    目标队员的战场 codeId
 * @param {number} myCid  自己（队长）的 codeId
 * @returns {{ready: boolean, reason: string}}
 *   ready=true 表示「已出现」，可以邀请；
 *   reason: "" | "in_my_team"（已在我队里）| "not_in_field"（战场状态表中还没有此人）| 其它 state 字符串
 */
export function getInviteReadiness(state, cid, myCid) {
  const c = Number(cid);
  if (!Number.isFinite(c)) return { ready: false, reason: "bad_cid" };
  if (getTeamMemberCids(state, myCid).includes(c)) {
    return { ready: false, reason: "in_my_team" };
  }
  const role = getRole(state, c);
  if (!role) return { ready: false, reason: "not_in_field" };
  if (role.state === "watching") return { ready: true, reason: "" };
  return { ready: false, reason: String(role.state || "unknown") };
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
