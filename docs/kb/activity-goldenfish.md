# L2 · 金鱼秋季活动（主战场）

> 核心文件：`src/utils/goldenfishConsumePlan.js`（消耗）、`src/utils/goldenfishFinishPlan.js`（收尾·纯逻辑）、`src/utils/batch/tasksGoldenfish.js`（执行）、`src/utils/batch/fishMerge.js`（合并鱼）
> 模拟器：`tools/goldenfish-simulator/` → `public/goldenfish-simulator.html`（**已上线** `http://111.229.64.152/goldenfish-simulator.html`）
> 文档：`docs/goldenfish-autumn-protocol.md`、`docs/goldenfish-claim-session-gap-analysis.md`、`docs/fish-merge-and-artifactbook-protocol.md`
> ⚠️ 元旦还有这个活动 ⇒ 相关资产（模拟器/纯逻辑/测试）都按**长期资产**维护。

## 1. 活动识别与进度口径

- 🔴 **进度在 `activity_get {}` → `commonActivityInfo[ID].task`，不在 `role` 上**。
  `task = {1:招募, 2:宝箱, 3:钓鱼, 4:收罐子, 5:金砖}`；`record` = 已领取的 missionId。
- **活动 ID 签名**：`task` 的键**全部落在 1..5**（真：2609251；空：2609252-4；负键排除：2609255）。取**最大键 = 最新期**；`manualId` 可覆盖。
- 9 月目标（消耗阶段留余量 / 收尾用满值）：

| 槽 | 目标 | 满值 | 备注 |
|---|---|---|---|
| 1 招募 | 3900 | 4000 | 招募令 itemId `1001` |
| 2 宝箱 | 99000 分 | 100000 | 分值：铂 50 / 金 20 / 铜 10 / 木 1 / 钻 0 |
| 3 钓鱼 | 1140 | 1750 | **周四下限 1300**、硬上限 1750；鱼竿 itemId `1012` |
| 4 收罐子 | — | — | 由 `forceTask` 写满（否则空转重复计入） |
| 5 金砖 | 38 万观察 → 46 万收敛 | — | slot5 档位是**万金砖**，服务端进度是**实际金砖数**（×10000） |

- 五类道具总计 **1050**。
- **奖励 itemId**：`5287`（当前期）/ `5261`（旧期）。`missionId = (slot-1)*20 + round`。
- 🔴 **服务端不自动发奖**：一轮一领、20 轮要点 20 次 ⇒ `planClaimSweep` 逐轮补领语义正确。
- ✅ **绝对判据（并发探针）**：`Role_GetRoleInfoResp.role.statistics` 有 `today:open:box`（今日开箱**调用次数**，每帧 +1）和 `activity:open:box`（本活动开箱**积分**）。本机发 N 帧而 `today:open:box` 涨幅 > N ⇒ 有第三方在开同一个号。

## 2. 关键商业模式（为什么这么打）

- **最终目的**：开 `5287` → 得 `5288`（期望 25% + bias∈[-5,5]）→ **250 个 5288 兑金鱼**。
- **金砖 ↔ 钓鱼 一箭双雕**：买竿（600/根，黑市 400 更便宜）既是金砖消耗任务，又推进钓鱼任务。
- **图鉴奖励 = 金砖/招募令回流的重要途径**（升星链的动机）。

## 3. 消耗阶段（`goldenfishConsumePlan.js`）

**算法**：`while (累积 + 可开分 < 目标) { 全开 → 一键兑积分 → 开 5287 → 重查 }`；退出后按差值精确开箱（铂→金→铜→木，`ceil` 保证达标，**超开留存不兑**）。

**并行策略**（`f831b56c` → `ccc9c1f8` → `aa9a0661`）：
- **招募 + 钓鱼并行，宝箱独占串行**（`runGoldenfish` 分组执行，并行段先跑）。
- `config.serialConsume=true` 全串行；`config.parallelBoxes=true` 复测三者并行（**默认关**）。
- 📌 "独立限流"是**配额**维度，**不等于**可并发写背包。

**🔴 整批开箱规则（已定案）**：服务端**只接受整批开箱**（单帧 `number` 恰好 = 10），**余数批被拒**（报"数量已发生变化，请重新操作"）。
- 定案链：失败号被拒帧全是 `2001×2/×3/…×8`；决定性样本 `28c-2-625238513` 计划 `2001×885` → 切 `[10×88, 5]` → 前 88 帧全成、**第 89 帧(5) 被拒**。全日志被拒帧 number 全 < 10、成功帧全 = 10。招募侧同理（`recruitNumber:3` 被拒）。
- 修复：`alignDownToBatch` —— 可开数一律**向下对齐到整批**（木箱先扣 200 再对齐）；`chestScoreAvailable`/`planOpenAll`/`planPreciseOpen` 全改整批口径（精确开箱需求量**向上取整**到整批保证达标）；`sendOpenBoxSteps` 兜底跳过 `n<10` 帧。
- 效果：只剩余数的号**一帧不发**并提示"余数不足一批的开不动"。与 master「差 3 次不做就不做了」同口径。

**🔴 宝箱积分兑换（09-29 口径，`27d9c159` 已上线）**：
- `boxPoint ≥ 1000` → 发 `item_batchclaimboxpointreward`（**无参数**，请求体 `0800`）**一帧兑光**；
- `< 1000` 才回落逐档 `item_claimboxpointreward`。门槛常量 `goldenfishConsumePlan.BOX_POINT_BATCH_MIN`。
- ⚠️ **`smartOpenBox.js` 故意不改**（它是"兑到刚好 3 个钻石箱就停"的精确控制，一键会兑光积分破坏优化）——**另一场景，别照金鱼这套去改它**。

**其它口径**：
- 钻石箱一律**不开**；木箱**保留 200**。
- 招募/钓鱼**单发固定 10**（余数被拒，向下对齐整批）；鱼竿返还 **10%**（实测 11.11%）。
- `item_openpack` 单次 `number` 上限 **999**，要分批（`ITEM_OPENPACK_MAX_PER_CALL=999`）。
- **鱼竿不足口径**（09-29 master 拍板）：消耗阶段**有多少做多少**（`willDo = min(目标差值, 库存)` 再整批对齐），缺口记日志（带 10% 返还折算竿数），**留待收尾用金砖买竿补全**，不做即时买入。

**🔴 三道角色维度闸门**（防同角色并发写背包）：
1. 模块级 `goldenfishRunActive`（跨 `createTasksGoldenfish` 实例共享——自由模板每任务各建 `isRunning: ref(false)`，注入的 ref 挡不住"定时+手动"叠加）；
2. 同批重复导入去重（`goldenfishActiveRoleKeys`）；
3. 跨标签页/窗口 localStorage 租约（键 = `serverId-roleId`，**5min TTL** + 60s 续租；抢不到跳过该号；裸 node 降级为无锁）。
   - `RUN_TAB_ID` 必须是 **sessionStorage 的"每标签页"id**（重载后同 id ⇒ 能接管自己的旧租约）；iframe/另一窗口独立 ⇒ 跨上下文仍互斥。
   - 必须补 **`pagehide` 全量归还**（`persisted=true` 的 bfcache 场景不归还）。
   - 跳过日志打「（持有者 tab，最后续租 HH:MM:SS（N 秒前））」，一眼分清真·另一标签页 vs 自己的僵尸租约。

## 4. 🔴 执行逻辑口径（master 2026-10-01 拍板，commit `83156215`，已上线）

1. **只要有响应就以响应为准** —— 服务端结果一定可靠。
   旧的逐帧"净耗不符即 `throw` 中止防盲做" **已废弃**：招募(1001)/钓鱼(1012)/开箱三处统一走 `applyStockFeedback`（**永不抛错**，偏差只留痕：净耗 > 消耗数 = warning，其余 info，然后换基线继续）。
   依据：丢帧/卡顿的小幅跳变无关紧要；并行兄弟任务会正向带进道具（净耗可为负）；消耗目标已留余量。
2. **出错兜底 = 重建连接 + 重跑当前出错账号的业务**：`runGoldenfish` 抽 `runBatch(ids)`，整批跑完后 `close + ensure` 重建连接，重跑**失败的那几个步骤**（`ACCOUNT_RERUN_MAX=2`；消耗类开头重读进度补差值，不会重复消耗）。
   - 限流 / 活动未开 = abort，**不重跑**。
   - `NON_RERUNNABLE_STEPS = ["useOneItem"]`（投一次即生效，重跑会真的多投 N 个）。
   - 日志：`[新] 以服务端响应为准` / `重建连接后重跑本账号`；旧特征 `中止防止盲做` / `扣减异常` 已全站 0 命中。
   - 遗留：逐帧扣减校验 `readItemCountStrict`（键缺失=null 区别于 0）仍在，但不再 throw。

## 5. 🎉 领取进度奖励挂死 —— ROOT CAUSE 已攻克（`ceb1dcf`，2026-10-01 13:52 上线）

**现象**：`activity_claimtaskreward {activityId, missionId}` 在**批量页/authuser 会话**下静默无响应（挂死到断线），只有**游戏内会话**能领。

**排查路径**（值得复用的方法论）：
1. 对照实验：同一 token 21a 2 分钟内 A/B —— 批量页 fail vs **推关页游戏本体 success**（claim ×6 全成，~60ms/帧）。两会话**服务端登录来源标记完全一致** ⇒ 登录来源不是差异。
2. 批量页同会话内**只有 claim 挂**（开箱/招募/钓鱼/fight_startlevel/邮件等写命令全通）⇒ 排除"笼统写权限"。
3. 实验 D（DevTools 抓握手）：游戏本体连接**也带 `p=`**（被动桥记录的"裸 agent"是 **hook 丢 query 的假象**）；Request Headers **无 Cookie** ⇒ **H-Cookie 排除**；Origin/UA 两边一致。
4. 唯一实锤差异：`p=` 字段集 —— 游戏 SDK 四字段 vs 批量页多塞 `roleId` → 实验 F（`2df6f788`，已上线）：`transformToken` 收成四字段。
5. 实验 F 后仍挂 ⇒ bin-test（`ab9e...` 系列 E0-E10）继续对照，最终**定案**。

**🔴 ROOT CAUSE（双因素，缺一不可）**：
```
① 进主城初始化序列（36 帧，末帧 role_backclaimreward = 进城结算标记）
② 首帧口径对齐游戏本体（h5 / 1.89.8-wx / scene:""）
```
- 四次实证：E4（9754 成功）/ E7（9755 干净号复刻成功，实领 5287×8 入账）/ E9（9756 干净号 initdelay=0 成功）/ E10（9757 复刻 28a 时序，得业务响应 `3200020`「奖励领取过了」= 受理正常）。
- 反例：E2/E3（只有 firstframe 仍断线）、E5/E6/E8（号被反复连挂 = **服务端会话冷却**，200020 泛滥数分钟）。
- **生产化**：① `xyzwWebSocket.js` 的 `role_getroleinfo` 注册 body 对齐 `h5/1.89.8-wx`（**仅此帧带这些字段，无 3000070 污染**）；② `tasksGoldenfish.js` 的 `GOLDENFISH_ENTER_GAME_SEQUENCE`（36 帧）前置到 `claimProgressRewardsStep`。
- 已上线核验：BatchDailyTasks chunk 含「进主城初始化序列」、主包含 `1.89.8-wx`；旧 `2.21.2` 残留仅在多开桥/gameCommands/firstFrameSpoof rules（不在 claim 路径）。
- 🎯 **业务码 `3200020` = 奖励已领取**（claim 的正常业务拒绝，不是失败）。
- ⚠️ **同角色频繁重连会触发服务端会话冷却**（200020 泛滥，数分钟自恢复）——批量重跑间隔别太激进（3s 过激）。
- 相关：`connectionManager.ensureConnection` 每连接固定发 `[role_getroleinfo, fight_startlevel]` 前奏（拉战斗版本）——**无害**（E10 实证）。

**🔴 2026-10-01 17:3x 追加发现：生产 claim 路径有两处「漏注册」（真·阻塞）**
用 `local-data/_check_registry.mjs` 实测：init 序列 **仅 17/36 帧注册**，且 `activity_claimtaskreward` **从未注册**。
⇒ 生产发送即抛 `Unknown cmd` → 异常把连接打成 `close 1006` → 后续帧全部只入队（"全帧入队/挂死"态）。
**这是比"多开会话冲突"更根本的解释**。
- ⚠️ **为什么 E4/E7 没暴露**：bin-test 的 `commands:` 模式与 `runInitSequence()` 会**自动兜底注册**未注册命令，
  把生产缺口整个掩盖了 ⇒ **研究 harness 比生产宽松时结论会失真**。
- 已修（`xyzwWebSocket.js`）：补注册 `activity_claimtaskreward` + init 序列 19 帧；
  `activity_rewardresp` 响应映射改为 `["activity_claimsignreward","activity_claimtaskreward"]`。复检 **36/36**（注册表 189→207）。
- **新增自检**：改动涉及新命令时，必须跑 `_check_registry.mjs` 核注册覆盖率。

**✅ 2026-10-01 17:42 自动领取打通（9767 / 角色 40a）**：
```
RUN --bin D:/my_projects/xyzw/gh_repo/mobile.bin --server 9767 --run claim
→ authuser 200 / 287B
→ 进主城初始化序列：29/36 帧成功
→ 进度奖励补领：77 个达标未领轮次
→ ✅ 领取完成：77/77 轮（record 校验全部入账）  ← 服务端 record 确认，不是本地推断
→ 全程 21 秒（init 12s + 领奖 8s）
```
⇒ **「自动领取进度奖励」已实现并实测通过**，待提交/部署到生产（`xyzwWebSocket.js` 的注册补丁）。
⚠️ 生产批量页的「领取进度奖励」按钮目前仍会失败（线上还是旧包），部署后生效。
⚠️ `200020` 的头号原因是**会话被占用**（不是 bin 类型，也不是 IP 冷却——master 明确 role token 是 IP 级 ~25 次才冷却）。

**⏸️ 未解卡点**：生产版 28a 仍失败（`claimprogressrewards_fail_again.jsonl`）：init 序列前 3 帧 ✓，**第 4 帧 `role_getfirstmonthdate` 挂死 8000ms**（无响应，非 200020）。bin-test 不可复现 ⇒ **最大嫌疑 = 28a 当时正在 master 的多开窗口里在线（第二客户端会话冲突）**。待 master 换干净号复测。

## 6. 收尾阶段（阶段 C，纯逻辑就绪 · 未接生产）

**目标（master 复述确认）**：
1. 宝箱和招募**全部做满**（消耗阶段留余量，最后一天用满值目标再跑一次）。
2. 鱼竿和金砖维持策略：钓鱼先补 1300 下限、不够往 1750；金砖 38 万观察 → 46 万收敛 + 2 换 1。
3. **起点未必是 1140** —— `fd = progress[3]` 按实际起点算缺口（`fishRoom = max(0, fishCap − fd)`）。
   实测：起点 1000 补到 1300 需 270 根 vs 起点 1140 只需 144 根（多买 126 根）。

**`src/utils/goldenfishFinishPlan.js` 导出**：`TIERS` / `buildRoundTable` / `planClaimSweep` / `openPacks` / `planRodPurchase` / `simulateFinish`。
**已踩的坑**：
1. slot5 档位是"万金砖"，服务端进度是实际金砖数（×10000）。
2. 金砖消耗 = 买 600/根鱼竿，一笔支出推进双任务（`weight=goldSpend`）。
3. 开普通道具 = 期望 + 有界线性 bias（±5，权重 `[1..6..1]/36`，E=0）。
4. `rodsInStock` 默认 0。
5. 返还**同时独立结算**，不能逐次 `floor`。
6. 鱼竿 10% 返还：x 根钓 `x/0.9` 次；`rodsForGoldFull` 不变（金砖看**花费**）；`rodReturnRate:0` 可关。
7. 金砖不足 ≠ 档位榨干（`blockedBy: "gold"` vs `"tiers"`）；总账 `1050 = 已领 + 待领 + 剩余`，**领奖前算**。

**🔴 2 换 1（master 拍板，已全链路落地 + 模拟器默认）**：
- 观察点 = 宝箱招募满 + 金砖 38 万（轮17）/ 钓鱼 1300（轮17）→ 25% 找可行解 → **金砖窗口 ≥2 且钓鱼有档** → **135 根（8.1 万）换 1 轮钓鱼**，杆钱计入金砖 ⇒ **钓鱼白捡一档**。
- `OBSERVE_GOLD=380000` / `GOLD_TARGET=460000`（第 20 轮金砖 4 万→12 道具是唯一低效支出，靠杆钱顺带跨过，不专门做）。
- 引擎 `MAX_ITER=12`（半步节奏每轮 +12 特殊；**5 会假性失败卡 248/250**），可 `config.maxIterations` 覆盖。
- 蒙特卡洛 100%（600 种子）、终态均值 252.7、区间 `[250,260]`、平均支出 ~12.9 万。

**🔴 最后兜底 = 补一轮金砖**（master 2026-09-28 拍板）：
- 一轮金砖 ≈4 万 → 12 道具 → 期望 +3 特殊。触发 = 主循环结束仍未达标但金砖还有档且买得起跨下一轮阈值，按"恰好跨过阈值"买杆（从 46.1 万起 = 65 根 / 39,000），防御上限 3 轮，**不会越过 50 万**（档榨干 = 真无解，照实失败）。
- 实现：`simulateFinish` 的 `goldTopUp`（默认开）+ `kind:"topup"` 迭代 + 返回 `topups`；引擎同源（`topup:true` 事件标记）。蒙特卡洛 600 场 **0 触发**（纯保命）。

**⚠️ 接线现状**：`tasksGoldenfish.js` 只 import 了 4 个纯函数（`fishesToRods` / `GOLDENFISH_PACK_RETURNS` / `completedRounds` / `toMissionId`）——`simulateFinish` / `planClaimSweep` / `openPacks` / `planRodPurchase` **一个都没用**。
**已产出的执行器**：`goldenfishClaimProgressRewards`（claim，已上线）；`goldenfishOpenPacks` / `goldenfishClearItems` / `goldenfishUpgradeChain`（**只做了函数层，UI 层曾集体漏接**）。
**`ConsumptionProgressCard.vue` 仍硬编码旧期** `activityId=2512261`、item `5261/5262`（405/408/411/442 行）——收尾前必改。

## 7. 养鱼合并 + 图鉴点亮（`docs/fish-merge-and-artifactbook-protocol.md`）

**抓包**：`local-data/goldenfish/merge_fish_claim_rewards.jsonl`（2026-09-30）。

**三条命令**（全部逐字节复现精确，0 失败）：
| 命令 | 参数 | 响应 cmd |
|---|---|---|
| `artifact_upgradestar` | `{heroId:-1, itemId}`（120 次） | `SyncResp`（靠 resp=seq） |
| `book_batchupgrade` | `{club:0, isArtifact:true, isSkin:false}`（4 次） | `Book_BatchUpgradeResp` |
| `book_claimpointreward` | `{}`（5 次） | **`Item_OpenBoxResp`** |

- ⚠️ `book_claimpointreward` 已注册（走 seq 匹配，不受影响）；**`artifact_upgradestar` / `book_batchupgrade` 尚未注册**（现有 `hero_heroupgradestar` + `book_upgrade` 是**英雄升星**那套，不是这套）。
- `itemId` = `TT SSL`（档位 13/14/15/16 + 品种序号 + 等级 1..5）；图鉴 key = 前 4 位。
- `artifactBooks[k].artifactId` = 历史最高等级（被合掉也留）；`claimedStar` = 已点亮星级；`role.book = {bookPoint, bookLastReward}`。
- **消耗公式**：`V(L) = 1 + (L-1)*k`，`k = {13:1, 14:2, 15:5, 16:20}`；单次升级 = 吃「本级鱼 1 条 + 1 级鱼 k 条」。⚠️ 材料由服务端自动挑，**实测只吃 1 级鱼、不碰更高等级成品**。
- **图鉴点亮**：一次调用**所有合规品种 +1 星**，连发 4 次到 5 星；推进条件 = 该品种历史最高等级 ≥ 目标星。`bookPoint` 增量 68/60/50/42，**公式反解不出整数（疑似每品种独立配置）⇒ 别本地预测，读响应**。
- **点数奖励**：每调用一次 `bookLastReward` +1（本次 43→48）；奖励 = 钻石(type2) + 道具(type3)。
- 未验证：材料不足时的返回形状、5 级是否真上限、中间等级能否抵材料、`club`/`isSkin` 其他组合。

**切阵容 = 服务端自动合并全背包鱼**（`local-data/goldenfish/fish_auto_merge.jsonl`，海王@26501，协议文档 §6）：
- `presetteam_saveteam {teamId:2}` **一帧**（useTeamId 1→2），**SaveTeamResp 直接带 items 大增量**（19 种归零 / 11 种新产出 / 18 品种被动；16011 恰 −20 ⇒ k 表一致）。
- **无 `artifact_upgradestar`、无客户端模拟**；合并范围 = 全部能合的（不只新阵容需要的）。
- ⚠️ 响应**无 artifactBooks/book 增量** ⇒ 切阵代劳不了**图鉴点亮**；preset 模板的 artifactId 只是**快照**，校验要以 `role.items` 实时为准。
- 自动化"一键合并"两条路：① 自算链逐条 `artifact_upgradestar`（**已选用**）② 借 `saveteam`（副作用 = 真切阵）。

**`batchFishAutoMerge`（一键合并鱼）**：
- `src/utils/batch/fishMerge.js` 规划器 = **高位种子优先**（与切阵自动合并逐鱼一致，1301/1402/1601 三场景测试实证）。
- 执行器：逐步 `artifact_upgradestar {heroId:-1, itemId}` + 响应 delta 校准 + `book_batchupgrade`×≤4 + 领奖×≤10。
- ⚠️ **只合背包鱼**（英雄身上的需先在游戏里卸下）。
- 接线三处 + `xyzwWebSocket` 注册 `artifact_upgradestar`/`book_batchupgrade`；测试 `test/fishMerge.test.js` 11 例。
- 🔴 **刻意不进自由/定时模板**（一次性操作），入口只留批量页「资源」栏按钮。

## 8. 模拟器（长期资产）

- `tools/goldenfish-simulator/`（`build.mjs` 打包 → 单文件 HTML）→ `public/goldenfish-simulator.html`（115KB，含内联引擎 + 虚拟服务端）。
- **改口径要同步 5 处**：常量 → 引擎 + `_smoke` → `_selfcheck` → `_mc` → 文档×3（`goldenfish-simulator.md` / `docs/goldenfish-autumn-protocol.md` / `index.html` 红框）。
- 覆盖：冒烟 6 场景 182 断言（E=2换1、F=兜底）、UI 冒烟 30 项、单测 60。
- 引擎坑：罐子 `freeItems` 由 `forceTask` 写满 `task.4`（否则重复计入空转）；UI 首屏 `record` 默认 1；`applyPreset` 先恢复全基线再叠预设。
- 🔴 改它必须 **commit**（vite `emptyOutDir` 清 dist）。

## 9. Excel「金鱼精算1」

- 已读：模拟器原漏算 5 项金砖收入（图鉴反哺 2 万 / 日常 2.1 万 / 钻箱 6.3 万等）；黑市 400/根便宜杆。
- ✅ master 2026-09-28 确认：**Excel = 模拟器的参考标准**（可吸收其口径）。
- ⚠️ **返还率口径未拍板**：`÷1.1` vs `×0.9`，差 ~8,730 金砖。

## 10. 金鱼红线

1. 进度在 `activity_get.task`，不在 `role`。
2. 开箱/招募/钓鱼**只认整批 10**，余数向下对齐；只剩余数 = 一帧不发。
3. 宝箱积分 `≥1000` 一键兑光，`<1000` 攒着；钻石箱不开、木箱留 200。
4. 别动 `smartOpenBox.js`。
5. **领奖前必须先跑 36 帧进主城初始化序列 + role_getroleinfo 首帧口径 `h5/1.89.8-wx`**（仅此帧带，无 3000070 污染）。
6. `3200020` = 奖励已领取（正常业务拒绝）。
7. 同角色频繁重连触发会话冷却 → 重跑间隔别 <10s；怀疑时等 2~3 分钟或换干净号。
8. 保护名单：`5288`(硬通货) / `5286`(每日投币) / `1013` / `1001` / `1012` / `2001-2005`。
9. `batchClearItems` 在金鱼收尾前**勿跑**（清单含 5287）。
10. 日志禁占位符（`fmtNum("-") = 0` 曾自毁证据链）。
