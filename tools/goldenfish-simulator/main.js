/**
 * 金鱼模拟器 · UI 层（esbuild 会把本文件 + engine.js + 生产模块打成单文件）
 */
import {
  runFullSimulation,
  ACTIVITY_ID,
  ITEM_RECRUIT,
  ITEM_GOLD_ROD,
  ITEM_PACK_NORMAL,
  ITEM_PACK_SPECIAL,
} from "./engine.js";
import { GOLDENFISH_CONSUME_DEFAULTS } from "../../src/utils/goldenfishConsumePlan.js";
import {
  toMissionId,
  GOLDENFISH_ROD_PRICE,
  GOLDENFISH_FISH_MIN_TARGET,
  GOLDENFISH_FISH_FULL,
  GOLDENFISH_PACK_BIAS_MAX,
} from "../../src/utils/goldenfishFinishPlan.js";

// ================================================================== 表单定义

const FIELDS = {
  task: [
    { key: "t1", label: "招募（次）", v: 3685, src: "task.1" },
    { key: "t2", label: "宝箱（分）", v: 96530, src: "task.2" },
    { key: "t3", label: "钓鱼（次）", v: 1140, src: "task.3" },
    { key: "t4", label: "收罐子", v: 632, src: "task.4" },
    { key: "t5", label: "金砖（个）", v: 20389, src: "task.5" },
  ],
  items: [
    { key: "recruit", label: "招募令 1001", v: 5000 },
    { key: "rod", label: "黄金鱼竿 1012", v: 2000 },
    { key: "gold", label: "金砖", v: 1000000 },
    { key: "c2001", label: "木箱 2001", v: 300 },
    { key: "c2002", label: "青铜 2002", v: 500 },
    { key: "c2003", label: "黄金 2003", v: 200 },
    { key: "c2004", label: "铂金 2004", v: 100 },
    { key: "c2005", label: "钻石 2005", v: 20 },
    { key: "packNormal", label: "普通道具 5287", v: 0 },
    { key: "packSpecial", label: "特殊道具 5286", v: 0 },
  ],
  targets: [
    { key: "recruitTarget", label: "招募目标", v: GOLDENFISH_CONSUME_DEFAULTS.recruitTarget },
    { key: "boxTarget", label: "宝箱目标", v: GOLDENFISH_CONSUME_DEFAULTS.boxTarget },
    { key: "fishTarget", label: "钓鱼目标", v: GOLDENFISH_CONSUME_DEFAULTS.fishTarget },
    { key: "targetSpecial", label: "特殊道具目标", v: 250 },
  ],
  model: [
    { key: "packRate", label: `开出概率 p（bias ±${GOLDENFISH_PACK_BIAS_MAX}）`, v: 0.25, step: 0.01 },
    { key: "rodPrice", label: "原价鱼竿单价", v: GOLDENFISH_ROD_PRICE },
    { key: "fishCap", label: "钓鱼硬上限（全满）", v: GOLDENFISH_FISH_FULL },
    { key: "fillupFishTarget", label: "周四先补到", v: GOLDENFISH_FISH_MIN_TARGET },
    { key: "fillupFish", label: "先补满钓鱼(0/1)", v: 1, step: 1 },
    { key: "boxPoint", label: "未兑换积分", v: 5000 },
    { key: "seed", label: "随机种子", v: 20260928 },
  ],
  record: [
    // 🔴 默认 1（= 抓包账号每类已领第 1 轮）：首屏展示的就是抓包快照，
    // record 与 capture 预设一致 ⇒ 首屏运行与「抓包预设」按钮点击后结果一致。
    // （曾默认 0 ⇒ 首屏 record 为空、多领 20 个道具，与预设按钮结果不一致。）
    { key: "rec1", label: "招募 已领轮次", v: 1 },
    { key: "rec2", label: "宝箱 已领轮次", v: 1 },
    { key: "rec3", label: "钓鱼 已领轮次", v: 1 },
    { key: "rec4", label: "罐子 已领轮次", v: 1 },
    { key: "rec5", label: "金砖 已领轮次", v: 1 },
  ],
};

const PRESETS = {
  capture: { t1: 3685, t2: 96530, t3: 1140, t4: 632, t5: 20389 },
  fresh: { t1: 0, t2: 0, t3: 0, t4: 0, t5: 0 },
  nearly: { t1: 4000, t2: 100000, t3: 1140, t4: 60, t5: 0 },
  rich: { t1: 0, t2: 0, t3: 0, t4: 0, t5: 0 },
};

// ================================================================== DOM 构建

const inputs = {};
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const renderGroup = (hostId, list) => {
  const host = document.getElementById(hostId);
  for (const f of list) {
    const row = el("div", "field");
    const lab = el("label", null, f.label);
    const inp = el("input");
    inp.type = "number";
    inp.value = f.v;
    if (f.step) inp.step = f.step;
    row.append(lab, inp);
    host.append(row);
    inputs[f.key] = inp;
  }
};

renderGroup("grp-task", FIELDS.task);
renderGroup("grp-items", FIELDS.items);
renderGroup("grp-targets", FIELDS.targets);
renderGroup("grp-model", FIELDS.model);
renderGroup("grp-record", FIELDS.record);

const num = (key, fallback = 0) => {
  const raw = inputs[key]?.value;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
};
const setNum = (key, v) => {
  if (inputs[key]) inputs[key].value = v;
};

// ================================================================== 预设按钮

const applyPreset = (name) => {
  const p = PRESETS[name];
  if (!p) return;
  // 🔴 先把**全部资源**恢复成表单基线，再叠加预设专属值 ——
  // 否则上一个预设改过的金砖/鱼竿/宝箱会漂移到下一次运行（UI 冒烟第 6/7 节踩过：
  // fresh 的 gold=200万 残留进后续 capture 运行，导致同预设不同结果）。
  for (const g of [FIELDS.items, FIELDS.targets, FIELDS.model]) {
    for (const f of g) setNum(f.key, f.v);
  }
  for (const [k, v] of Object.entries(p)) setNum(k, v);
  // 已领轮次：默认全部清零，抓包场景按真实 record 填（每类第 1 轮）
  for (const slot of [1, 2, 3, 4, 5]) setNum(`rec${slot}`, name === "capture" ? 1 : 0);
  if (name === "rich") {
    setNum("recruit", 20000);
    setNum("rod", 5000);
    setNum("gold", 2000000);
    setNum("c2002", 6000);
    setNum("c2003", 4000);
    setNum("c2004", 2500);
    setNum("c2005", 50);
  }
  if (name === "fresh") {
    setNum("recruit", 10000);
    setNum("rod", 3000);
    setNum("gold", 2000000);
    setNum("c2001", 500);
    // 宝箱要够：青铜 5000×10 + 黄金 3000×20 + 铂金 2000×50 = 210,000 分 > 99,000
    setNum("c2002", 5000);
    setNum("c2003", 3000);
    setNum("c2004", 2000);
    setNum("c2005", 50);
    setNum("packNormal", 0);
    setNum("packSpecial", 0);
  }
  if (name === "nearly") {
    setNum("packSpecial", 180);
    setNum("packNormal", 300);
  }
  if (name === "capture") {
    setNum("packNormal", 0);
    setNum("packSpecial", 0);
  }
};

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
});

// ================================================================== 渲染

const fmt = (v) => Number(v || 0).toLocaleString("zh-CN");
const pct = (v) => `${(v * 100).toFixed(1)}%`;

const renderVerdict = (report) => {
  const host = document.getElementById("verdict");
  host.className = `verdict ${report.finishResult.ok ? "ok" : "fail"}`;
  host.innerHTML = "";
  const f = report.finishResult;
  const strategyLabel =
    f.strategy === "minimal" ? "最小代价" : f.strategy === "twoForOne" ? "2轮金砖换1轮钓鱼" : "金砖做满";
  const left = el("div");
  left.append(
    el("div", "big", f.ok ? "✅ 达成：可以召唤金鱼" : "❌ 未达成：资源不够"),
    el(
      "div",
      "sub",
      f.ok
        ? `特殊道具 5286 已凑齐 250 个 · 策略「${strategyLabel}」· 买原价鱼竿 ${fmt(f.rodsBought)} 根（花 ${fmt(f.goldSpent)} 金砖）`
        : `原因：${f.reason} · 策略「${strategyLabel}」· 仍差 ${fmt(Math.max(0, 250 - f.special))} 个`,
    ),
  );
  const right = el("div", "metric");
  right.append(
    el("div", "v", `${fmt(f.special)}/${fmt(250)}`),
    el("div", "k", "特殊道具 5286"),
  );
  host.append(left, right);
};

const renderStats = (report) => {
  const host = document.getElementById("stats");
  host.innerHTML = "";
  const f = report.finishResult;
  const items = [
    ["消耗阶段帧", fmt(report.commandStats.consume.frames)],
    ["收尾阶段帧", fmt(report.commandStats.finish.frames)],
    ["总帧数", fmt(report.commandStats.totalFrames)],
    ["理论出率", pct(report.packModel.rate)],
    ["开包模型", report.packModel.model],
    ["偏差上界", `±${fmt(report.packModel.biasMax)} 个`],
    ["买原价鱼竿", fmt(f.rodsBought)],
    ["金砖支出", fmt(f.goldSpent)],
    ["残留普通道具", fmt(report.items.packNormal)],
    ["未兑换积分", fmt(report.boxPoint)],
  ];
  for (const [k, v] of items) {
    const s = el("div", "stat");
    s.append(el("div", "k", k), el("div", "v", v));
    host.append(s);
  }
};

/** 收尾补档明细（每一轮「缺口 → 买多少根鱼竿 → 得到多少道具」） */
const renderRodPlan = (report) => {
  const host = document.getElementById("rodplan");
  host.innerHTML = "";
  const rounds = report.finishResult.rounds || [];
  if (!rounds.length) {
    host.append(el("div", "empty", "没有补档轮次（领奖后已凑够 250）"));
    return;
  }
  const table = el("table");
  table.innerHTML =
    "<thead><tr><th class='num'>轮</th><th class='num'>缺口</th><th class='num'>需道具</th>" +
    "<th class='num'>买鱼竿</th><th class='num'>花金砖</th><th class='num'>金砖进度</th>" +
    "<th class='num'>钓鱼进度</th><th class='num'>得到</th><th class='num'>开箱得特殊</th>" +
    "<th class='num'>当前特殊</th></tr></thead>";
  const tbody = el("tbody");
  for (const r of rounds) {
    const tr = el("tr");
    for (const v of [
      r.iteration,
      `-${fmt(r.gap)}`,
      fmt(r.needItems),
      fmt(r.rods),
      fmt(r.goldSpend),
      fmt(r.goldAfter),
      `${fmt(r.fishAfter)}`,
      fmt(r.items),
      `+${fmt(r.gained)}`,
      `${fmt(r.special)}/250`,
    ]) {
      tr.append(el("td", "num", String(v)));
    }
    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);
};

/** 开道具返还统计（原文第 118-120 行的期望值口径；**四项同时获取**，不是多选一） */
const renderReturns = (report) => {
  const host = document.getElementById("returns");
  host.innerHTML = "";
  const r = report.finishResult.returns || {};
  const ex = report.finishResult.returnsExact || {};
  const hint = el(
    "div",
    "src",
    "🔴 四项**同时获取**（各自独立结算，不是多选一）。实发为整数，与期望的差 < 1 个/项 —— " +
      "因为改了「小数累加后统一取整」，不再逐次丢小数。",
  );
  const kv = el("div", "kv");
  const rows = [
    ["返还 招募令（0.5/个）", r.recruit, ex.recruit],
    ["返还 铂金宝箱 2004（0.205/个）", r.platinumBox, ex.platinumBox],
    ["返还 金砖（107.304/个）", r.gold, ex.gold],
  ];
  for (const [k, v, e] of rows) {
    const d = el("div");
    const val = el("span");
    val.textContent =
      Number.isFinite(e) && e !== v
        ? `${fmt(v)}  (期望 ${Number(e).toFixed(2)})`
        : fmt(v);
    d.append(el("span", null, k), val);
    kv.append(d);
  }
  const dSp = el("div");
  const biasList = Array.isArray(report.finishResult.packBiases) ? report.finishResult.packBiases : [];
  const base = Number(report.finishResult.packBase);
  const biasTxt = biasList.length
    ? `（期望基线 ${base.toFixed(1)} + 各批 bias [${biasList
        .map((b) => (b > 0 ? `+${b}` : `${b}`))
        .join(", ")}] ⇒ 实得 ${fmt(r.special)}）`
    : "";
  dSp.append(
    el("span", null, "开出 特殊道具 5286（round(n×0.25 + bias)）"),
    el("span", null, `${fmt(r.special)} ${biasTxt}`),
  );
  kv.append(dSp);
  host.append(kv, hint);
};

/** 失败时按原文第 136 行「向用户报错 + 提供完整记录下载」 */
const renderManualDump = (report) => {
  const host = document.getElementById("dump");
  host.innerHTML = "";
  if (!report.finishResult.needsManualDump) {
    host.append(el("div", "empty", "—（已达成，无需人工介入）"));
    return;
  }
  host.append(
    el(
      "div",
      "empty",
      `⚠️ 资源不足，未能凑齐 250 个特殊道具（${report.finishResult.reason}）\n` +
        `按原文第 136 行：此时应向用户报错，并把**完整执行记录**导出给用户人工处理。`,
    ),
  );
};

const renderRounds = (report) => {
  const host = document.getElementById("rounds");
  host.innerHTML = "";
  const table = el("table");
  table.innerHTML =
    "<thead><tr><th>任务</th><th class='num'>进度</th><th class='num'>/ 阈值</th>" +
    "<th class='num'>轮次</th><th style='width:34%'>达成度</th></tr></thead>";
  const tbody = el("tbody");
  for (const slot of [1, 2, 3, 4, 5]) {
    const r = report.rounds[slot];
    const ratio = r.maxThreshold > 0 ? Math.min(1, r.progress / r.maxThreshold) : 0;
    const tr = el("tr");
    const tdBar = el("td");
    const bar = el("div", `bar${r.rounds >= r.maxRounds ? " full" : ""}`);
    const fill = el("i");
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    bar.append(fill);
    tdBar.append(bar);
    tr.append(
      el("td", null, r.name),
      el("td", "num", fmt(r.progress)),
      el("td", "num", fmt(r.maxThreshold)),
      el("td", "num", `${r.rounds}/${r.maxRounds}`),
      tdBar,
    );
    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);
};

const renderInventory = (report) => {
  const host = document.getElementById("inventory");
  host.innerHTML = "";
  const kv = el("div", "kv");
  const rows = [
    ["招募令", report.items.recruitToken],
    ["黄金鱼竿", report.items.goldRod],
    ["金砖", report.items.gold],
    ["普通道具 5287", report.items.packNormal],
    ["特殊道具 5286", report.items.packSpecial],
    ["木箱 2001", report.items.chests[2001]],
    ["青铜 2002", report.items.chests[2002]],
    ["黄金 2003", report.items.chests[2003]],
    ["铂金 2004", report.items.chests[2004]],
    ["钻石 2005", report.items.chests[2005]],
    ["未兑换积分", report.boxPoint],
    ["五类全满道具总量（名义）", report.totalItemsFromTasks],
    ["本期实际可得上限", report.itemsCeiling],
  ];
  for (const [k, v] of rows) {
    const d = el("div");
    d.append(el("span", null, k), el("span", null, fmt(v)));
    kv.append(d);
  }
  host.append(kv);
};

const renderTimeline = (timeline) => {
  const host = document.getElementById("timeline");
  host.innerHTML = "";
  if (!timeline.length) {
    host.append(el("div", "empty", "无日志"));
    return;
  }
  for (const l of timeline) {
    const row = el("div", `tl-row ${l.level}`);
    row.append(el("div", "tl-phase", l.phase), el("div", "tl-text", l.text));
    host.append(row);
  }
};

const renderCmds = (report) => {
  const host = document.getElementById("cmds");
  host.innerHTML = "";
  const count = {};
  for (const c of report.calls) count[c.cmd] = (count[c.cmd] || 0) + 1;
  const table = el("table");
  table.innerHTML = "<thead><tr><th>命令</th><th class='num'>帧数</th></tr></thead>";
  const tbody = el("tbody");
  for (const [cmd, n] of Object.entries(count).sort((a, b) => b[1] - a[1])) {
    const tr = el("tr");
    tr.append(el("td", null, cmd), el("td", "num", fmt(n)));
    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);
  document.getElementById("src").textContent =
    `活动实例 ${ACTIVITY_ID} · 原价鱼竿 ${GOLDENFISH_ROD_PRICE} 金砖/根 · ` +
    `周四钓鱼先补 ${GOLDENFISH_FISH_MIN_TARGET}（下限）→ 硬上限 ${GOLDENFISH_FISH_FULL} · ` +
    `开道具 = round(n×0.25 + bias)、bias ∈ [±${GOLDENFISH_PACK_BIAS_MAX}] 线性（有保底） · ` +
    `道具 id ${ITEM_PACK_NORMAL}/${ITEM_PACK_SPECIAL} · ` +
    `招募令 ${ITEM_RECRUIT} / 鱼竿 ${ITEM_GOLD_ROD}`;
};

// ================================================================== 运行

/** 已领轮次（每类前 n 轮）→ record 表（missionId → 时间戳） */
const buildRecord = () => {
  const out = {};
  for (const slot of [1, 2, 3, 4, 5]) {
    const n = Math.max(0, Math.floor(num(`rec${slot}`)));
    for (let round = 1; round <= n; round += 1) out[toMissionId(slot, round)] = 1759000000 + slot * 100 + round;
  }
  return out;
};

const buildPreset = () => ({
  seed: num("seed", 20260928),
  task: { 1: num("t1"), 2: num("t2"), 3: num("t3"), 4: num("t4"), 5: num("t5") },
  record: buildRecord(),
  items: {
    [ITEM_RECRUIT]: num("recruit"),
    [ITEM_GOLD_ROD]: num("rod"),
    2001: num("c2001"),
    2002: num("c2002"),
    2003: num("c2003"),
    2004: num("c2004"),
    2005: num("c2005"),
    [ITEM_PACK_NORMAL]: num("packNormal"),
    [ITEM_PACK_SPECIAL]: num("packSpecial"),
  },
  gold: num("gold"),
  boxPoint: num("boxPoint"),
  boxPointLastReward: 0,
  recruitTarget: num("recruitTarget", GOLDENFISH_CONSUME_DEFAULTS.recruitTarget),
  boxTarget: num("boxTarget", GOLDENFISH_CONSUME_DEFAULTS.boxTarget),
  fishTarget: num("fishTarget", GOLDENFISH_CONSUME_DEFAULTS.fishTarget),
  targetSpecial: num("targetSpecial", 250),
  packRate: num("packRate", 0.25),
  rodPrice: num("rodPrice", GOLDENFISH_ROD_PRICE),
  fishCap: num("fishCap", GOLDENFISH_FISH_FULL),
  fillupFishTarget: num("fillupFishTarget", GOLDENFISH_FISH_MIN_TARGET),
  strategy: (() => {
    const v = document.getElementById("strategy")?.value;
    return v === "minimal" || v === "twoForOne" ? v : "master";
  })(),
  // 1 = 周四先把钓鱼补到 fillupFishTarget(1300)，之后由第 6 步买鱼竿继续推到 fishCap(1750)
  fillupFish: num("fillupFish", 1) >= 1,
});

/**
 * 把最后一次运行导出成 JSONL（master 2026-09-28：「生成一个更加可以结构化读取的 log，
 * 例如 jsonl，我下载了直接给你分析」）。
 *
 * 结构：
 *   第 1 行  meta —— 输入预设 + 模型 + 结论（一眼看懂这场跑的是什么、结果如何）
 *   之后每行 事件 —— report.events 全量平铺（ledger / fillup / claim / open / free /
 *                    plan / buyRod / fish / round / postmortem / summary）
 *
 * 每行都是**独立可读**的 JSON 对象：不用先猜 schema，jq 或肉眼都行。
 */
let lastRun = null; // { preset, report }
const downloadJsonl = () => {
  if (!lastRun) return;
  const { preset, report } = lastRun;
  const f = report.finishResult;
  const meta = {
    phase: "meta",
    event: "run",
    ts: new Date().toISOString(),
    ok: f.ok,
    verdict: f.ok ? "reached" : "failed",
    special: f.special,
    targetSpecial: f.targetSpecial,
    reason: f.reason,
    packModel: report.packModel,
    ledger: f.ledger,
    lastPlanBlockedBy: f.lastPlan?.blockedBy ?? null,
    preset,
  };
  const lines = [JSON.stringify(meta)];
  for (const e of report.events || []) lines.push(JSON.stringify(e));
  const blob = new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  a.href = url;
  a.download = `goldenfish_finish_${stamp}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
};

const runBtn = document.getElementById("run");
const dlBtn = document.getElementById("dlJsonl");
dlBtn.disabled = true;
dlBtn.addEventListener("click", downloadJsonl);

runBtn.addEventListener("click", () => {
  runBtn.disabled = true;
  runBtn.textContent = "运行中…";
  try {
    const preset = buildPreset();
    window.__lastPreset = preset; // 诊断口：冒烟脚本用来核对每次运行的实际输入
    const { timeline, report } = runFullSimulation(preset);
    lastRun = { preset, report };
    dlBtn.disabled = false;
    renderVerdict(report);
    renderStats(report);
    renderRounds(report);
    renderRodPlan(report);
    renderReturns(report);
    renderInventory(report);
    renderTimeline(timeline);
    renderCmds(report);
    renderManualDump(report);
  } catch (err) {
    document.getElementById("verdict").className = "verdict fail";
    document.getElementById("verdict").innerHTML =
      `<div><div class="big">❌ 运行出错</div><div class="sub">${String(err && err.message)}</div></div>`;
    console.error(err);
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "▶ 跑一遍完整模拟";
  }
});

// 首次自动跑一遍，省得 master 还要点
runBtn.click();
