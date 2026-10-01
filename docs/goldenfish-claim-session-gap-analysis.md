# 金鱼进度奖 `activity_claimtaskreward`：批量页会话缺口分析

> 2026-10-01。目标：搞清「批量页（轻量 WS 客户端）差什么信息」，为下次金鱼活动的全自动领奖铺路。
> 核心论点（master）：发包收包本质相同，批量页不存在物理障碍——缺的是会话要素，可以补齐。

## 1. 结论摘要

1. 领奖失败**不是**业务拒绝（无错误码）、**不是**断线（批量页场景连接保持）、而是**静默无响应**（挂死到超时）——特征指向请求在网关/路由层被丢弃，即**会话资格**问题，不是请求体问题（activityId 已补齐后依旧）。
2. 不是笼统的「写命令被禁」：批量页同会话内 `item_openbox` / `hero_recruit` / `artifact_lottery` / `fight_startlevel` / 邮件领取等**写命令全部成功**，唯独 `activity_claimtaskreward` 不响应。
3. 成功样本与失败样本是**同一个 token（21a，1901c3e74e77e9a5512d8ecbbebb3b7b）在 2 分钟内的 A/B 测试**，服务端对两会话的登录来源标记**完全一致**（`loginPlatform:"hortor-mix"`、`userLoginType:"app-mobile"`、`gameTp:"app"`）——登录来源不是差异，差异在**会话建立方式**。
4. 最大黑盒：成功会话用**裸 `wss://xxz-xyzw.hortorgames.com/agent`（无 p= 参数）**、首帧 body 亦无凭据字段、首帧 `role_getroleinfo` 直接成功 ⇒ 鉴权凭据在 **WS HTTP 握手层（疑似 Cookie）**，runtime 被动桥抓不到握手头。**用 DevTools 抓一次 WS 握手 request headers 即可实锤/排除（零成本）。**

## 2. 对照实验证据（2026-09-30，同 token，间隔 2 分钟）

### 失败样本：批量页（`21a_fail_wss-diag-2026-09-30T05-46-28.jsonl`）

```
05:46:22  refresh.req   → authuser 刷新
05:46:22  refresh.token {roleToken, roleId:249954438(=uid), sessId, connId, isRestore:0}
05:46:22  ws.connect    wss://xxz-xyzw.hortorgames.com/agent?p={...}&e=x&lang=chinese
05:46:22  role_getroleinfo            ✓ 111ms（role 完整返回，authed:true）
05:46:23  fight_startlevel            ✓  90ms
05:46:23  activity_get ×4             ✓ 113~200ms
05:46:23  activity_claimtaskreward
          {activityId:2609251, missionId:1}   ✗ 无响应——录制到此为止
```

### 成功样本：推关研究页的游戏本体（`21a_success_xyzw-runtime-wss-...jsonl`）

```
05:47:48  ws:open   wss://xxz-xyzw.hortorgames.com/agent   （裸 URL，无 p=）
05:47:48  role_getroleinfo  ✓（首帧 seq=1，body 无凭据字段）
05:47:48~52  进主城初始化 30+ 命令（system_getdatabundlever / queue / apex / club /
             store / mail / legion / collection / pkroom / friend / ...）
05:47:50  fight_startlevel           ✓
05:47:51  system_custom              ✓
05:47:53  role_backclaimreward       ✓ SyncRewardResp
05:47:59~05:48:10  activity_claimtaskreward ×6   ✓ 全部 Activity_RewardResp（~60ms/帧）
          {activityId:2609251, missionId: 1, 21, 41, 64, 81, 2}
```

第三份样本：21号战士真机领奖抓包（`goldenfish_claimProgressRewards.jsonl`，同为推关页游戏本体）
——同样裸 agent + 完整进主城后领奖成功，且领奖前发过 `role_backclaimreward`。

## 3. 差异矩阵

> ⚠️ **2026-10-01 11:0x 修正（master 用 27c 抓 DevTools 握手）**：游戏本体的连接**也带 `p=` 参数**！
> 被动桥记录的 `ws:open` URL「裸 agent」**不完整**（hook 记录丢 query），DevTools 才是权威。
> URL 层面两边几乎一致（`agent?p={...}&e=x&lang=chinese`），真实差异收窄到下方 #1/#2。

### 3.1 URL 层（已实锤，27c DevTools 抓包）

27c 游戏本体握手 URL 解码：

```json
p = {"roleToken":"XuPo8tPU...sR1c=","sessId":179082337460036,"connId":1790823374603,"isRestore":0}
```

游戏 SDK 源码（`src/xyzw/index.js:8040-8107`，连接参数全集）：

```js
_connParam = { roleToken, sessId: 100*Date.now()+~~(100*Math.random()), connId: 0, isRestore: 0 }
// tryConnect: connId = Date.now(); url = _url + "?p=" + enc(JSON) + "&e=" + encoding
//   isRestore 时加 &ack=...；Ye 映射表补 lang 等参数；重连第 2 次起加 &perMessageDeflate=0
```

| # | 维度 | 批量页（claim 挂死） | 游戏本体会话（claim 成功） | 判定 |
|---|---|---|---|---|
| 1 | p= 字段集 | `{roleToken, **roleId**, sessId, connId, isRestore}`（`token.ts transformToken` 的 `...data` 把 authuser 响应整个展开，roleId=uid 被塞进连接参数） | `{roleToken, sessId, connId, isRestore}`（游戏 SDK `_connParam` 固定四字段，**无 roleId**） | 🔴 **新实锤差异**：批量页多塞 `roleId`；服务端是否因此区分会话类型待验证（实验 F：去掉 roleId） |
| 2 | 握手 Request Headers（Cookie 等） | 未抓 | 未抓 | 🔴 最后黑盒，需 DevTools 该连接的 Request Headers |
| 3 | roleToken 来源 | `POST /login/authuser`（bin body，axios） | 同一接口同一 bin（LoginService.authUser 重放 bin 里的 authuser 请求） | 🟡 理论同质；除非服务端按 HTTP 请求指纹发不同 scope 的 token |
| 4 | 首帧 body | `{clientVersion:"2.21.2-…-wx", inviteUid:0, platform:"hortor", platformExt:"mix"}` | `{platform:"hortor", platformExt:"h5", inviteUid:0, clientVersion:"1.89.8-wx", scene:""}` | 🟡 同会话内 activity_get 通 ⇒ 非单独决定因素 |
| 5 | WS 内进主城初始化 | 无（查完直接做业务） | 30+ 初始化命令（含 `system_getdatabundlever`、`system_custom`、`role_backclaimreward`）后才做业务 | 🟡 两次成功会话 claim 前都发过 `role_backclaimreward` |
| 6 | 服务端登录来源标记 | `hortor-mix / app-mobile / app` | `hortor-mix / app-mobile / app`（一致） | ✅ 已排除 |
| 7 | 心跳 / `_sys/ack` | 有 | 有 | ✅ 已排除 |
| 8 | 消耗类写命令 | ✓ 全通 | ✓ | ✅ 「笼统写权限」假设排除 |
| 9 | `activity_claimtaskreward` | ✗ 静默无响应 | ✓ ~60ms 返回 | 唯一失败命令 |

## 4. 假设清单与验证实验

| 假设 | 内容 | 验证实验 | 成本 |
|---|---|---|---|
| **H-Cookie** | 握手层 Cookie 会话差异（游戏本体登录后种下 hortorgames.com Cookie） | **实验 D**：DevTools 抓该 WSS 连接的 **Request Headers**（URL 已抓到，还差 headers）对比批量页 | ⭐ master 贴一次 headers 即可 |
| **H-roleId** | p= 里多余的 `roleId` 字段使服务端把会话归入受限类 | **实验 F**：`token.ts transformToken` 不再 `...data` 整体展开，p= 只放游戏 SDK 四字段 `{roleToken, sessId, connId, isRestore}` → 试 claim | ⭐ 改一处，发一帧验证 |
| **H-指纹** | 首帧 body 的 platformExt/clientVersion/scene 影响（2.21.2-mix vs 1.89.8-h5） | **实验 A**：批量页/Node 首帧 body 改成游戏原值再发 claim，一发验证 | ⭐ 改一处常量 |
| **H-状态机** | 服务端 session 需「已进入游戏」标记（SwitchRole 之后 / WS 内初始化序列之后）才受理领奖 | **实验 B**：批量页 claim 前照抄成功会话的 30+ 初始化序列（含 `fight_startlevel`、`system_custom`、`role_backclaimreward`）再发 claim | ⭐⭐ 纯发包编排 |
| **H-组合** | 多要素缺一不可 | 上述实验按结果叠加 | ⭐⭐ |
| **H-复刻**（终极） | Node 复刻原生 HTTP 登录全链 | 抓游戏原生登录完整 HTTP 链 → Node 复刻 | ⭐⭐⭐ 工程量最大 |

> 注意 1：09-30 bin-test 的「游戏原值 1.89.8-wx+h5」实验针对的是 **p= token 字段组合 + role_getroleinfo 200020** 问题（Node 场景），**首帧 body 差异对 claim 挂死的影响没有单独验证过**——实验 A 不是重复劳动。
> 注意 2：实验 F 依据 —— 21a_fail 批量页 p= 带 roleId 时 role_getroleinfo 等命令全通，说明服务端**接受**该连接；但 claim 单命令挂死 ⇒ 服务端可能在**命令受理层**按 p= 字段集（roleId 有无）区分会话类型。 roleId=uid（249954438）在游戏 SDK 连接参数里本来就不存在，是 `transformToken` 把 authuser 响应整体展开带进去的——游戏原生客户端从不发送它。

## 7. 定案（2026-10-01 13:5x，bin-test 对照实验全链路）

master 指示用 bin 文件 + `xyzw-bin-test` skill 逐项对照，单变量实验链：

| 实验 | 形态 | 结果 |
|---|---|---|
| E0 | Node 默认首帧（mix/2.21.2）+ 四字段 p= | **role_getroleinfo 成功**（09-30 的 Node 200020 之谜 = p= 带 roleId / 会话残留，四字段已解） |
| E2 | claim 模式（自动算 78 轮补领） | activity_get ✓ 78 轮 todo，**首条 claim → 服务端断线 1006** |
| E3 | --firstframe game + claim | 仍断线 ⇒ 首帧口径**单独不充分** |
| E4 | **init 序列（36 帧进主城）+ firstframe + claim** | **✓ claim 成功**（Activity_RewardResp 带实时 items） |
| E5/E6 | init（无 firstframe / 有）+ claim，9754 | ✗ 断线——9754 已被反复连挂（**会话冷却**：同角色频繁 authuser/断线后 200020 泛滥，数分钟后恢复） |
| E7 | 干净号 9755 复刻 E4 | **✓ claim 成功**（实领 5287×8 入账）→ **可复制** |
| E8 | 9755 紧接 E7 再连 | ✗（会话冷却，2 分钟内重连被拒） |

### 根因定案

**`activity_claimtaskreward` 受理 = 双因素**：
1. **会话状态**：必须先跑「进主城初始化序列」（游戏本体连上后的 36 帧，末帧 `role_backclaimreward` = 进城结算标记）——服务端据此标记「已进入游戏」才受理领奖；
2. **首帧口径**：role_getroleinfo 用游戏本体原值（`platformExt:"h5"` / `clientVersion:"1.89.8-wx"` / `scene:""`）。

批量页此前缺这两样（首帧自编口径 mix/2.21.2 + 连上后直奔业务命令）⇒ 挂死。
**附带发现**：同角色频繁重建会话会触发服务端冷却（200020 泛滥，约数分钟），批量页重跑间隔 3s 太激进。

### 生产化（commit `ceb1dcf3`，13:52 部署上线）

- `xyzwWebSocket.js`：role_getroleinfo 注册 body → 游戏本体原值（h5/1.89.8-wx；仅此帧带这些字段，无 3000070 口径污染）；
- `tasksGoldenfish.js`：`GOLDENFISH_ENTER_GAME_SEQUENCE`（36 帧）+ claimProgressRewardsStep 前置执行，完成帧数进日志；
- 测试 554/555（唯一红 = skinChallenge 基线）。
- 待办：多开桥/运行时页路径的 2.21.2 口径（gameCommands / firstFrameSpoof rules）不在本次 claim 路径上，后续统一。

## 6. 证据文件索引

| 文件 | 内容 |
|---|---|
| `local-data/goldenfish/21a_fail_wss-diag-2026-09-30T05-46-28.jsonl` | 批量页失败样本（连接诊断录制，21 行） |
| `local-data/goldenfish/21a_success_xyzw-runtime-wss-2026-09-30T05-48-15-151Z.jsonl` | 游戏本体成功样本（99 帧被动抓包） |
| `local-data/goldenfish/_21a_success_full.txt` / `_21a_success_claims.txt` | 成功样本完整解码 / 领奖帧摘要 |
| `local-data/goldenfish/goldenfish_claimProgressRewards.jsonl` / `_claim_decoded.txt` | 21号战士游戏本体领奖抓包 + 解码 |
| `src/stores/tokenStore.ts:1066` | 批量页 WS URL 构造（`agent?p=...`） |
| `src/utils/xyzwWebSocket.js:114` | 批量页首帧 body 注册口径（mix / 2.21.2） |
| `public/game/sh1.readable.js:451`（doInjectLogin） | 游戏端 BIN 登录注入（LoginService.mix + authUser hook + SwitchRole） |
| `public/game/platform-spoof.js` | 平台口径背景（h5web/h5/mix、3000070、authuser 直连实测） |
| `src/utils/pushLevelResearchBridge.js` + `public/game/push-level-research-bridge.js:3177` | 推关页 postMessage 桥（`account:load` = BIN 交游戏上号器） |

## 8. 🔴 真正的生产根因（2026-10-01 17:4x）：命令从未注册

> 第 7 节的「双因素」是**必要前置**，但**不是生产失败的全部**。今天实测发现生产还有一处更硬的缺口。

### 现象

生产（批量页 / Node）发送 claim 时报：

```
[WS] [ERROR] 发送消息失败: activity_claimtaskreward Error: Unknown cmd: activity_claimtaskreward
```

`CommandRegistry.build` 对未注册命令直接 `throw`。异常之后**连接被打成 `close 1006`，后续每一帧都只入队**
（`WebSocket 未连接，消息已入队: xxx` 无限循环）——这正是此前被描述为「挂死 / 全帧入队」的现象。

### 两个缺口（`local-data/_check_registry.mjs` 实测）

| # | 缺口 | 影响 |
|---|---|---|
| ① | `activity_claimtaskreward` **从未注册**（`xyzwWebSocket.js` 里只出现在注释中） | claim 帧根本发不出去 |
| ② | `GOLDENFISH_ENTER_GAME_SEQUENCE` 36 帧里 **19 帧未注册**（含 `role_backclaimreward`），覆盖率仅 **17/36** | 连 init 序列都跑不完，第 4 节的双因素根本无法达成 |

缺失的 19 帧：`role_getfirstmonthdate` / `system_getchatmessage` / `invite_getinfo` / `collection_getinfo` /
`system_userminiprogram` / `sky_getgdrolesky` / `queue_getinfo` / `system_getservertimestamp` / `nmext_getinfo` /
`beginnerbox_getinfo` / `boss_getstate` / `mail_getbattlefieldreportlist` / `role_backclaimreward` /
`friend_getfollowinfo` / `friend_list` / `friend_applylist` / `pkroom_getfightroominfo` / `pkroom_getfightroomdetail`

### 为什么 E4/E7「看起来」通过了？

`local-data/bin-test/bin-test.mjs` 的 `commands:` 模式与 `runInitSequence()` 都会**自动兜底注册**：

```js
if (!ws.registry.commands.has(item.cmd)) ws.registry.register(item.cmd);
```

⇒ **研究 harness 比生产宽松，把生产缺口整个掩盖了**。
**教训：协议命令的「注册覆盖率」必须单独核查，不能把 harness 的通过当成生产可用。**

### 修复与验证

`src/utils/xyzwWebSocket.js`：
1. 补注册 `activity_claimtaskreward { activityId: 0, missionId: 0 }`；
2. 补注册上述 19 帧（默认 body 取抓包原值）；
3. 响应映射 `activity_rewardresp` 由 `"activity_claimsignreward"` 改为
   `["activity_claimsignreward", "activity_claimtaskreward"]`（两者都回 `Activity_RewardResp`）。

复检：**36/36 全覆盖**，注册表 189 → 207。

**✅ 实测（2026-10-01 17:42，9740 服 / 内部 9767 / 角色 40a）**：

```
进主城初始化序列：29/36 帧成功
进度奖励补领：77 个达标未领轮次
进度奖励领取完成：77/77 轮（record 校验全部入账）   ← 服务端 record 确认
全程 21 秒（init 12s + 领奖 8s）
```

### 排查命令（改动命令后必跑）

```bash
node --import ./local-data/_alias_loader.mjs local-data/_check_registry.mjs
```

### 附：`200020` 的正确归因（同时推翻一条旧结论）

`200020`（"出了点小问题，请尝试重启游戏解决～"）的**头号原因是该角色会话被占用**
（批量页在跑 / 游戏客户端在线 / 另有一个进程在连同一角色），**不是 bin 类型问题**。

实测 `_cmp_bins.mjs`：`rolebin-9754`(9754) / `rolebin-1009754`(1009754) / `rolebin-2009754`(2009754) / `fresh-28a-0`(9755)
—— **四个不同服的 bin，`info` 字段完全相同**（sha `09d64898` / timestamp `1790514993`），**唯一差异是 `serverId`**。
⇒ 所谓「角色级 bin」本质就是「账号 info + serverId」，`mobile.vue` 的 `createRoleBin` 注入法**本来就是对的**；
账号级 bin（如 `gh_repo/mobile.bin`）注入 `serverId` 后**完全可用**（9767 已实测通过）。

⚠️ 另注：同一角色被两个进程同时连接会互相踢（`close 1006`）——本次研究中曾因此误判为「服务端冷却」。
