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

| 序号段 | 含义 | 领取命令 | 已领标记 |
| --- | --- | --- | --- |
| `01`~`30` | 每日任务（本期 01~06 共 6 个） | `activity_warordertaskclaim {actId, missionId}` | `taskClaimed[missionId] === true` |
| `41`+ | 战令等级奖励（本期 41~73 共 33 条） | **同一个命令**（09-19 第二次抓包实证） | **同样在 `taskClaimed`** |
| — | 战令奖励宝箱（另一套） | `activity_warorderrewardclaim {actId}`（一键） | `rewardClaimed[4位奖励ID]` |

⚠️ 三处都写进 `complete`：它是**进度数值**（`101:41 / 141:4000 / 150:2 / 144:0`），**不是布尔**。
达标阈值在客户端配置里，本地拿不到 → 「是否可领」只能靠服务端裁定（见 §5.3）。

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
| `src/utils/xiaoyaojinPlan.js` | 纯逻辑：活动实例探测（7 位 YYMMDD 键 + 存活窗口取最新）、同族 ID 派生、每日任务清单、**战令等级奖励候选**、抽奖次数约束。**可被 node 测试直接导入** |
| `src/utils/batch/tasksXiaoyaojin.js` | 批量任务：7 个入口（全套/每日任务/战令宝箱/战令等级奖励/一次性礼包/7 天登录/抽奖）+ `inspectXiaoyaojin` 预览 |
| `src/utils/xyzwWebSocket.js` | 注册 7 条命令 + 响应映射（`activity_warorderclaimresp` 一响应四命令、`syncrewardresp` 增 `activity_commonbuygoods`） |
| `src/views/BatchDailyTasks.vue` | 批量任务页底部「临时活动」标签页；任务分组 / 自由模板分组同步 |
| `test/xiaoyaojinPlan.test.js` | 18 例回归（含两份真实抓包快照） |

### 关键实现选择

- **不写死活动 ID**：每账号跑 `activity_get` 现场探测，取日期头最新的 7 位战令键，据此派生签到/礼包 ID。
- **抽奖逐次发**：`times: 1` × N（与抓包逐字节一致），N = `min(界面配置, 5283 余额)`；遇错立即停。
  余额读不到时**不拦**（`resolveLotteryDraws` 把 `null/undefined/""` 视为「未知」而非 0——
  早期实现用 `Number(null)=0` 会误判成零券直接跳过，已被回归测试锁住）。
- **`patchDay: 0` = 领当天那一份**（抓包实证：第 1 天领取后 `record` 写入键 `"1"`）。
  缺签补签的天数语义未知 → **本工具不代为补签**。
- **幂等重跑**：已领取 / 已购买 / 未达成 都归入 info 级日志，不记 error、不打断其它账号。
  一次性礼包更进一层：`commonActivityInfo[礼包活动ID].record[goodsId] >= 1` 时**直接跳过**（连请求都不发）。
- **战令等级奖励逐个试（41+）**：本地只圈 `complete > 0` 且 `taskClaimed !== true` 的候选，
  **是否真达标交给服务端裁定**（未达标 `700010` / 已领 `700020`）→ 失败只计数、汇总一行，不刷屏。
  间隔用 `max(500ms, actionDelay)`，贴近真人点击节奏。
- **「一键全套」顺序**：每日任务 → 战令宝箱 → 战令等级奖励 → 一次性礼包 → 签到 → 抽奖
  （宝箱与等级奖励都产抽奖券 5283，**必须在抽奖之前**）。

## 5. 第二次抓包（`some_new_data.jsonl`，2026-09-19 16:20，账号 momo @9724服）

`verify_roundtrip.mjs --dir send` → **SEND 24/24 精确，0 失败**。这一份补上了战令奖励的完整链路。

### 5.1 新增命令 `activity_warorderrewardclaim { actId }`

- 响应同样是 `Activity_WarOrderClaimResp`（所以一个响应名现在对应 **4** 个请求命令）
- 是**一键领取**：实测两次调用分别给 `5283×1 + 10002×400` 与 `5283×2`（数量随当下可领宝箱数变化）
- 它写的是 **`rewardClaimed`**，键是 **4 位奖励 ID**（`{"1221":1,"1222":1,"1223":1}`），与 `complete` 里的 9 位 missionId **毫无对应关系**
- **产抽奖券**，所以应排在抽奖之前

### 5.2 纠正：战令等级奖励用的是**同一个** `activity_warordertaskclaim`

```
activity_warordertaskclaim { actId:2609191, missionId:260919141 }  → 成功，5282 ×400
activity_warordertaskclaim { actId:2609191, missionId:260919147 }  → 成功，5282 ×400
activity_warordertaskclaim { actId:2609191, missionId:260919148 }  → 成功，5282 ×400
activity_warordertaskclaim { actId:2609191, missionId:260919149 }  → 成功，5282 ×400
```

**每日任务（序号 01~30）与战令等级奖励（序号 41+）共用同一个命令、同一个 `taskClaimed` 字段**，
只靠 missionId 末两位区分。`taskClaimed=true` 的完整集合 = `[101,103,104,105,106] ∪ [141,147,148,149]`。

### 5.3 纠正：`complete[key]` 是**进度数值**，不是布尔标记

```
101:41   102:0   103:3   104:13  105:2   106:3      ← 每日任务进度
141:4000 142:4000 143:4000 144:0 145:0 146:0        ← 战令奖励条目
147:21   148:21  149:21
150:2 … 169:2                                        ← 50~69
170:0 … 173:0
```

- v1 假设 `>=1` 就是「可领」→ 对 10x 段侥幸成立（当天 `101:1` 就能领），但**对 41+ 段不成立**：
  `142/143` 与已领的 `141` 同为 4000，`150~169` 为 2，`144~146/170~173` 为 0
- 真正的「是否达标 / 是否可领」阈值在**客户端配置**里（我们拿不到）→ 实现改为
  「`complete > 0` 圈候选 + 服务端裁定」
- ⚠️ 另一个 v1 的错：用 `rewardClaimed` 判等级奖励是否已领。`rewardClaimed` 是 5.1 那套**另一套奖励**，
  键长 4 位，永远匹配不上 9 位 missionId → 会把**已领的 `141`（`complete:4000`）当成可领**。
  正确判据是 `taskClaimed[missionId] === true`。

### 5.4 `lotteryInfo.lotteryNum` = **累计抽奖次数**

```
getlotteryinfo      → {lotteryNum:1, fragProgress:1}     ← 本次已抽过 1 次
lottery ×1          → {lotteryNum:2, fragProgress:2}
lottery ×1          → {lotteryNum:3, fragProgress:3}
lottery ×1          → {lotteryNum:4, fragProgress:4}
```

- 递增语义 = **已抽总次数**（不是剩余次数），`fragProgress` 同步
- 首次抓包（凌晨那个账号）该字段**整个缺失** = 值为 0 被 BON 省略 → 与「尚未抽过」自洽
- 抽奖券消耗再次确认：`5283: 2 → 1 → null`（每次 −1）

### 5.5 顺带的确认

- 每日任务奖励固定 `5282 ×300`（10x 段）；等级奖励 `5282 ×400`（41+ 段）
- 抽奖产物：`type 2 itemId 0`（金砖类）、`itemId 1022`、金币等，另有 `lotteryPackIdList` 回执
- `discount_getdiscountinfo {}` 与逍遥津无关（折扣商店），忽略

### 已知缺口

- `activity_warorderget` 已注册但批量流程未使用（`activity_get` 已含完整 `warOrderActivityInfo`）；
  保留注册是为了后续「只刷战令」的轻量调用。
- `rewardClaimed` 的 4 位奖励 ID（1221/1222/1223）**语义未知**（疑似按等级解锁的宝箱档位），
  但由于服务端提供一键领取，实现无需知道档位细节 —— 直接调 `activity_warorderrewardclaim` 即可。
- 抽奖券 5283 之外的抽奖成本（是否还扣 5282）未验证；`times>1` 的整包调用未验证 → 实现只逐次发 `times:1`。
- `complete` 的达标阈值在客户端配置里，本地不猜；「战令等级奖励」因此逐个试（候选多时较慢）。
