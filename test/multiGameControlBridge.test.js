import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../public/game/multi-game-control-bridge.js", import.meta.url),
  "utf8",
);

function createBridge(automation = null) {
  const messages = [];
  const listeners = new Map();
  const parent = {
    postMessage(payload, origin) {
      messages.push({ payload, origin });
    },
  };
  const window = {
    __MULTI_GAME_BRIDGE_READY__: {
      scope: "mg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    __SALT_FIELD_AUTO__: automation,
    location: { origin: "https://helper.example" },
    parent,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  window.window = window;
  vm.runInNewContext(source, { window });
  return {
    messages,
    parent,
    send(payload, overrides = {}) {
      return listeners.get("message")({
        origin: overrides.origin || window.location.origin,
        source: overrides.source || parent,
        data: payload,
      });
    },
  };
}

function automationState() {
  return { running: false };
}

test("control bridge accepts allowlisted commands from the parent", async () => {
  const state = automationState();
  const automation = {
    start() {
      state.running = true;
    },
    stop() {
      state.running = false;
    },
    getStats() {
      return { ...state };
    },
  };
  const bridge = createBridge(automation);

  await bridge.send({
    channel: "multi-game-control",
    version: 1,
    type: "command",
    requestId: "request-1",
    action: "start",
  });

  assert.deepEqual(JSON.parse(JSON.stringify(bridge.messages)), [
    {
      origin: "https://helper.example",
      payload: {
        channel: "multi-game",
        version: 1,
        type: "control-result",
        scope: "mg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        requestId: "request-1",
        ok: true,
        result: { running: true },
      },
    },
  ]);

  await bridge.send({
    channel: "multi-game-control",
    version: 1,
    type: "command",
    requestId: "request-2",
    action: "stop",
  });
  assert.equal(bridge.messages.at(-1).payload.result.running, false);
});

test("control bridge rejects unsupported or untrusted messages", async () => {
  const bridge = createBridge({ getStats: () => ({ running: false }) });
  const command = {
    channel: "multi-game-control",
    version: 1,
    type: "command",
    requestId: "request-1",
    action: "eval",
  };

  await bridge.send(command);
  assert.equal(bridge.messages.at(-1).payload.error, "unsupported-action");

  const messageCount = bridge.messages.length;
  await bridge.send(command, { origin: "https://attacker.example" });
  await bridge.send(command, { source: {} });
  assert.equal(bridge.messages.length, messageCount);
});

test("control bridge reports unavailable automation instead of throwing", async () => {
  const bridge = createBridge();
  await bridge.send({
    channel: "multi-game-control",
    version: 1,
    type: "command",
    requestId: "request-1",
    action: "getStats",
  });

  assert.equal(bridge.messages[0].payload.ok, false);
  assert.equal(bridge.messages[0].payload.error, "automation-unavailable");
});
