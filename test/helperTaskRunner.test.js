import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTenBatchPlan,
  getClaimableBoxPoints,
  getItemQuantity,
  isCarSendUnavailableError,
  isModuleUnavailableError,
  isRateLimitError,
  isSkippableTaskError,
  isWebSocketNotConnectedError,
  runInventoryVerifiedGameCommand,
  runWithRateLimitRetry,
  runWithWebSocketReconnectRetry,
  runBatchedGameCommand,
} from "../src/utils/helperTaskRunner.js";

test("isRateLimitError recognizes server throttling responses", () => {
  assert.equal(isRateLimitError(new Error("服务器错误: 200400 - 操作太快")), true);
  assert.equal(isRateLimitError(new Error("服务器错误: 400312")), true);
  assert.equal(
    isRateLimitError(new Error("服务器错误: 12400000 - 挂机奖励领取过于频繁")),
    true,
  );
  assert.equal(isRateLimitError({ response: { status: 429 } }), true);
  assert.equal(isRateLimitError(new Error("服务器错误: 200160 - 模块未开启")), false);
});

test("400340 is a rate-limit error for every operation", () => {
  const error = new Error("服务器错误: 400340 - 未知错误");

  assert.equal(isCarSendUnavailableError(error), true);
  assert.equal(isRateLimitError(error), true);
  assert.equal(
    isRateLimitError(new Error("400340 - 操作太快，请稍后再试")),
    true,
  );
});

test("runWithRateLimitRetry waits one second for throttling and retries", async () => {
  const events = [];
  let attempts = 0;

  await runWithRateLimitRetry({
    execute: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("服务器错误: 200400 - 操作太快，请稍后再试");
      }
      return "ok";
    },
    sleepFn: async (ms) => events.push(ms),
  });

  assert.equal(attempts, 2);
  assert.deepEqual(events, [1000]);
});

test("runWithRateLimitRetry does not retry non-throttling errors", async () => {
  let attempts = 0;
  let sleeps = 0;

  await assert.rejects(
    runWithRateLimitRetry({
      execute: async () => {
        attempts += 1;
        throw new Error("车辆不存在");
      },
      sleepFn: async () => {
        sleeps += 1;
      },
    }),
    /车辆不存在/,
  );

  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
});

test("runWithRateLimitRetry supports operation-specific retry errors", async () => {
  const events = [];
  let attempts = 0;

  await runWithRateLimitRetry({
    execute: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("请求超时: bottlehelper_start (5000ms)");
      }
      return "ok";
    },
    shouldRetry: (error) => error.message.includes("bottlehelper_start"),
    sleepFn: async (ms) => events.push(ms),
  });

  assert.equal(attempts, 2);
  assert.deepEqual(events, [1000]);
});

test("runWithRateLimitRetry stops after the configured retry limit", async () => {
  let attempts = 0;

  await assert.rejects(
    runWithRateLimitRetry({
      execute: async () => {
        attempts += 1;
        throw new Error("服务器错误: 200400 - 操作太快");
      },
      maxRetries: 2,
      sleepFn: async () => {},
    }),
    /操作太快/,
  );

  assert.equal(attempts, 3);
});


test("runWithWebSocketReconnectRetry reconnects before retrying the command", async () => {
  const events = [];
  let attempts = 0;

  const result = await runWithWebSocketReconnectRetry({
    execute: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("WebSocket未连接 [token-1]");
      }
      return "ok";
    },
    reconnect: async (context) => {
      events.push({ type: "reconnect", ...context });
    },
    onRetry: (context) => {
      events.push({ type: "retry", ...context });
    },
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.equal(isWebSocketNotConnectedError(new Error("WebSocket未连接")), true);
  assert.equal(events[0].type, "retry");
  assert.equal(events[1].type, "reconnect");
  assert.equal(events[1].retryCount, 1);
});
test("isModuleUnavailableError recognizes disabled modules", () => {
  assert.equal(isModuleUnavailableError(new Error("服务器错误: 200160 - 模块未开启")), true);
  assert.equal(isModuleUnavailableError({ response: { data: { code: 200160 } } }), true);
  assert.equal(isModuleUnavailableError(new Error("服务器错误: 200020")), false);
});

test("isSkippableTaskError recognizes task-specific unavailable errors", () => {
  assert.equal(
    isSkippableTaskError(new Error("服务器错误: 200020"), {
      name: "竞技场战斗",
      skipErrorCodes: [200020],
    }),
    true,
  );
  assert.equal(
    isSkippableTaskError(new Error("服务器错误: 200020"), {
      name: "每日BOSS 1/3",
    }),
    false,
  );
});

test("buildTenBatchPlan splits totals into ten-sized batches plus remainder", () => {
  assert.deepEqual(buildTenBatchPlan(10), [10]);
  assert.deepEqual(buildTenBatchPlan(25), [10, 10, 5]);
  assert.deepEqual(buildTenBatchPlan(0), []);
});

test("runBatchedGameCommand sends batches sequentially with delay between batches", async () => {
  const events = [];
  const tokenStore = {
    async sendMessageWithPromise(tokenId, cmd, params, timeout) {
      events.push({ type: "send", tokenId, cmd, params, timeout });
      return { ok: true };
    },
  };

  await runBatchedGameCommand({
    tokenStore,
    tokenId: "token-1",
    cmd: "hero_recruit",
    total: 25,
    timeout: 1234,
    delayMs: 300,
    createParams: (amount) => ({ recruitType: 1, recruitNumber: amount }),
    sleepFn: async (ms) => {
      events.push({ type: "sleep", ms });
    },
    onProgress: (progress) => {
      events.push({ type: "progress", ...progress });
    },
  });

  assert.deepEqual(events, [
    {
      type: "send",
      tokenId: "token-1",
      cmd: "hero_recruit",
      params: { recruitType: 1, recruitNumber: 10 },
      timeout: 1234,
    },
    {
      type: "progress",
      batchIndex: 1,
      batchCount: 3,
      batchAmount: 10,
      completed: 10,
      total: 25,
    },
    { type: "sleep", ms: 300 },
    {
      type: "send",
      tokenId: "token-1",
      cmd: "hero_recruit",
      params: { recruitType: 1, recruitNumber: 10 },
      timeout: 1234,
    },
    {
      type: "progress",
      batchIndex: 2,
      batchCount: 3,
      batchAmount: 10,
      completed: 20,
      total: 25,
    },
    { type: "sleep", ms: 300 },
    {
      type: "send",
      tokenId: "token-1",
      cmd: "hero_recruit",
      params: { recruitType: 1, recruitNumber: 5 },
      timeout: 1234,
    },
    {
      type: "progress",
      batchIndex: 3,
      batchCount: 3,
      batchAmount: 5,
      completed: 25,
      total: 25,
    },
  ]);
});

test("runBatchedGameCommand propagates command failures", async () => {
  const tokenStore = {
    async sendMessageWithPromise() {
      throw new Error("请求超时");
    },
  };

  await assert.rejects(
    runBatchedGameCommand({
      tokenStore,
      tokenId: "token-1",
      cmd: "item_openbox",
      total: 10,
      createParams: (amount) => ({ itemId: 2004, number: amount }),
      sleepFn: async () => {},
    }),
    /请求超时/,
  );
});

test("runBatchedGameCommand retries rate-limited batches after backoff", async () => {
  const events = [];
  let attempts = 0;
  const tokenStore = {
    async sendMessageWithPromise(tokenId, cmd, params) {
      attempts += 1;
      events.push({ type: "send", attempts, tokenId, cmd, params });

      if (attempts === 2) {
        throw new Error("服务器错误: 400312 - 未知错误");
      }

      return { ok: true };
    },
  };

  await runBatchedGameCommand({
    tokenStore,
    tokenId: "token-1",
    cmd: "item_openbox",
    total: 20,
    delayMs: 300,
    retryDelayMs: 1000,
    maxRetries: 1,
    createParams: (amount) => ({ itemId: 2004, number: amount }),
    sleepFn: async (ms) => {
      events.push({ type: "sleep", ms });
    },
  });

  assert.deepEqual(events, [
    {
      type: "send",
      attempts: 1,
      tokenId: "token-1",
      cmd: "item_openbox",
      params: { itemId: 2004, number: 10 },
    },
    { type: "sleep", ms: 300 },
    {
      type: "send",
      attempts: 2,
      tokenId: "token-1",
      cmd: "item_openbox",
      params: { itemId: 2004, number: 10 },
    },
    { type: "sleep", ms: 1000 },
    {
      type: "send",
      attempts: 3,
      tokenId: "token-1",
      cmd: "item_openbox",
      params: { itemId: 2004, number: 10 },
    },
  ]);
});

test("getItemQuantity reads role item quantities from role info shapes", () => {
  assert.equal(
    getItemQuantity({ role: { items: { 2004: { quantity: 12 } } } }, 2004),
    12,
  );
  assert.equal(getItemQuantity({ items: { 1001: { count: 34 } } }, 1001), 34);
  assert.equal(getItemQuantity({ role: { items: {} } }, 2004), 0);
});

test("getClaimableBoxPoints reads common role info field shapes", () => {
  assert.equal(getClaimableBoxPoints({ role: { boxPoint: 1200 } }), 1200);
  assert.equal(getClaimableBoxPoints({ role: { boxPoints: "1,300" } }), 1300);
  assert.equal(
    getClaimableBoxPoints({
      data: { role: { boxPointReward: { canClaim: 1400 } } },
    }),
    1400,
  );
  assert.equal(
    getClaimableBoxPoints({
      role: { item: { box_points: { quantity: 1500 } } },
    }),
    1500,
  );
  assert.equal(getClaimableBoxPoints({ role: { items: {} } }), 0);
});

test("runInventoryVerifiedGameCommand checks inventory after the requested consume plan", async () => {
  let inventory = 25;
  const events = [];
  const tokenStore = {
    async sendMessageWithPromise(tokenId, cmd, params, timeout) {
      events.push({ type: "send", tokenId, cmd, params, timeout });
      inventory -= params.number;
      return { ok: true };
    },
  };

  const result = await runInventoryVerifiedGameCommand({
    tokenStore,
    tokenId: "token-1",
    cmd: "item_openbox",
    itemId: 2004,
    total: 20,
    timeout: 4321,
    delayMs: 300,
    createParams: (amount) => ({ itemId: 2004, number: amount }),
    queryInventory: async () => {
      events.push({ type: "query", inventory });
      return { role: { items: { 2004: { quantity: inventory } } } };
    },
    sleepFn: async (ms) => {
      events.push({ type: "sleep", ms });
    },
  });

  assert.deepEqual(result, {
    completed: 20,
    finalCount: 5,
    initialCount: 25,
  });
  assert.deepEqual(events, [
    { type: "query", inventory: 25 },
    {
      type: "send",
      tokenId: "token-1",
      cmd: "item_openbox",
      params: { itemId: 2004, number: 10 },
      timeout: 4321,
    },
    { type: "sleep", ms: 300 },
    {
      type: "send",
      tokenId: "token-1",
      cmd: "item_openbox",
      params: { itemId: 2004, number: 10 },
      timeout: 4321,
    },
    { type: "query", inventory: 5 },
  ]);
});

test("runInventoryVerifiedGameCommand sends ten consume calls before rechecking a target of one hundred", async () => {
  let inventory = 120;
  const events = [];
  const tokenStore = {
    async sendMessageWithPromise(_tokenId, _cmd, params) {
      events.push({ type: "send", amount: params.number });
      inventory -= params.number;
      return { ok: true };
    },
  };

  await runInventoryVerifiedGameCommand({
    tokenStore,
    tokenId: "token-1",
    cmd: "item_openbox",
    itemId: 2004,
    total: 100,
    createParams: (amount) => ({ itemId: 2004, number: amount }),
    queryInventory: async () => {
      events.push({ type: "query", inventory });
      return { role: { items: { 2004: { quantity: inventory } } } };
    },
    sleepFn: async () => {},
  });

  assert.deepEqual(events, [
    { type: "query", inventory: 120 },
    { type: "send", amount: 10 },
    { type: "send", amount: 10 },
    { type: "send", amount: 10 },
    { type: "send", amount: 10 },
    { type: "send", amount: 10 },
    { type: "send", amount: 10 },
    { type: "send", amount: 10 },
    { type: "send", amount: 10 },
    { type: "send", amount: 10 },
    { type: "send", amount: 10 },
    { type: "query", inventory: 20 },
  ]);
});

test("runInventoryVerifiedGameCommand sends the remaining deficit after a verification check", async () => {
  let inventory = 25;
  const events = [];
  const tokenStore = {
    async sendMessageWithPromise(_tokenId, _cmd, params) {
      events.push({ type: "send", amount: params.recruitNumber });
      inventory -= events.filter((event) => event.type === "send").length === 1
        ? 6
        : params.recruitNumber;
      return { ok: true };
    },
  };

  const result = await runInventoryVerifiedGameCommand({
    tokenStore,
    tokenId: "token-1",
    cmd: "hero_recruit",
    itemId: 1001,
    total: 20,
    delayMs: 300,
    createParams: (amount) => ({ recruitType: 1, recruitNumber: amount }),
    queryInventory: async () => {
      events.push({ type: "query", inventory });
      return { role: { items: { 1001: { quantity: inventory } } } };
    },
    sleepFn: async (ms) => {
      events.push({ type: "sleep", ms });
    },
  });

  assert.deepEqual(events, [
    { type: "query", inventory: 25 },
    { type: "send", amount: 10 },
    { type: "sleep", ms: 300 },
    { type: "send", amount: 10 },
    { type: "query", inventory: 9 },
    { type: "sleep", ms: 300 },
    { type: "send", amount: 4 },
    { type: "query", inventory: 5 },
  ]);
  assert.equal(result.completed, 20);
  assert.equal(result.finalCount, 5);
});

test("runInventoryVerifiedGameCommand ignores intermediate send failures and fills the final deficit", async () => {
  let inventory = 35;
  const events = [];
  let sendCount = 0;
  const tokenStore = {
    async sendMessageWithPromise(_tokenId, _cmd, params) {
      sendCount += 1;
      events.push({ type: "send", amount: params.number, sendCount });

      if (sendCount === 1) {
        throw new Error("服务器错误: 500000 - 临时失败");
      }

      inventory -= params.number;
      return { ok: true };
    },
  };

  const result = await runInventoryVerifiedGameCommand({
    tokenStore,
    tokenId: "token-1",
    cmd: "item_openbox",
    itemId: 2004,
    total: 20,
    delayMs: 300,
    maxRetries: 0,
    createParams: (amount) => ({ itemId: 2004, number: amount }),
    queryInventory: async () => {
      events.push({ type: "query", inventory });
      return { role: { items: { 2004: { quantity: inventory } } } };
    },
    sleepFn: async (ms) => {
      events.push({ type: "sleep", ms });
    },
  });

  assert.deepEqual(events, [
    { type: "query", inventory: 35 },
    { type: "send", amount: 10, sendCount: 1 },
    { type: "sleep", ms: 300 },
    { type: "send", amount: 10, sendCount: 2 },
    { type: "query", inventory: 25 },
    { type: "sleep", ms: 300 },
    { type: "send", amount: 10, sendCount: 3 },
    { type: "query", inventory: 15 },
  ]);
  assert.equal(result.completed, 20);
  assert.equal(result.finalCount, 15);
});

test("runInventoryVerifiedGameCommand does not fill when a failed intermediate call still consumed inventory", async () => {
  let inventory = 35;
  let sendCount = 0;
  const tokenStore = {
    async sendMessageWithPromise(_tokenId, _cmd, params) {
      sendCount += 1;
      inventory -= params.number;

      if (sendCount === 1) {
        throw new Error("服务器错误: 400312 - 未知错误");
      }

      return { ok: true };
    },
  };

  const result = await runInventoryVerifiedGameCommand({
    tokenStore,
    tokenId: "token-1",
    cmd: "item_openbox",
    itemId: 2004,
    total: 20,
    maxRetries: 0,
    createParams: (amount) => ({ itemId: 2004, number: amount }),
    queryInventory: async () => ({
      role: { items: { 2004: { quantity: inventory } } },
    }),
    sleepFn: async () => {},
  });

  assert.equal(sendCount, 2);
  assert.equal(result.completed, 20);
  assert.equal(result.finalCount, 15);
});

test("runInventoryVerifiedGameCommand stops when verification shows no inventory decrease", async () => {
  let inventory = 20;
  const tokenStore = {
    async sendMessageWithPromise() {
      return { ok: true };
    },
  };

  await assert.rejects(
    runInventoryVerifiedGameCommand({
      tokenStore,
      tokenId: "token-1",
      cmd: "hero_recruit",
      itemId: 1001,
      total: 10,
      createParams: (amount) => ({ recruitType: 1, recruitNumber: amount }),
      queryInventory: async () => ({
        role: { items: { 1001: { quantity: inventory } } },
      }),
      sleepFn: async () => {},
    }),
    /库存未变化/,
  );
});

test("runInventoryVerifiedGameCommand does not consume when inventory is insufficient", async () => {
  const tokenStore = {
    async sendMessageWithPromise() {
      throw new Error("不应该发送消耗命令");
    },
  };

  await assert.rejects(
    runInventoryVerifiedGameCommand({
      tokenStore,
      tokenId: "token-1",
      cmd: "item_openbox",
      itemId: 2004,
      total: 20,
      createParams: (amount) => ({ itemId: 2004, number: amount }),
      queryInventory: async () => ({
        role: { items: { 2004: { quantity: 10 } } },
      }),
    }),
    /库存不足/,
  );
});
