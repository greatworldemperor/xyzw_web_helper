// 盐场抓包：全场玩家 loginPlatform × 战场成就 交叉分析
//
// 背景（2026-10-04）：3000070「客户端数据异常」的归因排查。
// role_getroleinfo（登录首帧）是单播，别人的版本号/平台字段抓不到；
// 但服务端在战场 roles 表里广播了每个玩家的 **loginPlatform**（登录平台），
// 配合状态演进（watching/teaming/idle/combat/march）即可回答：
//   「野外各种平台的玩家，实际能做成哪些动作？」
//   → 哪些平台能登场、能行军、能成功开战（StartBattleResp 的 roleCodeId）
//
// 用法: node tools/saltfield/saltfield-platform-achievement.mjs [盐场jsonl路径]
//   缺省数据目录探测同 saltfield-offline-replay-test.mjs（local-data → captures_keep）
import fs from "fs";
import path from "path";
import url from "url";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");
const CANDIDATE_DIRS = [
  path.join(REPO, "local-data/saltfield/260926_data"),
  path.resolve(REPO, "../captures_keep/saltfield_260926"),
];
const DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : CANDIDATE_DIRS.find((d) => fs.existsSync(path.join(d, "saltfield-wss-2026-09-26-12-06-33.jsonl")));
if (!DIR) {
  console.error("找不到盐场抓包（saltfield-wss-2026-09-26-12-06-33.jsonl）");
  process.exit(1);
}
const FILE = path.join(DIR, "saltfield-wss-2026-09-26-12-06-33.jsonl");

const lines = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean);
const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const players = {}; // cid -> {platform, name, states:Set}
function noteRoles(roles) {
  for (const [cid, r] of Object.entries(roles || {})) {
    if (!r || typeof r !== "object") continue;
    const p = (players[cid] = players[cid] || { platform: null, name: r.name || "", states: new Set() });
    if (r.loginPlatform) p.platform = r.loginPlatform;
    if (r.name) p.name = r.name;
    if (r.state) p.states.add(r.state);
  }
}
const startBattleAttackers = [];
for (const r of rows) {
  const bf = r.body?.battlefield;
  if (bf?.roles) noteRoles(bf.roles);
  if (r.body?.roles) noteRoles(r.body.roles);
  if (r.dir === "recv" && /startbattleresp/i.test(r.cmd || "") && r.body?.roleCodeId !== undefined) {
    startBattleAttackers.push(String(r.body.roleCodeId));
  }
}

const DEPLOYED = ["idle", "combat", "march"];
const byPlatform = {};
for (const p of Object.values(players)) {
  const k = p.platform || "(unknown)";
  byPlatform[k] = byPlatform[k] || { total: 0, deployed: 0, fought: 0, marched: 0 };
  byPlatform[k].total++;
  if ([...p.states].some((s) => DEPLOYED.includes(s))) byPlatform[k].deployed++;
  if (p.states.has("combat")) byPlatform[k].fought++;
  if (p.states.has("march")) byPlatform[k].marched++;
}
console.log("全场可见玩家数:", Object.keys(players).length);
console.log("StartBattleResp 广播数:", startBattleAttackers.length, "（开战者去重:", new Set(startBattleAttackers).size, "）");
console.log("\n===== loginPlatform × 战场成就 =====");
for (const [k, v] of Object.entries(byPlatform).sort((a, b) => b[1].total - a[1].total)) {
  console.log(k.padEnd(16), "玩家", String(v.total).padStart(3), "| 登场", String(v.deployed).padStart(3), "| combat", String(v.fought).padStart(3), "| 行军", String(v.marched).padStart(3));
}
const fighterPlatforms = {};
for (const cid of startBattleAttackers) {
  const k = players[cid]?.platform || "(unknown)";
  fighterPlatforms[k] = (fighterPlatforms[k] || 0) + 1;
}
console.log("\n===== 成功开战者（StartBattleResp）平台分布 =====");
for (const [k, v] of Object.entries(fighterPlatforms).sort((a, b) => b[1] - a[1])) console.log(k.padEnd(16), v);
