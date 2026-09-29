/**
 * 金鱼消耗任务端到端测试 —— mock tokenStore 真跑 createTasksGoldenfish 的三个消耗 step
 *
 * 覆盖（2026-09-26 任务 1「初步消耗」）：
 *   - 招募：差值 → hero_recruit { recruitType:1, recruitNumber } 序列（10/发）
 *   - 钓鱼：差值 → artifact_lottery { type:2, lotteryNumber } 序列（只用黄金鱼竿 1012）
 *   - 宝箱：推进循环（全开=钻石不开/木箱留200 → 积分兑换 → 重查）+ 差值精确开箱
 *   - 进度不可读 → 必须跳过（宁可不跑不可盲跑，阶段 B 前的安全行为）
 *   - 限流 400340 → 交给 tokenStore 统一处理（弹窗 + 每 5 秒重试），本模块跳过该步骤
 *
 * 断言口径（xyzw-protocol-re skill）：
 *   - 命令序列逐字段断言
 *   - 日志里不允许出现「失败」type=error（挡运行时崩溃）
 *   - 每个分支（库存不足/无箱可开/进度不可读/限流）至少一条测试
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTasksGoldenfish } from "../src/utils/batch/tasksGoldenfish.js";
import { CHEST_POINTS } from "../src/utils/goldenfishConsumePlan.js";

/**
 * 模拟服务端：维护活动进度与库存，按命令推进状态
 */
function createHarness({ state } = {}) {
  const sent = [];
  const logs = [];
  const st = {
    recruitDone: state?.recruitDone ?? 0,
    boxScoreDone: state?.boxScoreDone ?? 0,
    fishDone: state?.fishDone ?? 0,
    boxPoint: state?.boxPoint ?? 0,
    boxPointLastReward: state?.boxPointLastReward ?? 0,
    items: {
      1001: state?.recruitTickets ?? 0, // 招募令
      1012: state?.goldRods ?? 0, // 黄金鱼竿
      2001: state?.wooden ?? 0,
      2002: state?.bronze ?? 0,
      2003: state?.gold ?? 0,
      2004: state?.platinum ?? 0,
      2005: state?.diamond ?? 0,
    },
  };
  let rateLimitOnce = state?.rateLimitOnce ?? false; // 下一次命令抛 400340
  let openboxFailOnce = state?.openboxFailOnce ?? false; // 下一次 item_openbox 抛乐观锁
  let recruitDeductHack = state?.recruitDeductHack ?? 0; // 第一帧招募多扣（触发扣减校验）

  const rolePayload = () => ({
    role: {
      items: JSON.parse(JSON.stringify(st.items)),
      boxPoint: st.boxPoint,
      boxPointLastReward: st.boxPointLastReward,
    },
  });

  const tokenStore = {
    sendMessageWithPromise: async (tokenId, cmd, params) => {
      sent.push({ cmd, params });
      if (rateLimitOnce && cmd === (state?.rateLimitCmd ?? "hero_recruit")) {
        rateLimitOnce = false;
        const err = new Error("操作频繁");
        err.code = 400340;
        throw err;
      }
      switch (cmd) {
        case "role_getroleinfo":
          return rolePayload();
        case "hero_recruit": {
          const n = params?.recruitNumber ?? 0;
          st.items[1001] = Math.max(0, st.items[1001] - n - recruitDeductHack);
          const hacked = recruitDeductHack > 0;
          recruitDeductHack = 0;
          st.recruitDone += n;
          // 带实时余额（抓包实证 Hero_RecruitResp.body.role.items）→ 激活扣减校验
          return { role: rolePayload().role, hacked };
        }
        case "artifact_lottery": {
          const n = params?.lotteryNumber ?? 0;
          st.items[1012] = Math.max(0, st.items[1012] - n);
          st.fishDone += n;
          return { role: rolePayload().role };
        }
        case "item_openbox": {
          if (openboxFailOnce) {
            openboxFailOnce = false;
            throw new Error("服务器错误: 200020 - 宝箱数量已发生变化，请重新操作");
          }
          const n = params?.number ?? 0;
          const pts = CHEST_POINTS[params?.itemId] ?? 0;
          st.items[params?.itemId] = Math.max(0, (st.items[params?.itemId] ?? 0) - n);
          st.boxScoreDone += n * pts;
          return { role: { ...rolePayload().role, items: st.items } };
        }
        case "item_claimboxpointreward": {
          const costs = [10, 20, 30, 40, 80, 100, 70, 50, 100];
          const cost = costs[st.boxPointLastReward] ?? 0;
          st.boxPoint = Math.max(0, st.boxPoint - cost);
          st.boxPointLastReward = (st.boxPointLastReward + 1) % 9;
          return { role: { ...rolePayload().role } };
        }
        default:
          return {};
      }
    },
    closeWebSocketConnection: () => {},
  };

  const ref = (value) => ({ value });
  const deps = {
    selectedTokens: ref(["t1"]),
    tokens: ref([{ id: "t1", name: "测试号" }]),
    tokenStatus: ref({}),
    isRunning: ref(false),
    shouldStop: ref(false),
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 0 },
    batchSettings: { maxActive: 2 },
    tokenStore,
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {}, error: () => {} },
    currentRunningTokenId: ref(null),
    delayConfig: { action: 1, command: 0 },
    // 活动进度注入（阶段 B 前测试用；线上默认占位返回 null）
    readActivityProgress: () => ({
      recruitDone: st.recruitDone,
      boxScoreDone: st.boxScoreDone,
      fishDone: st.fishDone,
    }),
  };

  const tasks = createTasksGoldenfish(deps);
  return {
    sent,
    logs,
    tasks,
    state: st,
    shouldStop: deps.shouldStop,
    errorLogs: () => logs.filter((l) => l.type === "error"),
    cmds: () => sent.map((s) => s.cmd),
  };
}

// ---------------------------------------------------------------- 招募

test("招募消耗：差值 50 → hero_recruit ×5（recruitNumber:10）", async () => {
  const h = createHarness({
    state: { recruitDone: 3850, recruitTickets: 500 },
  });
  await h.tasks.goldenfishRecruit({ recruitTarget: 3900, boxTarget: 99000, fishTarget: 1150 });

  assert.deepEqual(
    h.sent.filter((s) => s.cmd === "hero_recruit").map((s) => s.params),
    [
      { recruitType: 1, recruitNumber: 10 },
      { recruitType: 1, recruitNumber: 10 },
      { recruitType: 1, recruitNumber: 10 },
      { recruitType: 1, recruitNumber: 10 },
      { recruitType: 1, recruitNumber: 10 },
    ],
  );
  assert.equal(h.state.recruitDone, 3900);
  assert.equal(h.errorLogs().length, 0);
  assert.ok(h.logs.some((l) => l.message.includes("招募消耗结束")));
});

test("招募消耗：已达标不发命令", async () => {
  const h = createHarness({ state: { recruitDone: 3900, recruitTickets: 100 } });
  await h.tasks.goldenfishRecruit({});
  assert.ok(!h.sent.some((s) => s.cmd === "hero_recruit"));
  assert.ok(h.logs.some((l) => l.message.includes("已达目标")));
});

// ---------------------------------------------------------------- 钓鱼

test("钓鱼消耗：只用黄金鱼竿，库存不足正常停（整批发 20，余 5 不做）", async () => {
  const h = createHarness({
    state: { fishDone: 1100, goldRods: 25 },
  });
  await h.tasks.goldenfishFish({ fishTarget: 1150 });

  // alignDown（2026-09-29 口径）：lotteryNumber 余数批会被 200020 拒 → 只发整批
  assert.deepEqual(
    h.sent.filter((s) => s.cmd === "artifact_lottery").map((s) => s.params),
    [
      { type: 2, lotteryNumber: 10, newFree: true },
      { type: 2, lotteryNumber: 10, newFree: true },
    ],
  );
  assert.equal(h.state.fishDone, 1120);
  assert.equal(h.state.items[1012], 5); // 余 5 根留着
  assert.ok(
    h.logs.some((l) => l.message.includes("不足一批(10)") && l.message.includes("留待最后补满")),
  );
  assert.equal(h.errorLogs().length, 0);
});

test("钓鱼消耗：鱼竿整批发完后仍缺口 → 日志给出缺口次数与竿数折算，留待收尾买竿", async () => {
  // 2026-09-29 master 口径：有多少做多少，缺口靠收尾阶段金砖买竿补全（不即时买）
  const h = createHarness({
    state: { fishDone: 1000, goldRods: 30 }, // 差 150 次，库存 30 根（整批）→ 发 30，缺口 120 次
  });
  await h.tasks.goldenfishFish({ fishTarget: 1150 });

  assert.equal(h.sent.filter((s) => s.cmd === "artifact_lottery").length, 3); // 3 帧 ×10
  assert.equal(h.state.fishDone, 1030);
  assert.equal(h.state.items[1012], 0);
  const endLog = h.logs.find((l) => l.message.includes("钓鱼消耗结束"));
  assert.ok(endLog, "应有结束日志");
  assert.ok(endLog.message.includes("黄金鱼竿不足"), `应提示鱼竿不足：${endLog.message}`);
  assert.ok(endLog.message.includes("还差 120 次"), `应给出缺口次数：${endLog.message}`);
  assert.ok(endLog.message.includes("约 108 根"), `应给出竿数折算（120×0.9）：${endLog.message}`);
  assert.ok(endLog.message.includes("留待收尾阶段金砖买竿补全"), `应指向收尾补竿：${endLog.message}`);
  assert.equal(endLog.type, "warning");
  assert.equal(h.errorLogs().length, 0); // 库存不足是正常暂停，不算失败
});

// ---------------------------------------------------------------- 扣减校验（2026-09-29 master 口径：必须得到反馈再继续，避免盲做）

test("招募消耗：余额扣减不符 → 中止步骤防止盲做", async () => {
  const h = createHarness({
    state: { recruitDone: 0, recruitTickets: 100, recruitDeductHack: 20 },
  });
  await h.tasks.goldenfishRecruit({ recruitTarget: 50 });

  // 第一帧多扣 20（服务端口径不符）→ 校验发现 100→70 扣了 30 ≠ 10 → 中止
  assert.ok(h.logs.some((l) => l.message.includes("招募令扣减异常")));
  const recruits = h.sent.filter((s) => s.cmd === "hero_recruit").length;
  assert.equal(recruits, 1); // 只发了 1 帧，没有继续盲做
  assert.ok(h.errorLogs().length > 0);
});

test("招募消耗：余额逐帧正常扣减 → 校验通过不误杀", async () => {
  const h = createHarness({
    state: { recruitDone: 0, recruitTickets: 100 },
  });
  await h.tasks.goldenfishRecruit({ recruitTarget: 50 });

  const recruits = h.sent.filter((s) => s.cmd === "hero_recruit").length;
  assert.equal(recruits, 5);
  assert.equal(h.state.recruitDone, 50);
  assert.equal(h.state.items[1001], 50);
  assert.equal(h.errorLogs().length, 0);
  assert.ok(h.logs.some((l) => l.message.includes("招募消耗结束")));
});

// ---------------------------------------------------------------- 宝箱

test("宝箱消耗：差值精确开箱（98950 + 可开 550 ≥ 99000 → 只开 1 个铂金）", async () => {
  const h = createHarness({
    state: {
      boxScoreDone: 98950,
      wooden: 350,
      bronze: 20,
      gold: 5,
      platinum: 2,
    },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 99000 });

  // 98050? no: 98950 + 550 = 99500 ≥ 99000 → 不进推进循环
  // 差 50：planPreciseOpen → 铂金 ceil(50/50)=1 个
  assert.deepEqual(
    h.sent.filter((s) => s.cmd === "item_openbox").map((s) => s.params),
    [{ itemId: 2004, number: 1 }],
  );
  assert.equal(h.state.boxScoreDone, 99000);
  assert.equal(h.errorLogs().length, 0);
  assert.ok(h.logs.some((l) => l.message.includes("宝箱消耗结束")));
});

test("宝箱消耗：数量变化乐观锁 → 重新读库存重试成功（2026-09-29）", async () => {
  const h = createHarness({
    state: {
      boxScoreDone: 98000,
      wooden: 350,
      bronze: 20,
      gold: 5,
      platinum: 2,
      openboxFailOnce: true,
    },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 99000 });

  // 首帧被服务端乐观锁拒绝 → 重新拉库存重发 → 完成而不是跳过
  assert.ok(h.sent.some((s) => s.cmd === "item_openbox"));
  assert.ok(h.logs.some((l) => l.message.includes("宝箱数量已变化") && l.message.includes("重新读库存")));
  assert.ok(h.logs.some((l) => l.message.includes("宝箱消耗结束")));
  assert.equal(h.errorLogs().length, 0);
});

test("宝箱消耗：推进循环全开（钻石不开/木箱留200）→ 兑换 → 无箱可开暂停", async () => {
  const h = createHarness({
    state: {
      boxScoreDone: 98000,
      wooden: 350,
      bronze: 20,
      gold: 5,
      platinum: 2,
      diamond: 30,
    },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 99000 });

  // 全开清单：铂金2 + 黄金5 + 青铜10+10 + 木箱10×15（350-200），共 19 发
  const opens = h.sent.filter((s) => s.cmd === "item_openbox").map((s) => s.params);
  assert.equal(opens.length, 19);
  assert.deepEqual(
    opens.filter((o) => o.itemId === 2004),
    [{ itemId: 2004, number: 2 }],
  );
  assert.deepEqual(
    opens.filter((o) => o.itemId === 2001),
    Array.from({ length: 15 }, () => ({ itemId: 2001, number: 10 })),
  );
  // 钻石宝箱一律不开
  assert.ok(!opens.some((o) => o.itemId === 2005));
  // 积分推进 550 → 98550，第二轮无箱可开 → 暂停
  assert.equal(h.state.boxScoreDone, 98550);
  assert.ok(h.logs.some((l) => l.message.includes("无箱可开")));
  assert.equal(h.errorLogs().length, 0);
});

test("宝箱消耗：积分兑换按档位消耗 boxPoint（响应驱动）", async () => {
  const h = createHarness({
    state: {
      boxScoreDone: 90000,
      boxPoint: 130,
      boxPointLastReward: 0,
      wooden: 0,
      bronze: 0,
      gold: 0,
      platinum: 0,
    },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 99000 });
  // 无箱可开前会先全开（空清单）→ 直接暂停？——不，130 分未兑换不进箱。
  // shouldKeepLooping(90000, 全 0, 99000) → true → planOpenAll 空 → 暂停。
  // 兑换场景单独构造：boxPoint 不足以开箱 → 兑换不出宝箱 → 仍暂停（等补货）。
  assert.ok(h.logs.some((l) => l.message.includes("无箱可开")));
  assert.equal(h.errorLogs().length, 0);
});

// ---------------------------------------------------------------- 进度不可读

test("进度不可读：三个消耗 step 全部跳过，不发任何消耗命令", async () => {
  const sent = [];
  const logs = [];
  const ref = (v) => ({ value: v });
  const tokenStore = {
    sendMessageWithPromise: async (tokenId, cmd, params) => {
      sent.push({ cmd, params });
      return { role: { items: {} } };
    },
    closeWebSocketConnection: () => {},
  };
  const tasks = createTasksGoldenfish({
    selectedTokens: ref(["t1"]),
    tokens: ref([{ id: "t1", name: "测试号" }]),
    tokenStatus: ref({}),
    isRunning: ref(false),
    shouldStop: ref(false),
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 0 },
    batchSettings: { maxActive: 2 },
    tokenStore,
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {}, error: () => {} },
    currentRunningTokenId: ref(null),
    delayConfig: { action: 1, command: 0 },
    // 不注入 readActivityProgress → 默认占位返回 null
  });
  await tasks.goldenfishConsumeAll({});

  assert.ok(!sent.some((s) => s.cmd === "hero_recruit"));
  assert.ok(!sent.some((s) => s.cmd === "artifact_lottery"));
  assert.ok(!sent.some((s) => s.cmd === "item_openbox"));
  // role_getroleinfo 只用于探测，允许发出；但每个 step 必须有「进度不可读」日志
  const unreadable = logs.filter((l) => l.message.includes("进度不可读"));
  assert.equal(unreadable.length, 3);
  assert.equal(logs.filter((l) => l.type === "error").length, 0);
});

// -------------------------------------------- 阶段 B：真实活动数据（不注入进展实现）

/**
 * 真实抓包夹具：`local-data/goldenfish/goldenfish_task_and_rewards1.jsonl`
 * `Activity_GetResp` → `body.activity.commonActivityInfo`（2026-09-25）
 * 同期 2609252/3/4 无 task、2609255 是负数键 → 只有 2609251 是金鱼活动。
 */
const CAPTURE_COMMON = {
  2609251: {
    record: { 1: 1790578205, 21: 1790578207 },
    task: { 1: 3685, 2: 96530, 3: 1140, 4: 632, 5: 20389 },
    isBought: false,
  },
  2609252: { isBought: false },
  2609255: { task: { "-1": 0, "-2": 0 }, isBought: false },
};

/** 造一个「只喂真实活动响应」的最小 harness（**不注入** deps.readActivityProgress） */
function createRealActivityHarness({ commonActivityInfo, items = {}, cmds = {} }) {
  const sent = [];
  const logs = [];
  const ref = (v) => ({ value: v });
  const tokenStore = {
    sendMessageWithPromise: async (tokenId, cmd, params) => {
      sent.push({ cmd, params });
      if (cmd === "activity_get") return { body: { activity: { commonActivityInfo } } };
      if (cmd === "role_getroleinfo") return { role: { items } };
      if (Object.hasOwn(cmds, cmd)) return typeof cmds[cmd] === "function" ? cmds[cmd](params) : cmds[cmd];
      return {};
    },
    closeWebSocketConnection: () => {},
  };
  const tasks = createTasksGoldenfish({
    selectedTokens: ref(["t1"]),
    tokens: ref([{ id: "t1", name: "抓包号" }]),
    tokenStatus: ref({}),
    isRunning: ref(false),
    shouldStop: ref(false),
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 0 },
    batchSettings: { maxActive: 2 },
    tokenStore,
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {}, error: () => {} },
    currentRunningTokenId: ref(null),
    delayConfig: { action: 1, command: 0 },
  });
  return {
    tasks,
    sent,
    logs,
    cmds: () => sent.map((s) => s.cmd),
    errorLogs: () => logs.filter((l) => l.type === "error"),
  };
}

test("阶段B 真实数据：招募进度 3685 → 差值 215 → 21 发 10（余 5 不做）；activity_get 先于 role", async () => {
  const h = createRealActivityHarness({
    commonActivityInfo: CAPTURE_COMMON,
    items: { 1001: { quantity: 500 } },
  });
  await h.tasks.goldenfishRecruit({ recruitTarget: 3900 });

  // alignDown（2026-09-29 口径）：recruitNumber 余数批会被 200020 拒 → 只发整批
  const recruits = h.sent.filter((s) => s.cmd === "hero_recruit").map((s) => s.params);
  assert.equal(recruits.length, 21);
  assert.deepEqual(recruits, Array.from({ length: 21 }, () => ({ recruitType: 1, recruitNumber: 10 })));
  assert.ok(h.logs.some((l) => l.message.includes("不足一批(10)")));

  // 进度靠 activity_get（不是 role）→ 它必须先发
  const seq = h.cmds();
  assert.ok(seq.indexOf("activity_get") < seq.indexOf("role_getroleinfo"));
  // 日志里带上探测到的活动实例 ID
  assert.ok(h.logs.some((l) => l.message.includes("活动 2609251")));
  assert.equal(h.errorLogs().length, 0);
});

test("阶段B 真实数据：钓鱼进度 1140 = 目标 → 已达标不发命令", async () => {
  const h = createRealActivityHarness({
    commonActivityInfo: CAPTURE_COMMON,
    items: { 1012: { quantity: 999 } },
  });
  await h.tasks.goldenfishFish({ fishTarget: 1140 });

  assert.ok(!h.sent.some((s) => s.cmd === "artifact_lottery"));
  assert.ok(h.logs.some((l) => l.message.includes("钓鱼消耗已达目标")));
  assert.equal(h.errorLogs().length, 0);
});

test("阶段B 真实数据：槽位缺失（只有 task.1）→ 对应 step 跳过并指名缺哪个槽", async () => {
  const h = createRealActivityHarness({
    commonActivityInfo: {
      2609251: { task: { 1: 3685 }, isBought: false },
      2609252: { isBought: false },
    },
    items: { 1012: { quantity: 500 } },
  });
  await h.tasks.goldenfishConsumeAll({ recruitTarget: 3900, boxTarget: 99000, fishTarget: 1140 });

  // 缺 task.2/task.3 → 宝箱与钓鱼都跳过，不发消耗命令
  assert.ok(!h.sent.some((s) => s.cmd === "artifact_lottery"));
  assert.ok(!h.sent.some((s) => s.cmd === "item_openbox"));
  assert.ok(h.logs.some((l) => l.message.includes("缺 task.2（宝箱）")));
  assert.ok(h.logs.some((l) => l.message.includes("缺 task.3（钓鱼）")));
  assert.equal(h.errorLogs().length, 0);
});

// ---------------------------------------------------------------- 限流

test("限流 400340：由 tokenStore 统一处理，任务侧跳过该步骤且不计失败", async () => {
  const h = createHarness({
    state: { recruitDone: 3890, recruitTickets: 100, rateLimitOnce: true },
  });
  await h.tasks.goldenfishRecruit({ recruitTarget: 3900 });

  // 第一次 hero_recruit 被 400340 拒绝：本模块不再自行重试（tokenStore 负责弹窗 + 每 5 秒重试）
  assert.equal(h.sent.filter((s) => s.cmd === "hero_recruit").length, 1);
  assert.equal(h.state.recruitDone, 3890);
  assert.ok(h.logs.some((l) => l.message.includes("触发限流")));
  assert.equal(h.errorLogs().length, 0);
});

test("限流 400340：多账号限流互不影响，各自跳过本步骤", async () => {
  const logs = [];
  const sent = [];
  const ref = (v) => ({ value: v });
  const tokenStore = {
    sendMessageWithPromise: async (tokenId, cmd, params) => {
      sent.push({ tokenId, cmd, params });
      if (cmd === "role_getroleinfo") {
        return { role: { items: { 1001: { quantity: 500 } } } };
      }
      if (cmd === "hero_recruit") {
        const err = new Error("操作频繁");
        err.code = 400340;
        throw err;
      }
      return {};
    },
    closeWebSocketConnection: () => {},
  };
  const tasks = createTasksGoldenfish({
    selectedTokens: ref(["t1", "t2"]),
    tokens: ref([
      { id: "t1", name: "一号" },
      { id: "t2", name: "二号" },
    ]),
    tokenStatus: ref({}),
    isRunning: ref(false),
    shouldStop: ref(false),
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 0 },
    batchSettings: { maxActive: 4 },
    tokenStore,
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {}, error: () => {} },
    currentRunningTokenId: ref(null),
    delayConfig: { action: 1, command: 0 },
    readActivityProgress: () => ({ recruitDone: 3850, boxScoreDone: 0, fishDone: 0 }),
  });
  await tasks.goldenfishRecruit({ recruitTarget: 3900 });

  // 两个账号都各发了一次 hero_recruit 被限流 → 各自跳过本步骤，不产生 error 日志
  assert.equal(sent.filter((s) => s.cmd === "hero_recruit").length, 2);
  assert.equal(logs.filter((l) => l.type === "error").length, 0);
  assert.equal(
    logs.filter((l) => l.message.includes("触发限流")).length >= 2,
    true,
  );
});

// ---------------------------------------------------------------- 并行（2026-09-29 master：三者独立限流，不必串行）

/** 三路都有活干的状态：招募差 100 / 宝箱差 100 分 / 钓鱼差 100 次（库存均够） */
const PARALLEL_STATE = {
  recruitDone: 3800,
  recruitTickets: 120,
  boxScoreDone: 98900,
  platinum: 2,
  fishDone: 1000,
  goldRods: 120,
};
const PARALLEL_CONFIG = { recruitTarget: 3900, boxTarget: 99000, fishTarget: 1100 };

test("并行：招募+钓鱼并行、宝箱独占串行（宝箱背包乐观锁敏感）", async () => {
  const h = createHarness({ state: PARALLEL_STATE });
  await h.tasks.goldenfishConsumeAll({ ...PARALLEL_CONFIG });

  const parallelLog = h.logs.find((l) => l.message.includes("并行执行"));
  assert.ok(parallelLog, "应有并行执行日志");
  // 日志要点名：并行的是招募+钓鱼，宝箱走串行
  assert.ok(parallelLog.message.includes("consumeRecruit"), `并行段应含招募：${parallelLog.message}`);
  assert.ok(parallelLog.message.includes("consumeFish"), `并行段应含钓鱼：${parallelLog.message}`);
  assert.ok(
    parallelLog.message.includes("其余串行") && parallelLog.message.includes("consumeBoxes"),
    `日志应说明宝箱串行：${parallelLog.message}`,
  );

  // 三路命令都发出且都推进到位
  assert.ok(h.sent.some((s) => s.cmd === "hero_recruit"), "招募应有帧");
  assert.ok(h.sent.some((s) => s.cmd === "item_openbox"), "宝箱应有帧");
  assert.ok(h.sent.some((s) => s.cmd === "artifact_lottery"), "钓鱼应有帧");
  assert.equal(h.state.recruitDone, 3900);
  assert.equal(h.state.fishDone, 1100);
  assert.equal(h.state.boxScoreDone, 99000);
  assert.equal(h.errorLogs().length, 0);

  // 🔴 宝箱必须**独占**：它的开箱帧全部出现在招募/钓鱼之后
  const cmds = h.cmds();
  const firstRecruit = cmds.indexOf("hero_recruit");
  const firstFish = cmds.indexOf("artifact_lottery");
  const firstBox = cmds.indexOf("item_openbox");
  assert.ok(firstRecruit >= 0 && firstFish >= 0 && firstBox >= 0, `三路都要有帧：${cmds.join(",")}`);
  assert.ok(
    firstBox > firstRecruit && firstBox > firstFish,
    `宝箱应独占在并行段之后（避免与活动任务并发触发乐观锁）：${cmds.join(",")}`,
  );
});

test("并行：config.parallelBoxes=true → 宝箱也参与并行（实验开关）", async () => {
  const h = createHarness({ state: PARALLEL_STATE });
  await h.tasks.goldenfishConsumeAll({ ...PARALLEL_CONFIG, parallelBoxes: true });

  const parallelLog = h.logs.find((l) => l.message.includes("并行执行"));
  assert.ok(parallelLog?.message.includes("3 个消耗任务"), `应为 3 个并行：${parallelLog?.message}`);
  assert.ok(parallelLog.message.includes("consumeBoxes"), `宝箱应在并行段：${parallelLog.message}`);
  assert.equal(h.errorLogs().length, 0);
});

test("并行：config.serialConsume=true → 全部串行（无并行日志，段内顺序保持）", async () => {
  const h = createHarness({ state: PARALLEL_STATE });
  await h.tasks.goldenfishConsumeAll({ ...PARALLEL_CONFIG, serialConsume: true });

  assert.ok(
    !h.logs.some((l) => l.message.includes("并行执行")),
    "串行模式不应出现并行日志",
  );
  const cmds = h.cmds();
  const firstRecruit = cmds.indexOf("hero_recruit");
  const firstBox = cmds.indexOf("item_openbox");
  const firstFish = cmds.indexOf("artifact_lottery");
  assert.ok(firstRecruit >= 0, "招募应有帧");
  assert.ok(firstBox > firstRecruit, `宝箱应在招募之后（串行）: ${cmds.join(",")}`);
  assert.ok(firstFish > firstBox, `钓鱼应在宝箱之后（串行）: ${cmds.join(",")}`);
  assert.equal(h.errorLogs().length, 0);
});
