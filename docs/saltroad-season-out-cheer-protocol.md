# 盐场「赛季淘汰赛助威」协议（天工投票）

> 抓包：`local-data/tiangong_vote/vote.jsonl`（2026-10-15 22:46~22:47 北京时间，9736服「法王」，
> runtime 被动抓包，46 帧；token `⁹⁷³⁶法王-0-139073239`）
> 逐字节复现：`verify_roundtrip.mjs --dir send` → 目标 4 命令 **全部精确、0 失败**
> （另 8 帧为 1 字节明文心跳，属预期）。
> 落地：批量页「临时活动」→ 赛季淘汰赛助威（`batchSeasonOutCheer`，2026-10-15 接入）。

## 1. 玩法与结论速查

赛季期间**最强 64 家俱乐部**打「瑞士轮 + 淘汰轮」的淘汰赛（`SEASON_SWISS_ROUND_OF_1..4` /
`SEASON_KNOCKOUT_ROUND_OF_1..3`，见游戏 bundle `LegionWarSeasonOutStage4Data`），
普通玩家可以给其中一家**助威（投票）**：

- **一账号一届一次**：助威记录落在 `role.statistics["sr:out:cheer:<赛季首轮日期>"]`，
  键里的日期是**赛季首个赛程**（SEASON_SWISS_ROUND_OF_1）的 `yyMMdd`（本例 `261003`），
  整届不变 ⇒ 投过第二家会被服务端拒绝。
- **助威面板** = `saltroad_getseasonoutrank` 的 `legionList` 按 `sOWinCnt` 降序
  （同胜场保持服务端原序）**取前 64**。不是对战表！
- **对战表**（谁打谁）在 `saltroad_getoutopponent {phase}`，phase 形如 `261016`（比赛日期），
  但该 phase 来自客户端配置 `SeasonLegionScheduleConf`，**服务端没有查询接口** ⇒ 本工具不做对战表。

## 2. 命令清单（请求 → 响应）

| 命令 | 请求 body | 响应 |
|---|---|---|
| `saltroad_getseasonoutrank` | `null` | `SaltRoad_GetSeasonOutRankResp { round, legionList[] }` |
| `saltroad_outcheer` | `{ legionId: <number> }` | **`SyncResp`** `{ role.statistics["sr:out:cheer:<phase>"] = legionId }` |
| `saltroad_getoutopponent` | `{ phase: "261016" }` | `SaltRoad_GetOutOpponentResp { phase, opponentList[] }`（未接入，见 §1） |
| `saltroad_getwartype` | `{ date: "2026/10/10" }` | `SaltRoad_GetWarTypeResp { warType: 15 }`（既有命令，本次未新增用途） |

响应匹配：`resp=seq` 命中即可（`SyncResp` 不带 `*Resp` 名，靠 resp 匹配；
`responseToCommandMap` 里 `saltroad_getseasonoutrankresp` 与 `syncresp→saltroad_outcheer`
双保险均已补）。

### 2.1 `saltroad_getseasonoutrank` 响应（本工具只用它）

```
body = {
  round: 2,                     // 当前轮次
  legionList: [                 // 61 家（本届已淘汰几家就少几家）
    { id, name, serverId, logo, power, redQuench, dan, isKing, rank, score,
      sRTotalScore, monthKillCnt,
      sOWinCnt, sOLoseCnt, sOKillCnt, sODeadCnt, sOSumScore,   // 淘汰赛战绩
      legionWarType: 35, riseDate: "260927", ... }
  ]
}
```

抓包时点分布：`sOWinCnt` = 2胜×16 / 1胜×32 / 0胜×12 / 缺省×1。
注意有俱乐部**缺 `sOWinCnt` 字段**，排序时必须按 0 计（`Number(x)||0`）。

### 2.2 `saltroad_outcheer` 请求与成功回包

```
SEND  saltroad_outcheer { legionId: 942724 }        // 942724 = ¹ｗ¹礼之用(10001服)
RECV  SyncResp { role: { statistics: { "sr:out:cheer:261003": 942724 } } }
```

- `legionId` 必须是 **number**（BON Int tag 1）；字符串会被服务端拒。
- 成功回包**没有 `code`**，判定成功 = statistics 里出现 `sr:out:cheer:*` 键且值 = 请求的 legionId。
- 若值 = 别的俱乐部 ⇒ 该账号本届已助威别家（每届一次）。
- 失败走错误信封（`{seq,ack,time,resp,code,error}`，无 cmd 无 body）⇒ Promise reject，
  `error` 是服务端中文文案（助威窗口 / 已助威都在这里体现）。

## 3. 时序（抓包实录，UTC）

```
14:46:31.713  SEND  legion_getinfo            → 军团信息（页面上下文）
14:46:31.758  SEND  saltroad_getwartype {date:"2026/10/10"}  → {warType:15}
14:46:34.353  SEND  saltroad_getwartype {date:"2026/09/27"}  → {warType:15}   // 赛季 riseDate
14:46:46.151  SEND  saltroad_getoutopponent {phase:"261016"} → 32 场×2 = 64 强对战表
             （battlefieldId = "SEASON_SWISS_ROUND_OF_3-261016:35680000X"，winSid=0 未开赛）
14:46:49.669  SEND  saltroad_getseasonoutrank {}             → round=2, 61 家
14:47:25.249  SEND  saltroad_outcheer {legionId:942724}      → SyncResp（助威成功）
14:47:25.299  SEND  saltroad_getseasonoutrank {}             → 刷新（内容无变化，助威不改性表）
```

## 4. 客户端语义还原（game bundle，非抓包）

`local-data/game_bundle_dump/game_index.plain.js` → `LegionWarSeasonOutStage4Data`：

```js
betPhase     = getPhase(0)                 // 赛季首个赛程的 phase（= 助威记录键后缀）
betRoleLegion = ROLE.statistics.get("sr:out:cheer:" + betPhase)   // 已助威的俱乐部
getBetList() {                            // 助威面板
  if (betState === Before) return []
  legionList.map((e,t)=>({legion:e,index:t}))
    .sort((e,t)=> t.legion.sOWinCnt - e.legion.sOWinCnt || e.index - t.index)  // 稳定排序
    .slice(0, 64)
  // 已助威的俱乐部被 unshift 到第一位；UI 对已助威账号隐藏助威按钮
}
sendCheer(legionId) { SaltRoadService.outCheer({legionId}) }
```

助威窗口（`betState`）由赛程配置推算，本工具**不复刻**：
活跃度以 `getseasonoutrank` 非空名单为准，窗口外投票由服务端错误文案兜底。

## 5. 本工具落地形态

- 纯逻辑：`src/utils/seasonOutCheer.js`（统计键解析 / 结果判定 / 前 64 稳定排序 / 活跃判断 / 错误分类）
- 批量任务：`src/utils/batch/tasksSeasonOutCheer.js` → `batchSeasonOutCheer(legionId)`
  （前置 `getseasonoutrank` 探活跃 → `outcheer` → 读 SyncResp statistics 判定；
  限流 400340 / 未解锁 400000 / 已助威 / 未开放均不算失败）
- UI：批量页「临时活动」标签页 → 「赛季淘汰赛助威」弹窗（名单表格点选 → 对全部选中账号投票）
- 自由模板：「临时活动」分组 → `batchSeasonOutCheer`（参数 `seasonOutCheerLegionId`）
- 测试：`test/seasonOutCheer.test.js`（10 例，锚点全部取自本抓包）、
  `test/tasksSeasonOutCheer.test.js`（8 例，mock WS 全流程）
