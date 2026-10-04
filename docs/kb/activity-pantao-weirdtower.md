# L2 · 蟠桃 + 怪异塔助力

# 一、蟠桃（军团即时战斗）

> 实现：`src/utils/pantaoConfig.js` · `pantaoPlan.js` · `pantaoSession.js` · `pantaoState.js` · `src/utils/PeachTaskIds.js` · `src/utils/batch/tasksPantao.js` · `src/views/PantaoAuto.vue`（`/admin/pantao-auto`）
> 文档：`docs/pantao-protocol-catalog.md` · `docs/pantao-auto-feasibility.md` · 抓包：`local-data/pantao/`(54) + `pantao-analysis/`

## 状态：✅ 已接线（独立页 + 批任务）

`planTurn` / `State` 有回归；任务领取产线正常。

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

- `payload_setbattleteam` 在 **h5/1.89.8 口径被 3000070 拒绝**；**官方模拟器同场景已实测通过（10-04 定稿）**：09-13 batch3 与 09-20 wssa5 官方客户端（MuMu 模拟器；**版本串未捕获**，platform 推定 mix）布阵均 `state:idle` 成功（09-20 还是与 h5 被拒**同一战场 13059**、晚 76 分钟），官方全程 0 次 3000070 ⇒ 被拒的不是命令本身而是口径；工具为 mix 口径（现已升 2.48.2，f5332a8e）⇒ 预期通过。证据：`local-data/pantao/pantao_success_extract/` + `_wssa_decoded.txt`/`_batch_decoded.txt`。**注意：工具串 `2.48.2-fa918e1997301834-wx` 中段 hash 身份未定（AppID/每周构建 hash/静态标识三选一，见 pantao-protocol-catalog §7.5），若实测被拒，第一动作=抓模拟器登录首帧拿真串。**
- `payload_startmarch` / `payload_startbattle` 请求体**未抓到**（按响应反推，实现提供了覆写口）。

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
