/**
 * 盐场队长稳定键（serverId:roleId）回归测试（2026-10-03 事故修复）
 *
 * 事故：token 重导后 token id（bin 内容 MD5）全部变化，
 *       盐场队长清单/队伍表以 token id 为主键 → 30 支队伍全部 "Token not found"。
 * 修复：主键换成稳定键 serverId:roleId（master 定稿），旧数据惰性自动迁移。
 *
 * 运行（需别名加载器，saltFieldConfig 依赖 @/utils/token）：
 *   node --import ./local-data/_alias_loader.mjs test/saltfieldLeaderKeys.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  KEYS,
  getLeaderKeys,
  setLeaderKeys,
  addLeaderKeys,
  removeLeaderKey,
  getRoleCache,
  setRoleCacheEntry,
  getTeams,
  setTeams,
  makeTeamId,
  reconcileTeams,
  groupTeamsByLegion,
} from "../src/utils/saltFieldConfig.js";

const OLD_ID_A = "8fe8c11ca44c6ed22b330858bb7fe2ae"; // 旧 token id（md5 hex）
const OLD_ID_B = "8c813798473d84627c54c72463b6b00f";
const OLD_ID_ORPHAN = "9442eb5f12bd5f0f19c7b1c63c115958"; // roleCache 里查不到的队长

const KEY_A = "9740:715582089";
const KEY_B = "9741:715582090";

/** 安装一次性旧版（token id 主键）数据，复刻本次事故现场 */
function seedLegacy() {
  localStorage.clear();
  localStorage.setItem(
    KEYS.legacyLeaders,
    JSON.stringify([OLD_ID_A, OLD_ID_B, OLD_ID_ORPHAN]),
  );
  localStorage.setItem(
    KEYS.roleCache,
    JSON.stringify({
      [OLD_ID_A]: {
        roleId: 715582089,
        roleName: "队长甲",
        legionId: 1882,
        legionName: "测试俱乐部",
        serverId: 9740,
        serverName: "S9740",
      },
      [OLD_ID_B]: {
        roleId: 715582090,
        roleName: "队长乙",
        legionId: 1883,
        legionName: "隔壁俱乐部",
        serverId: 9741,
        serverName: "S9741",
      },
      // OLD_ID_ORPHAN 没有缓存条目 ⇒ 无法迁移，应被丢弃
    }),
  );
  localStorage.setItem(
    KEYS.teams,
    JSON.stringify([
      {
        id: `1882-${OLD_ID_A}`,
        legionId: 1882,
        leaderTokenId: OLD_ID_A,
        name: "队长甲",
        enabled: true,
        memberRoleIds: [111, 222],
        mobile: true,
        mode: "wait",
      },
      {
        id: `1883-${OLD_ID_B}`,
        legionId: 1883,
        leaderTokenId: OLD_ID_B,
        name: "队长乙",
        enabled: false,
        memberRoleIds: [],
        mobile: false,
        mode: "immediate",
      },
    ]),
  );
}

test("旧 token id 数据自动迁移到稳定键 serverId:roleId", () => {
  seedLegacy();
  // 首次读取即触发惰性迁移
  const leaders = getLeaderKeys();
  assert.deepEqual(leaders.sort(), [KEY_A, KEY_B].sort()); // 孤儿队长被丢弃
  assert.equal(localStorage.getItem(KEYS.legacyLeaders), null); // 旧键已删

  const cache = getRoleCache();
  assert.equal(cache[KEY_A]?.roleName, "队长甲");
  assert.equal(cache[KEY_B]?.roleName, "队长乙");
  assert.equal(cache[OLD_ID_A], undefined); // 旧 id 不再作为 key

  const teams = getTeams();
  assert.equal(teams.length, 2);
  const teamA = teams.find((t) => t.leaderKey === KEY_A);
  assert.ok(teamA, "队长甲的队伍应存在");
  assert.equal(teamA.leaderTokenId, undefined); // 旧字段已清
  assert.deepEqual(teamA.memberRoleIds, [111, 222]); // 业务字段保留
  assert.equal(teamA.mode, "wait");
  assert.equal(teamA.mobile, true);
  assert.equal(teamA.id, makeTeamId(1882, KEY_A)); // 队伍 id 用稳定键重建

  // 幂等：重复读不变化、不重建
  assert.deepEqual(getLeaderKeys(), leaders);
});

test("token 重导后（同一稳定键、新 token id）配置不受影响", () => {
  // 模拟 master 今天的场景：token 全部重导，id 变了但 serverId:roleId 不变
  const leaders = getLeaderKeys();
  assert.ok(leaders.includes(KEY_A));
  // 队伍表依然按 leaderKey 匹配，reconcile 不会把队伍移除
  const { teams, removed } = reconcileTeams();
  assert.equal(removed.length, 0);
  assert.equal(teams.length, 2);
  assert.ok(teams.find((t) => t.leaderKey === KEY_A)?.memberRoleIds?.length === 2);
});

test("reconcileTeams：新增队长补队伍、取消队长移队伍", () => {
  // 承接上一条的迁移后状态（迁移标志是模块级单例，seedLegacy 二次播种不会重跑迁移）
  addLeaderKeys(["9750:999"]);
  let { teams, added, removed } = reconcileTeams();
  assert.equal(added.length, 1);
  assert.equal(added[0].leaderKey, "9750:999");
  assert.equal(added[0].name, "队伍"); // 无缓存信息时默认名
  assert.equal(teams.length, 3);

  removeLeaderKey("9750:999");
  ({ teams, removed } = reconcileTeams());
  assert.equal(removed.length, 1);
  assert.equal(teams.length, 2);
});

test("setRoleCacheEntry / setTeams / groupTeamsByLegion 按稳定键工作", () => {
  localStorage.clear();
  setLeaderKeys([KEY_A]);
  setRoleCacheEntry(KEY_A, { roleId: 715582089, legionId: 1882, legionName: "测试俱乐部" });
  reconcileTeams();
  const groups = groupTeamsByLegion();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].legionId, 1882);
  assert.equal(groups[0].legionName, "测试俱乐部");
  assert.equal(groups[0].teams[0].leaderKey, KEY_A);
});

test("makeTeamId 格式：legionId-leaderKey", () => {
  assert.equal(makeTeamId(1882, "9740:715582089"), "1882-9740:715582089");
  // legionId 缺省时由 groupTeamsByLegion 侧归组为 "unknown"；makeTeamId 本身原样插值
  assert.equal(makeTeamId(null, "9740:1"), "null-9740:1");
});

test("leaderKeys 去重（setLeaderKeys）", () => {
  localStorage.clear();
  setLeaderKeys([KEY_A, KEY_A, KEY_B]);
  assert.deepEqual(getLeaderKeys(), [KEY_A, KEY_B]);
});
