# 项目当前上下文

> 这是一份面向后续开发和代码分析的快速交接文档。
>
> 内容基于 2026-08-12 对当前工作区源码、配置和测试结果的核对。遇到本文与源码冲突时，以当前源码和验证结果为准；已知问题集中记录在 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

## 1. 项目定位

这是一个基于 Vue 3 + Vite 的 XYZW 游戏自动化前端工具，核心能力是：

- 导入、解析和管理多个游戏 Token。
- 在浏览器中维护 Token、选中角色和部分任务状态。
- 通过 WebSocket 直接连接游戏服务。
- 使用自定义 BON 二进制协议完成编码、解码和多种加解密。
- 执行单账号日常任务和多账号批量任务。
- 提供角色状态、游戏功能、消息测试、盐场和主题管理界面。

项目没有一个与前端配套、且当前完整存在于仓库中的业务后端。生产部署主要面向 Cloudflare Pages，`worker.js` 被复制为 `dist/_worker.js`，用于固定上游接口代理。

## 2. 技术栈和入口

- Vue 3.5 + Composition API + `<script setup>`
- Vite 5
- Pinia 2
- Vue Router 4
- Naive UI 和 Arco Design Vue
- VueUse
- TypeScript 与 JavaScript 混合
- BON 协议、LZ4、CryptoJS、P-Queue、IndexedDB
- 包管理器：`pnpm@10.19.0`

应用入口：

- [src/main.js](src/main.js)：注册 Vue、Pinia、Router、Naive UI，初始化主题并挂载应用。
- [src/App.vue](src/App.vue)：全局 Naive UI Provider、主题状态和根路由视图。
- [vite.config.js](vite.config.js)：插件、别名、开发代理和 Worker 构建后复制逻辑。
- [package.json](package.json)：依赖和开发脚本。

## 3. 核心模块地图

### 状态层

[src/stores/tokenStore.ts](src/stores/tokenStore.ts) 是当前主要状态中枢，负责：

- `gameTokens`、`selectedTokenId`、`tokenGroups` 等本地持久化状态。
- Token 导入、Base64 解析、校验、选择、更新和删除。
- 自动 Token 刷新：URL、BIN 和微信扫码来源均由 `attemptTokenRefresh()` 统一处理；刷新结果必须是包含有效 `roleToken` 的 JSON 加密 Token。
- WebSocket 连接状态、连接锁、跨标签页连接协调。
- 角色信息、军团信息、活动、塔、队伍、战斗版本和学习状态等 `gameData`。
- 消息处理、事件分发、任务运行状态和部分连接池逻辑。

相关遗留模块仍存在：

- [src/stores/auth.js](src/stores/auth.js)：旧认证兼容层。
- [src/stores/gameRoles.js](src/stores/gameRoles.js)：旧角色管理逻辑。
- [src/stores/localTokenManager.js](src/stores/localTokenManager.js)：较早的本地 Token 管理实现。
- [src/stores/common.ts](src/stores/common.ts)：当前类型检查中存在未完成/遗留引用，不应视为主要状态入口。
- [src/stores/cache.ts](src/stores/cache.ts)：旧缓存实现，被 WebSocket 客户端使用，但严格类型不完整。

### 协议层

[src/utils/bonProtocol.js](src/utils/bonProtocol.js) 提供：

- `DataReader`、`DataWriter`。
- BON 编解码器，支持基础类型、数组、Map、嵌套对象和二进制数据。
- `ProtoMsg` / `ProtoMsgLegion` 消息包装。
- `lx`、`x`、`xtm` 加解密方案及自动检测。
- `g_utils.encode()`、`g_utils.parse()` 和游戏消息模板。

消息通常包含以下字段：

```js
{
  cmd,
  body,
  ack,
  seq,
  time
}
```

### WebSocket 层

[src/utils/xyzwWebSocket.js](src/utils/xyzwWebSocket.js) 是游戏 WebSocket 客户端，负责：

- `CommandRegistry` 命令注册和默认参数合并。
- 发送队列和顺序化发送。
- 心跳、自动重连、状态回调和日志。
- `send()` 的发送即忘模式。
- `sendWithPromise()` 的请求响应模式。
- 按 `resp`、命令名和映射表匹配服务端响应。

连接创建主要在 `tokenStore.createWebSocketConnection()` 中完成，默认地址形态为：

```text
wss://xxz-xyzw.hortorgames.com/agent?p=<encoded-token>&e=x&lang=chinese
```

连接超时和 Token 刷新行为：

- 普通角色登录连接默认监控 10 秒握手超时；1006 握手失败也会进入相同的刷新流程。
- `attemptTokenRefresh()` 从 URL 或 IndexedDB 中的 BIN/WX 数据获取新 Token，并在成功后更新本地存储；失败通过 `token:refresh:failed` 事件通知界面。
- [src/views/BatchDailyTasks.vue](src/views/BatchDailyTasks.vue) 的批处理连接失败后，先等待旧连接关闭，再刷新 Token 并使用最新 Token 重连；批处理连接关闭 Store 的握手超时和握手失败自动刷新，避免后台刷新与批量刷新争用。刷新接口遇到限流时每隔 1 秒重试，直到成功；不可重试的刷新错误才停止账号并保留失败原因。
- 批量任务中的 `role_getroleinfo` 统一通过 [src/views/BatchDailyTasks.vue](src/views/BatchDailyTasks.vue) 的恢复入口请求；请求失败时关闭旧 WSS、刷新 Token、使用最新 Token 重建连接并重试角色信息，恢复耗尽后将异常交回当前账号任务，避免继续使用过期数据。
- [src/layout/DefaultLayout.vue](src/layout/DefaultLayout.vue) 和 [src/views/TokenImport/index.vue](src/views/TokenImport/index.vue) 监听刷新失败事件，并使用 Naive UI 对话框提示用户。

### 任务层

- [src/utils/dailyTaskRunner.js](src/utils/dailyTaskRunner.js)：单账号任务编排，按照角色信息和任务设置生成任务列表，顺序执行游戏命令。
- [src/utils/helperTaskRunner.js](src/utils/helperTaskRunner.js)：批量命令、重试、限流和库存校验等相对独立的纯工具逻辑。
- [src/views/BatchDailyTasks.vue](src/views/BatchDailyTasks.vue)：多账号批量任务、定时任务、连接准备、日志和大量业务任务入口，目前是超大单文件。
- [src/views/DailyTasks.vue](src/views/DailyTasks.vue)：单账号日常任务页面，部分状态仍与 Mock/localStorage 逻辑耦合。

### 事件与界面层

[src/stores/events/](src/stores/events/) 根据服务端命令分发角色、活动、军团、队伍、塔、聊天等事件，更新 Store 或通知 UI。

主要页面：

- [src/views/Home.vue](src/views/Home.vue)：首页。
- [src/views/TokenImport/index.vue](src/views/TokenImport/index.vue)：Token 导入和管理。
- [src/views/TokenImport/bin.vue](src/views/TokenImport/bin.vue)：BIN 多角色导入；角色表桌面端每页显示 50 条，并支持顺序“全部添加”到待导入列表。
- [src/views/Dashboard.vue](src/views/Dashboard.vue)：控制台和连接/角色状态。
- [src/views/GameFeatures.vue](src/views/GameFeatures.vue)：游戏功能入口。
- [src/views/DailyTasks.vue](src/views/DailyTasks.vue)：单账号任务。
- [src/views/BatchDailyTasks.vue](src/views/BatchDailyTasks.vue)：批量任务。
- [src/views/LegionWar.vue](src/views/LegionWar.vue)：盐场功能。
- [src/components/Test/MessageTester.vue](src/components/Test/MessageTester.vue)：BON/消息测试。
- [src/components/Test/WebSocketTester.vue](src/components/Test/WebSocketTester.vue)：WebSocket 测试。
- [src/layout/DefaultLayout.vue](src/layout/DefaultLayout.vue)：管理页面导航和嵌套路由布局。

## 4. 关键数据流

### Token 导入到连接

```text
TokenImport 页面
  -> tokenStore.importBase64Token()
  -> parseBase64Token()
  -> validateToken()
  -> addToken()
  -> gameTokens / localStorage
  -> selectToken()
  -> createWebSocketConnection()
  -> XyzwWebSocketClient
```

Token 输入可能是纯文本、Base64、带前缀内容或 JSON 包装内容。解析后会提取 `token`、`gameToken` 或解码结果作为实际连接 Token。

### 消息发送到响应

```text
任务/页面
  -> tokenStore.sendMessageWithPromise()
  -> client.sendWithPromise()
  -> sendQueue
  -> CommandRegistry.build()
  -> BON encode + encryption
  -> WebSocket.send()
  -> WebSocket.onmessage
  -> BON decrypt + parse
  -> _handlePromiseResponse()
  -> Promise resolve/reject
```

无 Promise 的消息走 `send()`；心跳使用特殊的 `_sys/ack` 报文。收到消息后，Store 还会通过事件系统分发给角色、活动和功能模块。

### 任务执行

```text
批量日常执行 `DailyTaskRunner` 命令时，如果检测到 `WebSocket未连接`，会先关闭旧连接、重新建立并初始化 WebSocket，再重试当前命令，最多恢复 2 次；因此连接中途掉线不会直接跳过该命令。其他入口未注入重连回调时保持原有行为。

任务设置
  -> 生成任务列表
  -> 检查角色/活动/库存
  -> 建立或复用 WebSocket 连接
  -> 顺序或批量发送游戏命令
  -> 延迟、重试和进度回调
  -> 更新日志与 gameData
```

批量日常主流程按 `maxActive` 分成账号波次：同一波账号并发执行，但下一波必须等待当前波全部结束后才启动。每个账号内部由 `DailyTaskRunner` 线性执行任务，日常任务完成后先逐项领取每日任务积分奖励，再领取每日完成奖励，随后处理周常和通行证奖励。连接失败时先由批量流程刷新 Token，再使用最新 Token 重连；刷新遇到限流或 HTTP 429 时每隔 1 秒重试直到成功。任务执行遇到限流、模块未开启、已知屏蔽或其他服务器错误时，都记录警告并只跳过当前任务，继续执行后续任务；批量车辆、挂机奖励和加钟流程中的 `400340` 统一视为限流，相关命令按 1 秒间隔重试，最多重试 100 次并记录当前重试次数；领取挂机奖励的 `system_claimhangupreward` 遇到请求超时也按同样策略重试；车辆和挂机初始化也遵循该策略，耗尽后才跳过当前车辆或账号。智能发车只使用免费刷新和刷新券，不使用金砖刷新，策略默认是逻辑 A，也可在批量设置中选择逻辑 B。智能发车按角色逐辆处理车辆。只有用户主动停止批处理或连接初始化失败才会结束当前账号。流程结束后在页面弹窗显示完成数量、总数量和最终失败角色清单，并可一键重新选中最终失败的账号。错误账号按最终状态汇总，不记录中间重试失败。

批处理工具层已覆盖批次拆分、限流重试、库存前后校验等场景，并有 Node 原生测试；核心 Store、WebSocket、路由和大部分页面交互尚未形成系统化测试。

## 5. 路由结构

路由入口是 [src/router/index.js](src/router/index.js)：

- `/`：首页；有 Token 时重定向到 `/admin/dashboard`。
- `/tokens`：Token 导入管理页，支持 query 参数预填充。
- `/admin`：使用 [src/layout/DefaultLayout.vue](src/layout/DefaultLayout.vue) 的管理布局。
- `/admin/dashboard`：控制台。
- `/admin/game-features`：游戏功能。
- `/admin/daily-tasks`：单账号日常。
- `/admin/batch-daily-tasks`：批量日常。
- `/admin/message-test`：消息测试。
- `/admin/legion-war`：盐场，带时间限制。
- `/admin/profile`：设置。
- `/websocket-test`：WebSocket 测试。

路由同时使用手写路由和 `unplugin-vue-router` 自动路由。当前重复注入和热更新导出警告记录在 [KNOWN_ISSUES.md](KNOWN_ISSUES.md) 中。

## 6. 存储和外部依赖

浏览器端主要使用：

- `localStorage`：游戏 Token、选中 Token、分组、主题和跨标签页连接状态。
- IndexedDB：部分二进制数据和辅助存储。
- WebSocket：直接连接游戏服务。
- HTTP/HTTPS：Token 转换、服务器列表和 Worker/开发代理相关请求。

Vite 开发代理位于 [vite.config.js](vite.config.js)，当前配置了微信登录、微信长轮询和 Hortor 接口代理。Cloudflare Worker 位于 [worker.js](worker.js)，当前只代理固定的三个前缀并为其添加 CORS 响应头。

## 7. 常用命令和当前验证状态

安装依赖：

```bash
pnpm install --frozen-lockfile
```

开发、构建和预览：

```bash
pnpm run dev
pnpm run build
pnpm run preview
```

当前 `package.json` 声明的专项脚本：

```bash
pnpm run testr
pnpm run testd
```

需要注意：当前没有统一的 `test` 脚本。已验证的测试命令为：

```bash
node --test test/helperTaskRunner.test.js test/towerClimbLimit.test.js
```

截至 2026-08-12 的验证结果：

- 依赖按锁文件安装成功。
- 两个 Node 测试文件共 15 个用例全部通过。
- `pnpm run build` 成功，但有自动路由、`eval` 和大 chunk 警告。
- `pnpm exec tsc --noEmit -p tsconfig.app.json` 失败，14 个文件共 139 个错误。
- `pnpm exec eslint src --ext .vue,.js,.ts` 无法执行，找不到 `eslint` 命令。

截至 2026-08-13 的自动 Token 刷新功能验证：

- `pnpm build` 成功；仍有可选 Vite 插件缺失和 Sass legacy API 警告。
- `pnpm testd` 成功。
- `node --check src/utils/batch/connectionManager.js` 成功。
- `pnpm testr` 仍因测试脚本使用未配置的 `@utils/bonProtocol.js` 路径别名失败，与本次改动无关。

## 8. 部署信息

前端生产构建输出到 `dist`。Vite 的 `copy-worker` 插件会在构建结束时把根目录 [worker.js](worker.js) 复制为 `dist/_worker.js`，供 Cloudflare Pages Advanced Mode 使用。

README 还描述了 `server/app.py` 的 Python Token URL 服务，但当前工作区的 `server/` 目录只有 [requirements.txt](server/requirements.txt)，因此这部分说明不能视为当前仓库可直接运行的完整功能。

## 9. 后续分析入口

按任务选择最小读取范围：

- Token、连接、跨标签页状态：先读 [src/stores/tokenStore.ts](src/stores/tokenStore.ts)。
- BON 编解码或消息格式：读 [src/utils/bonProtocol.js](src/utils/bonProtocol.js)。
- WebSocket 请求、心跳、响应超时：读 [src/utils/xyzwWebSocket.js](src/utils/xyzwWebSocket.js)。
- 单账号自动化：读 [src/utils/dailyTaskRunner.js](src/utils/dailyTaskRunner.js)。
- 批量任务或定时调度：读 [src/views/BatchDailyTasks.vue](src/views/BatchDailyTasks.vue)，并注意其文件规模和动态任务分发。
- 页面跳转和 Token 门禁：读 [src/router/index.js](src/router/index.js)。
- 当前已知问题：读 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

## 10. 文档优先级

1. 当前源码、测试结果和配置文件。
2. 本文件 `PROJECT_CONTEXT.md`：当前状态的快速快照。
3. `KNOWN_ISSUES.md`：风险、缺陷和待处理事项。
4. `CLAUDE.md`：较完整的开发指导，但部分目录、接口和测试描述可能滞后。
5. `README.md`：用户使用和部署说明，其中 Python 服务部分与当前工作区不完全一致。

## 11. 维护约定

`PROJECT_CONTEXT.md` 是本仓库面向后续开发的当前状态文档。它不是一次性分析报告，而是需要随代码一起维护的交接入口。

- 涉及目录结构、模块职责、数据流、路由、存储、依赖、命令或部署方式的改动，应同步更新本文档。
- 新增或移除核心模块时，更新“核心模块地图”和“后续分析入口”。
- 构建、测试、类型检查或 lint 结果发生变化时，更新“常用命令和当前验证状态”，并注明验证日期。
- 已知缺陷、技术债和安全风险记录在 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)，本文档只保留必要的定位和入口。
- `README.md`、`CLAUDE.md`、`LOCAL_TOKEN_CHANGES.md` 等旧 Markdown 文件可能滞后；它们可用于了解历史背景，但不能覆盖当前源码、测试结果和本文档中的当前状态。
- 修改本文档时优先引用当前实际存在的文件、脚本和符号，避免把历史计划或未交付功能写成现行能力。
