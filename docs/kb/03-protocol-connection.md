# L1 · 协议与连接

> 红线：**永远不要手写 BON 解码器**，只用 `src/utils/bonProtocol.js`（解码工具的底层也必须是它）。

## 1. 帧格式与 BON

**帧**：`70 78` + 2 字节 key material + XOR 数据段；key 从第 3/4 字节隔 2 位取 1 位拼出；加密**保留原 4 字节头**。

帧头种类（自动识别）：`70 6c`(pl) / `70 78`(px) / `70 74`(pt)，另有透传。
- `px` 帧：**先 XOR 去头再 BON 解码**，不能直接调 `lz4XorDecode`。
- `pl` 帧：走 LZ4/XOR 解码。

**BON tag**：`0`null · `1`int · `2`long · `3`float · `4`double · `5`string · `6`bool · `7`bytes · `8`object · `9`array · `10`date · `99`stringRef。

**加密方案**：`lx`=LZ4+头掩码 · `x`=随机4字节+XOR · `xtm`=XXTEA；`getEnc("auto")` 自动检测。

**已踩过的坑**：
- 手写解码器遇 `double` 会错位 ⇒ 假结论"字段不存在"。
- `payload.decoded.body` 只是摘要，不可直接用；body 常是**嵌套 BON bytes，要再解一层**。
- `>6003` 字节的大帧会被截断。
- `BonEncoder.getBytes()` 默认返回**共享视图**，需要独立副本时用 `getBytes(true)`。
- 解密入口：`getEnc('auto').decrypt(rawHex)`。
- `Number(null) === 0` —— 已踩 3 次，可选数值必须**显式判空**。

## 2. `src/utils/bonProtocol.js` API

- `DataReader` / `DataWriter`
- `BonEncoder` / `BonDecoder`；单例 `bon.encode()` / `bon.decode()`
- `ProtoMsg`（`cmd` 小写；`rawData` 惰性 decode）/ `ProtoMsgLegion`
- `getEnc("lx"|"x"|"xtm"|"auto")`
- `g_utils.encode()` / `g_utils.parse()` + 游戏消息模板

## 3. `src/utils/xyzwWebSocket.js`（WS 客户端）

- `CommandRegistry.register(cmd, body, {rawBody})`：**未注册的 cmd 直接抛 `Unknown cmd`**（发不出去 → 只能超时）。
- `send()`：入队，统一分配 `seq`，发送即忘。
- `sendWithPromise(cmd, params, timeout=8000)`：以 `++seq` 为 key。
  **响应匹配：优先 `packet.resp === seq`**；兜底 `responseToCommandMap`（命令名映射，含一对多、`syncresp`/`syncrewardresp`）。**漏映射 ⇒ Promise 超时**。
- `reconnect()`：有 `isReconnecting` 防抖；`debounceSend` 会缓存 `role_getroleinfo`。
- 心跳：onConnect 后 3s 首心跳，`heartbeatMs=5000`，`seq=0` / `cmd=_sys/ack`。
- 默认地址形态：`wss://xxz-xyzw.hortorgames.com/agent?p=<encoded-token>&e=x&lang=chinese`

**`p=` 参数（重要）**：游戏 SDK(`src/xyzw/index.js` `_connParam`)固定**四字段** `{roleToken, sessId, connId, isRestore}`；
批量页历史实现曾用 `...data` 整体展开导致**多塞 `roleId`**（=uid），2026-10-01 已修为四字段（commit `2df6f788`）。游戏原生客户端**从不发送 roleId**。
`sessId = 100*now+rand`、`connId = now+rand`，与游戏 SDK 源码一致。

## 4. 连接管理

### tokenStore.createWebSocketConnection
建连全流程：**连接锁 → 跨标签页协调 → 按需刷新 token → 握手超时监控 → 挂监听 → init**。默认监控 **10s 握手超时**，1006 握手失败也走同一刷新流程。

- `acquireConnectionLock(tokenId, op)` / `releaseConnectionLock()`：键 `${tokenId}_${op}`，10s 超时，**必须配对释放**。
- 跨标签页：`ws_connection_${tokenId}` 写 localStorage，30s 内且 sessionId 不同 ⇒ 视为他页活跃，关掉本地重复连接。
- `ensureTokenAvailable()`：建连前若 token 为空/无效/过期**且有可刷新来源(BIN/URL)**才刷新；**不预取**。
- `attemptTokenRefreshWithResult()`：唯一刷新实现，**10s 冷却**。刷新接口遇限流每 1s 重试直到成功。
- 刷新失败经 `token:refresh:failed` 事件通知 UI（`DefaultLayout.vue` / `TokenImport/index.vue` 弹 Naive 对话框）。

### connectionManager（批量连接池）
- `connectionQueue.active < maxActive` 限流；等槽 → 建连 → `waitForConnection` 轮询 → 失败 close+重连。
- 建连成功后**顺序发前奏**：`role_getroleinfo` + `fight_startlevel`，由 `res.battleData.version` 调 `setBattleVersion`。
  （战斗类命令依赖 `battleVersion`，必须先有此前奏。）
- 槽位保持到任务完成才 `closeConnection` 释放。

### 限流
- 限流码：`400340` / `400312` / `200400` / `12400000` / `429` / 文本"操作过快/限流"。
- `400340` 由 `tokenStore` 统一控制器处理：**弹窗 + 每 5s 重试 + 15 分钟上限**；批量层平时收不到。
- IP 额度**各命令独立**（开箱/招募 ~180 帧、钓鱼 >200 帧，冷却 ≤5 分钟）：**不预判不闸门**，撞到就交统一弹窗自愈。

### 连接失败重试（任务级，2026-09-29 定稿）
口径：**除 token 明确无效、服务器明确业务拒绝外，连接失败类（无响应/断连/断网）都应重试，不判死账号**（master 批量跑批频繁切 IP，断网是常态）。
| 类别 | 判定 | 策略 |
|---|---|---|
| ① 发送前失败 | "WebSocket未连接" / "连接已关闭"（帧未发出，**零双执行风险**） | 重建连接 → **3 次 × 5s** |
| ② 请求超时 | "请求超时"（帧可能已执行，**有双执行风险**） | 重建连接 → **1 次 × 3s** |
| ③ 业务拒绝 / token 无效 | 业务错误码 | **不重试**，照旧失败 |
| ④ 限流 400340 | — | tokenStore 内部自愈 |

实现：`helperTaskRunner.js` 的 `isOfflineSendError` / `isTimeoutError` / `isConnectionError` / `runWithConnectionRetry`（任务级）/ `wrapTokenStoreWithConnectionRetry`（帧层 Proxy + reconnect 回调）；
`BatchDailyTasks.vue` 注入 `guardedTokenStore`（reconnect = `createWebSocketConnection`，自带连接锁）；
金鱼 `runGoldenfish` 有 per-step 第二层重跑 + 重建连接。日志格式：`⏱️ xx cmd 连接断开/请求超时，自动重试（n/N）`。

## 5. 多开 Runtime

- `src/utils/gameLauncher.js`：读 active launch → 构造 `game/multi-game.html?scope=mg-xxx&bin_id=` iframe → postMessage 握手（校验 origin / scope / version）。
- `src/utils/multiGameSyncPlan.js`：**纯计算**。三模式 `none`(默认) / `group` / `global`。
  同步源**两级**：手动指定窗口（点标题）> 第一分组的组长。
- **隔离**：每账号独立 localStorage 前缀 `multi-game:${scopeId}:`；BIN 经 `convertBinToLx` 注入；开关随 sessionStorage manifest。
- 相关页面：`src/views/GameMultiPlayer.vue`（多开网格）、`GamePlayer.vue`（单开）。

## 6. 平台伪装 / 3000070

`public/game/first-frame-spoof.js`：hook `WebSocket.prototype.send`，对 `px` 帧**就地字节改写**（解析 BON，只换 tag5 字符串并自内向外修正 tag7 长度）。
- 默认把 `role_getroleinfo` 的 `platformExt`→`mix`、`clientVersion`→`2.21.2-...`。
- 开关：`localStorage.xyzwFrameSpoof`（单开）/ `xyzwMultiGameFrameSpoof`（多开）；支持 `observeOnly`。
- **现状**：缺省 `enabled=false`（零干预的归因/实验工具），宿主 API `window.__xyzwFrameSpoof`。
- `platform-spoof.js` 改全局 PLATFORM：网页端仅 `h5`/`h5web` 可登录；`mix` 口径走轻量客户端，**二者不混用**。
- **3000070**：只有盐场 PVP `war_startbattle` 触发；`war_enterbattlefield` / `setbattleteam` / `invitejointeam` / `startmarch` / `speedup` 均成功 ⇒ 非"h5 平台整体禁用"。待验证 `first-frame-spoof` 改口径后 PVP 是否恢复（**仅在将来需要攻击时才做**）。
  详见 `activity-saltfield.md`。

## 7. 认证与 Token

见 `module-auth-token.md`。

## 8. 本节红线

1. 永远不要手写 BON 解码器。
2. 未在 `CommandRegistry` 注册的 cmd 发不出去 → 必先 `register`。
3. 响应匹配靠 `resp === seq`，命令名不一致的必须补 `responseToCommandMap`。
4. 战斗命令依赖 `battleVersion`，须先经 `fight_startlevel` 初始化。
5. 建连必须走 `tokenStore`（锁/跨标签/刷新），勿直接 `new WebSocket`。
6. role token 短命：导入只落 BIN/URL，**建连时按需刷新，不预取不落库**。
7. 多开存储必须带 `scopeId` 前缀，串号即事故。
8. 被动桥 hook 的 `ws:open` URL **会丢 query**（曾产生"裸 agent"假象）——握手层结论**以 DevTools 为准**。
