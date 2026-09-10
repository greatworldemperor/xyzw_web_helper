# 营地挑战协议与节点模型研究

- 状态：以当前用户规则和真实 WSS 抓包为依据
- 最近更新：2026-09-10
- 相关实现：[src/utils/batch/tasksCampChallenge.js](../src/utils/batch/tasksCampChallenge.js)
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

新日志中 `oppoMap` 的键出现过 `2`、`3`、`4`。它表示敌方俱乐部或来源分组，不是第一组、第二组、第三组的位置组。

`defenders` 是稀疏集合：

- 一个 `oppoMap.<key>` 可以包含不同十格位置区间的节点。
- 并非每个 `nodeId` 都会在同一个 `oppoMap` 中出现。
- `defenders` 的对象键才是全局 `nodeId`，不能把 `oppoMap` 的键当作区域编号。
- 目标遍历应在所有 `oppoMap` 分组的 `defenders` 中收集节点，再按 `nodeId` 建立索引。

因此，“三组十格位置”与“`oppoMap` 来源分组”是两个不同维度，代码中不能复用同一个 `groupId` 概念表示它们。

### 2.3 `nodeId` 是目标身份，`roleId` 只是目标角色

镜像复制会导致多个节点拥有同一个 `roleId`。新日志中观察到：

- 非镜像 `nodeId=6` 与镜像 `nodeId=20` 都使用 `roleId=705342925`。
- 非镜像 `nodeId=11` 与镜像 `nodeId=27` 都使用 `roleId=710072859`。

所以：

- 目标缓存、去重、计数和完成状态必须以 `nodeId` 为主键。
- `targetId` 在攻击请求中对应目标角色的 `roleId`，不能替代 `nodeId`。
- 每个节点必须单独保存 `nodeId`、`targetId/roleId`、`mirror`、`defeated`、`challengeCnt` 和 `failCnt`。
- 攻击请求必须透传该节点的 `targetIsMirror`，不能通过 `roleId` 推断或合并镜像节点。

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
| `hero_calcpowerbyteam` | 尚未在本批摘要中确认 | 攻击前计算己方队伍战力 | 观察到发送，字段仍需补抓 |
| `club_attack` | `Club_AttackResp` | 普通敌人攻击 | 已确认 |
| `club_attackmonster` | `Club_AttackMonsterResp` | 宠物攻击 | 本批未出现，待验证 |
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

由于节点集合可能是稀疏的，`defenders` 中缺少某个键不能直接解释为该节点不存在或已完成，需要结合完整的 30 节点模型和服务端返回状态判断。

### 4.2 `club_gettargetteam`

请求只需要目标角色 ID：

```js
{ targetId: defender.roleId }
```

响应包含：

```text
body.roleBattleTeam.role.roleId
body.roleBattleTeam.role.power
body.roleBattleTeam.battleTeam
```

目标战力可从 `roleBattleTeam.role.power` 读取。`battleTeam` 是目标阵容详情，不能把它当成攻击请求中的己方 `teamSetParams.battleTeam`。

### 4.3 `club_attack`

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

普通攻击和宠物攻击共用这两个计数。当前尚未把 `battleData` 中的某个字段单独认定为所有场景通用的胜负判定；`battleData` 常见顶层键包括 `id`、`mode`、`randomSeed`、`version`、`maxRound`、`leftTeam`、`rightTeam` 和 `result`，胜利判定仍需覆盖宠物攻击后再最终确认。

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
- 普通玩家挑战和宠物挑战共享这 3 次成功额度。
- 失败会消耗每日 10 次发起额度，但不消耗 3 次成功额度。
- 每个敌人总共可被击败 5 次；此前业务模型将其分为普通、困难、炼狱阶段，阶段和奖励领取需要按区域分别汇总。
- `confId=1` 已确认对应累计战斗 3 次，且不论胜负。
- 每个区域存在普通、困难、炼狱三档全清奖励；困难依赖普通全清，炼狱依赖困难全清。
- A 类任务进度奖励和 B 类种火石抽奖奖励是两套独立逻辑。

实现计数时，应优先读取服务端返回的：

```text
attackCnt
aSuccessCnt
```

其中 `aSuccessCnt` 是共享成功次数，不能分别为普通攻击和宠物攻击维护两个成功计数器。

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
- 不要过滤 `mirror=true` 的节点。
- 不要把失败次数当成成功次数。
- 不要把普通挑战和宠物挑战的成功额度分开计算。
- 目前三组 `confId` 均已有真实抓包确认：第一组 `5/6/7`、第二组 `8/9/10`、第三组 `11/12/13`。

## 7. 仍待验证

1. `club_attackmonster` 的完整请求体、响应体，以及它是否完全复用 `attackCnt/aSuccessCnt`。
2. `hero_calcpowerbyteam` 的请求和响应字段，以及发送前是否为强制步骤。
3. `battleData.result.accept.ext.curHP === 0` 是否同时适用于普通攻击和宠物攻击的胜利判断。
4. 每日 10 次和每日 3 次限制触发时的服务端错误码、`code` 和 `hint`。
5. 三组配置 ID 在更多账号上的稳定性，以及第一组全清后只出现一次 `club_draw` 的种火石/抽奖前置状态。
6. `challengeCnt` 和 `failCnt` 在重复攻击同一节点、跨难度阶段时的服务端递增语义。
7. 种火石对应的物品 ID、当前数量字段和 `club_draw` 的服务端前置条件。

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
  -> 按所属 club 分组
  -> 获取该 club 的实时 club_getinfo
  -> 获取该 club 仍有需求节点的真实目标阵容和战力
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

当前已完成第一版 club 级规划接线：

- [src/utils/batch/campChallengePlanner.js](../src/utils/batch/campChallengePlanner.js)：提供 `nodeId` 分组、club 快照合并、剩余击破需求、5/4/3 层可达性评估和最高层级选择。
- [src/utils/batch/tasksCampChallengeStrategy.js](../src/utils/batch/tasksCampChallengeStrategy.js)：按 `club.legionId` 聚合所选角色，读取真实目标战力，执行选中 club 的计划并保留 `nodeId`/`targetIsMirror`。
- [src/views/BatchDailyTasks.vue](../src/views/BatchDailyTasks.vue)：复用现有“营地挑战”按钮，支持智能规划和奖励领取模式，并接入自由模板 handler。
- [test/campChallengePlanner.test.js](../test/campChallengePlanner.test.js)：覆盖 nodeId 分组、镜像重复 roleId、最高层级选择、手动进度和容量不足。
- [src/utils/xyzwWebSocket.js](../src/utils/xyzwWebSocket.js)：注册 `club_getinfo`、`club_gettargetteam`、`hero_calcpowerbyteam`、`club_attack`、`club_attackmonster`、`club_taskclaim` 和 `club_draw` 请求命令。

当前仍需修正或补齐：

- [src/utils/batch/tasksCampChallengeStrategy.js](../src/utils/batch/tasksCampChallengeStrategy.js)：当前对 `club_getinfo` 未返回今日 `siege.attackMap[YYMMDD]` 的 club 安全跳过自动战斗；需要补到可靠的每日个人计数来源后，才能处理已有手动攻击的角色而不冒险超出 10 次/3 次上限。
- `club_attackmonster` 尚未接入虚拟规划，当前按钮的智能模式只执行普通攻击计划；宠物攻击需要真实抓包后加入共享成功容量。
- 任务奖励领取仍需读取 `taskClaimedMap` 后过滤已领取配置，`club_draw` 仍需根据服务端种火石状态决定次数。
- 需要一次真实低战力单 club 验收，再验证多 club 选中角色的隔离、攻击后重规划和失败释放。

详细实现 TODO 和项目整体状态仍维护在 [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md)。
