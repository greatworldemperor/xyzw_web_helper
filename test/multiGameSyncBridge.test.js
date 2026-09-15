import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// 真实执行 iframe 内的同步桥接脚本（vm + 假 canvas），验证父子页面的报文契约。
// 背景：曾经把 multi-game 通道的 version 从 1 改成 2，而宿主页面按 1 校验 user-event，
// 导致同步静默失效 —— 所以这里把「谁上报、谁回放、报文版本」都钉住。
const bridgeSource = await readFile(
  new URL("../public/game/multi-game-sync-bridge.js", import.meta.url),
  "utf8",
);
const ORIGIN = "https://helper.example";
const SCOPE = "mg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// 转发过来的事件来自别的窗口，scope 不等于本窗口才能被回放
const SOURCE_SCOPE = "mg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SYNC_CHANNEL = "multi-game-sync";

function createHarness() {
  const posted = [];
  const canvasListeners = new Map();
  const dispatched = [];
  const windowListeners = new Map();
  const clock = { now: 1000 };

  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 400 }),
    contains: () => true,
    addEventListener(type, handler) {
      canvasListeners.set(type, handler);
    },
    removeEventListener(type) {
      canvasListeners.delete(type);
    },
    dispatchEvent(event) {
      dispatched.push(event);
      return true;
    },
  };

  const parent = {
    postMessage(payload, origin) {
      posted.push({ payload, origin });
    },
  };

  const window = {
    __MULTI_GAME_BRIDGE_READY__: { scope: SCOPE },
    document: { getElementById: (id) => (id === "GameCanvas" ? canvas : null) },
    location: { origin: ORIGIN },
    parent,
    performance: { now: () => clock.now },
    requestAnimationFrame: (fn) => {
      fn();
      return 1;
    },
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener(type, handler) {
      windowListeners.set(type, handler);
    },
    Element: { prototype: { scrollIntoView() {} } },
    HTMLElement: { prototype: { focus() {} } },
    MouseEvent: class MouseEvent {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    WheelEvent: class WheelEvent {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    TouchEvent: class TouchEvent {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
  };
  window.window = window;

  // 浏览器里 window.MouseEvent === MouseEvent（同一全局），vm 里要两边都给
  vm.runInNewContext(bridgeSource, {
    window,
    performance: window.performance,
    MouseEvent: window.MouseEvent,
    WheelEvent: window.WheelEvent,
    TouchEvent: window.TouchEvent,
    Touch: window.MouseEvent,
  });

  const bridge = window.__MULTI_GAME_SYNC_BRIDGE__;

  return {
    bridge,
    dispatched,
    posted,
    /** 模拟宿主页面下发同步角色 */
    applyConfig(payload) {
      windowListeners.get("message")({
        origin: ORIGIN,
        source: parent,
        data: { channel: SYNC_CHANNEL, type: "config", ...payload },
      });
    },
    /** 模拟宿主页面转发事件到本窗口 */
    forwardEvent(event) {
      windowListeners.get("message")({
        origin: ORIGIN,
        source: parent,
        data: {
          channel: SYNC_CHANNEL,
          version: 2,
          type: "forward-event",
          scope: SOURCE_SCOPE,
          event,
        },
      });
    },
    /** 模拟游戏 canvas 上的一次本地输入（从窗口没有监听器，属于预期行为） */
    fireLocalEvent(type = "mousedown") {
      clock.now += 100;
      const listener = canvasListeners.get(type);
      if (!listener) return false;
      listener({
        type,
        timeStamp: 1,
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: 50,
        clientY: 100,
        target: canvas,
      });
      return true;
    },
    hasLocalListeners: () => canvasListeners.size > 0,
    lastPosted: () => posted[posted.length - 1] || null,
  };
}

const MOUSE_EVENT = {
  type: "mousedown",
  timeStamp: 1,
  bubbles: true,
  cancelable: true,
  button: 0,
  buttons: 1,
  nx: 0.25,
  ny: 0.25,
};

test("同步源上报本地事件：走 multi-game 通道的 version 1", () => {
  const harness = createHarness();
  harness.applyConfig({ version: 2, send: true, receive: false, enabled: true });
  assert.equal(harness.hasLocalListeners(), true);
  harness.fireLocalEvent();

  assert.equal(harness.posted.length, 1);
  const { payload, origin } = harness.lastPosted();
  assert.equal(origin, ORIGIN);
  assert.equal(payload.channel, "multi-game");
  // 宿主页面按 version 1 校验 user-event —— 这里钉住，别再跟着同步通道一起升级
  assert.equal(payload.version, 1);
  assert.equal(payload.type, "user-event");
  assert.equal(payload.scope, SCOPE);
  assert.equal(payload.event.type, "mousedown");
  assert.equal(payload.event.pointerType, "mouse");
  assert.equal(payload.event.nx, 0.25);
  assert.equal(payload.event.ny, 0.25);
  assert.equal(payload.event.buttons, 1);
});

test("同步从只回放、不上报本地事件", () => {
  const harness = createHarness();
  harness.applyConfig({ version: 2, send: false, receive: true, enabled: true });

  assert.equal(harness.hasLocalListeners(), false, "从窗口不该挂本地监听");
  harness.fireLocalEvent();
  assert.equal(harness.posted.length, 0, "从窗口不应该上报自己的输入");

  harness.forwardEvent(MOUSE_EVENT);
  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.dispatched[0].type, "mousedown");
  // 归一化坐标应还原到 canvas 尺寸（0.25 * 200 / 0.25 * 400）
  assert.equal(harness.dispatched[0].clientX, 50);
  assert.equal(harness.dispatched[0].clientY, 100);
});

test("不同步：既不上报也不回放", () => {
  const harness = createHarness();
  harness.applyConfig({ version: 2, send: false, receive: false, enabled: false });

  assert.equal(harness.hasLocalListeners(), false);
  harness.fireLocalEvent();
  harness.forwardEvent(MOUSE_EVENT);
  assert.equal(harness.posted.length, 0);
  assert.equal(harness.dispatched.length, 0);
});

test("切回同步源后重新挂载监听器（角色可来回切换）", () => {
  const harness = createHarness();
  harness.applyConfig({ version: 2, send: false, receive: true });
  harness.fireLocalEvent();
  assert.equal(harness.posted.length, 0);
  assert.equal(harness.hasLocalListeners(), false);

  harness.applyConfig({ version: 2, send: true, receive: false });
  assert.equal(harness.hasLocalListeners(), true, "切回同步源必须重新挂监听");
  harness.fireLocalEvent();
  assert.equal(harness.posted.length, 1);

  harness.applyConfig({ version: 2, send: false, receive: true });
  assert.equal(harness.hasLocalListeners(), false);
  harness.fireLocalEvent();
  assert.equal(harness.posted.length, 1, "切回从窗口后不该再上报");
});

test("兼容旧宿主页面：只下发 enabled 视为双向", () => {
  const harness = createHarness();
  harness.applyConfig({ version: 1, enabled: true });

  harness.fireLocalEvent();
  assert.equal(harness.posted.length, 1);
  assert.equal(harness.posted[0].payload.version, 1);
  harness.forwardEvent(MOUSE_EVENT);
  assert.equal(harness.dispatched.length, 1);
});

test("暴露的桥接版本：事件通道 1、同步通道 2", () => {
  const harness = createHarness();
  assert.equal(harness.bridge.version, 2);
  assert.equal(harness.bridge.eventVersion, 1);
  assert.equal(harness.bridge.sync.isSending(), false);
  assert.equal(harness.bridge.sync.isReceiving(), false);

  harness.applyConfig({ version: 2, send: true, receive: true });
  assert.equal(harness.bridge.sync.isSending(), true);
  assert.equal(harness.bridge.sync.isReceiving(), true);
});
