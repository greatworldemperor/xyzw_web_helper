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

## 金鱼消耗任务（第一步「初步消耗」，2026-09-26）

需求：`local-data/goldenfish/a_brief_introduction.txt`。目标：招募累积 3900 次 /
宝箱累积 99000 分 / 钓鱼（黄金竿 1012）累积 1150 次；金砖消耗 10 月 1 日收尾再做；
收罐子自然完成。全部复用既有命令，**零新协议**：

| 操作 | 命令 | 备注 |
| --- | --- | --- |
| 招募 | `hero_recruit { recruitType:1, recruitNumber:N }` | 10/发+余数，消耗招募令 1001 |
| 开宝箱 | `item_openbox { itemId, number:N }` | 10/发+余数；铂金 50/黄金 20/青铜 10/木质 1 分 |
| 积分兑宝箱 | `item_claimboxpointreward {}` | 一轮 9 档共 500 分，第 9 档必得钻石宝箱(2005) |
| 未兑换积分 | `role.boxPoint` / `role.boxPointLastReward` | 下一档索引 0~8 |
| 钓鱼 | `artifact_lottery { type:2, lotteryNumber:N, newFree:true }` | 只用黄金鱼竿 1012（master 拍板） |

算法（master 伪代码，`src/utils/goldenfishConsumePlan.js` 纯逻辑实现）：
`while(累积 + 手里可开分 < 目标) { 全开 → 积分全兑 → 重查 }`，退出后差值精确开箱
（铂金→黄金→青铜→木质，ceil 保证达标，超出留在未兑换积分不兑换）。
**钻石宝箱一律不开；木箱全程保留 200 个**（2026-09-26 master 拍板）。

- 实现：`tasksGoldenfish.js` 三个 step + `goldenfishConsumeAll` 一键（招募→宝箱→钓鱼）；
  每账号先查活动进度再补差值（断点续跑，分多天跑自动吸收每日任务的自然推进）。
- 库存不足（招募令/黄金鱼竿/宝箱）= 正常暂停，等商店购物列表自动补货后再跑。
- 限流 400340 → 弹框（`onRateLimitPause` deps 钩子）：换 IP 点「继续」重试同一命令，
  「中止」全局停止（跨账号 `consumeAbortAll` 标志，收尾重置 shouldStop 不影响）；
  120s 无确认自动重试。
- ⚠️ **唯一缺口**：五类任务的活动累积进度字段——现有抓包没有，等「金鱼活动面板」抓包
  （阶段 B）。接入前 `readActivityProgress` 占位返回 null → 消耗 step 一律跳过
  （宁可不跑不可盲跑）。测试可经 `deps.readActivityProgress` 注入。
- 回归：`test/goldenfishConsumePlan.test.js`（纯逻辑 21 条）+
  `test/tasksGoldenfishConsume.test.js`（端到端 10 条，mock tokenStore 断言命令序列）。

## IP 额度实测数据与分段执行（2026-09-28 master 实测）

服务器按 **IP** 对「消耗类命令」计数限流，且**与 `400340` 是两回事**——额度耗尽是一条**可预期**的
边界，不是随机故障。master 实测三档额度（单位 = **帧**，每帧 10 个）：

| 动作 | 命令 | 单 IP 帧数上限 | 折算道具 | 置信度 |
| --- | --- | --- | --- | --- |
| 开箱 | `item_openbox` | **~180 帧** | ~1800 箱 | 已摸到边界 |
| 招募 | `hero_recruit` | **~180 帧** | ~1800 次 | 已摸到边界 |
| 钓鱼 | `artifact_lottery` | **>200 帧** | ≥2000 次 | 只知下界，"次数很多也不是无限的" |

### 用额度反算金鱼消耗的帧预算（10/帧）

| 消耗任务 | 目标 | 纯帧数 | 占额度段 | 结论 |
| --- | --- | --- | --- | --- |
| 招募 | 3900 次 | 390 帧 | 390/180 = 2.17 | 需跨 **3 段**，中途要等 2 次冷却 |
| 钓鱼 | 1150 次 | 115 帧 | 115/200 = 0.58 | **一段内跑得完**，不用冷却 |
| 宝箱 | 99000 分 | 198 ~ 990 帧 | 1.1 ~ 5.5 | 需跨 **2~6 段**，最大消耗方 |

宝箱帧数取决于主力箱型（加权均分 S）：纯铂金 50 分 → 1980 箱 = 198 帧；纯黄金 20 分 → 4950 箱 = 495 帧；
纯青铜 10 分 → 9900 箱 = 990 帧。另需叠加 `item_claimboxpointreward` 的兑换帧
（每档 1 帧，一轮 9 档消耗 500 分）。

⚠️ 木箱(2001)只有 1 分 → 99000 分需 9900 帧（**55 个额度段**），所以木箱保留 200 个的策略
在「靠木箱凑分」上是不可行的，分主要靠铂金/黄金/青铜。

**总预算粗估（中位情形）** ≈ 招募 390 + 宝箱 300~500 + 兑换 200 + 钓鱼 115 ≈
**1000~1200 帧**，而单 IP 各动作额度合计约 560 帧 ⇒ **一次任务运行必然要跨好几个额度段，
中途吃 4~6 次冷却**。

### master 拍板（2026-09-28）

| 问题 | 决策 | 含义 |
| --- | --- | --- |
| 冷却时长 | **< 5 分钟**（是否 <1 分钟不确定） | 单命令 15 分钟重试上限足够覆盖，不会误触 `RATE_LIMIT_TIMEOUT` |
| 额度口径 | **按动作独立计数**（开箱 180 / 招募 180 / 钓鱼 200+ 各自一套） | 三种动作不互吃额度 |
| 打满后行为 | **不预判，撞到 `400340` 再说** | **不做主动计数闸门，零新增发送逻辑**；完全交给现有统一限流弹窗（每 5 秒重试、成功自关） |

⇒ **结论：本轮代码改动为零。** 额度数据**不参与控制流**，只用于「预估与解释」。

理由（master 原话口径）：冷却时间不是特别长，而换 IP 要人工介入 ⇒
额度打满是**节奏（pacing）问题**，不是**中断问题**，不值得为它引入一条新的控制分支；
现有 `400340` 弹窗 + 无限 5 秒重试，正好就是"冷却过去后自动恢复"，行为已经正确。

### 额度数据的实际用途（决策后收敛）

1. **耗时预估**（唯一建议补的一层，**尚未实现**）：一次全流程 =
   1000~1200 帧 × RTT（**发送间隔已于 09-28 归零**，≈50ms/帧）≈ **1~2 分钟发送**；
   再加 4~6 次冷却 × ≤5 分钟 ≈ **最多 30 分钟等待** ⇒ **单账号约 5~32 分钟，以冷却为主**；
   多账号按 `maxActive`（默认 2）排队会更久。用户挂机前应该能看到这个数字。
2. **真正的吞吐天花板是 IP 额度，不是发送间隔**：既然每 IP 每动作约 180 帧就进冷却，
   把间隔从 300ms 压到 0 只缩短了「打满一段」的耗时（54s → ~9s），**不改变单位时间可跑的帧数**。
   所以本任务（消耗类）加速收益有限；但**批量日常等不消耗额度的任务**是纯延迟受限，
   归零延迟对它们是实打实的提速。另：`maxActive`（并发账号数，默认 2）对受额度约束的消耗任务无效
   —— 同一 IP 的额度是所有账号共享的。
2. **解释限流现象**：撞 `400340` 时用户能明白「这是额度打满，不是故障，最多 5 分钟自愈」。
3. **口径校准**：若实测某动作撞限流的阈值明显偏离 180/180/200+，说明服务端口径变了。

### 明确不做（记录以免重复讨论）

- ❌ 主动帧计数闸门 / 分段停机 / 冷却倒计时 UI —— 既然不预判，就不知道何时进入冷却
- ❌ 额度共享模型 —— 按动作独立处理
- ❌ 安全余量 / 钓鱼阈值取值 —— 不预判就无需取值
- ✅ 保留：现有统一限流弹窗（`tokenStore`）为唯一处理路径

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
