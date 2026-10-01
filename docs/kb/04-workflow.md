# L1 · 开发工作流（照做即可）

## 0. 总流程（review-then-deploy）

```
理解需求 → 查知识库/抓包 → 离线回放验证假设 → 写代码 → 单测 → 构建 → 部署 → 线上双验 → 冒烟
   ↑___________________ 不确定就先出方案给 master 拍板，不要盲写 ___________________|
```

**master 的偏好**：中文；称 master；偏好**先出方案再写代码**、**阶段化交付（阶段 A / 阶段 B）**、**表格化决策点**；
不清楚会主动要求澄清；时间紧时**跳过 GitHub 推送**走 bundle 直连；执行交给我推进，他等完成报告。

## 1. 逆向一个未知协议（标准动作）

1. **抓包**：runtime 工具抓 WSS（存 `local-data/<活动>/`），或让 master 提供 bin / jsonl。
2. **解码**：用 `node local-data/goldenfish/_gf.mjs <file> cmds|sends|struct|grep|num|dump`（底层走生产 `bonProtocol.js`）。也可用 skill `xyzw-protocol-re`。
3. **离线回放**：把请求体**逐字节复现**，确认能照着实现客户端代码。未复现成功的结论不算结论。
4. **单变量隔离**：一次只质疑一个假设，用运行时证据纠正误读。
5. **实机验证**：用 skill `xyzw-bin-test`（`local-data/bin-test/bin-test.mjs`）走**真实生产代码路径**实测。
6. **接入生产**：见 §3 / §4。

**对照实验方法论（血泪教训）**：
- 🔴 **对照实验材料要先"并排"再下结论**——`21a_fail` vs `21a_success` 同 token 双样本躺了半天，早并排早定位。
- 成功样本要立刻用**干净号/干净时段复刻**（E4 成功后 E7 干净号复刻，避免被会话污染误导）。
- 拿到一个假设，先问"**有没有现成反例/对照已经躺在那儿**"。

## 2. UI 接线红线（🔴 最高频事故，已踩 3 次）

**"导出函数" ≠ "有入口"。** 独立入口可单跑的字样出现时，必须查三处（实际**五处**）：

| # | 位置 | 内容 |
|---|---|---|
| 1 | `src/utils/batch/tasksXxx.js` | 写 handler 并 return 出来 |
| 2 | `src/views/BatchDailyTasks.vue` | `import` + 实例化 + `const { xxx } = tasksItem` 解构 |
| 3 | `BatchDailyTasks.vue` `createFlexibleTaskHandlers` | 若新模块，补 `...createTasksXxx(deps)` |
| 4 | `BatchDailyTasks.vue` 模板 | `<n-button @click="xxx" :disabled="isRunning \|\| selectedTokens.length === 0">` |
| 5 | `src/utils/batch/flexibleTemplate.js` | `flexibleTaskGroups` 里 `batchTask("xxx","标签",opts)` |

- 漏任何一处：**冒烟 dump 不出来**，部署后"没有这个按钮"（09-28 升星链/清空道具、10-01 金鱼 claim 按钮均如此）。
- 冒烟脚本：`node local-data/_smoke_*.mjs`（多数支持 `baseUrl` 参数）。

## 3. 新增一个批量任务（完整清单）

1. 在合适的 `src/utils/batch/tasksXxx.js` 写 handler：
   - 账号级 `Promise.all` 循环；账号内 `await` 串行；
   - `finally` 里 `closeWebSocketConnection + releaseConnectionSlot`；
   - `try/catch` 把结果置 `completed` / `failed`。
2. `src/utils/batch/index.js` 导出该 `createTasksXxx`（多数模块已导出）。
3. `BatchDailyTasks.vue`：import + 实例化 + 解构（红线 #2）。
4. `createFlexibleTaskHandlers`（若新模块）补展开（红线 #3）。
5. 页面模板加 `<n-button @click="handlerName">`（红线 #4）。
6. `flexibleTemplate.js` 加 `batchTask(...)`；带参数则加默认值 + `normalizeFlexibleTemplateSettings` 归一化（红线 #5）。
7. 若要进定时任务：`src/utils/batch/constants.js` 的 `availableTasks` + 页面 `taskGroupDefinitions` 分组。
8. 需要特殊参数：`runFlexibleBatchTask` 参数分支（`scheduledArgument` 等）。
9. 补 `test/` 用例。

> 执行层展开机制：`createFlexibleTaskDeps`(BatchDailyTasks.vue ~:8664) 把 `ensureConnection` 换成协调器版本、`releaseConnectionSlot` 换成 noop、`tokenStore` 换成屏蔽 `closeWebSocketConnection` 的 Proxy（`createFlexibleTokenStore`），并注入 `template.settings`。
> 所以**同一条 handler 在"页面直按钮"与"自由模板"两种上下文跑，连接生命周期由一个模块的 deps 决定。**

## 4. 新增/修改一条协议命令

1. `src/utils/xyzwWebSocket.js` `registerDefaultCommands()` 里 `CommandRegistry.register(cmd, 默认body, {rawBody?})`。
2. 若响应命令名 ≠ 请求命令名，补 `responseToCommandMap` 映射（漏了就 Promise 超时）。
3. 战斗类命令：确认 `battleVersion` 注入路径。
4. 抓包**逐字节复现**后，写 `test/batchCmdRegistry.test.js` 之类的注册表用例。
5. ⚠️ `src/utils/gameCommands.js` 是**死代码**，不要往里加东西——统一加到 `registerDefaultCommands()`。

## 5. 证据与日志规范

- **日志禁占位符**：曾出现 `fmtNum("-") = 0` 自毁证据链——异常值要显式输出原文。
- 诊断日志要能定位到：`cmd` / 请求 `body` / 响应 `body` / `resp` / `code` / `hint`。
- 抓包/日志文件命名带**时间+来源**（如 `21a_fail_wss-diag` / `21a_success_xyzw-runtime-wss`），否则事后无法并排。
- 生产核验要留**新旧双向证据**（新特征命中 + 旧特征 0 命中）。
- 收尾动作（核验/清理）**别把输出截断到看不出结论**。

## 6. 提交与交付

- commit 消息用中文、带 `feat/fix/perf/ui/refactor` 前缀 + 一句结论。
- 改完**必须**：`node --test test/*.test.js`（基线 554/555，唯一红=skinChallenge）+ `node node_modules/vite/bin/vite.js build --outDir ._tmp_build --emptyOutDir`。
- 部署后**必须**做线上双验 + 相关冒烟。
- 交付形式：完成报告 + 表格化结论 + 具体验证命令与结果。

## 7. 何时先问 master

- 涉及**真实账号动作**（跑批/投道具/攻击）的时机——先问"号跑到哪了""能否中断"。
- 业务口径/阈值有歧义（例：返还率口径、宝箱积分是否兑零头）。
- 需要**改生产默认行为**或动线上数据。
- 部署窗口（他可能正在浏览器里跑批，部署会刷新页面）。
