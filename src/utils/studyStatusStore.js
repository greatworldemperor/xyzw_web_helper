/**
 * 答题状态：按 tokenId 隔离的存储 + 完成握手
 *
 * 🔴 背景（2026-09-29 修复）：
 * `tokenStore.gameData.studyStatus` 是**全局单例**，批量一键答题时 N 个角色
 * 并发读写同一个对象，互相覆盖：
 *   - A 可能读到 B 的 `completed` → 误判自己完成 → 立刻关连接，
 *     A 剩余题目与 study_claimreward 随连接一起丢失（界面还显示成功）；
 *   - 反向：A 完成后 1 秒 studyStatus 被重置为 ''，B 错过窗口 → 干等超时。
 * 因此这里按 tokenId 单独存一份状态，并提供 Promise 握手，取代全局轮询。
 *
 * 注意：`gameData.studyStatus` 仍会被写入，供单角色 UI（StudyChallengeCard /
 * GameStatus）展示，但它只作展示用，批量判定一律走本模块。
 */

const statusByToken = new Map();
const waitersByToken = new Map();

const normalizeTokenId = (tokenId) => String(tokenId ?? "");

export const createInitialStudyStatus = () => ({
  isAnswering: false,
  questionCount: 0,
  answeredCount: 0,
  status: "", // '', 'answering', 'claiming_rewards', 'completed', 'failed'
  timestamp: null,
  error: null,
});

/**
 * 重置某个角色的答题状态（每次开始答题前调用）
 */
export const resetStudyStatus = (tokenId) => {
  const key = normalizeTokenId(tokenId);
  const pending = waitersByToken.get(key);
  if (pending?.length) {
    // 上一轮遗留的等待者直接按超时处理，避免它们被新一轮的完成事件误唤醒
    waitersByToken.delete(key);
    pending.forEach(({ timeoutId, reject }) => {
      clearTimeout(timeoutId);
      reject(new Error("答题状态已重置（新一轮答题开始）"));
    });
  }

  const next = createInitialStudyStatus();
  statusByToken.set(key, next);
  return next;
};

export const getStudyStatus = (tokenId) =>
  statusByToken.get(normalizeTokenId(tokenId)) || createInitialStudyStatus();

const settleWaiters = (tokenId, status) => {
  const key = normalizeTokenId(tokenId);
  const waiters = waitersByToken.get(key);
  if (!waiters?.length) return;
  waitersByToken.delete(key);

  waiters.forEach(({ timeoutId, resolve, reject }) => {
    clearTimeout(timeoutId);
    if (status.status === "completed") {
      resolve(status);
    } else {
      const error = new Error(status.error || "答题失败");
      error.studyStatus = status;
      reject(error);
    }
  });
};

/**
 * 更新某个角色的答题状态；写入 'completed' / 'failed' 时唤醒等待者
 */
export const patchStudyStatus = (tokenId, patch) => {
  const key = normalizeTokenId(tokenId);
  const current = statusByToken.get(key) || createInitialStudyStatus();
  const next = { ...current, ...patch };
  statusByToken.set(key, next);

  if (next.status === "completed" || next.status === "failed") {
    settleWaiters(tokenId, next);
  }

  return next;
};

/**
 * 等待某个角色答题结束（completed 或 failed）
 * @returns {Promise<Object>} 终态 status
 */
export const waitStudyFinish = (tokenId, timeoutMs = 60000) =>
  new Promise((resolve, reject) => {
    const key = normalizeTokenId(tokenId);
    const current = statusByToken.get(key);

    if (current?.status === "completed") {
      resolve(current);
      return;
    }
    if (current?.status === "failed") {
      const error = new Error(current.error || "答题失败");
      error.studyStatus = current;
      reject(error);
      return;
    }

    const timeoutId = setTimeout(() => {
      const list = waitersByToken.get(key) || [];
      waitersByToken.set(
        key,
        list.filter((waiter) => waiter.timeoutId !== timeoutId),
      );
      reject(new Error("答题超时"));
    }, timeoutMs);

    const list = waitersByToken.get(key) || [];
    list.push({ resolve, reject, timeoutId });
    waitersByToken.set(key, list);
  });

/**
 * 测试/调试用：清空全部状态
 */
export const clearStudyStatusStore = () => {
  waitersByToken.forEach((waiters) => {
    waiters.forEach(({ timeoutId }) => clearTimeout(timeoutId));
  });
  waitersByToken.clear();
  statusByToken.clear();
};
