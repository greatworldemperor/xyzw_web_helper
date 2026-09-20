/**
 * 首帧口径改写（first-frame spoof）—— 3000070 归因验证工具（runtime 侧）
 *
 * 背景（2026-09-20 抓包实锤）：
 *   - 官方 H5 入口在 WS 首帧 role_getroleinfo 里上报 platformExt:"h5" / clientVersion:"1.89.8-wx"；
 *     真实客户端（项目协议客户端注册口径）上报的是 platformExt:"mix" / clientVersion:"2.21.2-fa918e1997301834-wx"。
 *   - 猜测：服务端 3000070（客户端数据异常）按这个上报口径拦战斗类动作
 *     （盐场 war_startbattle PVP 全败、蟠桃 payload_setbattleteam 全败，而进场/攻击建筑都成功）。
 *   - platform-spoof.js 只改 window.PLATFORM，网页环境可登录的只有 h5/h5web（mix 不是映射表 key、wx 会切 App SDK），
 *     所以「改全局」这条路走不通。本脚本改的是**帧内容本身**：直接把发出去的字节里的字段换掉。
 *
 * 原理（就地字节替换，不重编码整帧）：
 *   帧格式 = px 头（70 78 + 2 字节 key material）+ XOR 混淆的 BON。
 *   1. XOR 解出明文；2. 解析 BON 拿到节点区间；3. 只替换目标字段的 tag5 字符串字节；
 *   4. 自内向外修正所有包住该字段的 tag7（bytes）长度字段 —— 帧其余字节原样不动。
 *   实测首帧（pantao1/role_login.jsonl）明文布局：
 *     08 05 | 05 03 "ack" 01 00000000 | 05 04 "body" 07 58 <88字节嵌套BON> | 05 03 "seq" ... | 05 03 "cmd" 05 10 "role_getroleinfo"
 *     嵌套 BON 内：05 08 "platform" 05 06 "hortor" | 05 0b "platformExt" 05 02 "h5" | 05 0d "clientVersion" 05 09 "1.89.8-wx"
 *   ⇒ platformExt / clientVersion 的值都是 tag5 字面量，可直接替换；body 是 tag7，长度必须同步。
 *
 * 开关（与 platform-spoof.js 同样区分单开/多开）：
 *   单开 localStorage["xyzwFrameSpoof"]，多开 localStorage["xyzwMultiGameFrameSpoof"]：
 *   {
 *     "enabled": true,
 *     "observeOnly": false,
 *     "rules": [{ "cmd": "role_getroleinfo",
 *                 "fields": { "platformExt": "mix", "clientVersion": "2.21.2-fa918e1997301834-wx" } }]
 *   }
 *   - enabled=false 或缺省 → 完全不干预。
 *   - observeOnly=true → 只记录命中的帧与字段现值，不改字节（先用来确认字段确实在帧里）。
 *   - rules[].cmd 为空串/null 表示匹配所有命令。
 *
 * 宿主 API：window.__xyzwFrameSpoof = { KEY, read, write, clear, applied, stats, records, patchFrame }
 */
(function () {
  "use strict";

  var isMultiGameRuntime = /(?:^|\/)multi-game\.html$/i.test(
    String((window.location && window.location.pathname) || "")
  );
  var LS_KEY = isMultiGameRuntime ? "xyzwMultiGameFrameSpoof" : "xyzwFrameSpoof";

  var DEFAULT_RULES = [
    {
      cmd: "role_getroleinfo",
      fields: {
        platformExt: "mix",
        clientVersion: "2.21.2-fa918e1997301834-wx",
      },
    },
  ];
  var MAX_RECORDS = 20;

  // ---------------------------------------------------------------- px 混淆层
  function pxKey(e) {
    return (
      (((e[2] >> 6) & 1) << 7) | (((e[2] >> 4) & 1) << 6) | (((e[2] >> 2) & 1) << 5) | ((e[2] & 1) << 4) |
      (((e[3] >> 6) & 1) << 3) | (((e[3] >> 4) & 1) << 2) | (((e[3] >> 2) & 1) << 1) | (e[3] & 1)
    );
  }
  function isPxFrame(u8) {
    return u8 && u8.length >= 5 && u8[0] === 0x70 && u8[1] === 0x78;
  }
  function pxDecrypt(u8) {
    if (!isPxFrame(u8)) return null;
    var t = pxKey(u8);
    var out = new Uint8Array(u8.length - 4);
    for (var i = u8.length - 1; i >= 4; i--) out[i - 4] = u8[i] ^ t;
    return out;
  }
  /** 加密：保留原 4 字节头（key material 不变 ⇒ 服务端算出的 t 一致），只 XOR 数据段 */
  function pxEncrypt(plain, header) {
    var t = pxKey(header);
    var out = new Uint8Array(4 + plain.length);
    out.set(header.subarray(0, 4), 0);
    for (var i = 0; i < plain.length; i++) out[4 + i] = plain[i] ^ t;
    return out;
  }

  // ---------------------------------------------------------------- varint
  function readVarint(u8, pos) {
    var v = 0, shift = 0, b, guard = 0;
    do {
      if (guard++ > 5) throw new Error("varint overflow");
      b = u8[pos++];
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return { value: v >>> 0, next: pos, bytes: shift / 7 };
  }
  function writeVarint(v) {
    var out = [];
    var n = v >>> 0;
    do {
      var b = n & 0x7f;
      n >>>= 7;
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    return out;
  }

  // ---------------------------------------------------------------- BON 解析（带偏移）
  // 节点：{ tag, start, end, lenFieldStart, lenFieldBytes, contentStart, contentEnd, value, children, nested }
  var TAG = { NULL: 0, INT: 1, LONG: 2, FLOAT: 3, DOUBLE: 4, STRING: 5, BOOL: 6, BYTES: 7, OBJECT: 8, ARRAY: 9, DATE: 10, REF: 99 };

  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }
  function utf8String(u8, start, len) {
    if (typeof TextDecoder !== "undefined") {
      try { return new TextDecoder("utf-8").decode(u8.subarray(start, start + len)); } catch (e) {}
    }
    var s = "";
    for (var i = start; i < start + len; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  /**
   * 解析 BON 节点。state = { u8, pos, end, strings }
   * 返回节点对象（含字节区间），失败抛异常 —— 调用方负责降级放行。
   */
  function parseNode(state) {
    var u8 = state.u8;
    var start = state.pos;
    var tag = u8[state.pos++];
    var node = { tag: tag, start: start, end: start };

    if (tag === TAG.NULL) { node.value = null; node.end = state.pos; return node; }

    if (tag === TAG.INT) {
      node.value =
        u8[state.pos] | (u8[state.pos + 1] << 8) | (u8[state.pos + 2] << 16) | (u8[state.pos + 3] << 24);
      state.pos += 4; node.value = node.value | 0; node.end = state.pos; return node;
    }
    if (tag === TAG.LONG) {
      var lo = u8[state.pos] | (u8[state.pos + 1] << 8) | (u8[state.pos + 2] << 16) | (u8[state.pos + 3] << 24);
      state.pos += 4;
      var hi = u8[state.pos] | (u8[state.pos + 1] << 8) | (u8[state.pos + 2] << 16) | (u8[state.pos + 3] << 24);
      state.pos += 4;
      node.value = (hi * 0x100000000) + (lo < 0 ? lo + 0x100000000 : lo);
      node.end = state.pos; return node;
    }
    if (tag === TAG.FLOAT) {
      node.value = readF32(u8, state.pos); state.pos += 4; node.end = state.pos; return node;
    }
    if (tag === TAG.DOUBLE) {
      node.value = readF64(u8, state.pos); state.pos += 8; node.end = state.pos; return node;
    }
    if (tag === TAG.BOOL) {
      node.value = u8[state.pos++] === 1; node.end = state.pos; return node;
    }
    if (tag === TAG.DATE) {
      var dlo = u8[state.pos] | (u8[state.pos + 1] << 8) | (u8[state.pos + 2] << 16) | (u8[state.pos + 3] << 24);
      state.pos += 8;
      node.value = dlo; node.end = state.pos; return node;
    }
    if (tag === TAG.STRING) {
      var lr = readVarint(u8, state.pos);
      state.pos = lr.next;
      var s = utf8String(u8, state.pos, lr.value);
      state.strings.push(s);
      state.pos += lr.value;
      node.value = s;
      node.valueStart = lr.next;      // 内容起点
      node.valueLen = lr.value;
      node.end = state.pos;
      return node;
    }
    if (tag === TAG.REF) {
      var ir = readVarint(u8, state.pos);
      state.pos = ir.next;
      node.value = state.strings[ir.value];
      node.isRef = true;
      node.end = state.pos;
      return node;
    }
    if (tag === TAG.BYTES) {
      var lb = readVarint(u8, state.pos);
      node.lenFieldStart = state.pos;
      node.lenFieldBytes = lb.bytes;
      state.pos = lb.next;
      node.contentStart = state.pos;
      node.contentLen = lb.value;
      state.pos += lb.value;
      node.contentEnd = state.pos;
      node.end = state.pos;
      // 嵌套 BON：能完整解析且长度吻合就记录（用于向下定位字段）
      try {
        var sub = { u8: u8, pos: node.contentStart, end: node.contentEnd, strings: [] };
        var nested = parseNode(sub);
        if (sub.pos === node.contentEnd) node.nested = nested;
      } catch (e) {
        node.nested = null;
      }
      node.value = null;
      return node;
    }
    if (tag === TAG.OBJECT) {
      var lo2 = readVarint(u8, state.pos);
      state.pos = lo2.next;
      node.children = [];
      node.value = {};
      for (var i = 0; i < lo2.value; i++) {
        var k = parseNode(state);
        var v = parseNode(state);
        node.children.push({ key: k, value: v });
        if (typeof k.value === "string") node.value[k.value] = v.value;
      }
      node.end = state.pos;
      return node;
    }
    if (tag === TAG.ARRAY) {
      var la = readVarint(u8, state.pos);
      state.pos = la.next;
      node.items = [];
      node.value = [];
      for (var j = 0; j < la.value; j++) {
        var item = parseNode(state);
        node.items.push(item);
        node.value.push(item.value);
      }
      node.end = state.pos;
      return node;
    }
    throw new Error("unknown bon tag " + tag + " @" + (state.pos - 1));
  }

  function readF32(u8, pos) {
    var b = new Uint8Array(4);
    b.set(u8.subarray(pos, pos + 4));
    return new Float32Array(b.buffer)[0];
  }
  function readF64(u8, pos) {
    var b = new Uint8Array(8);
    b.set(u8.subarray(pos, pos + 8));
    return new Float64Array(b.buffer)[0];
  }

  /**
   * 找到 key 对应的值节点，并返回「包住它的 tag7 祖先链」（由内到外）。
   * ancestors 里每项 { lenFieldStart, lenFieldBytes, contentLen }
   */
  function findField(root, key) {
    function walk(node, chain) {
      if (!node) return null;
      if (node.nested) {
        var hit = walk(node.nested, [{ lenFieldStart: node.lenFieldStart, lenFieldBytes: node.lenFieldBytes, contentLen: node.contentLen }].concat(chain));
        if (hit) return hit;
      }
      if (node.children) {
        for (var i = 0; i < node.children.length; i++) {
          var c = node.children[i];
          if (c.key && c.key.value === key) return { node: c.value, chain: chain };
          var deeper = walk(c.value, chain);
          if (deeper) return deeper;
        }
      }
      if (node.items) {
        for (var j = 0; j < node.items.length; j++) {
          var d = walk(node.items[j], chain);
          if (d) return d;
        }
      }
      return null;
    }
    return walk(root, []);
  }

  /**
   * 就地替换一个 tag5 字符串字段，并自内向外修正 tag7 长度。
   * 返回 { bytes, changed, from } 或 null（未找到 / 不可替换）。
   */
  function replaceStringField(bytes, key, newStr) {
    var state = { u8: bytes, pos: 0, end: bytes.length, strings: [] };
    var root;
    try { root = parseNode(state); } catch (e) { return null; }
    var found = findField(root, key);
    if (!found || !found.node) return null;
    var target = found.node;
    if (target.tag !== TAG.STRING) return null;   // tag99 引用 / 非字符串：安全降级不改
    if (target.value === newStr) return null;

    var from = target.value;
    var newBytes = utf8Bytes(newStr);
    var newTag5 = [TAG.STRING].concat(writeVarint(newBytes.length));
    var patch = new Uint8Array(newTag5.length + newBytes.length);
    patch.set(newTag5, 0);
    patch.set(newBytes, newTag5.length);

    var out = new Uint8Array(bytes.length - (target.end - target.start) + patch.length);
    out.set(bytes.subarray(0, target.start), 0);
    out.set(patch, target.start);
    out.set(bytes.subarray(target.end), target.start + patch.length);

    // 自内向外修正 tag7：外层 lenField 总在内层之前 ⇒ 偏移不受内层修正影响
    var delta = patch.length - (target.end - target.start);
    for (var i = 0; i < found.chain.length; i++) {
      var a = found.chain[i];
      var newLen = a.contentLen + delta;
      var oldVarintLen = a.lenFieldBytes;
      var newVarint = writeVarint(newLen);
      if (newVarint.length !== oldVarintLen) {
        var rebuilt = new Uint8Array(out.length + (newVarint.length - oldVarintLen));
        rebuilt.set(out.subarray(0, a.lenFieldStart), 0);
        rebuilt.set(newVarint, a.lenFieldStart);
        rebuilt.set(out.subarray(a.lenFieldStart + oldVarintLen), a.lenFieldStart + newVarint.length);
        out = rebuilt;
      } else {
        for (var k = 0; k < newVarint.length; k++) out[a.lenFieldStart + k] = newVarint[k];
      }
      delta += newVarint.length - oldVarintLen;
    }
    return { bytes: out, changed: true, from: from, to: newStr };
  }

  /** 读帧里的 cmd（外层对象的 cmd 字段） */
  function readCmd(bytes) {
    try {
      var state = { u8: bytes, pos: 0, end: bytes.length, strings: [] };
      var root = parseNode(state);
      return root && root.value ? root.value.cmd : null;
    } catch (e) { return null; }
  }

  /**
   * 按规则改写一帧（明文进、明文出）。
   * rules: [{ cmd, fields }]
   * 返回 { plain, changes: [{cmd, key, from, to}], cmd }
   */
  function patchPlain(plain, rules) {
    var cmd = readCmd(plain);
    if (cmd === null || cmd === undefined) return { plain: plain, changes: [], cmd: null };
    var current = plain;
    var changes = [];
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (rule && rule.cmd && rule.cmd !== cmd) continue;
      var fields = (rule && rule.fields) || {};
      for (var key in fields) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
        var res = replaceStringField(current, key, String(fields[key]));
        if (res && res.changed) {
          current = res.bytes;
          changes.push({ cmd: cmd, key: key, from: res.from, to: res.to });
        }
      }
    }
    return { plain: current, changes: changes, cmd: cmd };
  }

  /** 对完整帧（含 px 头）做改写；非 px 帧或解析失败返回 null */
  function patchFrame(u8, rules) {
    if (!isPxFrame(u8)) return null;
    var plain = pxDecrypt(u8);
    if (!plain) return null;
    var out = patchPlain(plain, rules);
    if (!out.changes.length) return { frame: null, changes: [], cmd: out.cmd };
    return { frame: pxEncrypt(out.plain, u8), changes: out.changes, cmd: out.cmd };
  }

  // ---------------------------------------------------------------- 配置
  function normalizeRules(rules) {
    if (!rules || typeof rules !== "object") return DEFAULT_RULES.slice();
    var list = Array.isArray(rules) ? rules : [rules];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r !== "object") continue;
      var fields = {};
      var src = r.fields || {};
      for (var k in src) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
        if (typeof src[k] === "string" && src[k] !== "") fields[k] = src[k];
      }
      out.push({ cmd: typeof r.cmd === "string" ? r.cmd : "", fields: fields });
    }
    return out.length ? out : DEFAULT_RULES.slice();
  }

  function readConfig() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var cfg = JSON.parse(raw);
      if (!cfg || typeof cfg !== "object" || cfg.enabled !== true) return null;
      return {
        enabled: true,
        observeOnly: cfg.observeOnly === true,
        rules: normalizeRules(cfg.rules),
      };
    } catch (error) {
      return null;
    }
  }

  function writeConfig(patch) {
    var next = { enabled: false, observeOnly: false, rules: DEFAULT_RULES.slice() };
    try {
      var current = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      if (current && typeof current === "object") {
        next.enabled = current.enabled === true;
        next.observeOnly = current.observeOnly === true;
        next.rules = normalizeRules(current.rules);
      }
    } catch (error) {}
    if (patch && typeof patch === "object") {
      if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
      if (typeof patch.observeOnly === "boolean") next.observeOnly = patch.observeOnly;
      if (patch.rules) next.rules = normalizeRules(patch.rules);
    }
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch (error) {}
    return next;
  }

  function clearConfig() {
    try { localStorage.removeItem(LS_KEY); } catch (error) {}
  }

  // ---------------------------------------------------------------- 安装 hook
  var stats = { frames: 0, parsed: 0, matched: 0, patched: 0, failed: 0 };
  var records = [];
  var applied = { active: false, observeOnly: false, rules: null };

  function toU8(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }
  function fromU8(original, u8) {
    if (original instanceof ArrayBuffer) return u8.buffer;
    return u8;
  }
  function pushRecord(entry) {
    records.push(entry);
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  }

  function install(cfg) {
    var Proto = window.WebSocket && window.WebSocket.prototype;
    if (!Proto || !Proto.send) {
      console.warn("[frame-spoof] 未找到 WebSocket.prototype.send，跳过安装");
      return false;
    }
    if (Proto.__xyzwFrameSpoofHooked) return true;   // 重复注入保护
    var originalSend = Proto.send;

    Proto.send = function (data) {
      try {
        var u8 = toU8(data);
        if (u8) {
          stats.frames++;
          if (isPxFrame(u8)) {
            var plain = pxDecrypt(u8);
            if (plain) {
              stats.parsed++;
              var res = patchFrame(u8, cfg.rules);
              if (res && res.cmd) stats.matched++;
              if (res && res.changes && res.changes.length) {
                if (cfg.observeOnly) {
                  pushRecord({ at: new Date().toISOString(), cmd: res.cmd, observed: true, changes: res.changes });
                } else if (res.frame) {
                  stats.patched++;
                  pushRecord({ at: new Date().toISOString(), cmd: res.cmd, applied: true, changes: res.changes });
                  return originalSend.call(this, fromU8(data, res.frame));
                } else {
                  stats.failed++;
                }
              }
            }
          }
        }
      } catch (error) {
        stats.failed++;
        if (stats.failed <= 3) console.warn("[frame-spoof] 处理帧出错（已放行原帧）:", error && error.message);
      }
      return originalSend.call(this, data);
    };
    Proto.__xyzwFrameSpoofHooked = true;
    return true;
  }

  var cfg = readConfig();
  if (cfg) {
    applied.active = install(cfg);
    applied.observeOnly = cfg.observeOnly === true;
    applied.rules = cfg.rules;
    console.log(
      "[frame-spoof] " + (applied.active ? "已安装" : "安装失败") +
        " observeOnly=" + applied.observeOnly +
        " rules=" + JSON.stringify(cfg.rules)
    );
  } else {
    console.log("[frame-spoof] 未启用（localStorage." + LS_KEY + " 缺省或 enabled=false）");
  }

  window.__xyzwFrameSpoof = {
    KEY: LS_KEY,
    read: readConfig,
    write: writeConfig,
    clear: clearConfig,
    applied: applied,
    stats: stats,
    records: records,
    // 供宿主/测试直接驱动（不依赖 WebSocket）
    pxDecrypt: pxDecrypt,
    pxEncrypt: pxEncrypt,
    patchFrame: patchFrame,
    patchPlain: patchPlain,
    readCmd: readCmd,
    // 调试用（宿主/测试可逐层定位问题）
    _debug: { parseNode: parseNode, findField: findField, replaceStringField: replaceStringField, TAG: TAG },
  };
})();
