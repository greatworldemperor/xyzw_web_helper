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

      <div
        v-if="frames.length"
        class="platform-spoof-controls"
        role="group"
        aria-label="批量运行时平台伪装"
      >
        <span class="platform-spoof-label">平台伪装</span>
        <button
          class="platform-spoof-button"
          :class="{ 'is-enabled': multiGameSpoofEnabled }"
          type="button"
          :aria-pressed="multiGameSpoofEnabled"
          @click="toggleMultiGameSpoof"
        >
          {{ multiGameSpoofEnabled ? "已开启" : "已关闭" }}
        </button>
        <select
          v-model="multiGameSpoofTarget"
          class="platform-spoof-select"
          aria-label="批量运行时伪装目标"
          :disabled="!multiGameSpoofEnabled"
          @change="persistMultiGameSpoof"
        >
          <option
            v-for="option in multiGameSpoofTargetOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <button
          class="platform-spoof-reload"
          type="button"
          :disabled="!frames.length"
          @click="reloadAllFrames"
        >
          重载全部窗口
        </button>
        <span class="platform-spoof-hint">
          {{ multiGameSpoofEnabled ? `h5web → ${multiGameSpoofTarget}，重载后生效` : "关闭（批量独立配置，重载后恢复 h5web）" }}
        </span>
      </div>

      <div
        v-if="frames.length"
        class="platform-spoof-controls"
        role="group"
        aria-label="批量运行时首帧口径改写"
      >
        <span class="platform-spoof-label">首帧改写</span>
        <button
          class="platform-spoof-button"
          :class="{ 'is-enabled': multiGameFrameSpoofEnabled }"
          type="button"
          :aria-pressed="multiGameFrameSpoofEnabled"
          @click="toggleMultiGameFrameSpoof"
        >
          {{ multiGameFrameSpoofEnabled ? "已开启" : "已关闭" }}
        </button>
        <button
          class="platform-spoof-button"
          :class="{ 'is-enabled': multiGameFrameSpoofObserveOnly }"
          type="button"
          :aria-pressed="multiGameFrameSpoofObserveOnly"
          :disabled="!multiGameFrameSpoofEnabled"
          @click="toggleMultiGameFrameSpoofObserve"
        >
          只观察
        </button>
        <span class="platform-spoof-hint">
          {{
            multiGameFrameSpoofEnabled
              ? `role_getroleinfo → platformExt:mix / clientVersion:2.21.2…${multiGameFrameSpoofObserveOnly ? "（只记录不改字节）" : ""}，重载后生效`
              : "关闭（帧内容原样发出；改帧用于验证 3000070 是否按上报口径拦截）"
          }}
        </span>
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

    <!-- 同步栏：模式 / 分组顺序 / 组长（全局同步源默认取第一个分组的组长，也可点窗口标题指定） -->
    <section
      v-if="frames.length"
      class="sync-bar"
      aria-label="批量运行时同步"
      @dragend="endGroupDrag"
    >
      <div class="sync-mode-row">
        <span class="sync-label">同步模式</span>
        <div class="sync-mode-options" role="radiogroup" aria-label="同步模式">
          <button
            v-for="option in syncModeOptions"
            :key="option.value"
            type="button"
            class="sync-mode-button"
            :class="{ 'is-active': syncMode === option.value }"
            :aria-pressed="syncMode === option.value"
            :title="option.hint"
            @click="setSyncMode(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
        <span
          class="sync-summary"
          :class="syncPlan.active ? 'is-on' : 'is-off'"
        >
          {{ syncSummary }}
        </span>
        <button
          v-if="syncMode === SYNC_MODE_GLOBAL && syncGlobalSource"
          type="button"
          class="sync-source-clear"
          title="取消手动指定的同步源，改回按「第一个分组的组长」推导"
          @click="clearGlobalSource"
        >
          ✕ 取消手动源
        </button>
      </div>

      <div v-if="syncGroups.length" class="sync-group-row">
        <span class="sync-label">分组顺序</span>
        <div class="sync-group-chips">
          <div
            v-for="(chip, index) in syncGroupChips"
            :key="chip.id"
            class="sync-chip"
            :class="{
              'is-dragging': draggingGroupId === chip.id,
              'is-drop-target': dragOverGroupId === chip.id,
              'is-global-source': chip.isGlobalSourceGroup,
              'is-inactive': chip.inactive,
            }"
            @dragover.prevent="dragOverGroupId = chip.id"
            @dragleave="clearDragOver(chip.id)"
            @drop.prevent="dropGroupOn(chip.id)"
          >
            <span
              class="sync-chip-handle"
              draggable="true"
              title="拖动调整分组顺序"
              @dragstart="startGroupDrag(chip.id, $event)"
            >
              ⠿
            </span>
            <span class="sync-chip-index">{{ index + 1 }}</span>
            <span
              class="sync-chip-dot"
              :style="{ backgroundColor: chip.color }"
            ></span>
            <span class="sync-chip-name" :title="chip.name">
              {{ chip.name }}
            </span>
            <span class="sync-chip-count" :title="chip.countTitle">
              {{ chip.countLabel }}{{ chip.inactive ? "（单窗口不参与）" : "" }}
            </span>
            <span v-if="chip.isGlobalSourceGroup" class="sync-chip-flag">
              全局源
            </span>
            <span class="sync-chip-master">
              <span class="sync-chip-master-label">组长</span>
              <select
                class="sync-chip-select"
                :value="chip.masterScopeId || ''"
                :aria-label="`${chip.name} 的组长`"
                @change="setGroupMaster(chip.id, $event.target.value)"
              >
                <option v-for="member in chip.members" :key="member.scopeId" :value="member.scopeId">
                  {{ member.name }}
                </option>
              </select>
            </span>
            <span class="sync-chip-move">
              <button
                type="button"
                class="sync-chip-move-button"
                title="上移一个位置"
                :disabled="index === 0"
                @click="moveGroup(chip.id, -1)"
              >
                ←
              </button>
              <button
                type="button"
                class="sync-chip-move-button"
                title="下移一个位置"
                :disabled="index === syncGroupChips.length - 1"
                @click="moveGroup(chip.id, 1)"
              >
                →
              </button>
            </span>
          </div>
        </div>
        <span class="sync-hint">
          分组直接来自 Token 管理，只显示已打开窗口所在的分组；拖动 ⠿ 调整顺序，第一个分组的组长是全局同步的默认源，分组同步时各组组长只驱动本组；全局同步模式下点窗口标题可直接指定同步源
        </span>
      </div>
      <span v-else class="sync-hint">
        本次打开的窗口都不在任何 Token 管理分组里：分组同步用不了，请先到 Token 管理把账号分好组并勾选；全局同步不受影响，点窗口标题就能指定同步源
      </span>
    </section>

    <main
      v-if="frames.length"
      ref="gameStrip"
      class="game-strip"
      @wheel="handleStripWheel"
      @scroll="handleStripScroll"
      @pointerdown="releaseStripScrollLock"
      @touchstart.passive="releaseStripScrollLock"
    >
      <article
        v-for="frame in frames"
        :key="frame.scopeId"
        class="game-panel"
        :class="{ 'is-sync-source': isSyncSource(frame.scopeId) }"
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
          <div class="frame-group-tags" :title="getFrameGroupTitle(frame.scopeId)">
            <button
              v-for="group in getFrameGroups(frame.scopeId)"
              :key="group.id"
              class="frame-group-tag"
              type="button"
              :class="{ 'is-master': isGroupMaster(group.id, frame.scopeId) }"
              :style="{
                borderColor: group.color,
                color: group.color,
                backgroundColor: `${group.color}22`,
              }"
              :title="`${group.name}：点击把「${frame.name}」设为该组组长`"
              @click="setGroupMaster(group.id, frame.scopeId)"
            >
              {{ group.name }}
              <span v-if="isGroupMaster(group.id, frame.scopeId)">· 主</span>
            </button>
          </div>
          <span
            v-if="frameSyncRole(frame.scopeId)"
            class="frame-sync-flag"
            :class="`is-${frameSyncRole(frame.scopeId).tone}`"
          >
            {{ frameSyncRole(frame.scopeId).label }}
          </span>
          <!-- 全局同步下点标题即指定同步源（不依赖 Token 管理分组） -->
          <button
            v-if="syncMode === SYNC_MODE_GLOBAL"
            type="button"
            class="account-name account-name-pick"
            :class="{ 'is-global-source': isGlobalSourceScope(frame.scopeId) }"
            :title="globalSourceTitle(frame.scopeId)"
            @click="toggleGlobalSource(frame.scopeId)"
          >
            {{ frame.name }}
          </button>
          <span v-else class="account-name" :title="frame.name">{{ frame.name }}</span>
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
  watch,
} from "vue";
import { useRouter } from "vue-router";
import {
  buildMultiGameFrameSrc,
  closeMultiGameSession,
  moveMultiGameSession,
  MULTI_GAME_FRAME_SPOOF_KEY,
  MULTI_GAME_PLATFORM_SPOOF_KEY,
  MULTI_GAME_SYNC_GLOBAL_SOURCE_KEY,
  MULTI_GAME_SYNC_GROUP_ORDER_KEY,
  MULTI_GAME_SYNC_LEGACY_GROUPS_KEY,
  MULTI_GAME_SYNC_MASTERS_KEY,
  MULTI_GAME_SYNC_MODE_KEY,
  MULTI_GAME_TOKEN_GROUPS_KEY,
  readActiveMultiGameLaunch,
  resolveMultiGameFrameMessage,
} from "@/utils/gameLauncher";
import {
  describeSyncRole,
  normalizeSyncMode,
  orderSyncGroups,
  planMultiGameSync,
  SYNC_MODE_GLOBAL,
  SYNC_MODE_GROUP,
  SYNC_MODE_NONE,
  SYNC_MODE_OPTIONS,
} from "@/utils/multiGameSyncPlan";

const router = useRouter();
const FRAME_LOAD_TIMEOUT_MS = 45_000;
const multiGameSpoofEnabled = ref(false);
// 2026-09-16 实测：网页环境可登录的 PLATFORM 只有 h5/h5web。
// "mix" 不是映射表 key（getter 崩溃）；"wx" 等切 App SDK 登录分支（网页无 SDK 桥，卡死）。
const multiGameSpoofTarget = ref("h5");
const multiGameSpoofTargetOptions = [
  { label: "h5（推荐）", value: "h5" },
  { label: "h5web（原始）", value: "h5web" },
];
// 首帧口径改写：直接改 WS 帧字节里的 platformExt/clientVersion（3000070 归因验证）。
// 与平台伪装是两条独立的路：网页能登录的只有 h5/h5web，想上 mix 口径只能改帧。
const multiGameFrameSpoofEnabled = ref(false);
const multiGameFrameSpoofObserveOnly = ref(false);
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
// 三种模式：不同步（默认）/ 分组同步（各组组长驱动本组）/ 全局同步（一个源驱动全部，
// 源点窗口标题指定，没指定时用第一个分组的组长）
const SYNC_CMD_CHANNEL = "multi-game-sync";
const SYNC_VERSION = 2;
const syncThrottleMs = 16; // ~60fps
const tokenGroups = ref([]);
const syncMode = ref(SYNC_MODE_NONE);
const syncGroupOrder = ref([]);
const syncGroupMasters = ref({});
// 全局同步源：点窗口标题手动指定的 scopeId；空 = 按「第一个分组的组长」推导
const syncGlobalSource = ref("");
const draggingGroupId = ref("");
const dragOverGroupId = ref("");
const syncModeOptions = SYNC_MODE_OPTIONS;

function readJsonStorage(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Unable to persist ${key}:`, error);
  }
}

function loadTokenGroups() {
  const groups = readJsonStorage(MULTI_GAME_TOKEN_GROUPS_KEY, []);
  tokenGroups.value = Array.isArray(groups)
    ? groups
        .filter((group) => group && group.id != null)
        .map((group) => ({
          id: String(group.id),
          name: String(group.name || "未命名分组"),
          color: String(group.color || "#64748b"),
          tokenKeys: Array.isArray(group.tokenKeys)
            ? group.tokenKeys.map(String)
            : [],
        }))
    : [];
}

function loadSyncSettings() {
  const savedMode = readJsonStorage(MULTI_GAME_SYNC_MODE_KEY, null);
  syncMode.value = savedMode
    ? normalizeSyncMode(savedMode)
    : migrateLegacySyncMode();
  const order = readJsonStorage(MULTI_GAME_SYNC_GROUP_ORDER_KEY, []);
  syncGroupOrder.value = Array.isArray(order) ? order.map(String) : [];
  const masters = readJsonStorage(MULTI_GAME_SYNC_MASTERS_KEY, {});
  syncGroupMasters.value =
    masters && typeof masters === "object" && !Array.isArray(masters)
      ? Object.fromEntries(
          Object.entries(masters).map(([groupId, scopeId]) => [
            String(groupId),
            String(scopeId),
          ]),
        )
      : {};
  const globalSource = readJsonStorage(MULTI_GAME_SYNC_GLOBAL_SOURCE_KEY, "");
  syncGlobalSource.value = typeof globalSource === "string" ? globalSource : "";
}

/**
 * 旧版按「每个分组一个开关」保存同步意图（multiGameSyncGroups）。
 * 新模式只存一个全局模式，所以首次读取时把「曾经开过同步」迁移成分组同步，
 * 避免老用户升级后同步静默失效。没存过模式的用户仍然是「不同步」。
 */
function migrateLegacySyncMode() {
  const legacy = readJsonStorage(MULTI_GAME_SYNC_LEGACY_GROUPS_KEY, {});
  const hadEnabledGroup =
    legacy && typeof legacy === "object" && !Array.isArray(legacy)
      ? Object.values(legacy).some((enabled) => enabled === true)
      : false;
  if (!hadEnabledGroup) return SYNC_MODE_NONE;
  writeJsonStorage(MULTI_GAME_SYNC_MODE_KEY, SYNC_MODE_GROUP);
  return SYNC_MODE_GROUP;
}

loadTokenGroups();
loadSyncSettings();

function initMultiGameSpoof() {
  try {
    const raw = window.localStorage.getItem(MULTI_GAME_PLATFORM_SPOOF_KEY);
    const config = raw ? JSON.parse(raw) : null;
    if (!config || typeof config !== "object") return;
    multiGameSpoofEnabled.value = config.enabled === true;
    // 旧配置兼容：mix/wx 等历史值在网页环境不可登录，统一归一为 h5
    multiGameSpoofTarget.value = config.platform === "h5web" ? "h5web" : "h5";
  } catch {}
}

function persistMultiGameSpoof() {
  const serialized = JSON.stringify({
    enabled: multiGameSpoofEnabled.value,
    platform: multiGameSpoofTarget.value,
    gameVersion: "",
  });
  try {
    window.localStorage.setItem(MULTI_GAME_PLATFORM_SPOOF_KEY, serialized);
    for (const session of launch.value?.sessions || []) {
      window.localStorage.setItem(
        `multi-game:${session.scopeId}:${MULTI_GAME_PLATFORM_SPOOF_KEY}`,
        serialized,
      );
    }
  } catch (error) {
    console.error("Unable to persist MultiGame platform spoof config:", error);
  }
}

function toggleMultiGameSpoof() {
  multiGameSpoofEnabled.value = !multiGameSpoofEnabled.value;
  persistMultiGameSpoof();
}

function initMultiGameFrameSpoof() {
  try {
    const raw = window.localStorage.getItem(MULTI_GAME_FRAME_SPOOF_KEY);
    const config = raw ? JSON.parse(raw) : null;
    if (!config || typeof config !== "object") return;
    multiGameFrameSpoofEnabled.value = config.enabled === true;
    multiGameFrameSpoofObserveOnly.value = config.observeOnly === true;
  } catch {}
}

function persistMultiGameFrameSpoof() {
  const serialized = JSON.stringify({
    enabled: multiGameFrameSpoofEnabled.value,
    observeOnly: multiGameFrameSpoofObserveOnly.value,
    rules: [
      {
        cmd: "role_getroleinfo",
        fields: {
          platformExt: "mix",
          clientVersion: "2.21.2-fa918e1997301834-wx",
        },
      },
    ],
  });
  try {
    window.localStorage.setItem(MULTI_GAME_FRAME_SPOOF_KEY, serialized);
    for (const session of launch.value?.sessions || []) {
      window.localStorage.setItem(
        `multi-game:${session.scopeId}:${MULTI_GAME_FRAME_SPOOF_KEY}`,
        serialized,
      );
    }
  } catch (error) {
    console.error("Unable to persist MultiGame frame spoof config:", error);
  }
}

function toggleMultiGameFrameSpoof() {
  multiGameFrameSpoofEnabled.value = !multiGameFrameSpoofEnabled.value;
  if (!multiGameFrameSpoofEnabled.value) multiGameFrameSpoofObserveOnly.value = false;
  persistMultiGameFrameSpoof();
}

function toggleMultiGameFrameSpoofObserve() {
  multiGameFrameSpoofObserveOnly.value = !multiGameFrameSpoofObserveOnly.value;
  persistMultiGameFrameSpoof();
}

initMultiGameSpoof();
initMultiGameFrameSpoof();

/**
 * 同步分组 = Token 管理里的分组 ∩ 本次已打开窗口所在的账号。
 * 页面不维护自己的分组、也没有固定槽位：Token 管理里没勾选（窗口没打开）的分组不会出现。
 * 顺序按页面保存的 multiGameSyncGroupOrder 排列，组内窗口保持窗口顺序。
 */
const syncGroups = computed(() =>
  orderSyncGroups(
    tokenGroups.value
      .map((group) => ({
        ...group,
        scopeIds: frames.value
          .filter((frame) => group.tokenKeys.includes(String(frame.tokenKey)))
          .map((frame) => frame.scopeId),
      }))
      .filter((group) => group.scopeIds.length > 0),
    syncGroupOrder.value,
  ),
);

const syncPlan = computed(() =>
  planMultiGameSync({
    mode: syncMode.value,
    frames: frames.value.map((frame) => ({
      scopeId: frame.scopeId,
      name: frame.name,
    })),
    groups: syncGroups.value,
    masters: syncGroupMasters.value,
    globalSourceScopeId: syncGlobalSource.value,
  }),
);

const hasSyncEnabled = computed(() => syncPlan.value.active);

function frameName(scopeId) {
  return frames.value.find((frame) => frame.scopeId === scopeId)?.name || "未知账号";
}

/** 没有被任何分组覆盖的窗口数量（分组同步时它们不参与）。 */
const ungroupedFrameCount = computed(() => {
  const grouped = new Set(
    syncGroups.value.flatMap((group) => group.scopeIds),
  );
  return frames.value.filter((frame) => !grouped.has(frame.scopeId)).length;
});

const syncGroupChips = computed(() => {
  const plan = syncPlan.value;
  // 手动指定同步源时，高亮它所在的分组；没手动指定才把第一个分组标成「默认全局源」
  const globalSourceGroupId =
    plan.mode === SYNC_MODE_GLOBAL ? plan.globalSourceGroupId : null;
  return plan.groups.map((group) => {
    const opened = group.scopeIds.length;
    const totalMembers = group.tokenKeys.length;
    return {
      ...group,
      isGlobalSourceGroup: group.id === globalSourceGroupId,
      // 分组同步下单人分组没有同步对象，明确标出来免得以为失效
      inactive: plan.mode === SYNC_MODE_GROUP && opened < 2,
      // 组内还有账号没打开（没勾选）时把比例显示出来
      countLabel:
        totalMembers > opened
          ? `已打开 ${opened} / 组内 ${totalMembers}`
          : `${opened} 窗口`,
      countTitle: `组内共 ${totalMembers} 个账号，本次已打开 ${opened} 个`,
      members: group.scopeIds.map((scopeId) => ({
        scopeId,
        name: frameName(scopeId),
      })),
    };
  });
});

const syncSummary = computed(() => {
  const plan = syncPlan.value;
  if (plan.mode === SYNC_MODE_NONE) return "○ 不同步（默认，不会互相影响）";
  if (!plan.active) {
    if (!plan.groups.length) {
      return "○ 未生效：没有可用分组，请先在 Token 管理里给账号分组并勾选，或点击窗口标题直接指定全局同步源";
    }
    return plan.mode === SYNC_MODE_GLOBAL
      ? "○ 未生效：没有可用窗口"
      : "○ 未生效：同一个分组至少要有 2 个窗口";
  }
  const targetCount = new Set(Object.values(plan.targets).flat()).size;
  if (plan.mode === SYNC_MODE_GLOBAL) {
    const source = frameName(plan.sourceScopeId);
    if (!targetCount) return `● 全局：${source} 是同步源，暂无其他窗口可跟随`;
    return `● 全局：${source} 驱动 ${targetCount} 个窗口（${
      plan.globalSourceManual ? "手动指定" : "第一个分组的组长"
    }）`;
  }
  const skipped = ungroupedFrameCount.value;
  return `● 分组：${plan.sources.length} 个组长驱动 ${targetCount} 个窗口${
    skipped > 0 ? `（另有 ${skipped} 个未分组窗口不参与）` : ""
  }`;
});

function setSyncMode(mode) {
  const next = normalizeSyncMode(mode);
  if (next === syncMode.value) return;
  syncMode.value = next;
  writeJsonStorage(MULTI_GAME_SYNC_MODE_KEY, next);
  broadcastSyncConfig();
}

/** 当前是否就是这个窗口在当全局同步源（只有全局同步模式才有这一说）。 */
function isGlobalSourceScope(scopeId) {
  return (
    syncMode.value === SYNC_MODE_GLOBAL &&
    syncPlan.value.sourceScopeId === String(scopeId)
  );
}

function globalSourceTitle(scopeId) {
  const name = frameName(scopeId);
  return isGlobalSourceScope(scopeId)
    ? `${name} 是当前全局同步源：点击取消，改回按「第一个分组的组长」推导`
    : `点击把 ${name} 设为全局同步源，其他窗口跟随它的操作`;
}

/** 写入手动指定的全局同步源（空字符串 = 取消，回退为第一个分组的组长）。 */
function setGlobalSource(scopeId) {
  const next = typeof scopeId === "string" ? scopeId : "";
  if (next === syncGlobalSource.value) return;
  syncGlobalSource.value = next;
  writeJsonStorage(MULTI_GAME_SYNC_GLOBAL_SOURCE_KEY, next);
  broadcastSyncConfig();
}

function clearGlobalSource() {
  setGlobalSource("");
}

/**
 * 点击窗口标题指定全局同步源 —— 不依赖 Token 管理分组，
 * 临时拼起来的一批窗口也能选队长。再点一次取消（回退为第一个分组的组长）。
 * 分组同步没有这个入口：各组的组长在同步栏下拉 / 分组标签里选。
 */
function toggleGlobalSource(scopeId) {
  if (syncMode.value !== SYNC_MODE_GLOBAL) return;
  const key = String(scopeId);
  setGlobalSource(syncGlobalSource.value === key ? "" : key);
}

function getFrameGroups(scopeId) {
  return syncGroups.value.filter((group) => group.scopeIds.includes(scopeId));
}

function getFrameGroupTitle(scopeId) {
  const groups = getFrameGroups(scopeId);
  return groups.length
    ? groups.map((group) => group.name).join("、")
    : "未加入 Token 管理分组，不参与同步";
}

function isGroupMaster(groupId, scopeId) {
  const group = syncPlan.value.groups.find((item) => item.id === groupId);
  return Boolean(group && group.masterScopeId === scopeId);
}

/** 窗口卡片角标：谁是同步源、谁在跟随。 */
function frameSyncRole(scopeId) {
  if (syncMode.value === SYNC_MODE_NONE) return null;
  return describeSyncRole(syncPlan.value.roles[scopeId]);
}

/** 当前真正在驱动其他窗口的那个窗口（只有它会收到本地输入并转发）。 */
function isSyncSource(scopeId) {
  return Boolean(syncPlan.value.roles[scopeId]?.send);
}

function setGroupMaster(groupId, scopeId) {
  if (!groupId || !scopeId) return;
  const key = String(groupId);
  const group = syncGroups.value.find((item) => item.id === key);
  if (!group || !group.scopeIds.includes(scopeId)) return;
  const current = syncPlan.value.groups.find((item) => item.id === key);
  if (current?.masterScopeId === scopeId) return;
  syncGroupMasters.value = { ...syncGroupMasters.value, [key]: scopeId };
  writeJsonStorage(MULTI_GAME_SYNC_MASTERS_KEY, syncGroupMasters.value);
  broadcastSyncConfig();
}

function persistSyncGroupOrder() {
  writeJsonStorage(MULTI_GAME_SYNC_GROUP_ORDER_KEY, syncGroupOrder.value);
}

function applyGroupOrder(orderedIds) {
  syncGroupOrder.value = orderedIds;
  persistSyncGroupOrder();
  broadcastSyncConfig();
}

function moveGroup(groupId, direction) {
  const ordered = syncGroups.value.map((group) => group.id);
  const index = ordered.indexOf(String(groupId));
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ordered.length) return;
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  applyGroupOrder(ordered);
}

function startGroupDrag(groupId, event) {
  draggingGroupId.value = String(groupId);
  try {
    event?.dataTransfer?.setData("text/plain", String(groupId));
    if (event?.dataTransfer) event.dataTransfer.effectAllowed = "move";
  } catch {
    // 部分内核不允许写 dataTransfer，排序本身不依赖它
  }
}

function clearDragOver(groupId) {
  if (dragOverGroupId.value === String(groupId)) dragOverGroupId.value = "";
}

function dropGroupOn(targetGroupId) {
  const sourceId = draggingGroupId.value;
  dragOverGroupId.value = "";
  endGroupDrag();
  if (!sourceId || sourceId === String(targetGroupId)) return;
  const ordered = syncGroups.value.map((group) => group.id);
  const from = ordered.indexOf(sourceId);
  const to = ordered.indexOf(String(targetGroupId));
  if (from < 0 || to < 0) return;
  ordered.splice(from, 1);
  ordered.splice(to, 0, sourceId);
  applyGroupOrder(ordered);
}

function endGroupDrag() {
  draggingGroupId.value = "";
  dragOverGroupId.value = "";
}

/** 每个窗口下发的同步角色：send = 作为同步源上报，receive = 回放其他窗口的事件。 */
function syncConfigFor(scopeId) {
  const role = syncPlan.value.roles[scopeId] || { send: false, receive: false };
  return {
    channel: SYNC_CMD_CHANNEL,
    version: SYNC_VERSION,
    type: "config",
    send: role.send,
    receive: role.receive,
    // 兼容旧版 bridge（只认 enabled）
    enabled: role.send || role.receive,
    throttleMs: syncThrottleMs,
  };
}

/**
 * 向所有 iframe 广播同步配置
 */
function broadcastSyncConfig() {
  for (const [scopeId, element] of frameElements) {
    if (!isFrameReady(scopeId)) continue;
    element.contentWindow?.postMessage(
      syncConfigFor(scopeId),
      window.location.origin,
    );
  }
}

/**
 * 向指定 iframe 单独发送同步配置
 */
function sendSyncConfigTo(scopeId) {
  const element = frameElements.get(scopeId);
  if (!element || !isFrameReady(scopeId)) return;
  element.contentWindow?.postMessage(
    syncConfigFor(scopeId),
    window.location.origin,
  );
}

/**
 * 处理来自 iframe 的用户事件：只有同步源（组长 / 全局源）会转发，
 * 目标是该源负责的窗口集合，重叠分组自动去重。
 */
function handleUserEventFromFrame(scopeId, eventData) {
  const plan = syncPlan.value;
  if (!plan.roles[scopeId]?.send) return;
  const targetScopeIds = (plan.targets[scopeId] || []).filter((targetId) =>
    isFrameReady(targetId),
  );
  if (!targetScopeIds.length) return;

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
  // 兜底：同步转发可能引发 iframe 内部的跨文档滚动，锁定宿主网格位置
  lockStripScroll();
}

// 窗口增减 / 窗口顺序 / 分组归属 / 手动同步源变化都会改变同步角色，重新下发一次
watch(
  () =>
    Object.entries(syncPlan.value.roles)
      .map(
        ([scopeId, role]) =>
          `${scopeId}:${role.send ? "s" : ""}${role.receive ? "r" : ""}`,
      )
      .join("|"),
  () => broadcastSyncConfig(),
);


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

function reloadAllFrames() {
  for (const frame of frames.value) reloadFrame(frame.scopeId);
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

// ===== 同步静默化：转发同步事件期间锁定网格滚动位置 =====
// 从窗口内的游戏运行时（cocos EditBox）会调用 scrollIntoView / focus，
// 这两者的滚动副作用能跨 iframe 上溯，把宿主网格滚到该窗口所在行。
// multi-game-sync-bridge.js 已把滚动限制在 iframe 内部，这里再兜底一层：
// 同步转发后的一小段时间内，任何非用户发起的滚动都立即还原。
const STRIP_SCROLL_LOCK_MS = 1800;
let stripScrollLock = null;

function lockStripScroll() {
  if (!hasSyncEnabled.value) return;
  const strip = gameStrip.value;
  if (!strip) return;
  const now = performance.now();
  // 已在锁定窗口内则只续期，避免以"被滚走的位置"为新基准
  if (stripScrollLock && now <= stripScrollLock.until) {
    stripScrollLock.until = now + STRIP_SCROLL_LOCK_MS;
    return;
  }
  stripScrollLock = {
    scrollLeft: strip.scrollLeft,
    scrollTop: strip.scrollTop,
    until: now + STRIP_SCROLL_LOCK_MS,
  };
}

function releaseStripScrollLock() {
  stripScrollLock = null;
}

function handleStripScroll() {
  const strip = gameStrip.value;
  const lock = stripScrollLock;
  if (!strip || !lock) return;
  if (performance.now() > lock.until) {
    stripScrollLock = null;
    return;
  }
  // 用户滚轮平滑滚动进行中，不打断
  if (stripScrollAnimationId) return;
  if (
    Math.abs(strip.scrollLeft - lock.scrollLeft) <= 0.5 &&
    Math.abs(strip.scrollTop - lock.scrollTop) <= 0.5
  ) {
    return;
  }
  strip.scrollLeft = lock.scrollLeft;
  strip.scrollTop = lock.scrollTop;
  stripScrollTarget = strip.scrollLeft;
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
  // 用户主动滚动，解除同步兜底锁定
  releaseStripScrollLock();
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
    // 关掉的正好是手动指定的全局同步源：顺手清掉，别留一个指向已关窗口的引用
    if (syncGlobalSource.value === frame.scopeId) setGlobalSource("");
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
  // bridge 的 user-event 走 multi-game 通道（version 1）；兼容曾经误用 2 的中间版本 bridge
  if (
    payload?.channel === "multi-game" &&
    payload.type === "user-event" &&
    (payload.version === 1 || payload.version === 2) &&
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
      sendSyncConfigTo(result.scopeId);
    }
  }
}

function handleStorageChange(event) {
  if (event.key === MULTI_GAME_TOKEN_GROUPS_KEY) {
    loadTokenGroups();
    broadcastSyncConfig();
    return;
  }
  // 同步设置可能是另一个批量运行时标签页改的（同源共享 localStorage）
  if (event.key === MULTI_GAME_SYNC_MODE_KEY) {
    loadSyncSettings();
    broadcastSyncConfig();
  }
}

function goToTokens() {
  router.push("/tokens");
}

onBeforeMount(() => {
  window.addEventListener("message", handleMessage);
  window.addEventListener("storage", handleStorageChange);
});
onMounted(() => {
  frames.value.forEach((frame) => armFrameTimeout(frame.scopeId));
  statusPollTimer = window.setInterval(() => {
    if (!controlBusy.value) refreshAutomationStatus();
  }, 5000);
});
onUnmounted(() => {
  window.removeEventListener("message", handleMessage);
  window.removeEventListener("storage", handleStorageChange);
  stopStripScrollAnimation();
  releaseStripScrollLock();
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
  display: flex;
  flex-direction: column;
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

/* ===== 同步栏：模式 / 分组顺序 / 组长 ===== */
.sync-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  padding: 6px 12px;
  border-bottom: 1px solid #1f2937;
  background: #0d1420;
}

.sync-mode-row,
.sync-group-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
}

.sync-label {
  color: #cbd5e1;
  font-size: 12px;
  font-weight: 600;
}

.sync-mode-options {
  display: inline-flex;
  padding: 2px;
  border: 1px solid #334155;
  border-radius: 7px;
  background: #111827;
}

.sync-mode-button {
  min-height: 22px;
  padding: 2px 10px;
  border: 0;
  border-radius: 5px;
  color: #cbd5e1;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
}

.sync-mode-button:hover {
  color: #f8fafc;
  background: #1e293b;
}

.sync-mode-button.is-active {
  color: #eff6ff;
  background: #1d4ed8;
}

.sync-summary {
  font-size: 12px;
}

.sync-summary.is-on {
  color: #4ade80;
}

.sync-summary.is-off {
  color: #64748b;
}

/* 有手动指定的全局同步源时，给个一键回到默认（第一个分组的组长）的入口 */
.sync-source-clear {
  flex: none;
  min-height: 22px;
  padding: 2px 8px;
  border: 1px solid #334155;
  border-radius: 5px;
  color: #cbd5e1;
  background: #111827;
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
}

.sync-source-clear:hover {
  border-color: #64748b;
  color: #f8fafc;
}

.sync-group-chips {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.sync-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 2px 6px 2px 2px;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #cbd5e1;
  background: #172033;
  font-size: 11px;
}

.sync-chip.is-global-source {
  border-color: #2563eb;
  background: #1d4ed826;
}

.sync-chip.is-inactive {
  color: #94a3b8;
  opacity: 0.75;
}

.sync-chip.is-dragging {
  opacity: 0.45;
}

.sync-chip.is-drop-target {
  border-color: #60a5fa;
  box-shadow: inset 0 0 0 1px #60a5fa;
}

.sync-chip-handle {
  padding: 0 3px;
  color: #64748b;
  cursor: grab;
  font-size: 12px;
  line-height: 1;
  user-select: none;
}

.sync-chip-handle:active {
  cursor: grabbing;
}

.sync-chip-index {
  min-width: 13px;
  color: #93c5fd;
  font-weight: 700;
  text-align: center;
}

.sync-chip-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.sync-chip-name {
  max-width: 110px;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-chip-count {
  color: #94a3b8;
  font-size: 10px;
}

.sync-chip-flag {
  padding: 0 4px;
  border-radius: 4px;
  color: #dbeafe;
  background: #1d4ed8;
  font-size: 10px;
}

.sync-chip-master {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.sync-chip-master-label {
  color: #94a3b8;
  font-size: 10px;
}

.sync-chip-select {
  max-width: 120px;
  padding: 1px 3px;
  border: 1px solid #475569;
  border-radius: 4px;
  color: #e2e8f0;
  background: #1e293b;
  font-size: 11px;
}

.sync-chip-move {
  display: inline-flex;
  gap: 2px;
}

.sync-chip-move-button {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid #475569;
  border-radius: 4px;
  color: #cbd5e1;
  background: #1e293b;
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
}

.sync-chip-move-button:hover:not(:disabled) {
  background: #334155;
}

.sync-chip-move-button:disabled {
  color: #475569;
  cursor: not-allowed;
}

.sync-hint {
  flex: 1 1 240px;
  min-width: 0;
  color: #94a3b8;
  font-size: 11px;
}


.platform-spoof-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  padding: 4px 10px;
  border: 1px solid #3b4a63;
  border-radius: 8px;
  background: #0f1622;
}

.platform-spoof-label {
  color: #cbd5e1;
  font-size: 12px;
  font-weight: 600;
}

.platform-spoof-button,
.platform-spoof-reload {
  padding: 4px 8px;
  border: 1px solid #475569;
  border-radius: 5px;
  color: #cbd5e1;
  background: #1e293b;
  cursor: pointer;
  font-size: 12px;
}

.platform-spoof-button:hover,
.platform-spoof-reload:hover:not(:disabled) {
  background: #334155;
}

.platform-spoof-button.is-enabled {
  border-color: #16a34a;
  color: #bbf7d0;
  background: #14532d;
}

.platform-spoof-select {
  min-width: 104px;
  padding: 3px 5px;
  border: 1px solid #475569;
  border-radius: 5px;
  color: #e2e8f0;
  background: #1e293b;
  font-size: 12px;
}

.platform-spoof-select:disabled,
.platform-spoof-reload:disabled {
  color: #64748b;
  background: #111827;
  cursor: not-allowed;
  opacity: 0.65;
}

.platform-spoof-hint {
  color: #94a3b8;
  font-size: 11px;
}

.frame-group-tags {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}

.frame-group-tag {
  max-width: 110px;
  padding: 2px 5px;
  border: 1px solid;
  border-radius: 4px;
  overflow: hidden;
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.frame-group-tag.is-master {
  font-weight: 700;
  box-shadow: inset 0 0 0 1px currentColor;
}

.frame-sync-flag {
  flex: none;
  padding: 1px 5px;
  border: 1px solid;
  border-radius: 4px;
  font-size: 10px;
  white-space: nowrap;
}

.frame-sync-flag.is-source {
  border-color: #16a34a;
  color: #bbf7d0;
  background: #14532d;
}

.frame-sync-flag.is-target {
  border-color: #1d4ed8;
  color: #bfdbfe;
  background: #1e3a8a55;
}

.frame-sync-flag.is-both {
  border-color: #a855f7;
  color: #e9d5ff;
  background: #4c1d9555;
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
  flex: 1 1 auto;
  gap: 12px;
  min-height: 0;
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

/* 同步源窗口：只有这个窗口的输入会转发给其他窗口 */
.game-panel.is-sync-source {
  border-color: #16a34a;
  box-shadow:
    inset 0 0 0 1px #16a34a,
    0 10px 28px rgb(0 0 0 / 35%);
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

/* 全局同步模式下标题变成按钮：点一下就是同步源（虚线提示可点） */
.account-name-pick {
  padding: 0;
  border: 0;
  background: transparent;
  color: #cbd5e1;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
  text-align: left;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

.account-name-pick:hover,
.account-name-pick:focus-visible {
  color: #f8fafc;
}

.account-name-pick.is-global-source {
  color: #4ade80;
  font-weight: 700;
  text-decoration: underline;
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
  flex: 1 1 auto;
  min-height: 0;
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
    padding: 8px;
  }

  .game-panel {
    max-width: none;
  }

  .sync-bar {
    padding: 6px 8px;
  }

  .sync-hint {
    flex-basis: 100%;
  }
}
</style>