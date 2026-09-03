import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPushLevelDryRun } from "../src/utils/pushLevel/dryRun.js";

const makeMember = (heroId, index) => ({
  heroId,
  color: 3,
  level: 1200,
  order: index,
  index,
  rage: 0,
  club: 0,
  slot: index,
  star: 0,
  damage: 0,
  takeDamage: 0,
  treatment: 0,
  hp: 0,
  energy: 0,
  skin: 0,
  skinName: "",
  type: 1,
  maxAttr: { 2: 0, 3: 0, 4: 0 },
  statistic: {},
  skillDamage: {},
  skillTreatment: {},
  enchantMap: {},
});

const makeTeam = (roleId, members) => ({
  roleId,
  name: "test",
  headImg: "",
  avatarFrame: 0,
  power: 0,
  teamInfo: members,
  ext: { curHP: 0 },
});

const startResponse = {
  battleData: {
    id: 0,
    randomSeed: 6313,
    version: 240514,
    mode: 0,
    leftTeam: { roleId: "raw-left" },
    rightTeam: { 12: { id: 100052 } },
    options: { levelId: 1812 },
  },
};

test("dry-run composes start metadata, outputCode, and endLevel payload", () => {
  const preview = buildPushLevelDryRun({
    startResponse,
    sponsor: makeTeam("role-a", [makeMember(107, 0)]),
    accept: makeTeam("role-b", [
      makeMember(9303, 0),
      makeMember(9304, 1),
      makeMember(9305, 2),
    ]),
    battleTime: 447,
    isWin: true,
    autoTapTimes: [[]],
  });

  assert.equal(preview.levelId, 1812);
  assert.equal(preview.seed, 6313);
  assert.match(preview.outputCode, /^[a-f0-9]{32}$/);
  assert.equal(preview.result.outputCode, "");
  assert.equal(preview.result.isWin, true);
  assert.equal(preview.payload.outputCode, preview.outputCode);
  assert.deepEqual(preview.payload.tapTimes, [[]]);
  assert.equal(preview.payload.battleTime, 447);
  assert.deepEqual(preview.battleConfig, { battleTime: 447, isWin: true });
});

test("dry-run keeps an explicitly requested result in the hashed result and payload timing", () => {
  const preview = buildPushLevelDryRun({
    startResponse,
    sponsor: makeTeam("role-a", [makeMember(107, 0)]),
    accept: makeTeam("role-b", [makeMember(9303, 0)]),
    battleTime: 913,
    isWin: false,
  });

  assert.equal(preview.result.isWin, false);
  assert.equal(preview.payload.battleTime, 913);
  assert.deepEqual(preview.battleConfig, { battleTime: 913, isWin: false });
  assert.match(preview.outputCode, /^[a-f0-9]{32}$/);
});

test("dry-run uses the shared battle config default when timing is omitted", () => {
  const preview = buildPushLevelDryRun({
    startResponse,
    sponsor: makeTeam("role-a", [makeMember(107, 0)]),
    accept: makeTeam("role-b", [makeMember(9303, 0)]),
  });

  assert.equal(preview.battleConfig.battleTime, 447);
  assert.equal(preview.payload.battleTime, 447);
  assert.equal(preview.battleConfig.isWin, true);
});

test("dry-run refuses incomplete battle result templates", () => {
  assert.throws(
    () =>
      buildPushLevelDryRun({
        startResponse,
        sponsor: { roleId: "role-a" },
        accept: makeTeam("role-b", []),
        battleTime: 447,
      }),
    /explicit sponsor\.teamInfo and accept\.teamInfo/,
  );
});