(function () {
  "use strict";

  var REQUEST_TYPE = "xyzw:push-research:request";
  var RESPONSE_TYPE = "xyzw:push-research:response";
  var EVENT_TYPE = "xyzw:push-research:event";
  var BRIDGE_VERSION = "2026-09-03.21";
  var HEADLESS_TEST_MODE = new URLSearchParams(window.location.search).get("headless-test") === "1";
  var RESEARCH_MODE = new URLSearchParams(window.location.search).get("research") === "push-level";
  var MODE = HEADLESS_TEST_MODE ? "headless-test" : "passive-capture";
  var BLOCKED_COMMANDS = {
    "battle:start": "主动请求 fight_startlevel",
    "battle:simulate": "主动调用无头战斗模拟",
    "battle:end": "主动请求 fight_endlevel",
  };
  var MAX_EVENTS = 5000;
  var state = {
    sequence: 0,
    events: [],
    lastBattleData: null,
    lastBattleResponse: null,
    account: null,
    captureRawFrames: false,
    requireHooked: false,
    networkHooksInstalled: false,
    apiHooks: [],
    requiredModules: {},
    autoProbeDone: false,
    decodedFrameCount: 0,
    frameDecodeErrorCount: 0,
    protocolMessageCount: 0,
    lastProtocolMessage: null,
    lastBattleObservation: null,
    autoProbeScheduled: false,
    hashCaptureEnabled: false,
    hashHooked: false,
    hashHooks: [],
    hashCandidates: [],
    hashMatches: 0,
    hashObservations: [],
    stringifyCandidates: [],
    moduleNames: {},
    hashRoots: [],
    moduleRequireErrors: {},
    authHooked: false,
    hashHookSignature: "",
    headlessBusy: false,
    headlessRunCount: 0,
    headlessLastResult: null,
    submitRunCount: 0,
  };

  function origin() {
    return window.location.origin === "null" ? "*" : window.location.origin;
  }

  function post(message) {
    if (window.parent === window) return;
    try {
      window.parent.postMessage(message, origin());
    } catch (error) {}
  }

  function isParentMessage(event) {
    return (
      event.source === window.parent &&
      (event.origin === window.location.origin ||
        event.origin === "null" ||
        window.location.origin === "null")
    );
  }

  function sensitiveKey(key) {
    return /token|password|secret|cookie|authorization|accesskey|refreshkey|openid|platformuid|ukey|sessionid|connid/i.test(
      String(key),
    );
  }

  function bytesToHex(bytes, limit) {
    var output = [];
    var length = Math.min(bytes.length, limit === undefined ? 32 : limit);
    for (var index = 0; index < length; index += 1) {
      output.push(bytes[index].toString(16).padStart(2, "0"));
    }
    return output.join("");
  }

  function summarize(value, depth, seen) {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      if (
        value.length > 40 &&
        /roleToken|accessToken|refreshToken|password|authorization|openId|platformUId|uKey/i.test(value)
      ) {
        return "[REDACTED_STRING]";
      }
      return value.length > 12000 ? value.slice(0, 12000) + "...[truncated]" : value;
    }
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return String(value) + "n";
    if (typeof value === "function") {
      return { kind: "function", name: value.name || "anonymous", arity: value.length };
    }
    if (value instanceof Error) {
      return {
        kind: "error",
        name: value.name || "Error",
        message: value.message || String(value),
        stack: value.stack || "",
      };
    }
    if (depth > 6) return { kind: "object", truncated: true };

    if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
      return {
        kind: "arraybuffer",
        byteLength: value.byteLength,
        headHex: bytesToHex(new Uint8Array(value), 64),
      };
    }
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
      return {
        kind: "typed-array",
        byteLength: value.byteLength,
        headHex: bytesToHex(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
          64,
        ),
      };
    }
    if (typeof Blob !== "undefined" && value instanceof Blob) {
      return { kind: "blob", size: value.size, type: value.type || "" };
    }
    if (value instanceof Date) return value.toISOString();

    if (typeof Map !== "undefined" && value instanceof Map) {
      var mapResult = {};
      var mapCount = 0;
      value.forEach(function (mapValue, mapKey) {
        if (mapCount >= 300) return;
        mapResult[String(mapKey)] = summarize(mapValue, depth + 1, seen);
        mapCount += 1;
      });
      if (value.size > mapCount) mapResult.__truncated = value.size - mapCount;
      return mapResult;
    }

    seen = seen || [];
    if (seen.indexOf(value) >= 0) return { kind: "circular" };
    seen.push(value);

    if (Array.isArray(value)) {
      var arrayResult = value.slice(0, 400).map(function (item) {
        return summarize(item, depth + 1, seen);
      });
      if (value.length > arrayResult.length) {
        arrayResult.push("...[" + (value.length - arrayResult.length) + " more]");
      }
      seen.pop();
      return arrayResult;
    }

    var result = {};
    var keys = [];
    try {
      keys = Object.keys(value).slice(0, 400);
    } catch (error) {
      seen.pop();
      return { kind: "object", unreadable: true };
    }
    keys.forEach(function (key) {
      if (sensitiveKey(key)) {
        result[key] = "[REDACTED]";
        return;
      }
      try {
        result[key] = summarize(value[key], depth + 1, seen);
      } catch (error) {
        result[key] = "[UNREADABLE]";
      }
    });
    if (keys.length < Object.keys(value).length) result.__truncated = true;
    seen.pop();
    return result;
  }

  function record(event, payload) {
    var entry = {
      seq: ++state.sequence,
      at: new Date().toISOString(),
      event: event,
      payload: summarize(payload, 0, []),
    };
    state.events.push(entry);
    if (state.events.length > MAX_EVENTS) state.events.shift();
    post({ type: EVENT_TYPE, event: event, payload: entry });
    return entry;
  }

  function recordRaw(event, payload) {
    var entry = {
      seq: ++state.sequence,
      at: new Date().toISOString(),
      event: event,
      payload: payload,
    };
    state.events.push(entry);
    if (state.events.length > MAX_EVENTS) state.events.shift();
    post({ type: EVENT_TYPE, event: event, payload: entry });
    return entry;
  }

  function safeRequire(name) {
    if (typeof window.__require !== "function") return null;
    try {
      return window.__require(name);
    } catch (error) {
      return null;
    }
  }

  function quietRequire(name) {
    if (typeof window.__require !== "function") return null;
    var original = window.__require.__pushResearchOriginal || window.__require;
    try {
      return original(name);
    } catch (error) {
      return null;
    }
  }

  function rememberModuleName(name) {
    if (name === undefined || name === null) return;
    state.moduleNames[String(name)] = true;
  }

  function normalizeDigest(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
  }

  function isDigest(value) {
    return /^[a-f0-9]{32}$/i.test(String(value || ""));
  }

  function trimHashCandidates() {
    if (state.hashCandidates.length > 500) {
      state.hashCandidates.splice(0, state.hashCandidates.length - 500);
    }
    if (state.stringifyCandidates.length > 200) {
      state.stringifyCandidates.splice(0, state.stringifyCandidates.length - 200);
    }
  }

  function isBattleResultText(value) {
    if (typeof value !== "string" || value.length < 20) return false;
    return (
      /"(?:sponsor|accept|isWin|battleVersion|totalFrame|statistic)"/.test(value) ||
      /(?:sponsor|accept|isWin|battleVersion|totalFrame|statistic):/.test(value)
    );
  }

  function rememberHashCandidate(label, input, digest, args) {
    if (!state.hashCaptureEnabled || typeof input !== "string") return;
    var normalized = normalizeDigest(digest);
    if (!normalized || !isDigest(normalized)) return;
    var candidate = {
      id: "hash-" + Date.now() + "-" + state.hashCandidates.length,
      at: new Date().toISOString(),
      owner: label,
      digest: normalized,
      inputLength: input.length,
      input: input,
      argumentCount: args ? args.length : 0,
      matched: {},
    };
    state.hashCandidates.push(candidate);
    var stringifyCandidate = state.stringifyCandidates.find(function (item) {
      return !item.digest && item.input === input;
    });
    if (stringifyCandidate) {
      stringifyCandidate.digest = normalized;
      stringifyCandidate.hashCandidateId = candidate.id;
    }
    trimHashCandidates();
    record("hash:candidate", {
      id: candidate.id,
      owner: label,
      digest: normalized,
      inputLength: input.length,
      preview: input.slice(0, 240),
    });
    state.hashObservations.forEach(function (observation) {
      matchHashCandidate(candidate, observation);
    });
  }

  function rememberStringifyCandidate(label, value) {
    if (!state.hashCaptureEnabled || !isBattleResultText(value)) return;
    state.stringifyCandidates.push({
      id: "stringify-" + Date.now() + "-" + state.stringifyCandidates.length,
      at: new Date().toISOString(),
      owner: label,
      inputLength: value.length,
      input: value,
      digest: "",
      hashCandidateId: "",
    });
    trimHashCandidates();
    recordRaw("hash:stringify-candidate", {
      owner: label,
      inputLength: value.length,
      preview: value.slice(0, 240),
      preimage: value,
    });
  }

  function matchHashCandidates(kind, digest, battleData) {
    var normalized = normalizeDigest(digest);
    if (!normalized || !isDigest(normalized)) return;
    var observation = {
      kind: kind,
      digest: normalized,
      battle: summarize(battleData, 0, []),
    };
    state.hashObservations.push(observation);
    if (state.hashObservations.length > 200) state.hashObservations.shift();
    if (!state.hashCaptureEnabled) return;
    state.hashCandidates.forEach(function (candidate) {
      matchHashCandidate(candidate, observation);
    });
  }

  function matchHashCandidate(candidate, observation) {
    if (!candidate || !observation || candidate.digest !== observation.digest) return;
    if (candidate.matched[observation.kind]) return;
    candidate.matched[observation.kind] = true;
    state.hashMatches += 1;
    recordRaw("hash:matched", {
      kind: observation.kind,
      digest: observation.digest,
      owner: candidate.owner,
      capturedAt: candidate.at,
      inputLength: candidate.inputLength,
      preimage: candidate.input,
      battle: observation.battle,
    });
  }

  function isBattleHashInput(value) {
    if (typeof value !== "string" || value.length < 20) return false;
    return /randomSeed|leftTeam|rightTeam|sponsor|accept|isWin|battleVersion|totalFrame|statistic|levelId/i.test(value);
  }

  function hasHashSurface(value, depth, visited, budget) {
    if (!value || depth < 0) return false;
    visited = visited || [];
    budget = budget || { count: 0 };
    if (budget.count++ > 250 || visited.indexOf(value) >= 0) return false;
    visited.push(value);
    var keys = safeOwnKeys(value).slice(0, 160);
    for (var index = 0; index < keys.length; index += 1) {
      var key = String(keys[index]).toLowerCase();
      if (key === "hashstr" || key === "hashstring" || key.indexOf("hashstr") >= 0 || key === "jsonext") {
        return true;
      }
      var child;
      try {
        child = value[keys[index]];
      } catch (error) {
        continue;
      }
      if (depth > 0 && child && (typeof child === "object" || typeof child === "function") && hasHashSurface(child, depth - 1, visited, budget)) {
        return true;
      }
    }
    return false;
  }

  function safeOwnKeys(value) {
    try {
      return Object.getOwnPropertyNames(value);
    } catch (error) {
      return [];
    }
  }

  function wrapHashMethod(owner, key, label) {
    if (!owner || typeof owner[key] !== "function") return false;
    var descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
    } catch (error) {
      return false;
    }
    if (descriptor && descriptor.value && descriptor.value.__pushResearchHashWrapped) return false;
    var original = descriptor && descriptor.value ? descriptor.value : owner[key];
    if (typeof original !== "function") return false;

    var wrapped = function () {
      var args = Array.prototype.slice.call(arguments);
      var result = original.apply(this, args);
      if (state.hashCaptureEnabled && isBattleHashInput(args[0]) && isDigest(result)) {
        rememberHashCandidate(label + "." + key, args[0], result, args);
      }
      return result;
    };
    wrapped.__pushResearchHashWrapped = true;
    wrapped.__pushResearchOriginal = original;
    try {
      owner[key] = wrapped;
      if (owner[key] === wrapped) {
        state.hashHooks.push(label + "." + key);
        return true;
      }
    } catch (error) {}

    try {
      if (descriptor && descriptor.configurable) {
        Object.defineProperty(owner, key, {
          ...descriptor,
          value: wrapped,
        });
        if (owner[key] === wrapped) {
          state.hashHooks.push(label + "." + key);
          return true;
        }
      }
    } catch (error) {}
    return false;
  }

  function installKnownHashHooks() {
    var module = safeRequire("ts-md5");
    var md5 = module && module.Md5;
    if (!md5) return [];

    ["hashStr", "hashAsciiStr"].forEach(function (key) {
      wrapHashMethod(md5, key, "module:ts-md5.Md5");
    });
    return state.hashHooks.filter(function (hook) {
      return hook.indexOf("module:ts-md5.Md5.") === 0;
    });
  }

  function installKnownStringifyHooks() {
    var module = safeRequire("13");
    if (!module) return [];
    ["toJsonStringSB"].forEach(function (key) {
      wrapStringifyMethod(module, key, "module:13");
    });
    return state.hashHooks.filter(function (hook) {
      return hook.indexOf("module:13.") === 0;
    });
  }

  function captureHashInput(label, args, result) {
    if (!state.hashCaptureEnabled || !isDigest(result)) return;
    var input = args && args[0];
    if (!isBattleHashInput(input)) return;
    rememberHashCandidate(label, input, result, args);
  }

  function wrapHashMethodForCapture(owner, key, label) {
    if (!owner || typeof owner[key] !== "function") return false;
    var descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
    } catch (error) {
      return false;
    }
    var original = descriptor && descriptor.value ? descriptor.value : owner[key];
    if (typeof original !== "function" || original.__pushResearchHashWrapped) return false;
    var wrapped = function () {
      var args = Array.prototype.slice.call(arguments);
      var result = original.apply(this, args);
      captureHashInput(label + "." + key, args, result);
      return result;
    };
    wrapped.__pushResearchHashWrapped = true;
    wrapped.__pushResearchOriginal = original;
    try {
      owner[key] = wrapped;
      if (owner[key] === wrapped) {
        state.hashHooks.push(label + "." + key);
        return true;
      }
    } catch (error) {}
    try {
      if (descriptor && descriptor.configurable) {
        Object.defineProperty(owner, key, { ...descriptor, value: wrapped });
        if (owner[key] === wrapped) {
          state.hashHooks.push(label + "." + key);
          return true;
        }
      }
    } catch (error) {}
    return false;
  }

  function installDirectHashCapture() {
    var module = safeRequire("ts-md5");
    var md5 = module && module.Md5;
    if (!md5) return [];
    ["hashStr", "hashAsciiStr"].forEach(function (key) {
      wrapHashMethodForCapture(md5, key, "module:ts-md5.Md5");
    });
    return state.hashHooks.filter(function (hook) {
      return hook.indexOf("module:ts-md5.Md5.") === 0;
    });
  }

  function installDirectStringifyCapture() {
    var module = safeRequire("13");
    if (!module) return [];
    ["toJsonStringSB"].forEach(function (key) {
      wrapStringifyMethod(module, key, "module:13");
    });
    return state.hashHooks.filter(function (hook) {
      return hook.indexOf("module:13.") === 0;
    });
  }

  function recordHashHookError(label, error) {
    record("hash:hook:error", {
      owner: label,
      error: error && error.message ? error.message : String(error),
    });
  }

  function installHashCaptureHooks() {
    try {
      installDirectHashCapture();
      installDirectStringifyCapture();
    } catch (error) {
      recordHashHookError("direct", error);
    }
  }

  function wrapStringifyMethod(owner, key, label) {
    if (!owner || typeof owner[key] !== "function") return false;
    var descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
    } catch (error) {
      return false;
    }
    if (descriptor && descriptor.value && descriptor.value.__pushResearchStringifyWrapped) return false;
    var original = descriptor && descriptor.value ? descriptor.value : owner[key];
    if (typeof original !== "function") return false;

    var wrapped = function () {
      var result = original.apply(this, arguments);
      if (state.hashCaptureEnabled && isBattleHashInput(result)) {
        rememberStringifyCandidate(label + "." + key, result);
      }
      return result;
    };
    wrapped.__pushResearchStringifyWrapped = true;
    wrapped.__pushResearchOriginal = original;
    try {
      owner[key] = wrapped;
      state.hashHooks.push(label + "." + key);
      return true;
    } catch (error) {
      return false;
    }
  }

  function inspectHashSurface(value, label, depth, visited, budget) {
    if (!value || depth < 0) return;
    visited = visited || [];
    budget = budget || { count: 0 };
    if (budget.count++ > 1200 || visited.indexOf(value) >= 0) return;
    visited.push(value);

    var keys = safeOwnKeys(value).slice(0, 300);
    keys.forEach(function (key) {
      var lower = String(key).toLowerCase();
      var descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch (error) {
        return;
      }
      var child = descriptor && descriptor.value;
      var hashKey = lower === "hashstr" || lower === "hashstring" || (lower.indexOf("hashstr") >= 0);
      var stringifyKey = lower === "stringify" || lower === "tojsonstringsb" || lower.indexOf("stringify") >= 0;
      if (hashKey) wrapHashMethod(value, key, label);
      if (stringifyKey && /json|ext|serialize|battle|result|data-index/i.test(label + "." + key)) {
        wrapStringifyMethod(value, key, label);
      }

      if (depth > 0 && child && (typeof child === "object" || typeof child === "function")) {
        var childLabel = label + "." + key;
        if (
          /md5|hash|json|ext|string|battle|result|fight|level|data-index|manager-factory|types-common/i.test(childLabel) ||
          depth > 1
        ) {
          inspectHashSurface(child, childLabel, depth - 1, visited, budget);
        }
      }
    });

    if (typeof value === "function" && value.prototype) {
      inspectHashSurface(value.prototype, label + ".prototype", depth - 1, visited, budget);
    }
  }

  function installHashHooks() {
    installDirectHashCapture();
    installDirectStringifyCapture();
    var roots = [
      { label: "module:13", value: quietRequire("13") },
      { label: "module:ts-md5", value: quietRequire("ts-md5") },
      { label: "module:data-index", value: quietRequire("data-index") },
      { label: "module:manager-factory", value: quietRequire("manager-factory") },
      { label: "module:types-common", value: quietRequire("types-common") },
      { label: "global:Md5", value: window.Md5 },
      { label: "global:JSONExt", value: window.JSONExt },
    ];
    state.hashRoots.forEach(function (root) {
      roots.push(root);
    });
    roots.forEach(function (root) {
      inspectHashSurface(root.value, root.label, 3, [], { count: 0 });
    });
    state.hashHooked = state.hashHooks.length > 0;
    var signature = state.hashHooks.slice().sort().join("|");
    if (signature !== state.hashHookSignature) {
      state.hashHookSignature = signature;
      record("hash:hooks", {
        enabled: state.hashCaptureEnabled,
        hooked: state.hashHooked,
        hooks: state.hashHooks.slice(-100),
      });
    }
  }

  function toUint8Array(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      );
    }
    return null;
  }

  function xDecrypt(data) {
    var bytes = new Uint8Array(data);
    if (bytes.length < 5 || bytes[0] !== 0x70 || bytes[1] !== 0x78) return bytes;
    var key =
      (((bytes[2] >> 6) & 1) << 7) |
      (((bytes[2] >> 4) & 1) << 6) |
      (((bytes[2] >> 2) & 1) << 5) |
      ((bytes[2] & 1) << 4) |
      (((bytes[3] >> 6) & 1) << 3) |
      (((bytes[3] >> 4) & 1) << 2) |
      (((bytes[3] >> 2) & 1) << 1) |
      (bytes[3] & 1);
    for (var index = bytes.length - 1; index >= 4; index -= 1) bytes[index] ^= key;
    return bytes.subarray(4);
  }

  function bonDecode(bytes) {
    var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var position = 0;
    var strings = [];
    var view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    function readByte() {
      if (position >= data.length) throw new Error("BON eof");
      return data[position++];
    }

    function readInt32() {
      var value = readByte() | (readByte() << 8) | (readByte() << 16) | (readByte() << 24);
      return value | 0;
    }

    function readInt64() {
      var low = readInt32();
      var unsignedLow = low < 0 ? low + 0x100000000 : low;
      return unsignedLow + 0x100000000 * readInt32();
    }

    function read7BitInt() {
      var value = 0;
      var shift = 0;
      var count = 0;
      var byte;
      do {
        if (count++ === 35) throw new Error("BON 7bit overflow");
        byte = readByte();
        value |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      return value >>> 0;
    }

    function readUtf() {
      var length = read7BitInt();
      if (position + length > data.length) throw new Error("BON string eof");
      var value = new TextDecoder("utf-8").decode(data.subarray(position, position + length));
      position += length;
      return value;
    }

    function decode() {
      var tag = readByte();
      if (tag === 0) return null;
      if (tag === 1) return readInt32();
      if (tag === 2) return readInt64();
      if (tag === 3) {
        if (position + 4 > data.length) throw new Error("BON float eof");
        var float32 = view.getFloat32(position, true);
        position += 4;
        return float32;
      }
      if (tag === 4) {
        if (position + 8 > data.length) throw new Error("BON double eof");
        var float64 = view.getFloat64(position, true);
        position += 8;
        return float64;
      }
      if (tag === 5) {
        var stringValue = readUtf();
        strings.push(stringValue);
        return stringValue;
      }
      if (tag === 6) return readByte() === 1;
      if (tag === 7) {
        var byteLength = read7BitInt();
        if (position + byteLength > data.length) throw new Error("BON bytes eof");
        var bytesValue = data.subarray(position, position + byteLength);
        position += byteLength;
        return bytesValue;
      }
      if (tag === 8) {
        var objectCount = read7BitInt();
        var objectValue = {};
        for (var objectIndex = 0; objectIndex < objectCount; objectIndex += 1) {
          objectValue[decode()] = decode();
        }
        return objectValue;
      }
      if (tag === 9) {
        var arrayLength = read7BitInt();
        var arrayValue = [];
        for (var arrayIndex = 0; arrayIndex < arrayLength; arrayIndex += 1) {
          arrayValue.push(decode());
        }
        return arrayValue;
      }
      if (tag === 10) return new Date(readInt64());
      if (tag === 99) return strings[read7BitInt()];
      throw new Error("BON tag " + tag);
    }

    return decode();
  }

  function decryptForBon(data) {
    var bytes = toUint8Array(data);
    if (!bytes || bytes.length < 2) return bytes;
    if (bytes[0] === 0x70 && bytes[1] === 0x78) return xDecrypt(bytes);
    if (bytes[0] === 0x70 && bytes[1] === 0x6c) {
      var codec = safeRequire("13");
      if (codec && typeof codec.lz4XorDecode === "function") {
        return codec.lz4XorDecode(new Uint8Array(bytes));
      }
    }
    return bytes;
  }

  function installRequireHook() {
    if (state.requireHooked || typeof window.__require !== "function") return;
    if (window.__require.__pushResearchOriginal) {
      state.requireHooked = true;
      return;
    }

    var original = window.__require;
    var wrapped = function () {
      var args = Array.prototype.slice.call(arguments);
      try {
        var result = original.apply(this, args);
        var name = String(args[0] || "");
        var relevant =
          /^(13|data-index|manager-factory|types-common|Game|configs|battle-manager)$/i.test(name) ||
          /battle|fight|level|login|role|config|ts-md5/i.test(name);
        if (relevant && !state.requiredModules[name]) {
          state.requiredModules[name] = Boolean(result);
          record("module:require", {
            name: name,
            argumentCount: args.length,
            found: Boolean(result),
          });
        }
        return result;
      } catch (error) {
        var errorKey = String(args[0]) + "|" + args.length + "|" + error.message;
        if (!state.moduleRequireErrors[errorKey]) {
          state.moduleRequireErrors[errorKey] = true;
          record("module:require:error", {
            name: args[0],
            argumentCount: args.length,
            error: error.message,
            firstOccurrence: true,
          });
        }
        throw error;
      }
    };
    wrapped.__pushResearchOriginal = original;
    window.__require = wrapped;
    state.requireHooked = true;
    record("module:require:hooked", { requireType: typeof window.__require });
  }

  function keysOf(value) {
    if (!value) return [];
    try {
      return Object.keys(value).slice(0, 300);
    } catch (error) {
      return [];
    }
  }

  function describe(value) {
    var result = { type: typeof value, keys: keysOf(value) };
    if (typeof value === "function") {
      result.name = value.name || "anonymous";
      result.arity = value.length;
      try {
        result.prototypeKeys = Object.getOwnPropertyNames(value.prototype || {}).slice(
          0,
          120,
        );
      } catch (error) {
        result.prototypeKeys = [];
      }
    }
    return result;
  }

  function findNamed(root, names, depth, visited) {
    if (!root || depth < 0) return null;
    visited = visited || [];
    if (visited.indexOf(root) >= 0) return null;
    visited.push(root);

    for (var index = 0; index < names.length; index += 1) {
      var name = names[index];
      try {
        if (root[name]) return { value: root[name], path: name };
      } catch (error) {}
    }

    var keys = keysOf(root);
    for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      var key = keys[keyIndex];
      var child;
      try {
        child = root[key];
      } catch (error) {
        continue;
      }
      var found = findNamed(child, names, depth - 1, visited);
      if (found) {
        found.path = key + "." + found.path;
        return found;
      }
    }
    return null;
  }

  function probeModules() {
    installRequireHook();
    var moduleNames = [
      "13",
      "ts-md5",
      "data-index",
      "manager-factory",
      "types-common",
      "Game",
      "configs",
      "battle-manager",
    ];
    var modules = {};
    moduleNames.forEach(function (name) {
      var value = quietRequire(name);
      modules[name] = value ? describe(value) : { exists: false };
    });

    var roots = {
      dataIndex: quietRequire("data-index"),
      factory: quietRequire("manager-factory"),
      typesCommon: quietRequire("types-common"),
    };
    var names = [
      "FightService",
      "LevelModule",
      "BattleManager",
      "ClientBattleResult",
      "ClientBattleResultTeam",
      "JSONExt",
      "Md5",
      "ROLE",
    ];
    var named = {};
    Object.keys(roots).forEach(function (rootName) {
      names.forEach(function (name) {
        if (named[name]) return;
        var found = findNamed(roots[rootName], [name], 2);
        if (found) {
          named[name] = {
            source: rootName + "." + found.path,
            description: describe(found.value),
          };
        }
      });
    });

    var result = {
      bridgeVersion: BRIDGE_VERSION,
      requireType: typeof window.__require,
      modules: modules,
      named: named,
      runtime: {
        cc: typeof window.cc,
        canvas: Boolean(document.getElementById("GameCanvas")),
        location: window.location.pathname,
        captureRawFrames: state.captureRawFrames,
      },
    };
    record("module:probe", result);
    return result;
  }

  function decodeBin(arrayBuffer) {
    var decrypted = decryptForBon(arrayBuffer);
    if (!decrypted) throw new Error("BIN 解密结果为空");
    return bonDecode(decrypted);
  }

  function waitForLoginService(timeout) {
    return new Promise(function (resolve, reject) {
      var startedAt = Date.now();
      var timer = setInterval(function () {
        var loginModule = quietRequire("LoginManager");
        var manager = loginModule && loginModule.LoginManager;
        var platformModule = quietRequire("PlatformManager");
        var platformManager = platformModule && platformModule.PlatformManager;
        var managerInstance = manager && manager.instance;
        var platformInstance = platformManager && platformManager.instance;
        if (managerInstance && typeof managerInstance.login === "function" && platformInstance) {
          clearInterval(timer);
          resolve({
            manager: manager,
            managerInstance: managerInstance,
            platformManager: platformManager,
            platformInstance: platformInstance,
          });
        } else if (Date.now() - startedAt > timeout) {
          clearInterval(timer);
          reject(new Error("官方 LoginManager/PlatformManager 未就绪"));
        }
      }, 200);
    });
  }

  function installAuthUserHook(saveInfo) {
    var dataIndex = quietRequire("data-index");
    var loginService = dataIndex && dataIndex.LoginService;
    if (!loginService || typeof loginService.authUser !== "function") {
      record("account:auth-hook:error", {
        reason: "当前版本未找到 LoginService.authUser",
      });
      return false;
    }

    var descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(loginService, "authUser");
    } catch (error) {}
    var original = descriptor && descriptor.value
      ? descriptor.value
      : loginService.authUser;
    if (typeof original !== "function") return false;
    if (original.__pushResearchAuthWrapped) {
      state.authHooked = true;
      return true;
    }

    var info = saveInfo.info;
    if (info !== undefined && typeof info !== "string") {
      info = JSON.stringify(info);
    }
    var platformExt = saveInfo.platformExt;
    var serverId = saveInfo.serverId;
    var wrapped = function (request) {
      var loginRequest = request && typeof request === "object"
        ? Object.assign({}, request)
        : {};
      if (platformExt !== undefined && platformExt !== null) {
        loginRequest.platformExt = platformExt;
      }
      if (info !== undefined) loginRequest.info = info;
      if (serverId !== undefined && serverId !== null) {
        loginRequest.serverId = String(serverId);
      }
      record("account:auth-request", {
        keys: Object.keys(loginRequest),
        platformExt: loginRequest.platformExt,
        hasInfo: typeof loginRequest.info === "string" && loginRequest.info.length > 0,
        hasServerId: loginRequest.serverId !== undefined && loginRequest.serverId !== null,
      });
      return original.call(this, loginRequest);
    };
    wrapped.__pushResearchAuthWrapped = true;
    wrapped.__pushResearchAuthOriginal = original;

    try {
      loginService.authUser = wrapped;
      if (loginService.authUser === wrapped) {
        state.authHooked = true;
        record("account:auth-hook", {
          platformExt: platformExt,
          hasInfo: info !== undefined,
          hasServerId: serverId !== undefined && serverId !== null,
        });
        return true;
      }
    } catch (error) {}

    try {
      if (descriptor && descriptor.configurable) {
        Object.defineProperty(loginService, "authUser", {
          ...descriptor,
          value: wrapped,
        });
        if (loginService.authUser === wrapped) {
          state.authHooked = true;
          record("account:auth-hook", {
            platformExt: platformExt,
            hasInfo: info !== undefined,
            hasServerId: serverId !== undefined && serverId !== null,
          });
          return true;
        }
      }
    } catch (error) {}

    record("account:auth-hook:error", {
      reason: "LoginService.authUser 不可写",
    });
    return false;
  }

  function waitForAuthUserResult(loginManager, timeout) {
    return new Promise(function (resolve, reject) {
      var startedAt = Date.now();
      var timer = setInterval(function () {
        if (loginManager && loginManager._authUserResult) {
          clearInterval(timer);
          resolve(loginManager._authUserResult);
          return;
        }
        if (Date.now() - startedAt > timeout) {
          clearInterval(timer);
          reject(new Error("官方 authUser 响应等待超时"));
        }
      }, 200);
    });
  }

  async function loadAccount(payload) {
    if (!payload || !payload.bin) throw new Error("缺少 BIN 数据");
    var saveInfo = decodeBin(payload.bin);
    if (!saveInfo || typeof saveInfo !== "object") throw new Error("BIN 解码结果无效");
    state.account = { tokenId: payload.tokenId || "", keys: Object.keys(saveInfo) };
    window.__pushResearchSaveInfo = saveInfo;
    record("account:decoded", {
      tokenId: payload.tokenId || "",
      keys: Object.keys(saveInfo),
      platformExt: saveInfo.platformExt,
      serverId: saveInfo.serverId,
      infoType: typeof saveInfo.info,
    });

    var loginRuntime = await waitForLoginService(30000);
    var platformManager = loginRuntime.platformManager && loginRuntime.platformManager.instance;
    var loginManager = loginRuntime.manager && loginRuntime.manager.instance;
    if (!platformManager) throw new Error("PlatformManager.instance 不存在");
    if (!loginManager || typeof loginManager.login !== "function") {
      throw new Error("LoginManager.instance.login 不存在");
    }

    // 当前版本的 GameLogin 会读取这个字段，再由 LoginManager 组装官方 authUser 请求。
    platformManager.encryptUserInfo = saveInfo.info;
    installAuthUserHook(saveInfo);
    if (saveInfo.serverId !== undefined && saveInfo.serverId !== null) {
      var globalVarManager = quietRequire("GlobalVarManager");
      var localStorageModule = quietRequire("LocalStorage");
      var globalVars = globalVarManager && globalVarManager.GlobalVarManager;
      var localStorage = localStorageModule && localStorageModule.LocalStorage;
      var globalInstance = globalVars && globalVars.instance;
      var storageInstance = localStorage && localStorage.instance;
      if (globalInstance && typeof globalInstance.set === "function") {
        globalInstance.set("serverId", String(saveInfo.serverId));
      }
      if (storageInstance && typeof storageInstance.setItem === "function") {
        storageInstance.setItem("serverId", String(saveInfo.serverId));
      }
    }
    if (platformManager.authorizeDeferred && typeof platformManager.authorizeDeferred.resolve === "function") {
      platformManager.authorizeDeferred.resolve(saveInfo.info);
    }
    record("account:login:prepare", {
      tokenId: payload.tokenId || "",
      loginManager: describe(loginManager),
      platformManager: describe(platformManager),
      infoKeys: saveInfo.info && typeof saveInfo.info === "object" ? Object.keys(saveInfo.info) : [],
      serverId: saveInfo.serverId,
    });

    var gameState = null;
    try {
      gameState = window.__require("Game").Game.instance.stateMachine._current.stateId;
    } catch (error) {}

    var result = { deferredReleased: true, state: gameState };
    result.loginStarted = true;
    result.loginState = gameState;
    var loginPromise;
    try {
      loginPromise = Promise.resolve(loginManager.login(true));
    } catch (error) {
      record("account:login:manager:error", {
        tokenId: payload.tokenId || "",
        error: error.message,
      });
      throw error;
    }
    loginPromise.then(function (loginResult) {
      record("account:login:complete", {
        tokenId: payload.tokenId || "",
        result: summarize(loginResult, 0, []),
        role: {
          roleId: window.ROLE && window.ROLE.roleId,
          serverId: window.ROLE && window.ROLE.serverId,
          levelId: window.ROLE && window.ROLE.levelId,
          authed: window.ROLE && window.ROLE.authed,
        },
      });
    }).catch(function (error) {
      record("account:login:manager:error", {
        tokenId: payload.tokenId || "",
        error: error.message,
      });
    });
    await waitForAuthUserResult(loginManager, 15000);
    result.authUserReturned = true;
    result.loginPending = true;
    record("account:login:manager", {
      tokenId: payload.tokenId || "",
      result: result,
      role: {
        roleId: window.ROLE && window.ROLE.roleId,
        serverId: window.ROLE && window.ROLE.serverId,
        levelId: window.ROLE && window.ROLE.levelId,
        authed: window.ROLE && window.ROLE.authed,
      },
    });
    return {
      tokenId: payload.tokenId || "",
      saveInfoKeys: Object.keys(saveInfo),
      loginManager: describe(loginManager),
      platformManager: describe(platformManager),
    };
  }

  function extractBattleData(value) {
    if (!value) return null;
    return value.battleData || (value.body && value.body.battleData) || value;
  }

  function battleShape(battleData) {
    var rightTeam = battleData && battleData.rightTeam;
    var rightContainer = rightTeam && (rightTeam.team || rightTeam);
    return {
      keys: battleData ? Object.keys(battleData) : [],
      randomSeed: battleData && battleData.randomSeed,
      version: battleData && battleData.version,
      constructor: battleData && battleData.constructor ? battleData.constructor.name : "",
      leftTeam: summarize(battleData && battleData.leftTeam, 0, []),
      rightTeamKeys:
        rightContainer && typeof rightContainer === "object"
          ? Object.keys(rightContainer)
          : [],
      options: summarize(battleData && battleData.options, 0, []),
    };
  }

  function loadSh1IfNeeded() {
    // 研究被动页不注入旧上号器（避免探测污染）；headless-test 与普通运行时页由 sh1 负责 BIN 登录/进主城。
    // 必须在文档解析完成后动态注入：document.write 注入会切断后续静态脚本解析（v18 实测）。
    if (RESEARCH_MODE || document.getElementById("sh1-script")) return;
    var inject = function () {
      if (document.getElementById("sh1-script")) return;
      var script = document.createElement("script");
      script.id = "sh1-script";
      script.src = "sh1.js";
      script.charset = "utf-8";
      document.body.appendChild(script);
      record("runtime:sh1-injected", { at: document.readyState });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", inject, { once: true });
    } else {
      inject();
    }
  }

  function runtimeStateSnapshot() {
    var gameState = null;
    var login = null;
    var platform = null;
    var network = null;
    try {
      var gameModule = quietRequire("Game");
      gameState = gameModule && gameModule.Game && gameModule.Game.instance &&
        gameModule.Game.instance.stateMachine &&
        gameModule.Game.instance.stateMachine._current &&
        gameModule.Game.instance.stateMachine._current.stateId;
    } catch (error) {}
    try {
      var loginModule = quietRequire("LoginManager");
      login = loginModule && loginModule.LoginManager && loginModule.LoginManager.instance;
    } catch (error) {}
    try {
      var platformModule = quietRequire("PlatformManager");
      platform = platformModule && platformModule.PlatformManager && platformModule.PlatformManager.instance;
    } catch (error) {}
    try {
      var networkModule = quietRequire("NetworkManager");
      network = networkModule && networkModule.NetworkManager;
    } catch (error) {}
    return {
      gameState: gameState || null,
      role: {
        roleId: window.ROLE && window.ROLE.roleId,
        serverId: window.ROLE && window.ROLE.serverId,
        levelId: window.ROLE && window.ROLE.levelId,
        authed: window.ROLE && window.ROLE.authed,
      },
      login: {
        hasAuthUserResult: Boolean(login && login._authUserResult),
        repeatConnect: login && login.repeatConnect,
        tryReLoginTimes: login && login._tryReLoginTimes,
      },
      platform: {
        platformType: platform && platform.platformType,
        platformExt: platform && platform.platformExt,
        oriPlatformType: platform && platform.oriPlatformType,
        subPlatform: platform && platform._subPlatform,
      },
      network: {
        connected: network && typeof network.isConnected === "function"
          ? network.isConnected()
          : null,
        alive: network && typeof network.isAlive === "function"
          ? network.isAlive()
          : null,
      },
      capture: {
        hashCaptureEnabled: state.hashCaptureEnabled,
        hashHooked: state.hashHooked,
        authHooked: state.authHooked,
        hashHooks: state.hashHooks.slice(-20),
        decodedFrameCount: state.decodedFrameCount,
        frameDecodeErrorCount: state.frameDecodeErrorCount,
        protocolMessageCount: state.protocolMessageCount,
      },
    };
  }

  function runtimeCapabilitiesSnapshot() {
    var manager = quietRequire("manager-factory");
    var dataIndex = quietRequire("data-index");
    var battleManager = manager && manager.BattleManager;
    var battleInstance = null;
    var managerError = null;
    try {
      battleInstance = battleManager && battleManager.instance;
    } catch (error) {
      managerError = error && error.message ? error.message : String(error);
    }
    var startLevel = dataIndex && dataIndex.FightService && dataIndex.FightService.startLevel;
    var endLevel = dataIndex && dataIndex.FightService && dataIndex.FightService.endLevel;
    var quickBattle = battleManager && battleManager.prototype &&
      battleManager.prototype.startQuickLevelBattleById;
    return {
      bridgeVersion: BRIDGE_VERSION,
      mode: MODE,
      gameState: runtimeStateSnapshot().gameState,
      roleId: window.ROLE && window.ROLE.roleId,
      levelId: window.ROLE && window.ROLE.levelId,
      official: {
        fightStartLevel: typeof startLevel === "function",
        fightEndLevel: typeof endLevel === "function",
        battleDataType: Boolean(dataIndex && dataIndex.BattleData),
        battleResultType: Boolean(dataIndex && dataIndex.BattleResult),
        battleManager: Boolean(battleManager),
        quickBattleEntry: typeof quickBattle === "function",
        battleManagerInstance: Boolean(battleInstance),
        clientFactory: Boolean(battleInstance && battleInstance._battleFactory),
        serverFactory: Boolean(battleInstance && battleInstance._serverBattleFactory),
      },
      managerError: managerError,
      readyForHeadless: Boolean(
        battleInstance &&
        battleInstance._serverBattleFactory &&
        typeof startLevel === "function" &&
        typeof quickBattle === "function",
      ),
    };
  }

  function getOfficialRole() {
    var serverData = quietRequire("ServerData");
    return (serverData && serverData.ROLE) || window.ROLE || null;
  }

  function getNestedValue(root, names, depth, visited) {
    if (!root || depth < 0) return undefined;
    if (typeof root !== "object" && typeof root !== "function") return undefined;
    visited = visited || [];
    if (visited.indexOf(root) >= 0) return undefined;
    visited.push(root);

    for (var index = 0; index < names.length; index += 1) {
      var name = names[index];
      try {
        if (root[name] !== undefined && root[name] !== null) return root[name];
      } catch (error) {}
    }

    var keys = safeOwnKeys(root).slice(0, 180);
    for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      var key = keys[keyIndex];
      if (key === "caller" || key === "callee" || key === "arguments") continue;
      var child;
      try {
        child = root[key];
      } catch (error) {
        continue;
      }
      var found = getNestedValue(child, names, depth - 1, visited);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  function getBattleTime(world) {
    var tickCount = getNestedValue(world, ["tickCount", "battleTick", "totalTick"], 3, []);
    if (typeof tickCount === "number" && Number.isFinite(tickCount) && tickCount >= 0) {
      return Math.floor(tickCount);
    }
    var startTick = getNestedValue(world, ["StartTick", "startTick"], 4, []);
    var endTick = getNestedValue(world, ["EndTick", "endTick"], 4, []);
    if (
      typeof startTick === "number" &&
      typeof endTick === "number" &&
      Number.isFinite(startTick) &&
      Number.isFinite(endTick) &&
      endTick >= startTick
    ) {
      return Math.floor(endTick - startTick);
    }
    return 0;
  }

  function getBattleTimes(world, battleData, fallbackAutoTapTimes) {
    var tapTimes = getNestedValue(world, ["saveLordAttack", "lordAttackTime", "tapTimes"], 4, []);
    var autoTapTimes = getNestedValue(
      world,
      ["saveAutoLordAttack", "lordAutoAttackTime", "autoTapTimes"],
      4,
      [],
    );
    if (tapTimes === undefined || tapTimes === null) tapTimes = [[]];
    if (autoTapTimes === undefined || autoTapTimes === null) {
      autoTapTimes = fallbackAutoTapTimes;
    }
    if (autoTapTimes === undefined || autoTapTimes === null) {
      var leftTeam = battleData && battleData.leftTeam;
      autoTapTimes = leftTeam && leftTeam.lordAutoAttackTime;
    }
    if (autoTapTimes === undefined || autoTapTimes === null) autoTapTimes = [[]];
    return {
      tapTimes: summarize(tapTimes, 0, []),
      autoTapTimes: summarize(autoTapTimes, 0, []),
    };
  }

  function getStartLevelBattleData(response) {
    var data = response && typeof response.getData === "function"
      ? response.getData()
      : response;
    return data && (data.battleData || data.body && data.body.battleData);
  }

  function describeValue(value) {
    if (value === null || value === undefined) return value;
    var type = typeof value;
    if (type === "function") {
      return { kind: "function", name: value.name || "anonymous", arity: value.length };
    }
    if (type === "object") {
      return {
        kind: "object",
        constructor: (value.constructor && value.constructor.name) || "",
        keys: safeOwnKeys(value).slice(0, 60),
      };
    }
    return { kind: type, value: value };
  }

  function sourcePreview(fn, limit) {
    try {
      var text = Function.prototype.toString.call(fn);
      return text.slice(0, Math.min(text.length, limit || 500));
    } catch (error) {
      return null;
    }
  }

  function searchRef(root, names, depth, visited, budget) {
    if (!root || depth < 0) return null;
    if (budget.count++ > 3000) return null;
    if (visited.indexOf(root) >= 0) return null;
    visited.push(root);
    var keys = safeOwnKeys(root).slice(0, 200);
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      var child;
      try {
        child = root[key];
      } catch (error) {
        continue;
      }
      for (var nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
        if (key === names[nameIndex] && typeof child === "function") {
          var arity = child.length;
          if (arity === 0 || arity === 1 || arity === undefined) return child;
        }
      }
      if (child && (typeof child === "object" || typeof child === "function") && depth > 0) {
        var found = searchRef(child, names, depth - 1, visited, budget);
        if (found) return found;
      }
    }
    return null;
  }

  function findServerLauncherRef() {
    var roots = [quietRequire("manager-factory"), quietRequire("data-index"), quietRequire("Game")];
    for (var rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      var hit = searchRef(roots[rootIndex], ["ServerBattleLauncher", "ClientBattleLauncher"], 3, [], { count: 0 });
      if (hit) return hit;
    }
    return null;
  }

  function searchTargets(root, names, depth, path, visited, found, budget) {
    if (!root || depth < 0) return;
    if (budget.count++ > 4000) return;
    if (visited.indexOf(root) >= 0) return;
    visited.push(root);
    var keys = safeOwnKeys(root).slice(0, 200);
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      var match = false;
      for (var nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
        if (
          key === names[nameIndex] ||
          key.toLowerCase().indexOf(names[nameIndex].toLowerCase()) >= 0
        ) {
          match = true;
          break;
        }
      }
      var child;
      try {
        child = root[key];
      } catch (error) {
        continue;
      }
      var childPath = path ? path + "." + key : key;
      if (match && found.length < 60) {
        found.push({ path: childPath, value: describeValue(child) });
      }
      if (child && (typeof child === "object" || typeof child === "function") && depth > 0) {
        searchTargets(child, names, depth - 1, childPath, visited, found, budget);
      }
    }
  }

  function instanceFieldState(instance) {
    var out = {};
    if (!instance) return out;
    safeOwnKeys(instance).slice(0, 120).forEach(function (key) {
      if (!/factory|battle|season|launcher|config|running|state|update/i.test(key)) return;
      try {
        out[key] = describeValue(instance[key]);
      } catch (error) {
        out[key] = { kind: "unreadable", error: error.message };
      }
    });
    return out;
  }

  function findSeasonBattleTypesHolder(root, depth, path, visited, budget, found) {
    if (!root || depth < 0) return;
    if (budget.count++ > 8000) return;
    if (visited.indexOf(root) >= 0) return;
    visited.push(root);
    if (
      root &&
      toString.call(root) === "[object Object]" &&
      Object.prototype.hasOwnProperty.call(root, "seasonBattleTypes")
    ) {
      if (found.length < 20) {
        found.push({ path: path || "<root>", value: describeValue(root.seasonBattleTypes) });
      }
      return;
    }
    var keys = safeOwnKeys(root).slice(0, 150);
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      if (key === "caller" || key === "callee" || key === "arguments") continue;
      var child;
      try {
        child = root[key];
      } catch (error) {
        continue;
      }
      if (child && (typeof child === "object" || typeof child === "function")) {
        findSeasonBattleTypesHolder(
          child,
          depth - 1,
          path ? path + "." + key : key,
          visited,
          budget,
          found,
        );
      }
    }
  }

  function seasonBattleTypesHoldersProbe() {
    var seasonHolders = [];
    [
      { label: "manager-factory", value: quietRequire("manager-factory") },
      { label: "data-index", value: quietRequire("data-index") },
      { label: "Game", value: quietRequire("Game") },
      { label: "Configs", value: quietRequire("Configs") },
    ].forEach(function (root) {
      var found = [];
      findSeasonBattleTypesHolder(root.value, 3, root.label, [], { count: 0 }, found);
      if (found.length) seasonHolders.push({ root: root.label, holders: found });
    });
    return seasonHolders;
  }

  function diagnoseBattleManager() {
    var managerModule = quietRequire("manager-factory");
    var battleManager = managerModule && managerModule.BattleManager;
    var instance = null;
    var instanceError = null;
    try {
      instance = battleManager && battleManager.instance;
    } catch (error) {
      instanceError = error && error.message ? error.message : String(error);
    }
    var proto = battleManager && battleManager.prototype;
    var methods = {};
    ["init", "deinitialize", "updateServerFactory", "onLoad", "update", "startLevelBattleById", "startQuickLevelBattleById"].forEach(function (name) {
      var fn = proto && proto[name];
      methods[name] = typeof fn === "function" ? sourcePreview(fn, 600) : null;
    });
    var launcher = {};
    var launcherCtor = instance && instance._battleFactory && instance._battleFactory.constructor;
    if (launcherCtor) {
      launcher.constructorName = launcherCtor.name || "anonymous";
      ["initialize", "deinitialize", "createBattle", "createBattleById", "createBattleByType", "update", "getBattle", "quitBattle"].forEach(function (name) {
        var fn = launcherCtor.prototype && launcherCtor.prototype[name];
        launcher[name] = typeof fn === "function" ? sourcePreview(fn, 700) : null;
      });
    }
    var serverLauncherProto = instance && instance._serverBattleFactory && instance._serverBattleFactory.constructor;
    launcher.serverFactoryConstructor = serverLauncherProto ? (serverLauncherProto.name || "anonymous") : null;
    var launcherRef = findServerLauncherRef();
    launcher.reachableViaSearch = launcherRef ? String(launcherRef.name || "anonymous") : null;
    var configProbe = {};
    var configsModule = quietRequire("Configs");
    configProbe.configsModuleFound = Boolean(configsModule);
    if (configsModule) {
      configProbe.configsKeys = safeOwnKeys(configsModule).slice(0, 60);
      var configsInstance = null;
      try {
        configsInstance = configsModule.instance;
      } catch (error) {}
      configProbe.configsInstanceFound = Boolean(configsInstance);
      if (configsInstance) {
        configProbe.configsInstanceKeys = safeOwnKeys(configsInstance).slice(0, 80);
        configProbe.hasSeasonBattleTypes = "seasonBattleTypes" in configsInstance;
        configProbe.seasonBattleTypesKind = configProbe.hasSeasonBattleTypes
          ? describeValue(configsInstance.seasonBattleTypes)
          : null;
        configProbe.hasSeasonBattleType = "seasonBattleType" in configsInstance;
      }
    }
    var dataIndex = quietRequire("data-index");
    configProbe.battleTypeInDataIndex = Boolean(dataIndex && (dataIndex.BattleType || dataIndex.EMSeasonType || dataIndex.EMBattleType));

    var targets = {};
    [
      { label: "manager-factory", value: managerModule },
      { label: "data-index", value: dataIndex },
      { label: "Game", value: quietRequire("Game") },
    ].forEach(function (root) {
      var found = [];
      searchTargets(
        root.value,
        ["ServerBattleLauncher", "ClientBattleLauncher", "seasonBattleTypes", "seasonBattle", "SeasonBattleType"],
        2,
        "",
        [],
        found,
        { count: 0 },
      );
      if (found.length) targets[root.label] = found;
    });
    return {
      battleManagerFound: Boolean(battleManager),
      instanceFound: Boolean(instance),
      instanceError: instanceError,
      instanceKeys: instance ? safeOwnKeys(instance).slice(0, 100) : [],
      prototypeKeys: proto ? safeOwnKeys(proto).slice(0, 120) : [],
      fields: instanceFieldState(instance),
      methods: methods,
      launcher: launcher,
      configProbe: configProbe,
      seasonHolders: seasonBattleTypesHoldersProbe(),
      targets: targets,
    };
  }

  function runHeadlessBattle(world, targetResult, battleData, fallbackAutoTapTimes, timeout, useActual) {
    return new Promise(function (resolve, reject) {
      var signal = world && (world.BattleEndSignal || world.battleEndSignal);
      if (!signal || typeof signal.once !== "function") {
        reject(new Error("官方无头战斗缺少 BattleEndSignal.once"));
        return;
      }

      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("官方无头战斗等待结束超时"));
      }, timeout);

      signal.once(function (actualIsWin) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          // useActual=true 时用引擎真实胜负生成结果（用于"真实失败结果截获"实验）；
          // 否则用 targetResult 指定结果（官方 API 允许客户端指定胜负，用于常规生成）。
          var result = world.getBattleResult(useActual ? Boolean(actualIsWin) : Boolean(targetResult), false);
          var times = getBattleTimes(world, battleData, fallbackAutoTapTimes);
          resolve({
            actualIsWin: Boolean(actualIsWin),
            requestedIsWin: Boolean(targetResult),
            battleTime: getBattleTime(world),
            tapTimes: times.tapTimes,
            autoTapTimes: times.autoTapTimes,
            outputCode: result && result.outputCode,
            result: result,
          });
        } catch (error) {
          reject(error);
        }
      });

      try {
        world.startBattle();
        world.quickBattle();
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async function generateHeadlessBattle(payload) {
    if (!HEADLESS_TEST_MODE) {
      throw new Error("官方无头入口只允许在 headless-test=1 页面使用");
    }
    if (state.headlessBusy) throw new Error("官方无头战斗正在运行");
    if (state.headlessRunCount >= 1) throw new Error("单个 headless-test iframe 只允许生成一场战斗");
    if (!payload || payload.testOnly !== true) {
      throw new Error("官方无头战斗需要 testOnly=true");
    }
    if (payload.isWin !== undefined && typeof payload.isWin !== "boolean") {
      throw new Error("官方无头战斗的 isWin 必须是布尔值");
    }
    if (payload.battleTime !== undefined && payload.battleTime !== null) {
      var requestedBattleTime = Number(payload.battleTime);
      if (!Number.isInteger(requestedBattleTime) || requestedBattleTime < 0 || requestedBattleTime > 1000000) {
        throw new Error("官方无头战斗的 battleTime 必须是 0 到 1000000 之间的整数 tick");
      }
    }

    var managerModule = quietRequire("manager-factory");
    var dataIndex = quietRequire("data-index");
    var battleManager = managerModule && managerModule.BattleManager;
    var startLevel = dataIndex && dataIndex.FightService && dataIndex.FightService.startLevel;
    if (!battleManager || typeof startLevel !== "function") {
      throw new Error("官方 FightService.startLevel 或 BattleManager 不可用");
    }

    state.headlessBusy = true;
    state.headlessRunCount += 1;
    record("headless:start", {
      requestedIsWin: payload.isWin !== false,
      requestedBattleTime: payload.battleTime,
      autoTapTimes: payload.autoTapTimes,
    });
    try {
      var managerInstance = battleManager.instance;
      if (!managerInstance) throw new Error("BattleManager.instance 不可用");

      // 依次尝试引导 _serverBattleFactory：官方 init -> updateServerFactory -> 直接构造 ServerBattleLauncher。
      // 全部只读探测结果通过 headless:bootstrap / headless:diagnose 记录，供下一次运行时迭代定位 seasonBattleTypes。
      var bootstrap = [];
      if (!managerInstance._serverBattleFactory && typeof managerInstance.init === "function") {
        try {
          managerInstance.init();
          bootstrap.push({ kind: "init", ok: Boolean(managerInstance._serverBattleFactory), error: null });
        } catch (error) {
          bootstrap.push({ kind: "init", ok: false, error: error.message, stack: error.stack });
          record("headless:init:error", { error: error.message, stack: error.stack });
        }
      }
      if (!managerInstance._serverBattleFactory && typeof managerInstance.updateServerFactory === "function") {
        try {
          managerInstance.updateServerFactory();
          bootstrap.push({ kind: "updateServerFactory", ok: Boolean(managerInstance._serverBattleFactory), error: null });
        } catch (error) {
          bootstrap.push({ kind: "updateServerFactory", ok: false, error: error.message, stack: error.stack });
        }
      }
      if (!managerInstance._serverBattleFactory) {
        var Launcher = findServerLauncherRef();
        if (Launcher) {
          try {
            managerInstance._serverBattleFactory = new Launcher();
            bootstrap.push({
              kind: "direct-construct",
              constructor: Launcher.name || "anonymous",
              ok: Boolean(managerInstance._serverBattleFactory),
              error: null,
            });
          } catch (error) {
            bootstrap.push({
              kind: "direct-construct",
              constructor: Launcher.name || "anonymous",
              ok: false,
              error: error.message,
            });
          }
        }
      }
      if (bootstrap.length) {
        record("headless:bootstrap", {
          attempts: bootstrap,
          diagnose: diagnoseBattleManager(),
        });
      }
      if (!managerInstance._serverBattleFactory) {
        throw new Error("官方 _serverBattleFactory 尚未初始化，不能运行无头战斗");
      }

      var response = await startLevel({});
      var battleData = getStartLevelBattleData(response);
      if (!battleData || typeof battleData !== "object") {
        throw new Error("FightService.startLevel 未返回类型化 battleData");
      }
      if (payload.autoTapTimes !== undefined && payload.autoTapTimes !== null) {
        if (!battleData.leftTeam || typeof battleData.leftTeam !== "object") {
          throw new Error("battleData.leftTeam 不可用，无法设置自动攻击时间表");
        }
        battleData.leftTeam.lordAutoAttackTime = payload.autoTapTimes;
      }

      var role = getOfficialRole();
      var world = managerInstance.startQuickLevelBattleById(
        battleData,
        role,
        payload.autoAttack !== false,
        Number.isFinite(Number(payload.autoAttackInterval))
          ? Number(payload.autoAttackInterval)
          : 40,
        Number.isFinite(Number(payload.timeScale)) ? Number(payload.timeScale) : 0,
      );
      if (!world) throw new Error("官方 startQuickLevelBattleById 未创建战斗世界");

      if (typeof world.startBattle !== "function" || typeof world.quickBattle !== "function") {
        throw new Error("官方无头战斗世界缺少 startBattle/quickBattle");
      }

      var generated = await runHeadlessBattle(
        world,
        payload.isWin !== false,
        battleData,
        payload.autoTapTimes,
        60000,
      );
      var levelId = (function () {
        try {
          var opts = battleData && battleData.options;
          var pick = function (v) {
            if (v === undefined || v === null) return null;
            var n = Number(v);
            return Number.isFinite(n) && n >= 0 ? n : null;
          };
          if (opts) {
            var direct = pick(opts.levelId);
            if (direct !== null) return direct;
            if (typeof opts.get === "function") {
              var fromGet = pick(opts.get("levelId"));
              if (fromGet !== null) return fromGet;
            }
            if (typeof opts.getExt === "function") {
              var fromExt = pick(opts.getExt("levelId"));
              if (fromExt !== null) return fromExt;
            }
          }
          var flat = pick(battleData.levelId);
          if (flat !== null) return flat;
          var ro = window && window.ROLE;
          var roleLevel = ro ? pick(ro.levelId) : null;
          if (roleLevel !== null) return roleLevel;
          return null;
        } catch (error) {
          return null;
        }
      })();
      if (levelId === null || levelId === undefined) {
        throw new Error("无法确定 levelId（battleData.options.levelId 不可读）");
      }
      var requestedBattleTime = payload.battleTime;
      var battleTime = requestedBattleTime === undefined || requestedBattleTime === null
        ? generated.battleTime
        : requestedBattleTime;
      var result = {
        levelId: levelId,
        battleData: summarize(battleData, 0, []),
        battleTime: battleTime,
        actualBattleTime: generated.battleTime,
        tapTimes: generated.tapTimes,
        autoTapTimes: generated.autoTapTimes,
        actualIsWin: generated.actualIsWin,
        requestedIsWin: generated.requestedIsWin,
        outputCode: generated.outputCode,
        result: generated.result,
      };
      state.headlessLastResult = result;
      record("headless:result", result);
      return result;
    } finally {
      state.headlessBusy = false;
    }
  }

  // 对官方真实结果做单点微调（容差探测实验）：只改 payload.tweak 指定的字段与幅度，
  // 其余字段保持官方原值，重算哈希后提交，观察服务器验算的严格程度。
  function applyTweak(result, tweak) {
    var c = result;
    var sp0 = c.sponsor && c.sponsor.teamInfo && c.sponsor.teamInfo[0];
    var ac0 = c.accept && c.accept.teamInfo && c.accept.teamInfo[0];
    var amount = Number(tweak.amount);
    if (!Number.isFinite(amount)) amount = 0;
    switch (tweak.mode) {
      case "sponsor-hp-minus":
        if (sp0) sp0.hp = Math.max(0, Number(sp0.hp) - amount);
        break;
      case "sponsor-hp-plus":
        if (sp0) sp0.hp = Number(sp0.hp) + amount;
        break;
      case "accept-hp-plus":
        if (ac0) ac0.hp = Number(ac0.hp) + amount;
        break;
      case "accept-hp-minus":
        if (ac0) ac0.hp = Math.max(0, Number(ac0.hp) - amount);
        break;
      case "sponsor-rage-set":
        if (sp0) sp0.rage = amount;
        break;
      case "sponsor-damage-plus":
        if (sp0) sp0.damage = Number(sp0.damage) + amount;
        break;
      case "battle-time-plus":
        c.__battleTimeOffset = amount;
        break;
      default:
        break;
    }
    return c;
  }

  // 将"胜利结果"的战绩翻正为"守恒自洽"的成功形态：
  // - 我方各成员：hp = 初始血量 - 少量受击（主力掉5%、其余1%），rage/energy 成功值，治疗置 0
  // - 我方总伤害补齐"灭掉敌方全队"所需的缺口（敌方初始血 = 战后余血 + 已受击）
  // - 敌方：hp=0 全灭，takeDamage=初始血量（被灭所需），ext.curHP=0
  // 对照真实成功战报样本（sponsor 存活掉少量血、accept 全灭），并保持伤害/受击守恒。
  function successifyResult(result, battleData) {
    var clone = JSON.parse(JSON.stringify(result));
    clone.isWin = true;
    var teamMap = function (side) {
      var out = {};
      try {
        var raw = battleData && battleData.leftTeam && side === "left"
          ? battleData.leftTeam.team
          : (battleData && battleData.rightTeam && battleData.rightTeam.team);
        if (!raw) return out;
        if (typeof Map !== "undefined" && raw instanceof Map) {
          raw.forEach(function (value, key) {
            out[String(key)] = JSON.parse(JSON.stringify(value));
          });
        } else {
          out = JSON.parse(JSON.stringify(raw));
        }
      } catch (error) {}
      return out;
    };
    var leftTeamMap = teamMap("left");
    var rightTeamMap = teamMap("right");
    var sponsorMembers = clone.sponsor && clone.sponsor.teamInfo;
    if (Array.isArray(sponsorMembers)) {
      sponsorMembers.forEach(function (member, index) {
        var init = leftTeamMap[String(member.index)] || leftTeamMap[String(index)] || null;
        var initHp = init && Number(init.curHp) > 0 ? Number(init.curHp) : 1;
        var down = Math.max(1, Math.ceil(initHp * (index === 0 ? 0.05 : 0.01)));
        member.hp = Math.max(1, initHp - down);
        member.takeDamage = down;
        member.treatment = 0;
        member.rage = index === 0 ? 100 : 50;
        member.energy = index === 0 ? 100 : 50;
      });
      var total = sponsorMembers.reduce(function (sum, member) {
        return sum + (typeof member.hp === "number" ? member.hp : 0);
      }, 0);
      if (clone.sponsor.ext) clone.sponsor.ext.curHP = total;
    }
    var acceptMembers = clone.accept && clone.accept.teamInfo;
    if (Array.isArray(acceptMembers)) {
      var gapTotal = 0;
      acceptMembers.forEach(function (member) {
        var afterHp = Number(member.hp) > 0 ? Number(member.hp) : 0;
        var dealt = Number(member.takeDamage) > 0 ? Number(member.takeDamage) : 0;
        var initAc = Math.max(0, afterHp + dealt);
        gapTotal += initAc;
        member.hp = 0;
        member.takeDamage = afterHp + dealt;
        member.rage = 0;
        member.energy = 0;
      });
      if (clone.accept.ext) clone.accept.ext.curHP = 0;
      // 我方伤害补齐灭队缺口（主力承担）
      if (Array.isArray(sponsorMembers) && sponsorMembers.length) {
        var extra = Math.max(0, gapTotal);
        var first = sponsorMembers[0];
        first.damage = (typeof first.damage === "number" ? first.damage : 0) + extra;
        if (first.maxAttr) {
          var peak = (typeof first.maxAttr["4"] === "number" ? first.maxAttr["4"] : 0);
          first.maxAttr["4"] = peak + extra;
        }
      }
    }
    return clone;
  }

  // 将官方真实战斗结果中的 isWin 强制改为 true，并按文档公式（哈希时刻对象）重算 outputCode。
  // 用于"失败→成功拦截"受控实验：只改标志与哈希，不改战绩字段。
  function recomputeOutputCodeForWin(result, md5Module) {
    var clone = JSON.parse(JSON.stringify(result));
    clone.isWin = true;
    // 哈希时刻字段归零（与文档 §2.3/§7.2 一致）
    clone.totalFrame = 0;
    clone.round = 0;
    clone.battleVersion = "";
    clone.inputCode = "";
    clone.outputCode = "";
    clone.isTimeout = 0;
    clone.statistic = {};
    // 哈希时刻 JSONExt 序列化会丢弃这些字段（官方置 undefined）
    delete clone.memoMode;
    delete clone.sponsors;
    delete clone.accepts;
    delete clone.gameResults;
    delete clone.memos;
    // 顶层键序固定为官方构造顺序
    var ordered = {
      id: clone.id,
      isWin: clone.isWin,
      seed: clone.seed,
      totalFrame: clone.totalFrame,
      version: clone.version,
      battleVersion: clone.battleVersion,
      inputCode: clone.inputCode,
      outputCode: clone.outputCode,
      log: clone.log,
      sponsor: clone.sponsor,
      accept: clone.accept,
      type: clone.type,
      round: clone.round,
      isTimeout: clone.isTimeout,
      statistic: clone.statistic,
    };
    var serialized = JSON.stringify(ordered);
    var code = "";
    if (md5Module && md5Module.Md5 && typeof md5Module.Md5.hashStr === "function") {
      code = md5Module.Md5.hashStr(serialized);
    }
    return { clone: clone, serialized: serialized, outputCode: code };
  }

  async function doSubmitBypass(payload) {
    if (!HEADLESS_TEST_MODE) {
      throw new Error("官方无头入口只允许在 headless-test=1 页面使用");
    }
    if (state.headlessBusy) throw new Error("官方无头战斗正在运行");
    if (state.submitRunCount >= 1) {
      throw new Error("单个 headless-test iframe 只允许提交一次拦截实验");
    }
    if (!payload || payload.confirmSubmit !== true) {
      throw new Error("拦截提交实验需要 confirmSubmit=true（会真实提交 fight_endlevel，改变账号关卡进度）");
    }

    var managerModule = quietRequire("manager-factory");
    var dataIndex = quietRequire("data-index");
    var battleManager = managerModule && managerModule.BattleManager;
    var startLevel = dataIndex && dataIndex.FightService && dataIndex.FightService.startLevel;
    var endLevel = dataIndex && dataIndex.FightService && dataIndex.FightService.endLevel;
    if (typeof startLevel !== "function" || typeof endLevel !== "function") {
      throw new Error("官方 FightService.startLevel/endLevel 不可用");
    }

    state.headlessBusy = true;
    state.submitRunCount += 1;
    record("headless:bypass:start", {
      requestedAutoTapTimes: payload.autoTapTimes,
      beforeLevelId: (function () {
        try {
          return (window.ROLE && window.ROLE.levelId) || null;
        } catch (error) {
          return null;
        }
      })(),
    });
    try {
      var managerInstance = battleManager && battleManager.instance;
      if (!managerInstance) throw new Error("BattleManager.instance 不可用");
      if (!managerInstance._serverBattleFactory) {
        throw new Error("官方 _serverBattleFactory 未初始化（请先进入主城）");
      }

      var response = await startLevel({});
      var battleData = getStartLevelBattleData(response);
      if (!battleData || typeof battleData !== "object") {
        throw new Error("FightService.startLevel 未返回类型化 battleData");
      }
      if (payload.autoTapTimes !== undefined && payload.autoTapTimes !== null) {
        if (!battleData.leftTeam || typeof battleData.leftTeam !== "object") {
          throw new Error("battleData.leftTeam 不可用，无法设置自动攻击时间表");
        }
        battleData.leftTeam.lordAutoAttackTime = payload.autoTapTimes;
      }

      var role = getOfficialRole();
      var world = managerInstance.startQuickLevelBattleById(
        battleData,
        role,
        payload.autoAttack !== false,
        Number.isFinite(Number(payload.autoAttackInterval))
          ? Number(payload.autoAttackInterval)
          : 40,
        Number.isFinite(Number(payload.timeScale)) ? Number(payload.timeScale) : 0,
      );
      if (!world) throw new Error("官方 startQuickLevelBattleById 未创建战斗世界");

      var generated = await runHeadlessBattle(
        world,
        true,
        battleData,
        payload.autoTapTimes,
        60000,
        true, // useActual：取引擎真实胜负（本关预期失败）
      );

      var md5Module = quietRequire("ts-md5");
      var forWinSource = generated.result;
      if (payload.tweak && typeof payload.tweak === "object") {
        // 容差探测：以官方真实结果做基底，仅单点微调，其余保持官方原值
        forWinSource = JSON.parse(JSON.stringify(generated.result));
        forWinSource.isWin = true;
        applyTweak(forWinSource, payload.tweak);
        record("headless:bypass:tweaked", {
          tweak: payload.tweak,
          sponsor0Hp: forWinSource.sponsor && forWinSource.sponsor.teamInfo && forWinSource.sponsor.teamInfo[0] && forWinSource.sponsor.teamInfo[0].hp,
          accept0Hp: forWinSource.accept && forWinSource.accept.teamInfo && forWinSource.accept.teamInfo[0] && forWinSource.accept.teamInfo[0].hp,
        });
      } else if (!generated.actualIsWin && payload.successify === true) {
        // 只有真实失败才做成功化；若引擎真实胜利则原样提交官方结果（与官方提交等价的基线）
        forWinSource = successifyResult(generated.result, battleData);
        record("headless:bypass:successified", {
          sponsorHp: (forWinSource.sponsor && forWinSource.sponsor.teamInfo || []).map(function (m) { return m.hp; }),
          acceptHp: (forWinSource.accept && forWinSource.accept.teamInfo || []).map(function (m) { return m.hp; }),
          sponsorCurHp: forWinSource.sponsor && forWinSource.sponsor.ext && forWinSource.sponsor.ext.curHP,
          acceptCurHp: forWinSource.accept && forWinSource.accept.ext && forWinSource.accept.ext.curHP,
        });
      }
      var forWin = recomputeOutputCodeForWin(forWinSource, md5Module);
      if (!forWin.outputCode || forWin.outputCode.length !== 32) {
        throw new Error("ts-md5.hashStr 不可用，无法重算 outputCode");
      }

      var levelId = (function () {
        try {
          var opts = battleData && battleData.options;
          var pick = function (v) {
            if (v === undefined || v === null) return null;
            var n = Number(v);
            return Number.isFinite(n) && n >= 0 ? n : null;
          };
          if (opts) {
            var direct = pick(opts.levelId);
            if (direct !== null) return direct;
            if (typeof opts.get === "function") {
              var fromGet = pick(opts.get("levelId"));
              if (fromGet !== null) return fromGet;
            }
            if (typeof opts.getExt === "function") {
              var fromExt = pick(opts.getExt("levelId"));
              if (fromExt !== null) return fromExt;
            }
          }
          var flat = pick(battleData.levelId);
          if (flat !== null) return flat;
          var ro = window && window.ROLE;
          var roleLevel = ro ? pick(ro.levelId) : null;
          if (roleLevel !== null) return roleLevel;
          return null;
        } catch (error) {
          return null;
        }
      })();
      if (levelId === null || levelId === undefined) {
        throw new Error("无法确定 levelId（battleData.options.levelId 不可读）");
      }
      var endLevelBody = {
        levelId: levelId,
        battleTime: (Number.isFinite(generated.battleTime) ? generated.battleTime : 0) +
          (forWinSource && forWinSource.__battleTimeOffset ? forWinSource.__battleTimeOffset : 0),
        // 官方格式：tapTimes/autoTapTimes 是"每波次数组"；无点击/无自动点也要保留 [[]] 结构
        tapTimes: generated.tapTimes && generated.tapTimes.length ? generated.tapTimes : [[]],
        autoTapTimes: generated.autoTapTimes && generated.autoTapTimes.length ? generated.autoTapTimes : [[]],
        outputCode: forWin.outputCode,
        log: "",
      };
      record("headless:bypass:submitting", {
        mode: payload.successify === true ? "successify" : "iswin-only",
        levelId: levelId,
        actualIsWin: generated.actualIsWin,
        interceptedToWin: !generated.actualIsWin,
        battleTime: endLevelBody.battleTime,
        outputCode: forWin.outputCode,
        serializedLen: forWin.serialized.length,
        bodyKeys: Object.keys(endLevelBody),
        bodyFull: JSON.stringify(endLevelBody),
      });

      var endResponse = await endLevel(endLevelBody);
      var respData = null;
      try {
        respData = endResponse && typeof endResponse.getData === "function"
          ? endResponse.getData()
          : endResponse;
      } catch (error) {}
      var result = {
        levelId: levelId,
        actualIsWin: generated.actualIsWin,
        interceptedToWin: !generated.actualIsWin,
        battleTime: endLevelBody.battleTime,
        outputCode: forWin.outputCode,
        serializedLen: forWin.serialized.length,
        battleData: summarize(battleData, 0, []),
        result: summarize(generated.result, 0, []),
        endResponse: summarize(respData, 0, []),
        roleAfter: (function () {
          try {
            return {
              levelId: window.ROLE && window.ROLE.levelId,
              roleId: window.ROLE && window.ROLE.roleId,
            };
          } catch (error) {
            return null;
          }
        })(),
      };
      record("headless:bypass:result", result);
      return result;
    } finally {
      state.headlessBusy = false;
    }
  }

  function getPacketBody(packet) {
    if (!packet || typeof packet !== "object") return null;
    return packet.body && typeof packet.body === "object" ? packet.body : packet;
  }

  function getPacketCommand(packet) {
    return packet && typeof packet.cmd === "string" ? packet.cmd : "";
  }

  function extractPacketBattleData(packet) {
    var body = getPacketBody(packet);
    return body && (body.battleData || body.body && body.body.battleData) || null;
  }

  function observeProtocolMessage(packet, direction, url, frame) {
    if (!packet || typeof packet !== "object" || packet.__decodeError) return;
    var command = getPacketCommand(packet);
    if (!command) return;

    state.protocolMessageCount += 1;
    state.lastProtocolMessage = {
      command: command,
      direction: direction,
      responseTo: packet.resp,
      sequence: packet.seq,
    };
    record("protocol:message", {
      direction: direction,
      url: url,
      frame: frame,
      packet: packet,
    });

    var lowerCommand = command.toLowerCase();
    if (lowerCommand === "fight_startlevel" || lowerCommand === "fight_startlevelresp") {
      var battleData = extractPacketBattleData(packet);
      if (battleData) {
        state.lastBattleData = battleData;
        state.lastBattleResponse = packet;
      }
      record("battle:protocol:start", {
        direction: direction,
        command: command,
        responseTo: packet.resp,
        battleData: battleData,
        battleShape: battleShape(battleData),
      });
      return;
    }

    if (lowerCommand === "fight_endlevel" || lowerCommand === "fight_endlevelresp") {
      record("battle:protocol:end", {
        direction: direction,
        command: command,
        responseTo: packet.resp,
        body: getPacketBody(packet),
      });
    }
  }

  function observeTgaLog(type, data) {
    if (typeof type !== "string" || !type.startsWith("c_")) return;
    var eventName = "tga:log";
    if (type === "c_battleLevelStart") eventName = "battle:tga:start";
    if (type === "c_battleSuccess" || type === "c_battleFail" || type === "c_battleEnd") {
      eventName = "battle:tga:result";
    }
    var observation = { type: type, data: data };
    state.lastBattleObservation = observation;
    record(eventName, observation);
    if (type === "c_battleLevelStart" && data) {
      matchHashCandidates("inputCode", data.inputCode, {
        levelId: data.levelId,
        randomSeed: data.randomSeed,
        roleId: data.roleId,
        type: type,
      });
    }
    if ((type === "c_battleSuccess" || type === "c_battleFail" || type === "c_battleEnd") && data) {
      matchHashCandidates("outputCode", data.outputCode, {
        level: data.level,
        randomSeed: data.randomSeed,
        roleId: data.roleId,
        battleTime: data.battleTime,
        battleTick: data.battleTick,
        type: type,
      });
    }
  }

  function frameSummary(data) {
    if (typeof data === "string") {
      return { kind: "text", length: data.length, head: data.slice(0, 300) };
    }
    if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
      var arrayBufferSummary = {
        kind: "arraybuffer",
        byteLength: data.byteLength,
        headHex: bytesToHex(new Uint8Array(data), 64),
        scheme: new Uint8Array(data)[0] === 0x70 ? String.fromCharCode(new Uint8Array(data)[0], new Uint8Array(data)[1]) : "plain",
      };
      if (state.captureRawFrames) arrayBufferSummary.rawHex = bytesToHex(new Uint8Array(data), data.byteLength);
      return arrayBufferSummary;
    }
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(data)) {
      var viewSummary = {
        kind: "view",
        byteLength: data.byteLength,
        headHex: bytesToHex(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 64),
        scheme: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)[0] === 0x70
          ? String.fromCharCode(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength)[0],
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength)[1],
          )
          : "plain",
      };
      if (state.captureRawFrames) viewSummary.rawHex = bytesToHex(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), data.byteLength);
      return viewSummary;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return { kind: "blob", size: data.size, type: data.type || "" };
    }
    return summarize(data, 0, []);
  }

  function decodeFrame(data) {
    if (!(typeof ArrayBuffer !== "undefined" && (data instanceof ArrayBuffer || ArrayBuffer.isView(data)))) return null;
    var bytes = toUint8Array(data);
    if (!bytes || bytes.length < 2 || (bytes.length === 1 && bytes[0] === 0)) return null;
    try {
      var decoded = bonDecode(decryptForBon(bytes));
      state.decodedFrameCount += 1;
      return decoded;
    } catch (error) {
      state.frameDecodeErrorCount += 1;
      return {
        __decodeError: error.message,
        scheme: String.fromCharCode(bytes[0], bytes[1]),
        frameLength: bytes.length,
      };
    }
  }

  function installConsoleHook() {
    if (window.__pushResearchConsoleHooked) return;
    window.__pushResearchConsoleHooked = true;
    ["log", "info", "warn", "error", "debug"].forEach(function (level) {
      var original = console[level];
      if (typeof original !== "function") return;
      console[level] = function () {
        try {
          var args = Array.prototype.slice.call(arguments);
          record("console:" + level, { args: args });
          if (args[0] === "TGA log") observeTgaLog(args[1], args[2]);
        } catch (error) {}
        return original.apply(console, arguments);
      };
    });
  }

  function installErrorHooks() {
    window.addEventListener("error", function (event) {
      record("runtime:error", {
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error && event.error.stack,
      });
    });
    window.addEventListener("unhandledrejection", function (event) {
      record("runtime:unhandledrejection", { reason: event.reason });
    });
  }

  function installWebSocketHook() {
    var NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket !== "function" || NativeWebSocket.__pushResearchWrapped) return;

    function safeUrl(url) {
      try {
        var parsed = new URL(String(url), window.location.href);
        return parsed.origin + parsed.pathname;
      } catch (error) {
        return "[invalid-url]";
      }
    }

    function attach(socket) {
      var url = safeUrl(socket.url);
      socket.addEventListener("open", function () { record("ws:open", { url: url }); });
      socket.addEventListener("close", function (event) {
        record("ws:close", { url: url, code: event.code, reason: event.reason });
      });
      socket.addEventListener("error", function () { record("ws:error", { url: url }); });
      socket.addEventListener("message", function (event) {
        var frame = frameSummary(event.data);
        var decoded = decodeFrame(event.data);
        record("ws:message", {
          url: url,
          frame: frame,
          decoded: decoded,
        });
        observeProtocolMessage(decoded, "receive", url, frame);
      });
      var originalSend = socket.send;
      socket.send = function (data) {
        var frame = frameSummary(data);
        var decoded = decodeFrame(data);
        record("ws:send", { url: url, frame: frame, decoded: decoded });
        observeProtocolMessage(decoded, "send", url, frame);
        return originalSend.call(socket, data);
      };
    }

    function ResearchWebSocket(url, protocols) {
      var socket = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
      attach(socket);
      return socket;
    }
    ResearchWebSocket.prototype = NativeWebSocket.prototype;
    Object.keys(NativeWebSocket).forEach(function (key) {
      try { ResearchWebSocket[key] = NativeWebSocket[key]; } catch (error) {}
    });
    ResearchWebSocket.__pushResearchWrapped = true;
    window.WebSocket = ResearchWebSocket;
  }

  function respond(requestId, ok, result, error) {
    post({
      type: RESPONSE_TYPE,
      requestId: requestId,
      ok: ok,
      result: ok ? summarize(result, 0, []) : undefined,
      error: ok ? undefined : String(error && error.message ? error.message : error),
    });
  }

  async function handleRequest(message) {
    var command = message.command;
    if (BLOCKED_COMMANDS[command]) {
      record("safety:blocked-command", {
        command: command,
        reason: BLOCKED_COMMANDS[command],
        mode: MODE,
      });
      throw new Error("被动捕获模式已阻止：" + BLOCKED_COMMANDS[command]);
    }
    if (command === "runtime:ping") {
      return {
        bridgeVersion: BRIDGE_VERSION,
        mode: MODE,
        account: state.account,
        capture: {
          events: state.events.length,
          decodedFrames: state.decodedFrameCount,
          frameDecodeErrors: state.frameDecodeErrorCount,
          protocolMessages: state.protocolMessageCount,
        },
      };
    }
    if (command === "runtime:state") {
      var snapshot = runtimeStateSnapshot();
      record("runtime:state", snapshot);
      return snapshot;
    }
    if (command === "runtime:capabilities") {
      var capabilities = runtimeCapabilitiesSnapshot();
      record("runtime:capabilities", capabilities);
      return capabilities;
    }
    if (command === "headless:generate") return generateHeadlessBattle(message.payload || {});
    if (command === "headless:submit-bypass") return doSubmitBypass(message.payload || {});
    if (command === "headless:diagnose") {
      var diagnose = diagnoseBattleManager();
      record("headless:diagnose", diagnose);
      return diagnose;
    }
    if (command === "runtime:capture") {
      state.captureRawFrames = Boolean(message.payload && message.payload.enabled);
      record("runtime:capture", { enabled: state.captureRawFrames });
      return { enabled: state.captureRawFrames };
    }
    if (command === "runtime:hash-capture") {
      state.hashCaptureEnabled = Boolean(message.payload && message.payload.enabled);
      if (state.hashCaptureEnabled) installHashHooks();
      record("hash:capture", {
        enabled: state.hashCaptureEnabled,
        hooked: state.hashHooked,
        hooks: state.hashHooks.slice(-100),
      });
      return {
        enabled: state.hashCaptureEnabled,
        hooked: state.hashHooked,
        hooks: state.hashHooks.slice(-100),
      };
    }
    if (command === "runtime:probe") return probeModules();
    if (command === "account:load") return loadAccount(message.payload || {});
    if (command === "battle:inspect") {
      var shape = battleShape(state.lastBattleData);
      record("battle:inspect", { shape: shape, battleData: state.lastBattleData });
      return shape;
    }
    if (command === "runtime:events") return { events: state.events };
    if (command === "runtime:reload") {
      location.reload();
      return { reloading: true };
    }
    throw new Error("未知研究命令: " + command);
  }

  window.addEventListener("message", function (event) {
    if (!isParentMessage(event)) return;
    var message = event.data;
    if (!message || message.type !== REQUEST_TYPE || !message.requestId) return;
    Promise.resolve()
      .then(function () { return handleRequest(message); })
      .then(function (result) { respond(message.requestId, true, result); })
      .catch(function (error) {
        record("bridge:command:error", {
          command: message.command,
          error: error.message,
          stack: error.stack,
        });
        respond(message.requestId, false, null, error);
      });
  });

  installConsoleHook();
  installErrorHooks();
  installWebSocketHook();
  loadSh1IfNeeded();
  window.__pushLevelResearchBridge = {
    version: BRIDGE_VERSION,
    mode: MODE,
    state: state,
    probeModules: probeModules,
  };
  record("bridge:ready", {
    bridgeVersion: BRIDGE_VERSION,
    requireType: typeof window.__require,
    location: window.location.href.split("?")[0],
  });

  function scheduleAutoProbe() {
    if (state.autoProbeScheduled || state.autoProbeDone) return;
    state.autoProbeScheduled = true;
    window.setTimeout(function () {
      if (typeof window.__require !== "function") {
        state.autoProbeScheduled = false;
        return;
      }
      try {
        state.autoProbeDone = true;
        probeModules();
      } catch (error) {
        record("module:probe:error", { error: error.message });
      }
    }, 1500);
  }

  // Cocos 会在 boot 完成后才创建 __require，持续短暂观察以便补装模块钩子。
  var requirePollCount = 0;
  var requirePoll = setInterval(function () {
    requirePollCount += 1;
    installRequireHook();
    if (typeof window.__require === "function") scheduleAutoProbe();
    if (
      state.hashCaptureEnabled &&
      (!state.hashHooked ||
        !state.hashHooks.some(function (hook) {
          return hook.indexOf("module:ts-md5.Md5.hashStr") >= 0;
        }))
    ) {
      installHashHooks();
    }
    if (requirePollCount > 120) clearInterval(requirePoll);
  }, 250);
})();
