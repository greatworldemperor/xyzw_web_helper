import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

/**
 * public/game/first-frame-spoof.js 的行为回归。
 *
 * 样本来自真实抓包：local-data/pantao/pantao1/pantao_runtime_failed_to_enter/role_login.jsonl
 * （runtime 发出的首帧 role_getroleinfo，platformExt:"h5" / clientVersion:"1.89.8-wx"）。
 * local-data 被 gitignore，所以帧 hex 固化在这里。
 */
const REAL_FIRST_FRAME_HEX =
  "7078316c525f5f593b39315b5a5a5a5a5f5e38353e235d02525f5f522a363b2e3c3528375f5c3235282e35285f512a363b2e" +
  "3c3528371f222e5f58326f5f5333342c332e3f0f333e5b5a5a5a5a5f573936333f342e0c3f28293335345f536b7462637462" +
  "772d225f5f29393f343f5f5a5f5e2e33373f58a4cbf8e4fa5b5a5a5f59293f2b5b5b5a5a5a5f5939373e5f4a2835363f053d" +
  "3f2e2835363f33343c35";

const MIX_RULES = [
  {
    cmd: "role_getroleinfo",
    fields: { platformExt: "mix", clientVersion: "2.21.2-fa918e1997301834-wx" },
  },
];

const scriptSource = await readFile(
  new URL("../public/game/first-frame-spoof.js", import.meta.url),
  "utf8",
);
const { BonEncoder, bon, getEnc, parse } = await import("../src/utils/bonProtocol.js");

/**
 * 用项目自己的 BON 编码器构造内容（保证与真实帧同构）。
 * ⚠️ 必须 clone=true：DataWriter 用的是模块级共享 buffer（_shared），
 *    getBytes() 默认返回共享视图，下一次 encode 会把上一次的结果覆盖掉
 *    （实测：不 clone 时 body 内容会变成外层对象的开头）。
 */
function encodeBon(obj) {
  const enc = new BonEncoder();
  enc.encode(obj);
  return enc.getBytes(true);
}
/** 沙箱（vm）里产生的对象与宿主不同源，deepStrictEqual 会因原型不等失败 → 归一 */
const host = (value) => JSON.parse(JSON.stringify(value ?? null));
const toBytes = (u8) => Array.from(u8);
const hexToU8 = (hex) => new Uint8Array(Buffer.from(hex, "hex"));

/** 在假环境里执行注入脚本，返回宿主 API（顺带暴露 sent/logs/Proto 供断言） */
function loadScript({ config = null, pathname = "/game/index.html" } = {}) {
  const store = new Map();
  if (config) store.set("xyzwFrameSpoof", JSON.stringify(config));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const sent = [];
  function FakeWebSocket() {}
  FakeWebSocket.prototype.send = function (data) {
    sent.push(data);
    return "sent";
  };
  const win = { location: { pathname }, WebSocket: FakeWebSocket };
  win.window = win;
  const logs = [];
  vm.runInNewContext(scriptSource, {
    window: win,
    localStorage,
    console: {
      log: (...a) => logs.push(["log", a.join(" ")]),
      warn: (...a) => logs.push(["warn", a.join(" ")]),
      error: (...a) => logs.push(["error", a.join(" ")]),
    },
    TextEncoder,
    TextDecoder,
  });
  const api = win.__xyzwFrameSpoof;
  api._sent = sent;
  api._logs = logs;
  api._Proto = FakeWebSocket.prototype;
  api._store = store;
  return api;
}

/** 包成完整帧：px 头 + XOR（key material 与样本同款 0x31 0x6c） */
function wrapFrame(api, plain) {
  return api.pxEncrypt(plain, new Uint8Array([0x70, 0x78, 0x31, 0x6c]));
}

test("真实首帧：platformExt / clientVersion 被改写成 mix 口径", () => {
  const api = loadScript({ config: { enabled: true, rules: MIX_RULES } });
  const frame = hexToU8(REAL_FIRST_FRAME_HEX);

  const res = api.patchFrame(frame, MIX_RULES);
  assert.equal(res.cmd, "role_getroleinfo");
  assert.deepEqual(
    host(res.changes.map((c) => `${c.key}:${c.from}→${c.to}`)),
    ["platformExt:h5→mix", "clientVersion:1.89.8-wx→2.21.2-fa918e1997301834-wx"],
  );
  assert.ok(res.frame, "应返回改写后的帧");
  assert.notDeepEqual(toBytes(res.frame), toBytes(frame));
});

test("改写后的帧仍能被项目 BON 库正确解码（tag7 长度自洽）", () => {
  const api = loadScript({ config: { enabled: true, rules: MIX_RULES } });
  const res = api.patchFrame(hexToU8(REAL_FIRST_FRAME_HEX), MIX_RULES);

  const msg = parse(res.frame, getEnc("x"));
  assert.equal(msg.cmd, "role_getroleinfo", "cmd 不变");
  assert.equal(msg.seq, 1, "seq 不变（原帧 seq=1）");
  assert.equal(msg.ack, 0);

  const body = bon.decode(msg.body);
  assert.equal(body.platformExt, "mix", "platformExt 已改写");
  assert.equal(body.clientVersion, "2.21.2-fa918e1997301834-wx", "clientVersion 已改写");
  assert.equal(body.platform, "hortor", "未配置的字段保持原值");
  assert.equal(body.scene, "", "空字符串字段保持原值");
  assert.equal(body.inviteUid, 0);
});

test("值已是目标值时不再改动；命令不匹配时不动帧", () => {
  const api = loadScript({ config: { enabled: true, rules: MIX_RULES } });
  const once = api.patchFrame(hexToU8(REAL_FIRST_FRAME_HEX), MIX_RULES);
  const twice = api.patchFrame(once.frame, MIX_RULES);
  assert.deepEqual(host(twice.changes), [], "同值不再改");
  assert.equal(twice.frame, null);

  const other = api.patchFrame(hexToU8(REAL_FIRST_FRAME_HEX), [
    { cmd: "payload_setbattleteam", fields: { platformExt: "mix" } },
  ]);
  assert.deepEqual(host(other.changes), [], "命令不匹配时不改");
});

test("tag7 长度跨 128 边界（varint 变 2 字节）也能正确修正", () => {
  const api = loadScript({ config: { enabled: true, rules: MIX_RULES } });
  // 找一个 pad 长度使 body 明文长度 = 127（<128，varint 1 字节），
  // 替换 platformExt("h5"→"mix") 后 +1 = 128 → varint 必须变 2 字节
  let padLen = null;
  let plain = null;
  for (let n = 1; n < 200; n++) {
    const candidate = encodeBon({ cmd: "role_getroleinfo", body: encodeBon({ platformExt: "h5", pad: "x".repeat(n) }), seq: 1, ack: 0 });
    if (encodeBon({ platformExt: "h5", pad: "x".repeat(n) }).length === 127) {
      padLen = n;
      plain = candidate;
      break;
    }
  }
  assert.ok(padLen, "应能构造出跨 128 边界的样本（body 明文长度 127）");

  const res = api.patchFrame(wrapFrame(api, plain), [
    { cmd: "role_getroleinfo", fields: { platformExt: "mix" } },
  ]);
  assert.equal(res.changes.length, 1);

  const msg = parse(res.frame, getEnc("x"));
  const decoded = bon.decode(msg.body);
  assert.equal(decoded.platformExt, "mix");
  assert.equal(decoded.pad.length, padLen, "pad 内容未受影响");
  assert.ok(/^x+$/.test(decoded.pad));
});

test("字段值不是字符串（int）时安全跳过，不破坏帧", () => {
  const api = loadScript({ config: { enabled: true, rules: MIX_RULES } });
  const plain = encodeBon({ cmd: "role_getroleinfo", body: encodeBon({ inviteUid: 123 }), seq: 2, ack: 0 });
  const res = api.patchFrame(wrapFrame(api, plain), [
    { cmd: "role_getroleinfo", fields: { inviteUid: "mix" } },
  ]);
  assert.deepEqual(host(res.changes), [], "非字符串字段不改");
  assert.equal(res.frame, null);
});

test("启用后 WebSocket.send 发出的就是改写帧", () => {
  const api = loadScript({ config: { enabled: true, rules: MIX_RULES } });
  const frame = hexToU8(REAL_FIRST_FRAME_HEX);
  Object.create(api._Proto).send(frame);

  assert.equal(api._sent.length, 1);
  assert.notDeepEqual(toBytes(api._sent[0]), toBytes(frame), "发出的是改写后的帧");
  assert.deepEqual(host(api.stats), { frames: 1, parsed: 1, matched: 1, patched: 1, failed: 0 });
  assert.equal(api.records.length, 1);
  assert.equal(api.records[0].applied, true);
});

test("observeOnly=true 只记录不改字节", () => {
  const api = loadScript({ config: { enabled: true, observeOnly: true, rules: MIX_RULES } });
  const frame = hexToU8(REAL_FIRST_FRAME_HEX);
  Object.create(api._Proto).send(frame);

  assert.deepEqual(toBytes(api._sent[0]), toBytes(frame), "原帧原样发出");
  assert.equal(api.stats.patched, 0);
  assert.equal(api.records.length, 1);
  assert.equal(api.records[0].observed, true);
});

test("未启用（无配置 / enabled=false）时完全不干预", () => {
  for (const config of [null, { enabled: false, rules: MIX_RULES }]) {
    const api = loadScript({ config });
    const frame = hexToU8(REAL_FIRST_FRAME_HEX);
    Object.create(api._Proto).send(frame);

    assert.deepEqual(toBytes(api._sent[0]), toBytes(frame));
    assert.equal(api.stats.frames, 0, "未安装 hook 时不计数");
    assert.equal(api.applied.active, false);
  }
});

test("非 px 帧与垃圾数据放行且不抛错", () => {
  const api = loadScript({ config: { enabled: true, rules: MIX_RULES } });
  const inst = Object.create(api._Proto);

  inst.send(new Uint8Array([1, 2, 3, 4, 5]));             // 非 px 头
  inst.send(new Uint8Array([0x70, 0x78, 0x31, 0x6c, 9])); // px 头但内容不是合法 BON
  inst.send("plain text");                                 // 字符串

  assert.equal(api._sent.length, 3);
  assert.equal(api._sent[2], "plain text", "字符串原样放行");
  assert.equal(api.stats.frames, 2);
  assert.equal(api.stats.patched, 0);
  assert.equal(api.stats.failed, 0, "解析失败静默放行");
});

test("重复注入不会叠加 hook", () => {
  const api = loadScript({ config: { enabled: true, rules: MIX_RULES } });
  assert.equal(api._Proto.__xyzwFrameSpoofHooked, true);
  const before = api._Proto.send;
  vm.runInNewContext(scriptSource, {
    window: { location: { pathname: "/game/index.html" }, WebSocket: { prototype: api._Proto } },
    localStorage: { getItem: () => JSON.stringify({ enabled: true, rules: MIX_RULES }), setItem() {}, removeItem() {} },
    console: { log() {}, warn() {}, error() {} },
    TextEncoder,
    TextDecoder,
  });
  assert.equal(api._Proto.send, before, "二次注入应识别已 hook 并保持原方法");
});

test("配置读写：默认规则回落、observeOnly、clear", () => {
  const api = loadScript({ config: null });
  api.write({ enabled: true });
  const cfg = api.read();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.observeOnly, false);
  assert.deepEqual(host(cfg.rules), MIX_RULES, "未提供 rules 时回落到默认 mix 口径规则");

  api.write({ observeOnly: true, rules: [{ cmd: "", fields: { platformExt: "h5web" } }] });
  const cfg2 = api.read();
  assert.equal(cfg2.enabled, true, "enabled 保持原值");
  assert.equal(cfg2.observeOnly, true);
  assert.deepEqual(host(cfg2.rules), [{ cmd: "", fields: { platformExt: "h5web" } }]);

  api.clear();
  assert.equal(api.read(), null);
});

test("多开 runtime 用独立 localStorage 键", () => {
  const api = loadScript({ config: null, pathname: "/game/multi-game.html" });
  assert.equal(api.KEY, "xyzwMultiGameFrameSpoof");
});
