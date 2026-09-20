/**
 * 蟠桃编排层纯函数回归（只测 buildBattleTeamFromPreset —— 其余依赖网络/UI）
 * 数据结构照抄 2026-09-20 抓包 PresetTeam_GetInfoResp。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildBattleTeamFromPreset } from "../src/utils/pantaoPlan.js";

const PRESET_RESP = {
  presetTeamInfo: {
    roleId: 436746334,
    useTeamId: 1,
    presetTeamInfo: {
      1: {
        teamName: "阵容一",
        teamInfo: {
          0: { heroId: 116, level: 4200, star: 5, color: 5, power: 300000000, hp: 1, artifactId: 3, skin: 0, useSkin: 0 },
          1: { heroId: 102, level: 4200, star: 5, color: 5, power: 290000000, hp: 1, artifactId: 0, skin: 0, useSkin: 0 },
          2: { heroId: 112, level: 4200, star: 5, color: 5, power: 280000000, hp: 1, artifactId: 0, skin: 0, useSkin: 0 },
          3: { heroId: 107, level: 4200, star: 5, color: 5, power: 270000000, hp: 1, artifactId: 0, skin: 0, useSkin: 0 },
          4: { heroId: 106, level: 4200, star: 5, color: 5, power: 260000000, hp: 1, artifactId: 0, skin: 0, useSkin: 0 },
        },
        bagHeroInfo: { 201: { heroId: 201 } },
        weapon: { weaponId: 9, attachmentUid: 3, level: 5, passiveSkill: 1, createTime: 1 },
        petUId: "92-4AU",
      },
      2: {
        teamName: "阵容二",
        teamInfo: { 0: { heroId: 999 } },
        weapon: { weaponId: 7 },
        petUId: "",
      },
    },
  },
};

test("buildBattleTeamFromPreset：按 useTeamId 取阵容，输出 {0..4: heroId}", () => {
  const r = buildBattleTeamFromPreset(PRESET_RESP);
  assert.ok(r);
  assert.deepEqual(r.battleTeam, { 0: 116, 1: 102, 2: 112, 3: 107, 4: 106 });
  assert.equal(r.petUId, "92-4AU");
  assert.equal(r.weaponId, 9);
  assert.equal(r.teamId, 1);
});

test("buildBattleTeamFromPreset：useTeamId=2 时取另一套", () => {
  const resp = { presetTeamInfo: { ...PRESET_RESP.presetTeamInfo, useTeamId: 2 } };
  const r = buildBattleTeamFromPreset(resp);
  assert.deepEqual(r.battleTeam, { 0: 999 });
  assert.equal(r.weaponId, 7);
  assert.equal(r.petUId, "");
});

test("buildBattleTeamFromPreset：响应包在 body 里也能解", () => {
  const r = buildBattleTeamFromPreset({ body: PRESET_RESP });
  assert.equal(r.teamId, 1);
});

test("buildBattleTeamFromPreset：空/缺阵容返回 null", () => {
  assert.equal(buildBattleTeamFromPreset(null), null);
  assert.equal(buildBattleTeamFromPreset({}), null);
  assert.equal(buildBattleTeamFromPreset({ presetTeamInfo: { useTeamId: 1, presetTeamInfo: {} } }), null, "找不到队伍 → null");
});
