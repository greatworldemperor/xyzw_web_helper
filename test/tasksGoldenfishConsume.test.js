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
import {
  BOX_POINT_BATCH_MIN,
  BOX_POINT_STEP_COSTS,
  CHEST_POINTS,
  OPENBOX_BATCH_SIZE,
} from "../src/utils/goldenfishConsumePlan.js";
import {
  completedRounds,
  toMissionId,
} from "../src/utils/goldenfishFinishPlan.js";

/** 宝箱积分兑换的 9 档成本（与生产同一份定义，避免测试里再抄一遍） */
const BOX_POINT_COSTS = BOX_POINT_STEP_COSTS;

/**
 * 模拟服务端：维护活动进度与库存，按命令推进状态
 */
function createHarness({ state } = {}) {
  const sent = [];
  const logs = [];
  const warnings = []; // message.warning 文案（并发闸门 / 租约跳过的断言用）
  const st = {
    recruitDone: state?.recruitDone ?? 0,
    boxScoreDone: state?.boxScoreDone ?? 0,
    fishDone: state?.fishDone ?? 0,
    jarDone: state?.jarDone ?? 0,
    goldDone: state?.goldDone ?? 0,
    record: state?.record ?? {},
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
      5287: state?.packs ?? 0, // 普通道具（金鱼活动，item_openpack 开包）
      ...(state?.extraItems || {}), // 额外道具（清空清单/保护名单测试用）
    },
  };
  let rateLimitOnce = state?.rateLimitOnce ?? false; // 下一次命令抛 400340
  let openboxFailOnce = state?.openboxFailOnce ?? false; // 下一次 item_openbox 抛乐观锁
  const openboxAlwaysFail = state?.openboxAlwaysFail ?? false; // 每次 item_openbox 都抛乐观锁
  let recruitDeductHack = state?.recruitDeductHack ?? 0; // 第一帧招募多扣（触发扣减校验）
  // 首帧钓鱼返还/多扣模拟：正数 = 10% 概率返还鱼竿（净耗 n-1）；负数 = 多扣（触发扣减异常）
  let fishReturnHack = state?.fishReturnHack ?? 0;
  // 首帧开箱正向带进模拟（并行钓鱼掉落宝箱）：开完后给该箱型 +N → 净耗 n-N
  let boxGiftHack = state?.boxGiftHack ?? 0;
  // 第一阶段后段步骤的 mock 配额：heroUpOk/bookUpOk/starClaimOk = 前若干次返回成功
  let heroUpOk = state?.heroUpOk ?? 0;
  let bookUpOk = state?.bookUpOk ?? 0;
  let starClaimOk = state?.starClaimOk ?? 0;
  const claimedMissionIds = []; // activity_claimtaskreward 的 missionId 序列
  // 普通道具开包的铂金箱期望（默认 0.205/个，与 GOLDENFISH_PACK_RETURNS 一致；测试可覆盖）
  const packPlatinumYield = state?.packPlatinumYield ?? 0.205;
  // 服务端绝对计数器（today:open:box = 开箱调用次数；activity:open:box = 开箱积分）
  // phantomCallsPerOpenbox = 每次调用开箱时「别处」额外产生的调用次数（模拟第三方并发开同一个号）
  const phantomCallsPerOpenbox = state?.phantomCallsPerOpenbox ?? 0;
  let openboxCallStat = state?.todayOpenBox ?? 0;
  let openboxScoreStat = state?.activityOpenBox ?? 0;

  const rolePayload = () => ({
    role: {
      items: JSON.parse(JSON.stringify(st.items)),
      boxPoint: st.boxPoint,
      boxPointLastReward: st.boxPointLastReward,
      statistics: {
        "today:open:box": openboxCallStat,
        "activity:open:box": openboxScoreStat,
      },
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
          if (fishReturnHack !== 0) {
            // 首帧模拟钓鱼返还（正数 = 10% 概率返还鱼竿）或多扣（负数，异常用例）
            st.items[1012] += fishReturnHack;
            fishReturnHack = 0;
          }
          st.fishDone += n;
          return { role: rolePayload().role };
        }
        case "item_openbox": {
          if (openboxAlwaysFail || openboxFailOnce) {
            openboxFailOnce = false;
            // 服务端只要收到调用就计数（被拒也算）→ 本机这 1 帧 + 别处的 phantom 次
            openboxCallStat += 1 + phantomCallsPerOpenbox;
            throw new Error("服务器错误: 200020 - 宝箱数量已发生变化，请重新操作");
          }
          const n = params?.number ?? 0;
          // 🔴 服务端**只接受整批开箱**（单帧 number 恰好 = 10）：余数批被拒
          //    「宝箱数量已发生变化，请重新操作」。定案证据见
          //    goldenfishConsumePlan.js 的 OPENBOX_BATCH_SIZE 注释
          //    （28c 计划 885 → 前 88 帧×10 全成、第 89 帧(5)被拒；全部被拒帧 number < 10）。
          //    被拒也计数，保证计数器判据与线上一致。
          if (n < OPENBOX_BATCH_SIZE) {
            openboxCallStat += 1 + phantomCallsPerOpenbox;
            throw new Error("服务器错误: 200020 - 宝箱数量已发生变化，请重新操作");
          }
          const pts = CHEST_POINTS[params?.itemId] ?? 0;
          st.items[params?.itemId] = Math.max(0, (st.items[params?.itemId] ?? 0) - n);
          if (boxGiftHack !== 0) {
            // 首帧模拟并行钓鱼掉落宝箱（正向获取）：开完后 +N → 净耗 n-N
            st.items[params?.itemId] += boxGiftHack;
            boxGiftHack = 0;
          }
          st.boxScoreDone += n * pts;
          // 实证（consumption_tasks.jsonl）：每次 item_openbox 调用 today:+1、activity:+本帧积分
          openboxCallStat += 1 + phantomCallsPerOpenbox;
          openboxScoreStat += n * pts;
          return { role: { ...rolePayload().role, items: st.items } };
        }
        case "item_openpack": {
          // 开包（item_openpack { itemId, number, index }，单次 ≤999）：
          // 普通道具 5287 按期望口径返还 —— 铂金箱 = round(n × 0.205)、招募令 = round(n × 0.5)。
          // 数量不足按服务端行为拒绝（200020 系）。
          const n = params?.number ?? 0;
          const held = st.items[params?.itemId] ?? 0;
          if (n > held) {
            throw new Error("服务器错误: 200020 - 道具数量不足，请重新操作");
          }
          st.items[params?.itemId] = held - n;
          if (params?.itemId === 5287 && n > 0) {
            const plat = Math.round(n * packPlatinumYield);
            if (plat > 0) st.items[2004] = (st.items[2004] ?? 0) + plat;
            const recruit = Math.round(n * 0.5);
            if (recruit > 0) st.items[1001] = (st.items[1001] ?? 0) + recruit;
          }
          return { role: rolePayload().role };
        }
        case "item_claimboxpointreward": {
          // 逐档兑换。**金鱼消耗路径已不再调用它**（改成 ≥1000 一键兑光了），
          // 这里保留是让 mock 忠实于服务端（smartOpenBox 等其它路径仍在用该命令）。
          const cost = BOX_POINT_COSTS[st.boxPointLastReward] ?? 0;
          st.boxPoint = Math.max(0, st.boxPoint - cost);
          st.boxPointLastReward = (st.boxPointLastReward + 1) % BOX_POINT_COSTS.length;
          return { role: { ...rolePayload().role } };
        }
        case "item_batchclaimboxpointreward": {
          // 一键兑换：从当前档位起把「付得起」的档位连续兑到付不起（响应驱动，见 runGoldenfish
          // 注释里的抓包实证 1638 → 38）；无参数调用，响应仍带 role.boxPoint/boxPointLastReward
          let guard = 0;
          for (;;) {
            if (guard > 3000) break;
            guard += 1;
            const cost = BOX_POINT_COSTS[st.boxPointLastReward] ?? 0;
            if (st.boxPoint < cost) break;
            st.boxPoint -= cost;
            st.boxPointLastReward = (st.boxPointLastReward + 1) % BOX_POINT_COSTS.length;
          }
          return { role: { ...rolePayload().role } };
        }
        case "activity_claimtaskreward":
          claimedMissionIds.push(params?.missionId);
          if (params?.missionId != null) st.record[params.missionId] = 1790736291;
          return {};
        case "hero_heroupgradestar":
          if (heroUpOk > 0) { heroUpOk -= 1; return { code: 0 }; }
          return { code: 1 };
        case "book_upgrade":
          if (bookUpOk > 0) { bookUpOk -= 1; return { code: 0 }; }
          return { code: 1 };
        case "book_claimpointreward":
          if (starClaimOk > 0) { starClaimOk -= 1; return { code: 0 }; }
          return { code: 1 };
        default:
          return {};
      }
    },
    closeWebSocketConnection: () => {},
  };

  const ref = (value) => ({ value });
  const deps = {
    selectedTokens: ref(["t1"]),
    // serverId/roleId 决定跨标签页租约键（角色维度）→ 租约用例据此构造外部持有者
    tokens: ref([{ id: "t1", name: "测试号", serverId: 9701, roleId: 100001 }]),
    tokenStatus: ref({}),
    isRunning: ref(false),
    shouldStop: ref(false),
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 0 },
    batchSettings: { maxActive: 2 },
    tokenStore,
    addLog: (entry) => logs.push(entry),
    message: {
      success: () => {},
      warning: (text) => warnings.push(String(text)),
      error: () => {},
    },
    currentRunningTokenId: ref(null),
    delayConfig: { action: 1, command: 0 },
    // 活动进度注入（阶段 B 前测试用；线上默认占位返回 null）
    readActivityProgress: () => ({
      activityId: state?.activityId ?? 2609251,
      recruitDone: st.recruitDone,
      boxScoreDone: st.boxScoreDone,
      fishDone: st.fishDone,
      jarDone: st.jarDone,
      goldDone: st.goldDone,
      record: st.record,
    }),
  };

  const tasks = createTasksGoldenfish(deps);
  return {
    sent,
    logs,
    warnings,
    claimedMissionIds,
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

test("钓鱼消耗：fishDone=0（零进度补 0 后）正常执行，不再整步跳过", async () => {
  // 2026-09-30 定案：服务端对零进度任务不下发 task 键（21号战士/39b 缺 task.3）
  // 读取层补 0 后，钓鱼应按「有多少做多少」正常规划执行
  const h = createHarness({ state: { fishDone: 0, goldRods: 20 } });
  await h.tasks.goldenfishFish({ fishTarget: 1140 });

  assert.deepEqual(
    h.sent.filter((s) => s.cmd === "artifact_lottery").map((s) => s.params),
    [
      { type: 2, lotteryNumber: 10, newFree: true },
      { type: 2, lotteryNumber: 10, newFree: true },
    ],
  );
  assert.equal(h.state.fishDone, 20);
  assert.ok(
    !h.logs.some((l) => l.message.includes("缺 task.3")),
    "零进度不该再被判成缺字段跳过",
  );
  assert.equal(h.errorLogs().length, 0);
});

test("钓鱼消耗：10% 返还鱼竿不算扣减异常（净耗 9/10 记日志放行，2026-09-30 线上反馈）", async () => {
  // 34b 线上案例：预期 -10 实际 -9 —— 钓鱼有 10% 概率返还鱼竿，净耗 9 是合法的
  const h = createHarness({
    state: { fishDone: 1100, goldRods: 25, fishReturnHack: 1 },
  });
  await h.tasks.goldenfishFish({ fishTarget: 1150 });

  assert.deepEqual(
    h.sent.filter((s) => s.cmd === "artifact_lottery").map((s) => s.params),
    [
      { type: 2, lotteryNumber: 10, newFree: true },
      { type: 2, lotteryNumber: 10, newFree: true },
    ],
  );
  assert.ok(
    h.logs.some((l) => l.message.includes("黄金鱼竿净耗 9/10")),
    "返还帧应打净耗日志放行",
  );
  assert.ok(
    !h.logs.some((l) => l.message.includes("扣减异常")),
    "返还不该被判成扣减异常",
  );
  assert.ok(h.logs.some((l) => l.message.includes("钓鱼消耗结束")));
  assert.equal(h.errorLogs().length, 0);
});

test("钓鱼消耗：多扣（净耗 13 > 10）仍然中止防盲做", async () => {
  const h = createHarness({
    state: { fishDone: 1100, goldRods: 25, fishReturnHack: -3 }, // 首帧多扣 3 → 净耗 13 > 10
  });
  await h.tasks.goldenfishFish({ fishTarget: 1150 });

  assert.ok(
    h.logs.some(
      (l) => l.message.includes("consumeFish 失败") && l.message.includes("扣减异常"),
    ),
    "多扣仍应触发扣减异常并被步骤隔离",
  );
  assert.ok(
    h.logs.some((l) => l.message.includes("超出上限")),
    "异常文案应说明只允许正向获取",
  );
});

test("钓鱼消耗：净耗为负（并行正向带进鱼竿）不设下限、放行", async () => {
  // master 2026-09-30 拍板：检查条件 = 实际减扣数不大于消耗数量，不设下限
  const h = createHarness({
    state: { fishDone: 1100, goldRods: 25, fishReturnHack: 11 }, // 首帧返还 11 → 净耗 -1
  });
  await h.tasks.goldenfishFish({ fishTarget: 1150 });

  assert.ok(
    h.logs.some((l) => l.message.includes("黄金鱼竿净耗 -1/10")),
    "负净耗（正向带进）应打日志放行",
  );
  assert.ok(
    !h.logs.some((l) => l.message.includes("扣减异常")),
    "正向带进不该被判成扣减异常",
  );
  assert.equal(h.errorLogs().length, 0);
});

test("宝箱扣减校验：并行钓鱼掉落宝箱 → 净耗小于消耗数放行（三路并行口径）", async () => {
  // master 2026-09-30：钓鱼有概率掉各种宝箱（钻石除外），是正向获取 ——
  // 宝箱库存可能中途不降反升，净耗小于消耗数甚至为负都正常，只有多扣才异常
  const h = createHarness({
    state: { boxScoreDone: 98900, bronze: 20, boxGiftHack: 1 }, // 首帧净耗 9
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 99100 });

  assert.ok(
    h.logs.some((l) => l.message.includes("宝箱 2002 净耗 9/10")),
    "正向带进帧应打净耗日志放行",
  );
  assert.ok(
    !h.logs.some((l) => l.message.includes("扣减异常")),
    "正向获取不该被判成扣减异常",
  );
  assert.ok(h.logs.some((l) => l.message.includes("宝箱消耗结束")));
  assert.equal(h.errorLogs().length, 0);
});

test("招募扣减校验：并行正向获取（净耗 9/10）放行，多扣才中止", async () => {
  // 三路并行下救援开普通道具会给 0.5 招募令/个 —— 招募令库存可能中途回升
  const h = createHarness({
    state: { recruitDone: 3800, recruitTickets: 120, recruitDeductHack: -1 },
  });
  await h.tasks.goldenfishRecruit({ recruitTarget: 3900 });

  assert.ok(
    h.logs.some((l) => l.message.includes("招募令净耗 9/10")),
    "正向带进帧应打净耗日志放行",
  );
  assert.ok(
    !h.logs.some((l) => l.message.includes("扣减异常")),
    "正向获取不该被判成扣减异常",
  );
  assert.ok(h.logs.some((l) => l.message.includes("招募消耗结束")));
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

test("宝箱消耗：差值精确开箱（整批口径，余数补齐到一整批）", async () => {
  const h = createHarness({
    state: {
      boxScoreDone: 98900,
      wooden: 350,
      bronze: 20,
      gold: 5,
      platinum: 2,
    },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 99000 });

  // 可开（整批口径）：铂金 2→0、黄金 5→0、青铜 20、木箱 350−200=150 → 20×10 + 150×1 = 350
  // 98900 + 350 = 99250 ≥ 99000 → 不进推进循环；差 100 → 青铜需 10 个 = 恰好一整批
  assert.deepEqual(
    h.sent.filter((s) => s.cmd === "item_openbox").map((s) => s.params),
    [{ itemId: 2002, number: 10 }],
  );
  assert.equal(h.state.boxScoreDone, 99000);
  assert.equal(h.errorLogs().length, 0);
  assert.ok(h.logs.some((l) => l.message.includes("宝箱消耗结束")));
});

test("宝箱消耗：只有余数（木箱 208−200=8，不足一批）→ 一帧不发、提示开不动（线上失败号画像）", async () => {
  // batch_log1.txt 里 9 个失败号的真实画像：木箱 202~208、青铜/黄金/铂金全 0、钻石大量（一律不开）
  const h = createHarness({
    state: { boxScoreDone: 66950, wooden: 208, diamond: 234 },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 99000 });

  // 可开积分按整批算 = 0 → 不进入开箱（旧版会发 2001×8 被服务端拒三次）
  assert.equal(h.sent.filter((s) => s.cmd === "item_openbox").length, 0);
  assert.ok(h.logs.some((l) => l.message.includes("无箱可开")));
  assert.ok(h.logs.some((l) => l.message.includes("余数不足一批的开不动")));
  // 正常暂停，不是失败
  assert.equal(h.errorLogs().length, 0);
  assert.ok(!h.logs.some((l) => l.message.includes("开箱被服务端拒绝")));
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

test("宝箱消耗：推进循环全开（钻石不开/木箱留200/余数不整批不开）→ 兑换 → 无箱可开暂停", async () => {
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

  // 全开清单（整批对齐）：铂金 2→0、黄金 5→0、青铜 20→10+10、木箱 150→10×15，共 17 发
  const opens = h.sent.filter((s) => s.cmd === "item_openbox").map((s) => s.params);
  assert.equal(opens.length, 17);
  assert.deepEqual(opens.filter((o) => o.itemId === 2004), []); // 铂金 2 个不足一批 → 不开
  assert.deepEqual(opens.filter((o) => o.itemId === 2003), []); // 黄金 5 个不足一批 → 不开
  assert.deepEqual(
    opens.filter((o) => o.itemId === 2002),
    Array.from({ length: 2 }, () => ({ itemId: 2002, number: 10 })),
  );
  assert.deepEqual(
    opens.filter((o) => o.itemId === 2001),
    Array.from({ length: 15 }, () => ({ itemId: 2001, number: 10 })),
  );
  // 每帧都必须是整批（服务端只认整批，余数批会被拒）
  assert.ok(opens.every((o) => o.number % OPENBOX_BATCH_SIZE === 0));
  // 钻石宝箱一律不开
  assert.ok(!opens.some((o) => o.itemId === 2005));
  // 积分推进 350 → 98350，第二轮无箱可开 → 暂停
  assert.equal(h.state.boxScoreDone, 98350);
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

test("宝箱消耗：积分 ≥ 1000（边界值）→ 一键兑换一帧兑光，不发逐档", async () => {
  const h = createHarness({
    state: { boxScoreDone: 98000, boxPoint: 1000, boxPointLastReward: 0, wooden: 350 },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 99000 });

  const batch = h.sent.filter((s) => s.cmd === "item_batchclaimboxpointreward");
  assert.equal(batch.length, 1, `积分 ≥ 门槛时应只发一帧一键兑换（实际 ${batch.length}）`);
  assert.deepEqual(batch[0].params, {}, "一键兑换是无参数命令（抓包请求体 0800）");
  assert.equal(
    h.sent.filter((s) => s.cmd === "item_claimboxpointreward").length,
    0,
    "金鱼活动期间不再走逐档兑换",
  );
  assert.ok(
    h.logs.some((l) => l.message.includes("积分一键兑换")),
    "应打出「积分一键兑换」日志",
  );
  assert.ok(
    h.state.boxPoint < BOX_POINT_BATCH_MIN,
    `一键兑换应把积分兑到门槛以下（实际 ${h.state.boxPoint}）`,
  );
  assert.equal(h.errorLogs().length, 0);
});

test("宝箱消耗：积分 < 1000（999）→ 完全不兑换，一帧不发，积分原样留着", async () => {
  const h = createHarness({
    state: { boxScoreDone: 98000, boxPoint: 999, boxPointLastReward: 0, wooden: 350 },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 99000 });

  assert.equal(
    h.sent.filter((s) => s.cmd === "item_batchclaimboxpointreward").length,
    0,
    "不足门槛不该发一键兑换",
  );
  assert.equal(
    h.sent.filter((s) => s.cmd === "item_claimboxpointreward").length,
    0,
    "金鱼活动期间不做逐档抠零头（攒着，够了一次兑光）",
  );
  assert.equal(h.state.boxPoint, 999, "积分应原样留着");
  assert.ok(
    h.logs.some((l) => l.message.includes("未到一键兑换门槛")),
    "应说明为何本次不兑换",
  );
  assert.equal(h.errorLogs().length, 0);
});

// -------------------------------------------- 无箱可开救援循环（2026-09-29 深夜口径）

test("宝箱消耗：无箱可开 → 一键领取 + 开普通道具救援，铂金箱回流完成目标（39b 案例）", async () => {
  // 线上 39b 画像：木箱 204（保留 200 → 可开 4 < 一批）、未兑换 57,960、普通道具没开 ⇒ 旧版直接暂停
  const h = createHarness({
    state: {
      boxScoreDone: 0,
      boxPoint: 57960,
      boxPointLastReward: 0,
      wooden: 204,
      packs: 1000,
    },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 1000 });

  // 救援链路日志：领取 → 开包 → 救援成功
  assert.ok(
    h.logs.some((l) => l.message.includes("一键领取换宝箱")),
    "应有「一键领取换宝箱」救援日志",
  );
  assert.ok(
    h.logs.some((l) => l.message.includes("开普通道具(5287)")),
    "应开普通道具",
  );
  assert.ok(
    h.logs.some((l) => l.message.includes("领取/开包救援成功")),
    "应打救援成功日志",
  );
  // 开包帧：1000 个 = 999 + 1 两批
  const packs = h.sent
    .filter((s) => s.cmd === "item_openpack")
    .map((s) => s.params);
  assert.deepEqual(
    packs.map((p) => p.number),
    [999, 1],
    `开包应按 999 上限分批（实际 ${JSON.stringify(packs)}）`,
  );
  assert.ok(
    packs.every((p) => p.itemId === 5287 && p.index === 0),
    "开包命令字段应对齐抓包（itemId 5287 / index 0）",
  );
  // 一键领取发生（≥ 门槛）
  assert.ok(
    h.sent.some((s) => s.cmd === "item_batchclaimboxpointreward"),
    "未兑换 ≥ 1000 应一键领取",
  );
  // 1000 包 × 0.205 = 205 铂金回流 → 目标 1000 达成 → 成功结束而非暂停
  assert.ok(
    h.logs.some((l) => l.message.includes("宝箱消耗结束")),
    "救援后应完成目标",
  );
  assert.ok(!h.logs.some((l) => l.message.includes("宝箱消耗暂停")));
  assert.equal(h.errorLogs().length, 0);
});

test("宝箱消耗：救援后仍无可开积分 → 暂停（未达门槛不兑 + 普通道具已开尽）", async () => {
  const h = createHarness({
    state: {
      boxScoreDone: 0,
      boxPoint: 999, // < 1000 → 不兑
      wooden: 204, // 保留 200 → 可开 4 < 一批
      packs: 10, // 开出 round(10×0.205)=2 铂金 → 凑不满一批
    },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 99000 });

  assert.equal(
    h.sent.filter((s) => s.cmd === "item_openpack").length,
    1,
    "普通道具应被开掉（10 个一批）",
  );
  assert.equal(
    h.sent.filter((s) => s.cmd === "item_batchclaimboxpointreward").length,
    0,
    "未达门槛不发一键兑换",
  );
  const pause = h.logs.find((l) => l.message.includes("宝箱消耗暂停"));
  assert.ok(pause, "应有暂停日志");
  assert.ok(pause.message.includes("未达门槛不兑"), pause.message);
  assert.ok(pause.message.includes("已开尽"), pause.message);
  assert.equal(h.errorLogs().length, 0);
});

test("宝箱消耗：循环内领取后开普通道具，铂金箱回流进开箱/精确开箱", async () => {
  const h = createHarness({
    state: {
      boxScoreDone: 0,
      boxPoint: 1200,
      boxPointLastReward: 0,
      platinum: 20, // round1 开 2 批 = +1000 分
      packs: 100, // 领取后开包 → round(100×0.205)=21 铂金回流
    },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 1500 });

  assert.equal(
    h.sent.filter((s) => s.cmd === "item_openpack").length,
    1,
    "循环内应开一次普通道具（100 个 ≤ 999 一批）",
  );
  assert.ok(
    h.sent.some((s) => s.cmd === "item_batchclaimboxpointreward"),
    "1200 ≥ 1000 应一键领取",
  );
  // 开箱帧全为整批铂金：round1 2 批 + 精确开箱 1 批 = 3 批
  const opens = h.sent
    .filter((s) => s.cmd === "item_openbox")
    .map((s) => s.params);
  assert.ok(
    opens.every((o) => o.itemId === 2004 && o.number === OPENBOX_BATCH_SIZE),
    `开箱帧应全是整批铂金（实际 ${JSON.stringify(opens)}）`,
  );
  assert.equal(opens.length, 3, `应共开 3 批（实际 ${opens.length}）`);
  assert.equal(h.state.boxScoreDone, 1500, "累积应到 1500");
  assert.ok(h.logs.some((l) => l.message.includes("宝箱消耗结束")));
  assert.equal(h.errorLogs().length, 0);
});

// -------------------------------------------- 邮件领取（2026-09-30 master 口径）

test("金鱼消耗编排：宝箱周未满 32000 不领邮件（每 8000 分 1 轮 × 最多 4 轮，别收早了）", async () => {
  const h = createHarness({
    state: { boxScoreDone: 31000, wooden: 220 }, // 本轮开 20 分 → 31020 仍 < 32000
  });
  await h.tasks.goldenfishConsumeAll({ boxTarget: 31010 });

  assert.equal(
    h.sent.filter((s) => s.cmd === "mail_claimallattachment").length,
    0,
    "累积未到 32000 不该领邮件",
  );
  const skip = h.logs.find((l) => l.message.includes("邮件领取跳过"));
  assert.ok(skip, "应有跳过日志");
  assert.ok(skip.message.includes("未满不领"), skip.message);
  assert.ok(skip.message.includes("别收早了"), skip.message);
  assert.equal(h.errorLogs().length, 0);
});

test("金鱼消耗编排：累积 ≥ 32000 → 编排末尾领取邮件（4 轮全出再收）", async () => {
  const h = createHarness({
    state: { boxScoreDone: 32000, wooden: 220 },
  });
  await h.tasks.goldenfishConsumeAll({ boxTarget: 32000 });

  const mails = h.sent.filter((s) => s.cmd === "mail_claimallattachment");
  assert.equal(mails.length, 1, "应且仅应发一帧邮件领取");
  assert.deepEqual(mails[0].params, { category: 0 });
  // 位置在编排最后：邮件帧之后不应再有任何消耗帧
  const mailIdx = h.sent.findIndex((s) => s.cmd === "mail_claimallattachment");
  const tail = h.sent.slice(mailIdx + 1).filter((s) =>
    ["hero_recruit", "item_openbox", "artifact_lottery"].includes(s.cmd),
  );
  assert.equal(tail.length, 0, "邮件帧应是编排最后一步");
  assert.ok(
    h.logs.some((l) => l.message.includes("邮件奖励已领取")),
    "应打领取日志",
  );
  assert.equal(h.errorLogs().length, 0);
});

test("独立领取邮件：goldenfishClaimMail 只发一帧 mail_claimallattachment（需累积 ≥ 32000）", async () => {
  const h = createHarness({ state: { boxScoreDone: 57590 } });
  await h.tasks.goldenfishClaimMail({});

  const mails = h.sent.filter((s) => s.cmd === "mail_claimallattachment");
  assert.equal(mails.length, 1, "应且仅应发一帧邮件领取");
  assert.deepEqual(mails[0].params, { category: 0 });
  assert.ok(
    h.logs.some((l) => l.message.includes("邮件奖励已领取")),
    "应打领取日志",
  );
  assert.equal(h.errorLogs().length, 0);
});

// -------------------------------------------- 第一阶段流水线：领奖 → 开包 → 清空 → 升星

test("第一阶段第2步：领取所有进度奖励（按达标轮次补领，已领跳过）", async () => {
  const h = createHarness({
    state: {
      recruitDone: 3900,
      boxScoreDone: 99000,
      fishDone: 1140,
      jarDone: 60,
      record: { 1: 1790578205 }, // 已领：招募第 1 轮（missionId 1）
    },
  });
  await h.tasks.goldenfishClaimProgressRewards({});

  const expected = [];
  for (const [slot, value] of Object.entries({ 1: 3900, 2: 99000, 3: 1140, 4: 60, 5: 0 })) {
    const done = completedRounds(Number(slot), value);
    for (let round = 1; round <= done; round += 1) {
      const mid = toMissionId(Number(slot), round);
      if (mid !== 1) expected.push(mid);
    }
  }
  assert.deepEqual(
    h.claimedMissionIds,
    expected,
    "补领的 missionId 序列应等于「达标轮次 − 已领」",
  );
  assert.ok(!h.claimedMissionIds.includes(1), "已领的 missionId 不该重领");
  // 🔴 请求体必须带 activityId（master 2026-09-30 抓包实证：{activityId, missionId}）
  for (const frame of h.sent.filter((s) => s.cmd === "activity_claimtaskreward")) {
    assert.deepEqual(
      frame.params,
      { activityId: 2609251, missionId: frame.params.missionId },
      `领奖请求体应对齐抓包：${JSON.stringify(frame.params)}`,
    );
  }
  assert.ok(h.logs.some((l) => l.message.includes("进度奖励补领")));
  assert.ok(
    h.logs.some((l) => l.message.includes("record 校验全部入账")),
    "领取后应回读 record 校验",
  );
  assert.equal(h.errorLogs().length, 0);
});

test("第一阶段第3步：金鱼普通道具(5287)全部开掉，特殊道具(5288)绝不动", async () => {
  const h = createHarness({
    state: { packs: 1000, extraItems: { 5288: { quantity: 174 } } },
  });
  await h.tasks.goldenfishOpenPacks({});

  const ops = h.sent
    .filter((s) => s.cmd === "item_openpack")
    .map((s) => [s.params.itemId, s.params.number]);
  assert.deepEqual(ops, [[5287, 999], [5287, 1]], "1000 个 5287 按 999+1 两批开完");
  assert.ok(!ops.some(([id]) => id === 5288), "硬通货 5288 绝不开");
  assert.equal(h.errorLogs().length, 0);
});

test("第一阶段第4步：清空普通道具 = 非金鱼道具（5288/5286 与 52xx 金鱼段绝不开）", async () => {
  const h = createHarness({
    state: {
      extraItems: {
        3005: { quantity: 1200 }, // 英雄碎片包（非金鱼）→ 应开
        5264: { quantity: 30 }, // 52xx 金鱼段 → 不自动清
        5287: { quantity: 50 }, // 金鱼普通道具 → 由第 3 步开，不在本步
        5288: { quantity: 9 }, // 金鱼特殊道具（硬通货）
        5286: { quantity: 9 }, // 投道具用道具
      },
    },
  });
  await h.tasks.goldenfishClearItems({});

  const ops = h.sent
    .filter((s) => s.cmd === "item_openpack")
    .map((s) => [s.params.itemId, s.params.number]);
  assert.deepEqual(ops, [[3005, 999], [3005, 201]], "只清非金鱼段（3005 ×1200 → 999+201）");
  assert.ok(
    !ops.some(([id]) => [5264, 5287, 5288, 5286].includes(id)),
    "52xx 金鱼段与保护名单道具绝不被本步清空",
  );
  assert.ok(h.logs.some((l) => l.message.includes("清空普通道具完成")));
  assert.equal(h.errorLogs().length, 0);
});

test("第一阶段第5~7步：英雄升星→图鉴升星→领图鉴奖励（因果链按序）", async () => {
  const h = createHarness({ state: { heroUpOk: 3, bookUpOk: 2, starClaimOk: 1 } });
  await h.tasks.goldenfishUpgradeChain({});

  const cmds = h.cmds();
  const iHero = cmds.indexOf("hero_heroupgradestar");
  const iBook = cmds.indexOf("book_upgrade");
  const iClaim = cmds.indexOf("book_claimpointreward");
  assert.ok(iHero >= 0, "应有英雄升星帧");
  assert.ok(iBook > iHero, `图鉴升星应在英雄升星之后：${cmds.join(",")}`);
  assert.ok(iClaim > iBook, `领图鉴奖励应在图鉴升星之后：${cmds.join(",")}`);
  assert.ok(
    h.logs.some((l) =>
      l.message.includes("资源升级链完成：英雄升星 3 / 图鉴升星 2 / 领图鉴奖励 1"),
    ),
    "应打链路统计",
  );
  assert.equal(h.errorLogs().length, 0);
});

test("第一阶段全流程：消耗 → 开包 → 清空 → 升星 → 邮件（顺序断言，无领奖）", async () => {
  const h = createHarness({
    state: {
      recruitDone: 3900, // 已达标 → 不跑
      boxScoreDone: 98000,
      wooden: 1200, // 保留 200 → 可开 1000 分 → 补齐 99000
      fishDone: 1140, // 已达标 → 不跑
      packs: 10,
      extraItems: { 3005: { quantity: 5 } },
      heroUpOk: 1,
    },
  });
  await h.tasks.goldenfishConsumeAll({
    recruitTarget: 3900,
    boxTarget: 99000,
    fishTarget: 1140,
  });

  const cmds = h.cmds();
  const firstOpenbox = cmds.indexOf("item_openbox");
  const packIdx = h.sent.findIndex(
    (s) => s.cmd === "item_openpack" && s.params.itemId === 5287,
  );
  const clearIdx = h.sent.findIndex(
    (s) => s.cmd === "item_openpack" && s.params.itemId === 3005,
  );
  const heroIdx = cmds.indexOf("hero_heroupgradestar");
  const mailIdx = cmds.indexOf("mail_claimallattachment");

  assert.ok(firstOpenbox >= 0, "应有开箱帧");
  assert.ok(packIdx > firstOpenbox, "清空道具应在开包之后");
  assert.ok(heroIdx > clearIdx, "升星链应在清空之后");
  assert.ok(mailIdx > heroIdx, "邮件应在最后");
  // 🔴 领取进度奖励已移出编排（游戏内手动领取）
  assert.equal(
    h.sent.filter((s) => s.cmd === "activity_claimtaskreward").length,
    0,
    "编排内不应有领奖帧",
  );
  assert.equal(h.errorLogs().length, 0);
});

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
  // claimMail 依赖活动进度做「宝箱周 ≥ 32000」闸门 —— 进度不可读时宁可不领，不可收早
  assert.ok(
    !sent.some((s) => s.cmd === "mail_claimallattachment"),
    "进度不可读时不应领邮件（无法核对收取时机）",
  );
  // 每个消耗 step（含邮件领取）都必须有「进度不可读」日志
  const unreadable = logs.filter((l) => l.message.includes("进度不可读"));
  assert.equal(unreadable.length, 4);
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

test("阶段B 真实数据：残缺 task 表（只有 task.1）→ 缺槽位按 0，宝箱/钓鱼正常执行", async () => {
  // 2026-09-30 抓包 9721_fishing_start.jsonl 铁证：没钓过鱼的号 activity_get 里
  // 2609251.task = {1,2,4,5}（唯独没有 3）⇒ 服务端对零进度任务不下发键。
  // 旧行为「缺 task.2/3 → 整步跳过」被废弃（会永久卡住钓鱼进度）。
  const h = createRealActivityHarness({
    commonActivityInfo: {
      2609251: { task: { 1: 3685 }, isBought: false },
      2609252: { isBought: false },
    },
    items: { 1012: { quantity: 500 }, 1001: { quantity: 0 } },
  });
  await h.tasks.goldenfishConsumeAll({ recruitTarget: 3900, boxTarget: 99000, fishTarget: 1140 });

  // 缺槽位不再「缺字段跳过」
  assert.ok(!h.logs.some((l) => l.message.includes("缺 task.2（宝箱）")));
  assert.ok(!h.logs.some((l) => l.message.includes("缺 task.3（钓鱼）")));
  // 钓鱼按库存 500 根正常执行 → 50 帧 ×10
  const fish = h.sent.filter((s) => s.cmd === "artifact_lottery");
  assert.equal(fish.length, 50);
  assert.ok(fish.every((s) => s.params.lotteryNumber === 10));
  // 宝箱：零可开箱 → 走救援后暂停（不发 item_openbox）
  assert.ok(!h.sent.some((s) => s.cmd === "item_openbox"));
  assert.ok(h.logs.some((l) => l.message.includes("无箱可开")));
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

/** 三路都有活干的状态：招募差 100 / 宝箱差 100 分 / 钓鱼差 100 次（库存均够）
 *  宝箱给「青铜 20」而不是「铂金 2」：整批口径下铂金 2 个开不动，青铜 20 恰好够两批 */
const PARALLEL_STATE = {
  recruitDone: 3800,
  recruitTickets: 120,
  boxScoreDone: 98900,
  bronze: 20,
  fishDone: 1000,
  goldRods: 120,
};
const PARALLEL_CONFIG = { recruitTarget: 3900, boxTarget: 99000, fishTarget: 1100 };

test("并行：招募/宝箱/钓鱼 三路并行（2026-09-30 恢复，真凶余数批已定案）", async () => {
  const h = createHarness({ state: PARALLEL_STATE });
  await h.tasks.goldenfishConsumeAll({ ...PARALLEL_CONFIG });

  const parallelLog = h.logs.find((l) => l.message.includes("并行执行"));
  assert.ok(parallelLog, "应有并行执行日志");
  assert.ok(
    parallelLog.message.includes("3 个消耗任务"),
    `应为 3 个并行：${parallelLog.message}`,
  );
  for (const id of ["consumeRecruit", "consumeBoxes", "consumeFish"]) {
    assert.ok(parallelLog.message.includes(id), `并行段应含 ${id}：${parallelLog.message}`);
  }

  // 三路命令都发出且都推进到位
  assert.ok(h.sent.some((s) => s.cmd === "hero_recruit"), "招募应有帧");
  assert.ok(h.sent.some((s) => s.cmd === "item_openbox"), "宝箱应有帧");
  assert.ok(h.sent.some((s) => s.cmd === "artifact_lottery"), "钓鱼应有帧");
  assert.equal(h.state.recruitDone, 3900);
  assert.equal(h.state.fishDone, 1100);
  assert.equal(h.state.boxScoreDone, 99000);
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

// -------------------------------- 宝箱库存日志 / 拒绝诊断 / 并发闸门 / 租约

test("宝箱消耗：日志打真实宝箱库存（不能再是占位符 0）", async () => {
  const h = createHarness({
    state: { boxScoreDone: 0, platinum: 25, bronze: 7 },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 200 });

  const inv = h.logs.find((l) => l.message.includes("宝箱库存："));
  assert.ok(inv, "应有宝箱库存日志");
  assert.ok(
    inv.message.includes("木箱0 青铜7 黄金0 铂金25 钻石0"),
    `库存应逐箱型打印真实数量：${inv.message}`,
  );
  assert.ok(inv.message.includes("可开积分约"), `应给出可开积分：${inv.message}`);
  assert.ok(
    !h.logs.some((l) => l.message.includes("宝箱库存 0")),
    "不应再出现「宝箱库存 0」占位符",
  );
});

test("宝箱消耗：三次重试全被拒 → 诊断一次给全（计划/已开/被拒帧/重读），并标记步骤失败", async () => {
  const h = createHarness({
    state: { boxScoreDone: 98000, platinum: 2, bronze: 20, openboxAlwaysFail: true },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 99000 });

  assert.equal(
    h.logs.filter((l) => l.message.includes("宝箱数量已变化")).length,
    2,
    "应有 2 条重试日志（首次 + 2 次重试 = 3 次尝试）",
  );
  const finalLog = h.logs.find((l) => l.message.includes("开箱被服务端拒绝"));
  assert.ok(finalLog, "应有「开箱被服务端拒绝」的最终诊断");
  assert.ok(
    finalLog.message.includes("第 3 次") && finalLog.message.includes("计划 "),
    `最终诊断应含第几次与计划：${finalLog.message}`,
  );
  assert.ok(
    finalLog.message.includes("被拒帧 itemId 2002 × 10"),
    `最终诊断应含被拒帧实参（整批口径下首帧为青铜 2002×10）：${finalLog.message}`,
  );
  assert.ok(
    h.logs.some((l) => l.message.includes("诊断：开箱前读到的库存")),
    "应打印开箱前库存快照",
  );
  assert.ok(
    h.logs.some((l) => l.message.includes("两次读到的宝箱数量一致")),
    "未成功开箱时两次读应一致",
  );
  assert.ok(
    h.logs.some((l) => l.message.includes("consumeBoxes 失败")),
    "应把该步骤标记为失败并继续后续",
  );
  // 服务端绝对计数器：库存行打基线、失败时打前后对比、并给出并发判定
  assert.ok(
    h.logs.some((l) => l.message.includes("服务端计数器 today:open:box=")),
    "宝箱库存行应带服务端计数器基线",
  );
  assert.ok(
    h.logs.some((l) => l.message.includes("🔎 开箱计数器（服务端累计，非本机口径）")),
    "最终诊断应打印计数器前后对比",
  );
  assert.ok(
    h.logs.some((l) => l.message.includes("ℹ️ 并发判定")),
    "计数器涨幅 ≤ 本机帧数 → 应判定「无第三方并发」",
  );
  assert.ok(
    h.logs.some((l) => l.message.includes("没有第三方在开这个号")),
    "应明确指出不是并发，而是服务端判定口径与 role.items 不一致",
  );
});

test("宝箱消耗：服务端计数器涨幅 > 本机帧数 → 判定确有第三方在开同一个号", async () => {
  const h = createHarness({
    state: {
      boxScoreDone: 98000,
      platinum: 2,
      bronze: 20,
      openboxAlwaysFail: true,
      // 本机每帧 +1，别处再加 4 次 → 涨幅 5、本机帧数 1、多出 4（= 别处的调用次数）
      phantomCallsPerOpenbox: 4,
    },
  });
  await h.tasks.goldenfishBoxes({ boxTarget: 99000 });

  const verdict = h.logs.find((l) => l.message.includes("🚨 并发判定"));
  assert.ok(verdict, "应有并发判定告警");
  assert.ok(
    verdict.message.includes("只发了 1 帧"),
    `应报出本机实际帧数：${verdict.message}`,
  );
  assert.ok(
    verdict.message.includes("确有另一个客户端/运行在开同一个角色"),
    `应给出「确有第三方并发」的结论：${verdict.message}`,
  );
  assert.ok(
    verdict.message.includes("多出 4 次不是本机发的"),
    `应给出多出的调用次数：${verdict.message}`,
  );
  assert.ok(
    !h.logs.some((l) => l.message.includes("ℹ️ 并发判定")),
    "不应同时给出「无第三方并发」的相反结论",
  );
});

test("并发闸门：已有消耗在跑时第二次启动被拒绝（同一页面不叠加运行）", async () => {
  const h = createHarness({ state: PARALLEL_STATE });
  const first = h.tasks.goldenfishConsumeAll(PARALLEL_CONFIG);
  const framesAfterFirst = h.sent.length;
  // 第一轮尚未结束 → 第二次必须直接拒绝，不能并发开同一个号的箱子
  await h.tasks.goldenfishConsumeAll(PARALLEL_CONFIG);
  assert.ok(
    h.warnings.some((w) => w.includes("已有金鱼任务正在运行")),
    "第二次启动应被拒绝",
  );
  await first;
  assert.ok(h.sent.length >= framesAfterFirst);
  assert.equal(h.errorLogs().length, 0);
});

// ------------------------------------------------- 角色租约（跨标签页互斥）

/** 假 localStorage（Map 版；补齐 length/key —— 卸载释放会按前缀扫描） */
function fakeLocalStorage(entries = []) {
  const store = new Map(entries);
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}

/** 假 sessionStorage（标签页身份：同一个 id 代表「同一个标签页」） */
function fakeSessionStorage(tabId) {
  const store = new Map(tabId ? [["xyzw:goldenfish:tabId", tabId]] : []);
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

/** 在指定 storage/window 环境下跑一段代码，结束后还原全局（裸 node 默认三者都 undefined） */
async function withStorageEnv(env, fn) {
  const keys = ["localStorage", "sessionStorage", "window"];
  const origin = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
  for (const k of keys) {
    if (k in env) globalThis[k] = env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (origin[k] === undefined) delete globalThis[k];
      else globalThis[k] = origin[k];
    }
  }
}

const LEASE_KEY = "xyzw:goldenfish:consumeLease:9701-100001";

test("并发租约：另一个标签页持有该角色租约 → 跳过该角色且不发任何帧（并打出持有者/续租时间）", async () => {
  // 裸 node 无 localStorage → 注入假的，模拟「另一个标签页正在跑同一个角色」。
  // 键是**角色维度**（serverId-roleId），不是 token 条目 id。
  const ls = fakeLocalStorage([[LEASE_KEY, JSON.stringify({ tab: "other-tab", at: Date.now() - 3000 })]]);
  await withStorageEnv({ localStorage: ls, sessionStorage: fakeSessionStorage("tab-mine") }, async () => {
    const h = createHarness({ state: { recruitDone: 3800, recruitTickets: 500 } });
    await h.tasks.goldenfishRecruit({ recruitTarget: 3900 });

    assert.equal(h.sent.length, 0, "抢不到租约时不应发任何帧");
    const skip = h.logs.find((l) => l.message.includes("跳过"));
    assert.ok(skip, "应给出租约跳过日志");
    assert.ok(
      skip.message.includes("另一个标签页/窗口正在操作该角色"),
      `应说明是跨标签页占用：${skip.message}`,
    );
    assert.ok(skip.message.includes("持有者 other-tab"), `应打出持有者：${skip.message}`);
    assert.ok(skip.message.includes("秒前"), `应打出最后续租距今多久：${skip.message}`);
    assert.ok(
      !skip.message.includes("宝箱数量已发生变化"),
      `跳过理由不该再引已证伪的并发→报错因果：${skip.message}`,
    );
  });
});

test("并发租约：sessionStorage 同 id（同一个标签页）留下的旧租约不算「另一个标签页」→ 正常接管", async () => {
  // 旧实现按「createTasksGoldenfish 实例」生成 tab id ⇒ 同页先后两次运行会互认成别的标签页，
  // 页面重载后的新实例也认不出自己刚写的租约；改成「标签页」维度后必须能接管。
  const ls = fakeLocalStorage([[LEASE_KEY, JSON.stringify({ tab: "tab-same", at: Date.now() })]]);
  await withStorageEnv({ localStorage: ls, sessionStorage: fakeSessionStorage("tab-same") }, async () => {
    const h = createHarness({ state: { recruitDone: 3850, recruitTickets: 500 } });
    await h.tasks.goldenfishRecruit({ recruitTarget: 3900 });

    assert.equal(h.sent.filter((s) => s.cmd === "hero_recruit").length, 5, "自己的旧租约应被接管并正常发帧");
    assert.ok(!h.logs.some((l) => l.message.includes("跳过")), "不该出现跳过日志");
  });
});

test("并发租约：pagehide（关标签页/刷新）归还本标签页的租约，不留僵尸（且不误删别人的）", async () => {
  const OTHER_KEY = "xyzw:goldenfish:consumeLease:9701-999999";
  const ls = fakeLocalStorage([[OTHER_KEY, JSON.stringify({ tab: "other-tab", at: Date.now() })]]);
  const listeners = [];
  const fakeWindow = { addEventListener: (type, fn) => listeners.push({ type, fn }) };

  await withStorageEnv(
    { localStorage: ls, sessionStorage: fakeSessionStorage("tab-mine"), window: fakeWindow },
    async () => {
      const h = createHarness({ state: { recruitDone: 3850, recruitTickets: 500 } });
      await h.tasks.goldenfishRecruit({ recruitTarget: 3900 });

      // 跑完后租约本来就释放了 → 手工放一份自己的，模拟「跑到一半被刷新/关页」
      ls.setItem(LEASE_KEY, JSON.stringify({ tab: "tab-mine", at: Date.now() }));

      const hook = listeners.find((x) => x.type === "pagehide");
      assert.ok(hook, "应注册 pagehide 卸载钩子");

      // bfcache（persisted=true）时页面还会回来 → 不能归还租约
      hook.fn({ persisted: true });
      assert.ok(ls.getItem(LEASE_KEY) != null, "进 bfcache 时不应归还租约");

      hook.fn({ persisted: false });
      assert.equal(ls.getItem(LEASE_KEY), null, "自己的租约应在真正卸载时归还");
      assert.ok(ls.getItem(OTHER_KEY) != null, "别人的租约不能被误删");
    },
  );
});

test("同批重复导入：两条 token 指向同一角色 → 只跑第一条，另一条跳过", async () => {
  // 无 localStorage（裸 node）→ 跨页租约降级放行，但**同轮角色去重**必须仍然生效
  const logs = [];
  const sent = [];
  const ref = (v) => ({ value: v });
  const tokenStore = {
    sendMessageWithPromise: async (tokenId, cmd, params) => {
      sent.push({ tokenId, cmd, params });
      if (cmd === "role_getroleinfo") return { role: { items: { 1001: { quantity: 500 } } } };
      return {};
    },
    closeWebSocketConnection: () => {},
  };
  const tasks = createTasksGoldenfish({
    selectedTokens: ref(["a", "b"]),
    // 两条 token，id/name 不同，但 serverId-roleId 完全相同
    tokens: ref([
      { id: "a", name: "大号", serverId: 9724, roleId: 625228095 },
      { id: "b", name: "大号(副本)", serverId: 9724, roleId: 625228095 },
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

  // 只有一条 token 真的发了帧；另一条在租约闸门就被拦下
  assert.deepEqual([...new Set(sent.map((s) => s.tokenId))], ["a"], "只应有第一条 token 发帧");
  assert.ok(
    logs.some((l) => l.message.includes("本批里有另一条 token 指向同一个角色")),
    "应给出重复导入跳过日志",
  );
  assert.equal(logs.filter((l) => l.type === "error").length, 0);
});
