// 解码 runtimeSaltfield jsonl 抓包（px/x 方案 + BON），统计命令与响应码
// 用法: node local-data/saltfield/260926_data/_analyze_runtime.mjs <jsonl路径> [--cmd 过滤正则]
import fs from "fs";

const FILE = process.argv[2] || "local-data/saltfield/260926_data/runtime_saltfield_failed_to_setout.jsonl";
const CMD_RE = process.argv[3] ? new RegExp(process.argv[3], "i") : null;

// ---------- BON（与 decode_captures.mjs 一致） ----------
class DataReader {
  constructor(bytes) { this._data = bytes; this.position = 0; }
  validate(n) { if (this.position + n > this._data.length) throw new Error("read eof"); return true; }
  readUInt8() { this.validate(1); return this._data[this.position++]; }
  readInt32() {
    this.validate(4);
    const v = this._data[this.position++] | (this._data[this.position++] << 8) | (this._data[this.position++] << 16) | (this._data[this.position++] << 24);
    return v | 0;
  }
  readInt64() {
    let lo = this.readInt32();
    const _lo = lo < 0 ? lo + 0x100000000 : lo;
    const hi = this.readInt32();
    return _lo + 0x100000000 * hi;
  }
  readFloat32() {
    this.validate(4);
    const v = new DataView(this._data.buffer, this._data.byteOffset, this._data.byteLength).getFloat32(this.position, true);
    this.position += 4; return v;
  }
  readFloat64() {
    this.validate(8);
    const v = new DataView(this._data.buffer, this._data.byteOffset, this._data.byteLength).getFloat64(this.position, true);
    this.position += 8; return v;
  }
  read7BitInt() {
    let value = 0, shift = 0, b = 0, count = 0;
    do {
      if (count++ === 35) throw new Error("Bad7BitInt");
      b = this.readUInt8();
      value |= (b & 0x7f) << shift; shift += 7;
    } while ((b & 0x80) !== 0);
    return value >>> 0;
  }
  readUTF() {
    const len = this.read7BitInt();
    this.validate(len);
    const s = new TextDecoder("utf8").decode(this._data.subarray(this.position, this.position + len));
    this.position += len; return s;
  }
  readUint8Array(len) { this.validate(len); const a = this._data.subarray(this.position, this.position + len); this.position += len; return a; }
}

function bonDecode(bytes) {
  const dr = new DataReader(bytes);
  const strArr = [];
  function decode() {
    const tag = dr.readUInt8();
    switch (tag) {
      case 0: return null;
      case 1: return dr.readInt32();
      case 2: return dr.readInt64();
      case 3: return dr.readFloat32();
      case 4: return dr.readFloat64();
      case 5: { const s = dr.readUTF(); strArr.push(s); return s; }
      case 6: return dr.readUInt8() === 1;
      case 7: { const len = dr.read7BitInt(); return dr.readUint8Array(len); }
      case 8: {
        const count = dr.read7BitInt();
        const obj = {};
        for (let i = 0; i < count; i++) { const k = decode(); const v = decode(); obj[k] = v; }
        return obj;
      }
      case 9: {
        const len = dr.read7BitInt();
        const arr = new Array(len);
        for (let i = 0; i < len; i++) arr[i] = decode();
        return arr;
      }
      case 10: return new Date(dr.readInt64());
      case 99: return strArr[dr.read7BitInt()];
      default: throw new Error(`unknown BON tag ${tag} @${dr.position - 1}`);
    }
  }
  return decode();
}

// ---------- x 方案解密（保留原 4 字节头） ----------
const xDecrypt = (e) => {
  const t =
    (((e[2] >> 6) & 1) << 7) | (((e[2] >> 4) & 1) << 6) | (((e[2] >> 2) & 1) << 5) | ((e[2] & 1) << 4) |
    (((e[3] >> 6) & 1) << 3) | (((e[3] >> 4) & 1) << 2) | (((e[3] >> 2) & 1) << 1) | (e[3] & 1);
  for (let n = e.length; --n >= 4; ) e[n] ^= t;
  return e.subarray(4);
};

function decodeHexFrame(rawHex) {
  const u8 = new Uint8Array(rawHex.length / 2);
  for (let i = 0; i < u8.length; i++) u8[i] = parseInt(rawHex.substr(i * 2, 2), 16);
  if (!(u8.length > 4 && u8[0] === 0x70 && u8[1] === 0x78)) return { scheme: "?", msg: null };
  try {
    const plain = xDecrypt(u8.slice());
    const msg = bonDecode(plain);
    return { scheme: "x", msg };
  } catch (e) {
    return { scheme: "x", msg: null, err: e.message };
  }
}

// ---------- 主流程 ----------
const lines = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean);
const events = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }

let okCount = 0, failCount = 0;
const decoded = [];
for (const ev of events) {
  if (!/ws:(send|message)/.test(ev?.event || "")) continue;
  const frame = ev?.payload?.frame;
  if (!frame?.rawHex) continue;
  const dir = ev.event === "ws:send" ? "send" : "recv";
  let msg = ev?.payload?.decoded?.msg || ev?.payload?.decoded || null;
  let err;
  if (!msg) {
    const r = decodeHexFrame(frame.rawHex);
    msg = r.msg; err = r.err;
  }
  if (!msg) { failCount++; continue; }
  okCount++;
  decoded.push({ id: ev.id, at: ev.at, dir, cmd: msg.cmd, code: msg.code, ack: msg.ack, seq: msg.seq, body: msg.body, raw: msg });
}

console.log(`decoded ${okCount} frames, failed ${failCount}`);
const stat = {};
for (const d of decoded) {
  const k = d.dir + " " + d.cmd + (d.dir === "recv" && d.code !== undefined && d.code !== 0 ? ` code=${d.code}` : "");
  stat[k] = (stat[k] || 0) + 1;
}
for (const k of Object.keys(stat).sort()) console.log(String(stat[k]).padStart(5), k);

// 详细打印过滤的命令
if (CMD_RE) {
  console.log("\n===== filtered frames =====");
  for (const d of decoded) {
    if (!CMD_RE.test(d.cmd || "")) continue;
    console.log(`#${d.id} ${d.at.slice(11, 23)} ${d.dir.toUpperCase()} ${d.cmd}${d.code !== undefined && d.code !== 0 ? " code=" + d.code + " hint=" + (d.raw.hint || "") : ""}`);
    console.log("  body:", JSON.stringify(d.body)?.slice(0, 800));
  }
}
