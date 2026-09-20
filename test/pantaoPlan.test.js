/**
 * pantaoPlan 回归测试
 * 字段结构全部照抄 2026-09-20 实战抓包（wssa5 / Payload_EnterBfResp）。
 * ⚠️ 真实快照里全部 13 条船都是 state:"end"（已抵达），行进中的 state 取值尚未抓到，
 *    测试中按 "moving" 假设；抓到后只需改这里，判定逻辑（!= "end"）不变。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION,
  CAR_STRATEGY,
  DEFAULT_ATTACK_RATIO,
  batchIntervalMs,
  describeCarScore,
  getCarStepsLeft,
  getEnemiesOnCar,
  getRolePosition,
  isDeployed,
  isDead,
  isMarching,
  listActiveCars,
  listCars,
  manhattan,
  normalizeSnapshot,
  pickAttackTarget,
  pickTargetCar,
  planPollingBatches,
  planTurn,
  resolveMyLegionId,
  shouldAttack,
} from "../src/utils/pantaoPlan.js";

const MY_LEGION = 7199227;
const FOE_LEGION = 1183999;

const BF = {
  id: "260920:13059",
  state: "started",
  mapId: 1,
  refLegionId: MY_LEGION,
  legions: {
    [FOE_LEGION]: { id: FOE_LEGION, name: "盐场突飞猛进", position: { x: 20, y: 21 } },
    [MY_LEGION]: { id: MY_LEGION, name: "第一批", position: { x: 22, y: 10 } },
  },
  roles: {
    436746334: { roleId: 436746334, name: "momo271", power: 833637592, legionId: MY_LEGION, state: "watching", lordWeaponId: 3, petUId: "" },
    436747331: { roleId: 436747331, name: "momo261", power: 799386873, legionId: MY_LEGION, state: "march" },
    130264302: { roleId: 130264302, name: "窝不柿5精力", power: 11073042815, legionId: MY_LEGION, state: "die" },
    555000001: { roleId: 555000001, name: "上船无敌", power: 10000000000, legionId: MY_LEGION, state: "idle" },
    555000002: { roleId: 555000002, name: "上船碾压", power: 20000000000, legionId: MY_LEGION, state: "idle" },
    555000003: { roleId: 555000003, name: "上船打不过", power: 10000000000, legionId: MY_LEGION, state: "idle" },
    185903490: { roleId: 185903490, name: "情义乄先生", power: 12040000000, legionId: FOE_LEGION, state: "idle" },
    696075632: { roleId: 696075632, name: "4001毕业", power: 3000000, legionId: FOE_LEGION, state: "idle" },
  },
  carMap: {
    1: { id: 1, position: { x: 12, y: 23 }, pathId: 5, progress: 0, state: "end", score: -100000, scoreSpeed: -4, belongLegionId: FOE_LEGION, memberMap: {} },
    7: { id: 7, position: { x: 30, y: 7 }, pathId: 3, progress: 4, state: "moving", score: -56247, scoreSpeed: 0, belongLegionId: 0, memberMap: {} },
    8: { id: 8, position: { x: 25, y: 12 }, pathId: 3, progress: 2, state: "moving", score: 60007, scoreSpeed: 4, belongLegionId: MY_LEGION, memberMap: { 185903490: 1, 696075632: 1 } },
    12: { id: 12, position: { x: 16, y: 9 }, pathId: 2, progress: 1, state: "moving", score: 100000, scoreSpeed: 0, belongLegionId: MY_LEGION, memberMap: { 555000001: 1 } },
    13: { id: 13, position: { x: 22, y: 18 }, pathId: 2, progress: 1, state: "moving", score: -64327, scoreSpeed: -2, belongLegionId: FOE_LEGION, memberMap: {} },
    // 9 号船：只有强敌（用于「打不过」分支）；位置远、pathId 无总步数，避免影响选船类用例
    9: { id: 9, position: { x: 5, y: 30 }, pathId: 1, progress: 3, state: "moving", score: -90000, scoreSpeed: 1, belongLegionId: 0, memberMap: { 555000003: 1, 185903490: 1 } },
  },
  nextCarTimes: [1789906878],
  nextResurrectTime: 1789906860000,
};

const TILE_DATA = {
  "22_10": { id: "22_10", memberMap: {}, belongsLegionId: MY_LEGION },
  "24_17": { id: "24_17", memberMap: { 139073239: 1789906844647 }, belongsLegionId: 0 },
};

function snap(roleId, boardedCarId = 0) {
  return { snapshot: normalizeSnapshot({ bf: BF, roleId, bfId: BF.id, tileDataMap: { tileData: TILE_DATA } }), boardedCarId };
}

test("normalizeSnapshot 解析 body.bf / roleId / tileData", () => {
  const s = normalizeSnapshot({ bf: BF, roleId: 436746334, bfId: "260920:13059", tileDataMap: { tileData: TILE_DATA } });
  assert.equal(s.myRoleId, 436746334);
  assert.equal(s.bfId, "260920:13059");
  assert.equal(Object.keys(s.tileData).length, 2);
  assert.equal(normalizeSnapshot(null), null);
});

test("角色状态判定：watching 未登场，die/march 分别识别", () => {
  assert.equal(isDeployed(BF, 436746334), false, "watching 不算登场");
  assert.equal(isDeployed(BF, 436747331), true);
  assert.equal(isDead(BF, 130264302), true);
  assert.equal(isMarching(BF, 436747331), true);
  assert.equal(resolveMyLegionId(BF, 436746334), MY_LEGION);
});

test("listCars / listActiveCars 过滤已抵达的船", () => {
  assert.equal(listCars(BF).length, 6);
  const active = listActiveCars(BF);
  // 注意：JS 对整数型 key 按数值升序枚举 → [1,7,8,9,12,13]，剔除 state:"end" 的 1 号后为 [7,8,9,12,13]
  assert.deepEqual(active.map((c) => c.id), [7, 8, 9, 12, 13], "state=end 的 1 号船被排除");
});

test("getCarStepsLeft 用 totalStepsByPathId 推算，拿不到总步数时返回 null", () => {
  assert.equal(getCarStepsLeft(BF.carMap[7], { totalStepsByPathId: { 3: 10 } }), 6);
  assert.equal(getCarStepsLeft(BF.carMap[12], { totalStepsByPathId: { 2: 8 } }), 7);
  assert.equal(getCarStepsLeft(BF.carMap[7], {}), null);
});

test("getEnemiesOnCar 排除同军团，按战力升序", () => {
  const foes = getEnemiesOnCar(BF, BF.carMap[8], MY_LEGION);
  assert.deepEqual(foes.map((f) => f.roleId), [696075632, 185903490], "战力升序：300万在前、120亿在后");
  assert.equal(getEnemiesOnCar(BF, BF.carMap[12], MY_LEGION).length, 0, "自己人不上敌人列表");
});

test("shouldAttack：敌方战力低于我方 70% 才打（边界不含等号）", () => {
  assert.equal(shouldAttack(100, 69), true);
  assert.equal(shouldAttack(100, 70), false, "正好 70% 不打（严格小于）");
  assert.equal(shouldAttack(100, 71), false);
  assert.equal(shouldAttack(0, 10), false, "我方战力为 0 不打");
  assert.equal(shouldAttack(100, 0), false, "敌方战力为 0 不打");
});

test("pickAttackTarget 挑打得过的最弱目标", () => {
  const foes = getEnemiesOnCar(BF, BF.carMap[8], MY_LEGION); // 300万 / 120亿
  const rich = pickAttackTarget(foes, 20000000000); // 70% = 140亿，两个都打得过
  assert.equal(rich.roleId, 696075632, "都打得过时挑最弱的 300 万");
  const mid = pickAttackTarget(foes, 10000000000); // 70% = 70亿，只打得过 300 万
  assert.equal(mid.roleId, 696075632);
});

test("pickAttackTarget 能吃掉明显更弱的敌人", () => {
  const foes = [{ roleId: 1, power: 3000000 }];
  assert.equal(pickAttackTarget(foes, 10000000000).roleId, 1);
});

test("manhattan / getRolePosition 定位（不在 tileData 时回落到老家）", () => {
  assert.equal(manhattan({ x: 22, y: 10 }, { x: 25, y: 12 }), 5);
  const home = getRolePosition(snap(436746334).snapshot, 436746334);
  assert.deepEqual({ x: home.x, y: home.y }, { x: 22, y: 10 }, "momo271 未在任何地块 → 老家");
});

test("pickTargetCar 默认策略：在赶得上的船里挑剩余步数最少的", () => {
  const myPos = { x: 22, y: 10 };
  const pick = pickTargetCar({
    bf: BF,
    myPosition: myPos,
    totalStepsByPathId: { 2: 20, 3: 20 },
  });
  assert.equal(pick.car.id, 7, "7 号剩 16 步最少（8 号 18、12/13 各 19），且都赶得上");
  assert.equal(pick.reachable, true);
});

test("pickTargetCar 全部赶不上时退化为按剩余步数选，并标注赶不上", () => {
  const pick = pickTargetCar({
    bf: BF,
    myPosition: { x: 0, y: 0 },
    // 必须覆盖全部 pathId（含 9 号船的 pathId=1），否则缺总步数的船 stepsLeft=null 会被当成赶得上
    totalStepsByPathId: { 1: 5, 2: 3, 3: 3 },
  });
  assert.ok(pick.car);
  assert.equal(pick.reachable, false);
  assert.match(pick.reason, /赶不上/);
});

test("pickTargetCar 支持 nearest-me 与 contested 策略", () => {
  const myPos = { x: 22, y: 10 };
  const near = pickTargetCar({ bf: BF, myPosition: myPos, strategy: CAR_STRATEGY.NEAREST_ME });
  assert.equal(near.car.id, 8, "8 号船距 5 格最近（12 号 7 格、13 号 8 格、7 号 11 格）");
  const contested = pickTargetCar({ bf: BF, myPosition: myPos, strategy: CAR_STRATEGY.CONTESTED });
  assert.equal(contested.car.id, 7, "7 号船 |score|=56247 最胶着");
});

test("pickTargetCar 没有行进中的船时返回空", () => {
  const onlyEnded = { ...BF, carMap: { 1: BF.carMap[1] } };
  const pick = pickTargetCar({ bf: onlyEnded, myPosition: { x: 22, y: 10 } });
  assert.equal(pick.car, null);
  assert.match(pick.reason, /没有行进中的船/);
});

test("planTurn：watching → 布阵登场", () => {
  const { snapshot } = snap(436746334);
  const r = planTurn(snapshot, { roleId: 436746334 });
  assert.equal(r.action, ACTION.DEPLOY);
});

test("planTurn：die → 等复活（带复活时间）", () => {
  const { snapshot } = snap(130264302);
  const r = planTurn(snapshot, { roleId: 130264302 });
  assert.equal(r.action, ACTION.WAIT_REVIVE);
  assert.equal(r.reviveAt, 1789906860000);
});

test("planTurn：march → 继续等行军结束", () => {
  const { snapshot } = snap(436747331);
  const r = planTurn(snapshot, { roleId: 436747331 });
  assert.equal(r.action, ACTION.WAIT_MARCH);
});

test("planTurn：已登场未在船上 → 向目标船行军", () => {
  const { snapshot } = snap(555000002);
  const r = planTurn(snapshot, { roleId: 555000002, totalStepsByPathId: { 2: 20, 3: 20 } });
  assert.equal(r.action, ACTION.MARCH);
  assert.ok(r.car && r.car.id > 0);
});

test("planTurn：已上船且敌方都打不过 → 本轮完成（上船即完成）", () => {
  const { snapshot } = snap(555000003);
  const r = planTurn(snapshot, { roleId: 555000003, boardedCarId: 9 });
  assert.equal(r.action, ACTION.DONE, "100亿 vs 120亿：70% = 70亿 < 120亿，打不过");
  assert.match(r.reason, /已上船9/);
  assert.match(r.reason, /都打不过/);
});

test("planTurn：已上船且敌人够弱 → 攻击", () => {
  const { snapshot } = snap(555000002);
  const r = planTurn(snapshot, { roleId: 555000002, boardedCarId: 8 });
  assert.equal(r.action, ACTION.ATTACK);
  assert.equal(r.target.roleId, 696075632, "先挑最弱的 300 万");
});

test("planTurn：已上船、船上无敌 → 直接完成", () => {
  const { snapshot } = snap(555000001);
  const r = planTurn(snapshot, { roleId: 555000001 });
  assert.equal(r.action, ACTION.DONE);
  assert.match(r.reason, /无敌/);
});

test("planTurn：没有可用船 → 等刷新", () => {
  const onlyEnded = { ...BF, carMap: { 1: BF.carMap[1] } };
  const snapshot = normalizeSnapshot({ bf: onlyEnded, roleId: 555000002, bfId: "x", tileDataMap: { tileData: {} } });
  const r = planTurn(snapshot, { roleId: 555000002 });
  assert.equal(r.action, ACTION.WAIT_CAR);
  assert.equal(r.nextCarAt, 1789906878);
});

test("planTurn：没有快照 → 先进场", () => {
  assert.equal(planTurn(null, {}).action, ACTION.ENTER);
  const snapshot = normalizeSnapshot({ bf: BF, roleId: 999, bfId: "x", tileDataMap: {} });
  assert.equal(planTurn(snapshot, { roleId: 999 }).action, ACTION.ENTER, "角色不在战场里");
});

test("describeCarScore 归属与胶着判定", () => {
  const mine = describeCarScore(BF.carMap[12], MY_LEGION);
  assert.equal(mine.mine, true);
  assert.equal(mine.contested, false);
  const mid = describeCarScore(BF.carMap[13], MY_LEGION);
  assert.equal(mid.mine, false);
  assert.equal(mid.contested, false, "|-64327| > 30000 不算胶着");
  const c7 = describeCarScore(BF.carMap[7], MY_LEGION);
  assert.equal(c7.mine, false, "belongLegionId=0 不属于任何一方");
});

test("planPollingBatches 按并发数分批，余数单独一批", () => {
  assert.deepEqual(planPollingBatches([1, 2, 3, 4, 5], 1), [[1], [2], [3], [4], [5]]);
  assert.deepEqual(planPollingBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(planPollingBatches([], 3), []);
  assert.deepEqual(planPollingBatches([1], 0), [[1]], "并发数非法时兜底为 1");
});

test("batchIntervalMs 并发越大间隔越长，用于规避 IP 限流", () => {
  assert.equal(batchIntervalMs({ concurrency: 1, minIntervalMs: 1200 }), 1200);
  assert.ok(batchIntervalMs({ concurrency: 4, minIntervalMs: 1200 }) > 1200);
});

test("默认攻击比例是 70%", () => {
  assert.equal(DEFAULT_ATTACK_RATIO, 0.7);
});
