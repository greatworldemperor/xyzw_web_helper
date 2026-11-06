/**
 * 竞技场、补齐类任务
 * 包含: batcharenafight, batchTopUpFish, batchTopUpArena
 */

import { FISH_TARGET, ARENA_TARGET } from "./constants.js";
import { calcSmartTopUpTargets } from "./smartTopUp.js";
import { classifyArenaError, enterArena } from "../helperTaskRunner.js";

/**
 * 创建竞技场、补齐类任务执行器
 * @param {Object} deps - 依赖项
 * @returns {Object} 任务函数集合
 */
export function createTasksArena(deps) {
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
    pickArenaTargetId,
    getTodayStartSec,
    isTodayAvailable,
    calculateMonthProgress,
    delayConfig,
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

  /**
   * 竞技场入场统一入口（「一键打三次」与「一键/智能补齐」共用）。
   *
   * master 2026-11-06 口径：
   *   · 200020「拒绝入场」= **不能打的号**，返回 "skipped"：立即跳过该账号本轮，
   *     不重试、不计失败、不进失败清单（一键重跑只补「漏打」，不补「不能打」）；
   *   · 限流（竞技场打得太频繁：200400/400340/200350/429…）= **打得动的号**，
   *     按 getRateLimitRetryMs()（默认 60s）等待重试，绝不跳过；
   *   · 其它错误原样抛出，交给调用方标 failed。
   *
   * ⚠️ 11-03 曾把 200020 当暂态一起塞进限流重试，导致被拒账号空等 120s 后仍被
   *    标 failed。分流逻辑在 helperTaskRunner.classifyArenaError（限流优先判定）。
   */
  const tryEnterArena = (tokenId, tokenName, timeoutMs) =>
    enterArena({
      send: () => {
        const args = [tokenId, "arena_startarea", {}];
        if (timeoutMs) args.push(timeoutMs);
        return tokenStore.sendMessageWithPromise(...args);
      },
      shouldStop: () => shouldStop.value,
      onRateLimitRetry: ({ attempt, maxRateLimitRetries, delayMs, error }) => {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${tokenName} 进入竞技场赛区遇限流（${error?.message || error}），${Math.round(delayMs / 1000)}秒后重试（第${attempt}/${maxRateLimitRetries}次）`,
          type: "warning",
        });
      },
    });

  /**
   * 200020 跳过的统一收尾：记日志 → 标 completed（不进失败清单）→ 恢复原阵容。
   * 调用方随后 return，由 finally 关连接、释放连接槽位。
   * 恢复阵容失败只记 warning，绝不把「不能打的号」翻成 failed。
   */
  const skipArena = async ({
    tokenId,
    tokenName,
    taskLabel,
    reason,
    restoreFormation,
  }) => {
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `${tokenName} ${reason} → 跳过本账号本轮${taskLabel}（200020：无参赛资格，不重试、不计失败、不进失败清单）`,
      type: "warning",
    });
    tokenStatus.value[tokenId] = "completed";
    if (restoreFormation) {
      try {
        await restoreFormation();
      } catch (e) {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${tokenName} 跳过后恢复原阵容失败: ${e?.message || "未知错误"}（不影响跳过结论）`,
          type: "warning",
        });
      }
    }
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== ${tokenName} ${taskLabel}已跳过（200020 拒绝入场）===`,
      type: "warning",
    });
  };

  /**
   * 一键竞技场战斗3次
   */
  const batcharenafight = async () => {
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
          message: `=== 开始一键竞技场战斗: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId);
        if (shouldStop.value) return;

        // 检查咸神门票 (ID: 1007)
        let role = tokenStore.gameData?.roleInfo?.role;
        if (!role) {
          const roleInfo = await sendRoleInfo(tokenId);
          role = roleInfo?.role;
        }
        const ticketCount = role?.items?.[1007]?.quantity || 0;
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 当前咸神门票: ${ticketCount}`,
          type: "info",
        });

        if (ticketCount <= 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 咸神门票不足，无法进行竞技场战斗`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

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
        if (batchSettings.arenaFormation === "current") {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `竞技场阵容设置为维持当前（当前阵容: ${currentFormation}），不切换`,
            type: "info",
          });
        } else if (currentFormation === batchSettings.arenaFormation) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `当前已是阵容${batchSettings.arenaFormation}，无需切换`,
            type: "info",
          });
        } else {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "presetteam_saveteam",
            { teamId: batchSettings.arenaFormation },
            5000,
          );
          Isswitching = true;
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `成功切换到阵容${batchSettings.arenaFormation}`,
            type: "info",
          });
        }
        
        const fights = Math.min(3, ticketCount);
        if (fights < 3) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 咸神门票仅剩 ${ticketCount} 张，将执行 ${fights} 次战斗`,
            type: "warning",
          });
        }

        // 本账号本轮跳过（200020）的统一收尾；恢复阵容只在切过阵容时需要。
        const skipCurrentArena = (reason) =>
          skipArena({
            tokenId,
            tokenName: token.name,
            taskLabel: "一键竞技场战斗",
            reason,
            restoreFormation: Isswitching
              ? () =>
                  tokenStore.sendMessageWithPromise(
                    tokenId,
                    "presetteam_saveteam",
                    { teamId: currentFormation },
                    5000,
                  )
              : null,
          });

        for (let i = 0; i < fights; i++) {
          if (shouldStop.value) break;
          const entry = await tryEnterArena(tokenId, token.name);
          if (entry === "skipped") {
            await skipCurrentArena("进入竞技场赛区被拒");
            return;
          }
          let targets;
          try {
            targets = await tokenStore.sendMessageWithPromise(
              tokenId,
              "arena_getareatarget",
              {},
            );
          } catch (err) {
            if (classifyArenaError(err) === "rejected") {
              await skipCurrentArena("获取竞技场目标被拒");
              return;
            }
            message.error(`获取竞技场目标失败：${err.message}`);
            break;
          }
          const candidateSources = [
            "rankList",
            "roleList",
            "targets",
            "targetList",
            "list",
          ]
            .filter((source) => Array.isArray(targets?.[source]))
            .map((source) => `${source}[${targets[source].length}]`)
            .join(", ");
          console.info(
            `[Arena][${token.name}][${i + 1}/3] arena_getareatarget 原始响应:`,
            targets,
          );
          const targetId = pickArenaTargetId(targets, {
            mode: batchSettings.smartArenaMode || "lowestPower",
          });
          console.info(
            `[Arena][${token.name}][${i + 1}/3] 候选列表: ${candidateSources || "无数组候选列表"}; 选择目标:`,
            targetId,
          );
          if (!targetId) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 未找到可用的竞技场目标`,
              type: "error",
            });
            break;
          }
          try {
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "fight_startareaarena",
              { targetId },
            );
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 竞技场战斗 ${i + 1}/3`,
              type: "info",
            });
            await new Promise((r) => setTimeout(r, delayConfig.battle));
          } catch (e) {
            if (classifyArenaError(e) === "rejected") {
              await skipCurrentArena("竞技场对决被拒");
              return;
            }
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 竞技场对决失败: ${e.message || "未知错误"}`,
              type: "error",
            });
          }
        }
        await new Promise((r) => setTimeout(r, delayConfig.battle));
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
          message: `=== ${token.name} 竞技场战斗已完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 一键竞技场战斗失败: ${error.message || "未知错误"}`,
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
    message.success("批量竞技场战斗结束");
  };

  /**
   * 批量钓鱼补齐
   *
   * @param {object} [options]
   * @param {boolean} [options.smart]
   *   false（默认）= 原有口径：按日历线性摊平 `dayOfMonth / daysInMonth × 320`
   *   true          = 智能口径：按每日 3 次免费钓鱼倒推今日底线（见 smartTopUp.js）
   *
   * ⚠️ 两个口径共用同一套执行体（补到 shouldBe 为止 + 自动领鱼竿累计奖励），
   *   只有 shouldBe 的来源不同 —— 改执行细节时两条路一起受益，别复制成两份。
   */
  const runTopUpFish = async (options = {}) => {
    const smart = !!options?.smart;
    const taskLabel = smart ? "钓鱼智能补齐" : "钓鱼补齐";
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
          message: `=== 开始${taskLabel}: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId);
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 获取月度任务进度...`,
          type: "info",
        });
        const result = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_get",
          {},
          10000,
        );
        const act = result?.activity || result?.body?.activity || result;

        if (!act) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 获取月度任务进度失败`,
            type: "error",
          });
          tokenStatus.value[tokenId] = "failed";
          return;
        }
        const myMonthInfo = act.myMonthInfo || {};
        const fishNum = Number(myMonthInfo?.["2"]?.num || 0);

        const monthProgress = calculateMonthProgress();
        const now = new Date();
        const smartTargets = calcSmartTopUpTargets(now);
        const { remainingDays } = smartTargets;
        const shouldBe = smart
          ? smartTargets.fishShouldBe
          : remainingDays === 0
            ? FISH_TARGET
            : Math.min(FISH_TARGET, Math.ceil(monthProgress * FISH_TARGET));
        const need = Math.max(0, shouldBe - fishNum);
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 当前进度: ${fishNum}/${FISH_TARGET}，需要补齐: ${need}次${
            smart
              ? `（智能口径：今日底线 ${shouldBe}，剩余 ${remainingDays} 天 × 每日 ${smartTargets.fishPerDay} 次由每日任务自然完成）`
              : ""
          }`,
          type: "info",
        });
        if (need <= 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `当前进度已达标，无需补齐`,
            type: "success",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 开始执行${taskLabel}...`,
          type: "info",
        });

        let role = tokenStore.gameData?.roleInfo?.role;
        if (!role) {
          const roleInfo = await sendRoleInfo(tokenId);
          role = roleInfo?.role;
        }
        let freeUsed = 0;
        const lastFreeTime = Number(
          role?.statisticsTime?.["artifact:normal:lottery:time"] || 0,
        );
        if (isTodayAvailable(lastFreeTime)) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 检测到今日免费钓鱼次数，开始消耗 3 次`,
            type: "info",
          });
          for (let i = 0; i < 3 && need > freeUsed && !shouldStop.value; i++) {
            try {
              await tokenStore.sendMessageWithPromise(
                tokenId,
                "artifact_lottery",
                { lotteryNumber: 1, newFree: true, type: 1 },
                8000,
              );
              freeUsed++;
              await new Promise((r) => setTimeout(r, delayConfig.action));
            } catch (e) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 免费钓鱼失败: ${e.message}`,
                type: "error",
              });
              break;
            }
          }
        }

        const updatedResult = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_get",
          {},
          10000,
        );
        const updatedAct =
          updatedResult?.activity ||
          updatedResult?.body?.activity ||
          updatedResult;
        const updatedMyMonthInfo = updatedAct.myMonthInfo || {};
        const updatedFishNum = Number(updatedMyMonthInfo?.["2"]?.num || 0);
        let remaining = Math.max(0, shouldBe - updatedFishNum);
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 免费次数后进度: ${updatedFishNum}/${FISH_TARGET}，还需补齐: ${remaining}次`,
          type: "info",
        });
        if (remaining <= 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `已通过免费次数完成目标`,
            type: "success",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 开始付费钓鱼补齐: 共需 ${remaining} 次（每次最多10）`,
          type: "info",
        });

        // 检查普通鱼竿 (ID: 1011)
        const rodCount = role?.items?.[1011]?.quantity || 0;
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 当前普通鱼竿: ${rodCount}`,
          type: "info",
        });

        if (rodCount < remaining) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 普通鱼竿不足 (${rodCount} < ${remaining})，将仅使用现有鱼竿`,
            type: "warning",
          });
          remaining = rodCount;
        }

        while (remaining > 0 && !shouldStop.value) {
          const batch = Math.min(10, remaining);
          try {
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "artifact_lottery",
              { lotteryNumber: batch, newFree: true, type: 1 },
              12000,
            );
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 完成 ${batch} 次付费钓鱼`,
              type: "info",
            });
            remaining -= batch;
            
            // 每钓鱼5轮（50次）后，重新获取角色信息，校验鱼竿数量
            if (remaining > 0 && batch >= 10 && remaining % 50 === 0) {
                 try {
                     const roleRes = await sendRoleInfo(
                       tokenId,
                       {},
                       5000,
                       "同步鱼竿数量",
                     );
                     const currentRole = roleRes?.role || roleRes?.data?.role;
                     if (currentRole) {
                         const currentRodCount = currentRole.items?.[1011]?.quantity || 0;
                         if (currentRodCount < remaining) {
                             addLog({
                                 time: new Date().toLocaleTimeString(),
                                 message: `${token.name} 同步后发现鱼竿不足 (${currentRodCount} < ${remaining})，调整目标`,
                                 type: "warning",
                             });
                             remaining = currentRodCount;
                         }
                     }
                 } catch (e) {
                     if (e?.code === "ROLE_INFO_RECOVERY_FAILED") throw e;
                     // ignore
                 }
            }

            await new Promise((r) => setTimeout(r, delayConfig.battle));
          } catch (e) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 付费钓鱼失败: ${e.message}`,
              type: "error",
            });
            break;
          }
        }

        const finalResult = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_get",
          {},
          10000,
        );
        const finalAct =
          finalResult?.activity || finalResult?.body?.activity || finalResult;
        const finalMyMonthInfo = finalAct.myMonthInfo || {};
        const finalFishNum = Number(finalMyMonthInfo?.["2"]?.num || 0);
        if (finalFishNum >= shouldBe || finalFishNum >= FISH_TARGET) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 钓鱼补齐完成，最终进度: ${finalFishNum}/${FISH_TARGET}`,
            type: "success",
          });
        } else {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 钓鱼补齐已停止，未达到目标，最终进度: ${finalFishNum}/${FISH_TARGET}`,
            type: "warning",
          });
        }
        
        // 自动领取鱼竿累计奖励
        try {
           const roleRes = await sendRoleInfo(
             tokenId,
             {},
             5000,
             "获取鱼竿累计奖励信息",
           );
           const currentRole = roleRes?.role || roleRes?.data?.role;
           if (currentRole) {
              const points = currentRole.statistics?.["artifact:point"] || 0;
              const exchangeCount = Math.floor(points / 20);
              
              if (exchangeCount > 0) {
                 addLog({
                    time: new Date().toLocaleTimeString(),
                    message: `${token.name} 检测到鱼竿累计使用 ${points}，开始领取 ${exchangeCount} 次累计奖励`,
                    type: "info",
                 });
                 
                 for (let k = 0; k < exchangeCount && !shouldStop.value; k++) {
                    try {
                       await tokenStore.sendMessageWithPromise(
                         tokenId,
                         "artifact_exchange",
                         {},
                         3000
                       );
                       await new Promise((r) =>
                         setTimeout(r, Math.max(0, Number(delayConfig?.action) || 0)),
                       );
                    } catch (err) {
                       addLog({
                          time: new Date().toLocaleTimeString(),
                          message: `${token.name} 领取累计奖励失败 (第${k+1}次): ${err.message}`,
                          type: "warning",
                       });
                       break;
                    }
                 }
                 addLog({
                    time: new Date().toLocaleTimeString(),
                    message: `${token.name} 累计奖励领取结束`,
                    type: "success",
                 });
              }
           }
          } catch (e) {
            if (e?.code === "ROLE_INFO_RECOVERY_FAILED") throw e;
           addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 检查累计奖励失败: ${e.message}`,
              type: "warning",
           });
        }

        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 钓鱼补齐失败: ${error.message}`,
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
    message.success(`批量${taskLabel}结束`);
  };

  /** 一键钓鱼补齐（原有口径：按日历线性摊平，行为与本次改造前完全一致） */
  const batchTopUpFish = () => runTopUpFish();

  /** 智能钓鱼补齐（新增：按每日 3 次免费钓鱼倒推今日底线，只补到刚好够） */
  const batchSmartTopUpFish = () => runTopUpFish({ smart: true });

  /**
   * 批量竞技场补齐
   *
   * @param {object} [options]
   * @param {boolean} [options.smart]
   *   false（默认）= 原有口径：按日历线性摊平 `dayOfMonth / daysInMonth × 240`
   *   true          = 智能口径：按每日 6 分（3 场全胜）倒推今日底线
   *
   * ⚠️ 与钓鱼同理：共用执行体，只有 shouldBe 来源不同。
   */
  const runTopUpArena = async (options = {}) => {
    const smart = !!options?.smart;
    const taskLabel = smart ? "竞技场智能补齐" : "竞技场补齐";
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
          message: `=== 开始${taskLabel}: ${token.name} ===`,
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
        if (batchSettings.arenaFormation === "current") {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `竞技场阵容设置为维持当前（当前阵容: ${currentFormation}），不切换`,
            type: "info",
          });
        } else if (currentFormation === batchSettings.arenaFormation) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `当前已是阵容${batchSettings.arenaFormation}，无需切换`,
            type: "info",
          });
        } else {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "presetteam_saveteam",
            { teamId: batchSettings.arenaFormation },
            5000,
          );
          Isswitching = true;
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `成功切换到阵容${batchSettings.arenaFormation}`,
            type: "info",
          });
        }
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 获取月度任务进度...`,
          type: "info",
        });
        const result = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_get",
          {},
          10000,
        );
        const act = result?.activity || result?.body?.activity || result;

        if (!act) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 获取月度任务进度失败`,
            type: "error",
          });
          tokenStatus.value[tokenId] = "failed";
          return;
        }
        const myArenaInfo = act.myArenaInfo || {};
        const arenaNum = Number(myArenaInfo?.num || 0);

        const monthProgress = calculateMonthProgress();
        const now = new Date();
        const smartTargets = calcSmartTopUpTargets(now);
        const { remainingDays } = smartTargets;
        const shouldBe = smart
          ? smartTargets.arenaShouldBe
          : remainingDays === 0
            ? ARENA_TARGET
            : Math.min(ARENA_TARGET, Math.ceil(monthProgress * ARENA_TARGET));
        const need = Math.max(0, shouldBe - arenaNum);
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 当前进度: ${arenaNum}/${ARENA_TARGET}，需要补齐: ${need}次${
            smart
              ? `（智能口径：今日底线 ${shouldBe} 分，剩余 ${remainingDays} 天 × 每日 ${smartTargets.arenaPointsPerDay} 分由每日任务自然完成）`
              : ""
          }`,
          type: "info",
        });
        if (need <= 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 当前进度已达标，无需补齐`,
            type: "success",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 开始执行${taskLabel}...`,
          type: "info",
        });

        // 检查咸神门票 (ID: 1007)
        let role = tokenStore.gameData?.roleInfo?.role;
        if (!role) {
          try {
            const roleInfo = await sendRoleInfo(tokenId);
            role = roleInfo?.role;
          } catch (e) {
            if (e?.code === "ROLE_INFO_RECOVERY_FAILED") throw e;
          }
        }
        const ticketCount = role?.items?.[1007]?.quantity || 0;
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 当前咸神门票: ${ticketCount}`,
          type: "info",
        });

        if (ticketCount < need) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 咸神门票不足 (${ticketCount} < ${need})，将仅使用现有门票`,
            type: "warning",
          });
        }

        let ticketsLeft = ticketCount;
        let remaining = Math.min(need, ticketsLeft);

        if (remaining <= 0) {
           addLog({
             time: new Date().toLocaleTimeString(),
             message: `${token.name} 没有可用的咸神门票`,
             type: "warning",
           });
           tokenStatus.value[tokenId] = "completed";
           return;
        }

        // 本账号本轮跳过（200020）的统一收尾；恢复阵容只在切过阵容时需要。
        const skipCurrentArena = (reason) =>
          skipArena({
            tokenId,
            tokenName: token.name,
            taskLabel,
            reason,
            restoreFormation: Isswitching
              ? () =>
                  tokenStore.sendMessageWithPromise(
                    tokenId,
                    "presetteam_saveteam",
                    { teamId: currentFormation },
                    5000,
                  )
              : null,
          });

        let entry;
        try {
          entry = await tryEnterArena(tokenId, token.name, 6000);
        } catch (error) {
          // 非 200020（含限流重试耗尽）：保持原有「记 warning 后继续补齐」的行为，
          // 绝不跳过 —— 竞技场限流只是打得频繁，等一会还能打。
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 开始竞技场失败: ${error.message || error}（继续尝试补齐）`,
            type: "warning",
          });
          entry = "ok";
        }
        if (entry === "skipped") {
          await skipCurrentArena("进入竞技场赛区被拒");
          return;
        }

        // 循环内任一帧命中 200020 即停：没资格打的号再试多少场都打不了，
        // 不能让它把 planFights / 100 场上限空转完。
        let arenaRejectedReason = null;
        let safetyCounter = 0;
        const safetyMaxFights = 100;
        let round = 1;
        while (
          remaining > 0 &&
          ticketsLeft > 0 &&
          safetyCounter < safetyMaxFights &&
          !shouldStop.value
        ) {
          const planFights = Math.min(Math.ceil(remaining / 2), ticketsLeft);
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 第${round}轮：计划战斗 ${planFights} 场 (剩余门票: ${ticketsLeft})`,
            type: "info",
          });

          let actualFights = 0;
          for (
            let i = 0;
            i < planFights &&
            safetyCounter < safetyMaxFights &&
            !shouldStop.value;
            i++
          ) {
            let targets;
            try {
              targets = await tokenStore.sendMessageWithPromise(
                tokenId,
                "arena_getareatarget",
                {},
                8000,
              );
            } catch (err) {
              if (classifyArenaError(err) === "rejected") {
                arenaRejectedReason = "获取竞技场目标被拒";
                break;
              }
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 获取竞技场目标失败：${err.message}`,
                type: "error",
              });
              break;
            }

            const targetId = pickArenaTargetId(targets, {
              mode: batchSettings.smartArenaMode || "lowestPower",
            });
            if (!targetId) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 未找到可用的竞技场目标`,
                type: "warning",
              });
              break;
            }

            try {
              await tokenStore.sendMessageWithPromise(
                tokenId,
                "fight_startareaarena",
                { targetId },
                15000,
              );
              actualFights++;
              ticketsLeft--;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 竞技场战斗 ${i + 1}/${planFights} 完成`,
                type: "info",
              });
            } catch (e) {
              if (classifyArenaError(e) === "rejected") {
                arenaRejectedReason = "竞技场对决被拒";
                break;
              }
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 竞技场对决失败：${e.message}`,
                type: "error",
              });
            }

            safetyCounter++;
            await new Promise((r) => setTimeout(r, delayConfig.refresh));
          }

          // 200020 立即收尾，不再做 activity_get 复查 / 下一轮计划。
          if (arenaRejectedReason) break;

          const updatedResult = await tokenStore.sendMessageWithPromise(
            tokenId,
            "activity_get",
            {},
            10000,
          );
          const updatedAct =
            updatedResult?.activity ||
            updatedResult?.body?.activity ||
            updatedResult;
          const updatedMyArenaInfo = updatedAct.myArenaInfo || {};
          const updatedArenaNum = Number(updatedMyArenaInfo?.num || 0);
          
          // Re-calculate remaining needed for target, but don't exceed ticketsLeft
          const neededForTarget = Math.max(0, shouldBe - updatedArenaNum);
          
          // 每轮战斗后重新获取角色信息以更新门票数量
          try {
             const roleRes = await sendRoleInfo(
               tokenId,
               {},
               5000,
               "同步竞技场门票",
             );
             const currentRole = roleRes?.role || roleRes?.data?.role;
             if (currentRole) {
                 const newTickets = currentRole.items?.[1007]?.quantity || 0;
                 if (newTickets !== ticketsLeft) {
                    addLog({
                        time: new Date().toLocaleTimeString(),
                        message: `${token.name} 同步最新门票数量: ${newTickets} (原记录: ${ticketsLeft})`,
                        type: "info",
                    });
                    ticketsLeft = newTickets;
                 }
             }
            } catch (e) {
              if (e?.code === "ROLE_INFO_RECOVERY_FAILED") throw e;
              // ignore error, use local calculation
          }

          remaining = Math.min(neededForTarget, ticketsLeft);

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 第${round}轮后进度: ${updatedArenaNum}/${ARENA_TARGET}，还需补齐: ${remaining}次`,
            type: "info",
          });

          round++;
        }

        if (arenaRejectedReason) {
          await skipCurrentArena(arenaRejectedReason);
          return;
        }

        const finalResult = await tokenStore.sendMessageWithPromise(
          tokenId,
          "activity_get",
          {},
          10000,
        );
        const finalAct =
          finalResult?.activity || finalResult?.body?.activity || finalResult;
        const finalMyArenaInfo = finalAct.myArenaInfo || {};
        const finalArenaNum = Number(finalMyArenaInfo?.num || 0);
        if (finalArenaNum >= shouldBe || finalArenaNum >= ARENA_TARGET) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 竞技场补齐完成，最终进度: ${finalArenaNum}/${ARENA_TARGET}`,
            type: "success",
          });
        } else if (safetyCounter >= safetyMaxFights) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `达到安全上限，竞技场补齐已停止，最终进度: ${finalArenaNum}/${ARENA_TARGET}`,
            type: "warning",
          });
        } else {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 竞技场补齐已停止，未达到目标，最终进度: ${finalArenaNum}/${ARENA_TARGET}`,
            type: "warning",
          });
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
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 竞技场补齐失败: ${error.message}`,
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
    message.success(`批量${taskLabel}结束`);
  };

  /** 一键竞技场补齐（原有口径：按日历线性摊平，行为与本次改造前完全一致） */
  const batchTopUpArena = () => runTopUpArena();

  /** 智能竞技场补齐（新增：按每日 6 分倒推今日底线，只补到刚好够） */
  const batchSmartTopUpArena = () => runTopUpArena({ smart: true });

  return {
    batcharenafight,
    batchTopUpFish,
    batchTopUpArena,
    batchSmartTopUpFish,
    batchSmartTopUpArena,
  };
}
