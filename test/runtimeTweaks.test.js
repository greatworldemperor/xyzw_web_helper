// runtime-tweaks.js 单测：配置归一化 / BattleType 匹配 / 模块级应用 / 战斗加速轮询
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "../public/game/runtime-tweaks.js");

function loadTweaks({ search = "", storage = {}, requireFn = null } = {}) {
  const window = { location: { search } };
  const sandbox = {
    window,
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => {
        storage[k] = v;
      },
    },
    URLSearchParams,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    Date,
    JSON,
    RegExp,
    Object,
    Math,
    Number,
    isFinite,
  };
  if (requireFn) window.__require = requireFn;
  vm.createContext(sandbox);
  return { api: window.__xyzwGameTweaks, window, storage, sandbox };
}

// 同步读文件（顶层 await 不放进 helper，保持 loadTweaks 纯同步）
import { readFileSync } from "node:fs";
function loadTweaksSync({ search = "", storage = {}, requireFn = null } = {}) {
  const code = readFileSync(SCRIPT_PATH, "utf8");
  const window = { location: { search } };
  const sandbox = {
    window,
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => {
        storage[k] = v;
      },
    },
    URLSearchParams,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    Date,
    JSON,
    RegExp,
    Object,
    Math,
    Number,
    isFinite,
  };
  if (requireFn) window.__require = requireFn;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { api: window.__xyzwGameTweaks, window, storage, sandbox };
}

// 模拟 TS enum（含反向映射）
const MOCK_BATTLE_TYPE = (() => {
  const e = {};
  const forward = { nightmare: 5, nightmareStar: 12, level: 1, apex: 9, saltCup26: 21 };
  for (const [k, v] of Object.entries(forward)) {
    e[k] = v;
    e[v] = k; // 反向映射：数字 key -> 名字
  }
  return e;
})();

function makeRequireStub(overrides = {}) {
  const calls = {
    setBool: [],
    setNumber: [],
    setMusicVolume: [],
    setEffectVolume: [],
    stopAfk: 0,
    battleSpeed: [],
  };
  const missing = overrides.__missing__ || {};
  const modules = {
    LocalStorage: {
      instance: {
        setBool: (k, v) => calls.setBool.push([k, v]),
        setNumber: (k, v) => calls.setNumber.push([k, v]),
        getBool: () => true,
        getNumber: () => 1,
      },
    },
    SoundManager: {
      instance: {
        setMusicVolume: (v) => calls.setMusicVolume.push(v),
        setEffectVolume: (v) => calls.setEffectVolume.push(v),
      },
    },
    "data-index": {
      BattleType: overrides.battleType || MOCK_BATTLE_TYPE,
      ModuleType: { AFK: 77 },
    },
    "manager-factory": {
      GET_BATTLES_BY_TYPE: (t) => (overrides.battles ? overrides.battles(t) : []),
      BATTLE_SPEED_BY_TYPE: (t, s) => calls.battleSpeed.push([t, s]),
    },
    "index-ui": {
      GET_MODULE: () => ({ stopTiming: () => calls.stopAfk++ }),
    },
    AFKModule: {},
  };
  const requireFn = (name) => {
    if (missing[name]) throw new Error("module not found: " + name);
    return modules[name] || null;
  };
  return { calls, requireFn };
}

test("normalizeConfig: 默认值完整（speed=100）且夹在 1~100", () => {
  const { api } = loadTweaksSync();
  const cfg = api.read();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.muteMusic, true);
  assert.equal(cfg.muteSound, true);
  assert.equal(cfg.disablePowerSave, true);
  assert.deepEqual(cfg.battleSpeed, { enabled: true, speed: 100, pattern: "^nightmare$" });

  const over = api._internal.normalizeConfig({ battleSpeed: { speed: 500, pattern: "(abc" } });
  assert.equal(over.battleSpeed.speed, 100);
  assert.equal(over.battleSpeed.pattern, "^nightmare$"); // 非法正则回退默认
  const low = api._internal.normalizeConfig({ battleSpeed: { speed: 0 } });
  assert.equal(low.battleSpeed.speed, 1);
  const keep = api._internal.normalizeConfig({ battleSpeed: { speed: 99 } });
  assert.equal(keep.battleSpeed.speed, 99);
});

test("resolveBattleTargets: 精确匹配 nightmare 且排除反向映射与 nightmareStar", () => {
  const toJson = (x) => JSON.parse(JSON.stringify(x));
  const targets = loadTweaksSync().api._internal.resolveBattleTargets(
    { BattleType: MOCK_BATTLE_TYPE },
    "^nightmare$",
  );
  assert.deepEqual(toJson(targets), [{ key: "nightmare", value: 5 }]);

  const star = loadTweaksSync().api._internal.resolveBattleTargets(
    { BattleType: MOCK_BATTLE_TYPE },
    "nightmare",
  );
  assert.deepEqual(toJson(star), [
    { key: "nightmare", value: 5 },
    { key: "nightmareStar", value: 12 },
  ]);
});

test("tweaks=off / enabled=false 时不安装引擎 hook", () => {
  const off = loadTweaksSync({ search: "?tweaks=off" });
  assert.equal(off.api.read().enabled, false);
  assert.equal(off.api.status.engineHook, null);

  const disabled = loadTweaksSync({
    storage: { xyzwGameTweaks: JSON.stringify({ enabled: false }) },
  });
  assert.equal(disabled.api.status.engineHook, null);
});

test("applyModuleLevel: 写音乐/音效/AFK_GAP 存储并立即静音 + 停屏保定时器", () => {
  const stub = makeRequireStub();
  const { api } = loadTweaksSync({ requireFn: stub.requireFn });
  assert.equal(api.applyNow(), true);
  assert.ok(api.status.moduleApplied);
  assert.deepEqual(stub.calls.setBool, [
    ["MUSIC_OPEN", false],
    ["SOUND_OPEN", false],
  ]);
  assert.deepEqual(stub.calls.setNumber, [["AFK_GAP", 3]]);
  assert.deepEqual(stub.calls.setMusicVolume, [0]);
  assert.deepEqual(stub.calls.setEffectVolume, [0]);
  assert.equal(stub.calls.stopAfk, 1);
  assert.equal(api.status.afkTimerStopped, true);
  // 幂等：第二次调用不再执行
  assert.equal(api.applyNow(), true);
  assert.deepEqual(stub.calls.setNumber, [["AFK_GAP", 3]]);
});

test("battleSpeed 轮询: 仅在 timeScale 偏离目标时设置速度（默认 100）", () => {
  let battles = [{ timeScale: 1 }];
  const stub = makeRequireStub({
    battles: (t) => (t === 5 ? battles : []),
  });
  const intervals = [];

  const code = readFileSync(SCRIPT_PATH, "utf8");
  const window = { location: { search: "" } };
  const sandbox = {
    window,
    console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    URLSearchParams,
    setInterval: (cb) => {
      intervals.push(cb);
      return intervals.length;
    },
    clearInterval: () => {},
    setTimeout: () => 0,
    Date,
    JSON,
    RegExp,
    Object,
    Math,
    Number,
    isFinite,
  };
  window.__require = stub.requireFn;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  // applyNow 成功后 startBattleSpeedPoller 已注册（最后注册的 interval 是战斗轮询）
  window.__xyzwGameTweaks.applyNow();
  assert.equal(window.__xyzwGameTweaks.status.battleSpeedActive, true);
  const battlePoll = intervals[intervals.length - 1];

  battlePoll(); // 第一轮：timeScale=1 ≠ 100 → 设置
  assert.deepEqual(stub.calls.battleSpeed, [[5, 100]]);
  battles[0].timeScale = 100; // 模拟游戏已应用
  battlePoll(); // 第二轮：已达标 → 不再设置
  assert.equal(stub.calls.battleSpeed.length, 1);
  assert.equal(window.__xyzwGameTweaks.status.battleSpeedSets, 1);
});

test("battleSpeed pattern 无匹配时不启动轮询", () => {
  const stub = makeRequireStub();
  const { api } = loadTweaksSync({
    requireFn: stub.requireFn,
    storage: {
      xyzwGameTweaks: JSON.stringify({
        battleSpeed: { enabled: true, speed: 2, pattern: "不存在的类型" },
      }),
    },
  });
  api.applyNow();
  assert.equal(api.status.battleSpeedActive, false);
});

test("单开 index.html 与多开 multi-game.html 均已接线 runtime-tweaks", async () => {
  const indexHtml = await readFile(
    new URL("../public/game/index.html", import.meta.url),
    "utf8",
  );
  const multiGameHtml = await readFile(
    new URL("../public/game/multi-game.html", import.meta.url),
    "utf8",
  );
  assert.match(indexHtml, /<script src="runtime-tweaks\.js\?v=[^"]+"/);
  // 必须排在 cocos 引擎之后
  assert.ok(indexHtml.indexOf("cocos2d-js-min.a5841.js") < indexHtml.indexOf("runtime-tweaks.js"));
  assert.ok(multiGameHtml.includes('"runtime-tweaks.js?v='));
  const cocosIdx = multiGameHtml.indexOf("cocos2d-js-min.a5841.js");
  const tweaksIdx = multiGameHtml.indexOf("runtime-tweaks.js");
  assert.ok(cocosIdx !== -1 && tweaksIdx !== -1 && cocosIdx < tweaksIdx);
});
