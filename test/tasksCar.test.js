import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldSendCar, normalizeCars, gradeLabel, canClaim, isBigPrize, countRacingRefreshTickets } from "../src/utils/batch/carUtils.js";
import { createTasksCar } from "../src/utils/batch/tasksCar.js";

test("batchSmartSendCar continues through all four cars after a 400340 failure", async () => {
  const sentCarIds = [];
  const logs = [];
  const selectedTokens = { value: ["token-1"] };
  const tokens = { value: [{ id: "token-1", name: "测试角色" }] };
  const tokenStatus = { value: {} };
  const isRunning = { value: false };
  const shouldStop = { value: false };
  const currentRunningTokenId = { value: null };
  const batchSettings = {
    carMinColor: 1,
    smartDepartureGoldThreshold: 0,
    smartDepartureRecruitThreshold: 0,
    smartDepartureJadeThreshold: 0,
    smartDepartureTicketThreshold: 0,
    smartDepartureMode: "A",
  };
  const cars = [1, 2, 3, 4].map((id) => ({
    id,
    color: 1,
    rewards: [],
    refreshCount: 1,
    sendAt: 0,
  }));
  let carTwoAttempts = 0;
  const tokenStore = {
    async sendMessageWithPromise(_tokenId, cmd, params) {
      if (cmd === "car_getrolecar") return { body: cars };
      if (cmd === "role_getroleinfo") {
        return { role: { items: { 35002: { quantity: 0 } } } };
      }
      if (cmd === "car_getmemberhelpingcnt") return {};
      if (cmd === "legion_getinfo") return { info: { members: {} } };
      if (cmd === "car_send") {
        sentCarIds.push(String(params.carId));
        if (params.carId === "2" && carTwoAttempts++ === 0) {
          throw new Error("服务器错误: 400340 - 未知错误");
        }
      }
      return { ok: true };
    },
    closeWebSocketConnection() {},
  };

  const { batchSmartSendCar } = createTasksCar({
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 0 },
    batchSettings,
    tokenStore,
    addLog: (entry) => logs.push(entry),
    message: { success: () => {} },
    currentRunningTokenId,
    normalizeCars,
    gradeLabel,
    shouldSendCar,
    canClaim,
    isBigPrize,
    countRacingRefreshTickets,
    delayConfig: { action: 0, refresh: 0, retry: 0 },
  });

  await batchSmartSendCar();

  assert.deepEqual(sentCarIds, ["1", "2", "2", "3", "4"]);
  assert.equal(tokenStatus.value["token-1"], "completed");
  assert.equal(
    logs.some((entry) => entry.message.includes("触发服务器限流")),
    true,
  );
});