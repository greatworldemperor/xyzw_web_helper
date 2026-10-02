// runtime-tweaks.js 单测（v2）：配置归一化 / mode 过滤 / 模块级应用 / battle 创建 hook
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "../public/game/runtime-tweaks.js");
const SCRIPT_CODE = readFileSync(SCRIPT_PATH, "utf8");

function makeSandbox({ search = "", storage = {}, requireFn = null } = {}) {
  const window = { location: { search } };
  const intervals = [];
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
  if (requireFn) window.__require = requireFn;
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT_CODE, sandbox);
  return {
    api: window.__xyzwGameTweaks,
    window,
    storage,
    intervals,
    runIntervals: () => {
      const fns = [...intervals];
      fns.forEach((f) => f());
    },
  };
}

function makeRequireStub(overrides = {}) {
  const calls = {
    setBool: [],
    setNumber: [],
    setMusicVolume: [],
    setEffectVolume: [],
    afkPatched: 0,
    battleCreations: [],
  };
  const missing = overrides.__missing__ || {};

  // AFKModule 原型可 patch
  function AFKModuleClass() {}
  AFKModuleClass.prototype.startTiming = function (e) {
    calls.afkStartTimingArgs = [...arguments];
  };
  AFKModuleClass.prototype._onTiming = function () {};

  // battle launcher 类（v3：hook 类原型，不触碰 BattleManager.instance）
  function makeLauncherClass() {
    function LauncherClass() {}
    LauncherClass.prototype.createBattle = function (opts) {
      calls.battleCreations.push({ opts: { ...opts } });
      return { timeScale: opts?.timeScale, battleData: opts?.battleData };
    };
    LauncherClass.prototype.createBattleById = function (opts) {
      calls.battleCreations.push({ opts: { ...opts } });
      return { timeScale: opts?.timeScale, battleData: opts?.battleData };
    };
    return LauncherClass;
  }
  const ClientBattleLauncher = makeLauncherClass();
  const ServerBattleLauncher = makeLauncherClass();

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
    AFKModule: AFKModuleClass,
    "launcher-client": { ClientBattleLauncher },
    "launcher-server": { ServerBattleLauncher },
  };
  const requireFn = (name) => {
    if (missing[name]) throw new Error("module not found: " + name);
    return modules[name] || null;
  };
  return { calls, requireFn, AFKModuleClass, ClientBattleLauncher, ServerBattleLauncher };
}

test("normalizeConfig: 默认值完整（speed=100, excludeModes=[]）且夹在 1~100", () => {
  const { api } = makeSandbox();
  const cfg = api.read();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.muteMusic, true);
  assert.equal(cfg.muteSound, true);
  assert.equal(cfg.disablePowerSave, true);
  assert.deepEqual(cfg.battleSpeed, { enabled: true, speed: 100, excludeModes: [] });

  const over = api._internal.normalizeConfig({ battleSpeed: { speed: 500 } });
  assert.equal(over.battleSpeed.speed, 100);
  const low = api._internal.normalizeConfig({ battleSpeed: { speed: 0 } });
  assert.equal(low.battleSpeed.speed, 1);
  const keep = api._internal.normalizeConfig({ battleSpeed: { speed: 99 } });
  assert.equal(keep.battleSpeed.speed, 99);
});

test("shouldSpeedMode: excludeModes 数字精确排除", () => {
  const { api } = makeSandbox();
  const f = api._internal.shouldSpeedMode;
  assert.equal(f(5, []), true);
  assert.equal(f(null, [1]), true); // 未知 mode 默认加速
  assert.equal(f(5, [5]), false);
  assert.equal(f("5", [5]), false); // 字符串数字等值匹配 → 排除生效
  assert.equal(f(7, [5]), true);
});

test("tweaks=off / enabled=false 时不安装引擎 hook", () => {
  const off = makeSandbox({ search: "?tweaks=off" });
  assert.equal(off.api.read().enabled, false);
  assert.equal(off.api.status.engineHook, null);

  const disabled = makeSandbox({
    storage: { xyzwGameTweaks: JSON.stringify({ enabled: false }) },
  });
  assert.equal(disabled.api.status.engineHook, null);
});

test("applyModuleLevel: 静音存储 + AFK_GAP=3 + AFKModule 原型 patch", () => {
  const stub = makeRequireStub({ factoryReady: true });
  const { api } = makeSandbox({ requireFn: stub.requireFn });
  assert.equal(api.applyNow(), true);
  assert.ok(api.status.moduleApplied);
  assert.deepEqual(stub.calls.setBool, [
    ["MUSIC_OPEN", false],
    ["SOUND_OPEN", false],
  ]);
  assert.deepEqual(stub.calls.setNumber, [["AFK_GAP", 3]]);
  assert.deepEqual(stub.calls.setMusicVolume, [0]);
  assert.deepEqual(stub.calls.setEffectVolume, [0]);
  assert.equal(api.status.afkTimerStopped, true);
  // AFKModule 原型 startTiming/_onTiming 已被置空
  assert.equal(stub.AFKModuleClass.prototype.startTiming(), undefined);
  assert.equal(stub.AFKModuleClass.prototype.__xyzwTweaksDisabled, true);
});

test("battleSpeed v3: hook 类原型改写 opts.timeScale，不触碰 BattleManager.instance", () => {
  const stub = makeRequireStub();
  const { api, runIntervals } = makeSandbox({ requireFn: stub.requireFn });

  api.applyNow();
  runIntervals();
  assert.equal(api.status.battleSpeedActive, true);

  // 实例方法调用走类原型 hook（十殿实测 mode=13）
  const inst = new stub.ClientBattleLauncher();
  inst.createBattle({ timeScale: 1, battleData: { mode: 13, id: 77 } });
  assert.equal(stub.calls.battleCreations[0].opts.timeScale, 100);
  assert.equal(api.status.battleSpeedSets, 1);
});

test("battleSpeed v3: excludeModes 精确排除 + 幂等不二次包装", () => {
  const stub2 = makeRequireStub();
  const w2 = makeSandbox({
    requireFn: stub2.requireFn,
    storage: {
      xyzwGameTweaks: JSON.stringify({
        battleSpeed: { enabled: true, speed: 50, excludeModes: [13] },
      }),
    },
  });
  w2.api.applyNow();
  w2.runIntervals();
  w2.runIntervals(); // 多轮轮询
  w2.api.applyNow(); // 幂等
  assert.equal(w2.api.status.battleSpeedActive, true);

  new stub2.ClientBattleLauncher().createBattle({ timeScale: 1, battleData: { mode: 13, id: 1 } });
  new stub2.ClientBattleLauncher().createBattle({ timeScale: 1, battleData: { mode: 9, id: 2 } });
  assert.equal(stub2.calls.battleCreations[0].opts.timeScale, 1); // 排除
  assert.equal(stub2.calls.battleCreations[1].opts.timeScale, 50); // 加速
  // 只包装一层（多轮轮询 + 重复 apply 后仍只改写一次）
  assert.equal(stub2.calls.battleCreations.length, 2);
  assert.equal(w2.api.status.battleSpeedSets, 1);
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
  assert.ok(indexHtml.indexOf("cocos2d-js-min.a5841.js") < indexHtml.indexOf("runtime-tweaks.js"));
  assert.ok(multiGameHtml.includes('"runtime-tweaks.js?v='));
  const cocosIdx = multiGameHtml.indexOf("cocos2d-js-min.a5841.js");
  const tweaksIdx = multiGameHtml.indexOf("runtime-tweaks.js");
  assert.ok(cocosIdx !== -1 && tweaksIdx !== -1 && cocosIdx < tweaksIdx);
});
