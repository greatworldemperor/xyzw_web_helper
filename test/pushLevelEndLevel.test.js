import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildEndLevelPayload,
  extractStartLevel,
  normalizeBattleTime,
} from "../src/utils/pushLevel/endLevel.js";

const outputCode = "ABCDEF0123456789ABCDEF0123456789";

test("extractStartLevel reads nested response data and level metadata", () => {
  const battleData = {
    randomSeed: 6313,
    options: { levelId: 1812 },
  };

  assert.deepEqual(extractStartLevel({ battleData }), {
    battleData,
    levelId: 1812,
    seed: 6313,
  });
  assert.deepEqual(extractStartLevel({ body: { battleData } }), {
    battleData,
    levelId: 1812,
    seed: 6313,
  });
});

test("buildEndLevelPayload preserves wave shape and normalizes digest", () => {
  const payload = buildEndLevelPayload({
    battleData: { options: { levelId: 1812 } },
    battleTime: 447,
    tapTimes: [173, 179],
    autoTapTimes: [[]],
    outputCode,
  });

  assert.deepEqual(payload, {
    levelId: 1812,
    battleTime: 447,
    tapTimes: [[173, 179]],
    autoTapTimes: [[]],
    outputCode: outputCode.toLowerCase(),
    log: "",
  });
});

test("buildEndLevelPayload rejects unsafe or incomplete settlement data", () => {
  assert.throws(
    () =>
      buildEndLevelPayload({
        battleData: { options: { levelId: 1812 } },
        battleTime: 447,
        outputCode: "wrong",
      }),
    /outputCode/,
  );
  assert.throws(
    () =>
      buildEndLevelPayload({
        battleData: { options: { levelId: 1812 } },
        battleTime: -1,
        outputCode,
      }),
    /battleTime/,
  );
});

test("normalizeBattleTime accepts integer ticks and rejects fractional values", () => {
  assert.equal(normalizeBattleTime("447"), 447);
  assert.throws(
    () => normalizeBattleTime(447.5),
    /integer between 0 and 1000000 ticks/,
  );
});