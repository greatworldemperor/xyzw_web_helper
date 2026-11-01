/**
 * 蟠桃编排层纯函数回归（buildBattleTeamFromPreset + 战场并发闸门 createGate——其余依赖网络/UI）
 * 数据结构照抄 2026-09-20 抓包 PresetTeam_GetInfoResp。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildBattleTeamFromPreset, createGate } from "../src/utils/pantaoPlan.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* ---------- createGate：2026-11-01 切号提速（上限可运行中抬升） ---------- */

test("createGate：默认上限内直接放行，超限等待 release", async () => {
  const gate = createGate(2);
  await gate.acquire();
  await gate.acquire();
  assert.equal(gate.active, 2);

  let thirdDone = false;
  const third = gate.acquire().then(() => {
    thirdDone = true;
  });
  await sleep(600);
  assert.equal(thirdDone, false, "上限 2 时第 3 个 acquire 必须等待");
  assert.equal(gate.active, 2);

  gate.release();
  await Promise.race([third, sleep(2000)]);
  assert.equal(thirdDone, true, "release 后等待者应放行");
  assert.equal(gate.active, 2);
  gate.release();
  gate.release();
  assert.equal(gate.active, 0);
});

test("createGate：setMax 运行中抬升上限，等待者放行", async () => {
  const gate = createGate(1);
  await gate.acquire();
  let secondDone = false;
  const second = gate.acquire().then(() => {
    secondDone = true;
  });
  await sleep(600);
  assert.equal(secondDone, false, "上限 1 时第 2 个 acquire 必须等待");

  gate.setMax(2);
  await Promise.race([second, sleep(2000)]);
  assert.equal(secondDone, true, "抬升上限后等待者应立刻放行");
  assert.equal(gate.max, 2);
  gate.release();
  gate.release();
  assert.equal(gate.active, 0);
});

test("createGate：setMax 低于 active 不驱逐存量，只挡新进入者", async () => {
  const gate = createGate(2);
  await gate.acquire();
  await gate.acquire();
  gate.setMax(1);
  assert.equal(gate.active, 2, "已持有者不被驱逐");

  let thirdDone = false;
  const third = gate.acquire().then(() => {
    thirdDone = true;
  });
  await sleep(600);
  assert.equal(thirdDone, false, "limit=1 且 active=2 时新进入者仍等待");

  gate.release(); // active 2→1，仍 ≥ limit 1
  await sleep(600);
  assert.equal(thirdDone, false, "active 未降到 limit 以下前继续等待");

  gate.release(); // active 1→0 < 1
  await Promise.race([third, sleep(2000)]);
  assert.equal(thirdDone, true);
  gate.release();
});

test("createGate：非法/0 上限按 1 兜底", () => {
  const gate = createGate(0);
  assert.equal(gate.max, 1);
  gate.setMax(-5);
  assert.equal(gate.max, 1);
});

// 2026-11-01：蟠桃会话专用首帧口径（3000070 根因修复）——
// payload_setbattleteam 只认 App（mix）口径，官方真串取自 pantao_1101.pcap s01 主连接首帧。
// 🔴 改这两个值前先重抓官方 role_getroleinfo 校验（App 版本周更，tools/mumu_capture.cmd）。
import { PANTAO_PLATFORM_OVERRIDE } from "../src/utils/pantaoConfig.js";

test("蟠桃会话口径覆盖 = 官方 App 真串（mix / 0.36.0-android，pantao_1101 实证）", () => {
  assert.deepEqual({ ...PANTAO_PLATFORM_OVERRIDE }, {
    platform: "hortor",
    platformExt: "mix",
    clientVersion: "0.36.0-android",
    inviteUid: 0,
    scene: "",
  });
});
