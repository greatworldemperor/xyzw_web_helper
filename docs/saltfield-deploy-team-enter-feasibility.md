# 盐场自动化 · 第一步（布阵 → 组队 → 登场）可行性分析

> 数据来源：`local-data/saltfield/saltfield2026-09-12T12-41-33-492Z.jsonl`（2026-09-12 12:38–12:41 真实抓包，590 行 / 587 帧）
> 对照组：[`scripts/自动盐场.js`](../scripts/自动盐场.js)
> 解包与验证脚本：[`local-data/saltfield-analysis/`](../local-data/saltfield-analysis/)
>
> 目录：§1 抓包解包 · §2 三条命令的线格式（byte-exact）· §3 真实时序 · §4 roleMap 与组队约束 · §5 与 Userscript 对照 · §6 风险与未确认项（含 `3000070` 归因）· §7 落地改动清单 · §8 推进顺序 · **§9 轻量级方案可行性**


---

## 0. 一句话结论

**可行，而且比预期容易。** 抓包已经把三条动作的**完整请求体逐字节还原**，并用项目现有的 BON 编码规则做了 1:1 复现验证（7 条命令全部 byte-exact）。项目里盐场专用 WebSocket 通道、BON 编解码、心跳、`sid` 票据都已跑通，剩下的工作量集中在"注册 3 条命令 + 解析 roleMap + 写编排层"。

两个关键机制在抓包里被定位清楚了：

1. **`war_enterbattlefield` 的响应里带 `roleMap`** —— 我方俱乐部全部成员的 **roleId → 战场 codeId** 映射。有了它，"给某个 token 找到它在战场里的编号"不需要该 token 上线，甚至不需要它进过战场。
2. **`war_startbattle`（主动攻击）被服务端拒绝** `code 3000070`（`检测到您使用的客户端数据异常，请使用官方最新客户端`）。但抓包证据表明**不是"h5 平台整体不能攻击"**——同一战场里 `hortor-h5` 平台有 27 人有击杀、6 次正常发起战斗。更可能是 master 所用的**非官方 H5 入口**上报的客户端/平台数据不被认可。**第一步的 3 条命令 + 行军 + 加速在该入口下全部实测成功**，且 master 的方案不需要攻击，所以这条不构成阻塞，仅留作以后需要攻击时的线索。

> 本节结论已按 master 2026-09-13 的实测反馈修订：
> ① 真实操作顺序确为「选阵容 → 组队 → 登场」；
> ② 组队目标必须是同俱乐部角色，**但可以是当天没上线、从未进过战场的角色** —— 原第 4 节"必须在战场内"的判断作废；
> ③ master 使用的是**非官方 H5 入口**（正式入口只有 App 与微信小程序），因此 `3000070` 的来源需要重新归因，见 6.1。


---

## 1. 抓包解包结果

抓包用的是本仓库已有的私有编码方案（`px` 头 = `x` 方案 + BON），`decode_captures.mjs` 里的算法可直接复用。解码后得到：

| 项目 | 值 |
| --- | --- |
| 帧总数 | 587（130 发出 / 457 收到） |
| 连接 1 | `wss://xxz-xyzw.hortorgames.com/agent`（主游戏连接，203 帧） |
| 连接 2 | `wss://xxz-xyzw-new.hortorgames.com/agent`（**盐场战场专用连接**，12:40:10.632 建立，384 帧） |
| 本客户端 token | `momo-0-664483911`（26501 服） |
| 战场内身份 | `codeId = 406`，角色名「世界国皇帝」，俱乐部 `5143405 宾克斯✨酒馆` |
| 战场 | `WEEK-260912:841`，`confId 57`，`legionWarMap 13` |

**关键点：盐场战场是独立 WebSocket**，用主连接 `legion_getbattlefield` 返回的 `info.sid` 作为一次性票据连入（URL 形如 `.../agent?p=<token>&e=x&sid2=<sid>&lang=chinese`）。这一点本项目 [`src/stores/legionWarStore.js`](../src/stores/legionWarStore.js) 已经实现。

---

## 2. 三条命令的线格式（已逐字节验证）

外层统一信封：`{ ack, body, hint, time, seq, cmd }`，其中 `hint = battlefieldId`，`body` 是**嵌套的 BON 二进制**（tag 7 包裹）。

### 2.1 登场 = `war_setbattleteam`

```json
{ "battlefieldId": "WEEK-260912:841",
  "battleTeam": { "0": 116, "1": 112, "2": 107, "3": 104, "4": 106 },
  "lordWeaponId": 9,
  "petUId": "298-cP5" }
```

- `battleTeam` 是 **Map<int, int>**（位置 0–4 → 英雄 ID），不是数组。
- `lordWeaponId` / `petUId` 必须与角色当前的主公武器、宠物一致（抓包里与 `battlefield.roles[406]` 的字段完全相同）。

### 2.2 布阵 = `war_teamsetbattleteam`

**请求体与 2.1 完全一致**，唯一差别是 `cmd` 字符串（长度差 4 字节，正是命令名长度差）。

### 2.3 组队 = `war_invitejointeam`

```json
{ "battlefieldId": "WEEK-260912:841", "targetCodeId": 397 }
```

- `targetCodeId` 是**战场内 codeId**（`battlefield.roles` 的键），**不是** roleId（如 664483911）。
- 每次邀请 1 人，队长逐个发。

### 2.4 复现验证（决定性证据）

用 [`src/utils/bonProtocol.js`](../src/utils/bonProtocol.js) 的 `BonEncoder` 规则重新编码这 7 条命令，与抓包原文的明文逐字节比对：

```
war_setbattleteam      : OK 逐字节一致  (227B / 227B)
war_teamsetbattleteam  : OK 逐字节一致  (231B / 231B)
war_invitejointeam     : OK 逐字节一致  (146B / 146B)
war_enterbattlefield   : OK 逐字节一致  (140B / 140B)
war_startbattle        : OK 逐字节一致  (143B / 143B)
war_startmarch         : OK 逐字节一致  (149B / 149B)
war_speedup            : OK 逐字节一致  (134B / 134B)
```

即：**协议层已完全掌握，可以脱离游戏 H5 运行时直接在主项目里构造并发送这些请求。**

---

## 3. 真实时序（关键：顺序要修正）

本次操作中本客户端（role 406）发出的命令，按 seq 排：

| 时间 | seq | cmd | 备注 |
| --- | --- | --- | --- |
| 12:40:09.918 | 57 | `legion_getbattlefield`（主连接） | 取 `sid` / `battlefieldId` |
| 12:40:11.677 | 1 | `war_enterbattlefield` | 进入战场 |
| 12:40:16.149 | 2 | `war_teamsetbattleteam` | 提交出战阵容 |
| 12:40:18.105 | 4 | `war_invitejointeam` | 邀请 397 |
| 12:40:21.849 | 6 | `war_invitejointeam` | 邀请 396 |
| **12:40:39.023** | **10** | **`war_setbattleteam`** | **← 角色真正出现在地图上** |
| 12:40:42.719 | 12 | `war_startmarch` | 行军至 (13,5) |
| 12:40:43.820 | 13 | `war_speedup` | 加速 |
| 12:41:08.884 | 19 | `war_speedup` | 加速 |
| 12:41:26.807 | 24 | `war_startbattle` | 攻击 158 → **被拒（code 3000070）** |

role 406 的状态轨迹（从服务端增量帧里追出来的）：

```
12:40:11.820  enterbattlefield 快照   state=watching   position=(-1,-1)  isOnline=false
12:40:11.839                          isOnline=true
12:40:18.226  邀请 397 后             state=teaming    teamMap[406]={lCodeId:406, mCodeIds:[406,397]}
12:40:21.921  邀请 396 后             teamMap[406].mCodeIds=[406,397,396]
12:40:32.944  teaming 倒计时结束       state=watching   position=(-1,-1)   ← 队长还没登场，队伍回落
12:40:39.072  ← ack:10（即 war_setbattleteam 的响应）
              state=idle  position=(14,3)  teamMap[406]={state:idle, position:(14,3)}   ★ 登场
12:40:42.930  行军                   state=march
12:41:20.921  到达                   state=idle  position=(13,5)
```

### 结论

1. **"登场" = `war_setbattleteam`**。它的响应帧里第一次出现 `roles[406] = {state:"idle", position:{14,3}}`，是角色从 `(-1,-1) watching` 落到地图上的那一次跳变。这条响应 `ack: 10`，正好对应客户端 seq 10 的 `war_setbattleteam`，因果关系明确。
2. **`war_teamsetbattleteam` 只提交阵容，不改位置**（它的响应只有 `{roleCodeId, battlefieldId}`，之后到 12:40:39 之前 role 406 没有任何状态变化）。
3. **master 已确认操作顺序是「选阵容 → 组队队友 → 登场」，且只有登场之后才能移动 / 攻击建筑 / 攻击敌方玩家。** 与抓包时序完全吻合：

   | master 的操作 | 对应的 cmd | 抓包时间 |
   | --- | --- | --- |
   | 选阵容（布阵） | `war_teamsetbattleteam` | 12:40:16 |
   | 组队队友 | `war_invitejointeam` ×2 | 12:40:18 / 12:40:21 |
   | 登场 | `war_setbattleteam` | 12:40:39 |

4. 唯一需要补充的是：**这三步之前必须先"进入战场"**（`war_enterbattlefield`），因为 `battlefieldId` 和角色的战场 `codeId` 都来自战场本身。完整链是 **进入战场 → 选阵容 → 组队 → 登场**。

---

## 4. 组队：roleMap 机制与约束

### 4.1 关键机制：`roleMap`（本次最重要的发现）

`war_enterbattlefield` 的响应体除了巨型 `battlefield` 快照，还有一份 **`roleMap`**：

```json
"roleMap": {
  "664483911": { "rId": 664483911, "cId": 406, "n": "", "h": "", "s": 0 },
  "682283004": { "rId": 682283004, "cId": 397, "n": "", "h": "", "s": 0 },
  "714928789": { "rId": 714928789, "cId": 396, "n": "", "h": "", "s": 0 }
}
```

- `rId` = 角色 roleId（账号级，稳定）
- `cId` = **本场战场内的 codeId**（`war_invitejointeam` / `war_startbattle` 等命令用的就是它）
- `n` / `h` / `s` 本次全为空字符串 —— 客户端懒加载，不影响使用

**这份 roleMap 恰好等于我方俱乐部的全部成员，与本场活跃度无关：**

| 校验项 | 结果 |
| --- | --- |
| `roleMap` 条目数 | 21 |
| 俱乐部 `5143405 宾克斯✨酒馆` 名册成员数（`Legion_GetInfoResp.info.members`） | 21 |
| 两边 roleId 集合是否一致 | **完全一致**（含离线队友 `682283004` / `714928789`） |
| `battlefield.roles` 条目数 | 436 = 20 个俱乐部 × 各自成员，合计校验 **0 缺失** |

进一步验证了全场 codeId 的分配方式 —— **按俱乐部连续分段分配，开战时按名册全量发放**：

```
5~12    天問 (n=5)          23~46   永夜·羡宝王 (n=23)
47~76   唯爱冲锋. (n=30)     77~101  泥大乱 (n=25)
...                        392~412 宾克斯✨酒馆 (n=21)   ← 我方
413~434 风云2028 (n=22)     435~464 必胜客旦旦 (n=30)
465~483 丨隐仙居丨 (n=17)
```

**推论（已与 master 实测对齐）：** codeId 是按参战俱乐部名册**预先全量分配**的，所以一个**当天完全没上线、从未进过战场**的队友号，在 `roleMap` 里依然有 `cId`，照样能被邀请进队。这解释了抓包里 397/396 处于 `state:"watching" / isOnline:false / position:(-1,-1)` 却被成功拉入 `mCodeIds` 的现象。

**这直接决定了多号方案的形态：只有"队长号"需要登录并连入战场；队友号连登录都不需要，只要它的 roleId 属于把该号拉进去的那个俱乐部名册即可。**

### 4.2 约束表

| 约束 | 证据 |
| --- | --- |
| 上限 **5 人（含队长）** | 49 支队伍规模分布：5 人的 41 支、4 人 3 支、3 人 3 支、2 人 2 支，**没有超过 5** |
| **必须同俱乐部** | 406 / 397 / 396 的 `legionID` 都是 `5143405`；且 `roleMap` 只提供我方俱乐部的映射，服务端也只认本俱乐部 |
| **队友不需要进过战场、不需要当天上线** | `roleMap` 里 21 条映射覆盖名册全部成员（含 `online:0` / `signInTime` 为前一天的号）；master 实测确认 |
| 邀请目标用**战场 codeId** | `war_invitejointeam { battlefieldId, targetCodeId }`，`targetCodeId` 取自 `roleMap[rId].cId` |
| 邀请后 ~10s 窗口 | `constant.TeamCd = 10`；12:40:18 邀请 → `custom.teaming=1789216827`（+9s）；窗口结束时若队长仍未登场，队伍状态回落 `watching`（但 `mCodeIds` 保留，12:41:20 时队伍仍为 3 人） |
| 游戏自身的候选列表 | `scripts/自动盐场.js` 的 `listInviteCandidates()` 读 `self.legion.selfLegionIdleMembers`，即「本俱乐部 · 空闲（未组队）成员」—— 与 roleMap 口径一致，只是过滤掉了已在队的人 |

### 4.3 对 master 需求的映射

> 「组队目标是所有 token 已经登录的角色，不在这个范围内的除非显式写入白名单，否则不会优先组队，但缺人时可以组队」

- 「已登录的角色」→ 实际条件只需 **① 与本号同俱乐部 ② 该 roleId 在 `roleMap` 里**。是否登录、是否进过战场都无关。
- 「缺人时可用白名单外」→ 等价于「同俱乐部内 `roleMap` 里、当前未在队的其他成员」，可按 `battlefield.roles[cId].power` 排序取。
- ⚠️ 因为组队严格限同俱乐部，**配置时必须按俱乐部给 token 分桶**：跨俱乐部的 token 无法互相组队（服务端会拒）。

### 4.4 需要注意的边界

1. `cId` 是**每场重新分配**的（本次是 392~412，下一场必然不同）→ **每次进入战场后必须重新取 `roleMap`，绝不能跨场次缓存**。
2. `roleMap` 里没有的 roleId 无法邀请（例如该 token 不在本俱乐部、或该俱乐部本场未参战）。编排层需要给出明确报错而不是静默失败。
3. 队长自己也在 `roleMap` 里（`664483911 → 406`），别把自己邀请进去。


---

## 5. 与 `scripts/自动盐场.js` 的对照

脚本通过 `window.__require('ModuleManager').GET_MODULE(Configs.ModuleType.LEGION_WAR)` 拿游戏模块再调 `send*` 方法。本次抓包第一次把这些方法**落到了具体 cmd 和逐字节请求体**上：

| 脚本方法（真实分支） | 底层 cmd | 本次抓包 |
| --- | --- | --- |
| `lw.enterAnonymousWar()` | `war_enterbattlefield` | ✅ 有 SEND，已复现 |
| `lw.sendGetBattlefield()` | `legion_getbattlefield`（主连接） | ✅ 有 SEND，响应已解析 |
| `lw.sendGetBattlefieldInfo()` | `war_getbattlefieldinfo` | ⚠️ 本次未发出（只有 `war_enterbattlefield` 返回的大快照） |
| `lw.deployData.sendSetBattleTeam()` | `war_teamsetbattleteam` / `war_setbattleteam` | ✅ 两条都有，已复现 |
| `lw.sendInviteJoinTeam(playerId)` | `war_invitejointeam` | ✅ 两条 SEND，已复现 |
| `lw.sendStartMarch(position)` | `war_startmarch` | ✅ 已复现 |
| `lw.sendSpeedUp(marchId)` | `war_speedup` | ✅ 已复现 |
| `lw.sendStartBattle(enemyId)` | `war_startbattle` | ✅ 已复现（但服务端拒绝，见 6.1） |
| `lw.sendStartAttackBuilding(buildingId)` | 推测 `war_startattackbuilding` | ❌ 本次**没有 SEND**，只有服务端推送的 `War_StartAttackBuildingResp` |
| `lw.sendKickOutTeam / sendLeave / sendChangePos` | 未知 | ❌ 本次未发出（`War_AdjustTeamPosResp` 均为推送） |
| `lw.sendUseResurrect()` | 未知 | ❌ 本次未发出（`War_ResurrectNotify` 均为推送） |

**结论：脚本的"方法级接口"是真的，本次抓包把它升级为"协议级接口"。** 脚本中 `sandbox: true` 的伪造分支依然必须排除在协议推断之外（与 [`PROJECT_CONTEXT.md`](../PROJECT_CONTEXT.md) 的既有结论一致）。

---

## 6. 已知风险 / 未确认项

### 6.1 攻击被服务端拒绝：`code 3000070`（已重新归因，不是第一步的阻塞项）

12:41:26.807 发出 `war_startbattle {battlefieldId, targetCodeId:158}` 后，服务端 61ms 内直接回了：

```json
{ "seq": 301, "ack": 24, "time": 1789216886289, "resp": 24,
  "code": 3000070,
  "error": "检测到您使用的客户端数据异常，请使用官方最新客户端" }
```

这是全抓包**唯一**一条 `code !== 0` 的响应。同一客户端、同一战场、同一 session 下，`war_enterbattlefield` / `war_teamsetbattleteam` / `war_invitejointeam` / `war_setbattleteam` / `war_startmarch` / `war_speedup` **全部成功**。

#### 平台维度实测（用于归因）

master 指出其所用的是**非官方 H5 入口**（正式入口只有 App 与微信小程序）。据此按 `battlefield.roles[*].loginPlatform` 做了全场统计：

| loginPlatform | 人数 | killCnt > 0 的人数 | 最高击杀 | 作为发起方的成功战斗 |
| --- | --- | --- | --- | --- |
| `hortor-mix` | 369 | 185 | 66 | 33 次 |
| `hortor-h5` | 58 | 27 | 12 | 6 次 |
| `hortor-qq` | 8 | 3 | 4 | 0 次 |
| **`hortor-h5web`** | **1**（就是本号 406） | 1 | 1 | **0 次** |

`hortor-h5` 那 6 次成功发起战斗的样本：

```
12:40:55.437  发起=119(无界✨路子野 / hortor-h5) → 412(驴生戟角)
12:41:01.462  发起=119                          → 409(歪比巴卜)
12:41:07.457  发起=119                          → 401(酒馆✨C)
12:41:13.458  发起=119                          → 394(FAN)
12:41:20.428  发起=123(三岁★就很拽 / hortor-h5) → 394(FAN)
12:41:26.461  发起=123                          → 407(FAN)
```

#### 结论

1. **不是"h5 平台不能攻击"** —— `hortor-h5` 的平台有 27 人正常击杀、6 次正常发起战斗，说明 `war_startbattle` 并没有"只准官方 App/小程序"的硬门槛。
2. **`hortor-h5web` 是一个异常稀有的平台标识**：整场 436 个角色里只有 406 一个。它与抓包中 `role_getroleinfo` 请求上报的 `platformExt: "h5web"` 对应（同请求里 `platform: "hortor"`、`clientVersion: "1.89.8-wx"`）。
3. 因此 master 的怀疑**方向是对的**：更可能是**这个非官方 H5 入口上报的客户端/平台数据不被认可**，而不是命令本身不可用。可作为后续线索：改用 `hortor-mix` / `hortor-h5` 口径（或直接走 App/小程序）是否就能解除 3000070。
4. 一个需要留意的反证点：406 的 `killCnt = 1`、`d = 4`，说明它在本场**有过击杀记录**（`dieTime` 12:35:03、`reviveTime` 12:36:03 均在抓包开始之前）。但无法区分这是主动击杀还是被攻击时的反杀，所以不能据此断定"以前主动攻击成功过"。
5. **对第一步无影响**：master 的方案不需要攻击敌人。这条只作为以后需要攻击时的排查线索，不构成当前阻塞项。
6. 参考：战场上 39 条 `War_StartBattleResp` **全部是服务端主动推送**（无 `resp` 字段、无对应 SEND，`battleInfo.battleData` 为 `null`），说明「相邻自动交战」由服务端驱动，主动发起才是受限动作。


### 6.2 其它未确认项

1. `war_getbattlefieldinfo` 的请求体没在本次抓包里出现（进战场时用的是 `war_enterbattlefield` 返回的全量快照）。项目现有代码按 `{ battlefieldId }` 发送，需实测确认。
2. `war_startattackbuilding`、`war_useResurrect`、`war_kickoutteam`、`war_leave`、`war_changepos` 的请求体本次未捕获，需要专门再抓一次。
3. 服务端限流/冷却：抓包中 `war_ping` 稳定 5s 一次，业务命令间隔 ≥1s，`TeamCd=10`。实际最小间隔需实测。
4. 队友日消耗：邀请一个从没上线的号入队，是否会消耗该号的盐场次数/奖励资格，需要实测（不影响第一步的功能可行性，但影响策略）。

---

## 7. 落地改动清单（本项目）

### 7.1 `src/utils/xyzwLegionWarWebSocket.js`

`registerDefaultCommands()` 里补 3 条命令（`CommandRegistry.register` 已自动拼 `ack/seq/hint/time/body`，且 `hint` 已绑定为 `battlefieldId`，与抓包一致）：

```js
.register("war_teamsetbattleteam")   // 选阵容（布阵）
.register("war_setbattleteam")       // 登场（提交阵容并让角色落地）
.register("war_invitejointeam")      // 邀请组队
```

### 7.2 `src/stores/legionWarStore.js`

- 新增 action：`setBattleTeam({ battleTeam, lordWeaponId, petUId })`、`enterBattlefield()`（`tryJoinBattlefield` 已有雏形）、`inviteJoinTeam(cId)`。
- **新增 `roleMap` 解析与暴露**：从 `War_EnterBattlefieldResp.body` 取 `roleMap`（roleId → cId）和 `roleCodeId`（自己的 cId），存成 `ref`/`computed`。这是"给 token 找 cId"的唯一入口，也是本次方案简化的关键。
- 补 `battlefield.roles` / `battlefield.teamMap` / `constant` 的解析 —— 当前 [`src/utils/legionWar.js`](../src/utils/legionWar.js) 的 `extractValidData()` 只抽了地图、俱乐部汇总和成员统计，**没有抽 roleMap / roles / teamMap**，而这三块正是组队所需。
- 每次 enter 之后必须**重置** roleMap（cId 每场重分配，不能跨场复用）。

### 7.3 新增编排层（多号调度，已因 roleMap 大幅简化）

```text
1. 队长号：connect(战场WS) → war_enterbattlefield
          → 读 roleMap（roleId→cId）、roleCodeId（自己的 cId）
2. 选阵容：war_teamsetbattleteam({ battlefieldId, battleTeam, lordWeaponId, petUId })
3. 组队：  对每个队友 token → cId = roleMap[token.roleId].cId
          → war_invitejointeam({ battlefieldId, targetCodeId: cId })
          → 累计到 5 人（含队长）为止
4. 登场：  war_setbattleteam(同上阵容)   → 角色 watching → idle
5. 校验：  battlefield.teamMap[自己的 cId].mCodeIds 长度是否符合预期
```

要点：
- **只有队长号需要登录 + 连战场**；队友号不需要登录、不需要进战场（已由 roleMap 机制 + master 实测确认）。
- `cId` 一律从 `roleMap[token.roleId]` 取；`token.roleId` 在项目 `gameTokens` 里已有，无需额外请求。
- 队友候选：优先「本俱乐部 token 白名单」→ 不足时按 `battlefield.roles[cId].power` 取「本俱乐部未在队成员」。
- **按俱乐部给 token 分桶**：跨俱乐部无法组队，编排层要显式校验并提示。
- 队长未登场时队伍状态回落 `watching`，所以**登场要么在组队前完成，要么在 `TeamCd`（10s）窗口内完成**；失败要能重试。

### 7.4 阵容来源

`battleTeam` / `lordWeaponId` / `petUId` 是"该号已保存的盐场阵容"。两条路：
- **（推荐）** 先做只读验证：用 `hero_calcpowerbyteam`（同一组 body，不带 battlefieldId，抓包里有）校验阵容合法性；
- 或为每个 token 在本地配置一份盐场阵容（5 个英雄 ID + 主公武器 ID + 宠物 UID）。

---

## 8. 建议的推进顺序

1. **只读打通**：在 `legionWarStore` 里解析 `roleMap` / `roleCodeId` / `battlefield.roles` / `teamMap` / `constant`，确认能读到自己的 `cId` 和全部队友的 `cId`。
2. **单号三步**：`war_teamsetbattleteam → war_invitejointeam → war_setbattleteam`，用抓包时序对照观察 `watching → teaming → watching → idle` 的跳变。
3. **验证"队友无需上线"**：拿一个当天没登录的同俱乐部 token，只发 `war_invitejointeam`，看 `teamMap[自己cId].mCodeIds` 是否 +1。（这条已由 master 实测确认，此处是回归验证）
4. **多号编排**：按 7.3 串起来，加失败重试与限流。
5. 攻击（`war_startbattle` / `war_startattackbuilding`）**不在第一步范围内**；若以后要做，先验证 6.1 的归因（换用 `hortor-mix` / `hortor-h5` 口径的入口是否解除 `3000070`）。

---

## 附：master 已确认的事项（2026-09-13）

| 问题 | 答复 | 对方案的影响 |
| --- | --- | --- |
| "登场"是不是 `war_setbattleteam`？ | 操作顺序是**先选阵容 → 再组队队友 → 最后才登场**；且**只有登场之后才能移动、攻击建筑、攻击敌方玩家** | 与抓包时序（`war_teamsetbattleteam` 12:40:16 → `war_invitejointeam` 12:40:18/21 → `war_setbattleteam` 12:40:39）完全吻合，"登场 = `war_setbattleteam`" 成立。也说明 `war_setbattleteam` 是后续所有战斗动作的**前置门槛** |
| 组队 token 是否必须同俱乐部？ | **必须是同俱乐部**，但**可以是根本没进过战场、当天没上过线的** | 原"必须在战场内"结论作废；改由 `roleMap` 机制解释（见 4.1）。多号方案大幅简化：**队友号无需登录** |
| 队友号需要同时在线吗？ | 同第 2 条（不需要） | 确认成立 |
| 用的是官方客户端吗？ | **不是**。正式入口只有 App 与微信小程序；本次用的是非官方 H5 入口 | `3000070` 重新归因（见 6.1）。**不影响第一步** —— 该入口下 3 条目标命令 + 行军 + 加速均实测成功 |

### 仍待实测

1. `war_getbattlefieldinfo` 的实际请求体（项目现有代码按 `{ battlefieldId }` 发送）。
2. `war_startattackbuilding` / `war_useResurrect` / `war_kickoutteam` / `war_leave` / `war_changepos` 的请求体（本次未捕获）。
3. 被邀请的队友号（当天未上线）是否会消耗盐场次数或影响其奖励结算。
4. `3000070` 的归因验证：把入口上报的 `platformExt` 从 `h5web` 改为 `mix`（或换 h5/app 口径）后，`war_startbattle` 是否恢复（**仅当以后需要攻击时才做**）。

---

## 9. 轻量级方案（脱离 H5 运行时）可行性

> 背景：master 提出「是否开发轻量级盐场自动脚本，避免沉重的 H5 环境」。本节逐条核实。

### 9.1 结论：可行，而且**本项目本身就已经是"轻量级"的**

关键认知：**本项目是一个纯浏览器 Vue 应用，不依赖任何 Cocos / 游戏运行时。** `tokenStore` / `legionWarStore` 通过原生 `WebSocket` + 自带的 BON 编解码直接和服务器通信。所谓"沉重的 H5 环境"（`public/game/multi-game.html` 的 iframe、`cocos2d-js-min` bundle）**只是多开同步 UI 用的，盐场协议链路完全不需要它**。

已核实为纯 JS、且已经在跑的部分：

| 环节 | 位置 | 状态 |
| --- | --- | --- |
| 主连接（token 登录态） | `tokenStore.createWebSocketConnection()`，`wss://xxz-xyzw.hortorgames.com/agent?p=<token>&e=x&lang=chinese` | ✅ 已在用 |
| BON 编解码 + `x` 加解密 | `src/utils/bonProtocol.js` | ✅ 与抓包 byte-exact |
| 主连接命令注册 | `xyzwWebSocket.js` 的 `registerDefaultCommands()`，已含 `role_getroleinfo` / `legion_getbattlefield` / `legion_getinfo` / `role_gettargetteam` 等 | ✅ 已在用 |
| 战场专用连接 | `XyzwLegionWarWebSocketClient`，`.../agent?p=<token>&e=x&sid2=<sid>&lang=chinese` | ✅ 已在用 |
| 战场心跳 | `heart_beat` → `war_ping`（5s） | ✅ 已在用 |
| 战场命令注册 | 目前只有 `war_getbattlefieldinfo` / `war_enterbattlefield` | ⚠️ **需补 3 条** |

### 9.2 编码链路已逐层核实无误

把 `CommandRegistry` 与编码器的实际行为跟了一遍，确认战场客户端发出的帧格式**就是抓包格式**：

- 构造函数里 `this.utils = utils || g_utils`，传 `utils: null` 也会落到 `g_utils`；
- `this.enc = g_utils.getEnc("auto")` → "auto" 未注册 → 回落 `passthrough`，而 **`passthrough.encrypt` 正好就是 `getEnc("x").encrypt`**，即正确的 `x` 方案；
- `register()` 里 `body: this.encoder.bon.encode({...})` → **body 是嵌套 BON 二进制**（Uint8Array），再由 `encodePacket` 把整个信封 BON 编码 + x 加密。

结论：**编码层不需要改**。（`getEnc("auto")` 落到 `passthrough` 属于"恰好正确"，值得在代码里补一行注释说明，避免以后按"未注册 ⇒ 明文"去理解它。）

### 9.3 布阵参数可以完全无 H5 拿到（关键解锁点）

轻量方案原先最大的不确定项是"盐场阵容（5 个英雄 ID + 主公武器 + 宠物）从哪来"。抓包直接给了答案 —— **`role_getroleinfo` 的响应里就有**：

```jsonc
// Role_GetRoleInfoResp（主连接，一条命令）
"battleTeam": { "0": {"heroId":116}, "1": {"heroId":112}, "2": {"heroId":107},
                "3": {"heroId":104}, "4": {"heroId":106} },
"lordWeaponId": 9,
"pet": { "petId": 604, "petUId": "298-cP5" }
```

与 `war_teamsetbattleteam` 实际提交的 `battleTeam: {0:116,1:112,2:107,3:104,4:106}` / `lordWeaponId: 9` / `petUId: "298-cP5"` **完全一致**。转换关系：`{ i: {heroId} } → Map(i → heroId)`。

→ **轻量脚本用一条 `role_getroleinfo` 就能自己凑齐布阵 payload，不需要读游戏内存。**

⚠️ **唯一待确认项**：游戏里有 `presetteam_*` 阵容预设体系，如果盐场使用的是**独立的盐场阵容预设**，那么 `role_getroleinfo.battleTeam` 可能只是"主阵容"。本次抓包两者相同，无法区分。
**判断方法**：在盐场 UI 里把出战阵容改成一组明显不同的英雄，再抓一次 `war_teamsetbattleteam`，对比是否仍等于 `role_getroleinfo.battleTeam`。若不同，轻量脚本需加一份"每 token 单独配置盐场阵容"的兜底。

### 9.4 落地清单（轻量版）

1. `src/utils/xyzwLegionWarWebSocket.js` → `registerDefaultCommands()` 补 3 条：
   `war_teamsetbattleteam`、`war_setbattleteam`、`war_invitejointeam`
2. `src/stores/legionWarStore.js`：
   - 解析并暴露 `War_EnterBattlefieldResp.body` 的 `roleMap`（roleId → cId）、`roleCodeId`（自己的 cId）、`battlefield.roles`、`battlefield.teamMap`、`battlefield.constant`
   - 新增 actions：`setBattleTeam()` / `enterBattlefield()` / `inviteJoinTeam(cId)` / `deploy()`（登场）
   - **不要复用 `extractValidData()`** —— 它是为 UI 展示设计的，只抽地图/俱乐部汇总/成员统计；roleMap 等直接从 `rawData` 取
3. 编排层（新增，纯前端）：队长号 → 主连接 `role_getroleinfo`（阵容 + roleId）+ `legion_getbattlefield`（`sid`）→ 战场连接 enter → 读 `roleMap` → `war_teamsetbattleteam` → 逐个 `war_invitejointeam` → `war_setbattleteam` → 用 `teamMap` 校验
4. 队友号：**不需要任何连接**，只需配置里的 `roleId`（`gameTokens` 已有该字段）

### 9.5 风险与成本

| 风险 | 评估 |
| --- | --- |
| 编码 / 协议 | **已消除** —— 7 条命令 byte-exact 复现，编码链路核实无误 |
| 是否需要 H5 才能建立会话态 | **不需要** —— 主连接只需 token；`sid` 由 `legion_getbattlefield` 现取 |
| 服务端客户端完整性校验（`3000070`） | **风险反而更低**：本项目主连接默认上报 `platformExt: "mix"`（369 人 / 185 人有击杀的主流平台），而触发 `3000070` 的 H5 入口上报的是全场唯一的 `h5web`。属推断，需实测 |
| 阵容来源 | 见 9.3；一条命令可解，残留"是否存在独立盐场阵容"这一个待确认项 |
| 未捕获命令 | 若以后要做攻击/建筑/复活，仍缺 `war_startattackbuilding` / `war_useResurrect` / `war_teamsettarteam` 等的请求体 |
| 维护成本 | **低** —— 复用项目已有两个 WS 客户端；新增集中在「1 个注册函数 + 1 组 store action + 1 个编排文件」 |

### 9.6 建议：就在当前 Vue 项目里做，不必另起独立脚本

理由：

- 主连接、BON、加解密、token 管理、多账号选择、战场连接、心跳**全都在跑**；
- 只差 3 条命令注册 + roleMap 解析 + 一个编排层；
- 前端天然适合「选号 → 填白名单 → 一键布阵/组队/登场 → 看状态」的控制台形态；
- 真要脱离浏览器（改 Node 跑）也不难 —— 只需把 `bonProtocol.js` + 两个 WS 客户端 + store 里那几十行编排逻辑搬出来，但没有必要现在做。

**唯一的真实成本不是技术，而是"是否需要重放游戏 UI"**：本方案不需要 UI，因此也不受游戏资源包、活动开放时的页面状态影响，反而比注入 Userscript 更稳。

---

_分析产物：`local-data/saltfield-analysis/`（解码全文 `_saltfield_decoded.txt`、流程 `_saltfield_flow.txt`、role 406 轨迹 `_saltfield_406.txt`、roleMap 与名册比对 `_rolemap.txt`、全场 codeId 覆盖 `_coverage.txt`、军团信息结构 `_legioninfo.txt`、平台与战斗行为统计 `_platform.txt` / `_platform2.txt`、编码复现验证 `_verify_encode.txt` 及对应脚本）_

