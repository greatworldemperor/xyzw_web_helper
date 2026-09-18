# 逍遥津（限时临时活动）协议与批量实现

抓包：`local-data/xiaoyaojin/xyzw-runtime-wss-2026-09-18T17-58-18-440Z.jsonl`
（bridge 2026-09-16.1，passive-capture，token `海王-0-666543015` @26501 服）

验证：`verify_roundtrip.mjs --dir send` → **SEND 15/15 精确逐字节复现，0 失败**
（另 3 帧是 1 字节明文心跳，属预期）。

抓包时刻：`2026-09-18T17:57Z … 17:58Z` = **北京 2026-09-19 01:57~01:58**。

---

## 1. 抓包里的 4 件事（master 口述顺序 = 抓包顺序）

| # | 动作 | 命令 | 请求体 | 响应 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 每日任务奖励（只拿了登录奖） | `activity_warordertaskclaim` | `{actId:2609191, missionId:260919101}` | `Activity_WarOrderClaimResp` | 道具 5282 ×300 |
| 2 | 一次性奖励 | `activity_commonbuygoods` | `{goodsId:26091941}` | `SyncRewardResp` (resp=47) | 道具 5283 ×1 |
| 3 | 7 天登录奖励 | `activity_claimsignreward` | `{activityId:2609195, patchDay:0}` | `Activity_RewardResp` | 道具 1001 ×30 |
| 4 | 抽奖 | `activity_lottery` | `{times:1}` | `Activity_LotteryResp` | 金币 5000000 + pack 2609192 |

抽奖前先发了 `activity_getlotteryinfo {}` → `Activity_GetLotteryInfoResp{lotteryInfo:{boxPackIdList:[]}}`（只读，无参数）。
抓包末尾还补领了 `activity_warordertaskclaim` 的 `missionId:260919105`（另一个每日任务）。

**关键实测：抽奖消耗 5283**——第 2 步礼包给了 `5283 ×1`，第 4 步抽奖响应里 `role.items["5283"] = null`（归零）。
所以「礼包 → 抽奖」是有依赖的顺序，且**抽奖次数受 5283 余额约束**。

## 2. 活动实例 ID 规则（全服固定映射，跨账号一致）

```
YYMMDD + 功能位
  1 → 战令     = warOrderActivityInfo 的键           260919 → 2609191
  2 → 抽奖奖池 pack                                  260919 → 2609192
  4 → 一次性礼包（商品 ID = 活动 ID + "1"）           260919 → 2609194 / 26091941
  5 → 7 天登录                                       260919 → 2609195
```

日期头 = **活动开启日**（不是「今天」）。本期为 2026-09-19 开、7 天（7 天签到佐证），
第 1 天签到后 `record = {"1": 1789754264}`（键 = 天数序号）。

战令内部 ID = 战令实例 ID + 2 位序号：

| 序号段 | 含义 | 出现在 |
| --- | --- | --- |
| `01`~`30` | 每日任务（本期 01~06 共 6 个） | `taskClaimed`（全量 6 键） |
| `41`+ | 战令等级奖励（本期 41~73 共 33 级） | `rewardClaimed` / `complete` |

抓包第一节 `Activity_WarOrderGetResp`（`activity_warorderget {actId}`）：

```jsonc
{ "activity": { "warOrderActivityInfo": { "2609191": {
  "complete":    { "260919101": 1, "260919102": 0, … "260919141": 0 … "260919173": 0 },
  "taskClaimed": { "260919101": false, … "260919106": false },   // 只有每日任务
  "rewardClaimed": {},
  "dailyTime": 1789747200,  // 北京 09-19 00:00（当日切点）
  "weekTime":  1789315200,  // 北京 09-14 00:00（周一）
  "itemNum": 0, "unlockClaimed": false, "purchased": false
} } } }
```

抽奖后服务端**推送**了一份 `Activity_GetResp`（`ack:50`、无 `resp`，属广播而非应答），
其中 `complete` 变化：`260919105 → 1`（抽奖使该每日任务达成），`260919150`~`260919169`（序号 50~69）→ 1。

## 3. 状态从哪来：`activity_get`

`activity_get {}` → `Activity_GetResp`，根在 **`body.activity`**：

| 字段 | 内容 |
| --- | --- |
| `warOrderActivityInfo` | 按战令实例 ID 索引（历史版本里出现过 `1` / `1003` 等非 YYMMDD 键） |
| `commonActivityInfo` | 按公共活动实例 ID 索引，形如 `{ "2609194": {record:{26091941:1}, task:{}, isBought:false}, "2609195": {record:…} }` |
| `activity[]` | 周商店（11 金砖达标 / 9 江湖黑市 / 5 金砖商店），与本活动无关 |

⚠️ `commonActivityInfo` 在服务端**按变化分片推送**（抓包里只出现在 `Activity_Notify` / `Activity_RewardResp`），
`activity_get` 只保证 schema 含该字段，**不保证含本期键** → 只能当「佐证」，不能当唯一依据。
因此本实现把「签到 / 礼包 ID」**从战令实例 ID 派生**（同族同日期头），并在 `commonActivityInfo` 命中时打标确认。

⚠️ **嵌套语义极易写错（2026-09-19 实机探测抓出来的）**：

```
commonActivityInfo = {
  "2609194": { record: { "26091941": 1 }, task: {}, isBought: false },   // 外层 = 礼包「活动实例 ID」
  "2609195": { record: { "1": 1789754264 }, task: {}, isBought: false }  // 外层 = 签到「活动实例 ID」
}
```

**外层键是活动实例 ID（`2609194` / `2609195`），`26091941` 只是礼包自己 `record` 里的内层键。**
拿 goodsId（`26091941`）去查外层会**永远查不到** —— v1 就是这么写的，实机日志报「礼包 26091941（推送中未确认）」，
看着像服务端没推，其实是本地查错了键（已修，并加了「错误结构不得被认成已确认」的回归用例）。
顺带得到两个可用判据：`record[goodsId] >= 1` = 本期礼包已领（可省一次请求）；`record` 的键 = 已记录的第几天。

## 3.1 实机探测结果（2026-09-19 02:37，账号 21号战士 @139084096）

```
21号战士-0-139084096 逍遥津活动实例 2609191（开启于 0 天前）；
签到 2609195（推送中已确认）/ 礼包 26091941（推送中未确认）；
每日任务待领 1 个 / 未达成 5 个
```

- ✅ 自动探测拿到 `2609191`，`ageDays = 0` → **日期头 = 开启日的推导在真实账号上成立**
- ✅ 签到 `2609195` 被 `commonActivityInfo` 命中 → **同族 ID 派生规则（YYMMDD + 功能位）正确**
- ✅ 「待领 1 / 未达成 5」与抓包首帧（只有 `01` 登录达成）**完全一致** → 每日任务清单推导正确
- ❌ 「礼包未确认」是上面那个查错键的 bug（非服务端未推）

## 4. 实现落点

| 文件 | 职责 |
| --- | --- |
| `src/utils/xiaoyaojinPlan.js` | 纯逻辑：活动实例探测（7 位 YYMMDD 键 + 存活窗口取最新）、同族 ID 派生、每日任务清单、战令等级统计、抽奖次数约束。**可被 node 测试直接导入** |
| `src/utils/batch/tasksXiaoyaojin.js` | 批量任务：5 个入口（全套/每日任务/一次性礼包/7 天登录/抽奖）+ `inspectXiaoyaojin` 预览 |
| `src/utils/xyzwWebSocket.js` | 注册 6 条新命令 + 响应映射（`syncrewardresp` 增 `activity_commonbuygoods`） |
| `src/views/BatchDailyTasks.vue` | 批量任务页底部「临时活动」标签页；任务分组 / 自由模板分组同步 |
| `test/xiaoyaojinPlan.test.js` | 16 例回归（含真实抓包快照） |

### 关键实现选择

- **不写死活动 ID**：每账号跑 `activity_get` 现场探测，取日期头最新的 7 位战令键，据此派生签到/礼包 ID。
- **抽奖逐次发**：`times: 1` × N（与抓包逐字节一致），N = `min(界面配置, 5283 余额)`；遇错立即停。
  余额读不到时**不拦**（`resolveLotteryDraws` 把 `null/undefined/""` 视为「未知」而非 0——
  早期实现用 `Number(null)=0` 会误判成零券直接跳过，已被回归测试锁住）。
- **`patchDay: 0` = 领当天那一份**（抓包实证：第 1 天领取后 `record` 写入键 `"1"`）。
  缺签补签的天数语义未知 → **本工具不代为补签**。
- **幂等重跑**：已领取 / 已购买 / 未达成 都归入 info 级日志，不记 error、不打断其它账号。
  一次性礼包更进一层：`commonActivityInfo[礼包活动ID].record[goodsId] >= 1` 时**直接跳过**（连请求都不发）。
- **战令等级奖励（41+）不在这次范围**：日志里给出「还有 N 个可领」的提示，需在游戏内领取。

### 已知缺口

- `activity_warorderget` 已注册但批量流程未使用（`activity_get` 已含完整 `warOrderActivityInfo`）；
  保留注册是为了后续「只刷战令」的轻量调用。
- 战令等级奖励的领取命令**未抓到**（`rewardClaimed` 全空），要自动化需补抓一次点领取的包。
- 抽奖券 5283 之外的抽奖成本（是否还扣 5282 逍遥币）未验证 —— 抓包只有 1 次抽奖，
  且 `times>1` 的整包调用未验证，故实现只逐次发 `times:1`。
