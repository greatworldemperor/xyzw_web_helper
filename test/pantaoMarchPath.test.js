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

test("buildMarchPath：BFS 最短路含起点与终点（4 直达）", () => {
  const state = makeState({ myPos: { x: 20, y: 21 }, carId: 1, carPos: { x: 20, y: 15 } });
  const path = buildMarchPath(state, 1);
  assert.equal(path[0].x, 20);
  assert.equal(path[0].y, 21);
  assert.deepEqual(path[path.length - 1], { x: 20, y: 15 });
  // 无重复、步数 = 曼哈顿距离 + 1
  assert.equal(path.length, Math.abs(20 - 20) + Math.abs(21 - 15) + 1);
  const keys = new Set(path.map((p) => `${p.x}_${p.y}`));
  assert.equal(keys.size, path.length);
});

test("buildMarchPath：斜向目标（官方 09-13 路径形态 20_21→21_16）", () => {
  const state = makeState({ myPos: { x: 20, y: 21 }, carId: 1, carPos: { x: 21, y: 16 } });
  const path = buildMarchPath(state, 1);
  assert.equal(path.length, 1 + 5 + 1); // |dx|+|dy|+1
  assert.deepEqual(path[0], { x: 20, y: 21 });
  assert.deepEqual(path[path.length - 1], { x: 21, y: 16 });
});

test("buildMarchPath：与官方实抓路径同起终（20_21 → 20_15）", () => {
  // 官方 20:00:18 seq=11：path[0]=(20,21) path[last]=(20,15)，长度 8 = 曼哈顿 6 + ... 官方有绕行
  // 我们的最短路长度 ≤ 官方长度（官方绕行可能避障），但起终点必须一致
  const state = makeState({ myPos: { x: 20, y: 21 }, carId: 1, carPos: { x: 20, y: 15 } });
  const path = buildMarchPath(state, 1);
  assert.equal(path[0].x, 20);
  assert.equal(path[0].y, 21);
  assert.deepEqual(path[path.length - 1], { x: 20, y: 15 });
  assert.ok(path.length <= 8, `BFS 最短路应不长于官方 8 格（实际 ${path.length}）`);
});

test("buildMarchPath：同一格（已在船上位置）返回单元素", () => {
  const state = makeState({ myPos: { x: 20, y: 15 }, carId: 1, carPos: { x: 20, y: 15 } });
  assert.deepEqual(buildMarchPath(state, 1), [{ x: 20, y: 15 }]);
});

test("buildMarchPath：拿不到位置返回 null（不阻塞发送）", () => {
  const state = createPantaoState({ bfId: "x", myRoleId: 1 }); // 无 tileData 无 carMap
  assert.equal(buildMarchPath(state, 1), null);
});
