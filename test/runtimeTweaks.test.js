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

  // BattleManager：_battleFactory 挂在单例上（第二次轮询才就绪可选）
  const factory = {
    createBattle(opts) {
      calls.battleCreations.push({ opts: { ...opts } });
      return { timeScale: opts?.timeScale, battleData: opts?.battleData };
    },
    createBattleById(opts) {
      calls.battleCreations.push({ opts: { ...opts } });
      return { timeScale: opts?.timeScale, battleData: opts?.battleData };
    },
  };
  const managerInstance = { _battleFactory: overrides.factoryReady ? factory : null };

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
    "manager-factory": { BattleManager: { instance: managerInstance } },
    "manager-battle": {},
  };
  const requireFn = (name) => {
    if (missing[name]) throw new Error("module not found: " + name);
    return modules[name] || null;
  };
  return { calls, requireFn, AFKModuleClass, factory };
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

test("battleSpeed v2: hook createBattle 改写 opts.timeScale（factory 就绪后）", () => {
  const stub = makeRequireStub({ factoryReady: false });
  const { api, runIntervals } = makeSandbox({ requireFn: stub.requireFn });

  api.applyNow();
  assert.equal(api.status.battleSpeedActive, false); // factory 未就绪

  // 轮询若干轮后 factory 就绪（模拟 BattleManager.init）
  stub.requireFn("manager-factory").BattleManager.instance._battleFactory = stub.factory;
  runIntervals();
  assert.equal(api.status.battleSpeedActive, true);

  // 创建战斗：opts.timeScale 被改写为 100，且返回对象兜底改写
  stub.factory.createBattle({ timeScale: 1, battleData: { mode: 5, id: 77 } });
  assert.equal(stub.calls.battleCreations[0].opts.timeScale, 100);
  assert.equal(api.status.battleSpeedSets, 1);

  // excludeModes 生效：mode=5 被排除时保持原速
  api.write({ battleSpeed: { enabled: true, speed: 50, excludeModes: [5] } });
  const { api: api2 } = (() => {
    // write 只改本地 cfg；重载一个新沙盒验证 excludeModes 行为
    const s2 = makeRequireStub({ factoryReady: true });
    const w2 = makeSandbox({
      requireFn: s2.requireFn,
      storage: {
        xyzwGameTweaks: JSON.stringify({
          battleSpeed: { enabled: true, speed: 50, excludeModes: [5] },
        }),
      },
    });
    w2.api.applyNow();
    w2.runIntervals();
    assert.equal(w2.api.status.battleSpeedActive, true);
    s2.factory.createBattle({ timeScale: 1, battleData: { mode: 5, id: 1 } });
    s2.factory.createBattle({ timeScale: 1, battleData: { mode: 9, id: 2 } });
    assert.equal(s2.calls.battleCreations[0].opts.timeScale, 1); // 排除
    assert.equal(s2.calls.battleCreations[1].opts.timeScale, 50); // 加速
    return { api: w2.api };
  })();
  assert.ok(api2.status.battleSpeedActive);
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
