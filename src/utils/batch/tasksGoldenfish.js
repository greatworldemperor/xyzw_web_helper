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
  OPENBOX_BATCH_SIZE,
  WOODEN_RESERVE,
  chestScoreAvailable,
  chunkBatches,
  extractCommonActivityInfo,
  planCountConsume,
  planOpenAll,
  planPreciseOpen,
  readActivityProgress,
  readChestInventory,
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

/**
 * 页面级「金鱼任务」运行标志（**跨 createTasksGoldenfish 实例共享**）
 *
 * 为什么不能只靠注入的 `isRunning`：页面会给「自由模板」的每个任务各建一份 deps
 * （各自一个 `isRunning: ref(false)`），所以「定时任务 + 手动点击」这种叠加运行
 * 注入的 ref 根本挡不住。本闸门是廉价的保险：拿不准就先不并发，宁可少跑一个号。
 *
 * 📌 2026-09-29 定案后口径修正：当初加它是为了防「宝箱数量已发生变化」，
 *    而那个报错的真凶是**服务端只认整批开箱**（与本闸门无关）。闸门保留的理由改成
 *    通用的一条：**同一个角色的背包同一时间只允许一个运行去写**。
 */
let goldenfishRunActive = false;

/** `pagehide` 卸载释放租约的监听器只装一次（模块级，跨实例共享） */
let leaseUnloadHookInstalled = false;

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
   * 可并行的消耗步骤（master 2026-09-29：「招募、钓鱼可以并行而不是必须串行，
   * 因为这几个任务是独立限流的」）。
   *
   * 并行安全的依据（逐条核实过，不是想当然）：
   *   1. **限流独立**：游戏对每个活动任务独立计数，互不挤占配额（master 口径）；
   *   2. **道具不交叉**：招募令 1001 / 黄金鱼竿 1012 各用各的，逐帧扣减校验互不误判；
   *   3. **协议支持并发**：`sendWithPromise` 以请求 seq 登记 pending promise，
   *      响应 `_handlePromiseResponse` 按 `packet.resp`（= 请求 seq）**精确匹配**，
   *      并发不会串味；且这两条命令都不在 `CmdDebounceMap`（防抖表）里，无节流/互斥。
   *
   * 🔴 **宝箱不在此列**（2026-09-29 线上两轮实测修正）：`consumeBoxes` 内部是
   *   「开箱 ↔ 积分兑换 ↔ 重查进度」的强一致性循环，开箱走服务端**背包乐观锁**校验
   *   （提交数量与服务端当前持有必须一致）。与活动任务并发时实测「宝箱数量已发生变化」
   *   连片失败（3 个号同秒全部失败，而招募/钓鱼都成功）—— 宝箱对背包状态敏感，
   *   必须独占执行。招募/钓鱼是单纯「发帧扣道具」，互不影响，可以并行。
   *
   * ⚠️ 串行回退：`config.serialConsume === true` 时三者全部串行（排查问题用）。
   * ⚠️ 实验入口：`config.parallelBoxes === true` 让宝箱也参与并行（复测用，默认关）。
   */
  const PARALLEL_CONSUME_STEPS = ["consumeRecruit", "consumeFish"];

  // ------------------------------------------------------------------ 批量框架

  /** 限流中止信号（跨账号共享；runGoldenfish 收尾会重置 shouldStop，故用独立标志） */
  let consumeAbortAll = false;

  /**
   * 同角色并发闸门（2026-09-29 线上实测后新增；成因同日定案）
   *
   * 历史：部分账号的 consumeBoxes 被服务端拒「宝箱数量已发生变化，请重新操作」。
   * ✅ **已定案：真凶是服务端只接受整批开箱（单帧 number 恰好 = 10），余数批被拒**
   *    ——**与同角色并发无关**（证据链见本文件 `sendOpenBoxStepsWithReread` 注释、
   *    `goldenfishConsumePlan.OPENBOX_BATCH_SIZE` 注释、`local-data/goldenfish/batch_log1.txt`）。
   *
   * ⇒ 这三道闸门原本的「防『宝箱数量已发生变化』」理由**已失效**，但**保留**仍有价值：
   *   两个运行同时写同一个角色的背包本身就不该发生（多客户端竞争会丢道具 / 互相打断）。
   *   语义因此修正为「同一角色同一时间只允许一个运行写背包」。
   *
   * 三道闸门（都以**角色**为单位，不是 token 条目）：
   *   1. 本页内：`isRunning` / `goldenfishRunActive` 已是 true 时拒绝再次启动；
   *   2. 本页本轮内：同一批里两条 token 指向同一角色 → 只跑第一条（重复导入去重）；
   *   3. 跨标签页 / 跨窗口：localStorage 里给每个**角色**抢一份带 TTL 的租约，抢不到就跳过该号。
   * 非浏览器环境（裸 node 测试）自动降级为无锁，不影响既有用例。
   *
   * 🔴 2026-09-29 19:08 实战暴露两个缺陷（`local-data/goldenfish/role_conflict.txt`：
   *    一个 164 号的运行里 14 个跑成、**150 个被租约挡掉**，且理由写的是早已证伪的并发说）：
   *    a. **`RUN_TAB_ID` 原本是「每个 createTasksGoldenfish 实例」一个**，而自由模板每执行一次
   *       就新建一份 deps/实例（见 BatchDailyTasks.vue `runFlexibleBatchTask`）⇒
   *       **同一个页面里先后两次运行会互相认成「另一个标签页」**；页面重载后新实例同样
   *       认不出自己刚留下的租约。→ 改用 **sessionStorage 里的「每标签页」id**：
   *       同页跨实例一致、重载后仍是同一个 id（既治同页误判，也让重载后的会话能接管自己的旧租约）；
   *       而 iframe / 另一个窗口各有独立 sessionStorage ⇒ 跨上下文互斥依旧有效。
   *    b. **租约只在每个 token 的 `finally` 里释放**，页面重载/关闭根本不走它 ⇒
   *       没跑完的号会**白占租约**（原 TTL 15 分钟），下一次运行成片跳过。→ 补 `pagehide`
   *       全量归还，并把 TTL 收紧到 5 分钟（运行中每 60 秒续租，仍留 4 次容错）。
   *    c. 跳过日志现在打出**持有者 tab + 最后续租时间**，一眼分清「真·另一个标签页」与
   *      「自己上次留下的僵尸租约」。
   */

  /** 租约键前缀（键 = 前缀 + 角色维度 `serverId-roleId`） */
  const RUN_LEASE_PREFIX = "xyzw:goldenfish:consumeLease:";
  /** 租约有效期；运行中每 60 秒续一次（5 分钟 ≈ 容忍 4 次续租丢失，同时把崩溃残留窗口压到最短） */
  const RUN_LEASE_TTL_MS = 5 * 60 * 1000;
  /** 运行中续租间隔 */
  const RUN_LEASE_RENEW_MS = 60 * 1000;
  /** 本标签页 id 的 sessionStorage 键 */
  const RUN_TAB_ID_STORAGE_KEY = "xyzw:goldenfish:tabId";

  /**
   * 本**标签页**的身份（不是实例身份）。
   * sessionStorage 的特性正好合用：同一个标签页内跨重载保持、关闭标签页即消失。
   * 没有 sessionStorage（裸 node 测试）时退化为实例级随机 id。
   */
  const RUN_TAB_ID = (() => {
    const fresh = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      const s = typeof sessionStorage === "undefined" ? null : sessionStorage;
      if (!s) return fresh;
      const kept = s.getItem(RUN_TAB_ID_STORAGE_KEY);
      if (kept) return kept;
      s.setItem(RUN_TAB_ID_STORAGE_KEY, fresh);
      return fresh;
    } catch {
      return fresh;
    }
  })();

  /**
   * 同一轮运行内已占用的角色键（`serverId-roleId`）。
   * 为什么需要它：跨标签页租约判定里「持有者就是本标签页」时是放行的（续租语义），
   * 所以**同一批里两条 token 指向同一个角色**（重复导入 / 同名不同实例）会双双通过，
   * 等于我们自己给自己制造并发开箱。这个集合在 runGoldenfish 起止各清一次。
   */
  let goldenfishActiveRoleKeys = new Set();

  /**
   * 租约键 = 角色维度（`serverId-roleId`），**不是** token 条目维度。
   * 同一个角色可能被导入成两条 token（不同名称/不同 BIN 来源），按 tokenId 发租约对它们无效，
   * 而真正会被服务端拒绝的是「同一个角色的箱子被两个运行同时开」。
   */
  const runLeaseKeyOf = (tokenId) => {
    const item = tokens.value.find((t) => t.id === tokenId);
    if (item?.roleId) return `${item.serverId ?? ""}-${item.roleId}`;
    return String(item?.name ?? tokenId);
  };

  const leaseStore = () => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };

  /** 实际写进 localStorage 的键：前缀 + 角色维度键（同一角色跨 token 条目互斥） */
  const runLeaseStoreKey = (tokenId) => RUN_LEASE_PREFIX + runLeaseKeyOf(tokenId);

  const readRunLease = (tokenId) => {
    const store = leaseStore();
    if (!store) return null;
    try {
      const raw = store.getItem(runLeaseStoreKey(tokenId));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  const writeRunLease = (tokenId) => {
    const store = leaseStore();
    if (!store) return false;
    try {
      store.setItem(
        runLeaseStoreKey(tokenId),
        JSON.stringify({ tab: RUN_TAB_ID, at: Date.now() }),
      );
      return true;
    } catch {
      return false;
    }
  };

  const releaseRunLease = (tokenId) => {
    const store = leaseStore();
    if (!store) return;
    try {
      if (readRunLease(tokenId)?.tab === RUN_TAB_ID) {
        store.removeItem(runLeaseStoreKey(tokenId));
      }
    } catch {
      /* 忽略：租约清理失败不影响任务 */
    }
  };

  /**
   * 归还**本标签页持有的全部租约**（按前缀扫 localStorage，只删 `tab === 本页` 的条目）。
   *
   * 为什么必须有：常规释放点在每个 token 的 `finally`，而**页面重载 / 关闭标签页 /
   * 跳走都不会走到它** ⇒ 没跑完的号会白占租约直到 TTL 过期，下一次运行成片跳过
   * （2026-09-29 19:08 `role_conflict.txt` 实测：150 个号就是这么被挡掉的）。
   * 用 `pagehide`（关闭/刷新/跳转都触发）而不是 `beforeunload`（关标签页时不可靠）。
   * 跨实例只需装一次：`RUN_TAB_ID` 来自 sessionStorage，同页所有实例取值相同。
   */
  const releaseAllOwnLeases = () => {
    const store = leaseStore();
    if (!store) return;
    try {
      const keys = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key && key.startsWith(RUN_LEASE_PREFIX)) keys.push(key);
      }
      for (const key of keys) {
        try {
          const raw = store.getItem(key);
          if (raw && JSON.parse(raw)?.tab === RUN_TAB_ID) store.removeItem(key);
        } catch {
          /* 单条坏了不影响其它 */
        }
      }
    } catch {
      /* 卸载路径尽力而为，失败就让 TTL 兜底 */
    }
  };

  if (typeof window !== "undefined" && !leaseUnloadHookInstalled) {
    leaseUnloadHookInstalled = true;
    window.addEventListener("pagehide", (event) => {
      // ⚠️ `persisted === true` = 页面进了 bfcache（前进/后退还会原样回来），
      //    此时运行可能仍在继续，不能把租约还掉，否则会被别的上下文抢走。
      if (event?.persisted) return;
      releaseAllOwnLeases();
    });
  }

  /**
   * 被别的运行占着时，把「谁占的、多久前续的」打进日志 ——
   * 一眼分清「真·另一个标签页/窗口在跑」与「自己上次留下的僵尸租约」。
   */
  const leaseHolderText = (held) => {
    if (!held) return "";
    const at = Number(held.at) || 0;
    const agoText =
      at > 0 ? `，最后续租 ${new Date(at).toLocaleTimeString()}（${Math.max(0, Math.round((Date.now() - at) / 1000))} 秒前）` : "";
    return `（持有者 ${held.tab ?? "未知"}${agoText}）`;
  };

  /**
   * @returns {{ok: boolean, reason?: "duplicate-in-run" | "other-tab" | "lease-write-failed", held?: object}}
   * - 同一轮里已有另一条 token 指向同一角色 → `duplicate-in-run`（重复导入去重）
   * - 另一个标签页/窗口持有该角色租约 → `other-tab`（跨上下文互斥；`held` 是持有者信息）
   * - 无 localStorage 的裸 node 环境降级为无锁，直接放行（但同轮去重仍生效）
   */
  const acquireRunLease = (tokenId) => {
    const roleKey = runLeaseKeyOf(tokenId);
    if (goldenfishActiveRoleKeys.has(roleKey)) return { ok: false, reason: "duplicate-in-run" };
    goldenfishActiveRoleKeys.add(roleKey);
    if (!leaseStore()) return { ok: true };
    const held = readRunLease(tokenId);
    if (held && held.tab !== RUN_TAB_ID && Date.now() - Number(held.at || 0) < RUN_LEASE_TTL_MS) {
      return { ok: false, reason: "other-tab", held };
    }
    return writeRunLease(tokenId) ? { ok: true } : { ok: false, reason: "lease-write-failed" };
  };

  const runGoldenfish = async (stepIds, title, count = 1, config = null) => {
    if (selectedTokens.value.length === 0) {
      message.warning("请先选择账号");
      return;
    }
    // 闸门 1：同一页面里不允许两轮消耗叠加（定时任务与手动点击撞车 = 同一账号被并发开箱）
    if (isRunning.value || goldenfishRunActive) {
      message.warning("已有金鱼任务正在运行，请等本轮结束后再跑（同一账号并发消耗会被服务端拒绝）");
      return;
    }

    consumeAbortAll = false;
    goldenfishActiveRoleKeys = new Set(); // 本轮角色占位表清空（同批重复导入去重）
    goldenfishRunActive = true;
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

      // 闸门 2：角色维度互斥 —— 同批重复导入 / 另一个标签页在跑同一个角色，都跳过
      const lease = acquireRunLease(tokenId);
      if (!lease.ok) {
        tokenStatus.value[tokenId] = "failed";
        const why =
          lease.reason === "duplicate-in-run"
            ? "本批里有另一条 token 指向同一个角色（重复导入）"
            : lease.reason === "other-tab"
              ? "另一个标签页/窗口正在操作该角色（同浏览器租约）"
              : "本页写不进角色租约（localStorage 不可写）";
        addLog({
          time: nowText(),
          message:
            `⏭️ ${tokenName} 跳过：${why}${leaseHolderText(lease.held)}` +
            `（同一角色的背包同一时间只允许一个运行写；被僵尸租约挡住的话，最长 ${fmtNum(RUN_LEASE_TTL_MS / 60000)} 分钟后自动过期）`,
          type: "warning",
        });
        // 这里还没进连接队列（ensureConnection 未调用）→ 不能减槽位
        return;
      }
      const leaseTimer = leaseStore()
        ? setInterval(() => writeRunLease(tokenId), RUN_LEASE_RENEW_MS)
        : null;

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

        // 🔴 2026-09-29 master：招募/钓鱼**独立限流**可并行；**宝箱独占**（背包乐观锁敏感）。
        // 分组执行：并行段（默认 招募 + 钓鱼）先跑，其余步骤随后串行 —— 单步按钮/购物/投道具
        // 天然只有 1 个可并行项，会整体走原串行路径，语义不变。
        const isParallelizable = (id) =>
          PARALLEL_CONSUME_STEPS.includes(id) ||
          (config?.parallelBoxes === true && id === "consumeBoxes");
        const parallelIds =
          config?.serialConsume === true ? [] : stepIds.filter(isParallelizable);
        const useParallel = parallelIds.length >= 2;
        const serialIds = useParallel
          ? stepIds.filter((id) => !parallelIds.includes(id))
          : stepIds;

        if (useParallel) {
          log(
            tokenName,
            `⚡ 并行执行 ${parallelIds.length} 个消耗任务（独立限流、互不挤占）：${parallelIds.join(" + ")}` +
              (serialIds.length > 0 ? `；其余串行：${serialIds.join(" + ")}` : ""),
            "info",
          );
          // ⚠️ 并行时单个 step 遇限流无法收回已在跑的其他 step：它们各自也会收到 400340
          //    并由 tokenStore 自愈重试，最终各自收敛（不会互相拖挂）。
          await Promise.all(parallelIds.map((stepId) => runStep(stepId)));
        }
        for (const stepId of serialIds) {
          if (shouldStop.value || consumeAbortAll) break;
          const outcome = await runStep(stepId);
          if (outcome === "abort") break;
          await sleep();
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
        if (leaseTimer) clearInterval(leaseTimer);
        releaseRunLease(tokenId); // 角色级租约：本轮结束就还回去（异常路径也走这里）
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: nowText(),
          message: `${tokenName} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    try {
      await Promise.all(taskPromises);
    } finally {
      // 无论成功/异常都要放闸，否则后续所有金鱼任务都会被自己的标志挡住
      goldenfishRunActive = false;
      goldenfishActiveRoleKeys = new Set(); // 角色占位清空（下一轮重新抢）
      currentRunningTokenId.value = null;
      isRunning.value = false;
      shouldStop.value = false;
    }
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

  /** 进度日志三元组（skill 规范：目标/当前/差值/库存 + 错误原文）
   *  stock 为 null 时打「-」而不是 0 —— fmtNum(null) 会折成 0，
   *  宝箱 step 传占位符时线上日志永远是「宝箱库存 0」，把最有用的排查信息丢掉（2026-09-29） */
  const progressText = (target, done, stock, stockName) =>
    `目标 ${fmtNum(target)} / 已做 ${fmtNum(done)} / 差值 ${fmtNum(Math.max(0, target - done))} / ${stockName}库存 ${stock == null ? "-" : fmtNum(stock)}`;

  /** 宝箱名称（与 CHEST_POINTS 的键一一对应，只用于日志可读性） */
  const CHEST_NAMES = Object.freeze({
    2001: "木箱",
    2002: "青铜",
    2003: "黄金",
    2004: "铂金",
    2005: "钻石",
  });

  /** 宝箱库存可读文案：`木箱8,637 青铜2,216 黄金474 铂金329 钻石241`
   *  🔴 宝箱 step 必须打真实库存：这个数字是判断「服务端为什么拒开箱」的第一手证据
   *  （2026-09-29 线上连片「宝箱数量已发生变化」时，日志里全是占位符 0，没法定位） */
  const chestInventoryText = (items) => {
    const inv = readChestInventory(items);
    return Object.keys(inv)
      .map((id) => `${CHEST_NAMES[id] || `道具${id}`}${fmtNum(inv[id])}`)
      .join(" ");
  };

  /**
   * 服务端**绝对**开箱计数器（判定「是不是有人在并发开同一个号」的硬证据）
   *
   * `Role_GetRoleInfoResp.role.statistics` 里有两个与我们无关、纯服务端累计的量：
   *   - `today:open:box`    = 今天调用 item_openbox 的**次数**（每发一帧 +1，与开几个箱无关）
   *   - `activity:open:box` = 本活动累计开箱**积分**（口径 = 活动 task.2）
   *
   * 实证（local-data/goldenfish/consumption_tasks.jsonl，真实客户端连发 6 帧）：
   *   today:open:box   649→650→651→652→653→654→655   （每帧恰好 +1）
   *   activity:open:box  50→550→750→850→1350→1550→1650（10 铂金=500 / 10 黄金=200 / 10 青铜=100 分）
   *
   * ⇒ 判据：**本机只发 N 帧，而服务端调用次数涨幅 > N** ⇒ 多出来的调用不是本机发的
   *   ⇒ 确有另一个客户端/运行在开同一个角色（假设 ① 成立，且能给出「多几次」）。
   *   反之涨幅 ≤ N ⇒ 期间无人并发 ⇒ 拒绝来自服务端自身判定口径与 role.items 不一致（假设 ②）。
   */
  const OPENBOX_CALL_STAT = "today:open:box";
  const OPENBOX_SCORE_STAT = "activity:open:box";
  const readStatNumber = (role, key) => {
    const raw = role?.statistics?.[key];
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  /** 计数器可读文案；读不到时打 `-`（不要把「读不到」显示成 0，会误导） */
  const openboxCounterText = (role) =>
    `${OPENBOX_CALL_STAT}=${
      readStatNumber(role, OPENBOX_CALL_STAT) == null
        ? "-"
        : fmtNum(readStatNumber(role, OPENBOX_CALL_STAT))
    }、${OPENBOX_SCORE_STAT}=${
      readStatNumber(role, OPENBOX_SCORE_STAT) == null
        ? "-"
        : fmtNum(readStatNumber(role, OPENBOX_SCORE_STAT))
    }`;

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
   * 不符抛错防盲做（2026-09-29 master 口径；Item_OpenBoxResp.role.items 实证携带余额）
   * progress = 可选的进度记账对象（诊断用）：记录「本次已成功开多少 / 被拒的是哪一帧」 */
  const sendOpenBoxSteps = async ({ tokenId, token, steps, inventory, progress }) => {
    let lastResp = null;
    let total = 0;
    let lastItems = inventory ?? null;
    for (const step of steps) {
      for (const n of chunkBatches(step.number, OPENBOX_BATCH_SIZE)) {
        if (shouldStop.value) return lastResp;
        if (n < OPENBOX_BATCH_SIZE) {
          // 🔴 服务端只接受整批（单帧 number 恰好 = 10）：余数批会被拒
          //    「宝箱数量已发生变化，请重新操作」。规划层已按整批对齐
          //    （goldenfishConsumePlan.alignDownToBatch），这里是最后一道兜底 ——
          //    宁可少开这几个（与「差 3 次不做」同口径）也不要白发一帧被拒。
          log(
            token.name,
            `⏭️ 开箱余数 ${fmtNum(n)} 个不足一批(${fmtNum(OPENBOX_BATCH_SIZE)})，跳过（服务端只认整批开箱）`,
            "warning",
          );
          continue;
        }
        if (progress) {
          // 先登记「待发帧」：若这条被服务端拒，progress 里留下的就是被拒帧的实参
          progress.pendingItemId = step.itemId;
          progress.pendingNumber = n;
          // 计数「本机一共发了几帧」——与「服务端调用次数涨幅」比对即可判定是否有人并发（见 openboxCounterText）
          progress.framesAttempted += 1;
        }
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
        if (progress) progress.opened = total;
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
   *
   * ✅ 2026-09-29 定案（`local-data/goldenfish/batch_log1.txt` 18:14 那轮）：真凶是
   *    **服务端只接受整批开箱（单帧 number 恰好 = 10），余数批被拒**。
   *    排查路径（保留在此，供将来复用）：
   *      17:05 / 17:23 首测「重读 + 重规划 3 次全被拒」⇒ 否掉「快照过期」这一层；
   *      随后用「服务端绝对计数器」把两个候选成因机械判定干净：
   *        · ① 同角色并发：本机帧数 vs `today:open:box` 涨幅。新日志里**全部失败号**都是
   *          `涨 0 ≤ 本机 1 帧` + 计数器前后完全不变 + 两次读库存一致 ⇒ **① 被证伪**。
   *      账号画像给出最后一击：失败号全是「木箱数 − 200 = 2~8」（可开 < 一批）；
   *        而 `28c-2-625238513` 计划 885 → 切成 [10×88, 5] → **前 88 帧全成、第 89 帧(5)被拒**
   *        （其 today:open:box 1,768→1,856 = +88，与本机成功帧数精确吻合）。
   *      ⇒ 落点在 `OPENBOX_BATCH_SIZE` 注释里；规划层 `alignDownToBatch` 已消除余数批，
   *        本函数最终诊断里的「并发判定」留作回归探针（正常情况下不会再出现）。
   */
  const sendOpenBoxStepsWithReread = async ({ tokenId, token, replan }) => {
    for (let attempt = 0; ; attempt += 1) {
      const freshRole = await fetchRoleWithLimit(tokenId, token);
      const plan = replan(freshRole) ?? {};
      const steps = plan.steps ?? [];
      if (steps.length === 0) {
        return { empty: true, role: freshRole, plan };
      }
      const progress = { opened: 0, framesAttempted: 0, pendingItemId: null, pendingNumber: null };
      try {
        const lastResp = await sendOpenBoxSteps({
          tokenId,
          token,
          steps,
          inventory: freshRole?.items,
          progress,
        });
        return { empty: false, lastResp, role: freshRole, plan };
      } catch (error) {
        if (!isChestCountChangedError(error)) throw error;
        const planText = steps.map((s) => `${s.itemId}×${s.number}`).join("、");
        if (attempt >= 2) {
          // 最后一次：把关键诊断一次打全（计划 / 已开 / 被拒帧 / 拒绝后重读 / 计数器涨幅）
          const afterRole = await fetchRoleWithLimit(tokenId, token).catch(() => null);
          log(
            token.name,
            `❌ 开箱被服务端拒绝（第 ${attempt + 1} 次，不再重试）：计划 ${planText}；` +
              `本次已成功开 ${fmtNum(progress.opened)} 个；被拒帧 itemId ${progress.pendingItemId} × ${progress.pendingNumber}`,
            "error",
          );
          log(
            token.name,
            `诊断：开箱前读到的库存 ${chestInventoryText(freshRole?.items)}；` +
              `被拒后重读 ${afterRole ? chestInventoryText(afterRole.items) : "失败"}；` +
              `服务端返回 ${errorText(error)}`,
            "error",
          );
          if (afterRole) {
            const before = readChestInventory(freshRole?.items);
            const after = readChestInventory(afterRole.items);
            const changed = Object.keys(before).filter((id) => before[id] !== after[id]);
            log(
              token.name,
              changed.length > 0
                ? `⚠️ 两次读到的宝箱数量不一致（${changed.map((id) => `${id}: ${before[id]}→${after[id]}`).join("，")}）`
                : `两次读到的宝箱数量一致（${chestInventoryText(freshRole?.items)}）`,
              "warning",
            );
          }
          // 🔎 并发判定：服务端绝对计数器（唯一能「证明有人并发」的证据）
          const f0 = readStatNumber(freshRole, OPENBOX_CALL_STAT);
          const f1 = readStatNumber(afterRole, OPENBOX_CALL_STAT);
          log(
            token.name,
            `🔎 开箱计数器（服务端累计，非本机口径）：开箱前 ${openboxCounterText(freshRole)}；` +
              `被拒后 ${afterRole ? openboxCounterText(afterRole) : "重读失败"}`,
            "error",
          );
          if (f0 != null && f1 != null) {
            const deltaCalls = f1 - f0;
            const own = progress.framesAttempted;
            if (deltaCalls > own) {
              log(
                token.name,
                `🚨 并发判定：本机这次只发了 ${fmtNum(own)} 帧，但服务端「今日开箱调用次数」涨了 ${fmtNum(deltaCalls)} 次` +
                  `（多出 ${fmtNum(deltaCalls - own)} 次不是本机发的）⇒ **确有另一个客户端/运行在开同一个角色**，` +
                  `「宝箱数量已发生变化」由此而来 —— 请先停掉其它窗口/设备/定时任务再跑`,
                "error",
              );
            } else {
              log(
                token.name,
                `ℹ️ 并发判定：服务端调用次数涨幅 ${fmtNum(deltaCalls)} ≤ 本机本次帧数 ${fmtNum(own)}` +
                  `⇒ 这期间**没有第三方在开这个号**；拒绝不是并发导致。` +
                  `若被拒帧 number < ${fmtNum(OPENBOX_BATCH_SIZE)}，就是服务端「只认整批开箱」的余数批规则` +
                  `（已由发送层过滤，正常情况下不该再出现本行 —— 出现即回归，请把这行发给排查人）`,
                "error",
              );
            }
          }
          throw error;
        }
        log(
          token.name,
          `⏳ 宝箱数量已变化（服务端库存与计划不一致），2 秒后重新读库存重试（第 ${attempt + 1}/2 次）：` +
            `本次计划 ${planText}，已发 ${fmtNum(progress.framesAttempted)} 帧/已开 ${fmtNum(progress.opened)} 个，` +
            `被拒帧 ${progress.pendingItemId} × ${progress.pendingNumber}；` +
            `开箱前计数器 ${openboxCounterText(freshRole)}`,
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
      `宝箱消耗开始（活动 ${progressFirst.activityId}）：${progressText(target, accumulated, null, "宝箱")}`,
      "info",
    );
    // 🔴 真实宝箱库存必须进日志（2026-09-29 教训：这里原先是 "-" 占位符，被 fmtNum 折成 0，
    //    线上排查「宝箱数量已发生变化」时看不出手里到底有多少箱）
    log(
      token.name,
      `宝箱库存：${chestInventoryText(role?.items)}（木箱保留 ${fmtNum(WOODEN_RESERVE)} 个不动）；` +
        `可开积分约 ${fmtNum(chestScoreAvailable(role?.items))}（整批口径，单批 ${fmtNum(OPENBOX_BATCH_SIZE)} 个）；未兑换宝箱积分 ${fmtNum(role?.boxPoint)}（下一档 ${fmtNum(role?.boxPointLastReward)}）；` +
        `服务端计数器 ${openboxCounterText(role)}`,
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
          `宝箱消耗暂停：积分不足且无箱可开（累积 ${fmtNum(accumulated)}/${fmtNum(target)}；` +
            `可开积分按整批口径算，单批 ${fmtNum(OPENBOX_BATCH_SIZE)} 个，余数不足一批的开不动），等商店补货后再跑`,
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
   * 2026-09-29：**招募与钓鱼并行**（独立限流），**宝箱独占串行**（背包乐观锁敏感 ——
   * 与活动任务并发时服务端会以「宝箱数量已发生变化」拒绝，见 `PARALLEL_CONSUME_STEPS` 注释）。
   * `config.serialConsume = true` 可全部回退串行。
   */
  const goldenfishConsumeAll = (config) =>
    runGoldenfish(
      ["consumeRecruit", "consumeBoxes", "consumeFish"],
      "金鱼消耗（招募/钓鱼并行，宝箱独占）",
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
