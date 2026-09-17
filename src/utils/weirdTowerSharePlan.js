/**
 * 怪异塔助力：关系模型 / 自动分配 / 校验（纯逻辑，无 Vue 依赖，可单测）
 *
 * 设计见 docs/weird-tower-share-assist-design.md
 *
 * 数据模型：
 *   plan = {
 *     version: 1,
 *     receivers: [ { key, name, server, mode: "manual"|"auto", slots: [k|null, k|null, k|null] } ],
 *     assistPool: [key, ...],
 *   }
 *   key = getStableTokenKey(serverId, roleId) → "<serverId>:<roleId>"
 *
 * 两条硬约束：
 *   1. 一个助力者只能占一个槽位（因为「每角色每周期只能发起 1 次助力」）→ 全局唯一。
 *   2. 不能把自己的码给自己助力。
 */

/** 每个接受助力角色固定 3 个槽位（协议：一个角色最多被助力 3 次） */
export const SHARE_SLOT_COUNT = 3;

/** 失败错误码（协议实测，见 docs/weird-tower-share-code-protocol.md §2.4） */
export const SHARE_ERROR_SELF_EXHAUSTED = 12200100; // 自己本周期已用过唯一一次助力机会
export const SHARE_ERROR_TARGET_FULL = 12200090; // 目标已被助力满 3 次

export const RECEIVER_MODE_MANUAL = "manual";
export const RECEIVER_MODE_AUTO = "auto";

export const PLAN_VERSION = 1;

const isKey = (v) => typeof v === "string" && v.trim().length > 0;

/** 空计划 */
export function createEmptyAssistPlan() {
  return { version: PLAN_VERSION, receivers: [], assistPool: [] };
}

/**
 * 规范化（读盘的容错 + 自愈）：
 * - 丢弃非法条目、receivers 去重
 * - slots 补齐为 3 个
 * - **全局唯一自愈**：同一个助力者出现在多个槽位时，只保留最早出现的那个，其余置空
 */
export function normalizeAssistPlan(raw) {
  const plan = createEmptyAssistPlan();
  if (!raw || typeof raw !== "object") return plan;

  if (Array.isArray(raw.receivers)) {
    const seenKeys = new Set();
    for (const item of raw.receivers) {
      if (!item || !isKey(item.key)) continue;
      const key = item.key.trim();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const rawSlots = Array.isArray(item.slots) ? item.slots : [];
      const slots = [];
      for (let i = 0; i < SHARE_SLOT_COUNT; i += 1) {
        const value = rawSlots[i];
        slots.push(isKey(value) ? value.trim() : null);
      }

      plan.receivers.push({
        key,
        name: typeof item.name === "string" ? item.name : "",
        server: typeof item.server === "string" ? item.server : "",
        mode: item.mode === RECEIVER_MODE_AUTO ? RECEIVER_MODE_AUTO : RECEIVER_MODE_MANUAL,
        slots,
      });
    }
  }

  if (Array.isArray(raw.assistPool)) {
    const seen = new Set();
    for (const key of raw.assistPool) {
      if (!isKey(key)) continue;
      const trimmed = key.trim();
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      plan.assistPool.push(trimmed);
    }
  }

  return healDuplicateAssignments(plan).plan;
}

/** 清掉「同一个助力者占了多个槽位」的重复（保留最早出现的） */
function healDuplicateAssignments(plan) {
  const used = new Set();
  const removed = [];
  const receivers = plan.receivers.map((receiversItem) => {
    const slots = receiversItem.slots.map((slotKey, slotIndex) => {
      if (!slotKey) return null;
      if (used.has(slotKey)) {
        removed.push({ receiverKey: receiversItem.key, slotIndex, initiatorKey: slotKey });
        return null;
      }
      used.add(slotKey);
      return slotKey;
    });
    return { ...receiversItem, slots };
  });
  return { plan: { ...plan, receivers }, removed };
}

/** 已占用的助力者 key 集合（手动 + 自动分配的结果都算） */
export function occupiedInitiatorKeys(plan) {
  const set = new Set();
  for (const receiver of plan.receivers) {
    for (const slotKey of receiver.slots) {
      if (slotKey) set.add(slotKey);
    }
  }
  return set;
}

/** 某个助力者被哪个接受角色占用了 */
export function findInitiatorOwner(plan, initiatorKey) {
  for (const receiver of plan.receivers) {
    const slotIndex = receiver.slots.indexOf(initiatorKey);
    if (slotIndex >= 0) return { receiverKey: receiver.key, slotIndex };
  }
  return null;
}

export function findReceiver(plan, key) {
  return plan.receivers.find((receiver) => receiver.key === key) || null;
}

/** 追加接受助力角色（已存在的跳过 —— 按钮 1.1 的语义：追加，不覆盖） */
export function upsertReceivers(plan, entries = []) {
  const next = normalizeAssistPlan(plan);
  const existing = new Set(next.receivers.map((receiver) => receiver.key));
  const added = [];
  for (const entry of entries) {
    if (!isKey(entry?.key)) continue;
    const key = entry.key.trim();
    if (existing.has(key)) continue;
    existing.add(key);
    added.push(key);
    next.receivers.push({
      key,
      name: typeof entry.name === "string" ? entry.name : "",
      server: typeof entry.server === "string" ? entry.server : "",
      mode: RECEIVER_MODE_MANUAL,
      slots: new Array(SHARE_SLOT_COUNT).fill(null),
    });
  }
  return { plan: next, added };
}

export function removeReceivers(plan, keys = []) {
  const drop = new Set(keys);
  const base = normalizeAssistPlan(plan);
  return {
    ...base,
    receivers: base.receivers.filter((receiver) => !drop.has(receiver.key)),
  };
}

/** 设置助力角色池（按钮 1.2 的语义：直接覆盖，不是合并） */
export function setAssistPool(plan, keys = []) {
  const base = normalizeAssistPlan(plan);
  const seen = new Set();
  const pool = [];
  for (const key of keys) {
    if (!isKey(key)) continue;
    const trimmed = key.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    pool.push(trimmed);
  }
  return { ...base, assistPool: pool };
}

/**
 * 切换接受助力角色的模式。
 * master 确认的语义：**手动 → 自动 切换时清空该角色的 3 个槽**（完全交给自动分配）。
 * 自动 → 手动 时保留槽位（自动分配的结果可继续手工调整）。
 */
export function setReceiverMode(plan, receiverKey, mode) {
  const base = normalizeAssistPlan(plan);
  const nextMode = mode === RECEIVER_MODE_AUTO ? RECEIVER_MODE_AUTO : RECEIVER_MODE_MANUAL;
  return {
    ...base,
    receivers: base.receivers.map((receiver) => {
      if (receiver.key !== receiverKey) return receiver;
      if (nextMode === receiver.mode) return receiver;
      return {
        ...receiver,
        mode: nextMode,
        slots: nextMode === RECEIVER_MODE_AUTO ? new Array(SHARE_SLOT_COUNT).fill(null) : receiver.slots,
      };
    }),
  };
}

/**
 * 手动指定某个槽位的助力者。
 * 会做全局唯一处理：若该助力者已占别的槽位（含本角色其它槽），先把旧位置腾空。
 * @returns {{ plan, error?: "self" | "not-in-pool" | "invalid" }}
 */
export function setSlot(plan, receiverKey, slotIndex, initiatorKey) {
  const base = normalizeAssistPlan(plan);
  const receiver = findReceiver(base, receiverKey);
  if (!receiver) return { plan: base, error: "invalid" };
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= SHARE_SLOT_COUNT) {
    return { plan: base, error: "invalid" };
  }

  // 清空该槽
  if (!isKey(initiatorKey)) {
    return {
      plan: {
        ...base,
        receivers: base.receivers.map((item) =>
          item.key === receiverKey
            ? { ...item, slots: item.slots.map((s, i) => (i === slotIndex ? null : s)) }
            : item,
        ),
      },
    };
  }

  const target = initiatorKey.trim();
  if (target === receiverKey) return { plan: base, error: "self" };
  if (!base.assistPool.includes(target)) return { plan: base, error: "not-in-pool" };

  // 先把该助力者从所有槽位移除，再写入目标位置
  const receivers = base.receivers.map((item) => ({
    ...item,
    slots: item.slots.map((s) => (s === target ? null : s)),
  }));
  const updated = receivers.map((item) =>
    item.key === receiverKey
      ? { ...item, slots: item.slots.map((s, i) => (i === slotIndex ? target : s)) }
      : item,
  );

  return { plan: { ...base, receivers: updated } };
}

/** 从所有槽位里删掉某个助力者（该角色本周期额度用尽时用） */
export function releaseInitiator(plan, initiatorKey) {
  const base = normalizeAssistPlan(plan);
  return {
    ...base,
    receivers: base.receivers.map((receiver) => ({
      ...receiver,
      slots: receiver.slots.map((s) => (s === initiatorKey ? null : s)),
    })),
  };
}

/**
 * 自动分配：对所有 mode === "auto" 的接受角色补空槽。
 * 候选 = 助力池里「未被任何槽占用」且「本周期未用掉额度」的角色；排除 receiver 自己。
 *
 * @param {object} plan
 * @param {{ usedInitiators?: string[], random?: () => number,
 *           validKeys?: Set<string>|null }} [options]
 * @returns {{ plan, assigned: Array<{receiverKey, slotIndex, initiatorKey}>,
 *             shortages: Array<{receiverKey, missing}>, skippedPool: string[] }}
 */
export function autoAssignSlots(plan, options = {}) {
  const { usedInitiators = [], random = Math.random, validKeys = null } = options;
  const base = normalizeAssistPlan(plan);

  const used = new Set(usedInitiators.filter(isKey));
  const occupied = occupiedInitiatorKeys(base);

  // 候选池：去重、未占用、本周期未用掉额度、（若给了有效键）仍存在于角色列表
  let candidates = base.assistPool.filter(
    (key) =>
      !occupied.has(key) && !used.has(key) && (!validKeys || validKeys.has(key)),
  );

  const skippedPool = base.assistPool.filter(
    (key) => occupied.has(key) || used.has(key) || (validKeys && !validKeys.has(key)),
  );

  const assigned = [];
  const shortages = [];
  const receivers = base.receivers.map((receiver) => ({ ...receiver }));

  for (const receiver of receivers) {
    if (receiver.mode !== RECEIVER_MODE_AUTO) continue;
    const slots = [...receiver.slots];
    let missing = 0;

    for (let slotIndex = 0; slotIndex < SHARE_SLOT_COUNT; slotIndex += 1) {
      if (slots[slotIndex]) continue; // 已有占位（切换模式时已清空，这里兼容中途手填）

      // 每个槽位单独排除 receiver 自己
      const pickable = candidates.filter((key) => key !== receiver.key);
      if (pickable.length === 0) {
        missing += 1;
        continue;
      }

      const pickIndex = Math.floor(random() * pickable.length) % pickable.length;
      const picked = pickable[Math.abs(pickIndex)];
      candidates = candidates.filter((key) => key !== picked);
      slots[slotIndex] = picked;
      assigned.push({ receiverKey: receiver.key, slotIndex, initiatorKey: picked });
    }

    receiver.slots = slots;
    if (missing > 0) shortages.push({ receiverKey: receiver.key, missing });
  }

  return { plan: { ...base, receivers }, assigned, shortages, skippedPool };
}

/**
 * 收集待执行的助力动作。
 * @param {object} plan
 * @param {string[]|null} receiverKeys 只跑这些接受角色（null = 全部）
 * @returns {Array<{receiverKey, initiatorKey, slotIndex}>}
 */
export function collectAssignments(plan, receiverKeys = null) {
  const base = normalizeAssistPlan(plan);
  const filter = receiverKeys ? new Set(receiverKeys) : null;
  const assignments = [];
  for (const receiver of base.receivers) {
    if (filter && !filter.has(receiver.key)) continue;
    receiver.slots.forEach((initiatorKey, slotIndex) => {
      if (initiatorKey) {
        assignments.push({ receiverKey: receiver.key, initiatorKey, slotIndex });
      }
    });
  }
  return assignments;
}

/** 把协议错误码归类（调用侧据此分流，不要匹配文案） */
export function classifyShareError(error) {
  const code = error?.code;
  if (code === SHARE_ERROR_SELF_EXHAUSTED) return "self_exhausted";
  if (code === SHARE_ERROR_TARGET_FULL) return "target_full";
  return "other";
}

/**
 * 校验关系表的合理性（按钮 1.3 的「检查内容合理性」/ 卡片里的提示）。
 * @returns {Array<{level:"warning"|"info", code:string, message:string}>}
 */
export function validateAssistPlan(plan, context = {}) {
  const { validKeys = null, usedInitiators = [], fullReceivers = [] } = context;
  const base = normalizeAssistPlan(plan);
  const used = new Set(usedInitiators.filter(isKey));
  const full = new Set(fullReceivers.filter(isKey));
  const poolSet = new Set(base.assistPool);
  const receiverSet = new Set(base.receivers.map((receiver) => receiver.key));
  const items = [];

  // —— 助力池 ——
  for (const key of base.assistPool) {
    if (validKeys && !validKeys.has(key)) {
      items.push({
        level: "warning",
        code: "pool-not-in-token-list",
        message: `助力池内的角色已不在角色列表（可能已删除）：${key}`,
      });
    }
    if (used.has(key)) {
      items.push({
        level: "warning",
        code: "pool-used-this-cycle",
        message: `助力池内的角色本周期已用掉助力机会（12200100）：${key}`,
      });
    }
    if (receiverSet.has(key)) {
      items.push({
        level: "info",
        code: "pool-overlaps-receiver",
        message: `该角色既是接受助力角色、又在助力池中（合法，但要注意它的额度）：${key}`,
      });
    }
  }

  // —— 槽位 ——
  for (const receiver of base.receivers) {
    if (validKeys && !validKeys.has(receiver.key)) {
      items.push({
        level: "warning",
        code: "receiver-not-in-token-list",
        message: `接受助力角色已不在角色列表：${receiver.key}`,
      });
    }
    if (full.has(receiver.key)) {
      items.push({
        level: "info",
        code: "receiver-full-this-cycle",
        message: `该角色本周期已被助力满 3 次（12200090）：${receiver.key}`,
      });
    }

    receiver.slots.forEach((slotKey, slotIndex) => {
      if (!slotKey) return;
      const label = `${receiver.key} 的槽位 ${slotIndex + 1}`;
      if (!poolSet.has(slotKey)) {
        items.push({
          level: "warning",
          code: "slot-not-in-pool",
          message: `${label} 引用的角色不在助力角色池内：${slotKey}`,
        });
      }
      if (validKeys && !validKeys.has(slotKey)) {
        items.push({
          level: "warning",
          code: "slot-not-in-token-list",
          message: `${label} 引用的角色已不在角色列表：${slotKey}`,
        });
      }
      if (used.has(slotKey)) {
        items.push({
          level: "warning",
          code: "slot-used-this-cycle",
          message: `${label} 的助力者本周期已用掉额度：${slotKey}`,
        });
      }
    });
  }

  const filled = collectAssignments(base).length;
  items.push({
    level: "info",
    code: "summary",
    message: `接受助力角色 ${base.receivers.length} 个，已分配 ${filled} 个槽位，助力池 ${base.assistPool.length} 个角色`,
  });

  return items;
}

/**
 * 助力池 vs 当前勾选的差异（按钮 1.3：该选的是否都选了、是否选了不该选的）。
 * @param {string[]} poolKeys
 * @param {string[]} selectedKeys
 */
export function diffPoolSelection(poolKeys = [], selectedKeys = []) {
  const pool = new Set(poolKeys);
  const selected = new Set(selectedKeys);
  return {
    /** 在池内但当前没勾选 → 「该选没选」 */
    missing: poolKeys.filter((key) => !selected.has(key)),
    /** 当前勾选了但不在池内 → 「选了不该选的」 */
    extra: selectedKeys.filter((key) => !pool.has(key)),
  };
}
