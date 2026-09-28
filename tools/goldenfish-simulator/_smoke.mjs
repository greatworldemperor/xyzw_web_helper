// 模拟器引擎自测（node tools/goldenfish-simulator/_smoke.mjs）
//
// 六个场景（D/E/F 的细节写在各场景注释里）：
//   A. 抓包账号真实快照 —— 走完周四标准流程（补满 → 领奖 → 开道具 → 买鱼竿推钓鱼到 1750）。
//      这是最有价值的场景：它同时检验「达成一轮领一轮」的补领、四类返还、金砖同时推两任务。
//   B. 资源拉满 —— 一定应该成功凑满 250，用来锁住「成功路径」的账目自洽。
//   C. 五类档位全满 + 档位已全领 + 手里没货 —— 必须**诚实报错**（原文第 136 行），
//      而且不能空花金砖/空买鱼竿（这是「榨干上限后立刻收工」的回归）。
//   D. master 实测复盘（金砖不足 ≠ 档位榨干）／E. 2换1 策略观察点 ／ F. 兜底补一轮金砖。
//
// 🔴 2026-09-28 master 四条澄清 + 「有保底」二次修正后的口径：
//   · 开普通道具产出特殊道具 = round(普通道具数 × 0.25 + bias)，bias ∈ [-5,5] 整数、概率线性
//     （**没有 packGuarantee / normalRandom / clt-normal 了**，模型名 = bounded-linear-bias）
//   · 钓鱼 1300 是**下限**（fillupFishTarget），硬上限是 1750（fishCap）
//   · 买鱼竿的金砖计入金砖消耗任务（这正是完成该任务的主要手段）
import assert from "node:assert/strict";
import { runFullSimulation } from "./engine.js";
import { toMissionId } from "../../src/utils/goldenfishFinishPlan.js";

const BASE = {
  seed: 20260928,
  items: {
    1001: 5000, // 招募令
    1012: 2000, // 黄金鱼竿
    2001: 300, // 木制宝箱（留 200 不动）
    2002: 500, // 青铜
    2003: 200, // 黄金
    2004: 100, // 铂金
    2005: 20, // 钻石（一律不开）
  },
  task: { 1: 3685, 2: 96530, 3: 1140, 4: 632, 5: 20389 },
  record: { 1: 1759000001, 21: 1759000021, 41: 1759000041, 61: 1759000061, 81: 1759000081 },
  gold: 1000000,
  boxPoint: 5000,
  boxPointLastReward: 0,
  recruitTarget: 3900,
  boxTarget: 99000,
  fishTarget: 1140,
  targetSpecial: 250,
  packRate: 0.25, // 单次期望出率 p（有保底：结果 = round(n×p + bias)，bias∈[-5,5]）
  rodPrice: 600, // 金砖消耗 = 买原价鱼竿（原文第 135 行）
  fishCap: 1750, // 钓鱼**硬上限** = 20 轮全满
  fillupFishTarget: 1300, // 周四「先补满」的下限（master 第 4 条）
  fillupFish: true, // 周四先补到 1300，再看情况继续
  strategy: "master", // 原文第 134-135 行口径
};

/** 五类档位全部领完的 record（场景 C 用：让领奖阶段无事可做） */
const ALL_CLAIMED = (() => {
  const out = {};
  for (const slot of [1, 2, 3, 4, 5]) {
    for (let round = 1; round <= 20; round += 1) out[toMissionId(slot, round)] = 1759000000;
  }
  return out;
})();

const SCENARIOS = [
  {
    name: "A. 抓包账号 · 周四标准流程（补满 → 领奖 → 开道具 → 买鱼竿推钓鱼到 1750）",
    preset: { ...BASE },
    opensPacks: true,
    expectOk: true,
  },
  {
    name: "B. 资源拉满 + 运气好（seed 32 ⇒ 应凑满 250）",
    preset: {
      ...BASE,
      seed: 32,
      items: { ...BASE.items, 1001: 20000, 1012: 5000, 2002: 6000, 2003: 4000, 2004: 2500 },
      gold: 3000000,
      boxPoint: 0,
    },
    opensPacks: true,
    expectOk: true,
  },
  {
    name: "C. 五类档位全满 + 档位已全领 + 手里没货 ⇒ 必须诚实报错",
    preset: {
      ...BASE,
      task: { 1: 4000, 2: 100000, 3: 1750, 4: 60, 5: 500000 },
      record: { ...ALL_CLAIMED },
      items: { ...BASE.items, 1001: 20000, 1012: 0 },
      gold: 3000000,
      boxPoint: 0,
    },
    opensPacks: false,
    expectOk: false,
    // 🔴 金砖管够（300 万）都凑不够 ⇒ 这才是「档位榨干」
    expectBlockedBy: "tiers",
    expectReachable: false,
    expectFishMin: 1750, // 资源充足 ⇒ 钓鱼本就该被推到硬上限
  },
  {
    /**
     * 🔴 D 场景 = 2026-09-28 master 实测日志（`local-data/goldenfish/simu_log.txt`）的场景
     *    **+ 鱼竿 10% 返还新口径**（master：「x 个鱼竿可以得到 x/0.9 的消耗量」）。
     *
     * 当时引擎报「做满也凑不够」，master 一眼看出不对：
     * 「已经打开了 754 个普通道具，开出 201 个特殊道具，你居然说最终做满也拿不到鱼……
     *   注意金砖任务本身也是有奖励的，不要漏了。」
     *
     * 新口径下的账目（返还让 1,000 根库存可钓 1,111 次 ⇒ 钓鱼多跨 1 档）：
     *   - 历次已领 20 个（record 5 档）+ 本次待领 774 个（72 档）+ 剩余档位 256 个 = 1050 ✅
     *   - 本次可用 1030 个 ≈ 257 个特殊道具 ≥ 250 ⇒ **做满本可以拿鱼**
     *   - 只失败在「开完道具才返 ~83,053 金砖，只买得起 138 根杆」（所以 gold 预设 0）
     */
    name: "D. master 实测复盘：金砖不足（不是档位榨干）⇒ 做满本可以拿鱼",
    preset: {
      ...BASE,
      items: { 1001: 4000, 1012: 1000, 2001: 5300, 2002: 2000, 2003: 500, 2004: 1300, 2005: 0 },
      task: { 1: 0, 2: 0, 3: 0, 4: 60, 5: 20000 },
      record: { 1: 1, 21: 1, 41: 1, 61: 1, 81: 1 }, // 每类第 1 轮已领 = 20 个道具
      gold: 0,
      boxPoint: 0,
    },
    opensPacks: true,
    expectOk: false,
    expectBlockedBy: "gold",
    expectReasonPrefix: "金砖不足",
    expectReachable: true, // 复盘必须说出「做满本可以拿鱼」
    spendsBeforeFail: true, // 金砖不足 ⇒ 先买得起的 138 根，再报错
    expectLedger: { claimedItems: 20, pendingItems: 774, restItems: 256, usable: 1030 },
    expectIdealGoldNeeded: 397200, // 收尾收工时把剩余档位做满还需的金砖
    // 这个场景开局金砖为 0（要等开完道具才返金砖）⇒ 周四「补满」阶段推不动钓鱼
    expectFishMin: 0,
  },
  {
    /**
     * 🔴 E 场景 = master 2026-09-28 拍板的「2 轮金砖换 1 轮钓鱼」策略（观察点精确复刻）：
     *
     * 原话：「最后一天先做到宝箱招募做满，金砖 38 万 / 钓鱼 1300 次的状态，
     *        然后判断后续差距，找到任意一个可行解，
     *        然后判断，如果存在用 2 轮金砖换一轮钓鱼的机会，那就换。」
     *
     * 观察点账目：五类累计 400+200+208+20+114 = **942 个道具** ≈ 235.5 特殊（不够 250）；
     * 剩余档位 = 金砖 3 轮（12 万金砖 → 36）+ 钓鱼 3 轮（450 次 → 72）。
     * 2 换 1 数学：1 轮钓鱼（tier6 150 次）= 135 根杆（10% 返还）= 81,000 金砖 ≈ 2 轮金砖（80,000）
     * → 杆钱计入金砖任务 ⇒ 金砖跨过 46 万（轮 19）、钓鱼白捡一档（24 道具）。
     */
    name: "E. master 拍板策略：观察点（38万/1300）→ 2 轮金砖换 1 轮钓鱼",
    preset: {
      ...BASE,
      task: { 1: 4000, 2: 100000, 3: 1300, 4: 60, 5: 380000 },
      record: {}, // 观察点尚未领奖 ⇒ 收尾先补领 942 个再开
      items: {}, // 手上没货（观察点 = 刚做完消耗、还没开道具）
      gold: 300000, // 金砖库存充足（实际花不了这么多）
      boxPoint: 0,
      fillup: false, // 已在观察点，不再补满
      strategy: "twoForOne",
    },
    opensPacks: true,
    expectOk: true,
    expectTrade: true,
    expectLedger: { claimedItems: 0, pendingItems: 942, restItems: 108, usable: 1050 },
  },
  {
    /**
     * 🔴 F 场景 = 2026-09-28 master 拍板的「最后兜底：补一轮金砖」：
     *
     * 原话：「最后的兜底手段——如果运气不好还差几个特殊道具的话，就补一轮金砖……
     *        补一轮金砖一定会够的，不存在补不够的情况」（游戏强控制出率贴 25%，偏差极小）。
     *
     * 构造：观察点 + twoForOne + **maxIterations=1**（强测兜底路径）⇒
     * 主循环只跑一轮 2换1（81,000 → 金砖 46.1 万/轮 19、钓鱼 1450/轮 18）就被迭代上限掐断，
     * 缺口剩 1~3 个 ⇒ 兜底买 65 根（39,000 金砖）恰好跨过第 20 轮（50 万）→ +12 道具 → 达标。
     * seed 2 已验证确定性：251/250，总支出 120,000。
     */
    name: "F. 最后兜底：主循环被迭代上限掐断 → 补一轮金砖（第 20 轮）救场",
    preset: {
      ...BASE,
      seed: 2,
      task: { 1: 4000, 2: 100000, 3: 1300, 4: 60, 5: 380000 },
      record: {},
      items: {},
      gold: 300000,
      boxPoint: 0,
      fillup: false,
      strategy: "twoForOne",
      maxIterations: 1,
    },
    opensPacks: true,
    expectOk: true,
    expectTopup: true,
    expectLedger: { claimedItems: 0, pendingItems: 942, restItems: 108, usable: 1050 },
  },
];

let fails = 0;
let pass = 0;
const check = (label, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${label}`);
  } catch (err) {
    fails += 1;
    console.log(`  ❌ ${label}\n     ${err.message.split("\n")[0]}`);
  }
};

for (const sc of SCENARIOS) {
  console.log(`\n================ ${sc.name} ================`);
  const { timeline, report, ok } = runFullSimulation(sc.preset);

  for (const l of timeline) {
    const tag = { info: "  ", success: "✅", warning: "⚠️ ", error: "❌" }[l.level] || "  ";
    console.log(`[${l.phase}] ${tag} ${l.text}`);
  }

  const f = report.finishResult;
  console.log("\n---- 报表 ----");
  for (const slot of [1, 2, 3, 4, 5]) {
    const r = report.rounds[slot];
    console.log(
      `  ${r.name}\t进度 ${r.progress} / ${r.maxThreshold}\t轮次 ${r.rounds}/${r.maxRounds}`,
    );
  }
  console.log(
    `  剩余：招募令 ${report.items.recruitToken} / 鱼竿 ${report.items.goldRod} / 金砖 ${report.items.gold}` +
      ` / 普通道具 ${report.items.packNormal} / 特殊道具 ${report.items.packSpecial}`,
  );
  console.log(`  宝箱 ${JSON.stringify(report.items.chests)} · 未兑换积分 ${report.boxPoint}`);
  console.log(
    `  收尾（${f.strategy}）：买鱼竿 ${f.rodsBought} 根 / 花金砖 ${f.goldSpent}` +
      ` / 返还 招募令 +${f.returns.recruit} 铂金箱 +${f.returns.platinumBox} 金砖 +${f.returns.gold}`,
  );
  for (const r of f.rounds) {
    console.log(
      `    补档${r.iteration}：缺口 ${r.gap}（需 ${r.needItems}）→ 买 ${r.rods} 根（${r.goldSpend} 金砖）` +
        `→ 得 ${r.items} → 开出 +${r.gained} → 累计 ${r.special}/250`,
    );
  }
  console.log(
    `  开包模型 model=${report.packModel.model} rate=${report.packModel.rate}` +
      ` biasMax=±${report.packModel.biasMax}` +
      ` → 期望出率 ${(report.packModel.rate * 100).toFixed(1)}%（有保底：偏差绝对 ≤ ${report.packModel.biasMax}）`,
  );
  console.log(
    `  档位上限：全满名义 ${report.totalItemsFromTasks} / 本期实际可得 ${report.itemsCeiling}` +
      ` ${JSON.stringify(report.itemsCeilingBySlot)}`,
  );
  console.log(
    `  帧数：消耗 ${report.commandStats.consume.frames} + 收尾 ${report.commandStats.finish.frames}` +
      ` = ${report.commandStats.totalFrames}`,
  );
  const cmdCount = {};
  for (const c of report.calls) cmdCount[c.cmd] = (cmdCount[c.cmd] || 0) + 1;
  console.log(`  按命令: ${JSON.stringify(cmdCount)}`);
  console.log(`  → 总结果: ${ok ? "OK ✅" : "FAILED（按原文第 136 行报错）❌"}`);

  // ---------------------------------------------------------------- 断言
  console.log("\n---- 断言 ----");
  check("账目：totalFrames = 消耗 + 收尾", () =>
    assert.equal(
      report.commandStats.totalFrames,
      report.commandStats.consume.frames + report.commandStats.finish.frames,
    ));
  check("账目：买鱼竿 = 金砖支出 / 600（不重复计费）", () =>
    assert.equal(f.rodsBought, Math.floor(f.goldSpent / sc.preset.rodPrice)));
  check("周四补满：招募 → 4000 / 宝箱 → ≥100000", () => {
    assert.equal(report.rounds[1].progress, 4000);
    assert.ok(report.rounds[2].progress >= 100000, `宝箱 ${report.rounds[2].progress}`);
  });
  const fishMin = sc.expectFishMin ?? 1300;
  check(`钓鱼 ≥ ${fishMin}（先补到下限，之后由买鱼竿继续推到 ${sc.preset.fishCap}）`, () =>
    assert.ok(report.rounds[3].progress >= fishMin, `钓鱼 ${report.rounds[3].progress}`));
  check("钓鱼不超过硬上限 1750", () =>
    assert.ok(report.rounds[3].progress <= 1750, `钓鱼 ${report.rounds[3].progress}`));
  check("金砖任务进度 = 初始进度 + 金砖支出（buy_rod 恒等式：不漏计、不重复计费）", () =>
    assert.equal(
      report.rounds[5].progress,
      (sc.preset.task?.[5] || 0) + f.goldSpent,
      `task.5=${report.rounds[5].progress} vs 初始 ${sc.preset.task?.[5] || 0} + 支出 ${f.goldSpent}`,
    ));
  check("金砖任务进度溢出有界（≤ 500000 + 一轮钓鱼的杆钱 = 2换1 fallback 单步最大溢出）", () =>
    assert.ok(
      report.rounds[5].progress <= 500000 + 135 * sc.preset.rodPrice,
      `task.5=${report.rounds[5].progress}`,
    ));
  check("本期道具上限 = 1050（钓鱼做满 20 轮，不是 978）", () => {
    assert.equal(report.totalItemsFromTasks, 1050);
    assert.equal(report.itemsCeiling, 1050);
    assert.deepEqual(report.itemsCeilingBySlot, { 1: 20, 2: 20, 3: 20, 4: 20, 5: 20 });
  });
  check("领奖帧 ≤ 100（五类 × 20 轮的档位上限）", () => {
    const claimed = report.calls.filter((c) => c.cmd === "activity_claimtaskreward").length;
    assert.ok(claimed <= 100, `领奖帧 ${claimed} 超过 100 个档位上限`);
  });
  check("needsManualDump 与 ok 相反", () => assert.equal(f.needsManualDump, !f.ok));
  check("补档明细每轮都有 gap/rods/items 字段", () =>
    f.rounds.forEach((r) =>
      assert.ok(
        Number.isFinite(r.gap) && Number.isFinite(r.rods) && Number.isFinite(r.items),
        JSON.stringify(r),
      ),
    ));
  check("fillupFish 默认开启且 fishCap/fillupFishTarget 透传正确", () => {
    assert.equal(f.fillupFish, true);
    assert.equal(f.fillupFishTarget, 1300);
    assert.equal(f.fishCap, 1750);
  });
  check("开包模型已换成「有保底」的线性 bias 口径（无 CLT / 无保底次数参数）", () => {
    assert.equal(report.packModel.model, "bounded-linear-bias");
    assert.equal(report.packModel.biasMax, 5);
    assert.equal(report.packModel.guarantee, undefined);
    assert.equal(report.packModel.expectedRate, undefined);
  });
  check("收尾阶段回传 bias 诊断量（base / biases 数组）", () => {
    assert.ok(Number.isFinite(f.packBase), `packBase=${f.packBase}`);
    assert.ok(Array.isArray(f.packBiases), "packBiases 应为数组");
    assert.ok(f.packBiases.every((b) => Number.isInteger(b) && Math.abs(b) <= 5),
      `packBiases 越界：${JSON.stringify(f.packBiases)}`);
  });

  if (sc.opensPacks) {
    check("返还四项**同时**非零（不是多选一，master 2026-09-28 澄清）", () => {
      assert.ok(f.returns.recruit > 0, `招募令返还 ${f.returns.recruit}`);
      assert.ok(f.returns.platinumBox > 0, `铂金箱返还 ${f.returns.platinumBox}`);
      assert.ok(f.returns.gold > 0, `金砖返还 ${f.returns.gold}`);
      assert.ok(f.returns.special > 0, `特殊道具 ${f.returns.special}`);
    });
    check("返还精度：实发整数与期望小数的差 < 1 个/项（小数累加回归）", () => {
      const ex = f.returnsExact;
      assert.ok(
        Math.abs(f.returns.recruit - ex.recruit) < 1,
        `招募令 ${f.returns.recruit} vs ${ex.recruit}`,
      );
      assert.ok(
        Math.abs(f.returns.platinumBox - ex.platinumBox) < 1,
        `铂金箱 ${f.returns.platinumBox} vs ${ex.platinumBox}`,
      );
      assert.ok(Math.abs(f.returns.gold - ex.gold) < 1, `金砖 ${f.returns.gold} vs ${ex.gold}`);
    });
    check("返还期望与开包数自洽（×0.205 / ×0.5 / ×107.304）", () => {
      const ex = f.returnsExact;
      const packs = ex.gold / 107.304; // 用**期望值**反算包数（不能用实发整数）
      assert.ok(Number.isFinite(packs) && packs > 0);
      assert.ok(
        Math.abs(ex.platinumBox - packs * 0.205) < 1e-6,
        `${ex.platinumBox} vs ${packs * 0.205}`,
      );
      assert.ok(Math.abs(ex.recruit - packs * 0.5) < 1e-6, `${ex.recruit} vs ${packs * 0.5}`);
      assert.ok(Math.abs(ex.gold - packs * 107.304) < 1e-6);
    });
    check("开出的特殊道具 ≤ 消耗的普通道具（25% 不可能超产）", () =>
      assert.ok(f.returns.special <= f.returns.gold / 107.304 + 1));
  }

  check(`场景预期：${sc.expectOk ? "应成功" : "应诚实报错"}`, () => {
    if (sc.expectOk) {
      assert.equal(ok, true, f.reason);
      assert.ok(f.special >= 250, `特殊道具 ${f.special}`);
      assert.equal(f.needsManualDump, false);
    } else {
      assert.equal(ok, false);
      assert.ok(f.reason.length > 0, "必须给出原因");
      assert.ok(/档位|金砖|普通道具/.test(f.reason), f.reason);
      if (sc.spendsBeforeFail) {
        // 金砖不足 ⇒ 应**先把买得起的买掉**（这是唯一能往前走的路），再报错
        assert.ok(f.goldSpent > 0, "金砖不足时应先把买得起的档位换掉");
        assert.equal(f.rodsBought, Math.floor(f.goldSpent / sc.preset.rodPrice));
      } else {
        // 真·无解 ⇒ 不该空花钱
        assert.equal(f.goldSpent, 0, "报错时不该空花金砖");
        assert.equal(f.rodsBought, 0, "报错时不该空买鱼竿");
      }
    }
  });

  // ---------------------------------------------------------------- 档位总账（三段同量纲）
  check("档位总账：历次已领 + 本次待领 + 剩余档位 = 1050（三段同量纲，可直接相加）", () => {
    assert.ok(f.ledger, "缺少 ledger");
    assert.equal(f.ledger.total, 1050);
    assert.equal(
      f.ledger.claimedItems + f.ledger.pendingItems + f.ledger.restItems,
      f.ledger.total,
      `已领 ${f.ledger.claimedItems} + 待领 ${f.ledger.pendingItems} + 剩余 ${f.ledger.restItems}`,
    );
    assert.equal(f.ledger.consistent, true, "三段必须与 1050 自洽（record 不含超前进度）");
    assert.equal(f.ledger.usable, f.ledger.pendingItems + f.ledger.restItems);
  });
  check("档位总账：档位数与道具数分开记（不许混量纲）", () => {
    const L = f.ledger;
    for (const k of ["claimedRounds", "pendingRounds", "restRounds"]) {
      assert.ok(Number.isFinite(L[k]) && L[k] >= 0, `${k}=${L[k]}`);
    }
    assert.ok(
      L.claimedRounds + L.pendingRounds + L.restRounds <= 100,
      `档位总数 ${L.claimedRounds + L.pendingRounds + L.restRounds} 不应超过 100（5 类 × 20 轮）`,
    );
  });
  if (sc.expectLedger) {
    check("档位总账：数值与 master 实测日志逐项一致", () => {
      for (const [k, v] of Object.entries(sc.expectLedger)) {
        assert.equal(f.ledger[k], v, `ledger.${k} = ${f.ledger[k]}，期望 ${v}`);
      }
    });
  }

  // ---------------------------------------------------------------- 2 换 1 策略（master 2026-09-28 拍板）
  if (sc.expectTrade) {
    check("2换1：至少触发一次交换（plan 事件 traded=true，且判定上下文留痕）", () => {
      const tradedPlan = (report.events || []).find((e) => e.event === "plan" && e.traded);
      assert.ok(tradedPlan, "没有 traded=true 的 plan 事件");
      assert.equal(tradedPlan.tradeApply, true, `tradeApply=${tradedPlan.tradeApply}`);
      assert.ok(tradedPlan.tradeGoldLeft >= 2, `tradeGoldLeft=${tradedPlan.tradeGoldLeft}`);
      assert.ok(tradedPlan.tradeFishLeft > 0, `tradeFishLeft=${tradedPlan.tradeFishLeft}`);
      assert.ok(typeof tradedPlan.tradeReason === "string" && tradedPlan.tradeReason.length > 0);
    });
    check("2换1：金砖进度被推过 GOLDENFISH_GOLD_TARGET（46 万，轮 19）", () =>
      assert.ok(report.rounds[5].progress >= 460000, `金砖 ${report.rounds[5].progress}`));
    check("2换1：钓鱼至少再推 1 轮（≥ 1450，白捡的一档）", () =>
      assert.ok(report.rounds[3].progress >= 1450, `钓鱼 ${report.rounds[3].progress}`));
    check("2换1：金砖支出远小于「金砖做满」口径（≤ 观察点余量 12 万 + 2 轮钓鱼杆钱）", () =>
      assert.ok(
        f.goldSpent <= 120000 + 2 * 81000 + 600,
        `goldSpent=${f.goldSpent}`,
      ));
    check("2换1：JSONL round 事件带 traded 标记", () => {
      const rounds = f.rounds || [];
      assert.ok(rounds.some((r) => r.traded === true), `rounds=${JSON.stringify(rounds)}`);
    });
  }

  // ---------------------------------------------------------------- 最后兜底：补一轮金砖（master 2026-09-28 拍板）
  if (sc.expectTopup) {
    check("兜底：finishResult.topups ≥ 1 且时间线出现【兜底】标记", () => {
      assert.ok((f.topups || 0) >= 1, `topups=${f.topups}`);
      assert.ok(
        timeline.some((l) => typeof l.text === "string" && l.text.includes("【兜底】")),
        "时间线缺少【兜底】日志",
      );
    });
    check("兜底：恰好补 1 轮金砖（65 根 / 39,000 金砖恰好跨过第 20 轮，不越过 50 万）", () => {
      const topRound = (f.rounds || []).find((r) => r.topup === true);
      assert.ok(topRound, "rounds 缺少 topup 条目");
      assert.equal(topRound.rods, 65);
      assert.equal(topRound.goldSpend, 39000);
      assert.equal(topRound.items, 12);
      assert.equal(report.rounds[5].progress, 500000, `金砖 ${report.rounds[5].progress}`);
    });
    check("兜底：JSONL 事件流带 topup 标记（buyRod/round/summary）", () => {
      const evs = report.events || [];
      assert.ok(evs.some((e) => e.event === "buyRod" && e.topup === true), "缺 buyRod(topup)");
      assert.ok(evs.some((e) => e.event === "round" && e.topup === true), "缺 round(topup)");
      // ⚠️ 消耗阶段也有一个 summary 事件 ⇒ 取最后一个（收尾的）
      const summaries = evs.filter((e) => e.event === "summary");
      const sum = summaries[summaries.length - 1];
      assert.equal(sum.topups, f.topups, "summary.topups 与 finishResult.topups 一致");
    });
    check("兜底：总支出 = 2换1 的 81,000 + 兜底的 39,000 = 120,000", () =>
      assert.equal(f.goldSpent, 120000));
  }

  // ---------------------------------------------------------------- 失败复盘（能区分「缺钱」与「无路」）
  if (sc.expectBlockedBy) {
    check(`卡点归类 = "${sc.expectBlockedBy}"（blockedBy）`, () =>
      assert.equal(f.lastPlan?.blockedBy, sc.expectBlockedBy, JSON.stringify(f.lastPlan)));
  }
  if (sc.expectReasonPrefix) {
    check(`reason 以「${sc.expectReasonPrefix}」开头（不再谎报「档位榨干」）`, () =>
      assert.ok(f.reason.startsWith(sc.expectReasonPrefix), f.reason));
  }
  if (sc.expectReachable !== undefined) {
    const line = timeline.find((l) => typeof l.text === "string" && l.text.includes("复盘·理论上限"));
    check(`复盘·理论上限 ⇒ ${sc.expectReachable ? "做满本可以拿鱼" : "做满也不够"}`, () => {
      assert.ok(line, "缺少「复盘·理论上限」日志");
      assert.ok(
        line.text.includes(sc.expectReachable ? "做满本可以拿鱼" : "做满也不够"),
        line.text,
      );
    });
    check(`复盘·卡点 ⇒ ${sc.expectReachable ? "金砖不足是唯一原因" : "真·无解"}`, () => {
      const kl = timeline.find((l) => typeof l.text === "string" && l.text.includes("复盘·卡点"));
      assert.ok(kl, "缺少「复盘·卡点」日志");
      assert.ok(
        kl.text.includes(sc.expectReachable ? "金砖不足" : "即使金砖管够也凑不够"),
        kl.text,
      );
    });
  }
  if (sc.expectIdealGoldNeeded !== undefined) {
    check("复盘·卡点：报出「做满还差多少金砖」（用户可行动的信息）", () => {
      const kl = timeline.find((l) => typeof l.text === "string" && l.text.includes("复盘·卡点"));
      assert.ok(kl, "缺少「复盘·卡点」日志");
      assert.ok(kl.text.includes(String(sc.expectIdealGoldNeeded)), kl.text);
    });
  }
  // ---------------------------------------------------------------- JSONL 事件流（master 2026-09-28 要求的结构化日志）
  const events = report.events || [];
  check("事件流：非空且每行都有 phase/event/seq", () => {
    assert.ok(events.length > 0, "events 不应为空");
    events.forEach((e, i) => {
      assert.ok(e.phase && e.event, `第 ${i} 行缺 phase/event：${JSON.stringify(e)}`);
      assert.equal(e.seq, i, `第 ${i} 行 seq 不连续`);
    });
  });
  check("事件流：核心事件必有（ledger/plan/summary —— 收尾三件套）", () => {
    for (const k of ["ledger", "plan", "summary"]) {
      assert.ok(events.some((e) => e.event === k), `缺少 ${k} 事件`);
    }
  });
  if (sc.opensPacks) {
    check("事件流：开包场景有 open + claim 事件", () => {
      for (const k of ["open", "claim"]) {
        assert.ok(events.some((e) => e.event === k), `缺少 ${k} 事件`);
      }
    });
  }
  check("事件流：ledger 事件与 finishResult.ledger 一致", () => {
    const led = events.find((e) => e.event === "ledger");
    assert.deepEqual(
      { ...led, phase: undefined, event: undefined, seq: undefined },
      { ...f.ledger, phase: undefined, event: undefined, seq: undefined },
    );
  });
  check("事件流：plan 事件带全诊断量（blockedBy/goldShortfall/maxTotal）", () => {
    const p = events.filter((e) => e.event === "plan");
    assert.ok(p.length > 0);
    for (const e of p) {
      for (const k of ["blockedBy", "goldShortfall", "maxTotal", "rodsWanted", "goldNeeded", "needItems"]) {
        assert.ok(k in e, `plan 事件缺 ${k}`);
      }
    }
  });
  if (sc.expectBlockedBy) {
    check(`事件流：plan/summary 事件把卡点归类为 "${sc.expectBlockedBy}"`, () => {
      assert.equal(f.lastPlan?.blockedBy, sc.expectBlockedBy);
      const sum = events.find((e) => e.event === "summary");
      assert.equal(sum.lastPlanBlockedBy ?? f.lastPlan?.blockedBy, sc.expectBlockedBy);
    });
  }
  if (sc.expectReachable !== undefined) {
    check(`事件流：postmortem 事件 reachable=${sc.expectReachable}（机器可直接判「缺钱还是无解」）`, () => {
      const pm = events.find((e) => e.event === "postmortem");
      assert.ok(pm, "缺少 postmortem 事件");
      assert.equal(pm.reachable, sc.expectReachable);
      assert.equal(pm.verdict, sc.expectReachable ? "gold-blocked" : "unsolvable");
    });
  }
  check("事件流：每行 JSON.stringify 可序列化（JSONL 直接可用）", () => {
    for (const e of events) {
      const s = JSON.stringify(e);
      assert.ok(typeof s === "string" && s.length > 0);
      assert.equal(typeof JSON.parse(s), "object");
    }
  });

  if (sc.opensPacks && !sc.expectOk) {
    check("失败时也召回了「买得起的杆能换回多少」（不是只说一句凑不够）", () =>
      assert.ok(
        timeline.some((l) => typeof l.text === "string" && l.text.includes("金砖预算：做满金砖任务需买")),
        "缺少金砖预算行",
      ));
  }
}

console.log(`\n${fails === 0 ? `全部通过 ✅ (${pass})` : `有 ${fails} 项失败 ❌ (${pass} 通过)`}\n`);
process.exit(fails === 0 ? 0 : 1);
