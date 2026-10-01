# bin → WSS 通讯全链路（批量页路径 vs bin-test 路径）

> 本文是「从 bin 文件到建立有效 WSS 连接并通讯」的权威说明。
> 结论先给：**两条路径在协议层已等价**（同 authuser、同四字段 `p=`、同 `XyzwWebSocketClient`、同 36 帧进主城序列），
> 差异只剩「HTTP 请求头」和「会话租约」，均已验证不影响角色命令受理。
> ⚠️ 核查日期 2026-10-01；如源码变动请重新对照行号。

---

## 0. TL;DR 数据流

```
bin 文件
  │ g_utils.parse → _raw（角色级 serverId≠null / 账号级 serverId=null）
  ▼
[账号级] POST /login/serverlist  → roles{serverId:{roleId,name,loginAt}}
         → 选 serverId → g_utils.encode({..._raw, serverId}, "lx")  = roleBin
[角色级] roleBin = binBytes
  ▼
POST /login/authuser  (Content-Type: application/octet-stream, body=roleBin)
  → { roleToken, roleId(=账号uid，不是角色 roleId) }
  ▼
p= = JSON.stringify({ roleToken, sessId: now*100+rand, connId: now+rand, isRestore: 0 })   ← 必须四字段
  ▼
wss://xxz-xyzw.hortorgames.com/agent?p=<encodeURIComponent(p)>&e=x&lang=chinese
  ▼
XyzwWebSocketClient.init() → onopen → 心跳(5s, seq=0, cmd=_sys/ack)
  ▼
sendWithPromise(cmd, params) → CommandRegistry.build → BON encode + 加密 → send
  ← onmessage → utils.parse(evt.data,"auto") → 按 packet.resp === seq 匹配（兜底 responseToCommandMap）
  ▼
【角色命令受理前提】首帧口径 h5/1.89.8-wx + 36 帧进主城初始化序列（见 §4）
```

---

## 1. 批量页建连链路（权威路径）

### 1.1 调用入口
按钮 → `createTaskDeps().ensureConnection`（`src/views/BatchDailyTasks.vue`，`tasksItem` 解构得到）
自由模板上下文里换成 `coordinator.ensureConnection`（共享连接协调器）。

### 1.2 `src/utils/batch/connectionManager.js` → `ensureConnection`（L57–152）
1. `waitForConnectionSlot()` —— `connectionQueue.active < batchSettings.maxActive` 才放行（默认 `maxActive=2`），`active++`。
2. `tokenStore.getWebSocketStatus(tokenId) === "connected"` → 跳过建连。
3. 否则 `tokenStore.createWebSocketConnection(tokenId, latestToken.token, latestToken.wsUrl)`。
4. `waitForConnection(tokenId)` —— **每 500ms 轮询** `getWebSocketStatus`，直到 `connected` 或 `connectionTimeout`。
5. 超时且 `maxRetries>0`（默认 2）→ `closeWebSocketConnection` → 等 `reconnectDelay` → 重新 `createWebSocketConnection`。
6. 仍失败 → `throw new Error("连接失败 (重试后仍超时)")`（**槽位不释放，由调用方 finally 释放**）。
7. ✅ 成功后发**前奏**（顺序、各 5s 超时）：
   ```js
   await sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 5000);
   const res = await sendMessageWithPromise(tokenId, "fight_startlevel", {}, 5000);
   if (res?.battleData?.version) tokenStore.setBattleVersion(res.battleData.version);
   ```
   前奏失败会 **throw**（`初始化数据失败`）——这是 ⑨ 个失败分档里「业务拒绝不重试、连接类才重试」的输入。
8. 槽位保持占用直到任务结束 `closeConnection(tokenId, name)` → `closeWebSocketConnection` + `releaseConnectionSlot()`。

### 1.3 `src/stores/tokenStore.ts` → `createWebSocketConnection`（L1000 起）
| 步 | 动作 | 关键点 |
|---|---|---|
| 1 | `acquireConnectionLock(tokenId, "connect")` | 键 `${tokenId}_connect`，**10s 超时**，必须配对释放 |
| 2 | `checkCrossTabConnection(tokenId)` | `ws_connection_${tokenId}`(localStorage)，30s 内且 sessionId 不同 ⇒ 直接 `return null`（跳过建连） |
| 3 | `updateCrossTabConnectionState(tokenId,"connecting")` | 供其它标签页避让 |
| 4 | 已有连接 → `closeWebSocketConnectionAsync(tokenId)` | 优雅关闭，自带防竞态 |
| 5 | `validateToken(effectiveToken)` 失败 → `ensureTokenAvailable(tokenId)`（L695） | **按需刷新**：不预取 |
| 6 | `parseBase64Token(effectiveToken)` → `actualToken` | 无效且刷新失败 → 抛「Token 为空或已失效…请重新导入 BIN」 |
| 7 | `wsUrl = wss://xxz-xyzw.hortorgames.com/agent?p=${encodeURIComponent(actualToken)}&e=x&lang=chinese` | `customWsUrl` 优先 |
| 8 | `pushConnectionDiag({kind:"ws.connect", wsUrl, actualToken})` | **诊断导出用**，`actualToken` 就是可直接复用的 token |
| 9 | `new XyzwWebSocketClient({url, utils:g_utils, heartbeatMs:5000})` | 构造**不自动连** |
| 10 | 包装 `sendWithPromise` 录制 `ws.send`/`ws.resp`/`ws.resp.err` | 开关关时**直通零开销** |
| 11 | `wsConnections.value[tokenId] = {client, status:"connecting", ...}` | 状态机入口 |
| 12 | `monitorTimeout !== false` → **10s 握手超时定时器** | 超时 → `attemptTokenRefresh(tokenId, true)`；失败则关闭连接 |

### 1.4 bin → roleToken：`ensureTokenAvailable` → `resolveRefreshedToken` → `transformToken`
- `shouldRefreshTokenOnDemand(gameToken)`（`src/utils/tokenRefreshPolicy.js`）判定是否可刷（BIN/URL 来源且 token 空/失效）。
- `src/utils/token.ts` `transformToken`（L132）—— 与 bin-test 手写 fetch **等价**：
  ```
  POST https://xxz-xyzw.hortorgames.com/login/authuser?_seq=1
  headers: { "Content-Type": "application/octet-stream", referrerPolicy: "no-referrer" }
  responseType: arraybuffer
  → g_utils.parse(res.data).getData().roleToken
  → JSON.stringify({ roleToken, sessId: now*100+rand, connId: now+rand, isRestore: 0 })   ← 🔴 四字段
  ```
- 🔴 **历史 bug（已修，commit `2df6f788`）**：旧实现用 `...data` 整体展开，把 authuser 响应里的 `roleId`(=账号 uid)
  也塞进 `p=` —— 这是批量页与游戏本体会话在握手 URL 上的**唯一差异**。游戏 SDK（`src/xyzw/index.js` `_connParam`）从不发 `roleId`。

### 1.5 `src/utils/xyzwWebSocket.js`
- `registerDefaultCommands(reg)`（L110）：`role_getroleinfo` 注册 body = `{clientVersion:"1.89.8-wx", inviteUid:0, platform:"hortor", platformExt:"h5", scene:""}`（L118–124，**仅此帧带**，无 3000070 污染）。
- `XyzwWebSocketClient` 构造（L465）：`registry = registerDefaultCommands(new CommandRegistry(...))`；**构造函数不自动连**。
- `init()`（L499）：`new WebSocket(url)` → `onopen` 里 `connected=true` + `_setupHeartbeat()` + `_processQueueLoop()` + `onConnect()`。
- `onmessage`（L514）：字符串 → `JSON.parse`；`ArrayBuffer` → `utils.parse(data, "auto")`（自动识别 `70 6c/70 78/70 74` + 解密）。
- 心跳：`heartbeatMs=5000`，`seq=0`，`cmd="_sys/ack"`。
- `sendWithPromise`：`registry.build` → 加密 → `send`；**响应按 `packet.resp === seq` 匹配**，兜底 `responseToCommandMap`（L1081 起，`role_getroleinforesp: "role_getroleinfo"` 等）。
- `reconnect()`（L781）：`isReconnecting` 防抖。

---

## 2. bin-test 链路（`local-data/bin-test/bin-test.mjs`）

```
1. readFileSync(bin) → g_utils.parse → _raw       [L87-93]
2. isRoleBin = _raw.serverId != null
   账号级 && 无 --server → POST /login/serverlist?_seq=3 → roles → 选 loginAt 最旧(--auto)   [L99-125]
3. roleBin = isRoleBin ? binBytes : g_utils.encode({..._raw, serverId}, "lx")   [L132-135]
4. POST /login/authuser?_seq=1  (Content-Type: application/octet-stream, +BROWSER_HEADERS)   [L138-142]
5. wsToken = { roleToken, sessId, connId, isRestore:0 }  ← 与生产 transformToken 同构   [L159-165]
6. connect(): new XyzwWebSocketClient({url, utils:g_utils, heartbeatMs:5000}); ws.onConnect=...; ws.init()   [L195-224]
7. 冒烟 role_getroleinfo ×最多6次(间隔2s) → activity_get   [L378-399]
8. run 模式分发：smoke / claim / claimone:<id> / commands:<file> / pipeline
```

**bin-test 特有的三种模式**：
- `--run claim`：先 `runInitSequence()`（读 `local-data/goldenfish/init-commands.json`，36 帧，间隔 `--initdelay`，默认 250ms）再 `tasks.goldenfishClaimProgressRewards()`。
- `--run claimone:<missionId>`：单发 `activity_claimtaskreward {activityId:2609251, missionId}` + 随后 `activity_get` **探测会话是否被打挂**。
- `DIAG_FILE=<jsonl>`：跳过 authuser，直接用批量页导出的 `ws.connect.actualToken` 连接（对比「同 token 浏览器通/Node 不通」）。
- `--run pipeline [--skipclear] [--skipupgrade]`：金鱼七步全流程（**真实消耗**）。

**它复用的生产代码**（这是"生产等价"的保证）：
- `XyzwWebSocketClient`（`src/utils/xyzwWebSocket.js`）—— 信封/加密/resp 匹配/心跳逐字节一致
- `g_utils`（`src/utils/bonProtocol.js`）—— BIN 解析与编解码
- `createTasksGoldenfish(...)`（`src/utils/batch/tasksGoldenfish.js`）—— 业务步骤，注入 tokenStore 适配器
- 入站包日志 hook `ws.socket.onmessage`，打印 `resp/cmd/code/error`

---

## 3. 两条路径逐项对照

| 项 | 批量页 | bin-test | 是否等价 |
|---|---|---|---|
| BIN 解析 | `parseBase64Token` / `resolveRefreshedToken` | `g_utils.parse` + `g_utils.encode` | ✅ |
| 账号级 bin 注入 serverId | 由 serverlist 环节（UI）决定 | `{..._raw, serverId}, "lx"` | ✅ |
| authuser | `transformToken`（axios） | 手写 `fetch` | ✅（同 URL/方法/Content-Type） |
| HTTP 头 | `referrerPolicy: "no-referrer"` | `+Origin/Referer/UA` | ⚠️ 不等价，**已证无效** |
| `p=` 字段 | 4 字段（`2df6f788` 后） | 4 字段 | ✅ |
| 首帧口径 | 生产注册 body = **`h5/1.89.8-wx`**（`ceb1dcf` 后） | 同（复用生产 registry） | ✅ **已对齐** |
| 36 帧进主城序列 | `GOLDENFISH_ENTER_GAME_SEQUENCE` 前置到 claim | `runInitSequence()` | ✅ 命令序列**完全一致**（已逐帧 diff） |
| WS 客户端 | `XyzwWebSocketClient` | 同 | ✅ |
| 连接前奏 | `role_getroleinfo + fight_startlevel` | 仅冒烟 `role_getroleinfo` | ⚠️ 轻微差异（bin-test 不拉 battleVersion） |
| 会话租约/闸门 | `goldenfishRunActive` + localStorage 租约(5min TTL) | 无 | ⚠️ bin-test 无锁（要自己保证独占） |
| 多开隔离 | iframe + `multi-game:${scopeId}:` | 无 | — |
| 自动重连/重试 | `wrapTokenStoreWithConnectionRetry` 分档 | `sendLimited` 仅限流 5s×7 | ⚠️ bin-test 弱一些 |

### ⚠️ 核查中发现的两个「文档/代码不一致」
1. **`ROLE_DEFAULTS` 是死常量**：`bin-test.mjs` L71–77 定义了 `{clientVersion:"2.21.2-…", platformExt:"mix"}`，但**全文件无人引用**。
   实际生效的是生产 registry 的 `h5/1.89.8-wx` ⇒ 现在 `--firstframe game` 已是**冗余开关**（两者取值相同）。
   建议：删掉 `ROLE_DEFAULTS` 或让它真正参与，避免下次误判口径。
2. **`role_backclaimreward` 不是最后一帧**：生产注释（`tasksGoldenfish.js` L1723）与 bin-test 注释都写「末帧/最后一帧」，
   实测它是 **36 帧里的第 31 帧**（其后还有 friend_*/pkroom_* 5 帧）。功能无误，但注释误导。

---

## 4. 🔴 角色命令受理的前置（claim 挂死的根因）

`activity_claimtaskreward` 在批量页/authuser 会话下曾**静默无响应**。ROOT CAUSE（2026-10-01 定案，commit `ceb1dcf3`）：

```
受理 = ① 首帧口径对齐游戏本体（role_getroleinfo → h5 / 1.89.8-wx / scene:""）
     + ② 进主城初始化序列（36 帧，含 role_backclaimreward 进城结算标记）
     两者缺一不可
```

- 实证：E4（9754 成功）/ E7（9755 干净号复刻，实领 5287×8 入账）/ E9（9756，initdelay=0）/ E10（9757，业务码 `3200020`「奖励已领取」= 受理正常）。
- 反例：只发 firstframe 不发 init（E2/E3）→ 仍断线 1006。
- 业务码 **`3200020` = 奖励已领取**（正常业务拒绝，不是失败）。

---

## 5. 会话独占 / 冷却（最常见的"打不通"原因）

1. **同一角色同时只能有一个客户端**（批量页 / 游戏客户端 / bin-test 三者互斥）。被占用时角色命令返回 `200020`（空 hint）。
2. **每次 authuser 会作废同账号的旧会话** ⇒ 实测期间**不要**在批量页触发该账号的 Token 刷新。
3. **频繁重连触发服务端会话冷却**（`200020` 泛滥、数分钟自愈）：init 序列帧间隔别用 0ms（生产版 0ms 曾挂死，E9 单变量复现）。
   批量重跑间隔也别太激进（3s 过激）。
4. `200020` 的其它来源：非当天 `oppoMap` 键（营地）、账号级 bin 签出的 token（见 §6）。

**诊断优先级**：先确认目标号「没有」在批量页运行、也没有游戏客户端在线，再跑。

---

## 6. 已知未解（2026-10-01 15:38 存档）

| 问题 | 状态 | 下一步 |
|---|---|---|
| `mobile.bin`/`wechat.bin`（**账号级** bin）注入 serverId 后 authuser **成功**（返回 `{roleToken, roleId=uid}`），但该 token 建的 WS 会话**所有角色命令 200020** | 未解 | 怀疑 mobile→web 网关缺「二次换签/选服」环节；待抓多开窗口原生登录 HTTP 全序列（`captureHttp=true`）对比 authuser→WS 之间是否还有请求 |
| rolebin 9754–9757 被当天反复测试后也打不进（200020 / 全帧入队） | 疑会话残留 | 换干净时段重试；master 明确「无长冷却」（游戏客户端连着做没问题） |
| 生产 28a claim 第 4 帧 `role_getfirstmonthdate` 挂死 8000ms（非 200020 非业务码） | 疑多开窗口会话冲突 | 换干净号在批量页重测 |
| `--firstframe game` 冗余、`ROLE_DEFAULTS` 死常量 | 代码整洁 | 见 §3 的两条 |

---

## 7. 打通检查清单（照做即可）

🔴 **必须带 `--import ./local-data/_alias_loader.mjs`**（否则裸 node 解析不了 `@/` 别名，直接 `ERR_MODULE_NOT_FOUND`）。
该 loader 做三件事：`@/` 别名解析、TS strip、补 `window/localStorage/sessionStorage/import.meta.env` 垫片。

```bash
cd /d/my_projects/xyzw/gh_repo/xyzw_web_helper_kai
NODE="C:/Users/worldemperor/.workbuddy/binaries/node/versions/22.22.2-5/node.exe"
RUN() { "$NODE" --import ./local-data/_alias_loader.mjs local-data/bin-test/bin-test.mjs "$@"; }

# 0) 先问 master：目标号有没有在批量页跑 / 游戏客户端在线（authuser 会作废同账号旧会话）
# 1) 冒烟：bin → authuser → WSS → role_getroleinfo + activity_get（不消耗资源）
RUN --bin <bin> [--server <内部id>] [--auto]

# 2) 只读金鱼进度（确认会话可读）
RUN --bin <bin> --server <内部id> --run commands:<文件>

# 3) claim 单发诊断（会自动前置 36 帧 init）
RUN --bin <bin> --server <内部id> --run claimone:52

# 4) 全流程（⚠️ 真实消耗，需 master 授权）
RUN --bin <bin> --server <内部id> --run pipeline
```

**判据**：
- 步骤 1 打出 `冒烟 role_getroleinfo #n: 成功（含 role 数据）` ⇒ **bin → WSS 全链路已通**。
- `activity_get: code=undefined` 是**正常**输出（成功响应不带 `code` 字段）；若超时才是异常。
- 若持续 `200020` ⇒ 先排除 §5（会话独占/冷却），再排查是否是**账号级 bin**（§6）。
- 步骤 3 有任何响应（哪怕 `3200020`）⇒ claim 通道打通；挂死 ⇒ 未打通。

---

## 7.5 ✅ 实跑验证记录

| 日期 | 目标 | 命令 | 结果 |
|---|---|---|---|
| 2026-10-01 16:27 | `goldenfish/rolebins/fresh-28a-0.bin`（28a，显示服 9728 / 内部 9755） | `RUN --bin …`（smoke） | ✅ `role_getroleinfo #1 成功（含 role 数据）`；authuser 200 / 287B；`activity_get: code=undefined`（正常） |
| 2026-10-01 17:41 | `gh_repo/mobile.bin` + `--server 9767`（**账号级 bin 注入 serverId**，角色 40a） | `RUN --bin … --server 9767`（smoke） | ✅ 冒烟通过 ⇒ **账号级 bin 完全可用**（推翻旧结论） |
| 2026-10-01 17:42 | 同上 | `RUN … --run claim` | 🎉 **自动领取成功：77/77 轮全部入账**（init 29/36，21 秒） |

**打通所需的最终修复**（`src/utils/xyzwWebSocket.js`，见 §3 缺口）：
1. 补注册 `activity_claimtaskreward`（此前**从未注册**）；
2. 补注册 init 序列缺失的 19 帧（含 `role_backclaimreward`），覆盖率 17/36 → **36/36**；
3. 响应映射 `activity_rewardresp` 改为 `["activity_claimsignreward","activity_claimtaskreward"]`。

**本次顺带修掉一个真缺陷**：`bin-test.mjs` 曾**双连接**——模块末尾 `connect().then(main)` 已建一条会话，
`main()` 内又 `await connect()` 建第二条；同一 token 两条 WS 会话互相踢（服务端 `close 1006`），
并可能成为"频繁重连触发风控"的来源。
修复后复跑：**只剩一次 `onConnect` + 一次 `[socket] open`，不再出现 `close 1006`**。

---

## 8. 关键文件 / 行号索引（2026-10-01 快照）

| 文件 | 位置 | 内容 |
|---|---|---|
| `src/utils/batch/connectionManager.js` | L57–152 | `ensureConnection`（租约+前奏） |
| `src/stores/tokenStore.ts` | L695 / L1000 | `ensureTokenAvailable` / `createWebSocketConnection` |
| `src/utils/token.ts` | L132 | `transformToken`（bin → 四字段 `p=`） |
| `src/utils/tokenRefreshPolicy.js` | — | `shouldRefreshTokenOnDemand` |
| `src/utils/xyzwWebSocket.js` | L110–124 / L465 / L499 / L781 / L1081 | 注册表 / 构造 / `init` / `reconnect` / 响应映射 |
| `src/utils/bonProtocol.js` | — | `g_utils.parse/encode`、`getEnc("auto")` |
| `src/utils/batch/tasksGoldenfish.js` | L1727 / L1766 / L1786 | init 序列 / `runEnterGameSequence` / claim 步骤 |
| `local-data/bin-test/bin-test.mjs` | L195 / L294 / L301 / L366 | `connect` / `main` / `runInitSequence` / claim 模式 |
| `local-data/goldenfish/init-commands.json` | 36 项 | 进主城初始化序列（与生产逐帧一致） |
| `local-data/_alias_loader.mjs` | — | 裸 node 的 `@/` 别名 + TS strip + 浏览器垫片 |
