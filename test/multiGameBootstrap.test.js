import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const multiGameHtml = await readFile(
  new URL("../public/game/multi-game.html", import.meta.url),
  "utf8",
).catch(() => "");
const bootstrapScript = [
  ...multiGameHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
]
  .map((match) => match[1])
  .find((script) => script.includes("loadMultiGameRuntime"));
// 与 public/game/index.html 保持一致的运行时清单：
// sh1.js 由 push-level-research-bridge.js 在 DOM 解析完成后动态注入。
const expectedRuntimeFiles = [
  "patch.decrypted_readable.js",
  "src/settings.da7ef.js",
  "game-defines.a175e.js",
  "platform-spoof.js?v=20260916.2",
  "main.2a00e.js",
  "cocos2d-js-min.a5841.js",
  "xh.js",
  "diagnose_require.js",
  "push-level-research-bridge.js?v=20260907.13",
];
const expectedAutomationFiles = [
  "salt-field-auto.js?v=20260911.1",
  "multi-game-control-bridge.js?v=20260911.1",
  "multi-game-sync-bridge.js?v=20260915.2",
];

function executeBootstrap(boot, { search = "" } = {}) {
  const messages = [];
  const loadedScripts = [];
  const splash = { style: {}, textContent: "" };
  const binToolClasses = new Set();
  const binTool = {
    dataset: {},
    classList: {
      add(...names) {
        names.forEach((name) => binToolClasses.add(name));
      },
      contains(name) {
        return binToolClasses.has(name);
      },
    },
  };
  const minimizeBtn = {
    clickCount: 0,
    click() {
      this.clickCount += 1;
      binToolClasses.add("minimized");
    },
  };
  // 上号器面板由 sh1.js 异步挂载：boot 完成后才可能出现。
  let accountToolMounted = false;
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() {
      this.disconnected = true;
    }
    trigger() {
      if (this.disconnected) return;
      this.callback([]);
    }
  }
  const document = {
    documentElement: { nodeType: 1 },
    head: {
      appendChild(script) {
        loadedScripts.push(script.src);
        queueMicrotask(() => script.onload());
      },
    },
    createElement() {
      return {};
    },
    getElementById(id) {
      if (id === "splash") return splash;
      if (id === "binTool") return accountToolMounted ? binTool : null;
      if (id === "minimizeBtn") return accountToolMounted ? minimizeBtn : null;
      return null;
    },
  };
  const window = {
    __MULTI_GAME_BRIDGE_READY__: {
      scope: "mg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    boot() {
      return boot([...loadedScripts], { binTool });
    },
    document,
    location: { origin: "https://helper.example", search },
    parent: {
      postMessage(payload, origin) {
        messages.push({ payload, origin });
      },
    },
  };
  window.window = window;
  const unrefTimeout = (callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return timer;
  };

  vm.runInNewContext(bootstrapScript, {
    document,
    Error,
    MutationObserver: FakeMutationObserver,
    Promise,
    queueMicrotask,
    setTimeout: unrefTimeout,
    URLSearchParams,
    window,
  });
  return {
    binTool,
    mountAccountTool() {
      accountToolMounted = true;
      observers.forEach((observer) => observer.trigger());
    },
    loadedScripts,
    messages,
    minimizeBtn,
    observers,
    splash,
    window,
  };
}

const flushBootstrap = () => new Promise((resolve) => setImmediate(resolve));

test("multi-game bootstrap gates every game runtime behind the storage bridge", () => {
  assert.match(multiGameHtml, /src="multi-game-storage-bridge\.js"/);
  assert.match(multiGameHtml, /if \(!window\.__MULTI_GAME_BRIDGE_READY__\) return;/);

  const staticScriptSources = [...multiGameHtml.matchAll(/<script\s+src="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(staticScriptSources, ["multi-game-storage-bridge.js"]);

  for (const runtimeFile of expectedRuntimeFiles) {
    assert.ok(multiGameHtml.includes(`"${runtimeFile}"`), runtimeFile);
  }
});

test("multi-game bootstrap waits for boot completion before reporting ready", async () => {
  let resolveBoot;
  let scriptsAtBoot;
  const { loadedScripts, messages } = executeBootstrap((scripts) => {
    scriptsAtBoot = scripts;
    return {
      then(resolve) {
        resolveBoot = resolve;
      },
    };
  });

  await flushBootstrap();
  assert.equal(typeof resolveBoot, "function");
  assert.deepEqual(loadedScripts, expectedRuntimeFiles);
  assert.deepEqual(scriptsAtBoot, expectedRuntimeFiles);
  assert.deepEqual(messages, []);

  resolveBoot();
  await flushBootstrap();
  assert.deepEqual(loadedScripts, [
    ...expectedRuntimeFiles,
    ...expectedAutomationFiles,
  ]);
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0])), {
    payload: {
      channel: "multi-game",
      version: 1,
      type: "ready",
      scope: "mg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    origin: "https://helper.example",
  });
});

test("multi-game bootstrap folds the account tool as soon as sh1 mounts it", async () => {
  let minimizedBeforeMount = false;
  const env = executeBootstrap((_scripts, state) => {
    minimizedBeforeMount = state.binTool.classList.contains("minimized");
    return Promise.resolve();
  });
  const { binTool, minimizeBtn, observers } = env;

  await flushBootstrap();

  // 面板尚未挂载：不应误点，且已开始监听 DOM 变化。
  assert.equal(minimizeBtn.clickCount, 0);
  assert.equal(minimizedBeforeMount, false);
  assert.ok(observers.length >= 1);
  assert.equal(observers[0].options.subtree, true);

  // 面板挂载 → 立刻用面板自带按钮折叠，并打上标记（避免重复折叠 / 供 CSS 显示）。
  env.mountAccountTool();
  assert.equal(minimizeBtn.clickCount, 1);
  assert.equal(binTool.classList.contains("minimized"), true);
  assert.equal(binTool.dataset.mgAutoCollapsed, "1");
  assert.equal(observers[0].disconnected, true);

  // 用户手动展开后再次触发 DOM 变化，不会把面板重新折叠回去。
  binTool.classList.add("expanded");
  env.mountAccountTool();
  assert.equal(minimizeBtn.clickCount, 1);
});

test("multi-game bootstrap folds the account tool when it is already mounted", async () => {
  const env = executeBootstrap(() => Promise.resolve());
  env.mountAccountTool();
  await flushBootstrap();

  assert.equal(env.minimizeBtn.clickCount, 1);
  assert.equal(env.binTool.classList.contains("minimized"), true);
});

test("multi-game bootstrap leaves the account tool alone when bin-tool=show", async () => {
  const env = executeBootstrap(() => Promise.resolve(), {
    search: "?scope=mg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&bin_id=a&bin-tool=show",
  });
  await flushBootstrap();
  env.mountAccountTool();

  assert.equal(env.minimizeBtn.clickCount, 0);
  assert.equal(env.binTool.classList.contains("minimized"), false);
  assert.equal(env.binTool.dataset.mgAutoCollapsed, undefined);
  assert.equal(env.observers.length, 0);
});

test("multi-game bootstrap reports boot rejection as fatal", async () => {
  let rejectBoot;
  const { messages, splash } = executeBootstrap(() => ({
    then(_resolve, reject) {
      rejectBoot = reject;
    },
  }));

  await flushBootstrap();
  assert.equal(typeof rejectBoot, "function");
  rejectBoot(new Error("bundle versions unavailable"));
  await flushBootstrap();

  assert.equal(splash.textContent, "游戏资源加载失败");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.type, "fatal");
  assert.equal(messages[0].payload.code, "runtime-load-failed");
});