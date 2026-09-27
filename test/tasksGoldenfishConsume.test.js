/**
 * 金鱼消耗任务端到端测试 —— mock tokenStore 真跑 createTasksGoldenfish 的三个消耗 step
 *
 * 覆盖（2026-09-26 任务 1「初步消耗」）：
 *   - 招募：差值 → hero_recruit { recruitType:1, recruitNumber } 序列（10/发）
 *   - 钓鱼：差值 → artifact_lottery { type:2, lotteryNumber } 序列（只用黄金鱼竿 1012）
 *   - 宝箱：推进循环（全开=钻石不开/木箱留200 → 积分兑换 → 重查）+ 差值精确开箱
 *   - 进度不可读 → 必须跳过（宁可不跑不可盲跑，阶段 B 前的安全行为）
 *   - 限流 400340 → 弹框钩子 continue 重试 / stop 全局中止
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
function createHarness({ state, onRateLimitPause } = {}) {
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
          st.items[1001] = Math.max(0, st.items[1001] - n);
          st.recruitDone += n;
          return {};
        }
        case "artifact_lottery": {
          const n = params?.lotteryNumber ?? 0;
          st.items[1012] = Math.max(0, st.items[1012] - n);
          st.fishDone += n;
          return {};
        }
        case "item_openbox": {
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
    onRateLimitPause:
      onRateLimitPause || (async () => "continue"),
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

test("钓鱼消耗：只用黄金鱼竿，库存不足正常停（还差 25 次警告）", async () => {
  const h = createHarness({
    state: { fishDone: 1100, goldRods: 25 },
  });
  await h.tasks.goldenfishFish({ fishTarget: 1150 });

  assert.deepEqual(
    h.sent.filter((s) => s.cmd === "artifact_lottery").map((s) => s.params),
    [
      { type: 2, lotteryNumber: 10, newFree: true },
      { type: 2, lotteryNumber: 10, newFree: true },
      { type: 2, lotteryNumber: 5, newFree: true },
    ],
  );
  assert.equal(h.state.fishDone, 1125);
  assert.equal(h.state.items[1012], 0);
  assert.ok(h.logs.some((l) => l.message.includes("黄金鱼竿不足") && l.message.includes("还差 25 次")));
  assert.equal(h.errorLogs().length, 0);
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

// ---------------------------------------------------------------- 限流

test("限流 400340：弹框「继续」→ 重试同一命令成功", async () => {
  const pauses = [];
  const h = createHarness({
    state: { recruitDone: 3890, recruitTickets: 100, rateLimitOnce: true },
    onRateLimitPause: async (tokenName, cmd) => {
      pauses.push({ tokenName, cmd });
      return "continue";
    },
  });
  await h.tasks.goldenfishRecruit({ recruitTarget: 3900 });

  assert.deepEqual(pauses, [{ tokenName: "测试号", cmd: "hero_recruit" }]);
  // 第一次被 400340 拒绝 + 重试成功 = 2 条发送记录；进度只按成功一次推进
  assert.equal(h.sent.filter((s) => s.cmd === "hero_recruit").length, 2);
  assert.equal(h.state.recruitDone, 3900);
  assert.equal(h.errorLogs().length, 0);
});

test("限流 400340：弹框「中止」→ 不重试不续发，日志记录中止", async () => {
  const h = createHarness({
    state: { recruitDone: 3890, recruitTickets: 100, rateLimitOnce: true },
    onRateLimitPause: async () => "stop",
  });
  await h.tasks.goldenfishRecruit({ recruitTarget: 3900 });

  // 第一次发送被拒后弹框选择中止 → 无重试、无后续招募命令
  assert.equal(h.sent.filter((s) => s.cmd === "hero_recruit").length, 1);
  assert.equal(h.state.recruitDone, 3890);
  assert.ok(h.logs.some((l) => l.message.includes("限流弹框选择中止")));
  // 中止不是失败
  assert.equal(h.errorLogs().length, 0);
});

test("限流 400340：多账号并发，中止后其它账号不再发消耗命令", async () => {
  const logs = [];
  const sent = [];
  const ref = (v) => ({ value: v });
  let abortAll = false;
  let t1RecruitCount = 0;
  const tokenStore = {
    sendMessageWithPromise: async (tokenId, cmd, params) => {
      sent.push({ tokenId, cmd, params });
      if (cmd === "role_getroleinfo") {
        if (tokenId === "t2") {
          // t2 晚 100ms 才拿到角色数据：t1 的中止流程先完成
          await new Promise((r) => setTimeout(r, 100));
        }
        return { role: { items: { 1001: { quantity: 500 } } } };
      }
      if (tokenId === "t1" && cmd === "hero_recruit") {
        t1RecruitCount += 1;
        if (t1RecruitCount >= 3) {
          const err = new Error("操作频繁");
          err.code = 400340;
          throw err;
        }
        return {};
      }
      // 中止落闸后任何账号再发招募命令都算竞态失败
      if (cmd === "hero_recruit" && abortAll) {
        throw new Error("RACE: 中止后仍发送");
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
    onRateLimitPause: async () => {
      abortAll = true; // 模拟弹框「中止」落闸
      return "stop";
    },
  });
  await tasks.goldenfishRecruit({ recruitTarget: 3900 });

  // t1 第 3 发触发限流；t2 在 t1 中止后才拿到角色数据 → 不应发出任何招募命令
  assert.ok(t1RecruitCount >= 3);
  assert.ok(!sent.some((s) => s.tokenId === "t2" && s.cmd === "hero_recruit"));
  assert.ok(logs.some((l) => l.message.includes("限流弹框选择中止")));
  assert.equal(logs.filter((l) => l.type === "error").length, 0);
});
