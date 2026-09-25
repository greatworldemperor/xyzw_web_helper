/**
 * 金鱼（秋季活动 autumn_*）批量任务
 *
 * 协议来源：`local-data/goldenfish/use_one_item.jsonl`（2026-09-25 抓包，wss://xxz-xyzw.hortorgames.com/agent）
 *
 * 抓包结论：
 *   - 投一个道具：`autumn_useitem { itemNum: 1 }`（请求体只有数量，服务端自动扣道具）
 *   - 响应 `Autumn_UseItemResp`：
 *       reward: [{ type, itemId, value, ext }]        —— 本次投掷奖励
 *       roleAutumn: { areaId, itemNum, distance, lastUseItemTime, lastUseItemNum, ... }
 *                                                    —— 投掷后进度（distance = 前进距离）
 *       role.items: { "1006": { quantity }, ... }     —— 道具余额快照
 *   - 排行榜：`autumn_getrolerank {}` → `Autumn_GetRoleRankResp`（本次任务用不到）
 *
 * 商店购物列表（09-25 抓包 `local-data/goldenfish/shop_list.jsonl`，master 逐字节验证）：
 *   - 读：`store_getpurchase {}` → `Store_GetPurchaseResp { purchaseCnt, purchaseItemList }`
 *   - 写：`store_setpurchase { purchaseCnt, purchaseItemList: [{ itemId, discount }] }`
 *     响应回显设置后的列表（按 itemId 升序）；discount = 折扣阈值（整数折，10 = 原价），
 *     商店刷新出 ≤ 阈值的折扣时服务端自动购买。
 *   - `purchaseCnt` = 游戏里的「刷新次数」（09-25 晚 master 口径确认，抓包 15）；
 *     优先用页面配置值，未配置沿用服务端现值，最后兜底 15。
 *
 * 设计要点（与 tasksXiaoyaojin 一致）：
 * - 每次调用每账号只投 1 个道具（与抓包逐字节一致），道具不足 / 活动未开都是「正常结束」；
 * - 已知限流码 400340：不是失败，是「这次别连发了」。
 */

const nowText = () => new Date().toLocaleTimeString();

/** 「金鱼模式」默认购物列表（09-25 master 口径，抓包 store_setpurchase 验证） */
export const GOLDENFISH_SHOP_DEFAULTS = [
  { itemId: 2002, name: "青铜宝箱", discount: 5, enabled: true },
  { itemId: 2003, name: "黄金宝箱", discount: 5, enabled: true },
  { itemId: 2004, name: "铂金宝箱", discount: 8, enabled: true },
  { itemId: 1001, name: "招募令", discount: 10, enabled: true },
  { itemId: 1012, name: "黄金鱼竿", discount: 8, enabled: true },
];

/** 抓包默认刷新次数（09-25 master 提交 15，仅作缺失兜底） */
const DEFAULT_PURCHASE_CNT = 15;

/** 刷新次数（purchaseCnt）合法值：正整数（Number(null)===0 陷阱，显式判） */
const normalizePurchaseCnt = (raw) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/**
 * UI 配置 → 请求体 purchaseItemList
 * 只收 1~10 的整数折（10 = 原价）；未启用 / 非法行直接剔除（Number(null)===0 陷阱，显式判）
 */
export const buildShopPurchaseItems = (config) => {
  const list = Array.isArray(config?.items) ? config.items : [];
  const out = [];
  for (const item of list) {
    if (!item?.enabled) continue;
    const itemId = Number(item.itemId);
    const discount = Number(item.discount);
    if (!Number.isInteger(itemId) || itemId <= 0) continue;
    if (!Number.isFinite(discount) || discount < 1 || discount > 10) continue;
    out.push({ itemId, discount: Math.floor(discount) });
  }
  return out;
};

/** 服务端列表 → 可读文案（"2002 5折、1001 10折"） */
const formatPurchaseItems = (list) => {
  if (!Array.isArray(list)) return "";
  return list
    .map((it) => {
      const id = Number(it?.itemId);
      const discount = Number(it?.discount);
      return Number.isInteger(id) && Number.isFinite(discount)
        ? `${id} ${discount}折`
        : "";
    })
    .filter(Boolean)
    .join("、");
};

/** 服务端错误信封 → 判定文本 */
const errorText = (error) =>
  String(error?.error || error?.message || error || "");

/** 活动未开 / 无效参数：提示为主，不算失败 */
const isInactiveError = (error) =>
  /未开启|未开始|已结束|活动不存在|无效的/.test(errorText(error));

/** 道具不足：提示为主 */
const isNoItemError = (error) =>
  /道具不足|数量不足|不足/.test(errorText(error));

/** 服务端限流（沿用项目通用码） */
const isRateLimitError = (error) => Number(error?.code) === 400340;

/** 奖励字段 → 可读文案 */
const rewardText = (response) => {
  const list = Array.isArray(response?.reward) ? response.reward : [];
  if (list.length === 0) return "无奖励";
  return list.map((item) => `itemId ${item.itemId} ×${item.value}`).join("、");
};

export function createTasksGoldenfish(deps) {
  const {
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot,
    connectionQueue,
    batchSettings,
    tokenStore,
    addLog,
    message,
    currentRunningTokenId,
    delayConfig,
  } = deps;

  const actionDelay = () => {
    const raw = Number(delayConfig?.action);
    return Number.isFinite(raw) && raw > 0 ? raw : 300;
  };
  const sleep = (ms = actionDelay()) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  const log = (tokenName, text, type = "info") =>
    addLog({ time: nowText(), message: `${tokenName} ${text}`, type });

  /** 可选数值参数一律显式判空（Number(null)===0 陷阱） */
  const clampCount = (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  };

  /** 道具余额快照 → 可读文案（resp.role.items: { itemId: { quantity } }） */
  const itemsText = (response) => {
    const items = response?.role?.items;
    if (!items || typeof items !== "object") return "";
    const parts = Object.entries(items)
      .map(([id, v]) => `${id}×${Number(v?.quantity)}`)
      .filter((s) => !s.endsWith("×NaN"));
    return parts.length > 0 ? `；余额 ${parts.join(" ")}` : "";
  };

  /** 投 N 个道具：autumn_useitem { itemNum: N }，响应里带回进度/奖励/余额
   *  ⚠️ 抓包只实测过 itemNum:1；N>1 是否单次生效待活动开放时间验证（见 docs 待验证清单） */
  const useOneItem = async ({ tokenId, token, count }) => {
    const n = clampCount(count);
    const response = await tokenStore.sendMessageWithPromise(
      tokenId,
      "autumn_useitem",
      { itemNum: n },
      8000,
    );
    const distance = Number(response?.distance ?? response?.roleAutumn?.distance);
    const areaId = Number(response?.roleAutumn?.areaId);
    const progress =
      Number.isFinite(distance) && distance > 0
        ? `，前进 ${distance} 格` + (Number.isFinite(areaId) ? `（区域 ${areaId}）` : "")
        : "";
    log(
      token.name,
      `投出 ${n} 个道具${progress}（${rewardText(response)}${itemsText(response)}）`,
      "success",
    );
  };

  /** 设置商店购物列表：先读 purchaseCnt 现值，再写 { purchaseCnt, purchaseItemList } */
  const setShopList = async ({ tokenId, token, config }) => {
    const purchaseItemList = buildShopPurchaseItems(config);
    if (purchaseItemList.length === 0) {
      log(token.name, "购物列表为空（全部未启用），跳过", "warning");
      return;
    }

    const current = await tokenStore.sendMessageWithPromise(
      tokenId,
      "store_getpurchase",
      {},
      8000,
    );
    // 刷新次数（purchaseCnt）：页面配置优先 → 服务端现值 → 抓包默认 15（Number(null)===0 陷阱，显式判）
    const wantedCnt = normalizePurchaseCnt(config?.purchaseCnt);
    const purchaseCnt =
      wantedCnt ?? normalizePurchaseCnt(current?.purchaseCnt) ?? DEFAULT_PURCHASE_CNT;
    const oldText = formatPurchaseItems(current?.purchaseItemList);

    const response = await tokenStore.sendMessageWithPromise(
      tokenId,
      "store_setpurchase",
      { purchaseCnt, purchaseItemList },
      8000,
    );

    // 回显比对：列表逐项比对集合 + 刷新次数一致
    const echoed = Array.isArray(response?.purchaseItemList)
      ? response.purchaseItemList
      : [];
    const ok =
      Number(response?.purchaseCnt) === purchaseCnt &&
      echoed.length === purchaseItemList.length &&
      purchaseItemList.every((item) =>
        echoed.some(
          (it) =>
            Number(it?.itemId) === item.itemId &&
            Number(it?.discount) === item.discount,
        ),
      );
    log(
      token.name,
      `商店购物列表${ok ? "已设置" : "已发送（回显不一致，注意核对）"}：` +
        `刷新 ${purchaseCnt} 次；` +
        `${purchaseItemList.map((it) => `${it.itemId} ${it.discount}折`).join("、")}` +
        `（原列表：${oldText || "空"}）`,
      ok ? "success" : "warning",
    );
  };

  const STEPS = { useOneItem, setShopList };

  // ------------------------------------------------------------------ 批量框架

  const runGoldenfish = async (stepIds, title, count = 1, config = null) => {
    if (selectedTokens.value.length === 0) {
      message.warning("请先选择账号");
      return;
    }

    isRunning.value = true;
    shouldStop.value = false;
    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((item) => item.id === tokenId);
      const tokenName = token?.name || tokenId;

      try {
        addLog({
          time: nowText(),
          message: `=== 开始${title}: ${tokenName} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        for (const stepId of stepIds) {
          if (shouldStop.value) break;
          const step = STEPS[stepId];
          if (!step) continue;
          try {
            await step({ tokenId, token, count, config });
          } catch (error) {
            if (isRateLimitError(error)) {
              log(tokenName, `触发限流(400340)，下次再试`, "warning");
              break;
            }
            if (isInactiveError(error)) {
              log(tokenName, `金鱼活动未开启（${errorText(error)}），跳过`, "warning");
              break;
            }
            if (isNoItemError(error)) {
              log(tokenName, `投掷道具不足（${errorText(error)}），跳过`, "warning");
              break;
            }
            throw error;
          }
          await sleep();
        }

        if (tokenStatus.value[tokenId] !== "failed") {
          tokenStatus.value[tokenId] = "completed";
        }
        addLog({
          time: nowText(),
          message: `=== ${tokenName} ${title}结束 ===`,
          type: "success",
        });
      } catch (error) {
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: nowText(),
          message: `${title}失败: ${error?.message || String(error)}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: nowText(),
          message: `${tokenName} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;
    message.success(`${title}结束`);
  };

  const goldenfishUseItem = (count = 1) =>
    runGoldenfish(["useOneItem"], "金鱼投道具", clampCount(count));

  const goldenfishSetShopList = (config) =>
    runGoldenfish(["setShopList"], "金鱼商店购物列表", 1, config);

  return { goldenfishUseItem, goldenfishSetShopList };
}

export default { createTasksGoldenfish };
