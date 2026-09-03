import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_BATTLE_CONFIG,
  normalizeBattleConfig,
} from "../src/utils/pushLevel/config.js";

test("battle config defaults to a forced win and known tick duration", () => {
  const config = normalizeBattleConfig();

  assert.deepEqual(config, DEFAULT_BATTLE_CONFIG);
  assert.equal(Object.isFrozen(config), true);
});

test("battle config preserves an explicit result and integer duration", () => {
  assert.deepEqual(
    normalizeBattleConfig({ battleTime: "913", isWin: false }),
    { battleTime: 913, isWin: false },
  );
});

test("battle config rejects ambiguous result or fractional duration", () => {
  assert.throws(
    () => normalizeBattleConfig({ battleTime: 913.5, isWin: true }),
    /integer between 0 and 1000000 ticks/,
  );
  assert.throws(
    () => normalizeBattleConfig({ battleTime: 913, isWin: 1 }),
    /isWin must be a boolean/,
  );
});