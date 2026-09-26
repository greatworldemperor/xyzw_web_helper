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

// ------------------------------------------------------------------ 金鱼号检测

/** 固定分组名：检测达标的账号统一进这个组，后续金鱼任务基于它执行 */
export const GOLDENFISH_GROUP_NAME = "金鱼组";
/** 金鱼组例外（排除）server id 默认值 */
export const DEFAULT_GOLDENFISH_EXCLUDE_SERVERS = "9724, 9736, 26501";
/** 金鱼组颜色（分组标签用） */
const GOLDENFISH_GROUP_COLOR = "#f5a623";

/** 达标阈值与折算（09-26 master 口径） */
export const GOLDENFISH_CHECK_RULES = {
  recruitMin: 3000, // 招募令（itemId 1001）
  rodUnit: 600, // 1 根黄金鱼竿折算的金砖
  diamondPlusRodMin: 640000, // 金砖 + 黄金鱼竿×600
  boxPointMin: 30000, // 有效宝箱积分
  /** 有效宝箱积分 = 未兑换积分×0.52 + 各宝箱可兑换积分之和 */
  boxPointFactor: 0.52,
  /** 各宝箱单个可兑换积分（itemId → 积分；钻石宝箱没有积分） */
  chestPoints: { 2001: 1, 2002: 10, 2003: 20, 2004: 50, 2005: 0 },
};

const ITEM_RECRUIT = 1001; // 招募令
const ITEM_GOLD_ROD = 1012; // 黄金鱼竿

/** 例外 server id 文本 → Set（支持中英文逗号/分号/空格/换行分隔） */
export const parseServerIdList = (raw) => {
  const text = Array.isArray(raw)
    ? raw.join(",")
    : typeof raw === "string"
      ? raw
      : String(raw ?? "");
  return new Set(
    text
      .split(/[,，;；\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
};

const normalizeServerId = (value) => {
  const text = String(value ?? "").trim();
  return text === "" || text === "undefined" || text === "null" ? "" : text;
};

const fmtNum = (value) => (Number(value) || 0).toLocaleString("zh-CN");

/** 从 role.items 里取道具数量：兼容数组 / { itemId: { quantity } } / { itemId: num } */
const readItemCount = (items, itemId) => {
  if (!items) return 0;
  if (Array.isArray(items)) {
    const found = items.find(
      (it) => Number(it?.id ?? it?.itemId) === Number(itemId),
    );
    if (!found) return 0;
    return Number(found.num ?? found.count ?? found.quantity ?? 0) || 0;
  }
  if (typeof items !== "object") return 0;
  const node = items[String(itemId)] ?? items[itemId];
  const pick = (entry) => {
    if (entry == null) return 0;
    if (typeof entry === "number") return Number(entry) || 0;
    if (typeof entry === "object")
      return Number(entry.num ?? entry.count ?? entry.quantity ?? 0) || 0;
    return Number(entry) || 0;
  };
  if (node == null) {
    const match = Object.values(items).find(
      (entry) => Number(entry?.itemId ?? entry?.id) === Number(itemId),
    );
    return pick(match);
  }
  return pick(node);
};

/** role_getroleinfo 响应 → role 对象 */
const extractRole = (response) =>
  response?.role || response?.body?.role || response?.body || response || {};

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
    sendRoleInfo: batchSendRoleInfo,
    addLog,
    message,
    currentRunningTokenId,
    delayConfig,
  } = deps;

  /** 取角色信息（批量页注入的带限流重试版本优先） */
  const sendRoleInfoRef =
    batchSendRoleInfo ||
    ((tokenId, params = {}, timeout = 15000) =>
      tokenStore.sendMessageWithPromise(
        tokenId,
        "role_getroleinfo",
        params,
        timeout,
      ));

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

  // ---------------------------------------------------------------- 金鱼号检测

  /** tokenStore.tokenGroups 兼容取值（Pinia 解包后是数组） */
  const readGroups = () => {
    const groups = tokenStore?.tokenGroups;
    if (Array.isArray(groups)) return groups;
    if (Array.isArray(groups?.value)) return groups.value;
    return [];
  };

  /**
   * 检测达标账号并同步「金鱼组」
   * 合并语义：只把本次达标的账号加进组，老成员一律保留
   * （本次不达标 / 例外服 / 检测失败都不会被移出）。
   * 想全量重建：在「管理分组」里删掉「金鱼组」再重新检测即可。
   */
  const syncGoldenfishGroup = (summary) => {
    const groups = readGroups();
    let group = groups.find((item) => item?.name === GOLDENFISH_GROUP_NAME);

    if (!group && summary.qualified.length > 0) {
      group = tokenStore.createTokenGroup(
        GOLDENFISH_GROUP_NAME,
        GOLDENFISH_GROUP_COLOR,
      );
      addLog?.({
        time: nowText(),
        message: `已新建分组「${GOLDENFISH_GROUP_NAME}」`,
        type: "success",
      });
    }
    if (!group) {
      summary.groupName = GOLDENFISH_GROUP_NAME;
      summary.groupSize = 0;
      return summary;
    }

    const groupId = group.id;
    const oldSize = (group.tokenKeys || []).length;
    summary.qualified.forEach((row) => {
      tokenStore.addTokenToGroup(groupId, row.tokenId);
    });

    summary.groupName = GOLDENFISH_GROUP_NAME;
    summary.groupSize = (
      tokenStore.getGroupTokenIds?.(groupId) || []
    ).length;
    addLog?.({
      time: nowText(),
      message: `「${GOLDENFISH_GROUP_NAME}」合并完成：本次达标 ${summary.qualified.length} 个，${oldSize} → ${summary.groupSize} 个（合并模式，老成员保留；全量重建请先在管理分组里删除本组）`,
      type: "success",
    });
    return summary;
  };

  /**
   * 检测金鱼号：招募令 ≥ 3000；金砖 + 黄金鱼竿×600 ≥ 640000；宝箱积分 ≥ 30000
   * @param {{ excludeServers?: string | string[] }} options 例外（排除）server id
   */
  const detectGoldenfishAccounts = async (options = {}) => {
    const excludeServers = parseServerIdList(options?.excludeServers);

    if (selectedTokens.value.length === 0) {
      message.warning("请先选择要检测的账号");
      return null;
    }

    const {
      recruitMin,
      rodUnit,
      diamondPlusRodMin,
      boxPointMin,
      boxPointFactor,
      chestPoints,
    } = GOLDENFISH_CHECK_RULES;

    isRunning.value = true;
    shouldStop.value = false;
    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    addLog?.({
      time: nowText(),
      message:
        `=== 开始检测金鱼号：共 ${selectedTokens.value.length} 个账号 ===` +
        (excludeServers.size > 0
          ? `（例外 server id：${[...excludeServers].join("、")}）`
          : ""),
      type: "info",
    });

    const summary = {
      total: selectedTokens.value.length,
      qualified: [],
      unqualified: [],
      excluded: [],
      failed: [],
      groupName: GOLDENFISH_GROUP_NAME,
      groupSize: 0,
    };

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      const token = tokens.value.find((item) => item.id === tokenId);
      const tokenName = token?.name || tokenId;
      const serverId = normalizeServerId(token?.serverId);

      // 例外 server：不检测、不入组（已入组的移出）
      if (serverId && excludeServers.has(serverId)) {
        summary.excluded.push({ tokenId, tokenName, serverId });
        tokenStatus.value[tokenId] = "completed";
        log(
          tokenName,
          `${serverId}服 命中例外 server id，跳过检测（不入「${GOLDENFISH_GROUP_NAME}」）`,
          "info",
        );
        return;
      }

      tokenStatus.value[tokenId] = "running";
      try {
        log(tokenName, "=== 开始检测金鱼号 ===", "info");
        await ensureConnection(tokenId);
        if (shouldStop.value) return;

        const response = await sendRoleInfoRef(
          tokenId,
          {},
          15000,
          "检测金鱼号",
        );
        const role = extractRole(response);
        const recruit = readItemCount(role?.items, ITEM_RECRUIT);
        const goldRod = readItemCount(role?.items, ITEM_GOLD_ROD);
        const diamond = Number(role?.diamond ?? 0) || 0;
        const diamondTotal = diamond + goldRod * rodUnit;
        const boxPoint =
          Number(role?.boxPoint ?? role?.boxPoints ?? 0) || 0;

        // 有效宝箱积分 = 未兑换积分×0.52 + 各宝箱可兑换积分之和
        // （木1/青铜10/黄金20/铂金50/钻石0，见 GOLDENFISH_CHECK_RULES.chestPoints）
        const chests = Object.entries(chestPoints).map(([itemId, pts]) => ({
          itemId: Number(itemId),
          pts,
          count: readItemCount(role?.items, Number(itemId)),
        }));
        const chestScore = chests.reduce(
          (sum, chest) => sum + chest.count * chest.pts,
          0,
        );
        const boxScore = Math.floor(
          boxPoint * boxPointFactor + chestScore,
        );

        const row = {
          tokenId,
          tokenName,
          serverId,
          recruit,
          diamond,
          goldRod,
          diamondTotal,
          boxPoint,
          chests,
          chestScore,
          boxScore,
        };

        const reasons = [];
        if (recruit < recruitMin)
          reasons.push(`招募令 ${fmtNum(recruit)} < ${fmtNum(recruitMin)}`);
        if (diamondTotal < diamondPlusRodMin)
          reasons.push(
            `金砖+鱼竿×${rodUnit} = ${fmtNum(diamondTotal)} < ${fmtNum(diamondPlusRodMin)}`,
          );
        if (boxScore < boxPointMin)
          reasons.push(
            `有效宝箱积分 ${fmtNum(boxScore)} < ${fmtNum(boxPointMin)}`,
          );

        if (reasons.length === 0) {
          summary.qualified.push(row);
          tokenStatus.value[tokenId] = "completed";
          log(
            tokenName,
            `达标 ✓ 招募令 ${fmtNum(recruit)} / 金砖 ${fmtNum(diamond)} + 黄金鱼竿 ${fmtNum(goldRod)}×${rodUnit} = ${fmtNum(diamondTotal)} / 有效宝箱积分 ${fmtNum(boxPoint)}×${boxPointFactor} + 宝箱 ${fmtNum(chestScore)} = ${fmtNum(boxScore)}`,
            "success",
          );
        } else {
          summary.unqualified.push({ ...row, reasons });
          tokenStatus.value[tokenId] = "completed";
          log(tokenName, `不达标：${reasons.join("；")}`, "warning");
        }
      } catch (error) {
        summary.failed.push({
          tokenId,
          tokenName,
          serverId,
          reason: error?.message || String(error),
        });
        tokenStatus.value[tokenId] = "failed";
        log(tokenName, `检测金鱼号失败: ${error?.message || "未知错误"}`, "error");
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        log(
          tokenName,
          `连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
        );
      }
    });

    await Promise.all(taskPromises);

    syncGoldenfishGroup(summary);

    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;

    addLog?.({
      time: nowText(),
      message:
        `=== 检测金鱼号结束：达标 ${summary.qualified.length} 个，不达标 ${summary.unqualified.length} 个，` +
        `例外跳过 ${summary.excluded.length} 个，失败 ${summary.failed.length} 个 ===`,
      type: "info",
    });
    message.success(
      `检测完成：达标 ${summary.qualified.length} 个，已合并进「${GOLDENFISH_GROUP_NAME}」（现有 ${summary.groupSize} 个）`,
    );

    return summary;
  };

  return {
    goldenfishUseItem,
    goldenfishSetShopList,
    detectGoldenfishAccounts,
  };
}

export default { createTasksGoldenfish };
