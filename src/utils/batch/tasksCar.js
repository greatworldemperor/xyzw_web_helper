/**
 * 车辆类任务
 * 包含: batchSmartSendCar, batchClaimCars
 */

import { CarresearchItem } from "./constants.js";
import {
  is400340Error,
  RATE_LIMIT_MAX_RETRIES,
  RATE_LIMIT_RETRY_DELAY_MS,
  runWithRateLimitRetry,
} from "../helperTaskRunner.js";

const CAR_COMMAND_RETRY_DELAY_MS = RATE_LIMIT_RETRY_DELAY_MS;
// 实测第46次重试成功，推测服务器实际冷却时间约46秒；服务器可能随时调整冷却时间。
const CAR_COMMAND_MAX_RETRIES = RATE_LIMIT_MAX_RETRIES;

/**
 * 创建车辆类任务执行器
 * @param {Object} deps - 依赖项
 * @returns {Object} 任务函数集合
 */
export function createTasksCar(deps) {
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
    normalizeCars,
    gradeLabel,
    shouldSendCar,
    canClaim,
    isBigPrize,
    countRacingRefreshTickets,
    delayConfig,
  } = deps;

  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const carCommandRetryDelayMs = Number.isFinite(Number(delayConfig?.retry))
    ? Number(delayConfig.retry)
    : CAR_COMMAND_RETRY_DELAY_MS;
  const sendRoleInfo = (tokenId, params = {}, timeout = 15000, operation) =>
    batchSendRoleInfo
      ? batchSendRoleInfo(tokenId, params, timeout, operation)
      : tokenStore.sendMessageWithPromise(
          tokenId,
          "role_getroleinfo",
          params,
          timeout,
        );

  /**
   * 智能发车
   */
  const batchSmartSendCar = async () => {
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

      const sendCarCommand = (cmd, params, timeout, operation) =>
        runWithRateLimitRetry({
          execute: () =>
            tokenStore.sendMessageWithPromise(tokenId, cmd, params, timeout),
          retryDelayMs: carCommandRetryDelayMs,
          maxRetries: CAR_COMMAND_MAX_RETRIES,
          onRetry: ({ retryCount, maxRetries }) => {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} ${operation}触发服务器限流，1秒后重试（第${retryCount}/${maxRetries}次）`,
              type: "warning",
            });
          },
        });

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始智能发车: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        // 1. Fetch Car Info
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 获取车辆信息...`,
          type: "info",
        });
        const res = await sendCarCommand(
          "car_getrolecar",
          {},
          10000,
          "获取车辆信息",
        );
        let carList = normalizeCars(res?.body ?? res);

        // 2. Fetch Tickets & Role Info
        let refreshTickets = 0;
        let currentRoleId = null;
        try {
          const roleRes = await sendRoleInfo(tokenId, {}, 10000, "获取角色信息");
          const qty = roleRes?.role?.items?.[35002]?.quantity;
          refreshTickets = Number(qty || 0);
          currentRoleId = roleRes?.role?.roleId ? String(roleRes.role.roleId) : null;
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 剩余刷新次数: ${refreshTickets}`,
            type: "info",
          });
        } catch (error) {
          throw error;
        }

        // 2.5 Fetch Helper Data (Club Members & Usage)
        let helperUsageMap = {};
        let sortedHelpers = [];

        // 封装获取护卫使用情况的方法
        const updateHelperUsage = async () => {
          try {
            const usageRes = await sendCarCommand(
              "car_getmemberhelpingcnt",
              {},
              5000,
              "获取护卫使用情况",
            );
            helperUsageMap =
              usageRes?.body?.memberHelpingCntMap ||
              usageRes?.memberHelpingCntMap ||
              {};
          } catch (e) {
            // 忽略更新失败，使用旧数据或空数据
          }
        };

        try {
          // Initial fetch of usage
          await updateHelperUsage();

          // Fetch club members
          const legionRes = await sendCarCommand(
            "legion_getinfo",
            {},
            5000,
            "获取护卫列表",
          );
          const membersMap =
            legionRes?.body?.info?.members || legionRes?.info?.members || {};
          
          // Sort members by Red Quench (desc)
          sortedHelpers = Object.values(membersMap)
            .filter(
              (m) =>
                !currentRoleId || String(m.roleId) !== currentRoleId
            )
            .map((m) => ({
              id: String(m.roleId),
              name: m.name || m.nickname || String(m.roleId),
              redQuench: m.custom?.red_quench_cnt || 0,
            }))
            .sort((a, b) => b.redQuench - a.redQuench);
            
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 获取到 ${sortedHelpers.length} 位潜在护卫`,
            type: "info",
          });
        } catch (e) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 获取护卫数据失败: ${e.message}，将不带护卫发车`,
            type: "warning",
            code: e.code // Log code if available
          });
        }

        // Helper function to assign guard
        const assignHelperIfNeeded = async (car) => {
          const color = Number(car.color || 0);
          // Only Red(5) and above need guards
          if (color < 5) return;
          // Skip if already has helper
          if (car.helperId) return;

          // 每次分配前刷新护卫状态，避免并发导致的使用次数超标
          await updateHelperUsage();

          if (!sortedHelpers.length) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 车辆[${gradeLabel(car.color)}]需要护卫，但未获取到可用护卫列表`,
              type: "warning",
            });
            return;
          }

          // Find best available helper
          const bestHelper = sortedHelpers.find((h) => {
            const used = Number(helperUsageMap[h.id] || 0);
            return used < 4;
          });

          if (bestHelper) {
            car.helperId = bestHelper.id;
            // Update local usage count (optimistic update)
            helperUsageMap[bestHelper.id] = Number(helperUsageMap[bestHelper.id] || 0) + 1;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 车辆[${gradeLabel(car.color)}]自动分配护卫: ${bestHelper.name} (已助战: ${helperUsageMap[bestHelper.id]}/4)`,
              type: "success",
            });
          } else {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 车辆[${gradeLabel(car.color)}]需要护卫，但所有护卫次数已满`,
              type: "warning",
            });
          }
        };

        const customConditions = {
          gold: batchSettings.smartDepartureGoldThreshold,
          recruit: batchSettings.smartDepartureRecruitThreshold,
          jade: batchSettings.smartDepartureJadeThreshold,
          ticket: batchSettings.smartDepartureTicketThreshold,
        };
        const paidRefreshConditions = { ...customConditions, ticket: 0 };
        const smartDepartureMode =
          batchSettings.smartDepartureMode === "B" ? "B" : "A";

        const sendCar = async (car, logMessage, logType = "info") => {
          await assignHelperIfNeeded(car);
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} ${logMessage}`,
            type: logType,
          });
          await sendCarCommand(
            "car_send",
            {
              carId: String(car.id),
              helperId: car.helperId ? String(car.helperId) : 0,
              text: "",
              isUpgrade: false,
            },
            10000,
            "发车",
          );
          await new Promise((r) => setTimeout(r, delayConfig.action));
        };

        const refreshCar = async (car, isFreeRefresh = false) => {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 车辆[${gradeLabel(car.color)}]${
              isFreeRefresh ? "进行免费刷新" : "尝试刷新"
            }...`,
            type: "info",
          });
          const resp = await sendCarCommand(
            "car_refresh",
            { carId: String(car.id) },
            10000,
            isFreeRefresh ? "免费刷新车辆" : "刷新车辆",
          );
          const data = resp?.car || resp?.body?.car || resp;

          if (data && typeof data === "object") {
            if (data.color != null) car.color = Number(data.color);
            if (data.refreshCount != null)
              car.refreshCount = Number(data.refreshCount);
            if (data.rewards != null) car.rewards = data.rewards;
          }

          try {
            const roleRes = await sendRoleInfo(
              tokenId,
              {},
              5000,
              "获取刷新券数量",
            );
            refreshTickets = Number(
              roleRes?.role?.items?.[35002]?.quantity || 0,
            );
          } catch (error) {
            if (error?.code === "ROLE_INFO_RECOVERY_FAILED") throw error;
            refreshTickets = 0;
          }
        };

        const meetsConditions = (car, conditions = customConditions) =>
          shouldSendCar(
            car,
            refreshTickets,
            batchSettings.carMinColor,
            conditions,
            false,
            false,
          );

        const canUsePaidRefresh = () => refreshTickets > 0;

        // 3. Process Cars
        for (const car of carList) {
          if (shouldStop.value) break;

          if (Number(car.sendAt || 0) !== 0) continue;

          try {
            if (meetsConditions(car)) {
              await sendCar(
                car,
                `车辆[${gradeLabel(car.color)}]满足条件，直接发车`,
              );
              continue;
            }

            if (Number(car.refreshCount ?? 0) === 0) {
              await refreshCar(car, true);
              if (meetsConditions(car)) {
                await sendCar(
                  car,
                  `免费刷新后车辆[${gradeLabel(car.color)}]满足条件，发车`,
                  "success",
                );
                continue;
              }
            }

            if (shouldStop.value) break;

            if (smartDepartureMode === "B") {
              if (customConditions.ticket > 0) {
                addLog({
                  time: new Date().toLocaleTimeString(),
                  message: `${token.name} 车辆[${gradeLabel(car.color)}]免费刷新后仍不满足完整条件，逻辑B暂时忽略刷新券奖励数量要求`,
                  type: "warning",
                });
              }

              let sentAfterPaidRefresh = false;
              while (
                !shouldStop.value &&
                canUsePaidRefresh()
              ) {
                await refreshCar(car);
                if (meetsConditions(car, paidRefreshConditions)) {
                  await sendCar(
                    car,
                    `追刷后车辆[${gradeLabel(car.color)}]满足条件，发车`,
                    "success",
                  );
                  sentAfterPaidRefresh = true;
                  break;
                }

                await new Promise((r) => setTimeout(r, delayConfig.refresh));
              }

              if (shouldStop.value) break;
              if (sentAfterPaidRefresh) continue;
            }

            await sendCar(
              car,
              `车辆[${gradeLabel(car.color)}]未满足条件，直接发车`,
              "warning",
            );
          } catch (carError) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: is400340Error(carError)
                ? `${token.name} 车辆[${gradeLabel(car.color)}]发车失败（400340每秒重试${CAR_COMMAND_MAX_RETRIES}次后仍失败），继续处理其他车辆`
                : `${token.name} 车辆[${gradeLabel(car.color)}]处理失败: ${carError.message}，跳过该车辆`,
              type: "error",
            });
            continue;
          }
        }

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 智能发车完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `智能发车失败: ${error.message}`,
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
    message.success("批量智能发车结束");
  };

  /**
   * 一键收车
   */
  const batchClaimCars = async () => {
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

      const sendCarCommand = (cmd, params, timeout, operation) =>
        runWithRateLimitRetry({
          execute: () =>
            tokenStore.sendMessageWithPromise(tokenId, cmd, params, timeout),
          retryDelayMs: carCommandRetryDelayMs,
          maxRetries: CAR_COMMAND_MAX_RETRIES,
          onRetry: ({ retryCount, maxRetries }) => {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} ${operation}触发服务器限流，1秒后重试（第${retryCount}/${maxRetries}次）`,
              type: "warning",
            });
          },
        });

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始一键收车: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 获取车辆信息...`,
          type: "info",
        });
        const res = await sendCarCommand(
          "car_getrolecar",
          {},
          10000,
          "获取车辆信息",
        );
        let carList = normalizeCars(res?.body ?? res);
        let refreshlevel = res?.roleCar?.research?.[1] || 0;

        let claimedCount = 0;
        for (const car of carList) {
          if (shouldStop.value) break;
          if (canClaim(car)) {
            try {
              await sendCarCommand(
                "car_claim",
                { carId: String(car.id) },
                10000,
                "收车",
              );
              claimedCount++;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 收车成功: ${gradeLabel(car.color)}`,
                type: "success",
              });
              const roleRes = await sendRoleInfo(
                tokenId,
                {},
                5000,
                "获取角色信息",
              );
              let refreshpieces = Number(
                roleRes?.role?.items?.[35009]?.quantity || 0,
              );
              while (
                refreshlevel < CarresearchItem.length &&
                refreshpieces >= CarresearchItem[refreshlevel] &&
                !shouldStop.value
              ) {
                try {
                  await sendCarCommand(
                    "car_research",
                    { researchId: 1 },
                    5000,
                    "车辆改装升级",
                  );
                  refreshlevel++;

                  const updatedRoleRes = await sendRoleInfo(
                    tokenId,
                    {},
                    5000,
                    "获取角色信息",
                  );
                  refreshpieces = Number(
                    updatedRoleRes?.role?.items?.[35009]?.quantity || 0,
                  );

                  addLog({
                    time: new Date().toLocaleTimeString(),
                    message: `${token.name} 执行车辆改装升级，当前等级: ${refreshlevel}`,
                    type: "success",
                  });

                  await new Promise((r) => setTimeout(r, delayConfig.action));
                } catch (e) {
                  if (e?.code === "ROLE_INFO_RECOVERY_FAILED") throw e;
                  addLog({
                    time: new Date().toLocaleTimeString(),
                    message: `${token.name} 车辆改装升级失败: ${e.message}`,
                    type: "error",
                  });
                  break;
                }
              }

              // 尝试领取改装升级累计奖励
              try {
                const rewardRes = await sendCarCommand(
                  "car_claimpartconsumereward",
                  {},
                  5000,
                  "领取改装升级累计奖励",
                );
                if (rewardRes && rewardRes.reward) {
                  addLog({
                    time: new Date().toLocaleTimeString(),
                    message: `${token.name} 领取改装升级累计奖励成功`,
                    type: "success",
                  });
                }
              } catch (e) {
                // 忽略错误
              }
            } catch (e) {
              if (e?.code === "ROLE_INFO_RECOVERY_FAILED") throw e;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 收车失败: ${e.message}`,
                type: "warning",
              });
            }
            await new Promise((r) => setTimeout(r, delayConfig.action));
          }
        }

        if (claimedCount === 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 没有可收取的车辆`,
            type: "info",
          });
        }

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 收车完成，共收取 ${claimedCount} 辆 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 收车失败: ${error.message}`,
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
    message.success("批量一键收车结束");
  };

  return {
    batchSmartSendCar,
    batchClaimCars,
  };
}
