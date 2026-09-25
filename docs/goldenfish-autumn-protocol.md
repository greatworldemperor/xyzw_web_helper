# 金鱼（秋季活动 autumn_*）协议备忘

> 来源：`local-data/goldenfish/use_one_item.jsonl`（2026-09-25 抓包，`wss://xxz-xyzw.hortorgames.com/agent`，x 方案 px 帧）
> 商店部分来源：`local-data/goldenfish/shop_list.jsonl`（2026-09-25 抓包）
> 实现：`src/utils/batch/tasksGoldenfish.js`，入口 `/admin/batch-daily-tasks` → 批量功能。
> 「商店购物列表」按 master 指示放在「日常」栏目（常规操作，金鱼等活动的商店通用）；
> 金鱼 tab 只保留投道具。

## 命令

### 投道具（投一个道具）

```
SEND autumn_useitem  body = { itemNum: 1 }
```

- 请求体**只有数量**，没有 itemId —— 服务端自动扣减投掷道具（抓包中账号道具 1006 余量 344400）。
- 响应 `Autumn_UseItemResp`：
  - `reward: [{ type, itemId, value, ext }]` —— 本次投掷奖励（抓包：`itemId 1006 ×10`）
  - `distance` / `roleAutumn.distance` —— 前进距离（=itemNum）
  - `roleAutumn: { areaId, itemNum, distance, lastUseItemTime, lastUseItemNum, incUId, groupIdId }`
  - `role.items: { "1006": { quantity }, "5286": { quantity } }` —— 道具余额快照

### 排行榜（暂未接入批量）

```
SEND autumn_getrolerank  body = {}          （ack = UseItemResp 的 seq）
RESP Autumn_GetRoleRankResp  list: [{ roleId, serverId, name, itemNum, rank, distance, score, ... }]
```

### 商店购物列表（自动购买，09-25 接入批量）

```
SEND store_getpurchase  body = {}
RESP Store_GetPurchaseResp  { purchaseCnt, purchaseItemList: [{ itemId, discount }] }

SEND store_setpurchase  body = { purchaseCnt, purchaseItemList: [{ itemId, discount }] }
RESP Store_SetPurchaseResp  回显设置后的列表（按 itemId 升序，与发送顺序无关）
```

- `discount` = 折扣阈值（整数折，10 = 原价）；商店刷新出 ≤ 阈值的折扣时服务端自动购买。
- `purchaseCnt` = 游戏里的**刷新次数**（09-25 晚 master 口径确认，抓包提交 15）；
  实现优先用页面配置值，未配置沿用 `getpurchase` 返回的现值，最后兜底 15。
  回显比对同时校验列表与 purchaseCnt。
- itemId 对照（金鱼活动商店，抓包 #525 实测）：

| itemId | 商品     | master 口径 |
| ------ | -------- | ----------- |
| 2002   | 青铜宝箱 | 5 折        |
| 2003   | 黄金宝箱 | 5 折        |
| 2004   | 铂金宝箱 | 8 折        |
| 1001   | 招募令   | 10 折（原价） |
| 1012   | 黄金鱼竿 | 8 折        |

- 以上 5 项即「金鱼模式」预设（`GOLDENFISH_SHOP_DEFAULTS`）；页面可改折扣/勾选/刷新次数，
  localStorage `goldenfishShopSettings` 记忆（旧版纯数组存档兼容读取）。其他商品 itemId 未抓到，暂不支持自定义添加。
- 回归：`test/goldenfishShop.test.js` —— 默认配置构造的 setpurchase body 与抓包 #525 帧逐字节一致。

## 实现要点

- 每账号每次调用发 1 次 `{ itemNum: N }`（N 默认 1，页面可调；抓包只实测过 N=1）；
  道具不足 / 活动未开（错误文案含「未开启/已结束/无效的/不足」）视为正常跳过，不算失败。
- 限流 400340 → warning 后 break（不能 continue 跳过 sleep 造成连发，同逍遥津）。
- 批量页面栏目「金鱼」：`taskGroupDefinitions` + tab-pane；**刻意不进自由/定时模板**
  （09-25 master 指示，待做完整自动金鱼）；回归测试 batch 任务总数维持 36。

## 完整自动金鱼 · 待验证清单（活动开放时间实测）

1. **`itemNum: N`（N>1）是否单发生效**：抓包 resp 里 `roleAutumn.lastUseItemNum` 与 `itemNum` 同值，
   理论上单发投 N 个；若服务端按 1 处理则改为循环 N 次（每次 sleep）。
2. **投的到底是哪个道具**：请求体无 itemId，抓包账号道具 1006（×344400）/ 5286（×17）；
   用 resp `role.items` 前后对比余额变化确认扣减哪个（疑似 1006 鱼食类）。
3. **每日投掷上限 / 冷却**：`roleAutumn.lastUseItemTime`（秒级）+ `statistics["au:f:le:id:<期号>"]`
   疑似累计分/距离；确认是否存在每日次数上限，决定自动任务「投到上限」的判定方式。
4. **areaId / groupIdId / incUId 机制**：区域推进与奖励档位关系未摸清，需多点采样。
5. **活动开放判定**：用哪个命令/字段判断「活动已开」做前置跳过（暂靠错误文案兜底）。
6. **排行榜**：`autumn_getrolerank {}` 的 ack 时序（抓包 ack=UseItemResp.seq）、
   `score` 与 `distance` 关系；自动金鱼是否需要榜上进度展示。
