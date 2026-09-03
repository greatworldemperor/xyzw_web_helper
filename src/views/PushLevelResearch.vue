<template>
  <div class="research-page">
    <header class="page-header">
      <div>
        <h2>主线推关 · 重方案研究</h2>
        <p>官方运行时观测台。只登录和监听，不主动发送战斗请求。</p>
      </div>
      <div class="header-actions">
        <n-tag :type="runtimeTagType" size="small">{{ runtimeStatus }}</n-tag>
        <n-button size="small" secondary :disabled="busy" @click="reloadRuntime">
          <template #icon><n-icon><Refresh /></n-icon></template>
          重载运行时
        </n-button>
        <n-button size="small" type="primary" :disabled="!logs.length" @click="downloadLog">
          <template #icon><n-icon><Download /></n-icon></template>
          下载日志
        </n-button>
      </div>
    </header>

    <n-alert type="warning" :show-icon="true">
      被动模式不会调用 startLevel、无头模拟或 fight_endlevel。请先使用可测试账号；日志会自动脱敏常见凭据字段，但下载后仍请检查再回传。
    </n-alert>

    <n-card class="control-card" :content-style="{ padding: '14px 16px' }">
      <div class="control-grid">
        <div class="field account-field">
          <span class="field-label">研究账号</span>
          <n-select
            v-model:value="selectedResearchTokenId"
            :options="tokenOptions"
            filterable
            clearable
            size="small"
            placeholder="选择已有账号"
          />
        </div>
        <div class="field upload-field">
          <span class="field-label">临时 BIN</span>
          <input
            ref="binFileInput"
            class="hidden-file-input"
            type="file"
            accept=".bin,application/octet-stream"
            @change="handleBinUpload"
          />
          <n-button size="small" secondary @click="openBinPicker">
            <template #icon><n-icon><CloudUpload /></n-icon></template>
            导入到内存
          </n-button>
          <span class="field-hint">{{ uploadedBinName || "未导入" }}</span>
        </div>
        <div class="field switch-field">
          <span class="field-label">原始帧</span>
          <n-switch v-model:value="captureRawFrames" :disabled="!runtimeReady" @update:value="setRawCapture" />
          <span class="field-hint">记录完整二进制十六进制</span>
        </div>
        <div class="field switch-field">
          <span class="field-label">哈希原文</span>
          <n-switch v-model:value="captureHashPreimages" :disabled="!runtimeReady" @update:value="setHashCapture" />
          <span class="field-hint">记录 MD5 输入字符串</span>
        </div>
        <div class="field switch-field">
          <span class="field-label">自动滚动</span>
          <n-switch v-model:value="autoScroll" />
        </div>
      </div>
      <div class="button-row">
        <n-button size="small" :loading="busyAction === 'probe'" :disabled="!runtimeReady || busy" @click="probeRuntime">
          <template #icon><n-icon><Search /></n-icon></template>
          探测模块
        </n-button>
        <n-button size="small" :loading="busyAction === 'account'" :disabled="!runtimeReady || (!selectedResearchTokenId && !uploadedBin) || busy" @click="loadSelectedAccount">
          <template #icon><n-icon><PersonAdd /></n-icon></template>
          注入 BIN
        </n-button>
        <n-tag type="warning" size="small">主动战斗命令已锁定</n-tag>
        <n-button size="small" quaternary :disabled="!logs.length || busy" @click="clearLogs">
          清空日志
        </n-button>
      </div>
    </n-card>

    <div class="summary-grid">
      <n-card size="small" title="运行时">
        <div class="summary-list">
          <div><span>iframe</span><strong>{{ runtimeStatus }}</strong></div>
          <div><span>桥版本</span><strong>{{ bridgeVersion || "--" }}</strong></div>
          <div><span>账号</span><strong>{{ accountLabel }}</strong></div>
          <div><span>BIN</span><strong>{{ selectedBinStatus }}</strong></div>
        </div>
      </n-card>
      <n-card size="small" title="观测计数">
        <div class="summary-list">
          <div><span>事件</span><strong>{{ logs.length }}</strong></div>
          <div><span>WS 帧</span><strong>{{ wsFrameCount }}</strong></div>
          <div><span>战斗事件</span><strong>{{ battleEventCount }}</strong></div>
          <div><span>哈希配对</span><strong>{{ hashMatchCount }}</strong></div>
          <div><span>异常</span><strong :class="{ danger: errorCount > 0 }">{{ errorCount }}</strong></div>
        </div>
      </n-card>
      <n-card size="small" title="最近战斗数据">
        <div v-if="battleShape" class="battle-summary">
          <div><span>来源/状态</span><strong>{{ battleShape.source || "--" }} {{ battleShape.result || "" }}</strong></div>
          <div><span>关卡</span><strong>{{ battleShape.levelId ?? battleShape.options?.levelId ?? "--" }}</strong></div>
          <div><span>随机种子</span><strong>{{ battleShape.randomSeed ?? "--" }}</strong></div>
          <div><span>版本</span><strong>{{ battleShape.version ?? "--" }} / {{ battleShape.battleVersion ?? "--" }}</strong></div>
          <div><span>战斗时间</span><strong>{{ battleShape.battleTime ?? "--" }} / {{ battleShape.battleTick ?? "--" }} tick</strong></div>
          <div><span>点击次数</span><strong>{{ battleShape.touchTimes ?? battleShape.attackTimes ?? "--" }}</strong></div>
          <div class="wide-summary"><span>inputCode</span><strong :title="battleShape.inputCode">{{ battleShape.inputCode || "--" }}</strong></div>
          <div class="wide-summary"><span>outputCode</span><strong :title="battleShape.outputCode">{{ battleShape.outputCode || "--" }}</strong></div>
          <div><span>敌方格位</span><strong>{{ battleShape.rightTeamKeys?.join(", ") || "--" }}</strong></div>
        </div>
        <n-empty v-else description="尚未获取 battleData" size="small" />
      </n-card>
    </div>

    <n-card class="runtime-card" size="small">
      <template #header>
        <div class="runtime-card-header">
          <span>游戏运行时</span>
          <span class="runtime-note">请在这里手动操作官方游戏，研究桥只记录实际流量</span>
        </div>
      </template>
      <iframe
        ref="gameFrame"
        :src="gameSrc"
        class="game-frame"
        title="XYZW 官方游戏运行时"
        allow="fullscreen; autoplay"
        @load="handleFrameLoad"
      />
    </n-card>

    <n-card class="runtime-card" size="small">
      <template #header>
        <div class="runtime-card-header">
          <span>官方无头引擎测试</span>
          <span class="runtime-note">headless-test iframe：隔离、单场、只生成官方结果，不发送 fight_endlevel</span>
        </div>
      </template>
      <div class="headless-toolbar">
        <n-button
          size="small"
          :disabled="headlessBusy"
          @click="openHeadlessRuntime"
        >
          <template #icon><n-icon><Play /></n-icon></template>
          {{ headlessReady ? "重载无头运行时" : "打开无头运行时" }}
        </n-button>
        <n-button
          size="small"
          :disabled="!headlessReady || headlessBusy"
          @click="readHeadlessCapabilities"
        >
          <template #icon><n-icon><Search /></n-icon></template>
          无头能力
        </n-button>
        <n-button
          size="small"
          :disabled="!headlessReady || headlessBusy"
          @click="runHeadlessDiagnose"
        >
          <template #icon><n-icon><Search /></n-icon></template>
          无头初始化诊断
        </n-button>
        <n-button
          size="small"
          :disabled="!headlessReady || headlessBusy"
          @click="loadAccountIntoHeadless"
        >
          <template #icon><n-icon><PersonAdd /></n-icon></template>
          注入 BIN
        </n-button>
        <n-button
          size="small"
          type="primary"
          :disabled="!headlessReady || headlessBusy"
          @click="runHeadlessGenerate"
        >
          <template #icon><n-icon><Play /></n-icon></template>
          生成官方无头结果
        </n-button>
        <n-button
          size="small"
          danger
          :disabled="!headlessReady || headlessBusy"
          @click="runSubmitBypass"
        >
          <template #icon><n-icon><Warning /></n-icon></template>
          失败→成功拦截提交
        </n-button>
        <n-tag
          v-if="headlessCapabilities"
          :type="headlessCapabilities.readyForHeadless ? 'success' : 'warning'"
          size="small"
        >
          readyForHeadless={{ headlessCapabilities.readyForHeadless }}
        </n-tag>
      </div>
      <div class="headless-tweak-row">
        <n-select
          v-model:value="tweakMode"
          :options="tweakOptions"
          size="small"
          style="width: 240px"
          placeholder="微调字段"
        />
        <n-input-number
          v-model:value="tweakAmount"
          size="small"
          :min="0"
          style="width: 130px"
          placeholder="幅度"
        />
        <n-button
          size="small"
          danger
          :disabled="!headlessReady || headlessBusy"
          @click="runTweakSubmit"
        >
          微调提交（容差探测）
        </n-button>
        <span class="field-hint">以官方真实结果为基底，单点微调后重算哈希提交，探测服务器验算严格度</span>
      </div>
      <iframe
        v-if="headlessEnabled"
        ref="headlessFrame"
        :src="headlessSrc"
        class="game-frame headless-frame"
        title="XYZW 官方无头引擎测试"
        allow="fullscreen; autoplay"
        @load="handleHeadlessFrameLoad"
      />
    </n-card>

    <n-card class="log-card" size="small">
      <template #header>
        <div class="log-header">
          <div class="log-title">研究日志 <n-tag size="small">{{ logs.length }}</n-tag></div>
          <n-input v-model:value="logKeyword" size="small" clearable placeholder="筛选事件或内容" class="log-search" />
        </div>
      </template>
      <div ref="logContainer" class="log-container">
        <div v-for="entry in visibleLogs" :key="entry.id" class="log-entry" :class="entryClass(entry)">
          <div class="log-entry-head">
            <span class="log-time">{{ entry.at }}</span>
            <strong>{{ entry.event }}</strong>
            <span v-if="entry.source" class="log-source">{{ entry.source }}</span>
          </div>
          <pre>{{ formatPayload(entry.payload) }}</pre>
        </div>
        <n-empty v-if="!visibleLogs.length" description="暂无研究日志" size="small" />
      </div>
    </n-card>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useMessage } from "naive-ui";
import {
  CloudUpload,
  Download,
  PersonAdd,
  Play,
  Refresh,
  Search,
  Warning,
} from "@vicons/ionicons5";
import { useTokenStore } from "@/stores/tokenStore";
import useIndexedDB from "@/hooks/useIndexedDB";
import { PushLevelResearchBridge } from "@/utils/pushLevelResearchBridge.js";

const MAX_PARENT_LOGS = 10000;
const tokenStore = useTokenStore();
const message = useMessage();
const { getArrayBuffer, isReady } = useIndexedDB();

const gameFrame = ref(null);
const binFileInput = ref(null);
const logContainer = ref(null);
const runtimeReady = ref(false);
const runtimeStatus = ref("未加载");
const bridgeVersion = ref("");
const selectedResearchTokenId = ref(tokenStore.selectedToken?.id || tokenStore.gameTokens?.[0]?.id || null);
const captureRawFrames = ref(false);
const captureHashPreimages = ref(false);
const autoScroll = ref(true);
const logKeyword = ref("");
const logs = ref([]);
const battleShape = ref(null);
const busyAction = ref("");
const binAvailable = ref(null);
const uploadedBin = ref(null);
const uploadedBinName = ref("");
const headlessFrame = ref(null);
const headlessSrc = ref(`${import.meta.env.BASE_URL}game/index.html?headless-test=1`);
const headlessReady = ref(false);
const headlessEnabled = ref(false);
const headlessBusyAction = ref("");
const headlessCapabilities = ref(null);
const tweakMode = ref("sponsor-hp-minus");
const tweakAmount = ref(10000);
const tweakOptions = [
  { label: "我方主力 HP -", value: "sponsor-hp-minus" },
  { label: "我方主力 HP +", value: "sponsor-hp-plus" },
  { label: "敌方首名 HP +（未灭透）", value: "accept-hp-plus" },
  { label: "敌方首名 HP -", value: "accept-hp-minus" },
  { label: "我方主力怒气 =", value: "sponsor-rage-set" },
  { label: "我方主力伤害 +", value: "sponsor-damage-plus" },
  { label: "battleTime +", value: "battle-time-plus" },
];
let logSequence = 0;

const bridge = new PushLevelResearchBridge((event, payload) => {
  appendLog({
    source: "iframe",
    event,
    at: payload?.at || new Date().toISOString(),
    payload: payload?.payload ?? payload,
  });
  if (event === "bridge:ready") {
    bridgeVersion.value = payload?.payload?.bridgeVersion || "";
  }
  if (event === "battle:start:response") {
    battleShape.value = payload?.payload?.battleShape || null;
  }
  if (event === "battle:tga:start" || event === "battle:tga:result" || event === "battle:protocol:start" || event === "battle:protocol:end") {
    updateBattleSummary(event, payload?.payload || {});
  }
});

const headlessBridge = new PushLevelResearchBridge((event, payload) => {
  appendLog({
    source: "headless",
    event,
    at: payload?.at || new Date().toISOString(),
    payload: payload?.payload ?? payload,
  });
});

const gameSrc = `${import.meta.env.BASE_URL}game/index.html?research=push-level`;

const tokenOptions = computed(() => {
  return (tokenStore.gameTokens || []).map((token) => ({
    label: `${token.server || "未知区服"} - ${token.name || token.id}`,
    value: token.id,
  }));
});

const selectedToken = computed(() => {
  return (tokenStore.gameTokens || []).find((token) => token.id === selectedResearchTokenId.value) || null;
});

const accountLabel = computed(() => selectedToken.value?.name || selectedResearchTokenId.value || "未选择");
const selectedBinStatus = computed(() => {
  if (uploadedBin.value) return "临时 BIN 可用";
  if (binAvailable.value === true) return "可读取";
  if (binAvailable.value === false) return "无 BIN";
  return "未检查";
});

const runtimeTagType = computed(() => {
  if (runtimeReady.value) return "success";
  if (runtimeStatus.value === "异常") return "error";
  return "warning";
});

const busy = computed(() => Boolean(busyAction.value));
const headlessBusy = computed(() => Boolean(headlessBusyAction.value));

const wsFrameCount = computed(() => logs.value.filter((entry) => entry.event === "ws:send" || entry.event === "ws:message").length);
const battleEventCount = computed(() => logs.value.filter((entry) => entry.event === "battle:tga:start" || entry.event === "battle:tga:result" || entry.event === "battle:protocol:start" || entry.event === "battle:protocol:end").length);
const hashMatchCount = computed(() => logs.value.filter((entry) => entry.event === "hash:matched" || entry.event === "hash:stringify-matched").length);
const errorCount = computed(() => logs.value.filter((entry) => /error|reject|throw/i.test(entry.event)).length);

const visibleLogs = computed(() => {
  const keyword = logKeyword.value.trim().toLowerCase();
  const source = keyword
    ? logs.value.filter((entry) => `${entry.event} ${formatPayload(entry.payload)}`.toLowerCase().includes(keyword))
    : logs.value;
  return source.slice(-500);
});

function appendLog(entry) {
  const next = {
    id: ++logSequence,
    source: entry.source || "page",
    event: entry.event || "unknown",
    at: entry.at || new Date().toISOString(),
    payload: entry.payload ?? null,
  };
  logs.value.push(next);
  if (logs.value.length > MAX_PARENT_LOGS) logs.value.splice(0, logs.value.length - MAX_PARENT_LOGS);
  if (autoScroll.value) {
    nextTick(() => {
      logContainer.value?.scrollTo({ top: logContainer.value.scrollHeight });
    });
  }
}

function formatPayload(payload) {
  if (payload === undefined) return "";
  try {
    return JSON.stringify(payload, null, 2);
  } catch (error) {
    return String(payload);
  }
}

function entryClass(entry) {
  if (/error|reject|throw/i.test(entry.event)) return "is-error";
  if (/battle/i.test(entry.event)) return "is-battle";
  if (/ws:/i.test(entry.event)) return "is-network";
  return "";
}

function updateBattleSummary(event, observation) {
  const current = event === "battle:tga:start" || event === "battle:protocol:start"
    ? {}
    : battleShape.value || {};
  const next = { ...current, source: event };
  const data = observation?.data || {};
  const protocolShape = observation?.battleShape;
  if (protocolShape) Object.assign(next, protocolShape);

  const level = data.levelId ?? data.level;
  if (level !== undefined && level !== null) {
    next.levelId = level;
    next.options = { ...(next.options || {}), levelId: level };
  }
  for (const key of ["randomSeed", "version", "battleVersion", "battleTime", "battleTick", "touchTimes", "attackTimes", "inputCode", "outputCode"]) {
    if (data[key] !== undefined && data[key] !== null) next[key] = data[key];
  }
  if (data.isWin !== undefined) next.result = data.isWin ? "success" : "fail";
  if (data.success !== undefined) next.result = data.success ? "success" : "fail";
  if (data.beforeInputCode) next.beforeInputCode = data.beforeInputCode;

  const body = observation?.body;
  if (body && typeof body === "object") {
    for (const key of ["levelId", "battleTime", "tapTimes", "autoTapTimes", "outputCode", "log"]) {
      if (body[key] !== undefined && body[key] !== null) next[key] = body[key];
    }
  }
  battleShape.value = next;
}

async function handleFrameLoad() {
  if (!gameFrame.value) return;
  bridge.attach(gameFrame.value);
  runtimeReady.value = false;
  runtimeStatus.value = "连接中";
  appendLog({ event: "page:iframe:load", payload: { src: gameSrc } });
  try {
    const result = await bridge.request("runtime:ping", {}, 10000);
    runtimeReady.value = true;
    runtimeStatus.value = "已就绪";
    bridgeVersion.value = result?.bridgeVersion || bridgeVersion.value;
    await bridge.request("runtime:capture", { enabled: captureRawFrames.value }, 10000);
    await bridge.request("runtime:hash-capture", { enabled: captureHashPreimages.value }, 10000);
  } catch (error) {
    runtimeStatus.value = "异常";
    appendLog({ event: "page:runtime:error", payload: { error: error.message } });
  }
}

async function setRawCapture(enabled) {
  if (!runtimeReady.value) return;
  try {
    await bridge.request("runtime:capture", { enabled }, 10000);
  } catch (error) {
    appendLog({ event: "page:capture:error", payload: { error: error.message } });
    captureRawFrames.value = !enabled;
  }
}

async function setHashCapture(enabled) {
  if (!runtimeReady.value) return;
  try {
    await bridge.request("runtime:hash-capture", { enabled }, 10000);
  } catch (error) {
    appendLog({ event: "page:hash-capture:error", payload: { error: error.message } });
    captureHashPreimages.value = !enabled;
  }
}

async function runAction(name, command, payload, timeout = 30000, transfer = []) {
  if (!runtimeReady.value) {
    message.warning("研究 iframe 尚未就绪");
    return null;
  }
  busyAction.value = name;
  appendLog({ event: `page:${command}:call`, payload: { command, payload: summarizeForPage(payload) } });
  try {
    const result = await bridge.request(command, payload, timeout, transfer);
    appendLog({ event: `page:${command}:return`, payload: result });
    return result;
  } catch (error) {
    appendLog({ event: `page:${command}:error`, payload: { error: error.message, stack: error.stack } });
    message.error(error.message);
    return null;
  } finally {
    busyAction.value = "";
  }
}

function summarizeForPage(value) {
  if (!value || typeof value !== "object") return value;
  const result = { ...value };
  if (result.bin instanceof ArrayBuffer) {
    result.bin = { kind: "arraybuffer", byteLength: result.bin.byteLength };
  }
  return result;
}

async function readSelectedBin(tokenId) {
  const startedAt = Date.now();
  while (!isReady.value && Date.now() - startedAt < 5000) {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  return getArrayBuffer(tokenId);
}

function openBinPicker() {
  binFileInput.value?.click();
}

async function handleBinUpload(event) {
  const file = event.target?.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    uploadedBin.value = await file.arrayBuffer();
    uploadedBinName.value = file.name;
    binAvailable.value = true;
    appendLog({
      event: "page:account:bin-loaded",
      payload: { name: file.name, byteLength: file.size, storage: "memory-only" },
    });
    message.success("BIN 已载入当前页面内存");
  } catch (error) {
    uploadedBin.value = null;
    uploadedBinName.value = "";
    binAvailable.value = false;
    appendLog({ event: "page:account:bin-error", payload: { error: error.message } });
    message.error(`读取 BIN 失败：${error.message}`);
  }
}

async function probeRuntime() {
  await runAction("probe", "runtime:probe", {}, 30000);
}

async function loadAccountWithBridge(commandBridge, busyKey, logSource) {
  const token = selectedToken.value;
  const tokenId = token?.id || `uploaded:${uploadedBinName.value || "bin"}`;
  const bin = uploadedBin.value
    ? uploadedBin.value.slice(0)
    : token
      ? await readSelectedBin(token.id)
      : null;
  binAvailable.value = Boolean(bin);
  if (!bin) {
    message.warning("请选择已有账号或先导入 BIN");
    appendLog({ event: `page:${logSource}:account:no-bin`, payload: { tokenId } });
    return;
  }
  await runBridgeAction(
    commandBridge,
    busyKey,
    `${logSource}:account`,
    "account:load",
    { tokenId, bin },
    45000,
    [bin],
    `page:${logSource}:account`,
  );
}

async function loadSelectedAccount() {
  await loadAccountWithBridge(bridge, busyAction, "research");
}

async function loadAccountIntoHeadless() {
  await loadAccountWithBridge(headlessBridge, headlessBusyAction, "headless");
}

function openHeadlessRuntime() {
  if (!headlessBridge) return;
  headlessEnabled.value = true;
  headlessReady.value = false;
  headlessCapabilities.value = null;
  const token = selectedToken.value;
  const binId = token?.id ? `&bin_id=${encodeURIComponent(token.id)}` : "";
  headlessSrc.value = `${import.meta.env.BASE_URL}game/index.html?headless-test=1${binId}&reload=${Date.now()}`;
  appendLog({ event: "page:headless:open", payload: { src: headlessSrc.value } });
}

async function handleHeadlessFrameLoad() {
  if (!headlessFrame.value) return;
  headlessBridge.attach(headlessFrame.value);
  headlessReady.value = false;
  appendLog({ event: "page:headless:iframe:load", payload: { src: headlessSrc.value } });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await headlessBridge.request("runtime:ping", {}, 10000);
      headlessReady.value = true;
      await readHeadlessCapabilities();
      return;
    } catch (error) {
      if (attempt === 4) {
        appendLog({ event: "page:headless:error", payload: { error: error.message } });
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 6000));
    }
  }
}

async function readHeadlessCapabilities() {
  const result = await runBridgeAction(
    headlessBridge,
    headlessBusyAction,
    "headless:capabilities",
    "runtime:capabilities",
    {},
    20000,
    [],
    "page:headless",
  );
  if (result) headlessCapabilities.value = result;
  return result;
}

async function runHeadlessDiagnose() {
  return runBridgeAction(
    headlessBridge,
    headlessBusyAction,
    "headless:diagnose",
    "headless:diagnose",
    {},
    20000,
    [],
    "page:headless",
  );
}

async function runHeadlessGenerate() {
  const result = await runBridgeAction(
    headlessBridge,
    headlessBusyAction,
    "headless:generate",
    "headless:generate",
    { testOnly: true, isWin: true, autoAttack: true, autoAttackInterval: 40, timeScale: 0 },
    90000,
    [],
    "page:headless",
  );
  if (result) {
    message.success(`无头结果已生成：第 ${result.levelId} 关`);
  }
  return result;
}

async function runSubmitBypass() {
  const confirmed = window.confirm(
    "将真实提交一场 fight_endlevel：官方无头引擎真实战斗（预期失败），发送前把结果改为成功形态（我方存活/怒气满、敌方全灭）并重算 outputCode 再提交，以验证服务器的结果一致性校验。该动作会改变当前账号的关卡进度，且每个 iframe 只允许执行一次。是否继续？",
  );
  if (!confirmed) return;
  const result = await runBridgeAction(
    headlessBridge,
    headlessBusyAction,
    "headless:submit-bypass",
    "headless:submit-bypass",
    { confirmSubmit: true, successify: true, isWin: true, autoAttack: true, autoAttackInterval: 40, timeScale: 0, autoTapTimes: [[0, 40, 500]] },
    120000,
    [],
    "page:headless",
  );
  if (result) {
    const roleLevelId =
      result.endResponse?.body?.role?.levelId ??
      result.endResponse?.role?.levelId ??
      result.roleAfter?.levelId ??
      "--";
    message.info(
      `拦截实验完成：实际${result.actualIsWin ? "胜" : "负"}→提交为胜，响应 role.levelId=${roleLevelId}`,
    );
  }
  return result;
}

async function runTweakSubmit() {
  const confirmed = window.confirm(
    `将以官方真实结果为基底，把 "${tweakMode.value}" 按幅度 ${tweakAmount.value} 微调并重算哈希后提交 fight_endlevel。会改变当前账号关卡进度，每个 iframe 只允许执行一次。是否继续？`,
  );
  if (!confirmed) return;
  const result = await runBridgeAction(
    headlessBridge,
    headlessBusyAction,
    "headless:submit-bypass",
    "headless:submit-bypass",
    {
      confirmSubmit: true,
      tweak: { mode: tweakMode.value, amount: Number(tweakAmount.value) },
      autoAttack: true,
      autoAttackInterval: 40,
      timeScale: 0,
      autoTapTimes: [[0, 40, 500]],
    },
    120000,
    [],
    "page:headless",
  );
  if (result) {
    const roleLevelId =
      result.endResponse?.body?.role?.levelId ??
      result.endResponse?.role?.levelId ??
      result.roleAfter?.levelId ??
      "--";
    message.info(`微调实验完成：提交前 ${result.levelId}，响应 role.levelId=${roleLevelId}`);
  }
  return result;
}

async function runBridgeAction(commandBridge, busyKey, name, command, payload = {}, timeout = 30000, transfer = [], logSource = "page") {
  if (!commandBridge || !commandBridge.isReady()) {
    message.warning("目标 iframe 尚未就绪");
    return null;
  }
  busyKey.value = name;
  appendLog({
    event: `${logSource}:${command}:call`,
    payload: { command, payload: summarizeForPage(payload) },
  });
  try {
    const result = await commandBridge.request(command, payload, timeout, transfer);
    appendLog({ event: `${logSource}:${command}:return`, payload: result });
    return result;
  } catch (error) {
    appendLog({
      event: `${logSource}:${command}:error`,
      payload: { error: error.message, stack: error.stack },
    });
    message.error(error.message);
    return null;
  } finally {
    busyKey.value = "";
  }
}

async function reloadRuntime() {
  runtimeReady.value = false;
  runtimeStatus.value = "重载中";
  appendLog({ event: "page:runtime:reload", payload: {} });
  if (gameFrame.value) gameFrame.value.src = `${gameSrc}&reload=${Date.now()}`;
}

function clearLogs() {
  logs.value = [];
  battleShape.value = null;
  appendLog({ event: "page:logs:cleared", payload: {} });
}

function downloadLog() {
  const header = {
    format: "xyzw-push-level-research-jsonl",
    version: 1,
    downloadedAt: new Date().toISOString(),
    page: window.location.href.split("?")[0],
    gameSrc,
    bridgeVersion: bridgeVersion.value,
    mode: "passive-capture",
    selectedToken: selectedToken.value
      ? { id: selectedToken.value.id, name: selectedToken.value.name, server: selectedToken.value.server }
      : null,
    battleShape: battleShape.value,
    captureRawFrames: captureRawFrames.value,
    captureHashPreimages: captureHashPreimages.value,
    captureStats: {
      wsFrames: wsFrameCount.value,
      battleEvents: battleEventCount.value,
      hashMatches: hashMatchCount.value,
      errors: errorCount.value,
    },
    eventCount: logs.value.length,
  };
  const content = [header, ...logs.value].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const blob = new Blob([content], { type: "application/x-ndjson;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `push-level-research-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  link.click();
  URL.revokeObjectURL(url);
  appendLog({ event: "page:logs:downloaded", payload: { eventCount: logs.value.length } });
  message.success("研究日志已下载");
}

watch(selectedResearchTokenId, async () => {
  if (uploadedBin.value) {
    binAvailable.value = true;
    return;
  }
  binAvailable.value = null;
  const token = selectedToken.value;
  if (!token) return;
  const bin = await readSelectedBin(token.id);
  binAvailable.value = Boolean(bin);
});

onMounted(async () => {
  appendLog({ event: "page:ready", payload: { gameSrc } });
  if (gameFrame.value) bridge.attach(gameFrame.value);
  const token = selectedToken.value;
  if (token) binAvailable.value = Boolean(await readSelectedBin(token.id));
});

onBeforeUnmount(() => {
  bridge.dispose();
  headlessBridge.dispose();
});
</script>

<style scoped>
.research-page {
  min-height: 100%;
  padding: 16px;
  background: #f5f7fa;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.page-header,
.header-actions,
.button-row,
.control-grid,
.runtime-card-header,
.log-header,
.log-entry-head {
  display: flex;
  align-items: center;
}

.page-header,
.runtime-card-header,
.log-header {
  justify-content: space-between;
  gap: 12px;
}

.page-header h2 {
  margin: 0;
  color: #17212b;
  font-size: 22px;
}

.page-header p {
  margin: 4px 0 0;
  color: #667085;
  font-size: 13px;
}

.header-actions,
.button-row {
  gap: 8px;
  flex-wrap: wrap;
}

.control-grid {
  gap: 18px;
  flex-wrap: wrap;
}

.field {
  min-width: 180px;
}

.account-field {
  width: min(360px, 100%);
}

.switch-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.field-label {
  display: block;
  margin-bottom: 6px;
  color: #344054;
  font-size: 12px;
  font-weight: 600;
}

.switch-field .field-label {
  margin-bottom: 0;
}

.field-hint,
.runtime-note {
  color: #98a2b3;
  font-size: 12px;
}

.button-row {
  margin-top: 14px;
}

.headless-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.headless-frame {
  margin-top: 10px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.summary-list,
.battle-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;
}

.summary-list div,
.battle-summary div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.summary-list span,
.battle-summary span {
  color: #98a2b3;
  font-size: 11px;
}

.summary-list strong,
.battle-summary strong {
  overflow: hidden;
  color: #344054;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.danger {
  color: #d92d20 !important;
}

.runtime-card :deep(.n-card__content) {
  padding: 0;
}

.runtime-card-header {
  min-height: 22px;
}

.game-frame {
  display: block;
  width: 100%;
  height: 360px;
  margin-top: 10px;
  border: 1px solid #d0d5dd;
  background: #111827;
}

.log-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-search {
  width: min(320px, 48%);
}

.log-container {
  height: 360px;
  overflow: auto;
  padding: 2px;
  background: #111827;
  border-radius: 4px;
}

.log-entry {
  padding: 7px 9px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.15);
  color: #d1d5db;
  font-family: Consolas, "Courier New", monospace;
  font-size: 11px;
}

.log-entry.is-error {
  background: rgba(127, 29, 29, 0.35);
}

.log-entry.is-battle {
  background: rgba(20, 83, 45, 0.24);
}

.log-entry.is-network {
  background: rgba(30, 64, 175, 0.2);
}

.log-entry-head {
  gap: 8px;
  flex-wrap: wrap;
}

.log-entry-head strong {
  color: #f8fafc;
}

.log-time,
.log-source {
  color: #94a3b8;
}

.log-source {
  padding: 1px 4px;
  border: 1px solid #475569;
  border-radius: 3px;
}

.log-entry pre {
  max-width: 100%;
  margin: 5px 0 0;
  overflow: auto;
  color: #cbd5e1;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 900px) {
  .summary-grid {
    grid-template-columns: 1fr;
  }

  .page-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .game-frame {
    height: 280px;
  }
}

@media (max-width: 560px) {
  .research-page {
    padding: 10px;
  }

  .header-actions {
    width: 100%;
  }

  .header-actions .n-button {
    flex: 1;
  }

  .log-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .log-search {
    width: 100%;
  }
}
</style>