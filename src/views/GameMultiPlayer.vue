<template>
  <div class="multi-game-page">
    <header class="multi-game-toolbar">
      <button class="toolbar-button" type="button" @click="goToTokens">
        ← 返回 Token 管理
      </button>
      <strong class="toolbar-title">批量运行时</strong>
      <span class="toolbar-count">{{ frames.length }} 个窗口</span>
      <span class="toolbar-ready">{{ readyCount }} 个已就绪</span>
      <span
        v-if="skippedSummary"
        class="toolbar-skipped"
        :title="skippedDetails"
      >
        {{ skippedSummary }}
      </span>

      <!-- 同步操作控制区 -->
      <div class="sync-controls" role="group" aria-label="同步操作">
        <span class="sync-label">同步操作</span>
        <label class="sync-toggle">
          <input
            type="checkbox"
            :checked="syncEnabled"
            @change="toggleSync"
          />
          <span
            class="sync-toggle-indicator"
            :class="{ 'is-on': syncEnabled }"
          ></span>
        </label>
        <span v-if="syncEnabled" class="sync-status-on">● 已启用</span>
        <span v-else class="sync-status-off">○ 已禁用</span>
        <div v-if="syncEnabled" class="sync-group-badges">
          <button
            v-for="g in 6"
            :key="g - 1"
            type="button"
            class="sync-group-badge"
            :style="getGroupBadgeStyle(g - 1)"
            :title="`第 ${g} 组 ${groupMemberCount(g - 1)} 个窗口`"
          >
            {{ groupMemberCount(g - 1) }}
          </button>
        </div>
      </div>

      <div class="automation-actions" role="group" aria-label="自动盐场批量操作">
        <span class="selection-count">已选 {{ selectedScopes.size }} 个</span>
        <button
          class="toolbar-action"
          type="button"
          @click="toggleAllSelection"
        >
          {{ selectedScopes.size === frames.length ? "取消全选" : "全选" }}
        </button>
        <button
          class="toolbar-action toolbar-action-primary"
          type="button"
          :disabled="selectedReadyCount === 0 || controlBusy"
          @click="runSelectedAction('start')"
        >
          启动选中
        </button>
        <button
          class="toolbar-action toolbar-action-warning"
          type="button"
          :disabled="selectedReadyCount === 0 || controlBusy"
          @click="runSelectedAction('stop')"
        >
          暂停选中
        </button>
        <button
          class="toolbar-action"
          type="button"
          :disabled="readyCount === 0 || controlBusy"
          @click="refreshAutomationStatus()"
        >
          刷新状态
        </button>
      </div>
      <span class="toolbar-warning">
        自动盐场仍需活动开放；未就绪窗口不会接收操作
      </span>
      <n-popover trigger="hover" placement="bottom-end" :width="360">
        <template #trigger>
          <button class="crash-help-trigger" type="button">页面崩溃？</button>
        </template>
        <div class="crash-help-content">
          <strong>多开内存提示</strong>
          <p>
            同时开启多个游戏会占用大量内存。若系统仍有可用内存但页面提示
            Out of Memory，可能是 32 位浏览器的进程内存限制，建议升级到 64
            位浏览器。
          </p>
          <p>
            查看方法：在 Chrome 地址栏输入 <code>chrome://version</code>，检查版本或操作系统信息是否显示 64 位。
          </p>
          <a
            href="https://support.google.com/chrome/a/answer/7650032?hl=zh-Hans"
            target="_blank"
            rel="noopener noreferrer"
          >
            下载 Chrome 官方 Windows 64 位捆绑包
          </a>
        </div>
      </n-popover>
    </header>

    <main
      v-if="frames.length"
      ref="gameStrip"
      class="game-strip"
      @wheel="handleStripWheel"
    >
      <article
        v-for="frame in frames"
        :key="frame.scopeId"
        class="game-panel"
        :style="{ order: frame.order }"
      >
        <header class="game-panel-header">
          <input
            class="frame-select"
            type="checkbox"
            :checked="isFrameSelected(frame.scopeId)"
            :aria-label="`选择 ${frame.name}`"
            @change="toggleFrameSelection(frame.scopeId)"
          />
          <!-- 分组选择器 + 主窗口切换 -->
          <n-popover
            :width="220"
            trigger="click"
            placement="bottom-start"
          >
            <template #trigger>
              <button
                class="frame-group-indicator"
                :class="{ 'is-master': isMasterOf(frame.scopeId) }"
                type="button"
                :title="getFrameGroupTitle(frame.scopeId)"
                :style="getGroupBadgeStyle(frameGroups[frame.scopeId] ?? -1, true)"
              >
                <span v-if="isMasterOf(frame.scopeId)" class="master-star">★</span>
                {{ frameGroups[frame.scopeId] == null || frameGroups[frame.scopeId] < 0 ? "—" : frameGroups[frame.scopeId] + 1 }}
              </button>
            </template>
            <div class="group-popover">
              <div class="group-popover-title">分配分组</div>
              <button
                class="group-option-btn"
                :class="{ active: (frameGroups[frame.scopeId] ?? -1) === -1 }"
                type="button"
                @click="setFrameGroup(frame.scopeId, -1)"
              >
                — 不分组（不参与同步）
              </button>
              <button
                v-for="g in 6"
                :key="g - 1"
                class="group-option-btn"
                :class="{
                  active: frameGroups[frame.scopeId] === g - 1,
                  'is-master-row': frameGroups[frame.scopeId] === g - 1 && isMasterOf(frame.scopeId),
                }"
                :style="getGroupBadgeStyle(g - 1)"
                type="button"
                @click="setFrameGroup(frame.scopeId, g - 1)"
              >
                <span class="group-name">第 {{ g }} 组</span>
                <span
                  v-if="frameGroups[frame.scopeId] === g - 1 && isMasterOf(frame.scopeId)"
                  class="master-badge"
                >
                  ★ 主
                </span>
                <span
                  v-else-if="groupMasters[g - 1] && frameGroups[groupMasters[g - 1]] === g - 1"
                  class="master-badge-muted"
                >
                  {{ frames.find((f) => f.scopeId === groupMasters[g - 1])?.name?.slice(0, 4) || "" }}
                </span>
              </button>
              <!-- 设为主窗口按钮：仅当已分组且不是当前主窗口时显示 -->
              <template v-if="frameGroups[frame.scopeId] >= 0 && !isMasterOf(frame.scopeId)">
                <div class="group-popover-sep"></div>
                <button
                  class="group-option-btn group-option-primary"
                  type="button"
                  @click="makeMaster(frame.scopeId)"
                >
                  ★ 设为该组主窗口
                </button>
              </template>
            </div>
          </n-popover>
          <span class="account-name" :title="frame.name">{{ frame.name }}</span>
          <span
            class="frame-status"
            :class="`is-${frameStates[frame.scopeId]?.status || 'loading'}`"
          >
            {{ statusLabel(frame.scopeId) }}
          </span>
          <span
            class="automation-status"
            :class="`is-${automationStatus(frame.scopeId).tone}`"
          >
            {{ automationStatus(frame.scopeId).label }}
          </span>
          <button
            class="move-button move-button-first"
            type="button"
            title="将窗口向左移动"
            :aria-label="`将 ${frame.name} 的运行窗口向左移动`"
            :disabled="movingFrame || !canMoveFrame(frame.scopeId, -1)"
            @click="moveFrame(frame.scopeId, -1, $event)"
          >
            ←
          </button>
          <button
            class="move-button"
            type="button"
            title="将窗口向右移动"
            :aria-label="`将 ${frame.name} 的运行窗口向右移动`"
            :disabled="movingFrame || !canMoveFrame(frame.scopeId, 1)"
            @click="moveFrame(frame.scopeId, 1, $event)"
          >
            →
          </button>
          <n-popconfirm
            :show-icon="false"
            positive-text="确认重新加载"
            negative-text="取消"
            @positive-click="reloadFrame(frame.scopeId)"
          >
            <template #trigger>
              <button
                class="reload-button"
                type="button"
                :title="`重新加载 ${frame.name} 的运行窗口`"
              >
                重新加载
              </button>
            </template>
            确定重新加载“{{ frame.name }}”的运行窗口吗？
          </n-popconfirm>
          <n-popconfirm
            :show-icon="false"
            positive-text="确认关闭"
            negative-text="取消"
            @positive-click="closeFrame(frame)"
          >
            <template #trigger>
              <button
                class="close-button"
                type="button"
                :title="`关闭 ${frame.name} 的运行窗口`"
              >
                关闭
              </button>
            </template>
            确定关闭“{{ frame.name }}”的运行窗口吗？
          </n-popconfirm>
        </header>

        <div class="game-frame-shell">
          <iframe
            :key="`${frame.scopeId}:${frameStates[frame.scopeId].revision}`"
            :ref="(element) => setFrameElement(frame.scopeId, element)"
            :src="frame.src"
            :title="`${frame.name} 的运行窗口`"
            class="game-frame"
            allow="fullscreen; autoplay"
            @error="markFrameFatal(frame.scopeId)"
          />
          <div
            v-if="frameStates[frame.scopeId]?.status === 'fatal'"
            class="frame-error"
          >
            <strong>该账号加载失败</strong>
            <span>其他运行窗口不受影响</span>
            <button type="button" @click="reloadFrame(frame.scopeId)">
              重试
            </button>
          </div>
        </div>
        <footer class="game-panel-actions">
          <button
            class="panel-action panel-action-primary"
            type="button"
            :disabled="!isFrameReady(frame.scopeId) || controlBusy"
            @click="runFrameAction(frame.scopeId, 'start')"
          >
            启动自动盐场
          </button>
          <button
            class="panel-action panel-action-warning"
            type="button"
            :disabled="!isFrameReady(frame.scopeId) || controlBusy"
            @click="runFrameAction(frame.scopeId, 'stop')"
          >
            暂停
          </button>
          <button
            class="panel-action"
            type="button"
            :disabled="!isFrameReady(frame.scopeId) || controlBusy"
            @click="runFrameAction(frame.scopeId, 'deploy')"
          >
            布阵
          </button>
          <button
            class="panel-action"
            type="button"
            :disabled="!isFrameReady(frame.scopeId) || controlBusy"
            @click="runFrameAction(frame.scopeId, 'march')"
          >
            寻盐田
          </button>
          <button
            class="panel-action"
            type="button"
            :disabled="!isFrameReady(frame.scopeId) || controlBusy"
            @click="runFrameAction(frame.scopeId, 'attack')"
          >
            攻击当前
          </button>
          <button
            class="panel-action"
            type="button"
            :disabled="!isFrameReady(frame.scopeId) || controlBusy"
            @click="runFrameAction(frame.scopeId, 'speedUp')"
          >
            加速
          </button>
          <span
            v-if="frameStates[frame.scopeId]?.automationError"
            class="automation-error"
            :title="frameStates[frame.scopeId].automationError"
          >
            控制失败
          </span>
        </footer>
      </article>
    </main>

    <main v-else class="empty-state">
      <div class="empty-card">
        <h1>还没有待打开的运行时账号</h1>
        <p>请先到 Token 管理页面勾选账号，再使用“批量打开运行时”。</p>
        <button type="button" @click="goToTokens">前往 Token 管理</button>
      </div>
    </main>
  </div>
</template>

<script setup>
import { NPopover } from "naive-ui";
import {
  computed,
  nextTick,
  onBeforeMount,
  onMounted,
  onUnmounted,
  reactive,
  ref,
} from "vue";
import { useRouter } from "vue-router";
import {
  buildMultiGameFrameSrc,
  closeMultiGameSession,
  moveMultiGameSession,
  readActiveMultiGameLaunch,
  resolveMultiGameFrameMessage,
} from "@/utils/gameLauncher";

const router = useRouter();
const FRAME_LOAD_TIMEOUT_MS = 45_000;
const launch = ref(readLaunchSafely());
const gameStrip = ref(null);
const movingFrame = ref(false);
let stripScrollTarget = 0;
let stripScrollAnimationId = 0;
const frameDomOrder = (launch.value?.sessions || []).map(
  (session) => session.scopeId,
);
const frames = computed(() => {
  const sessionsByScope = new Map(
    (launch.value?.sessions || []).map((session) => [session.scopeId, session]),
  );
  return frameDomOrder
    .map((scopeId) => sessionsByScope.get(scopeId))
    .filter(Boolean)
    .map((session) => ({
      ...session,
      src: buildMultiGameFrameSrc(import.meta.env.BASE_URL, session),
    }));
});
const frameElements = new Map();
const frameTimeouts = new Map();
const controlPending = reactive(new Map());
const selectedScopes = ref(new Set(frames.value.map((frame) => frame.scopeId)));
let controlSequence = 0;
let statusPollTimer = 0;
const frameStates = reactive(
  Object.fromEntries(
    frames.value.map((frame) => [
      frame.scopeId,
      {
        status: "loading",
        revision: 0,
        automation: null,
        automationError: "",
      },
    ]),
  ),
);

// ========== 同步操作相关状态 ==========
const SYNC_CMD_CHANNEL = "multi-game-sync";
const SYNC_VERSION = 1;
const MAX_GROUPS = 6;
const GROUP_COLORS = [
  "#ef4444", // 红
  "#f97316", // 橙
  "#eab308", // 黄
  "#22c55e", // 绿
  "#3b82f6", // 蓝
  "#a855f7", // 紫
];
const syncEnabled = ref(false);
const syncThrottleMs = 16; // ~60fps
// 每个 scopeId 对应一个组号 (-1 表示未分组)
const frameGroups = reactive(
  Object.fromEntries(frames.value.map((f, i) => [f.scopeId, i % MAX_GROUPS])),
);
// 每组的主窗口 scopeId —— 权威源，只以实际分组作为键
const groupMasters = reactive({});

/**
 * 获取某组的所有成员 scopeId（不包含 -1 未分组）
 */
function getGroupMembers(groupIndex) {
  if (groupIndex == null || groupIndex < 0) return [];
  return Object.entries(frameGroups)
    .filter(([, g]) => g === groupIndex)
    .map(([scopeId]) => scopeId);
}

/**
 * 确保某组有主窗口；没有就选第一个成员
 * 权威源：groupMasters[groupIndex]，与 UI 筛选态无关
 */
function ensureGroupMaster(groupIndex) {
  if (groupIndex == null || groupIndex < 0) return null;
  const current = groupMasters[groupIndex];
  // 现任仍在该组且未被移除，则保持
  if (current != null && frameGroups[current] === groupIndex) {
    return current;
  }
  // 否则从当前成员中选一个
  const members = getGroupMembers(groupIndex);
  if (members.length > 0) {
    groupMasters[groupIndex] = members[0];
    return members[0];
  }
  // 该组无人 —— 清理
  delete groupMasters[groupIndex];
  return null;
}

/**
 * 把某组的主窗口换成指定 scopeId（必须已在该组）
 */
function setGroupMaster(groupIndex, scopeId) {
  if (groupIndex == null || groupIndex < 0) return false;
  if (scopeId == null) {
    delete groupMasters[groupIndex];
    return true;
  }
  if (frameGroups[scopeId] !== groupIndex) return false;
  groupMasters[groupIndex] = scopeId;
  return true;
}

/**
 * 当某窗口的分组发生变更时，更新两组的主窗口状态
 */
function onFrameGroupChanged(scopeId, oldGroup, newGroup) {
  // 旧组：如果离开的是主窗口，重选
  if (oldGroup != null && oldGroup >= 0) {
    if (groupMasters[oldGroup] === scopeId) {
      delete groupMasters[oldGroup];
      ensureGroupMaster(oldGroup);
    }
  }
  // 新组：确保有主窗口（新成员自动当选如果之前没主）
  if (newGroup != null && newGroup >= 0) {
    ensureGroupMaster(newGroup);
  }
}

/**
 * 当某窗口被移除（关闭）时清理分组和主窗口
 */
function onFrameRemoved(scopeId) {
  const g = frameGroups[scopeId];
  if (g != null && g >= 0) {
    if (groupMasters[g] === scopeId) {
      delete groupMasters[g];
      ensureGroupMaster(g);
    }
    delete frameGroups[scopeId];
  }
}

/**
 * 判断某窗口是否为其所在组的主窗口
 */
function isMasterOf(scopeId) {
  const g = frameGroups[scopeId];
  if (g == null || g < 0) return false;
  return groupMasters[g] === scopeId;
}

function groupMemberCount(groupIndex) {
  if (groupIndex < 0) return 0;
  return Object.values(frameGroups).filter((g) => g === groupIndex).length;
}

function getGroupBadgeStyle(groupIndex, compact = false) {
  if (groupIndex == null || groupIndex < 0) {
    return compact
      ? {
          background: "#1e293b",
          borderColor: "#475569",
          color: "#94a3b8",
        }
      : {};
  }
  const color = GROUP_COLORS[groupIndex % GROUP_COLORS.length];
  return {
    background: `${color}22`,
    borderColor: color,
    color,
  };
}

function getFrameGroupTitle(scopeId) {
  const g = frameGroups[scopeId];
  if (g == null || g < 0) return "未分组 - 点击分配到组";
  const master = groupMasters[g];
  if (master === scopeId) return `第 ${g + 1} 组 · 主窗口 - 点击切换`;
  return `第 ${g + 1} 组 - 点击设置为主窗口`;
}

function setFrameGroup(scopeId, groupIndex) {
  const old = frameGroups[scopeId];
  if (old === groupIndex) return;
  frameGroups[scopeId] = groupIndex;
  onFrameGroupChanged(scopeId, old, groupIndex);
}

/**
 * 把窗口切换为所在组的主窗口
 */
function makeMaster(scopeId) {
  const g = frameGroups[scopeId];
  if (g == null || g < 0) return;
  setGroupMaster(g, scopeId);
}

function toggleSync(event) {
  syncEnabled.value = event.target.checked;
  broadcastSyncConfig();
}

/**
 * 向所有 iframe 广播同步配置
 */
function broadcastSyncConfig() {
  const message = {
    channel: SYNC_CMD_CHANNEL,
    version: SYNC_VERSION,
    type: "config",
    enabled: syncEnabled.value,
    throttleMs: syncThrottleMs,
  };
  for (const [scopeId, element] of frameElements) {
    if (!isFrameReady(scopeId)) continue;
    element.contentWindow?.postMessage(message, window.location.origin);
  }
}

/**
 * 向指定 iframe 单独发送同步配置
 */
function sendSyncConfigTo(scopeId) {
  const element = frameElements.get(scopeId);
  if (!element || !isFrameReady(scopeId)) return;
  element.contentWindow?.postMessage(
    {
      channel: SYNC_CMD_CHANNEL,
      version: SYNC_VERSION,
      type: "config",
      enabled: syncEnabled.value,
      throttleMs: syncThrottleMs,
    },
    window.location.origin,
  );
}

/**
 * 处理来自 iframe 的用户事件：仅主窗口的事件向同组从窗口转发
 * 从窗口事件静默丢弃（不向任何方向同步）
 */
function handleUserEventFromFrame(scopeId, eventData) {
  if (!syncEnabled.value) return;

  const group = frameGroups[scopeId];
  if (group == null || group < 0) return; // 未分组不参与同步

  // 只有主窗口的事件才向外转发 —— 单向同步核心
  if (groupMasters[group] !== scopeId) return;

  const targetScopeIds = frames.value
    .filter(
      (f) =>
        f.scopeId !== scopeId &&
        frameGroups[f.scopeId] === group &&
        isFrameReady(f.scopeId),
    )
    .map((f) => f.scopeId);

  for (const targetId of targetScopeIds) {
    const element = frameElements.get(targetId);
    if (!element) continue;
    element.contentWindow?.postMessage(
      {
        channel: SYNC_CMD_CHANNEL,
        version: SYNC_VERSION,
        type: "forward-event",
        scope: scopeId,
        event: eventData,
      },
      window.location.origin,
    );
  }
}

// ========== 同步操作相关状态结束 ==========

const readyCount = computed(
  () => frames.value.filter((frame) => isFrameReady(frame.scopeId)).length,
);
const selectedReadyCount = computed(
  () =>
    frames.value.filter(
      (frame) =>
        selectedScopes.value.has(frame.scopeId) && isFrameReady(frame.scopeId),
    ).length,
);
const controlBusy = computed(() => controlPending.size > 0);

const skippedDetails = computed(() =>
  (launch.value?.failures || [])
    .map((failure) => `${failure.name}（${failureReason(failure.reason)}）`)
    .join("、"),
);
const skippedSummary = computed(() => {
  const failures = launch.value?.failures || [];
  if (!failures.length) return "";
  const preview = failures
    .slice(0, 2)
    .map((failure) => failure.name)
    .join("、");
  return `已跳过 ${failures.length} 个账号：${preview}${
    failures.length > 2 ? "…" : ""
  }`;
});

function failureReason(reason) {
  return {
    "missing-bin": "缺少 BIN 数据",
    "read-failed": "读取 BIN 失败",
    "convert-failed": "转换 BIN 失败",
  }[reason] || "准备失败";
}

function readLaunchSafely() {
  try {
    return readActiveMultiGameLaunch(window.sessionStorage);
  } catch {
    return null;
  }
}

function statusLabel(scopeId) {
  return {
    loading: "加载中",
    ready: "已启动",
    fatal: "加载失败",
  }[frameStates[scopeId]?.status || "loading"];
}

function isFrameReady(scopeId) {
  return frameStates[scopeId]?.status === "ready";
}

function isFrameSelected(scopeId) {
  return selectedScopes.value.has(scopeId);
}

function toggleFrameSelection(scopeId) {
  const next = new Set(selectedScopes.value);
  if (next.has(scopeId)) next.delete(scopeId);
  else next.add(scopeId);
  selectedScopes.value = next;
}

function toggleAllSelection() {
  selectedScopes.value =
    selectedScopes.value.size === frames.value.length
      ? new Set()
      : new Set(frames.value.map((frame) => frame.scopeId));
}

function automationStatus(scopeId) {
  const state = frameStates[scopeId];
  if (!isFrameReady(scopeId)) return { label: "未就绪", tone: "offline" };
  if (!state?.automation) return { label: "等待状态", tone: "loading" };
  if (state.automation.running) return { label: "自动运行", tone: "running" };
  return { label: "已暂停", tone: "paused" };
}

function clearControlPending(scopeId, reason = "运行窗口已关闭") {
  for (const [requestId, pending] of controlPending) {
    if (pending.scopeId !== scopeId) continue;
    window.clearTimeout(pending.timeoutId);
    controlPending.delete(requestId);
    pending.reject(new Error(reason));
  }
}

function sendFrameCommand(scopeId, action) {
  const frameElement = frameElements.get(scopeId);
  if (!frameElement?.contentWindow || !isFrameReady(scopeId)) {
    return Promise.reject(new Error("运行窗口尚未就绪"));
  }

  const requestId = `${scopeId}-${Date.now()}-${controlSequence++}`;
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      controlPending.delete(requestId);
      reject(new Error("自动盐场控制请求超时"));
    }, 10000);
    controlPending.set(requestId, { scopeId, resolve, reject, timeoutId });
    frameElement.contentWindow.postMessage(
      {
        channel: "multi-game-control",
        version: 1,
        type: "command",
        requestId,
        action,
      },
      window.location.origin,
    );
  });
}

function applyAutomationResult(scopeId, result) {
  const state = frameStates[scopeId];
  if (!state || !result || typeof result !== "object") return;
  state.automation = result;
  state.automationError = "";
}

async function runFrameAction(scopeId, action) {
  const state = frameStates[scopeId];
  if (!state || !isFrameReady(scopeId)) return null;
  state.automationError = "";
  try {
    const result = await sendFrameCommand(scopeId, action);
    applyAutomationResult(scopeId, result);
    return result;
  } catch (error) {
    state.automationError = error?.message || "自动盐场控制失败";
    return null;
  }
}

async function runSelectedAction(action) {
  const scopeIds = frames.value
    .filter(
      (frame) =>
        selectedScopes.value.has(frame.scopeId) && isFrameReady(frame.scopeId),
    )
    .map((frame) => frame.scopeId);
  await Promise.all(scopeIds.map((scopeId) => runFrameAction(scopeId, action)));
}

async function refreshAutomationStatus(scopeId = null) {
  const scopeIds = scopeId
    ? [scopeId]
    : frames.value
        .filter((frame) => isFrameReady(frame.scopeId))
        .map((frame) => frame.scopeId);
  await Promise.all(scopeIds.map((id) => runFrameAction(id, "getStats")));
}

function setFrameElement(scopeId, element) {
  if (element) frameElements.set(scopeId, element);
  else frameElements.delete(scopeId);
}

function clearFrameTimeout(scopeId) {
  const timeoutId = frameTimeouts.get(scopeId);
  if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  frameTimeouts.delete(scopeId);
}

function armFrameTimeout(scopeId) {
  clearFrameTimeout(scopeId);
  const state = frameStates[scopeId];
  if (!state || state.status !== "loading") return;
  const revision = state.revision;
  const timeoutId = window.setTimeout(() => {
    if (
      frameStates[scopeId]?.status === "loading" &&
      frameStates[scopeId]?.revision === revision
    ) {
      frameStates[scopeId].status = "fatal";
    }
    frameTimeouts.delete(scopeId);
  }, FRAME_LOAD_TIMEOUT_MS);
  frameTimeouts.set(scopeId, timeoutId);
}

function markFrameFatal(scopeId) {
  clearFrameTimeout(scopeId);
  if (frameStates[scopeId]) frameStates[scopeId].status = "fatal";
}

function reloadFrame(scopeId) {
  const state = frameStates[scopeId];
  if (!state) return;
  clearControlPending(scopeId, "运行窗口正在重新加载");
  frameElements.delete(scopeId);
  state.status = "loading";
  state.revision += 1;
  state.automation = null;
  state.automationError = "";
  armFrameTimeout(scopeId);
}

function canMoveFrame(scopeId, direction) {
  const sessions = launch.value?.sessions || [];
  const index = sessions.findIndex((session) => session.scopeId === scopeId);
  const targetIndex = index + direction;
  return index >= 0 && targetIndex >= 0 && targetIndex < sessions.length;
}

function stopStripScrollAnimation(strip = gameStrip.value) {
  if (stripScrollAnimationId) {
    window.cancelAnimationFrame(stripScrollAnimationId);
    stripScrollAnimationId = 0;
  }
  if (strip) stripScrollTarget = strip.scrollLeft;
}

function animateStripScroll() {
  const strip = gameStrip.value;
  if (!strip) {
    stripScrollAnimationId = 0;
    return;
  }

  const distance = stripScrollTarget - strip.scrollLeft;
  if (Math.abs(distance) <= 0.5) {
    strip.scrollLeft = stripScrollTarget;
    stripScrollAnimationId = 0;
    return;
  }

  strip.scrollLeft += distance * 0.24;
  stripScrollAnimationId = window.requestAnimationFrame(animateStripScroll);
}

function handleStripWheel(event) {
  const strip = gameStrip.value;
  if (!strip || !event.deltaY) return;
  if (event.ctrlKey || event.metaKey) {
    stopStripScrollAnimation(strip);
    return;
  }
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
    stopStripScrollAnimation(strip);
    return;
  }

  let delta = event.deltaY;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
  else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    delta *= strip.clientWidth;
  }

  const maxScrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth);
  if (!stripScrollAnimationId) stripScrollTarget = strip.scrollLeft;
  const nextScrollTarget = Math.min(
    maxScrollLeft,
    Math.max(0, stripScrollTarget + delta),
  );
  if (nextScrollTarget === stripScrollTarget) {
    if (stripScrollAnimationId) event.preventDefault();
    return;
  }

  event.preventDefault();
  stripScrollTarget = nextScrollTarget;
  if (!stripScrollAnimationId) {
    stripScrollAnimationId = window.requestAnimationFrame(animateStripScroll);
  }
}

async function moveFrame(scopeId, direction, event) {
  if (movingFrame.value) return;

  const button = event.currentTarget;
  const strip = gameStrip.value;
  stopStripScrollAnimation(strip);
  const previousLeft = button.getBoundingClientRect().left;
  movingFrame.value = true;

  try {
    const updatedLaunch = moveMultiGameSession({
      scopeId,
      direction,
      sessionStorage: window.sessionStorage,
    });
    if (!updatedLaunch) return;

    launch.value = updatedLaunch;
    await nextTick();
    if (!strip || !button.isConnected) return;

    const desiredScrollLeft =
      strip.scrollLeft + button.getBoundingClientRect().left - previousLeft;
    const maxScrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth);
    strip.scrollLeft = Math.min(
      maxScrollLeft,
      Math.max(0, desiredScrollLeft),
    );
    stripScrollTarget = strip.scrollLeft;
  } catch (error) {
    console.error("Unable to move MultiGame frame:", error);
    window.alert("移动运行窗口失败，请重试");
  } finally {
    movingFrame.value = false;
  }
}

function closeFrame(frame) {
  try {
    const updatedLaunch = closeMultiGameSession({
      scopeId: frame.scopeId,
      localStorage: window.localStorage,
      sessionStorage: window.sessionStorage,
    });
    clearFrameTimeout(frame.scopeId);
    clearControlPending(frame.scopeId);
    frameElements.delete(frame.scopeId);
    delete frameStates[frame.scopeId];
    // 清理分组 + 主窗口选举
    onFrameRemoved(frame.scopeId);
    const nextSelection = new Set(selectedScopes.value);
    nextSelection.delete(frame.scopeId);
    selectedScopes.value = nextSelection;
    launch.value = updatedLaunch;
  } catch (error) {
    console.error("Unable to close MultiGame frame:", error);
    window.alert("关闭运行窗口失败，请重试");
  }
}

function handleMessage(event) {
  const payload = event.data;
  if (payload?.channel === "multi-game" && payload.type === "control-result") {
    const pending = controlPending.get(payload.requestId);
    const frame = frames.value.find((item) => item.scopeId === payload.scope);
    const element = frame && frameElements.get(frame.scopeId);
    if (
      !pending ||
      event.origin !== window.location.origin ||
      payload.version !== 1 ||
      pending.scopeId !== payload.scope ||
      !frame ||
      !element ||
      event.source !== element.contentWindow
    ) {
      return;
    }
    window.clearTimeout(pending.timeoutId);
    controlPending.delete(payload.requestId);
    if (payload.ok) {
      applyAutomationResult(frame.scopeId, payload.result);
      pending.resolve(payload.result);
    } else {
      frameStates[frame.scopeId].automationError =
        payload.error || "自动盐场控制失败";
      pending.reject(new Error(frameStates[frame.scopeId].automationError));
    }
    return;
  }

  // ===== 同步事件转发：来自 iframe 的 user-event =====
  if (
    payload?.channel === "multi-game" &&
    payload.type === "user-event" &&
    payload.version === 1 &&
    event.origin === window.location.origin
  ) {
    const frame = frames.value.find((item) => item.scopeId === payload.scope);
    const element = frame && frameElements.get(frame.scopeId);
    if (frame && element && event.source === element.contentWindow) {
      handleUserEventFromFrame(frame.scopeId, payload.event);
    }
    return;
  }

  const result = resolveMultiGameFrameMessage({
    event,
    expectedOrigin: window.location.origin,
    frames: frames.value,
    frameElements,
  });
  if (result && frameStates[result.scopeId]) {
    clearFrameTimeout(result.scopeId);
    frameStates[result.scopeId].status = result.status;
    if (result.status === "ready") {
      refreshAutomationStatus(result.scopeId);
      // 新 iframe 就绪后，发送当前同步配置
      if (syncEnabled.value) {
        sendSyncConfigTo(result.scopeId);
      }
      // 确保分组状态已初始化 + 自动选举主窗口
      if (!(result.scopeId in frameGroups)) {
        setFrameGroup(result.scopeId, 0);
      } else {
        ensureGroupMaster(frameGroups[result.scopeId]);
      }
    }
  }
}

function goToTokens() {
  router.push("/tokens");
}

onBeforeMount(() => window.addEventListener("message", handleMessage));
onMounted(() => {
  frames.value.forEach((frame) => armFrameTimeout(frame.scopeId));
  // 初始主窗口选举：遍历所有已分组成员，每组选第一个
  for (let g = 0; g < MAX_GROUPS; g++) ensureGroupMaster(g);
  statusPollTimer = window.setInterval(() => {
    if (!controlBusy.value) refreshAutomationStatus();
  }, 5000);
});
onUnmounted(() => {
  window.removeEventListener("message", handleMessage);
  stopStripScrollAnimation();
  for (const scopeId of frameTimeouts.keys()) clearFrameTimeout(scopeId);
  for (const pending of controlPending.values()) {
    window.clearTimeout(pending.timeoutId);
    pending.reject(new Error("多开页面已关闭"));
  }
  controlPending.clear();
  if (statusPollTimer) window.clearInterval(statusPollTimer);
});
</script>

<style scoped>
.multi-game-page {
  position: fixed;
  inset: 0;
  z-index: 1000;
  color: #e5e7eb;
  background: #080b12;
}

.multi-game-toolbar {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  min-height: 52px;
  padding: 8px 12px;
  overflow-x: auto;
  border-bottom: 1px solid #273244;
  background: #111827;
}

.toolbar-button,
.move-button,
.reload-button,
.close-button,
.empty-card button,
.frame-error button {
  border: 1px solid #475569;
  border-radius: 6px;
  color: #f8fafc;
  background: #1e293b;
  cursor: pointer;
}

.toolbar-button {
  padding: 7px 11px;
}

.toolbar-button:hover,
.move-button:hover:not(:disabled),
.reload-button:hover,
.close-button:hover,
.empty-card button:hover,
.frame-error button:hover {
  background: #334155;
}

.toolbar-title {
  color: #f8fafc;
  font-size: 16px;
}

.toolbar-count {
  color: #93c5fd;
}

.toolbar-ready {
  color: #86efac;
  font-size: 12px;
}

.toolbar-skipped {
  color: #fbbf24;
}

/* ===== 同步操作控制区 ===== */
.sync-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border: 1px solid #3b4a63;
  border-radius: 8px;
  background: #0f1622;
}

.sync-label {
  color: #cbd5e1;
  font-size: 12px;
  font-weight: 600;
}

.sync-toggle {
  position: relative;
  display: inline-block;
  width: 38px;
  height: 20px;
  cursor: pointer;
}

.sync-toggle input {
  position: absolute;
  inset: 0;
  opacity: 0;
  margin: 0;
  cursor: pointer;
  z-index: 1;
}

.sync-toggle-indicator {
  position: absolute;
  inset: 0;
  border-radius: 20px;
  background: #374151;
  transition: background-color 0.2s;
}

.sync-toggle-indicator::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #e5e7eb;
  transition: transform 0.2s;
}

.sync-toggle-indicator.is-on {
  background: #2563eb;
}

.sync-toggle-indicator.is-on::after {
  transform: translateX(18px);
  background: #dbeafe;
}

.sync-status-on {
  color: #4ade80;
  font-size: 12px;
}

.sync-status-off {
  color: #64748b;
  font-size: 12px;
}

.sync-group-badges {
  display: flex;
  gap: 3px;
}

.sync-group-badge {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  cursor: help;
}

.frame-group-indicator {
  flex: none;
  min-width: 30px;
  height: 22px;
  padding: 0 5px;
  border: 1px solid #475569;
  border-radius: 4px;
  color: #cbd5e1;
  font-size: 12px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  cursor: pointer;
  transition: transform 0.1s, box-shadow 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.frame-group-indicator:hover {
  transform: scale(1.08);
}

.frame-group-indicator.is-master {
  box-shadow: 0 0 0 1px #eab308, 0 0 8px #eab30880;
  background: #713f12 !important;
  color: #fde68a !important;
}

.master-star {
  font-size: 10px;
  color: #fbbf24;
}

.group-popover {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group-popover-title {
  padding-bottom: 4px;
  margin-bottom: 4px;
  border-bottom: 1px solid #374151;
  color: #94a3b8;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.group-option-btn {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid #374151;
  border-radius: 5px;
  background: #0f1622;
  color: #cbd5e1;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}

.group-option-btn:hover {
  background: #1e293b;
  border-color: #2563eb;
}

.group-option-btn.active {
  border-color: #2563eb;
  background: #1d4ed8;
  color: #dbeafe;
  font-weight: 600;
}

.group-option-btn.is-master-row {
  border-color: #eab308 !important;
  background: #713f12 !important;
  color: #fde68a !important;
}

.group-option-btn.group-option-primary {
  border-color: #2563eb;
  background: #1d4ed8;
  color: #dbeafe;
  font-weight: 600;
}

.group-option-btn.group-option-primary:hover {
  background: #1e40af !important;
}

.group-option-btn .group-name {
  flex: 1;
}

.master-badge {
  flex: none;
  padding: 1px 5px;
  border-radius: 3px;
  background: #eab308;
  color: #1c1917;
  font-size: 10px;
  font-weight: 700;
}

.master-badge-muted {
  flex: none;
  padding: 1px 5px;
  border-radius: 3px;
  background: #374151;
  color: #9ca3af;
  font-size: 10px;
  font-weight: 500;
  max-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-popover-sep {
  height: 1px;
  margin: 4px 0;
  background: #374151;
}

.automation-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}

.selection-count {
  color: #cbd5e1;
  font-size: 12px;
}

.toolbar-action,
.panel-action {
  min-height: 26px;
  padding: 3px 8px;
  border: 1px solid #475569;
  border-radius: 5px;
  color: #e2e8f0;
  background: #1e293b;
  cursor: pointer;
}

.toolbar-action:hover:not(:disabled),
.panel-action:hover:not(:disabled) {
  background: #334155;
}

.toolbar-action-primary,
.panel-action-primary {
  border-color: #2563eb;
  color: #dbeafe;
  background: #1d4ed8;
}

.toolbar-action-warning,
.panel-action-warning {
  border-color: #92400e;
  color: #fef3c7;
  background: #78350f;
}

.toolbar-action:disabled,
.panel-action:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.toolbar-warning {
  flex: 1 1 180px;
  min-width: 180px;
  color: #94a3b8;
  font-size: 12px;
  text-align: right;
}


.crash-help-trigger {
  flex: none;
  padding: 3px 7px;
  border: 1px solid #92400e;
  border-radius: 6px;
  color: #fbbf24;
  background: #451a03;
  cursor: help;
}

.crash-help-trigger:hover,
.crash-help-trigger:focus-visible {
  background: #78350f;
  outline: none;
}

.crash-help-content {
  line-height: 1.6;
  white-space: normal;
}

.crash-help-content p {
  margin: 8px 0;
}

.crash-help-content a {
  color: #2563eb;
  text-decoration: underline;
}
.game-strip {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 390px), 1fr));
  grid-auto-rows: max-content;
  align-items: flex-start;
  align-content: flex-start;
  gap: 12px;
  height: calc(100dvh - 68px);
  padding: 12px;
  overflow: auto;
}

.game-panel {
  box-sizing: border-box;
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 520px;
  min-width: 0;
  justify-self: center;
  overflow: hidden;
  border: 1px solid #334155;
  border-radius: 8px;
  background: #000;
  box-shadow: 0 10px 28px rgb(0 0 0 / 35%);
}

.game-panel-header {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 4px 8px;
  background: #172033;
}

.frame-select {
  flex: none;
  width: 16px;
  height: 16px;
  accent-color: #60a5fa;
}

.account-name {
  min-width: 0;
  overflow: hidden;
  color: #f8fafc;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.frame-status {
  flex: none;
  font-size: 12px;
}

.frame-status.is-loading {
  color: #fbbf24;
}

.frame-status.is-ready {
  color: #4ade80;
}

.frame-status.is-fatal {
  color: #f87171;
}

.automation-status {
  flex: none;
  font-size: 11px;
}

.automation-status.is-offline {
  color: #94a3b8;
}

.automation-status.is-loading {
  color: #fbbf24;
}

.automation-status.is-running {
  color: #4ade80;
}

.automation-status.is-paused {
  color: #cbd5e1;
}

.move-button {
  flex: none;
  width: 28px;
  height: 24px;
  padding: 0;
  font-size: 16px;
  line-height: 22px;
}

.move-button-first {
  margin-left: auto;
}

.move-button:disabled {
  color: #64748b;
  background: #111827;
  cursor: not-allowed;
  opacity: 0.65;
}

.reload-button {
  flex: none;
  padding: 3px 7px;
  font-size: 12px;
}

.close-button {
  flex: none;
  padding: 3px 7px;
  border-color: #7f1d1d;
  color: #fecaca;
  background: #450a0a;
  font-size: 12px;
}

.close-button:hover {
  background: #7f1d1d;
}

.game-frame-shell {
  position: relative;
  height: auto;
  aspect-ratio: 9 / 16;
  flex: 0 0 auto;
  width: 100%;
  height: 177.7777778cqw;
}

.game-panel-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 42px;
  padding: 6px 8px;
  background: #111827;
}

.panel-action {
  font-size: 12px;
}

.automation-error {
  margin-left: auto;
  overflow: hidden;
  color: #fca5a5;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.game-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}

.frame-error {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  color: #fecaca;
  background: rgb(15 23 42 / 92%);
}

.frame-error span {
  color: #94a3b8;
  font-size: 13px;
}

.frame-error button {
  padding: 7px 16px;
}

.empty-state {
  display: grid;
  height: calc(100dvh - 52px);
  padding: 24px;
  place-items: center;
}

.empty-card {
  max-width: 480px;
  padding: 32px;
  text-align: center;
  border: 1px solid #334155;
  border-radius: 12px;
  background: #111827;
}

.empty-card h1 {
  margin: 0 0 12px;
  color: #f8fafc;
  font-size: 22px;
}

.empty-card p {
  margin: 0 0 20px;
  color: #94a3b8;
}

.empty-card button {
  padding: 9px 18px;
}

@media (max-width: 720px) {
  .multi-game-toolbar {
    gap: 8px;
    padding: 8px;
  }

  .automation-actions,
  .toolbar-warning {
    flex-basis: 100%;
    margin-left: 0;
  }

  .toolbar-warning {
    text-align: left;
  }

  .game-strip {
    grid-template-columns: minmax(0, 1fr);
    height: calc(100dvh - 142px);
    padding: 8px;
  }

  .game-panel {
    max-width: none;
  }
}
</style>