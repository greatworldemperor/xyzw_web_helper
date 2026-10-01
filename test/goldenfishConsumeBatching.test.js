import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkBatches,
  chunkBatchesMixed,
  planCountConsume,
  RECRUIT_BATCH_SIZE,
  RECRUIT_FILL_SIZE,
} from "../src/utils/goldenfishConsumePlan.js";

test("招募切分：只能用 1 或 10 —— 37 次 ⇒ 3 帧 10 + 7 帧 1", () => {
  const batches = chunkBatchesMixed(37, RECRUIT_BATCH_SIZE, RECRUIT_FILL_SIZE);
  assert.deepEqual(batches, [10, 10, 10, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(
    batches.reduce((a, b) => a + b, 0),
    37,
  );
  // 关键：没有任何一帧是 2..9 这类非法数量
  assert.ok(batches.every((n) => n === 1 || n === 10));
});

test("招募切分：整 10 无余数 ⇒ 全 10，不产生 1", () => {
  const batches = chunkBatchesMixed(4000, 10, 1);
  assert.equal(batches.length, 400);
  assert.ok(batches.every((n) => n === 10));
});

test("招募切分：余数 1..9 全部合法（穷举）", () => {
  for (let r = 1; r <= 9; r += 1) {
    const batches = chunkBatchesMixed(r, 10, 1);
    assert.equal(batches.length, r);
    assert.ok(batches.every((n) => n === 1));
  }
});

test("planCountConsume + fillRemainder=1：不丢余数（旧行为是丢弃）", () => {
  // 差 37 次、库存充足
  const withFill = planCountConsume({
    done: 3963,
    target: 4000,
    stock: 9999,
    batchSize: 10,
    alignDown: true,
    fillRemainder: 1,
  });
  assert.equal(withFill.willDo, 37);
  assert.equal(withFill.alignedShort, false);
  assert.equal(
    withFill.batches.reduce((a, b) => a + b, 0),
    37,
  );

  // 旧行为（不传 fillRemainder）：37 → 只做 30，余 7 丢弃
  const withoutFill = planCountConsume({
    done: 3963,
    target: 4000,
    stock: 9999,
    batchSize: 10,
    alignDown: true,
  });
  assert.equal(withoutFill.willDo, 30);
  assert.equal(withoutFill.alignedShort, true);
});

test("planCountConsume + fillRemainder=1：库存不足时仍按库存收敛", () => {
  const plan = planCountConsume({
    done: 3900,
    target: 4000,
    stock: 17,
    batchSize: 10,
    alignDown: true,
    fillRemainder: 1,
  });
  assert.equal(plan.willDo, 17);
  assert.equal(plan.stockShort, true);
  assert.deepEqual(plan.batches, [10, 1, 1, 1, 1, 1, 1, 1]);
});

test("钓鱼/开箱不传 fillRemainder ⇒ 行为不变（chunkBatches 原样，余数丢）", () => {
  const plan = planCountConsume({
    done: 1140,
    target: 1300,
    stock: 9999,
    batchSize: 10,
    alignDown: true,
  });
  assert.equal(plan.willDo, 160);
  assert.equal(plan.alignedShort, false);

  const odd = planCountConsume({
    done: 1140,
    target: 1305,
    stock: 9999,
    batchSize: 10,
    alignDown: true,
  });
  assert.equal(odd.willDo, 160); // 165 对齐到 160，余 5 丢
  assert.equal(odd.alignedShort, true);
});

test("chunkBatches 原语义保留（旧调用方不受影响）", () => {
  assert.deepEqual(chunkBatches(25, 10), [10, 10, 5]);
});
