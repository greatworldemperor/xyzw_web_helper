import assert from "node:assert/strict";
import { test } from "node:test";

import {
  calculateJitteredDelay,
  PushLevelScheduler,
} from "../src/utils/pushLevel/scheduler.js";

const startResponse = {
  battleData: {
    id: 1,
    randomSeed: 6313,
    version: 240514,
    options: { levelId: 1812 },
  },
};

const makeBuilder = () => async (response, context) => ({
  levelId: context.levelId,
  outputCode: "abcdef0123456789abcdef0123456789",
  payload: {
    levelId: context.levelId,
    battleTime: 447,
    tapTimes: [[]],
    autoTapTimes: [[]],
    outputCode: "abcdef0123456789abcdef0123456789",
    log: "",
  },
  response,
});
test("calculateJitteredDelay clamps the configured interval", () => {
  const settings = {
    baseIntervalMs: 100,
    jitterMs: 30,
    minIntervalMs: 50,
    maxIntervalMs: 120,
  };

  assert.equal(calculateJitteredDelay(settings, () => 0), 70);
  assert.equal(calculateJitteredDelay(settings, () => 1), 120);
});

test("scheduler defaults to a non-sending dry-run", async () => {
  let startCalls = 0;
  const events = [];
  const scheduler = new PushLevelScheduler({
    tokenId: "token-a",
    startLevel: async () => {
      startCalls += 1;
      return startResponse;
    },
    buildResult: makeBuilder(),
    settings: { minIntervalMs: 0, maxIntervalMs: 0 },
    onEvent: (event) => events.push(event),
  });

  const result = await scheduler.runOnce({ wait: false });

  assert.equal(startCalls, 1);
  assert.equal(result.dryRun, true);
  assert.equal(result.submitted, false);
  assert.equal(scheduler.state, "ready");
  assert.equal(events.some((event) => event.type === "preview"), true);
});

test("scheduler submits once and requires explicit confirmation", async () => {
  const calls = [];
  const scheduler = new PushLevelScheduler({
    tokenId: "token-a",
    startLevel: async () => startResponse,
    buildResult: makeBuilder(),
    submit: async (payload) => {
      calls.push(["submit", payload.levelId]);
      return { code: 0 };
    },
    confirm: async (response, preview) => {
      calls.push(["confirm", response.code, preview.levelId]);
      return { confirmed: true };
    },
  });

  const result = await scheduler.runOnce({ wait: false });

  assert.deepEqual(calls, [
    ["submit", 1812],
    ["confirm", 0, 1812],
  ]);
  assert.equal(result.submitted, true);
  assert.equal(scheduler.state, "ready");
});
test("settlement failures are not retried", async () => {
  let submitCalls = 0;
  const scheduler = new PushLevelScheduler({
    startLevel: async () => startResponse,
    buildResult: makeBuilder(),
    submit: async () => {
      submitCalls += 1;
      throw new Error("settlement failed");
    },
    confirm: async () => true,
    settings: { maxRetries: 99 },
  });

  await assert.rejects(() => scheduler.runOnce({ wait: false }), /settlement failed/);
  assert.equal(submitCalls, 1);
  assert.equal(scheduler.state, "error");
});

test("stop cancels an in-flight interval wait", async () => {
  const scheduler = new PushLevelScheduler({
    startLevel: async () => startResponse,
    buildResult: makeBuilder(),
    settings: {
      baseIntervalMs: 60000,
      jitterMs: 0,
      minIntervalMs: 60000,
      maxIntervalMs: 60000,
    },
  });

  const running = scheduler.start();
  scheduler.stop();
  const result = await running;

  assert.equal(result, null);
  assert.equal(scheduler.state, "stopped");
});

test("stop does not hide an in-flight settlement request", async () => {
  let resolveSubmit;
  const submitStarted = new Promise((resolve) => {
    resolveSubmit = resolve;
  });
  const scheduler = new PushLevelScheduler({
    startLevel: async () => startResponse,
    buildResult: makeBuilder(),
    submit: async () => {
      scheduler.submitStarted = true;
      await submitStarted;
      return { levelId: 1813 };
    },
    confirm: async () => true,
  });

  const running = scheduler.runOnce({ wait: false });
  while (!scheduler.inFlightSubmit) await new Promise((resolve) => setImmediate(resolve));
  scheduler.stop();
  assert.equal(scheduler.inFlightSubmit, true);
  resolveSubmit();
  const result = await running;

  assert.equal(result.stopped, true);
  assert.equal(scheduler.inFlightSubmit, false);
  assert.equal(scheduler.state, "stopped");
});

test("resume starts a new cycle after a paused in-flight request settles", async () => {
  let resolveSubmit;
  let submitCalls = 0;
  const submitStarted = new Promise((resolve) => {
    resolveSubmit = resolve;
  });
  const scheduler = new PushLevelScheduler({
    startLevel: async () => startResponse,
    buildResult: makeBuilder(),
    submit: async () => {
      submitCalls += 1;
      if (submitCalls === 1) await submitStarted;
      return { levelId: 1813 };
    },
    confirm: async () => true,
    settings: { autoContinue: false },
  });

  const firstRun = scheduler.start({ immediate: true });
  while (!scheduler.inFlightSubmit) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  scheduler.pause();
  const resumedRun = scheduler.resume();

  assert.notEqual(resumedRun, firstRun);
  assert.equal(scheduler.paused, true);
  resolveSubmit();
  const result = await resumedRun;

  assert.equal(submitCalls, 2);
  assert.equal(result.submitted, true);
  assert.equal(scheduler.state, "ready");
});

