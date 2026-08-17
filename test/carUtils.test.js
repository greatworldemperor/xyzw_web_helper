import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldSendCar } from "../src/utils/batch/carUtils.js";

test("shouldSendCar sends a color-qualified car when no reward thresholds are set", () => {
  assert.equal(
    shouldSendCar({ color: 4, rewards: [] }, 0, 4, {}, false),
    true,
  );
  assert.equal(
    shouldSendCar({ color: 3, rewards: [] }, 0, 4, {}, false),
    false,
  );
});

test("shouldSendCar requires configured reward thresholds after the color threshold", () => {
  const car = { color: 4, rewards: [{ itemId: 1001, value: 10 }] };

  assert.equal(
    shouldSendCar(car, 0, 4, { recruit: 10 }, false),
    true,
  );
  assert.equal(
    shouldSendCar(car, 0, 4, { jade: 100 }, false),
    false,
  );
});

test("shouldSendCar keeps the refresh-ticket reward threshold for normal checks", () => {
  const car = { color: 4, rewards: [{ itemId: 35002, value: 2 }] };

  assert.equal(
    shouldSendCar(car, 0, 4, { ticket: 2 }, false),
    true,
  );
  assert.equal(
    shouldSendCar(car, 0, 4, { ticket: 3 }, false),
    false,
  );
});