/**
 * 周年庆周任务奖励 + 拼图兑换（临时活动批量任务，2026-10-22 接入）
 *
 * 协议证据：`local-data/anniversary/xyzw_1022.pcap`
 * （MuMu 模拟器 tcpdump 明文 ws 抓包，2026-10-22 双角色实测；
 * `_ws_extract.py` 抽 RFC6455 帧 + skill `xyzw-protocol-re` bon.mjs 解码，494 帧 0 失败）：
 *
 * ① 周任务奖励（战令 actId 2610169 的序号 06~14，命令与每日奖励 01~05 相同）：
 *      查询 activity_warorderget {actId} → warOrderActivityInfo["2610169"]
 *        complete[missionId] / taskClaimed[missionId]（BON map 键是字符串）
 *      领取 activity_warordertaskclaim {actId, missionId} → 每任务 10× 道具 5290（拼图货币）
 *      实证达标线：06:1 07:1 08:2 09:8 10:8 11:8(营地挑战达标) 12:3 13:3 14:3
 *      （角色A 09/10/11 complete=0 一个没领；角色B 8/8/8 全领 —— 状态驱动成立）
 *
 * ② 拼图兑换（actId 2610168，photo 指针模型）：
 *      状态 Activity_GetResp.body.activity.photoActivityInfo["2610168"] = {num, pieceId}
 *        pieceId = 当前待兑换块（线性 11→…→14→21→…→24→31→…→34），num = 已投入 5290 数
 *      兑换 activity_photo {activityId, num, pieceId}（每块 10 个 5290）
 *        → Activity_PhotoResp（role.items["5290"] 余额快照）
 *      领奖 activity_claimphotoreward {activityId, pieceId}
 *        → Activity_RewardResp（奖励分档，2026-10-29 实测：普通块 30×5293+1000 钻，
 *          每周第 3 块（51/61）50×5293+2000 钻+1×5291；photoActivityInfo 指针已指向下一块）
 *      指针实证：角色A 起始 {num:10, pieceId:11}（昨日投满未领）→ 先领 11 → 兑 12…；
 *      两角色均 5290 耗尽即停（领任务数 == 兑块数）。
 *
 * 2026-10-29 抓包（xyzw_1029.pcap）补充实证：
 *   - pieceId 线性序列延伸到 41~44 / 51~54 / 61~64（第 5/6 周），指针模型不变；
 *   - **num=9 部分投入**：余额不足 10 时客户端发差值（activity_photo {num:9}），
 *     服务端照收（5290 归零、块留 num<10 半满）⇒ 「用光道具」按差值投入合法；
 *   - 拼图领奖**掉新集卡**（type:21，cardId 9014/9015/9016，响应 role.linkCard readNum=0），
 *     客户端随即 linkcard_readcard {cardId, readNum:1} 读掉；
 *   - 战令 09/10/11 本周 complete=15 仍领（门槛≤8 成立）；07 进度 0 领不了。
 *
 * 实现口径（master 2026-10-29 拍板：合并为一个「领取周年庆每周奖励」按钮，一周一次）：
 *   - 周任务用**门槛表**：complete≥门槛且未领才发请求，不发无效帧；
 *   - 拼图 photo→claim 顺序循环，**用光 5290**：余额不足一块时按差值部分投入
 *     （半满块不可领，留待下周补满后自动领——重跑幂等）；
 *   - 拼图领奖掉的新集卡**自动读掉**（listUnreadCardIds + linkcard_readcard）；
 *   - 错误分类复用 tasksAnnBoss 导出的 classifyClaimError / rewardText / readItemQuantity；
 *   - 限流(400340)立即停本账号剩余动作；超时/断连走 sendWithRecovery（刷新Token重发）；
 *   - 连接生命周期与 daily/boss 模块同口径：ensureConnection → finally close + releaseSlot。
 *
 * 2026-11-05 抓包（xyzw_20261105_225125.pcap，活动最后一天，master 手动操作双号）新增③商店兑换：
 *   - X=5293（拼图领奖产出）资源商店 actId 26101611，7 种商品限购，兑换顺序 = 优先级
 *     （A/B 两号顺序完全一致）：217→211→213→212→216→215→214；
 *     单价由 B 号余额差实证（217×5 花费 125 ⇒ 25/个）：25/5/10/10/25/15/10；
 *     A 号 980 X 全花到 0、B 号 780 花剩 5（214 单价 10 > 5 买不起）——纯函数逐字复现两号序列；
 *   - Y=5291 皮肤商店 actId 26101610：7 Y → 1 皮肤（A 号 goodsId 261016145 → 皮肤 11905，
 *     master 指定就兑这个）；不足 7 个时 1 Y → 10 X（B 号 goodsId 261016147 ×5 → 5293+50，
 *     B 号先折算再进 X 商店）；余数逻辑：先兑皮肤(floor(Y/7))，余数 <7 全部折算成 X；
 *   - 兑换响应 = Common_RewardResp（role.items 快照），已注册 + 已有响应映射，零协议改动。
 */

import {
  getErrorMessage,
  isConnectionError,
  isRateLimitError as isProjectRateLimitError,
} from "../helperTaskRunner.js";
import {
  ANN_LINKCARD_READ_NUM,
  classifyClaimError,
  isInactiveError,
  isRateLimitError,
  listUnreadCardIds,
  readItemQuantity,
  rewardText,
} from "./tasksAnnBoss.js";

const nowText = () => new Date().toLocaleTimeString();

const RECOVERY_ROUNDS = 2;

const errorText = (error) =>
  String(error?.error || error?.message || error || "");

// ── 常量（抓包实证，下期轮换再改这里）──────────────────────────────────────────

/** 战令活动实例 ID（与每日奖励 01~05 同一个 actId） */
export const ANN_WEEK_ACT_ID = 2610169;

/**
 * 周任务（序号 06~14）达标线（抓包实证「领取成功时的 complete 值」，
 * 服务端真实门槛只高不低 —— 高估只会晚领，低估会被服务端拒后按 benign 跳过，两头都安全）
 */
export const ANN_WEEK_MISSION_THRESHOLDS = Object.freeze({
  6: 1,
  7: 1,
  8: 2,
  9: 8,
  10: 8,
  11: 8, // 营地挑战达标（角色A 忘报名 → complete 0 → 无法完成，master 2026-10-22 口径）
  12: 3,
  13: 3,
  14: 3,
});

/** 拼图活动实例 ID */
export const ANN_PUZZLE_ACT_ID = 2610168;

/** 拼图货币（战令任务产出）与每块消耗 */
export const ANN_PUZZLE_CURRENCY_ITEM_ID = 5290;
export const ANN_PUZZLE_PIECE_COST = 10;

/** 拼图块总数保险丝（2026-10-29 实证序列已到 61+；留多周追赶余量） */
export const ANN_PUZZLE_MAX_PIECES = 16;

// ── 商店兑换常量（2026-11-05 抓包实证，活动最后一天 master 手动操作双号）─────────

/** X 资源商店（5293 兑资源）与 Y 皮肤商店（5291 兑皮肤/折算）活动实例 ID */
export const ANN_SHOP_X_ACT_ID = 26101611;
export const ANN_SHOP_Y_ACT_ID = 26101610;

/** X/Y 货币 item ID（X=拼图领奖产出 5293；Y=每周第 3 块拼图产出 5291） */
export const ANN_SHOP_X_ITEM_ID = 5293;
export const ANN_SHOP_Y_ITEM_ID = 5291;

/** Y 兑皮肤：goodsId 261016145 → 皮肤 11905（A 号实证），7 Y/个（master 指定兑这个） */
export const ANN_SKIN_GOODS_ID = 261016145;
export const ANN_SKIN_COST_Y = 7;

/** Y 不足 7 个时按 1 Y → 10 X 折算（B 号实证 goodsId 261016147） */
export const ANN_Y2X_GOODS_ID = 261016147;
export const ANN_Y2X_X_GAIN = 10;

/**
 * X 商店优先级表（master 口径：抓包兑换顺序 = 优先级，上一格兑满兑下一格）。
 * qty = 抓包购买量 —— 服务端已实证收得下 ⇒ 真实限购 ≥ qty（保守方向安全）；
 *   215/214 的 qty 受余额所限（18/1），是限购已知下界，超高余额账号可能剩零头。
 * cost = 5293 单价（B 号余额差实证：217×5 花费 125 ⇒ 25/个）。
 */
export const ANN_X_GOODS_PLAN = Object.freeze([
  { goodsId: 261016217, cost: 25, qty: 5 },
  { goodsId: 261016211, cost: 5, qty: 5 },
  { goodsId: 261016213, cost: 10, qty: 10 },
  { goodsId: 261016212, cost: 10, qty: 20 },
  { goodsId: 261016216, cost: 25, qty: 10 },
  { goodsId: 261016215, cost: 15, qty: 18 },
  { goodsId: 261016214, cost: 10, qty: 1 },
]);

const ACTION_INTERVAL_MS = 500;

// ── 纯函数（导出给测试）─────────────────────────────────────────────────────────

/**
 * 从 warOrderActivityInfo 快照里挑出「未领且达标」的周任务（按序号升序）。
 * 🔴 complete/taskClaimed 的键是 missionId 的**字符串**（BON map 解码即如此）；
 *    complete 可能缺键 —— 缺键按 0 处理（不踩 Number(null)===0 的坑，显式 ?? 0）。
 */
export function listClaimableWeekMissions(
  info,
  thresholds = ANN_WEEK_MISSION_THRESHOLDS,
) {
  const out = [];
  if (!info || typeof info !== "object") return out;
  const complete = info.complete || {};
  const claimed = info.taskClaimed || {};
  for (const seqText of Object.keys(thresholds).sort((a, b) => a - b)) {
    const threshold = thresholds[seqText];
    const missionId = ANN_WEEK_ACT_ID * 100 + Number(seqText);
    if (claimed[String(missionId)]) continue; // 已领过
    const progress = Number(complete[String(missionId)] ?? 0);
    if (progress >= threshold) {
      out.push({ seq: Number(seqText), missionId, progress, threshold });
    }
  }
  return out;
}

/**
 * 从响应 body 里读拼图指针：{pieceId, invested}；无进行中的块（活动未开 /
 * 本期拼图已全部完成 / pieceId 空缺）返回 null。
 */
export function readPuzzleState(body) {
  const info = body?.activity?.photoActivityInfo?.[String(ANN_PUZZLE_ACT_ID)];
  if (!info || typeof info !== "object") return null;
  const pieceId = Number(info.pieceId ?? 0);
  if (!pieceId) return null;
  return { pieceId, invested: Number(info.num ?? 0) };
}

/** 领奖响应里的下一块指针（可能缺 activity 快照 → null） */
export const readNextPuzzleState = readPuzzleState;

/**
 * Y(5291) 兑换计划（2026-11-05 master 口径）：
 * ≥7 的部分按 7:1 兑皮肤（goodsId 261016145），余数（<7）全部按 1Y→10X 折算。
 * 返回 { skinQty, y2xQty }。
 */
export function planYExchange(yBalance) {
  const skinQty = Math.floor(yBalance / ANN_SKIN_COST_Y);
  return { skinQty, y2xQty: yBalance - skinQty * ANN_SKIN_COST_Y };
}

/**
 * X 商店购买计划：按优先级逐格，买 min(限购, floor(余额/单价))；
 * 余额买不起一格（cost）时跳下一格。
 * 逐字复现 2026-11-05 抓包：余额 980 → A 号序列(5/5/10/20/10/18/1，花到 0)；
 * 余额 780 → B 号序列(5/5/10/20/10/5，剩 5 止步)。
 */
export function planXShopPurchases(xBalance, plan = ANN_X_GOODS_PLAN) {
  const out = [];
  let left = xBalance;
  for (const { goodsId, cost, qty } of plan) {
    const n = Math.min(qty, Math.floor(left / cost));
    if (n > 0) {
      out.push({ goodsId, quantity: n });
      left -= n * cost;
    }
  }
  return out;
}

// ── 批量任务 ───────────────────────────────────────────────────────────────────

export function createTasksAnnWeek(deps) {
  const {
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot,
    connectionQueue,
    batchSettings,
    tokenStore,
    reconnectWithFreshToken,
    addLog,
    message,
    currentRunningTokenId,
  } = deps;

  const log = (tokenName, text, type = "info") =>
    addLog({ time: nowText(), message: `${tokenName} ${text}`, type });

  const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  /** 带「刷新 Token 后重试」的发送（与 tasksAnnDaily/Boss 同款，master 2026-10-17 口径） */
  const sendWithRecovery = async (tokenId, tokenName, cmd, params, timeout, label) => {
    for (let round = 0; ; round += 1) {
      try {
        return await tokenStore.sendMessageWithPromise(tokenId, cmd, params, timeout);
      } catch (error) {
        if (
          shouldStop.value ||
          round >= RECOVERY_ROUNDS ||
          !isConnectionError(error) ||
          isProjectRateLimitError(error)
        ) {
          throw error;
        }
        log(
          tokenName,
          `${label}失败（${getErrorMessage(error)}），强制刷新Token并重建WSS后重试（第${round + 1}/${RECOVERY_ROUNDS}次）`,
          "warning",
        );
        await reconnectWithFreshToken?.(tokenId, `${label}失败（第${round + 1}次）`);
      }
    }
  };

  /**
   * 批量执行骨架（与 tasksAnnBoss.runForSelectedTokens 同口径）。
   * perToken.run 返回 "failed" 时该账号记 failed，其余（含全跳过）记 completed。
   */
  const runForSelectedTokens = async (perToken, doneMessage) => {
    if (selectedTokens.value.length === 0) {
      message.warning("请先选择账号");
      return;
    }

    isRunning.value = true;
    shouldStop.value = false;
    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((item) => item.id === tokenId);
      const tokenName = token?.name || tokenId;

      try {
        addLog({
          time: nowText(),
          message: `=== 开始${perToken.label}: ${tokenName} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        const outcome = await perToken.run({ tokenId, token });
        tokenStatus.value[tokenId] = outcome === "failed" ? "failed" : "completed";
      } catch (error) {
        if (isRateLimitError(error)) {
          tokenStatus.value[tokenId] = "completed";
          log(tokenName, "触发限流(400340)，下次再试", "warning");
        } else if (isInactiveError(error)) {
          tokenStatus.value[tokenId] = "completed";
          log(tokenName, `活动暂未开放：${errorText(error)}`, "warning");
        } else {
          tokenStatus.value[tokenId] = "failed";
          log(tokenName, `${perToken.label}失败：${errorText(error)}`, "error");
        }
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: nowText(),
          message: `${tokenName} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;
    message.success(doneMessage);
  };

  // ── ① 周任务奖励（06~14，状态驱动 + 门槛表）─────────────────────────────────

  const claimWeekForToken = async ({ tokenId, token }) => {
    const tokenName = token?.name || tokenId;
    let claimed = 0;
    let hardFailed = false;

    const snapshot = await sendWithRecovery(
      tokenId,
      tokenName,
      "activity_warorderget",
      { actId: ANN_WEEK_ACT_ID },
      8000,
      "周年庆周任务查询",
    );
    const info =
      snapshot?.activity?.warOrderActivityInfo?.[String(ANN_WEEK_ACT_ID)];
    if (!info) {
      log(tokenName, "周年庆周任务：无战令状态（活动未开或本期不存在），跳过", "warning");
      return "nothing";
    }

    const claimables = listClaimableWeekMissions(info);
    if (claimables.length === 0) {
      log(tokenName, "周年庆周任务：暂无可领（未达标或已领完）");
      return "nothing";
    }

    for (const { seq, missionId, progress, threshold } of claimables) {
      if (shouldStop.value) break;
      try {
        const response = await sendWithRecovery(
          tokenId,
          tokenName,
          "activity_warordertaskclaim",
          { actId: ANN_WEEK_ACT_ID, missionId },
          8000,
          `周年庆周任务 ${seq}`,
        );
        claimed += 1;
        log(
          tokenName,
          `周年庆周任务 ${seq} 领取成功（进度 ${progress}/${threshold}，${rewardText(response)}）`,
          "success",
        );
      } catch (error) {
        const kind = classifyClaimError(error);
        if (kind === "ratelimit") {
          log(tokenName, "触发限流(400340)，周年庆周任务下次再领", "warning");
          break;
        }
        if (kind === "boundary") {
          log(
            tokenName,
            `周年庆周任务 ${seq} 服务端判定不可领（进度 ${progress}，门槛可能高于 ${threshold}），跳过`,
          );
        } else if (kind === "benign") {
          log(tokenName, `周年庆周任务 ${seq} 已领过/未开放，跳过`);
        } else {
          log(
            tokenName,
            `周年庆周任务 ${seq} 领取失败：${errorText(error)}（继续下一个）`,
            "error",
          );
          hardFailed = true;
        }
      }
      await sleep(ACTION_INTERVAL_MS);
    }

    if (hardFailed) return "failed";
    return claimed > 0 ? "claimed" : "nothing";
  };

  const batchAnnWeekTaskClaim = async () =>
    runForSelectedTokens(
      { label: "领取周年庆周任务奖励", run: claimWeekForToken },
      "批量领取周年庆周任务奖励结束",
    );

  // ── ② 拼图兑换（photo → claim 指针循环，5290 尽即停）────────────────────────

  const exchangePuzzleForToken = async ({ tokenId, token }) => {
    const tokenName = token?.name || tokenId;
    let piecesDone = 0;
    let hardFailed = false;

    // 2.1 读拼图指针（activity_get；响应体含 photoActivityInfo）
    const getActivity = await sendWithRecovery(
      tokenId,
      tokenName,
      "activity_get",
      {},
      15000,
      "周年庆拼图状态查询",
    );
    let state = readPuzzleState(getActivity);
    if (!state) {
      log(tokenName, "周年庆拼图：无进行中的块（活动未开或本期已全部完成），跳过");
      return "nothing";
    }

    // 2.2 读 5290 余额（role_getroleinfo 的 role.items；键不存在 = 0）
    const roleInfo = await sendWithRecovery(
      tokenId,
      tokenName,
      "role_getroleinfo",
      {},
      15000,
      "周年庆拼图余额查询",
    );
    let balance = readItemQuantity(roleInfo, ANN_PUZZLE_CURRENCY_ITEM_ID) ?? 0;

    for (let i = 0; i < ANN_PUZZLE_MAX_PIECES && !shouldStop.value; i += 1) {
      const { pieceId, invested } = state;
      const need = ANN_PUZZLE_PIECE_COST - invested;

      if (balance < need) {
        if (balance <= 0) {
          log(
            tokenName,
            `周年庆拼图：5290 余额 0，停——先跑「周任务奖励」攒币后重跑`,
            "warning",
          );
          break;
        }
        // 2026-10-29 抓包实证：余额不足一块时客户端按差值投入（num:9 服务端照收），
        // 块留在 num<10 的半满状态 ⇒ 这里把最后一个 5290 也用光（master 口径：用光道具）
        const spent = balance;
        try {
          const photoResp = await sendWithRecovery(
            tokenId,
            tokenName,
            "activity_photo",
            { activityId: ANN_PUZZLE_ACT_ID, num: spent, pieceId },
            8000,
            `周年庆拼图 ${pieceId} 部分投入`,
          );
          const shown = readItemQuantity(photoResp, ANN_PUZZLE_CURRENCY_ITEM_ID);
          balance = shown === null ? 0 : shown;
          log(
            tokenName,
            `周年庆拼图 ${pieceId} 部分投入（投 ${spent} 个 5290，还差 ${need - spent} 个，下周补满后自动领）`,
            "warning",
          );
        } catch (error) {
          const kind = classifyClaimError(error);
          if (kind === "ratelimit") {
            log(tokenName, "触发限流(400340)，周年庆拼图下次再兑", "warning");
          } else if (kind === "hard") {
            log(
              tokenName,
              `周年庆拼图 ${pieceId} 部分投入失败：${errorText(error)}`,
              "error",
            );
            hardFailed = true;
          } else {
            log(
              tokenName,
              `周年庆拼图 ${pieceId} 部分投入被拒（${errorText(error)}）`,
              "warning",
            );
          }
        }
        break; // 半满块不可领奖，本轮收工（重跑幂等：activity_get 重读指针）
      }

      // 2.3 兑换（num 已满的存量块直接跳到领奖，不重投）
      if (need > 0) {
        try {
          const photoResp = await sendWithRecovery(
            tokenId,
            tokenName,
            "activity_photo",
            { activityId: ANN_PUZZLE_ACT_ID, num: need, pieceId },
            8000,
            `周年庆拼图 ${pieceId} 兑换`,
          );
          const shown = readItemQuantity(photoResp, ANN_PUZZLE_CURRENCY_ITEM_ID);
          balance = shown === null ? balance - need : shown;
          log(
            tokenName,
            `周年庆拼图 ${pieceId} 兑换成功（投 ${need} 个 5290，余额 ${balance}）`,
            "success",
          );
        } catch (error) {
          const kind = classifyClaimError(error);
          if (kind === "ratelimit") {
            log(tokenName, "触发限流(400340)，周年庆拼图下次再兑", "warning");
            break;
          }
          if (kind === "hard") {
            log(tokenName, `周年庆拼图 ${pieceId} 兑换失败：${errorText(error)}`, "error");
            hardFailed = true;
          } else {
            log(
              tokenName,
              `周年庆拼图 ${pieceId} 兑换被拒（${errorText(error)}），停止——重跑会从最新指针继续`,
              "warning",
            );
          }
          break; // 兑换失败后指针状态未知，一律停（重跑幂等：activity_get 重读指针）
        }
        await sleep(ACTION_INTERVAL_MS);
      }

      // 2.4 领奖
      try {
        const claimResp = await sendWithRecovery(
          tokenId,
          tokenName,
          "activity_claimphotoreward",
          { activityId: ANN_PUZZLE_ACT_ID, pieceId },
          8000,
          `周年庆拼图 ${pieceId} 领奖`,
        );
        piecesDone += 1;
        log(
          tokenName,
          `周年庆拼图 ${pieceId} 领奖成功（${rewardText(claimResp)}）`,
          "success",
        );
        // 2026-10-29 抓包实证：拼图领奖可能掉新集卡（type:21，role.linkCard readNum=0），
        // 客户端随即 linkcard_readcard 读掉 ⇒ 这里自动跟读（失败只记日志，不阻塞拼图主流程）
        for (const cardId of listUnreadCardIds(claimResp)) {
          if (shouldStop.value) break;
          try {
            await sendWithRecovery(
              tokenId,
              tokenName,
              "linkcard_readcard",
              { cardId, readNum: ANN_LINKCARD_READ_NUM },
              8000,
              `周年庆拼图读卡 ${cardId}`,
            );
            log(tokenName, `周年庆拼图读卡成功（cardId ${cardId}）`, "success");
          } catch (error) {
            const kind = classifyClaimError(error);
            if (kind === "ratelimit") {
              log(tokenName, "触发限流(400340)，读卡下次再读", "warning");
              break;
            }
            log(
              tokenName,
              `周年庆拼图读卡 ${cardId} 失败（${errorText(error)}），不阻塞后续拼图`,
              "warning",
            );
          }
          await sleep(ACTION_INTERVAL_MS);
        }
        const next = readNextPuzzleState(claimResp);
        if (!next) {
          log(tokenName, "周年庆拼图：本期已全部完成 🎉");
          break;
        }
        if (next.pieceId === pieceId) {
          log(tokenName, `周年庆拼图：指针未前进（仍指向 ${pieceId}），停止防死循环`, "warning");
          break;
        }
        state = next;
      } catch (error) {
        const kind = classifyClaimError(error);
        if (kind === "ratelimit") {
          log(tokenName, "触发限流(400340)，周年庆拼图下次再领", "warning");
        } else if (kind === "hard") {
          log(tokenName, `周年庆拼图 ${pieceId} 领奖失败：${errorText(error)}`, "error");
          hardFailed = true;
        } else {
          log(tokenName, `周年庆拼图 ${pieceId} 领奖被拒（${errorText(error)}），停止`, "warning");
        }
        break; // 领奖失败指针未知，停止（重跑幂等）
      }
      await sleep(ACTION_INTERVAL_MS);
    }

    if (hardFailed) return "failed";
    return piecesDone > 0 ? "claimed" : "nothing";
  };

  const batchAnnPuzzleExchange = async () =>
    runForSelectedTokens(
      { label: "周年庆拼图兑换", run: exchangePuzzleForToken },
      "周年庆拼图兑换结束",
    );

  // ── ③ 商店兑换（2026-11-05 新增：Y 皮肤/折算 → X 资源按优先级）────────────────
  //    顺序跟随 B 号实测：Y 先处理（≥7 兑皮肤、余数折 10X/个），折出来的 X 进 X 商店预算
  const exchangeShopForToken = async ({ tokenId, token }) => {
    const tokenName = token?.name || tokenId;
    let hardFailed = false;
    let didSomething = false;

    // 3.1 读 X/Y 余额（role_getroleinfo → role.items；缺键 = 0）
    const roleInfo = await sendWithRecovery(
      tokenId,
      tokenName,
      "role_getroleinfo",
      {},
      15000,
      "周年庆商店余额查询",
    );
    const yBalance = readItemQuantity(roleInfo, ANN_SHOP_Y_ITEM_ID) ?? 0;
    let xBalance = readItemQuantity(roleInfo, ANN_SHOP_X_ITEM_ID) ?? 0;
    if (yBalance <= 0 && xBalance <= 0) {
      log(tokenName, "周年庆商店：X/Y 余额均为 0，无兑换可做");
      return "nothing";
    }
    log(tokenName, `周年庆商店：Y(5291)=${yBalance}，X(5293)=${xBalance}`);

    // 3.2 皮肤：7 Y → 1 个（goodsId 261016145 = 皮肤 11905，A 号 2026-11-05 实证）
    const { skinQty, y2xQty } = planYExchange(yBalance);
    if (skinQty > 0) {
      try {
        const resp = await sendWithRecovery(
          tokenId,
          tokenName,
          "activity_exchange",
          { activityId: ANN_SHOP_Y_ACT_ID, goodsId: ANN_SKIN_GOODS_ID, quantity: skinQty },
          8000,
          "周年庆皮肤兑换",
        );
        didSomething = true;
        log(
          tokenName,
          `周年庆皮肤兑换成功（${skinQty} 个 × 7Y → 皮肤 11905，${rewardText(resp)}）`,
          "success",
        );
      } catch (error) {
        const kind = classifyClaimError(error);
        if (kind === "ratelimit") {
          log(tokenName, "触发限流(400340)，周年庆商店下次再兑", "warning");
          return didSomething ? "claimed" : "nothing";
        }
        if (kind === "hard") {
          log(tokenName, `周年庆皮肤兑换失败：${errorText(error)}`, "error");
          hardFailed = true;
        } else {
          // 皮肤已拥有 / 活动限制等 benign：跳过，不影响后续折算与 X 商店
          log(tokenName, `周年庆皮肤兑换被拒（${errorText(error)}），跳过`, "warning");
        }
      }
      await sleep(ACTION_INTERVAL_MS);
    }

    // 3.3 余数 Y → 10X/个（goodsId 261016147，B 号实证 5Y → 5293+50）
    if (y2xQty > 0) {
      try {
        const resp = await sendWithRecovery(
          tokenId,
          tokenName,
          "activity_exchange",
          { activityId: ANN_SHOP_Y_ACT_ID, goodsId: ANN_Y2X_GOODS_ID, quantity: y2xQty },
          8000,
          "周年庆 Y 折算",
        );
        didSomething = true;
        const shown = readItemQuantity(resp, ANN_SHOP_X_ITEM_ID);
        if (shown !== null) xBalance = shown;
        log(
          tokenName,
          `周年庆 Y 折算成功（${y2xQty} Y → ${y2xQty * ANN_Y2X_X_GAIN} X，X 余额 ${xBalance}）`,
          "success",
        );
      } catch (error) {
        const kind = classifyClaimError(error);
        if (kind === "ratelimit") {
          log(tokenName, "触发限流(400340)，周年庆商店下次再兑", "warning");
          return didSomething ? "claimed" : "nothing";
        }
        if (kind === "hard") {
          log(tokenName, `周年庆 Y 折算失败：${errorText(error)}（继续 X 商店）`, "error");
        } else {
          log(tokenName, `周年庆 Y 折算被拒（${errorText(error)}）`, "warning");
        }
      }
      await sleep(ACTION_INTERVAL_MS);
    }

    // 3.4 X 商店：纯函数出计划（优先级 + min(限购, 买得起)），逐笔发送，余额以响应快照为准
    const purchases = planXShopPurchases(xBalance);
    if (purchases.length === 0) {
      log(tokenName, `周年庆 X 商店：余额 ${xBalance} 买不起任何一格，跳过`);
    }
    for (const { goodsId, quantity } of purchases) {
      if (shouldStop.value) break;
      try {
        const resp = await sendWithRecovery(
          tokenId,
          tokenName,
          "activity_exchange",
          { activityId: ANN_SHOP_X_ACT_ID, goodsId, quantity },
          8000,
          `周年庆商店 ${goodsId}`,
        );
        didSomething = true;
        const shown = readItemQuantity(resp, ANN_SHOP_X_ITEM_ID);
        if (shown !== null) xBalance = shown;
        log(
          tokenName,
          `周年庆商店 ${goodsId} ×${quantity} 成功（X 余额 ${xBalance}，${rewardText(resp)}）`,
          "success",
        );
      } catch (error) {
        const kind = classifyClaimError(error);
        if (kind === "ratelimit") {
          log(tokenName, "触发限流(400340)，周年庆商店下次再兑", "warning");
          break;
        }
        if (kind === "hard") {
          log(tokenName, `周年庆商店 ${goodsId} 失败：${errorText(error)}，停止本账号商店`, "error");
          hardFailed = true;
          break;
        }
        // benign/boundary（限购已满等）→ 计划里的量都是抓包实证发得出的，被拒只记日志继续
        log(tokenName, `周年庆商店 ${goodsId} 被拒（${errorText(error)}），继续下一格`, "warning");
      }
      await sleep(ACTION_INTERVAL_MS);
    }

    if (hardFailed) return "failed";
    return didSomething ? "claimed" : "nothing";
  };

  // ── ④ 合并：领取周年庆每周奖励（一周一次，master 2026-10-29 口径；2026-11-05 加③）──
  //    同一连接先领周任务（攒 5290）→ 再「放入胶卷」用光 5290 → 最后商店兑换
  //    （X=5293 按优先级花光 + Y=5291 兑皮肤/折算）
  const weekRewardForToken = async ({ tokenId, token }) => {
    const outcomeClaim = await claimWeekForToken({ tokenId, token });
    const outcomePuzzle = await exchangePuzzleForToken({ tokenId, token });
    const outcomeShop = await exchangeShopForToken({ tokenId, token });
    if (
      outcomeClaim === "failed" ||
      outcomePuzzle === "failed" ||
      outcomeShop === "failed"
    ) {
      return "failed";
    }
    return outcomeClaim === "claimed" ||
      outcomePuzzle === "claimed" ||
      outcomeShop === "claimed"
      ? "claimed"
      : "nothing";
  };

  const batchAnnWeekReward = async () =>
    runForSelectedTokens(
      { label: "领取周年庆每周奖励", run: weekRewardForToken },
      "批量领取周年庆每周奖励结束",
    );

  return { batchAnnWeekTaskClaim, batchAnnPuzzleExchange, batchAnnWeekReward };
}
