# L2 · 盐场（军团战）

> 页面：`src/views/SaltFieldAuto.vue`（`/admin/salt-field-auto`，自动盐场控制面）、`src/views/LegionWar.vue`（旧战场地图展示）
> 实现：`src/utils/batch/tasksSaltField.js` · `src/utils/saltFieldConfig.js` · `src/utils/legionWar.js` · `legionWarSession.js` · `legionWarState.js` · `src/utils/xyzwLegionWarWebSocket.js` · `src/utils/clubWarrankUtils.js` · `src/stores/legionWarStore.js`
> 文档：`docs/saltfield-protocol-catalog.md`、`saltfield-auto-ui-design.md`、`saltfield-deploy-team-enter-feasibility.md`

## 1. 🔴 两条连接链路（关键结构差异）

| 链路 | 说明 |
|---|---|
| **主连接**（普通游戏 WS） | 查询战场元信息、俱乐部名册、匹配对手；`legion_getbattlefield` / `legion_getinfo` 等 |
| **盐场专用连接** | `xxz-xyzw-new.../agent?p=&sid2=<sid>`（**一次性票据**，由 `info.sid` 构造）；`war_*` 全部走这里 |

- 专用客户端：`src/utils/xyzwLegionWarWebSocket.js`；状态：`src/stores/legionWarStore.js`。
- 盐场连接须有**独立并发上限** `maxActiveBattlefield`（不能和主连接共用一个池）。
- ⚠️ **不能拿建连前的旧 token 引用去拼战场连接地址**（`buildLegionWarUrl` 两处均已改为重新取值）——role token 短命，必须按需刷新后再取值。

## 2. 命令清单与实现状态

| 命令 | 链路 | 参数 | 状态 |
|---|---|---|---|
| `legion_getbattlefield` | 主 | — | ✅ 已实现（取 `info.battlefieldId` / `info.sid` / `info.phase` / `canEnterWar`） |
| `legion_getinfo` | 主 | — | ✅ 已实现（本俱乐部成员名册、`warMap`/`warRank`） |
| `legion_getopponent` | 主 | `{phase, battlefieldId}` | ✅ 返回 `opponentList`（`ClubWarrank.vue`） |
| `legion_getinfobyid` | 主 | — | ✅ 俱乐部详情（战力/红淬/阵容） |
| `rank_getroleinfo` | 主 | — | ✅ 角色详情补充 |
| `war_enterbattlefield` | 战场 | `{battlefieldId, useGzip:true}` | ✅ 进入实时战场，返回**全量快照**（`roleMap`/`roles`/`teamMap`/`constant`） |
| `war_getbattlefieldinfo` | 战场 | `{battlefieldId}` | ✅ 拉实时快照（等待模式轮询） |
| `war_teamsetbattleteam` / `war_setbattleteam` | 战场 | — | ✅ 选阵容 / 登场 |
| `war_invitejointeam` | 战场 | `{targetCodeId}` | ✅ 邀请组队 |
| `war_ping` | 战场 | — | ✅ 5s 心跳（由 `heart_beat` 映射） |
| `war_startmarch` | 战场 | — | ❌ **未实现** |
| `war_startattackbuilding` | 战场 | `{buildingId}` | ❌ **未实现**（bin-test 实测 **20/20 成功**，可自动化） |
| `war_speedup` | 战场 | `{marchId}` | ❌ 未实现 |
| `war_adjustteampos` / `war_kickoutteam` / `war_leave` / `war_resurrect` | 战场 | — | ❌ 未实现 |
| `war_startbattle`（PVP） | 战场 | `{targetId}` | 🔴 **3000070 拒绝，禁止自动化** |

**已实现范围**：进战场 → 选阵容 → 组队 → 登场（**不含行军 / 加速 / 攻击**）。

## 3. 关键机制

- **`roleMap`（本俱乐部 roleId → cId）只在 `war_enterbattlefield` 的**快照帧**里带，增量帧不带**；按连接所属俱乐部隔离。
- **邀请流程**：占位（mCodeIds 即收入）→ `teamLimitTime`（**+10s**）→ **离线号服务端自动同意**（teaming→watching，详见 §10）→ **全员就位才能登场**。
- **队员无需登录/进场**：只要其 roleId 在 `roleMap`（同俱乐部）即可。
- **cId 每场重分配** ⇒ **禁跨场缓存**。
- **阵容来源**：直接取 `role_getroleinfo` 的**主阵容**（`battleTeam` / `lordWeaponId` / `petUId`）。
- **上限 5 人**；**跨俱乐部组队必拒** ⇒ 候选池按俱乐部独立维护。

## 4. 可行性结论

- 7 条命令**逐字节 byte-exact 复现** ⇒ **轻量方案（脱离 H5 runtime）确认可行**。
- 单队消耗 = **1 主连接 + 1 战场连接**（须独立并发上限）。
- 旧战场快照原始内容远比 UI 展示丰富（`battlefield.buildingData` / `legions` / `roles`）；研究底层状态时应保留 `war_getbattlefieldinfo` 的完整 `message.rawData`，别只看 `legionWar.js` 的 `extractValidData()`。

## 5. UI 现状（`SaltFieldAuto.vue`）

三层结构：**俱乐部 → 队伍 → 角色**；已有：同步角色信息、名册池/战场池、机动补齐、**立即 + 等待两种执行模式**、单队执行 + 一键执行。
**范围仅到「进战场 → 选阵容 → 组队 → 登场」，不含行军/加速/攻击。**
（双执行模式语义：默认先"立即"跑首测，再用"等待"验证后批量。）

## 6. 🔴 3000070 现状与归因

- **只有 `war_startbattle`(PVP) 触发**；`war_enterbattlefield` / `teamsetbattleteam` / `invitejointeam` / `setbattleteam` / `startmarch` / `speedup` **均成功** ⇒ **非"h5 平台整体禁用"**。
- 归因：本号是全场唯一 `platformExt: "h5web"`（非官方 H5 入口）；`hortor-h5` 平台有 6 次正常发起战斗。
- 待验证：`public/game/first-frame-spoof.js` 把首帧口径改成 `mix` / `h5` 后 PVP 是否恢复（**仅当将来需要攻击时才做**）。
- 09-26 runtime 补充：**官方 H5 客户端**在我们 runtime 里登场/打建筑/邀请全成功，唯 `war_startbattle` 同样被 3000070 拒（请求体与协议客户端逐字段一致）⇒ **命令结构非差异点**，拦的是会话口径或客户端完整性（runtime 里 PLATFORM 被覆写、WebSocket 构造器带 `__pushResearchWrapped` 标记、`prototype.send` 非 native，全是可检点）。
- 🔴 测量陷阱：runtime 抓包 tap 在**实例层**包 `socket.send`（先执行），first-frame-spoof 在**原型层** hook（后执行）⇒ 抓包显示的 h5 口径是**改写前字节**，不能当 spoof 未生效的证据；判定必须读页面「读取改写状态」→ `__xyzwFrameSpoof.stats.patched`。
- 🔴 红线：**绝不自动化 PVP、勿高频重试被拒命令**。

## 7. ⏱️ 每周节奏约束（影响迭代方式）

- 军团战**每周开打**，实测窗口**仅限开战时段**（09-13 首战、09-19 首战抓包）。
- **每次改口径需等下周开战验证 ⇒ 迭代周期以"周"为单位**。
- 09-21 已写 SOP：下周盐场**先只观察、校准 frame-spoof**，不急着自动化。

## 8. `../scripts` 里的 Userscript（协议线索来源，注意甄别）

仓库旁侧 `scripts/` 有四份注入真实游戏 H5 的脚本（**不是**主项目协议封装，依赖游戏页面运行时）：
- `自动盐场.js`：`enterAnonymousWar` / `goto` / `sendGetBattlefield(Info)` / `deployData.sendSetBattleTeam` / `sendStartMarch` / `sendSpeedUp` / `sendStartAttackBuilding` / `sendStartBattle` / `sendUseResurrect` / `sendInviteJoinTeam` / `sendKickOutTeam` / `sendLeave` / `sendChangePos` / `sendGetTeamInfo`。**`sandbox:true` 分支是本地伪造，必须排除在协议推断之外**（默认 `sandbox:false` 才调真实模块）。
- `全自动蟠桃园.js`、`新锁头盐场阵容.js`、`盐场攻击弹窗不消失(1).js`（后者是 UI 补丁，但内含真实的 `LEGION_WAR.sendStartBattle(targetId)` 调用，应拆开判断）。

**甄别铁律**：纯 UI 模拟 < 真实 H5 模块调用 < 直接 BON/WebSocket 通讯（证据强度递增）；sandbox/mock 分支**不能证明服务端接口存在或请求成功**。

## 9. 盐场红线

1. 战场连接地址必须**用刷新后的 token 重新取值**，别复用旧引用。
2. `roleMap` 只在快照帧带；cId 每场重分配，**禁跨场缓存**。
3. 跨俱乐部组队必拒；候选池按俱乐部独立。
4. 战场连接须独立并发上限，别与主连接共用池。
5. **绝不自动化 PVP**；被 3000070 拒绝后**不要高频重试**。
6. `sandbox` 分支不构成协议证据。
7. 改口径要预留**一周**验证周期。

## 10. 🔴 09-26 登场事故复盘与修复（deploy 假成功）

**事故**：09-26 自动盐场 16 支队伍全部「表面登场成功」，实际 **0 登场**（"我印象中一个都没有"属实）。

**根因链**（离线复刻定量实锤）：
1. 离线号邀请后 **+10s 服务端自动同意**（此前"+8s 准备期 / 未确认弹回"是误读）：`teaming→watching`、`teamLimitTime` 清 0、**mCodeIds 保留**；**~1s 后队长才翻 watching**。
2. 自动流在「最后一个队员就位」的同一瞬间调 `deploy()`，此刻队长自身 state 仍是 `teaming`（他翻 watching 的通知晚 ~1s 才到）。
3. 旧判据 `state!=='watching'` 把 `teaming` 当成已登场 → `dp.ok` **同步 true** → 毫秒级 verify + closeProbe 关连接。
4. 战场 WS 发送队列 50ms/tick，连接在 tick 前被关 → **`war_setbattleteam` 从未上线**（抓包实录：本连接最后一个就位通知后 0 帧）。

**修复（d4bcf246，09-27 已上线）**：
- `legionWarState.js`：`DEPLOYED_STATES=['idle','combat','march']` + `isDeployedState/isRoleDeployed` —— **deploy 唯一成功判据**。
- `legionWarSession.deploy()` 等 `isRoleDeployed` 真确认（等待期间连接保活，帧必上线）；新增 `closeAsync()` = `flushSendQueue()` → close。
- `xyzwLegionWarWebSocket.flushSendQueue(2000)`：closeProbe 前排空发送队列（连接已死直接返回不空等）。
- `tasksSaltField.closeProbe` 改 async 走 closeAsync；接住 deploy 返回值（顺修单人队 verify 分支 `dp is not defined` 潜伏错）。
- `SaltFieldAuto.vue`：状态 pill/圆点只认真登场；teaming → 「组队中」。
- 回归测试 `test/saltfieldDeploy.test.js` 7 例（合成帧复刻抓包序列 + 旧判据 bug 锚点断言）。

**状态语义（定稿）**：`watching`=已组队未登场（可点登场）/未组队可被邀请；`teaming`=邀请放置期；`idle/combat/march`=已登场。

**等待方式审计**：登场链路全部事件驱动（帧到即过，timeout 仅为放弃上限）；剩余 sleep 均为节奏/重试/本地信号量；`isMemberSettled` 的时钟成分用的是服务器预告的 `teamLimitTime` 截止时刻（帧优先、时钟兜底），保留。

**离线复刻验证法（可重建）**：真实抓包帧 → 驱动真实 `legionWarState` 状态机 → 模拟时钟=帧时间戳 → `runUntil(全员就位)` 就地暂停评估两版判据（不偷看未来帧）→ 与抓包实录逐项硬对照。09-26/27 实测：4 名队员模拟就位时刻 vs 抓包 notify 误差 ≤42ms（轮询粒度）；登场确认 12:54:54.810 vs 真帧 54.790；旧判据三次假成功全部复刻。
⚠️ 原始抓包与复刻脚本（`local-data/saltfield/260926_data/`）已在 09-28~10-01 清理中丢失（10-02 的 7z 存档里也没有）——方法与结论以本节和回归测试为准；下次盐场实战录制的新抓包将作为新的成功基准。
