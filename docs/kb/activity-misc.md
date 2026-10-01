# L2 · 常驻功能与其它活动

> 状态口径：**已上线** = UI 可点且走生产 ｜ **已接线** = 有 UI 入口但依赖未实测协议 ｜ **纯逻辑就绪** = 有回归测试的纯函数 ｜ **待验证** = 协议缺口未实测

## 汇总表

| 模块 | 关键文件 | 关键命令 | 状态 | 卡点/TODO |
|---|---|---|---|---|
| **白玉/预约** | `whiteJade.js` · `pkroomAppoint.js` · `batch/tasksWhiteJadePkroom.js` | `activity_claimrolluppack{id:17}` · `pkroom_appoint{}` | 已上线（批量页两按钮）；四抓包 21/21 复现 | 预约**无参数**、房号由服务端定；金砖不足/无可预约的错误码未覆盖。`11900050` = **已受理**（非失败） |
| **黑市（智能 + 黑市周）** | `smartBlackMarket.js` · `batch/tasksStore.js` | `store_purchase{}` · `store_buy{goodsId:1}`（日任12）· `activity_get` · `activity_buystoregoods`（黑市周 9 / 金砖 5） | 已上线（智能黑市购物 + 黑市周商品勾选弹窗）；黑市周抓包 15/15、58/58 复现 | 金砖不足/超限错误码未抓（两号金砖均充足）；`buyDiamond` 语义仍属推测。文档 `docs/weekly-event-blackmarket-analysis.md` |
| **宝箱（智能开箱）** | `smartOpenBox.js` · `batch/tasksItem.js` | `item_claimboxpointreward` · `item_openbox`（日任7） | 已上线（`batchSmartOpenBox`） | 逻辑 = 钻石优先、**兑满 9 档得钻石**、回退木箱。🔴 **与金鱼宝箱口径不同**（金鱼是活动积分消耗）⇒ **互不通用，别照金鱼口径改它** |
| **逐鹿盐山竞猜** | `batch/tasksApex.js` | `apex_getroleinfo` · `apex_getguesslist` · `apex_guess` | 已上线 | — |
| **竞技场** | `batch/tasksArena.js` | `arena_startarea` · `arena_getareatarget` · `fight_startareaarena` · `presetteam_*` · `artifact_lottery` | 已上线 | 智能选敌只支持 `lowestPower`（默认）；候选 `roleList` **最多 4 个**，用 `info.power` 升序；`info.rank` 恒 0 不可当排名；服务端顺序视为随机 |
| **盐杯竞猜** | `batch/tasksFootball.js` | `saltcup26_getbetinfo` · `saltcup26_placebet` | 已上线 | 默认客胜 `pick=3` |
| **盐罐** | `batch/tasksBottle.js` | `bottlehelper_stop` / `start` / `claim` | 已上线 | — |
| **宝库/梦境** | `batch/tasksDungeon.js` · `dreamConstants.js` | `bosstower_getinfo` / `startboss` / `startbox` · `dungeon_selecthero` · `dungeon_buymerchant` | 已上线 | 梦境仅开放日（`dreamConstants`） |
| **挂机/答题/签到** | `batch/tasksHangUp.js` · `studyRewardClaim.js` · `studyStatusStore.js` · `studyQuestionsFromJSON.js` | `system_claimhangupreward` · `study_claimreward{rewardId:1..10}` · `club_sign` | 已上线 | 已修 ack + 退避重试 + 补领；状态按 `tokenId` 隔离。题库依赖 `public/answer.json` **模糊匹配** |
| **功法** | `batch/tasksLegacy.js` | `legacy_claimhangup` · `legacy_sendgift`（+ `role_commitpassword`） | 已上线 | 需接收者 ID 与安全密码 |
| **商店** | `batch/tasksStore.js` | `legion_storebuygoods` · `activity_buystoregoods` · `collection_claimfreereward` · `discount_getdiscountinfo` | 已上线 | — |
| **爬塔 / 怪异塔** | `batch/tasksTower.js` · `towerActId.js` · `towerClimbLimit.js` · `skinChallengeUtils.js` | `fight_starttower` · `evotower_getinfo` / `readyfight` / `claimreward` · `mergebox_*` | 已上线 | 爬塔前需**先补领 evotower 章节奖励**（否则 `12200020`）。换皮闯关 BOSS 支持 1-6，空选=跳过全部 |
| **咸主检测** | `batch/tasksXianMaster.js` | `role_getroleinfo`（读 `body.role.bossId > 0`） | 已上线（**只读**） | 检测结束开不可误触关闭的明细弹窗，支持复制角色与咸主 ID |
| **主线推关** | `utils/pushLevel/` · `views/PushLevelSynthetic.vue` / `PushingLevels.vue` / `PushLevelResearch.vue` | `fight_startlevel` → `fight_endlevel` + `outputCode`(MD5) | **重方案已真机验收上线**（官方无头引擎打赢才提交，推进 `role.levelId`）；**轻方案（合成胜利）被服务端拒 `200020`/`800080`**，仅作结果预览 | 合成成功结果**无法过服务端真伪校验**；纯本地 `outputCode`/`resultTemplate`/`config` 已接 `PushLevelSynthetic`，`scheduler` 未接生产 |
| **通用工具** | `protocolError.js` · `tokenSort.js` · `clubBattleUtils.js` · `groupExport.js` · `imageExport.js` · `gameSelection.js` · `DateTimeUtils.js` · `struckAnalyer.ts` · `randomSeed.ts` | — | 纯函数/工具 | `protocolError`(12200090/12200100)、`tokenSort` 有测试；`struckAnalyer` 是调试扫描器；`randomSeed`(`GenRandomSeed`) 接入点**未确认** |

## 专属说明

### 白玉 / 预约比赛
- `activity_claimrolluppack {id:17}` 领周一白玉；`pkroom_appoint {}` 预约比赛拿金砖。
- 四份抓包 **21/21 逐字节复现**。
- `11900050` 判定为"**已受理**"而非失败（别当错误处理）。
- 冒烟：`local-data/_smoke_whitejade_pkroom.mjs`。文档 `docs/monday-jade-and-pkroom-appoint-protocol.md`。

### 黑市
- 两套：**智能黑市购物**（每日，`store_purchase` / `store_buy`，商品钩在批量页弹窗）与**黑市周奖励**（`activity_buystoregoods`，`activityBuyBlackMarketWeek` 任务）。
- 金鱼鱼竿可通过黑市 **400/根**（比商店 600 便宜）。

### 宝箱（⚠️ 最容易被混淆的一个）
- `smartOpenBox.js` = **日常开箱**：钻石优先，**兑满 9 档拿钻石**，回退木箱。
- 金鱼的宝箱 = **活动积分消耗**（`activity_get.task.2`），走 `goldenfishConsumePlan`。
- 🔴 **两者口径不同，互不通用**。master 明确：**别照金鱼那套去改 `smartOpenBox.js`**。

### 主线推关（重要区分）
- **重方案（已上线）**：官方无头引擎（`headless` iframe 经 `sh1` 登录进主城）内**真实打赢**后才生成 `ClientBattleResult` 并提交 → 服务端接受。里程碑：首场官方无头战斗（1841 关）生成完整结果，本地按文档公式复算 digest 与官方**完全一致**（`serializedLen=2805`，样本 `local-data/headless_result_1841.json` + `verify_official_1841.mjs`）。
- **轻方案（被证伪）**：本地合成胜利结果（`isWin=true` / `battleTime=447` tick，`src/utils/pushLevel/config.js` 冻结配置）提交被服务端拒 `200020`/`800080` ⇒ **仅保留为结果预览**。服务端**不只校验 outputCode 公式**，会真伪校验。
- 研究页 `PushLevelResearch.vue`：只读 runtime 观测环境（HTTP/WSS/runtime 三路抓包 + JSONL 下载 + 被动捕获），桥固定 `passive-capture`，**禁止**主动 `fight_startlevel` / 无头模拟 / `fight_endlevel`。
- WSS Runtime Sandbox（`?wss-sandbox=1`）：在 H5/Cocos/`__require` 初始化前替换原生 WebSocket 为内存 socket；`send()` 只记 `ws:blocked-send`；父页可 `runtime:wss-inject` 注入入站帧。**必须在 Runtime 初始化前启用**，否则要刷新 iframe。
- 反混淆资产：`scripts/7.7.12.deobfuscated.runtime-assisted.js`（338,877 项替换）、`tools/instrument-7.7.12-runtime.cjs`、`split-runtime-traced.cjs`、`collect-runtime-trace.cjs`、`deobfuscate-7.7.12.cjs`；结论见 `docs/reverse-engineering/`。
- `docs/7.7.12-skip150.md`：`scripts/7.7.12.js` 的"自动推 150 关"实际是 **`skip150` 客户端配置 Hook**（改 `Configs.LevelConf.getById`，2≤levelId≤150 时 `monsters=[[[0]]]`），**不是** `fight_startlevel`/`outputCode` 方案。

### 活动/命令盘点（PROJECT_CONTEXT 遗留结论）
- `src/utils/gameCommands.js` 是**死代码** → 命令统一注册到 `xyzwWebSocket.js` 的 `registerDefaultCommands()`。
- 旧 `src/utils/wsAgent.js` 只服务早期 Token/连接流程，**不是**盐场/蟠桃的第二套业务实现。
- 已知"仅注册、未接线"命令见 `activity-pantao-weirdtower.md`。
