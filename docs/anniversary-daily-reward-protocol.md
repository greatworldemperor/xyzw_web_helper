# 周年庆每日奖励协议

> 抓包：`local-data/ann_daily/`（2026-10-16 23:14~23:19 北京时间，HttpCanary 抓的 wss bin，24 帧；
> 帧头 `70 78` = x 加密方案 + BON）
> 解码：`node local-data/ann_daily/_decode.mjs local-data/ann_daily`（走生产 `bonProtocol.js`，
> 24/24 帧 consumed==total 零错位；local-data 不随 git，换电脑需重新抓）
> 落地：批量页「**临时活动**」→「领取周年庆每日奖励」（`batchAnnDailyClaim`，
> 2026-10-16 接入，commit `a3affc36`）。

## 1. 结论速查

- **命令**：`activity_warordertaskclaim {actId: 2610169, missionId: 2610169XX}`
  → `Activity_WarOrderClaimResp`（请求/响应命令名不同，`xyzwWebSocket.js` 已有
  `activity_warorderclaimresp` 一响四命令的映射，**无需新增注册**）。
- **本期每日奖励 = 序号 01~05 共 5 个**；missionId = actId×100 + 序号
  （`261016901`~`261016905`）。
- **每个奖励 = 道具 5290 ×1**（响应 `body.reward[0] = {type:3, itemId:5290, value:1, ext:0}`；
  连领 4 个后 `role.items["5290"].quantity = 4`）。
- 与逍遥津战令（actId 2609191）**同一套 warOrder 系统**：序号 01~30 = 每日任务、
  41+ = 等级奖励（共用 `taskClaimed` 字段），见 `docs/xiaoyaojin-activity-protocol.md`。
- **服务端快照**（响应 `activity.warOrderActivityInfo["2610169"]`）：

  | 字段 | 值（抓包时刻） |
  |---|---|
  | `complete` | `{01:21, 02:3, 03:3, 04:3, 05:10, 06~14:0}` |
  | `taskClaimed` | `{01:true, 02:false, 03:true, 04:true, 05:true, 06~14:false}` |
  | `dailyTime` / `weekTime` / `sevenTime` | 1792080000 / 1791734400 / 1792339200 |
  | `purchased` / `purchased2` / `purchased3` | 全 false（免费轨） |

  ⇒ 序号 06+ 服务端进度为 0，「5 个奖励」与 master 口径一致。
- **拒绝语义由服务端裁定**（本地不猜阈值）：已领取 / 任务未达成 / 活动未开
  → 错误信封，实现按 benign 跳过；`400340` = 限流，立即停该账号剩余领取。

## 2. 帧清单（24 帧）

| 帧数 | cmd | 说明 |
|---|---|---|
| 1 | `fight_startlevel` | 背景噪音（seq 35，body `{}`，与领奖无关） |
| 6 | `activity_warordertaskclaim` | seq 37 → mission `261016901`（HttpCanary 同帧重复导出 6 份） |
| 4 | `activity_warordertaskclaim` | seq 38 → mission `261016903` |
| 5 | `activity_warordertaskclaim` | seq 39 → mission `261016905` |
| 4 | `Activity_WarOrderClaimResp` | 同一条响应（seq 41 / ack 39 / resp 40）重复导出 |
| 4 | `_sys/ack` | ack 41 |

> HttpCanary 会对同一帧导出多份（时间戳不同、内容一致），去重后实质是
> **3 条领取请求 + 1 条响应 + 1 条 ack**。请求间隔约 2.1s（人手点击速度），
> 实现取 500ms。

## 3. 请求体逐字节复现

x 方案解密后 BON（以 seq 37 为例）：

```
08                       object(2 键)
  05 05 6163744964       key "actId"
  01 f9d32700            int32 LE = 2610169
  05 09 6d697373696f6e4964 key "missionId"
  01 45cd8e0f            int32 LE = 261016901
```

响应体（826B 帧的 body，726B）关键路径：

```
role.items["5290"].quantity = 4
reward[0] = {type:3, itemId:5290, value:1, ext:0}
activity.warOrderActivityInfo["2610169"] = { complete{...}, taskClaimed{...}, ... }
```

## 4. 落地实现要点（`src/utils/batch/tasksAnnDaily.js`）

- **硬编码** `ANN_DAILY_ACT_ID = 2610169` 与 5 个 missionId
  （master 2026-10-16 拍板「很单纯的领取指令，别搞复杂」；临时活动轮换后改顶部两个常量）。
- 不前置 `activity_get` 探测，直接依次领 5 个；两条之间 sleep 500ms。
- 错误分类（沿用逍遥津口径）：`400340` 限流 → break；已领取 / 未达成 / 未开放
  → warning 日志继续；未知错误 → 记 failed。
- 五处接线：`batch/index.js` 导出 · `BatchDailyTasks.vue` import+实例化+解构 ·
  `createFlexibleTaskHandlers` 展开 · 「临时活动」tab 按钮 ·
  `flexibleTemplate.js` temporary 组 `batchTask`（无参数，自由模板走默认 `handler()` 分支）。
- 回归测试：`test/annDailyClaim.test.js`（actId / 5 个 missionId 对齐抓包）。

## 5. 相关文件

| 文件 | 说明 |
|---|---|
| `src/utils/batch/tasksAnnDaily.js` | 批量任务实现 |
| `local-data/ann_daily/_decode.mjs` | 抓包解码脚本（本机 local-data，不随 git） |
| `local-data/ann_daily/*.bin` | 24 帧原始抓包 |
| `test/annDailyClaim.test.js` | 协议常量回归测试 |
