# 自由模板任务逻辑核查

> 本文以当前源码为准，供确认自由模板 UI 文案与实际执行行为是否一致。本文只记录事实和差异，不在本次变更中修改 UI 或任务 handler。
>
> 核查入口：[`flexibleTemplate.js`](../src/utils/batch/flexibleTemplate.js)、[`BatchDailyTasks.vue`](../src/views/BatchDailyTasks.vue)、[`dailyTaskRunner.js`](../src/utils/dailyTaskRunner.js) 和各批量任务模块。

## 1. 阅读约定

- 自由模板当前包含 71 个任务：完整日常 32 个、日常批量 12 个、副本 6 个、宝库 2 个、怪异塔 4 个、资源 10 个、功法 2 个、月度与活动 3 个。
- 下文的“调用参数”是 handler 调用 `sendMessageWithPromise()` 时传入的参数。报文最终还会与 `CommandRegistry` 中对应命令的默认 body 合并。
- “完成”优先指源码把账号状态设为 `completed`，不等于业务目标一定达到。例如没有库存、活动未开放、达到安全上限或没有可操作对象时，多个 handler 仍会把账号标为 `completed`。
- “准确”表示 UI 标签大体描述了会发送的动作；“需确认”表示动作存在但范围、成功含义或协议语义需要在 UI 上说明；“不准确”表示标签明显超过了当前实现。
- 所有批量 handler 通常都对账号使用 `Promise.all()`，账号内部再按各自的循环顺序发送命令。自由模板会替换 handler 的关闭连接和释放槽位操作，由共享连接协调器统一处理。

## 2. 自由模板编排与并发

`runFlexibleTemplate()` 的控制结构如下：

```text
规范化模板和任务 ID
  -> 过滤活动当前不可用的批量任务
  -> 按 maxActive 切分账号波次
  -> 每一波创建一个共享连接协调器
  -> 启动完整日常 runner（如果有 daily.*）
     和全部选中的批量 handler
  -> 同一波等待所有顶层执行结束
  -> 关闭本波账号连接并释放连接槽位
  -> 进入下一波
```

具体规则：

1. `selectedTasks` 会去重并过滤未知 ID，保留规范化数组顺序。
2. 账号波次按 `batchSettings.maxActive` 串行推进。下一波不会在上一波完成前启动。
3. 同一波内的账号通常并发运行。
4. 同一波内，完整日常和每一个选中的批量任务都是独立 Promise，并通过 `Promise.all()` 并发启动。模板目录顺序只决定 Promise 创建顺序，不决定完成顺序。
5. 每个账号在同一波内只缓存一个共享连接 Promise，避免多个顶层任务重复建连。
6. 日常任务由 `DailyTaskRunner` 自己串行执行：角色信息和当前阵容初始化后，按源码固定顺序逐项执行，不按 checkbox 勾选顺序执行。
7. 同一账号的不同批量 handler 没有共享的业务串行锁。因此日常、竞技场、爬塔、开箱、车辆等任务可能同时切换阵容、读取角色数据或修改全局 `tokenStore.gameData`。
8. WebSocket 的 `sendQueue` 只按各异步流程实际调用 `send()` 的先后发送。它不能保证自由模板目录顺序，也不能防止不同 handler 的阵容切换和状态读取互相交错。
9. `sendWithPromise()` 会先按序号登记响应 Promise，再把命令放入发送队列；命令是否已发送不代表业务响应已经成功返回。
10. 共享协调器只统一连接生命周期，不会把多个 handler 合并成一个账号级串行队列。

## 3. 统一配置和隐藏依赖

自由模板编辑器目前提供这些模板设置：

- 竞技场、爬塔、BOSS 阵容。
- 军团 BOSS 次数。
- 箱子类型、开箱数量、目标箱子积分。
- 鱼竿类型、钓鱼数量、招募数量。
- 怪异塔最大爬塔次数。
- 盐杯竞猜选项。
- 功法接收者 ID、赠送数量。
- 月赛助威俱乐部 ID、拍手器数量。

以下配置仍来自旧的批量设置或每个账号的旧设置，不属于自由模板自己的字段：

- 梦境商品购买清单 `batchSettings.dreamPurchaseList`。
- 智能发车的颜色、金币、招募令、白玉、刷新券阈值及 A/B 策略。
- 智能竞技场选敌模式。
- 功法赠送安全密码。
- 旧的日常开关。

自由模板执行完整日常时，`createFlexibleTaskDeps()` 会强制打开以下旧日常开关：`claimBottle`、`payRecruit`、`openBox`、`arenaEnable`、`claimHangUp`、`claimEmail`、`blackMarketPurchase`、`freeGachaEnable`。因此勾选了对应 `daily.*` 任务后，旧设置不能再关闭这些行为，UI 目前没有对此作出提示。

## 4. 完整日常：32 项

实现：[`dailyTaskRunner.js`](../src/utils/dailyTaskRunner.js)。选择任意 `daily.*` 任务时，runner 都会先获取角色信息，并尝试读取当前阵容；这些初始化请求不受 checkbox 单项限制。

### 4.1 基础任务

#### 1. `daily.share`：分享一次游戏

- **handler/队列位置**：`DailyTaskRunner` 基础任务第一项。
- **命令**：`system_mysharecallback`。
- **参数**：`{ isSkipShareCard: true, type: 2 }`。
- **条件**：任务完成表中的 ID `2` 不是 `-1`，且选中了该任务。
- **循环**：一次。
- **失败行为**：当前任务记录失败并继续日常队列。
- **文案核查**：**需确认**。该命令与 `daily.addHangUpTime` 完全相同，当前源码不能仅凭命令确认它一定代表“分享一次游戏”。

#### 2. `daily.friendGold`：赠送好友金币

- **命令**：`friend_batch`。
- **参数**：调用参数 `{}`。
- **条件**：任务完成表中的 ID `3` 不是 `-1`。
- **循环**：一次。
- **文案核查**：**准确**，但是否存在可赠送好友由服务端决定。

#### 3. `daily.freeRecruit`：免费招募

- **命令**：`hero_recruit`。
- **参数**：`{ recruitType: 3, recruitNumber: 1 }`。
- **条件**：任务完成表中的 ID `4` 不是 `-1`。
- **循环**：一次。
- **文案核查**：**准确**。

#### 4. `daily.paidRecruit`：付费招募

- **命令**：`hero_recruit`。
- **参数**：`{ recruitType: 1, recruitNumber: 1 }`。
- **条件**：任务完成表中的 ID `4` 不是 `-1`，`settings.payRecruit` 为真，并选中该任务。
- **循环**：一次。
- **特殊行为**：完整日常会在构建任务列表时一次性读取完成状态。如果免费招募和付费招募同时选中，它们可能都会被加入队列，不会在免费招募成功后重新读取任务状态。
- **文案核查**：**准确**；自由模板会强制 `payRecruit: true`，UI 没有关闭开关。

#### 5. `daily.freeGold`：免费点金 3 次

- **命令**：`system_buygold`。
- **参数**：`{ buyNum: 1 }`。
- **条件**：选中任务、任务完成表 ID `6` 不是 `-1`，且 `statisticsTime["buy:gold"]` 不是今天。
- **循环**：固定加入 3 次任务，实际每次失败后由 runner 跳过当前项；不会根据中途响应动态缩短后续次数。
- **文案核查**：**基本准确**，但“3 次”是请求计划，不保证 3 次都成功。

#### 6. `daily.claimHangUp`：领取挂机奖励

- **命令**：`system_claimhangupreward`。
- **参数**：调用参数 `{}`。
- **条件**：任务完成表 ID `5` 不是 `-1`，且 `settings.claimHangUp` 为真。
- **循环**：一次。
- **文案核查**：**准确**；自由模板会强制打开 `claimHangUp`。

#### 7. `daily.addHangUpTime`：挂机加钟 4 次

- **命令**：`system_mysharecallback`。
- **参数**：`{ isSkipShareCard: true, type: 2 }`。
- **条件**：任务完成表 ID `5` 不是 `-1`，且 `settings.claimHangUp` 为真。
- **循环**：固定 4 次。
- **特殊行为**：与 `daily.share` 使用完全相同的命令和参数；源码依靠任务位置和业务上下文区分日志名称。
- **文案核查**：**需确认**。次数描述准确，但协议语义与“分享一次游戏”相同，不能把两者当作已验证的不同服务端动作。

#### 8. `daily.openBox`：开启木质宝箱 10 个

- **命令**：`item_openbox`。
- **参数**：`{ itemId: 2001, number: 10 }`。
- **条件**：任务完成表 ID `7` 不是 `-1`，且 `settings.openBox` 为真。
- **循环**：一次；不预检查木质宝箱库存。
- **文案核查**：**准确**，但库存不足时由服务端返回失败。

#### 9. `daily.resetBottleTimer`：重置盐罐计时

- **命令**：先 `bottlehelper_stop`，再 `bottlehelper_start`。
- **参数**：调用参数均为 `{}`；命令注册表会为瓶子命令补入默认 `bottleType: -1`。
- **条件**：仅需选中任务，没有每日完成状态判断。
- **循环**：停止和开始各一次，中间按命令延迟执行。
- **文案核查**：**准确**；它重置的是计时，不领取盐罐奖励。

#### 10. `daily.claimBottle`：领取盐罐奖励

- **命令**：`bottlehelper_claim`。
- **参数**：调用参数 `{}`。
- **条件**：任务完成表 ID `14` 不是 `-1`，且 `settings.claimBottle` 为真。
- **循环**：一次。
- **文案核查**：**准确**；自由模板会强制打开 `claimBottle`。

### 4.2 竞技场与 BOSS

#### 11. `daily.arena`：竞技场战斗 3 次

- **命令顺序**：`presetteam_getinfo`/必要时 `presetteam_saveteam`，`arena_startarea`，重复 `arena_getareatarget` 和 `fight_startareaarena`。
- **参数**：切阵容使用 `{ teamId: settings.arenaFormation }`；战斗使用 `{ targetId }`。
- **条件**：任务完成表 ID `13` 不是 `-1`，`settings.arenaEnable` 为真，且本地时间小时在 `6` 至 `22` 之间（含边界）。
- **循环**：最多 3 轮。每轮先取目标，再发起战斗；取目标失败或没有目标时结束竞技场流程。
- **阵容**：使用自由模板的竞技场阵容；该任务自身不立即恢复阵容，后续选中的 `daily.restoreFormation` 才负责恢复。
- **失败行为**：非限流错误通常只结束当前竞技场任务，runner 继续后续任务。
- **文案核查**：**基本准确**，但“3 次”是最多 3 次；时间、目标缺失和战斗失败都可能少于 3 次。

#### 12. `daily.legionBoss`：军团 BOSS

- **命令顺序**：必要时 `presetteam_saveteam`，然后重复 `fight_startlegionboss`。
- **参数**：切阵容 `{ teamId: settings.bossFormation }`；BOSS 命令调用参数 `{}`。
- **条件**：选中任务且 `settings.bossTimes > 0`。从 `statistics["legion:boss"]` 读取今日已打次数；如果时间戳不是今天则按 0 次计算。
- **循环**：`max(settings.bossTimes - alreadyLegionBoss, 0)` 次，模板设置被规范化到 `0-4`。
- **文案核查**：**准确**；实际次数会受已完成统计和模板次数限制。

#### 13. `daily.dailyBoss`：每日 BOSS 3 次

- **命令顺序**：必要时切换 BOSS 阵容，重复 `fight_startboss`。
- **参数**：`{ bossId: todayBossId }`；BOSS ID 由星期映射为 `9901-9905`。
- **条件**：只需选中任务；当前没有读取每日 BOSS 已完成次数。
- **循环**：固定 3 次。
- **文案核查**：**需确认**。标签与固定请求数一致，但实现没有像军团 BOSS 一样按当日完成统计缩减，可能重复请求。

### 4.3 固定奖励

以下任务都在固定奖励阶段按源码数组顺序加入；通常没有单独的每日完成状态预检查，服务端已领取时会返回错误并由 runner 跳过当前任务。

#### 14. `daily.welfareSignIn`：福利签到

- **命令**：`system_signinreward`。
- **参数**：调用参数 `{}`。
- **循环**：一次。
- **文案核查**：**准确**。

#### 15. `daily.clubSignIn`：俱乐部签到

- **命令**：`legion_signin`。
- **参数**：调用参数 `{}`。
- **循环**：一次。
- **文案核查**：**准确**。

#### 16. `daily.discountGift`：领取每日礼包

- **命令**：`discount_claimreward`。
- **参数**：调用参数 `{}`；注册表默认 `discountId: 1`。
- **循环**：一次。
- **文案核查**：**准确**，商品 ID 由命令默认值决定。

#### 17. `daily.collectionReward`：领取每日免费奖励

- **命令**：`collection_claimfreereward`。
- **参数**：调用参数 `{}`。
- **循环**：一次。
- **文案核查**：**基本准确**。

#### 18. `daily.freeCardGift`：领取免费礼包

- **命令**：`card_claimreward`。
- **参数**：调用参数 `{}`；注册表默认 `cardId: 1`。
- **循环**：一次。
- **文案核查**：**基本准确**，具体卡 ID 依赖命令默认值。

#### 19. `daily.permanentCardGift`：领取永久卡礼包

- **命令**：`card_claimreward`。
- **参数**：`{ cardId: 4003 }`。
- **循环**：一次。
- **文案核查**：**准确**，前提是 `4003` 确实对应永久卡礼包。

#### 20. `daily.claimEmail`：领取邮件奖励

- **命令**：`mail_claimallattachment`。
- **参数**：调用参数 `{}`；注册表默认 `category: 0`。
- **条件**：`settings.claimEmail` 为真；自由模板会强制打开该设置。
- **循环**：一次，领取该分类的全部附件。
- **文案核查**：**准确**。

#### 21. `daily.collectionGift`：领取珍宝阁免费礼包

- **命令顺序**：`collection_goodslist`，再 `collection_claimfreereward`。
- **参数**：两个调用参数均为 `{}`。
- **循环**：每个命令一次。
- **文案核查**：**准确**；与 `daily.collectionReward` 共享领取命令，同时选中可能产生重复请求。

### 4.4 免费活动、黑市与梦境

#### 22. `daily.freeGacha`：免费扭蛋

- **命令**：`gacha_drawreward`。
- **参数**：`{ num: 1, isGroup: false }`。
- **条件**：`settings.freeGachaEnable !== false`，且 `statisticsTime["gacha:free"]` 不是今天。
- **循环**：一次。
- **文案核查**：**准确**；自由模板会强制打开该开关。

#### 23. `daily.freeFishing`：免费钓鱼 3 次

- **命令**：`artifact_lottery`。
- **参数**：`{ lotteryNumber: 1, newFree: true, type: 1 }`。
- **条件**：`statistics["artifact:normal:lottery:time"]` 不是今天。这里使用的是 `statistics`，不是 `statisticsTime`。
- **循环**：固定加入 3 次。
- **文案核查**：**需确认**。标签和请求次数明确，但时间字段来源与其他免费活动不一致，需确认服务端字段语义。

#### 24. `daily.genieSweep`：四国灯神免费扫荡

- **命令**：对灯神 ID `1-4` 分别调用 `genie_sweep`。
- **参数**：`{ genieId: 1 }` 至 `{ genieId: 4 }`。
- **条件**：每个国家分别检查 `statisticsTime[genie:daily:free:<id>]` 是否不是今天。
- **循环**：最多四个国家，每个国家一次；已领取的国家不会加入队列。
- **文案核查**：**准确**，不包含深海灯神 ID `5`。

#### 25. `daily.freeGenieTickets`：领取免费扫荡券 3 次

- **命令**：`genie_buysweep`。
- **参数**：调用参数 `{}`。
- **条件**：只需选中任务，没有本地时间或完成次数预检查。
- **循环**：固定 3 次，服务端决定是否还有可领取次数。
- **文案核查**：**基本准确**，3 次是请求上限而不是保证成功次数。

#### 26. `daily.blackMarket`：黑市购买 1 次

- **命令**：`store_purchase`。
- **参数**：`{ goodsId: 1 }`；这也是命令注册表默认商品。
- **条件**：任务完成表 ID `12` 不是 `-1`，且 `settings.blackMarketPurchase` 为真。
- **循环**：一次。
- **文案核查**：**准确**；自由模板会强制打开黑市购买开关。

#### 27. `daily.dream`：咸王梦境

- **命令**：`dungeon_selecthero`。
- **参数**：`{ battleTeam: { 0: 107 } }`。
- **条件**：只在周日、周一、周三、周四加入任务队列。
- **循环**：一次。
- **实际范围**：没有梦境战斗、推进关卡、购买商品或领取奖励命令，只提交梦境阵容。
- **文案核查**：**不准确**。建议 UI 明确写成“梦境选择阵容”或在实现补齐真正的梦境流程后再使用“一键梦境”。

#### 28. `daily.deepSeaGenie`：深海灯神

- **命令**：`genie_sweep`。
- **参数**：`{ genieId: 5, sweepCnt: 1 }`。
- **条件**：仅周一，且 `statisticsTime["genie:daily:free:5"]` 不是今天。
- **循环**：一次。
- **文案核查**：**准确**；这是完整日常中的深海灯神免费扫荡，不同于批量灯神 handler 的 1-4 国选择。

#### 29. `daily.restoreFormation`：还原初始阵容

- **命令顺序**：必要时 `presetteam_getinfo`，再 `presetteam_saveteam`。
- **参数**：`{ teamId: originalFormation }`。
- **条件**：选中任务且 runner 初始化时成功读取到 `originalFormation`。
- **循环**：最多一次切换。
- **特殊行为**：初始化读取原阵容发生在任务列表构建前，即使只选中其他日常任务也会尝试读取。
- **文案核查**：**准确**；自由模板并发运行其他会切阵容的 handler 时，恢复顺序可能与其他 handler 交错。

### 4.5 日常、周常与通行证奖励

#### 30. `daily.dailyRewards`：领取每日任务积分及完成奖励

- **命令顺序**：`task_claimdailypoint` 的 `taskId=1..10`，再 `task_claimdailyreward`。
- **参数**：积分请求 `{ taskId: 1 }` 至 `{ taskId: 10 }`；完成奖励调用参数 `{}`。
- **循环**：10 个积分请求串行，再 1 个完成奖励请求。
- **条件**：只需选中任务；源码不逐项读取积分领取状态。
- **失败行为**：每个请求由 runner 单独处理，某一项失败不会阻止后续项。
- **文案核查**：**准确**，但“领取”表示尝试请求，不保证每个积分档位都有奖励。

#### 31. `daily.weeklyReward`：领取周常任务奖励

- **命令**：`task_claimweekreward`。
- **参数**：调用参数 `{}`；注册表默认 `rewardId: 0`。
- **循环**：一次。
- **文案核查**：**准确**。

#### 32. `daily.passReward`：领取通行证奖励

- **命令**：`activity_recyclewarorderrewardclaim`。
- **参数**：`{ actId: 1 }`。
- **循环**：一次。
- **文案核查**：**准确**，具体可领取档位由服务端状态决定。

### 4.6 完整日常固定顺序

```text
角色信息
  -> 当前阵容
  -> 分享、好友金币、免费招募、付费招募、点金
  -> 挂机领取、挂机加钟、开箱、盐罐
  -> 竞技场
  -> 军团 BOSS、每日 BOSS
  -> 固定签到和礼包
  -> 珍宝阁、免费扭蛋、免费钓鱼、四国灯神、扫荡券
  -> 黑市
  -> 梦境选择阵容、深海灯神、阵容还原
  -> 每日积分和完成奖励
  -> 周常奖励
  -> 通行证奖励
```

## 5. 日常批量：12 项

实现主要位于 [`tasksHangUp.js`](../src/utils/batch/tasksHangUp.js)、[`tasksBottle.js`](../src/utils/batch/tasksBottle.js)、[`tasksArena.js`](../src/utils/batch/tasksArena.js)、[`tasksCar.js`](../src/utils/batch/tasksCar.js)、[`tasksStore.js`](../src/utils/batch/tasksStore.js) 和 [`tasksItem.js`](../src/utils/batch/tasksItem.js)。

### 33. `claimHangUpRewards`：领取挂机并加钟

- **命令顺序**：`system_claimhangupreward` 一次；随后 `system_mysharecallback` 四次。
- **参数**：领取调用 `{}`；加钟调用 `{ isSkipShareCard: true, type: 2 }`。
- **循环**：每账号固定 4 次加钟，账号之间并发。
- **重试**：领取支持限流和特定超时重试；加钟支持限流重试。
- **完成条件**：四次流程结束且没有未处理异常，就将账号设为 `completed`。
- **文案核查**：**准确**；“并加钟”确实是同一个 handler 内的两段流程。

### 34. `batchAddHangUpTime`：一键加钟

- **命令**：`system_mysharecallback`。
- **参数**：`{ isSkipShareCard: true, type: 2 }`。
- **循环**：每账号 4 次串行。
- **重试**：除停止和 400340 外，失败会关闭连接后重试整个账号流程；没有普通错误的固定重试上限，直到成功或停止。
- **完成条件**：4 次加钟全部走完才标记完成；400340 或停止会失败/中止。
- **文案核查**：**准确**，但同样不能仅凭命令证明这是与 `daily.share` 不同的协议动作。

### 35. `resetBottles`：重置罐子

- **命令顺序**：`bottlehelper_stop`，等待约 500ms，再 `bottlehelper_start`。
- **参数**：调用参数均为 `{}`，注册表会补入 `bottleType: -1`。
- **重试**：开始计时对限流或特定超时按配置重试，最大重试次数来自 helper 常量。
- **完成条件**：开始计时请求成功。
- **文案核查**：**准确**。

### 36. `batchlingguanzi`：一键领取罐子

- **命令**：`bottlehelper_claim`。
- **参数**：调用参数 `{}`。
- **循环**：每账号一次。
- **完成条件**：命令 Promise 成功；没有奖励时通常由服务端错误决定失败状态。
- **文案核查**：**准确**。

### 37. `batchclubsign`：一键俱乐部签到

- **命令**：`legion_signin`。
- **参数**：调用参数 `{}`。
- **循环**：每账号一次。
- **文案核查**：**准确**。

### 38. `batchStudy`：一键答题

- **初始化**：动态预加载题库，并重置 `tokenStore.gameData.studyStatus`。
- **命令**：`study_startgame` 一次。
- **后续行为**：本 handler 不逐题发送 `study_answer`，而是最多轮询约 90 秒的 `gameData.studyStatus`，答题和领奖状态由其他消息处理逻辑驱动。
- **完成条件**：状态变为 `completed`；超时或未开始为失败。
- **并发风险**：`studyStatus` 位于共享的 `tokenStore.gameData`，多个账号或其他任务并发时可能互相覆盖状态。
- **文案核查**：**需确认**。功能目标是答题，但当前 handler 本身只负责启动并等待状态机。

### 39. `batcharenafight`：一键竞技场战斗 3 次

- **初始化**：读取角色信息中的咸神门票 ID `1007`，读取当前阵容。
- **条件**：门票为 0 时直接记录跳过并标记 `completed`。
- **命令顺序**：必要时切换竞技场阵容；每轮 `arena_startarea`、`arena_getareatarget`、`fight_startareaarena`。
- **参数**：战斗 `{ targetId }`；选敌使用当前批量设置的 `smartArenaMode`，默认最低战力模式。
- **循环**：`Math.min(3, ticketCount)` 轮。取目标失败或战斗失败时可能少于 3 次，但账号通常仍会进入 `completed`。
- **收尾**：如果切过阵容，尝试恢复原阵容。
- **文案核查**：**基本准确**，但“3 次”是上限，不是保证。

### 40. `batchSmartSendCar`：智能发车

- **读取**：`car_getrolecar`、角色信息中的刷新券 ID `35002`、`car_getmemberhelpingcnt`、`legion_getinfo`。
- **发车命令**：`car_send { carId, helperId, text: "", isUpgrade: false }`。
- **筛选**：只处理 `sendAt` 为 0 的车辆；已发车车辆跳过。
- **护卫**：红色及以上车辆在没有护卫时，按军团成员的红淬数量降序选择未达到 4 次使用上限的护卫。
- **条件**：基础门槛是 `carMinColor`；自定义奖励条件之间使用 OR。智能发车的颜色、金币、招募令、白玉、刷新券阈值来自旧批量设置，不来自自由模板。
- **策略 A**：满足条件直接发车；不满足时最多先做一次免费刷新；仍不满足则不再继续付费刷新，直接发车并记录 warning。
- **策略 B**：免费刷新后仍不满足时，在有刷新券的情况下继续付费刷新；付费刷新判断会忽略“刷新券奖励数量”条件；成功满足其余条件后发车，否则最后直接发车。
- **失败行为**：单辆车失败会跳过该车，继续处理其他车辆；账号最后仍可能标记 `completed`。
- **文案核查**：**基本准确**，但“智能”依赖旧设置，且两种策略最终都可能对不满足条件的车辆直接发车。

### 41. `batchClaimCars`：一键收车

- **读取**：`car_getrolecar`。
- **条件**：车辆 `sendAt` 距当前至少 4 小时才可收取。
- **命令顺序**：可收车辆发送 `car_claim { carId }`；收车后读取角色信息，根据 ID `35009` 改装零件和 `CarresearchItem` 逐级发送 `car_research { researchId: 1 }`；最后尝试 `car_claimpartconsumereward {}`。
- **循环**：遍历所有车辆；改装升级循环直到零件不足、等级上限或失败。
- **失败行为**：单辆车收取或改装失败通常记录 warning 后继续其他车辆；没有可收车辆时也标记 `completed`。
- **文案核查**：**准确**，但“一键收车”还包含自动改装升级和累计奖励领取。

### 42. `store_purchase`：一键黑市采购

- **命令**：`store_purchase`。
- **参数**：调用参数 `{}`，注册表默认 `goodsId: 1`。
- **循环**：每账号一次。
- **文案核查**：**准确**，但商品范围只有默认商品 1。

### 43. `collection_claimfreereward`：一键领取珍宝阁

- **命令**：`collection_claimfreereward`。
- **参数**：调用参数 `{}`。
- **循环**：每账号一次。
- **文案核查**：**基本准确**，实际只是领取免费奖励，不读取商品列表。

### 44. `batchGenieSweep`：一键灯神扫荡

- **读取**：角色灯神进度和扫荡券 ID `1021`。
- **选择**：只在灯神 ID `1-4` 中寻找最高层，未选择深海灯神 ID `5`。
- **命令**：`genie_sweep { genieId: bestGenieId, sweepCnt }`。
- **循环**：每次最多消耗 20 张券，按响应中的剩余券数量继续，直到没有券、停止或请求失败。
- **完成条件**：无券或没有可选关卡时也标记 `completed`；扫荡中途失败后刷新一次角色信息，通常仍标记完成。
- **文案核查**：**需修正**。泛称“一键灯神扫荡”容易让用户以为包含深海灯神，但当前只处理四国灯神。

## 6. 副本与活动：6 项

实现：[`tasksDungeon.js`](../src/utils/batch/tasksDungeon.js)、[`tasksTower.js`](../src/utils/batch/tasksTower.js)、[`tasksItem.js`](../src/utils/batch/tasksItem.js) 和 [`tasksFootball.js`](../src/utils/batch/tasksFootball.js)。

### 45. `climbTower`：一键爬塔

- **初始化**：读取并切换爬塔阵容；发送 `tower_getinfo`；读取角色信息中的塔体力。
- **命令**：重复 `fight_starttower {}`；每 5 次或异常恢复时刷新角色信息；遇到 `1500040` 时尝试 `tower_claimreward { rewardId }`。
- **循环**：体力大于 0 时最多 100 次。
- **停止条件**：体力耗尽、达到 100 次、用户停止、400340、连续普通失败 3 次等。
- **收尾**：如果切过阵容，恢复原阵容。
- **完成条件**：循环退出后通常直接标记 `completed`，即使体力不足、达到上限或提前停止战斗。
- **文案核查**：**基本准确**，但“一键爬塔”不等于保证爬到更高层。

### 46. `batchmengjing`：一键梦境

- **开放日**：周日、周一、周三、周四。
- **命令**：开放日发送 `dungeon_selecthero { battleTeam: { 0: 107 } }` 一次。
- **未开放日**：记录“当前未在开放时间”，但当前分支没有明确把账号改为 failed；外层最终状态需要结合运行时状态观察。
- **实际范围**：没有梦境战斗、推进、商品购买或奖励领取。
- **文案核查**：**不准确**。这是当前最明显的标签与实现不一致之一，建议改名为“梦境选择阵容”或实现完整梦境动作后再保留“一键梦境”。

### 47. `skinChallenge`：一键换皮闯关

- **读取**：`towers_getinfo { actId: getTowerActId() }`。
- **活动 ID**：按当前周期所在周五生成；活动起止日期由返回的 `actId` 再次校验。
- **开放 BOSS**：周五至周三每天对应一个类型；周四开放类型 `1-6`。
- **命令**：未通关 BOSS 重复 `towers_start { actId, towerType }`、`towers_fight { actId, towerType }`；成功后刷新 `towers_getinfo`。
- **循环**：按未通关类型串行；单个 BOSS 连续失败 3 次后跳过。挑战结束后对 `actIdList` 中的活动 ID 循环发送 `activity_startactegame` 领取奖励，直到请求失败或停止。
- **完成条件**：活动过期、今日没有待挑战 BOSS 或部分 BOSS 跳过时也可能标记完成。
- **文案核查**：**基本准确**，但它同时包含闯关和活动领奖，且“完成”不保证所有 BOSS 通关。

### 48. `batchClaimPeachTasks`：一键领取蟠桃园任务

- **读取**：`legion_getpayloadtask`。
- **筛选**：按返回 `taskMap` 的类型、进度和本地 [`PeachTaskIds.js`](../src/utils/PeachTaskIds.js) 中的目标过滤可领取任务。
- **命令**：逐项发送 `legion_claimpayloadtask { taskId }`；再次读取任务后，条件满足时发送 `legion_claimpayloadtaskprogress { taskGroup: 1 }` 和 `{ taskGroup: 2 }`。
- **循环**：任务奖励串行；俱乐部积分和个人积分各最多请求一次。
- **失败行为**：单项领取失败被忽略；没有可领取项、返回列表缺失或积分领取失败时，账号通常仍标记 `completed`。
- **文案核查**：**基本准确**，但“领取完成”只表示尝试处理当前列表，不代表所有蟠桃目标都已完成。

### 49. `batchBuyDreamItems`：一键购买梦境商品

- **前置条件**：自由模板外层要求梦境活动开放；handler 还要求 `batchSettings.dreamPurchaseList` 非空。
- **配置来源**：购买清单不在自由模板设置中，而是沿用旧批量设置。
- **读取**：角色信息中的 `role.dungeon.merchant` 和关卡数。
- **命令**：逐项发送 `dungeon_buymerchant { id, index, pos }`。
- **排序**：按商人 ID 升序、商人位置 `pos` 降序。
- **条件**：关卡小于 4000 时跳过购买；单项失败只增加失败计数，通常不抛出整体失败。
- **文案核查**：**需确认**。标签描述了 handler，但自由模板编辑器无法配置清单，实际执行依赖旧设置；建议在 UI 明确提示该依赖。

### 50. `batchFootballBet`：一键竞猜

- **读取**：`saltcup26_getbetinfo`，从 `roleData.betRecord` 最后一个赛程读取比赛记录。
- **筛选**：只处理 `pick === 0` 的未下注比赛。
- **命令**：逐场发送 `saltcup26_placebet { matchId, pick }`。
- **循环**：未下注比赛串行，每场间隔约 500ms；单场失败不阻止后续比赛。
- **参数**：自由模板使用 `footballPick`，`1=主胜`、`2=平局`、`3=客胜`。
- **文案核查**：**准确**，但所有未下注比赛使用同一个预测选项。

## 7. 宝库：2 项

实现：[`tasksDungeon.js`](../src/utils/batch/tasksDungeon.js)。自由模板外层只在宝库活动开放时启动这两项。

### 51. `batchbaoku13`：一键宝库前 3 层

- **读取**：`bosstower_getinfo`。
- **条件**：只有返回的 `bossTower.towerId` 在 `1-3` 时执行动作；其他层数直接跳过，但账号仍可能标记 `completed`。
- **命令**：`bosstower_startboss {}` 2 次，再 `bosstower_startbox {}` 9 次。
- **循环**：BOSS 2 次、宝箱 9 次，中间各约 500ms。
- **奖励**：日志明确提示需要上线手动领取奖励。
- **文案核查**：**需确认**。标签“前 3 层”容易理解为逐层完成战斗；实际代码只按当前 `towerId` 区间发送固定数量命令，且没有读取每次战斗结果。

### 52. `batchbaoku45`：一键宝库 4、5 层

- **读取**：`bosstower_getinfo`。
- **条件**：只有 `towerId` 在 `4-5` 时执行；其他层数跳过后仍可能标记完成。
- **命令**：`bosstower_startboss {}` 2 次。
- **循环**：固定 2 次；不发送 `bosstower_startbox`。
- **文案核查**：**需确认**。名称只表达目标层范围，但实现没有逐层状态校验，也没有箱子命令或奖励领取。

## 8. 怪异塔：3 项

实现：[`tasksTower.js`](../src/utils/batch/tasksTower.js)。自由模板外层只在怪异塔活动开放时启动相关任务。

### 53. `climbWeirdTower`：一键爬怪异塔

- **初始化**：读取并切换 `towerFormation`；发送 `evotower_getinfo` 获取能量。
- **命令**：每轮 `evotower_readyfight {}`，再 `evotower_fight { battleNum: 1, winNum: 1 }`；随后刷新信息。
- **循环**：能量大于 0 且未达到模板 `weirdTowerMaxClimb`；模板值规范化为 `1-10000`。
- **领奖**：每轮检查当天任务 1-3，发送 `evotower_claimtask { taskId }`；检测章节通关后尝试 `evotower_claimreward {}`。
- **停止条件**：能量耗尽、达到上限、400340、连续失败 3 次或用户停止。
- **完成条件**：循环提前停止时通常仍标记完成。
- **文案核查**：**基本准确**，但次数是上限，且不保证通关目标。

### 54. `batchSmartItemHandling`：智能道具处理

- **前置**：先读取 `mergebox_getinfo { actType: 1 }`，有可领取的免费道具时发送 `mergebox_claimfreeenergy { actType: 1 }`。
- **使用**：读取 `evoTower.lotteryLeftCnt` 作为剩余道具数，使用 `mergeBox.costTotalCnt` 决定网格位置，循环发送 `mergebox_openbox { actType: 1, pos }`。
- **交替**：道具使用阶段遇到 `12300040`（没有空格子）或本轮道具用完后，执行合成；合成释放格子后，若仍有道具则继续使用。
- **合成**：遍历 `gridMap`，只收集 `gridConfId == 0`、`gridItemId > 0` 且未锁定的格子，按 `gridItemId` 分组；根据任务键 `251212208` 选择智能合成或两两手动合成。
- **终止**：道具耗尽后仍执行当前轮最后一次合成，然后结束；格子已满但没有可合成物品时停止，避免重复请求。
- **完成条件**：完成上述处理流程、用户停止或达到内部合成安全上限时标记完成。

### 55. `batchClaimFreeEnergy`：一键领取怪异塔免费道具

- **读取**：`mergebox_getinfo { actType: 1 }`。
- **条件**：`mergeBox.freeEnergy > 0` 才发送领取命令；没有免费道具时记录无可领取并标记完成。
- **命令**：`mergebox_claimfreeenergy { actType: 1 }`。
- **循环**：每账号最多一次。
- **文案核查**：**准确**，但没有免费道具时“完成”表示检查结束，不是领取到了道具。

## 9. 资源：10 项

实现：[`tasksItem.js`](../src/utils/batch/tasksItem.js)、[`tasksStore.js`](../src/utils/batch/tasksStore.js)。带 `scheduledArgument` 的自由模板任务会接收 `true`，从自由模板设置读取数量或目标。

### 57. `batchOpenBox`：批量开箱

- **配置**：自由模板使用 `boxType` 和 `boxCount`；不使用旧助手面板的临时设置。
- **命令**：`item_openbox { itemId: boxType, number: 10 }`，余数再发送一次；之后发送 `item_batchclaimboxpointreward {}` 并刷新角色信息。
- **循环**：按 10 个一批，最后处理余数。
- **预检查**：不检查箱子库存，库存不足由服务端决定。
- **完成条件**：最后领奖和角色刷新流程没有抛出未处理异常时标记完成。
- **文案核查**：**准确**；数量是请求数量，不保证实际开出数量。

### 58. `batchOpenBoxByPoints`：按积分开箱

- **配置**：自由模板使用 `targetBoxPoints`。
- **读取**：角色四种箱子库存；木箱每个 1 分、青铜 10 分、黄金 20 分、铂金 50 分，木箱默认保留 200 个。
- **规划**：先计划使用可动用的木箱，再用嵌套枚举寻找达到目标且浪费积分最少的青铜、黄金、铂金、木箱组合；开箱顺序为木、青铜、黄金、铂金。
- **命令**：按规划数量发送 `item_openbox { itemId, number }`，每次最多 10 个。
- **不做的事**：不自动发送 `item_batchclaimboxpointreward`。
- **失败行为**：总积分不足时标记失败；有库存但没有找到组合时仍可能没有开箱动作后标记完成。
- **文案核查**：**基本准确**，但它是“规划并尝试开箱”，不包含积分奖励领取。

### 59. `batchClaimBoxPointReward`：领取宝箱积分

- **命令**：`item_batchclaimboxpointreward {}`。
- **收尾**：随后刷新角色信息。
- **循环**：每账号一次。
- **文案核查**：**准确**。

### 60. `batchFish`：批量钓鱼

- **配置**：自由模板使用 `fishType` 和 `fishCount`。
- **库存**：普通鱼竿 ID `1011`，黄金鱼竿 ID `1012`；库存不足时把目标缩小到现有库存，没有鱼竿时标记完成并跳过。
- **命令**：`artifact_lottery { type: fishType, lotteryNumber: 10 或余数, newFree: true }`。
- **循环**：每 10 次一批；每 5 批重新读取鱼竿数量，若少于 10 则停止后续批量。
- **奖励**：读取 `artifact:point`，按 `floor(points / 20)` 次发送 `artifact_exchange {}`，单次失败停止领奖循环。
- **完成条件**：库存不足、领奖失败或用户停止后也通常标记完成。
- **文案核查**：**基本准确**；请求中始终带 `newFree: true`，但实际是否消耗免费次数或普通鱼竿由服务端解释。

### 61. `batchRecruit`：批量招募

- **配置**：自由模板使用 `recruitCount`。
- **命令**：`hero_recruit { recruitType: 1, recruitNumber: 10 或余数 }`。
- **循环**：每 10 次一批，最后处理余数；完成后刷新角色信息。
- **预检查**：不读取招募令库存。
- **完成条件**：计划请求完成即标记完成；服务端失败会进入账号失败。
- **文案核查**：**准确**，但数量是请求计划，不保证库存足够。

### 62. `batchHeroUpgrade`：一键英雄升星

- **遍历**：遍历 `HERO_DICT` 中的全部英雄 ID。
- **命令**：`hero_heroupgradestar { heroId }`。
- **循环**：每个英雄最多尝试 10 次；当前英雄第一次失败就跳到下一个英雄。
- **成功判断**：响应满足 `code === 0`、`success === true` 或 `result === 0` 之一才继续。
- **完成条件**：所有英雄都尝试过，哪怕大多数英雄因碎片不足或满星而跳过，也标记完成。
- **文案核查**：**需确认**。标签表达的是“升星动作”，不是“所有英雄升星成功”。

### 63. `batchBookUpgrade`：一键图鉴升星

- **遍历**：遍历 `HERO_DICT` 中的全部英雄 ID。
- **命令**：`book_upgrade { heroId }`。
- **循环**：每个英雄最多 10 次，当前英雄失败后进入下一个英雄。
- **完成条件**：尝试循环结束即标记完成。
- **文案核查**：**需确认**，与英雄升星相同，完成不等于每个英雄都升星。

### 64. `batchClaimStarRewards`：一键领取图鉴奖励

- **命令**：`book_claimpointreward {}`。
- **循环**：每账号最多 10 次；第一次失败即停止当前账号的领奖循环。
- **完成条件**：没有奖励可领导致循环停止时仍标记完成。
- **文案核查**：**基本准确**，但最多 10 次且没有奖励时也会显示完成。

### 65. `legion_storebuygoods`：一键购买四圣碎片

- **命令**：`legion_storebuygoods`。
- **参数**：`{ id: 6 }`。
- **循环**：每账号一次。
- **错误行为**：购买上限错误按已购买跳过；物品不存在错误按盐锭不足或未加入军团处理；其他错误标记失败。
- **文案核查**：**准确**，实际商品含义依赖军团商店 ID `6` 的服务端配置。

### 66. `legionStoreBuySkinCoins`：一键购买俱乐部 5 皮肤币

- **命令**：重复 `legion_storebuygoods`。
- **参数**：每次 `{ id: 1 }`。
- **循环**：最多 5 次串行；只保留最后一次响应用于最终 `result.error` 判断。
- **完成条件**：达到 5 次或停止；服务端返回上限错误时记录跳过，账号可能仍为完成。
- **文案核查**：**需确认**。源码明确是购买请求 5 次，但没有在本地验证每次是否恰好得到 1 个皮肤币，因此“5 皮肤币”是商品配置假设。

## 10. 功法：2 项

实现：[`tasksLegacy.js`](../src/utils/batch/tasksLegacy.js)。

### 67. `batchLegacyClaim`：批量功法残卷领取

- **命令**：`legacy_claimhangup {}`。
- **响应读取**：日志读取奖励数量和物品 ID `37007` 的总数量。
- **循环**：每账号一次。
- **完成条件**：领取命令 Promise 成功。
- **文案核查**：**准确**。

### 68. `batchLegacyGiftSendEnhanced`：批量功法残卷赠送

- **配置**：自由模板以 `scheduledArgument=true` 调用，使用模板接收者 ID和赠送数量；安全密码仍来自旧批量设置 `batchSettings.password`。
- **读取**：发送方角色信息中的残卷 ID `37007`；再以 `rank_getroleinfo` 查询接收者。
- **命令顺序**：`role_getroleinfo`，必要时 `rank_getroleinfo`，`role_commitpassword { password, passwordType: 1 }`，`legacy_sendgift { itemCnt, legacyUIds: [], targetId }`，最后刷新角色信息。
- **校验**：接收者存在、发送方残卷足够、赠送数量在范围内、密码验证响应含 `que:wh:tm` 统计字段。
- **循环**：每账号最多 3 次整体尝试；普通错误间隔重试，400340 直接失败。
- **数量**：模板数量会被限制为不超过发送方当前持有量和 9999；如果配置数量无效则使用当前持有量。
- **文案核查**：**准确**；但这是高风险操作，模板编辑器只配置接收者和数量，密码仍隐藏在旧批量设置中。

## 11. 月度与活动：3 项

实现：[`tasksArena.js`](../src/utils/batch/tasksArena.js) 和 [`tasksHangUp.js`](../src/utils/batch/tasksHangUp.js)。

### 69. `batchTopUpFish`：一键钓鱼补齐

- **目标**：读取 `activity_get` 的 `myMonthInfo["2"].num`，目标常量为 `FISH_TARGET=320`；按当前月份进度计算阶段性应达值。
- **免费部分**：若 `statisticsTime["artifact:normal:lottery:time"]` 显示今日可用，最多发送 3 次 `artifact_lottery { lotteryNumber: 1, newFree: true, type: 1 }`。
- **付费部分**：再次读取月度进度；读取普通鱼竿 ID `1011`，按最多 10 次一批发送 `artifact_lottery { lotteryNumber: batch, newFree: true, type: 1 }`。
- **奖励**：最后按 `artifact:point` 每 20 分尝试发送一次 `artifact_exchange {}`。
- **停止条件**：目标达到、普通鱼竿不足、请求失败、用户停止或安全流程结束。
- **重要配置事实**：自由模板的 `fishType` 不会改变该 handler；补齐任务固定使用普通鱼竿和 `type: 1`。模板里的鱼竿类型只影响 `batchFish`。
- **完成条件**：即使最终月度进度低于目标，代码最后仍把账号设为 `completed`。
- **文案核查**：**需确认**。目标补齐逻辑存在，但“补齐”不保证达到目标，且自由模板鱼竿类型设置对它无效。

### 70. `batchTopUpArena`：一键竞技场补齐

- **目标**：读取 `activity_get` 的 `myArenaInfo.num`，目标常量为 `ARENA_TARGET=240`；按当前月份进度计算阶段性应达值。
- **初始化**：读取并切换自由模板竞技场阵容。
- **库存**：读取咸神门票 ID `1007`；门票不足时把实际目标缩小到现有门票，门票为 0 时标记完成并跳过。
- **命令**：先尝试 `arena_startarea {}`；循环 `arena_getareatarget {}` 和 `fight_startareaarena { targetId }`；每轮刷新 `activity_get` 和角色门票。
- **循环**：每轮计划约 `ceil(remaining / 2)` 场，最多 100 次安全战斗计数。
- **收尾**：刷新最终进度并尝试恢复原阵容。
- **完成条件**：达到目标、门票耗尽、目标缺失、安全上限、请求中断等情况最后都可能标记 `completed`；日志会区分“达到目标”和“未达到目标”。
- **文案核查**：**需确认**。补齐算法存在，但 UI 标签容易把“尝试补齐”理解为“必定完成 240 次”。

### 71. `batchWarGuessCheer`：月赛助威

- **前置配置**：需要自由模板的 `warGuessLegionId`；拍手器数量使用 `warGuessCoin`，规范化范围为 `1-20`。
- **命令顺序**：尝试 `warguess_getguesscoinreward {}`；读取 `warguess_getrank { bfId: "" }`；必要时发送 `warguess_startguess { guessCoin, legionId }`。
- **次数**：统计当前赛程已助威数量，最多补到 20 次；配置数量超过剩余次数时自动缩小。
- **特殊状态**：已满 20 次、没有拍手器或 400000 功能未解锁时，账号可能被标记 `completed` 并跳过。
- **完成判断**：只有响应含 `guessLegion` 时记录助威成功；其他失败为 failed，400000 例外按跳过处理。
- **文案核查**：**准确**，但“完成”也可能表示已满、未解锁或跳过。

## 12. UI 与实现差异清单

以下项目建议在用户确认后再决定改 UI 还是改 handler：

1. **一键梦境**：`daily.dream` 和 `batchmengjing` 都只选择梦境阵容，没有真正执行梦境战斗、推进或奖励领取。
2. **宝库前 3 层、4/5 层**：handler 只按 `towerId` 区间发送固定次数的 BOSS/宝箱命令，没有逐层读取结果；4/5 层还不发送 `startbox`。
3. **梦境商品清单**：`batchBuyDreamItems` 使用旧的 `batchSettings.dreamPurchaseList`，自由模板编辑器没有自己的清单字段。
4. **完整日常开关**：自由模板会强制打开付费招募、开箱、竞技场、挂机、邮件、黑市等旧开关，UI 没有逐项展示这种覆盖关系。
5. **灯神范围**：`batchGenieSweep` 只处理 ID `1-4`，不处理深海灯神 ID `5`；“一键灯神扫荡”范围过宽。
6. **每日 BOSS 次数**：`daily.dailyBoss` 固定发送 3 次，没有读取每日已完成次数；“3 次”与实现一致，但可能重复请求。
7. **分享与加钟命令相同**：`daily.share`、`daily.addHangUpTime`、`claimHangUpRewards` 和 `batchAddHangUpTime` 都会发送 `system_mysharecallback` 的同一组参数，文案不应暗示已验证为不同底层动作。
8. **免费钓鱼时间字段**：`daily.freeFishing` 读取 `statistics["artifact:normal:lottery:time"]`，而其他任务多读取 `statisticsTime`；需要用真实响应确认。
9. **“完成”语义**：没有库存、活动不开放、没有目标、没有可合成对象、达到安全上限或目标未达成时，多个 handler 仍标记账号完成。UI 结果最好区分“执行完成”和“业务目标达成”。
10. **补齐任务的配置与结果**：月度钓鱼、竞技场补齐会受库存和安全上限限制；钓鱼补齐固定普通鱼竿；竞技场补齐的智能选敌和阈值配置来自旧设置。
11. **自由模板并发风险**：同一账号的多个顶层任务会并发切换阵容、读取角色信息并访问共享 `gameData`；共享 WebSocket 只保证队列发送，不保证业务操作互斥。
12. **重复领取命令**：`daily.collectionReward`、`daily.collectionGift` 和批量 `collection_claimfreereward` 可能在同一模板中重复请求同一领取接口。

## 13. 建议的确认口径

用户确认每项任务时，建议分别回答四个问题：

1. **是否允许发送这些命令和参数？**
2. **是否接受源码中的固定次数、库存缩减、活动日期和安全上限？**
3. **没有可操作对象或目标未达成时，是否仍显示账号“完成”？**
4. **同一账号选中多个任务时，是否接受它们并发运行并可能互相切阵容？**

在这四点确认前，不建议仅通过修改标签来掩盖执行范围，也不建议把 handler 返回的 `completed` 直接改写成业务目标成功。
