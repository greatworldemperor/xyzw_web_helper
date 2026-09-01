// 临时脚本：解码 MuMu 抓包的 wss bin 文件（x / lx 加密 + BON）
import fs from "fs";
import path from "path";
import lz4 from "lz4js";

const ROOT = process.argv[2] || "C:/Users/worldemperor/Documents/MuMu共享文件夹/captures/test1/binary";
const OUT = process.argv[3];
const lines = [];
const log = (s) => (OUT ? lines.push(s) : log(s));

// ---------- BON ----------
class DataReader {
  constructor(bytes) {
    this._data = bytes;
    this.position = 0;
  }
  validate(n) {
    if (this.position + n > this._data.length) throw new Error("read eof");
    return true;
  }
  readUInt8() {
    this.validate(1);
    return this._data[this.position++];
  }
  readInt32() {
    this.validate(4);
    const v =
      this._data[this.position++] |
      (this._data[this.position++] << 8) |
      (this._data[this.position++] << 16) |
      (this._data[this.position++] << 24);
    return v | 0;
  }
  readInt64() {
    let lo = this.readInt32();
    let _lo = lo < 0 ? lo + 0x100000000 : lo;
    const hi = this.readInt32();
    return _lo + 0x100000000 * hi;
  }
  readFloat32() {
    this.validate(4);
    const v = new DataView(
      this._data.buffer,
      this._data.byteOffset,
      this._data.byteLength,
    ).getFloat32(this.position, true);
    this.position += 4;
    return v;
  }
  readFloat64() {
    this.validate(8);
    const v = new DataView(
      this._data.buffer,
      this._data.byteOffset,
      this._data.byteLength,
    ).getFloat64(this.position, true);
    this.position += 8;
    return v;
  }
  read7BitInt() {
    let value = 0,
      shift = 0,
      b = 0,
      count = 0;
    do {
      if (count++ === 35) throw new Error("Bad7BitInt");
      b = this.readUInt8();
      value |= (b & 0x7f) << shift;
      shift += 7;
    } while ((b & 0x80) !== 0);
    return value >>> 0;
  }
  readUTF() {
    const len = this.read7BitInt();
    this.validate(len);
    const s = new TextDecoder("utf8").decode(
      this._data.subarray(this.position, this.position + len),
    );
    this.position += len;
    return s;
  }
  readUint8Array(len) {
    this.validate(len);
    const out = this._data.subarray(this.position, this.position + len);
    this.position += len;
    return out;
  }
}

function bonDecode(bytes) {
  const dr = new DataReader(bytes);
  const strArr = [];
  function decode() {
    const tag = dr.readUInt8();
    switch (tag) {
      case 0:
        return null;
      case 1:
        return dr.readInt32();
      case 2:
        return dr.readInt64();
      case 3:
        return dr.readFloat32();
      case 4:
        return dr.readFloat64();
      case 5: {
        const s = dr.readUTF();
        strArr.push(s);
        return s;
      }
      case 6:
        return dr.readUInt8() === 1;
      case 7: {
        const len = dr.read7BitInt();
        return dr.readUint8Array(len);
      }
      case 8: {
        const count = dr.read7BitInt();
        const obj = {};
        for (let i = 0; i < count; i++) {
          const k = decode();
          const v = decode();
          obj[k] = v;
        }
        return obj;
      }
      case 9: {
        const len = dr.read7BitInt();
        const arr = new Array(len);
        for (let i = 0; i < len; i++) arr[i] = decode();
        return arr;
      }
      case 10:
        return new Date(dr.readInt64());
      case 99:
        return strArr[dr.read7BitInt()];
      default:
        throw new Error(`unknown BON tag ${tag} @${dr.position - 1}`);
    }
  }
  return decode();
}

// ---------- 加密方案（与 bonProtocol.js 一致） ----------
const xDecrypt = (e) => {
  const t =
    (((e[2] >> 6) & 1) << 7) |
    (((e[2] >> 4) & 1) << 6) |
    (((e[2] >> 2) & 1) << 5) |
    ((e[2] & 1) << 4) |
    (((e[3] >> 6) & 1) << 3) |
    (((e[3] >> 4) & 1) << 2) |
    (((e[3] >> 2) & 1) << 1) |
    (e[3] & 1);
  for (let n = e.length; --n >= 4; ) e[n] ^= t;
  return e.subarray(4);
};

const lxDecrypt = (e) => {
  const t =
    (((e[2] >> 6) & 1) << 7) |
    (((e[2] >> 4) & 1) << 6) |
    (((e[2] >> 2) & 1) << 5) |
    ((e[2] & 1) << 4) |
    (((e[3] >> 6) & 1) << 3) |
    (((e[3] >> 4) & 1) << 2) |
    (((e[3] >> 2) & 1) << 1) |
    (e[3] & 1);
  for (let n = Math.min(100, e.length); --n >= 2; ) e[n] ^= t;
  e[0] = 4;
  e[1] = 34;
  e[2] = 77;
  e[3] = 24; // LZ4 frame magic 0x184D2204
  return lz4.decompress(e);
};

function decryptFrame(u8) {
  if (u8.length > 4 && u8[0] === 112 && u8[1] === 108) return { scheme: "lx", plain: lxDecrypt(u8) };
  if (u8.length > 4 && u8[0] === 112 && u8[1] === 120) return { scheme: "x", plain: xDecrypt(u8) };
  if (u8.length > 3 && u8[0] === 112 && u8[1] === 116) return { scheme: "xtm", plain: null };
  return { scheme: "?", plain: null };
}

// ---------- 主流程 ----------
function pretty(v) {
  if (v instanceof Uint8Array) {
    try {
      return pretty(bonDecode(v));
    } catch {
      return `[BON binary ${v.length}B] ${Buffer.from(v.subarray(0, 32)).toString("hex")}...`;
    }
  }
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(pretty);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = pretty(v[k]);
    return o;
  }
  return v;
}

if (OUT) fs.writeFileSync(OUT, "");

function processDir(dirPath, label) {
  log(`\n========== ${label} ==========`);
  for (const file of fs.readdirSync(dirPath).sort()) {
    const fp = path.join(dirPath, file);
    if (!fs.statSync(fp).isFile()) continue;
    const buf = fs.readFileSync(fp);
    const u8 = new Uint8Array(buf);
    log(`\n--- ${file} (${u8.length} bytes, head: ${buf.subarray(0, 8).toString("hex")}) ---`);
    try {
      const { scheme, plain } = decryptFrame(u8);
      if (!plain) {
        log(`  scheme=${scheme} 无法解密`);
        continue;
      }
      const raw = bonDecode(plain);
      const out = {};
      for (const k of Object.keys(raw)) out[k] = pretty(raw[k]);
      log(`  scheme=${scheme}  message= ${JSON.stringify(out, null, 2)}`);
    } catch (err) {
      log(`  解析失败: ${err.message}`);
    }
  }
}

const rootEntries = fs.readdirSync(ROOT, { withFileTypes: true });
const hasSubDir = rootEntries.some((e) => e.isDirectory());
if (hasSubDir) {
  for (const e of rootEntries) {
    if (e.isDirectory()) processDir(path.join(ROOT, e.name), e.name);
  }
} else {
  processDir(ROOT, path.basename(ROOT));
}

if (OUT) fs.writeFileSync(OUT, lines.join("\n"));

