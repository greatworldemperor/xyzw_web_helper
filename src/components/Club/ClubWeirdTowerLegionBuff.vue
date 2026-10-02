<template>
  <div class="legion-buff">
    <!-- 标题行 -->
    <div class="buff-header">
      <div class="buff-title">
        <n-icon size="16" color="#854F0B"><Trophy /></n-icon>
        <span>俱乐部 buff · 参与人数档位</span>
      </div>
      <div class="buff-actions">
        <span v-if="loaded && gate.ok && summary.pending > 0" class="buff-auto-hint">
          爬塔时自动领取
        </span>
        <n-button
          size="tiny"
          secondary
          :disabled="loading"
          @click="handleRefresh"
        >
          <template #icon><n-icon><Refresh /></n-icon></template>
          刷新
        </n-button>
      </div>
    </div>

    <!-- 未绑定俱乐部 / 无人参与 提示 -->
    <n-alert v-if="loaded && !gate.ok" type="warning" :bordered="false" size="small" class="buff-alert">
      {{ gate.reason }}
    </n-alert>

    <!-- 汇总条 -->
    <div v-else-if="loaded" class="buff-summary">{{ summary.headline }}</div>

    <!-- 加载中 -->
    <div v-else class="buff-loading">
      <n-spin size="small" />
    </div>

    <!-- 四档进度（固定 4 档，阈值 10/15/20/25） -->
    <div v-if="loaded && tiers.length" class="tier-grid">
      <div
        v-for="t in tiers"
        :key="t.tier"
        class="tier-card"
        :class="[`is-${t.state}`, { 'is-next': t.tier === summary.reachedTier + 1 }]"
      >
        <div class="tier-head">
          <span class="tier-name">{{ t.label }}</span>
          <span class="tier-badge" :class="`badge-${t.state}`">{{ stateText(t.state) }}</span>
        </div>
        <div class="tier-threshold">
          <n-icon size="13"><People /></n-icon>
          <span>{{ t.threshold }} 人</span>
        </div>
        <div class="tier-desc">{{ t.desc }}</div>
        <div class="tier-progress">
          <div
            class="tier-progress-bar"
            :style="{ width: progressWidth(t.tier) + '%' }"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { NAlert, NButton, NIcon, NSpin, useMessage } from 'naive-ui'
import { People, Refresh, Trophy } from '@vicons/ionicons5'
import { useTokenStore } from '@/stores/tokenStore'
import {
  CMD_GET_EVOTOWER_INFO,
  CMD_GET_LEGION_JOIN_MEMBERS,
  TIER_STATE,
  autoClaimLegionBuffDuringClimb,
  buildTierStates,
  canClaim,
  countParticipants,
  pickUnlockedTiers,
  summarizeBuff,
} from '@/utils/weirdTowerLegionBuff'

const props = defineProps({
  tokenId: { type: String, default: '' },
  /** 外部已拿到的 memberScores（ClubWeirdTowerInfo 传入，避免重复请求） */
  memberScores: { type: Object, default: null },
  /** 自动加载 */
  autoLoad: { type: Boolean, default: true },
})

const emit = defineEmits(['claimed'])

const message = useMessage()
const tokenStore = useTokenStore()

const loading = ref(false)
const claiming = ref(false)
const loaded = ref(false)
/** 已解锁档位（顶层 legionPrivilege，领取后由服务端回填） */
const unlockedTiers = ref([])
/** 已领取档位（由嵌套 evoTower.legionPrivilege 累积） */
const claimedTiers = ref([])
const bindLegionId = ref(0)
const participantCount = ref(0)

/** 实际使用的 tokenId：优先 props，回落全局选中 */
const effectiveTokenId = computed(() => {
  if (props.tokenId) return props.tokenId
  return tokenStore.selectedToken?.id || ''
})

const gate = computed(() =>
  canClaim({ bindLegionId: bindLegionId.value, participantCount: participantCount.value }),
)

const tiers = computed(() =>
  buildTierStates({
    participantCount: participantCount.value,
    claimedTiers: claimedTiers.value,
  }),
)

const summary = computed(() =>
  summarizeBuff({
    participantCount: participantCount.value,
    claimedTiers: claimedTiers.value,
  }),
)

/** 待领档数 */
const pendingCount = computed(() => summary.value.pending)

const stateText = (state) =>
  ({ [TIER_STATE.CLAIMED]: '已领', [TIER_STATE.CLAIMABLE]: '可领', [TIER_STATE.LOCKED]: '未达' })[state] ||
  '未知'

/** 进度条宽度：当前人数相对该档阈值的百分比（上限 100） */
const progressWidth = (tier) => {
  const threshold = tiers.value.find((t) => t.tier === tier)?.threshold || 1
  return Math.min(100, Math.round((participantCount.value / threshold) * 100))
}

async function ensureConnected() {
  if (!effectiveTokenId.value) {
    message.warning('请先选择角色')
    return false
  }
  const status = tokenStore.getWebSocketStatus?.(effectiveTokenId.value)
  if (status !== 'connected') {
    message.error('WebSocket未连接，无法领取俱乐部 buff')
    return false
  }
  return true
}

/**
 * 拉取 buff 状态。
 * 🔴 两个数据源：
 *   - memberScores（人数）：优先用外部传入，否则自己发 getlegionjoinmembers
 *   - legionPrivilege（已解锁档位）：走 getinfo，**领取前是{}**，不能靠它判断有无未领档
 */
async function fetchBuffState() {
  if (!(await ensureConnected())) return
  loading.value = true
  try {
    // 1) 人数：优先复用外部数据，避免重复请求
    if (props.memberScores && Object.keys(props.memberScores).length > 0) {
      participantCount.value = countParticipants(props.memberScores)
    } else {
      const membersResp = await tokenStore.sendMessageWithPromise(
        effectiveTokenId.value,
        CMD_GET_LEGION_JOIN_MEMBERS,
        {},
        10000,
      )
      participantCount.value = countParticipants(membersResp?.memberScores)
    }

    // 2) 已解锁档位 + 俱乐部归属
    const infoResp = await tokenStore.sendMessageWithPromise(
      effectiveTokenId.value,
      CMD_GET_EVOTOWER_INFO,
      {},
      10000,
    )
    const tower = infoResp?.evoTower || infoResp?.body?.evoTower || {}
    bindLegionId.value = Number(tower.bindLegionId) || 0
    unlockedTiers.value = pickUnlockedTiers({ legionPrivilege: tower.legionPrivilege })

    // 3) 已领取档位：getinfo 的 legionPrivilege 是「已解锁且已领」的全量集合。
    //    领取前为空 {}，所以首次加载时 claimedTiers 为空（= 全部待领）。
    claimedTiers.value = pickUnlockedTiers({ legionPrivilege: tower.legionPrivilege })

    loaded.value = true
  } catch (error) {
    console.error('查询俱乐部 buff 状态失败:', error)
    message.error(`查询俱乐部 buff 失败: ${error?.message || error}`)
    loaded.value = false
  } finally {
    loading.value = false
  }
}

/**
 * 手动触发领取（供调试 / 特殊场景用）。
 *
 * 🔴 业务口径（master 2026-10-03）：**正常爬塔时不需要点这个**——
 *    `autoClaimLegionBuffDuringClimb` 已内置到两条爬塔流程的前置步骤里
 *   （src/utils/batch/tasksTower.js · src/components/Tower/WeirdTowerStatus.vue）。
 *    这个方法只是给「想立刻领、不想等爬塔」的场景留的入口。
 */
async function handleClaimAll() {
  if (!(await ensureConnected())) return
  if (!gate.value.ok) {
    message.warning(gate.value.reason)
    return
  }
  claiming.value = true
  try {
    const r = await autoClaimLegionBuffDuringClimb({
      send: (cmd, body, timeout) =>
        tokenStore.sendMessageWithPromise(effectiveTokenId.value, cmd, body, timeout),
      onLog: (msg, type) => {
        if (type === 'success') message.success(msg)
        else if (type === 'warning') message.warning(msg)
        else message.info(msg)
      },
    })
    if (r.claimedTiers.length) {
      claimedTiers.value = [...new Set([...claimedTiers.value, ...r.claimedTiers])].sort((a, b) => a - b)
      if (r.unlockedTiers.length) unlockedTiers.value = r.unlockedTiers
      emit('claimed', { tiers: r.claimedTiers })
    }
  } finally {
    claiming.value = false
  }
}

function handleRefresh() {
  fetchBuffState()
}

defineExpose({ fetchBuffState, handleClaimAll })

if (props.autoLoad) {
  // 组件挂载即拉（父组件通常已connected）
  setTimeout(fetchBuffState, 0)
}
</script>

<style scoped lang="scss">
.legion-buff {
  margin-bottom: var(--spacing-md);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--border-radius-medium);
}

.buff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
  margin-bottom: var(--spacing-sm);
}

.buff-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.buff-actions {
  display: flex;
  gap: var(--spacing-xs);
  align-items: center;
}

.buff-auto-hint {
  font-size: 11px;
  line-height: 18px;
  padding: 0 8px;
  border-radius: 9px;
  background: rgba(191, 108, 0, 0.14);
  color: #854f0b;
  white-space: nowrap;
}

.buff-alert {
  margin-bottom: var(--spacing-sm);
}

.buff-summary {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin-bottom: var(--spacing-sm);
  line-height: 1.5;
}

.buff-loading {
  display: flex;
  justify-content: center;
  padding: var(--spacing-sm) 0;
}

.tier-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--spacing-sm);
}

@media (max-width: 640px) {
  .tier-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.tier-card {
  padding: 8px 10px;
  border-radius: var(--border-radius-medium);
  border: 1px solid var(--border-light);
  background: var(--bg-primary);
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;

  &.is-claimed {
    border-color: rgba(63, 106, 17, 0.4);
    background: rgba(234, 243, 222, 0.5);
  }

  &.is-claimable {
    border-color: rgba(191, 108, 0, 0.45);
    background: rgba(250, 238, 218, 0.5);
  }

  &.is-next {
    box-shadow: 0 0 0 1px rgba(191, 108, 0, 0.35);
  }
}

.tier-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.tier-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  white-space: nowrap;
}

.tier-badge {
  font-size: 11px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  white-space: nowrap;

  &.badge-claimed {
    background: rgba(63, 106, 17, 0.14);
    color: #3b6d11;
  }

  &.badge-claimable {
    background: rgba(191, 108, 0, 0.16);
    color: #854f0b;
  }

  &.badge-locked {
    background: rgba(0, 0, 0, 0.06);
    color: var(--text-tertiary, #999);
  }
}

.tier-threshold {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.tier-desc {
  font-size: 11px;
  color: var(--text-tertiary, #999);
  line-height: 1.4;
  min-height: 15px;
}

.tier-progress {
  height: 3px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.08);
  overflow: hidden;
}

.tier-progress-bar {
  height: 100%;
  border-radius: 2px;
  background: #ba7517;
  transition: width var(--transition-fast, 0.2s);
}

.tier-card.is-claimed .tier-progress-bar {
  background: #639922;
}

.tier-card.is-locked .tier-progress-bar {
  background: rgba(0, 0, 0, 0.18);
}
</style>
