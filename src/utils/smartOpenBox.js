/**
 * 智能开箱核心逻辑（每日任务7「开启3次宝箱」）
 *
 * 规则：
 * - 方案1（钻石优先）：若 钻石宝箱数量 + 宝箱积分/500 >= 3，
 *   先用积分兑换补足到3个钻石宝箱（每轮第9档必得钻石），再打开
 * - 方案2（回退）：打开10个木质宝箱
 *
 * 宝箱积分兑换：一轮共9档，成本依次为 [10,20,30,40,80,100,70,50,100]（合计500分），
 * 每次调用 item_claimboxpointreward（空参数）兑换一档，索引8（第9档）必得钻石宝箱(2005)。
 * role.boxPointLastReward 为下一档索引（0~8，一轮兑完自动归0）。
 */

export const BOX_POINT_STEP_COSTS = [10, 20, 30, 40, 80, 100, 70, 50, 100];

const DIAMOND_BOX_ID = 2005;
const WOODEN_BOX_ID = 2001;
const ROUND_TOTAL_COST = 500;
const TARGET_DIAMONDS = 3;
// 兑换安全阀：3个钻石最多需要约3轮=27次兑换
const MAX_CLAIM_COUNT = 30;

const BOX_NAMES = {
  2001: "木质宝箱",
  2002: "青铜宝箱",
  2003: "黄金宝箱",
  2004: "铂金宝箱",
  2005: "钻石宝箱",
};

// 汇总开箱/兑换响应中的 reward 数组为可读文本
const summarizeRewards = (rewards) => {
  if (!Array.isArray(rewards) || rewards.length === 0) return "无奖励";
  const diamondTotal = rewards
    .filter((r) => r.type === 2)
    .reduce((sum, r) => sum + (r.value || 0), 0);
  const itemCounts = {};
  rewards
    .filter((r) => r.type === 3 && r.itemId)
    .forEach((r) => {
      itemCounts[r.itemId] = (itemCounts[r.itemId] || 0) + (r.value || 0);
    });
  const parts = [];
  if (diamondTotal > 0) parts.push(`钻石×${diamondTotal}`);
  for (const [itemId, count] of Object.entries(itemCounts)) {
    parts.push(`${BOX_NAMES[itemId] || `道具${itemId}`}×${count}`);
  }
  return parts.length > 0 ? parts.join(", ") : "无奖励";
};

/**
 * 执行智能开箱
 * @param {Object} options
 * @param {() => Promise<Object>} options.getRoleInfo - 获取最新角色数据（返回 role 对象）
 * @param {(cmd: string, params: Object, description?: string) => Promise<Object>} options.sendCommand - 发送游戏命令
 * @param {(message: string, type?: string) => void} options.log - 输出日志
 * @returns {Promise<{skipped?: boolean, plan?: number}>}
 */
export async function executeSmartOpenBox({ getRoleInfo, sendCommand, log }) {
  log("=== 智能开箱开始 ===");
  const role = await getRoleInfo();

  let diamonds = role?.items?.[DIAMOND_BOX_ID]?.quantity ?? 0;
  let boxPoint = role?.boxPoint ?? 0;
  let pos = role?.boxPointLastReward ?? 0; // 下一档索引（0~8）
  const taskProgress = role?.dailyTask?.complete?.[7];

  log(
    `当前状态: 钻石宝箱=${diamonds}个, 宝箱积分=${boxPoint}分, 本轮兑换进度=${pos}/9, 任务7进度=${taskProgress ?? 0}`,
  );

  // 任务7进度已达标（开启满3次），无需再开箱（积分奖励由其他任务领取）
  if (
    taskProgress === -1 ||
    (typeof taskProgress === "number" && taskProgress >= 3)
  ) {
    log("任务7「开启3次宝箱」已完成，跳过开箱", "success");
    return { skipped: true };
  }

  const rounds = Math.floor(boxPoint / ROUND_TOTAL_COST);
  log(
    `判定: 钻石宝箱${diamonds} + 积分可兑换${rounds}个 (积分${boxPoint}/500) ${diamonds + rounds >= TARGET_DIAMONDS ? ">=" : "<"} 3`,
  );

  if (diamonds + rounds >= TARGET_DIAMONDS) {
    // ---- 方案1：钻石开箱 ----
    log(`采用方案1: 智能钻石开箱`, "success");

    // 兑换阶段：补足到3个钻石宝箱
    let claimCount = 0;
    while (diamonds < TARGET_DIAMONDS && claimCount < MAX_CLAIM_COUNT) {
      const stepIndex = pos; // 本次兑换的档位（0~8）
      if (stepIndex < 0 || stepIndex >= BOX_POINT_STEP_COSTS.length) {
        log(`兑换进度异常(pos=${stepIndex})，停止兑换`, "warning");
        break;
      }
      const cost = BOX_POINT_STEP_COSTS[stepIndex];
      claimCount++;
      try {
        const resp = await sendCommand(
          "item_claimboxpointreward",
          {},
          `宝箱积分兑换第${stepIndex + 1}/9档(消耗${cost}分)`,
        );
        const respRole = resp?.role ?? {};
        const rewards = resp?.reward ?? [];
        if (typeof respRole.boxPoint === "number") {
          boxPoint = respRole.boxPoint;
        }
        if (typeof respRole.boxPointLastReward === "number") {
          pos = respRole.boxPointLastReward;
        }
        if (rewards.some((r) => r.itemId === DIAMOND_BOX_ID)) {
          diamonds++;
        }
        log(
          `兑换第${stepIndex + 1}/9档(消耗${cost}分): 获得[${summarizeRewards(rewards)}], 剩余积分${boxPoint}, 钻石宝箱${diamonds}/${TARGET_DIAMONDS}`,
        );
      } catch (error) {
        // 兑换失败（如积分不足）：停止兑换，用当前钻石数继续判定
        log(`兑换第${stepIndex + 1}/9档失败: ${error.message}，停止兑换`, "warning");
        break;
      }
    }

    if (claimCount >= MAX_CLAIM_COUNT) {
      log(`兑换次数超过安全上限${MAX_CLAIM_COUNT}，停止兑换`, "warning");
    }

    if (diamonds >= TARGET_DIAMONDS) {
      // 开箱阶段：不足10个全开；满10个按游戏规则开10个
      const openCount = diamonds >= 10 ? 10 : diamonds;
      log(`准备打开${openCount}个钻石宝箱 (库存${diamonds}个)`);
      const openResp = await sendCommand(
        "item_openbox",
        { itemId: DIAMOND_BOX_ID, number: openCount },
        `打开${openCount}个钻石宝箱`,
      );
      log(
        `钻石开箱完成: 打开${openCount}个, 获得[${summarizeRewards(openResp?.reward)}]`,
        "success",
      );
      return { plan: 1 };
    }

    // 兑换后钻石仍不足，回退木质方案
    log(
      `兑换后钻石宝箱仅${diamonds}个，回退到方案2（木质宝箱）`,
      "warning",
    );
  }

  // ---- 方案2：木质宝箱（回退方案） ----
  const woodenCount = role?.items?.[WOODEN_BOX_ID]?.quantity ?? 0;
  log(
    `采用方案2: 打开10个木质宝箱 (木质宝箱库存${woodenCount}个, 钻石宝箱${diamonds}个, 积分${boxPoint}分)`,
  );
  const openResp = await sendCommand(
    "item_openbox",
    { itemId: WOODEN_BOX_ID, number: 10 },
    "打开10个木质宝箱",
  );
  log(
    `木质开箱完成: 获得[${summarizeRewards(openResp?.reward)}]`,
    "success",
  );
  return { plan: 2 };
}
