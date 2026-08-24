# 项目当前上下文

> 这是一份面向后续开发和代码分析的快速交接文档。
>
> 内容基于 2026-08-20 对当前工作区源码、配置和测试结果的核对。遇到本文与源码冲突时，以当前源码和验证结果为准；已知问题集中记录在 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

## 1. 项目定位

这是一个基于 Vue 3 + Vite 的 XYZW 游戏自动化前端工具，核心能力是：


项目没有一个与前端配套、且当前完整存在于仓库中的业务后端。生产部署主要面向 Cloudflare Pages，`worker.js` 被复制为 `dist/_worker.js`，用于固定上游接口代理。


- Vue 3.5 + Composition API + `<script setup>`
- Vite 5
##### 脚本信息的协议参考判定

后续自动蟠桃和自动盐场开发应按“脚本实际触达的层级”判断参考价值，不能把所有 Userscript 等价看待：

- **纯 UI 模拟**：只查找按钮、触发点击、修改页面节点或拦截界面回调的脚本，只能参考操作流程、状态判断和交互时机，不能据此确认服务端命令、参数或成功条件。
- **真实 H5 模块调用**：脚本通过 `ModuleManager.GET_MODULE(...)` 取得 `LEGION_WAR`/`LEGION_PAYLOAD`，再调用真实模块的 `send*` 方法时，动作会交给游戏内部网络层编码并发送。此类脚本可以直接参考真实动作顺序、参数语义、前置状态和轮询策略，是当前自动蟠桃/自动盐场最有价值的协议线索。
- **直接 BON/WebSocket 通讯**：脚本若自行构造请求包、编码 BON body 或直接调用 WebSocket，则可以进一步直接参考 `cmd`、请求体和响应匹配方式；这是比方法级调用更强的协议证据。
- **sandbox/mock 分支**：只修改本地伪造的战场、角色或方法返回值，不能证明服务端接口存在或请求成功。`自动盐场.js` 的 `sandbox: true` 路径必须排除在协议推断之外。
- **混合脚本**：同一脚本可以同时包含 UI 补丁和真实协议调用。`盐场攻击弹窗不消失(1).js` 的弹窗修改属于 UI 行为，但其中 `LEGION_WAR.sendStartBattle(targetId)` 仍然是一个可追踪的真实动作调用；应拆开判断，不能因为外层改 UI 就否定该调用。

因此，当前工作结论是：`全自动蟠桃园.js`、`自动盐场.js` 和 `新锁头盐场阵容.js` 的真实分支具有直接开发参考价值；它们已经证明了进场、布阵、行军、加速、攻击、拾取、用车道具、复活和组队等动作会通过游戏协议层执行。但它们仍没有单独证明每个动作的底层命令名、完整 BON body、响应类型或错误码，不能仅凭方法名直接在主项目中盲发请求。

后续应把每个动作整理成以下映射并逐项验证：

```text
H5 方法
  -> 内部网络方法/请求类
  -> cmd
  -> BON body 参数及类型
  -> 连接类型（普通游戏连接或盐场战场连接）
  -> 成功响应、状态推送和错误码
  -> 冷却、限流、消耗和失败重试规则
```

“游戏指令大概率共用同一套路子”的假设可以作为反查方向，但不能提前当作事实：当前项目已确认盐场存在 `war_enterbattlefield`/`war_getbattlefieldinfo` 的专用连接链，蟠桃动作和盐场动作是否共用完全相同的连接、命令前缀和响应机制，仍需从 H5 方法实现或真实收发报文确认。协议一旦确认，就可以复用当前 `XyzwWebSocketClient`、`CommandRegistry` 和 `tokenStore.sendMessageWithPromise()`，再实现自动蟠桃、自动盐场的任务编排；在此之前，不能把 UI 资源已加载或 H5 方法名存在误认为 Vue 页面已经具备可用的游戏会话。

- Pinia 2
- Vue Router 4
- Naive UI 和 Arco Design Vue
- VueUse
- TypeScript 与 JavaScript 混合
- BON 协议、LZ4、CryptoJS、P-Queue、IndexedDB
- 包管理器：`pnpm@10.19.0`

应用入口：

- [src/main.js](src/main.js)：注册 Vue、Pinia、Router、Naive UI，初始化主题并挂载应用。
- [src/App.vue](src/App.vue)：全局 Naive UI Provider、主题状态和根路由视图。
- [vite.config.js](vite.config.js)：插件、别名、开发代理和 Worker 构建后复制逻辑。
- [package.json](package.json)：依赖和开发脚本。

## 3. 核心模块地图

### 状态层

[src/stores/tokenStore.ts](src/stores/tokenStore.ts) 是当前主要状态中枢，负责：

- `gameTokens`、`selectedTokenId`、`tokenGroups` 等本地持久化状态。
- Token 导入、Base64 解析、校验、选择、更新和删除。
- 自动 Token 刷新：URL、BIN 和微信扫码来源均由 `attemptTokenRefresh()` 统一处理；刷新结果必须是包含有效 `roleToken` 的 JSON 加密 Token。
- WebSocket 连接状态、连接锁、跨标签页连接协调。
- 角色信息、军团信息、活动、塔、队伍、战斗版本和学习状态等 `gameData`。
- 消息处理、事件分发、任务运行状态和部分连接池逻辑。

相关遗留模块仍存在：

- [src/stores/auth.js](src/stores/auth.js)：旧认证兼容层。
- [src/stores/gameRoles.js](src/stores/gameRoles.js)：旧角色管理逻辑。
- [src/stores/localTokenManager.js](src/stores/localTokenManager.js)：较早的本地 Token 管理实现。
- [src/stores/common.ts](src/stores/common.ts)：当前类型检查中存在未完成/遗留引用，不应视为主要状态入口。
- [src/stores/cache.ts](src/stores/cache.ts)：旧缓存实现，被 WebSocket 客户端使用，但严格类型不完整。

### 协议层

[src/utils/bonProtocol.js](src/utils/bonProtocol.js) 提供：

- `DataReader`、`DataWriter`。
- BON 编解码器，支持基础类型、数组、Map、嵌套对象和二进制数据。
- `ProtoMsg` / `ProtoMsgLegion` 消息包装。
- `lx`、`x`、`xtm` 加解密方案及自动检测。
- `g_utils.encode()`、`g_utils.parse()` 和游戏消息模板。

消息通常包含以下字段：

```js
{
  cmd,
  body,
  ack,
  seq,
  time
}
```

### WebSocket 层

#### 竞技场目标响应（已用实测日志确认）

2026-08-20 的批量“一键竞技场战斗3次”日志确认，`arena_getareatarget` 返回的实际结构为 `roleList`，本次观测每次返回 4 个候选对象；候选数量不是固定值，协议上最多不超过 4 个。每个候选对象已包含可用于前端排序的摘要信息，不需要先调用 `rank_getroleinfo` 补充基础数据：

```js
{
  roleId,
  score,
  rank,
  info: {
    roleId,
    serverId,
    name,
    headImg,
    power,
    score,
    bossId,
    bossHeadImg,
    bottleType,
    lordSkinId,
    legacy,
    petId,
    petEvo,
    // 以及头像框、勋章、自定义卡片等字段
  }
}
```

- 外层 `roleId` 与 `info.roleId` 对应；外层 `score`、`rank` 是候选摘要，`info.power` 是可直接使用的战力字段，`info.score` 是带小数部分的分数值。
- 本次样本中的 `info.rank` 均为 `0`，不能把它当作竞技场排名；当前智能模式只使用 `info.power` 升序选敌，并对缺失字段设置回退策略。
- 三轮样本均为 `roleList[4]`，但候选数量不是固定值；`pickArenaTargetId()` 会按实际返回数组长度（0 至 4）遍历。无模式时保留原有第一个有效候选的行为，启用 `lowestPower` 时选择战力最低的有效候选。
- 样本中的候选顺序没有稳定地按战力、分数或排名升降排列，后续应把服务端顺序视为随机顺序，在前端基于 `info.power`、外层 `score`/`rank` 等字段自行筛选或排序。
- 智能竞技场设置目前只有 `lowestPower`（最低战力）模式，默认值为 `lowestPower`；只有批量任务“一键竞技场战斗3次”传入该模式，竞技场补齐任务仍使用默认的第一个有效候选逻辑。战力相同则保留服务端原始顺序；无有效战力、候选为空或目标 ID 缺失时保留兼容回退。
- 后续竞技场候选排序或选敌功能可以直接依据上述已验证响应结构开发，无需等待新的实测数据；仍需保留 `roleList` 缺失、字段缺失和目标 ID 缺失时的兼容回退。

#### 盐场与蟠桃军团即时战斗接口盘点

以下结论基于当前仓库源码的调用链和命令注册表整理，区分“已经真实发送过的接口”和“仅注册、尚未实测的接口”。命令本身通过 BON 编码后经 WebSocket 发送；通用接口入口是 `tokenStore.sendMessage()` / `tokenStore.sendMessageWithPromise()`，响应优先按 `resp` 或请求序号匹配，再按命令响应映射兼容处理。

##### 盐场：已接入的接口

普通游戏 WebSocket 和盐场专用 WebSocket 分成两条连接链路：

1. `legion_getbattlefield`
   - 普通连接请求战场元信息。
   - 当前代码使用返回的 `info.sid` 构造盐场专用 WSS 地址，使用 `info.battlefieldId` 作为战场标识，使用 `info.phase` 查询匹配对手。
   - 入口：[src/stores/legionWarStore.js](src/stores/legionWarStore.js) 和 [src/views/LegionWar.vue](src/views/LegionWar.vue)。
2. `legion_getopponent`
   - 参数为 `{ phase, battlefieldId }`。
   - 返回 `opponentList`，用于盐场匹配对手页面；随后对每个俱乐部调用 `legion_getinfobyid`，并对成员调用 `rank_getroleinfo` 补充战力、红淬和阵容信息。
   - 入口：[src/components/Club/ClubWarrank.vue](src/components/Club/ClubWarrank.vue)。
3. `war_enterbattlefield`
   - 盐场专用 WebSocket 连接建立后发送，参数为 `{ battlefieldId, useGzip: true }`。
   - 作用是进入实时战场，不是普通战绩查询接口。
4. `war_getbattlefieldinfo`
   - 盐场专用 WebSocket 的实时战场快照请求，参数为 `{ battlefieldId }`。
   - 当前 UI 只主动刷新快照，没有发现移动、攻击、占点或复活等独立动作命令。
5. `war_ping`
   - 专用连接内部心跳，由 `heart_beat` 映射产生；用于维持连接，不是业务战斗动作。

盐场专用客户端和状态管理位于 [src/utils/xyzwLegionWarWebSocket.js](src/utils/xyzwLegionWarWebSocket.js) 与 [src/stores/legionWarStore.js](src/stores/legionWarStore.js)。实时快照的原始内容明显比当前页面展示的字段更丰富：

- `battlefield.buildingData`：地图建筑、坐标、类型、血量、最大血量、占领关系和建筑积分等。
- `battlefield.legions`：俱乐部 ID、名称、等级、战力、服务器、基地位置、占领建筑、四圣数量/积分、击杀数、俱乐部积分、成员集合和自定义统计字段。
- `battlefield.roles`：角色名称、所属俱乐部、在线状态、行动状态、刨地数据、击杀、死亡、复活、复活丹消耗和个人积分等。

[src/utils/legionWar.js](src/utils/legionWar.js) 的 `extractValidData()` 目前只抽取地图、俱乐部汇总和成员统计；如果需要研究更底层的盐场状态，应保留并记录 `war_getbattlefieldinfo` 的完整 `message.rawData`，而不是只看 `validData`。

盐场相关的其他读取接口还包括：

- `legion_getwarrank`：盐场历史/当前匹配榜单。
- `legionwar_getdetails`：指定日期的俱乐部战争详细战绩。
- `legionwar_getgoldmonthwarrank`：黄金月赛俱乐部榜单。
- `saltroad_getwartype`：查询伟大航路/岛屿赛事类型。
- `saltroad_getsaltroadwartotalrank`：查询岛屿赛事总榜。
- `legion_getinfo`：获取俱乐部信息，其中现有页面会读取 `warMap` 和 `warRank`。
- `legion_getinfobyid`、`rank_getroleinfo`：查询俱乐部和角色详情，用于补充战力、红淬、英雄和阵容数据。

这些接口主要是读取或补充数据，不等同于实时战场操作接口。

##### 蟠桃：已接入的接口

蟠桃当前代码已经覆盖实时/历史信息、战斗记录、任务和奖励，但没有接入完整的蟠桃船操作链：

- `legion_getpayloadbf`
  - 蟠桃战斗时间内获取实时双方俱乐部信息。
  - 当前代码读取 `legions`，根据本方俱乐部 ID 找出对手俱乐部 ID。
- `legion_getpayloadrecord`
  - 获取历史对战日期到对手俱乐部的映射，当前代码读取 `enemyLegionMap[shortDate].id`。
- `legion_getpayloadkillrecord`
  - 按日期获取双方参战/击杀记录，当前代码读取 `recordsMap[legionId]`。
  - 页面消费的字段包括 `roleInfo.roleId`、角色名称/头像、`killCnt`、`reviveCnt`、`mCKCnt`、`carCnt` 等；具体响应可能还包含更多字段。
- `legion_getpayloadtask`
  - 获取蟠桃任务和进度，当前代码读取 `payloadTask.taskMap`、`legionPoint`、`selfPoint` 和 `progressMap`。
- `legion_claimpayloadtask`
  - 参数为 `{ taskId }`，领取单个蟠桃任务奖励。
- `legion_claimpayloadtaskprogress`
  - 参数为 `{ taskGroup: 1 }` 或 `{ taskGroup: 2 }`，分别领取俱乐部积分奖励和个人积分奖励。
- `legion_getinfobyid`
  - 获取双方俱乐部的名称、等级、战力、服务器、Logo、公告和成员等详情。
- `rank_getroleinfo`
  - 获取参战角色的完整角色、英雄、装备、鱼灵和阵容信息。
- `fight_startpvp`
  - 当前“蟠桃信息”页面中的手动切磋入口，参数为 `{ targetId }`；`tokenStore` 会自动注入 `battleVersion`。
  - 页面消费 `battleData.result.isWin`、`leftTeam`、`rightTeam`、双方 `teamInfo` 和英雄血量，用于统计切磋胜率与掉将情况。

相关实现位于 [src/components/Club/PeachInfo.vue](src/components/Club/PeachInfo.vue)、[src/components/Club/PeachBattleRecords.vue](src/components/Club/PeachBattleRecords.vue) 和 [src/utils/batch/tasksItem.js](src/utils/batch/tasksItem.js)。

##### 仅注册、尚未接线实测的军团战接口

`src/utils/xyzwWebSocket.js` 的默认命令注册表和响应映射中存在以下命令，但当前源码没有找到实际页面或任务发送链：

- `legion_signup`：注释标记为盐场报名。
- `legion_payloadsignup`：注释标记为蟠桃报名。
- `league_getbattlefield`：联盟/联赛战场信息候选接口。
- `league_getgroupopponent`：联盟/联赛分组对手候选接口。
- `saltroad_getsaltroadwargrouprank`：岛屿赛事分组榜候选接口。

这些命令目前只能确认“客户端预留了命令名和响应映射”，无法仅根据现有代码确定参数、开放条件或返回结构，需在对应活动时间用实际日志验证。

`legionmatch_rolesignup` 虽然已经在 [src/components/Club/Rank.vue](src/components/Club/Rank.vue) 和 [src/views/GameFeatures.vue](src/views/GameFeatures.vue) 中调用，但它是“俱乐部排位”报名，不应与盐场的 `legion_signup` 或蟠桃的 `legion_payloadsignup` 混同。

##### 主项目 `src` 当前未发现的战斗动作接口

在主项目 `src` 的标准 BON/WebSocket 命令链中，没有发现能够直接执行以下蟠桃或盐场操作的已实现命令链：

- 蟠桃船出发、护送、移动、登船或下船。
- 攻击船上玩家、抢夺船只控制权、使用花盆等战斗道具。
- 盐场角色移动、攻击、占点、建筑操作或主动复活。
- 蟠桃战斗或盐场战斗的独立结算提交接口。

`src/utils/PeachTaskIds.js` 中大量“送船、抢船、花盆、击杀、控制权”的描述来自任务配置，只能证明这些游戏事件存在，不能反推出对应的请求命令已经被项目掌握。

##### `../scripts` H5 注入脚本的补充发现

仓库旁侧目录 `../scripts` 中的四份 Userscript 不是主项目的标准协议封装，而是注入真实游戏 H5 页面后，通过 `window.__require()` 取得游戏内部模块并直接调用模块方法。它们依赖游戏页面已经初始化的 Cocos/FGUI、`ModuleManager`、`Configs`、`ServerData`、`LEGION_WAR` 和 `LEGION_PAYLOAD`，不能脱离 H5 运行时单独执行。

四份脚本的能力如下：

- `../scripts/全自动蟠桃园.js`
  - 获取 `Configs.ModuleType.LEGION_PAYLOAD` 模块。
  - `startBattle(force)`：进场；`sendSetBattleTeam(battleTeam, lordWeaponId, petUId)`：提交主阵容。
  - `sendMarch(path)`：普通行军；`sendGetCar(carId, path)`：向车辆行军/上车。
  - `sendPickItem()`：拾取道具；`sendUse(carId)`：使用车辆道具；`sendBattle(enemyId)`：攻击附近敌人。
  - 读取 `lPWarData.battlefield`、`self`、`roles`、`carData`、`itemData`、位置、死亡和复活状态，并按距离选择车辆、敌人和道具。
  - 具备自动进场、布阵、复活后重进、自动上车、自动拾取、用车道具和攻击；未发现报名、领奖或明确的夺船控制权方法。

- `../scripts/自动盐场.js`
  - 获取真实 `Configs.ModuleType.LEGION_WAR` 模块，也能获取 `LEGION_PAYLOAD`、`LEGION` 模块。
  - 进场：`enterAnonymousWar()` / `goto()`；刷新：`sendGetBattlefield()`、`sendGetBattlefieldInfo()`。
  - 布阵：`deployData.sendSetBattleTeam()`；行军：`sendStartMarch(position)`；加速：`sendSpeedUp(marchId)`。
  - 战斗：`sendStartAttackBuilding(buildingId)` 攻击建筑，`sendStartBattle(enemyId)` 攻击敌人。
  - 复活：`sendUseResurrect()`；组队：`sendInviteJoinTeam(playerId)`、`sendKickOutTeam(playerId)`、`sendLeave()`、`sendChangePos(ids)`。
  - 查询：`sendGetTeamInfo(roleCodeId)`、`sendGetTeamImgInfo(imgNames)`，并通过 `LEGION.sendGetInfo()` 刷新成员信息。
  - 自动化流程包括寻盐田、跟随成员、锁定敌人、等待入队、攻击建筑、攻击当前建筑内敌人、自动加速、死亡复活和队伍管理。
  - `sandbox: true` 分支会创建本地伪造的战场、角色、建筑和方法；沙盒方法只修改本地对象，不能证明服务端接口成功。默认 `sandbox: false` 时才调用真实 H5 模块。

- `../scripts/新锁头盐场阵容.js`
  - 不只是阵容展示工具：通过 `sendGetTeamInfo()` / `sendGetTeamImgInfo()` 获取敌方阵容和头像数据，使用头像 PNG 签名与英雄 ID识别阵容。
  - 给攻击/防守队列增加阵容标签、战力/精力排序和锁定按钮。
  - 锁定目标后会调用 `sendStartMarch(position)` 前往目标建筑，必要时调用 `sendSpeedUp(marchId)`，到达后调用 `sendStartBattle(targetId)`；目标离开时可返回原建筑并切换队列中的下一个目标。
  - 还包含自动攻击当前建筑 `sendStartAttackBuilding(buildingId)`，并通过 `isAutoAttack` 控制游戏内置自动攻击开关。

- `../scripts/盐场攻击弹窗不消失(1).js`
  - 修改 `AttackTroopsPage` 和 `DefenseTroopsPage` 的 `_refreshItem`，替换攻击按钮处理器。
  - 点击时调用 `LEGION_WAR.sendStartBattle(targetId)`，但故意不执行关闭部队弹窗的逻辑；它是 UI/按钮补丁，不是完整自动化器。

这些脚本没有自行创建 `WebSocket`，也没有统一的 `fetch`/XHR 拦截层；它们调用的 `send*` 方法由游戏 H5 内部网络模块继续编码和发送。因此脚本暴露了比主项目 `src` 更丰富的“方法级接口”，但没有直接给出每个方法对应的底层 `cmd`、完整参数编码和响应命令名。

##### 将 H5 脚本能力加入本网页项目的可行性

总体可行，但不能把这些脚本方法直接当作当前 Vue 页面里的普通函数调用。[src/main.js](src/main.js) 只负责启动 Vue、Pinia、Router 和 Naive UI；[index.html](index.html) 另外加载了 `src/xyzw/cocos2d-js-min.js`、`src/xyzw/game-defines.js` 和 `src/xyzw/index.js`。因此游戏打包资源和 `window.__require` 定义在仓库中已有，但“脚本能否直接工作”仍取决于 Cocos/FGUI 是否完成初始化、游戏模块是否注册、动态资源包是否加载以及有效 H5 会话是否建立。当前 Vue 应用没有对这些运行时状态提供稳定的适配层，也不能假设 `ModuleManager.GET_MODULE(...)` 已经返回可用的 `LEGION_WAR`/`LEGION_PAYLOAD` 实例。

可选路线有两条：

1. **H5 注入桥接路线，短期最可行**
   - 让 Userscript/浏览器扩展继续运行在真实游戏 H5 页面中，由脚本调用内部 `send*` 方法。
   - 主项目只负责配置、账号选择、策略和日志，通过 `postMessage`、同源页面通信或扩展消息通道与注入脚本通信。
   - 优点是可以直接复用已经验证的进场、行军、攻击、组队、蟠桃车辆等能力，不需要立即反编译所有底层命令。
   - 缺点是依赖真实游戏页面、注入权限、页面生命周期和跨域通信；Token、操作权限和消息来源必须严格校验，不能把任意网页消息直接转成战斗动作。

2. **协议移植路线，长期更适合独立网页**
   - 从 H5 内部 `sendStartMarch`、`sendStartBattle`、`sendStartAttackBuilding`、`sendGetTeamInfo` 等方法继续反查真实请求命令和参数。
   - 在主项目的 `CommandRegistry`、`xyzwLegionWarWebSocket.js` 和 `tokenStore` 中新增命令、响应映射、参数校验和状态处理，再由 Vue 页面调用。
   - 优点是最终可以不依赖游戏 UI 和 Cocos/FGUI 页面，适合批量任务和独立控制台。
   - 缺点是需要逐个实测请求/响应，处理战场专用连接、序列号、心跳、战场状态同步、版本差异和服务端权限；仅凭脚本中的方法名无法安全推导完整协议。

##### 当前缺失的集成资源和前置条件

如果采用 H5 注入桥接，必须具备：

- 可加载并完成初始化的游戏打包入口；当前仓库已有 `index.html` 加载的 Cocos/游戏 bundle，但仍需确认运行时启动成功。
- 初始化后的 `window.__require`、Cocos `cc`、FGUI `fgui` 和游戏 `ModuleManager`，以及 `ModuleManager.GET_MODULE(...)` 能取得目标模块。
- `Configs.ModuleType`、`ServerData`、`DateUtil`、`types-legion-war`、`types-legion-payload` 等运行时模块。
- 盐场/蟠桃所需的资源包和 UI/地图资源，例如脚本中引用的 `legion_payload`、`ui_lp_tiled_map`、`ui_lp_war` 等；仅执行后台动作时不一定需要全部 UI 资源，但进入原生地图或修改界面时需要。
- 与当前 Token 对应的有效 H5 会话、活动开放时间和服务端允许的角色状态。

如果采用协议移植，当前仍缺少：

- 上述 `send*` 方法实际发送的底层命令名和精确 BON 请求体。
- `sendStartMarch`、`sendStartAttackBuilding`、`sendUseResurrect`、`sendInviteJoinTeam`、`sendChangePos` 等动作的成功响应和错误码样本。
- 盐场战场专用连接中完整的请求/响应类型，尤其是队伍、行军、建筑、攻击和复活状态同步。
- 蟠桃 `sendMarch`、`sendGetCar`、`sendPickItem`、`sendUse`、`sendBattle` 对应的请求/响应类型；当前主项目的 `legion_getpayload*` 只覆盖查询和奖励，不能替代这些动作接口。
- 游戏版本对应的生成数据模块、协议响应类和可能的 source map；例如脚本会尝试读取 `data-index` 中的 `War_GetTeamInfoResp`。
- 真实运行日志，用于确认接口开放条件、参数 ID 类型、战斗冷却、限流、复活消耗和失败重试规则。

因此建议的实现顺序是：先在当前页面实际验证 Cocos/FGUI、`window.__require` 和目标模块是否就绪，再用 H5 注入桥接验证控制面和安全边界；随后针对最稳定的只读/低风险动作抓取原始报文，最后将已确认的协议逐个移植到主项目。`src/xyzw/index.js` 虽然已经由 `index.html` 加载，但单独加载 bundle 仍不等于完整的 Cocos 场景、模块状态、动态资源和登录会话；这些运行时条件仍需处理。

##### 底层扩展边界

通用 `XyzwWebSocketClient` 可以通过 `sendMessage()` 或 `sendMessageWithPromise()` 发送已注册命令，自动完成 BON 编码、序列号、响应匹配和日志；战斗命令还会由 [src/stores/tokenStore.ts](src/stores/tokenStore.ts) 自动注入 `battleVersion`。因此，后续验证未知命令的最小路径是：确认活动时间和连接类型，记录原始请求/响应包，先验证只读接口，再判断是否存在状态变更接口。

仓库中的旧 [src/utils/wsAgent.js](src/utils/wsAgent.js) 仅用于早期 Token/连接流程，不是盐场或蟠桃业务接口的第二套实现。对内置 [src/xyzw/index.js](src/xyzw/index.js) 游戏资源进行命令字符串检索，也未发现额外的 `payload_*`、`saltroad_*` 或可直接对应船战动作的协议实现。

[src/utils/xyzwWebSocket.js](src/utils/xyzwWebSocket.js) 是游戏 WebSocket 客户端，负责：

- `CommandRegistry` 命令注册和默认参数合并。
- 发送队列和顺序化发送。
- 心跳、自动重连、状态回调和日志。
- `send()` 的发送即忘模式。
- `sendWithPromise()` 的请求响应模式。
- 按 `resp`、命令名和映射表匹配服务端响应。

连接创建主要在 `tokenStore.createWebSocketConnection()` 中完成，默认地址形态为：

```text
wss://xxz-xyzw.hortorgames.com/agent?p=<encoded-token>&e=x&lang=chinese
```

连接超时和 Token 刷新行为：

- 普通角色登录连接默认监控 10 秒握手超时；1006 握手失败也会进入相同的刷新流程。
- `attemptTokenRefresh()` 从 URL 或 IndexedDB 中的 BIN/WX 数据获取新 Token，并在成功后更新本地存储；失败通过 `token:refresh:failed` 事件通知界面。
- [src/views/BatchDailyTasks.vue](src/views/BatchDailyTasks.vue) 的批处理连接失败后，先等待旧连接关闭，再刷新 Token 并使用最新 Token 重连；批处理连接关闭 Store 的握手超时和握手失败自动刷新，避免后台刷新与批量刷新争用。刷新接口遇到限流时每隔 1 秒重试，直到成功；不可重试的刷新错误才停止账号并保留失败原因。
- 批量任务中的 `role_getroleinfo` 统一通过 [src/views/BatchDailyTasks.vue](src/views/BatchDailyTasks.vue) 的恢复入口请求；请求失败时关闭旧 WSS、刷新 Token、使用最新 Token 重建连接并重试角色信息，恢复耗尽后将异常交回当前账号任务，避免继续使用过期数据。
- [src/layout/DefaultLayout.vue](src/layout/DefaultLayout.vue) 和 [src/views/TokenImport/index.vue](src/views/TokenImport/index.vue) 监听刷新失败事件，并使用 Naive UI 对话框提示用户。

### 任务层

- [src/utils/dailyTaskRunner.js](src/utils/dailyTaskRunner.js)：单账号任务编排，按照角色信息和任务设置生成任务列表，顺序执行游戏命令；可通过 `selectedTaskIds` 只生成自由模板勾选的日常任务，未传该字段时保持原完整日常行为。
- [src/utils/helperTaskRunner.js](src/utils/helperTaskRunner.js)：批量命令、重试、限流和库存校验等相对独立的纯工具逻辑。
- [src/utils/batch/flexibleTemplate.js](src/utils/batch/flexibleTemplate.js)：自由模板的完整任务目录、参数规范化、持久化解析和共享连接协调器；目录显式包含 32 组原完整日常内部任务和 39 个原批量功能入口。
- [src/views/BatchDailyTasks.vue](src/views/BatchDailyTasks.vue)：多账号批量任务、定时任务、连接准备、日志和大量业务任务入口，目前是超大单文件；旧任务模板和批量功能列表继续保留，新增独立的自由模板管理、复选编辑和组合执行入口。
- [src/views/DailyTasks.vue](src/views/DailyTasks.vue)：单账号日常任务页面，部分状态仍与 Mock/localStorage 逻辑耦合。

### 事件与界面层

[src/stores/events/](src/stores/events/) 根据服务端命令分发角色、活动、军团、队伍、塔、聊天等事件，更新 Store 或通知 UI。

主要页面：

- [src/views/Home.vue](src/views/Home.vue)：首页。
- [src/views/TokenImport/index.vue](src/views/TokenImport/index.vue)：Token 导入和管理。
- [src/views/TokenImport/bin.vue](src/views/TokenImport/bin.vue)：BIN 多角色导入；角色表桌面端每页显示 50 条，并支持顺序“全部添加”到待导入列表。
- [src/views/Dashboard.vue](src/views/Dashboard.vue)：控制台和连接/角色状态。
- [src/views/GameFeatures.vue](src/views/GameFeatures.vue)：游戏功能入口。
- [src/views/DailyTasks.vue](src/views/DailyTasks.vue)：单账号任务。
- [src/views/BatchDailyTasks.vue](src/views/BatchDailyTasks.vue)：批量任务。
- [src/views/LegionWar.vue](src/views/LegionWar.vue)：盐场功能。
- [src/components/Test/MessageTester.vue](src/components/Test/MessageTester.vue)：BON/消息测试。
- [src/components/Test/WebSocketTester.vue](src/components/Test/WebSocketTester.vue)：WebSocket 测试。
- [src/layout/DefaultLayout.vue](src/layout/DefaultLayout.vue)：管理页面导航和嵌套路由布局。

## 4. 关键数据流

### Token 导入到连接

```text
TokenImport 页面
  -> tokenStore.importBase64Token()
  -> parseBase64Token()
  -> validateToken()
  -> addToken()
  -> gameTokens / localStorage
  -> selectToken()
  -> createWebSocketConnection()
  -> XyzwWebSocketClient
```

Token 输入可能是纯文本、Base64、带前缀内容或 JSON 包装内容。解析后会提取 `token`、`gameToken` 或解码结果作为实际连接 Token。

### 消息发送到响应

```text
任务/页面
  -> tokenStore.sendMessageWithPromise()
  -> client.sendWithPromise()
  -> sendQueue
  -> CommandRegistry.build()
  -> BON encode + encryption
  -> WebSocket.send()
  -> WebSocket.onmessage
  -> BON decrypt + parse
  -> _handlePromiseResponse()
  -> Promise resolve/reject
```

无 Promise 的消息走 `send()`；心跳使用特殊的 `_sys/ack` 报文。收到消息后，Store 还会通过事件系统分发给角色、活动和功能模块。

### 任务执行

```text
批量日常执行 `DailyTaskRunner` 命令时，如果检测到 `WebSocket未连接`，会先关闭旧连接、重新建立并初始化 WebSocket，再重试当前命令，最多恢复 2 次；因此连接中途掉线不会直接跳过该命令。其他入口未注入重连回调时保持原有行为。

任务设置
  -> 生成任务列表
  -> 检查角色/活动/库存
  -> 建立或复用 WebSocket 连接
  -> 顺序或批量发送游戏命令
  -> 延迟、重试和进度回调
  -> 更新日志与 gameData
```

批量日常主流程按 `maxActive` 分成账号波次：同一波账号并发执行，但下一波必须等待当前波全部结束后才启动。每个账号内部由 `DailyTaskRunner` 线性执行任务，日常任务完成后先逐项领取每日任务积分奖励，再领取每日完成奖励，随后处理周常和通行证奖励。连接失败时先由批量流程刷新 Token，再使用最新 Token 重连；刷新遇到限流或 HTTP 429 时每隔 1 秒重试直到成功。任务执行遇到限流、模块未开启、已知屏蔽或其他服务器错误时，都记录警告并只跳过当前任务，继续执行后续任务；批量车辆、挂机奖励和加钟流程中的 `400340` 统一视为限流，相关命令按 1 秒间隔重试，最多重试 100 次并记录当前重试次数；领取挂机奖励的 `system_claimhangupreward` 遇到请求超时也按同样策略重试；车辆和挂机初始化也遵循该策略，耗尽后才跳过当前车辆或账号。智能发车只使用免费刷新和刷新券，不使用金砖刷新，策略默认是逻辑 A，也可在批量设置中选择逻辑 B。智能发车按角色逐辆处理车辆。只有用户主动停止批处理或连接初始化失败才会结束当前账号。流程结束后在页面弹窗显示完成数量、总数量和最终失败角色清单，并可一键重新选中最终失败的账号。错误账号按最终状态汇总，不记录中间重试失败。

自由模板是与旧任务模板并存的第二套模板，不修改旧 `task-templates` 或账号 `daily-settings:*` 引用。自由模板可任意复选完整任务目录并保存阵容、BOSS 次数、开箱/钓鱼/招募、怪异塔、竞猜、功法赠送和月赛助威等参数；导入数据会过滤未知任务并规范化参数。执行时仍按 `maxActive` 分账号波次，同一波中的账号并发；同一模板内的多个任务同步启动，使任务自身的等待和冷却时间互相重叠。每个账号只占一个连接槽位并共享一个 WebSocket 生命周期，最慢任务结束后才统一断开；底层客户端继续通过独立发送队列和请求 `seq` 顺序发包、匹配响应。任一子任务失败只计入对应账号，不会把同一波其他账号误判为失败。每个任务的 UI 标签、实际命令、条件、循环和 `completed` 语义详见 [docs/flexible-batch-template-task-logic.md](docs/flexible-batch-template-task-logic.md)。

批处理工具层已覆盖批次拆分、限流重试、库存前后校验等场景，并有 Node 原生测试；核心 Store、WebSocket、路由和大部分页面交互尚未形成系统化测试。

## 5. 路由结构

路由入口是 [src/router/index.js](src/router/index.js)：

- `/`：首页；有 Token 时重定向到 `/admin/dashboard`。
- `/tokens`：Token 导入管理页，支持 query 参数预填充。
- `/admin`：使用 [src/layout/DefaultLayout.vue](src/layout/DefaultLayout.vue) 的管理布局。
- `/admin/dashboard`：控制台。
- `/admin/game-features`：游戏功能。
- `/admin/daily-tasks`：单账号日常。
- `/admin/batch-daily-tasks`：批量日常。
- `/admin/message-test`：消息测试。
- `/admin/legion-war`：盐场，带时间限制。
- `/admin/profile`：设置。
- `/websocket-test`：WebSocket 测试。

路由同时使用手写路由和 `unplugin-vue-router` 自动路由。当前重复注入和热更新导出警告记录在 [KNOWN_ISSUES.md](KNOWN_ISSUES.md) 中。

## 6. 存储和外部依赖

浏览器端主要使用：

- `localStorage`：游戏 Token、选中 Token、分组、主题和跨标签页连接状态。
- `localStorage` 的 `flexible-task-templates`：自由模板定义；旧模板仍使用 `task-templates`，两者独立保存。配置导入/导出版本 `1.2` 包含自由模板。
- IndexedDB：部分二进制数据和辅助存储。
- WebSocket：直接连接游戏服务。
- HTTP/HTTPS：Token 转换、服务器列表和 Worker/开发代理相关请求。

Vite 开发代理位于 [vite.config.js](vite.config.js)，当前配置了微信登录、微信长轮询和 Hortor 接口代理。Cloudflare Worker 位于 [worker.js](worker.js)，当前只代理固定的三个前缀并为其添加 CORS 响应头。

## 7. 常用命令和当前验证状态

安装依赖：

```bash
pnpm install --frozen-lockfile
```

开发、构建和预览：

```bash
pnpm run dev
pnpm run build
pnpm run preview
```

当前 `package.json` 声明的专项脚本：

```bash
pnpm run testr
pnpm run testd
```

需要注意：当前没有统一的 `test` 脚本。已验证的测试命令为：

```bash
node --test test/helperTaskRunner.test.js test/towerClimbLimit.test.js
```

截至 2026-08-12 的验证结果：

- 依赖按锁文件安装成功。
- 两个 Node 测试文件共 15 个用例全部通过。
- `pnpm run build` 成功，但有自动路由、`eval` 和大 chunk 警告。
- `pnpm exec tsc --noEmit -p tsconfig.app.json` 失败，14 个文件共 139 个错误。
- `pnpm exec eslint src --ext .vue,.js,.ts` 无法执行，找不到 `eslint` 命令。

截至 2026-08-13 的自动 Token 刷新功能验证：

- `pnpm build` 成功；仍有可选 Vite 插件缺失和 Sass legacy API 警告。
- `pnpm testd` 成功。
- `node --check src/utils/batch/connectionManager.js` 成功。
- `pnpm testr` 仍因测试脚本使用未配置的 `@utils/bonProtocol.js` 路径别名失败，与本次改动无关。

截至 2026-08-24 的自由模板功能验证：

- `node --test` 执行仓库全部 `test/*.test.js`，共 42 个用例全部通过；其中新增用例覆盖 32 组隐藏日常、39 个原批量入口、模板参数规范化、损坏存储处理、共享连接只建立/关闭一次、连接失败释放槽位后可重试，以及 `DailyTaskRunner` 只生成勾选任务。
- `pnpm run build` 成功；仍有既有的自动路由、`eval`、Sass legacy API 和大 chunk 警告。
- 使用本地 Vite 页面验证自由模板新增、编辑、71 项全选/清空、独立存储和旧模板存储不变；桌面及 `390 × 844` 移动视口均无横向溢出，编辑器任务网格在移动端降为单列并使用内部滚动。
- `git diff --check` 通过；编辑器未报告本次触及文件的语法或类型诊断。仓库未安装可执行的 `prettier`，因此未运行 Prettier 检查。

## 8. 部署信息

前端生产构建输出到 `dist`。Vite 的 `copy-worker` 插件会在构建结束时把根目录 [worker.js](worker.js) 复制为 `dist/_worker.js`，供 Cloudflare Pages Advanced Mode 使用。

README 还描述了 `server/app.py` 的 Python Token URL 服务，但当前工作区的 `server/` 目录只有 [requirements.txt](server/requirements.txt)，因此这部分说明不能视为当前仓库可直接运行的完整功能。

## 9. 后续分析入口

按任务选择最小读取范围：

- Token、连接、跨标签页状态：先读 [src/stores/tokenStore.ts](src/stores/tokenStore.ts)。
- BON 编解码或消息格式：读 [src/utils/bonProtocol.js](src/utils/bonProtocol.js)。
- WebSocket 请求、心跳、响应超时：读 [src/utils/xyzwWebSocket.js](src/utils/xyzwWebSocket.js)。
- 单账号自动化：读 [src/utils/dailyTaskRunner.js](src/utils/dailyTaskRunner.js)。
- 批量任务或定时调度：读 [src/views/BatchDailyTasks.vue](src/views/BatchDailyTasks.vue)，并注意其文件规模和动态任务分发。
- 页面跳转和 Token 门禁：读 [src/router/index.js](src/router/index.js)。
- 当前已知问题：读 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

## 10. 文档优先级

1. 当前源码、测试结果和配置文件。
2. 本文件 `PROJECT_CONTEXT.md`：当前状态的快速快照。
3. `KNOWN_ISSUES.md`：风险、缺陷和待处理事项。
4. `CLAUDE.md`：较完整的开发指导，但部分目录、接口和测试描述可能滞后。
5. `README.md`：用户使用和部署说明，其中 Python 服务部分与当前工作区不完全一致。

## 11. 维护约定

`PROJECT_CONTEXT.md` 是本仓库面向后续开发的当前状态文档。它不是一次性分析报告，而是需要随代码一起维护的交接入口。

- 涉及目录结构、模块职责、数据流、路由、存储、依赖、命令或部署方式的改动，应同步更新本文档。
- 新增或移除核心模块时，更新“核心模块地图”和“后续分析入口”。
- 构建、测试、类型检查或 lint 结果发生变化时，更新“常用命令和当前验证状态”，并注明验证日期。
- 已知缺陷、技术债和安全风险记录在 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)，本文档只保留必要的定位和入口。
- `README.md`、`CLAUDE.md`、`LOCAL_TOKEN_CHANGES.md` 等旧 Markdown 文件可能滞后；它们可用于了解历史背景，但不能覆盖当前源码、测试结果和本文档中的当前状态。
- 修改本文档时优先引用当前实际存在的文件、脚本和符号，避免把历史计划或未交付功能写成现行能力。
