<template>
  <div class="salt-field-auto">
    <div class="page-header">
      <div class="page-header__title">
        <h2>自动盐场</h2>
        <p class="subtitle">进入战场 · 选阵容 · 组队 · 登场　　俱乐部 → 队伍 → 角色</p>
      </div>
      <div class="page-header__actions">
        <n-tag :type="activityTag.type" size="small">{{ activityTag.text }}</n-tag>
        <n-button size="small" :loading="syncing" @click="syncRoles">同步角色信息</n-button>
        <n-button size="small" type="primary" :disabled="!canRun" @click="runAll">一键执行</n-button>
        <n-button size="small" :disabled="!isRunning" @click="stop">停止</n-button>
      </div>
    </div>

    <n-alert v-if="leaderIds.length === 0" type="warning" class="tips" :show-icon="true">
      还没有选择队长角色。请先到
      <router-link to="/tokens">Token 管理</router-link>
      勾选角色作为队长 —— 选中的角色即一支队伍的队长，所属俱乐部会自动推导出来。
    </n-alert>
    <n-alert v-else-if="unsyncedCount > 0" type="info" class="tips" :show-icon="true">
      有 {{ unsyncedCount }} 个队长角色尚未同步俱乐部信息，点「同步角色信息」补全后才会参与执行。
    </n-alert>

    <div class="metrics">
      <div class="metric"><p class="metric__label">俱乐部</p><p class="metric__value">{{ clubGroups.length }}</p></div>
      <div class="metric">
        <p class="metric__label">队伍</p>
        <p class="metric__value">{{ teams.length }}</p>
        <p class="metric__hint">{{ mobileCount }} 机动 · {{ teams.length - mobileCount }} 固定</p>
      </div>
      <div class="metric"><p class="metric__label">队长（需登录）</p><p class="metric__value">{{ teams.length }}</p></div>
      <div class="metric">
        <p class="metric__label">队员（免登录）</p>
        <p class="metric__value">{{ memberCount }}</p>
      </div>
      <div class="metric">
        <p class="metric__label">上轮入队</p>
        <p class="metric__value">{{ lastRound.ok }} / {{ lastRound.total }}</p>
      </div>
    </div>

    <div class="main-layout">
      <div class="left-column">
        <n-card class="panel">
          <template #header>
            <div class="panel__header">
              <div>
                <span class="panel__title">队伍编排</span>
                <span class="panel__sub">队伍是最小执行单位 · 组队与补齐都只在同一俱乐部内进行</span>
              </div>
              <div class="panel__actions">
                <n-checkbox v-model:checked="fillOnlyIncomplete" size="small">仅补齐不满 5 人的队伍</n-checkbox>
                <n-button size="small" :loading="filling" @click="batchMobileFill">机动补齐</n-button>
              </div>
            </div>
          </template>

          <div v-if="clubGroups.length === 0" class="empty">暂无队伍。先到 Token 管理选择队长角色。</div>

          <div v-for="group in clubGroups" :key="group.key" class="club-group">
            <div class="club-group__header">
              <n-button text size="tiny" @click="toggleCollapse(group.key)">
                {{ collapsed[group.key] ? "▸" : "▾" }}
              </n-button>
              <span class="club-group__name">{{ group.legionId ?? "未同步" }} {{ group.legionName }}</span>
              <n-tag size="tiny">{{ group.teams.length }} 队</n-tag>
              <n-tag v-if="group.memberCount != null" size="tiny">{{ group.memberCount }} 人</n-tag>
              <span class="flex-1"></span>
              <n-switch
                size="small"
                :value="group.enabled"
                :disabled="group.legionId == null"
                @update:value="(v) => toggleClubEnabled(group, v)"
              >
                <template #checked>启用</template>
                <template #unchecked>停用</template>
              </n-switch>
            </div>

            <div v-show="!collapsed[group.key]" class="club-group__body">
              <div v-for="team in group.teams" :key="team.id" class="team-row">
                <span class="team-row__dot" :class="statusClass(team)"></span>
                <span class="team-row__name">{{ team.name }}</span>
                <span class="chip chip--leader" :title="`roleId ${leaderRoleId(team)}`">
                  队长 cId {{ liveCid(team) ?? "—" }} · {{ leaderName(team) }}
                </span>
                <span
                  v-for="rid in team.memberRoleIds"
                  :key="rid"
                  class="chip"
                  :class="{ 'chip--bad': liveCidOfRole(team, rid) == null && hasLive(team) }"
                  :title="`roleId ${rid}`"
                >
                  {{ roleNameOf(team, rid) }} · cId {{ liveCidOfRole(team, rid) ?? "?" }}
                  <i class="chip__x" @click.stop="removeMember(team, rid)">×</i>
                </span>
                <span v-for="n in emptySlots(team)" :key="'e' + n" class="chip chip--empty">＋空位</span>
                <span class="flex-1"></span>
                <n-switch size="small" :value="team.mobile" @update:value="(v) => setTeamField(team, 'mobile', v)">
                  <template #checked>机动</template>
                  <template #unchecked>固定</template>
                </n-switch>
                <n-button size="tiny" @click="openEditor(team)">编辑</n-button>
                <n-button size="tiny" :loading="runningTeamId === team.id" :disabled="!canRun" @click="runTeam(team)">
                  执行
                </n-button>
                <n-button size="tiny" quaternary @click="openCandidates(team)">候选</n-button>
              </div>
              <div v-if="group.legionId == null" class="club-group__warn">
                该队长尚未同步角色信息，无法确定所属俱乐部 —— 请先点「同步角色信息」。
              </div>
              <div v-else-if="!group.enabled" class="club-group__warn">该俱乐部已停用，一键执行时会跳过其下所有队伍。</div>
            </div>
          </div>
        </n-card>

        <n-card class="panel">
          <template #header>
            <div class="panel__header">
              <div>
                <span class="panel__title">候选账号</span>
                <span class="panel__sub">按俱乐部分组 · 排序：不在线优先 → 势力降序 · 仅供机动补齐</span>
              </div>
              <n-tag size="tiny">各俱乐部独立候选池</n-tag>
            </div>
          </template>
          <div v-if="candidateGroups.length === 0" class="empty">
            还没有候选池数据。执行一次队伍、或点队伍行的「候选」按钮探测一次即可填充。
          </div>
          <div v-for="cg in candidateGroups" :key="cg.key" class="club-group">
            <div class="club-group__header">
              <span class="club-group__name">{{ cg.legionId }} {{ cg.legionName }}</span>
              <n-tag size="tiny">可选取 {{ cg.pool.available.length }}</n-tag>
              <n-tag v-if="cg.pool.unavailable.length" size="tiny" type="error">
                不可用 {{ cg.pool.unavailable.length }}
              </n-tag>
              <span class="flex-1"></span>
              <span class="panel__sub">
                前 3 名：{{ cg.pool.available.slice(0, 3).map((c) => c.name || c.cId).join(" · ") || "—" }}
              </span>
            </div>
            <div class="club-group__body">
              <div v-for="c in cg.pool.all.slice(0, 12)" :key="c.roleId" class="cand-row">
                <n-tag size="tiny" :type="c.unavailable ? 'error' : c.isOffline ? 'default' : 'success'">
                  {{ c.unavailable ? "不可用" : c.isOffline ? "离线" : "在线" }}
                </n-tag>
                <span class="cand-row__name">{{ c.name }}</span>
                <span class="cand-row__meta">roleId {{ c.roleId }}</span>
                <span class="flex-1"></span>
                <span class="cand-row__meta">cId {{ c.cId ?? "—" }}</span>
                <span class="cand-row__meta">{{ formatPower(c.power) }}</span>
                <n-tag v-if="c.excluded" size="tiny" type="warning">已占用</n-tag>
              </div>
            </div>
          </div>
        </n-card>
      </div>

      <div class="right-column">
        <n-card class="panel log-card">
          <template #header>
            <div class="panel__header">
              <div>
                <span class="panel__title">{{ runningTeamLabel || "执行日志" }}</span>
                <span class="panel__sub">{{ logs.length }} 条</span>
              </div>
              <div class="panel__actions">
                <n-checkbox v-model:checked="autoScrollLog" size="small">自动滚动</n-checkbox>
                <n-checkbox v-model:checked="filterErrorsOnly" size="small">只看错误</n-checkbox>
                <n-tag v-if="errorCount > 0" size="small" type="error">{{ errorCount }} 个错误</n-tag>
                <n-button size="small" @click="logs = []">清空</n-button>
              </div>
            </div>
          </template>
          <n-progress type="line" :percentage="progressPercent" :indicator-placement="'inside'" processing />
          <div ref="logContainer" class="log-container">
            <div v-for="(l, i) in filteredLogs" :key="i" class="log-item" :class="l.type">
              <span class="log-item__time">{{ l.time }}</span>
              <span class="log-item__msg">{{ l.message }}</span>
            </div>
          </div>
        </n-card>
      </div>
    </div>

    <n-modal
      v-model:show="showEditor"
      preset="card"
      :title="`编辑队伍 - ${editingTeam?.name || ''}`"
      style="width: 92%; max-width: 520px"
    >
      <div v-if="editingTeam" class="editor">
        <div class="editor__row">
          <label>队伍名</label>
          <n-input v-model:value="editingTeam.name" size="small" @update:value="persistTeams" />
        </div>
        <div class="editor__row">
          <label>启用</label>
          <n-switch v-model:value="editingTeam.enabled" size="small" @update:value="persistTeams" />
        </div>
        <div class="editor__row">
          <label>机动</label>
          <div>
            <n-switch v-model:value="editingTeam.mobile" size="small" @update:value="persistTeams" />
            <span class="editor__hint">开启后，队伍不满 5 人时将按候选顺序在本俱乐部内补齐</span>
          </div>
        </div>
        <div class="editor__row editor__row--block">
          <label>队长</label>
          <div class="editor__leader">
            <span>{{ leaderName(editingTeam) }}</span>
            <n-tag size="tiny">roleId {{ leaderRoleId(editingTeam) }}</n-tag>
            <n-tag size="tiny">俱乐部 {{ editingTeam.legionId ?? "未同步" }}</n-tag>
          </div>
        </div>
        <div class="editor__row editor__row--block">
          <label>队员（按 roleId 指定，最多 4 人）</label>
          <n-select
            v-model:value="editingTeam.memberRoleIds"
            multiple
            filterable
            size="small"
            :options="memberOptions(editingTeam)"
            placeholder="从已导入的角色里选；也可手动输入 roleId"
            @update:value="persistTeams"
          />
          <div class="editor__hint">
            不在同一俱乐部的角色会在执行时被跳过并报错。队友好坏不需要登录，只需 roleId。
          </div>
        </div>
        <div class="editor__row editor__row--block">
          <label>手动添加 roleId（白名单外的号）</label>
          <div class="editor__manual">
            <n-input v-model:value="manualRoleId" size="small" placeholder="例如 682283004" />
            <n-button size="small" @click="addManualMember">添加</n-button>
          </div>
        </div>
      </div>
    </n-modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from "vue";
import { useMessage } from "naive-ui";
import { useTokenStore, gameTokens } from "@/stores/tokenStore";
import { createConnectionManager } from "@/utils/batch/connectionManager";
import { createTasksSaltField } from "@/utils/batch/tasksSaltField";
import * as cfg from "@/utils/saltFieldConfig";

const message = useMessage();
const tokenStore = useTokenStore();

/* ------------------------------ 日志 ------------------------------ */
const logs = ref([]);
const autoScrollLog = ref(true);
const filterErrorsOnly = ref(false);
const logContainer = ref(null);
const MAX_LOGS = 800;

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
const syncing = ref(false);
const filling = ref(false);
const runningTeamId = ref(null);
const runningTeamLabel = ref("");
const tokenStatus = ref({});
const progressPercent = ref(0);
const fillOnlyIncomplete = ref(true);
const showEditor = ref(false);
const editingTeam = ref(null);
const manualRoleId = ref("");
const collapsed = ref({});

/** 上一次运行/探测得来的战场实况：tokenId -> { myCid, roleMap, roster, pool, roleNames } */
const liveByTeam = ref({});
const lastRound = ref({ ok: 0, total: 0 });

/* ------------------------------ 配置态 ------------------------------ */
const leaderIds = ref(cfg.getLeaderTokenIds());
const teams = ref(cfg.getTeams());
const roleCache = ref(cfg.getRoleCache());

const batchSettings = {
  maxActive: 3,
  connectionTimeout: 15000,
  reconnectDelay: 2000,
  maxLogEntries: MAX_LOGS,
};

const coordinator = createConnectionManager({
  tokenStore,
  batchSettings,
  addLog,
});

const tasks = createTasksSaltField({
  tokens: computed(() => tokenStore.gameTokens || []),
  isRunning,
  shouldStop,
  tokenStatus,
  ensureConnection: (tokenId) => coordinator.ensureConnection(tokenId, tokenStore.gameTokens || []),
  releaseConnectionSlot: coordinator.releaseConnectionSlot,
  connectionQueue: coordinator.connectionQueue,
  batchSettings,
  tokenStore,
  addLog,
  message,
});

/* ------------------------------ 派生 ------------------------------ */
const reloadFromStorage = () => {
  leaderIds.value = cfg.getLeaderTokenIds();
  teams.value = cfg.getTeams();
  roleCache.value = cfg.getRoleCache();
};

const groupCollapseKey = (legionId) => String(legionId ?? "unknown");

const clubGroups = computed(() => {
  const groups = cfg.groupTeamsByLegion(teams.value, roleCache.value);
  return groups.map((g) => {
    const key = groupCollapseKey(g.legionId);
    const cached = liveByTeam.value[`legion:${key}`];
    return {
      ...g,
      key,
      memberCount: cached?.roster?.length ?? null,
    };
  });
});

const memberCount = computed(() => teams.value.reduce((n, t) => n + (t.memberRoleIds?.length || 0), 0));
const mobileCount = computed(() => teams.value.filter((t) => t.mobile).length);
const unsyncedCount = computed(
  () => leaderIds.value.filter((id) => !roleCache.value[String(id)]?.legionId).length,
);
const canRun = computed(() => !isRunning.value && teams.value.length > 0);

const activityTag = computed(() => {
  const anyLive = Object.values(liveByTeam.value).find((x) => x?.activityWindow?.end);
  if (!anyLive) return { type: "default", text: "未探测活动窗口" };
  const { start, end, phase } = anyLive.activityWindow;
  const now = Math.floor(Date.now() / 1000);
  if (!start || !end) return { type: "default", text: phase || "窗口未知" };
  const fmt = (s) => new Date(s * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (now >= start && now < end) return { type: "success", text: `${phase} 进行中 ${fmt(start)}–${fmt(end)} · 剩 ${Math.ceil((end - now) / 60)} 分` };
  if (now < start) return { type: "warning", text: `${phase} 未开始 · ${fmt(start)} 开放` };
  return { type: "error", text: `${phase} 已结束` };
});

const candidateGroups = computed(() => {
  const out = [];
  for (const [key, val] of Object.entries(liveByTeam.value)) {
    if (!val?.pool) continue;
    out.push({
      key,
      legionId: val.legionId,
      legionName: val.legionName,
      pool: val.pool,
    });
  }
  return out.sort((a, b) => Number(a.legionId || 0) - Number(b.legionId || 0));
});

/* ------------------------------ 队伍展示辅助 ------------------------------ */
const leaderRoleId = (team) => roleCache.value[String(team.leaderTokenId)]?.roleId ?? null;
const leaderName = (team) =>
  roleCache.value[String(team.leaderTokenId)]?.roleName || team.name || team.leaderTokenId;

const hasLive = (team) => !!liveByTeam.value[team.id];
const liveCid = (team) => liveByTeam.value[team.id]?.myCid ?? null;
const liveCidOfRole = (team, roleId) => {
  const live = liveByTeam.value[team.id];
  if (!live?.roleMap) return null;
  const entry = live.roleMap[String(roleId)];
  return entry ? Number(entry.cId) : null;
};
const roleNameOf = (team, roleId) => {
  const live = liveByTeam.value[team.id];
  const fromLive = live?.roleNames?.[String(roleId)];
  if (fromLive) return fromLive;
  const t = (tokenStore.gameTokens || []).find((x) => Number(x.roleId) === Number(roleId));
  return t?.name || String(roleId);
};
const emptySlots = (team) => Math.max(0, 5 - 1 - (team.memberRoleIds?.length || 0));
const statusClass = (team) => {
  if (!team.enabled) return "dot--off";
  if (!hasLive(team)) return "dot--idle";
  const cid = liveCid(team);
  const role = cid != null ? liveByTeam.value[team.id]?.roles?.[String(cid)] : null;
  if (!role) return "dot--idle";
  return role.state && role.state !== "watching" ? "dot--ok" : "dot--warn";
};

const formatPower = (p) => {
  const n = Number(p || 0);
  if (n >= 1e12) return (n / 1e12).toFixed(2) + "万亿";
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
  return String(n);
};

const memberOptions = (team) => {
  const own = new Set([Number(leaderRoleId(team))]);
  return (tokenStore.gameTokens || [])
    .map((t) => ({
      label: `${t.name}（roleId ${t.roleId ?? "?"}）`,
      value: Number(t.roleId || 0),
      disabled: !t.roleId || own.has(Number(t.roleId)),
    }))
    .filter((o) => o.value);
};

/* ------------------------------ 配置写回 ------------------------------ */
const persistTeams = () => {
  // 未同步的队长 id 形态不变，直接整体写回
  cfg.setTeams(teams.value.map((t) => ({ ...t, memberRoleIds: [...(t.memberRoleIds || [])] })));
};

const setTeamField = (team, key, value) => {
  team[key] = value;
  persistTeams();
};

const toggleCollapse = (key) => {
  collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] };
};

const toggleClubEnabled = (group, value) => {
  if (group.legionId == null) return;
  cfg.setClubEnabled(group.legionId, value);
  reloadFromStorage();
  addLog({ time: new Date().toLocaleTimeString(), message: `俱乐部 ${group.legionId} ${group.legionName} ${value ? "已启用" : "已停用"}`, type: "info" });
};

const openEditor = (team) => {
  editingTeam.value = teams.value.find((t) => t.id === team.id) || team;
  manualRoleId.value = "";
  showEditor.value = true;
};

const removeMember = (team, roleId) => {
  const t = teams.value.find((x) => x.id === team.id);
  if (!t) return;
  t.memberRoleIds = (t.memberRoleIds || []).filter((r) => Number(r) !== Number(roleId));
  persistTeams();
};

const addManualMember = () => {
  const rid = Number(String(manualRoleId.value).trim());
  if (!rid) return;
  const t = editingTeam.value;
  if (!t) return;
  if ((t.memberRoleIds || []).length >= 4) {
    message.warning("队员已达 4 人上限（含队长共 5 人）");
    return;
  }
  if (!(t.memberRoleIds || []).some((r) => Number(r) === rid)) {
    t.memberRoleIds = [...(t.memberRoleIds || []), rid];
    persistTeams();
  }
  manualRoleId.value = "";
};

/* ------------------------------ 动作 ------------------------------ */
const syncRoles = async () => {
  syncing.value = true;
  progressPercent.value = 0;
  try {
    await tasks.syncSaltFieldRoles();
    reloadFromStorage();
    cfg.reconcileTeams();
    reloadFromStorage();
  } catch (e) {
    addLog({ time: new Date().toLocaleTimeString(), message: `同步失败: ${e?.message || e}`, type: "error" });
  } finally {
    syncing.value = false;
  }
};

const stop = () => {
  shouldStop.value = true;
  addLog({ time: new Date().toLocaleTimeString(), message: "已请求停止，等待当前队伍收尾…", type: "warning" });
};

/** 探测一支队伍的候选池（会真的连一次战场，但不发组队/布阵命令） */
const probeTeam = async (team) => {
  const { probe, pool } = await tasks.previewSaltFieldTeamCandidates(team);
  const roleNames = {};
  for (const r of probe.roster) roleNames[String(r.roleId)] = r.name;
  const prev = liveByTeam.value[team.id] || {};
  liveByTeam.value = {
    ...liveByTeam.value,
    [team.id]: {
      ...prev,
      myCid: probe.myCid,
      legionId: probe.legionId,
      legionName: probe.legionName,
      roleMap: probe.roleMap,
      roster: probe.roster,
      roleNames,
      pool,
      activityWindow: probe.activityWindow,
      roles: probe.session?.roles || prev.roles || {},
    },
    [`legion:${groupCollapseKey(probe.legionId)}`]: {
      roster: probe.roster,
      pool,
    },
  };
  return pool;
};

const openCandidates = async (team) => {
  runningTeamId.value = team.id;
  addLog({ time: new Date().toLocaleTimeString(), message: `[${team.legionId ?? "?"} / ${team.name}] 探测候选池…`, type: "info" });
  try {
    const pool = await probeTeam(team);
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `[${team.legionId} / ${team.name}] 候选池：可选取 ${pool.available.length}，不可用 ${pool.unavailable.length}，已占用 ${pool.excluded.length}`,
      type: "success",
    });
  } catch (e) {
    addLog({ time: new Date().toLocaleTimeString(), message: `[${team.name}] 探测失败: ${e?.message || e}`, type: "error" });
  } finally {
    runningTeamId.value = null;
  }
};

const runTeam = async (team) => {
  runningTeamId.value = team.id;
  runningTeamLabel.value = `正在执行: ${team.name}`;
  progressPercent.value = 0;
  try {
    const results = await tasks.runSaltFieldTeams([team.id]);
    const r = results[0];
    lastRound.value = { ok: r?.ok ? 1 : 0, total: 1 };
    if (r) {
      liveByTeam.value = {
        ...liveByTeam.value,
        [team.id]: {
          ...(liveByTeam.value[team.id] || {}),
          myCid: liveByTeam.value[team.id]?.myCid ?? null,
          teamMembers: r.teamMembers,
        },
      };
    }
  } finally {
    runningTeamId.value = null;
    runningTeamLabel.value = "";
    progressPercent.value = 100;
  }
};

const runAll = async () => {
  progressPercent.value = 0;
  runningTeamLabel.value = "批量执行中…";
  try {
    const results = await tasks.runSaltFieldTeams(null);
    lastRound.value = { ok: results.filter((r) => r.ok).length, total: results.length };
    progressPercent.value = 100;
  } finally {
    runningTeamId.value = null;
    runningTeamLabel.value = "";
  }
};

/** 批量机动补齐：本俱乐部内去重，先到先得 */
const batchMobileFill = async () => {
  filling.value = true;
  try {
    const groups = cfg.groupTeamsByLegion(teams.value, roleCache.value);
    let filledCount = 0;
    const occupiedByLegion = new Map();

    for (const g of groups) {
      if (!g.enabled) continue;
      const targets = g.teams.filter((t) => {
        if (!t.mobile) return false;
        if (fillOnlyIncomplete.value && (t.memberRoleIds?.length || 0) >= 4) return false;
        return true;
      });
      if (targets.length === 0) continue;

      // 已有别的队占用的人（同俱乐部内去重）
      const occupied = new Set();
      for (const t of g.teams) {
        for (const r of t.memberRoleIds || []) occupied.add(Number(r));
      }
      for (const r of occupiedByLegion.get(String(g.legionId)) || []) occupied.add(Number(r));

      // 顺序分配，先到先得
      for (const team of targets) {
        let pool = liveByTeam.value[team.id]?.pool;
        if (!pool) {
          try {
            pool = await probeTeam(team);
          } catch (e) {
            addLog({ time: new Date().toLocaleTimeString(), message: `[${team.name}] 取候选池失败: ${e?.message || e}`, type: "error" });
            continue;
          }
        }
        const target = teams.value.find((x) => x.id === team.id);
        const leaderRole = Number(leaderRoleId(target));
        const specified = (target.memberRoleIds || []).map(Number).filter((r) => r !== leaderRole);
        const picked = cfg.pickMobileFill({
          candidatePoolAvailable: pool.available.filter((c) => !occupied.has(Number(c.roleId))),
          team: { leaderRoleId: leaderRole, memberRoleIds: specified },
          occupiedRoleIds: [...occupied],
        });
        if (picked.length) {
          target.memberRoleIds = [...specified, ...picked.map((p) => p.roleId)];
          picked.forEach((p) => occupied.add(Number(p.roleId)));
          filledCount += picked.length;
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `[${g.legionId} / ${target.name}] 机动补齐 ${picked.map((p) => `${p.cId} ${p.name}(${p.isOffline ? "离线" : "在线"})`).join("、")}`,
            type: "success",
          });
        } else {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `[${g.legionId} / ${target.name}] 本俱乐部候选池已无可用成员（或缺员为 0）`,
            type: "warning",
          });
        }
      }
      occupiedByLegion.set(String(g.legionId), [...occupied]);
    }
    persistTeams();
    message.success(filledCount > 0 ? `机动补齐完成：共补入 ${filledCount} 人` : "机动补齐完成：没有需要补的队伍");
  } finally {
    filling.value = false;
  }
};

onMounted(() => {
  cfg.reconcileTeams();
  reloadFromStorage();
  addLog({
    time: new Date().toLocaleTimeString(),
    message: `自动盐场就绪：${teams.value.length} 支队伍 / ${clubGroups.value.length} 个俱乐部。选择队长请到 Token 管理页。`,
    type: "info",
  });
});
</script>

<style scoped>
.salt-field-auto {
  padding: 16px;
}
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.page-header__title h2 {
  margin: 0;
  font-size: 18px;
}
.subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: #86909c;
}
.page-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tips {
  margin-bottom: 12px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.metric {
  background: #f7f8fa;
  border-radius: 8px;
  padding: 12px 14px;
}
.metric__label {
  margin: 0 0 4px;
  font-size: 12px;
  color: #86909c;
}
.metric__value {
  margin: 0;
  font-size: 22px;
  font-weight: 500;
  line-height: 1.2;
}
.metric__hint {
  margin: 2px 0 0;
  font-size: 12px;
  color: #86909c;
}
.main-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.left-column,
.right-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.panel__title {
  font-size: 14px;
  font-weight: 500;
  margin-right: 8px;
}
.panel__sub {
  font-size: 12px;
  color: #86909c;
}
.panel__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.empty {
  padding: 24px 8px;
  text-align: center;
  color: #86909c;
  font-size: 13px;
}
.club-group {
  margin-top: 12px;
}
.club-group__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #f7f8fa;
  border-radius: 8px;
  flex-wrap: wrap;
}
.club-group__name {
  font-size: 13px;
  font-weight: 500;
}
.club-group__body {
  padding-left: 14px;
  margin-left: 6px;
  border-left: 2px solid #e5e6eb;
}
.club-group__warn {
  font-size: 12px;
  color: #d03050;
  padding: 6px 0 2px 8px;
}
.team-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 0;
  flex-wrap: wrap;
}
.team-row__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 8px;
  background: #c9cdd4;
}
.dot--ok {
  background: #18a058;
}
.dot--warn {
  background: #f0a020;
}
.dot--off {
  background: #c9cdd4;
}
.dot--idle {
  background: #2080f0;
}
.team-row__name {
  font-size: 13px;
  font-weight: 500;
  min-width: 52px;
}
.chip {
  font-size: 12px;
  padding: 3px 8px;
  border: 1px solid #e5e6eb;
  border-radius: 6px;
  color: #4e5969;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.chip--leader {
  background: #e8f3ff;
  border-color: #a3c9f7;
  color: #2080f0;
}
.chip--bad {
  background: #fdecec;
  border-color: #f7c1c1;
  color: #d03050;
}
.chip--empty {
  border-style: dashed;
  color: #c9cdd4;
}
.chip__x {
  cursor: pointer;
  font-style: normal;
  color: #86909c;
}
.chip__x:hover {
  color: #d03050;
}
.flex-1 {
  flex: 1;
}
.cand-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  font-size: 12px;
  flex-wrap: wrap;
}
.cand-row__name {
  font-size: 13px;
}
.cand-row__meta {
  color: #86909c;
}
.log-card {
  position: sticky;
  top: 16px;
}
.log-container {
  margin-top: 8px;
  max-height: calc(100vh - 300px);
  min-height: 240px;
  overflow: auto;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.8;
}
.log-item {
  display: flex;
  gap: 8px;
}
.log-item__time {
  color: #c9cdd4;
  flex: 0 0 auto;
}
.log-item__msg {
  word-break: break-all;
}
.log-item.success .log-item__msg {
  color: #18a058;
}
.log-item.warning .log-item__msg {
  color: #f0a020;
}
.log-item.error .log-item__msg {
  color: #d03050;
}
.editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.editor__row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.editor__row label {
  flex: 0 0 96px;
  font-size: 13px;
  color: #4e5969;
}
.editor__row--block {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}
.editor__row--block label {
  flex: none;
}
.editor__leader {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.editor__hint {
  font-size: 12px;
  color: #86909c;
  margin-left: 8px;
}
.editor__manual {
  display: flex;
  gap: 8px;
}
</style>
