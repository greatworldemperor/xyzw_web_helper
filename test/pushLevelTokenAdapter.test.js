import assert from "node:assert/strict";
import { test } from "node:test";

import {
  confirmEndLevelProgress,
  createPushLevelScheduler,
  createPushLevelTokenAdapter,
  extractEndLevelResponseLevelId,
} from "../src/utils/pushLevel/tokenAdapter.js";
import { g_utils } from "../src/utils/bonProtocol.js";

const startResponse = {
  battleData: {
    id: 1,
    randomSeed: 6313,
    version: 240514,
    options: { levelId: 1812 },
  },
};

const preview = {
  levelId: 1812,
  outputCode: "abcdef0123456789abcdef0123456789",
  payload: {
    levelId: 1812,
    battleTime: 447,
    tapTimes: [[]],
    autoTapTimes: [[]],
    outputCode: "abcdef0123456789abcdef0123456789",
    log: "",
  },
};

const makeStore = (response = { levelId: 1813 }) => {
  const calls = [];
  return {
    calls,
    sendMessageWithPromise: async (...args) => {
      calls.push(args);
      if (args[1] === "fight_startlevel") return startResponse;
      return response;
    },
  };
};

test("extractEndLevelResponseLevelId reads root and nested response fields", () => {
  assert.equal(extractEndLevelResponseLevelId({ levelId: 1813 }), 1813);
  assert.equal(
    extractEndLevelResponseLevelId({ role: { levelId: "1813" } }),
    1813,
  );
  assert.equal(
    extractEndLevelResponseLevelId({ currLevel: 1812, levelId: 1813 }),
    1813,
  );
  assert.equal(extractEndLevelResponseLevelId({ items: [] }), null);
});

test("confirmEndLevelProgress requires the exact next level", () => {
  assert.deepEqual(
    confirmEndLevelProgress({ body: { role: { levelId: 1813 } } }, {
      completedLevelId: 1812,
    }),
    {
      confirmed: true,
      completedLevelId: 1812,
      expectedNextLevelId: 1813,
      responseLevelId: 1813,
    },
  );
  assert.throws(
    () => confirmEndLevelProgress({ levelId: 1812 }, { completedLevelId: 1812 }),
    /未按顺序推进/,
  );
  assert.throws(
    () => confirmEndLevelProgress({}, { completedLevelId: 1812 }),
    /缺少下一关 levelId/,
  );
});

test("token adapter is dry-run by default and never exposes submit", async () => {
  const store = makeStore();
  const adapter = createPushLevelTokenAdapter(store);

  assert.equal(adapter.submit, undefined);
  assert.deepEqual(await adapter.startLevel("token-a"), startResponse);
  assert.deepEqual(store.calls[0], ["token-a", "fight_startlevel", {}, 15000]);
});

test("explicit allowSubmit wires endLevel and strict confirmation", async () => {
  const store = makeStore();
  const scheduler = createPushLevelScheduler({
    tokenStore: store,
    tokenId: "token-a",
    allowSubmit: true,
    buildResult: async () => preview,
  });

  const result = await scheduler.runOnce({ wait: false });

  assert.equal(result.submitted, true);
  assert.deepEqual(store.calls.map((call) => call[1]), [
    "fight_startlevel",
    "fight_endlevel",
  ]);
  assert.deepEqual(store.calls[1][2], preview.payload);
  assert.equal(result.confirmation.responseLevelId, 1813);
});

test("adapter stops on a non-progressing endLevel response", async () => {
  const store = makeStore({ levelId: 1812 });
  const scheduler = createPushLevelScheduler({
    tokenStore: store,
    tokenId: "token-a",
    allowSubmit: true,
    buildResult: async () => preview,
  });

  await assert.rejects(
    () => scheduler.runOnce({ wait: false }),
    /未按顺序推进/,
  );
  assert.equal(store.calls.filter((call) => call[1] === "fight_endlevel").length, 1);
  assert.equal(scheduler.state, "error");
});

test("fight_endlevel command round trips through the real BON/x codec", () => {
  const payload = {
    levelId: 1812,
    battleTime: 447,
    tapTimes: [[]],
    autoTapTimes: [[0, 40, 500]],
    outputCode: "abcdef0123456789abcdef0123456789",
    log: "",
  };
  const raw = {
    cmd: "fight_endlevel",
    ack: 3,
    seq: 4,
    time: Date.now(),
    body: g_utils.bon.encode(payload),
  };
  const encoded = g_utils.encode(raw, "x");
  const buffer = encoded instanceof ArrayBuffer
    ? encoded
    : encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  const decoded = g_utils.parse(buffer, "auto");

  assert.equal(raw.cmd, "fight_endlevel");
  assert.equal(decoded.cmd, "fight_endlevel");
  assert.deepEqual(decoded.rawData, payload);
});