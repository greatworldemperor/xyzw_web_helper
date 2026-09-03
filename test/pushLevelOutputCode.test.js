import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildInputCode,
  buildOutputCode,
  outputCodeSchema,
} from "../src/utils/pushLevel/outputCode.js";
import { jsonExtStringify } from "../src/utils/pushLevel/jsonExt.js";

const hashWithNode = (value) =>
  createHash("md5").update(value, "utf8").digest("hex");

const makeMember = (heroId, index) => ({
  heroId,
  color: 3,
  level: 1200,
  order: index,
  index,
  rage: 100,
  club: 4,
  slot: index,
  star: 10,
  damage: 1234 + index,
  takeDamage: 10 * index,
  treatment: 0,
  hp: 9000 - index,
  energy: 100,
  skin: -1,
  skinName: "",
  type: 0,
  maxAttr: new Map([
    [2, 100],
    [3, 200],
    [4, 300],
  ]),
  statistic: new Map(),
  skillDamage: {},
  skillTreatment: {},
  enchantMap: {},
});

const sponsor = {
  roleId: "role-a",
  name: "A",
  headImg: "head-a",
  avatarFrame: 2,
  power: 10000,
  teamInfo: [makeMember(107, 0)],
  ext: { curHP: 9000 },
};

const accept = {
  roleId: "role-b",
  name: "B",
  headImg: "head-b",
  avatarFrame: 0,
  power: 2000,
  teamInfo: [makeMember(9303, 0), makeMember(9304, 1), makeMember(9305, 2)],
  ext: { curHP: 0 },
};

test("JSONExt serialization converts Map and preserves JSON omission rules", () => {
  assert.equal(
    jsonExtStringify({ first: 1, omitted: undefined, values: new Map([["b", 2], ["a", 1]]) }),
    '{"first":1,"values":{"b":2,"a":1}}',
  );
});

test("outputCode uses the captured result, team, and member key order", () => {
  const generated = buildOutputCode({
    battleData: { id: 7, randomSeed: 19, version: 240514, mode: 0 },
    sponsor,
    accept,
  });

  assert.deepEqual(Object.keys(generated.result), outputCodeSchema.resultKeys);
  assert.deepEqual(
    Object.keys(generated.result.sponsor),
    outputCodeSchema.teamKeys,
  );
  assert.deepEqual(
    Object.keys(generated.result.sponsor.teamInfo[0]),
    outputCodeSchema.memberKeys,
  );
  assert.equal(generated.result.outputCode, "");
  assert.equal(generated.outputCode, hashWithNode(generated.serialized));
  assert.match(generated.outputCode, /^[a-f0-9]{32}$/);
  assert.equal(generated.result.accept.teamInfo.length, 3);

  const changedDisplayFields = buildOutputCode({
    battleData: { id: 7, randomSeed: 19, version: 240514, mode: 0 },
    sponsor: { ...sponsor, name: "different" },
    accept,
  });
  assert.notEqual(changedDisplayFields.outputCode, generated.outputCode);
});

test("outputCode rejects an ambiguous result flag", () => {
  assert.throws(
    () => buildOutputCode({ battleData: { randomSeed: 19 }, sponsor, accept, isWin: "true" }),
    /isWin must be a boolean/,
  );
});

test("inputCode sanitization does not mutate battleData or reorder existing keys", () => {
  const battleData = {
    id: 7,
    leftTeams: [{ id: 1 }],
    randomSeed: 19,
    rightTeams: [{ id: 2 }],
    result: { stale: true },
    options: { levelId: 1812 },
  };
  const expectedSerialized =
    '{"id":7,"randomSeed":19,"result":null,"options":{"levelId":1812}}';
  const inputCode = buildInputCode(battleData);

  assert.equal(inputCode, hashWithNode(expectedSerialized));
  assert.deepEqual(battleData.leftTeams, [{ id: 1 }]);
  assert.deepEqual(battleData.result, { stale: true });
});
