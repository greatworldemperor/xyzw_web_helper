import { getTowerActId } from "../towerActId.js";
import {
  is400340Error,
  RATE_LIMIT_MAX_RETRIES,
} from "../helperTaskRunner.js";

/**
 * 爬塔类任务
 * 包含: climbTower, climbWeirdTower, batchClaimFreeEnergy
 */
import { normalizeWeirdTowerMaxClimb } from "../towerClimbLimit.js";
import {
  normalizeSkinChallengeTargets,
  selectSkinChallengeTargets,
} from "./skinChallengeUtils.js";

/**
 * 补领怪异塔未领取的章节通关奖励
 *
 * evoTower.towerId 是层号（如 240 表示已通关第 24 章），rewardTowerId 是已领取到的章号。
 * 两者不一致说明有章节奖励未领取，此时游戏服会拒绝 evotower_readyfight 并返回 12200020，
 * 导致爬塔无法开始。故需在爬塔前按 rewardTowerId 主动补齐。
 *
 * @param {Object} tokenStore - token store
 * @param {string} tokenId - token id
 * @param {Object} evoTower - evotower_getinfo 返回的 evoTower 对象
 * @param {Function} onLog - 日志回调 (message, type) => void
 * @returns {Promise<number>} 实际补领的章节数
 */
async function claimPendingEvoTowerRewards(tokenStore, tokenId, evoTower, onLog) {
  const towerId = Number(evoTower?.towerId ?? 0);
  const rewardTowerId = Number(evoTower?.rewardTowerId ?? 0);
  if (!towerId) {
    return 0;
  }

  const clearedChapter = Math.floor(towerId / 10);
  let pending = clearedChapter - rewardTowerId;
  if (pending <= 0) {
    return 0;
  }

  onLog?.(
    `检测到 ${pending} 个未领取的章节通关奖励（已通关第 ${clearedChapter} 章，已领至第 ${rewardTowerId} 章），先行补领`,
    "warning",
  );

  let claimed = 0;
  while (pending > 0) {
    try {
      const res = await tokenStore.sendMessageWithPromise(
        tokenId,
        "evotower_claimreward",
        {},
        5000,
      );
      claimed++;
      pending--;
      onLog?.(`已领取第 ${res?.evoTower?.rewardTowerId ?? rewardTowerId + claimed} 章通关奖励`, "success");
      await new Promise((r) => setTimeout(r, 300));
    } catch (error) {
      // 领奖失败则停止：继续爬塔只会持续返回 12200020
      onLog?.(
        `领取章节奖励失败，已补领 ${claimed}/${claimed + pending} 个：${error?.message || error}`,
        "error",
      );
      break;
    }
  }
  return claimed;
}

/**
 * 创建爬塔类任务执行器
 * @param {Object} deps - 依赖项
 * @returns {Object} 任务函数集合
 */
export function createTasksTower(deps) {
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
    sendRoleInfo: batchSendRoleInfo,
    addLog,
    message,
    currentRunningTokenId,
    currentSettings,
    loadSettings,
    weirdTowerMaxClimb,
  } = deps;

  const sendRoleInfo =
    batchSendRoleInfo ||
    ((tokenId, params = {}) =>
      typeof tokenStore.sendGetRoleInfo === "function"
        ? tokenStore.sendGetRoleInfo(tokenId, params)
        : tokenStore.sendMessageWithPromise(
            tokenId,
            "role_getroleinfo",
            params,
          ));

  const isMergeBoxFullError = (error) => {
    const errorText = [
      error?.message,
      error?.code,
      error?.errorCode,
      error?.hint,
      error?.response?.data?.code,
      error?.response?.data?.message,
    ]
      .filter((value) => value !== undefined && value !== null)
      .join(" ");

    return errorText.includes("12300040") || errorText.includes("没有空格子了");
  };

  const mergeItemsForToken = async (
    tokenId,
    tokenName,
    { logNoMerge = true } = {},
  ) => {
    let loopCount = 0;
    let mergedCount = 0;
    const MAX_LOOPS = 20;

    while (loopCount < MAX_LOOPS && !shouldStop.value) {
      loopCount++;

      const infoRes = await tokenStore.sendMessageWithPromise(
        tokenId,
        "mergebox_getinfo",
        { actType: 1 },
        5000,
      );

      if (!infoRes || !infoRes.mergeBox) {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${tokenName} 返回数据缺少 mergeBox`,
          type: "warning",
        });
        break;
      }

      if (infoRes.mergeBox.taskMap) {
        const taskMap = infoRes.mergeBox.taskMap;
        const taskClaimMap = infoRes.mergeBox.taskClaimMap || {};
        const rewardMapping = {
          2: { name: "短裙手套", reward: "10随机红色碎片" },
          3: { name: "拽拽菜篮", reward: "2黄金鱼竿" },
          4: { name: "狂野菜板", reward: "2招募令" },
          5: { name: "大胃锅", reward: "2珍珠" },
          6: { name: "幽影茶壶", reward: "5皮肤币" },
          7: { name: "愤怒面包机", reward: "2珍珠" },
          8: { name: "惊讶榨汁机", reward: "1四圣宝珠碎片" },
          9: { name: "动感电饭锅", reward: "5000白玉" },
          10: { name: "迅捷烤炉", reward: "12珍珠" },
          11: { name: "至尊打蛋机", reward: "15彩玉" },
          12: { name: "完美烤炉", reward: "24珍珠" },
        };

        for (const taskId in taskMap) {
          if (shouldStop.value) break;
          if (taskMap[taskId] !== 0 && !taskClaimMap[taskId]) {
            await tokenStore
              .sendMessageWithPromise(
                tokenId,
                "mergebox_claimmergeprogress",
                { actType: 1, taskId: parseInt(taskId) },
                2000,
              )
              .catch(() => {});

            const idStr = String(taskId);
            const lastTwo = parseInt(idStr.slice(-2));
            const taskInfo = rewardMapping[lastTwo];
            const taskDesc = taskInfo
              ? `${lastTwo}级 ${taskInfo.reward ? " 奖励" + taskInfo.reward : ""}`
              : `任务${taskId}`;

            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${tokenName} 领取合成奖励: ${taskDesc}`,
              type: "success",
            });
            await new Promise((res) => setTimeout(res, 500));
          }
        }
      }

      const gridMap = infoRes.mergeBox.gridMap || {};
      const items = [];

      for (const xStr in gridMap) {
        for (const yStr in gridMap[xStr]) {
          const item = gridMap[xStr][yStr];
          if (item.gridConfId == 0 && item.gridItemId > 0 && !item.isLock) {
            items.push({
              x: parseInt(xStr),
              y: parseInt(yStr),
              id: item.gridItemId,
            });
          }
        }
      }

      const groupedItems = {};
      items.forEach((item) => {
        if (!groupedItems[item.id]) {
          groupedItems[item.id] = [];
        }
        groupedItems[item.id].push(item);
      });

      const hasPotentialMerge = Object.values(groupedItems).some(
        (group) => group.length >= 2,
      );

      if (!hasPotentialMerge) {
        if (logNoMerge && loopCount === 1) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${tokenName} 当前没有可合成的物品`,
            type: "info",
          });
        }
        break;
      }

      const isLevel8OrAbove =
        infoRes.mergeBox.taskMap &&
        infoRes.mergeBox.taskMap["251212208"] &&
        infoRes.mergeBox.taskMap["251212208"] !== 0;

      if (isLevel8OrAbove) {
        await tokenStore.sendMessageWithPromise(
          tokenId,
          "mergebox_automergeitem",
          { actType: 1 },
          10000,
        );
        mergedCount++;
        await new Promise((res) => setTimeout(res, 1500));
      } else {
        for (const id in groupedItems) {
          if (shouldStop.value) break;
          const group = groupedItems[id];
          while (group.length >= 2) {
            if (shouldStop.value) break;
            const source = group.shift();
            const target = group.shift();

            try {
              await tokenStore.sendMessageWithPromise(
                tokenId,
                "mergebox_mergeitem",
                {
                  actType: 1,
                  sourcePos: { gridX: source.x, gridY: source.y },
                  targetPos: { gridX: target.x, gridY: target.y },
                },
                1000,
              );
              mergedCount++;
            } catch {}
            await new Promise((res) => setTimeout(res, 300));
          }
        }
      }

      await new Promise((res) => setTimeout(res, 500));
    }

    return mergedCount;
  };

  const claimFreeEnergyForToken = async (tokenId, tokenName) => {
    const freeEnergyResult = await tokenStore.sendMessageWithPromise(
      tokenId,
      "mergebox_getinfo",
      { actType: 1 },
      5000,
    );

    if (!freeEnergyResult?.mergeBox) {
      throw new Error("获取活动信息失败");
    }

    const freeEnergy = freeEnergyResult.mergeBox.freeEnergy || 0;
    if (freeEnergy > 0) {
      await tokenStore.sendMessageWithPromise(
        tokenId,
        "mergebox_claimfreeenergy",
        { actType: 1 },
        5000,
      );
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `=== ${tokenName} 成功领取免费道具${freeEnergy}个 ===`,
        type: "success",
      });
    } else {
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `=== ${tokenName} 暂无免费道具可领取 ===`,
        type: "info",
      });
    }

    return freeEnergy;
  };

  const useItemsForToken = async (tokenId, tokenName) => {
    const infoRes = await tokenStore.sendMessageWithPromise(
      tokenId,
      "mergebox_getinfo",
      { actType: 1 },
      5000,
    );
    const towerInfoRes = await tokenStore.sendMessageWithPromise(
      tokenId,
      "evotower_getinfo",
      {},
      5000,
    );

    if (!infoRes?.mergeBox) {
      throw new Error("获取活动信息失败");
    }

    let costTotalCnt = infoRes.mergeBox.costTotalCnt || 0;
    let lotteryLeftCnt = towerInfoRes?.evoTower?.lotteryLeftCnt || 0;
    let processedCount = 0;
    let reachedFull = false;

    if (lotteryLeftCnt > 0) {
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `${tokenName} 开始使用道具，剩余：${lotteryLeftCnt}，已用：${costTotalCnt}`,
        type: "info",
      });
    } else {
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `${tokenName} 没有剩余道具可使用`,
        type: "info",
      });
    }

    while (lotteryLeftCnt > 0 && !shouldStop.value) {
      let pos = {};
      if (costTotalCnt < 2) {
        pos = { gridX: 4, gridY: 5 };
      } else if (costTotalCnt < 102) {
        pos = { gridX: 7, gridY: 3 };
      } else {
        pos = { gridX: 6, gridY: 3 };
      }

      try {
        await tokenStore.sendMessageWithPromise(
          tokenId,
          "mergebox_openbox",
          {
            actType: 1,
            pos,
          },
          5000,
        );
      } catch (error) {
        if (!isMergeBoxFullError(error)) {
          throw error;
        }

        reachedFull = true;
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${tokenName} 格子已满，开始合成物品`,
          type: "info",
        });
        break;
      }

      costTotalCnt++;
      lotteryLeftCnt--;
      processedCount++;
      await new Promise((res) => setTimeout(res, 500));
    }

    await tokenStore
      .sendMessageWithPromise(
        tokenId,
        "mergebox_claimcostprogress",
        { actType: 1 },
        5000,
      )
      .catch(() => {});
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `${tokenName} 尝试领取累计使用奖励`,
      type: "info",
    });

    return {
      costTotalCnt,
      lotteryLeftCnt,
      processedCount,
      reachedFull,
    };
  };

  /**
   * 爬塔
   */
  const climbTower = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);
      // 加载该Token的独立配置，如果未找到则回退到currentSettings
      const tokenSettings = loadSettings ? (loadSettings(tokenId) || currentSettings) : currentSettings;

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始爬塔: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        const teamInfo = await tokenStore.sendMessageWithPromise(
          tokenId,
          "presetteam_getinfo",
          {},
          5000,
        );
        if (!teamInfo || !teamInfo.presetTeamInfo) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `阵容信息异常: ${JSON.stringify(teamInfo)}`,
            type: "warning",
          });
        }

        const currentFormation = teamInfo?.presetTeamInfo?.useTeamId;
        let Isswitching = false;
        if (currentFormation === tokenSettings.towerFormation) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `当前已是阵容${tokenSettings.towerFormation}，无需切换`,
            type: "info",
          });
        } else {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "presetteam_saveteam",
            { teamId: tokenSettings.towerFormation },
            5000,
          );
          Isswitching = true;
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `成功切换到阵容${tokenSettings.towerFormation}`,
            type: "info",
          });
        }

        // Initial check
        await tokenStore
          .sendMessageWithPromise(tokenId, "tower_getinfo", {}, 5000)
          .catch(() => {});
        let roleInfo = await sendRoleInfo(tokenId);
        let energy = roleInfo?.role?.tower?.energy || 0;
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 初始体力: ${energy}`,
          type: "info",
        });

        let count = 0;
        const MAX_CLIMB = 100;
        let consecutiveFailures = 0;

        while (energy > 0 && count < MAX_CLIMB && !shouldStop.value) {
          try {
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "fight_starttower",
              {},
              5000,
            );
            count++;
            consecutiveFailures = 0;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 爬塔第 ${count} 次`,
              type: "info",
            });

            await new Promise((r) => setTimeout(r, 1000));

            // Refresh energy
            // 默认每5次刷新一次，或体力不足时刷新
            if (count % 5 === 0) {
               try {
                  roleInfo = await sendRoleInfo(tokenId);
                  energy = roleInfo?.role?.tower?.energy || 0;
               } catch (e) {
                 if (e?.code === "ROLE_INFO_RECOVERY_FAILED") throw e;
                 // 忽略刷新失败
               }
            } else {
               // 尝试从本地缓存获取最新的体力信息（如果其他地方更新了）
               const storeRoleInfo = tokenStore.gameData?.roleInfo;
               const storeEnergy = storeRoleInfo?.role?.tower?.energy;
               
               // 如果store中的体力大于当前预计剩余体力，说明可能有额外恢复/奖励，使用store的值
               if (storeEnergy !== undefined && storeEnergy > (energy - 1)) {
                   energy = storeEnergy;
               } else {
                   // 本地扣除体力
                   energy--;
               }
            }
          } catch (err) {
            if (is400340Error(err)) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 触发400340冷却，已按每秒重试${RATE_LIMIT_MAX_RETRIES}次仍失败，停止爬塔`,
                type: "error",
              });
              break;
            }

            if (err.message && err.message.includes("200400")) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 操作过快 (200400)，等待5秒后重试...`,
                type: "warning",
              });
              await new Promise((r) => setTimeout(r, 5000));
              continue;
            }

            // 处理"上座塔奖励未领取"错误 (1500040)
            if (err.message && err.message.includes("1500040")) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 上座塔奖励未领取，尝试自动领取并等待...`,
                type: "warning",
              });
              
              // 尝试获取当前塔层数
              try {
                // 如果本地没有roleInfo，尝试获取一次
                if (!roleInfo) {
                   roleInfo = await sendRoleInfo(tokenId);
                }
                const towerId = roleInfo?.role?.tower?.id;
                
                if (towerId !== undefined) {
                   const rewardFloor = Math.floor(towerId / 10);
                   if (rewardFloor > 0) {
                      addLog({
                        time: new Date().toLocaleTimeString(),
                        message: `${token.name} 尝试领取第 ${rewardFloor} 层奖励`,
                        type: "info",
                      });
                      // 发送领取请求，不等待响应，因为可能通过事件处理了
                      tokenStore.sendMessage(tokenId, "tower_claimreward", { rewardId: rewardFloor });
                   }
                }
                } catch (e) {
                  if (e?.code === "ROLE_INFO_RECOVERY_FAILED") throw e;
                 // 忽略获取信息失败
              }

              // 等待较长时间让领取生效
              await new Promise((r) => setTimeout(r, 3000));
              
              // 刷新角色信息以更新状态
              try {
                 roleInfo = await sendRoleInfo(tokenId);
                 energy = roleInfo?.role?.tower?.energy || 0;
              } catch (e) {
                if (e?.code === "ROLE_INFO_RECOVERY_FAILED") throw e;
              }

              // 重置连续失败计数，因为这是一个可恢复的错误
              consecutiveFailures = 0;
              continue;
            }

            consecutiveFailures++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `战斗出错: ${err.message} (重试 ${consecutiveFailures}/3)`,
              type: "warning",
            });

            if (consecutiveFailures >= 3) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 连续失败次数过多，停止爬塔`,
                type: "error",
              });
              break;
            }

            await new Promise((r) => setTimeout(r, 2000));

            try {
              roleInfo = await sendRoleInfo(tokenId);
              energy = roleInfo?.role?.tower?.energy || 0;
            } catch (e) {
              if (e?.code === "ROLE_INFO_RECOVERY_FAILED") throw e;
              // 忽略刷新失败
            }
          }
        }
        if (Isswitching) {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "presetteam_saveteam",
            { teamId: currentFormation },
            5000,
          );
        }
        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 爬塔结束，共 ${count} 次 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 爬塔失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量爬塔结束");
  };

  /**
   * 爬怪异塔
   */
  const climbWeirdTower = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);
      // 加载该Token的独立配置，如果未找到则回退到currentSettings
      const tokenSettings = loadSettings ? (loadSettings(tokenId) || currentSettings) : currentSettings;

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始爬怪异塔: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        const teamInfo = await tokenStore.sendMessageWithPromise(
          tokenId,
          "presetteam_getinfo",
          {},
          5000,
        );
        if (!teamInfo || !teamInfo.presetTeamInfo) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `阵容信息异常: ${JSON.stringify(teamInfo)}`,
            type: "warning",
          });
        }

        const currentFormation = teamInfo?.presetTeamInfo?.useTeamId;
        let Isswitching = false;
        if (currentFormation === tokenSettings.towerFormation) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `当前已是阵容${tokenSettings.towerFormation}，无需切换`,
            type: "info",
          });
        } else {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "presetteam_saveteam",
            { teamId: tokenSettings.towerFormation },
            5000,
          );
          Isswitching = true;
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `成功切换到阵容${tokenSettings.towerFormation}`,
            type: "info",
          });
        }

        // 获取怪异塔信息
        const evotowerinfo1 = await tokenStore.sendMessageWithPromise(
          tokenId,
          "evotower_getinfo",
          {},
          5000,
        );

        let currentEnergy = evotowerinfo1?.evoTower?.energy;

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 初始能量: ${currentEnergy}`,
          type: "info",
        });

        // 爬塔前先补领未领取的章节奖励，否则 evotower_readyfight 会被拒绝（12200020）
        await claimPendingEvoTowerRewards(
          tokenStore,
          tokenId,
          evotowerinfo1?.evoTower,
          (message, type) => addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} ${message}`,
            type,
          }),
        );

        let count = 0;
        const MAX_CLIMB = normalizeWeirdTowerMaxClimb(
          weirdTowerMaxClimb?.value ?? weirdTowerMaxClimb,
        );
        let consecutiveFailures = 0;

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 本次最多爬怪异塔 ${MAX_CLIMB} 次`,
          type: "info",
        });

        while (currentEnergy > 0 && count < MAX_CLIMB && !shouldStop.value) {
          try {
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "evotower_readyfight",
              {},
              5000,
            );

            await tokenStore.sendMessageWithPromise(
              tokenId,
              "evotower_fight",
              {
                battleNum: 1,
                winNum: 1,
              },
              10000,
            );

            count++;
            consecutiveFailures = 0;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 爬怪异塔第 ${count} 次`,
              type: "info",
            });

            await new Promise((r) => setTimeout(r, 500));

            const evotowerinfo2 = await tokenStore.sendMessageWithPromise(
              tokenId,
              "evotower_getinfo",
              {},
              5000,
            );

            // 检查并领取每日任务奖励
            if (evotowerinfo2 && evotowerinfo2.evoTower && evotowerinfo2.evoTower.taskClaimMap) {
                 const now = new Date();
                 const year = now.getFullYear().toString().slice(2);
                 const month = (now.getMonth() + 1).toString().padStart(2, '0');
                 const day = now.getDate().toString().padStart(2, '0');
                 const dateKey = `${year}${month}${day}`;
                 
                 const dailyTasks = evotowerinfo2.evoTower.taskClaimMap[dateKey] || {};
                 const taskIds = [1, 2, 3];
                 
                 for (const taskId of taskIds) {
                    if (!dailyTasks[taskId]) {
                      await tokenStore.sendMessageWithPromise(
                        tokenId,
                        "evotower_claimtask",
                        { taskId: taskId },
                        2000
                      ).then(() => {
                         addLog({
                            time: new Date().toLocaleTimeString(),
                            message: `${token.name} 领取每日任务奖励 ${taskId} 成功`,
                            type: "success",
                         });
                      }).catch(() => {});
                      await new Promise(r => setTimeout(r, 200)); 
                    }
                 }
            }

            // 通关章节奖励：以 rewardTowerId 为准判断是否有未领取的章节
            // （原按 (towerId % 10) + 1 === 1 判断，towerId 为 10 的整数倍时恒成立，
            //   会重复发送领奖命令，且无法感知历史未领取的章节）
            await claimPendingEvoTowerRewards(
              tokenStore,
              tokenId,
              evotowerinfo2?.evoTower,
              (message, type) => addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} ${message}`,
                type,
              }),
            );

            // 刷新能量
            try {
              const evotowerinfoRefresh1 = await tokenStore.sendMessageWithPromise(
                tokenId,
                "evotower_getinfo",
                {},
                5000,
              );
              currentEnergy = evotowerinfoRefresh1?.evoTower?.energy || 0;
            } catch (e) {
              // 忽略刷新失败
            }
          } catch (err) {
            if (is400340Error(err)) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 触发400340冷却，已按每秒重试${RATE_LIMIT_MAX_RETRIES}次仍失败，停止爬怪异塔`,
                type: "error",
              });
              break;
            }

            consecutiveFailures++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `战斗出错: ${err.message} (重试 ${consecutiveFailures}/3)`,
              type: "warning",
            });

            if (consecutiveFailures >= 3) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 连续失败次数过多，停止爬怪异塔`,
                type: "error",
              });
              break;
            }

            await new Promise((r) => setTimeout(r, 1000));

            try {
              const evotowerinfoRefresh2 = await tokenStore.sendMessageWithPromise(
                tokenId,
                "evotower_getinfo",
                {},
                5000,
              );
              currentEnergy = evotowerinfoRefresh2?.evoTower?.energy || 0;
            } catch (e) {
              // 忽略刷新失败
            }
          }
        }
        if (Isswitching) {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "presetteam_saveteam",
            { teamId: currentFormation },
            5000,
          );
        }
        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 爬怪异塔结束，共 ${count} 次 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: is400340Error(error)
            ? `${token.name} 触发400340冷却，已按每秒重试${RATE_LIMIT_MAX_RETRIES}次仍失败，停止爬怪异塔`
            : `${token.name} 爬怪异塔失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量爬怪异塔结束");
  };

  /**
   * 领取怪异塔免费道具
   */
  const batchClaimFreeEnergy = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);
      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始领取怪异塔免费道具: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);
        await claimFreeEnergyForToken(tokenId, token.name);

        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 领取免费道具失败: ${error.message || "未知错误"}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量领取怪异塔免费道具结束");
  };

  /**
   * 换皮闯关
   */
  const skinChallenge = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);
      const tokenSettings = loadSettings
        ? loadSettings(tokenId) || currentSettings
        : currentSettings;

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始换皮闯关: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        // 获取活动信息
        let res = await tokenStore.sendMessageWithPromise(
          tokenId,
          "towers_getinfo",
          { actId: getTowerActId() },
          5000
        );
        
        let towerData = res.actId ? res : (res.towerData && res.towerData.actId ? res.towerData : res);

        // 检查活动是否有效
        if (!towerData.actId) {
           addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 换皮闯关活动信息获取失败`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "failed";
          return;
        }

        const actId = String(towerData.actId);
        if (actId.length >= 6) {
           const year = "20" + actId.substring(0, 2);
           const month = actId.substring(2, 4);
           const day = actId.substring(4, 6);
           const startDate = new Date(`${year}-${month}-${day}T00:00:00`);
           const endDate = new Date(startDate);
           endDate.setDate(startDate.getDate() + 7);
           const now = new Date();
           if (now < startDate || now >= endDate) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 换皮闯关活动已结束`,
                type: "warning",
              });
              tokenStatus.value[tokenId] = "completed";
              return;
           }
        }

        let levelRewardMap = towerData.levelRewardMap || {};
        
        // 计算今日开放的BOSS
        const todayWeekDay = new Date().getDay(); // 0-6 (Sun-Sat)
        const openTowerMap = {
          5: [1], // Friday
          6: [2], // Saturday
          0: [3], // Sunday
          1: [4], // Monday
          2: [5], // Tuesday
          3: [6], // Wednesday
          4: [1, 2, 3, 4, 5, 6] // Thursday (All open)
        };
        const todayOpenTowers = openTowerMap[todayWeekDay] || [];

        // 辅助函数：判断是否已通关
        const isTowerCleared = (type, map) => {
          const key1 = `${type}008`;
          const key2 = Number(key1);
          return !!(map[key1] || map[key2]);
        };
        
        // 辅助函数：获取当前层数
        const getTowerLevel = (type, map) => {
           for (let i = 8; i >= 1; i--) {
            const key1 = `${type}00${i}`;
            const key2 = Number(key1);
            if (map[key1] || map[key2]) {
                if (i === 8) return 8;
                return i + 1;
            }
          }
          return 1;
        };

        const selectedTargetTowers = normalizeSkinChallengeTargets(
          tokenSettings?.skinChallengeTargets,
        );
        const selectedOpenTowers = todayOpenTowers.filter((type) =>
          selectedTargetTowers.includes(type),
        );
        const targetTowers = selectSkinChallengeTargets(
          todayOpenTowers,
          selectedTargetTowers,
          (type) => isTowerCleared(type, levelRewardMap),
        );

        if (todayWeekDay === 4) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 周四指定挑战BOSS: ${selectedTargetTowers.length > 0 ? selectedTargetTowers.join(", ") : "无"}，检测到需补打BOSS: ${targetTowers.length > 0 ? targetTowers.join(", ") : "无"}`,
            type: "info",
          });
        } else if (selectedOpenTowers.length === 0 && todayOpenTowers.length > 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 未指定今日开放的BOSS，跳过挑战`,
            type: "info",
          });
        } else if (targetTowers.length === 0 && selectedOpenTowers.length > 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 今日指定BOSS已通关`,
            type: "info",
          });
        }

        if (targetTowers.length === 0) {
             tokenStatus.value[tokenId] = "completed";
             addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 换皮闯关结束 (无需挑战) ===`,
                type: "success",
             });
             return;
        }

        for (const type of targetTowers) {
            if (shouldStop.value) break;

            addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 开始挑战 BOSS ${type}`,
                type: "info",
            });

            let needStart = true;
            let loop = true;
            let failCount = 0;

            while (loop && !shouldStop.value) {
                if (needStart) {
                    await tokenStore.sendMessageWithPromise(tokenId, "towers_start", { actId: getTowerActId(), towerType: type }, 5000);
                    // 稍微等待一下
                    await new Promise(r => setTimeout(r, 500));
                }

                const fightRes = await tokenStore.sendMessageWithPromise(tokenId, "towers_fight", { actId: getTowerActId(), towerType: type }, 5000);
                const battleData = fightRes?.battleData;
                const curHP = battleData?.result?.accept?.ext?.curHP;
                
                const currentLevel = getTowerLevel(type, levelRewardMap);

                if (curHP === 0) {
                     addLog({
                        time: new Date().toLocaleTimeString(),
                        message: `${token.name} BOSS ${type} 第 ${currentLevel} 层挑战成功`,
                        type: "success",
                     });

                     needStart = false;
                     failCount = 0;

                     // 刷新数据
                     res = await tokenStore.sendMessageWithPromise(tokenId, "towers_getinfo", { actId: getTowerActId() }, 5000);
                     towerData = res.actId ? res : (res.towerData && res.towerData.actId ? res.towerData : res);
                     levelRewardMap = towerData.levelRewardMap || {};

                     if (isTowerCleared(type, levelRewardMap)) {
                        loop = false;
                        addLog({
                            time: new Date().toLocaleTimeString(),
                            message: `${token.name} BOSS ${type} 全部通关`,
                            type: "success",
                        });
                     } else {
                        await new Promise(r => setTimeout(r, 1000));
                     }
                } else {
                     addLog({
                        time: new Date().toLocaleTimeString(),
                        message: `${token.name} BOSS ${type} 第 ${currentLevel} 层挑战失败`,
                        type: "warning",
                     });

                     needStart = true;
                     failCount++;

                     if (failCount >= 3) {
                         addLog({
                            time: new Date().toLocaleTimeString(),
                            message: `${token.name} BOSS ${type} 连续失败3次，跳过`,
                            type: "error",
                         });
                         loop = false;
                     } else {
                        await new Promise(r => setTimeout(r, 1000));
                     }
                }
            }
        }

        // 闯关结束后循环领取奖励
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 闯关结束，开始领取奖励`,
          type: "info",
        });
        let claimCount = 0;
        const claimActId = Number(actId) % 10 === 1 ? Number(actId) + 1 : Number(actId);
          try {
            while (!shouldStop.value) {
              await tokenStore.sendMessageWithPromise(
                tokenId,
                "activity_startactegame",
                { actId: claimActId },
                5000,
              );
              claimCount++;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 活动 ${claimActId} 领取奖励第 ${claimCount} 次`,
                type: "success",
              });
              await new Promise((r) => setTimeout(r, 300));
            }
          } catch (e) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 活动 ${claimActId} 领取结束（共 ${claimCount} 次）`,
              type: claimCount > 0 ? "success" : "info",
            });
          }
        if (claimCount > 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 领取奖励 ${claimCount} 次`,
            type: "success",
          });
        }

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 换皮闯关结束 ===`,
          type: "success",
        });

      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";

        let errorMessage = error.message;
        if (is400340Error(error)) {
          errorMessage = `触发400340限流，已按每秒重试${RATE_LIMIT_MAX_RETRIES}次仍失败，跳过该账号`;
        } else if (errorMessage && errorMessage.includes("200330")) {
           errorMessage = "存在未完成的挑战，需要手动处理";
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 换皮闯关失败: ${errorMessage}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 断开连接`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
  };

  /**
   * 批量使用道具
   */
  const batchUseItems = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始使用道具: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);
        const { processedCount } = await useItemsForToken(tokenId, token.name);

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 使用道具结束，共使用 ${processedCount} 次 ===`,
          type: "success",
        });

      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 使用道具失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 断开连接`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量使用道具结束");
  };

  /**
   * 批量合成
   */
  const batchMergeItems = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始一键合成: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);
        const mergedCount = await mergeItemsForToken(tokenId, token.name);

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 一键合成完成，共合成 ${mergedCount} 次 ===`,
          type: "success",
        });

      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 一键合成失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 断开连接`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量一键合成结束");
  };

  /**
   * 智能处理怪异塔道具：先领取免费道具，再交替使用和合成。
   */
  const batchSmartItemHandling = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始智能处理怪异塔道具: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        await claimFreeEnergyForToken(tokenId, token.name);

        let totalProcessedCount = 0;
        let totalMergedCount = 0;
        let cycleCount = 0;
        const MAX_SMART_CYCLES = 100;

        while (cycleCount < MAX_SMART_CYCLES && !shouldStop.value) {
          cycleCount++;
          const useResult = await useItemsForToken(tokenId, token.name);
          totalProcessedCount += useResult.processedCount;

          const mergedCount = await mergeItemsForToken(tokenId, token.name, {
            logNoMerge: cycleCount === 1,
          });
          totalMergedCount += mergedCount;

          if (useResult.lotteryLeftCnt <= 0) {
            break;
          }

          if (useResult.reachedFull && mergedCount === 0) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 格子已满且没有可合成物品，停止智能处理`,
              type: "warning",
            });
            break;
          }
        }

        if (cycleCount >= MAX_SMART_CYCLES && !shouldStop.value) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 智能处理达到循环安全上限，停止继续请求`,
            type: "warning",
          });
        }

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 智能道具处理完成，共使用 ${totalProcessedCount} 次，合成 ${totalMergedCount} 次 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 智能道具处理失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 断开连接`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量智能道具处理结束");
  };

  return {
    climbTower,
    climbWeirdTower,
    batchClaimFreeEnergy,
    skinChallenge,
    batchUseItems,
    batchMergeItems,
    batchSmartItemHandling,
  };
}

/**
 * 批量使用道具
 * @param {Object} deps
 */
function batchUseItems(deps) {
  // logic to be implemented inside createTasksTower or moved here if refactored
  // But based on the file structure, I should add it inside createTasksTower
}
