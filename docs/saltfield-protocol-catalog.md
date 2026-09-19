# 盐场（军团战）协议指令全表

> 数据来源：2026-09-19 首战实测
> - 自动盐场 WSS 录制 `local-data/saltfield/260919_autofield.jsonl`（4446 帧，6 个战场 24 队）
> - runtime 抓包 `local-data/saltfield/saltfield_runtime_wss/`（6 个 jsonl，1108 send / 10267 message）
> - 提取脚本：`local-data/saltfield-analysis/_extract_commands.mjs`（144 个命令）
>
> 用途：为后续功能扩展做技术储备。表中「已实现」指 `src/utils/legionWarSession.js` 是否已有封装。

## 1. 战场连接生命周期

```
legion_getbattlefield（主连接）→ 拿 battlefieldId / sid / canEnterWar
        ↓
战场 WS：war_enterbattlefield{useGzip:true} → 全量快照（roleMap / roles / teamMap / constant）
        ↓
war_teamsetbattleteam（布阵，不改变位置）
        ↓
war_invitejointeam × N（邀请队员，逐个）
        ↓  等全员正式入队（teamLimitTime 过期，约 +8s）
war_setbattleteam（登场：提交阵容并落到地图）
        ↓
war_startmarch（行军）/ war_startattackbuilding（攻击建筑）/ war_speedup（加速）
```

- 心跳：`war_ping`（约每 5 秒）
- 快照刷新：`war_getbattlefieldinfo`（等待模式的轮询用）

## 2. 可执行动作（send 命令）

### 2.1 盐场专用

| 命令 | 实测次数 | 请求体字段 | 已实现 | 备注 |
|---|---|---|---|---|
| `war_enterbattlefield` | 22 | `battlefieldId`, `useGzip` | ✅ | 进入战场，响应为全量快照 |
| `war_ping` | 284 | `battlefieldId` | ✅ | 心跳 |
| `war_teamsetbattleteam` | 18 | `battlefieldId`, `battleTeam`, `lordWeaponId`, `petUId` | ✅ | 选阵容/布阵，不改位置 |
| `war_setbattleteam` | 9 | 同上 | ✅ | **登场**（watching → idle） |
| `war_invitejointeam` | 101 | `battlefieldId`, `targetCodeId` | ✅ | 邀请入队 |
| `war_getbattlefieldinfo` | 2 | `battlefieldId` | ✅ | 拉全量快照（09-16 新增） |
| `war_startmarch` | 15 | `battlefieldId`, `target{x,y}` | ❌ | **行军**：可自动化 |
| `war_startattackbuilding` | 20 | `battlefieldId`, `buildingId` | ❌ | **攻击建筑**：实测 20 次全部成功、0 错误 → 可自动化 |
| `war_speedup` | 23 | `battlefieldId`, `marchId` | ❌ | 加速行军 |
| `war_adjustteampos` | 4 | `battlefieldId`, …（待补） | ❌ | 调整队伍位置 |
| `war_startbattle` | 3 | `battlefieldId`, `targetCodeId` | ❌ | **PVP：被服务端 3000070 拒绝**（见 §5） |

### 2.2 主连接（俱乐部/战场入口）

| 命令 | 次数 | 字段 | 已实现 | 备注 |
|---|---|---|---|---|
| `legion_getbattlefield` | 9 | — | ✅ | 拿 battlefieldId / sid / canEnterWar |
| `legion_getinfo` | 9 | — | ✅ | 本俱乐部成员名册（roleId→power/online） |
| `legion_getopponent` | 4 | `phase`, `battlefieldId` | ❌ | 对手信息 |
| `mail_getbattlefieldreportlist` | 4 | `lastId`, `category`, `size` | ❌ | 战场战报 |
| `saltroad_getwartype` | 2 | `date` | ❌ | 盐路战场类型 |
| `legionwar_getmajoreventslist` | 2 | `date` | ❌ | 大事件列表 |

## 3. 广播与响应（recv）

主要命令（次数为两侧合计）：

| 命令 | 次数 | 关键内容 |
|---|---|---|
| `war_speedupresp` | 1976 | 行军/加速状态 |
| `war_startattackbuildingresp` | 1804 | `battleInfo{id,battleType,leftCodeId,rightCodeId,startTime,endTime,isWin}` |
| `war_endattackbuildingnotify` | 1785 | 攻塔结束 |
| `war_startmarchresp` / `war_endmarchnotify` | 626 / 622 | `marches{marchId…}` |
| `war_invitejointeamnotify` | 548 | **邀请状态通知**（含准备期弹回） |
| `war_setbattleteamresp` | 533 | 登场广播（全场可见，无法据此归因自己） |
| `war_invitejointeamresp` | 386 | 邀请响应（带 `teamMap` 更新 + 目标完整字段） |
| `war_startbattleresp` | 296 | `battleType=1` PVP 广播 |
| `war_endbattlenotify` | 285 | `winCodeId` |
| `war_resurrectnotify` | 232 | 复活 |
| `war_adjustteamposresp` | 144 | `teamMap` + `memberCodeIdList` |
| `war_teamsetbattleteamresp` | 88 | `roleCodeId` |
| `war_enterbattlefieldresp` | 74 | 全量快照：`roleMap`/`roles`/`teamMap`/`constant`/`legionWarMap` |
| `war_kickoutteamresp` | 3 | 踢出队伍 |
| `war_suicideresp` | 1 | 自杀/撤退 |

⚠️ **`war_setbattleteamresp` 等是全场广播**：不能用来判断"我的命令是否生效"，只能看状态变化。

## 4. 关键机制

### 4.1 邀请 = 占位 → 准备期 → 正式入队

1. `war_invitejointeam` 发出后，服务端**立即**把目标放进 `teamMap[队长].mCodeIds`（**占位**），目标 `state=teaming`，响应同帧返回
2. 响应里目标带 **`teamLimitTime` = 邀请时刻 + 8 秒**（260 样本统计：7s×1 / 8s×168 / 9s×91，中位 8s；9s 由时间戳取整造成）
3. **过了 `teamLimitTime` 即「正式入队」，此后该字段消失**
4. **全员正式入队后才能登场**；任何一人仍在准备期 → 整个队伍无法登场（master 实战语义，与 348 队数据吻合：deploy 早于队员到期 9 秒 → 失败）

> 判定式：`正式入队 = 队员在 mCodeIds 中 && (无 teamLimitTime || now >= teamLimitTime)`
> **mCodeIds 满员 ≠ 能登场**（首战：9 队满员，仅 4 队成功登场）

### 4.2 自身身份 roleCodeId

- `state.roleCodeId` 是「本连接自身」的编号，**绝不能跟随广播帧的 `body.roleCodeId`**（那是别人的）
- 实测每条连接上带 `roleCodeId` 的帧涉及 15~182 个不同 cId，旧逻辑被改写 139~542 次
- **正确判据**：用「自己的 roleId」在本俱乐部 `roleMap`（roleId→cId）里反查；`roleMap` 只在全量快照帧带，增量广播不带 → 身份永不漂移

### 4.3 cId 唯一性

- **同一战场内 cId 唯一**
- **跨战场 cId 会复用**：376 在 1524=momo302，在 1543=星源☆欢喜，在 1428=解散11号
- ⇒ 分析多战场数据时**必须按 battlefieldId 分组**

### 4.4 角色 state 机

`watching`（未登场未入队）→ `teaming`（已入队/准备中）→ `idle`（已登场）→ `combat`（战斗中）→ `die`（阵亡，等待 `reviveTime`）

- `teaming` + `position(-1,-1)` = **未真正登场**（登场失败的瞬态/失败态）
- `die(x,y)` 有坐标 = 登场成功后战死，**不算登场失败**

## 5. 错误码

| code | 文案 | 首战次数 | 处理建议 |
|---|---|---|---|
| **3000070** | 检测到您使用的客户端数据异常 | 3 | **仅出现在 `war_startbattle`（PVP）**；攻击建筑/行军/登场均不触发。⇒ 不是平台口径问题，是 **PVP 动作被服务端拦截**（推测需客户端战斗数据/签名）。**红线：不要自动化 PVP** |
| 3000430 | 被邀请玩家不在观战状态 | 14 | 该队员已登场/被组走 → 换下一位候选 |
| 3000440 | 被邀请玩家已经被邀请了 | 4 | 已被别人邀请 → 换人 |
| 3000460 | 邀请的玩家队伍已满 | 2 | 换人 |
| 3000060 | 您正在行军路上 | 6 | 等待行军结束再操作 |

⚠️ 代码目前**未解析这些错误码**（只 waitForState 超时 → 日志"未确认"）。应监听并据此换人。

## 6. 可扩展方向（按价值排序）

1. **登场后自动攻击建筑** (`war_startattackbuilding`)：实测 20/20 成功。master 说明「上场有战斗记录即可拿低保（含攻击建筑）」→ **自动化可完整覆盖低保目标**
2. **自动行军** (`war_startmarch`)：移动到建筑/目标附近
3. **加速** (`war_speedup`)：缩短行军时间
4. **战报采集** (`mail_getbattlefieldreportlist`)：战后数据统计

## 7. 待逆向清单

| 目标 | 现状 | 需要的数据 |
|---|---|---|
| **「确认入队」命令** | 未捕获 | runtime 收到邀请弹窗时**点确认**并抓包（当前自动化靠队员挂 runtime 或等 8 秒自动入队） |
| `war_adjustteampos` 完整字段 | 仅知 battlefieldId | 游戏内调整队伍位置时抓包 |
| `war_speedup` 的 `marchId` 来源 | 未知（应来自 `war_startmarchresp.marches`） | 已可推断，待验证 |
| PVP 的 3000070 校验细节 | 仅知被拒 | 需官方客户端 PVP 抓包对比 |

## 8. 红线

- 🚫 **绝不自动化 PVP（`war_startbattle`）**——必被 3000070 拒绝，且可能触发风控
- 🚫 不要高频重复被拒命令（3000070/3000430 等）——记录原因后换目标
