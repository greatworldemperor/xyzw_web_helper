import assert from "node:assert/strict";
import { test } from "node:test";

import { buildResultTemplates } from "../src/utils/pushLevel/resultTemplate.js";

const battleData = {
  rightTeam: {
    team: {
      12: { id: 100052, type: 1, index: 12, level: 4 },
      14: { id: 100053, type: 1, index: 14, level: 4 },
      27: { id: 4, type: 1, index: 27, level: 4 },
    },
  },
};

test("result templates combine role heroes with the active preset team", () => {
  const templates = buildResultTemplates({
    battleData,
    roleResponse: {
      role: {
        roleId: 721769022,
        name: "test-role",
        headImg: "head",
        power: 100,
        heroes: {
          107: { heroId: 107, level: 2200, color: 3, star: 25 },
        },
      },
    },
    presetResponse: {
      presetTeamInfo: {
        useTeamId: 1,
        presetTeamInfo: {
          1: { teamInfo: { 0: { heroId: 107, slot: 0 } } },
        },
      },
    },
  });

  assert.equal(templates.sponsor.roleId, 721769022);
  assert.equal(templates.sponsor.teamInfo.length, 1);
  assert.equal(templates.sponsor.teamInfo[0].level, 2200);
  assert.equal(templates.accept.teamInfo.length, 3);
  assert.deepEqual(
    templates.accept.teamInfo.map((member) => member.index),
    [12, 14, 27],
  );
  assert.deepEqual(
    templates.accept.teamInfo.map((member) => member.slot),
    [12, 14, 27],
  );
  assert.deepEqual(templates.accept.avatarFrame, { id: 0, expire: 0 });
});

test("result templates support a fifteen-member enemy team", () => {
  const team = Object.fromEntries(
    Array.from({ length: 15 }, (_, index) => [
      String(index),
      { id: 100000 + index, type: 1, index },
    ]),
  );
  const templates = buildResultTemplates({
    battleData: { rightTeam: { team } },
    roleResponse: { role: { roleId: 1, heroes: { 107: { heroId: 107 } } } },
    presetResponse: {
      presetTeamInfo: {
        useTeamId: 1,
        presetTeamInfo: { 1: { teamInfo: { 0: { heroId: 107 } } } },
      },
    },
  });

  assert.equal(templates.accept.teamInfo.length, 15);
});

test("result templates accept a direct position object for the active team", () => {
  const templates = buildResultTemplates({
    battleData,
    roleResponse: { role: { roleId: 1, heroes: { 107: { heroId: 107 } } } },
    presetResponse: {
      presetTeamInfo: {
        useTeamId: 1,
        presetTeamInfo: { 1: { teamInfo: { 0: { heroId: 107 } } } },
      },
    },
  });

  assert.deepEqual(templates.sponsor.teamInfo.map((member) => member.heroId), [107]);
});

test("result templates discard empty preset positions", () => {
  const templates = buildResultTemplates({
    battleData,
    roleResponse: {
      role: {
        roleId: 1,
        heroes: { 107: { heroId: 107 }, 108: { heroId: 108 } },
      },
    },
    presetResponse: {
      presetTeamInfo: {
        useTeamId: 1,
        presetTeamInfo: {
          1: {
            teamInfo: {
              0: { heroId: 107 },
              1: {},
              2: { heroId: 108 },
            },
          },
        },
      },
    },
  });

  assert.deepEqual(templates.sponsor.teamInfo.map((member) => member.heroId), [107, 108]);
});

test("result templates do not select a conflicting root field over body data", () => {
  const templates = buildResultTemplates({
    battleData,
    roleResponse: {
      role: { roleId: 99, heroes: { 107: { heroId: 107, level: 900 } } },
      body: { role: { roleId: 1, heroes: { 107: { heroId: 107, level: 2200 } } } },
    },
    presetResponse: {
      presetTeamInfo: {
        useTeamId: 1,
        presetTeamInfo: { 1: { teamInfo: { 0: { heroId: 107 } } } },
      },
      body: { presetTeamInfo: { useTeamId: 1, presetTeamInfo: {} } },
    },
  });

  assert.equal(templates.sponsor.roleId, 1);
  assert.equal(templates.sponsor.teamInfo[0].level, 2200);
});

test("result templates accepts avatarFrameId when avatarFrame is absent", () => {
  const templates = buildResultTemplates({
    battleData,
    roleResponse: {
      role: {
        roleId: 1,
        avatarFrameId: 7,
        heroes: { 107: { heroId: 107 } },
      },
    },
    presetResponse: {
      presetTeamInfo: {
        useTeamId: 1,
        presetTeamInfo: { 1: { teamInfo: { 0: { heroId: 107 } } } },
      },
    },
  });

  assert.deepEqual(templates.sponsor.avatarFrame, { id: 7, expire: 0 });
});

test("result templates fail closed when either side is incomplete", () => {
  assert.throws(
    () =>
      buildResultTemplates({
        battleData,
        roleResponse: { role: { roleId: 1 } },
        presetResponse: {},
      }),
    /active team/,
  );
  assert.throws(
    () =>
      buildResultTemplates({
        battleData: { rightTeam: {} },
        roleResponse: { role: { heroes: { 107: {} } } },
        presetResponse: {
          presetTeamInfo: {
            useTeamId: 1,
            presetTeamInfo: { 1: { teamInfo: { 0: { heroId: 107 } } } },
          },
        },
      }),
    /enemy team members/,
  );
});