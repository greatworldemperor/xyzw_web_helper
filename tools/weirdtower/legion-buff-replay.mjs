// 离线回放：用真实抓包 evotower_get_buff.jsonl 的字节验证 weirdTowerLegionBuff
// 的档位推导与「顶层 vs 嵌套」口径。
//
// 🔴 这个脚本的价值：证明纯逻辑模块的输入形状 = 真实抓包的解码结果，
//    不是我手搓的假对象。
//
// 抓包自动探测：local-data/ → ../captures_keep/（local-data 在 .gitignore 里，
// 换机器/清理后可能不在；见 docs/kb/02-toolchain-deploy.md）
//
// 用法: node tools/weirdtower/legion-buff-replay.mjs [jsonl路径]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnc } from "../../src/utils/bonProtocol.js";
import {
  buildTierStates,
  canClaim,
  countParticipants,
  countPendingClaims,
  isEmptyClaim,
  pickClaimedThisTime,
  pickUnlockedTiers,
  resolveReachedTier,
  summarizeBuff,
} from "../../src/utils/weirdTowerLegionBuff.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const CANDIDATES = [
  path.join(REPO, "local-data", "weird_tower", "evotower_get_buff.jsonl"),
  path.join(REPO, "..", "captures_keep", "weird_tower", "evotower_get_buff.jsonl"),
];
const FILE =
  process.argv[2] ||
  CANDIDATES.find((p) => fs.existsSync(p));

if (!FILE || !fs.existsSync(FILE)) {
  console.error("✗ 找不到抓包文件。已尝试：");
  CANDIDATES.forEach((p) => console.error("   " + p));
  console.error("请显式传参：node tools/weirdtower/legion-buff-replay.mjs <jsonl路径>");
  process.exit(2);
}

const h2b = (h) => {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
};

/** 通用 BON 解码（支持 tag99 引用、嵌套 bytes 递归） */
function makeReader(bytes) {
  const p = { i: 0 };
  const u8 = () => bytes[p.i++];
  const i32 = () => {
    const v = bytes[p.i++] | (bytes[p.i++] << 8) | (bytes[p.i++] << 16) | (bytes[p.i++] << 24);
    return v | 0;
  };
  const i64 = () => {
    const lo = BigInt(i32() >>> 0);
    const hi = BigInt(i32() >>> 0);
    return Number((hi << 32n) | lo);
  };
  const f32 = () => {
    const v = new DataView(bytes.buffer, bytes.byteOffset + p.i, 4).getFloat32(0, true);
    p.i += 4;
    return v;
  };
  const f64 = () => {
    const v = new DataView(bytes.buffer, bytes.byteOffset + p.i, 8).getFloat64(0, true);
    p.i += 8;
    return v;
  };
  const r7 = () => {
    let v = 0, s = 0;
    for (;;) {
      const c = bytes[p.i++];
      v |= (c & 0x7f) << s;
      if (!(c & 0x80)) break;
      s += 7;
    }
    return v >>> 0;
  };
  const utf = () => {
    const n = r7();
    const s = new TextDecoder().decode(bytes.subarray(p.i, p.i + n));
    p.i += n;
    return s;
  };
  const refs = [];
  const readVal = (depth) => {
    const t = u8();
    switch (t) {
      case 1: return i32();
      case 2: return i64();
      case 3: return f32();
      case 4: return f64();
      case 5: { const s = utf(); refs.push(s); return s; }
      case 6: return u8() === 1;
      case 7: {
        const n = r7();
        const b = bytes.subarray(p.i, p.i + n);
        p.i += n;
        if (depth < 3 && n > 0) {
          try {
            const sub = makeReader(b).readRoot();
            if (sub && typeof sub === "object") return sub;
          } catch {}
        }
        return { __bytes: n };
      }
      case 8: {
        const cnt = r7();
        const o = {};
        for (let k = 0; k < cnt; k++) { const key = readVal(depth); o[key] = readVal(depth); }
        return o;
      }
      case 9: {
        const cnt = r7();
        const a = [];
        for (let k = 0; k < cnt; k++) a.push(readVal(depth));
        return a;
      }
      case 10: return i64();
      case 99: return refs[r7()];
      default: throw new Error("unknown tag " + t);
    }
  };
  return { readRoot: () => readVal(0) };
}

const lines = fs
  .readFileSync(FILE, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const decoded = [];
for (const o of lines) {
  const d = o?.payload?.decoded;
  const fr = o?.payload?.frame;
  if (!d?.cmd || !fr?.rawHex) continue;
  try {
    // envelope = { seq, ack, time, resp, cmd, body:{...} }，业务字段在 envelope.body
    const envelope = makeReader(getEnc(fr.scheme).decrypt(h2b(fr.rawHex))).readRoot();
    decoded.push({
      seq: d.seq,
      event: o.event,
      cmd: d.cmd,
      body: envelope?.body ?? {},
    });
  } catch (e) {
    console.warn(`跳过 #${o.id} ${d.cmd}: ${e.message}`);
  }
}

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      实际=${JSON.stringify(actual)}\n      期望=${JSON.stringify(expected)}`); }
};

console.log("=".repeat(72));
console.log("怪异塔俱乐部 buff · 真实抓包离线回放");
console.log(`文件: ${FILE}  ·  成功解码 ${decoded.length} 帧`);
console.log("=".repeat(72));

// ---------- 1. 找 getlegionjoinmembers 响应 ----------
const memberFrames = decoded.filter((f) => f.cmd === "EvoTower_GetLegionJoinMembersResp");
console.log(`\n[1] getlegionjoinmembers 响应 × ${memberFrames.length}`);
check("三次返回完全一致（稳定状态快照）",
  new Set(memberFrames.map((f) => JSON.stringify(f.body))).size, 1);

const memberScores = memberFrames[0]?.body?.memberScores || {};
const n = countParticipants(memberScores);
console.log(`  参与人数 = ${n}（只数 key 数，不看层数）`);
check("参与人数 = 21", n, 21);
check("达档 = 3（21 >= 20）", resolveReachedTier(n), 3);
check("第 4 档（25人）未达", resolveReachedTier(n) < 4, true);

// ---------- 2. getinfo：绑定状态 ----------
const infoFrames = decoded.filter((f) => f.cmd === "EvoTowerInfoResp");
console.log(`\n[2] getinfo 响应 × ${infoFrames.length}`);
const tower = infoFrames[0]?.body?.evoTower || {};
check("bindLegionId = 7203672（已完成首次战斗 → 已绑定）", tower.bindLegionId, 7203672);
check("领取前 legionPrivilege 为空 {}", Object.keys(tower.legionPrivilege || {}).length, 0);
const gate = canClaim({ bindLegionId: tower.bindLegionId, participantCount: n });
check("canClaim(已绑定 + 21人) = true", gate.ok, true);

// ---------- 3. claim 三次：顶层 vs 嵌套 ----------
const claimFrames = decoded
  .filter((f) => f.cmd === "EvoTower_ClaimLegionPrivilegeResp")
  .sort((a, b) => a.seq - b.seq);
console.log(`\n[3] claimlegionprivilege 响应 × ${claimFrames.length}`);

const unlockedPerFrame = claimFrames.map((f) => pickUnlockedTiers(f.body));
console.log(`  顶层 legionPrivilege（已解锁全量）: ${unlockedPerFrame.map((u) => `[${u}]`).join(" ")}`);
check("顶层三次恒为 [1,2,3]", unlockedPerFrame, [[1, 2, 3], [1, 2, 3], [1, 2, 3]]);

const claimedPerFrame = claimFrames.map((f) => pickClaimedThisTime(f.body));
console.log(`  嵌套 evoTower.legionPrivilege（本次）: ${claimedPerFrame.map((u) => `[${u}]`).join(" ")}`);
check("本次逐档递进[1]→[2]→[3]", claimedPerFrame, [[1], [2], [3]]);
check("三次都非空（isEmptyClaim=false）", claimFrames.map((f) => isEmptyClaim(f.body)), [false, false, false]);

// ---------- 4. 模拟「一键领取」循环 ----------
console.log("\n[4] 模拟一键领取循环（一次一档）");
const unlockedAll = pickUnlockedTiers(claimFrames[claimFrames.length - 1].body);
check("循环上界 = 待领档数 3", countPendingClaims({ participantCount: n, claimedTiers: [] }), 3);

const acc = [];
let rounds = 0;
for (const f of claimFrames) {
  rounds++;
  const got = pickClaimedThisTime(f.body);
  if (got.length === 0) break;
  acc.push(...got);
}
check(`实际领了 ${acc.length} 档（第 ${acc.join("、")} 档）`, acc.length, 3);
check(`循环 ${rounds} 轮后与顶层已解锁一致`, [...acc].sort((a, b) => a - b), unlockedAll);

// 🔴 反证：如果错用顶层做「本次结果」，第一次就以为领完
const wrongFirstRound = pickUnlockedTiers(claimFrames[0].body);
console.log(`\n  🔴 反证：若用顶层当本次结果，第 1 轮就会误判为已领 ${wrongFirstRound.length} 档 → 循环提前结束`);
check("正确口径下第 1 轮只领 1 档", pickClaimedThisTime(claimFrames[0].body).length, 1);
check("错误口径下第 1 轮会误判 3 档", wrongFirstRound.length, 3);

// ---------- 5. 四档状态（UI 展示） ----------
console.log("\n[5] 四档状态（领取前）");
const before = buildTierStates({ participantCount: n, claimedTiers: [] });
before.forEach((r) => console.log(`  ${r.label} · ${r.threshold}人 · ${r.state} · ${r.desc}`));
check("四档齐全", before.length, 4);
check("1/2/3 可领、4 未达", before.map((r) => r.state), ["claimable", "claimable", "claimable", "locked"]);

console.log("\n[6] 四档状态（领取后）");
const after = buildTierStates({ participantCount: n, claimedTiers: acc });
after.forEach((r) => console.log(`  ${r.label} · ${r.threshold}人 · ${r.state} · ${r.desc}`));
check("1/2/3 已领、4 未达", after.map((r) => r.state), ["claimed", "claimed", "claimed", "locked"]);
check("无待领档位", countPendingClaims({ participantCount: n, claimedTiers: acc }), 0);

// ---------- 7. 边界：满级 25 人 ----------
console.log("\n[7] 边界：25 人满级（协议未抓到，用纯逻辑验证 4 档全解锁）");
const full = buildTierStates({ participantCount: 25, claimedTiers: [] });
full.forEach((r) => console.log(`  ${r.label} · ${r.threshold}人 · ${r.state}`));
check("25 人 → 4 档全部可领", full.map((r) => r.state), ["claimable", "claimable", "claimable", "claimable"]);
check("满级待领 4 档（循环 4 次）", countPendingClaims({ participantCount: 25, claimedTiers: [] }), 4);
console.log(`  ${summarizeBuff({ participantCount: 25, claimedTiers: [] }).headline}`);

console.log("\n" + "=".repeat(72));
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(72));
process.exit(fail === 0 ? 0 : 1);
