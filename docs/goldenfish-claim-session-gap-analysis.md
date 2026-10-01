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

## 5. 全自动化路径（按实验结果择路）

- **路径一（若实锤 Cookie，改动最小）**：批量页领奖命令走 **multi-game iframe 桥**（postMessage → 游戏本体 → 原生会话领奖），其余命令仍走轻量 WS。游戏本体领奖已被 3 份抓包 100% 验证；multi-game 上号器（sh1.js）就是现成的批量原生登录框架，120 号可逐号隐形开 iframe 登录 → 桥发领奖 → 销毁。
- **路径二（若实锤 Cookie 且想彻底协议化）**：Node 复刻原生登录全链拿 Cookie（实验 E），批量页 WS 握手带 Cookie + p= 双凭据。一劳永逸，但要逆向完整 HTTP 登录链。
- **路径三（若 H-状态机/指纹成立）**：批量页发包编排加「首帧指纹对齐 + 进主城初始化序列」两步，纯协议层解决，无需 iframe。成本最低、最干净，优先验证。

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
