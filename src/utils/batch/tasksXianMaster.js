/**
 * 咸主关系查询任务。
 * 只读取 role_getroleinfo，不执行抓人或其他写操作。
 */

const normalizeRoleId = (value) => {
  const roleId = Number(value);
  return Number.isSafeInteger(roleId) && roleId > 0 ? String(roleId) : "";
};

const getRole = (response) =>
  response?.role || response?.body?.role || response?.body || response || {};

export function createTasksXianMaster(deps) {
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
    xianMasterResult,
    showXianMasterResultModal,
  } = deps;

  const sendRoleInfo =
    batchSendRoleInfo ||
    ((tokenId, params = {}) =>
      tokenStore.sendMessageWithPromise(
        tokenId,
        "role_getroleinfo",
        params,
        10000,
      ));

  /**
   * @param {boolean} includeExistingBosses 是否保留已经存在于 Token 列表的咸主
   */
  const detectXianMasters = async (includeExistingBosses = false) => {
    if (selectedTokens.value.length === 0) {
      message?.warning?.("请先选择要检测的账号");
      return { detected: 0, ignored: 0, withoutBoss: 0, failed: 0 };
    }

    const tokenList = Array.isArray(tokens?.value)
      ? tokens.value
      : tokenStore.gameTokens || [];
    const existingRoleIds = new Set(
      tokenList.map((token) => normalizeRoleId(token?.roleId)).filter(Boolean),
    );
    const summary = {
      detected: 0,
      detectedRoles: [],
      ignored: 0,
      withoutBoss: 0,
      failed: 0,
    };

    isRunning.value = true;
    shouldStop.value = false;
    selectedTokens.value.forEach((tokenId) => {
      tokenStatus.value[tokenId] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokenList.find((item) => item.id === tokenId);
      const tokenName = token?.name || tokenId;

      try {
        addLog?.({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始检测咸主: ${tokenName} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);
        if (shouldStop.value) return;

        const response = await sendRoleInfo(
          tokenId,
          {},
          10000,
          "检测咸主",
        );
        const role = getRole(response);
        const bossId = normalizeRoleId(role?.bossId);

        if (!bossId) {
          summary.withoutBoss += 1;
          tokenStatus.value[tokenId] = "completed";
          addLog?.({
            time: new Date().toLocaleTimeString(),
            message: `${tokenName} 未检测到咸主`,
            type: "info",
          });
          return;
        }

        if (!includeExistingBosses && existingRoleIds.has(bossId)) {
          summary.ignored += 1;
          tokenStatus.value[tokenId] = "completed";
          addLog?.({
            time: new Date().toLocaleTimeString(),
            message: `${tokenName} 的咸主 roleId=${bossId} 已在 Token 列表中，按设置忽略`,
            type: "info",
          });
          return;
        }

        summary.detected += 1;
        summary.detectedRoles.push({
          tokenId,
          tokenName,
          roleId: normalizeRoleId(role?.roleId) || normalizeRoleId(token?.roleId),
          roleName: role?.name || tokenName,
          bossId,
          bossName: role?.bossName || "",
        });
        tokenStatus.value[tokenId] = "completed";
        addLog?.({
          time: new Date().toLocaleTimeString(),
          message: `${tokenName} 检测到咸主: roleId=${bossId}${
            role?.bossHeadImg ? "（已返回头像）" : ""
          }`,
          type: "success",
        });
      } catch (error) {
        summary.failed += 1;
        tokenStatus.value[tokenId] = "failed";
        addLog?.({
          time: new Date().toLocaleTimeString(),
          message: `${tokenName} 检测咸主失败: ${error?.message || "未知错误"}`,
          type: "error",
        });
      } finally {
        await tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog?.({
          time: new Date().toLocaleTimeString(),
          message: `${tokenName} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    shouldStop.value = false;
    if (xianMasterResult) {
      Object.assign(xianMasterResult, summary);
    }
    if (showXianMasterResultModal) {
      showXianMasterResultModal.value = true;
    }
    return summary;
  };

  return { detectXianMasters };
}