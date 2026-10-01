# L1 · 架构总览

## 1. 项目定位

无后端的纯前端工具站：管理游戏 Token → 直连游戏 WebSocket（BON 私有协议）→ 批量自动化各类游戏活动。
**没有配套业务后端**，所有状态在浏览器（localStorage + IndexedDB）；生产部署在腾讯云 nginx（`dist/` 直出）。

**技术栈**：Vue 3.5 (`<script setup>`) · Vite 5 · Pinia 2 · Vue Router 4 · Naive UI + Arco Design Vue · VueUse · TS/JS 混合 · `p-queue` · `lz4js` · `crypto-js` · IndexedDB · 包管理器 `pnpm@10.19.0`。

**入口**：`src/main.js`(注册 Vue/Pinia/Router/Naive) → `src/App.vue`(Provider+根路由) → `vite.config.js`(插件/别名/代理) · `index.html` 额外加载 `src/xyzw/`(Cocos 游戏 bundle + `window.__require`)。

## 2. 分层架构（自上而下）

| 层 | 文件 | 职责 → 关键符号 |
|---|---|---|
| 页面 | `src/views/*.vue`、`src/components/**` | 交互、按钮、结果展示 |
| 批量编排 | `src/views/BatchDailyTasks.vue`、`src/utils/batch/*` | 多账号波次调度、任务目录、限流重试 |
| 状态中枢 | `src/stores/tokenStore.ts` | **唯一对外 API**：连接/锁/刷新/gameData/限流 |
| 协议 | `src/utils/bonProtocol.js` | BON 编解码 + 加密 + `ProtoMsg` |
| WS 客户端 | `src/utils/xyzwWebSocket.js` | `CommandRegistry` / `send` / `sendWithPromise` |
| 连接池 | `src/utils/batch/connectionManager.js` | 并发限流 + 建连前奏 |
| 事件 | `src/stores/events/*` | `emitPlus(cmd)` → 各 Plugin 写 `gameData` |
| 多开 | `src/utils/gameLauncher.js`、`multiGameSyncPlan.js`、`public/game/*` | iframe 隔离/同步/伪装 |

## 3. 关键数据流

**导入 → 连接**
```
页面 → tokenStore.importBase64Token → parseBase64Token → validateToken → addToken
     → gameTokens(localStorage) → selectToken → createWebSocketConnection
     → ensureTokenAvailable(按需刷新) → new XyzwWebSocketClient().init()
```

**发命令 → 收响应**
```
页面/任务 → tokenStore.sendMessageWithPromise
  → client.sendWithPromise (入队、分配 ++seq)
  → CommandRegistry.build → BON encode → 加密 → WebSocket.send
  → onmessage → utils.parse → _handlePromiseResponse
  → 匹配规则：优先 packet.resp === seq；兜底 responseToCommandMap(命令名映射)
  → resolve / reject(超时)
收到帧 → handleGameMessage → emitPlus(cmd) → Plugin → gameData
```
- `send()` = 发送即忘；`sendWithPromise()` = 请求响应。
- 心跳：连接后 3s 首发，`heartbeatMs=5000`，`seq=0`、`cmd=_sys/ack`。

**任务执行（批量）**
```
批量页 → 按 maxActive 分账号波次 → 每账号
  → connectionQueue 等槽 → ensureConnection(建连 + role_getroleinfo + fight_startlevel)
  → DailyTaskRunner 线性跑 daily 任务 / batch 任务并发
  → 延迟·重试·进度回调 → 更新日志与 gameData
  → 波次末尾统一 close + releaseSlot
```

## 4. 目录地图（只列有意义的）

```
src/
├── views/            BatchDailyTasks(主入口·超大单文件) / SaltFieldAuto / PantaoAuto
│                     GameMultiPlayer / GamePlayer / PushingLevels / PushLevelResearch
│                     PushLevelSynthetic / LegionWar / Dashboard / DailyTasks / TokenImport/
├── components/        Club/ Tower/ Team/ Daily/ cards/ Common/ Setting/ Test/
├── stores/           tokenStore.ts(核心) · events/(分发) · legionWarStore · weirdTowerAssist
│                     (+ legacy: auth.js / gameRoles.js / localTokenManager.js / cache.ts)
├── utils/
│   ├── (连接/协议)    bonProtocol.js · xyzwWebSocket.js · wsAgent.js · readable-xyzw-ws.js
│   ├── (认证)         token.ts · tokenRefreshPolicy.js · tokenDb.js · hortorLogin.js · serverRole.js
│   ├── (活动)         goldenfish* · xiaoyaojinPlan · pantao* · saltFieldConfig · legionWar*
│   │                  whiteJade · pkroomAppoint · smartBlackMarket · smartOpenBox · weirdTower*
│   ├── batch/         引擎：flexibleTemplate · connectionManager · helperTaskRunner · index
│   │                  tasks*.js(按活动拆) · logRing · logUtils · cronUtils · campChallengePlanner
│   ├── pushLevel/     主线推关(纯逻辑)
│   └── gameLauncher.js / multiGameSyncPlan.js / clubBattleUtils.js / protocolError.js
├── router/index.js   手写 + unplugin-vue-router 自动路由
└── xyzw/             Cocos 游戏 bundle(index.html 加载，非主应用)
```

## 5. 路由

| 路径 | 页面 |
|---|---|
| `/` | 首页（有 Token 自动跳 `/admin/dashboard`） |
| `/tokens` | Token 导入管理（支持 query 预填） |
| `/admin/*` | `DefaultLayout.vue` 管理布局：dashboard / game-features / daily-tasks / batch-daily-tasks / message-test / legion-war / salt-field-auto / pantao-auto / profile |
| `/websocket-test` | WS 测试 |

## 6. 状态管理

- **`tokenStore`(TS)**：`gameTokens` / `selectedTokenId` / `tokenGroups`(按稳定键 `serverId:roleId`) / `wsConnections` / `gameData` / 连接队列 / 任务运行状态。经 VueUse `useLocalStorage` 持久化。
- **legacy store**（`auth.js` / `gameRoles.js` / `localTokenManager.js` / `cache.ts`）：仍被引用，但不是主入口，勿在其上扩展。
- **`gameData` 结构**：`roleInfo` / `legionInfo` / `commonActivityInfo` / `bossTowerInfo` / `evoTowerInfo` / `presetTeam` / `battleVersion` / `studyStatus` / `lastUpdated`。
- **事件**：`src/stores/events/` 按服务端命令分发（角色/活动/军团/队伍/塔/聊天）。

## 7. 存储与外部依赖

- `localStorage`：`gameTokens` / `selectedTokenId` / `tokenGroups` / `multiGameTokenGroups` / `theme` / `ws_connection_${tokenId}`(跨标签页) / `flexible-task-templates`(自由模板) / `task-templates`(旧模板) / `daily-settings:*` / `xyzwPlatformSpoof` / `xyzwMultiGamePlatformSpoof` / `multiGameSyncMode|GroupOrder|Masters|GlobalSource`
- `IndexedDB`：`tokenDb.js` — 登录 BIN 等二进制数据（手机号/微信扫码来源的刷新凭据）
- 网络：WSS 直连游戏；HTTP 仅 Token 转换/服务器列表；Vite 开发代理（微信登录/长轮询/Hortor 组合登录/账号中心）
- `worker.js` → 构建时复制为 `dist/_worker.js`（Cloudflare Pages 高级模式代理，**当前生产用 nginx，实际不走它**）

## 8. 构建配置要点

- 别名：`@`→`src/`、`@components`、`@views`、`@assets`、`@utils`、`@api`、`@stores`
- `unplugin-vue-router` 从 `src/views/` 自动生成路由（排除 `components/`、`test**.vue`、`**Modal.vue`）
- `unplugin-auto-import`（Vue/Router/i18n 免 import）、`unplugin-vue-components`（`src/components/` 自动注册 + ArcoResolver）
- 插件用 `safeImport()` 安全加载，缺可选依赖不崩
- 已知警告（正常现象）：自动路由重复注入、`eval`、Sass legacy API、大 chunk（主 chunk ~4.7MB）
