<template>
  <div class="mobile-login-form">
    <div class="login-status" :data-step="currentStep">
      <div class="step" :class="{ active: currentStep >= 1 }">
        <span>1</span>
        <strong>验证手机</strong>
      </div>
      <div class="step-line"></div>
      <div class="step" :class="{ active: currentStep >= 2 }">
        <span>2</span>
        <strong>选择角色</strong>
      </div>
      <div class="step-line"></div>
      <div class="step" :class="{ active: currentStep >= 3 }">
        <span>3</span>
        <strong>完成添加</strong>
      </div>
    </div>

    <n-alert v-if="statusMessage" :type="statusType" :show-icon="true">
      {{ statusMessage }}
    </n-alert>

    <n-form
      v-if="currentStep === 1"
      ref="loginFormRef"
      :model="loginForm"
      :rules="loginRules"
      label-placement="top"
      size="large"
      @submit.prevent="handleLogin"
    >
      <n-form-item label="手机号" path="mobile">
        <n-input
          v-model:value="loginForm.mobile"
          inputmode="numeric"
          maxlength="11"
          clearable
          placeholder="请输入用于登录游戏的手机号"
          :disabled="isLoggingIn"
          @update:value="normalizeMobile"
        >
          <template #prefix>
            <n-icon :component="PhonePortraitOutline" />
          </template>
        </n-input>
      </n-form-item>

      <n-form-item label="短信验证码" path="smsCode">
        <div class="verification-row">
          <n-input
            v-model:value="loginForm.smsCode"
            inputmode="numeric"
            maxlength="6"
            clearable
            placeholder="6 位验证码"
            :disabled="isLoggingIn"
            @update:value="normalizeSmsCode"
          >
            <template #prefix>
              <n-icon :component="KeyOutline" />
            </template>
          </n-input>
          <n-button
            type="primary"
            secondary
            :loading="isSendingCode"
            :disabled="countdown > 0 || isLoggingIn"
            @click="sendVerificationCode"
          >
            {{ countdown > 0 ? `${countdown} 秒` : "获取验证码" }}
          </n-button>
        </div>
      </n-form-item>

      <n-button
        type="primary"
        size="large"
        block
        attr-type="submit"
        :loading="isLoggingIn"
        :disabled="isSendingCode"
      >
        <template #icon>
          <n-icon :component="LogInOutline" />
        </template>
        登录并获取角色
      </n-button>
    </n-form>

    <template v-else>
      <n-form :model="importForm" label-placement="top" size="large">
        <n-form-item label="角色命名格式">
          <n-input
            v-model:value="importForm.nameTemplate"
            placeholder="{name}-{index}-{id}"
          />
          <template #feedback>
            支持 {name}、{id}、{index} 和 {server}
          </template>
        </n-form-item>
      </n-form>

      <ServerRoleList
        :data="serverListData"
        server-column-title="区服ID"
        max-height="50vh"
        :page-size="50"
        :show-add-all="true"
        :add-all-loading="isAddingAll"
        @add="addSelectedRole"
        @add-all="addAllRoles"
        @download="handleDownload"
      />

      <div v-if="pendingRoles.length" class="pending-roles">
        <div class="pending-header">
          <h3>待添加角色</h3>
          <n-tag type="success" size="small">{{ pendingRoles.length }} 个</n-tag>
        </div>
        <div class="pending-list">
          <div v-for="role in pendingRoles" :key="role.id" class="pending-role">
            <div>
              <strong>{{ role.name }}</strong>
              <span>{{ role.server }} · 序号 {{ role.roleIndex }}</span>
            </div>
            <n-button
              quaternary
              circle
              type="error"
              title="移除角色"
              @click="removePendingRole(role.id)"
            >
              <template #icon>
                <n-icon :component="TrashOutline" />
              </template>
            </n-button>
          </div>
        </div>
      </div>

      <div class="form-actions">
        <n-button
          type="primary"
          size="large"
          block
          :loading="isImporting"
          :disabled="pendingRoles.length === 0"
          @click="handleImport"
        >
          <template #icon>
            <n-icon :component="CloudUploadOutline" />
          </template>
          添加 {{ pendingRoles.length || "" }} 个 Token
        </n-button>
        <n-button
          secondary
          :disabled="isAddingAll || isImporting"
          @click="resetLogin"
        >
          <template #icon>
            <n-icon :component="RefreshOutline" />
          </template>
          更换手机号
        </n-button>
      </div>
    </template>

    <n-button
      v-if="tokenStore.hasTokens"
      quaternary
      block
      :disabled="isSendingCode || isLoggingIn || isAddingAll || isImporting"
      @click="emit('cancel')"
    >
      取消
    </n-button>
  </div>
</template>

<script lang="ts" setup>
import { computed, onUnmounted, reactive, ref } from "vue";
import {
  CloudUploadOutline,
  KeyOutline,
  LogInOutline,
  PhonePortraitOutline,
  RefreshOutline,
  TrashOutline,
} from "@vicons/ionicons5";
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NTag,
  type FormInst,
  type FormRules,
  useMessage,
} from "naive-ui";
import ServerRoleList from "@/components/ServerRoleList.vue";
import useIndexedDB from "@/hooks/useIndexedDB";
import { useTokenStore } from "@/stores/tokenStore";
import { g_utils } from "@/utils/bonProtocol";
import {
  createHortorLoginBin,
  getOrCreateHortorDeviceProfile,
  isValidChineseMobile,
  isValidSmsCode,
  loginWithMobileCode,
  requestMobileVerificationCode,
} from "@/utils/hortorLogin";
import { decodeServerRoleId, formatImportedRoleName } from "@/utils/serverRole";
import { getServerList, getTokenId, transformToken } from "@/utils/token";

interface ServerRole {
  name?: string;
  roleId: string | number;
  serverId: string | number;
  power?: number;
}

interface PendingRole {
  id: string;
  name: string;
  roleId: string | number;
  serverId: string | number;
  token: string;
  server: string;
  roleIndex: number;
  wsUrl: string;
  importMethod: "mobile";
}

const emit = defineEmits(["cancel", "ok"]);
const tokenStore = useTokenStore();
const message = useMessage();
const { storeArrayBuffer } = useIndexedDB();
const deviceProfile = getOrCreateHortorDeviceProfile();

const loginFormRef = ref<FormInst | null>(null);
const loginForm = reactive({ mobile: "", smsCode: "" });
const importForm = reactive({ nameTemplate: "{name}-{index}-{id}" });
const isSendingCode = ref(false);
const isLoggingIn = ref(false);
const isAddingAll = ref(false);
const isImporting = ref(false);
const countdown = ref(0);
const statusMessage = ref("");
const statusType = ref<"info" | "success" | "warning" | "error">("info");
const serverListData = ref<ServerRole[]>([]);
const pendingRoles = ref<PendingRole[]>([]);
const originalBinData = ref<Record<string, unknown> | null>(null);
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let requestController: AbortController | null = null;

const currentStep = computed(() => {
  if (serverListData.value.length === 0) return 1;
  return pendingRoles.value.length > 0 ? 3 : 2;
});

const loginRules: FormRules = {
  mobile: [
    {
      validator: (_rule, value) => isValidChineseMobile(String(value)),
      message: "请输入正确的 11 位手机号",
      trigger: ["input", "blur"],
    },
  ],
  smsCode: [
    {
      validator: (_rule, value) => isValidSmsCode(String(value)),
      message: "请输入 6 位短信验证码",
      trigger: ["input", "blur"],
    },
  ],
};

const normalizeMobile = (value: string) => {
  loginForm.mobile = value.replace(/\D/g, "").slice(0, 11);
};

const normalizeSmsCode = (value: string) => {
  loginForm.smsCode = value.replace(/\D/g, "").slice(0, 6);
};

const showStatus = (
  text: string,
  type: "info" | "success" | "warning" | "error" = "info",
) => {
  statusMessage.value = text;
  statusType.value = type;
};

const stopCountdown = () => {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
};

const startCountdown = (seconds: number) => {
  stopCountdown();
  countdown.value = seconds;
  countdownTimer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) {
      countdown.value = 0;
      stopCountdown();
    }
  }, 1000);
};

const sendVerificationCode = async () => {
  if (!isValidChineseMobile(loginForm.mobile)) {
    showStatus("请输入正确的 11 位手机号", "warning");
    await loginFormRef.value?.validate(undefined, (rule) => rule?.key === "mobile");
    return;
  }

  isSendingCode.value = true;
  requestController?.abort();
  requestController = new AbortController();
  try {
    const result = await requestMobileVerificationCode(
      loginForm.mobile,
      deviceProfile,
      { signal: requestController.signal },
    );
    startCountdown(result.waitSecond);
    showStatus(result.message, "success");
    message.success("验证码已发送");
  } catch (error: any) {
    if (error?.name !== "AbortError") {
      showStatus(error?.message || "验证码发送失败", "error");
    }
  } finally {
    isSendingCode.value = false;
  }
};

const handleLogin = async () => {
  try {
    await loginFormRef.value?.validate();
  } catch {
    return;
  }

  isLoggingIn.value = true;
  requestController?.abort();
  requestController = new AbortController();
  showStatus("正在验证并获取角色...", "info");
  try {
    const { combUser } = await loginWithMobileCode(
      loginForm.mobile,
      loginForm.smsCode,
      deviceProfile,
      { signal: requestController.signal },
    );
    const loginBin = createHortorLoginBin(combUser, deviceProfile);
    const parsed = g_utils.parse(loginBin.slice(0));
    originalBinData.value = { ...(parsed as any)._raw };

    const listText = await getServerList(loginBin);
    const parsedList = JSON.parse(listText);
    serverListData.value = Object.values(parsedList || {}).sort(
      (left: any, right: any) => Number(right.power || 0) - Number(left.power || 0),
    ) as ServerRole[];

    if (serverListData.value.length === 0) {
      throw new Error("该手机号下没有可用角色");
    }

    loginForm.smsCode = "";
    showStatus(
      `登录成功，共找到 ${serverListData.value.length} 个角色`,
      "success",
    );
  } catch (error: any) {
    if (error?.name !== "AbortError") {
      showStatus(error?.message || "手机号登录失败", "error");
    }
  } finally {
    isLoggingIn.value = false;
  }
};

const createRoleBin = (serverId: string | number) => {
  if (!originalBinData.value) throw new Error("登录数据已失效，请重新登录");
  return g_utils.encode({ ...originalBinData.value, serverId }, "lx") as ArrayBuffer;
};

const addSelectedRole = async (
  roleInfo: ServerRole,
  showMessage = true,
): Promise<boolean> => {
  if (
    pendingRoles.value.some(
      (role) => String(role.roleId) === String(roleInfo.roleId),
    )
  ) {
    if (showMessage) message.warning("该角色已在待添加列表中");
    return false;
  }

  try {
    const roleBin = createRoleBin(roleInfo.serverId);
    const tokenId = getTokenId(roleBin);
    const roleToken = await transformToken(roleBin);
    const saved = await storeArrayBuffer(tokenId, roleBin, {
      importMethod: "mobile",
      roleId: String(roleInfo.roleId),
    });
    if (!saved) throw new Error("保存登录数据失败，请检查浏览器存储权限");

    const { serverNumber, roleIndex } = decodeServerRoleId(roleInfo.serverId);
    pendingRoles.value.push({
      id: tokenId,
      roleId: roleInfo.roleId,
      serverId: roleInfo.serverId,
      token: roleToken,
      name: formatImportedRoleName(importForm.nameTemplate, roleInfo),
      server: `${serverNumber}服`,
      roleIndex,
      wsUrl: "",
      importMethod: "mobile",
    });

    if (showMessage) message.success("角色已加入待添加列表");
    return true;
  } catch (error: any) {
    if (showMessage) message.error(error?.message || "角色添加失败");
    return false;
  }
};

const addAllRoles = async () => {
  if (isAddingAll.value) return;
  isAddingAll.value = true;
  let addedCount = 0;
  try {
    for (const role of serverListData.value) {
      if (await addSelectedRole(role, false)) addedCount += 1;
    }
    if (addedCount > 0) {
      message.success(`已加入 ${addedCount} 个角色`);
    } else {
      message.warning("没有新的角色可添加");
    }
  } finally {
    isAddingAll.value = false;
  }
};

const removePendingRole = (tokenId: string) => {
  pendingRoles.value = pendingRoles.value.filter((role) => role.id !== tokenId);
};

const handleDownload = (roleInfo: ServerRole) => {
  try {
    const roleBin = createRoleBin(roleInfo.serverId);
    const { serverNumber, roleIndex } = decodeServerRoleId(roleInfo.serverId);
    const safeName = String(roleInfo.name || "未命名角色").replace(
      /[\\/:*?"<>|]/g,
      "_",
    );
    const fileName = `bin-${serverNumber}服-${roleIndex}-${roleInfo.roleId}-${safeName}.bin`;
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(roleBin)], { type: "application/octet-stream" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error: any) {
    message.error(error?.message || "下载失败");
  }
};

const handleImport = async () => {
  if (pendingRoles.value.length === 0) return;
  isImporting.value = true;
  try {
    for (const role of pendingRoles.value) {
      const existing = tokenStore.gameTokens.find((token) => token.id === role.id);
      if (existing) tokenStore.updateToken(existing.id, { ...role });
      else tokenStore.addToken({ ...role });
    }
    const importedCount = pendingRoles.value.length;
    pendingRoles.value = [];
    showStatus(`已添加 ${importedCount} 个 Token`, "success");
    message.success(`成功添加 ${importedCount} 个 Token`);
    emit("ok");
  } finally {
    isImporting.value = false;
  }
};

const resetLogin = () => {
  requestController?.abort();
  stopCountdown();
  countdown.value = 0;
  loginForm.mobile = "";
  loginForm.smsCode = "";
  serverListData.value = [];
  pendingRoles.value = [];
  originalBinData.value = null;
  statusMessage.value = "";
};

onUnmounted(() => {
  requestController?.abort();
  stopCountdown();
  loginForm.mobile = "";
  loginForm.smsCode = "";
});
</script>

<style scoped lang="scss">
.mobile-login-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg, 20px);
  padding: var(--spacing-md, 12px) 0;
}

.login-status {
  display: grid;
  grid-template-columns: auto minmax(24px, 1fr) auto minmax(24px, 1fr) auto;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

.step {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  color: var(--text-tertiary);
  white-space: nowrap;
}

.step span {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--border-light);
  border-radius: 50%;
  font-size: 12px;
}

.step strong {
  font-size: var(--font-size-sm, 12px);
  font-weight: 500;
}

.step.active {
  color: var(--primary-color);
}

.step.active span {
  color: #fff;
  border-color: var(--primary-color);
  background: var(--primary-color);
}

.step-line {
  height: 1px;
  background: var(--border-light);
}

.verification-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 128px;
  gap: var(--spacing-sm, 8px);
  width: 100%;
}

.pending-roles {
  border-top: 1px solid var(--border-light);
  padding-top: var(--spacing-md, 12px);
}

.pending-header,
.pending-role {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md, 12px);
}

.pending-header h3 {
  margin: 0;
  font-size: var(--font-size-md, 14px);
}

.pending-list {
  display: grid;
  gap: var(--spacing-sm, 8px);
  margin-top: var(--spacing-sm, 8px);
  max-height: 180px;
  overflow-y: auto;
}

.pending-role {
  padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
  border: 1px solid var(--border-light);
  border-radius: var(--border-radius-medium, 8px);
  background: var(--bg-tertiary);
}

.pending-role div {
  min-width: 0;
}

.pending-role strong,
.pending-role span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pending-role span {
  margin-top: 2px;
  color: var(--text-secondary);
  font-size: var(--font-size-sm, 12px);
}

.form-actions {
  display: grid;
  gap: var(--spacing-sm, 8px);
}

@media (max-width: 560px) {
  .login-status {
    gap: 4px;
  }

  .step {
    flex-direction: column;
  }

  .step strong {
    font-size: 11px;
  }

  .verification-row {
    grid-template-columns: minmax(0, 1fr) 112px;
  }
}
</style>
