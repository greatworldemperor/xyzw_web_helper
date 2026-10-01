# L2 · 认证与 Token

## 1. 核心模型

- **account id = 微信 id / uid**（例 `119532574`）
- **role id = 游戏角色 id**（例 `715582089`）
- 一个账号下多个角色；**稳定身份键 = `serverId:roleId`**（`tokenGroups` / `multiGameTokenGroups` 都按它匹配，界面需要的当前 `token.id` 由 Store 运行时解析）
- 所有导入入口**必须保留 `serverId` 和 `roleId`**。

## 2. 三种登录入口

| 方式 | 页面 | 实现 |
|---|---|---|
| BIN 文件 | `src/views/TokenImport/bin.vue` | 多角色导入；桌面端每页 50 条，支持顺序"全部添加" |
| 微信扫码 | Token 导入页 | 微信登录 / 长轮询代理 |
| 手机号验证码 | `src/views/TokenImport/mobile.vue` + `src/utils/hortorLogin.js` | 发验证码 → 组合登录 → 角色列表 → bin 下载 → 批量导入 |
| 手动 / URL | `TokenImport/index.vue` | Base64 直接粘贴 / 从 API 拉取并可自动刷新 |

**手机号登录细节**（协议研究见 `docs/mobile-phone-login-protocol-research.md`）：
- 链路：`combUser -> bin -> Token`。
- 每个角色生成并持久化**独立登录 bin**（存 IndexedDB），再导入可刷新的 Token。
- **手机号和验证码不持久化**（IndexedDB / localStorage 均不含）。
- 待确认：真实上游是否接受网页生成的 `activeLoginMatchId`；验证码错误/过期/上游限流等失败响应仍待补抓。

## 3. 解析与存储

- BIN 解码得到 `info = {encryptCombUser, timestamp, sign}`；写入 `PlatformManager.instance.encryptUserInfo` → 释放 `authorizeDeferred` → 官方 `LoginManager.instance.login()`。
- `wechat.bin` 历史样本 1628 字节，仅页面内存使用。
- `src/utils/token.ts`：
  - `parseBase64Token()` / `validateToken()` — 支持纯文本 / Base64 / 带前缀(`token:`) / JSON 包装 / bin / URL
  - `transformToken()` — 生成 WS 连接用 `p=` 参数
  - `getStableTokenKey()` — `serverId:roleId`
  - `RateLimiter` — 限流工具

## 4. 🔴 按需刷新策略（核心设计）

**role token 生命周期很短**（分钟级），且**同一账号整批导入会触发 `authuser` 限流（25/min）**。因此：

- BIN / 微信扫码 / 手机号登录 / 配置导入等入口 **不在导入时逐个换取 roleToken**：只落库 BIN，**`token` 字段留空**。
- 首次建连前若 token 为空/无效/过期 → `ensureTokenAvailable()` 用 `resolveRefreshedToken()` 换取一份新的。
- 判定规则：`src/utils/tokenRefreshPolicy.js`（`shouldRefreshTokenOnDemand` / `isBinBackedToken`）；单测 `test/tokenRefreshPolicy.test.js`。
- ⚠️ **"token 字段为空"是合法状态**：
  - **不能用空字符串参与去重**；
  - **不能拿建连前的旧 token 引用去拼战场连接地址**（盐场 `buildLegionWarUrl` 两处均已改为重新取值）。
- 自动刷新统一入口 `attemptTokenRefreshWithResult()`：**10s 冷却**；URL / BIN / 微信扫码 / 手机号四类来源统一处理。
- 批量场景：`ensureConnection` 在**账号切换建连前**主动刷新短生命周期 Role Token；**同一账号 60s 内复用最近刷新结果**；已有旧连接在刷新后关闭重建；超时/初始化恢复不会立即重复刷新。

**`p=` 四字段**：`{roleToken, sessId, connId, isRestore}`，`sessId = 100*now+rand`、`connId = now+rand`。
2026-10-01 修正 `transformToken` 的 `...data` 整体展开 → 收成游戏 SDK 四字段（去掉多塞的 `roleId`），commit `2df6f788`。

## 5. 连接与刷新流程

```
createWebSocketConnection(tokenId)
  → acquireConnectionLock
  → 跨标签页检查(ws_connection_${tokenId})
  → ensureTokenAvailable() → attemptTokenRefreshWithResult()  (需要时)
  → new XyzwWebSocketClient(构建 wss URL，带 p=)
  → init()，挂 10s 握手超时监控
  → onConnect → 发 role_getroleinfo
  → 失败(超时/1006) → 走同一刷新流程 → attemptTokenRefresh
```

- **刷新接口遇限流**：每 1s 重试，直到成功；**不可重试的刷新错误才停账号并保留失败原因**。
- 批量页 `BatchDailyTasks.vue` 的批处理连接失败后：先等旧连接关闭，再刷 token，用最新 token 重连；批处理会**关闭 Store 的握手超时/握手失败自动刷新**，避免后台刷新与批量刷新争用。
- 批量 `role_getroleinfo` 统一走批量页的恢复入口：失败 → 关旧 WSS → 刷新 Token → 用最新 Token 重建 → 重试；恢复耗尽才把异常交回当前账号任务。
- 刷新失败通过 `token:refresh:failed` 事件 → `DefaultLayout.vue` / `TokenImport/index.vue` 弹 Naive 对话框。

## 6. 跨标签页协调

- `ws_connection_${tokenId}` 写 localStorage；**30s 内且 sessionId 不同** ⇒ 视为其他标签页活跃，关闭本地重复连接。
- 锁 10min 清理。

## 7. `src/utils/serverRole.js`

服务器/角色列表获取（`ServerRoleList.vue` 消费）。相关测试 `test/serverRole.test.js`。

## 8. 相关文件/测试

`src/utils/token.ts` · `tokenRefreshPolicy.js` · `tokenDb.js`(IndexedDB) · `hortorLogin.js` · `serverRole.js` · `tokenSort.js`
`src/stores/tokenStore.ts` · `src/views/TokenImport/{index,bin,mobile}.vue`
测试：`tokenRefreshPolicy.test.js` · `hortorLogin.test.js` · `serverRole.test.js` · `worker.test.js`

## 9. 已知问题

- 🔴 Token **明文存 localStorage**（KNOWN_ISSUES P0）。
- `worker.js` 旧微信代理 `Access-Control-Allow-Origin: *`（Hortor 登录路由已收紧）；验证码路由校验手机号并按 IP + 手机号摘要做单实例内存限流。
- 🔴 **会话独占是 `200020` 的头号原因**（不是 bin 类型问题——2026-10-01 17:40 已推翻旧结论）：
  同角色被批量页/游戏客户端占用时，角色命令一律 `200020`。**排障先排"被占用"**。
- ✅ **账号级 bin 完全可用**：`gh_repo/mobile.bin`（账号级，DID `9fd311e9…`）+ 注入 `serverId` → 9767 冒烟通过、
  自动领奖 77/77 成功。所谓"角色级 bin"本质就是「账号 info + serverId」（实测四个不同服的 bin `info` 完全相同）。
  ⚠️ 但 `local-data/login_bin/mobile.bin`（DID `e7d3f629…`）是**另一环境**的 bin，不可混用比较。

## 10. bin → WSS 实测链路（skill `xyzw-bin-test`）

📄 **权威链路文档**：`C:\Users\worldemperor\.workbuddy\skills\xyzw-bin-test\references\pipeline.md`
（批量页路径 vs bin-test 路径逐项对照、行号索引、可执行检查清单）

- **唯一权威实现** = `local-data/bin-test/bin-test.mjs`（项目内，随代码演进）；
  skill 内 `scripts/bin-test.mjs` **只是快照，会漂移** ⇒ 用前 `diff` 比对。
- **两条路径在协议层已等价**：同 authuser、同四字段 `p=`、同 `XyzwWebSocketClient`、同 36 帧进主城序列。
  差异仅 HTTP 头（已证无效）与会话租约（bin-test 无锁，需自行保证独占）。
- 🔴 **角色命令受理双因素**：`role_getroleinfo` 首帧口径 **h5/1.89.8-wx** + **36 帧进主城初始化序列**。
  生产已内建（`xyzwWebSocket.js` L118 注册 body / `tasksGoldenfish.js` L1727 序列）。
- 🔴 **会话独占**：同角色同时只能一个客户端；**每次 authuser 作废同账号旧会话** ⇒ 实测前必须问 master 该号是否在跑。
- 🔴 **运行命令必须带 `--import ./local-data/_alias_loader.mjs`**（否则裸 node 解析不了 `@/` 别名直接崩）。
- ✅ **2026-10-01 实测通过**（`fresh-28a-0.bin` / 内部 9755，只读冒烟）：authuser 200 → WSS → `role_getroleinfo` 成功返 role 数据。
- ⚠️ 实测中修掉 `bin-test.mjs` 的**双连接 bug**（末尾 `connect().then(main)` + main 内 `connect()` 各建一条会话 ⇒ 同 token 互相踢 `close 1006`，疑为"频繁重连触发风控"来源之一）。
