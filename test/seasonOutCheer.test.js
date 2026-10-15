/**
 * 盐场「赛季淘汰赛助威」纯逻辑回归测试
 *
 * 锚点数据全部来自真实抓包 `local-data/tiangong_vote/vote.jsonl`
 * （2026-10-15，9736服法王，SEND 帧逐字节精确复现、0 失败）：
 *   - SyncResp 助威成功回包：statistics["sr:out:cheer:261003"] = 942724
 *   - GetSeasonOutRankResp：round=2、61 家俱乐部（sOWinCnt 分布 2胜×16 / 1胜×32 / 0胜×12 / 缺省×1）
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SEASON_OUT_CHEER_STAT_PREFIX,
  describeSeasonOutCheerResult,
  isBenignCheerError,
  isInactiveCheerError,
  isSeasonOutRankActive,
  readCheeredLegionId,
  selectTopSeasonOutLegions,
} from "../src/utils/seasonOutCheer.js";

/** 抓包实录：saltroad_outcheer 成功后的 SyncResp body */
const REAL_CHEER_SYNC_RESP = {
  role: {
    statistics: {
      "sr:out:cheer:261003": 942724,
    },
  },
};

/** 抓包实录：SaltRoad_GetSeasonOutRankResp.body.legionList 前 6 家 + 942724 */
const REAL_LEGION_LIST = [
  { id: 378071, name: "百战⸸成诗", serverId: 4701, power: 583983669394, redQuench: 2414, rank: 1, score: 315.07698021913, sRTotalScore: 315, sOWinCnt: 2, sOLoseCnt: 0, sOKillCnt: 509, sODeadCnt: 264, sOSumScore: 6 },
  { id: 2029011, name: "✨归墟", serverId: 18001, power: 628390938680, redQuench: 2325, rank: 2, score: 500.02351029813, sRTotalScore: 500, sOWinCnt: 2, sOLoseCnt: 0, sOKillCnt: 492, sODeadCnt: 357, sOSumScore: 6 },
  { id: 2286020, name: "元神²ʷ¹", serverId: 20001, power: 634146240044, redQuench: 2367, rank: 3, score: 470.02756030513, sRTotalScore: 470, sOWinCnt: 2, sOLoseCnt: 0, sOKillCnt: 458, sODeadCnt: 261, sOSumScore: 6 },
  { id: 4499488, name: "沧澜⁣⁡​⁢", serverId: 26001, power: 578272700271, redQuench: 2216, rank: 4, score: 330.07990016413, sRTotalScore: 330, sOWinCnt: 2, sOLoseCnt: 0, sOKillCnt: 448, sODeadCnt: 321, sOSumScore: 5 },
  { id: 1956608, name: "龙 心", serverId: 17308, power: 553630009462, redQuench: 2042, rank: 5, score: 420.02367021113, sRTotalScore: 420, sOWinCnt: 2, sOLoseCnt: 0, sOKillCnt: 445, sODeadCnt: 419, sOSumScore: 4 },
  { id: 141973, name: "数字天团²⁵", serverId: 2542, power: 543584834450, redQuench: 2183, rank: 6, score: 450.02207028113, sRTotalScore: 450, sOWinCnt: 2, sOLoseCnt: 0, sOKillCnt: 435, sODeadCnt: 421, sOSumScore: 5 },
  // 1 胜俱乐部（抓包中位于第 23 位）：用于验证「高胜场排前、原序稳定」
  { id: 942724, name: "¹ｗ¹礼之用", serverId: 10001, power: 610369605492, redQuench: 2354, rank: 23, score: 415.08026026613, sRTotalScore: 415, sOWinCnt: 1, sOLoseCnt: 1, sOKillCnt: 478, sODeadCnt: 297, sOSumScore: 3 },
];

test("统计键前缀与抓包一致（sr:out:cheer:）", () => {
  assert.equal(SEASON_OUT_CHEER_STAT_PREFIX, "sr:out:cheer:");
});

test("readCheeredLegionId 读出抓包实录的助威记录", () => {
  assert.equal(readCheeredLegionId(REAL_CHEER_SYNC_RESP.role.statistics), 942724);
  // 键名带日期后缀（每届锚定首轮日期），只认前缀
  assert.equal(readCheeredLegionId({ "sr:out:cheer:261003": 378071 }), 378071);
  assert.equal(readCheeredLegionId({ "pk:appoint:room:id": 356800001 }), null);
  assert.equal(readCheeredLegionId({}), null);
  assert.equal(readCheeredLegionId(null), null);
});

test("describeSeasonOutCheerResult 判定本次投票成功", () => {
  const result = describeSeasonOutCheerResult(REAL_CHEER_SYNC_RESP, 942724);
  assert.deepEqual(result, {
    ok: true,
    state: "voted",
    cheeredLegionId: 942724,
  });
});

test("describeSeasonOutCheerResult 识别已助威其他俱乐部", () => {
  const result = describeSeasonOutCheerResult(REAL_CHEER_SYNC_RESP, 378071);
  assert.equal(result.ok, true);
  assert.equal(result.state, "already-other");
  assert.equal(result.cheeredLegionId, 942724);
});

test("describeSeasonOutCheerResult 响应缺助威记录时判 unknown", () => {
  const result = describeSeasonOutCheerResult({ role: { statistics: {} } }, 942724);
  assert.equal(result.ok, false);
  assert.equal(result.state, "unknown");
});

test("selectTopSeasonOutLegions 按 sOWinCnt 降序且同胜场保持原序（对齐游戏 getBetList）", () => {
  const top = selectTopSeasonOutLegions(REAL_LEGION_LIST);
  // 6 家 2 胜俱乐部按原序在前，1 胜的 942724 排最后
  assert.deepEqual(
    top.map((legion) => legion.id),
    [378071, 2029011, 2286020, 4499488, 1956608, 141973, 942724],
  );
});

test("selectTopSeasonOutLegions 默认截断 64 家", () => {
  const many = Array.from({ length: 80 }, (_, index) => ({
    id: index + 1,
    sOWinCnt: 1,
  }));
  const top = selectTopSeasonOutLegions(many);
  assert.equal(top.length, 64);
  assert.equal(top[0].id, 1);
  assert.equal(top[63].id, 64);
});

test("selectTopSeasonOutLegions 缺省 sOWinCnt 按 0 计且不改入参", () => {
  const input = [
    { id: 1, sOWinCnt: 0 },
    { id: 2 },
    { id: 3, sOWinCnt: 2 },
  ];
  const top = selectTopSeasonOutLegions(input);
  assert.deepEqual(
    top.map((legion) => legion.id),
    [3, 1, 2],
  );
  assert.equal(input[0].id, 1); // 原数组未被排序改写
  assert.deepEqual(selectTopSeasonOutLegions(null), []);
  assert.deepEqual(selectTopSeasonOutLegions("nope"), []);
});

test("isSeasonOutRankActive 以非空 legionList 为准", () => {
  assert.equal(isSeasonOutRankActive({ round: 2, legionList: REAL_LEGION_LIST }), true);
  assert.equal(isSeasonOutRankActive({ round: 2, legionList: [] }), false);
  assert.equal(isSeasonOutRankActive({ round: 2 }), false);
  assert.equal(isSeasonOutRankActive(null), false);
});

test("错误文案分类：已助威/未开放不算失败", () => {
  assert.equal(isBenignCheerError({ error: "本届已助威过，无法重复助威" }), true);
  // 「已参与」同语义（助力/投票都算参与过），不是失败
  assert.equal(isBenignCheerError({ code: 12200100, error: "本次活动已参与助力" }), true);
  assert.equal(isBenignCheerError({ error: "金砖不足" }), false);
  assert.equal(isInactiveCheerError({ error: "活动未开启" }), true);
  assert.equal(isInactiveCheerError({ error: "淘汰赛已结束" }), true);
  assert.equal(isInactiveCheerError(new Error("请求超时: saltroad_outcheer (5000ms)")), false);
  assert.equal(isBenignCheerError(null), false);
});
