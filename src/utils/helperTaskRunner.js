export const HELPER_BATCH_SIZE = 10;
export const HELPER_BATCH_DELAY_MS = 300;
export const HELPER_COMMAND_TIMEOUT_MS = 5000;
export const HELPER_RETRY_DELAY_MS = 1000;
export const HELPER_MAX_RETRIES = 2;

// 统一限流重试口径（2026-09-28 master 口径）：
//   命中服务器限流 → 每 5 秒重试一次，且不再设次数上限（持续重试到成功为止）。
//   400340 的弹窗/自动关窗由 tokenStore 统一控制器负责，这里只是兜底的间隔与上限。
export const RATE_LIMIT_RETRY_DELAY_MS = 5000;
export const RATE_LIMIT_MAX_RETRIES = Infinity;

// 统一超时重试口径（2026-09-29 master 口径）：
//   「请求超时」不应直接判死跳过账号，自动重试后再失败才算失败。
//   ⚠️ 语义说明：超时 ≠ 未送达，非幂等命令（招募/购买等）重试在极少数情况下
//   可能重复执行一次；重试仅 1 次 + 3 秒间隔，日志可见（warning）。
export const TIMEOUT_RETRY_DELAY_MS = 3000;
export const TIMEOUT_RETRY_MAX = 1;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function buildTenBatchPlan(total, batchSize = HELPER_BATCH_SIZE) {
  const safeTotal = Math.max(0, Math.trunc(Number(total) || 0));
  const safeBatchSize = Math.max(
    1,
    Math.trunc(Number(batchSize) || HELPER_BATCH_SIZE),
  );
  const fullBatches = Math.floor(safeTotal / safeBatchSize);
  const remainder = safeTotal % safeBatchSize;
  const plan = Array.from({ length: fullBatches }, () => safeBatchSize);

  if (remainder > 0) {
    plan.push(remainder);
  }

  return plan;
}

export function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

export function markRateLimitRetriesExhausted(error) {
  const retryError =
    error && typeof error === "object"
      ? error
      : new Error(getErrorMessage(error));
  retryError.rateLimitRetriesExhausted = true;
  return retryError;
}

export function getErrorDetails(error) {
  const details = [];
  const code = error?.code ?? error?.errorCode;
  const hint = error?.hint;
  const responseStatus = error?.response?.status;
  const responseCode = error?.response?.data?.code;

  if (code !== undefined && code !== null) {
    details.push(`code=${code}`);
  }

  if (responseStatus !== undefined && responseStatus !== null) {
    details.push(`httpStatus=${responseStatus}`);
  }

  if (
    responseCode !== undefined &&
    responseCode !== null &&
    responseCode !== code
  ) {
    details.push(`responseCode=${responseCode}`);
  }

  if (hint) {
    details.push(`hint=${hint}`);
  }

  details.push(`message=${getErrorMessage(error)}`);
  return details.join(" | ");
}

function getErrorSearchText(error) {
  return [
    getErrorMessage(error),
    error?.code,
    error?.errorCode,
    error?.response?.status,
    error?.response?.data?.code,
    error?.response?.data?.message,
    error?.response?.data?.hint,
  ]
    .filter((value) => value !== undefined && value !== null)
    .join(" ");
}

export function is400340Error(error) {
  return getErrorSearchText(error).includes("400340");
}

export function isRateLimitError(error) {
  if (error?.rateLimitRetriesExhausted) return false;

  const message = getErrorSearchText(error);

  return (
    is400340Error(error) ||
    message.includes("400312") ||
    message.includes("200400") ||
    message.includes("12400000") ||
    message.includes("429") ||
    message.includes("操作过快") ||
    message.includes("操作太快") ||
    message.includes("请求频繁") ||
    message.includes("过于频繁") ||
    message.includes("限流") ||
    message.includes("屏蔽")
  );
}

export async function runWithRateLimitRetry({
  execute,
  retryDelayMs = RATE_LIMIT_RETRY_DELAY_MS,
  maxRetries = RATE_LIMIT_MAX_RETRIES,
  sleepFn = sleep,
  shouldRetry = isRateLimitError,
  onRetry,
}) {
  // Infinity 表示不限次数（持续重试到成功为止）
  const retryLimit =
    maxRetries === Infinity
      ? Infinity
      : Number.isFinite(Number(maxRetries))
        ? Math.max(0, Math.trunc(Number(maxRetries)))
        : 0;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await execute();
    } catch (error) {
      if (attempt >= retryLimit || !shouldRetry(error)) {
        throw error;
      }

      onRetry?.({
        error,
        retryCount: attempt + 1,
        maxRetries: retryLimit,
      });
      await sleepFn(retryDelayMs);
    }
  }
}

export function isWebSocketNotConnectedError(error) {
  return getErrorSearchText(error).includes("WebSocket未连接");
}

/** 「请求超时」= 帧发出后 timeoutMs 内没等到响应（xyzwWebSocket 超时器） */
export function isTimeoutError(error) {
  return getErrorMessage(error).includes("请求超时");
}

/**
 * 通用「请求超时」重试：execute 整体重跑（不是重发单帧）。
 * 适合任务级恢复——execute 内部会重新读进度/库存的任务（如金鱼消耗）重跑是安全的。
 * 非「请求超时」错误原样抛出；用户停止（shouldStop）后不再重试。
 */
export async function runWithTimeoutRetry({
  execute,
  retryDelayMs = TIMEOUT_RETRY_DELAY_MS,
  maxRetries = TIMEOUT_RETRY_MAX,
  shouldStop,
  onRetry,
  sleepFn = sleep,
}) {
  const retryLimit = Number.isFinite(Number(maxRetries))
    ? Math.max(0, Math.trunc(Number(maxRetries)))
    : 0;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await execute();
    } catch (error) {
      if (attempt >= retryLimit || !isTimeoutError(error) || shouldStop?.()) {
        throw error;
      }
      await onRetry?.({ error, retryCount: attempt + 1, maxRetries: retryLimit });
      if (shouldStop?.()) throw error;
      await sleepFn(retryDelayMs);
    }
  }
}

/**
 * tokenStore 发送层的超时自动重试（2026-09-29 master 口径：超时应重试而不是跳过）。
 * 返回包装后的 tokenStore：sendMessageWithPromise 遇「请求超时」→ 等 3 秒 → 原样重发 1 次；
 * 其他错误原样抛出。重试前检查 shouldStop（用户点了停止就不再重试）。
 *
 * ⚠️ 为什么不在这一层做多次重试：超时的帧可能已送达并执行（响应只是丢了），
 * 非幂等命令重复执行会双倍消耗。这里只兜 1 次，任务级需要更强恢复（如金鱼
 * 「读进度→补差值」step 重跑）由各编排器自行叠加。
 */
export function wrapTokenStoreWithTimeoutRetry(tokenStore, options = {}) {
  const {
    retryDelayMs = TIMEOUT_RETRY_DELAY_MS,
    maxRetries = TIMEOUT_RETRY_MAX,
    onRetry,
    shouldStop,
    sleepFn = sleep,
  } = options;

  const retryLimit = Number.isFinite(Number(maxRetries))
    ? Math.max(0, Math.trunc(Number(maxRetries)))
    : 0;

  const sendWithTimeoutRetry = async (tokenId, cmd, params, timeout) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await tokenStore.sendMessageWithPromise(
          tokenId,
          cmd,
          params,
          timeout,
        );
      } catch (error) {
        if (
          attempt >= retryLimit ||
          !isTimeoutError(error) ||
          shouldStop?.()
        ) {
          throw error;
        }
        onRetry?.({ tokenId, cmd, error, retryCount: attempt + 1 });
        await sleepFn(retryDelayMs);
        if (shouldStop?.()) throw error;
      }
    }
  };

  return new Proxy(tokenStore, {
    get(target, property, receiver) {
      if (property === "sendMessageWithPromise") {
        return sendWithTimeoutRetry;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function runWithWebSocketReconnectRetry({
  execute,
  reconnect,
  maxRetries = 2,
  onRetry,
}) {
  const retryLimit = Number.isFinite(Number(maxRetries))
    ? Math.max(0, Math.trunc(Number(maxRetries)))
    : 0;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await execute();
    } catch (error) {
      if (
        !reconnect ||
        attempt >= retryLimit ||
        !isWebSocketNotConnectedError(error)
      ) {
        throw error;
      }

      const retryCount = attempt + 1;
      onRetry?.({ error, retryCount, maxRetries: retryLimit });
      await reconnect({ error, retryCount, maxRetries: retryLimit });
    }
  }
}

export function isModuleUnavailableError(error) {
  const message = getErrorSearchText(error);

  return (
    message.includes("200160") ||
    /模块(?:未|不)(?:开启|开放)|功能(?:未|不)(?:开启|开放)|尚未开放/.test(
      message,
    )
  );
}

export function isSkippableTaskError(error, task) {
  if (isModuleUnavailableError(error)) {
    return true;
  }

  const skipErrorCodes = task?.skipErrorCodes ?? [];
  const message = getErrorSearchText(error);

  return skipErrorCodes.some((code) => message.includes(String(code)));
}

export function getItemQuantity(roleInfo, itemId) {
  const item =
    roleInfo?.role?.items?.[itemId] ??
    roleInfo?.role?.items?.[String(itemId)] ??
    roleInfo?.items?.[itemId] ??
    roleInfo?.items?.[String(itemId)];

  const quantity = item?.quantity ?? item?.count ?? 0;
  const numericQuantity = Number(quantity);

  return Number.isFinite(numericQuantity) ? numericQuantity : 0;
}

function toFiniteNumber(value) {
  if (typeof value === "string") {
    value = value.replace(/,/g, "").trim();
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function pickNumericLeaf(value) {
  const directNumber = toFiniteNumber(value);

  if (directNumber !== null) {
    return directNumber;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const preferredKeys = [
    "canClaim",
    "claimable",
    "available",
    "value",
    "amount",
    "quantity",
    "count",
    "num",
    "points",
    "score",
  ];

  for (const key of preferredKeys) {
    const number = toFiniteNumber(value[key]);

    if (number !== null) {
      return number;
    }
  }

  return null;
}

export function getClaimableBoxPoints(roleInfo) {
  const candidates = [
    roleInfo?.role?.boxPoint,
    roleInfo?.role?.boxPoints,
    roleInfo?.role?.box_point,
    roleInfo?.role?.box_points,
    roleInfo?.role?.boxPointReward,
    roleInfo?.role?.boxPointRewards,
    roleInfo?.role?.box_point_reward,
    roleInfo?.data?.role?.boxPoint,
    roleInfo?.data?.role?.boxPoints,
    roleInfo?.data?.role?.box_point,
    roleInfo?.data?.role?.box_points,
    roleInfo?.data?.role?.boxPointReward,
    roleInfo?.data?.role?.boxPointRewards,
    roleInfo?.data?.role?.box_point_reward,
    roleInfo?.boxPoint,
    roleInfo?.boxPoints,
    roleInfo?.box_point,
    roleInfo?.box_points,
    roleInfo?.boxPointReward,
    roleInfo?.boxPointRewards,
    roleInfo?.box_point_reward,
  ];

  for (const candidate of candidates) {
    const number = pickNumericLeaf(candidate);

    if (number !== null) {
      return Math.max(0, Math.trunc(number));
    }
  }

  const matches = [];
  const seen = new Set();
  const scan = (value, path = "", depth = 0) => {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) {
      return;
    }

    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;

      if (/box[_-]?points?|box.*point|point.*box/i.test(key)) {
        const number = pickNumericLeaf(child);

        if (number !== null) {
          matches.push({ path: nextPath, number });
        }
      }

      scan(child, nextPath, depth + 1);
    }
  };

  scan(roleInfo);

  if (matches.length === 0) {
    return 0;
  }

  matches.sort((left, right) => {
    const leftClaimScore = /claim|available|reward/i.test(left.path) ? 1 : 0;
    const rightClaimScore = /claim|available|reward/i.test(right.path) ? 1 : 0;

    return rightClaimScore - leftClaimScore;
  });

  return Math.max(0, Math.trunc(matches[0].number));
}

export async function runBatchedGameCommand({
  tokenStore,
  tokenId,
  cmd,
  total,
  createParams,
  batchSize = HELPER_BATCH_SIZE,
  timeout = HELPER_COMMAND_TIMEOUT_MS,
  delayMs = HELPER_BATCH_DELAY_MS,
  retryDelayMs = HELPER_RETRY_DELAY_MS,
  maxRetries = HELPER_MAX_RETRIES,
  sleepFn = sleep,
  onProgress,
}) {
  const plan = buildTenBatchPlan(total, batchSize);
  let completed = 0;

  for (const [index, batchAmount] of plan.entries()) {
    for (let attempt = 0; ; attempt++) {
      try {
        await tokenStore.sendMessageWithPromise(
          tokenId,
          cmd,
          createParams(batchAmount),
          timeout,
        );
        break;
      } catch (error) {
        if (attempt >= maxRetries || !isRateLimitError(error)) {
          throw error;
        }

        await sleepFn(retryDelayMs * (attempt + 1));
      }
    }

    completed += batchAmount;
    onProgress?.({
      batchIndex: index + 1,
      batchCount: plan.length,
      batchAmount,
      completed,
      total: Math.max(0, Math.trunc(Number(total) || 0)),
    });

    if (delayMs > 0 && index < plan.length - 1) {
      await sleepFn(delayMs);
    }
  }

  return { batchCount: plan.length, completed };
}

export async function runInventoryVerifiedGameCommand({
  tokenStore,
  tokenId,
  cmd,
  itemId,
  total,
  createParams,
  queryInventory,
  batchSize = HELPER_BATCH_SIZE,
  timeout = HELPER_COMMAND_TIMEOUT_MS,
  delayMs = HELPER_BATCH_DELAY_MS,
  retryDelayMs = HELPER_RETRY_DELAY_MS,
  maxRetries = HELPER_MAX_RETRIES,
  sleepFn = sleep,
  onProgress,
}) {
  const targetTotal = Math.max(0, Math.trunc(Number(total) || 0));
  const initialRoleInfo = await queryInventory();
  let currentCount = getItemQuantity(initialRoleInfo, itemId);

  if (currentCount < targetTotal) {
    throw new Error(`库存不足：当前 ${currentCount}，需要 ${targetTotal}`);
  }

  const initialCount = currentCount;
  let verifiedConsumed = 0;
  let verificationIndex = 0;

  while (verifiedConsumed < targetTotal) {
    verificationIndex += 1;
    const remaining = targetTotal - verifiedConsumed;
    const beforeCount = currentCount;
    const plan = buildTenBatchPlan(remaining, batchSize);
    let attemptedAmount = 0;
    let lastStageError = null;

    for (const [index, batchAmount] of plan.entries()) {
      for (let attempt = 0; ; attempt++) {
        try {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            cmd,
            createParams(batchAmount),
            timeout,
          );
          break;
        } catch (error) {
          lastStageError = error;

          if (attempt < maxRetries && isRateLimitError(error)) {
            await sleepFn(retryDelayMs * (attempt + 1));
            continue;
          }

          break;
        }
      }

      attemptedAmount += batchAmount;

      if (delayMs > 0 && index < plan.length - 1) {
        await sleepFn(delayMs);
      }
    }

    const roleInfo = await queryInventory();
    currentCount = getItemQuantity(roleInfo, itemId);
    const totalConsumed = Math.max(0, initialCount - currentCount);
    const consumed = totalConsumed - verifiedConsumed;

    if (consumed <= 0) {
      const errorSuffix = lastStageError
        ? `，最近错误：${getErrorMessage(lastStageError)}`
        : "";
      throw new Error(`库存未变化：${cmd} 本次没有消耗道具${errorSuffix}`);
    }

    verifiedConsumed = totalConsumed;
    onProgress?.({
      batchIndex: verificationIndex,
      batchAmount: attemptedAmount,
      consumed,
      completed: Math.min(verifiedConsumed, targetTotal),
      total: targetTotal,
      beforeCount,
      afterCount: currentCount,
    });

    if (verifiedConsumed < targetTotal && delayMs > 0) {
      await sleepFn(delayMs);
    }
  }

  return {
    completed: targetTotal,
    finalCount: currentCount,
    initialCount,
  };
}
