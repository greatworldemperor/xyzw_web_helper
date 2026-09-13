# 黑市周（江湖黑市）协议分析报告

> 抓包①：`local-data/weekly_events/blackmarketweek_purchase_goods.jsonl`（购买段，9986服 2862-2-706623335，2026-09-12 20:10 UTC）
> 抓包②：`local-data/weekly_events/blackmarketweek_purchase_goods_full.jsonl`（**登录起完整包**，9722服 22号战士-0-139081826，2026-09-13 07:43 UTC，购买相同商品）
> 解码：`decode_blackmarketweek.txt` / `decode_blackmarketweek_full.txt`（全文）；验证：`verify_blackmarketweek.txt` / `verify_blackmarketweek_full.txt`
> 解码时间：2026-09-13（北京时间）

## 1. 抓包概况

- meta: `xyzw-runtime-analysis-jsonl` v2，passive-capture，bridge 2026-09-09.1
- token: `2862-2-706623335`（9986服），主连接 `wss://xxz-xyzw.hortorgames.com/agent`
- 44 帧（SEND 15 / RECV 29），无 `pl`/lz4 帧，全部 `px` 方案
- 内容：一次完整的「黑市周购买」操作 —— 6 次 `activity_buystoregoods` 购买

命令直方图：

```
 6  >> activity_buystoregoods        （购买请求）
 6  << Activity_StoreNotify          （商店状态推送）
 6  << SyncRewardResp                （奖励同步，resp=请求seq）
 5  >> _sys/ack   5 << _sys/ack
 4  << Activity_TotalRewardNotify    （金砖达标进度）
 4  << OMail_NewMailNotify           （奖励邮件）
 4  >> mail_getmtlshortinfo  4 << Mail_GetMtlShortInfoResp
```

## 2. 活动组结构：黑市周 = 3 个子活动

`Activity_StoreNotify.body.activity.activity[]` 是一个活动组，包含：

| 子活动 | id | type | buyType | 说明 |
| --- | --- | --- | --- | --- |
| 金砖达标 | **11** | 12 | — | 本周花费金砖达里程碑领奖 |
| 江湖黑市 | **9** | 4 | 3 | 黑市商店（金砖购买，含免费商品） |
| 金砖商店 | **5** | 4 | 1 | 充值金砖礼包（**不是金砖购买**，批量日常不适用，但含 1 件免费商品） |

本期活动时间：`openTime 2026-09-11T04:00Z`（北京 09-11 12:00）～ `endTime 2026-09-17T16:00Z`（北京 09-18 00:00）。周重置时间 `1789099200` 与 openTime 一致。

### 2.1 江湖黑市（activityId=9）商品表 —— 本次分析的主角

| goodsIndex | 商品 | 价格(金砖) | 限购 | 内容 |
| --- | --- | --- | --- | --- |
| 0 | 黑市福利 | **0（免费）** | 1 | 金砖×500 |
| 1 | 黑市见面礼 | 600 | 1 | 招募令(1001)×5 + 精铁(1006)×1000 |
| 2 | 黑市惊喜礼 | 1200 | 1 | 招募令×10 + 进阶石(1003)×2000 |
| 3 | 初级黑市包 | 2500 | 1 | 进阶石×6000 |
| 4 | 中级黑市包 | 5000 | 1 | 木质(2001)/青铜(2002)/黄金(2003)/铂金(2004)宝箱各×10 |
| 5 | 高级黑市包 | 8000 | 1 | 招募令×40 + 邢道荣卡(3007)×50 |
| 6 | 顶级鱼竿包 | 12000 | 1 | 普通鱼竿(1011)×30 + 金鱼竿(1012)×30 |
| 7 | 白玉黑市包 | 2000 | 1 | 白玉(1022)×2000 |
| 8 | 特级灵贝包 | 25000 | 1 | 张星彩卡(1033)×10 |
| 9 | 养成补给包 | 8000 | **4** | 袁绍卡(1016)×2000 + 貂蝉卡(1026)×3000 |

结构字段：`data: { buyType: 3, itemId: 0, goodsList: [{ title, description, limit, price, rewardList[{type,itemId,value,ext}], titleId, descriptionId }] }`

### 2.2 金砖商店（activityId=5）—— 含免费金砖回馈

| goodsIndex | 商品 | 价格 | 限购 | 内容 |
| --- | --- | --- | --- | --- |
| 0 | 金砖回馈 | **0（免费）** | 1 | 金砖×200 |
| 1-5 | 各档金砖礼包 | 3000/6800/12800/32800/64800 | 1/1/1/5/10 | 金砖×660/1500/2820/7220/14260 |

价格单位是充值货币（非金砖，660 金砖卖 3000），属于充值礼包，批量功能**只应碰 goodsIndex 0（免费领 200 金砖）**。

### 2.3 金砖达标（activityId=11）里程碑

进度 = `myTotalInfo["11"].num` = 本周累计花费金砖（见 §4 wa:diamond）。

| 门槛 | 奖励 | 门槛 | 奖励 |
| --- | --- | --- | --- |
| 1000 | 招募令×5 | 20000 | 吕蒙卡(3201)×30 + 珍珠(1013)×1 |
| 5000 | 邢道荣卡×50 + 袁绍卡×2000 | 35000 | 邢道荣卡×150 + 珍珠×1 |
| 10000 | 吕蒙卡×20 + 普通鱼竿×5 | 50000 | 吕蒙卡×50 + 珍珠×2 |
| 15000 | 邢道荣卡×100 + 金鱼竿×5 | 75000 | 邢道荣卡×300 + 珍珠×2 |
| | | 100000 | 吕蒙卡×60 + 珍珠×2 |

## 3. 购买协议（核心结论）

### 3.0 商店状态查询（抓包②补齐）—— `activity_get`

```
SEND activity_get  body: {}          （空对象；登录 bootstrap 即发送）
RECV Activity_GetResp              （resp=seq，可 Promise 匹配）
```

`Activity_GetResp.body.activity` 一次给全批量任务所需的全部状态：

| 字段 | 内容 |
| --- | --- |
| `activity[]` | 整组活动配置：金砖达标(11)/江湖黑市(9)/金砖商店(5)，各含 `data.goodsList` 完整商品表（title/price/limit/rewardList）与 `openTime`/`endTime` |
| `myStoreInfo` | 已购状态：`{"5":{complete:{}},"9":{complete:{}}}`（登录时为空，购买后 goodsIndex→次数） |
| `myTotalInfo` | 金砖达标进度：`{"11":{num,rounds,complete,openTime}}`（本周累计花费金砖） |
| 其它 | `activityShop`（另一套商店记录）、`warOrderActivityInfo` 等，与本功能无关 |

### 3.1 购买请求与响应链

请求（可 Promise 匹配、逐字节复现）：

```
SEND activity_buystoregoods  body: { activityId: <Int>, goodsIndex: <Int>, buyNum: <Int> }
```

与招募周/宝箱周完全同构，无新编码逻辑。每次购买的服务器响应链：

| 顺序 | 命令 | 匹配方式 | 内容 |
| --- | --- | --- | --- |
| 1 | `Activity_StoreNotify` | **推送**（自带 seq、ack=0，不能按 resp 匹配） | 整组活动配置 + `myStoreInfo`（已购状态）+ `myTotalInfo` |
| 2 | `SyncRewardResp` | `resp` = 请求 seq（**Promise 匹配走这个**） | `body.role`（diamond/buyDiamond/items/statistics）+ `body.reward`（本次所得） |
| 3 | `Activity_TotalRewardNotify` | 推送 | 金砖达标进度（`myTotalInfo["11"].num`） |
| 4 | `OMail_NewMailNotify` → `mail_getmtlshortinfo` | 推送→拉取 | 部分奖励走邮件发放 |

**已购状态**：`myStoreInfo["9"].complete` 是 `{goodsIndex: 已购次数}` 的 Map，每次购买后 +1（抓包中随购买逐次出现 `"0":1` → `"0":1,"1":1` → …）。判断"本期已买过"应以此为准，服务端拒绝时错误码 `1100010`（现有招募周代码已处理）。

## 4. SyncRewardResp 字段语义（两账号 12 次购买全部对账验证）

抓包①（9986服）与抓包②（9722服）购买**完全相同的 6 件商品**，diamond 对账逐次吻合，语义跨账号成立：

| # | 购买 | 价格 | 抓包①diamond(买后) | 抓包②diamond(买后) | buyDiamond(两号相同) | wa:diamond | reward |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 5/0 金砖回馈(免费) | 0 | 546871 | 204186 | 200 | — | 金砖×200 |
| B | 9/0 黑市福利(免费) | 0 | 547371(+500) | 204686(+500) | 700 | — | 金砖×500 |
| C | 9/1 见面礼 | 600 | 546771(−600) | 204086(−600) | 100 | 600 | 招募令×5+精铁×1000 |
| D | 9/2 惊喜礼 | 1200 | 545571(−1200) | 202886(−1200) | 0 | 1800 | 招募令×10+进阶石×2000 |
| E | 9/4 中级黑市包 | 5000 | 540571(−5000) | 197886(−5000) | (缺省) | 6800 | 四种宝箱各×10 |
| F | 9/6 顶级鱼竿包 | 12000 | 528571(−12000) | 185886(−12000) | (缺省) | 18800 | 鱼竿×60 |

- `role.diamond`：购买后金砖余额（免费商品给金砖时反而增加，Δ 与价格完全吻合，12/12 对账无误）
- `role.statistics["wa:diamond"]`：**本周累计花费金砖 = 金砖达标进度**（600→1800→6800→18800 与 TotalRewardNotify 的 num 逐帧一致）；`statisticsTime["wa:diamond"]`= 周重置时间
- `role.items`：本次所得物品的最新数量（快照）
- `body.reward`：本次商品 rewardList 原文（免费金砖商品时为 `type:2, itemId:2` 金砖）
- `role.buyDiamond`：两号观测完全一致 200→700→100→0（后两次 0 时缺省）。= 本周通过该活动净获得金砖（获得−花费，下限 0）。**两次独立观测吻合，仍为推测语义，对实现无影响**

已购状态最终形态（抓包②，全部买完后）：`myStoreInfo = {"5":{complete:{"0":1}}, "9":{complete:{"0":1,"1":1,"2":1,"4":1,"6":1}}}`。

## 5. 复现验证（skill 闸门）

- 抓包① `--dir send`：**15/15 全部「精确」**（activity_buystoregoods 6/6）
- 抓包② `--dir send`：**58/58 全部「精确」**——含登录帧 `role_getroleinfo`、`activity_get`（空对象）、6 帧 `activity_buystoregoods` 及其余全部 bootstrap 查询，0 仅tag不同、0 失败

→ 相关命令格式已完全掌握，可以照着写客户端代码。

## 6. 与现有批量功能的对照

| 批量任务 | activityId | goodsIndex | 内容 |
| --- | --- | --- | --- |
| 招募周一次性奖励 | 6 | 0 | 招募令×5（免费） |
| 宝箱周免费奖励 | 7 | 0 | 免费 + `activity_claimredquenchreward` 红淬 |
| **黑市周（待实现）** | **9**（黑市）/ 5（金砖回馈） | 多个 | 1 件免费 + 9 件付费 |

activityId 已跨两个账号（9986服/9722服）验证一致，是全服固定映射。命令 `activity_buystoregoods` 已在 `xyzwWebSocket.js` 注册（默认参数是招募周的 6/0），`SyncRewardResp` 的 Promise 映射已存在；`activity_get` 也已注册（见 `xyzwWebSocket.js` 活动/任务段），无需动协议层。

## 7. 黑市周批量任务的实现要点

1. **闭环流程（抓包②后可全做）**：`activity_get` 拿商品表+已购状态 → 按 `goodsList` 的 `price`/`limit` 与 `myStoreInfo.complete` 过滤出可买商品 → 逐件 `activity_buystoregoods` → 用 `SyncRewardResp`（resp 匹配）确认 + 记录 `statistics["wa:diamond"]` 进度
2. **免费部分无脑做**：`{activityId:9, goodsIndex:0}`（金砖×500）+ `{activityId:5, goodsIndex:0}`（金砖×200），共白嫖 700 金砖
3. **付费部分做成选项**：9 件付费商品价格跨度 600～25000，默认只买免费，付费商品按用户勾选（或按余额阈值）逐件购买；每次购买间留 `delayConfig.action` 间隔
4. **已购判断**：首选 `activity_get` 的 `myStoreInfo` 预判（不浪费请求）；服务端拒绝兜底 `1100010`（沿用现有模式）
5. **金砖不足**：服务器报错码两份抓包均未覆盖（两号金砖都充足），首版用通用错误处理即可
6. **买什么不做**：金砖商店 1-5 号是充值礼包，绝不进批量逻辑

## 8. 开放问题

1. ~~商店初始状态查询命令未抓到~~ **已解决（抓包②）**：`activity_get` 空 body 一次返回商品配置+已购状态+金砖达标进度
2. `buyDiamond` 的准确语义（两号独立观测均符合"本周活动净得金砖，下限 0"，仍为推测）
3. 金砖不足/超出限购的具体错误码（需一个金砖不足的账号再抓）
