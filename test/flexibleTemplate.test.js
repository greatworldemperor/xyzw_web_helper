import assert from "node:assert/strict";
import test from "node:test";

import {
  createSharedConnectionCoordinator,
  flexibleTaskGroups,
  flexibleTasks,
  normalizeFlexibleTemplate,
  parseFlexibleTemplates,
} from "../src/utils/batch/flexibleTemplate.js";

test("flexible task catalog includes hidden daily tasks and every batch action", () => {
  const taskIds = new Set(flexibleTasks.map((task) => task.value));
  const hiddenDailyTasks = [
    "daily.share",
    "daily.friendGold",
    "daily.freeRecruit",
    "daily.paidRecruit",
    "daily.freeGold",
    "daily.claimHangUp",
    "daily.openBox",
    "daily.resetBottleTimer",
    "daily.claimBottle",
    "daily.arena",
    "daily.legionBoss",
    "daily.dailyBoss",
    "daily.welfareSignIn",
    "daily.clubSignIn",
    "daily.discountGift",
    "daily.freeCardGift",
    "daily.permanentCardGift",
    "daily.claimEmail",
    "daily.collectionGift",
    "daily.freeGacha",
    "daily.freeFishing",
    "daily.genieSweep",
    "daily.freeGenieTickets",
    "daily.blackMarket",
    "daily.dream",
    "daily.deepSeaGenie",
    "daily.restoreFormation",
    "daily.dailyRewards",
    "daily.weeklyReward",
    "daily.passReward",
  ];
  const batchActions = [
    "batchStudy",
    "batchSmartSendCar",
    "batchClaimCars",
    "climbTower",
    "skinChallenge",
    "batchClaimPeachTasks",
    "batchBuyDreamItems",
    "batchFootballBet",
    "batchbaoku13",
    "batchbaoku45",
    "climbWeirdTower",
    "batchSmartItemHandling",
    "batchOpenBox",
    "batchOpenBoxByPoints",
    "batchClaimBoxPointReward",
    "batchFish",
    "batchRecruit",
    "batchHeroUpgrade",
    "batchBookUpgrade",
    "batchClaimStarRewards",
    "legion_storebuygoods",
    "legionStoreBuySkinCoins",
    "batchLegacyClaim",
    "batchLegacyGiftSendEnhanced",
    "batchTopUpFish",
    "batchTopUpArena",
    "batchWarGuessCheer",
  ];

  [...hiddenDailyTasks, ...batchActions].forEach((taskId) =>
    assert.equal(taskIds.has(taskId), true, `missing task: ${taskId}`),
  );
  assert.equal(
    flexibleTasks.filter((task) => task.kind === "batch").length,
    batchActions.length,
  );
  assert.equal(
    flexibleTasks.filter((task) => task.kind === "daily").length,
    hiddenDailyTasks.length,
  );
  assert.equal(taskIds.size, flexibleTasks.length);
  [
    "daily.addHangUpTime",
    "daily.collectionReward",
    "claimHangUpRewards",
    "batchAddHangUpTime",
    "batchclubsign",
    "batcharenafight",
    "store_purchase",
    "collection_claimfreereward",
    "batchGenieSweep",
    "batchmengjing",
    "batchClaimFreeEnergy",
  ].forEach((taskId) => assert.equal(taskIds.has(taskId), false, `removed task remains: ${taskId}`));
  assert.equal(
    flexibleTaskGroups.some((group) => group.name === "routine"),
    false,
  );

  const dailyGroup = flexibleTaskGroups.find((group) => group.name === "daily");
  assert.deepEqual(
    dailyGroup.tasks.filter((task) => task.kind === "batch").map((task) => task.value),
    ["batchStudy", "batchSmartSendCar", "batchClaimCars"],
  );
});

test("normalization migrates removed duplicate task IDs to canonical tasks", () => {
  const normalized = normalizeFlexibleTemplate({
    id: "legacy-duplicates",
    name: "legacy duplicates",
    selectedTasks: [
      "daily.claimHangUp",
      "daily.addHangUpTime",
      "claimHangUpRewards",
      "batchAddHangUpTime",
      "daily.collectionReward",
      "collection_claimfreereward",
      "daily.genieSweep",
      "batchGenieSweep",
      "batchClaimFreeEnergy",
      "batchSmartItemHandling",
      "batchmengjing",
    ],
  });

  assert.deepEqual(normalized.selectedTasks, [
    "daily.claimHangUp",
    "daily.collectionGift",
    "daily.genieSweep",
    "batchSmartItemHandling",
    "daily.dream",
  ]);
});

test("normalization combines legacy weird-tower item tasks", () => {
  const normalized = normalizeFlexibleTemplate({
    id: "weird-tower",
    name: "weird tower",
    selectedTasks: ["batchUseItems", "batchMergeItems", "batchSmartItemHandling"],
  });

  assert.deepEqual(normalized.selectedTasks, ["batchSmartItemHandling"]);
});

test("normalization removes unknown and duplicate task ids while merging settings", () => {
  const normalized = normalizeFlexibleTemplate({
    id: "template-1",
    name: "  morning  ",
    selectedTasks: ["daily.share", "unknown", "daily.share", "batchStudy"],
    settings: { bossTimes: 4 },
  });

  assert.deepEqual(normalized.selectedTasks, ["daily.share", "batchStudy"]);
  assert.equal(normalized.name, "morning");
  assert.equal(normalized.settings.bossTimes, 4);
  assert.equal(normalized.settings.boxCount, 100);
});

test("normalization clamps imported settings and rejects invalid options", () => {
  const normalized = normalizeFlexibleTemplate({
    id: "unsafe-settings",
    name: "unsafe",
    selectedTasks: ["batchOpenBox"],
    settings: {
      arenaFormation: 99,
      bossTimes: -5,
      boxType: 9999,
      boxCount: 999999,
      footballPick: "2",
      legacyRecipientId: -1,
      warGuessCoin: 50,
    },
  });

  assert.equal(normalized.settings.arenaFormation, 1);
  assert.equal(normalized.settings.bossTimes, 0);
  assert.equal(normalized.settings.boxType, 2001);
  assert.equal(normalized.settings.boxCount, 10000);
  assert.equal(normalized.settings.footballPick, 2);
  assert.equal(normalized.settings.legacyRecipientId, null);
  assert.equal(normalized.settings.warGuessCoin, 20);
});

test("persisted templates fail closed when storage is malformed", () => {
  assert.deepEqual(parseFlexibleTemplates("not-json"), []);
  assert.deepEqual(parseFlexibleTemplates({}), []);
  assert.equal(
    parseFlexibleTemplates(
      JSON.stringify([
        { id: "valid", name: "有效", selectedTasks: ["daily.share"] },
        { id: "missing-name", selectedTasks: [] },
      ]),
    ).length,
    1,
  );
});

test("concurrent tasks share one connection lifecycle per token", async () => {
  const calls = [];
  const coordinator = createSharedConnectionCoordinator({
    acquireSlot: async (tokenId) => calls.push(`acquire:${tokenId}`),
    connect: async (tokenId) => calls.push(`connect:${tokenId}`),
    close: async (tokenId) => calls.push(`close:${tokenId}`),
    releaseSlot: (tokenId) => calls.push(`release:${tokenId}`),
  });

  await Promise.all([
    coordinator.ensureConnection("role-1"),
    coordinator.ensureConnection("role-1"),
    coordinator.ensureConnection("role-1"),
  ]);
  await coordinator.cleanup();
  await coordinator.cleanup();

  assert.deepEqual(calls, [
    "acquire:role-1",
    "connect:role-1",
    "close:role-1",
    "release:role-1",
  ]);
});

test("a failed connection releases its slot and can be retried", async () => {
  const calls = [];
  let connectionAttempt = 0;
  const coordinator = createSharedConnectionCoordinator({
    acquireSlot: async (tokenId) => calls.push(`acquire:${tokenId}`),
    connect: async (tokenId) => {
      connectionAttempt++;
      calls.push(`connect:${tokenId}:${connectionAttempt}`);
      if (connectionAttempt === 1) throw new Error("temporary failure");
    },
    close: async (tokenId) => calls.push(`close:${tokenId}`),
    releaseSlot: (tokenId) => calls.push(`release:${tokenId}`),
  });

  await assert.rejects(
    coordinator.ensureConnection("role-1"),
    /temporary failure/,
  );
  await coordinator.ensureConnection("role-1");
  await coordinator.cleanup();

  assert.deepEqual(calls, [
    "acquire:role-1",
    "connect:role-1:1",
    "close:role-1",
    "release:role-1",
    "acquire:role-1",
    "connect:role-1:2",
    "close:role-1",
    "release:role-1",
  ]);
});