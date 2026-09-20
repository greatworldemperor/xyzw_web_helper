/**
 * pantaoState 回归测试
 * 数据结构照抄 2026-09-13 / 09-20 实战抓包（batch5 / wssa5 / runtime）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyPantaoFrame,
  createPantaoState,
  getMyCarId,
  getMyMarch,
  getMyPosition,
  getMyRole,
  mergeInto,
  summarizePantao,
} from "../src/utils/pantaoState.js";

const MY = 292742316;
const MY_LEGION = 7199227;

/** 首帧全量（精简版，字段结构真实） */
const FULL = {
  bf: {
    id: "260913:13175",
    state: "ready",
    mapId: 1,
    refLegionId: MY_LEGION,
    legions: {
      [MY_LEGION]: { id: MY_LEGION, name: "第一批", position: { x: 22, y: 10 } },
      1183999: { id: 1183999, name: "对手", position: { x: 20, y: 21 } },
    },
    roles: {
      [MY]: { roleId: MY, name: "momo1", power: 833637592, legionId: MY_LEGION, state: "watching" },
      138980611: { roleId: 138980611, name: "敌人甲", power: 12040000000, legionId: 1183999, state: "idle" },
    },
    carMap: {
      15: { id: 15, position: { x: 13, y: 19 }, pathId: 2, progress: 0, state: "moving", score: -100000, belongLegionId: 0, memberMap: {} },
      16: { id: 16, position: { x: 28, y: 13 }, pathId: 3, progress: 0, state: "moving", score: 0, belongLegionId: 0, memberMap: {} },
    },
    nextCarTimes: [1789302110],
    nextResurrectTime: 1789302120000,
  },
  roleId: MY,
  bfId: "260913:13175",
  tileDataMap: { tileData: { "22_10": { id: "22_10", memberMap: {}, belongsLegionId: MY_LEGION } } },
};

function fresh() {
  return createPantaoState();
}

test("mergeInto：null 表示删除该键（服务端用 null 移除成员/战斗/行军）", () => {
  const t = { a: 1, b: { c: 2, d: 3 } };
  mergeInto(t, { b: { c: null, e: 4 }, f: 5 });
  assert.deepEqual(t, { a: 1, b: { d: 3, e: 4 }, f: 5 });
});

test("applyPantaoFrame：首帧全量 → bfId / myRoleId / bf / tileData 都就位", () => {
  const s = applyPantaoFrame(fresh(), FULL, { cmd: "Payload_EnterBfResp" });
  assert.equal(s.bfId, "260913:13175");
  assert.equal(s.myRoleId, MY);
  assert.equal(s.bf.state, "ready");
  assert.equal(s.bf.id, "260913:13175");
  assert.equal(Object.keys(s.tileData).length, 1);
  assert.equal(s.lastCmd, "Payload_EnterBfResp");
  assert.equal(s.frameCount, 1);
});

test("applyPantaoFrame：增量帧（state / role.state / car.progress）叠加", () => {
  const s = applyPantaoFrame(fresh(), FULL);
  applyPantaoFrame(s, { bf: { state: "started" }, bfId: FULL.bfId }, { cmd: "Payload_StateChangeNotify" });
  applyPantaoFrame(s, { bf: { roles: { [MY]: { state: "march" } } }, bfId: FULL.bfId }, { cmd: "Payload_StartMarchResp" });
  applyPantaoFrame(s, { bf: { carMap: { 15: { progress: 3, beginTime: 100 } } }, bfId: FULL.bfId }, { cmd: "Payload_SyncCarNotify" });

  assert.equal(s.bf.state, "started", "增量覆盖 state");
  assert.equal(s.bf.roles[String(MY)].state, "march");
  assert.equal(s.bf.roles[String(MY)].power, 833637592, "未下发的字段保持原值");
  assert.equal(s.bf.carMap["15"].progress, 3);
  assert.equal(s.bf.carMap["15"].position.x, 13, "增量未带的字段不能丢");
  assert.equal(s.bf.carMap["16"].progress, 0, "另一条船不受影响");
  assert.equal(s.frameCount, 4);
});

test("applyPantaoFrame：memberMap 置 null = 离船（getMyCarId 归零）", () => {
  const s = applyPantaoFrame(fresh(), FULL);
  applyPantaoFrame(s, { bf: { carMap: { 15: { memberMap: { [MY]: 1 } } } }, bfId: FULL.bfId });
  assert.equal(getMyCarId(s), 15, "先上船");

  applyPantaoFrame(
    s,
    { bfId: FULL.bfId, tileDataMap: { tileData: { "13_19": { memberMap: { [MY]: null } } } } },
    { cmd: "Payload_EndMarchNotify" },
  );
  // 船上的成员表也要能被 null 清掉
  applyPantaoFrame(s, { bf: { carMap: { 15: { memberMap: { [MY]: null } } } }, bfId: FULL.bfId });
  assert.equal(getMyCarId(s), 0, "memberMap 置 null 后判定为不在船上");
});

test("applyPantaoFrame：battleMap 置 null = 战斗结束被移除", () => {
  const s = applyPantaoFrame(fresh(), FULL);
  applyPantaoFrame(s, { bf: { battleMap: { 87: { id: 87, leftId: 1, rightId: 2 } } }, bfId: FULL.bfId });
  assert.ok(s.bf.battleMap["87"]);
  applyPantaoFrame(s, { bf: { battleMap: { 87: null } }, bfId: FULL.bfId }, { cmd: "Payload_EndBattleNotify" });
  assert.equal(s.bf.battleMap["87"], undefined);
});

test("getMyMarch：从 tileData.marches 里认领自己的行军", () => {
  const s = applyPantaoFrame(fresh(), FULL);
  assert.equal(getMyMarch(s), null, "没行军时为 null");

  applyPantaoFrame(s, {
    bfId: FULL.bfId,
    tileDataMap: {
      tileData: {
        "22_10": {
          marches: {
            214: { id: 214, codeId: MY, legionId: MY_LEGION, from: { x: 22, y: 10 }, to: { x: 22, y: 11 }, startTime: 1, endTime: 2001, carId: 15, path: [] },
          },
        },
      },
    },
  });
  const m = getMyMarch(s);
  assert.equal(m.id, 214);
  assert.equal(m.carId, 15);

  applyPantaoFrame(s, { bfId: FULL.bfId, tileDataMap: { tileData: { "22_10": { marches: { 214: null } } } } });
  assert.equal(getMyMarch(s), null, "marches[id]=null 表示行军结束");
});

test("getMyPosition：memberMap 命中优先，落空回落军团老家", () => {
  const s = applyPantaoFrame(fresh(), FULL);
  const home = getMyPosition(s);
  assert.deepEqual({ x: home.x, y: home.y }, { x: 22, y: 10 }, "watching → 老家");

  applyPantaoFrame(s, { bfId: FULL.bfId, tileDataMap: { tileData: { "13_19": { memberMap: { [MY]: 1789302106801 } } } } });
  const onMap = getMyPosition(s);
  assert.deepEqual({ x: onMap.x, y: onMap.y }, { x: 13, y: 19 });
});

test("getMyRole / summarizePantao：给 UI 的摘要字段", () => {
  const s = applyPantaoFrame(fresh(), FULL);
  assert.equal(getMyRole(s).name, "momo1");

  applyPantaoFrame(s, { bf: { state: "started", roles: { [MY]: { state: "idle" } } }, bfId: FULL.bfId });
  applyPantaoFrame(s, { bf: { carMap: { 15: { memberMap: { [MY]: 1 } } } }, bfId: FULL.bfId });

  const sum = summarizePantao(s);
  assert.equal(sum.phase, "started");
  assert.equal(sum.myState, "idle");
  assert.equal(sum.carId, 15);
  assert.equal(sum.carTotal, 2);
  assert.equal(sum.carActive, 2);
  assert.equal(sum.nextCarAt, 1789302110);
  assert.equal(sum.reviveAt, 1789302120000);
  assert.equal(sum.myPower, 833637592);
  assert.equal(sum.marching, false);
});

test("applyPantaoFrame：非法输入不抛错", () => {
  const s = fresh();
  assert.equal(applyPantaoFrame(s, null), s);
  assert.equal(applyPantaoFrame(s, undefined), s);
  assert.equal(s.frameCount, 0);
});
