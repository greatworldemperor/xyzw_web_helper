import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useTokenStore } from "@/stores/tokenStore";
import { LegionWarSession, buildLegionWarUrl } from "@/utils/legionWarSession";
import {
  roleIdToCid,
  cidToRoleId,
  getTeamMemberCids,
  getRole,
  getActivityWindow,
  summarizeSnapshot,
} from "@/utils/legionWarState";
import { extractValidData } from "@/utils/legionWar";
import { getCurrentTimeByFormat } from "@/utils/DateTimeUtils";

/**
 * 盐场（战地）单连接状态。
 *
 * 注意区分两个使用场景：
 *   1) 本 store —— 服务于 /admin/legion-war 只读页，**只维护一条连接**（当前选中的 token）
 *   2) 自动化编排 —— 每支队伍各自一条连接，见 src/utils/batch/tasksSaltField.js + LegionWarSession
 *
 * 之所以不能共用一条连接：roleMap 是按「连接所属俱乐部」下发的
 * （见 docs/saltfield-auto-ui-design.md §1.5），一个连接只覆盖它自己俱乐部的成员。
 */
export const useLegionWarStore = defineStore("legionWar", () => {
  const tokenStore = useTokenStore();

  // 状态
  const isConnected = ref(false);
  const connecting = ref(false);
  const battlefieldId = ref(null);
  const validData = ref(null);
  const legionDetails = ref({});
  const lastUpdateTime = ref("");
  const isJoined = ref(false); // 是否已进入战场

  // 战场原始状态（由 LegionWarSession 维护，含 roleMap / roles / teamMap / constant）
  const battlefieldState = ref(null);
  const stateVersion = ref(0); // 用于驱动依赖战场状态的 computed

  // 引用计数，用于管理连接生命周期
  const subscriberCount = ref(0);
  let disconnectTimer = null;

  // 会话实例（一条连接）
  let session = null;

  // 对外暴露的战场派生数据
  const roleMap = computed(() => {
    void stateVersion.value;
    return battlefieldState.value?.roleMap || {};
  });
  const roleCodeId = computed(() => {
    void stateVersion.value;
    return battlefieldState.value?.roleCodeId ?? null;
  });
  const battlefieldRoles = computed(() => {
    void stateVersion.value;
    return battlefieldState.value?.roles || {};
  });
  const teamMap = computed(() => {
    void stateVersion.value;
    return battlefieldState.value?.teamMap || {};
  });
  const battlefieldConstant = computed(() => {
    void stateVersion.value;
    return battlefieldState.value?.constant || {};
  });
  const battlefieldMeta = computed(() => {
    void stateVersion.value;
    return battlefieldState.value?.meta || {};
  });
  const activityWindow = computed(() => {
    void stateVersion.value;
    return getActivityWindow(battlefieldState.value || {});
  });
  const stateSummary = computed(() => {
    void stateVersion.value;
    return battlefieldState.value ? summarizeSnapshot(battlefieldState.value) : null;
  });

  /** roleId -> 战场 cId */
  const cidOfRoleId = (roleId) =>
    battlefieldState.value ? roleIdToCid(battlefieldState.value, roleId) : null;

  /** 战场 cId -> roleId */
  const roleIdOfCid = (cid) =>
    battlefieldState.value ? cidToRoleId(battlefieldState.value, cid) : null;

  /** 自己队伍的成员 cId */
  const myTeamMemberCids = () =>
    battlefieldState.value ? getTeamMemberCids(battlefieldState.value, roleCodeId.value) : [];

  /** 取某个战场角色的当前状态 */
  const roleAt = (cid) => (battlefieldState.value ? getRole(battlefieldState.value, cid) : null);

  const _pushStateVersion = () => {
    stateVersion.value += 1;
  };

  // 连接 WebSocket
  const connect = async () => {
    subscriberCount.value++;

    // 如果有待执行的断开操作，取消它
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }

    if (!tokenStore.selectedToken) {
      subscriberCount.value--;
      throw new Error("请先选择一个Token");
    }

    if (isConnected.value) {
      // 已连接但还没进战场，补一次进入
      if (!isJoined.value && !connecting.value) {
        tryJoinBattlefield();
      }
      return;
    }

    if (connecting.value) {
      return; // 正在连接中
    }

    connecting.value = true;
    try {
      const tokenId = tokenStore.selectedToken.id;

      // 1. 取战场元信息（sid 是一次性票据，每次连接前都要重新取）
      const getbattlefield = await tokenStore.sendMessageWithPromise(
        tokenId,
        "legion_getbattlefield",
        {},
        10000,
      );

      if (!getbattlefield || !getbattlefield.info) {
        throw new Error("无法获取战场信息");
      }

      battlefieldId.value = getbattlefield.info.battlefieldId;

      // 2. 建立战场专用连接
      session = new LegionWarSession({
        url: buildLegionWarUrl(tokenStore.selectedToken.token, getbattlefield.info.sid),
        battlefieldId: battlefieldId.value,
        heartbeatMs: 5000,
        onFrame: (msg) => {
          // 只读页需要的最简数据仍走原有提取逻辑
          if ((msg?.cmd || "").includes("war_getbattlefieldinfo")) {
            const extracted = extractValidData(msg.rawData);
            if (extracted) {
              validData.value = extracted;
              lastUpdateTime.value = getCurrentTimeByFormat("HH:mm:ss");

              Object.values(extracted.legionInfo || {}).forEach((legion) => {
                if (!legionDetails.value[legion.id]) {
                  fetchLegionDetail(legion.id);
                }
              });
            }
          }
        },
        onUpdate: (state) => {
          battlefieldState.value = state;
          _pushStateVersion();
        },
      });
      // 让首次快照也能被 computed 感知
      battlefieldState.value = session.state;

      session.client.onConnect = () => {
        console.log("战场WebSocket连接成功");
        isConnected.value = true;
        connecting.value = false;

        // 延迟发送进入战场指令
        setTimeout(() => {
          tryJoinBattlefield();
        }, 1000);
      };

      session.client.onDisconnect = (event) => {
        console.log("战场WebSocket断开", event);
        isConnected.value = false;
        isJoined.value = false;
        connecting.value = false;
      };

      session.client.onError = (error) => {
        console.error("战场WebSocket错误", error);
        isConnected.value = false;
        isJoined.value = false;
        connecting.value = false;
      };

      await session.init();
    } catch (error) {
      console.error("连接失败:", error);
      connecting.value = false;
      subscriberCount.value--; // 连接失败，回滚计数
      throw error;
    }
  };

  const tryJoinBattlefield = () => {
    if (session && isConnected.value) {
      session.enterBattlefield().catch((e) => {
        console.warn("进入战场失败", e?.message || e);
      });
      isJoined.value = true;

      // 主动请求一次快照
      refreshData();
    }
  };

  const disconnect = (force = false) => {
    if (subscriberCount.value > 0) {
      subscriberCount.value--;
    }

    if (force) {
      subscriberCount.value = 0;
      performDisconnect();
    } else if (subscriberCount.value <= 0) {
      // 延迟断开，防止页面切换时频繁断连
      if (disconnectTimer) clearTimeout(disconnectTimer);

      disconnectTimer = setTimeout(() => {
        if (subscriberCount.value <= 0) {
          performDisconnect();
        }
      }, 3000); // 3秒缓冲期
    }
  };

  const performDisconnect = () => {
    if (session) {
      session.close();
      session = null;
    }
    isConnected.value = false;
    isJoined.value = false;
    connecting.value = false;
    battlefieldId.value = null;
    battlefieldState.value = null;
    _pushStateVersion();
    disconnectTimer = null;
  };

  const refreshData = () => {
    if (!isConnected.value || !session) {
      console.warn("请先连接到战场");
      return;
    }

    if (!battlefieldId.value) {
      console.warn("未获取到战场ID");
      return;
    }

    session.client.send("war_getbattlefieldinfo", {
      battlefieldId: battlefieldId.value,
    });
  };

  /* ------------------------- 战场动作（供手动/调试用） ------------------------- */

  /** 选阵容（布阵） */
  const setBattleTeam = async ({ battleTeam, lordWeaponId, petUId }, timeoutMs) => {
    if (!session) throw new Error("战场未连接");
    return session.setBattleTeam({ battleTeam, lordWeaponId, petUId }, timeoutMs);
  };

  /** 登场 */
  const deploy = async ({ battleTeam, lordWeaponId, petUId }, timeoutMs) => {
    if (!session) throw new Error("战场未连接");
    return session.deploy({ battleTeam, lordWeaponId, petUId }, timeoutMs);
  };

  /** 邀请组队（targetCodeId 为战场 cId） */
  const inviteJoinTeam = async (targetCodeId, timeoutMs) => {
    if (!session) throw new Error("战场未连接");
    return session.inviteJoinTeam(targetCodeId, timeoutMs);
  };

  const fetchLegionDetail = async (legionId) => {
    if (!tokenStore.selectedToken) return;
    try {
      const response = await tokenStore.sendMessageWithPromise(
        tokenStore.selectedToken.id,
        "legion_getinfobyid",
        { legionId: legionId },
      );

      if (response && (response.legionData || response.info)) {
        legionDetails.value[legionId] = response.legionData || response.info;
      }
    } catch (error) {
      console.error(`获取俱乐部[${legionId}]详情失败`, error);
    }
  };

  return {
    // State
    isConnected,
    connecting,
    battlefieldId,
    validData,
    legionDetails,
    lastUpdateTime,
    isJoined,

    // 战场原始状态（roleMap / roles / teamMap / constant / meta）
    battlefieldState,
    roleMap,
    roleCodeId,
    battlefieldRoles,
    teamMap,
    battlefieldConstant,
    battlefieldMeta,
    activityWindow,
    stateSummary,

    // 派生查询
    cidOfRoleId,
    roleIdOfCid,
    myTeamMemberCids,
    roleAt,

    // Actions
    connect,
    disconnect,
    refreshData,
    fetchLegionDetail,
    setBattleTeam,
    deploy,
    inviteJoinTeam,
  };
});
