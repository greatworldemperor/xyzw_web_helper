# L2 · 参考 · 协议命令总表

> 用途：查某个 cmd 属于哪个功能、参数与响应要点。
> ⚠️ **参数以真实抓包为准**；本表是索引，权威细节在对应活动文件与 `docs/`。
> 🔴 未在 `CommandRegistry` 注册的命令**发不出去**（见 `03-protocol-connection.md`）。

## 0. 连接与握手

| 项 | 值 |
|---|---|
| 普通连接 URL | `wss://xxz-xyzw.hortorgames.com/agent?p=<token>&e=x&lang=chinese` |
| 盐场专用连接 | `xxz-xyzw-new.../agent?p=<token>&sid2=<sid>`（sid 来自 `legion_getbattlefield.info.sid`，一次性） |
| `p=` 编码 | `{roleToken, sessId, connId, isRestore}` 四字段；`sessId=100*now+rand`，`connId=now+rand` |
| 心跳 | 连接后 3s 首发，每 5000ms，`seq=0`，`cmd=_sys/ack` |
| 消息结构 | `{cmd, body, ack, seq, time}` |
| 响应匹配 | `packet.resp === seq` → 兜底 `responseToCommandMap` |

## 1. 角色 / 基础

`role_getroleinfo`（**claim 前必须对齐首帧口径 `h5/1.89.8-wx` / `scene:""`**；返回 `role.statistics`、`role.items`、`role.book`、`battleData.version`）
`role_backclaimreward`（**进主城初始化序列的末帧 = 进城结算标记**）
`rank_getroleinfo` · `role_getfirstmonthdate` · `role_commitpassword`
`fight_startlevel`（拉 `battleData.version`）· `fight_endlevel`

## 2. 金鱼 / 消耗活动

| 命令 | 参数 | 响应关键 |
|---|---|---|
| `activity_get` | `{}` | `commonActivityInfo[ID].task`（进度唯一来源）/ `record` |
| `activity_claimtaskreward` | `{activityId, missionId}`，`missionId=(slot-1)*20+round` | 5287×N；**业务码 3200020 = 已领取** |
| `item_batchclaimboxpointreward` | `{}`（请求体 `0800`） | `Item_OpenBoxResp`，一帧兑光 |
| `item_claimboxpointreward` | `{}` | 逐档（仅 smartOpenBox 用） |
| `item_openbox` | `{itemId, number:10}` | `role.items` 实时扣减；**只认整批 10** |
| `item_openpack` | `{itemId, number≤999}` | 5287→5288；**上限 999，须分批** |
| `hero_recruit` | `{recruitType:1, recruitNumber:N}` | 1001 扣减（**只认整批 10**） |
| `artifact_lottery` | `{type:2, lotteryNumber:N, newFree:true}` | `SyncRewardResp`，1012 扣减 |
| `mail_claimallattachment` | `{category:0}` | 累积 ≥32000 才领 |
| `activity_claimweekactreward` | `{typ:2, selectRewardsMap: **Map{5=>4}**}` ⚠️key 是 BON **整数 5**，必须用 `Map`（写 `{5:4}` 会编码成字符串键 `05 01 35`，差 2 字节） | 宝箱周**达标**奖励 + 兑 4×珍珠(1013)；响应 `Activity_ClaimWeekActRewardResp`（已加 responseToCommandMap）；`statistics week:act:cr:cnt:2`。**已接批量**（`activityClaimBoxWeekMilestoneRewards`，`fd14e99d`）；字节级回归 `test/boxWeekMilestoneReward.test.js` + 复现脚本 `local-data/misc/_verify_weekact.mjs` |

## 3. 养鱼 / 图鉴

| 命令 | 参数 | 响应 cmd |
|---|---|---|
| `artifact_upgradestar` | `{heroId:-1, itemId}` | `SyncResp`（resp=seq） |
| `book_batchupgrade` | `{club:0, isArtifact:true, isSkin:false}` | `Book_BatchUpgradeResp` |
| `book_claimpointreward` | `{}` | **`Item_OpenBoxResp`** |
| `presetteam_saveteam` | `{teamId:2}` | `SaveTeamResp`（**含 items 大增量 = 服务端自动合并全背包鱼**） |
| `presetteam_getinfo` / `presetteam_saveteam` | — | 阵容读写 |

## 4. 盐场

`legion_getbattlefield` · `legion_getinfo` · `legion_getopponent{phase,battlefieldId}` · `legion_getinfobyid` · `legion_getwarrank` · `legionwar_getdetails` · `legionwar_getgoldmonthwarrank` · `saltroad_getwartype` · `saltroad_getsaltroadwartotalrank`
`war_enterbattlefield{battlefieldId,useGzip:true}` · `war_getbattlefieldinfo{battlefieldId}` · `war_teamsetbattleteam` · `war_setbattleteam` · `war_invitejointeam{targetCodeId}` · `war_ping`
**未实现**：`war_startmarch` · `war_startattackbuilding{buildingId}`(实测 20/20 成功) · `war_speedup{marchId}` · `war_adjustteampos` · `war_kickoutteam` · `war_leave` · `war_resurrect`
**🔴 禁止**：`war_startbattle`（3000070）

## 5. 营地挑战

`club_getinfo` · `club_gettargetteam{targetId:Number}` · `hero_calcpowerbyteam` · `club_attack{nodeId,targetId,challengeCnt,failCnt,targetIsMirror,useItem,teamSetParams}` · `club_attackmonster{useItem,teamSetParams}` · `club_taskclaim{confId}` · `club_draw{}`
**响应映射**：`club_*` 响应命令已加入 `xyzwWebSocket.js`（只覆盖匹配，不代表发送可用）。
**计数**：`siege.attackMap[YYMMDD].attackCnt` / `.aSuccessCnt`（普通与宠物共享）。

## 6. 蟠桃

`legion_getpayloadbf` · `legion_getpayloadrecord` · `legion_getpayloadkillrecord` · `legion_getpayloadtask` · `legion_claimpayloadtask{taskId}` · `legion_claimpayloadtaskprogress{taskGroup:1|2}`
`payload_enterbf` · `payload_setbattleteam`（h5 口径被 3000070 拒） · `payload_startmarch`（请求体未抓到） · `payload_startbattle`（请求体未抓到） · `payload_ping`
`fight_startpvp{targetId}`（自动注入 `battleVersion`）
**仅注册未实测**：`legion_signup` · `legion_payloadsignup` · `league_getbattlefield` · `league_getgroupopponent` · `saltroad_getsaltroadwargrouprank`

## 7. 逍遥津

`warordertaskclaim` · `warorderrewardclaim` · `commonbuygoods` · `claimsignreward` · `getlotteryinfo` · `lottery` · `claimlotterycumulative` · `exchange`
（活动 2026-09-26 下线，源码保留）

## 8. 怪异塔

`evotower_getshareinfo` · `evotower_getsharecode` · `evotower_acceptsharebycode` · `evotower_claimreward`（**参数未知**）
`evotower_getinfo` / `evotower_readyfight` / `evotower_claimreward`（爬塔章节）

## 9. 白玉 / 预约 / 黑市 / 周活动

`activity_claimrolluppack{id:17}` · `pkroom_appoint{}`（11900050 = 已受理）
`store_purchase{}` · `store_buy{goodsId:1}` · `activity_buystoregoods{activityId,goodsIndex,buyNum}` · `collection_claimfreereward` · `discount_getdiscountinfo`
`activity_get` · `activity_buystoregoods`（黑市周 9 / 金砖 5）

## 10. 竞技场 / 竞猜 / 罐子 / 副本 / 梦境

`arena_startarea` · `arena_getareatarget`（返回 `roleList`，≤4 个） · `fight_startareaarena` · `presetteam_*`
`apex_getroleinfo` · `apex_getguesslist` · `apex_guess`（逐鹿盐山）
`saltcup26_getbetinfo` · `saltcup26_placebet`（盐杯，默认 pick=3）
`bottlehelper_stop` / `start` / `claim`
`bosstower_getinfo` / `startboss` / `startbox` · `dungeon_selecthero` · `dungeon_buymerchant`
`fight_starttower` · `mergebox_*`

## 11. 日常杂项

`system_claimhangupreward` · `study_claimreward{rewardId:1..10}` · `club_sign` · `legion_storebuygoods` · `legionStoreBuySkinCoins` · `legionmatch_rolesignup`（**俱乐部排位报名**，非盐场/蟠桃报名）
`legacy_claimhangup` · `legacy_sendgift`

## 12. 已确认的业务错误码

| 码 | 含义 |
|---|---|
| `400340` | 限流（开箱/招募等，IP 维度、各命令独立额度）→ 统一弹窗 + 5s 重试 + 15min 上限 |
| `400312` / `200400` / `429` / `12400000` | 限流/请求过频 |
| `3200020` | 金鱼 claim：**奖励已领取**（正常业务拒绝） |
| `200020` | 目标不可查/会话异常（非当天 oppoMap 键、账号级 token 会话等）→ **可致"全帧入队挂死"** |
| `3000070` | 平台口径拦截（盐场 PVP、蟠桃 setbattleteam） |
| `11900050` | 预约比赛：**已受理**（非失败） |
| `12200020` | 爬塔：需先补领 evotower 章节奖励 |
| `12200090` / `12200100` | 见 `src/utils/protocolError.js` |
| `800080` | 推关：轻方案合成结果被拒 |
| `400340`（挂机/加钟） | 视为限流，1s 间隔最多重试 100 次 |
| **`200060`** | **金砖数量不足**（买竿 `system_buyitem` 超出余额；2026-10-01 38号战士实测） |
| **`400010`** | **物品数量不足**（英雄升星 `hero_heroupgradestar` 材料不够 → 升星链无产出） |
| **`600010`** | **图鉴等级已达上限**（`book_upgrade`，正常终止不是错） |
| **`600020`** | **不满足图鉴升级条件**（`book_claimpointreward`） |
| **`2300100`** | **没有权限**（init 序列里如 `legion_applylist`，可忽略） |
| **`200160`** | **模块未开启**（如 `apex_getroleinfo`，可忽略） |

> 📌 **诊断日志格式区分（2026-10-01 踩坑）**：`local-data/**/*.jsonl` 有两种，工具不通用：
> - **runtime 抓包**：`{"id":..,"source":"iframe","event":"ws:send","payload":{...frame:base64...}}`
>   → 用 `local-data/goldenfish/_gf.mjs <file> cmds|sends|struct|grep`；
> - **连接诊断（批量页「导出诊断」）**：`{"t":..,"tokenId":"..","kind":"ws.send|ws.resp|ws.resp.err","cmd":..,"params"/"body"/"code"/"err"}`
>   → 用 `local-data/_dump_diag.mjs <file>`（`_gf.mjs` 对它**恒返回 0 帧**，别误判成"文件坏了"）。
