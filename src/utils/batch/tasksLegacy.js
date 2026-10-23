/**
 * 功法类任务
 * 包含: batchLegacyClaim, batchLegacyStartHangUp, batchLegacyGiftSendEnhanced
 */

/**
 * 创建功法类任务执行器
 * @param {Object} deps - 依赖项
 * @returns {Object} 任务函数集合
 */
export function createTasksLegacy(deps) {
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
    recipientIdInput,
    recipientInfo,
    securityPassword,
    giftQuantity,
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
   * 读取功法产出起始时间（hangUpBeginTime）
   * 抓包实证：local-data/misc/gongfa_start.jsonl（2026-10-24）
   *   legacy_getinfo → Legacy_GetInfoResp { roleLegacy: { hangUpBeginTime } }
   * @returns {Promise<number>} 0=未启动/查询失败，-1=请求异常（未知状态）
   */
  const readHangUpBeginTime = async (tokenId) => {
    try {
      const infoResp = await tokenStore.sendMessageWithPromise(
        tokenId,
        "legacy_getinfo",
        {},
        5000,
      );
      return Number(infoResp?.roleLegacy?.hangUpBeginTime) || 0;
    } catch (error) {
      console.error(error);
      return -1;
    }
  };

  /**
   * 启动功法产出（legacy_beginhangup）
   * @returns {Promise<number>} 新的 hangUpBeginTime（毫秒时间戳），0 表示启动失败
   */
  const beginHangUp = async (tokenId) => {
    const resp = await tokenStore.sendMessageWithPromise(
      tokenId,
      "legacy_beginhangup",
      {},
      5000,
    );
    return Number(resp?.roleLegacy?.hangUpBeginTime) || 0;
  };

  /**
   * 批量启动功法
   * 🔴 每期功法结束后服务端会把 roleLegacy.hangUpBeginTime 归 0，此时直接
   *    legacy_claimhangup 会报错 —— 必须先 legacy_beginhangup 重启本期产出。
   * 幂等：hangUpBeginTime > 0（已在产出中）直接跳过，不重复启动。
   */
  const batchLegacyStartHangUp = async () => {
    if (selectedTokens.value.length === 0) {
      message.warning("请先选择要操作的角色");
      return;
    }
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    let totalStarted = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);
      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始启动功法: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId);

        const beginTime = await readHangUpBeginTime(tokenId);
        if (beginTime > 0) {
          totalSkipped++;
          tokenStatus.value[tokenId] = "completed";
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== ${token.name} 功法已在产出中（开始于 ${new Date(beginTime).toLocaleString()}），无需启动 ===`,
            type: "success",
          });
          return;
        }
        if (beginTime < 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== ${token.name} 功法状态查询失败，直接尝试启动 ===`,
            type: "warning",
          });
        }

        const newBeginTime = await beginHangUp(tokenId);
        if (!newBeginTime) {
          throw new Error("启动响应未返回 hangUpBeginTime");
        }
        totalStarted++;
        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 功法已启动，产出开始于 ${new Date(newBeginTime).toLocaleString()} ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        totalFailed++;

        let errorMsg = error.message || "未知错误";
        if (errorMsg.includes("200160")) {
          errorMsg = "功法系统未开启";
        } else if (errorMsg.includes("timeout")) {
          errorMsg = "请求超时";
        }
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 启动功法失败: ${errorMsg} ===`,
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

    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== 批量启动功法完成: 新启动 ${totalStarted} 个，已启动 ${totalSkipped} 个，失败 ${totalFailed} 个 ===`,
      type: "success",
    });

    message.success(
      `批量启动功法结束，新启动 ${totalStarted} 个，已启动 ${totalSkipped} 个，失败 ${totalFailed} 个`,
    );
  };

  /**
   * 批量领取功法残卷
   * 🔴 2026-10-24：每期功法结束后 hangUpBeginTime 归 0，直接领取会报错。
   *    领取前先查一次状态，未启动则自动 legacy_beginhangup（失败不阻断原有领取流程）。
   */
  const batchLegacyClaim = async () => {
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
          message: `=== 开始领取功法残卷: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId);

        // 前置：功法未启动（hangUpBeginTime==0）时先重启本期产出，否则领取会报错。
        // -1 = 状态查询失败 → 保持旧行为直接领取，不改变原有成功率。
        const beforeClaimBeginTime = await readHangUpBeginTime(tokenId);
        if (beforeClaimBeginTime === 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== ${token.name} 功法未启动，先启动再领取 ===`,
            type: "info",
          });
          try {
            const startedAt = await beginHangUp(tokenId);
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== ${token.name} 功法已启动${startedAt ? `（${new Date(startedAt).toLocaleString()}）` : ""} ===`,
              type: "success",
            });
          } catch (startError) {
            console.error(startError);
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== ${token.name} 功法启动失败: ${startError.message || "未知错误"}，继续尝试领取 ===`,
              type: "warning",
            });
          }
        }

        const LegacyClaimHangUpResp = await tokenStore.sendMessageWithPromise(
          tokenId,
          "legacy_claimhangup",
          {},
          5000,
        );
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 成功领取功法残卷${LegacyClaimHangUpResp.reward[0].value}，共有${LegacyClaimHangUpResp.role.items[37007].quantity}个`,
          type: "success",
        });
        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 领取功法残卷失败: ${error.message || "未知错误"}`,
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
    message.success("批量领取功法残卷结束");
  };

  /**
   * 增强版批量赠送功法残卷（含完善的验证和错误处理）
   */
  const batchLegacyGiftSendEnhanced = async (isScheduledTask = false) => {
    if (selectedTokens.value.length === 0) {
      message.warning("请先选择要操作的角色");
      return;
    }

    const recipientId = isScheduledTask
      ? batchSettings.receiverId
      : recipientIdInput.value;
    const password = isScheduledTask
      ? batchSettings.password
      : securityPassword.value;

    const giftConfig = {
      recipientId: Number(recipientId),
      itemId: 37007,
      quantity: Math.min(giftQuantity.value, 9999) || 0,
      serverName: recipientInfo.value?.serverName || "",
      name: recipientInfo.value?.name || "",
    };

    if (!isScheduledTask) {
      if (!giftConfig.recipientId || giftConfig.recipientId <= 0) {
        message.error("请输入有效的接收者ID");
        return;
      }

      if (giftConfig.quantity <= 0 || giftConfig.quantity > 9999) {
        message.error("赠送数量必须在1-9999之间");
        return;
      }
    }

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    let totalSuccess = 0;
    let totalFailed = 0;

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);
      let consecutiveErrors = 0;
      const maxRetries = 2;

      while (consecutiveErrors <= maxRetries && !shouldStop.value) {
        try {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== 开始赠送功法残卷: ${token.name} (尝试 ${consecutiveErrors + 1}/${maxRetries + 1}) ===`,
            type: "info",
          });

          await ensureConnection(tokenId);

          const roleInfo = await sendRoleInfo(tokenId);
          const legacyFragmentCount =
            Math.min(
              roleInfo?.role?.items?.[giftConfig.itemId]?.quantity,
              9999,
            ) || 0;
          if (isScheduledTask) {
            if (legacyFragmentCount === 0) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 功法残卷不足，当前拥有: 0 ===`,
                type: "error",
              });
              tokenStatus.value[tokenId] = "failed";
              totalFailed++;
              break;
            }
            const rankroleinfo = await tokenStore.sendMessageWithPromise(
              tokenId,
              "rank_getroleinfo",
              {
                bottleType: 0,
                includeBottleTeam: false,
                isSearch: false,
                roleId: giftConfig.recipientId,
              },
              5000,
            );
            giftConfig.serverName = rankroleinfo?.roleInfo?.serverName || "";
            giftConfig.name = rankroleinfo?.roleInfo?.name || "";
            if (!rankroleinfo?.roleInfo?.roleId) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 赠送功法残卷失败: 接收者${giftConfig.recipientId}不存在`,
                type: "error",
              });
              tokenStatus.value[tokenId] = "failed";
              totalFailed++;
              break;
            }
            const configuredQuantity = Number(batchSettings.giftQuantity);
            giftConfig.quantity =
              Number.isFinite(configuredQuantity) && configuredQuantity > 0
                ? Math.min(configuredQuantity, legacyFragmentCount)
                : legacyFragmentCount;
          }

          if (legacyFragmentCount < giftConfig.quantity) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== ${token.name} 功法残卷不足，当前拥有: ${legacyFragmentCount}，需要: ${giftConfig.quantity} ===`,
              type: "error",
            });
            tokenStatus.value[tokenId] = "failed";
            totalFailed++;
            break;
          }

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== 开始解除安全密码验证 ===`,
            type: "info",
          });

          const commitPasswordResp = await tokenStore.sendMessageWithPromise(
            tokenId,
            "role_commitpassword",
            {
              password: password,
              passwordType: 1,
            },
            5000,
          );

          if (!commitPasswordResp) {
            throw new Error("安全密码验证请求无响应");
          }
          if (!commitPasswordResp.role?.statistics?.["que:wh:tm"]) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} === 密码解除失败,请检查密码是否配置正确 ===`,
              type: "error",
            });
            tokenStatus.value[tokenId] = "failed";
            totalFailed++;
            break;
          }
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== 安全密码验证成功 ===`,
            type: "success",
          });

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} === 开始赠送功法残卷${giftConfig.quantity}个,目标:[${giftConfig.serverName}] ID:${giftConfig.recipientId} ${giftConfig.name} ===`,
            type: "info",
          });

          const legacySendGiftResp = await tokenStore.sendMessageWithPromise(
            tokenId,
            "legacy_sendgift",
            {
              itemCnt: giftConfig.quantity,
              legacyUIds: [],
              targetId: giftConfig.recipientId,
            },
            5000,
          );

          if (!legacySendGiftResp) {
            throw new Error("赠送请求无响应");
          }

          await sendRoleInfo(tokenId);

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== ${token.name} 成功赠送功法残卷${giftConfig.quantity}个给[${giftConfig.serverName}] ID:${giftConfig.recipientId} ${giftConfig.name} ===`,
            type: "success",
          });

          tokenStatus.value[tokenId] = "completed";
          totalSuccess++;
          break;
        } catch (error) {
          // 限流(400340)由 tokenStore 统一处理（弹窗 + 每 5 秒重试），此处只处理真正的失败
          consecutiveErrors++;
          console.error(`赠送失败: ${error.message}`);

          let errorMsg = error.message || "未知错误";
          let errorType = "error";

          if (errorMsg.includes("200160")) {
            errorMsg = "模块未开启";
          } else if (errorMsg.includes("timeout")) {
            errorMsg = "请求超时";
            errorType = "warning";
          } else if (errorMsg.includes("网络")) {
            errorMsg = "网络错误";
            errorType = "warning";
          }

          if (consecutiveErrors <= maxRetries && !shouldStop.value) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== ${token.name} 赠送功法残卷失败: ${errorMsg}，将在3秒后重试 ===`,
              type: "warning",
            });
            await new Promise((r) => setTimeout(r, delayConfig.long));
          } else {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== ${token.name} 赠送功法残卷失败: ${errorMsg}，已达最大重试次数 ===`,
              type: "error",
            });
            tokenStatus.value[tokenId] = "failed";
            totalFailed++;
            break;
          }
        } finally {
          tokenStore.closeWebSocketConnection(tokenId);
          releaseConnectionSlot();
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
            type: "info",
          });
        }
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;

    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== 批量赠送功法残卷完成: 成功 ${totalSuccess} 个，失败 ${totalFailed} 个 ===`,
      type: "success",
    });

    message.success(
      `批量赠送功法残卷结束，成功 ${totalSuccess} 个，失败 ${totalFailed} 个`,
    );
  };

  return {
    batchLegacyClaim,
    batchLegacyStartHangUp,
    batchLegacyGiftSendEnhanced,
  };
}
