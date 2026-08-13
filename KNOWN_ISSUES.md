# 已知问题与技术债

> 状态：仅记录，暂不处理。
>
> 本文件用于保存项目分析中确认的风险、缺陷和维护事项，后续按优先级逐项处理。

## 优先级说明

- **P0**：安全风险或可能导致严重数据/业务问题，应优先处理。
- **P1**：影响可靠性、构建质量或核心维护流程。
- **P2**：维护成本、性能、文档和体验问题。

## P0：安全风险

### 1. 批量任务使用 `eval` 动态执行函数

- **位置**：`src/views/BatchDailyTasks.vue:4429`、`src/views/BatchDailyTasks.vue:4595`
- **现状**：定时任务通过 `eval(taskName)` 查找并执行任务函数。
- **风险**：动态表达式执行会扩大输入污染后的影响范围，也会削弱静态分析、重构和构建压缩的可靠性。生产构建已经对此发出警告。
- **后续方向**：使用显式的任务名到处理函数的白名单映射，统一校验和执行入口。
- **状态**：未处理。

### 2. Token 明文持久化到浏览器 `localStorage`

- **位置**：`src/stores/tokenStore.ts:70`、`src/stores/tokenStore.ts:79`、`src/stores/tokenStore.ts:82`
- **现状**：`gameTokens` 等状态通过 `useLocalStorage` 持久化，Token 数据直接包含敏感 Token。
- **风险**：页面 XSS、恶意浏览器扩展、共享设备或调试环境都可能读取 Token。
- **后续方向**：减少敏感字段的持久化范围，评估会话化、用户口令派生密钥加密和 IndexedDB 存储；同时避免在日志和连接状态中重复保存原始 Token。
- **状态**：未处理。

### 3. Worker 代理允许任意来源跨域调用

- **位置**：`worker.js:8`
- **现状**：`Access-Control-Allow-Origin` 设置为 `*`。
- **风险**：任意站点都可以调用代理接口，可能增加接口滥用、配额消耗和跨站数据访问风险。
- **后续方向**：限制允许来源、请求方法、请求头、代理路径和请求频率；生产环境不要使用无条件的通配来源。
- **状态**：未处理。

### 4. README 暴露默认管理员账号密码

- **位置**：`README.md:203-219`
- **现状**：文档直接写出默认账号 `admin` 和密码 `admin123`。
- **风险**：部署人员可能直接沿用弱口令，形成可预测的管理入口。
- **后续方向**：首次启动强制设置管理员密码，或通过环境变量/交互式初始化生成随机凭据；文档只说明初始化流程，不记录固定密码。
- **状态**：未处理。

## P1：可靠性与构建质量

### 5. WebSocket Promise 超时定时器在成功响应后没有清理

- **位置**：`src/utils/xyzwWebSocket.js:854-875`、`src/utils/xyzwWebSocket.js:1012`
- **现状**：`sendWithPromise` 创建超时定时器，但定时器句柄没有放入 Promise 记录；响应处理只删除 Promise 记录，无法清理定时器。
- **风险**：高频请求下会积累大量已无效的定时器，增加运行时开销和诊断噪声。
- **后续方向**：将 timer 保存到请求记录，在成功响应、服务器错误、超时、断开连接等所有结束路径统一清理。
- **状态**：未处理。

### 6. WebSocket 断开时挂起请求的统一失败处理不足

- **位置**：`src/utils/xyzwWebSocket.js:854`、连接断开相关处理区域
- **现状**：请求 Promise 保存在 `this.promises` 中；需要确认连接关闭、重连和永久失败时是否会统一 reject 所有挂起请求。
- **风险**：请求可能一直等待到各自超时，任务层得到的错误延迟且不明确。
- **后续方向**：建立连接生命周期结束处理器，批量 reject 挂起请求并清理对应定时器。
- **状态**：待进一步验证，未处理。

### 7. Token Store 初始化不是幂等的

- **位置**：`src/stores/tokenStore.ts:1276`、`src/stores/tokenStore.ts:1430`；调用点见 `src/views/Dashboard.vue:199`
- **现状**：`initTokenStore()` 每次调用都会启动监控定时器并注册 `storage` 监听，没有统一的初始化标记或销毁函数。
- **风险**：重复进入页面、热更新或重复初始化可能产生多个定时器和事件监听器，导致重复清理、重复日志和性能问题。
- **后续方向**：增加幂等初始化保护，并提供清理函数，在应用生命周期中统一管理。
- **状态**：未处理。

### 8. 自动路由重复注入，并调用了当前模块未导出的热更新成员

- **位置**：`src/router/index.js:6`、`src/router/index.js:104`、`src/router/index.js:130`、`src/router/index.js:154`
- **现状**：`generatedRoutes` 同时作为 `/admin` 子路由和顶层路由注入；构建时报告 `handleHotUpdate` 不是 `virtual:vue-router/auto-routes` 导出的成员。
- **风险**：可能出现重复匹配、路由命名冲突、导航行为不一致或开发环境热更新异常。
- **后续方向**：明确自动路由的唯一挂载层级，依据当前 `unplugin-vue-router` 版本使用正确的热更新 API。
- **状态**：未处理。

### 9. TypeScript 严格检查失败

- **验证结果**：`pnpm exec tsc --noEmit -p tsconfig.app.json` 报告 14 个文件共 139 个错误。
- **主要位置**：`src/stores/tokenStore.ts`、`src/stores/common.ts`、`src/stores/cache.ts`、`src/stores/events/`、`src/utils/token.ts`
- **典型问题**：接口缺少实际使用的字段，如 `level`、`profession`、`lastUsed`、`connectedAt`、`reconnectAttempts`、`disconnecting`；同时存在隐式 `any`、未使用变量和旧代码引用不存在的变量/函数。
- **风险**：类型检查无法作为回归保护，连接状态和 Token 数据的接口变更容易引入运行时问题。
- **后续方向**：先统一 Token 和 WebSocket 状态模型，再清理遗留 store/cache 代码，最后恢复严格类型检查作为 CI 门禁。
- **状态**：未处理。

### 10. ESLint 命令不可用

- **位置**：`package.json` 的 `lint` 脚本、`eslint.config.ts`
- **现状**：`pnpm exec eslint src --ext .vue,.js,.ts` 返回找不到 `eslint` 命令；项目虽然配置了 ESLint，但依赖/脚本链路不完整。
- **风险**：代码风格、未使用变量和部分安全规则无法稳定执行；现有 `lint` 脚本还带有 `--fix`，不适合作为只读 CI 检查。
- **后续方向**：补齐 ESLint CLI 依赖，增加不修改文件的检查脚本，并将 lint 纳入 CI。
- **状态**：未处理。

### 11. 生产构建存在较大的 JavaScript chunk

- **验证结果**：`pnpm run build` 成功，但主 chunk 约 4.7 MB，`GameFeatures` chunk 约 860 KB；构建工具报告超过 500 KB 的 chunk 警告。
- **位置**：`src/views/GameFeatures.vue`、相关协议/功能模块和 Vite 构建配置
- **风险**：首次加载和低带宽环境下的页面响应变慢，缓存更新成本较高。
- **后续方向**：按功能拆分动态导入，配置合理的 Rollup manual chunks，并排查协议与大型功能模块是否被过早打入公共 chunk。
- **状态**：未处理。

## P2：维护与行为一致性

### 12. 批量任务页面职责过重

- **位置**：`src/views/BatchDailyTasks.vue`
- **现状**：单文件同时包含界面、定时调度、多账号编排、连接管理、日志和大量游戏业务策略，文件规模超过 5900 行。
- **风险**：修改影响范围难以判断，测试和代码审查成本高，任务之间容易产生共享状态耦合。
- **后续方向**：按任务编排、连接上下文、调度器、任务注册表和展示组件拆分，优先抽出无 UI 的纯业务模块。
- **状态**：未处理。

### 13. DailyTasks 页面仍包含 Mock 数据和本地缓存逻辑

- **位置**：`src/views/DailyTasks.vue:329`、`src/views/DailyTasks.vue:349`
- **现状**：页面部分任务状态来自 Mock 数据或 `localStorage`，与真实 WebSocket 任务状态并非完全闭环。
- **风险**：用户看到的任务状态可能与服务器实际状态不一致，问题定位也会变困难。
- **后续方向**：明确 Mock 模式和真实模式的边界，统一由任务状态源驱动 UI，并为缓存增加版本和失效策略。
- **状态**：未处理。

### 14. 周几判断误用了位运算符

- **位置**：`src/utils/dailyTaskRunner.js:621-624`
- **现状**：使用 `|` 代替逻辑或 `||` 判断多个星期值。
- **风险**：当前整数条件下可能“碰巧正常”，但语义错误，后续修改条件类型时容易产生隐蔽行为。
- **后续方向**：改为 `includes` 或 `||`，并补充星期边界测试。
- **状态**：未处理。

### 15. 文档描述的 Python 服务在当前仓库中不完整

- **位置**：`README.md:171` 起、`server/`
- **现状**：README 描述了 `server/app.py`、配置文件、用户认证和 Token URL 服务，但当前 `server/` 目录只有 `requirements.txt`。
- **风险**：新开发者无法仅依据 README 启动该服务，部署预期与仓库内容不一致。
- **后续方向**：补齐服务端代码，或从 README 删除未随仓库交付的服务说明，并单独链接真实服务仓库。
- **状态**：未处理。

## 验证记录

验证日期：2026-08-12

- `pnpm install --frozen-lockfile`：成功。
- `node --test test/helperTaskRunner.test.js test/towerClimbLimit.test.js`：15 个测试全部通过。
- `pnpm run build`：成功，但报告自动路由热更新导出、`eval` 和大 chunk 警告；构建同时生成 `dist/_worker.js`。
- `pnpm exec tsc --noEmit -p tsconfig.app.json`：失败，14 个文件共 139 个错误。
- `pnpm exec eslint src --ext .vue,.js,.ts`：失败，找不到 `eslint` 命令。

## 处理约定

- 本文件只记录问题，不代表本次已经修复。
- 修复问题时保留对应条目，补充修复日期、变更说明和验证命令。
- 若问题已被证实不是缺陷，应标记为“已确认不成立”，不要直接删除历史记录。
