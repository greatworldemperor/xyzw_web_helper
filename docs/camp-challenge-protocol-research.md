# 营地挑战协议与节点模型研究

- 状态：以当前用户规则和真实 WSS 抓包为依据
- 最近更新：2026-09-10
- 相关实现：[src/utils/batch/tasksCampChallengeStrategy.js](../src/utils/batch/tasksCampChallengeStrategy.js)
- 相关抓包目录：[local-data/camp_data](../local-data/camp_data)

## 1. 证据范围

本次整理使用以下资料：

- [readme.txt](../local-data/camp_data/readme.txt)：记录各次手动操作顺序和测试意图。
- [camp_data_attack_multi_enemies.jsonl](../local-data/camp_data/camp_data_attack_multi_enemies.jsonl)：依次攻击不同位置的四个敌人，不含领奖阶段。
- [camp_data_attack_multi_enemies_and_claim_rewards.jsonl](../local-data/camp_data/camp_data_attack_multi_enemies_and_claim_rewards.jsonl)：与上一份日志的攻击阶段相同，额外包含任务领奖和抽奖。
- [camp_data_group2_eliminated.jsonl](../local-data/camp_data/camp_data_group2_eliminated.jsonl)：完成第二组敌人后领取第二组的三个难度奖励，并执行三次抽奖。
- [camp_data_group1_cleared.jsonl](../local-data/camp_data/camp_data_group1_cleared.jsonl)：完成第一组敌人后领取第一组的三个难度奖励，并执行一次抽奖。
- 既有营地日志：[camp_data.jsonl](../local-data/camp_data/camp_data.jsonl)、[camp_data1.jsonl](../local-data/camp_data/camp_data1.jsonl)、[camp_data2.jsonl](../local-data/camp_data/camp_data2.jsonl)、[camp_data_fail.jsonl](../local-data/camp_data/camp_data_fail.jsonl)、[camp_data_more_rewards.jsonl](../local-data/camp_data/camp_data_more_rewards.jsonl)。

日志中的 WSS 数据按项目现有协议链解码：`px` 帧 -> `x` 解密 -> 外层 BON -> `body` 内层 BON。下面的字段名和命令名均来自解码后的报文，未解码或尚未在抓包中出现的字段会明确标记为待验证。

## 2. 核心结论

### 2.1 `nodeId` 使用 1-based 编号

营地对我方固定表现为 30 个敌人节点，`nodeId` 的协议范围是：

```text
[1, 30]
```

不是 `[0, 29]`。当前证据中直接观察到 `nodeId=1`、`3`、`11`、`20` 和 `30`，没有观察到 `nodeId=0`。

三组十个位置的映射为：

| 位置组 | 组内位置 | 全局 `nodeId` |
| --- | --- | --- |
| 第一组 | 1 - 10 | 1 - 10 |
| 第二组 | 1 - 10 | 11 - 20 |
| 第三组 | 1 - 10 | 21 - 30 |

公式为：

```text
nodeId = (组序号 - 1) * 10 + 组内位置
```

如果在代码中使用数组下标，应使用 `nodeId - 1`；如果使用对象或 Map，应直接使用 `nodeId` 作为业务主键，并先验证 `1 <= nodeId <= 30`。

真实玩家不足 30 个时，系统会复制部分敌人补满节点。复制后的节点仍然是独立的可挑战目标，不能因为 `mirror=true` 而过滤。

### 2.2 `oppoMap` 不是三组十格位置

`club_getinfo` 的主要结构为：

```text
body.club.oppoMap.<来源分组键>.defenders.<nodeId>
```

同一响应中的 `body.club.members.<key>` 是我方成员集合。历史日志显示当前角色的 `roleId` 能与这个 `<key>` 对上，例如 39 号角色对应 `members["2"]`，因此代码可将该键记录为 `ownNodeId=2` 用于我方节点身份和诊断。`members` 的 `challengeCnt`、`failCnt`、`score` 仍不能用于个人每日攻击计数；每日攻击计数只读取 `siege.attackMap[YYMMDD]`。

新日志中 `oppoMap` 的键出现过 `2`、`3`、`4`。每个键对应一个独立的敌方俱乐部来源，包含自己的 `legionId`、名称、战力和 `defenders`；它不是第一组、第二组、第三组的位置组。

`defenders` 是稀疏集合：

- 一个 `oppoMap.<key>` 可以包含不同十格位置区间的节点。
- 并非每个 `nodeId` 都会在同一个 `oppoMap` 中出现。
- `defenders` 的对象键才是全局 `nodeId`，不能把 `oppoMap` 的键当作区域编号。
- 同一个 `nodeId` 在不同来源 club 下可以对应不同的 `roleId`，不能跨来源 club 按 `nodeId` 合并。
- 同一来源 club 内的多个快照可以按来源键合并，再以 `nodeId` 建立索引；规划和攻击时必须保留来源 club。

因此，“三组十格位置”与“`oppoMap` 来源 club”是两个不同维度，代码中不能复用同一个 `groupId` 概念表示它们，也不能把多个来源 club 拼成一张 30 节点棋盘。

debug10 进一步验证了这一点：来源 club `2` 和 `3` 各有 30 个节点，来源 club `4` 有 26 个节点；自动请求来源 club `2` 的目标全部返回 `200020`，而来源 club `3` 的 `nodeId=4/12/16` 目标成功返回战队。

### 2.2.1 `oppoMap` 的键是本星期的战斗日（星期几），每天只有一个对手

2026-09-17 复核 debug9/debug10 与历史日志后确认（**主结论，周四需再验一次 key `4`**）：

活动规则为**每周二、三、四共三天，每天匹配一个敌方俱乐部**（每周一报名）。`oppoMap` 的三个键就是本星期的三个战斗日，键值等于**星期几**（`2`=周二、`3`=周三、`4`=周四，与 JS `Date.getDay()` 一致）。因此：

- **当天只有一个来源 club 是有效对手**，其余键是本周其它战斗日的对手。
- `club_gettargetteam` 只接受**当天对手**的目标；查询其它战斗日的目标一律返回 `200020`（"出了点小问题，请尝试重启游戏即可"是服务端的通用拒绝码，不是限流，也不代表该角色不可查）。
- 由此，debug9/debug10 的失败根因是**代码把三个来源 club 按 `nodeId` 合并成了一张棋盘**（复刻 `collectCampEnemies` 的合并规则可逐项复现日志里 25 个 `(nodeId, targetId)` 请求，25/25 一致），其中 22 个节点属于**昨天（key `2`）**的对手 → 全部 `200020`；只有 3 个节点属于**今天（key `3`）**的对手 → 3/3 成功。
- 正确做法是**取 `oppoMap[今天星期几]`** 作为唯一棋盘，不需要"逐来源探测哪家可查"，也不需要"棋盘必须满 30 节点"的门槛。

支持证据（全部来自 `local-data/camp_data/log_for_debug9|10.txt`，均为 2026-09-16 周三）：

| 证据 | 内容 |
| --- | --- |
| `weekScore` 与 `scoreMap` 自洽 | 我方 `weekScore=90` = `scoreMap{2:75, 3:15}` 之和；`dayScore=15` = `scoreMap["3"]` → 键是星期几，今天（周三）= `3` |
| `signUpMap` | `{260831, 260907, 260914}` 全是**周一** → 周一报名、周二三四开打 |
| `attackMap` 日期键 | 历史键只有 `260901/02/03`（9/1 周二、9/2 周三、9/3 周四）、`260908/09/10`（9/8 周二、9/9 周三、9/10 周四）、`260915`（周二）——**从不出现周五到周一** |
| 可查询性 | 唯一可查的是 key `3`（新势力｜挽月，`dayScore=185` 且等于其 `scoreMap["3"]`）；key `2`（昨天）22/22 全拒；key `4`（明天）仅 26 节点、`scoreMap=null`（尚未开战，节点未生成完整） |

失败/成功在同一条连接、同一会话内交错（17:38:17 失败 → 17:38:19 成功 → 17:38:20 失败），且每个失败目标都重试过两次，可排除限流与"整条连接被拒"。

**2026-09-17（周四）实测复核通过**：当天两个俱乐部都只走 `key=4`，60 个位置全部查到战力、0 次 `200020`；key `4` 的棋盘当天是完整 30 个位置。见 §7 第 8 条与 `local-data/camp_data/log_for_debug11.txt`。

### 2.3 `nodeId` 是目标身份，`roleId` 只是目标角色

镜像复制会导致多个节点拥有同一个 `roleId`。新日志中观察到：

- 非镜像 `nodeId=6` 与镜像 `nodeId=20` 都使用 `roleId=705342925`。
- 非镜像 `nodeId=11` 与镜像 `nodeId=27` 都使用 `roleId=710072859`。

所以：

- 目标缓存、去重、计数和完成状态必须以 `nodeId` 为主键。
- `targetId` 在攻击请求中对应目标角色的 `roleId`，不能替代 `nodeId`。
- 每个节点必须单独保存 `nodeId`、`targetId/roleId`、`mirror`、`defeated`、`challengeCnt` 和 `failCnt`。
- 攻击请求必须透传该节点的 `targetIsMirror`，不能通过 `roleId` 推断或合并镜像节点。
- **镜像是完全复制体，进度与原版不互通**（master 2026-09-17 确认）：打掉镜像不会推进原版的 `challengeCnt`，两者各自累计；因此"整组全清"按该组 10 个 `nodeId` 各自完成 5 次计算，镜像节点在其所属 `nodeId` 区间内正常参与。

## 3. 多敌人攻击实验

两份新日志的攻击阶段完全一致。`readme.txt` 记录的操作顺序为：

1. 第一组第三个敌人，失败。
2. 第一组第一个敌人，成功。
3. 第二组第一个敌人，成功。
4. 第二组第十个敌人，成功。

解码后的请求和响应如下：

| 次数 | 位置 | `nodeId` | `targetId`/`roleId` | `targetIsMirror` | 结果 | `attackCnt` | `aSuccessCnt` |
| --- | --- | ---: | ---: | --- | --- | ---: | ---: |
| 1 | 第一组第 3 个 | 3 | 706334526 | `false` | 失败 | 1 | 0 |
| 2 | 第一组第 1 个 | 1 | 716058477 | `false` | 成功 | 2 | 1 |
| 3 | 第二组第 1 个 | 11 | 710072859 | `false` | 成功 | 3 | 2 |
| 4 | 第二组第 10 个 | 20 | 705342925 | `true` | 成功 | 4 | 3 |

失败响应只返回对应节点的计数变化，例如：

```text
club.oppoMap.<key>.defenders.3.failCnt = 1
club.oppoMap.<key>.defenders.3.challengeCnt = 1
```

成功响应会返回对应节点的挑战变化和奖励；本次四次攻击后每日计数为：

```text
siege.attackMap[260909].attackCnt = 4
siege.attackMap[260909].aSuccessCnt = 3
```

日期键 `260909` 是该次日志日期的 `YYMMDD` 表示。实现时应按当前日期生成键，不应写死该值。

## 4. 已观察到的协议命令

| 请求命令 | 响应命令 | 已观察用途 | 当前状态 |
| --- | --- | --- | --- |
| `club_getinfo` | `Club_GetInfoResp` | 获取俱乐部、敌方来源分组和节点状态 | 已确认 |
| `club_gettargetteam` | `Club_GetTargetTeamResp` | 获取目标角色和战斗队伍 | 已确认 |
| `hero_calcpowerbyteam` | `Hero_CalcPowerByTeamResp` | 攻击前计算己方队伍战力 | 已确认 |
| `club_attack` | `Club_AttackResp` | 普通敌人攻击 | 已确认 |
| `club_attackmonster` | `Club_AttackMonsterResp` | 宠物攻击 | 已确认（`camp_data.jsonl`） |
| `club_taskclaim` | `Club_TaskClaimResp` | 领取营地任务进度奖励 | 已确认 |
| `club_draw` | `Club_DrawResp` | 消耗种火石抽奖 | 已确认 |

响应匹配应继续使用项目 WebSocket 客户端的 `resp`、请求 `seq` 和命令映射，不能只按命令名等待第一个响应。

### 4.1 `club_getinfo`

请求 body 为 `{}`。响应的关键路径为：

```text
body.club.oppoMap.<sourceGroup>.defenders.<nodeId>
```

节点常见字段包括：

```text
roleId
name
score
lordSkinId
petId
petEvo
defeated
failCnt
challengeCnt
mirror
```

新增敌情查看抓包确认：`club_getinfo` 返回的 30 节点大包只包含节点身份和状态字段，例如 `roleId`、`name`、`score`、`petId`、`defeated`、`failCnt`、`challengeCnt`、`mirror`；其中没有 `power`，也没有 `battleTeam`。因此大包可以用于节点、镜像和击破进度筛选，不能直接替代目标战力查询。

由于节点集合可能是稀疏的，`defenders` 中缺少某个键不能直接解释为该节点不存在或已完成，需要结合完整的 30 节点模型和服务端返回状态判断。

### 4.2 `club_gettargetteam`

请求只需要目标角色 ID：

```js
{ targetId: defender.roleId }
```

类型必须是数值型。历史真实抓包中的 BON 请求为 `{"targetId":719442918}`；debug9 曾暴露自动实现发送 `{"targetId":"715575104"}` 的字符串差异。当前实现已在节点收集和请求边界统一将 `roleId/targetId` 规范为 Number。

响应包含：

```text
body.roleBattleTeam.role.roleId
body.roleBattleTeam.role.power
body.roleBattleTeam.battleTeam
```

目标战力可从 `roleBattleTeam.role.power` 读取。`battleTeam` 是目标阵容详情，不能把它当成攻击请求中的己方 `teamSetParams.battleTeam`。

查询目标阵容前应先按节点状态过滤：`remainingTo5 <= 0` 或 `defeated=true` 的节点已经没有可完成的击破次数，不应再发送 `club_gettargetteam`。最新调试日志中 `targetId=719442918`（历史上对应 `nodeId=11`）在此前抓包中可以正常查询，但在该节点可能已被其他角色击败完成后重复查询返回 `200020`；这类错误不能直接归因于当前低战力角色没有出战。

历史手动抓包中的连续 `club_gettargetteam` 请求通常间隔约 1 到 5 秒；批量实现不能在同一秒突发查询全部目标。当前执行器按命令延迟串行查询，临时失败会等待后重试一次；单个目标最终仍不可查询时，只将该目标标记为不可评估，让规划器继续比较其他位置组，不再中止整个 club。

新增的 `camp_data_get_enemy_info` 抓包确认界面本身会对用户查看的少量目标发送 `club_gettargetteam`，其中也可能包含镜像节点；这不改变自动规划规则：同一 `targetId` 已有普通节点时，镜像复用普通节点的战力，不重复探测；只有镜像且没有可参考的普通节点时，自动规划将其标记为不可评估。

历史成功链路还确认了连接上下文顺序：同一条 WSS 连接上先发送 `club_getinfo`，再发送 `club_gettargetteam`，之后才发送 `club_attack`。批量执行器如果为了查询目标重新建立连接，必须在该新连接上再次发送 `club_getinfo`，不能只完成通用角色/战斗初始化后直接查询目标。

### 4.3 `club_attack`

真实 UI 的单次普通攻击链路为：

```text
legion_getinfo
  -> saltroad_getwartype({ date: 最近/当前营地周六 })
  -> club_getinfo
  -> club_gettargetteam({ targetId })
  -> hero_calcpowerbyteam({ battleTeam, lordWeaponId, petUId })
  -> club_attack({ nodeId, targetId, targetIsMirror, ... })
```

重新建立 WSS 后，不能只执行通用角色初始化再直接发送 `club_gettargetteam`；必须在该连接上重新建立营地上下文。`hero_calcpowerbyteam` 是真实攻击前的战力计算步骤，不能省略。

新日志观察到的请求结构为：

```js
{
  nodeId: 20,
  targetId: 705342925,
  targetIsMirror: true,
  challengeCnt: 0,
  failCnt: 0,
  useItem: false,
  teamSetParams: {
    lordWeaponId: 3,
    petUId: "",
    battleTeam: {
      0: 116,
      1: 102,
      2: 112,
      3: 107,
      4: 106
    }
  }
}
```

已确认的字段类型和语义：

- `nodeId`：数值型，全局节点身份，范围 `1..30`。
- `targetId`：数值型，当前报文中等于目标 `roleId`。
- `targetIsMirror`：布尔型，必须使用目标节点自身的 `mirror` 值。
- `challengeCnt`、`failCnt`：数值型，本次抓包请求均为 `0`；服务端返回的节点计数会递增。
- `useItem`：布尔型，本次为 `false`。
- `teamSetParams.lordWeaponId`：数值型，本次为 `3`。
- `teamSetParams.petUId`：字符串型，本次为空字符串。
- `teamSetParams.battleTeam`：位置到英雄 ID 的对象。

响应包含 `club`、`siege`、`battleData`，成功时通常还包含 `reward`。每日攻击计数的已确认路径为：

```text
body.siege.attackMap[YYMMDD].attackCnt
body.siege.attackMap[YYMMDD].aSuccessCnt
```

普通攻击和宠物攻击共用这两个计数。最新批量调试日志确认：`club_getinfo` 的 `siege.attackMap` 会保留历史日期；如果存在历史日期键但没有今日 `YYMMDD` 键，应解释为今日尚未发起攻击，即今日 `attackCnt=0`、`aSuccessCnt=0`。只有 `attackMap` 完全缺失/为空，或今日键存在但缺少两个计数字段，才应视为计数未知并停止自动规划。

不要使用 `club.members.<slot>.challengeCnt`、`failCnt` 或 `score` 推导当前角色的每日攻击次数：新日志中 39 号角色当天已完成 3 次攻击，但成员记录仍为 `challengeCnt=0`、`failCnt=0`、`score=26`。这些成员字段与个人每日攻击计数不是同一语义；自动规划只读取 `siege.attackMap[YYMMDD]`。

日志还确认批量账号切换前的 Token 主动刷新和 WSS 初始化均成功；后续 `[连接诊断]` 的连接超时应与营地计数缺失分开排查。当前尚未把 `battleData` 中的某个字段单独认定为所有场景通用的胜负判定；`battleData` 常见顶层键包括 `id`、`mode`、`randomSeed`、`version`、`maxRound`、`leftTeam`、`rightTeam` 和 `result`，胜利判定仍需覆盖宠物攻击后再最终确认。

### 4.3.1 `club_attackmonster`

`camp_data.jsonl`（2026-09-08 10:15:34）首次抓到宠物攻击，整份抓包的 13 个可复现 SEND 帧经 `verify_roundtrip.mjs --dir send` **全部逐字节精确复现（13/13，0 失败）**。

真实 UI 的宠物攻击链路：

```text
club_getinfo
  -> hero_calcpowerbyteam({ battleTeam, lordWeaponId, petUId })
  -> club_attackmonster({ useItem, teamSetParams })
```

请求体**不含 `nodeId` / `targetId`**：宠物是全 club 共享目标，不是某个十格位置节点。

```js
{
  useItem: false,
  teamSetParams: {
    lordWeaponId: 3,
    petUId: "",
    battleTeam: { 0: 116, 1: 102, 2: 112, 3: 107, 4: 106 }
  }
}
```

要点：

- `teamSetParams` **只有三个字段**（`lordWeaponId` / `petUId` / `battleTeam`）。`battleTeam` 的键按抓包是**字符串**（tag 5），`hero_calcpowerbyteam` 与 `club_attack` 用的是同一份对象；客户端实现里不要额外塞入本地辅助字段（例如阵型编号），否则报文体与真实客户端不一致。
- `hero_calcpowerbyteam` 的请求体与 `teamSetParams` **完全同构**（`battleTeam` / `lordWeaponId` / `petUId`），响应为 `body.power`。

响应结构（`Club_AttackMonsterResp`）：

```text
body.role.diamond / freeDiamond / items.<itemId>.quantity
body.reward[]                                 本次奖励
body.club.{weekScore,dayScore,members}
body.siege.score
body.siege.attackMap[YYMMDD].{attackCnt,aSuccessCnt}
body.battleData.leftTeam.*   己方
body.battleData.rightTeam.*  宠物
body.battleData.result.isWin                 显式胜负标记
body.battleData.result.sponsor.ext.curHP     己方剩余血量
body.battleData.result.accept.ext.curHP      宠物剩余血量（0=击败）
body.addScore                                本次得分
```

本次观测：宠物攻击前 `attackCnt=1`，攻击后变为 `attackCnt=2`、`aSuccessCnt=1`，证实**普通攻击与宠物攻击共享 `attackMap` 的每日计数与成功额度**。胜负判定可直接读 `battleData.result.isWin`（比只依赖 `accept.ext.curHP === 0` 更直接，二者本次一致）。

### 4.4 `club_taskclaim`

```js
{ confId: 1 }
```

`confId=1` 是累计战斗 3 次奖励，不属于某一个十格位置组。当前已经通过全清日志确认三组位置奖励 ID：

| 位置组 | 普通难度 | 困难难度 | 炼狱难度 | 证据 |
| --- | ---: | ---: | ---: | --- |
| 第一组 | `5` | `6` | `7` | `camp_data_group1_cleared` |
| 第二组 | `8` | `9` | `10` | `camp_data_group2_eliminated` |
| 第三组 | `11` | `12` | `13` | `camp_data_attack_multi_enemies_and_claim_rewards` 及此前全清记录 |

第二组全清日志中的请求顺序为：

```text
confId = 1
confId = 8
confId = 9
confId = 10
```

第三组全清日志中的请求顺序为：

```text
confId = 1
confId = 11
confId = 12
confId = 13
```

第一组全清日志中的请求顺序为：

```text
confId = 1
confId = 5
confId = 6
confId = 7
```

响应包含 `siege.taskClaimedMap`，例如：

```text
siege.taskClaimedMap.1  = 1788939946
siege.taskClaimedMap.8  = 1788948990
siege.taskClaimedMap.9  = 1788948992
siege.taskClaimedMap.10 = 1788948993
siege.taskClaimedMap.5  = 1789008064
siege.taskClaimedMap.6  = 1789008065
siege.taskClaimedMap.7  = 1789008067
```

这些值表现为领取时间戳或服务端记录值，具体单位和持久化语义仍不需要由客户端推断；判断已领取时应以键是否存在和服务端返回为准。

本次响应观察到的奖励内容如下，物品含义仍应通过物品表或更多抓包确认：

| `confId` | 观察到的奖励 |
| ---: | --- |
| 1 | `itemId=41004, value=1` |
| 5 | `itemId=41004, value=1`；`itemId=41003, value=150` |
| 6 | `itemId=41004, value=1`；`itemId=41003, value=150`；`itemId=1023, value=1` |
| 7 | `itemId=1023, value=2`；`itemId=41003, value=200` |
| 8 | `itemId=41004, value=1`；`itemId=41003, value=150` |
| 9 | `itemId=41004, value=1`；`itemId=41003, value=150`；`itemId=1022, value=500` |
| 10 | `itemId=41003, value=200`；`itemId=1022, value=1000` |
| 11 | `itemId=41004, value=1`；`itemId=41003, value=150` |
| 12 | `itemId=41004, value=1`；`itemId=41003, value=150`；`itemId=1001, value=3` |
| 13 | `itemId=1001, value=5`；`itemId=41003, value=200` |

当前已通过真实全清日志确认第一组使用 `5/6/7`、第二组使用 `8/9/10`、第三组使用 `11/12/13`。三组配置 ID 连续衔接，先前提出的 `2/3/4` 仅是低概率备选，已被第一组实测结果排除。

### 4.5 `club_draw`

请求 body 为空对象：

```js
{}
```

三份领奖日志在任务领奖后分别出现一次、三次和两次 `club_draw`。响应为 `Club_DrawResp`，包含 `siege.boxId`、`siege.poolRewards` 和实际 `reward`。第二组全清日志中观察到：

- 第一次抽奖返回 `boxId=2`，实际奖励包含 `itemId=3008, value=4`。
- 第二次抽奖返回 `boxId=3`，实际奖励包含 `itemId=3010, value=5`。
- 第三次抽奖返回 `boxId=4`，实际奖励包含 `itemId=3010, value=5`。

第一组全清日志中的抽奖返回 `boxId=5`，实际奖励包含 `itemId=3009, value=5`。

此前业务分析已确认：击败敌人会获得种火石，累计 10 个种火石后通过 `club_draw({})` 抽奖一次。具体种火石物品 ID和服务端剩余数量字段仍应以更多响应为准。

## 5. 业务规则

以下规则来自用户确认、既有营地日志和跨日志对比；不应只依赖单次 `club_getinfo` 响应中的局部字段：

- 每日最多发起 10 次挑战。
- 每日成功挑战最多 3 次。
- 普通玩家挑战和宠物挑战共享这 3 次**成功**额度。
- **攻击宠物同样消耗每日的"战斗次数"和"获胜次数"**（宠物必胜）。master 2026-09-17 明确以此为准（此前"宠物不计发起次数"的说法已作废）。因此：
  - 规划层必须**保留每个成员最后 `remainingWins` 次发起额度给宠物**（`planPartialCampAttacks` 的 `reserveWinsForPet`），否则中途打普通怪失败会挤掉必胜名额，拿不满 3 次获胜；
  - 宠物保底同时受"剩余发起次数"和"剩余成功次数"约束（`runPetInsurance`），实现上按"宠物也占发起额度"保守记账；
  - 目标是**每个角色每天必须获胜 3 次**。
  - 待实跑确认：日志里 `260915` 出现过 `attackCnt=0 / aSuccessCnt=3`（发起 0 次却成功 3 次），与"宠物也消耗战斗次数"不一致，需要在真实攻击宠物时观察 `attackMap[今日]` 两个计数如何变化。
- 失败会消耗每日 10 次发起额度，但不消耗 3 次成功额度。
- 每个敌人总共可被击败 5 次；此前业务模型将其分为普通、困难、炼狱阶段，阶段和奖励领取需要按区域分别汇总。
- **每个敌人的剩余可击败次数可直接从 `oppoMap.<key>.defenders.<nodeId>` 推导**：`successCount = min(5, challengeCnt - failCnt)`，`defeated=true` 视为已完成（`successCount = 5`）。双向样本一致：我方 `club.members`（`challengeCnt=5, failCnt=0, defeated=true`）与敌方 `defenders`（`challengeCnt=5, failCnt=4, defeated=false` ⇒ 1 次成功）都符合该公式。人工击杀高战力敌人若干次（3~4 次）后，这里的剩余次数会同步变小，规划必须以它为准，而不是固定按 5 次算。
- `confId=1` 已确认对应累计战斗 3 次，且不论胜负。
- 每个区域存在普通、困难、炼狱三档全清奖励；困难依赖普通全清，炼狱依赖困难全清。
- A 类任务进度奖励和 B 类种火石抽奖奖励是两套独立逻辑。

实现计数时，应优先读取服务端返回的：

```text
attackCnt
aSuccessCnt
```

其中 `aSuccessCnt` 是共享成功次数，不能分别为普通攻击和宠物攻击维护两个成功计数器；`attackCnt` 只由普通攻击推进。

## 6. 实现约束

目标收集逻辑应满足以下不变量：

```js
for (const nodeId of [1, 2, ..., 30]) {
  // 在所有 oppoMap.<key>.defenders 中寻找该 nodeId
  // 不按 roleId 去重
  // mirror 节点照常加入候选
}
```

每个攻击目标至少应保留：

```js
{
  nodeId,
  targetId: defender.roleId,
  targetIsMirror: Boolean(defender.mirror),
  sourceGroupKey,
  challengeCnt,
  failCnt,
  defeated,
  roleId: defender.roleId
}
```

攻击流程建议保持以下顺序：

```text
club_getinfo
  -> 收集 1..30 节点并按 nodeId 建索引
  -> club_gettargetteam({ targetId })
  -> 准备己方 battleTeam / 必要时执行 hero_calcpowerbyteam
  -> club_attack({ nodeId, targetId, targetIsMirror, ... })
  -> 读取 siege.attackMap[YYMMDD]
  -> 更新该 nodeId 的失败/挑战状态
  -> 继续下一目标或停止
```

不要使用以下做法：

- 不要把 `oppoMap` 的键当作三个区域编号。
- 不要把 `roleId` 当作节点唯一键。
- 不要跨来源 club 按 `nodeId` 合并成一张棋盘（每天只有当天对手那一个键有效，见 2.2.1）。
- 不要过滤 `mirror=true` 的节点。
- 不要把失败次数当成成功次数。
- 不要把普通挑战和宠物挑战的成功额度分开计算。
- 目前三组 `confId` 均已有真实抓包确认：第一组 `5/6/7`、第二组 `8/9/10`、第三组 `11/12/13`。

### 6.1 信息搜集层：连接与请求的最小化

规划阶段需要的信息可以按"归属粒度"拆成两类，避免为每个选中角色都建一次连接、发一遍全套命令（2026-09-16 日志中 16 个账号各建一次连接、各发 5 个快照命令，`club_getinfo` 被重复调用 40 次）：

| 信息 | 粒度 | 最小成本 |
| --- | --- | --- |
| 我方俱乐部成员表、**我方每个角色战力** | club 级 | `legion_getinfo {}` 一次。`info.members[roleId].power` 与 `role_getroleinfo.role.power` 在 17 个角色上 **17/17 完全一致**；更省的做法见下 |
| 我方角色 → 俱乐部分组、我方战力/阵容/petUId | 单连接 | `rank_getroleinfo { roleId }`（见 7.1）：一个连接就能为所有选中角色取到 `legionId`/`power`/`lordWeaponId`/`pet.petUId`/`battleTeam`，**不必按俱乐部逐个探测** |
| 当日对手棋盘 `oppoMap[今天星期几]` | club 级 | `club_getinfo {}` 一次（20 份快照的 oppoMap 完全一致，用哪个成员查都一样），可与目标查询共用同一条连接 |
| 敌方目标阵容/战力 | club 级 | `club_gettargetteam { targetId }`，由任一成员连接发即可；只查当天对手的节点 |
| **每个角色当日剩余额度** `siege.attackMap[YYMMDD].attackCnt/aSuccessCnt` | **role 级** | 必须用该角色自己的连接读（16 个账号的 attackMap 各不相同：39 号有 `260908` 而其它角色没有，momo381/momo391 出现过 `4/3`） |
| 己方我方战力/阵容/`petUId` | 单连接 | 首选 `rank_getroleinfo`（见 7.1）；只有 `arenaFormation` 指定了非当前预设阵容时，才需要该角色连接上的 `presetteam_getinfo` |

俱乐部分组（当前实现，首选路径）：一个连接对每个选中角色发 `rank_getroleinfo`，用响应里的 `legionId` 直接分组；查不到 `legionId` 的角色才退回下面这种"用它的连接读俱乐部成员表"的兜底方式：

```js
const visitedRoles = new Set();
const clubs = [];
for (const role of selectedRoles) {
  if (visitedRoles.has(role.roleId)) continue;
  const members = await fetchClubMembers(role.tokenId); // 兜底：该角色连接上的 legion_getinfo
  for (const member of members) {
    if (selectedRoleIds.has(member.roleId)) visitedRoles.add(member.roleId);
  }
  clubs.push(extractClubId(members));
}
```

由此，**规划阶段的连接数 = 1（分组发现）+ 我方俱乐部数**（每个俱乐部一条连接，上下文与目标查询共用）；执行阶段再为每个参战角色建自己的连接，并在该连接上顺手读 `attackMap` 校正 10/3 额度。额度一律以服务端返回为准，不用本地自增计数。

## 7. 仍待验证

1. ~~`club_attackmonster` 的完整请求体、响应体，以及它是否完全复用 `attackCnt/aSuccessCnt`。~~ 已由 `camp_data.jsonl` 确认，见 4.3.1；仍待验证的是宠物被击败后再次攻击的服务端错误码，以及宠物是否有独立的剩余血量/次数上限。
2. `hero_calcpowerbyteam` 的更多错误响应语义；请求字段和攻击前调用顺序已由真实抓包确认。
3. `battleData.result.accept.ext.curHP === 0` 是否同时适用于普通攻击和宠物攻击的胜利判断。
4. 每日 10 次和每日 3 次限制触发时的服务端错误码、`code` 和 `hint`。
5. 三组配置 ID 在更多账号上的稳定性，以及第一组全清后只出现一次 `club_draw` 的种火石/抽奖前置状态。
6. `challengeCnt` 和 `failCnt` 在重复攻击同一节点、跨难度阶段时的服务端递增语义。
7. 种火石对应的物品 ID、当前数量字段和 `club_draw` 的服务端前置条件。
8. ~~**周四（下一场战斗日）复核 `oppoMap` 的键**~~ ✅ **已实测确认（2026-09-17 周四，`log_for_debug11.txt`）**：两个俱乐部（7199227「第一批」19 人、7203672「第二批」1 人）当天都命中 `key=4`，并且**每个位置都能查到战力：位置 60/60、去重目标 47/47、0 次 `200020`**。key `4` 的棋盘当天是**完整 30 个位置**（09-16 快照里只有 26 个是因为当时尚未开战、节点还没补齐），因此"棋盘必须满 30 节点"这个门槛确实不该作为前置条件。
9. ~~`rank_getroleinfo { roleId, bottleType: 0, includeBottleTeam: false, isSearch: false }` 的完整响应字段~~ ✅ **已确认（2026-09-17，见 7.1）**：响应含 `legionId`、`power`、`lordWeaponId`、`petUId`、`battleTeam`，可用单连接完成所有角色的俱乐部分组与我方阵容组装。
10. `attackMap` 的粒度是 role 级还是 club 级共享：日志显示 16 个账号的 `attackMap` 互不相同（39 号有 `260908`、momo381/momo391 出现 `4/3`），据此判断是 role 级，但需与"共享 3 次成功额度"的既有表述对齐含义。
11. `260915` 出现 `attackCnt=0` 而 `aSuccessCnt=3` 的计数口径。
12. 达到 3 次成功后是否仍可发起（日志出现过 `4/3`；按客户端约定应由我们自己严格在 3 胜后停止）。

### 7.1 `rank_getroleinfo` 用单连接就能拿到我方角色的全部规划字段（2026-09-17 确认）

抓包位置（**不在 `camp_data`**）：

- `local-data/misc/xianchen_search.jsonl`（2026-09-15，查的是别的玩家 `620825899`）：SEND 7 帧 `rank_getroleinfo` + RECV 7 帧 `Rank_GetRoleInfoResp`。`verify_roundtrip.mjs --dir send` 结果 **`rank_getroleinfo` 7/7 精确逐字节复现**。
- `local-data/pantao-analysis/`（2026-09-13）另有一份：`_pantao_decoded.txt` 有完整收发，`_verify_bins.txt` 记录 `rank_getroleinfo: 1/1 精确`、`Rank_GetRoleInfoResp: 2/2 精确`。

请求（137 字节，与项目既有用法一致）：

```json
{"roleId": 620825899, "bottleType": 0, "includeBottleTeam": false, "isSearch": false}
```

响应 `body.roleInfo.*` 的关键字段（实测可查**任意** roleId，不需要该角色在线）：

| 字段 | 用途 |
| --- | --- |
| `roleInfo.legionId` | **我方角色 → 俱乐部分组**（不必为该角色建连就能分组） |
| `roleInfo.power` | 我方角色总战力（与 `role_getroleinfo.role.power` 同口径） |
| `roleInfo.lordWeaponId` | `teamSetParams.lordWeaponId` |
| `roleInfo.pet.petUId`（如 `"109-Ple"`） | `teamSetParams.petUId` |
| `roleInfo.battleTeam`（`{0:{heroId:116},…,4:{heroId:107}}`，只需 `heroId`） | `teamSetParams.battleTeam` |
| `roleInfo.heroes[*].battleTeamSlot` | 上阵槽位，可与 `battleTeam` 交叉校验 |
| `roleInfo.name` / `serverName` | 日志展示 |
| `legionInfo.{id,name,dan}` | 顺带拿到我方俱乐部名与段位 |
| `showPet.{petId,level,redQuenchSlot}` | 宠物展示信息 |

由此得到的结论：

- **俱乐部分组不再需要"按俱乐部逐个探测"**：一个连接为所有选中角色发 `rank_getroleinfo` 即可拿到 `legionId`，直接分组。
- 我方战力、阵容与 `petUId` 在规划阶段就能取全，不必逐角色 `role_getroleinfo` + `presetteam_getinfo`。
- 每个俱乐部的 `club_getinfo` 仍必须由**该俱乐部成员**的连接发出（它返回"连接角色所在俱乐部"的上下文），这条绕不过去，但可以和目标查询共用同一个连接。
- 待确认：`roleInfo.battleTeam` 是"当前出战队"；若要按 `arenaFormation` 指定某个预设队伍，仍需该角色连接上的 `presetteam_getinfo`。

## 8. UI 入口与 club 独立规划

### 8.1 UI 入口

批量营地挑战使用 [src/views/BatchDailyTasks.vue](../src/views/BatchDailyTasks.vue) 中现有的“营地挑战”按钮作为唯一入口。用户可以在批量角色列表中复选多个角色；执行器先按照所选角色所属的 `club` 分组，再逐个处理每个 `club`。

这里的 `club` 是战斗边界，不是仅用于 UI 展示的分组标签。每个 `club` 都有自己的：

- 敌方 30 个 `nodeId` 节点和 `oppoMap` 数据。
- 敌方节点的已击破进度、剩余需求和镜像属性。
- 所选我方角色、每日 `attackCnt`、共享 `aSuccessCnt` 和可用攻击容量。
- 三组可达性评估结果、最终选择的目标组和真实攻击计划。

不同 `club` 之间不得共享敌人、`nodeId`、每日次数、成功次数、角色战斗容量或攻击计划。一个 `club` 的敌人不能由另一个 `club` 的角色攻击；多个 `club` 的角色也不能合并成一个虚拟战斗池。

### 8.2 每个 club 的规划顺序

每个 `club` 独立执行以下流程：

```text
选中角色
  -> 按所属 club 分组（每个 club 只用一次连接就能拿到成员表和全俱乐部战力）
  -> 获取该 club 的实时 club_getinfo，取 oppoMap[今天星期几] 作为当天唯一对手棋盘
  -> 只查询当天对手仍有需求节点的真实目标阵容和战力（绝不跨战斗日的键合并）
  -> 虚拟评估第一组、第二组、第三组的 5/4/3 层可达性
  -> 选择该 club 可达层级最高的一个组
  -> 只对该 club 的目标组执行真实攻击
  -> 每次攻击后刷新该 club 状态，必要时重新规划
  -> 按该 club 的完成状态领取奖励
```

三组评估必须在真实攻击前全部完成。比较依据是每组的最高可达层级：

```text
5 层 > 4 层 > 3 层 > 不可达
```

例如同一个 `club` 的第一组最高只能达到 3 层、第二组可以达到 5 层、第三组不可达，则选择第二组；另一个 `club` 应根据自己的敌人和角色状态独立选择，不受前一个 `club` 的结果影响。

### 8.3 设计稿与实现的边界

[local-data/camp_data/design.txt](../local-data/camp_data/design.txt) 是业务策略和约束的伪代码说明，不是最终 JavaScript/TypeScript 的接口或结构规范。最终实现不需要逐行翻译其中的 C++ 风格代码，也不需要复用其中的类名、循环方式、排序方式或数据结构。

实现可以使用纯规划函数、服务端状态适配器、最大匹配/回溯/贪心算法、独立任务执行器或其他等价结构，但必须保留以下行为契约：

1. 以单个 `club` 为规划和执行边界。
2. 先获取实时敌方状态，再虚拟判断整组 5/4/3 层是否可达。
3. 整组奖励要求所有仍有需求的 `nodeId` 都能完成，不能跳过无法击败的节点后把部分成功当作整组可达。
4. 选定最高奖励组后才发送真实攻击。
5. 真实攻击改变状态后，以服务端响应为准，过期计划需要停止并重新规划。
6. UI 层只负责读取复选角色、触发任务和展示进度，不直接承担协议解码和战斗规划细节。

## 9. 对当前代码的影响

### 9.1 2026-09-17：信息搜集层改造（当前实现）

按 2.2.1 与 6.1 的结论重做，智能规划现在是「信息搜集层优先」的结构：

- `campChallengePlanner.js` 新增 `getCampOppoKey()`（键=星期几）、`isCampBattleDay()`（周二/三/四）、`selectTodayCampOppo()`（**只取当天那一个来源组**）；`collectCampEnemies` 已加注释禁止跨来源组调用（跨组会按 nodeId 互相覆盖，拼出混合棋盘，是 200020 的根因）。
- `tasksCampChallengeStrategy.js`：
  - `discoverClubGroups()`：**一个连接批量发 `rank_getroleinfo`**（见 7.1），用响应里的 `legionId` 直接完成俱乐部分组，同时拿到每个我方角色的 `power`/`lordWeaponId`/`pet.petUId`/`battleTeam`；只有查不到 `legionId` 的角色才退回"用它的连接探测 `legion_getinfo` 成员表"的兜底路径。
  - 每个俱乐部只开**一条**信息连接：`readClubHeaderOnConnection()`（legion_getinfo + saltroad_getwartype + club_getinfo）与目标战力查询（`runTargetQueriesInsideConnection`）共用它，不再"探测一次、查询再连一次"。
  - 作战棋盘只来自 `selectTodayCampOppo()`，不再做"逐来源探测"，也不再要求"棋盘必须满 30 节点"。
  - 目标战力与被拒绝目标按 `clubId + YYMMDD` 缓存：同一目标当天不重复撞击；服务端明确拒绝（含 200020）时一次即止、不重试。
  - 规划阶段的我方战力与 `teamSetParams` 来自 `rank_getroleinfo` 摘要；执行阶段仍在角色自己的连接上校验实时额度（`club_getinfo`），只有 `arenaFormation` 指定了非当前阵容时才补读 `presetteam_getinfo`。
  - 规划顺序：先按 `selectBestCampGroup({ requireCompleteNodes: true })` 找"整组可达"的组；**三组都不可达时降级为"部分攻击"**（`planPartialCampAttacks`：30 个节点含镜像统一排序，打打得赢的对手）；普通攻击之后再用 `runPetInsurance` 把剩余成功额度用必胜宠物补满。计划执行中途中止也会继续保底与领奖，不浪费当天额度。
  - 新增只读**测试模式** `batchCampDiagnose`：读取当天对手 30 个位置的全部战力，逐位置打印 `nodeId/roleId/mirror/进度/战力`，并汇总"位置成功 x/30、去重目标成功 y/z"；不攻击、不领奖。
- `BatchDailyTasks.vue`：同一个「营地挑战」按钮的下拉现在是 4 个模式——`智能规划战斗` / `简版：宠物3次+领奖` / `只领取营地奖励` / `测试：读对方30战力`。
- `test/campChallengeTodayOppo.test.js`：覆盖键=星期几、战斗日判定、当天只取一个来源组（并显式断言旧合并规则会取到别的组）、当天对手缺失时不回退、测试模式只读 25 个去重目标且不发任何攻击。

改造后仍需补齐：规划阶段的每日额度是乐观值（依赖执行阶段实时闸门校正，额度不足时跳过该角色的计划攻击而非重新规划）；`club_attackmonster` 未接入虚拟规划；`club_draw` 次数仍待按种火石状态决定；「打不过时退而求其次打最低战力敌人」这一例外尚未实现。

**2026-09-17 实跑与预演暴露的原则冲突（已按 master 澄清落定）**：`log_for_debug11.txt` 显示信息层已经完全可用（60/60 位置、47/47 去重目标、0 失败）；但用同一份真实数据预演规划（`local-data/camp_data/_plan_preview.mjs`）时，**两个俱乐部的三个区域组全部不可达**——「第一批」19 人战力 7.1~19.1 亿（+1 个 102.1 亿），当天对手节点战力 9.9~113.4 亿，每组都有节点连我方最强者（按 100% 放宽）也打不动。

master 澄清后的原则（**已实现**）：

1. **高战力对战不做自动化**：高战力对局的战力数值参考意义弱、规则复杂，由人工击杀对方高战力；本功能主要面向"低战力清对面低战力"，在这类对局里战力阈值（默认 `0.75`）参考价值较高。测试用的百亿角色不代表真实使用场景。
2. **全清判定用"剩余可击败次数"**（见 §5），人工打到 3/4 次的节点，自动化只补剩余次数。
3. **三组都清不掉时降级为"部分攻击"**（`planPartialCampAttacks`）：把当天对手 30 个节点（**含镜像**）统一排序（剩余次数少者优先，其次战力低者优先），用"打得赢且最省额度"的我方角色补足，而不是直接打宠物。
4. **宠物只作保底**：普通攻击用完后仍有成功额度没拿满时，才用必胜的宠物补（`runPetInsurance`），并且宠物也占发起额度、受剩余次数约束。计划层保留每个成员最后 `remainingWins` 次发起额度给宠物，确保**每人每天拿满 3 次获胜**。
5. **镜像节点是完全的复制体，进度与原版不互通**（master 2026-09-17 确认）：因此 30 个 `nodeId` 各自独立计数、独立作为可打目标；清掉一个镜像不会推进原版，整组全清按该组的 10 个 `nodeId` 各自完成 5 次计算。

用 09-17 的真实数据复算：19 人的俱乐部 → 18 次普通攻击覆盖 4 个节点（其余 26 个打不动），13 人需要用宠物补成功额度；单人俱乐部 → 3 次普通攻击覆盖 1 个节点。

### 9.2 历史记录（第一版接线）

当前已完成第一版 club 级规划接线：

- [src/utils/batch/campChallengePlanner.js](../src/utils/batch/campChallengePlanner.js)：提供 `nodeId` 分组、club 快照合并、剩余击破需求、5/4/3 层可达性评估和最高层级选择。
- [src/utils/batch/tasksCampChallengeStrategy.js](../src/utils/batch/tasksCampChallengeStrategy.js)：按 `club.legionId` 聚合所选角色，读取真实目标战力，执行选中 club 的计划并保留 `nodeId`/`targetIsMirror`。
- [src/views/BatchDailyTasks.vue](../src/views/BatchDailyTasks.vue)：复用现有“营地挑战”按钮，支持智能规划和奖励领取模式，并接入自由模板 handler。
- 批量任务的通用 [ensureConnection](../src/views/BatchDailyTasks.vue) 已在账号切换建连前主动刷新短生命周期 Role Token；同一账号在 60 秒窗口内复用最近刷新结果，并通过 pending Promise 避免并发重复刷新。已有旧连接在 Token 刷新后会关闭并使用新 Token 重建。
- [test/campChallengePlanner.test.js](../test/campChallengePlanner.test.js)：覆盖 nodeId 分组、镜像重复 roleId、最高层级选择、手动进度和容量不足。
- [src/utils/xyzwWebSocket.js](../src/utils/xyzwWebSocket.js)：注册 `club_getinfo`、`club_gettargetteam`、`hero_calcpowerbyteam`、`club_attack`、`club_attackmonster`、`club_taskclaim` 和 `club_draw` 请求命令。
- 目标查询和真实攻击已按真实 UI 顺序补齐 `legion_getinfo -> saltroad_getwartype -> club_getinfo` 上下文；目标查询按 `targetId` 去重、普通节点优先、镜像复用，并对单目标失败做延迟重试和降级。

当前仍需修正或补齐：

- [src/utils/batch/tasksCampChallengeStrategy.js](../src/utils/batch/tasksCampChallengeStrategy.js)：当前对 `club_getinfo` 的 `attackMap` 为空，或今日记录字段不完整的 club 安全跳过自动战斗；存在历史日期但缺少今日日期时按今日零次处理。
- [src/views/BatchDailyTasks.vue](../src/views/BatchDailyTasks.vue)：批量账号切换前刷新 Token 的通用连接逻辑已接入；若连接超时或初始化失败，恢复流程会复用刚刷新 Token，不会立即重复刷新。
- `club_attackmonster` 仍未接入虚拟规划（智能模式只执行普通攻击计划）。作为替代，已按「与智能规划并列」的方式上线**简化版**：遍历选中角色 → `club_attackmonster` 最多 3 次 → 按 `taskClaimedMap` 过滤后领奖。入口是同一个「营地挑战」按钮下拉里的 `简版：宠物3次+领奖`。
- 任务奖励领取仍需读取 `taskClaimedMap` 后过滤已领取配置，`club_draw` 仍需根据服务端种火石状态决定次数。
- 需要一次真实低战力单 club 验收，再验证多 club 选中角色的隔离、攻击后重规划和失败释放。

详细实现 TODO 和项目整体状态仍维护在 [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md)。
