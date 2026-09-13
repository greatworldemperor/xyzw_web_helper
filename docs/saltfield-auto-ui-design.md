# 自动盐场 · 轻量级方案 UI 设计稿

> 上游可行性依据：[`saltfield-deploy-team-enter-feasibility.md`](./saltfield-deploy-team-enter-feasibility.md)（协议已 byte-exact 复现、roleMap 机制、`3000070` 归因）
> 本文档只谈**设计**：分层、数据流、候选池与排序、持久化、界面结构、未决项。

---

## 0. 已确定的设计决策（2026-09-13）

| 决策 | 结论 |
| --- | --- |
| **层级模型** | **三层：俱乐部（高级单位）→ 队伍（最小执行单位）→ 角色**。见 §1.5，这条会连带决定执行方式 |
| **入口与俱乐部发现** | **不手动选俱乐部**。改为**在 Token 管理 / 批量任务界面勾选角色，选中的角色即队长**；俱乐部由「队长角色所属 legionId」反推得出。见 §1.6 |
| **队伍 ⇔ 队长 是 1:1** | 每个队长角色就是一支队伍；「新增/删除队伍」等价于「增减队长角色」 |
| **每个俱乐部可能在不同战场** | 各队各自 `legion_getbattlefield` 取自己的 `battlefieldId`，**不得假设相同、不得共享** |
| 页面位置 | **新增独立页 `/admin/salt-field-auto`**，照搬「批量日常」的左配置 / 右日志双栏范式；侧栏新增入口 |
| 选人主路径 | **手动指定满员队伍为常态**；排序只在「机动补齐」时作为兜底。选人规则本身不是重点 |
| 排序规则 | **① 不在线优先（`online` 字段）② 高战力优先**，**在俱乐部内部排序** —— 见 §3.2 |
| 重复选中副作用 | **接受**，不做轮换降权 |
| 机动（mobile） | **两级开关**：队伍级持久开关 + 「补齐」按钮上的一次性选项 —— 见 §3.5 |
| 布阵阵容 | **无独立盐场阵容**，直接取 `role_getroleinfo` 的主阵容（`battleTeam` + `lordWeaponId` + `pet.petUId`） |
| 执行粒度 | **一键全跑 + 每队单独跑** 都要 |
| 功能范围 | 仅「进入战场 → 选阵容 → 组队 → 登场」；**不含**行军、加速、攻击 |


---

## 1.5 层级模型，以及它带来的强制约束

```
俱乐部 legionId         ← 高级单位：候选池、排序、并发、开关的边界
  └─ 队伍 team          ← 最小执行单位：一条主连接 + 一条战场连接 + 一个队长
       └─ 角色 roleId   ← 具体的人
```

这不是设计偏好，而是被协议**强制**的。关键事实：**`roleMap` 是按"角色所属俱乐部"下发的，不是全局的。**

抓包证据：本场战场 `WEEK-260912:841` 共 **20 个俱乐部、436 人**，但角色 406 收到的 `roleMap` **只有 21 条** —— 正好是它自己所属俱乐部 `5143405 宾克斯✨酒馆` 的全部成员。跨俱乐部 415 人在 `battlefield.roles` 里能看到，但**不在 `roleMap` 里，也就拿不到 `cId`，无法邀请**。

由此推出三条硬约束：

| 约束 | 说明 |
| --- | --- |
| **① 每支队伍必须使用自己队长的连接** | `roleMap` 随 `war_enterbattlefield` 的响应返回，而该响应属于某一条连接（某个角色）。所以一个连接只能服务它自己俱乐部的队伍 |
| **② 候选池按俱乐部独立** | 每个俱乐部一份「成员名册 ∩ roleMap」；排序、机动补齐都**只能在本俱乐部内进行**。跨俱乐部组队服务端必然拒绝 |
| **③ `sid` / `roleCodeId` 按角色，`battlefieldId` 可共享** | 同一场战斗里多个俱乐部共用同一个 `battlefieldId`，但 `sid` 是每个角色各自的一次性票据。所以每队都要走一遍 `legion_getbattlefield`（顺带拿到自己的 `sid`） |

**「俱乐部」这一层怎么拿到：**

- 一个 token 属于哪个俱乐部 → `role_getroleinfo` → **`body.role.legionId`**（抓包实测 = 5143405，同响应里还有 `serverId` / `serverName` / `name`）。`ensureConnection()` 内部已经会调这条命令。
- 本俱乐部的成员名册 → **`legion_getinfo`（无参数）返回的就是调用者自己的俱乐部**（抓包 `body.info.id = 5143405`，正是 406 的俱乐部）。所以**每队用自己队长的连接调一次 `legion_getinfo` 就拿到本俱乐部名册 + roleMap，天然按俱乐部隔离，不需要传俱乐部 id**。

> ⚠️ **不同俱乐部可能在不同战场。** master 已明确这些俱乐部并不都在同一场战斗里。所以**每队必须各自 `legion_getbattlefield` 取自己的 `battlefieldId`**：不能假设相同、不能跨队共享、不能因为"上一队拿到了"就跳过。当前设计本来就是每队各取一次，符合这一要求。


> 好消息：因为 `legion_getinfo` 与 `roleMap` 都以「连接自己的俱乐部」为准，俱乐部隔离是**自然成立**的 —— 只要坚持"每队一条自己的连接"，就不会串俱乐部。反过来，如果为了复用连接而让一个连接服务多支队伍，就会立刻错俱乐部。

**并发上的新问题（必须处理）：** 每队需要 **2 条 WebSocket**（主连接 + 战场连接）。现有 `batchSettings.maxActive` 只管主连接的槽位，战场连接没有纳入限流 —— 20 支队伍会变成 40 条 WS。需要给战场连接也加一层并发上限。

---

## 1.6 俱乐部发现：由「队长角色」反推，不手动选

master 明确：*「这些俱乐部并不都在一个战场的。所以，我们首先要知道有哪些俱乐部参与……但是选择俱乐部比较困难，所以我的设计是从 token 列表中选择角色，然后选中的角色就是队长了。这个可以在 token 管理或者批量任务界面，选好队长之后，俱乐部信息和队长信息自然也就有了。」*

### 关键认知

**用户手上只有 token 列表，他记不住也不关心 `legionId`。** 所以"选俱乐部"这个动作根本不该出现在界面上 —— 让用户选他熟悉的东西（角色），俱乐部信息作为**副产品**被推导出来。

### 四步流程（重排后）

```
① 选队长        【在 Token 管理 / 批量任务界面完成】
                勾选角色 → 每个勾选的角色 = 一支队伍的队长
                产物：saltFieldAutoLeaderTokenIds: string[]

② 同步角色信息   【自动盐场页，一次动作】
                遍历①的 token → 各自连接 → role_getroleinfo(+legion_getinfo)
                读出 roleId / legionId / legionName / 角色名 → 写入本地缓存
                产物：按 legionId 自动归组，得到「参与的俱乐部」清单

③ 每俱乐部设定队伍  【自动盐场页】
                因为 队伍 ⇔ 队长 是 1:1，这一步主要是：
                确认该俱乐部下有哪些队伍（= 哪些队长）、启用/禁用、改名

④ 每队设定队员     【自动盐场页】
                手动指定队员（主路径）/ 机动补齐（兜底）
```

### 字段来源（已实测确认）

| 要什么 | 从哪来 | 备注 |
| --- | --- | --- |
| 角色所属 `legionId` | `role_getroleinfo` → **`body.role.legionId`** | 抓包实测 = 5143405 |
| 俱乐部名 | `legion_getinfo`（**无参数**）→ **`body.info.name`** | 抓包实测 = "宾克斯✨酒馆"；返回的就是调用者自己的俱乐部 |
| 角色名 / roleId / serverId | `role_getroleinfo` → `body.role.{name, roleId, serverId, serverName}` | 同响应 |
| 主阵容（布阵用） | `role_getroleinfo` → `body.role` 顶层 `battleTeam` / `lordWeaponId` / `pet.petUId` | 同一条命令一次拿全 |

### ⚠️ 必须自己缓存（项目现状不支持直接复用）

`tokenStore.gameData` 是一个**全局单例 `ref`**，只保存"当前连接的那个角色"的信息，**不是 per-token 缓存**。所以同步阶段的结果必须我们落盘：

```jsonc
"saltFieldAutoRoleCache": {
  "<tokenId>": {
    "roleId": 664483911,
    "roleName": "世界国皇帝",
    "legionId": 5143405,
    "legionName": "宾克斯✨酒馆",
    "serverId": 26528,
    "updatedAt": 1789216811
  }
}
```

意义：
- 界面在**没连接**的情况下也能渲染出俱乐部分组（用缓存）
- 同步阶段只跑一次，不必每次进页面都连一遍
- 缓存要带 `updatedAt` 并支持**手动刷新**（换俱乐部/改名后需要更新）

### 成本提示

"同步角色信息"这一步需要**为每个队长 token 各建一次连接**（受 `maxActive` 限流）。N 个队长 ≈ N 次连接往返。这是可接受的（一次性、且可以并发限流），但**不能每次进页面都自动跑** —— 默认用缓存渲染，由用户点「同步」触发。



---

## 1. 分层与文件清单

```
协议层（纯增量，不动现有逻辑）
  src/utils/xyzwLegionWarWebSocket.js
    registerDefaultCommands() 追加 3 条：
      war_teamsetbattleteam   选阵容
      war_setbattleteam       登场
      war_invitejointeam      邀请组队
    （hint 已绑定 battlefieldId；CommandRegistry 已自动拼 ack/seq/time/body）

状态层
  src/stores/legionWarStore.js
    · 从 War_EnterBattlefieldResp.body 解析并暴露（**按连接隔离，一个连接一份**）：
        roleMap      roleId -> cId（**本连接所属俱乐部**的全部成员）
        roleCodeId   本连接的 cId
        roles        battlefield.roles（全场 436 人，含 isOnline/state/power 等）
        teamMap      组队结果（校验用）
        constant     TeamCd / Time 等
    · 新增 actions：enterBattlefield() / setBattleTeam() / deploy() / inviteJoinTeam(cId)
    · 每次 enter 后重置 roleMap（cId 每场重分配，禁止跨场缓存）
    · ⚠️ roleMap 不是全局的：它只覆盖本连接的角色所属俱乐部。**多俱乐部场景下必须每队一份，不能共享**
    · ⚠️ 不要复用 extractValidData()：它是给 UI 展示用的，只抽地图/俱乐部汇总/成员统计

编排层（复用现有批量基建）
  src/utils/batch/tasksSaltField.js   ← 新增，遵守 createTasksXxx(deps) 契约
    · 执行单位是**队伍**（不是账号、不是俱乐部）
    · 每队：1 条主连接 + 1 条战场连接，两条都要纳入并发限流
    · 直接白拿：ensureConnection()（含 role_getroleinfo + battleVersion 初始化）、
               connectionQueue 并发限流、addLog / isRunning / shouldStop / tokenStatus
  src/utils/batch/index.js            追加 export

UI 层
  src/views/SaltFieldAuto.vue         ← 新增（俱乐部 → 队伍 三级展开）
  src/router/index.js                 path: 'salt-field-auto'，title: '自动盐场'
```

---

## 2. 数据流（单队一次执行 = 最小执行单位）

```
⓪ 归属与候选          用队长自己的连接：
                     · role_getroleinfo → body.role.legionId（确定本队属于哪个俱乐部）
                       + roleInfo 写入 saltFieldAutoRoleCache（供离线渲染）
                     · legion_getinfo（无参数）→ 本俱乐部名册 info.members
                                              （roleId / name / power / online）
                     ↳ 这一步同时填充「本俱乐部候选池」，供机动补齐使用
① 主连接            ensureConnection(leaderTokenId)
                   ↳ 内部已调 role_getroleinfo（拿到 legionId + battleTeam / lordWeaponId / pet.petUId）
                   ↳ 内部已调 fight_startlevel（battleVersion，战斗类命令需要）
② 取战场元信息       legion_getbattlefield  → info.{ battlefieldId, sid, phase,
                                              startTime, endTime }
③ 连战场            new XyzwLegionWarWebSocketClient({
                        url: `.../agent?p=<token>&e=x&sid2=<sid>&lang=chinese`,
                        hint: battlefieldId })   ← 复用现有类，编码链路已验证正确
④ 进入战场           war_enterbattlefield { battlefieldId, useGzip: true }
                   ↳ 响应里取 **本俱乐部** 的 roleMap / 自己的 roleCodeId /
                     battlefield.roles / constant
⑤ 解析队员 cId       cId = roleMap[memberRoleId].cId
                   ↳ 不在 roleMap 里 ⇒ 该 roleId 不属于本队长的俱乐部，直接报错并跳过
                   ↳ 机动开启且人数不足 5 ⇒ 在本俱乐部候选池里按排序补齐（见 §3）
⑥ 选阵容            war_teamsetbattleteam { battlefieldId, battleTeam: Map(0..4 -> heroId),
                                            lordWeaponId, petUId }
                   ↳ battleTeam 由 role_getroleinfo 的 {i:{heroId}} 转 Map(i -> heroId)
⑦ 组队              for cId of teammates:  war_invitejointeam { battlefieldId, targetCodeId: cId }
                   ↳ 逐个发，间隔 ≥1s；每发一个用响应的 teamMap 校验 mCodeIds 是否 +1
⑧ 登场              war_setbattleteam（同 ⑥ 的 body）
                   ↳ 响应里 roles[自己cId] 应由 watching -> idle，并带 position
⑨ 校验              读 teamMap[自己cId].mCodeIds.length == 预期；否则报错并允许单队重跑
⑩ 清理              断开战场连接 + closeWebSocketConnection(leaderTokenId)
                   + 释放主连接槽位 + 释放战场连接槽位
```

**关键点：队友号完全不出现在这条链路里。** 只需要在配置里存放它们的 `roleId`，执行时用**本连接自己的** `roleMap[roleId].cId` 换算。

**多俱乐部时的执行模型：** 每支队伍独立走完 ⓪~⑩。俱乐部之间没有任何共享状态 —— 这是 §1.5 的强制结论，不是偷懒。


---

## 3. 候选池与排序

### 3.1 候选池的构造（**按俱乐部独立，每个俱乐部一份**）

```
对每个俱乐部 L：
  A(L) = L 的全部成员            来源：该俱乐部队长连接调 legion_getinfo（无参数）
                                  → body.info.members（key = roleId）
                                  字段：name / power / online（+ custom.s_power 备用）
  B(L) = L 在本场的可用成员        来源：同一连接的 War_EnterBattlefieldResp.body.roleMap
                                  （key = roleId，**只含 L 自己**）
  可用候选(L) = A(L) ∩ B(L)
  不可用(L)   = A(L) − B(L)        UI 上直接标「不可用（不在本场 roleMap）」并置灰
```

因为 `legion_getinfo` 与 `roleMap` 都以「连接自己的俱乐部」为准，**俱乐部隔离是自然成立的**：每队用自己队长的连接各取一份，不会串俱乐部。

实测（俱乐部 5143405）：A = B = 21 人，0 缺失 —— 同俱乐部成员本场全部有 `cId`。

**严禁跨俱乐部取人**：跨俱乐部组队服务端必然拒绝（`roleMap` 里根本没有对应 `cId`）。机动补齐也只能在本俱乐部候选池内进行。


### 3.2 排序规则：用 `online` 字段

master 指定：**① 不在线优先于在线 ② 高战力优先于低战力**。

关于 `online` 字段的语义，做过两轮核实（第二轮的结论推翻了第一轮）：

**第一轮结论（错误，已作废）**：认为 `roster.online` 不可用。理由是 21 人里有 7 人 `online == 0`，其中 2 人战场在线（`bf.isOnline == true`）、5 人战场离线 —— 同一个 `0` 对应两种状态，解释不通。

**错误原因**：把 `battlefield.roles[cId].isOnline` 当成了"游戏在线"。实际上它只表示**是否连着战场 WebSocket**，而 `roster.online` 表示**是否在游戏里在线**。两者是包含关系：

```
战场在线  ⊆  游戏在线
```

按这个正确框架重算，**零反例**：

| 检查项 | 结果 |
| --- | --- |
| `online != 0`（判为离线）却战场在线的反例数 | **0 / 14** |
| `online == 0`（判为在线）却战场离线的人数 | 5 人 —— 可解释为"游戏在线但没打开战场" |
| `online != 0` 的取值区间 | 09-12 05:54 ~ 20:27，**全部早于抓包时刻 20:40** → 是"最近在线时间" |

**结论：`online === 0` ⇒ 当前在线；`online !== 0` ⇒ 已离线，值 = 最近在线时间。** 语义成立，可直接用于排序。

字段来源与取用建议：

| 字段 | 来源 | 用途 |
| --- | --- | --- |
| `online` | `Legion_GetInfoResp.info.members[roleId].online` | ①离线/在线 分组（`=== 0` ⇒ 在线） |
| `power` | 同上（roster 快照） | ②组内战力降序。**优先用 roster 的 `power`**；`battlefield.roles[cId].power` 可能被战斗状态改写（本场 411：战场值 4.0e9 vs roster 值 1.02e10，是 21 人里唯一分歧样本） |
| `signInTime` | 同上 | 仅供参考，**不作为排序键**（本次已确认不使用） |

排序键：`isOffline desc, power desc`。

### 3.3 本场真实排序预览（21 人）

```
排名 | cId | name                    | 在线状态 | 势力         | 最近在线
 1   | 394 | FAN                     | 离线     | 1.2958e10 | 09-12 18:54
 2   | 405 | 不吃鱼                   | 离线     | 1.2722e10 | 09-12 20:27
 3   | 393 | 郭良郭影只想过平静的生活     | 离线     | 1.2663e10 | 09-12 19:12
 4   | 409 | 歪比巴卜                  | 离线     | 1.1334e10 | 09-12 20:00
 5   | 410 | 康康                     | 离线     | 1.1040e10 | 09-12 16:17
 6   | 401 | 酒馆✨C                   | 离线     | 1.0455e10 | 09-12 16:51
 7   | 408 | 不吃菜                   | 离线     | 1.0405e10 | 09-12 20:27
 8   | 395 | 不吃肉                   | 离线     | 1.0148e10 | 09-12 20:27
 9   | 407 | FAN                     | 离线     | 9.644e9  | 09-12 18:54
10   | 398 | 酒馆刨地仔                | 离线     | 9.606e9  | 09-12 20:00
11   | 400 | 鸡扣爱吃蛋挞              | 离线     | 8.492e9  | 09-12 05:54
12   | 397 | 完败啊                   | 离线     | 8.349e9  | 09-12 18:54   ← 已知队友号
13   | 403 | 轻舟过万重山              | 离线     | 7.936e9  | 09-12 19:40
14   | 396 | 完败啊                   | 离线     | 1.015e5  | 09-12 17:48   ← 已知队友号
15   | 392 | 不凡                     | 在线     | 1.2378e10 | —
16   | 402 | 淡然                     | 在线     | 1.1623e10 | —
17   | 399 | 天府♚白也                 | 在线     | 1.1119e10 | —
18   | 411 | 无尘灬                   | 在线     | 1.0204e10 | —
19   | 406 | 世界国皇帝                | 在线     | 9.967e9  | —             ← master 自己的号
20   | 412 | 驴生戟角                 | 在线     | 8.856e9  | —
21   | 404 | 电驴开车                 | 在线     | 7.108e9  | —
```

> 注意：因为**接受重复选中**，这个顺序每天基本不变（离线号只要不上线就一直排前面）。这是已知且接受的代价。

### 3.4 按排序切分队伍（**俱乐部内部切分**）

排序只在俱乐部内部做，切分也只在本俱乐部候选池内切。下面用俱乐部 5143405（21 人）演示，按 5 人一队切成 4 队：

```
俱乐部 5143405 宾克斯✨酒馆（21 人 → 4 队，余 1 人）
  队伍1  队长 394 FAN        队员 405 不吃鱼 / 393 郭良郭影 / 409 歪比巴卜 / 410 康康
  队伍2  队长 401 酒馆✨C     队员 408 不吃菜 / 395 不吃肉 / 407 FAN / 398 酒馆刨地仔
  队伍3  队长 400 鸡扣爱吃蛋挞  队员 397 完败啊 / 403 轻舟过万重山 / 396 完败啊 / 392 不凡
  队伍4  队长 402 淡然        队员 399 天府♚白也 / 411 无尘灬 / 406 世界国皇帝 / 412 驴生戟角
  剩余    404 电驴开车           ← 21 = 4×5 + 1
```

> 这只是「全自动模式」的参考。master 已说明**主路径是手动指定满员队伍**，这个切分只在需要一键铺满时用。

**多俱乐部时**：每个俱乐部各自独立切分，互不影响。总队伍数 = 各俱乐部的队伍数之和。


### 3.5 机动（mobile）

master 的原话：*「正常情况我都会指定满队伍的。你给选人按钮增加一个选项：机动（如果队伍不满 5 人的话），也对队伍整体增加一个选项：机动（机动队伍在不满 5 人时候会正确拉满 5 人，无机动则只拉指定的队员。）」*

归纳下来是同一个语义，落在两个入口上：

**核心语义**：`机动 = 队伍不满 5 人时，按 §3.2 的排序从候选池补齐到 5 人（含队长）。`

| 入口 | 类型 | 行为 |
| --- | --- | --- |
| **队伍行的「机动」开关** | 持久配置（`localStorage`） | 执行阶段生效：`mobile=true` 且指定队员 < 4 人 → 按排序补齐到 5 人；`mobile=false` → 只用指定队员，有几个组几个（最少只有队长 1 人） |
| **「补齐」按钮上的「机动」选项** | 一次性动作 | 勾选 = 只处理当前不满 5 人的队伍，已满 5 人的队伍不动；不勾选 = 按排序重新填充（语义是"重建"，会覆盖原有指定） |

补齐时的取人顺序（按排序，跳过已被占用的号）：

```
候选取 = 排序后的候选池 − 队长自己 − 已被其他队伍占用的人
按序取 (5 − 当前队伍人数) 个
```

**示例**（用本场真实数据）：队长 `406 世界国皇帝` 已指定队员 `397`、`396`。

- 机动开启 → 按排序取前 2 名补齐：`394 FAN`（离线, 1.2958e10）、`405 不吃鱼`（离线, 1.2722e10）→ 队伍 = 5 人
- 机动关闭 → 队伍保持 3 人（队长 + 397 + 396），只对 3 人发邀请

**跨队伍占用**：同一个俱乐部的补齐必须全局去重（一个号只能进本俱乐部的一队）。多队同时机动时，按队伍顺序依次分配，先到先得；UI 上要把"已被队伍 N 占用"标出来。跨俱乐部不存在这个问题（roleId 不会重复）。


---

## 4. 配置态 vs 运行态（必须分开）

| | 内容 | 存储 | 变化频率 |
| --- | --- | --- | --- |
| **配置态** | 俱乐部清单与开关、队伍编排（legionId + leaderTokenId + memberRoleIds[] + `mobile`） | `localStorage` | 用户手动改，跨天持久 |
| **运行态** | 每队自己的 `battlefieldId`、`sid`、`roleMap`、`cId`、`teamMap`、`TeamCd` 倒计时 | 内存（Pinia store，**按队伍 key 隔离**） | **每场重取，禁止持久化** |

理由：`cId` 每场重分配；`sid` 是一次性票据；`roleMap` 只对某一条连接所属俱乐部有效。
界面上要把这个区别表现出来 —— **配置里显示 `roleId`（稳定），日志里显示 `cId`（每场变）**。

### localStorage schema 建议

```jsonc
// ① 队长角色（在 Token 管理 / 批量任务界面勾选产生）
//    这是唯一的"入口数据"，俱乐部由它反推
"saltFieldAutoLeaderTokenIds": ["<token.id>", "<token.id>"],

// ② 角色信息缓存（同步阶段写入，供离线渲染俱乐部分组）
"saltFieldAutoRoleCache": {
  "<token.id>": { "roleId": 664483911, "roleName": "世界国皇帝",
                  "legionId": 5143405, "legionName": "宾克斯✨酒馆",
                  "serverId": 26528, "updatedAt": 1789216811 }
},

// ③ 俱乐部层（**由 ② 推导，不手动增删**；这里只存用户改过的开关）
"saltFieldAutoClubs": {
  "5143405": { "enabled": true }
},

// ④ 队伍层（最小执行单位）：扁平数组，用 legionId 归组
//    队伍 ⇔ 队长 1:1，所以 leaderTokenId 唯一；legionId 可从 ② 查到，冗余存一份便于渲染
"saltFieldAutoTeams": [
  { "id": "5143405-664483911", "legionId": 5143405,
    "leaderTokenId": "<token.id>",            // 队长（需登录 + 连战场）
    "name": "队伍 1",                          // 默认取队长角色名，可改
    "enabled": true,
    "memberRoleIds": [682283004, 714928789],  // 稳定键，用 roleId
    "mobile": true }                          // 机动：不满 5 人时按排序补齐
],

"saltFieldAutoSettings": {
  "inviteIntervalMs": 1200,     // 逐个邀请的间隔（≥1s）
  "teamCdWaitMs": 10000,        // TeamCd 窗口
  "enterTimeoutMs": 15000,
  "maxActiveBattlefield": 3     // 战场连接并发上限（见 §1.5，需与 maxActive 分开）
}
```

> 只需 `roleId` 就能组队 —— 执行时用**本队连接的** `roleMap[roleId].cId` 换算。所以队友的 token 可以不在本地、可以从未登录。

> 俱乐部清单（③）**不存 id 列表**：它每次都从 ② 的角色缓存 `groupBy(legionId)` 推导。用户勾掉一个队长 token，对应俱乐部若没有其它队长就自动消失 —— 不需要额外的增删逻辑。


---

## 5. 界面结构（三层 + 两个界面协作）

### 5.1 第一步在别的页面：Token 管理 / 批量任务界面选队长

```
Token 管理（/tokens）或 批量日常（/admin/batch-daily-tasks）
  · 复用现有的 token 勾选交互
  · 每个 token 行新增一个「盐场队长」开关 / 或工具栏「将选中项设为盐场队长」
  · 选完即写入 saltFieldAutoLeaderTokenIds，并跳转/提示到「自动盐场」页继续
  · 这一层完全不出现"俱乐部"概念 —— 用户只选角色
```

> 之所以放这两个页面：它们是用户已经在用的 token 列表入口，改造成本最低；而且批量日常已经有 `selectedTokens` 之类的多选状态，交互一致。

### 5.2 自动盐场页（`/admin/salt-field-auto`）

```
页头    自动盐场（副标题：进入战场 · 选阵容 · 组队 · 登场　|　俱乐部 → 队伍 → 角色）
        [活动状态 tag]  [同步角色信息]  [保存配置]  [一键执行]  [停止]
        ↑ 活动状态由 legion_getbattlefield 的 startTime/endTime 推算剩余时间
          （本场窗口 = startTime 20:00 → endTime 21:00 CST，正好等于 constant.Time = 3600s）
        ↑ [同步角色信息] 才建立连接去读 legionId/legionName；平时用缓存渲染
          未同步的队长显示为「未同步」灰态，不参与执行

指标行  俱乐部 K | 队伍 M（X 机动 / Y 固定） | 队长（需登录） | 队员（免登录） | 上轮入队成功数

左栏 ① 队伍编排（主卡，主路径）
        俱乐部分组（**由队长角色反推，不手动增删**；可折叠）：
          ┌ [▾] 5143405 宾克斯✨酒馆   21 人 · 2 队 · [启用 开关]
          │     队伍 1  ● | 队长 世界国皇帝 · 406 | 完败啊 · 397 | 完败啊 · 396
          │             | ＋空位 | ＋空位 | [机动 开] | [执行] [编辑] [删除]
          │     队伍 2  ○ | 队长 不凡 · 392 | 郭良郭影 · 393 | FAN · 394
          │             | ＋空位 | ＋空位 | [机动 关] | [执行] [编辑] [删除]
          └ [▸] 6789012 凤鸣·拾光   15 人 · 1 队 · [启用 开关]
                （折叠状态也要显示队伍数与是否有错误）
        · 每个俱乐部的队伍数 = 该俱乐部的队长角色数（含未启用的）
        · 「删除队伍」= 取消该角色作为队长（回到 Token 管理页也能做）
        · 队长不参与排序
        · 空位显示为虚线 chip；机动关闭时点击空位不能自动补人，只能手动加
        · 每队左侧状态点：watching（队长未登场）/ idle（正常）/ 失败 / 未执行
        · 缺员时行内黄条提示原因（本俱乐部可用成员不足 / 已被本俱乐部队伍 N 占用）
        · 卡片头按钮：[机动补齐] [展开全部 / 折叠全部]
            · [机动补齐] 带一个「仅处理不满 5 人的队伍」勾选（见 §3.5）
            · 补齐严格在本俱乐部内进行

左栏 ② 候选账号（次卡，机动补齐时的来源）
        · **按俱乐部聚合**（与 ① 同样的分组）；每行 name / roleId / 势力 / 在线状态 / 标签
        · 标签四态：队长 / 队员 / 可加入 / 不可用（不在本场 roleMap，置灰）
        · 每个俱乐部标题下显示该俱乐部「按规则排序后的前 N 名」预览
        · 候选池来自该俱乐部的 legion_getinfo，因此**必须先执行一次该队**才有数据；
          未执行过时显示「候选池需先执行一次以获取」

右栏   执行日志
        · 复用批量日常的日志卡：自动滚动 / 只看错误 / 错误计数 / 清空 / 复制 + 进度条
        · 日志行前缀带俱乐部与队伍，例如 `[5143405 / 队伍1]`，多俱乐部并行时才能分清
        · 日志行显示 cId 而非 roleId（因为组队用的是 cId）
        · 关键节点：定俱乐部 → 拉名册 → 进入战场 → 读 roleMap → 选阵容 → 逐个邀请 → 登场 → 校验
```

**一键执行的组织方式**：按队伍并行（受 `maxActive` / `maxActiveBattlefield` 限流），
日志按 `[俱乐部 / 队伍]` 前缀区分，避免多俱乐部并行时日志串线。

**不同俱乐部在不同战场**这点在界面上表现为：每个俱乐部分组各自显示自己的 `battlefieldId`
（未执行时不显示）。不提供"全军统一战场"的假设。

---

## 6. 未决项

已完成（前几轮定案）：排序字段（`online`）、重复选中副作用（接受）、布阵阵容来源（主阵容，无独立预设）、机动语义、层级模型（俱乐部 → 队伍 → 角色）、**俱乐部发现方式（由队长角色反推）**、**各俱乐部可能在不同战场**。

仍需确认 / 实测：

1. **队长角色缓存（`saltFieldAutoRoleCache`）的失效策略**：换俱乐部、改名、跨天后是否要强制重新同步？建议默认"进页面用缓存 + 手动同步"，另加一个"超过 N 天自动标记为过期"的提示。
2. **候选池数据的首次获取时机**：`legion_getinfo` 是在执行时拉（当前设计），所以**执行前界面看不到候选排序**。是否需要一个独立的「预热」动作（只连队长、拉名册、不执行动作）来提前填充候选池？
3. **战场连接的并发上限取值**：每队 2 条 WS（主 + 战场）。需定 `maxActiveBattlefield` 的值，并确认服务端对同 IP 多连接是否有限制。
4. **`legion_getbattlefield` 的 `canEnterWar` 字段**：抓包里为 `true`。若为 `false`（例如该俱乐部本场未参战），该俱乐部的队伍应整体跳过 —— 需要确认未参战时的取值。
5. **`war_getbattlefieldinfo` 的实际请求体**（项目现有代码按 `{ battlefieldId }` 发送，需实测）。
6. **`war_startattackbuilding` / `war_useResurrect` / `war_kickoutteam` / `war_leave` / `war_changepos` 的请求体**（本次抓包未捕获；第一步不需要，但后续要补）。
7. **`3000070` 的归因验证**：把入口上报的 `platformExt` 从 `h5web` 改为 `mix` 后 `war_startbattle` 是否恢复（仅当以后需要攻击时才做）。



