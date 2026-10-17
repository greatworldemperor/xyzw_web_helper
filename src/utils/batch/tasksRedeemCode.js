/**
 * 批量兑换码（CDK）模块，2026-10-17 接入
 *
 * 协议证据：`local-data/misc/redemption_code.jsonl`（master 手工兑换 wuzhounian2026 抓包，
 * xyzw-protocol-re skill 解码 + 逐字节复现验证：SEND 帧精确 = 1 / 失败 = 0）：
 *
 *   请求  system_claimcdkreward { key: "wuzhounian2026", platformType: "h5" }
 *         → SyncRewardResp（resp 匹配请求 seq）
 *   成功 body.reward[] = [{type:3, itemId, value, ext}, ...]（本例 4 件奖励）
 *         body.role.statistics["cdk:<兑换码>_0"] = 兑换时间戳（服务端记账键，可用于判断该码是否兑过）
 *
 * 失败信封（skill 已知边界，本抓包无失败样本）：{ seq, ack, time, resp, code, error }，
 * 无 cmd 无 body，error = 服务端中文文案（如「兑换码无效/已被使用」）——
 * 文案归类正则是按常见措辞写的宽松匹配，匹配不上一律走「失败 + error 透传」，
 * 上线跑一次真实失败样本后如有偏差再修。
 *
 * 实现口径：
 *   - 兑换码不写死：页面文本框输入，按换行（兼容空格/逗号/分号）分割，trim 去空去重保序；
 *   - 每个选中账号依次兑同一批码（CDK 按账号记账，一个码每个账号各兑一次）；
 *   - 触发限流(400340)立即停本账号剩余兑换；「已使用」类算 benign 不算失败；
 *   - 连接生命周期与周年庆模块同口径：ensureConnection → finally close + releaseSlot；
 *   - 不进自由/定时模板（兑换码是一次性手动操作，与合并鱼 goldenfishUseItem 同待遇），
 *     入口只保留批量日常页「兑换码」文本框 + 按钮。
 */
const nowText = () => new Date().toLocaleTimeString();

/**
 * 解析兑换码输入：按换行为主分割（兼容空格/中英文逗号/分号/tab），
 * trim、滤空、去重（保序；大小写敏感，兑换码大小写是码的一部分）。
 */
export function parseRedeemCodes(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  return [
    ...new Set(
      text
        .split(/[\s,;，；]+/)
        .map((code) => code.trim())
        .filter(Boolean),
    ),
  ];
}

/** 服务端错误信封 → 判定文本（createServerError 会把 error / message 都挂上） */
const errorText = (error) =>
  String(error?.error || error?.message || error || "");

/** 已兑过：幂等重跑常态，不算失败（失败样本待线上实测校准措辞） */
const isAlreadyUsedError = (error) =>
  /已使用|已被使用|已兑换|已领取|兑换过|重复/.test(errorText(error));

/** 服务端限流（项目通用码）：不是失败，是「这次别连发了」 */
const isRateLimitError = (error) => Number(error?.code) === 400340;

/** 成功响应 reward[] → 可读文案 */
const rewardText = (response) => {
  const list = Array.isArray(response?.reward) ? response.reward : [];
  if (list.length === 0) return "奖励已同步";
  return list
    .map((item) => `itemId ${item.itemId} ×${item.value}`)
    .join("、");
};

/** 两条兑换指令之间的间隔（ms）：与周年庆领取同口径，不连发 */
const REDEEM_INTERVAL_MS = 500;

export function createTasksRedeemCode(deps) {
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
    addLog,
    message,
    currentRunningTokenId,
  } = deps;

  const log = (tokenName, text, type = "info") =>
    addLog({ time: nowText(), message: `${tokenName} ${text}`, type });

  const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  /**
   * 单个账号：依次兑一批码
   * @returns {{ redeemed: number, alreadyUsed: number, failed: number }}
   */
  const redeemCodesForToken = async ({ tokenId, token, codes }) => {
    const tokenName = token?.name || tokenId;
    const stats = { redeemed: 0, alreadyUsed: 0, failed: 0 };

    for (const code of codes) {
      if (shouldStop.value) break;
      try {
        const response = await tokenStore.sendMessageWithPromise(
          tokenId,
          "system_claimcdkreward",
          { key: code, platformType: "h5" },
          8000,
        );
        stats.redeemed += 1;
        log(
          tokenName,
          `兑换码 ${code} 兑换成功（${rewardText(response)}）`,
          "success",
        );
      } catch (error) {
        if (isRateLimitError(error)) {
          // ⚠️ 不能 continue（会跳过末尾 sleep 变成连发）→ 直接结束本账号
          log(tokenName, "触发限流(400340)，本账号剩余兑换码下次再兑", "warning");
          break;
        }
        if (isAlreadyUsedError(error)) {
          stats.alreadyUsed += 1;
          log(tokenName, `兑换码 ${code} 已兑过，跳过（${errorText(error)}）`);
        } else {
          stats.failed += 1;
          log(
            tokenName,
            `兑换码 ${code} 兑换失败：${errorText(error)}`,
            "error",
          );
        }
      }
      await sleep(REDEEM_INTERVAL_MS);
    }

    return stats;
  };

  /** 批量兑换码（对所有选中账号，输入 = 文本框原文） */
  const batchRedeemCodes = async (codesText) => {
    const codes = parseRedeemCodes(codesText);
    if (codes.length === 0) {
      message.warning("请先输入兑换码（每行一个）");
      return;
    }
    if (selectedTokens.value.length === 0) {
      message.warning("请先选择账号");
      return;
    }

    isRunning.value = true;
    shouldStop.value = false;
    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const total = { redeemed: 0, alreadyUsed: 0, failed: 0 };

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((item) => item.id === tokenId);
      const tokenName = token?.name || tokenId;

      try {
        addLog({
          time: nowText(),
          message: `=== 开始批量兑换码（${codes.length} 个）: ${tokenName} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        const stats = await redeemCodesForToken({ tokenId, token, codes });
        total.redeemed += stats.redeemed;
        total.alreadyUsed += stats.alreadyUsed;
        total.failed += stats.failed;

        log(
          tokenName,
          `兑换码批次完成：成功 ${stats.redeemed} / 已兑过 ${stats.alreadyUsed} / 失败 ${stats.failed}（共 ${codes.length}）`,
          stats.failed > 0 ? "warning" : "success",
        );
        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        tokenStatus.value[tokenId] = "failed";
        log(tokenName, `批量兑换码失败：${errorText(error)}`, "error");
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
    addLog({
      time: nowText(),
      message: `批量兑换码全部结束：成功 ${total.redeemed} / 已兑过 ${total.alreadyUsed} / 失败 ${total.failed}`,
      type: "info",
    });
    message.success("批量兑换码结束");
  };

  return { batchRedeemCodes };
}
