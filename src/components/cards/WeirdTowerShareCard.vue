<template>
  <div class="weird-tower-share-card">
    <div class="wt-head">
      <div class="wt-head-main">
        <h3>怪异塔助力</h3>
        <p class="wt-head-sub">{{ windowState.reason }}</p>
      </div>
      <n-tag :type="windowTagType" size="small" round>{{ windowTagText }}</n-tag>
    </div>

    <div class="wt-toolbar">
      <n-button
        size="small"
        :disabled="isRunning || !plan.receivers.length"
        @click="handleAutoAssign"
      >
        自动分配
      </n-button>
      <n-button
        size="small"
        type="primary"
        :loading="isRunning"
        :disabled="!canRun"
        @click="handleRun"
      >
        开始助力（{{ selectedAssignments.length }}）
      </n-button>
      <n-button
        v-if="isRunning"
        size="small"
        type="error"
        ghost
        @click="shouldStop = true"
      >
        停止
      </n-button>
      <span class="wt-toolbar-hint">{{ planSummary }}</span>
    </div>

    <n-alert
      v-if="!windowState.open"
      class="wt-alert"
      type="warning"
      :show-icon="true"
    >
      {{ windowState.reason }}
    </n-alert>

    <div class="wt-body">
      <div class="wt-panel wt-receivers">
        <div class="wt-panel-head">
          <n-checkbox
            :checked="allReceiversSelected"
            :indeterminate="someReceiversSelected && !allReceiversSelected"
            @update:checked="toggleAllReceivers"
          >
            接受助力角色（{{ plan.receivers.length }}）
          </n-checkbox>
        </div>
        <div v-if="!plan.receivers.length" class="wt-empty">
          还没有接受助力角色。<br />
          到「批量日常」页面选中角色，再点怪异塔栏目的「设为接受助力角色」。
        </div>
        <n-scrollbar v-else class="wt-scroll">
          <div
            v-for="receiver in plan.receivers"
            :key="receiver.key"
            class="wt-row"
            :class="{ active: receiver.key === activeReceiverKey }"
            @click="activeReceiverKey = receiver.key"
          >
            <n-checkbox
              :checked="selectedReceiverKeys.includes(receiver.key)"
              @click.stop
              @update:checked="(value) => toggleReceiver(receiver.key, value)"
            />
            <span class="wt-row-name" :title="receiver.key">{{ labelOfKey(receiver.key) }}</span>
            <n-tag
              size="tiny"
              :type="receiver.mode === 'auto' ? 'info' : 'default'"
            >
              {{ receiver.mode === "auto" ? "自动" : "手动" }}
            </n-tag>
            <span class="wt-row-count">{{ filledCount(receiver) }}/3</span>
          </div>
        </n-scrollbar>
      </div>

      <div class="wt-panel wt-slots">
        <template v-if="activeReceiver">
          <div class="wt-panel-head">
            <span class="wt-panel-title">{{ labelOfKey(activeReceiver.key) }} 的助力者</span>
            <n-button size="tiny" @click="handleToggleMode">
              {{ activeReceiver.mode === "auto" ? "切换为手动指定" : "切换为自动分配" }}
            </n-button>
          </div>

          <div v-for="(slotKey, index) in activeReceiver.slots" :key="index" class="wt-slot">
            <span class="wt-slot-label">槽 {{ index + 1 }}</span>
            <n-select
              class="wt-slot-select"
              size="small"
              filterable
              clearable
              :value="slotKey || null"
              :options="slotOptionsFor(activeReceiver, index)"
              :placeholder="activeReceiver.mode === 'auto' ? '自动分配' : '未指定'"
              @update:value="(value) => handleSlotChange(index, value)"
            />
          </div>

          <div class="wt-hint">
            下拉只列<b>助力角色池</b>内的角色；已被其它槽占用的会置灰并标注归属。
          </div>
        </template>
        <div v-else class="wt-empty">左侧选一个接受助力角色</div>
      </div>
    </div>

    <div v-if="validationItems.length" class="wt-validation">
      <div
        v-for="(item, index) in validationItems"
        :key="index"
        class="wt-validation-item"
        :class="item.level"
      >
        {{ item.level === "warning" ? "⚠" : "·" }} {{ item.message }}
      </div>
    </div>

    <div v-if="logs.length" class="wt-logs">
      <div class="wt-logs-head">
        <span>执行日志</span>
        <n-button size="tiny" text @click="logs = []">清空</n-button>
      </div>
      <n-scrollbar class="wt-scroll wt-scroll-logs">
        <div v-for="(log, index) in logs" :key="index" class="wt-log" :class="log.type">
          <span class="wt-log-time">{{ log.time }}</span>
          <span>{{ log.message }}</span>
        </div>
      </n-scrollbar>
    </div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref } from "vue";
import { useDialog, useMessage } from "naive-ui";

import { useTokenStore } from "@/stores/tokenStore";
import {
  cacheShareCode,
  findTokenByKey,
  getCachedShareCode,
  markInitiatorUsed,
  markReceiverFull,
  readCycleRuntime,
  tokenKeyOfToken,
  weirdTowerAssistPlan,
  writeAssistPlan,
} from "@/stores/weirdTowerAssist";
import {
  RECEIVER_MODE_AUTO,
  RECEIVER_MODE_MANUAL,
  autoAssignSlots,
  classifyShareError,
  collectAssignments,
  normalizeAssistPlan,
  releaseInitiator,
  setReceiverMode,
  setSlot,
  validateAssistPlan,
} from "@/utils/weirdTowerSharePlan.js";
import {
  describeWeirdTowerShareState,
  getWeirdTowerCycleKey,
  isWeirdTowerShareWindowOpen,
} from "@/utils/weirdTowerShareWindow.js";

/** 并发建连上限（每角色一条连接，取码/助力各自用完即关） */
const MAX_CONCURRENT_CONNECTIONS = 2;
/** 单次命令超时 */
const COMMAND_TIMEOUT_MS = 10000;
/** 等连接就绪的上限 */
const CONNECT_TIMEOUT_MS = 12000;

const tokenStore = useTokenStore();
const message = useMessage();
const dialog = useDialog();

/**
 * 关系表直接读共享的 localStorage ref（不是局部副本），
 * 这样批量日常页的 3 个按钮改完，本卡片会立刻跟着变。
 */
const plan = computed(() => normalizeAssistPlan(weirdTowerAssistPlan.value));
const activeReceiverKey = ref(null);
/** 采用「排除法」记勾选状态：新加进来的接受角色默认选中，删掉的自动消失 */
const excludedReceiverKeys = ref([]);
const logs = ref([]);
const isRunning = ref(false);
const shouldStop = ref(false);
const now = ref(new Date());

const tokens = computed(() => tokenStore.gameTokens || []);
const cycleKey = computed(() => getWeirdTowerCycleKey(now.value));
const windowState = computed(
  () =>
    describeWeirdTowerShareState(now.value) || {
      state: "before-start",
      open: false,
      reason: "活动尚未开始",
    },
);

const windowTimer = setInterval(() => {
  now.value = new Date();
}, 60_000);
onUnmounted(() => clearInterval(windowTimer));

// —— 展示辅助 ——
const labelOfKey = (key) => {
  if (!key) return "";
  const token = findTokenByKey(tokens.value, key);
  if (token?.name) return token.name;
  const stored = plan.value.receivers.find((item) => item.key === key);
  if (stored?.name) return stored.name;
  return key;
};

const filledCount = (receiver) =>
  receiver.slots.filter((slotKey) => Boolean(slotKey)).length;

const planSummary = computed(() => {
  const total = collectAssignments(plan.value).length;
  return `助力池 ${plan.value.assistPool.length} 个角色 · 已分配 ${total} 个槽位`;
});

const windowTagType = computed(() => {
  if (windowState.value.state === "open") return "success";
  if (windowState.value.state === "tail") return "warning";
  return "default";
});

const windowTagText = computed(() => {
  switch (windowState.value.state) {
    case "open":
      return "可助力";
    case "tail":
      return "仅道具/领奖";
    case "not-black-market":
      return "非黑市周";
    default:
      return "未开放";
  }
});

/** 勾选范围（默认全选，排除掉的踢出去） */
const selectedReceiverKeys = computed(() => {
  const excluded = new Set(excludedReceiverKeys.value);
  return plan.value.receivers
    .map((item) => item.key)
    .filter((key) => !excluded.has(key));
});

const allReceiversSelected = computed(
  () => plan.value.receivers.length > 0 && excludedReceiverKeys.value.length === 0,
);
const someReceiversSelected = computed(() => selectedReceiverKeys.value.length > 0);

const activeReceiver = computed(() => {
  const list = plan.value.receivers;
  return (
    list.find((item) => item.key === activeReceiverKey.value) || list[0] || null
  );
});

const validKeySet = computed(() => {
  const set = new Set();
  for (const token of tokens.value) {
    const key = tokenKeyOfToken(token);
    if (key) set.add(key);
  }
  return set;
});

const cycleRuntime = computed(() =>
  cycleKey.value ? readCycleRuntime(cycleKey.value) : { usedInitiators: [], fullReceivers: [] },
);

const validationItems = computed(() =>
  validateAssistPlan(plan.value, {
    validKeys: validKeySet.value,
    usedInitiators: cycleRuntime.value.usedInitiators,
    fullReceivers: cycleRuntime.value.fullReceivers,
  }).filter((item) => item.code !== "summary"),
);

const selectedAssignments = computed(() =>
  collectAssignments(plan.value, selectedReceiverKeys.value),
);

const canRun = computed(
  () => !isRunning.value && windowState.value.open && selectedAssignments.value.length > 0,
);

// —— 交互 ——
/** 写回共享 ref；plan 是 computed，会自动重新规范化 */
const persist = (nextPlan) => {
  writeAssistPlan(nextPlan);
};

const toggleAllReceivers = (checked) => {
  excludedReceiverKeys.value = checked
    ? []
    : plan.value.receivers.map((item) => item.key);
};

const toggleReceiver = (key, checked) => {
  const excluded = new Set(excludedReceiverKeys.value);
  if (checked) excluded.delete(key);
  else excluded.add(key);
  excludedReceiverKeys.value = [...excluded];
};

const slotOptionsFor = (receiver, slotIndex) => {
  const current = receiver.slots[slotIndex];
  const usedInitiators = new Set(cycleRuntime.value.usedInitiators || []);

  return plan.value.assistPool.map((key) => {
    const owner = [...plan.value.receivers].find((item) =>
      item.slots.includes(key),
    );
    const ownerIsOtherSlot = owner && !(owner.key === receiver.key && current === key);
    const disabled = Boolean(ownerIsOtherSlot) || key === receiver.key || usedInitiators.has(key);

    let suffix = "";
    if (ownerIsOtherSlot) suffix = `（已用于 ${labelOfKey(owner.key)} 槽 ${owner.slots.indexOf(key) + 1}）`;
    else if (key === receiver.key) suffix = "（不能给自己助力）";
    else if (usedInitiators.has(key)) suffix = "（本周期已用掉机会）";

    return {
      label: `${labelOfKey(key)}${suffix}`,
      value: key,
      disabled,
    };
  });
};

const handleSlotChange = (slotIndex, value) => {
  if (!activeReceiver.value) return;
  const result = setSlot(plan.value, activeReceiver.value.key, slotIndex, value);
  if (result.error === "self") {
    message.warning("不能把接受助力角色自己放进它的槽位");
    return;
  }
  if (result.error === "not-in-pool") {
    message.warning("该角色不在助力角色池内，请先到批量日常页把它设为助力角色池");
    return;
  }
  persist(result.plan);
};

const handleToggleMode = () => {
  if (!activeReceiver.value) return;
  const nextMode =
    activeReceiver.value.mode === RECEIVER_MODE_AUTO
      ? RECEIVER_MODE_MANUAL
      : RECEIVER_MODE_AUTO;

  if (nextMode === RECEIVER_MODE_AUTO && filledCount(activeReceiver.value) > 0) {
    dialog.warning({
      title: "切换为自动分配",
      content: "切换为自动分配会清空该角色已指定的 3 个助力者槽位，是否继续？",
      positiveText: "继续",
      negativeText: "取消",
      onPositiveClick: () => {
        persist(setReceiverMode(plan.value, activeReceiver.value.key, nextMode));
      },
    });
    return;
  }

  persist(setReceiverMode(plan.value, activeReceiver.value.key, nextMode));
};

const handleAutoAssign = () => {
  const result = autoAssignSlots(plan.value, {
    usedInitiators: cycleRuntime.value.usedInitiators || [],
    validKeys: validKeySet.value,
  });
  persist(result.plan);

  const shortageText = result.shortages.length
    ? `；有 ${result.shortages.length} 个接受角色因助力池候选不足未填满`
    : "";
  addLog(
    `自动分配完成：填了 ${result.assigned.length} 个槽位${shortageText}`,
    result.shortages.length ? "warning" : "success",
  );

  if (result.assigned.length === 0 && result.shortages.length === 0) {
    message.info("没有处于「自动分配」模式且有空槽的接受助力角色");
  }
};

// —— 执行 ——
const addLog = (text, type = "info") => {
  logs.value = [
    ...logs.value,
    { time: new Date().toLocaleTimeString(), message: text, type },
  ];
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForConnected(tokenId, timeoutMs = CONNECT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tokenStore.getWebSocketStatus(tokenId) === "connected") return true;
    await sleep(200);
  }
  return false;
}

/** 确保某角色有可用连接 */
async function ensureConnectionForKey(key) {
  const token = findTokenByKey(tokens.value, key);
  if (!token) throw new Error(`角色已不在角色列表：${key}`);

  if (tokenStore.getWebSocketStatus(token.id) === "connected") return token;

  await tokenStore.createWebSocketConnection(token.id, token.token, token.wsUrl);
  const ok = await waitForConnected(token.id);
  if (!ok) throw new Error(`连接超时：${token.name || key}`);
  return token;
}

function releaseConnectionForKey(key) {
  const token = findTokenByKey(tokens.value, key);
  if (token) tokenStore.closeWebSocketConnection(token.id);
}

/** 并发受限的任务执行器 */
async function runLimited(items, limit, worker) {
  const queue = [...items];
  const running = new Set();

  while (queue.length > 0 || running.size > 0) {
    while (queue.length > 0 && running.size < limit) {
      const item = queue.shift();
      let task;
      task = Promise.resolve()
        .then(() => worker(item))
        .catch((error) => {
          addLog(`✗ ${item.label} 失败：${error?.message || error}`, "error");
        })
        .finally(() => running.delete(task));
      running.add(task);
    }
    if (running.size > 0) await Promise.race(running);
  }
}

async function handleRun() {
  if (!isWeirdTowerShareWindowOpen(now.value)) {
    message.warning(windowState.value.reason);
    return;
  }
  if (!cycleKey.value) {
    message.warning("无法确定当前活动周期");
    return;
  }

  const assignments = selectedAssignments.value;
  if (assignments.length === 0) {
    message.info("没有待执行的助力分配");
    return;
  }

  dialog.info({
    title: "确认开始助力",
    content: `将对 ${selectedReceiverKeys.value.length} 个接受助力角色执行 ${assignments.length} 次助力。助力码由接受方的连接获取，助力由助力方的连接发起。`,
    positiveText: "开始",
    negativeText: "取消",
    onPositiveClick: () => {
      void executeAssignments(assignments);
    },
  });
}

async function executeAssignments(assignments) {
  const key = cycleKey.value;
  isRunning.value = true;
  shouldStop.value = false;
  addLog(`=== 开始助力：${assignments.length} 次（周期 ${key}） ===`, "info");

  try {
    // 阶段一：取每个接受助力角色的助力码（每周期缓存）
    const receiverKeys = [...new Set(assignments.map((item) => item.receiverKey))];
    const pendingCodeFetch = receiverKeys.filter(
      (receiverKey) => !getCachedShareCode(key, receiverKey),
    );

    if (pendingCodeFetch.length > 0) {
      addLog(`取助力码：${pendingCodeFetch.length} 个角色`, "info");
      await runLimited(
        pendingCodeFetch.map((receiverKey) => ({
          label: `取码 ${labelOfKey(receiverKey)}`,
          receiverKey,
        })),
        MAX_CONCURRENT_CONNECTIONS,
        async ({ receiverKey }) => {
          const token = await ensureConnectionForKey(receiverKey);
          try {
            const result = await tokenStore.sendMessageWithPromise(
              token.id,
              "evotower_getsharecode",
              {},
              COMMAND_TIMEOUT_MS,
            );
            const shareCode = result?.shareCode;
            if (!shareCode) throw new Error("响应里没有 shareCode");
            cacheShareCode(key, receiverKey, shareCode);
            addLog(`✓ ${labelOfKey(receiverKey)} 的助力码已获取`, "success");
          } finally {
            releaseConnectionForKey(receiverKey);
          }
        },
      );
    }

    // 阶段二：逐条发起助力
    addLog("开始发起助力…", "info");
    await runLimited(
      assignments.map((item) => ({
        ...item,
        label: `${labelOfKey(item.initiatorKey)} → ${labelOfKey(item.receiverKey)}`,
      })),
      MAX_CONCURRENT_CONNECTIONS,
      async (item) => {
        if (shouldStop.value) return;
        const shareCode = getCachedShareCode(key, item.receiverKey);
        if (!shareCode) {
          addLog(`✗ ${item.label} 跳过：没有取到接受方的助力码`, "error");
          return;
        }

        const initiatorToken = await ensureConnectionForKey(item.initiatorKey);
        try {
          await tokenStore.sendMessageWithPromise(
            initiatorToken.id,
            "evotower_acceptsharebycode",
            { shareCode },
            COMMAND_TIMEOUT_MS,
          );
          addLog(`✓ ${item.label} 助力成功`, "success");
        } catch (error) {
          const kind = classifyShareError(error);
          if (kind === "self_exhausted") {
            markInitiatorUsed(key, item.initiatorKey);
            persist(releaseInitiator(plan.value, item.initiatorKey));
            addLog(
              `✗ ${item.label} 失败：该角色本周期已用掉助力机会（12200100），已从所有槽位移除`,
              "error",
            );
          } else if (kind === "target_full") {
            markReceiverFull(key, item.receiverKey);
            addLog(
              `✗ ${item.label} 失败：对方已被助力满 3 次（12200090），本周期不再尝试`,
              "error",
            );
          } else {
            addLog(`✗ ${item.label} 失败：${error?.message || error}`, "error");
          }
        } finally {
          releaseConnectionForKey(item.initiatorKey);
        }
      },
    );

    addLog("=== 助力流程结束 ===", "success");
  } finally {
    isRunning.value = false;
  }
}
</script>

<style scoped>
.weird-tower-share-card {
  background: var(--bg-primary, #fff);
  border-radius: var(--border-radius-xl, 16px);
  padding: var(--spacing-lg, 16px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.wt-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}

.wt-head-main {
  flex: 1;
  min-width: 0;
}

.wt-head-main h3 {
  margin: 0 0 4px;
  font-size: var(--font-size-md, 16px);
  font-weight: var(--font-weight-semibold, 600);
  color: var(--text-primary, #1f1f1f);
}

.wt-head-sub {
  margin: 0;
  font-size: var(--font-size-sm, 12px);
  color: var(--text-secondary, #666);
}

.wt-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.wt-toolbar-hint {
  font-size: var(--font-size-sm, 12px);
  color: var(--text-tertiary, #999);
}

.wt-alert {
  margin-bottom: 12px;
}

.wt-body {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.wt-panel {
  border: 1px solid var(--border-light, #eee);
  border-radius: 10px;
  padding: 10px;
  min-width: 0;
}

.wt-receivers {
  flex: 0 0 300px;
}

.wt-slots {
  flex: 1;
}

.wt-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  font-size: var(--font-size-sm, 12px);
  color: var(--text-primary, #1f1f1f);
}

.wt-panel-title {
  font-weight: 600;
}

.wt-scroll {
  max-height: 260px;
}

.wt-scroll-logs {
  max-height: 180px;
}

.wt-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
}

.wt-row:hover {
  background: var(--bg-tertiary, #f5f5f5);
}

.wt-row.active {
  background: rgba(24, 95, 165, 0.08);
}

.wt-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm, 12px);
}

.wt-row-count {
  font-size: var(--font-size-sm, 12px);
  color: var(--text-secondary, #666);
  font-variant-numeric: tabular-nums;
}

.wt-slot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.wt-slot-label {
  flex: 0 0 40px;
  font-size: var(--font-size-sm, 12px);
  color: var(--text-secondary, #666);
}

.wt-slot-select {
  flex: 1;
  min-width: 0;
}

.wt-hint {
  margin-top: 6px;
  font-size: var(--font-size-sm, 12px);
  color: var(--text-tertiary, #999);
  line-height: 1.5;
}

.wt-empty {
  padding: 16px 8px;
  font-size: var(--font-size-sm, 12px);
  color: var(--text-tertiary, #999);
  line-height: 1.6;
}

.wt-validation {
  margin-top: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--bg-tertiary, #fafafa);
}

.wt-validation-item {
  font-size: var(--font-size-sm, 12px);
  line-height: 1.7;
  color: var(--text-secondary, #666);
}

.wt-validation-item.warning {
  color: #d03050;
}

.wt-logs {
  margin-top: 12px;
  border-top: 1px dashed var(--border-light, #eee);
  padding-top: 8px;
}

.wt-logs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--font-size-sm, 12px);
  color: var(--text-secondary, #666);
  margin-bottom: 4px;
}

.wt-log {
  font-size: var(--font-size-sm, 12px);
  line-height: 1.7;
  color: var(--text-secondary, #666);
}

.wt-log.success {
  color: #18a058;
}

.wt-log.error {
  color: #d03050;
}

.wt-log.warning {
  color: #f0a020;
}

.wt-log-time {
  color: var(--text-tertiary, #999);
  margin-right: 6px;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 768px) {
  .wt-body {
    flex-direction: column;
  }

  .wt-receivers {
    flex: 1 1 auto;
    width: 100%;
  }
}
</style>
