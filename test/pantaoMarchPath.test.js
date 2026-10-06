// 蟠桃行军寻路 + startmarch 请求体组装回归
// 基准：官方实抓（captures_keep/pantao_261004/wss_pantao_start，20:00:18 seq=11）
// 官方真实路径：deploy 在 20_21 → 行军去 carId=1：path[0]=(20,21) 逐格 → 末格=(20,15)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyPantaoFrame,
  buildMarchPath,
  createPantaoState,
  getCarPosition,
  getMyPosition,
} from "../src/utils/pantaoState.js";
import { WALK_GRAPH } from "../src/utils/pantaoWalkGraph.js";

function makeState({ myPos, carId, carPos, myRoleId = 130301444 }) {
  const state = createPantaoState({ bfId: "261004:12982", myRoleId });
  // 部署到 myPos（EnterBfResp/SetBattleTeamResp 的 tileData 形态）
  applyPantaoFrame(state, {
    tileDataMap: {
      tileData: {
        [`${myPos.x}_${myPos.y}`]: { memberMap: { [String(myRoleId)]: 1791115220000 } },
      },
    },
  });
  applyPantaoFrame(state, {
    bf: { carMap: { [String(carId)]: { id: carId, position: { x: carPos.x, y: carPos.y } } } },
  });
  return state;
}

test("getMyPosition 从 tileData.memberMap 取坐标", () => {
  const state = makeState({ myPos: { x: 20, y: 21 }, carId: 1, carPos: { x: 20, y: 15 } });
  assert.deepEqual(getMyPosition(state), { x: 20, y: 21, tile: "20_21" });
});

test("getCarPosition 从 bf.carMap.position 取坐标", () => {
  const state = makeState({ myPos: { x: 20, y: 21 }, carId: 1, carPos: { x: 20, y: 15 } });
  assert.deepEqual(getCarPosition(state, 1), { x: 20, y: 15 });
  assert.equal(getCarPosition(state, 999), null);
});

test("buildMarchPath：官方通行图路由（20_21 → 20_15 = 官方 carId1 路径，8 格）", () => {
  const state = makeState({ myPos: { x: 20, y: 21 }, carId: 1, carPos: { x: 20, y: 15 } });
  const path = buildMarchPath(state, 1);
  assert.equal(path.length, 8, "官方图最短路 = 官方实抓长度 8");
  assert.deepEqual(path[0], { x: 20, y: 21 });
  assert.deepEqual(path[path.length - 1], { x: 20, y: 15 });
  const keys = new Set(path.map((p) => `${p.x}_${p.y}`));
  assert.equal(keys.size, path.length, "无重复");
});

test("buildMarchPath：兜底 8 邻域（目标不在通行图内）+ 警告", () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    // 5_5 不在官方通行图（图覆盖 261004 战场的行船走廊）
    const state = makeState({ myPos: { x: 20, y: 21 }, carId: 1, carPos: { x: 5, y: 5 } });
    const path = buildMarchPath(state, 1);
    assert.deepEqual(path[0], { x: 20, y: 21 });
    assert.deepEqual(path[path.length - 1], { x: 5, y: 5 });
    // 8 邻域最短 = chebyshev + 1 = 16 + 1
    assert.equal(path.length, Math.max(15, 16) + 1);
    assert.ok(warnings.some((w) => w.includes("回退全图可走 BFS")), "应有回退警告");
  } finally {
    console.warn = origWarn;
  }
});

// ── 金测：官方 15 条 startmarch（261004:12982 实战）逐一复刻 ──
const OFFICIAL_MARCHES = [
  { carId: 1, start: "20_21", end: "20_15", len: 8 },
  { carId: 2, start: "27_11", end: "13_18", len: 19 },
  { carId: 3, start: "12_23", end: "13_11", len: 16 },
  { carId: 4, start: "7_15", end: "15_16", len: 14 },
  { carId: 5, start: "12_23", end: "27_15", len: 19 },
  { carId: 7, start: "30_7", end: "13_19", len: 25 },
  { carId: 6, start: "12_20", end: "23_6", len: 23 },
  { carId: 8, start: "30_7", end: "13_18", len: 25 },
  { carId: 9, start: "12_23", end: "27_16", len: 19 },
  { carId: 11, start: "27_8", end: "15_17", len: 20 },
  { carId: 10, start: "12_21", end: "20_7", len: 21 },
  { carId: 12, start: "25_6", end: "22_16", len: 16 },
  { carId: 14, start: "28_22", end: "15_12", len: 17 },
  { carId: 15, start: "15_8", end: "23_16", len: 14 },
  { carId: 16, start: "28_19", end: "14_18", len: 15 },
];

test("buildMarchPath：官方 15 条路径金测——图上寻路长度逐一复刻", () => {
  for (const m of OFFICIAL_MARCHES) {
    const [sx, sy] = m.start.split("_").map(Number);
    const [ex, ey] = m.end.split("_").map(Number);
    const state = makeState({ myPos: { x: sx, y: sy }, carId: m.carId, carPos: { x: ex, y: ey } });
    const path = buildMarchPath(state, m.carId);
    assert.equal(path.length, m.len, `carId ${m.carId} ${m.start}→${m.end}：图上最短 = 官方 ${m.len} 格`);
    assert.deepEqual(path[0], { x: sx, y: sy });
    assert.deepEqual(path[path.length - 1], { x: ex, y: ey });
  }
});

test("buildMarchPath：官方图金测——相邻步均为图上的合法边（8 邻域 + 无穿越）", () => {
  const edges = WALK_GRAPH.edges;
  for (const m of OFFICIAL_MARCHES) {
    const [sx, sy] = m.start.split("_").map(Number);
    const [ex, ey] = m.end.split("_").map(Number);
    const state = makeState({ myPos: { x: sx, y: sy }, carId: m.carId, carPos: { x: ex, y: ey } });
    const path = buildMarchPath(state, m.carId);
    for (let i = 1; i < path.length; i++) {
      const a = `${path[i - 1].x}_${path[i - 1].y}`;
      const b = `${path[i].x}_${path[i].y}`;
      assert.ok((edges[a] || []).includes(b), `carId ${m.carId}：步 ${a}→${b} 必须是官方图上的合法边`);
    }
  }
});

test("buildMarchPath：同一格（已在船上位置）返回单元素", () => {
  const state = makeState({ myPos: { x: 20, y: 15 }, carId: 1, carPos: { x: 20, y: 15 } });
  assert.deepEqual(buildMarchPath(state, 1), [{ x: 20, y: 15 }]);
});

test("buildMarchPath：拿不到位置返回 null（不阻塞发送）", () => {
  const state = createPantaoState({ bfId: "x", myRoleId: 1 }); // 无 tileData 无 carMap
  assert.equal(buildMarchPath(state, 1), null);
});
