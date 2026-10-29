/**
 * 周年庆周任务奖励 + 拼图兑换 协议回归测试
 *
 * 证据：local-data/anniversary/xyzw_1022.pcap
 * （2026-10-22 MuMu 模拟器 tcpdump **明文 ws** 抓包，双角色实测；
 * `_ws_extract.py` 抽 RFC6455 帧 + skill `xyzw-protocol-re` bon.mjs 解码，494 帧 0 失败）
 *
 * 关键实证（全部逐字抄自抓包，勿凭理解改）：
 *   - 战令 actId 2610169 周任务 06~14，领取成功时 complete 值 = 门槛表
 *     （06:1 07:1 08:2 09:8 10:8 11:8 12:3 13:3 14:3）；
 *   - 角色 A 的 09/10/11 complete=0（忘报名营地挑战）→ 一个没发领取帧；
 *   - 拼图 actId 2610168：photoActivityInfo = {num, pieceId} 指针模型，
 *     角色 A 起始 {num:10, pieceId:11}（存量块直接领不重投）；
 *   - activity_photo / activity_claimphotoreward 的 body 逐字节 hex（解密后明文）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { g_utils } from "../src/utils/bonProtocol.js";

import {
  ANN_WEEK_ACT_ID,
  ANN_PUZZLE_ACT_ID,
  ANN_PUZZLE_CURRENCY_ITEM_ID,
  ANN_PUZZLE_PIECE_COST,
  listClaimableWeekMissions,
  readPuzzleState,
  createTasksAnnWeek,
} from "../src/utils/batch/tasksAnnWeek.js";

// ⚠️ `src/utils/xyzwWebSocket.js` 顶部 import 了 vite 别名 `@/stores`，裸 node 解析不了。
//    先装项目自带的别名钩子（local-data/_alias_loader.mjs）再动态 import，
//    这样 `node --test test/*.test.js` 这条标准命令仍能整体跑通。
await import("../local-data/_alias_loader.mjs");
const { CommandRegistry, registerDefaultCommands } = await import(
  "../src/utils/xyzwWebSocket.js"
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const buildRegistry = () => {
  const reg = new CommandRegistry(g_utils, null);
  registerDefaultCommands(reg);
  return reg;
};

const toHex = (u8) => Buffer.from(u8).toString("hex");

// ── 抓包 fixture（逐字抄，勿凭理解改）───────────────────────────────────────────

/** 角色 B（营地任务全做）warorderget 快照：complete 09/10/11 = 8，01~05 已领 */
const ROLE_B_WARORDER = {
  complete: {
    261016901: 50, 261016902: 3, 261016903: 3, 261016904: 3, 261016905: 10,
    261016906: 1, 261016907: 1, 261016908: 2,
    261016909: 8, 261016910: 8, 261016911: 8,
    261016912: 3, 261016913: 3, 261016914: 3,
  },
  taskClaimed: {
    261016901: true, 261016902: true, 261016903: true,
    261016904: true, 261016905: true,
    261016906: false, 261016907: false, 261016908: false,
    261016909: false, 261016910: false, 261016911: false,
    261016912: false, 261016913: false, 261016914: false,
  },
};

/** 角色 A（忘报名营地挑战）：09/10/11 complete = 0，其余与角色 B 同 */
const ROLE_A_WARORDER = {
  complete: {
    261016901: 44, 261016902: 3, 261016903: 3, 261016904: 3, 261016905: 10,
    261016906: 1, 261016907: 1, 261016908: 2,
    261016909: 0, 261016910: 0, 261016911: 0,
    261016912: 3, 261016913: 3, 261016914: 3,
  },
  taskClaimed: {
    261016901: true, 261016902: true, 261016903: true,
    261016904: true, 261016905: true,
    261016906: false, 261016907: false, 261016908: false,
    261016909: false, 261016910: false, 261016911: false,
    261016912: false, 261016913: false, 261016914: false,
  },
};

/** activity_photo {activityId:2610168, num:10, pieceId:14} body 明文（帧 #00098） */
const CAPTURED_PHOTO_BODY_HEX =
  "0803050a6163746976697479496401f8d3270005036e756d010a000000050770696563654964010e000000";

/** activity_claimphotoreward {activityId:2610168, pieceId:14} body 明文（帧 #00100） */
const CAPTURED_CLAIM_BODY_HEX =
  "0802050a6163746976697479496401f8d32700050770696563654964010e000000";

// ── 常量回归 ────────────────────────────────────────────────────────────────────

test("常量：战令 2610169 / 拼图 2610168 / 每块 10 个 5290", () => {
  assert.equal(ANN_WEEK_ACT_ID, 2610169);
  assert.equal(ANN_PUZZLE_ACT_ID, 2610168);
  assert.equal(ANN_PUZZLE_CURRENCY_ITEM_ID, 5290);
  assert.equal(ANN_PUZZLE_PIECE_COST, 10);
});

// ── 周任务状态驱动（门槛表）────────────────────────────────────────────────────

test("周任务：角色 B 快照（09/10/11=8）→ 9 个全部可领，missionId 与抓包一致", () => {
  const claimable = listClaimableWeekMissions(ROLE_B_WARORDER);
  assert.deepEqual(
    claimable.map((m) => m.missionId),
    [
      261016906, 261016907, 261016908, 261016909, 261016910,
      261016911, 261016912, 261016913, 261016914,
    ],
  );
});

test("周任务：角色 A 快照（09/10/11=0，营地未报名）→ 只领 6 个，绝不发 09/10/11", () => {
  const claimable = listClaimableWeekMissions(ROLE_A_WARORDER);
  assert.deepEqual(
    claimable.map((m) => m.seq),
    [6, 7, 8, 12, 13, 14],
  );
  // 抓包实证：角色 A 全程没发过 09/10/11 的领取帧
  assert.equal(claimable.some((m) => m.missionId === 261016909), false);
  assert.equal(claimable.some((m) => m.missionId === 261016910), false);
  assert.equal(claimable.some((m) => m.missionId === 261016911), false);
});

test("周任务：已领的（taskClaimed true）不再发（幂等重跑）", () => {
  const claimed = {
    complete: { 261016906: 1, 261016907: 1 },
    taskClaimed: { 261016906: true, 261016907: true },
  };
  assert.deepEqual(listClaimableWeekMissions(claimed), []);
});

test("周任务：无战令快照 → 空数组（不炸）", () => {
  assert.deepEqual(listClaimableWeekMissions(null), []);
  assert.deepEqual(listClaimableWeekMissions({}), []);
});

// ── 拼图指针模型 ────────────────────────────────────────────────────────────────

test("拼图指针：角色 A 起始 {num:10, pieceId:11}（存量块）", () => {
  const body = { activity: { photoActivityInfo: { 2610168: { num: 10, pieceId: 11 } } } };
  assert.deepEqual(readPuzzleState(body), { pieceId: 11, invested: 10 });
});

test("拼图指针：角色 B 起始 {num:0, pieceId:14}；领奖后指向下一块 {num:0, pieceId:21}", () => {
  assert.deepEqual(
    readPuzzleState({ activity: { photoActivityInfo: { 2610168: { num: 0, pieceId: 14 } } } }),
    { pieceId: 14, invested: 0 },
  );
  assert.deepEqual(
    readPuzzleState({ activity: { photoActivityInfo: { 2610168: { num: 0, pieceId: 21 } } } }),
    { pieceId: 21, invested: 0 },
  );
});

test("拼图指针：活动未开 / 全部完成 / pieceId 空缺 → null", () => {
  assert.equal(readPuzzleState({}), null);
  assert.equal(readPuzzleState({ activity: {} }), null);
  assert.equal(
    readPuzzleState({ activity: { photoActivityInfo: { 2610168: { num: 0 } } } }),
    null,
  );
  assert.equal(
    readPuzzleState({ activity: { photoActivityInfo: { 2610168: { num: 0, pieceId: 0 } } } }),
    null,
  );
});

// ── 注册表 + 逐字节复现（抓包明文哨兵）─────────────────────────────────────────

test("activity_photo / activity_claimphotoreward 已注册（未注册 = 帧发不出去 = 请求超时）", () => {
  const reg = buildRegistry();
  assert.ok(reg.commands.has("activity_photo"), "activity_photo 必须注册");
  assert.ok(
    reg.commands.has("activity_claimphotoreward"),
    "activity_claimphotoreward 必须注册",
  );
});

test("activity_photo body 逐字节复现抓包（帧 #00098：{2610168, num:10, pieceId:14}）", () => {
  const reg = buildRegistry();
  const build = reg.commands.get("activity_photo");
  const { body } = build(0, 1, { activityId: 2610168, num: 10, pieceId: 14 });
  assert.equal(toHex(body), CAPTURED_PHOTO_BODY_HEX);
});

test("activity_claimphotoreward body 逐字节复现抓包（帧 #00100：{2610168, pieceId:14}）", () => {
  const reg = buildRegistry();
  const build = reg.commands.get("activity_claimphotoreward");
  const { body } = build(0, 1, { activityId: 2610168, pieceId: 14 });
  assert.equal(toHex(body), CAPTURED_CLAIM_BODY_HEX);
});

test("响应映射：activity_photoresp / activity_rewardresp（共用）已接", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/utils/xyzwWebSocket.js"), "utf8");
  assert.match(src, /activity_photoresp:\s*"activity_photo"/);
  const rewardMap = src.match(/activity_rewardresp:\s*\[([^\]]*)\]/);
  assert.ok(rewardMap, "activity_rewardresp 数组映射必须存在");
  assert.match(rewardMap[1], /activity_claimphotoreward/);
});

// ── 批量行为 ────────────────────────────────────────────────────────────────────

/** 构造 deps + mock tokenStore（照 annDailyClaim.test.js 口径） */
const makeTasks = ({ send }) => {
  const commands = [];
  const logs = [];
  const tasks = createTasksAnnWeek({
    selectedTokens: { value: ["token-1"] },
    tokens: { value: [{ id: "token-1", name: "测试角色" }] },
    tokenStatus: { value: {} },
    isRunning: { value: false },
    shouldStop: { value: false },
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 1 },
    batchSettings: { maxActive: 1 },
    reconnectWithFreshToken: async () => {},
    tokenStore: {
      async sendMessageWithPromise(_tokenId, command, body) {
        commands.push({ command, body });
        return send(command, body);
      },
      closeWebSocketConnection() {},
    },
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {} },
    currentRunningTokenId: { value: null },
  });
  return { tasks, commands, logs };
};

test("批量周任务：角色 B 快照 → 9 个按序领取（每个得 10× 5290）", async () => {
  const { tasks, commands, logs } = makeTasks({
    send: (command, body) => {
      if (command === "activity_warorderget") {
        return { activity: { warOrderActivityInfo: { 2610169: ROLE_B_WARORDER } } };
      }
      if (command === "activity_warordertaskclaim") {
        return { reward: [{ type: 3, itemId: 5290, value: 10 }] };
      }
      return {};
    },
  });

  await tasks.batchAnnWeekTaskClaim();

  const claims = commands.filter((c) => c.command === "activity_warordertaskclaim");
  assert.deepEqual(
    claims.map((c) => c.body.missionId),
    [
      261016906, 261016907, 261016908, 261016909, 261016910,
      261016911, 261016912, 261016913, 261016914,
    ],
  );
  // 所有领取都带同一 actId
  assert.ok(claims.every((c) => c.body.actId === 2610169));
  assert.equal(logs.filter((l) => l.message.includes("领取成功")).length, 9);
});

test("批量周任务：角色 A 快照 → 只发 6 帧，营地任务 09/10/11 一帧不发", async () => {
  const { tasks, commands } = makeTasks({
    send: (command) => {
      if (command === "activity_warorderget") {
        return { activity: { warOrderActivityInfo: { 2610169: ROLE_A_WARORDER } } };
      }
      return { reward: [{ type: 3, itemId: 5290, value: 10 }] };
    },
  });

  await tasks.batchAnnWeekTaskClaim();

  const missionIds = commands
    .filter((c) => c.command === "activity_warordertaskclaim")
    .map((c) => c.body.missionId);
  assert.deepEqual(missionIds, [261016906, 261016907, 261016908, 261016912, 261016913, 261016914]);
});

test("批量周任务：200020 良性跳过，不短路后面的序号、不记 error", async () => {
  const { tasks, commands, logs } = makeTasks({
    send: (command, body) => {
      if (command === "activity_warorderget") {
        return { activity: { warOrderActivityInfo: { 2610169: ROLE_B_WARORDER } } };
      }
      if (command === "activity_warordertaskclaim") {
        if (body.missionId === 261016907) {
          throw Object.assign(
            new Error("服务器错误: 200020 - 出了点小问题，请尝试重启游戏解决～"),
            { code: 200020 },
          );
        }
        return { reward: [{ type: 3, itemId: 5290, value: 10 }] };
      }
      return {};
    },
  });

  await tasks.batchAnnWeekTaskClaim();

  // 9 个序号全部尝试过（200020 只是跳过，不影响其余）
  assert.equal(
    commands.filter((c) => c.command === "activity_warordertaskclaim").length,
    9,
  );
  assert.equal(logs.filter((l) => l.type === "error").length, 0);
});

test("批量周任务：无战令快照（活动未开）→ 不发任何领取帧、账号 completed", async () => {
  const { tasks, commands, logs } = makeTasks({
    send: () => ({}),
  });

  await tasks.batchAnnWeekTaskClaim();

  assert.equal(commands.filter((c) => c.command === "activity_warordertaskclaim").length, 0);
  assert.equal(logs.filter((l) => l.type === "error").length, 0);
  assert.ok(logs.some((l) => l.message.includes("无战令状态")));
});

test("批量拼图：余额 30 + 指针 {num:0, pieceId:14} → 恰好 3 轮 photo+claim 后因 5290 不足停", async () => {
  let pointer = { num: 0, pieceId: 14 };
  let balance = 30;
  const nextOf = { 14: 21, 21: 22, 22: 23, 23: 24 };

  const { tasks, commands, logs } = makeTasks({
    send: (command, body) => {
      if (command === "activity_get") {
        return { activity: { photoActivityInfo: { 2610168: { ...pointer } } } };
      }
      if (command === "role_getroleinfo") {
        return { role: { items: { 5290: { quantity: balance } } } };
      }
      if (command === "activity_photo") {
        assert.equal(body.activityId, 2610168);
        assert.equal(body.num, 10); // 抓包实证：每次整投 10 个
        balance -= body.num;
        return {
          role: { items: { 5290: { quantity: balance } } },
          activity: { photoActivityInfo: { 2610168: { ...pointer, num: 10 } } },
        };
      }
      if (command === "activity_claimphotoreward") {
        assert.equal(body.pieceId, pointer.pieceId);
        pointer = { num: 0, pieceId: nextOf[body.pieceId] };
        return {
          reward: [
            { type: 3, itemId: 5293, value: 50 },
            { type: 2, itemId: 0, value: 2000 },
            { type: 3, itemId: 5291, value: 1 },
          ],
          activity: { photoActivityInfo: { 2610168: { ...pointer } } },
        };
      }
      return {};
    },
  });

  await tasks.batchAnnPuzzleExchange();

  assert.equal(commands.filter((c) => c.command === "activity_photo").length, 3);
  assert.equal(commands.filter((c) => c.command === "activity_claimphotoreward").length, 3);
  // 领奖顺序 14 → 21 → 22（余额 30 = 3 块），第 4 块前停
  assert.deepEqual(
    commands.filter((c) => c.command === "activity_claimphotoreward").map((c) => c.body.pieceId),
    [14, 21, 22],
  );
  assert.ok(logs.some((l) => l.message.includes("5290 余额 0")));
  // 余额不足是正常停（不是硬失败）
  assert.equal(logs.filter((l) => l.type === "error").length, 0);
});

test("批量拼图：存量块 {num:10, pieceId:11} → 直接领奖不重投；末块余额不足按差值用光（10-29 口径）", async () => {
  // 余额 15：块 12 投 10 剩 5，到块 13 时不足一块 → 按差值 num:5 投入用光（半满待下周补）
  let balance = 15;
  let pointer = { num: 10, pieceId: 11 }; // 存量块：昨天投满没领
  const nextOf = { 11: 12, 12: 13, 13: 14 };
  const { tasks, commands, logs } = makeTasks({
    send: (command, body) => {
      if (command === "activity_get") {
        return { activity: { photoActivityInfo: { 2610168: { ...pointer } } } };
      }
      if (command === "role_getroleinfo") {
        return { role: { items: { 5290: { quantity: balance } } } };
      }
      if (command === "activity_photo") {
        balance -= body.num; // 真实扣币
        return {
          role: { items: balance > 0 ? { 5290: { quantity: balance } } : { 5290: null } },
          activity: {
            photoActivityInfo: { 2610168: { num: body.num, pieceId: body.pieceId } },
          },
        };
      }
      if (command === "activity_claimphotoreward") {
        pointer = { num: 0, pieceId: nextOf[body.pieceId] ?? 0 };
        return {
          reward: [{ type: 3, itemId: 5293, value: 50 }],
          activity: { photoActivityInfo: { 2610168: { ...pointer } } },
        };
      }
      return {};
    },
  });

  await tasks.batchAnnPuzzleExchange();

  // 块 11 没有发过 photo（存量已满 10，直接领）；块 12 整投；块 13 差值投光
  const photos = commands.filter((c) => c.command === "activity_photo");
  assert.deepEqual(
    photos.map((c) => [c.body.pieceId, c.body.num]),
    [[12, 10], [13, 5]],
  );
  assert.deepEqual(
    commands.filter((c) => c.command === "activity_claimphotoreward").map((c) => c.body.pieceId),
    [11, 12],
  );
  // 部分投入后收工（半满块不可领，下周补满自动领）
  assert.ok(logs.some((l) => l.message.includes("部分投入（投 5 个 5290，还差 5 个")));
  assert.equal(logs.filter((l) => l.type === "error").length, 0);
});

test("批量拼图：余额为 0 → 除查询外一帧不发，账号 completed（提示先跑周任务攒币）", async () => {
  const { tasks, commands, logs } = makeTasks({
    send: (command) => {
      if (command === "activity_get") {
        return { activity: { photoActivityInfo: { 2610168: { num: 0, pieceId: 14 } } } };
      }
      if (command === "role_getroleinfo") {
        return { role: {} }; // 5290 键不存在 = 0
      }
      return {};
    },
  });

  await tasks.batchAnnPuzzleExchange();

  assert.equal(commands.filter((c) => c.command === "activity_photo").length, 0);
  assert.equal(commands.filter((c) => c.command === "activity_claimphotoreward").length, 0);
  assert.ok(logs.some((l) => l.message.includes("周任务")));
  assert.equal(logs.filter((l) => l.type === "error").length, 0);
});

test("批量拼图：余额 9（不足一块）→ 按差值投入 num:9 用光道具，不发领奖帧（10-29 抓包实证）", async () => {
  let balance = 9;
  const { tasks, commands, logs } = makeTasks({
    send: (command, body) => {
      if (command === "activity_get") {
        return { activity: { photoActivityInfo: { 2610168: { num: 0, pieceId: 63 } } } };
      }
      if (command === "role_getroleinfo") {
        return { role: { items: { 5290: { quantity: balance } } } };
      }
      if (command === "activity_photo") {
        // 复刻 10-29 抓包：num:9 服务端照收，块留半满 {num:9}
        assert.equal(body.num, 9);
        balance -= body.num;
        return {
          role: { items: { 5290: balance > 0 ? { quantity: balance } : null } },
          activity: { photoActivityInfo: { 2610168: { num: body.num, pieceId: body.pieceId } } },
        };
      }
      if (command === "activity_claimphotoreward") {
        throw new Error("半满块不该发领奖帧");
      }
      return {};
    },
  });

  await tasks.batchAnnPuzzleExchange();

  // 唯一一帧 photo 按余额差值投入，之后收工（半满块不可领）
  assert.deepEqual(
    commands.filter((c) => c.command === "activity_photo").map((c) => c.body.num),
    [9],
  );
  assert.equal(commands.filter((c) => c.command === "activity_claimphotoreward").length, 0);
  assert.ok(logs.some((l) => l.message.includes("还差 1 个")));
  assert.equal(logs.filter((l) => l.type === "error").length, 0);
});

test("批量拼图：领奖掉的新集卡自动读掉（linkcard_readcard readNum:1）", async () => {
  let balance = 10;
  const { tasks, commands } = makeTasks({
    send: (command, body) => {
      if (command === "activity_get") {
        return { activity: { photoActivityInfo: { 2610168: { num: 0, pieceId: 41 } } } };
      }
      if (command === "role_getroleinfo") {
        return { role: { items: { 5290: { quantity: balance } } } };
      }
      if (command === "activity_photo") {
        balance -= body.num;
        return {
          role: { items: { 5290: { quantity: balance } } },
          activity: { photoActivityInfo: { 2610168: { num: 10, pieceId: body.pieceId } } },
        };
      }
      if (command === "activity_claimphotoreward") {
        // 复刻 10-29 抓包：领奖掉卡 9014（type:21，readNum=0），指针跳 42
        return {
          reward: [{ type: 21, itemId: 9014, value: 1 }],
          role: {
            items: { 5293: { quantity: 450 } },
            linkCard: { 9014: { cardId: 9014, quantity: 1, readNum: 0 } },
          },
          activity: { photoActivityInfo: { 2610168: { num: 0, pieceId: 42 } } },
        };
      }
      if (command === "linkcard_readcard") {
        return {};
      }
      return {};
    },
  });

  await tasks.batchAnnPuzzleExchange();

  const reads = commands.filter((c) => c.command === "linkcard_readcard");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].body.cardId, 9014);
  assert.equal(reads[0].body.readNum, 1);
});

test("合并：batchAnnWeekReward = 周任务领取（攒币）→ 拼图兑换用光（同一连接按序跑完）", async () => {
  let balance = 0;
  let pointer = { num: 0, pieceId: 41 };
  const nextOf = { 41: 42, 42: 43, 43: 44, 44: 51, 51: 52, 52: 53, 53: 54, 54: 61, 61: 62 };
  const { tasks, commands, logs } = makeTasks({
    send: (command, body) => {
      if (command === "activity_warorderget") {
        return { activity: { warOrderActivityInfo: { 2610169: ROLE_B_WARORDER } } };
      }
      if (command === "activity_warordertaskclaim") {
        balance += 10; // 每领一个任务 +10 个 5290
        return { reward: [{ type: 3, itemId: 5290, value: 10 }] };
      }
      if (command === "activity_get") {
        return { activity: { photoActivityInfo: { 2610168: { ...pointer } } } };
      }
      if (command === "role_getroleinfo") {
        return { role: { items: balance > 0 ? { 5290: { quantity: balance } } : { 5290: null } } };
      }
      if (command === "activity_photo") {
        balance -= body.num;
        return {
          role: { items: balance > 0 ? { 5290: { quantity: balance } } : { 5290: null } },
          activity: { photoActivityInfo: { 2610168: { num: 10, pieceId: body.pieceId } } },
        };
      }
      if (command === "activity_claimphotoreward") {
        pointer = { num: 0, pieceId: nextOf[body.pieceId] ?? 0 };
        return {
          reward: [{ type: 3, itemId: 5293, value: 30 }],
          activity: { photoActivityInfo: { 2610168: { ...pointer } } },
        };
      }
      return {};
    },
  });

  await tasks.batchAnnWeekReward();

  // ① 战令 9 个任务全部领取（攒 90 个 5290）
  const claims = commands.filter((c) => c.command === "activity_warordertaskclaim");
  assert.equal(claims.length, 9);
  // ② 拼图阶段：90 个 5290 → 恰好 9 块 photo+claim
  assert.equal(commands.filter((c) => c.command === "activity_photo").length, 9);
  assert.equal(commands.filter((c) => c.command === "activity_claimphotoreward").length, 9);
  // ③ 顺序：战令阶段全部先于拼图阶段（activity_get 是拼图的第一帧）
  const firstPuzzleIdx = commands.findIndex((c) => c.command === "activity_get");
  const lastClaimIdx = commands.map((c) => c.command).lastIndexOf("activity_warordertaskclaim");
  assert.ok(firstPuzzleIdx > lastClaimIdx);
  // ④ 全程无硬失败
  assert.equal(logs.filter((l) => l.type === "error").length, 0);
});

test("批量拼图：无拼图指针（本期完成/未开）→ 只发查询帧", async () => {
  const { tasks, commands, logs } = makeTasks({
    send: () => ({}),
  });

  await tasks.batchAnnPuzzleExchange();

  assert.equal(commands.filter((c) => c.command === "activity_photo").length, 0);
  assert.equal(commands.filter((c) => c.command === "activity_claimphotoreward").length, 0);
  assert.ok(logs.some((l) => l.message.includes("无进行中的块")));
});
