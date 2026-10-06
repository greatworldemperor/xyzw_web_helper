<template>
  <!-- 手动输入表单 -->
  <n-form :model="importForm" :label-placement="'top'" :size="'large'" :show-label="true">


    <n-form-item :label="'bin文件'" :show-label="true">
      <a-upload multiple accept="*.bin,*.dmp" @before-upload="uploadBin" draggable dropzone placeholder="粘贴Token字符串..."
        clearable>
        <!-- <div class="dropzone-content">
          请点击上传或将bind文件拖拽到此处
        </div> -->
      </a-upload>
    </n-form-item>

    <n-form-item label="角色命名格式" :show-label="true">
      <n-input v-model:value="importForm.nameTemplate" placeholder="{name}-{index}-{id}" />
      <template #feedback>
        支持变量: {name}角色名, {id}角色ID, {index}角色序号, {server}区服
      </template>
    </n-form-item>

    <ServerRoleList
      :data="serverListData"
      max-height="50vh"
      :page-size="50"
      :show-add-all="true"
      :add-all-loading="isAddingAll"
      @add="addSelectedRole"
      @add-all="addAllRoles"
    />

    <a-list>
      <a-list-item v-for="(role, index) in roleList" :key="index">
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%">
          <div>
            <strong>角色名称:</strong> {{ role.name || "未命名角色" }}<br />
            <strong>Token:</strong>
            <span style="word-break: break-all">{{
              role.token || "导入不预取，使用时自动刷新"
            }}</span><br />
            <strong>服务器:</strong> {{ role.server || "未指定" }}<br />
            <strong>角色序号:</strong> {{ role.roleIndex }}
          </div>
          <n-button type="error" size="small" @click="removeRole(index)">
            删除
          </n-button>
        </div>
      </a-list-item>
    </a-list>

    <div class="form-actions">
      <div class="import-hint">
        角色 Token 不会在导入时获取（生命周期很短），只保存 BIN 数据；首次使用时会自动刷新。
      </div>
      <n-button type="primary" size="large" block :loading="isImporting" @click="handleImport">
        <template #icon>
          <n-icon>
            <CloudUpload />
          </n-icon>
        </template>
        添加Token
      </n-button>

      <n-button v-if="tokenStore.hasTokens" size="large" block @click="cancel">
        取消
      </n-button>
    </div>
  </n-form>
</template>

<script lang="ts" setup>
import { ref, reactive } from "vue";
import { useTokenStore } from "@/stores/tokenStore";
import { CloudUpload } from "@vicons/ionicons5";

import {
  NForm,
  NFormItem,
  NInput,
  NButton,
  NIcon,
  useMessage,
} from "naive-ui";

import PQueue from "p-queue";
import useIndexedDB from "@/hooks/useIndexedDB";
import { getTokenId, getServerList } from "@/utils/token";
import { g_utils } from "@/utils/bonProtocol";
import { getStableTokenKey } from "@/utils/stableTokenKey";

const $emit = defineEmits(["cancel", "ok"]);

const { storeArrayBuffer, getArrayBuffer } = useIndexedDB();

const cancel = () => {
  roleList.value = [];
  $emit("cancel");
};

const removeRole = (index: number) => {
  roleList.value.splice(index, 1);
};

const tokenStore = useTokenStore();
const message = useMessage();
const isImporting = ref(false);
const isAddingAll = ref(false);
const importForm = reactive({
  name: "",
  server: "",
  wsUrl: "",
  importMethod: "",
  nameTemplate: "{name}-{index}-{id}",
});
const roleList = ref<
  Array<{
    id: string;
    name: string;
    roleId: string;
    serverId?: string | number;
    token: string;
    server: string;
    roleIndex?: number;
    wsUrl: string;
    importMethod: "bin";
  }>
>([]);
const serverListData = ref<any[]>([]);
const currentBinData = ref<ArrayBuffer | null>(null);
const binDecodedResult = ref("");
const originalBinData = ref<any>(null);

const tQueue = new PQueue({ concurrency: 1, interval: 1000 });

const addSelectedRole = async (
  roleInfo: any,
  showMessage = true,
): Promise<boolean> => {
  if (!originalBinData.value) {
    message.error("Bin数据丢失，请重新上传");
    return false;
  }

  try {
    const newData = { ...originalBinData.value };
    newData.serverId = roleInfo.serverId; // 确保类型一致
    const newBinBuffer = g_utils.encode(newData) as ArrayBuffer;
    const tokenId = getTokenId(newBinBuffer);
    // role token 生命周期很短，导入时不预取：
    // 这里只保存 BIN（IndexedDB），token 留空，等真正要用的时候再按需刷新
    const roleToken = "";
    const roleName = roleInfo.name || `角色_${roleInfo.roleId}`;

    // 刷新indexDB数据库token数据 (保存原始bin)
    const saved = await storeArrayBuffer(tokenId, newBinBuffer);
    if (!saved) {
      throw new Error("保存BIN数据到IndexedDB失败，请检查浏览器存储空间或权限");
    }

    let sid = Number(roleInfo.serverId);
    let roleIndex = 0;
    if (sid >= 2000000) {
      roleIndex = 2;
      sid -= 2000000;
    } else if (sid >= 1000000) {
      roleIndex = 1;
      sid -= 1000000;
    }
    const serverNum = sid - 27;

    const template = importForm.nameTemplate || "{name}-{index}-{id}";
    const finalName = template
      .replace(/{name}/g, () => roleName)
      .replace(/{index}/g, () => String(roleIndex))
      .replace(/{id}/g, () => String(roleInfo.roleId))
      .replace(/{server}/g, () => String(serverNum) + "服");

    // 检查是否已存在相同配置 (根据角色名称和roleId)
    const exists = roleList.value.some(
      (r) => r.roleId === roleInfo.roleId && r.name === finalName
    );

    if (exists) {
      if (showMessage) {
        message.warning(`角色 ${finalName} 已在待添加列表中`);
      }
      return false;
    }

    roleList.value.push({
      id: tokenId,
      roleId: roleInfo.roleId,
      serverId: roleInfo.serverId,
      token: roleToken,
      name: finalName,
      server: String(serverNum) + "服",
      roleIndex: roleIndex,
      wsUrl: importForm.wsUrl || "",
      importMethod: "bin",
    });

    if (showMessage) {
      message.success(`已添加角色: ${finalName}`);
    }
    return true;

  } catch (e: any) {
    console.error("添加角色失败", e);
    if (showMessage) {
      message.error("添加角色失败: " + e.message);
    }
    return false;
  }
};

const addAllRoles = async () => {
  if (isAddingAll.value) return;

  if (!originalBinData.value) {
    message.error("Bin数据丢失，请重新上传");
    return;
  }

  const roles = [...serverListData.value];
  if (roles.length === 0) {
    message.warning("没有可添加的角色");
    return;
  }

  isAddingAll.value = true;
  let addedCount = 0;

  try {
    for (const role of roles) {
      if (await addSelectedRole(role, false)) {
        addedCount += 1;
      }
    }

    if (addedCount === roles.length) {
      message.success(`已全部添加 ${addedCount} 个角色`);
    } else if (addedCount > 0) {
      message.warning(`已添加 ${addedCount}/${roles.length} 个角色`);
    } else {
      message.warning("没有新的角色可添加");
    }
  } finally {
    isAddingAll.value = false;
  }
};

const uploadBin = (binFile: File) => {
  tQueue.add(async () => {
    console.log("上传文件数据:", binFile);
    const reader = new FileReader();
    reader.onload = async (e) => {
      const userToken = e.target?.result as ArrayBuffer;
      currentBinData.value = userToken;

      // 获取服务器角色列表
      try {
        const listStr = await getServerList(userToken);
        const parsedList = JSON.parse(listStr);
        // 转换为数组
        if (parsedList && typeof parsedList === 'object') {
          serverListData.value = Object.values(parsedList).sort((a: any, b: any) => b.power - a.power);
        } else {
          serverListData.value = [];
        }
        console.log("Server List:", parsedList);
        message.success("获取服务器角色列表成功，请选择角色添加");
      } catch (err) {
        console.error("Failed to get server list", err);
        message.warning("获取服务器角色列表失败，请检查文件是否正确");
        serverListData.value = [];
      }

      // 尝试解析 bin 文件内容
      try {
        const binMsg = g_utils.parse(userToken);
        let binData = binMsg.getData();
        if (!binData && (binMsg as any)._raw) {
          console.log("Bin文件 getData() 为空，尝试使用 _raw");
          binData = { ...(binMsg as any)._raw };
        }

        console.log("Bin文件解析:", binData);
        binDecodedResult.value = JSON.stringify(binData, null, 2);
        originalBinData.value = binData;
      } catch (err: any) {
        console.error("Bin文件解析失败", err);
        binDecodedResult.value = "Bin文件解析失败: " + (err.message || err);
      }
    };
    reader.onerror = () => {
      message.error("读取文件失败，请重试");
    };
    reader.readAsArrayBuffer(binFile);
  });
  return false; // 阻止自动上传
};

const handleImport = async () => {
  if (roleList.value.length === 0) {
    message.error("请先上传bin文件！");
    return;
  }
  /**
   * 查重键 = 稳定键 serverId:roleId（master 2026-10-07 bug 修复）。
   * 旧逻辑按 t.id === role.id 查重，而 token id = bin 内容 MD5——角色重新登录后
   * bin 必变 → MD5 变 → 永远查不到旧记录 → 走 addToken 追加，新老两条并存
   * （蟠桃/盐场里同一个角色出现两份，旧的那份 bin 已过期连不上）。
   * 现在同角色命中旧记录时：保留旧 id 原地更新 → 按 token id 记录的
   * 蟠桃勾选/俱乐部缓存等配置自动接上，不再悬空。
   */
  let addedCount = 0;
  let updatedCount = 0;
  for (const role of roleList.value) {
    const sKey = getStableTokenKey(role.serverId, role.roleId);
    const existing =
      // ① 完全相同的 bin 重复导入（id 相同）→ 原地更新（原有行为）
      tokenStore.gameTokens.find((t) => t.id === role.id) ||
      // ② 同角色的过期 bin（稳定键相同、id 不同）→ 保留旧 id 更新
      (sKey
        ? tokenStore.gameTokens.find(
            (t) => t.id !== role.id && getStableTokenKey(t.serverId, t.roleId) === sKey,
          )
        : undefined);

    if (existing) {
      // 新 bin 已按新 MD5 键存 IndexedDB（addSelectedRole → storeArrayBuffer），
      // 但运行时刷新链路按 token.id 读 bin（tokenStore/gameLauncher）——
      // 补一份按旧 id 键的存储，保证按旧 id 也能读到新 bin
      try {
        if (existing.id !== role.id) {
          const buf = await getArrayBuffer(role.id);
          if (buf) await storeArrayBuffer(existing.id, buf);
        }
      } catch (e) {
        console.warn("补存新 bin 到旧 token id 失败（不影响导入）", e);
      }
      tokenStore.updateToken(existing.id, { ...role, id: existing.id });
      updatedCount++;
    } else {
      tokenStore.addToken({ ...role });
      addedCount++;
    }
  }
  if (updatedCount > 0) {
    message.success(`导入完成：新增 ${addedCount} 个，同角色更新 ${updatedCount} 个（保留原记录）`);
  } else {
    message.success(`Token添加成功（新增 ${addedCount} 个）`);
  }
  roleList.value = [];
  $emit("ok");
};

</script>

<style scoped lang="scss">
.optional-fields {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;

  n-form-item {
    flex: 1;
    min-width: 200px;
  }
}

.form-actions {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.import-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-tertiary, #888);
}

.dropzone-content {
  width: 100%;
  border: 1px dashed #fcc;
  border-radius: 8px;
  text-align: center;
  color: #888;
  padding: 40px 20px;
  font-size: 12px;
}
</style>
