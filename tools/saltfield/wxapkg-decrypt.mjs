// PC 微信加密 wxapkg 解密 + 解包（appid 已知：wx0840558555a454ed）
// 方案：magic "V1MMWX" → 前 1024B AES-256-CBC(key=md5hex(appid), iv="the iv: 16 bytes") 取前 1023B；
//       其余 XOR（key 暴力枚举，按可打印率选定）；再按 wxapkg 索引解出内部文件。
// 用法: node _wxapkg_decrypt.mjs <in.wxapkg> <outDir>
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const APPID = "wx0840558555a454ed";
const [inFile, outDir] = process.argv.slice(2);
if (!inFile || !outDir) {
  console.error("usage: node _wxapkg_decrypt.mjs <in.wxapkg> <outDir>");
  process.exit(1);
}

const buf = fs.readFileSync(inFile);
if (buf.slice(0, 6).toString("latin1") !== "V1MMWX") {
  console.error("not V1MMWX encrypted");
  process.exit(1);
}

// --- 第一段：AES-256-CBC（key = PBKDF2(appid, "saltiest", 1000, 32, sha1)，已对 0xBE..0xED 魔数验证） ---
const key = crypto.pbkdf2Sync(APPID, "saltiest", 1000, 32, "sha1");
const iv = "the iv: 16 bytes";
const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
decipher.setAutoPadding(false);
const head = Buffer.concat([
  decipher.update(buf.slice(6, 6 + 1024)),
  decipher.final(),
]).slice(0, 1023);

if (head[0] !== 0xbe || head[13] !== 0xed) {
  console.error(`AES head verify FAILED: head[0]=0x${head[0].toString(16)} head[13]=0x${head[13].toString(16)}`);
  process.exit(1);
}
console.log("AES head verify OK (0xBE...0xED)");

// --- 第二段：XOR（终极判定：枚举 256 key，完整解析索引成功的才算对） ---
const tailEnc = buf.slice(6 + 1024);
const HEAD_LEN = 1023;
function tryParse(plain) {
  if (plain[0] !== 0xbe || plain[13] !== 0xed) return null;
  const indexInfoLen = plain.readUInt32BE(5);
  const bodyInfoLen = plain.readUInt32BE(9);
  if (indexInfoLen <= 0 || indexInfoLen > plain.length) return null;
  let p = 14;
  let fileCount;
  try { fileCount = plain.readUInt32BE(p); } catch { return null; }
  p += 4;
  if (fileCount <= 0 || fileCount > 100000) return null;
  const entries = [];
  for (let i = 0; i < fileCount; i++) {
    if (p + 4 > 14 + indexInfoLen) return null;
    const nameLen = plain.readUInt32BE(p); p += 4;
    if (nameLen <= 0 || nameLen > 1024 || p + nameLen + 8 > 14 + indexInfoLen) return null;
    const name = plain.slice(p, p + nameLen).toString("utf8"); p += nameLen;
    if (!/^[\x20-\x7e]+$/.test(name)) return null;
    const off = plain.readUInt32BE(p); p += 4;
    const size = plain.readUInt32BE(p); p += 4;
    // off 是相对整个 plain 的绝对偏移（entry0 = 14+indexInfoLen）
    if (off + size > plain.length) return null;
    entries.push({ name, off, size });
  }
  if (p - 14 !== indexInfoLen) return null;
  return { indexInfoLen, bodyInfoLen, entries };
}
let bestXor = -1, parsed = null;
for (let x = 0; x < 256 && bestXor < 0; x++) {
  const plain = Buffer.alloc(HEAD_LEN + tailEnc.length);
  head.copy(plain, 0);
  for (let i = 0; i < tailEnc.length; i++) plain[HEAD_LEN + i] = tailEnc[i] ^ x;
  const r = tryParse(plain);
  if (r) { bestXor = x; parsed = { plain, ...r }; }
}
if (bestXor < 0) { console.error("no XOR key yields a valid index parse"); process.exit(1); }
console.log(`XOR key = 0x${bestXor.toString(16).padStart(2, "0")} (index parse validated)`);
const { plain, indexInfoLen, bodyInfoLen, entries } = parsed;
console.log(`indexInfoLen=${indexInfoLen} bodyInfoLen=${bodyInfoLen} plainTotal=${plain.length} fileCount=${entries.length}`);

fs.mkdirSync(outDir, { recursive: true });
let ok = 0;
for (const e of entries) {
  const dst = path.join(outDir, e.name);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const data = plain.slice(e.off, e.off + e.size);
  fs.writeFileSync(dst, data);
  ok++;
}
console.log(`extracted ${ok}/${entries.length} files -> ${outDir}`);
