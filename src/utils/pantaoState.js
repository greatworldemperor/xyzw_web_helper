/**
 * 蟠桃战场状态累积（纯逻辑，无网络/UI 依赖 → 可回归）
 *
 * 为什么需要这一层：
 *   蟠桃战场**没有**「拉全量快照」的命令（盐场有 war_getbattlefieldinfo），
 *   服务端只下发：
 *     · `Payload_EnterBfResp`（首帧全量 20KB，之后**同一个 cmd 反复下发增量**）
 *     · `Payload_StartMarchResp` / `Payload_EndMarchNotify` / `Payload_StartBattleResp`
 *       / `Payload_EndBattleNotify` / `Payload_StateChangeNotify` / `Payload_*CarNotify`
 *   增量帧只带变化字段，且**用 null 表示删除**（`battleMap[86]=null`、
 *   `carMap[15].memberMap[roleId]=null`、`marches[id]=null`）。
 *   ⇒ 必须自己把增量合并成完整快照，否则决策层看到的永远是残缺数据。
 *
 * 帧形状（统一已解码的 body / rawData）：
 *   { bf: {...}, roleId, bfId, tileDataMap: { tileData: { "x_y": {...} } } }
 *   增量帧示例：
 *   { bf: { state: "started" }, bfId }
 *   { bf: { roles: { "292742316": { state: "march" } } }, bfId }
 *   { bf: { carMap: { "15": { progress, beginTime } } }, bfId }
 *   { bfId, tileDataMap: { tileData: { "13_19": { memberMap: { "139080738": null } } } } }
 */

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * 把 patch 深合并进 target；**patch 里的 null 表示删除该键**。
 * @returns {object} target（原地修改）
 */
export function mergeInto(target, patch) {
  if (!isObj(target) || !isObj(patch)) return target;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete target[k];
      continue;
    }
    if (isObj(v)) {
      if (!isObj(target[k])) target[k] = {};
      mergeInto(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** 新战场状态容器 */
export function createPantaoState({ bfId = "", myRoleId = 0 } = {}) {
  return {
    bfId: bfId || "",
    myRoleId: Number(myRoleId) || 0,
    /** 完整战场（legacy 字段见 docs/pantao-protocol-catalog.md §5） */
    bf: null,
    /** tileDataMap.tileData 的合并结果 */
    tileData: {},
    lastCmd: "",
    frameCount: 0,
    updatedAt: 0,
    /** 最近一次非 0 错误码 */
    lastError: null,
  };
}

/**
 * 合并一帧。
 * @param {object} state createPantaoState()
 * @param {object} raw   已解码的 body（或 packet.rawData）
 * @param {object} opts  { nowMs, cmd }
 * @returns {object} state
 */
export function applyPantaoFrame(state, raw, { nowMs = Date.now(), cmd = "" } = {}) {
  if (!isObj(state) || !isObj(raw)) return state;

  const body = isObj(raw.body) && !isObj(raw.bf) && !isObj(raw.tileDataMap) ? raw.body : raw;

  if (cmd) state.lastCmd = cmd;
  if (raw.cmd && !cmd) state.lastCmd = raw.cmd;
  if (raw.code && Number(raw.code) !== 0) {
    state.lastError = { cmd: state.lastCmd || raw.cmd || "", code: Number(raw.code), error: raw.error || "" };
  }

  if (body.bfId) state.bfId = body.bfId;
  if (body.roleId !== undefined && body.roleId !== null) state.myRoleId = Number(body.roleId) || state.myRoleId;

  if (isObj(body.bf)) {
    if (!isObj(state.bf)) state.bf = {};
    mergeInto(state.bf, body.bf);
    // 首帧可能没带 id（增量帧），用 bfId 补
    if (!state.bf.id && state.bfId) state.bf.id = state.bfId;
  }

  const td = isObj(body.tileDataMap) ? body.tileDataMap.tileData : null;
  if (isObj(td)) mergeInto(state.tileData, td);

  state.frameCount++;
  state.updatedAt = nowMs;
  return state;
}

/** 我自己的角色对象（含 state / power / legionId …） */
export function getMyRole(state) {
  const bf = state?.bf;
  if (!isObj(bf) || !isObj(bf.roles)) return null;
  const r = bf.roles[String(state.myRoleId)];
  return isObj(r) ? r : null;
}

/** 我当前所在的船（carId），不在船上返回 0 */
export function getMyCarId(state) {
  const bf = state?.bf;
  if (!isObj(bf) || !isObj(bf.carMap)) return 0;
  for (const car of Object.values(bf.carMap)) {
    if (!isObj(car) || !isObj(car.memberMap)) continue;
    if (car.memberMap[String(state.myRoleId)] !== undefined) return Number(car.id) || 0;
  }
  return 0;
}

/** 我在地图上的坐标（优先 tileData.memberMap，回落军团老家） */
export function getMyPosition(state) {
  const me = String(state?.myRoleId);
  const td = state?.tileData;
  if (isObj(td)) {
    for (const [tile, t] of Object.entries(td)) {
      if (isObj(t) && isObj(t.memberMap) && t.memberMap[me] !== undefined) {
        const [x, y] = tile.split("_").map((v) => Number(v));
        return { x, y, tile };
      }
    }
  }
  const role = getMyRole(state);
  const lid = Number(role?.legionId || state?.bf?.refLegionId || 0);
  const home = isObj(state?.bf?.legions) ? state.bf.legions[String(lid)] : null;
  if (isObj(home) && isObj(home.position)) {
    return { x: Number(home.position.x), y: Number(home.position.y), tile: `${home.position.x}_${home.position.y}` };
  }
  return null;
}

/** 我是否正在行军（从 tileData.marches 里找自己的 march） */
export function getMyMarch(state) {
  const me = Number(state?.myRoleId);
  const td = state?.tileData;
  if (!me || !isObj(td)) return null;
  for (const t of Object.values(td)) {
    if (!isObj(t) || !isObj(t.marches)) continue;
    for (const m of Object.values(t.marches)) {
      if (isObj(m) && Number(m.codeId) === me) return m;
    }
  }
  return null;
}

/** 给 UI/日志用的战场摘要 */
export function summarizePantao(state) {
  const bf = state?.bf;
  const role = getMyRole(state);
  const carId = getMyCarId(state);
  const pos = getMyPosition(state);
  const march = getMyMarch(state);
  const cars = isObj(bf?.carMap) ? Object.values(bf.carMap).filter(isObj) : [];
  const active = cars.filter((c) => String(c.state || "") !== "end");
  const nextCar = Array.isArray(bf?.nextCarTimes) ? Number(bf.nextCarTimes[0] || 0) : 0;
  return {
    bfId: state?.bfId || "",
    phase: isObj(bf) ? String(bf.state || "") : "",
    myRoleId: state?.myRoleId || 0,
    myName: role?.name || "",
    myPower: Number(role?.power || 0),
    myState: String(role?.state || ""),
    lordWeaponId: Number(role?.lordWeaponId || 0),
    petUId: role?.petUId ?? "",
    position: pos,
    carId,
    marching: !!march,
    marchEndAt: Number(march?.endTime || 0),
    carTotal: cars.length,
    carActive: active.length,
    nextCarAt: nextCar,
    reviveAt: Number(bf?.nextResurrectTime || 0),
    frameCount: state?.frameCount || 0,
  };
}

export default {
  createPantaoState,
  applyPantaoFrame,
  mergeInto,
  getMyRole,
  getMyCarId,
  getMyPosition,
  getMyMarch,
  summarizePantao,
};
