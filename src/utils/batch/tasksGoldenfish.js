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

/**
 * 金鱼消耗任务（第一步「初步消耗」，2026-09-26）：
 *   招募 → 3900 / 宝箱积分 → 99000 / 钓鱼（黄金竿 1012）→ **1140**。
 * 纯逻辑见 src/utils/goldenfishConsumePlan.js；master 拍板口径：
 *   - 钓鱼只用黄金鱼竿（1012 / artifact_lottery type:2）；
 *   - 钓鱼 1140 而非 1150：给 10 月留 160 次额度（1140+160=1300，见需求原文）；
 *   - 钻石宝箱(2005)一律不开，木制宝箱(2001)全程保留 200 个；
 *   - 限流 400340：由 tokenStore 统一处理（立即弹窗提示换 IP + 每 5 秒自动重试 + 成功自关）；
 *   - 每账号先发 `activity_get` 拿活动累积进度再算差值（断点续跑）；进度不可读时宁可不跑。
 *
 * 2026-09-28 阶段 B：进度来源已接入 —— `activity_get` →
 *   `body.activity.commonActivityInfo[<金鱼活动ID>].task.{1:招募,2:宝箱,3:钓鱼,4:收罐子,5:金砖}`
 *   ⚠️ 进度**不在** `role_getroleinfo` 上（旧结论已证伪），所以每个消耗 step 都要多发一次
 *   `activity_get`。活动实例 ID 由 `resolveGoldenfishActivity` 自动探测（task 键全部落在 1..5）。
 */
import {
  BOX_POINT_STEP_COSTS,
  GOLDENFISH_CONSUME_DEFAULTS,
  chunkBatches,
  extractCommonActivityInfo,
  planCountConsume,
  planOpenAll,
  planPreciseOpen,
  readActivityProgress,
  resolveGoldenfishActivity,
  shouldKeepLooping,
} from "../goldenfishConsumePlan.js";
// ⚠️ 用相对路径而非 @/ 别名：tasksGoldenfishConsume.test.js 在裸 node 环境
// 直接 import 本文件，@/ 别名会 ERR_MODULE_NOT_FOUND（2026-09-29 踩实）
import { runWithConnectionRetry } from "../helperTaskRunner.js";
// 收尾模块的鱼竿/次数折算（纯逻辑，无网络依赖）。
// 用它而不是内联写死 0.9：返还率口径只有一处定义（GOLDENFISH_ROD_RETURN_RATE），
// 将来 master 调整返还率时日志数字自动同步，不会漂移。
import { fishesToRods } from "../goldenfishFinishPlan.js";

/**
 * 金鱼消耗目标默认值（页面可调）
 * ⚠️ **唯一定义在 `goldenfishConsumePlan.js`**，这里只做转发 —— 早先两处各写一份，
 *    改钓鱼目标时差点漏改一处（2026-09-28）。
 */
export { GOLDENFISH_CONSUME_DEFAULTS };

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

/**
 * 严格版：键不存在/结构缺失返回 null（区别于「数量为 0」）。
 * 用于消耗响应的扣减校验 —— 快照缺键时跳过校验而不是误判成扣光。
 */
const readItemCountStrict = (items, itemId) => {
  if (!items || typeof items !== "object") return null;
  const node = items[String(itemId)] ?? items[itemId];
  if (node == null) return null;
  const value = Number(
    typeof node === "number" ? node : (node.num ?? node.count ?? node.quantity),
  );
  return Number.isFinite(value) ? value : null;
};

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

/** 宝箱乐观锁：请求的开箱数量与服务端当前库存不一致（2026-09-29 线上实测） */
const isChestCountChangedError = (error) =>
  errorText(error).includes("数量已发生变化");

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

  // 2026-09-28：0 是合法值（= 不限速；命令本身是「发→await 响应」串行，0 即纯 RTT 速度）。
  // 旧实现 `raw > 0 ? raw : 300` 会把 0 当成未配置回退 300ms，反而更慢 —— 已修。
  const DEFAULT_ACTION_DELAY = 0;
  const actionDelay = () => {
    const raw = Number(delayConfig?.action);
    return Number.isFinite(raw) ? Math.max(0, raw) : DEFAULT_ACTION_DELAY;
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

  const STEPS = {
    useOneItem,
    setShopList,
    consumeRecruit: null, // 下方赋值（引用 sendWithRateLimit 等闭包）
    consumeBoxes: null,
    consumeFish: null,
  };

  /**
   * 可并行的消耗步骤（master 2026-09-29：「宝箱、招募、钓鱼可以并行而不是必须串行，
   * 因为这几个任务是独立限流的」）。
   *
   * 并行安全的依据（逐条核实过，不是想当然）：
   *   1. **限流独立**：游戏对每个活动任务独立计数，三者不互相挤占配额（master 口径）；
   *   2. **道具不交叉**：招募令 1001 / 各档宝箱 2001-2004 / 黄金鱼竿 1012 —— 逐帧扣减校验
   *      各查各的 itemId，不会互相误判；
   *   3. **协议支持并发**：`sendWithPromise` 以请求 seq 登记 pending promise，
   *      响应 `_handlePromiseResponse` 按 `packet.resp`（= 请求 seq）**精确匹配**，
   *      并发不会串味；且这三条命令都不在 `CmdDebounceMap`（防抖表）里，无节流/互斥。
   *
   * ⚠️ `role_getroleinfo` 有 1000ms 防抖缓存：三个 step 并行拉背包时会**共享同一份快照**
   *    （只读库存，安全且省一次请求）。
   * ⚠️ 串行回退：`config.serialConsume === true` 时恢复原串行语义（排查问题用）。
   */
  const PARALLEL_CONSUME_STEPS = ["consumeRecruit", "consumeBoxes", "consumeFish"];

  // ------------------------------------------------------------------ 批量框架

  /** 限流中止信号（跨账号共享；runGoldenfish 收尾会重置 shouldStop，故用独立标志） */
  let consumeAbortAll = false;

  const runGoldenfish = async (stepIds, title, count = 1, config = null) => {
    if (selectedTokens.value.length === 0) {
      message.warning("请先选择账号");
      return;
    }

    consumeAbortAll = false;
    isRunning.value = true;
    shouldStop.value = false;
    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value || consumeAbortAll) return;

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

        const failedSteps = [];
        /** 跑单个 step；返回 "ok" | "abort"（限流/活动未开，应中断后续）| "failed" */
        const runStep = async (stepId) => {
          const step = STEPS[stepId];
          if (!step) return "skip";
          try {
            // 2026-09-29 master 口径：连接失败类（超时/断连/断网）应重试而非跳过。
            // 帧层已有自动重发+重连（wrapTokenStoreWithConnectionRetry）；
            // 这里是任务级第二层：重跑整个 step —— 消耗类 step 开头都会重新
            // activity_get 读进度再补差值，重跑安全，不会重复消耗。
            await runWithConnectionRetry({
              execute: () => step({ tokenId, token, count, config }),
              shouldStop: () => shouldStop.value || consumeAbortAll,
              onRetry: async () => {
                log(
                  tokenName,
                  `⏱️ ${stepId} 连接类错误（超时/断连），3 秒后重跑该步骤（重新读进度续跑）`,
                  "warning",
                );
                // 断连/假死场景：重建连接再跑，避免原连接继续失败
                await tokenStore.closeWebSocketConnection(tokenId);
                await ensureConnection(tokenId);
              },
            });
            return "ok";
          } catch (error) {
            // 限流(400340)已由 tokenStore 自愈重试 15 分钟才到这 / 活动未开：
            // 整个号没有继续的意义，中断后续步骤。
            if (isRateLimitError(error) || isInactiveError(error)) {
              log(
                tokenName,
                `触发限流或活动未开（${errorText(error)}），中断后续步骤`,
                "warning",
              );
              return "abort";
            }
            // 其余错误（如 200020 参数拒绝）：跳过本步骤，继续后续步骤。
            // （2026-09-29 master：招募差 3 触发 200020，不该拦住宝箱/钓鱼）
            failedSteps.push(stepId);
            log(
              tokenName,
              `⏭️ ${stepId} 失败（${errorText(error)}），跳过本步骤继续后续`,
              "error",
            );
            return "failed";
          }
        };

        // 🔴 2026-09-29 master：招募/宝箱/钓鱼**独立限流**，不必串行 —— 三 step 齐活时并行跑，
        // 整体耗时约等于最慢的那一个（而非三者相加）。其余组合（单步按钮、含购物/投道具）保持串行。
        const runInParallel =
          config?.serialConsume !== true &&
          stepIds.length >= 2 &&
          stepIds.every((id) => PARALLEL_CONSUME_STEPS.includes(id));

        if (runInParallel) {
          log(
            tokenName,
            `⚡ ${stepIds.length} 个消耗任务并行执行（招募/宝箱/钓鱼 独立限流、互不挤占）`,
            "info",
          );
          // ⚠️ 并行时单个 step 遇限流无法收回已在跑的其他 step：它们各自也会收到 400340
          //    并由 tokenStore 自愈重试，最终各自收敛（不会互相拖挂）。
          await Promise.all(stepIds.map((stepId) => runStep(stepId)));
        } else {
          for (const stepId of stepIds) {
            if (shouldStop.value || consumeAbortAll) break;
            const outcome = await runStep(stepId);
            if (outcome === "abort") break;
            await sleep();
          }
        }

        if (failedSteps.length > 0) {
          tokenStatus.value[tokenId] = "failed";
          addLog({
            time: nowText(),
            message: `=== ${tokenName} ${title}结束（部分失败：${failedSteps.join("、")}；其余步骤已执行） ===`,
            type: "error",
          });
        } else if (tokenStatus.value[tokenId] !== "failed") {
          tokenStatus.value[tokenId] = "completed";
          addLog({
            time: nowText(),
            message: `=== ${tokenName} ${title}结束 ===`,
            type: "success",
          });
        }
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

  // ------------------------------------------------------- 金鱼消耗（第一步）

  /**
   * 命令发送：限流(400340)已由 tokenStore 统一处理（立即弹窗 + 每 5 秒自动重试 + 成功自关），
   * 这里只做透传，不再单独弹框。
   */
  const sendWithRateLimit = (tokenId, cmd, params, token, timeout = 8000) =>
    tokenStore.sendMessageWithPromise(tokenId, cmd, params, timeout);

  /** 拉最新 role（带限流重试）—— 只用来读**库存/未兑换积分**，进度不在这里 */
  const fetchRoleWithLimit = async (tokenId, token) => {
    const response = await sendWithRateLimit(
      tokenId,
      "role_getroleinfo",
      {},
      token,
      15000,
    );
    return extractRole(response);
  };

  /**
   * 拉活动数据（`activity_get`，空 body）—— 五类消耗进度的**唯一来源**
   *
   * ⚠️ 进度不在 role 上（`role.statistics` 是旧文档的错误候选），必须发这条命令；
   * 宝箱推进循环里每轮都要重查（进度会被 `item_openbox` 推高）。
   */
  const fetchActivityWithLimit = (tokenId, token) =>
    sendWithRateLimit(tokenId, "activity_get", {}, token, 15000);

  /** 活动进度读取：默认走 goldenfishConsumePlan.readActivityProgress（读 activity_get 的
   *  commonActivityInfo）；测试/特殊场景可通过 deps.readActivityProgress 注入覆盖 */
  const readProgressRef = deps.readActivityProgress || readActivityProgress;

  /** 活动进度可读性检查：读不到 → 必须跳过该步骤（宁可不跑，不可盲跑），并给出具体原因 */
  const readProgressOrSkip = (activityResponse, tokenName, stepName) => {
    const progress = readProgressRef(activityResponse);
    if (!progress) {
      const diag = resolveGoldenfishActivity(
        extractCommonActivityInfo(activityResponse),
        {},
      );
      log(
        tokenName,
        `${stepName}跳过：活动累积进度不可读（${diag.reason}）`,
        "warning",
      );
      return null;
    }
    return progress;
  };

  /** 进度日志三元组（skill 规范：目标/当前/差值/库存 + 错误原文） */
  const progressText = (target, done, stock, stockName) =>
    `目标 ${fmtNum(target)} / 已做 ${fmtNum(done)} / 差值 ${fmtNum(Math.max(0, target - done))} / ${stockName}库存 ${fmtNum(stock)}`;

  /**
   * 消耗 step：招募（hero_recruit recruitType:1，10/发+余数，消耗招募令 1001）
   * 库存不足 = 正常暂停（黑市购物列表 10 折自动补货后再跑）
   */
  const consumeRecruitStep = async ({ tokenId, token, config }) => {
    const target = clampCount(config?.recruitTarget ?? GOLDENFISH_CONSUME_DEFAULTS.recruitTarget);
    // 先读活动进度（读不到/缺字段直接跳过，省一次 role 查询）
    const activity = await fetchActivityWithLimit(tokenId, token);
    const progress = readProgressOrSkip(activity, token.name, "招募消耗");
    if (!progress) return;
    if (progress.recruitDone == null) {
      log(
        token.name,
        `招募消耗跳过：活动 ${progress.activityId} 缺 task.1（招募）进度字段`,
        "warning",
      );
      return;
    }

    const role = await fetchRoleWithLimit(tokenId, token);
    const stock = readItemCount(role?.items, ITEM_RECRUIT);
    const plan = planCountConsume({
      done: progress.recruitDone,
      target,
      stock,
      batchSize: 10,
      alignDown: true, // 抓包口径单发固定 10：余数批次会被 200020 拒绝（2026-09-29）
    });
    if (!plan.ok) {
      log(token.name, `招募消耗跳过：进度不可读（${progressText(target, null, stock, "招募令")}）`, "warning");
      return;
    }
    if (plan.reached) {
      log(token.name, `招募消耗已达目标（${progressText(target, progress.recruitDone, stock, "招募令")}）`, "success");
      return;
    }
    log(
      token.name,
      `招募消耗开始（活动 ${progress.activityId}）：${progressText(target, progress.recruitDone, stock, "招募令")}`,
      "info",
    );

    let done = progress.recruitDone;
    let sent = 0;
    let lastStock = stock; // 上一次已知的招募令余额（响应逐帧更新，扣减校验基准）
    for (const n of plan.batches) {
      if (shouldStop.value) return;
      const resp = await sendWithRateLimit(
        tokenId,
        "hero_recruit",
        { recruitType: 1, recruitNumber: n },
        token,
      );
      // 扣减校验（2026-09-29 master 口径「必须得到反馈再继续，避免盲做」，
      // 抓包实证 Hero_RecruitResp.body.role.items 携带实时余额）：
      // 每帧校验招募令余额扣减 = 本帧数量，不符立即中止防止盲做。
      const nowStock = readItemCountStrict(resp?.role?.items, ITEM_RECRUIT);
      if (nowStock != null && lastStock != null && lastStock - nowStock !== n) {
        throw new Error(
          `招募令扣减异常：预期 -${n}，实际 ${lastStock - nowStock}（${lastStock}→${nowStock}），中止防止盲做`,
        );
      }
      if (nowStock != null) lastStock = nowStock;
      done += n;
      sent += 1;
      if (sent % 50 === 0) {
        log(token.name, `招募消耗进度：${fmtNum(done)}/${fmtNum(target)}（已发 ${sent} 帧）`, "info");
      }
      await sleep();
    }
    log(
      token.name,
      `招募消耗结束：本次 ${fmtNum(plan.willDo)}，累计 ${fmtNum(done)}/${fmtNum(target)}` +
        (plan.alignedShort
          ? `；⏸️ 差 ${fmtNum(plan.remaining - plan.willDo)} 次不足一批(10)，按口径不做、留待最后补满`
          : plan.stockShort
            ? `；⚠️ 招募令不足，还差 ${fmtNum(plan.remaining - plan.willDo)} 次，等黑市补货后再跑`
            : ""),
      plan.stockShort ? "warning" : "success",
    );
  };

  /**
   * 消耗 step：钓鱼（artifact_lottery type:2 = 黄金鱼竿 1012，10/发+余数）
   *
   * master 口径（2026-09-29 拍板）：**只用黄金鱼竿；库存不足 = 有多少做多少**，
   * 不做即时买入 —— 缺口记日志（含竿数折算），**留待收尾阶段用金砖买竿补全**
   * （买竿本身就是金砖消耗任务的实现手段，一笔支出同时推进金砖 + 钓鱼两个任务；
   *   商店购物清单里 1012 已有 8 折口径 `GOLDENFISH_SHOP_DEFAULTS`）。
   */
  const consumeFishStep = async ({ tokenId, token, config }) => {
    const target = clampCount(config?.fishTarget ?? GOLDENFISH_CONSUME_DEFAULTS.fishTarget);
    // 先读活动进度（读不到/缺字段直接跳过，省一次 role 查询）
    const activity = await fetchActivityWithLimit(tokenId, token);
    const progress = readProgressOrSkip(activity, token.name, "钓鱼消耗");
    if (!progress) return;
    if (progress.fishDone == null) {
      log(
        token.name,
        `钓鱼消耗跳过：活动 ${progress.activityId} 缺 task.3（钓鱼）进度字段`,
        "warning",
      );
      return;
    }

    const role = await fetchRoleWithLimit(tokenId, token);
    const stock = readItemCount(role?.items, ITEM_GOLD_ROD);
    const plan = planCountConsume({
      done: progress.fishDone,
      target,
      stock,
      batchSize: 10,
      alignDown: true, // 抓包口径单发固定 10：余数批次会被 200020 拒绝（2026-09-29）
    });
    if (!plan.ok) {
      log(token.name, `钓鱼消耗跳过：进度不可读（${progressText(target, null, stock, "黄金鱼竿")}）`, "warning");
      return;
    }
    if (plan.reached) {
      log(token.name, `钓鱼消耗已达目标（${progressText(target, progress.fishDone, stock, "黄金鱼竿")}）`, "success");
      return;
    }
    log(
      token.name,
      `钓鱼消耗开始（活动 ${progress.activityId}）：${progressText(target, progress.fishDone, stock, "黄金鱼竿")}`,
      "info",
    );

    let done = progress.fishDone;
    let sent = 0;
    let lastStock = stock; // 上一次已知的黄金鱼竿余额（扣减校验基准）
    for (const n of plan.batches) {
      if (shouldStop.value) return;
      const resp = await sendWithRateLimit(
        tokenId,
        "artifact_lottery",
        { type: 2, lotteryNumber: n, newFree: true },
        token,
      );
      // 扣减校验（抓包实证 SyncRewardResp.body.role.items 携带实时余额，resp 序号对齐请求）
      const nowStock = readItemCountStrict(resp?.role?.items, ITEM_GOLD_ROD);
      if (nowStock != null && lastStock != null && lastStock - nowStock !== n) {
        throw new Error(
          `黄金鱼竿扣减异常：预期 -${n}，实际 ${lastStock - nowStock}（${lastStock}→${nowStock}），中止防止盲做`,
        );
      }
      if (nowStock != null) lastStock = nowStock;
      done += n;
      sent += 1;
      if (sent % 20 === 0) {
        log(token.name, `钓鱼消耗进度：${fmtNum(done)}/${fmtNum(target)}（已发 ${sent} 帧）`, "info");
      }
      await sleep();
    }
    log(
      token.name,
      `钓鱼消耗结束：本次 ${fmtNum(plan.willDo)}，累计 ${fmtNum(done)}/${fmtNum(target)}` +
        (plan.alignedShort
          ? `；⏸️ 差 ${fmtNum(plan.remaining - plan.willDo)} 次不足一批(10)，按口径不做、留待最后补满`
          : plan.stockShort
            ? `；⚠️ 黄金鱼竿不足，还差 ${fmtNum(plan.remaining - plan.willDo)} 次（约 ${fmtNum(fishesToRods(plan.remaining - plan.willDo))} 根，含 10% 返还折算），留待收尾阶段金砖买竿补全`
            : ""),
      plan.stockShort ? "warning" : "success",
    );
  };

  /** 积分兑换：从当前档位逐档 claim 到付不起下一档（响应驱动 boxPoint/boxPointLastReward） */
  const exchangeAllScore = async ({ tokenId, token, role }) => {
    let boxPoint = Number(role?.boxPoint ?? 0) || 0;
    let pos = Number(role?.boxPointLastReward ?? 0) || 0;
    let claimed = 0;
    for (;;) {
      if (pos < 0 || pos >= BOX_POINT_STEP_COSTS.length || claimed >= 3000) break;
      const cost = BOX_POINT_STEP_COSTS[pos];
      if (boxPoint < cost) break;
      const resp = await sendWithRateLimit(tokenId, "item_claimboxpointreward", {}, token, 8000);
      claimed += 1;
      const r = resp?.role ?? {};
      if (typeof r.boxPoint === "number") {
        boxPoint = r.boxPoint;
      } else {
        boxPoint -= cost;
      }
      if (typeof r.boxPointLastReward === "number") {
        pos = r.boxPointLastReward;
      } else {
        pos = (pos + 1) % BOX_POINT_STEP_COSTS.length;
      }
      if (claimed % 20 === 0) {
        log(token.name, `积分兑换进度：已兑 ${claimed} 档，剩余积分 ${fmtNum(boxPoint)}`, "info");
      }
    }
    log(token.name, `积分兑换完成：本次兑换 ${claimed} 档，剩余未兑换积分 ${fmtNum(boxPoint)}`, "success");
    return claimed;
  };

  /** 开箱计划逐批发送（10/发+余数），返回最后一份带 role 的响应。
   * inventory = 发送前已知的库存快照（可选）：逐帧校验该箱型扣减 = 本帧数量，
   * 不符抛错防盲做（2026-09-29 master 口径；Item_OpenBoxResp.role.items 实证携带余额） */
  const sendOpenBoxSteps = async ({ tokenId, token, steps, inventory }) => {
    let lastResp = null;
    let total = 0;
    let lastItems = inventory ?? null;
    for (const step of steps) {
      for (const n of chunkBatches(step.number, 10)) {
        if (shouldStop.value) return lastResp;
        lastResp = await sendWithRateLimit(
          tokenId,
          "item_openbox",
          { itemId: step.itemId, number: n },
          token,
          8000,
        );
        if (lastItems) {
          const before = readItemCountStrict(lastItems, step.itemId);
          const now = readItemCountStrict(lastResp?.role?.items, step.itemId);
          if (before != null && now != null && before - now !== n) {
            throw new Error(
              `宝箱扣减异常：itemId ${step.itemId} 预期 -${n}，实际 ${before - now}（${before}→${now}），中止防止盲做`,
            );
          }
          if (now != null) lastItems = { ...lastItems, [step.itemId]: now };
        }
        total += n;
        await sleep();
      }
    }
    if (total > 0) {
      log(token.name, `开箱完成：本次共开 ${fmtNum(total)} 个`, "info");
    }
    return lastResp;
  };

  /**
   * 带库存重读的开箱发送（2026-09-29 master 口径：「宝箱数量已发生变化就需要重新获取」）。
   * 服务端对 item_openbox 做数量校验（乐观锁）：计划基于过期库存时会拒
   * 「宝箱数量已发生变化，请重新操作」→ 重新拉背包、重新规划、再发（最多 2 次）。
   * replan(role) → { steps, ...extra }；steps 为空 = 无箱可开（empty: true 返回）。
   */
  const sendOpenBoxStepsWithReread = async ({ tokenId, token, replan }) => {
    for (let attempt = 0; ; attempt += 1) {
      const freshRole = await fetchRoleWithLimit(tokenId, token);
      const plan = replan(freshRole) ?? {};
      const steps = plan.steps ?? [];
      if (steps.length === 0) {
        return { empty: true, role: freshRole, plan };
      }
      try {
        const lastResp = await sendOpenBoxSteps({
          tokenId,
          token,
          steps,
          inventory: freshRole?.items,
        });
        return { empty: false, lastResp, role: freshRole, plan };
      } catch (error) {
        if (attempt >= 2 || !isChestCountChangedError(error)) throw error;
        log(
          token.name,
          `⏳ 宝箱数量已变化（服务端库存与计划不一致），2 秒后重新读库存重试（第 ${attempt + 1}/2 次）`,
          "warning",
        );
        await sleep(2000);
      }
    }
  };

  /**
   * 消耗 step：宝箱（master 伪代码完整实现）
   * while(累积 + 可开分 < 目标) { 全开(钻石不开/木箱留200) → 积分全兑 → 重查 }
   * 退出后差值精确开（铂金→黄金→青铜→木箱），剩余积分不兑换（利润最大化）
   */
  const consumeBoxesStep = async ({ tokenId, token, config }) => {
    const target = clampCount(config?.boxTarget ?? GOLDENFISH_CONSUME_DEFAULTS.boxTarget);
    const activityResp = await fetchActivityWithLimit(tokenId, token);
    const progressFirst = readProgressOrSkip(activityResp, token.name, "宝箱消耗");
    if (!progressFirst) return;
    if (progressFirst.boxScoreDone == null) {
      log(
        token.name,
        `宝箱消耗跳过：活动 ${progressFirst.activityId} 缺 task.2（宝箱）进度字段`,
        "warning",
      );
      return;
    }

    let role = await fetchRoleWithLimit(tokenId, token);
    let accumulated = Math.max(0, Math.floor(Number(progressFirst.boxScoreDone) || 0));
    log(
      token.name,
      `宝箱消耗开始（活动 ${progressFirst.activityId}）：${progressText(target, accumulated, "-", "宝箱")}`,
      "info",
    );

    // 推进循环（防死循环双保险：轮次上限 + 两轮零增长中止）
    let round = 0;
    let noGrowthRounds = 0;
    while (shouldKeepLooping(accumulated, role?.items, target) && !shouldStop.value) {
      round += 1;
      if (round > 200) {
        log(token.name, `宝箱推进循环超 200 轮，中止（请检查进度字段口径，当前累积 ${fmtNum(accumulated)}）`, "warning");
        return;
      }
      // 全开计划基于重读后的新鲜库存（数量变化乐观锁自愈，2026-09-29）
      const result = await sendOpenBoxStepsWithReread({
        tokenId,
        token,
        replan: (freshRole) => ({ steps: planOpenAll(freshRole?.items) }),
      });
      if (result.empty) {
        log(
          token.name,
          `宝箱消耗暂停：积分不足且无箱可开（累积 ${fmtNum(accumulated)}/${fmtNum(target)}），等商店补货后再跑`,
          "warning",
        );
        return;
      }
      role = result.role;
      const lastResp = result.lastResp;
      await exchangeAllScore({ tokenId, token, role: lastResp?.role ?? role });

      role = await fetchRoleWithLimit(tokenId, token);
      // 推进循环里进度也会变（item_openbox 抬高 task.2）→ 每轮都重新拉活动数据
      const nextActivity = await fetchActivityWithLimit(tokenId, token);
      const progress = readProgressRef(nextActivity);
      if (!progress || progress.boxScoreDone == null) {
        log(token.name, "宝箱消耗中止：循环中进度变得不可读", "warning");
        return;
      }
      const next = Math.max(0, Math.floor(Number(progress.boxScoreDone) || 0));
      if (next === accumulated) {
        noGrowthRounds += 1;
        if (noGrowthRounds >= 2) {
          log(token.name, `宝箱累积积分两轮无增长（仍 ${fmtNum(accumulated)}），中止以防死循环（疑似进度字段口径不符）`, "warning");
          return;
        }
      } else {
        noGrowthRounds = 0;
      }
      accumulated = next;
      log(token.name, `宝箱推进第 ${round} 轮完成：累积 ${fmtNum(accumulated)}/${fmtNum(target)}`, "info");
    }

    // 差值精确开箱（不兑换，剩余积分留活动结束）
    if (accumulated < target && !shouldStop.value) {
      const remaining = target - accumulated;
      // 精确开箱同样基于重读后的新鲜库存（数量变化乐观锁自愈，2026-09-29）
      const result = await sendOpenBoxStepsWithReread({
        tokenId,
        token,
        replan: (freshRole) => planPreciseOpen(remaining, freshRole?.items),
      });
      log(
        token.name,
        `宝箱差值精确开箱：差 ${fmtNum(remaining)} 分，计划开 ${result.plan.steps.map((s) => `${s.itemId}×${s.number}`).join("、") || "无"}`,
        "info",
      );
      if (result.empty || result.plan.remainingScore > 0) {
        log(
          token.name,
          `宝箱消耗暂停：库存不足，还差 ${fmtNum(result.plan.remainingScore)} 分，等商店补货后再跑`,
          "warning",
        );
        return;
      }
    }
    log(token.name, `宝箱消耗结束：累积 ${fmtNum(accumulated)}/${fmtNum(target)}（剩余积分保留不兑换）`, "success");
  };

  STEPS.consumeRecruit = consumeRecruitStep;
  STEPS.consumeBoxes = consumeBoxesStep;
  STEPS.consumeFish = consumeFishStep;

  /**
   * 金鱼消耗一键编排：招募 + 宝箱 + 钓鱼
   *
   * 2026-09-29 master：三者**独立限流**，由 runGoldenfish 自动并行执行
   * （整体耗时 ≈ 最慢的单个任务；传入 `config.serialConsume = true` 可回退串行）。
   */
  const goldenfishConsumeAll = (config) =>
    runGoldenfish(
      ["consumeRecruit", "consumeBoxes", "consumeFish"],
      "金鱼消耗（招募/宝箱/钓鱼 并行）",
      1,
      config,
    );
  const goldenfishRecruit = (config) =>
    runGoldenfish(["consumeRecruit"], "金鱼招募消耗", 1, config);
  const goldenfishBoxes = (config) =>
    runGoldenfish(["consumeBoxes"], "金鱼宝箱消耗", 1, config);
  const goldenfishFish = (config) =>
    runGoldenfish(["consumeFish"], "金鱼钓鱼消耗", 1, config);

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
    goldenfishConsumeAll,
    goldenfishRecruit,
    goldenfishBoxes,
    goldenfishFish,
  };
}

export default { createTasksGoldenfish };
