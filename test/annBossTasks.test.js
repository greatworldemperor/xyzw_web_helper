/**
 * 周年庆「一次性奖励 + 每日签到助力 + 闯关打BOSS」批量任务回归测试
 *
 * 证据：local-data/anniversary/ann_daily_boss_full.jsonl（2026-10-17 抓包，158 帧全解码）
 *   - 请求体：common_claimtotalreward {2610167, 261016701}；
 *     celebrate_sign {}；celebrate_claimfullserver {idList:[1]}/{idList:[2]}；
 *     linkcard_readcard {cardId:90111, readNum:1}；celebrate_claimpersonal {idList:[1]}；
 *     towers_getinfo/start/fight {actId: 2610163, towerType: 2}
 *   - 闯关响应：8 次 fight 全 isWin=true、accept.ext.curHP=0，第 8 次 pass=true 通关
 *   - 逐字段复现：_verify_reencode.mjs 11/11 一致（见 local-data/anniversary/）
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANN_BOSS_ACT_ID,
  ANN_BOSS_MAX_FIGHTS,
  ANN_BOSS_TYPES,
  ANN_CELEBRATE_FULLSERVER_IDS,
  ANN_CELEBRATE_PERSONAL_IDS,
  ANN_LINKCARD_CARD_ID,
  ANN_LINKCARD_READ_NUM,
  ANN_ONETIME_ACT_ID,
  ANN_ONETIME_CONFIG_ID,
  createTasksAnnBoss,
  getTodayOpenBossTypes,
  isAlreadyDoneError,
  isFightWin,
  isInactiveError,
  isNotCompletedError,
  isRateLimitError,
  normalizeTowerInfo,
  pickBossTargets,
} from "../src/utils/batch/tasksAnnBoss.js";

test("周年庆一次性奖励：actId / configId 与抓包一致", () => {
  assert.equal(ANN_ONETIME_ACT_ID, 2610167);
  assert.equal(ANN_ONETIME_CONFIG_ID, 261016701);
});

test("周年庆签到助力：档位与卡号与抓包一致", () => {
  assert.deepEqual([...ANN_CELEBRATE_FULLSERVER_IDS], [1, 2]);
  assert.deepEqual([...ANN_CELEBRATE_PERSONAL_IDS], [1]);
  assert.equal(ANN_LINKCARD_CARD_ID, 90111);
  assert.equal(ANN_LINKCARD_READ_NUM, 1);
});

test("周年庆闯关：actId 2610163（换皮闯关 getTowerActId 当周推算是 2610161，故旧入口打不了）", () => {
  assert.equal(ANN_BOSS_ACT_ID, 2610163);
  assert.deepEqual([...ANN_BOSS_TYPES], [1, 2, 3, 4, 5, 6]);
  // master 口径：8 关 + 失败冗余 = 10 次机会
  assert.equal(ANN_BOSS_MAX_FIGHTS, 10);
});

test("今日开放 BOSS：周五1/周六2/周日3/周一4/周二5/周三6/周四全开", () => {
  // 2026-10-17 是周六 —— 抓包日 master 打的正是 BOSS 2，吻合
  assert.deepEqual(getTodayOpenBossTypes(new Date("2026-10-17T10:00:00+08:00")), [2]);
  assert.deepEqual(getTodayOpenBossTypes(new Date("2026-10-16T10:00:00+08:00")), [1]); // 周五
  assert.deepEqual(getTodayOpenBossTypes(new Date("2026-10-18T10:00:00+08:00")), [3]); // 周日
  assert.deepEqual(getTodayOpenBossTypes(new Date("2026-10-19T10:00:00+08:00")), [4]); // 周一
  assert.deepEqual(getTodayOpenBossTypes(new Date("2026-10-20T10:00:00+08:00")), [5]); // 周二
  assert.deepEqual(getTodayOpenBossTypes(new Date("2026-10-21T10:00:00+08:00")), [6]); // 周三
  assert.deepEqual(getTodayOpenBossTypes(new Date("2026-10-22T10:00:00+08:00")), [1, 2, 3, 4, 5, 6]); // 周四
});

test("normalizeTowerInfo：外层 towerData 内还有一层 towerData Map（抓包实证的嵌套形态）", () => {
  const nested = {
    towerData: {
      actId: 2610163,
      season: 45,
      useTickCnt: 1,
      todayUseTickCnt: 0,
      towerData: { 1: { towerType: 1, pass: false }, 2: { towerType: 2, pass: false } },
      levelRewardMap: { 1001: true },
    },
  };
  const normalized = normalizeTowerInfo(nested);
  assert.equal(normalized.actId, 2610163);
  assert.equal(normalized.towerData["2"].towerType, 2);

  // 平铺形态（旧功能代码遇到过的 res.actId 直接在根上的情况）
  const flat = { actId: 2610163, towerData: { 1: { pass: true } } };
  assert.equal(normalizeTowerInfo(flat).actId, 2610163);

  // 空响应 → null（调用方按「活动未开」跳过）
  assert.equal(normalizeTowerInfo(null), null);
  assert.equal(normalizeTowerInfo({}), null);
});

test("pickBossTargets：只选今日开放且未通关的 BOSS", () => {
  const saturday = new Date("2026-10-17T10:00:00+08:00");
  const towerInfo = {
    actId: 2610163,
    towerData: {
      1: { towerType: 1, pass: false },
      2: { towerType: 2, pass: false },
      3: { towerType: 3, pass: false },
      4: { towerType: 4, pass: false },
      5: { towerType: 5, pass: false },
      6: { towerType: 6, pass: true }, // 已通关
    },
  };
  // 周六只开 BOSS 2，且未通关 → [2]
  assert.deepEqual(pickBossTargets(towerInfo, saturday), [2]);

  // BOSS 2 已通关 → 空
  assert.deepEqual(
    pickBossTargets({ ...towerInfo, towerData: { ...towerInfo.towerData, 2: { pass: true } } }, saturday),
    [],
  );

  // 周四全开：6 个里 5 个未通关（6 已通关）
  assert.deepEqual(
    pickBossTargets(towerInfo, new Date("2026-10-22T10:00:00+08:00")),
    [1, 2, 3, 4, 5],
  );

  // 周五只开 BOSS 1
  assert.deepEqual(pickBossTargets(towerInfo, new Date("2026-10-16T10:00:00+08:00")), [1]);

  // 无 actId（活动未开）→ 空
  assert.deepEqual(pickBossTargets({ towerData: { 2: { pass: false } } }, saturday), []);
  // 缺 towerData Map → 空
  assert.deepEqual(pickBossTargets({ actId: 2610163 }, saturday), []);
});

test("isFightWin：主判 result.isWin，兜底 accept.ext.curHP=0 / winCnt 上涨", () => {
  // 抓包 8 场全是这个形态
  assert.equal(
    isFightWin({ battleData: { result: { isWin: true, accept: { ext: { curHP: 0 } } } } }),
    true,
  );
  assert.equal(isFightWin({ battleData: { result: { isWin: false } } }), false);
  // isWin 缺失时兜底旧口径：怪物方 curHP 归零
  assert.equal(isFightWin({ battleData: { result: { accept: { ext: { curHP: 0 } } } } }), true);
  assert.equal(isFightWin({ battleData: { result: { accept: { ext: { curHP: 12345 } } } } }), false);
  // 再兜底：winCnt 比打之前涨了
  assert.equal(isFightWin({ towerData: { winCnt: 5 } }, 4), true);
  assert.equal(isFightWin({ towerData: { winCnt: 4 } }, 4), false);
  // 什么都没给 → 不算赢
  assert.equal(isFightWin({}), false);
});

test("错误分类：已领取/未达成/未开放/限流 与 tasksAnnDaily 同口径", () => {
  assert.equal(isRateLimitError({ code: 400340 }), true);
  assert.equal(isRateLimitError({ code: 200020 }), false);

  assert.equal(isAlreadyDoneError({ error: "已领取" }), true);
  assert.equal(isAlreadyDoneError({ error: "今日已签到" }), true);
  assert.equal(isAlreadyDoneError({ error: "重复领取" }), true);
  assert.equal(isAlreadyDoneError({ error: "网络错误" }), false);

  assert.equal(isNotCompletedError({ error: "任务未达成" }), true);
  assert.equal(isNotCompletedError({ error: "条件不满足" }), true);
  assert.equal(isNotCompletedError({ error: "已领取" }), false);

  assert.equal(isInactiveError({ error: "活动未开启" }), true);
  assert.equal(isInactiveError({ error: "活动已结束" }), true);
  assert.equal(isInactiveError({ error: "未开放" }), true);
  assert.equal(isInactiveError({ error: "未知错误" }), false);
});

// ── 流程级测试（mock tokenStore，验命令顺序 / 提前停止 / 重试）────────────────

/** 构造 createTasksAnnBoss 的 deps（tokenStore 可注入 mock） */
const makeDeps = (tokenStore) => {
  const logs = [];
  return {
    deps: {
      selectedTokens: { value: ["token-1"] },
      tokens: { value: [{ id: "token-1", name: "测试角色" }] },
      tokenStatus: { value: {} },
      isRunning: { value: false },
      shouldStop: { value: false },
      ensureConnection: async () => {},
      releaseConnectionSlot: () => {},
      connectionQueue: { active: 1 },
      batchSettings: { maxActive: 1 },
      tokenStore,
      addLog: (entry) => logs.push(entry),
      message: { success: () => {}, warning: () => {} },
      currentRunningTokenId: { value: null },
    },
    logs,
  };
};

test("批量：一次性奖励只发一条 common_claimtotalreward，参数与抓包一致", async () => {
  const commands = [];
  const { deps, logs } = makeDeps({
    async sendMessageWithPromise(_tokenId, command, body) {
      commands.push({ command, body });
      return { reward: [{ type: 3, itemId: 5292, value: 1 }, { type: 3, itemId: 37011, value: 1 }] };
    },
    closeWebSocketConnection() {},
  });

  const tasks = createTasksAnnBoss(deps);
  await tasks.batchAnnOneTimeReward();

  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "common_claimtotalreward");
  assert.deepEqual(commands[0].body, {
    activityId: ANN_ONETIME_ACT_ID,
    configId: ANN_ONETIME_CONFIG_ID,
  });
  assert.equal(deps.tokenStatus.value["token-1"], "completed");
  assert.ok(logs.some((l) => l.message.includes("5292") && l.message.includes("37011")));
});

test("批量：每日签到助力按抓包顺序发 5 条命令（签到→助力1→读卡→助力2→个人）", async () => {
  const commands = [];
  const { deps, logs } = makeDeps({
    async sendMessageWithPromise(_tokenId, command, body) {
      commands.push({ command, body });
      if (command === "celebrate_claimfullserver") {
        return {
          reward:
            body.idList[0] === 1
              ? [{ type: 21, itemId: ANN_LINKCARD_CARD_ID, value: 1 }]
              : [{ type: 3, itemId: 1001, value: 10 }],
        };
      }
      if (command === "linkcard_readcard") {
        return { role: { linkCard: { [ANN_LINKCARD_CARD_ID]: { readNum: 1 } } } };
      }
      if (command === "celebrate_claimpersonal") {
        return { reward: [{ type: 3, itemId: 1001, value: 3 }] };
      }
      return {};
    },
    closeWebSocketConnection() {},
  });

  const tasks = createTasksAnnBoss(deps);
  await tasks.batchAnnCelebrateClaim();

  assert.deepEqual(
    commands.map((c) => c.command),
    [
      "celebrate_sign",
      "celebrate_claimfullserver",
      "linkcard_readcard",
      "celebrate_claimfullserver",
      "celebrate_claimpersonal",
    ],
  );
  // 参数逐条对（读卡必须在助力1 拿到卡之后，顺序即证据）
  assert.deepEqual(commands[1].body, { idList: [ANN_CELEBRATE_FULLSERVER_IDS[0]] });
  assert.deepEqual(commands[2].body, {
    cardId: ANN_LINKCARD_CARD_ID,
    readNum: ANN_LINKCARD_READ_NUM,
  });
  assert.deepEqual(commands[3].body, { idList: [ANN_CELEBRATE_FULLSERVER_IDS[1]] });
  assert.deepEqual(commands[4].body, { idList: [...ANN_CELEBRATE_PERSONAL_IDS] });
  assert.equal(deps.tokenStatus.value["token-1"], "completed");
  assert.ok(logs.some((l) => l.message.includes("签到成功")));
  assert.ok(logs.some((l) => l.message.includes("读卡成功")));
});

/** 构造抓包同构的 towers_getinfo 响应：只有 leaveUnclearedType 那个 BOSS 未通关 */
const makeTowerInfoResponse = (leaveUnclearedType) => {
  const towerData = {};
  for (const type of ANN_BOSS_TYPES) {
    towerData[String(type)] = {
      towerType: type,
      fighting: false,
      actTowerLv: 1,
      winCnt: 0,
      pass: type !== leaveUnclearedType,
    };
  }
  return {
    towerData: {
      actId: ANN_BOSS_ACT_ID,
      season: 45,
      useTickCnt: 0,
      todayUseTickCnt: 0,
      towerData,
      levelRewardMap: {},
    },
  };
};

test("批量：闯关 8 场全胜即通关（第 8 场 pass=true，不多打）", async () => {
  const openToday = getTodayOpenBossTypes();
  assert.ok(openToday.length > 0, "今天应有开放 BOSS");
  const targetBoss = openToday[0];

  const commands = [];
  let fightCnt = 0;
  const { deps, logs } = makeDeps({
    async sendMessageWithPromise(_tokenId, command, body) {
      commands.push({ command, body });
      if (command === "towers_getinfo") return makeTowerInfoResponse(targetBoss);
      if (command === "towers_start") return {};
      if (command === "towers_fight") {
        fightCnt += 1;
        return {
          reward: [{ type: 3, itemId: 1001, value: 2 }],
          towerData: {
            towerType: body.towerType,
            fighting: true,
            actTowerLv: fightCnt + 1,
            winCnt: fightCnt,
            pass: fightCnt === 8, // 第 8 场通关
          },
          battleData: { result: { isWin: true, accept: { ext: { curHP: 0 } } } },
        };
      }
      return {};
    },
    closeWebSocketConnection() {},
  });

  const tasks = createTasksAnnBoss(deps);
  await tasks.batchAnnBossFight();

  const fightCmds = commands.filter((c) => c.command === "towers_fight");
  const startCmds = commands.filter((c) => c.command === "towers_start");
  assert.equal(commands.filter((c) => c.command === "towers_getinfo").length, 1);
  assert.equal(startCmds.length, 1); // 连胜不重新 start
  assert.equal(fightCmds.length, 8); // 8 场通关即停，不会打第 9 场
  fightCmds.forEach((c) =>
    assert.deepEqual(c.body, { actId: ANN_BOSS_ACT_ID, towerType: targetBoss }),
  );
  assert.equal(deps.tokenStatus.value["token-1"], "completed");
  assert.ok(logs.some((l) => l.message.includes("已通关")));
});

test("批量：闯关连败打满 10 次机会上限即停，且每败重 start", async () => {
  const openToday = getTodayOpenBossTypes();
  const targetBoss = openToday[0];

  const commands = [];
  let fightCnt = 0;
  const { deps, logs } = makeDeps({
    async sendMessageWithPromise(_tokenId, command, body) {
      commands.push({ command, body });
      if (command === "towers_getinfo") return makeTowerInfoResponse(targetBoss);
      if (command === "towers_start") return {};
      if (command === "towers_fight") {
        fightCnt += 1;
        return {
          towerData: { towerType: body.towerType, fighting: false, actTowerLv: 1, winCnt: 0, pass: false },
          battleData: { result: { isWin: false } },
        };
      }
      return {};
    },
    closeWebSocketConnection() {},
  });

  const tasks = createTasksAnnBoss(deps);
  await tasks.batchAnnBossFight();

  assert.equal(commands.filter((c) => c.command === "towers_fight").length, ANN_BOSS_MAX_FIGHTS);
  // 每败一次重新 start：10 战 = 1 首 start + 9 重 start
  assert.equal(commands.filter((c) => c.command === "towers_start").length, ANN_BOSS_MAX_FIGHTS);
  assert.equal(deps.tokenStatus.value["token-1"], "completed");
  assert.ok(logs.some((l) => l.message.includes(`${ANN_BOSS_MAX_FIGHTS} 次机会上限`)));
});
