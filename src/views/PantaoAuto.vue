<template>
  <div class="pantao-auto">
    <div class="page-header">
      <div class="page-header__title">
        <h2>自动蟠桃</h2>
        <p class="subtitle">一个角色一条连接 · 分批轮询 · 抢船（向抵达最近的船移动，上船即完成）</p>
      </div>
      <div class="page-header__actions">
        <n-button size="small" :loading="probing" :disabled="!selectedIds.length" @click="probeAll">
          探测战场
        </n-button>
        <n-button size="small" type="primary" :loading="isRunning" :disabled="!canRun" @click="runAll">
          开始执行
        </n-button>
        <n-button size="small" :disabled="!isRunning" @click="stop">停止</n-button>
      </div>
    </div>

    <n-alert v-if="selectedIds.length === 0" type="warning" class="tips" :show-icon="true">
      还没有选择任何角色。请在下方「参与角色」里勾选要上场的号（蟠桃不能组队，每个号各自上场）。
    </n-alert>
    <n-alert v-else type="info" class="tips" :show-icon="true">
      已选 {{ selectedIds.length }} 个角色 · 每批 {{ settings.concurrency }} 个 · 共
      {{ batchCount }} 批 · 批间 {{ intervalMs }}ms（规避同 IP 限流）
    </n-alert>

    <div class="metrics">
      <div class="metric">
        <p class="metric__label">参与角色</p>
        <p class="metric__value">{{ selectedIds.length }}</p>
      </div>
      <div class="metric">
        <p class="metric__label">批次数</p>
        <p class="metric__value">{{ batchCount }}</p>
      </div>
      <div class="metric">
        <p class="metric__label">上轮成功</p>
        <p class="metric__value">{{ lastRound.ok }} / {{ lastRound.total }}</p>
      </div>
      <div class="metric">
        <p class="metric__label">录制帧</p>
        <p class="metric__value">{{ recordedFrames.length }}</p>
      </div>
    </div>

    <div class="main-layout">
      <div class="left-column">
        <n-card class="panel">
          <template #header>
            <div class="panel__header">
              <div>
                <span class="panel__title">参与角色</span>
                <span class="panel__sub">全部已导入的号 · 勾选后自动记住</span>
              </div>
              <div class="panel__actions">
                <n-button size="tiny" @click="selectAll">全选</n-button>
                <n-button size="tiny" @click="clearAll">清空</n-button>
                <n-button size="tiny" :disabled="!clubGroups.length" @click="toggleAllClubs">
                  {{ allClubsCollapsed ? "全部展开" : "全部折叠" }}
                </n-button>
              </div>
            </div>
          </template>

          <div v-if="allTokens.length === 0" class="empty">
            还没有导入任何角色，请先到 <router-link to="/tokens">Token 管理</router-link> 导入。
          </div>
          <div v-else class="role-picker">
            <n-input v-model:value="roleFilter" size="small" placeholder="搜索角色名 / 服务器 / 俱乐部" clearable />
            <div class="club-groups">
              <div v-for="g in clubGroups" :key="g.name" class="club-group">
                <div class="club-group__head">
                  <n-checkbox
                    :checked="g.allSelected"
                    :indeterminate="g.someSelected && !g.allSelected"
                    :label="`${g.name}（已选 ${g.selectedCount}/${g.tokens.length}）`"
                    @update:checked="(v) => toggleClub(g, v)"
                  />
                  <span
                    class="club-group__spacer"
                    :title="isClubCollapsed(g.name) ? '展开' : '折叠'"
                    @click="toggleClubCollapsed(g.name)"
                  ></span>
                  <span class="club-group__count">{{ g.tokens.length }} 人</span>
                  <button
                    type="button"
                    class="club-group__toggle"
                    :title="isClubCollapsed(g.name) ? '展开' : '折叠'"
                    @click="toggleClubCollapsed(g.name)"
                  >
                    {{ isClubCollapsed(g.name) ? "▸" : "▾" }}
                  </button>
                </div>
                <div v-show="!isClubCollapsed(g.name)" class="role-list role-list--nested">
                  <n-checkbox
                    v-for="t in g.tokens"
                    :key="t.id"
                    :checked="selectedIds.includes(String(t.id))"
                    :label="tokenLabel(t)"
                    @update:checked="(v) => toggleRole(t.id, v)"
                  />
                </div>
              </div>
              <div v-if="clubGroups.length === 0" class="empty club-groups__empty">没有匹配的角色</div>
            </div>
          </div>
        </n-card>

        <n-card class="panel">
          <template #header>
            <div class="panel__header">
              <div>
                <span class="panel__title">执行参数</span>
                <span class="panel__sub">并发越大 → 批间间隔自动拉长（log₂）</span>
              </div>
            </div>
          </template>

          <div class="settings">
            <div class="setting">
              <span>每批并发</span>
              <n-input-number v-model:value="settings.concurrency" size="small" :min="1" :max="20" />
            </div>
            <div class="setting">
              <span>批间最小间隔 (ms)</span>
              <n-input-number v-model:value="settings.minIntervalMs" size="small" :min="200" :step="200" />
            </div>
            <div class="setting">
              <span>攻击阈值（敌方 &lt; 我方 ×）</span>
              <n-input-number v-model:value="settings.attackRatio" size="small" :min="0.1" :max="1" :step="0.05" />
            </div>
            <div class="setting">
              <span>选船策略</span>
              <n-select
                v-model:value="settings.strategy"
                size="small"
                :options="strategyOptions"
                style="width: 180px"
              />
            </div>
            <div class="setting">
              <span>单角色超时 (ms)</span>
              <n-input-number v-model:value="settings.turnTimeoutMs" size="small" :min="10000" :step="5000" />
            </div>
            <div class="setting">
              <span>轮询轮数</span>
              <n-input-number v-model:value="rounds" size="small" :min="1" :max="20" />
            </div>
            <div class="setting">
              <span>只探测不行动（dry-run）</span>
              <n-switch v-model:value="settings.dryRun" size="small" />
            </div>
          </div>
        </n-card>
      </div>

      <div class="right-column">
        <n-card class="panel log-panel">
          <template #header>
            <div class="panel__header">
              <div>
                <span class="panel__title">执行日志</span>
                <span class="panel__sub">{{ logs.length }} 条 · 错误 {{ errorCount }}</span>
              </div>
              <div class="panel__actions">
                <n-button size="tiny" :type="recording ? 'error' : 'default'" @click="toggleRecording">
                  {{ recording ? "停止录制" : "录制 WSS" }}
                </n-button>
                <n-button size="tiny" :disabled="!recordedFrames.length" @click="downloadRecording">
                  下载
                </n-button>
                <n-checkbox v-model:checked="filterErrorsOnly" size="small">只看错误</n-checkbox>
                <n-checkbox v-model:checked="autoScrollLog" size="small">自动滚动</n-checkbox>
                <n-button size="tiny" @click="logs = []">清空</n-button>
              </div>
            </div>
          </template>

          <div ref="logContainer" class="log-body">
            <div v-for="(l, i) in filteredLogs" :key="i" class="log-line" :class="`log-line--${l.type}`">
              <span class="log-line__time">{{ l.time }}</span>
              <span class="log-line__msg">{{ l.message }}</span>
            </div>
            <div v-if="!filteredLogs.length" class="empty">暂无日志</div>
          </div>
        </n-card>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useMessage } from "naive-ui";
import { useTokenStore } from "@/stores/tokenStore";
import { createConnectionManager } from "@/utils/batch/connectionManager";
import { createTasksPantao } from "@/utils/batch/tasksPantao";
import * as cfg from "@/utils/pantaoConfig";

const message = useMessage();
const tokenStore = useTokenStore();

/* ------------------------------ 日志 ------------------------------ */
const MAX_LOGS = 800;
const logs = ref([]);
const autoScrollLog = ref(true);
const filterErrorsOnly = ref(false);
const logContainer = ref(null);

const addLog = (entry) => {
  logs.value.push(entry);
  if (logs.value.length > MAX_LOGS) logs.value.splice(0, logs.value.length - MAX_LOGS);
  if (autoScrollLog.value) {
    nextTick(() => {
      const el = logContainer.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
};
const errorCount = computed(() => logs.value.filter((l) => l.type === "error").length);
const filteredLogs = computed(() =>
  filterErrorsOnly.value ? logs.value.filter((l) => l.type === "error") : logs.value,
);

/* ------------------------------ 运行态 ------------------------------ */
const isRunning = ref(false);
const shouldStop = ref(false);
const probing = ref(false);
const rounds = ref(1);
const lastRound = ref({ ok: 0, total: 0 });

/* ------------------------------ 配置态 ------------------------------ */
const settings = ref(cfg.getSettings());
const selectedIds = ref(cfg.getRoleTokenIds());
const roleFilter = ref("");

const strategyOptions = [
  { label: "抵达目的地最近（默认）", value: "nearest-arrival" },
  { label: "离我最近", value: "nearest-me" },
  { label: "最胶着（|势力值| 最小）", value: "contested" },
];

const batchSettings = {
  maxActive: 3,
  connectionTimeout: 15000,
  reconnectDelay: 2000,
  maxLogEntries: MAX_LOGS,
};

const coordinator = createConnectionManager({ tokenStore, batchSettings, addLog });

const tasks = createTasksPantao({
  tokens: computed(() => tokenStore.gameTokens || []),
  isRunning,
  shouldStop,
  ensureConnection: (tokenId) => coordinator.ensureConnection(tokenId, tokenStore.gameTokens || []),
  releaseConnectionSlot: coordinator.releaseConnectionSlot,
  tokenStore,
  addLog,
  message,
  onWarFrame,
});

/* ------------------------------ WSS 帧录制 ------------------------------ */
const MAX_RECORDED = 8000;
const recording = ref(false);
const recordedFrames = ref([]);

function onWarFrame(meta, frame) {
  if (!recording.value) return;
  recordedFrames.value.push({
    ts: new Date().toISOString(),
    dir: frame?.dir,
    name: meta?.name,
    roleId: meta?.roleId,
    bfId: meta?.bfId,
    cmd: frame?.cmd,
    seq: frame?.seq,
    ack: frame?.ack,
    code: frame?.code,
    body: frame?.body ?? frame?.rawData,
  });
  if (recordedFrames.value.length > MAX_RECORDED) {
    recordedFrames.value.splice(0, recordedFrames.value.length - MAX_RECORDED);
  }
}

const toggleRecording = () => {
  recording.value = !recording.value;
  if (recording.value) {
    recordedFrames.value = [];
    addLog({ time: new Date().toLocaleTimeString(), message: "WSS 录制已开始（战场 WS 收发帧，心跳除外）", type: "info" });
  } else {
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `WSS 录制已停止，共 ${recordedFrames.value.length} 帧，可点「下载」保存`,
      type: "info",
    });
  }
};

const downloadRecording = () => {
  if (recordedFrames.value.length === 0) {
    message?.warning?.("还没有录到任何帧");
    return;
  }
  const dropBytes = (k, v) => (v instanceof Uint8Array ? `<bytes:${v.length}>` : v);
  const lines = recordedFrames.value.map((r) => JSON.stringify(r, dropBytes));
  const blob = new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pantao-wss-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jsonl`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  addLog({ time: new Date().toLocaleTimeString(), message: `已下载 ${recordedFrames.value.length} 帧录制数据`, type: "success" });
};

/* ------------------------------ 派生 ------------------------------ */
const allTokens = computed(() => tokenStore.gameTokens || []);

/**
 * 俱乐部分组（master 2026-10-06 需求：按俱乐部为单位选择启动/关闭）。
 * 数据源 = **蟠桃自己的 roleCache**（probePantao 顺带 legion_getinfo 刷新；盐场数据不混用——
 * 盐场参与者与蟠桃参与者未必相同）。未探测过 / 无俱乐部信息的角色归入「未分组」。
 * 搜索关键词同时匹配角色名 / 服务器 / 俱乐部名。
 */
const clubVersion = ref(0);
const clubGroups = computed(() => {
  clubVersion.value; // 依赖探测时的缓存写入（probeAll 后强制重算）
  const kw = roleFilter.value.trim().toLowerCase();
  const cache = cfg.getRoleCache?.() || {};
  const byClub = new Map();
  for (const t of allTokens.value) {
    const label = tokenLabel(t);
    const meta = cache[String(t.id)] || null;
    const clubName = meta?.legionName || (meta?.legionId ? `俱乐部 ${meta.legionId}` : "未分组");
    if (kw) {
      const hay = `${label} ${t?.server || ""} ${clubName}`.toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    if (!byClub.has(clubName)) byClub.set(clubName, []);
    byClub.get(clubName).push(t);
  }
  const groups = [...byClub.entries()].map(([name, tokens]) => {
    const selectedCount = tokens.filter((t) => selectedIds.value.includes(String(t.id))).length;
    return {
      name,
      tokens,
      selectedCount,
      allSelected: selectedCount === tokens.length && tokens.length > 0,
      someSelected: selectedCount > 0,
    };
  });
  // 未分组排最后，其余按名字排序
  groups.sort((a, b) => {
    if (a.name === "未分组") return 1;
    if (b.name === "未分组") return -1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
  return groups;
});

const toggleClub = (g, checked) => {
  const ids = g.tokens.map((t) => String(t.id));
  if (checked) cfg.addRoleTokenIds(ids);
  else cfg.setRoleTokenIds(cfg.getRoleTokenIds().filter((id) => !ids.includes(String(id))));
  selectedIds.value = cfg.getRoleTokenIds();
};

/* ------------- 分组折叠（master 2026-10-06：按俱乐部折叠，状态持久化） ------------- */
const collapsedClubs = ref(new Set(cfg.getCollapsedClubs()));

const isClubCollapsed = (name) => collapsedClubs.value.has(name);

const toggleClubCollapsed = (name) => {
  const s = new Set(collapsedClubs.value);
  if (s.has(name)) s.delete(name);
  else s.add(name);
  collapsedClubs.value = s;
  cfg.setCollapsedClubs([...s]);
};

const allClubsCollapsed = computed(
  () => clubGroups.value.length > 0 && clubGroups.value.every((g) => collapsedClubs.value.has(g.name)),
);

const toggleAllClubs = () => {
  const s = allClubsCollapsed.value ? new Set() : new Set(clubGroups.value.map((g) => g.name));
  collapsedClubs.value = s;
  cfg.setCollapsedClubs([...s]);
};

const batchCount = computed(() =>
  Math.ceil(selectedIds.value.length / Math.max(1, Number(settings.value.concurrency) || 1)),
);
const intervalMs = computed(() => {
  const c = Math.max(1, Number(settings.value.concurrency) || 1);
  const min = Number(settings.value.minIntervalMs) || 1200;
  return Math.max(min, Math.round(min * Math.log2(c + 1)));
});
const canRun = computed(() => !isRunning.value && selectedIds.value.length > 0);

function tokenLabel(t) {
  const extra = t?.server ? `${t.server}` : "";
  return `${t?.name || t?.id}${extra ? " · " + extra : ""}`;
}

const findTokenById = (id) => allTokens.value.find((t) => String(t.id) === String(id)) || null;

watch(
  settings,
  (v) => {
    cfg.setSettings(v);
  },
  { deep: true },
);

const toggleRole = (id, checked) => {
  if (checked) cfg.addRoleTokenIds([id]);
  else cfg.removeRoleTokenId(id);
  selectedIds.value = cfg.getRoleTokenIds();
};
const selectAll = () => {
  cfg.setRoleTokenIds(allTokens.value.map((t) => t.id));
  selectedIds.value = cfg.getRoleTokenIds();
};
const clearAll = () => {
  cfg.setRoleTokenIds([]);
  selectedIds.value = [];
};

/* ------------------------------ 动作 ------------------------------ */

const stop = () => {
  shouldStop.value = true;
  addLog({ time: new Date().toLocaleTimeString(), message: "已请求停止（当前批次结束后生效）", type: "warning" });
};

/**
 * 探测循环（2026-10-06 优化，master：探明 1 个号 → 拉回其俱乐部全量名册 →
 * 本地匹配 pending 队列中所有 roleId∈名册 的号，直接归类出队，不再发请求。
 * 同俱乐部 N 个号只花 1 次 legion_getinfo；漏网的号自然落回逐个探测，正确性不受影响。）
 */
const probeAll = async () => {
  probing.value = true;
  addLog({
    time: new Date().toLocaleTimeString(),
    message: `=== 探测 ${selectedIds.value.length} 个角色（俱乐部名单本地消化 + 蟠桃战场门票） ===`,
    type: "info",
  });

  /** 待探测队列（探明/归类一个出一个） */
  const pending = [...selectedIds.value];
  /** roleId(String) → 本地 token（用于和名册比对） */
  const tokensByRoleId = new Map();
  for (const t of allTokens.value) {
    const rid = t?.roleId != null ? String(t.roleId) : "";
    if (rid) {
      if (!tokensByRoleId.has(rid)) tokensByRoleId.set(rid, []);
      tokensByRoleId.get(rid).push(t);
    }
  }

  let netClubCount = 0; // 联网探明的俱乐部数（= legion_getinfo 次数）
  let localHits = 0; // 本地名册匹配归类数
  let ticketCount = 0;
  let failCount = 0;

  /** 把 legion 名册与本地待测号比对，命中者写缓存+出队；返回命中 token 列表 */
  const absorbByRoster = (legion) => {
    if (!legion?.id || !Array.isArray(legion.roster) || !legion.roster.length) return [];
    const memberIds = new Set(legion.roster.map((m) => String(m.roleId)));
    const nameOf = new Map(legion.roster.map((m) => [String(m.roleId), m.name || ""]));
    const hit = [];
    for (let i = pending.length - 1; i >= 0; i--) {
      const tid = pending[i];
      const tok = findTokenById(tid);
      const rid = tok?.roleId != null ? String(tok.roleId) : "";
      if (rid && memberIds.has(rid)) {
        cfg.setRoleCacheEntry(tid, {
          legionId: legion.id,
          legionName: legion.name || "",
          roleId: Number(rid),
          roleName: nameOf.get(rid) || tok?.name || "",
        });
        pending.splice(i, 1);
        hit.push(tok?.name || tid);
      }
    }
    return hit;
  };

  try {
    while (pending.length) {
      if (shouldStop.value) break;
      const id = pending.shift();
      const r = await tasks.probePantao(id);

      if (r.legion?.id) {
        netClubCount++;
        clubVersion.value++;
        cfg.setRoleCacheEntry(String(id), { legionId: r.legion.id, legionName: r.legion.name || "" });

        // 名册本地消化：同俱乐部的待测号全部归类出队
        const hits = absorbByRoster(r.legion);
        localHits += hits.length;
        if (hits.length) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `[${r.legion.name}] 名册 ${r.legion.roster.length} 人，本地匹配到 ${hits.length} 个待测号，免再探：${hits.join("、")}`,
            type: "success",
          });
        }
      }

      if (r.info) {
        ticketCount++;
        const info = r.info;
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${r.label}${r.legion?.name ? ` [${r.legion.name}]` : ""} 战场 ${info.bfId}（准备 ${ts(info.readyTime)} / 开打 ${ts(info.startTime)} / 结束 ${ts(info.endTime)}，roleBfState=${r.roleBfState || "-"}）`,
          type: "success",
        });
      } else if (r.legion?.id) {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${r.label} [${r.legion.name}] ${r.reason}`,
          type: "info",
        });
      } else {
        failCount++;
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${id} ${r.reason}`,
          type: "warning",
        });
      }
      try {
        tokenStore.closeWebSocketConnection(id);
      } catch {
        /* ignore */
      }
      coordinator.releaseConnectionSlot?.();
    }

    const parts = [`俱乐部联网探明 ${netClubCount} 个`, `本地匹配归类 ${localHits} 个`, `战场有票 ${ticketCount} 个`, `失败 ${failCount} 个`];
    if (shouldStop.value) parts.push("（已手动停止）");
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== 探测完成：${parts.join("｜")} ===`,
      type: failCount === 0 ? "success" : "warning",
    });
  } finally {
    probing.value = false;
  }
};

const runAll = async () => {
  shouldStop.value = false;
  const res = await tasks.runPantaoRoles({
    tokenIds: selectedIds.value,
    concurrency: settings.value.concurrency,
    rounds: rounds.value,
  });
  lastRound.value = { ok: res.ok, total: res.results.length };
};

function ts(sec) {
  const n = Number(sec || 0);
  if (!n) return "-";
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(sec) : d.toLocaleTimeString();
}

onMounted(() => {
  addLog({
    time: new Date().toLocaleTimeString(),
    message: "自动蟠桃：勾选角色 → 先「探测战场」确认有票 → 再「开始执行」。建议先勾 1~2 个号 dry-run。",
    type: "info",
  });
});
</script>

<style scoped>
.pantao-auto {
  padding: 16px;
}
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.page-header__title h2 {
  margin: 0;
  font-size: 20px;
}
.subtitle {
  margin: 4px 0 0;
  color: #8a94a6;
  font-size: 12px;
}
.page-header__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.tips {
  margin-bottom: 12px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}
.metric {
  background: #fff;
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 10px 12px;
}
.metric__label {
  margin: 0;
  font-size: 12px;
  color: #8a94a6;
}
.metric__value {
  margin: 4px 0 0;
  font-size: 20px;
  font-weight: 600;
}
.main-layout {
  display: grid;
  grid-template-columns: 1.45fr 1fr;
  gap: 12px;
  align-items: start;
}
.left-column,
.right-column {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.panel__title {
  font-weight: 600;
}
.panel__sub {
  margin-left: 8px;
  font-size: 12px;
  color: #8a94a6;
}
.panel__actions {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.empty {
  color: #9aa3b2;
  font-size: 13px;
  padding: 8px 0;
}
.role-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.role-list {
  max-height: 260px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.club-groups {
  max-height: 380px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.club-group {
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 8px;
  padding: 8px 10px;
}
.club-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.club-group__spacer {
  flex: 1;
  cursor: pointer;
  align-self: stretch;
}
.club-group__count {
  font-size: 12px;
  color: #9aa3b2;
  white-space: nowrap;
}
.club-group__toggle {
  border: none;
  background: transparent;
  cursor: pointer;
  color: #8a94a6;
  font-size: 12px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 4px;
}
.club-group__toggle:hover {
  color: #18a058;
  background: rgba(24, 160, 88, 0.08);
}
.role-list--nested {
  max-height: 180px;
  padding-left: 18px;
}
.settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.log-body {
  max-height: 460px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.7;
}
.log-line {
  display: flex;
  gap: 8px;
}
.log-line__time {
  color: #9aa3b2;
  flex: 0 0 72px;
}
.log-line--error .log-line__msg {
  color: #d03050;
}
.log-line--warning .log-line__msg {
  color: #f0a020;
}
.log-line--success .log-line__msg {
  color: #18a058;
}
</style>
