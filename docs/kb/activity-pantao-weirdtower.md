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

- `payload_setbattleteam` 在 **h5 口径被 3000070 拒绝**（混用 `mix` 口径未实测；**仅周日活动窗口可验**）。
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

# 三、两者红线

1. 蟠桃 `legion_getpayload*` **只覆盖查询和奖励**，不能替代船上的动作接口。
2. 脚本方法名**不能直接推导底层 cmd / BON body**（见 `05-redlines.md` §G）。
3. 蟠桃 `payload_setbattleteam` 在 h5 口径被拒；**别在非活动窗口盲试**。
4. 怪异塔领奖参数未知前**不要启用自动领奖**。
5. `legionmatch_rolesignup` ≠ 盐场/蟠桃报名。
