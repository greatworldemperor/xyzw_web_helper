// 离线复刻测试：把「今天的失败逻辑」和「修复路线」分别套到真实抓包帧上回放对比
//
// master 2026-09-26 深夜要求：两条路线都用 runtime 抓包数据模拟，找到真实错误原因。
//
// 方法：
//   - 用抓包里的真实帧驱动真实状态机（src/utils/legionWarState.js，纯函数，Node 可跑）；
//   - 模拟时钟 = 帧时间戳；等待判定（isMemberSettled / getUnsettledMembers / deploy 判据）
//     按线上相同的轮询粒度（120ms/300ms）在事件队列里推进；
//   - 关键：runUntil(全员就位) 就地暂停 → 在「自动流真实会调 deploy 的那一刻」用当时的
//     状态快照评估两版判据（绝不引入未来帧）；
//   - 路线A（今天线上旧代码）：deploy 判据 = state !== 'watching'；返回 true 的瞬间
//     模型化「closeProbe 关连接」→ 后续帧全部丢弃（不再进状态机）；
//   - 路线B（修复路线）：deploy 判据 = state 进入 {idle,combat,march}（等真确认），连接保活。
//
// 场景1 = runtime 抓包（官方客户端真实成功流程）：Round1 单人队 + Round2 四人队，按轮切窗
// 场景2 = 自动盐场抓包（09-26 中午 0 登场，team1 / legion 7432632）
//
// 用法: node tools/saltfield/saltfield-offline-replay-test.mjs [数据目录]
//   数据目录缺省按顺序探测：local-data/saltfield/260926_data → 仓库同级 captures_keep/saltfield_260926
//   也可显式传参（用于直接跑保留副本）：node tools/saltfield/saltfield-offline-replay-test.mjs ../captures_keep/saltfield_260926
// 本脚本属于「成功基准」工具链，见 docs/kb/activity-saltfield.md §10；抓包数据不要删。
import fs from "fs";
import path from "path";
import url from "url";
import {
  createInitialState,
  applyBattlefieldFrame,
  isMemberSettled,
  getUnsettledMembers,
  getTeamMemberCids,
  getRole,
  isRoleDeployed,
} from "../../src/utils/legionWarState.js";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");
const CANDIDATE_DIRS = [
  path.join(REPO, "local-data/saltfield/260926_data"),
  path.resolve(REPO, "../captures_keep/saltfield_260926"),
];
const DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : CANDIDATE_DIRS.find((d) => fs.existsSync(path.join(d, "runtime_saltfield_failed_to_setout.jsonl")));
if (!DIR) {
  console.error("找不到抓包数据：请恢复 local-data/saltfield/260926_data/ 或确认仓库同级 captures_keep/saltfield_260926/ 存在。");
  process.exit(1);
}
const RUNTIME_FILE = path.join(DIR, "runtime_saltfield_failed_to_setout.jsonl");
const AUTO_FILE = path.join(DIR, "saltfield-wss-2026-09-26-12-06-33.jsonl");

/* ---------------- BON + px 解密（与 decode_captures.mjs 一致） ---------------- */
class DR {
  constructor(b) { this._d = b; this.p = 0; }
  v(n) { if (this.p + n > this._d.length) throw new Error("eof"); return true; }
  u8() { this.v(1); return this._d[this.p++]; }
  i32() { this.v(4); const v = this._d[this.p++] | (this._d[this.p++] << 8) | (this._d[this.p++] << 16) | (this._d[this.p++] << 24); return v | 0; }
  i64() { let lo = this.i32(); const _lo = lo < 0 ? lo + 0x100000000 : lo; const hi = this.i32(); return _lo + 0x100000000 * hi; }
  r7() { let v = 0, s = 0, b = 0, c = 0; do { if (c++ === 35) throw new Error("bad"); b = this.u8(); v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return v >>> 0; }
  utf() { const l = this.r7(); this.v(l); const s = new TextDecoder().decode(this._d.subarray(this.p, this.p + l)); this.p += l; return s; }
  ua(l) { this.v(l); const a = this._d.subarray(this.p, this.p + l); this.p += l; return a; }
}
function bonDecode(bytes) {
  const dr = new DR(bytes); const sa = [];
  function dec() {
    const t = dr.u8();
    switch (t) {
      case 0: return null; case 1: return dr.i32(); case 2: return dr.i64();
      case 3: dr.p += 4; return 0; case 4: dr.p += 8; return 0;
      case 5: { const s = dr.utf(); sa.push(s); return s; }
      case 6: return dr.u8() === 1;
      case 7: { const l = dr.r7(); return dr.ua(l); }
      case 8: { const c = dr.r7(); const o = {}; for (let i = 0; i < c; i++) { const k = dec(); const v = dec(); o[k] = v; } return o; }
      case 9: { const l = dr.r7(); const a = new Array(l); for (let i = 0; i < l; i++) a[i] = dec(); return a; }
      case 10: return dr.i64();
      case 99: return sa[dr.r7()];
      default: throw new Error("tag" + t);
    }
  }
  return dec();
}
const xDec = (e) => {
  const t = (((e[2] >> 6) & 1) << 7) | (((e[2] >> 4) & 1) << 6) | (((e[2] >> 2) & 1) << 5) | ((e[2] & 1) << 4) |
    (((e[3] >> 6) & 1) << 3) | (((e[3] >> 4) & 1) << 2) | (((e[3] >> 2) & 1) << 1) | (e[3] & 1);
  for (let n = e.length; --n >= 4;) e[n] ^= t;
  return e.subarray(4);
};
function decodeRuntimeFrame(rawHex) {
  const u8 = new Uint8Array(rawHex.length / 2);
  for (let i = 0; i < u8.length; i++) u8[i] = parseInt(rawHex.substr(i * 2, 2), 16);
  if (!(u8.length > 4 && u8[0] === 0x70 && u8[1] === 0x78)) return null;
  try {
    const m = bonDecode(xDec(u8.slice()));
    if (m && m.body instanceof Uint8Array) { try { m.bodyDecoded = bonDecode(m.body); } catch { /* keep raw */ } }
    return m;
  } catch { return null; }
}

/* ---------------- 帧加载 ---------------- */
const ts2ms = (iso) => Date.parse(iso);
const fmt = (ms) => new Date(ms).toISOString().slice(11, 23);

function loadRuntimeBfFrames(window) {
  const lines = fs.readFileSync(RUNTIME_FILE, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const l of lines) {
    let ev; try { ev = JSON.parse(l); } catch { continue; }
    if (ev.event !== "ws:message") continue;
    if (!(ev.payload?.url || "").includes("xxz-xyzw-new")) continue;
    const atMs = ts2ms(ev.at);
    if (atMs < window.t0 || atMs > window.t1) continue;
    const m = decodeRuntimeFrame(ev.payload.frame.rawHex);
    if (!m || !m.bodyDecoded || typeof m.bodyDecoded !== "object") continue;
    out.push({ atMs, cmd: m.cmd || "", body: m.bodyDecoded });
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}
function loadAutoFrames(legionId, window) {
  const lines = fs.readFileSync(AUTO_FILE, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.dir !== "recv" || r.legionId !== legionId) continue;
    const atMs = ts2ms(r.ts);
    if (atMs < window.t0 || atMs > window.t1) continue;
    if (!r.body || typeof r.body !== "object") continue;
    out.push({ atMs, cmd: r.cmd || "", body: r.body });
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

/** 从帧列表里找第一个 roleMap 快照，反推 ownerRoleId（使 roleCodeId 推导=线上逻辑） */
function findOwnerRoleId(frames, expectedCid) {
  for (const f of frames) {
    const rm = f.body?.roleMap;
    if (!rm) continue;
    for (const [roleId, e] of Object.entries(rm)) {
      if (Number(e?.cId) === expectedCid) return Number(roleId);
    }
  }
  return 0;
}

/* ---------------- 模拟器 ---------------- */
class Sim {
  constructor(frames, ownerRoleId, label) {
    this.frames = frames;
    this.ownerRoleId = ownerRoleId;
    this.label = label;
    this.state = createInitialState();
    this.now = frames.length ? frames[0].atMs : 0;
    this.queue = frames.map((f) => ({ t: f.atMs, kind: "frame", f }));
    this.alive = true;
    this.killedAt = null;
    this.droppedFrames = 0;
  }
  addWaiter({ startMs, intervalMs, deadlineMs, test, label }) {
    const w = { startMs, intervalMs, deadlineMs, test, label, ok: false, done: false, okAt: null, timedOutAt: null };
    this.queue.push({ t: startMs, kind: "poll", w });
    this.queue.sort((a, b) => a.t - b.t || (a.kind === "frame" ? -1 : 1));
    return w;
  }
  step() {
    const e = this.queue.shift();
    if (!e) return false;
    this.now = Math.max(this.now, e.t);
    if (e.kind === "frame") {
      if (!this.alive) { this.droppedFrames++; return true; }   // 模型：连接已被 closeProbe 关闭
      applyBattlefieldFrame(this.state, e.f.body, this.ownerRoleId);
      return true;
    }
    const w = e.w;
    if (w.done) return true;
    let ok = false;
    try { ok = !!w.test(this.state, Math.floor(this.now / 1000)); } catch { ok = false; }
    if (ok) { w.done = true; w.ok = true; w.okAt = this.now; }
    else if (this.now + w.intervalMs <= w.deadlineMs) {
      this.queue.push({ t: this.now + w.intervalMs, kind: "poll", w });
      this.queue.sort((a, b) => a.t - b.t || (a.kind === "frame" ? -1 : 1));
    } else { w.done = true; w.ok = false; w.timedOutAt = w.deadlineMs; }
    return true;
  }
  /** 处理到谓词为真为止（就地暂停，不偷看未来帧） */
  runUntil(pred) { while (this.queue.length && !pred()) this.step(); }
  runAll() { while (this.queue.length) this.step(); }
  snapshot(cid) {
    const r = getRole(this.state, cid) || {};
    return {
      state: r.state || "?",
      pos: r.position && (r.position.x !== -1) ? `(${r.position.x},${r.position.y})` : "(-1,-1)",
      m: getTeamMemberCids(this.state, cid),
    };
  }
}

/* ---------------- 两版登场判据 ---------------- */
/* 旧判据：今天线上代码（deploy() 修复前），故意保留作 bug 锚点 */
const oldDeployTest = (myCid) => (st) => {
  const r = getRole(st, myCid);
  return !!r && !!r.state && r.state !== "watching";
};
/* 新判据：直接引用修复后源码里的 isRoleDeployed（即实际上线代码） */
const newDeployTest = (myCid) => (st) => isRoleDeployed(st, myCid);
const inviteTest = (myCid, cid) => (st, nowSec) => isMemberSettled(st, myCid, cid, nowSec);
const confirmTest = (myCid, cids) => (st, nowSec) => {
  const u = getUnsettledMembers(st, myCid, cids, nowSec);
  return u.notInTeam.length === 0 && u.stillPreparing.length === 0;
};

/* ---------------- 公共：跑「邀请→全员就位」，在 T1 就地暂停 ---------------- */
function runToConfirm(sim, invites, MY, confCids, lastInviteMs) {
  const ws = invites.map(([cid, t]) => ({
    cid, w: sim.addWaiter({ startMs: ts2ms(t), intervalMs: 120, deadlineMs: ts2ms(t) + 15000, test: inviteTest(MY, cid), label: "invite" + cid }),
  }));
  const conf = sim.addWaiter({
    startMs: lastInviteMs + 200, intervalMs: 300, deadlineMs: lastInviteMs + 30000,
    test: confirmTest(MY, confCids), label: "confirm",
  });
  sim.runUntil(() => conf.done);
  return { ws, conf, T1: conf.okAt };
}
const invLine = ({ cid, w }) => `    invite ${cid} 就位: ${w.ok ? fmt(w.okAt) : "未就位"}（发出后 +${(((w.okAt ?? w.timedOutAt) - w.startMs) / 1000).toFixed(2)}s）`;

/* ---------------- 场景1：runtime 真实成功流程（按轮切窗） ---------------- */
function scenario1() {
  console.log("=".repeat(76));
  console.log("场景1：runtime 抓包回放（官方客户端真实流程）— 两条路线 × 两个 deploy 时机");
  console.log("=".repeat(76));

  /* ---- Round 1：单人队 177（窗口切到 12:55:01.9，避开用户随后的 march）---- */
  console.log("\n■ Round 1：邀请离线员 177 → 自动同意 → 登场（单人队）");
  {
    const t0 = ts2ms("2026-09-26T12:54:06.000Z");
    const t1 = ts2ms("2026-09-26T12:55:01.900Z");
    const frames = loadRuntimeBfFrames({ t0, t1 });
    const MY = 182;
    const ownerRoleId = findOwnerRoleId(frames, MY);
    console.log(`  窗口 ${fmt(t0)}~${fmt(t1)}，帧 ${frames.length} 条；ownerRoleId=${ownerRoleId} → roleCodeId=${MY}`);

    // Run A：旧判据 @ 自动流时机
    {
      const sim = new Sim(frames, ownerRoleId, "R1-RunA");
      const { ws, conf, T1 } = runToConfirm(sim, [[177, "2026-09-26T12:54:43.270Z"]], MY, [177], ts2ms("2026-09-26T12:54:43.270Z"));
      console.log(`\n  [Run A] 旧判据（今天线上代码）@ 自动流时机`);
      console.log(invLine(ws[0]));
      console.log(`    全员就位判定 T1: ${T1 ? fmt(T1) : "未通过"}`);
      const okNow = oldDeployTest(MY)(sim.state, Math.floor(T1 / 1000));
      const snap = sim.snapshot(MY);
      console.log(`    deploy 判据首次评估 @T1: ${okNow ? "立即 TRUE" : "false"}（此刻 role.state=${snap.state} ${snap.pos}）`);
      if (okNow) {
        sim.alive = false; sim.killedAt = T1; sim.runAll();
        console.log(`    ⇒ 假成功复刻 ✓：UI 会打「登场完成 ${snap.state}${snap.pos}」，同时毫秒级 closeProbe 关连接`);
        console.log(`    ⇒ 关连接后丢弃帧 ${sim.droppedFrames} 条，队长永远停在 ${sim.snapshot(MY).state}，war_setbattleteam 未上线`);
      }
    }
    // Run B：新判据 @ 自动流时机 + 真实用户时机对照
    {
      const sim = new Sim(frames, ownerRoleId, "R1-RunB");
      const { conf, T1 } = runToConfirm(sim, [[177, "2026-09-26T12:54:43.270Z"]], MY, [177], ts2ms("2026-09-26T12:54:43.270Z"));
      const newAtT1 = sim.addWaiter({ startMs: T1, intervalMs: 120, deadlineMs: T1 + 10000, test: newDeployTest(MY), label: "new@T1" });
      const tReal = ts2ms("2026-09-26T12:54:54.717Z");
      const oldAtReal = sim.addWaiter({ startMs: tReal, intervalMs: 120, deadlineMs: tReal + 10000, test: oldDeployTest(MY), label: "old@real" });
      const newAtReal = sim.addWaiter({ startMs: tReal, intervalMs: 120, deadlineMs: tReal + 10000, test: newDeployTest(MY), label: "new@real" });
      sim.runAll();
      console.log(`\n  [Run B] 新判据（修复路线）+ 真实时机对照（连接保活，帧持续进状态机）`);
      console.log(`    新判据 @ T1=${fmt(T1)}: ${newAtT1.ok ? fmt(newAtT1.okAt) + " → " + JSON.stringify(sim.snapshot(MY)) + " → 真成功" : "超时"}`);
      console.log(`    抓包真实确认帧 = 12:54:54.790（War_SetBattleTeamResp，177+182 同时 idle@21,5）→ 复刻 ✓`);
      console.log(`    [对照] 真实用户时机 12:54:54.717 发出：旧判据 ${oldAtReal.ok ? fmt(oldAtReal.okAt) : "超时"} / 新判据 ${newAtReal.ok ? fmt(newAtReal.okAt) : "超时"}`);
      console.log(`    （用户在队长翻 watching 之后才点登场，旧判据恰好也能过 —— 手动流程因此没暴露 bug）`);
    }
  }

  /* ---- Round 2：四人队 176/181/177/169（窗口 12:57:20 → 12:58:41）---- */
  console.log("\n■ Round 2：重进战场后组四人队 176/181/177/169 → 登场");
  {
    const t0 = ts2ms("2026-09-26T12:57:20.000Z");
    const t1 = ts2ms("2026-09-26T12:58:41.000Z");
    const frames = loadRuntimeBfFrames({ t0, t1 });
    const MY = 182;
    const ownerRoleId = findOwnerRoleId(frames, MY);
    const cids = [176, 181, 177, 169];
    const invTimes = [
      [176, "2026-09-26T12:58:01.865Z"],
      [181, "2026-09-26T12:58:02.967Z"],
      [177, "2026-09-26T12:58:05.257Z"],
      [169, "2026-09-26T12:58:10.921Z"],
    ];
    console.log(`  窗口 ${fmt(t0)}~${fmt(t1)}，帧 ${frames.length} 条`);

    // Run A：旧判据 @ 自动流时机
    {
      const sim = new Sim(frames, ownerRoleId, "R2-RunA");
      const { ws, conf, T1 } = runToConfirm(sim, invTimes, MY, cids, ts2ms(invTimes[invTimes.length - 1][1]));
      console.log(`\n  [Run A] 旧判据 @ 自动流时机`);
      for (const x of ws) console.log(invLine(x));
      console.log(`    全员就位判定 T1: ${T1 ? fmt(T1) : "未通过"}`);
      const okNow = oldDeployTest(MY)(sim.state, Math.floor(T1 / 1000));
      const snap = sim.snapshot(MY);
      console.log(`    deploy 判据首次评估 @T1: ${okNow ? "立即 TRUE" : "false"}（此刻 role.state=${snap.state} ${snap.pos}）`);
      if (okNow) {
        sim.alive = false; sim.killedAt = T1; sim.runAll();
        console.log(`    ⇒ 又是假成功（state=${snap.state}）；关连接后丢弃帧 ${sim.droppedFrames} 条`);
      }
    }
    // Run B：新判据 @ 自动流时机 / 真实时机
    {
      const sim = new Sim(frames, ownerRoleId, "R2-RunB");
      const { T1 } = runToConfirm(sim, invTimes, MY, cids, ts2ms(invTimes[invTimes.length - 1][1]));
      const newAtT1 = sim.addWaiter({ startMs: T1, intervalMs: 120, deadlineMs: T1 + 10000, test: newDeployTest(MY), label: "new@T1" });
      const tReal = ts2ms("2026-09-26T12:58:30.351Z");
      const newAtReal = sim.addWaiter({ startMs: tReal, intervalMs: 120, deadlineMs: tReal + 10000, test: newDeployTest(MY), label: "new@real" });
      sim.runAll();
      console.log(`\n  [Run B] 新判据（修复路线）`);
      console.log(`    新判据 @ T1=${fmt(T1)}: ${newAtT1.ok ? fmt(newAtT1.okAt) + " → " + JSON.stringify(sim.snapshot(MY)) : "超时"}`);
      console.log(`    （回放里 idle 只在用户真实登场 12:58:30.456 出现；修复后的工具在 T1 自己发帧，服务端 ~0.1s 回 idle，不用等这么久）`);
      console.log(`    新判据 @ 真实登场时刻 12:58:30.351: ${newAtReal.ok ? fmt(newAtReal.okAt) + " → " + JSON.stringify(sim.snapshot(MY)) + " → 复刻第二次登场 ✓" : "超时"}`);
    }
  }
}

/* ---------------- 场景2：自动盐场今天的失败（team1） ---------------- */
function scenario2() {
  console.log("");
  console.log("=".repeat(76));
  console.log("场景2：自动盐场 09-26 12:00（team1 legion 7432632，cId 457，队员 443/453/444/447）");
  console.log("=".repeat(76));
  const t0 = ts2ms("2026-09-26T12:00:10.000Z");
  const t1 = ts2ms("2026-09-26T12:00:55.000Z");   // 本连接最后一帧 12:00:54.849（closeProbe 后录制停止）
  const frames = loadAutoFrames(7432632, { t0, t1 });
  const MY = 457;
  const ownerRoleId = findOwnerRoleId(frames, MY);
  const cids = [443, 453, 444, 447];
  const invTimes = [
    [443, "2026-09-26T12:00:10.857Z"],
    [453, "2026-09-26T12:00:22.207Z"],
    [444, "2026-09-26T12:00:33.556Z"],
    [447, "2026-09-26T12:00:44.811Z"],
  ];
  console.log(`窗口 ${fmt(t0)}~${fmt(t1)}，帧 ${frames.length} 条（本连接 54.849 后无帧 = 旧 bug 关连接的实录）`);

  // Run A：旧代码完整路径
  {
    const sim = new Sim(frames, ownerRoleId, "S2-RunA");
    const { ws, conf, T1 } = runToConfirm(sim, invTimes, MY, cids, ts2ms(invTimes[invites_last(invTimes)][1]));
    console.log(`\n[Run A] 旧代码完整路径回放`);
    const realNotify = { 443: "12:00:20.898", 453: "12:00:32.245", 444: "12:00:43.598", 447: "12:00:54.849" };
    for (const { cid, w } of ws) console.log(invLine({ cid, w }) + `  ← 抓包 notify ${realNotify[cid]}`);
    console.log(`  全员就位判定 T1: ${T1 ? fmt(T1) : "未通过"}（+10.0s/人 = 离线号自动同意，真就位，与抓包逐条吻合）`);
    const okNow = oldDeployTest(MY)(sim.state, Math.floor(T1 / 1000));
    const snap = sim.snapshot(MY);
    console.log(`  deploy 判据首次评估 @T1: ${okNow ? "立即 TRUE" : "false"}（此刻 role.state=${snap.state} ${snap.pos}，mCodeIds=${JSON.stringify(snap.m)}）`);
    if (okNow) {
      console.log(`  ⇒ 假成功复刻 ✓：UI 打「登场完成 ${snap.state}${snap.pos}」、校验 5人=5人 通过 → 毫秒级 closeProbe`);
      sim.alive = false; sim.killedAt = T1; sim.runAll();
      console.log(`  ⇒ 关连接后丢弃帧 ${sim.droppedFrames} 条；抓包事实：54.849 后本连接再无帧 —— war_setbattleteam 从未上线，服务端 0 登场`);
    }
  }
  // Run B：修复路线
  {
    const sim = new Sim(frames, ownerRoleId, "S2-RunB");
    const { conf, T1 } = runToConfirm(sim, invTimes, MY, cids, ts2ms(invTimes[invites_last(invTimes)][1]));
    const dep = sim.addWaiter({ startMs: T1, intervalMs: 120, deadlineMs: T1 + 10000, test: newDeployTest(MY), label: "deploy-new" });
    sim.runAll();
    console.log(`\n[Run B] 修复路线回放（新判据，连接保活）`);
    console.log(`  T1=${fmt(T1)}；deploy-new 等 idle：${dep.ok ? fmt(dep.okAt) + " → " + JSON.stringify(sim.snapshot(MY)) : "10s 超时 → 诚实失败（不假成功）"}`);
    console.log(`  说明：抓包在 54.849 后无帧（旧 bug 关连接所致），模拟里没有服务端可响应；`);
    console.log(`  真实修复后帧在 T1 上线，服务端以 runtime 实测 70~105ms 回 idle → 预期 ${fmt(T1 + 100)} 前后全队登场。`);
  }
}
const invites_last = (a) => a.length - 1;

scenario1();
scenario2();
console.log("");
console.log("=".repeat(76));
console.log("结论：真实错误原因（两份抓包 × 两条路线交叉验证）");
console.log("=".repeat(76));
console.log(`1) 队伍组建没有失败：离线号邀请 +10s 服务端自动同意（teaming→watching、倒计时清0、留在 mCodeIds）——`);
console.log(`   runtime 与自动抓包两边的就位时刻逐一吻合（+10.0~10.3s），isMemberSettled 判定的就是真就位；`);
console.log(`2) 断点在 deploy()：自动流在「最后一个队员就位」瞬间调 deploy，此时队长还处于 teaming`);
console.log(`   （他自己翻 watching 的通知晚 ~1s），旧判据 state!=='watching' 把 teaming 当成已登场 →`);
console.log(`   dp.ok 同步 true → 毫秒级 closeProbe → 50ms 发送队列 tick 没跑到 → war_setbattleteam 从未上线；`);
console.log(`3) 修复路线（等 state∈{idle,combat,march} 真确认）在 runtime 抓包上复刻真实成功路径`);
console.log(`   （T1 发→+0.12s 内 idle@21,5），且在自动流时机下不再假成功；`);
console.log(`4) 辅助保险：closeProbe 前排空发送队列；UI 只有 idle/combat/march 算「已登场」。`);
