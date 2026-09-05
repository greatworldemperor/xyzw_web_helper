import {
  getErrorDetails,
  isRateLimitError,
  isSkippableTaskError,
  runWithWebSocketReconnectRetry,
} from "./helperTaskRunner.js";
import { executeSmartOpenBox } from "./smartOpenBox.js";
import { executeSmartBlackMarketPurchase } from "./smartBlackMarket.js";
import { pickArenaTargetId } from "./batch/connectionManager.js";

const formatCommandParams = (params) => {
  try {
    return JSON.stringify(params ?? {});
  } catch {
    return "[无法序列化]";
  }
};

const isTodayAvailable = (statisticsTime) => {
  if (!statisticsTime) return true;

  // 如果有时间戳，检查是否为今天
  const today = new Date().toDateString();
  //系统返回得时间戳是秒，要转换成毫秒
  const recordDate = new Date(statisticsTime * 1000).toDateString();

  return today !== recordDate;
};

const getTodayBossId = () => {
  const DAY_BOSS_MAP = [9904, 9905, 9901, 9902, 9903, 9904, 9905]; // 周日~周六
  const dayOfWeek = new Date().getDay();
  return DAY_BOSS_MAP[dayOfWeek];
};

export class DailyTaskRunner {
  constructor(tokenStore, delaySettings = null) {
    this.tokenStore = tokenStore;
    this.delaySettings = delaySettings || {
      commandDelay: 500,
      taskDelay: 500
    };
  }

  log(message, type = "info") {
    if (this.callbacks?.onLog) {
      this.callbacks.onLog({
        time: new Date().toLocaleTimeString(),
        message,
        type,
      });
    }
  }

  async executeWithWebSocketRecovery(tokenId, execute) {
    const reconnect = this.callbacks?.onWebSocketReconnect;

    return runWithWebSocketReconnectRetry({
      execute,
      reconnect: reconnect
        ? ({ error, retryCount, maxRetries }) =>
            reconnect({ tokenId, error, retryCount, maxRetries })
        : null,
      maxRetries: this.callbacks?.maxWebSocketReconnectRetries ?? 2,
      onRetry: ({ retryCount, maxRetries }) => {
        this.log(
          `[${tokenId}] 检测到WebSocket未连接，刷新连接后重试（第${retryCount}/${maxRetries}次）`,
          "warning",
        );
      },
    });
  }

  async executeGameCommand(
    tokenId,
    cmd,
    params = {},
    description = "",
    timeout = 8000,
  ) {
    try {
      const commandContext = `[cmd=${cmd}, params=${formatCommandParams(params)}]`;
      if (description) this.log(`执行: ${description} ${commandContext}`);
      const result = await this.executeWithWebSocketRecovery(tokenId, () =>
        this.tokenStore.sendMessageWithPromise(
          tokenId,
          cmd,
          params,
          timeout,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, this.delaySettings.commandDelay));
      if (description) this.log(`${description} - 成功`, "success");
      return result;
    } catch (error) {
      if (description) {
        const token = this.tokenStore.gameTokens.find((t) => t.id === tokenId);
        const tokenName = token?.name || tokenId;
        this.log(
          `[${tokenName}] ${description} - 失败 [cmd=${cmd}, params=${formatCommandParams(params)}] ${getErrorDetails(error)}`,
          "error",
        );
      }
      throw error;
    }
  }

  async switchToFormationIfNeeded(tokenId, targetFormation, formationName) {
    try {
      // 尝试从本地缓存获取当前阵容信息
      // 注意：这里直接读取 store 中的 gameData 可能不是最新的，如果是批量跑，建议每次都获取最新的
      // 或者我们假设 tokenStore.gameData 会随着 sendMessage 更新（如果 store 有处理逻辑）
      // 安全起见，这里先从服务器获取

      this.log(`检查${formationName}配置...`);
      const teamInfo = await this.executeGameCommand(
        tokenId,
        "presetteam_getinfo",
        {},
        "获取阵容信息",
      );

      if (!teamInfo || !teamInfo.presetTeamInfo) {
        this.log(`阵容信息异常: ${JSON.stringify(teamInfo)}`, "warning");
      }

      const currentFormation = teamInfo?.presetTeamInfo?.useTeamId;
      this.log(`当前阵容: ${currentFormation}`);

      if (currentFormation === targetFormation) {
        this.log(
          `当前已是${formationName}${targetFormation}，无需切换`,
          "success",
        );
        return false;
      }

      this.log(
        `当前阵容: ${currentFormation}, 目标阵容: ${targetFormation}，开始切换...`,
      );
      await this.executeGameCommand(
        tokenId,
        "presetteam_saveteam",
        { teamId: targetFormation },
        `切换到${formationName}${targetFormation}`,
      );

      this.log(`成功切换到${formationName}${targetFormation}`, "success");
      return true;
    } catch (error) {
      if (isRateLimitError(error)) {
        throw error;
      }

      this.log(`阵容检查失败，尝试强制切换: ${error.message}`, "warning");
      try {
        await this.executeGameCommand(
          tokenId,
          "presetteam_saveteam",
          { teamId: targetFormation },
          `强制切换到${formationName}${targetFormation}`,
        );
        return true;
      } catch (fallbackError) {
        this.log(`强制切换也失败: ${fallbackError.message}`, "error");
        throw fallbackError;
      }
    }
  }

  // 智能开箱：钻石宝箱+积分足够时优先兑换并打开钻石宝箱，否则回退木质宝箱
  async executeSmartOpenBox(tokenId) {
    return executeSmartOpenBox({
      getRoleInfo: async () => {
        const resp = await this.executeWithWebSocketRecovery(tokenId, () =>
          this.tokenStore.sendGetRoleInfo(tokenId),
        );
        return resp?.role;
      },
      sendCommand: (cmd, params, description) =>
        this.executeGameCommand(tokenId, cmd, params, description),
      log: (msg, type) => this.log(msg, type),
    });
  }

  // 智能黑市购物：先批量购买，有成交则停止，否则兜底购买1个青铜宝箱
  async executeSmartBlackMarket(tokenId) {
    return executeSmartBlackMarketPurchase({
      sendCommand: (cmd, params) =>
        this.executeGameCommand(tokenId, cmd, params),
      log: (msg, type) => this.log(msg, type),
    });
  }

  loadSettings(roleId) {
    try {
      const raw = localStorage.getItem(`daily-settings:${roleId}`);
      const defaultSettings = {
        arenaFormation: 1,
        smartArenaMode: "lowestPower",
        bossFormation: 1,
        bossTimes: 2,
        claimBottle: true,
        payRecruit: true,
        openBox: true,
        arenaEnable: true,
        claimHangUp: true,
        claimEmail: true,
        blackMarketPurchase: true,
        freeGachaEnable: true,
      };
      return raw ? { ...defaultSettings, ...JSON.parse(raw) } : defaultSettings;
    } catch (error) {
      console.error("Failed to load settings:", error);
      return null;
    }
  }

  createDailyTaskRewardTasks(tokenId) {
    const rewardTasks = [];

    for (let taskId = 1; taskId <= 10; taskId++) {
      rewardTasks.push({
        name: `领取每日任务积分奖励${taskId}`,
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "task_claimdailypoint",
            { taskId },
            `领取每日任务积分奖励${taskId}`,
            5000,
          ),
      });
    }

    rewardTasks.push({
      name: "领取每日任务完成奖励",
      execute: () =>
        this.executeGameCommand(
          tokenId,
          "task_claimdailyreward",
          {},
          "领取每日任务完成奖励",
        ),
    });

    return rewardTasks;
  }

  async run(tokenId, callbacks = {}, customSettings = null) {
    this.callbacks = callbacks;
    const settings = customSettings || this.loadSettings(tokenId); // 优先使用传入的设置
    const isStopped = () => this.callbacks?.shouldStop?.() === true;
    const selectedTaskIds = Array.isArray(settings?.selectedTaskIds)
      ? new Set(settings.selectedTaskIds)
      : null;
    const isTaskEnabled = (taskId) =>
      selectedTaskIds === null || selectedTaskIds.has(taskId);
    const isCollectionGiftEnabled =
      isTaskEnabled("daily.collectionGift") ||
      isTaskEnabled("daily.collectionReward");

    // 获取角色信息以确认 roleId 和 任务状态
    this.log("正在获取角色信息...");
    let roleInfoResp;
    try {
      roleInfoResp = await this.executeWithWebSocketRecovery(tokenId, () =>
        this.tokenStore.sendGetRoleInfo(tokenId),
      );
      this.log("角色信息获取成功", "success");
    } catch (error) {
      this.log(`获取角色信息失败: ${error.message}`, "error");
      throw error;
    }

    const roleData = roleInfoResp?.role;
    if (!roleData) {
      throw new Error("角色数据不存在");
    }

    // 重新加载设置，使用正确的 roleId (虽然通常 tokenId 就是 roleId 或者一一对应，但为了保险)
    // 在这个项目中，tokenId 似乎就是 roleId 或者用于标识
    // DailyTaskStatus.vue 中: const role = getCurrentRole() -> roleId: tokenStore.selectedToken.id
    // 所以 tokenId 就是 key

    this.log("开始执行每日任务补差");

    // 读取并保存当前阵容信息
    let originalFormation = null;
    try {
      this.log("读取当前阵容信息...");
      const teamInfo = await this.executeGameCommand(
        tokenId,
        "presetteam_getinfo",
        {},
        "获取当前阵容信息",
      );
      originalFormation = teamInfo?.presetTeamInfo?.useTeamId;
      this.log(`当前阵容: ${originalFormation}`);
    } catch (error) {
      this.log(`读取当前阵容失败: ${error.message}`, "warning");
    }

    const completedTasks = roleData.dailyTask?.complete ?? {};
    const isTaskCompleted = (taskId) => completedTasks[taskId] === -1;
    const statistics = roleData.statistics ?? {};
    const statisticsTime = roleData.statisticsTime ?? {};

    const taskList = [];

    // 1. 基础任务
    if (isTaskEnabled("daily.share") && !isTaskCompleted(2)) {
      taskList.push({
        name: "分享一次游戏",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "system_mysharecallback",
            { isSkipShareCard: true, type: 2 },
            "分享游戏",
          ),
      });
    }

    if (isTaskEnabled("daily.friendGold") && !isTaskCompleted(3)) {
      taskList.push({
        name: "赠送好友金币",
        execute: () =>
          this.executeGameCommand(tokenId, "friend_batch", {}, "赠送好友金币"),
      });
    }

    if (!isTaskCompleted(4) && isTaskEnabled("daily.freeRecruit")) {
      taskList.push({
        name: "免费招募",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "hero_recruit",
            { recruitType: 3, recruitNumber: 1 },
            "免费招募",
          ),
      });
    }

    if (
      !isTaskCompleted(4) &&
      settings.payRecruit &&
      isTaskEnabled("daily.paidRecruit")
    ) {
      taskList.push({
        name: "付费招募",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "hero_recruit",
            { recruitType: 1, recruitNumber: 1 },
            "付费招募",
          ),
      });
    }

    if (
      isTaskEnabled("daily.freeGold") &&
      !isTaskCompleted(6) &&
      isTodayAvailable(statisticsTime["buy:gold"])
    ) {
      for (let i = 0; i < 3; i++) {
        taskList.push({
          name: `免费点金 ${i + 1}/3`,
          execute: () =>
            this.executeGameCommand(
              tokenId,
              "system_buygold",
              { buyNum: 1 },
              `免费点金 ${i + 1}`,
            ),
        });
      }
    }

    if (
      isTaskEnabled("daily.claimHangUp") &&
      !isTaskCompleted(5) &&
      settings.claimHangUp
    ) {
      taskList.push({
        name: "领取挂机并加钟",
        execute: async () => {
          await this.executeGameCommand(
            tokenId,
            "system_claimhangupreward",
            {},
            "领取挂机奖励",
          );

          for (let i = 0; i < 4; i++) {
            await this.executeGameCommand(
              tokenId,
              "system_mysharecallback",
              { isSkipShareCard: true, type: 2 },
              `挂机加钟 ${i + 1}/4`,
            );
          }
        },
      });
    }

    if (
      isTaskEnabled("daily.openBox") &&
      !isTaskCompleted(7) &&
      settings.openBox
    ) {
      taskList.push({
        name: "智能开箱",
        execute: () => this.executeSmartOpenBox(tokenId),
      });
    }

    if (isTaskEnabled("daily.resetBottleTimer")) {
      taskList.push({
        name: "停止盐罐计时",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "bottlehelper_stop",
            {},
            "停止盐罐计时",
          ),
      });
      taskList.push({
        name: "开始盐罐计时",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "bottlehelper_start",
            {},
            "开始盐罐计时",
          ),
      });
    }

    if (
      isTaskEnabled("daily.claimBottle") &&
      !isTaskCompleted(14) &&
      settings.claimBottle
    ) {
      taskList.push({
        name: "领取盐罐奖励",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "bottlehelper_claim",
            {},
            "领取盐罐奖励",
          ),
      });
    }

    // 2. 竞技场
    if (
      isTaskEnabled("daily.arena") &&
      !isTaskCompleted(13) &&
      settings.arenaEnable
    ) {
      taskList.push({
        name: "竞技场战斗",
        skipErrorCodes: [200020],
        execute: async () => {
          this.log("开始竞技场战斗流程");
          const hour = new Date().getHours();
          if (hour < 6) {
            this.log("当前时间未到6点，跳过竞技场战斗", "warning");
            return;
          }
          if (hour > 22) {
            this.log("当前时间已过22点，跳过竞技场战斗", "warning");
            return;
          }

          if (settings.arenaFormation === "current") {
            this.log("竞技场阵容设置为维持当前，跳过阵容切换");
          } else {
            await this.switchToFormationIfNeeded(
              tokenId,
              settings.arenaFormation,
              "竞技场阵容",
            );
          }
          await this.executeGameCommand(
            tokenId,
            "arena_startarea",
            {},
            "开始竞技场",
          );

          for (let i = 1; i <= 3; i++) {
            this.log(`竞技场战斗 ${i}/3`);
            let targets;
            try {
              targets = await this.executeGameCommand(
                tokenId,
                "arena_getareatarget",
                {},
                `获取竞技场目标${i}`,
              );
            } catch (err) {
              if (isRateLimitError(err)) {
                throw err;
              }

              this.log(
                `竞技场战斗${i} - 获取对手失败: ${err.message}`,
                "error",
              );
              break;
            }

            const targetId = pickArenaTargetId(targets, {
              mode: settings.smartArenaMode || "lowestPower",
            });
            if (targetId) {
              await this.executeGameCommand(
                tokenId,
                "fight_startareaarena",
                { targetId },
                `竞技场战斗${i}`,
                10000,
              );
            } else {
              this.log(
                `竞技场战斗${i} - 未找到目标: ${JSON.stringify(targets)}`,
                "warning",
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        },
      });
    }

    // 3. BOSS
    if (isTaskEnabled("daily.legionBoss") && settings.bossTimes > 0) {
      let alreadyLegionBoss = statistics["legion:boss"] ?? 0;
      if (isTodayAvailable(statisticsTime["legion:boss"])) {
        alreadyLegionBoss = 0;
      }
      const remainingLegionBoss = Math.max(
        settings.bossTimes - alreadyLegionBoss,
        0,
      );

      if (remainingLegionBoss > 0) {
        taskList.push({
          name: "军团BOSS阵容检查",
          execute: () =>
            settings.bossFormation === "current"
              ? this.log("BOSS阵容设置为维持当前，跳过阵容切换")
              : this.switchToFormationIfNeeded(
                  tokenId,
                  settings.bossFormation,
                  "BOSS阵容",
                ),
        });
        for (let i = 0; i < remainingLegionBoss; i++) {
          taskList.push({
            name: `军团BOSS ${i + 1}/${remainingLegionBoss}`,
            execute: () =>
              this.executeGameCommand(
                tokenId,
                "fight_startlegionboss",
                {},
                `军团BOSS ${i + 1}`,
                12000,
              ),
          });
        }
      }
    }

    if (isTaskEnabled("daily.dailyBoss")) {
      const todayBossId = getTodayBossId();
      taskList.push({
        name: "每日BOSS阵容检查",
        execute: () =>
          settings.bossFormation === "current"
            ? this.log("BOSS阵容设置为维持当前，跳过阵容切换")
            : this.switchToFormationIfNeeded(
                tokenId,
                settings.bossFormation,
                "BOSS阵容",
              ),
      });
      for (let i = 0; i < 3; i++) {
        taskList.push({
          name: `每日BOSS ${i + 1}/3`,
          execute: () =>
            this.executeGameCommand(
              tokenId,
              "fight_startboss",
              { bossId: todayBossId },
              `每日BOSS ${i + 1}`,
              12000,
            ),
        });
      }
    }

    // 4. 固定奖励
    const fixedRewards = [
      {
        taskId: "daily.welfareSignIn",
        name: "福利签到",
        cmd: "system_signinreward",
      },
      { taskId: "daily.clubSignIn", name: "俱乐部", cmd: "legion_signin" },
      {
        taskId: "daily.discountGift",
        name: "领取每日礼包",
        cmd: "discount_claimreward",
      },
      {
        taskId: "daily.freeCardGift",
        name: "领取免费礼包",
        cmd: "card_claimreward",
      },
      {
        taskId: "daily.permanentCardGift",
        name: "领取永久卡礼包",
        cmd: "card_claimreward",
        params: { cardId: 4003 },
      },
    ];

    if (settings.claimEmail && isTaskEnabled("daily.claimEmail")) {
      fixedRewards.push({
        taskId: "daily.claimEmail",
        name: "领取邮件奖励",
        cmd: "mail_claimallattachment",
      });
    }

    fixedRewards.filter((reward) => isTaskEnabled(reward.taskId)).forEach((reward) => {
      taskList.push({
        name: reward.name,
        execute: () =>
          this.executeGameCommand(
            tokenId,
            reward.cmd,
            reward.params || {},
            reward.name,
          ),
      });
    });

    if (isCollectionGiftEnabled) {
      taskList.push({
        name: "开始领取珍宝阁礼包",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "collection_goodslist",
            {},
            "开始领取珍宝阁礼包",
          ),
      });
      taskList.push({
        name: "领取珍宝阁免费礼包",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "collection_claimfreereward",
            {},
            "领取珍宝阁免费礼包",
          ),
      });
    }

    if (
      isTaskEnabled("daily.freeGacha") &&
      settings.freeGachaEnable !== false &&
      isTodayAvailable(statisticsTime["gacha:free"])
    ) {
      taskList.push({
        name: "免费扭蛋",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "gacha_drawreward",
            { num: 1, isGroup: false },
            "免费扭蛋",
          ),
      });
    }

    // 5. 免费活动
    if (
      isTaskEnabled("daily.freeFishing") &&
      isTodayAvailable(statistics["artifact:normal:lottery:time"])
    ) {
      for (let i = 0; i < 3; i++) {
        taskList.push({
          name: `免费钓鱼 ${i + 1}/3`,
          execute: () =>
            this.executeGameCommand(
              tokenId,
              "artifact_lottery",
              { lotteryNumber: 1, newFree: true, type: 1 },
              `免费钓鱼 ${i + 1}`,
            ),
        });
      }
    }

    if (isTaskEnabled("daily.genieSweep")) {
      const kingdoms = ["魏国", "蜀国", "吴国", "群雄"];
      for (let gid = 1; gid <= 4; gid++) {
        if (isTodayAvailable(statisticsTime[`genie:daily:free:${gid}`])) {
          taskList.push({
            name: `${kingdoms[gid - 1]}灯神免费扫荡`,
            execute: () =>
              this.executeGameCommand(
                tokenId,
                "genie_sweep",
                { genieId: gid },
                `${kingdoms[gid - 1]}灯神免费扫荡`,
              ),
          });
        }
      }
    }

    if (isTaskEnabled("daily.freeGenieTickets")) {
      for (let i = 0; i < 3; i++) {
        taskList.push({
          name: `领取免费扫荡卷 ${i + 1}/3`,
          execute: () =>
            this.executeGameCommand(
              tokenId,
              "genie_buysweep",
              {},
              `领取免费扫荡卷 ${i + 1}`,
            ),
        });
      }
    }

    // 6. 智能黑市购物
    if (
      isTaskEnabled("daily.blackMarket") &&
      !isTaskCompleted(12) &&
      settings.blackMarketPurchase
    ) {
      taskList.push({
        name: "智能黑市购物",
        execute: () => this.executeSmartBlackMarket(tokenId),
      });
    }

    // 咸王梦境
    const mengyandayOfWeek = new Date().getDay();
    if (
      isTaskEnabled("daily.dream") &&
      [0, 1, 3, 4].includes(mengyandayOfWeek)
    ) {
      const mjbattleTeam = { 0: 107 };
      taskList.push({
        name: "咸王梦境",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "dungeon_selecthero",
            { battleTeam: mjbattleTeam },
            "咸王梦境",
          ),
      });
    }

    // 深海灯神
    if (
      isTaskEnabled("daily.deepSeaGenie") &&
      mengyandayOfWeek === 1 &&
      isTodayAvailable(statisticsTime[`genie:daily:free:5`])
    ) {
      taskList.push({
        name: "深海灯神",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "genie_sweep",
            { genieId: 5, sweepCnt: 1 },
            "深海灯神",
          ),
      });
    }

    // 阵容还原
    if (isTaskEnabled("daily.restoreFormation") && originalFormation) {
      taskList.push({
        name: "阵容还原",
        execute: () =>
          this.switchToFormationIfNeeded(
            tokenId,
            originalFormation,
            "初始阵容",
          ),
      });
    }

    // 7. 每日任务奖励：先领取各项积分奖励，再领取每日完成奖励
    if (isTaskEnabled("daily.dailyRewards")) {
      taskList.push(...this.createDailyTaskRewardTasks(tokenId));
    }
    if (isTaskEnabled("daily.weeklyReward")) {
      taskList.push({
        name: "领取周常任务奖励",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "task_claimweekreward",
            {},
            "领取周常任务奖励",
          ),
      });
    }
    if (isTaskEnabled("daily.passReward")) {
      taskList.push({
        name: "领取通行证奖励",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "activity_recyclewarorderrewardclaim",
            { actId: 1 },
            "领取通行证奖励",
          ),
      });
    }

    // 执行
    const totalTasks = taskList.length;
    const dailyRewardStartIndex = taskList.findIndex(
      (task) => task.name === "领取每日任务积分奖励1",
    );
    const dailyRewardStartPosition =
      dailyRewardStartIndex >= 0
        ? `${dailyRewardStartIndex + 1}/${totalTasks}`
        : "未找到";

    this.log(
      `任务队列已生成: 共 ${totalTasks} 项；每日任务奖励阶段起点=${dailyRewardStartPosition}`,
    );

    for (let i = 0; i < taskList.length; i++) {
      const task = taskList[i];
      const taskPosition = `${i + 1}/${totalTasks}`;

      if (isStopped()) {
        this.log(
          `[任务 ${taskPosition}] 执行前检测到停止，未执行: ${task.name}`,
          "warning",
        );
        return { success: false, stopped: true, failedTask: task.name };
      }

      if (i === dailyRewardStartIndex) {
        this.log(
          `[奖励阶段] 开始领取每日任务积分/完成奖励（任务 ${taskPosition}）`,
          "info",
        );
      }

      this.log(`[任务 ${taskPosition}] 开始: ${task.name}`);

      for (;;) {
        try {
          await task.execute();
          const progress = Math.floor(((i + 1) / totalTasks) * 100);
          if (this.callbacks?.onProgress) this.callbacks.onProgress(progress);
          await new Promise((resolve) => setTimeout(resolve, this.delaySettings.taskDelay));
          break;
        } catch (error) {
          if (isStopped()) {
            return {
              success: false,
              stopped: true,
              failedTask: task.name,
              error,
            };
          }

          const skipReason = isRateLimitError(error)
            ? "任务触发限流，跳过当前任务继续执行"
            : isSkippableTaskError(error, task)
              ? "当前角色未开启该模块，跳过任务继续执行"
              : "任务失败，跳过当前任务继续执行";

          this.log(
            `[任务 ${taskPosition}] ${skipReason}: ${task.name} | ${getErrorDetails(error)}`,
            "warning",
          );
          const progress = Math.floor(((i + 1) / totalTasks) * 100);
          if (this.callbacks?.onProgress) this.callbacks.onProgress(progress);
          await new Promise((resolve) => setTimeout(resolve, this.delaySettings.taskDelay));
          break;
        }
      }
    }

    if (this.callbacks?.onProgress) this.callbacks.onProgress(100);
    this.log("所有任务执行完成", "success");
    return { success: true, stopped: false };
  }
}
