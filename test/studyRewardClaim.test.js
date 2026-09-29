import test from "node:test";
import assert from "node:assert/strict";

import {
  claimAllStudyRewards,
  isRetryableClaimError,
  STUDY_REWARD_IDS,
} from "../src/utils/studyRewardClaim.js";

const fastOptions = {
  intervalMs: 0,
  backoffMs: 0,
  sleepFn: async () => {},
};

// 造一个可控的假 client：responses[rewardId] 描述第 n 次尝试的行为
const makeClient = (behavior) => {
  const sent = [];
  const acked = [];
  const attempts = {};
  const stats = { totalAttempts: 0 };
  return {
    sent,
    acked,
    attempts,
    stats,
    send(cmd, params) {
      sent.push(params.rewardId);
    },
    sendWithPromise: async (cmd, params) => {
      const id = params.rewardId;
      attempts[id] = (attempts[id] || 0) + 1;
      stats.totalAttempts++;
      const nth = attempts[id];
      const rule = typeof behavior === "function" ? behavior(id, nth) : behavior;
      if (rule === "ok") {
        acked.push(id);
        return { code: 0 };
      }
      throw Object.assign(new Error(rule), { message: rule });
    },
  };
};

test("全部 ack 成功：10 档都记入 claimed", async () => {
  const client = makeClient("ok");
  const { claimed, failed } = await claimAllStudyRewards(client, fastOptions);

  assert.deepEqual(claimed, STUDY_REWARD_IDS);
  assert.deepEqual(failed, []);
  assert.equal(client.acked.length, 10);
});

test("限流导致的漏领会重试并补上（旧实现正是这里静默丢帧）", async () => {
  // 第 5~8 档第一次撞限流，第二次成功
  const client = makeClient((id, nth) => {
    if (id >= 5 && id <= 8 && nth === 1) return "操作过快，请稍后再试 400340";
    return "ok";
  });

  const { claimed, failed } = await claimAllStudyRewards(client, fastOptions);

  assert.deepEqual(claimed, STUDY_REWARD_IDS);
  assert.deepEqual(failed, []);
  assert.equal(client.acked.length, 10); // 每档最终都 ack 成功一次
  assert.equal(client.stats.totalAttempts, 14); // 10 + 4 档各多试一次
});

test("持续限流：首轮失败后走补领第二轮，仍失败则报出档位", async () => {
  let pass = 0;
  const client = makeClient((id, nth) => {
    // 7、9 档：前 4 次（首轮 3 次 + 补领 1 次）限流，第 5 次成功
    if ((id === 7 || id === 9) && nth <= 4) return "请求频繁";
    return "ok";
  });
  void pass;

  const { claimed, failed } = await claimAllStudyRewards(client, fastOptions);

  // 首轮 7、9 失败 → 进补领轮 → 第 4 次尝试成功
  assert.deepEqual(claimed, STUDY_REWARD_IDS);
  assert.deepEqual(failed, []);
});

test("真正领不到的档位会被列进 failed，不会假装成功", async () => {
  const client = makeClient((id) => (id === 3 ? "已领取" : "ok"));

  const { claimed, failed } = await claimAllStudyRewards(client, fastOptions);

  assert.deepEqual(failed, [3]);
  assert.equal(claimed.length, 9);
  assert.ok(!claimed.includes(3));
});

test("业务错误不重试（避免无谓的重复领取）", async () => {
  const client = makeClient((id) => (id === 2 ? "已领取" : "ok"));
  const { failed } = await claimAllStudyRewards(client, fastOptions);

  // 只尝试一次即判终态，加上补领那一次 = 2 次
  const twiceFor2 = client.acked.filter((x) => x === 2).length;
  assert.equal(twiceFor2, 0);
  assert.deepEqual(failed, [2]);
});

test("服务端不回 ack 时降级为裸发，不会每档白等", async () => {
  const client = makeClient(() => "请求超时");

  const { claimed, failed } = await claimAllStudyRewards(client, fastOptions);

  // 第 1 档连试 3 次超时 → 降级；之后 9 档走裸发
  assert.equal(client.acked.length, 0);
  assert.equal(client.sent.length, 10); // 1(降级) + 9(裸发)
  assert.deepEqual(failed, []);
  assert.deepEqual(claimed, STUDY_REWARD_IDS);
});

test("client 为空时不会抛错，全部档位记为未领取", async () => {
  const { claimed, failed } = await claimAllStudyRewards(null, fastOptions);
  assert.deepEqual(claimed, []);
  assert.deepEqual(failed, STUDY_REWARD_IDS);
});

test("isRetryableClaimError 只对传输类错误为真", () => {
  assert.equal(isRetryableClaimError(new Error("请求超时: study_claimreward")), true);
  assert.equal(isRetryableClaimError(new Error("WebSocket 连接已关闭")), true);
  assert.equal(isRetryableClaimError(new Error("操作过快 400340")), true);
  assert.equal(isRetryableClaimError(new Error("已领取")), false);
  assert.equal(isRetryableClaimError(new Error("200020")), false);
  assert.equal(isRetryableClaimError(new Error("参数错误")), false);
});
