// 解析 HttpCanary .hcy WSS 流文件（101 头 + WebSocket 帧序列）
// 用法: node _parse_hcy_stream.mjs <file.hcy> [dir=req|res]
// 客户端帧带 mask（req），服务端帧不带（res）；负载 = px 魔数 → xDecrypt → BON
import fs from "node:fs";

function xDecrypt(e) {
  if (e.length < 5 || e[0] !== 0x70 || e[1] !== 0x78) return null;
  const t =
    (((e[2] >> 6) & 1) << 7) |
    (((e[2] >> 4) & 1) << 6) |
    (((e[2] >> 2) & 1) << 5) |
    ((e[2] & 1) << 4) |
    (((e[3] >> 6) & 1) << 3) |
    (((e[3] >> 4) & 1) << 2) |
    (((e[3] >> 2) & 1) << 1) |
    (e[3] & 1);
  const out = new Uint8Array(e.length - 4);
  for (let n = e.length; --n >= 4; ) out[n - 4] = e[n] ^ t;
  return out;
}

function bonDecode(data) {
  let pos = 0;
  const strings = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rb = () => data[pos++];
  const r32 = () => (rb() | (rb() << 8) | (rb() << 16) | (rb() << 24)) | 0;
  const r64 = () => {
    const lo = r32();
    return lo + 0x100000000 * r32();
  };
  const r7 = () => {
    let v = 0, s = 0, c = 0, b;
    do {
      if (c++ === 35) throw new Error("ovf");
      b = rb();
      v |= (b & 0x7f) << s;
      s += 7;
    } while (b & 0x80);
    return v >>> 0;
  };
  const ru = () => {
    const l = r7();
    const s = new TextDecoder("utf-8").decode(data.subarray(pos, pos + l));
    pos += l;
    return s;
  };
  const dec = () => {
    const tag = rb();
    if (tag === 0) return null;
    if (tag === 1) return r32();
    if (tag === 2) return r64();
    if (tag === 3) { const v = view.getFloat32(pos, true); pos += 4; return v; }
    if (tag === 4) { const v = view.getFloat64(pos, true); pos += 8; return v; }
    if (tag === 5) { const s = ru(); strings.push(s); return s; }
    if (tag === 6) return rb() === 1;
    if (tag === 7) { const n = r7(); const b = data.subarray(pos, pos + n); pos += n; return b; }
    if (tag === 8) { const n = r7(); const o = {}; for (let i = 0; i < n; i++) o[dec()] = dec(); return o; }
    if (tag === 9) { const n = r7(); const a = []; for (let i = 0; i < n; i++) a.push(dec()); return a; }
    if (tag === 10) return new Date(r64());
    if (tag === 99) return strings[r7()];
    throw new Error("tag " + tag + " @" + (pos - 1));
  };
  return dec();
}

const [file, dirTag] = process.argv.slice(2);
const raw = fs.readFileSync(file);

// 1. 跳过 HTTP 头
const headerEnd = raw.indexOf(Buffer.from("\r\n\r\n"));
if (headerEnd < 0) { console.error("no http header terminator"); process.exit(1); }
console.error(`HTTP header: ${headerEnd + 4} bytes`);

// 2. 顺序解析 WS 帧
const frames = [];
let p = headerEnd + 4;
let count = 0;
while (p + 2 <= raw.length) {
  const b0 = raw[p], b1 = raw[p + 1];
  const fin = (b0 >> 7) & 1;
  const opcode = b0 & 0x0f;
  const masked = (b1 >> 7) & 1;
  let len = b1 & 0x7f;
  let q = p + 2;
  if (len === 126) { len = raw.readUInt16BE(q); q += 2; }
  else if (len === 127) { len = Number(raw.readBigUInt64BE(q)); q += 8; }
  let maskKey = null;
  if (masked) { maskKey = raw.slice(q, q + 4); q += 4; }
  const payload = raw.slice(q, q + len);
  q += len;
  if (q > raw.length + 4) { console.error(`frame ${count}: truncated (len=${len} at ${p})`); break; }

  const unmasked = masked
    ? Uint8Array.from(payload, (b, i) => b ^ maskKey[i % 4])
    : new Uint8Array(payload);

  let msg = null;
  const plain = xDecrypt(unmasked);
  if (plain) {
    try {
      msg = bonDecode(plain);
      if (msg && msg.body instanceof Uint8Array) {
        try { msg.bodyDecoded = bonDecode(msg.body); } catch {}
      }
    } catch {}
  }
  frames.push({ idx: count, fin, opcode, masked, len, msg });
  count++;
  p = q;
}

console.error(`WS frames parsed: ${count}`);
const t0Raw = frames.find((f) => f.msg?.time > 0)?.msg?.time || 0;
const fmt = (ts) => new Date(ts).toTimeString().slice(0, 8);

// 3. 输出
const interesting = process.argv[3] || "";
let out = [];
for (const f of frames) {
  const m = f.msg;
  if (!m) { out.push(`${f.idx}\t!${f.opcode === 9 ? "ping" : f.opcode === 10 ? "pong" : "op" + f.opcode}\t${f.len}B`); continue; }
  const t = m.time > 0 ? fmt(m.time) : "?";
  const row = `${f.idx}\t${t}\tseq=${m.seq ?? "-"}\t${m.cmd || "?"}${m.code ? ` code=${m.code}` : ""}\t${JSON.stringify(m.bodyDecoded ?? m.body ?? "").slice(0, Number(interesting) || 260)}`;
  out.push(row);
}
console.log(out.join("\n"));
