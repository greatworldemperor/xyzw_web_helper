# 周年庆「一次性奖励 + 每日签到助力 + 闯关打BOSS」协议

> 抓包：`local-data/anniversary/ann_daily_boss_full.jsonl`（2026-10-17 01:32~01:35 北京时间，
> runtime-analysis jsonl，158 帧，角色 **9736服-139073239-法王**，页面
> `admin/push-level-research`，被动捕获 captureRawFrames）
> 解码（走生产 `bonProtocol.js`，红线：永不手写解码器）：
> - `node --import ./local-data/_alias_loader.mjs local-data/anniversary/_decode_boss_jsonl.mjs` → 77 个 SEND 帧
> - `node --import ./local-data/_alias_loader.mjs local-data/anniversary/_decode_boss_recv.mjs` → 81 个 RECV 帧
> - `node --import ./local-data/_alias_loader.mjs local-data/anniversary/_check_iswin.mjs` → 8/8 场 isWin=true
> - `node --import ./local-data/_alias_loader.mjs local-data/anniversary/_verify_reencode.mjs` → **11/11 请求逐字段复现一致**
>   （字节层唯一差异 = BON map 键序：游戏本体 `ack,body,time,seq,cmd` vs 注册表
>   `cmd,ack,seq,time,body`；BON map 无序，服务端解码与顺序无关，帧长完全一致）
>
> 落地：批量页「**临时活动**」→ 三个按钮（2026-10-17 接入）：
> 「领取周年庆一次性奖励」「领取周年庆每日奖励/助力」「周年庆攻打BOSS」
> （`batchAnnOneTimeReward` / `batchAnnCelebrateClaim` / `batchAnnBossFight`，
> 模块 `src/utils/batch/tasksAnnBoss.js`）。

## 1. 与「换皮闯关」的差异（为什么旧入口打不了本活动）

游戏界面形式相同（`towers_*` 六宫格 BOSS 挑战、8 层、通关领奖），但协议层是**两个活动**：

| | 换皮闯关（旧） | 周年庆闯关（本活动） |
|---|---|---|
| **actId** | `getTowerActId()` 按「本周五」推算：`YYMMDD1`（2026-10-17 当周 = **2610161**） | 固定 **2610163**（抓包 `Towers_GetInfoResp.towerData.actId` 实证） |
| **towers_getinfo 结果** | 发 2610161 → 服务端空响应 → 旧功能记「活动信息获取失败」直接 return | 发 2610163 → 正常返回六宫格状态 |
| **通关后领奖** | `activity_startactegame {actId: actId+1}` 轮领 | 无轮领命令：`levelRewardMap` 1001~1008 抓包时已全 true，每层奖励随战斗自动到账 |
| **同屏其他模块** | 无 | celebrate（签到/全服助力/读卡/个人奖励）+ `common_claimtotalreward`（一次性奖励） |
| **今日挑战计数** | UI「今日挑战 X/10」= `todayUseTickCnt` | 同字段，但语义 = **start 次数**（抓包 1 次 start + 8 次 fight，`todayUseTickCnt` 全程 = 1） |

⇒ 旧功能（`SkinChallengeCard.vue` / `tasksTower.js skinChallenge`）不是坏了，是 **actId 对不上**；
本活动窗口（actId 2610163 → 2026-10-16 起 7 天）内用新入口打。

## 2. 命令与请求体（逐字段复现存证）

| 步骤 | 命令 | 请求体 | 响应 |
|---|---|---|---|
| 一次性奖励 | `common_claimtotalreward` | `{activityId: 2610167, configId: 261016701}` | `Common_RewardResp`：`reward = [5292 ×1, 37011 ×1]`；`activity.commonActivityInfo["2610167"].record["261016701"] = 领取时间戳` |
| 每日签到 | `celebrate_sign` | `{}` | `Celebrate_GetCelebrateInfoResp`（**不是 `_signresp`**）：`personalSignMap` 写入 `{"261017": 时间戳}`（键 = 日期 26-10-17） |
| 全服助力 1 | `celebrate_claimfullserver` | `{idList: [1]}` | `Celebrate_ClaimResp`：`reward = [{type:21, itemId:90111, value:1}]`（集卡）；`fullServerClaimMap["1"] = 时间戳` |
| 集卡读卡 | `linkcard_readcard` | `{cardId: 90111, readNum: 1}` | `SyncResp`：`role.linkCard["90111"].readNum` 0→1 |
| 全服助力 2 | `celebrate_claimfullserver` | `{idList: [2]}` | `Celebrate_ClaimResp`：`reward = [{type:3, itemId:1001, value:10}]`（金币） |
| 个人奖励 | `celebrate_claimpersonal` | `{idList: [1]}` | `Celebrate_ClaimResp`：`reward = [{type:3, itemId:1001, value:3}]`；`personalClaimMap["1"].signState` 1→2 |
| 闯关信息 | `towers_getinfo` | `{actId: 2610163}` | `Towers_GetInfoResp`（结构见 §3） |
| 闯关开打 | `towers_start` | `{actId: 2610163, towerType: 2}` | `Towers_StartResp`：该格 `fighting: true` |
| 闯关战斗 | `towers_fight` | `{actId: 2610163, towerType: 2}` | `Towers_FightResp`（结构见 §4） |

全服助力档位与个人奖励档位按抓包实证硬编码（fullserver [1,2] / personal [1]）；
未领的档位服务端会拒，实现按 benign 跳过。**本期一次性奖励只有 configId 261016701 一个**
（抓包只出现这一个；若有多的按同格式往 `ANN_ONETIME_CONFIG_ID` 列表加）。

## 3. Towers_GetInfoResp 结构（注意两层 towerData）

```
body.towerData = {                       ← 外层
  actId: 2610163, season: 45,
  useTickCnt: 1, todayUseTickCnt: 0,
  towerData: {                           ← 内层：六宫格 Map，键 = "1".."6"
    "2": { towerType: 2, fighting: false, actTowerLv: 1, winCnt: 0, maxWinCnt: 0,
           curMonsterStateData: {}, curHeroStateData: {}, monsterMaxHp: {61~65: 3608745},
           towerScore: 0, pass: false },
    ...（1/3/4/5/6 同构）
  },
  levelRewardMap: {1001: true, ..., 1008: true}   ← 已全领（按层一次性奖励）
}
```

- `pass` = 当日是否已通关该 BOSS；**每日重置**（抓包账号前一天打过、levelRewardMap 全 true，
  但 towerData 回到 lv1/0 胜）⇒ 次日可重打拿战斗奖励。
- `fighting` = 有未打完的战斗（上次中断）⇒ 续打不需要重新 `towers_start`。
- 活动未开/actId 错 ⇒ 空响应或错误信封，实现记「暂未开放」跳过。

## 4. Towers_FightResp 结构（胜负判定）

```
body = {
  reward: [{type:3, itemId:1001, value:2}, {type:3, itemId:40009, value:1}],  ← 每场战斗奖励，数量随层数涨
  todayUseTickCnt: 1,
  towerData: { towerType: 2, fighting: true, actTowerLv: 2, winCnt: 1, ..., pass: false },
  battleData: { id, mode: 18, randomSeed, version: 240519, leftTeam: {...}, rightTeam: {...},
    result: { id, isWin: true, seed, totalFrame, ..., accept: { teamInfo: [...怪物方...], ext: { curHP: 0 } } } }
}
```

- **主判 `battleData.result.isWin`**（抓包 8/8 = true）；
  兜底 `result.accept.ext.curHP === 0`（旧功能口径，怪物方全员血量归零）；
  再兜底 `towerData.winCnt` 比打之前涨了（`isFightWin(res, prevWinCnt)`）。
- 通关判定 `towerData.pass === true`（第 8 层胜利那场）。
- 奖励梯度（金币 1001）：第 1 场 ×2 → 第 8 场 ×5；券 40009 同步 ×1~×3。

## 5. 抓包实战序列（master 手动全流程，8 场无失败直接通关）

```
01:32:09  common_claimtotalreward {2610167, 261016701}     → 5292+37011
01:32:13  activity_commonbuygoods {26101661}               → 40009 ×35（礼包购买，本功能不包含）
01:32:16  celebrate_getcelebrateinfo {}                    → fullServerSignCnt: 1480658
01:32:20  celebrate_sign {}                                → personalSignMap{261017: ts}
01:32:22  celebrate_claimfullserver {idList:[1]}           → 集卡 90111
01:32:23  linkcard_readcard {90111, 1}                     → readNum 0→1
01:32:27  celebrate_claimfullserver {idList:[2]}           → 金币 ×10
01:32:36  celebrate_claimpersonal {idList:[1]}             → 金币 ×3
01:32:40  towers_getinfo {2610163}                         → 六宫格全 lv1
01:32:42  role_gettargetteam / hero_calcpowerbyteam / team_setteam  ← 游戏本体读阵容，自动化不需要
01:32:43  system_custom "act:multiTower:1:2610163" = 1792166400000  ← 客户端本地簿记，自动化不发
01:32:43  towers_start {2, 2610163} + towers_fight ×8（每场间隔 ~15s = master 看动画）
          → actTowerLv 1→8, winCnt 0→8, 第 8 场 pass:true 通关
          （每场后客户端 system_custom "act:multiTower:successCount:1:2610163" 累加，同样不发）
01:35:24  role_backclaimreward {}                          → 离线奖励，本功能不包含
```

- `team_setteam`（teamType 6 = 闯关阵容）是游戏本体进 UI 时的读队-算战力-存队流程，
  服务端用账号现有阵容打，**自动化无需 replicate**。
- `system_custom` 两个键（`act:multiTower:1:2610163` = 当日零点时间戳、
  `act:multiTower:successCount:1:2610163` = 累计胜场）是客户端本地簿记透传服务端存储，
  towerData 全在服务端权威字段里，自动化不发（出问题再补）。

## 6. 实现口径（tasksAnnBoss.js）

- **三个独立按钮**（一次性 / 每日助力 / 打BOSS），都走 `runForSelectedTokens` 骨架：
  `ensureConnection` → 干活 → `finally closeWebSocketConnection + releaseConnectionSlot`，
  与 `tasksAnnDaily` / `tasksSeasonOutCheer` 同口径。
- **领取类不前置探测**，按抓包顺序直接发；已领取 / 未达成 / 未开放 / 已结束全算 benign；
  `400340` 限流立即停该账号剩余动作。
- **打BOSS前置一次 `towers_getinfo`** 探活 + 选目标：
  今日开放（周五 BOSS1 / 周六 BOSS2 / 周日 BOSS3 / 周一 BOSS4 / 周二 BOSS5 /
  周三 BOSS6 / 周四全开 —— 与换皮闯关同口径，抓包日周六打 BOSS2 吻合）
  且 `pass !== true` 的 BOSS 逐个打；
  **每个 BOSS 最多 10 战**（`ANN_BOSS_MAX_FIGHTS`，8 关 + 失败冗余，master 2026-10-17 口径：
  「可能会失败，所以一共 10 次机会」），通关即停；
  `fighting: true` 的中断局续打不重新 start；失败一场重新 start 再打。
- 战斗间隔 1000ms、start 后 500ms、领取间隔 500ms（抓包手点 ~15s 含看动画，自动跑不需要）。
- 命令注册：`common_claimtotalreward` / `celebrate_getcelebrateinfo` / `celebrate_sign` /
  `celebrate_claimfullserver` / `celebrate_claimpersonal` / `linkcard_readcard`
  （2026-10-17 新增，注册表 212 → 218；`towers_*` 换皮闯关时已注册）。
  响应映射：`commonrewardresp += common_claimtotalreward`；
  `celebrate_getcelebrateinforesp → [celebrate_getcelebrateinfo, celebrate_sign]`；
  `celebrate_claimresp → [celebrate_claimfullserver, celebrate_claimpersonal]`；
  `syncresp += linkcard_readcard`。
  ⚠️ `celebrate_sign` 成功回的是 `Celebrate_GetCelebrateInfoResp`（resp=seq 兜底匹配也能中，
  映射补上双保险）。
- 回归测试：`test/annBossTasks.test.js`（常量 / 开放日程 / 选怪 / 胜负判定 / 错误分类）。
- **活动结束清理**（按逍遥津 / 赛季助威先例）：移除 `tasksAnnBoss.js` 的导出与页面三按钮、
  flexibleTemplate 三个 task 项；测试保留；本文档保留作历史记录。

## 7. 待确认 / 风险

- 全服助力档位可能随全服签到量解锁更多（抓包时刻 148 万签，只有 1/2 两档可领）——
  解锁新档位后往 `ANN_CELEBRATE_FULLSERVER_IDS` 追加即可。
- 周四全开 6 BOSS × 最多 10 战 = 60 请求/账号；若服务端有每日 fight 上限
  （`todayUseTickCnt` 只记 start 次数，未能可靠反映），超限会走 benign 错误分支，
  日志可见，不影响其他账号。
- 一次性奖励 configId 只有 01 实证；若 UI 出现多个一次性奖励按钮，按
  `2610167XX` 格式追加。
