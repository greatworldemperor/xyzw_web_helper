<template>
  <div class="synthetic-page">
    <header class="page-header">
      <div>
        <p class="eyebrow">MAINLINE / SYNTHETIC RESULT</p>
        <h2>前台合成推关</h2>
        <p>读取当前关卡数据，生成 ClientBattleResult 和 fight_endlevel 预览。</p>
      </div>
      <n-tag :type="allowSubmit ? 'error' : 'success'" size="small">
        {{ allowSubmit ? "单场提交已解锁" : "仅生成预览" }}
      </n-tag>
    </header>

    <n-alert type="warning" :show-icon="true">
      默认不会发送 fight_endlevel。提交前请确认账号、关卡和 outputCode；服务器推进确认不通过时页面会停止，不会自动重试结算。
    </n-alert>

    <div class="workspace-grid">
      <n-card title="单场参数" size="small">
        <n-form label-placement="top" size="small">
          <n-form-item label="账号">
            <n-select
              v-model:value="selectedTokenId"
              :options="tokenOptions"
              filterable
              placeholder="选择账号"
              :disabled="schedulerActive || schedulerStopping || submitting"
            />
          </n-form-item>
          <div class="form-grid">
            <n-form-item label="battleTime（tick）">
              <n-input-number
                v-model:value="battleTime"
                :min="0"
                :max="1000000"
                :step="1"
                :disabled="schedulerActive || schedulerStopping || submitting"
                style="width: 100%"
              />
            </n-form-item>
            <n-form-item label="目标结果">
              <n-select
                v-model:value="targetResult"
                :options="targetResultOptions"
                :disabled="schedulerActive || schedulerStopping || submitting"
              />
            </n-form-item>
            <n-form-item label="结果模板">
              <n-input value="当前角色 + 当前预设阵容 + startLevel 敌方阵容" readonly />
            </n-form-item>
              <n-form-item label="基础间隔（毫秒）">
                <n-input-number
                  v-model:value="baseIntervalMs"
                  :min="0"
                  :max="3600000"
                  style="width: 100%"
                />
              </n-form-item>
              <n-form-item label="随机偏移（毫秒）">
                <n-input-number
                  v-model:value="jitterMs"
                  :min="0"
                  :max="600000"
                  style="width: 100%"
                />
              </n-form-item>
          </div>
          <n-form-item label="tapTimes（JSON）">
            <n-input
              v-model:value="tapTimesText"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 3 }"
              placeholder="例如 [[]]"
            />
          </n-form-item>
          <n-form-item label="autoTapTimes（JSON）">
            <n-input
              v-model:value="autoTapTimesText"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 3 }"
              placeholder="例如 [[]] 或 [[0,40,500]]"
            />
          </n-form-item>
          <div class="submit-gate">
            <div>
              <strong>允许单场提交</strong>
              <span>关闭时只生成本地 payload</span>
            </div>
            <n-switch v-model:value="allowSubmit" :disabled="schedulerActive || schedulerStopping || submitting" />
          </div>
        </n-form>

        <n-alert v-if="allowSubmit" type="error" size="small" :show-icon="true" class="gate-alert">
            当前页面具备真实结算能力。自动继续默认关闭；开启后会按间隔循环提交，并在服务器未确认下一关时停止。
        </n-alert>

          <div v-if="allowSubmit" class="submit-gate auto-gate">
            <div>
              <strong>自动继续</strong>
              <span>关闭时最多提交当前一场</span>
            </div>
          <n-switch v-model:value="autoContinue" :disabled="schedulerActive || schedulerStopping || submitting" />
          </div>

        <div class="action-row">
          <n-button type="primary" :loading="loading" :disabled="!selectedTokenId || schedulerActive || schedulerStopping || submitting" @click="generatePreview">
            生成预览
          </n-button>
          <n-button
            type="warning"
            :loading="submitting"
            :disabled="!allowSubmit || !preview || loading || submitting || schedulerActive || schedulerStopping"
            @click="submitOnce"
          >
            提交本场
          </n-button>
            <n-button
              type="error"
              :loading="schedulerStarting"
              :disabled="!allowSubmit || schedulerActive || schedulerStopping || loading || submitting"
              @click="startScheduler"
            >
              {{ autoContinue ? "启动自动推关" : "启动单场调度" }}
            </n-button>
            <n-button
              v-if="schedulerActive && schedulerState === 'paused'"
              type="success"
              :disabled="submitting"
              @click="resumeScheduler"
            >
              继续
            </n-button>
            <n-button
              v-else-if="schedulerActive"
              type="warning"
              :disabled="submitting"
              @click="pauseScheduler"
            >
              暂停
            </n-button>
          <n-button v-if="schedulerActive" type="error" secondary :loading="schedulerStopping" :disabled="schedulerStopping" @click="stopScheduler">
              停止
            </n-button>
          <n-button quaternary :disabled="loading || submitting || schedulerActive || schedulerStopping" @click="clearPreview">
            清除
          </n-button>
        </div>
      </n-card>

      <n-card title="运行状态" size="small">
        <div class="status-list">
          <div><span>连接</span><strong>{{ connectionStatus }}</strong></div>
          <div><span>账号</span><strong>{{ selectedToken?.name || "未选择" }}</strong></div>
          <div><span>预览关卡</span><strong>{{ preview?.levelId ?? "--" }}</strong></div>
          <div><span>随机种子</span><strong>{{ preview?.seed ?? "--" }}</strong></div>
          <div><span>目标结果</span><strong>{{ preview ? (preview.result?.isWin ? "胜利（强制过关）" : "失败") : "--" }}</strong></div>
          <div><span>我方成员</span><strong>{{ preview?.result?.sponsor?.teamInfo?.length ?? "--" }}</strong></div>
          <div><span>敌方成员</span><strong>{{ preview?.result?.accept?.teamInfo?.length ?? "--" }}</strong></div>
            <div><span>调度状态</span><strong>{{ schedulerState }}</strong></div>
            <div><span>本轮间隔</span><strong>{{ lastDelayMs ? `${lastDelayMs} ms` : "--" }}</strong></div>
          <div class="wide"><span>outputCode</span><code :title="preview?.outputCode">{{ preview?.outputCode || "--" }}</code></div>
          <div class="wide"><span>最近动作</span><strong>{{ lastAction || "等待操作" }}</strong></div>
        </div>
      </n-card>
    </div>

    <div v-if="preview" class="result-grid">
      <n-card title="生成结果" size="small">
        <div class="result-facts">
          <div><span>battleData.version</span><strong>{{ preview.battleData?.version ?? "--" }}</strong></div>
          <div><span>battleData.id</span><strong>{{ preview.battleData?.id ?? "--" }}</strong></div>
          <div><span>序列化长度</span><strong>{{ preview.serialized?.length ?? 0 }}</strong></div>
          <div><span>battleTime</span><strong>{{ preview.payload?.battleTime ?? "--" }} tick</strong></div>
          <div><span>isWin</span><strong>{{ preview.result?.isWin ? "true" : "false" }}</strong></div>
        </div>
        <div class="code-block">
          <span>ClientBattleResult</span>
          <pre>{{ formatJson(preview.result) }}</pre>
        </div>
      </n-card>

      <n-card title="待发送 payload" size="small">
        <pre class="payload-block">{{ formatJson(preview.payload) }}</pre>
      </n-card>
    </div>

    <n-card v-if="response || confirmation" title="最近响应" size="small">
      <div class="response-head">
        <n-tag :type="confirmation?.confirmed ? 'success' : 'warning'" size="small">
          {{ confirmation?.confirmed ? "已确认推进" : "已收到响应，未确认推进" }}
        </n-tag>
        <span v-if="confirmation">服务器下一关：{{ confirmation.responseLevelId }}</span>
      </div>
      <pre class="payload-block">{{ formatJson(response) }}</pre>
    </n-card>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useDialog, useMessage } from "naive-ui";
import { useTokenStore } from "@/stores/tokenStore";
import { buildPushLevelDryRun } from "@/utils/pushLevel/dryRun.js";
import { buildResultTemplates } from "@/utils/pushLevel/resultTemplate.js";
import { normalizeBattleConfig } from "@/utils/pushLevel/config.js";
import {
  createPushLevelTokenAdapter,
  createPushLevelScheduler,
  extractEndLevelResponseLevelId,
} from "@/utils/pushLevel/tokenAdapter.js";

const tokenStore = useTokenStore();
const message = useMessage();
const dialog = useDialog();

const selectedTokenId = ref(
  tokenStore.selectedToken?.id || tokenStore.gameTokens?.[0]?.id || null,
);
const battleTime = ref(447);
const targetResult = ref("win");
const baseIntervalMs = ref(30000);
const jitterMs = ref(5000);
const tapTimesText = ref("[[]]");
const autoTapTimesText = ref("[[]]");
const allowSubmit = ref(false);
const autoContinue = ref(false);
const loading = ref(false);
const submitting = ref(false);
const schedulerStarting = ref(false);
const schedulerActive = ref(false);
const schedulerStopping = ref(false);
const schedulerState = ref("idle");
const lastDelayMs = ref(0);
const preview = ref(null);
const response = ref(null);
const confirmation = ref(null);
const lastAction = ref("");
const previewTokenId = ref("");
let scheduler = null;

const targetResultOptions = [
  { label: "胜利（强制过关）", value: "win" },
  { label: "失败", value: "fail" },
];

const tokens = computed(() => tokenStore.gameTokens || []);
const selectedToken = computed(() =>
  tokens.value.find((token) => token.id === selectedTokenId.value) || null,
);
const tokenOptions = computed(() =>
  tokens.value.map((token) => ({
    label: `${token.server || "未知区服"} - ${token.name || token.id}`,
    value: token.id,
  })),
);
const connectionStatus = computed(() => {
  if (!selectedTokenId.value) return "未选择账号";
  return tokenStore.getWebSocketStatus(selectedTokenId.value) || "disconnected";
});

watch(selectedTokenId, (nextTokenId, previousTokenId) => {
  if (previousTokenId && nextTokenId !== previousTokenId && previewTokenId.value) {
    clearPreview();
    lastAction.value = "账号已切换，旧预览已清除";
  }
});

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function waitForConnection(tokenId, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (tokenStore.getWebSocketStatus(tokenId) === "connected") return true;
    await sleep(200);
  }
  return tokenStore.getWebSocketStatus(tokenId) === "connected";
}

async function ensureConnected(tokenId) {
  if (tokenStore.getWebSocketStatus(tokenId) === "connected") return;
  const token = tokens.value.find((item) => item.id === tokenId);
  if (!token) throw new Error("未找到所选账号");

  await tokenStore.createWebSocketConnection(
    tokenId,
    token.token,
    token.wsUrl,
    { monitorTimeout: false },
  );
  if (!(await waitForConnection(tokenId))) {
    throw new Error("WebSocket 连接超时");
  }
}

function parseJsonArray(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value || "[[]]");
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} 必须是数组`);
  return parsed;
}

function getBattleConfig() {
  return normalizeBattleConfig({
    battleTime: Number(battleTime.value),
    isWin: targetResult.value === "win",
  });
}

function formatJson(value) {
  if (value === undefined || value === null) return "--";
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

async function generatePreview() {
  if (!selectedTokenId.value) return;
  loading.value = true;
  response.value = null;
  confirmation.value = null;
  lastAction.value = "读取角色和阵容";

  try {
    const tokenId = selectedTokenId.value;
    await ensureConnected(tokenId);
    const [roleResponse, presetResponse] = await Promise.all([
      tokenStore.sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 15000),
      tokenStore.sendMessageWithPromise(tokenId, "presetteam_getinfo", {}, 15000),
    ]);
    lastAction.value = "读取当前关卡";
    const startResponse = await tokenStore.sendMessageWithPromise(
      tokenId,
      "fight_startlevel",
      {},
      15000,
    );
    const startBattleData = startResponse?.battleData || startResponse?.body?.battleData;
    const templates = buildResultTemplates({
      battleData: startBattleData,
      roleResponse,
      presetResponse,
    });
    const battleConfig = getBattleConfig();

    preview.value = buildPushLevelDryRun({
      startResponse,
      sponsor: templates.sponsor,
      accept: templates.accept,
      ...battleConfig,
      tapTimes: parseJsonArray(tapTimesText.value, "tapTimes"),
      autoTapTimes: parseJsonArray(autoTapTimesText.value, "autoTapTimes"),
    });
    previewTokenId.value = tokenId;
    lastAction.value = "预览已生成，未发送结算";
    message.success(`已生成第 ${preview.value.levelId} 关预览`);
  } catch (error) {
    preview.value = null;
    lastAction.value = "预览失败";
    message.error(error?.message || String(error));
  } finally {
    loading.value = false;
  }
}

async function buildScheduledPreview(startResponse, _context, battleConfig) {
  const tokenId = selectedTokenId.value;
  const [roleResponse, presetResponse] = await Promise.all([
    tokenStore.sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 15000),
    tokenStore.sendMessageWithPromise(tokenId, "presetteam_getinfo", {}, 15000),
  ]);
  const startBattleData = startResponse?.battleData || startResponse?.body?.battleData;
  const templates = buildResultTemplates({
    battleData: startBattleData,
    roleResponse,
    presetResponse,
  });
  battleConfig = battleConfig || getBattleConfig();
  const nextPreview = buildPushLevelDryRun({
    startResponse,
    sponsor: templates.sponsor,
    accept: templates.accept,
    ...battleConfig,
    tapTimes: parseJsonArray(tapTimesText.value, "tapTimes"),
    autoTapTimes: parseJsonArray(autoTapTimesText.value, "autoTapTimes"),
  });
  preview.value = nextPreview;
  previewTokenId.value = tokenId;
  response.value = null;
  confirmation.value = null;
  lastAction.value = `已生成第 ${nextPreview.levelId} 关结果`;
  return nextPreview;
}

async function confirmSchedulerStart() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const mode = autoContinue.value ? "自动连续推关" : "单场提交";
    dialog.warning({
      title: `确认启动${mode}`,
      content: `将使用 ${selectedToken.value?.name || selectedTokenId.value}，基础间隔 ${baseIntervalMs.value}ms，随机偏移 ${jitterMs.value}ms。服务器未确认下一关时会停止。`,
      positiveText: "确认启动",
      negativeText: "取消",
      onPositiveClick: () => finish(true),
      onNegativeClick: () => finish(false),
      onClose: () => finish(false),
    });
  });
}

function handleSchedulerEvent(event) {
  schedulerState.value = event.state || schedulerState.value;
  if (Number.isFinite(event.delayMs)) lastDelayMs.value = event.delayMs;
  if (event.state === "ready" && !autoContinue.value) {
    schedulerActive.value = false;
  }
  if (event.type === "preview") {
    lastAction.value = `第 ${event.levelId} 关结果已生成`;
  } else if (event.type === "submitted") {
    lastAction.value = `第 ${event.levelId} 关已提交并确认`;
  } else if (event.type === "error") {
    lastAction.value = `调度停止：${event.error}`;
  }
}

async function startScheduler() {
  if (!allowSubmit.value || !selectedTokenId.value || schedulerActive.value) return;
  if (!(await confirmSchedulerStart())) return;

  schedulerStarting.value = true;
  lastAction.value = "准备启动调度器";
  try {
    const battleConfig = getBattleConfig();
    await ensureConnected(selectedTokenId.value);
    scheduler = createPushLevelScheduler({
      tokenStore,
      tokenId: selectedTokenId.value,
      allowSubmit: true,
      settings: {
        baseIntervalMs: Number(baseIntervalMs.value),
        jitterMs: Number(jitterMs.value),
        minIntervalMs: 5000,
        maxIntervalMs: 120000,
        autoContinue: autoContinue.value,
      },
      buildResult: (startResponse, context) =>
        buildScheduledPreview(startResponse, context, battleConfig),
      onEvent: handleSchedulerEvent,
    });
    schedulerActive.value = true;
    schedulerState.value = "starting";
    schedulerStarting.value = false;
    lastAction.value = autoContinue.value ? "自动调度已启动" : "单场调度已启动";
    await scheduler.start({ immediate: true });
  } catch (error) {
    lastAction.value = "调度启动失败";
    message.error(error?.message || String(error));
  } finally {
    schedulerStarting.value = false;
    if (!schedulerStopping.value && scheduler?.state !== "paused") schedulerActive.value = false;
    if (scheduler?.state) schedulerState.value = scheduler.state;
  }
}

function pauseScheduler() {
  if (!scheduler) return;
  scheduler.pause();
  schedulerState.value = scheduler.state;
  lastAction.value = "调度已暂停";
}

function resumeScheduler() {
  if (!scheduler) return;
  schedulerActive.value = true;
  schedulerState.value = "starting";
  lastAction.value = "调度继续运行";
  void scheduler.resume()?.catch((error) => {
    schedulerActive.value = false;
    schedulerState.value = scheduler.state;
    lastAction.value = "调度恢复失败";
    message.error(error?.message || String(error));
  });
}

async function stopScheduler() {
  if (!scheduler || schedulerStopping.value) return;
  schedulerStopping.value = true;
  scheduler.stop();
  schedulerState.value = scheduler.state;
  lastAction.value = scheduler.inFlightSubmit
    ? "正在等待已发送的结算响应"
    : "正在停止调度";
  await scheduler.waitForIdle();
  schedulerActive.value = false;
  schedulerStopping.value = false;
  lastAction.value = "调度已停止";
}

function confirmSubmit() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    dialog.warning({
      title: "确认提交单场结算",
      content: `将向 ${selectedToken.value?.name || selectedTokenId.value} 提交第 ${preview.value.levelId} 关的合成战报。该动作可能改变账号进度。`,
      positiveText: "提交本场",
      negativeText: "取消",
      onPositiveClick: () => finish(true),
      onNegativeClick: () => finish(false),
      onClose: () => finish(false),
    });
  });
}

async function submitOnce() {
  if (!allowSubmit.value || !preview.value || !selectedTokenId.value) return;
  if (previewTokenId.value !== selectedTokenId.value) {
    clearPreview();
    message.warning("预览所属账号已变化，请重新生成");
    return;
  }
  if (!(await confirmSubmit())) return;

  submitting.value = true;
  lastAction.value = "提交 fight_endlevel";
  try {
    const adapter = createPushLevelTokenAdapter(tokenStore, { allowSubmit: true });
    const context = {
      tokenId: selectedTokenId.value,
      levelId: preview.value.levelId,
    };
    response.value = await adapter.submit(preview.value.payload, context);
    lastAction.value = "确认服务器推进";
    confirmation.value = adapter.confirm(response.value, preview.value, context);
    lastAction.value = `已确认推进到 ${confirmation.value.responseLevelId}`;
    message.success(`服务器确认进入第 ${confirmation.value.responseLevelId} 关`);
    preview.value = null;
    previewTokenId.value = "";
  } catch (error) {
    confirmation.value = null;
    lastAction.value = `提交失败${extractEndLevelResponseLevelId(response.value) === null ? "，已停止" : ""}`;
    message.error(error?.message || String(error));
  } finally {
    submitting.value = false;
  }
}

function clearPreview() {
  preview.value = null;
  previewTokenId.value = "";
  response.value = null;
  confirmation.value = null;
  lastAction.value = "已清除预览";
}

onBeforeUnmount(() => {
  scheduler?.stop();
});
</script>

<style scoped>
.synthetic-page {
  min-height: 100%;
  padding: 18px;
  background: linear-gradient(135deg, #f4f7fb 0%, #e8eef5 100%);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page-header,
.action-row,
.submit-gate,
.response-head {
  display: flex;
  align-items: center;
}

.page-header,
.response-head {
  justify-content: space-between;
  gap: 14px;
}

.eyebrow {
  margin: 0 0 5px;
  color: #0f766e;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.page-header h2 {
  margin: 0;
  color: #17212b;
  font-size: 23px;
}

.page-header p:last-child {
  margin: 5px 0 0;
  color: #667085;
  font-size: 13px;
}

.workspace-grid,
.result-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
  gap: 14px;
}

.form-grid,
.status-list,
.result-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 14px;
}

.submit-gate {
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid #d0d5dd;
  background: #f8fafc;
}

.auto-gate {
  margin-top: 10px;
}

.submit-gate div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.submit-gate strong {
  color: #344054;
  font-size: 13px;
}

.submit-gate span,
.status-list span,
.result-facts span {
  color: #98a2b3;
  font-size: 11px;
}

.gate-alert {
  margin-top: 12px;
}

.action-row {
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.status-list div,
.result-facts div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.status-list strong,
.result-facts strong {
  overflow: hidden;
  color: #344054;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-list .wide {
  grid-column: 1 / -1;
}

code {
  overflow-wrap: anywhere;
  color: #0f766e;
  font-family: Consolas, "Courier New", monospace;
  font-size: 12px;
}

.code-block {
  margin-top: 16px;
}

.code-block > span {
  color: #667085;
  font-size: 12px;
  font-weight: 600;
}

pre {
  margin: 7px 0 0;
  overflow: auto;
  color: #dbeafe;
  font-family: Consolas, "Courier New", monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.code-block pre,
.payload-block {
  max-height: 430px;
  padding: 12px;
  background: #17212b;
  border-radius: 4px;
}

.payload-block {
  min-height: 140px;
  margin: 0;
}

.response-head {
  justify-content: flex-start;
  color: #667085;
  font-size: 12px;
}

@media (max-width: 850px) {
  .workspace-grid,
  .result-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .synthetic-page {
    padding: 10px;
  }

  .page-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .form-grid,
  .status-list,
  .result-facts {
    grid-template-columns: 1fr;
  }
}
</style>