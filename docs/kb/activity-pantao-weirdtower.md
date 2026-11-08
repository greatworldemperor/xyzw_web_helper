# L2 · 蟠桃 + 怪异塔助力

# 一、蟠桃（军团即时战斗）

> 实现：`src/utils/pantaoConfig.js` · `pantaoPlan.js` · `pantaoSession.js` · `pantaoState.js` · `src/utils/PeachTaskIds.js` · `src/utils/batch/tasksPantao.js` · `src/views/PantaoAuto.vue`（`/admin/pantao-auto`）
> 文档：`docs/pantao-protocol-catalog.md` · `docs/pantao-auto-feasibility.md` · 抓包：`local-data/pantao/`(54) + `pantao-analysis/`

## 状态：✅ 已接线（独立页 + 批任务）

`planTurn` / `State` 有回归；任务领取产线正常。

## 🔴 并发口径（2026-11-01 切号提速，master：100+ 号要打完比赛）

**「每批并发」是唯一旋钮**（蟠桃页「执行参数」，localStorage `pantaoAutoSettings.concurrency`，1~50，默认 3），
同时驱动三处，改一处其余自动跟随：

| 节流点 | 位置 | 生效值 |
|---|---|---|
| 分批轮询批大小 | `runPantaoRoles`（planPollingBatches） | = concurrency |
| 主连接槽位 | PantaoAuto.vue `batchSettings.maxActive`（原写死 3 → **getter 跟随**） | = concurrency |
| 战场闸门 | `createGate`（pantaoPlan 纯逻辑层，`setMax` 运行中抬升） | max(配置 maxActiveBattlefield, concurrency) |

- 坑史：原先 maxActive 写死 3 + gate 只在 setup 取值一次 ⇒ UI 并发调 20 也只有 3 个号同时建连，切号提速是空谈。
- `connectionQueue` 计数器是跨页面共享单例（批量/盐场同源），但上限各页管各页；`ensureConnection` 幂等路径不占槽
  而调用方 finally 无条件 release ⇒ active 向宽松漂移（有 >0 下限保护，只会放宽不会死锁）。
- 批间间隔 = minIntervalMs × log₂(concurrency+1) 自动拉长，规避同 IP 限流；批次看门狗 batchWatchdogMs=180s 不随并发缩放。
- `createGate` 单测在 test/pantaoTasks.test.js（放 pantaoPlan 是因为 tasksPantao import 链带 `import.meta.env`，纯 node 碰不得）。

## 命令清单

| 命令 | 说明 |
|---|---|
| `legion_getpayloadbf` | 战斗时间内获取实时双方俱乐部信息（读 `legions`，按本方 clubId 找对手） |
| `legion_getpayloadrecord` | 历史对战日期 → 对手俱乐部映射（`enemyLegionMap[shortDate].id`） |
| `legion_getpayloadkillrecord` | 按日期取双方参战/击杀记录（`recordsMap[legionId]`）：`roleInfo.roleId` / 名称 / 头像 / `killCnt` / `reviveCnt` / `mCKCnt` / `carCnt` |
| `legion_getpayloadtask` | 任务与进度（`payloadTask.taskMap` / `legionPoint` / `selfPoint` / `progressMap`） |
| `legion_claimpayloadtask` | `{taskId}` 领单个任务 |
| `legion_claimpayloadtaskprogress` | `{taskGroup:1}` / `{taskGroup:2}` 领俱乐部积分 / 个人积分奖励 |
| `legion_getinfobyid` | 双方俱乐部详情 |
| `rank_getroleinfo` | 参战角色完整信息 |
| `presetteam_getinfo` | 阵容 |
| `fight_startpvp` | `{targetId}` 手动切磋（`tokenStore` 自动注入 `battleVersion`） |
| `payload_enterbf` | 进入蟠桃战场 |
| `payload_setbattleteam` | 提交主阵容 |
| `payload_startmarch` | 行军（**请求体未抓到**，按响应反推，可覆写） |
| `payload_startbattle` | 攻击（**请求体未抓到**） |
| `payload_ping` | 心跳 |

## ⚠️ 卡点

- ❌ **2026-11-01「只认 App 口径」根因已被 11-08 实机 A/B 证伪，勿再照此修**：`a6c6fc1`（蟠桃会话主连接首帧切 `hortor/mix/0.36.0-android`）确实上线，但 11-08 实战 41 号仍全灭（30 个 `payload_setbattleteam` → 3000070）。当晚用 bin 实机逐项排除：首帧 h5→官方 mix、进主城 36 帧、`hero_calcpowerbyteam` ×3、战场 URL（与官方 pcap 握手逐字一致）、body 全字段变体（petUId / 官方全套阵容 / 数组 / 战场连接上报 mix）、战场连接独立 `sessId/connId`、authuser 去自定义头、换角色 —— **全部仍回 3000070**。⇒ 首帧口径、主连接序列、URL、票据、body 都不是判据；真串 `0.36.0-android` 是否周更也不再是关键。
- 🔴 **2026-11-08 定案：3000070 = `payload_setbattleteam` 命令专属的客户端校验**。同一战场连接上 `payload_startbattle`→200020、`payload_getbattlefieldinfo`→-1、`payload_startmarch`→12100036，各回各码；活动结束后 `enterbf` 回 `12100036 蟠桃大会已结束` 时布阵仍回 3000070 ⇒ **与进场状态无关**，活动关闭后仍可做探针。⚠️ 但战场实例约在结束后 1.5h 全部销毁（21:0x 还能连 `261108:7513`，22:1x 起所有 sid 一律 `_sys/fatal server not found`），窗口有限，开赛第一时间就要测。
- ✅ **已修的确定 bug（非 3000070 主因）**：官方 `payload_setbattleteam.battleTeam` 键是 **BON Int 0~4**（`pantao_1101.pcap` s00 #00030），`buildBattleTeamFromPreset` 返回普通对象会编成 String("0"~"4")、body 121B→111B（11-01「命令结构逐字段一致」是被解码后都显示 `{"0":116,…}` 骗了）。已加 `pantaoPlan.toBonIntKeyBattleTeam`（转 `Map(number→number)` 走 `encodeMap`），`PantaoSession.setBattleTeam` 调用；`test/pantaoPlan.test.js` 有官方 121B fixture 逐字节回归 + 3 例。⚠️ 实机证明单独修它不能解 3000070。
- 🔴 **下一个待验方向（按概率）**：① **登录凭证层** —— master 提供的官方 App bin（`auth/20261108/1794146964097_body`）与 `wechat.bin` 结构差异大：角色级（serverId=9751）、`info` 为 2135 字符串（微信 bin 是 `{encryptCombUser,timestamp,sign}` 对象）、多 `oriPlatform` / `deviceUniqueId`(40字符)、`scene:0`；该 bin 的阵容 `{108,120,116,112,109}` / `weaponId:8` / `petUId:"247-KyX"` 与 10-04 官方成功抓包逐字一致 ⇒ **就是官方成功玩家**。用它在活动窗口跑一次即可一发定性（注意不是「多套 token 鉴权」：authuser 单端点、`p=` 四字段，只是凭证携带的渠道/设备标记不同）。② WS 握手 `Origin: http://xxz-xyzw-new.hortorgames.com`（官方带、Node 内置 WebSocket 不带；实验脚本已备 `--pantao-ws-origin 1`）。③ 角色参赛名单/资格（换号也 3000070，概率偏低）。
  - 工具：`local-data/bin-test/bin-test.mjs --run pantao`（开关见脚本头，含 `--pantao-bfid` / `--pantao-patch-bin` / `--pantao-mapteam` / `--pantao-main-cmd` 等）；固定同一角色做 A/B。主连接不实现布阵命令（直发会超时）。
- `payload_startmarch` / `payload_startbattle` 请求体 ✅ 已补全（2026-10-29/11-01 官方模拟器抓包 `pantao_1101.pcap`）：`startmarch {bfId, carId, path:[{x,y}…]}`（逐格路径）、`startbattle {bfId, targetId}`；响应**广播式**（无 resp 匹配，错误信封例外：10000120 目标战斗中 / 10000130 自己战斗中）；`payload_startbattle` **无 3000070 拦截**。

## 相关源码脚本（协议线索，非主项目封装）

`scripts/全自动蟠桃园.js`：
- `startBattle(force)` 进场；`sendSetBattleTeam(battleTeam, lordWeaponId, petUId)` 提交主阵容；
- `sendMarch(path)` 普通行军；`sendGetCar(carId, path)` 向车辆行军/上车；`sendPickItem()` 拾取道具；`sendUse(carId)` 使用车辆道具；`sendBattle(enemyId)` 攻击附近敌人。
- 读 `lPWarData.battlefield` / `self` / `roles` / `carData` / `itemData` / 位置 / 死亡复活状态，按距离选车辆/敌人/道具。
- 有自动进场、布阵、复活后重进、自动上车、自动拾取、用车道具、攻击；**未发现报名、领奖或明确的夺船控制权方法**。

## 🔴 未掌握的能力（不能从任务配置反推）

主项目 `src` 的标准 BON/WebSocket 命令链**未发现**：蟠桃船出发/护送/移动/登船/下船、攻击船上玩家/抢夺控制权/使用花盆、独立结算提交接口。
`src/utils/PeachTaskIds.js` 里大量"送船/抢船/花盆/击杀/控制权"描述**只是任务配置**，不能证明对应请求命令已被掌握。

## 仅注册、尚未接线实测的命令

`legion_signup`(盐场报名) · `legion_payloadsignup`(蟠桃报名) · `league_getbattlefield` · `league_getgroupopponent` · `saltroad_getsaltroadwargrouprank`
⚠️ `legionmatch_rolesignup` 是**俱乐部排位报名**（`Rank.vue` / `GameFeatures.vue` 在用），**不要**与盐场 `legion_signup` / 蟠桃 `legion_payloadsignup` 混同。

---

# 二、怪异塔助力（幻塔分享助力）

> 实现：`src/utils/weirdTowerSharePlan.js` · `src/utils/weirdTowerShareWindow.js` · `src/stores/weirdTowerAssist.js` · `src/components/**/WeirdTowerShareCard.vue`
> 文档：`docs/weird-tower-share-code-protocol.md` · `docs/weird-tower-share-assist-design.md`

## 状态：✅ 已上线（卡片 + 弹窗 + 批量页 4 按钮）

两条命令**逐字节复现**；窗口判定 + 自动分配 **29 例回归**（`test/weirdTowerShare*.test.js`）。

## 命令

| 命令 | 说明 |
|---|---|
| `evotower_getshareinfo` | 查询助力信息 |
| `evotower_getsharecode` | 取/生成分享码 |
| `evotower_acceptsharebycode` | 用分享码接受助力 |
| `evotower_claimreward` | **领奖（参数未知，待补抓）** |

## ⚠️ 待办

- `evotower_claimreward` 参数未知 ⇒ **待 10-02 活动窗口补抓**。
- `shareTask` 能否**先查额度**未决。
- **周期键滚动**未确认。

---

# 二·B、怪异塔俱乐部 legion buff（俱乐部人数档位）

> 抓包：`local-data/weird_tower/evotower_get_buff.jsonl`（2026-10-02，38 帧，9730 服「第二批」21 人）
> 文档：`docs/weird-tower-legion-privilege-analysis.md`
> 解码脚本：`local-data/weird_tower/_decode_get_buff.mjs`

## 状态：✅ 已接线 —— **爬塔时自动领取**（无需手动按钮）

> 逻辑：`src/utils/weirdTowerLegionBuff.js`（`autoClaimLegionBuffDuringClimb`）
> 入口A：`src/utils/batch/tasksTower.js` L784（批量爬塔）· 入口 B：`src/components/Tower/WeirdTowerStatus.vue` L525（单号爬塔）
> 展示：`src/components/Club/ClubWeirdTowerLegionBuff.vue`（**只读**四档卡片）
> 测试：`test/weirdTowerLegionBuff.test.js`（41 例）+ `tools/weirdtower/legion-buff-replay.mjs`（真实抓包回放 21 例）

## 🔴 业务口径（master 2026-10-03 定）

**领取是爬塔的前置步骤，不是独立按钮。** 爬塔本来就要拉 `memberScores`（人数已在手），
能领就领、领不到直接爬塔。与既有的 `claimPendingEvoTowerRewards`（爬塔前补领章节奖励，
否则 `readyfight` 被拒 12200020）同一模式。

**判据不能用「对比已领取 vs 已解锁」** —— 顶层 `legionPrivilege` 领取前是 `{}`、
领取后给全量，无法区分二者。改用**发空 body 试探**：服务端给档位就继续领，给空就收手。
判断权完全交给服务端。

**任何失败都不阻塞爬塔**（buff 是增益不是前置条件）：
- `getinfo` 失败 → 跳过
- `claim` 失败 → 保留已领档位，继续爬塔
- 硬上界 `for i < 4`（4 档到顶），不可能死循环

## 规则

- buff 档位由**本俱乐部本期已参与怪异塔战斗的角色数**决定，4 档：**10/15/20/25 人**。
- 俱乐部归属**首次战斗时绑定**（`bindLegionId` 由 0 变真实 id），绑定前拿不到 buff。

## 命令

| 命令 | body | 响应关键字段 |
|---|---|---|
| `evotower_getlegionjoinmembers` | `{}` | `memberScores` = `{roleId: 最高层数}`，**key 数 = 参与人数** |
| `evotower_claimlegionprivilege` | `{}` | 顶层 `legionPrivilege` = **已解锁全量档位**；`body.evoTower.legionPrivilege` = **本次新领档位** |
| `evotower_getinfo` | `{}` | `evoTower.legionPrivilege`（领取前为 `{}`）、`evoTower.bindLegionId` |

## 🔴 两条关键口径

1. **`claimlegionprivilege` 一次只领一档**，21 人需连点 **3 次**（seq 50/52/53 分别领到 `{1:1}`/`{2:1}`/`{3:1}`）。请求体**无参数**，服务端决定给哪档。
2. **顶层 `legionPrivilege` 不是本次结果**，三次调用恒为 `{1:1,2:1,3:1}`。拿它做增量判断会误判「已全领完」。

## 证据（21 人 → 命中 1/2/3 档，第 4 档 25 人未达）

| seq | cmd | 响应 |
|---|---|---|
| 43/47 | `evotower_getinfo` | `legionPrivilege: {}`（领取前空）· `bindLegionId: 7203672` |
| 49/51/54 | `getlegionjoinmembers` | 21 个 key，三次完全一致（稳定快照） |
| 50 | `claimlegionprivilege` | `evoTower: {1:1}` |
| 52 | `claimlegionprivilege` | `evoTower: {2:1}` |
| 53 | `claimlegionprivilege` | `evoTower: {3:1}` |

## 缺口

- 阈值 10/15/20/25 **协议不下发**（服务端内部维护）⇒ 前端硬编码在 `weirdTowerLegionBuff.js`，已标注来源为活动规则。
- 第 4 档（25 人）**抓包未覆盖**（当时俱乐部只有 21 人）⇒ 逻辑与前三档同构，由 25 人边界用例覆盖；真机满级验证待下次活动。
- ⚠️ 抓包信封有**两层**：业务字段在 `envelope.body`，不是 `envelope`。写回放断言前先log 真实结构。

---

# 三、两者红线

1. 蟠桃 `legion_getpayload*` **只覆盖查询和奖励**，不能替代船上的动作接口。
2. 脚本方法名**不能直接推导底层 cmd / BON body**（见 `05-redlines.md` §G）。
3. 蟠桃 `payload_setbattleteam` 在 h5 口径被拒；**别在非活动窗口盲试**。
4. 怪异塔领奖参数未知前**不要启用自动领奖**。
5. `legionmatch_rolesignup` ≠ 盐场/蟠桃报名。
6. 怪异塔 `claimlegionprivilege` **顶层 `legionPrivilege` ≠ 本次结果**（是已解锁全量档位），自动领取循环必须看 `body.evoTower.legionPrivilege`。
7. 怪异塔 `claimlegionprivilege` **顶层 `legionPrivilege` 领取前为空、领取后给全量** ⇒ **不能**用它做「已解锁 vs 已领取」的增量判断（会第一次就误判领完）。判据只能用「发空body 试探 + 看嵌套字段」。

## 官方成功战斗基准（261004 战场，2026-10-04 实测）

来源：模拟器 HttpCanary 抓包 `captures_keep/pantao_261004/`（wss1/2/3_partial=主连接+首战场连接，wss5_partial=重连后战场连接）。
⚠️ 排时间线的坑：**HttpCanary 文件名时间戳 = 手动保存时刻（晚 ~36min），帧内 `time` 字段才是真实收发时刻**。
解码器：`local-data/pantao/_decode_261004.mjs`（全量解码 + 关键帧 + 导出 `_decoded_full.txt` / `_decoded_wss5.txt`）。

### 官方时间线（帧内 time 还原）

| 时刻 | 动作 | 备注 |
|---|---|---|
| 19:55:15 | `legion_getinfo/getpayloadtask/getpayloadbf` | 与工具 probe 流同构 |
| 19:55:23 | `payload_enterbf`（bfId 261004:12982，ready 期进场） | |
| **19:56:11** | 双连接 `_sys/error conn timeout` 断线 | **官方也断线重连** |
| 19:57:17 | 新主连接 `fight_startlevel`（Resp `battleData.version=240518`）+ hall/legion/activity | |
| 19:57:32 | 第二战场连接 `payload_enterbf`（同 bfId 重进） | |
| 19:58:47 | `Payload_EnterBfResp` ×3（战场快照：legions/roles/tileData） | |
| 20:00:00 | `Payload_StateChangeNotify {state:"started"}` ×2 | 开打信号 |
| 20:00:01 | `hero_calcpowerbyteam` ×2（第二次带 `petUId:"247-KyX"`）+ `presetteam_getinfo` | 登场前算战力 |
| **20:00:14** | **`Payload_SetBattleTeamResp`：130301444（本号）`state:idle` + petUId 247-KyX**（同秒 132025603/139073239 也 idle）| **登场确认 = 开打后 ~14s** |
| 20:00:20+ | `Payload_StartMarchResp`（marchId 逐格）→ `Payload_EndMarchNotify`（每格一帧）→ 上船（`carMap`）→ `Payload_CarMoveNotify` | 行军→登船流 |

### 对工具的校验结论

- 工具流程（probe → enterbf → setbattleteam → planTurn 行军/上船）与官方序列**一致**，petUId 透传 ✓。
- 官方 ready 期就 enterbf 挂着等开打；工具可参考：进场不必等开打。
- 蟠桃战场广播依旧**零平台/版本字段**；官方客户端全程 0 次 3000070。
- 缺帧：官方自己的 `payload_setbattleteam` SEND 帧（手存遗漏，Resp 已足够）；登录首帧（需冷启动重抓）。

### ✅ 官方 `payload_setbattleteam` SEND 帧实抓（10-04 补全，wss_pantao_start/）

20:00:13 seq=10（开打后 13s，Resp 前 1s）：
```json
{"bfId":"261004:12982","battleTeam":{"0":108,"1":120,"2":116,"3":112,"4":109},"lordWeaponId":8,"petUId":"247-KyX"}
```
→ 1 秒后（20:00:14）Resp：本号 `state:idle` + petUId 回读。**与工具 `PantaoSession.setBattleTeam` 的命令结构逐字段一致**（{bfId, battleTeam, lordWeaponId, petUId}）—— 命令层零差异，工具唯一曾输在口径版本与静默 bug（均已修）。时序：开打 20:00:00 → 客户端算战力+查预设（~13s）→ 20:00:13 发布阵 → 20:00:14 确认 idle → 20:00:15 GenCarNotify（船生成）→ 20:00:20 startmarch（2s/格）。
