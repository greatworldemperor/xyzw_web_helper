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
- **邀请流程**：占位 → `teamLimitTime`（+8s）准备期 → 正式入队 → **全员就位才能登场**。
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
