# L2 · 逍遥津 + 营地挑战

# 一、逍遥津

> 实现：`src/utils/xiaoyaojinPlan.js` · `src/utils/batch/tasksXiaoyaojin.js`
> 文档：`docs/xiaoyaojin-activity-protocol.md` · 抓包：`local-data/xiaoyaojin/`（`xinyaojin_full.jsonl`）

## 状态：✅ 已上线（源码保留）

- 批量页「一键全套 + 各步按钮」；**SEND 15/15 逐字节复现**。
- 含**玄武灵契抽 → 补券闭环**；券兑换**自动认期回退**。

## 命令清单

| 命令 | 用途 |
|---|---|
| `activity_get` | 活动数据（进度来源） |
| `warordertaskclaim` | 领取战令任务 |
| `warorderrewardclaim` | 领取战令奖励 |
| `commonbuygoods` | 购买商品 |
| `claimsignreward` | 领取签到奖励 |
| `getlotteryinfo` | 抽奖信息 |
| `lottery` | 抽奖（玄武灵契） |
| `claimlotterycumulative` | 累计抽奖奖励 |
| `exchange` | 兑换（券） |

## ⚠️ 活动状态与待验证

- **活动已于 2026-09-26 结束下线**：`flexibleTemplate.js` 的"临时活动"分组与任务项**已移除**；源码 + 测试保留（`tasksXiaoyaojin.js` + `xiaoyaojinPlan.js` + `test/xiaoyaojinPlan.test.js` + `test/tasksXiaoyaojinCoupon.test.js`）。
  **下期若要接回**：恢复分组 + 页面「临时活动」标签页的按钮接线即可。
- 待实证：累计奖励门槛表、兑换其它商品号、`times ≠ 1/10`、`5285` 旧义。
- 历史教训：兑奖券重现时需要**外层循环重领**（部署后才发现，随即迭代补上）。

---

# 二、营地挑战

> 实现：`src/utils/batch/campChallengePlanner.js`（规划器）· `src/utils/batch/tasksCampChallengeStrategy.js`（执行器）
> 文档：`docs/camp-challenge-protocol-research.md` · 抓包：`local-data/camp_data/`（76 文件）
> 测试：`test/campChallengePlanner.test.js` · `test/campChallengeTodayOppo.test.js`
> 业务伪代码参考：`local-data/camp_data/design.txt`（**只是意图，不是接口规范**）

## 状态：✅ 已上线（策略模式 + 宠物简化 + 诊断，三入口）

规则与抓包 **13/13 复现**；25 例回归。

## 1. 业务规则（已确认 2026-09-07）

- 每日最多**发起 10 次**挑战；每日最多**成功 3 次**。
- **普通玩家挑战和宠物挑战共享 3 次成功额度**；达到 3 次成功后不可再挑战。
- 营地共 **3 个区域 × 10 个敌人**；每个敌人总共可被击败 **5 次**（前 3 次普通 → 困难 → 炼狱）。
- 困难全清依赖普通全清；炼狱全清依赖困难全清 ⇒ **区域全清判断必须按区域+难度+敌人阶段汇总**，不能只看全局成功次数。
- 敌方对我方永远呈现 **30 个敌人节点**；真实玩家不足 30 时系统复制补满。
  🔴 **`nodeId` 才是敌人唯一标识**；`targetId/roleId` 可能因镜像复制而重复，**不能用它去重或替代节点身份**。
- **`nodeId = (组序号-1)*10 + 组内位置`**（全局 1~30，不是每组从 1 重开）。
- **镜像 = 完全复制体，进度与原版不互通**；30 个 `nodeId` 各自独立计数与完成。镜像同样可挑战，请求需透传 `targetIsMirror`。

## 2. 🔴 信息搜集层定稿（2026-09-17，推翻"逐来源探测"）

- 活动为**每周二、三、四各匹配一个敌方俱乐部**；`club_getinfo.club.oppoMap` 的键就是**星期几**（2=周二 / 3=周三 / 4=周四，与 `Date.getDay()` 一致）。
- 🔴 **当天只有那一个键的对手可以查询目标阵容**；其余键的目标一律返回 `200020`。
  此前把三个来源组按 `nodeId` 合并成一张棋盘 ⇒ 当天对手之外发出大量无效请求（可复现日志里 25 个 `(nodeId,targetId)`），是"三组均不可达、当天 0 攻击"的**直接原因**。
- 落地：
  - `campChallengePlanner.js`：`getCampOppoKey()` / `isCampBattleDay()` / `selectTodayCampOppo()`；`collectCampEnemies` **禁止跨来源组调用**。
  - `tasksCampChallengeStrategy.js`：按俱乐部去重分组，**一个俱乐部只用一个成员探测一次**（`legion_getinfo` 成员表给全俱乐部战力，与 `role_getroleinfo` 一致）；目标战力与被拒目标按 `clubId + YYMMDD` **当天缓存**；执行阶段才取 `teamSetParams` 并做**实时额度闸门**。
  - 实测（`log_for_debug11.txt`，09-17）：20 个选中角色归并 2 个俱乐部、只建连 3 次、73 条命令、**0 次失败**；当天两俱乐部 30 个位置 **60/60 全部拿到战力**（key=4）。

## 3. 规划原则（master 2026-09-17 澄清，已实现）

1. **高战力对战不做自动化**（参考意义弱、规则复杂，由人工击杀）；本功能面向"低战力清对面低战力"，阈值默认**「目标战力 ≤ 我方 × 75%」**（`batchSettings.campPowerThreshold` 可覆盖）。
2. **全清判定用对方节点的"剩余可击败次数"** = `5 - (challengeCnt - failCnt)`（`defeated=true` 视为已完成）——人工打到 3/4 次的节点，自动化只补剩余次数。
3. **三个区域组都清不掉时降级为"部分攻击"**（`planPartialCampAttacks`）：把当天对手 30 个节点（含镜像）统一排序（**剩余次数少者优先，其次战力低者**），用"打得赢且最省额度"的角色补足，而不是直接打宠物。
4. **宠物只作保底**（`runPetInsurance`）：攻击宠物**也消耗每日战斗次数与获胜次数**（必赢）⇒ 规划层要**保留每个成员最后 `remainingWins` 次发起额度给宠物**，确保每个角色每天拿满 3 次获胜。

## 4. 命令与领奖

| 命令 | 参数 | 响应关键 |
|---|---|---|
| `legion_getinfo` | — | 成员表（全俱乐部战力） |
| `saltroad_getwartype` | — | 赛事类型 |
| `club_getinfo` | — | `siege.attackMap` / `oppoMap` / `taskClaimedMap` / 30 节点身份与击破状态（**不含 power / battleTeam**） |
| `club_gettargetteam` | `{targetId: Number}` | 单节点战力与阵容（**targetId 必须数值，不是字符串**） |
| `hero_calcpowerbyteam` | — | 阵容战力 |
| `club_attack` | `{nodeId, targetId, challengeCnt, failCnt, targetIsMirror, useItem, teamSetParams:{lordWeaponId, petUId, battleTeam}}` | `siege.attackMap[YYMMDD]` / `battleData.result.isWin` / `reward` / `addScore` |
| `club_attackmonster` | `{useItem:false, teamSetParams}`（**无 nodeId/targetId**） | 宠物挑战（必赢）；13/13 逐字节复现 |
| `club_taskclaim` | `{confId}` | 领奖 |
| `club_draw` | `{}` | 种火石抽奖 |

**计数语义**：`siege.attackMap[YYMMDD].attackCnt`（总发起）/ `.aSuccessCnt`（成功）——**普通与宠物共享这两个计数**。
- ⚠️ `club.members.<slot>.challengeCnt/failCnt/score` **不是**每日攻击计数（39 号当天已攻 3 次但这些字段仍 `0/0/26`）⇒ **只读 `siege.attackMap[YYMMDD]`**。
- `club.members.<key>` 解析为当前角色的 `ownNodeId` 诊断信息（39 号 ↔ `members["2"]`）。
- 历史 `attackMap` 存在但缺今日键 ⇒ 按**今日 0 次**规划；仅 `attackMap` 为空或今日计数不完整时才视为未知并跳过。

**领奖顺序**（A 类奖励 ID 已全部经真实抓包确认）：
`confId: 1`（累计战斗 3 次）+ 第一组 `5/6/7` + 第二组 `8/9/10` + 第三组 `11/12/13`；按 `taskClaimedMap` 过滤已领取。
**B 类**：每击败一个营地敌人得种火石，累计 10 个通过 `club_draw({})` 抽奖一次（次数与种火石数量的对应关系**待确认**）。

**标准链路**（真实 UI 抓包）：
```
legion_getinfo → saltroad_getwartype → club_getinfo → club_gettargetteam
  → hero_calcpowerbyteam → club_attack
```
🔴 **重连后查询或攻击前必须重新建立该上下文**（先 `club_getinfo` 再 `club_gettargetteam`）。

## 5. 批量 UI 入口与模式

`BatchDailyTasks.vue` 的「营地挑战」下拉，共 4 项：
1. **智能规划模式**：复选角色 → 按 `club.legionId` 聚合 → 每个 club 独立获取状态、评估三组 5/4/3 层可达性 → 选**最高可达奖励组**执行；**不同 club 不得共享敌人/nodeId/次数/成功额度/角色容量/攻击计划**。
2. **简版：宠物 3 次 + 领奖**（`batchCampChallengePet`）：遍历选中角色 → `club_attackmonster` 最多 3 次 → 按 `taskClaimedMap` 过滤后领奖；攻击次数按 `siege.attackMap[YYMMDD]` 收敛；额度用尽只领奖；单角色失败不影响其他。
3. **只领取营地奖励**：与简版共用领奖实现。
4. **测试：读对方 30 战力**（只读，逐位置打印战力并汇总成功数）。

## 6. 已修问题 / 实现细节

- `club_gettargetteam` 突发 `200020` → 串行延迟 + 一次重试 + 单目标降级（已完成节点不查询；单目标最终不可查询只影响其所在组评估，不中止整个 club）。
- 目标阵容查询**只针对 `remainingTo5 > 0` 且未 `defeated`** 的敌方节点发送。
- `teamSetParams` 收敛为 `{lordWeaponId, petUId, battleTeam}` 三字段，**不再发送本地辅助字段（阵型编号）**。
- 镜像目标：自动规划仍按 `targetId` 去重；已有普通节点时镜像复用战力，不重复探测；无普通原版可参考的镜像节点标记为**不可评估**。
- 宠物挑战响应 `battleData.result.isWin` 是显式胜负标记（本次与 `accept.ext.curHP === 0` 一致）⇒ 优先读 `isWin`、回退读 `curHP`。

## 7. 待办 / 待验证

- [ ] 普通挑战当前把"最多 3 次"实现为**最多 3 次尝试**，而非最多 3 次成功——失败仍消耗每日 10 次发起额度，但**不应消耗 3 次成功额度**。
- [ ] 抽取共享计数逻辑：总发起上限 10、普通与宠物共享成功上限 3，达任一上限立即停止。
- [ ] 真实攻击失败后的**刷新重规划**、宠物攻击、奖励状态过滤（部分已补）。
- [ ] 确认每日 10 次 / 3 次限制的**服务端错误码**（避免只依赖本地计数）。
- [ ] 更多账号验证三组 `confId` 映射稳定性；`club_draw` 次数与种火石数量的对应关系。
- [ ] 完成一次真实账号单账号低风险验收，再做多账号并发验证。
- [ ] 宠物被击败后的错误码、限流处理。

## 8. 营地红线

1. **`nodeId` 是唯一目标标识**，不能用 `targetId/roleId` 去重。
2. **只有当天那个 `oppoMap` 键（星期几）的对手可查**，其余必返回 200020；禁止跨来源组合并棋盘。
3. 每日次数**只读 `siege.attackMap[YYMMDD]`**，不读 `members.*` 字段。
4. 不同 club **完全隔离**（敌人、次数、额度、计划）。
5. 同一 club **单线程执行**，不得同时两个角色发起挑战。
6. 全 club 成员打完才统一领奖（不要每人打完立刻领）。
7. **高战力对战不做自动化**（阈值默认 75%）。
8. `club_gettargetteam` 的 `targetId` 必须是 **Number**。
