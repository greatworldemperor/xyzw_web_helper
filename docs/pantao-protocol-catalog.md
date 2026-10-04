# 蟠桃（payload）协议全表

> 数据来源：`local-data/pantao/pantao1`
> - `wssa1`~`wssa5`：模拟器（**真实游戏客户端**）HttpCanary 导出，每帧一个 `.bin`（`px` 加密），成功进入战场
> - `pantao_runtime_failed_to_enter/`：runtime（网页 h5 客户端）`xyzw-runtime-analysis-jsonl` v2，进得去战场但**布阵被拒**
>
> 解码：`px` 帧 = `70 78` 头 + 2 字节 key material + XOR 全帧，解后从 offset 4 起是 BON（`local-data/pantao/_decode_wssa.mjs`）。
> runtime 侧帧在 `payload.frame.rawHex`，用同一套解码（`_runtime_frame.mjs`）。

---

## 1. 连接拓扑（关键新发现）

蟠桃战场用**独立的 WS 域名**，与主连接不同：

| 连接 | 地址 | 用途 |
|---|---|---|
| 主连接 | `wss://xxz-xyzw.hortorgames.com/agent` | 登录、军团、活动、查询 |
| **战场连接** | **`wss://xxz-xyzw-new.hortorgames.com/agent`** | 蟠桃战场专用，第一条命令就是 `payload_enterbf`（seq=1） |

- URL **不带任何 query 参数** → 客户端身份不在这里
- 战场连接建立后只发 `payload_enterbf` + 每 20 秒 `payload_ping {bfId}`

## 2. 战场 ID 规则

`bfId` 格式：**`YYMMDD:战场序号`**，例 `260920:13059`（2026-09-20 第 13059 场）。
- `payload_enterbf` 的 `body.bfId` 与帧级 `hint` 必须一致
- 同一个角色不同场次 bfId 不同；同一场次两个军团对战

## 3. 进入流程（真实客户端实测序列）

```
主连接:
  legion_getpayloadbf        {}                    → Legion_GetPayloadBfResp (429B: phase, signupStartTime, signupEndTime)
  legion_getpayloadtask      {}                    → Legion_GetPayloadTaskResp (483B: phase="260920", taskMap, progress)
  legion_getpayloadlegioninfo {}                   → Legion_GetPayloadLegionInfoResp (4095B: legion.members)
  presetteam_getinfo                               → PresetTeam_GetInfoResp (3206B) ← 布阵数据源
  hero_calcpowerbyteam {battleTeam, lordWeaponId, petUId}
                                                   → Hero_CalcPowerByTeamResp {power}
战场连接:
  payload_enterbf        {bfId}                    → Payload_EnterBfResp (20KB / 准备期 3KB)
  payload_ping           {bfId}      每 20s
  payload_setbattleteam  {bfId, battleTeam, lordWeaponId, petUId}
                                                   → Payload_SetBattleTeamResp
  payload_startmarch                               → Payload_StartMarchResp / Payload_EndMarchNotify
```

## 4. 命令全表

### send（可执行动作）

| 命令 | body | 说明 |
|---|---|---|
| `legion_getpayloadbf` | `{}` | 查蟠桃战场/报名期信息 |
| `legion_getpayloadtask` | `{}` | 蟠桃任务进度 |
| `legion_getpayloadlegioninfo` | `{}` | 军团参战成员 |
| `presetteam_getinfo` | — | **预设队伍**（布阵数据源，见 §6） |
| `hero_calcpowerbyteam` | `{battleTeam, lordWeaponId, petUId}` | 算战力，返回 `{power}` |
| `payload_enterbf` | `{bfId}` | **进战场** |
| `payload_ping` | `{bfId}` | 心跳，20s |
| `payload_setbattleteam` | `{bfId, battleTeam, lordWeaponId, petUId}` | **布阵/上阵**（runtime h5/1.89.8 被 3000070；官方模拟器成功——同战场 13059 对照，见 §7 修正；**模拟器版本串未捕获**） |
| `payload_startmarch` | — | 行军 |
| `payload_useitem` | — | 用道具（→ `Payload_UseItemResp`） |

### recv（含广播）

`Payload_EnterBfResp`（**也用作增量广播帧**，会反复下发，只带 `bf` 子字段）
`Payload_SetBattleTeamResp` `Payload_StartMarchResp` `Payload_EndMarchNotify`
`Payload_StartBattleResp` `Payload_EndBattleNotify` `Payload_ResurrectNotify`
`Payload_CarMoveNotify` `Payload_GenCarNotify` `Payload_SyncCarNotify`
`Payload_StateChangeNotify` `Task_PayloadNotify` `System_NewChatMessageNotify`

## 5. `Payload_EnterBfResp` 数据结构

```js
body = {
  bf: {
    id: "260920:13059",
    state: "ready" | "started",        // 准备期 → 开战
    mapId: 1,
    readyTime, openTime, endTime,      // 秒；openTime - readyTime = 300s，end - open = 1800s
    legions: { [legionId]: {id,name,logo,color,level,power,serverId,position,state,outTime,members} },
    roleIds: { "legionId_roleId": 0 }, // 参战名单
    roles:   { [roleId]: { roleId, serverId, name, power, legionId, key:"legionId_roleId",
                           state, winCnt, dieCnt, energy, revive, conKill,
                           lordWeaponId, petUId, itemId, robCarCnt, ... } },
    carMap:  { 1..13: { id, position, pathId, progress, beginTime, endTime,
                        state, belongLegionId, score, scoreSpeed, carItemId } },   // 蟠桃车
    nextCarTimes: [ts, ts, ts],
    refLegionId,
    battleMap: {}, changeCarPathCDMap: {},
    itemMap: { "31_11":6, "15_6":1, "12_18":3 },   // 地块道具
    nextResurrectTime, nextItemRefreshTime,
    rTimeoutTime: 20, noResurrect: false
  },
  roleId,        // 自己
  bfId,
  tileDataMap: { tileData: { "x_y": { id, memberMap:{roleId:ts}, belongsLegionId,
                                      marches:{ id, codeId, legionId, from, to,
                                                startTime, endTime, carId, path[] } } } }
}
```

### role.state 状态机
`watching`（观战/未上场）→ `idle` → `march`（行军中）→ 战斗中 → `die`（死亡等复活）

## 6. `PresetTeam_GetInfoResp`（布阵数据源）

```js
body.presetTeamInfo = {
  roleId, useTeamId: 1,
  presetTeamInfo: {
    1: { teamName, teamInfo: {0..4: {heroId, level, star, color, power, hp, artifactId, skin, useSkin}},
         bagHeroInfo: {...}, heroSkin: {63项},
         weapon: { weaponId, attachmentUid, level, passiveSkill, createTime },
         petUId: "249-RkM" },
    2: { ... }
  }
}
```
`payload_setbattleteam.battleTeam` = 预设队伍 `teamInfo` 的 5 个 `heroId`（按阵位重排，集合一致）。

## 7. 3000070「客户端数据异常」归因（本次核心结论）

### 已用数据**证伪**的因素

| 候选 | 证据 |
|---|---|
| `petUId` 为空 | 战场 30 人中 20 人无宠物，**19 人成功上场**（含同批小号 momo261：`petUId:""`、`state:march`、`die:2`）；服务端对 momo271 记录的也是 `petUId:""` → **无关**（与「蟠桃上线时宠物机制还没出」一致） |
| 战力不符 | `hero_calcpowerbyteam` 返回 `833637592`，与服务端 `roles[436746334].power` **完全一致** → 无关 |
| 命令结构/字段缺失 | 两侧 `payload_setbattleteam` body 都是 `{bfId, battleTeam, lordWeaponId, petUId}`，字节差 7 = 仅 `petUId` 字符串长度 → 结构一致 |
| 连接 URL / 报名资格 | URL 无参数；`roleIds` 含 `7199227_436746334` → 有资格 |

### 真正的判据：WS 上报的身份字段

WS 连接后**第一条命令 `role_getroleinfo`（seq=1）**上报：

```js
// runtime（网页 h5 客户端，被拒）
{ platform: "hortor", platformExt: "h5",  inviteUid: 0, clientVersion: "1.89.8-wx", scene: "" }

// 模拟器（真实客户端，通过）
platformExt = "mix"      // wx / ios / android 在 _platformExtMapping 中的 ext 输出
clientVersion ≈ "2.21.2-fa918e1997301834-wx"
```

- 映射表（`src/xyzw/index.js` 27567）：`wx/ios/android → ext:"mix"`；`h5 → "h5"`；`h5web → "h5web"`
- `platformExt` getter = `_platformExtMapping[PLATFORM].ext`
- `platform-spoof.js` 只覆写 `window.PLATFORM`，网页可登录值只有 `h5/h5web` → **无论怎么选都还是网页口径**

⇒ 服务端据此把连接标记为 `loginPlatform: hortor-h5`，并在**战斗类动作**上拦截：
- 蟠桃 `payload_setbattleteam` → 3000070（**仅 h5/1.89.8 口径**；官方模拟器同战场成功——10-04 从 pantao.7z/wssa5+batch3 证实，§7 的『mix 未实测』已闭环；**模拟器版本串未捕获**）
- 盐场 `war_startbattle`（PVP）→ 3000070
- 而 `payload_enterbf` / `payload_ping` / 盐场 `war_startattackbuilding` / 组队 → **正常**

### 两条修复路线

1. **别在游戏 runtime 里伪装**（推荐）：用项目自己的协议客户端（`src/utils/xyzwWebSocket.js`），它注册口径**本来就是 mix**：
   ```js
   role_getroleinfo: { clientVersion: "2.21.2-fa918e1997301834-wx", platformExt: "mix", platform: "hortor" }
   ```
   直接实现蟠桃：`payload_enterbf` → `payload_setbattleteam` → `payload_startmarch`。
2. **继续用 runtime**：需要把上报口径改成 mix，且**不能改 `PLATFORM`**（wx 会切 App SDK 登录分支卡死，mix 不是 key 会崩）。可行做法是 patch `_platformExtMapping` 实例表或 hook WS send 改写 `role_getroleinfo` body（`platformExt:"mix"`、`clientVersion:"2.21.2-fa918e1997301834-wx"`），登录分支保持 h5 不变。

### 7.5 clientVersion 中段 16hex（`fa918e1997301834`）身份研究（10-04）

- **组装结构**（从官方 web 构建 `game-defines.a175e.js` 反推）：`clientVersion = CODE_VERSION + ['-' + 构建标识] + '-wx'`。
  web 通道无中段（`gt.CODE_VERSION='1.89.8'` → `'1.89.8-wx'`，`VERSION_POSTFIX=''/COMMIT_ID=''/RESOURCES_COMMIT_ID=''`）；
  原生/小游戏通道带 16hex 中段；**`-wx` 后缀全通道常量**（web 构建也有，不是"微信"的意思）。
- **出身**：串随上游开源项目进入工具（git -S 首现 commit `59058ca6`，2026-03-30，2.21.2 为当时版本），上游也无出处记载。
  ⚠️ **local-data 全量扫描：我们从未捕获过任何真实原生客户端首帧** —— 唯一真实客户端串 = 冻结镜像的 `1.89.8-wx`（9 处，全是 runtime 自己发的）；
  E4/E7 文档"真机 2.21.2-…-wx"是从工具自用串反推的假设，非解码证据（goldenfish 领奖抓包里根本没有 clientVersion 帧）。
  10-04 补强：batch1-5（09-13）+ wssa1-5（09-20）共 **461 帧全量递归解码**（0 解码失败、1190 个不同字段），**0 个版本模式串、0 个 version/hash 类字段**；
  两周抓包均始于登录后（batch1 首帧 = 聊天广播且 seq 已 59，wssa1 首帧 = matchteam_getroleteaminfo）⇒ **两周 hash 对比在这批数据上无从做起**，
  唯一近似 hash 的字段是 `roleInfo.platformUId`（32hex，玩家平台账号标识，非构建 hash）。
- **时间线吻合**：2.21.2（03-30 在用）→ 2.48.2（10-02 上线，master 截图）= 27 个 minor ≈ 27 周，与"每周五更新"完全一致。
- **身份判定（10-04 定稿：H2 每周构建 hash，轮换实锤）**：master 提供 PC 微信小游戏包路径
  （`%APPDATA%/Tencent/xwechat/radium/users/<user>/applet/packages/wx0840558555a454ed/`，appid 与 H5 镜像
  `gt.APPID` 同源）→ `tools/saltfield/wxapkg-decrypt.mjs` 解密（`V1MMWX` = PBKDF2(appid,"saltiest",1000,32,sha1)
  AES-256-CBC 前 1023B + 余量单字节 XOR（索引全量解析校验选定））→ 两代构建对照：
  构建356 = `2.44.2-e1853b3c1fe23f57-wx`、构建361 = `2.48.2-cbe6e57c59db01c2-wx`，加上 03 月的
  `2.21.2-fa918e1997301834-wx` —— **三代三 hash，随周五更新轮换**。tool 曾用的 `2.48.2-fa918e…` 拼装串
  从未存在，未实测即废弃；已换官方 361 真串（commit `44d97cdf`，10-04 04:41 部署）。
- **换版本 SOP**：PC 微信打开一次小游戏（自动更新包）→ `node tools/saltfield/wxapkg-decrypt.mjs
  "<packages>/wx0840558555a454ed/<新构建号>/__APP__.wxapkg" <outDir>` → `grep GAME_VERSION <outDir>/game.js`
  → 改 `src/utils/clientVersion.js` 一行 → 测试 → deploy。
- **新字段 `BATTLE_VERSION="7f91491b47"`**：356/361 两代同值（轮换频率低于版本号），首帧不上报，暂不跟进。
- 🔑 **hash 是构建期静态字面量，不是运行时计算**（10-05 定稿）：解密后的 game.js 全文仅 2 处 `GAME_VERSION=` 赋值且都是**字符串常量**（一处 `"dev"` 占位、一处真实值 `"2.48.2-cbe6e57c59db01c2-wx"`），无任何拼接/哈希函数参与，`VERSION_POSTFIX=""`（hash 直接烧在字面量里）⇒ **客户端只读不算，「算法」在官方 CI 打包线上，无需逆向任何算法**。每周换串 = 解包读新常量（5 分钟机械操作）。旁证：BATTLE_VERSION 跨代不变（若是内容摘要早该随代码变了）。若未来服务端改要求"运行时计算的签名"，那才是新逆向课题——目前零证据。
- **门模型现状**：盐场 deploy 接受过真实历史对 `2.21.2-fa918e`（10-03）⇒ 无"当前全串白名单"；盐场 PVP 拒同一串（09-19）⇒ PVP 门校验版本新鲜度且更严。
  蟠桃 deploy 的门待 10-04 用官方真串 `2.48.2-cbe6e57c59db01c2-wx` 实测；若仍被拒 ⇒ 残余变量只剩"非官方设备/会话指纹"方向。
- **每周换串 SOP**（见上）：PC 微信打开小游戏触发更新 → `wxapkg-decrypt.mjs` 解新构建 → 改 `clientVersion.js` 一行；HttpCanary 抓登录首帧是等价备选。

## 8. 待逆向 / 待确认

- ✅ **`payload_startmarch` 请求体已实抓**（10-04 官方 wss_pantao_start，13 次 send 全量）：
  `{ bfId, carId, path[] }` —— **path 为含起点的逐格路由**（`path[0]`=我所在格、末格=船位），每格 `{x,y}`。
  官方示例（20:00:18 seq=11）：`{"bfId":"261004:12982","carId":1,"path":[{20,21},{20,20},{21,19},{21,18},{21,17},{21,16},{20,16},{20,15}]}`
  ⇒ 此前推测 `{bfId, carId}` **少了 path**；工具已修复：`PantaoSession.startMarch` 自动 BFS 补 path
  （`pantaoState.buildMarchPath`，格面近似全通航最短路，测试 `test/pantaoMarchPath.test.js` 7 例）。
- ⚠️ **攻击动作**：到底有没有 `payload_startbattle` 这个 send？（官方 10-04 流 19:57~20:21 窗口内**未出现攻击 send**——31 帧业务命令里只有布阵/行军/查阵容；剩余窗口在 HttpCanary 缓存，若下次实战需要攻击再补抓）
  - `Payload_StartBattleResp` 抓到的帧是 `seq:12, ack:0`（**不像对请求的应答**，更像广播）
  - 但盐场经验是「war_* 响应 ack 常为 0，不能据此判定是广播」→ 结论未定
  - 若实测是「位置重叠自动开战」，则「攻击」应实现为「行军到敌人所在格」，70% 阈值就变成「选船/选格子」的判据
- `payload_useitem` 的道具 ID 语义
- `carMap` 抢车（`robCarCnt`）相关动作命令
- 报名期（`signupStartTime`~`signupEndTime`）是否需要单独命令
- 路线 2 的注入实现与实测验证

---

## 9. 2026-09-21 补：门票 / 行军 / 战斗（本次新增结论）

### 9.1 `legion_getpayloadbf` —— **bfId 与连接地址都在这里**（此前缺失的关键一环）

```js
// 主连接 send: legion_getpayloadbf {}
// 主连接 recv: Legion_GetPayloadBfResp  (429B)
body = {
  info: {                       // 9 个字段
    phase: "260920",            // 活动期（YYMMDD）
    signupStartTime, signupEndTime,
    readyTime, startTime, endTime,   // 准备 / 开打 / 结束（秒）
    bfId: "260920:13059",       // ← 战场 ID，格式 YYMMDD:序号
    sid: "Og9BuVAF3XSsVevJ…",   // ← 一次性票据，每次连接前重取（同盐场）
    domainName: "wss://xxz-xyzw-new.hortorgames.com/agent",  // ← **地址由服务端下发**
  },
  roleBfState: "normal",
  legions: [ { id, name, viewId }, … ],   // 对阵双方
}
```

⇒ 战场连接地址（与盐场同构，**修正「URL 无 query 参数」的旧结论**）：

```js
buildPayloadUrl = ({ domainName, token, sid }) =>
  `${domainName}?p=${encodeURIComponent(token)}&e=x&sid2=${encodeURIComponent(sid)}&lang=chinese`
```

### 9.2 行军（march）

- 客户端只发**一次** `payload_startmarch`，服务端算好整条 `path` 并逐格推进
- **每格 2000ms**（`endTime - startTime = 2000`）；每走一格下发一次 `Payload_EndMarchNotify`
- `Payload_StartMarchResp` 同时把 `bf.roles[me].state` 置为 `march`，并在**出发格**的 `tileData.marches[marchId]` 写入行军对象
- 行军结束后 `marches[id] = null`、角色 `memberMap` 落到新格子 ⇒ **null = 删除**

### 9.3 战斗（battle）

```js
Payload_StartBattleResp.body = {
  bf: {
    roles: { "69567001": { state:"combat", battleId:87 }, "130301444": { state:"combat", battleId:87 } },
    carMap: { "15": { progress, beginTime } },
    battleMap: { "87": { id, leftId, rightId, startTime, endTime, isWin:false, carId:15, battleData:null } },
  },
  bfId, battleId: 87,
}
Payload_EndBattleNotify.body = {
  bf: {
    roles: { "62883302": { state:"idle", winCnt:15, energy:95, conKill:1, battleId:0 },
             "138980611": { state:"die", dieCnt:5, battleId:0 } },
    carMap: { "15": { memberMap: { "138980611": null }, score:-100000, scoreSpeed:-4, … } },
    battleMap: { "86": null },
  },
  leftRoleId, rightRoleId, winId,
}
```
战斗时长约 5 秒（`endTime - startTime`）；输的一方 `state:"die"` 并被移出所在船。

### 9.4 增量帧合并规则（状态层必须照做）

- `Payload_EnterBfResp` 会**反复下发**且只带变化字段；`Payload_*Notify` 同理
- **null 表示删除**：`battleMap[id]=null`、`carMap[id].memberMap[roleId]=null`、`tileData.marches[id]=null`
- 蟠桃**没有**「拉全量快照」命令（盐场有 `war_getbattlefieldinfo`）⇒ 必须本地累积
  （实现见 `src/utils/pantaoState.js`，回归 `test/pantaoState.test.js`）

### 9.5 代码实现位置

| 层 | 文件 | 说明 |
|---|---|---|
| 决策（纯） | `src/utils/pantaoPlan.js` | planTurn / pickTargetCar / shouldAttack / 轮询分批 |
| 状态（纯） | `src/utils/pantaoState.js` | 增量帧合并、我在哪/在哪条船/是否在行军 |
| 会话 | `src/utils/pantaoSession.js` | 战场连接（payload_* 命令 + payload_ping 20s）、enter/setbattleteam/march/attack |
| 编排 | `src/utils/batch/tasksPantao.js` | 主连接拿票 → 战场连接 → 登场 → 决策循环 → 分批轮询 |
| 页面 | `src/views/PantaoAuto.vue`（`/admin/pantao-auto`） | 角色勾选 / 参数 / 日志 / WSS 录制下载 |
