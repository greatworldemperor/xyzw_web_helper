# L2 · 批量执行引擎

> 主入口：`src/views/BatchDailyTasks.vue`（**10104 行超大单文件**：template 1-3944 / script 3944-9270 / style 9272+）
> 引擎层：`src/utils/batch/*`

## 1. 任务分类体系

| 体系 | 存储键 | 结构 | 执行方式 |
|---|---|---|---|
| **旧任务模板** | `task-templates` + `daily-settings:*` | `selectedTasks` = **函数名字符串数组** | 页面 `eval(taskName)`（~:6427）；入口 `startBatch`(完整日常) / `executeScheduledTask` / `manualExecuteTask` |
| **自由模板** | `flexible-task-templates` | `{id,name,selectedTasks:[taskId],settings}`，`kind` ∈ `daily`/`batch` | `runFlexibleTemplate` + 共享连接协调器 |

两套**并存、独立存储、共用同一批 handler**；旧模板/导入数据里的旧 ID 由 `legacyFlexibleTaskAliases` 归一化。

**自由模板的 7 个分组（`flexibleTemplate.js` `flexibleTaskGroups`，实际 63 个 task ID）**：

| 分组 id | 名称 | 数量 | 说明 |
|---|---|---|---|
| `daily` | 完整日常 | 31 | 30 个 `daily.*` + 1 个 `batchStudy`(一键答题) |
| `dungeon` | 副本 | 5 | climbTower / skinChallenge / batchClaimPeachTasks / batchBuyDreamItems / batchFootballBet |
| `treasury` | 宝库 | 2 | batchbaoku13 / batchbaoku45 |
| `weirdTower` | 怪异塔 | 2 | climbWeirdTower / batchSmartItemHandling |
| `resource` | 资源 | 18 | 白玉/预约/周奖励/开箱/钓鱼/招募/升星链/清空道具/俱乐部购买… |
| `legacy` | 功法 | 2 | batchLegacyClaim / batchLegacyGiftSendEnhanced |
| `monthly` | 月度与活动 | 3 | batchTopUpFish / batchTopUpArena / batchWarGuessCheer |

- ⚠️ 文档里的 "58 个任务"、任务书口述的 57 **均已过期**，以 `flexibleTaskGroups` 实际展开为准（当前 63）。
- **`daily.*` vs `batch`**：`daily.*` 只汇总进 `dailyTaskIds`，交 `DailyTaskRunner.run` **按源码固定顺序串行**（**不按勾选顺序**）；`batch` 任务各自是独立 Promise，**并发**执行。
- 逍遥津「临时活动」分组已于 **2026-09-26 活动结束后下线**（分组与任务项移除，源码 + 测试保留；下期恢复分组 + 页面标签按钮即可）。
- `batchFishAutoMerge`（一键合并鱼）**刻意不进自由/定时模板**——一次性操作，只留批量页「资源」栏按钮。

## 2. 一个任务从"定义"到"可点击"的 5 处同步点

见 `04-workflow.md` §2。简版：
1. `src/utils/batch/tasksXxx.js` 写 handler（`createTasksXxx(deps)` 返回对象）
2. `BatchDailyTasks.vue` import + 实例化 + `const { xxx } = tasksItem` 解构
3. `createFlexibleTaskHandlers`（~:8549-8564）用 `...createTasksXxx(deps)` **打平合并**，key = handler 名；`runFlexibleBatchTask`(~:8756) 按 `task.handler` 取同名函数
4. 模板 `<n-button @click="xxx">`
5. `flexibleTemplate.js` `batchTask("xxx","标签",opts)`

**deps 注入（`createTaskDeps`）**：`ensureConnection` / `releaseConnectionSlot` / `connectionQueue` / `tokenStore` / `addLog` / `batchSettings` / `delayConfig`。
**自由模板上下文（`createFlexibleTaskDeps` ~:8664）**：换成 `coordinator.ensureConnection`、`releaseConnectionSlot` = noop、`tokenStore` = 屏蔽 `closeWebSocketConnection` 的 Proxy、`message` = 屏蔽 `success` 的 Proxy，注入 `template.settings`。

## 3. 执行调度（`runFlexibleTemplate` ~:8866-9024）

```
batchSize = maxActive (默认 2)
for 波次 (按 startIndex 推进):
    wave = 账号切片
    coordinator = createSharedConnectionCoordinator()   // flexibleTemplate.js:364
    executions = [ runFlexibleDailyTasks?, ...batchTasks.map(runFlexibleBatchTask) ]
    await Promise.all(executions)                       // 账号内线性、账号间并发
    finally: coordinator.cleanup() → connections.clear() → 逐 token close + releaseSlot
```

- **每账号只缓存一个连接 Promise**（`connections Map`），避免多顶层任务重复建连；失败时回收槽位。
- **上一波全部结束才进下一波**。
- **最慢任务决定断开时机**（槽位保持到所有任务跑完）。
- 全局 `connectionQueue.active` 由 `waitForConnectionSlot` / `releaseConnectionSlot` 维护。

## 4. 错误处理与重试（`src/utils/helperTaskRunner.js`）

| 判定函数 | 命中 |
|---|---|
| `is400340Error` | 文本含 `400340` |
| `isRateLimitError` | `400312`/`200400`/`12400000`/`429`/操作过快/限流…（排除已耗尽） |
| `isOfflineSendError` | "WebSocket未连接" / "连接已关闭"（帧未发出） |
| `isTimeoutError` | "请求超时" |
| `isConnectionError` | 超时 + offline + 连接超时 / Failed to fetch / ENOTFOUND |

| 机制 | 行为 |
|---|---|
| `runWithRateLimitRetry` | 限流 → 每 5s 重试，`RATE_LIMIT_MAX_RETRIES = Infinity` |
| `runWithConnectionRetry` | 任务级**整体重跑**，仅连接类且未停止 |
| `wrapTokenStoreWithConnectionRetry` | 帧层 Proxy 包 `sendMessageWithPromise`：发送前失败→重建连接 3次×5s；超时→1次×3s；其它原样抛 |
| tokenStore 限流控制器 | `400340` 弹窗 + 5s 重试 + 15min 上限（批量层弹不到） |
| `DailyTaskRunner.executeWithWebSocketRecovery` | 单账号日常遇"WebSocket未连接"→关旧连→重建→重试，最多 2 次 |

**批量主流程语义**：
- 按 `maxActive` 分波，同波账号并发，下一波必须等当前波全部结束。
- 账号内日常任务跑完 → 逐项领每日任务积分奖励 → 领每日完成奖励 → 周常 → 通行证奖励。
- 连接失败：先批量流程刷 token，再用最新 token 重连；限流/429 每 1s 重试直到成功。
- 任务遇限流/模块未开启/已知屏蔽/其它服务器错误 → **记警告 + 只跳过当前任务**，继续后续。
- 挂机奖励/加钟的 `400340` 统一视为限流，按 1s 间隔最多重试 100 次（记当前次数）；`system_claimhangupreward` 超时同策略。
- 只有**用户主动停止**或**连接初始化失败**才结束当前账号。
- 结束弹窗显示：完成数/总数/最终失败角色清单，可一键重新选中失败账号（按**最终状态**汇总，不记中间重试失败）。

## 5. UI 结构

左侧 header：`startBatch` / 停止 / 旧任务模板 / 自由模板 / 设置 + 账号列表（分组）。
右侧 `n-tabs`：`daily 日常`、`dungeon 副本`、`baoku 宝库`、`weirdTower 怪异塔`、`resource 资源`、`legacy 功法`、`monthly 月度`、`temporary 临时活动`(空壳)、`goldenfish 金鱼`。
每个 tab = `n-space` + 若干 `n-button`，禁用条件统一 `isRunning || selectedTokens.length === 0`。

**按钮绑定三套路径**：① 页面按钮直接绑作用域函数；② 定时任务经 `taskGroupDefinitions` 分 tab 勾选函数名后 `eval`；③ 自由模板经 `createFlexibleTaskHandlers` 映射。
**相关弹窗**：自由模板管理(~:1744)、定时任务列表(~:2750)、任务编辑(~:2846)、自由模板编辑(~:3026)、黑市商品(~:2677)。

## 6. 其它引擎组件

| 文件 | 职责 |
|---|---|
| `batch/constants.js` | `availableTasks`（定时任务可选任务）等常量 |
| `batch/cronUtils.js` | 定时表达式工具 |
| `batch/logRing.js` | 日志环形缓冲（曾省 70% 渲染开销） |
| `batch/logUtils.js` | 日志格式化 |
| `batch/phase1Cleanup.js` | 第一阶段清理逻辑 |
| `batch/skinChallengeUtils.js` | 换皮闯关 BOSS 目标规范化（支持 BOSS 1-6，空选=跳过） |
| `batch/connectionManager.js` | 连接池 + 建连前奏（见 `03-protocol-connection.md`） |
| `dailyTaskRunner.js` | 单账号日常编排；`selectedTaskIds` 可只生成勾选任务 |
| `helperTaskRunner.js` | 纯工具：批量命令、重试、限流、库存校验 |

## 7. 相关测试（`test/`）

`batchCmdRegistry` · `flexibleTemplate` · `helperTaskRunner` · `logRing` · `dailyTaskRunnerSelection` · `tasksHangUp` · `tasksTower` · `tasksXianMaster` · `tasksXiaoyaojinCoupon` · `fishMerge` · `tasksGoldenfishConsume`

## 8. 引擎红线

1. 五处接线缺一不可（见 §2）。
2. 新增 handler 必须自己 `finally` 释放槽位，否则连接池泄漏、后续账号排队卡死。
3. `daily.*` 按源码顺序跑，不接受勾选顺序；要自定义顺序必须用 `batch` 任务。
4. `eval(taskName)`（旧模板）是已知 P0 安全问题，新增功能**别再往这条路径上加**。
5. 自由模板里 `tokenStore` 是 Proxy，**`closeWebSocketConnection` 被屏蔽**——不要在 handler 里依赖它关闭连接。
