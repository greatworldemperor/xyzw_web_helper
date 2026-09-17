# 幻塔（EvoTower）助力码协议分析

> 抓包：`local-data/weird_tower/`
> · `get_code.jsonl` 取自己的助力码 ｜ `assist_code.jsonl` 用他人码助力成功
> · `share_code_full1.jsonl` / `share_code_full2.jsonl`（**失败**：发起方额度用尽 / 被助力方已满）
> 分析日期：2026-09-17 ~ 09-18 ｜ bridge `2026-09-16.1`
> 结论状态：**两条命令均已通过逐字节（明文）复现验证；成功与失败两种信封都已掌握，可直接实现**

---

## 0. 业务约束（master 确认，权威）

| 约束 | 含义 | 触发时的错误码 |
| --- | --- | --- |
| **每个角色只能被别的角色助力 3 次** | 收方上限：一个角色的助力码最多被 3 个角色使用 | `12200090` 对方已到最大助力人数 |
| **每个角色只能助力别的角色 1 次** | 发方上限：一个角色对整个活动只能发起 1 次助力 | `12200100` 本次活动已参与助力，无法助力其他伙伴 |

→ 自动助力本质是一个**带双侧容量约束的匹配问题**：每个角色出度 ≤ 1、入度 ≤ 3。

### 0.1 生命周期：三周一次的周活动，周期内不重置（master 确认）

- 助力是**周活动**，**三周才轮到一次**；**一次活动内不重置、不刷新**。
- 所以**不存在**「每天能助力几次 / 每天能被助力几次」的问题 —— 上表的 1 次 / 3 次都是**一次活动内的总量**。
- 推论：**黑名单不能按日失效**，必须按「活动周期」失效。用每日键会让同一活动内的失败记录反复过期，白撞 `12200100`。

### 0.2 活动周期的判定（项目里已有现成模型，且与抓包吻合）

项目**已经**为幻塔实现了这个三周轮换（`src/components/Tower/WeirdTowerStatus.vue`）：

```js
const start = new Date('2025-12-12T12:00:00'); // 锚点：黑市周开始
const weekDuration = 7 * 24 * 60 * 60 * 1000;
const cycleDuration = 3 * weekDuration;
const cyclePosition = (new Date() - start) % cycleDuration;
// [0,1)周 = 黑市周；[1,2)周 = 招募周；[2,3)周 = 宝箱周
// isWeirdTowerActivityOpen = 当前是「黑市周」
```

**用四份抓包验算，全部吻合**：抓包时刻（2026-09-17 23:26~23:58 北京）落在**黑市周**，
属第 **13** 个周期，窗口为 **2026-09-11 12:00 ~ 2026-09-18 12:00（北京）**。

窗口规律（每 3 周一轮，**游戏的「活动周」= 周五 12:00 开 → 周四 24:00 关**）：

| 周期 | 黑市周（活动周） | 战斗/助力开放 | 仅道具·领奖的 12 小时尾巴 |
| --- | --- | --- | --- |
| #12 | 08/21 12:00 → 08/27 24:00 | 同左 | 08/28 00:00 → 08/28 12:00 |
| **#13（抓包所在）** | **09/11 12:00 → 09/17 24:00** | **同左** | **09/18 00:00 → 09/18 12:00** |
| #14 | 10/02 12:00 → 10/08 24:00 | 同左 | 10/09 00:00 → 10/09 12:00 |
| #15 | 10/23 12:00 → 10/29 24:00 | 同左 | 10/30 00:00 → 10/30 12:00 |

### ⚠️ 关键：助力窗口 = 活动周（6.5 天），**不含**最后那 12 小时尾巴

master 补充（权威）：**黑市周结束后的第一个周五的前 12 小时**里，怪异塔**只能使用道具领取奖励**
（即批量任务里的「自动智能道具处理」「领取免费道具」），
**战斗和助力都已经进不去** —— 它们在**周四 24:00**（= 周五 00:00）就结束了。

也就是说：

```
周五 12:00 ─────── 活动周 6.5 天 ─────── 周五 00:00 ── 尾巴 12h ── 周五 12:00
          战斗 ✅  助力 ✅                战斗 ❌ 助力 ❌        下一个活动周开始
                                        道具 ✅ 领奖 ✅
```

由此得到两条实现要点：

1. **不能用项目的 `isWeirdTowerActivityOpen`（= 黑市周，到周五 12:00）来判断「助力能不能做」。**
   它按 `cyclePosition < weekDuration` 算，覆盖了那 12 小时尾巴，是个**超集**。
   助力可用窗口必须额外**排除掉尾部 12 小时**，即：
   `助力可用 = 当前是黑市周 且 (now - 周期起点) < 6.5 天`。
2. **窗口关闭期的失败要单独识别，不能记进额度黑名单** —— 那是「活动已关」而不是「额度用尽」，
   下个周期开头还得重新尝试。（`evotower_acceptsharebycode` 在关闭期的响应形态尚未抓到，见 §5。）


更妙的是服务端自己也给了同一个周期起点 —— `EvoTowerInfoResp.evotower` 的
`taskMap` / `taskClaimMap` 的键是**日期键**：

```
taskMap:      { "260911": {...}, "260912": {...}, "260913": {...},
                "260915": {...}, "260916": {...}, "260917": {...} }
taskClaimMap: { "260911": {1:1789134952, 2:1789134953, 3:1789134954}, ... }
```

最早键 `260911` = **2026-09-11**，正是上面算出的周期起点；最晚键 `260917` = 抓包当天。
（中间缺 `260914`——周一，当天没有塔任务。）`taskClaimMap[260911]` 的时间戳换算回来也落在 9/11 12:00 之后。

→ **周期键有两个可选来源**：
1. **服务端权威**：`min(keys(EvoTowerInfoResp.evotower.taskMap))`（上例 = `260911`）。不需本地推算，随周期自动滚动。
2. **本地推算**：复用 `getCurrentActivityWeek()` 的锚点算出的周期序号（上例 = 13）。

⚠️ `taskMap` 只有**一个周期**的样本（6 个日期键、值完全相同，像是静态模板 + 领取时间戳），
所以「最早键 = 当前周期起点」是**强证据但未跨周期验证**。建议实施时两个来源都用：
本地推算出的周期序号作缓存键，同时把 `taskMap` 最早键记进日志；等下一个黑市周抓一次抓包即可确认两者是否同步滚动。

⚠️ 注意别混淆项目里两个同名概念：
- `getTowerActId()`（`src/utils/towerActId.js`）是给**换皮闯关 `towers_*`** 用的**周** actId（格式 `YYMMDD1`，取所在周的周五），**不是**幻塔的活动 ID。
- 幻塔是 `evotower_*`，这些命令的请求体都是 `{}`，**不带 actId**，抓包里也没有任何 actId/activity 字段。


---

## 1. 结论摘要

幻塔的「助力」只有两条命令，且都极简：

| 用途 | 命令 | 请求 body | 成功响应 | 响应 body |
| --- | --- | --- | --- | --- |
| 取自己的助力码 | `evotower_getsharecode` | `{}` | `EvoTower_GetShareCodeResp` | `{ shareCode: "<32位hex>" }` |
| 用他人的助力码助力 | `evotower_acceptsharebycode` | `{ shareCode: "<32位hex>" }` | `EvoTower_AcceptShareByCodeResp` | `{}` （空） |

关键事实：

1. **助力码不可派生。** 已用 18 组候选（`md5(roleId)`、`md5(roleId+serverId)`、含 token/name/towerId 的组合等）验证，均不匹配。要拿码**必须实际调一次 `evotower_getsharecode`**。
2. **助力码在两次抓包中稳定不变**（同一角色 15:26 与 15:27 取到的都是 `11c48d50382ab70290ec5fcfc150d831`），与用户提供值一致。→ 可缓存。
3. **助力是「用自己的连接 + 别人的码」**。`acceptsharebycode` 由发起助力的角色发出，所以「A 助力 B」= 用 A 的连接调 `acceptsharebycode{ B的码 }`。
4. **成功没有 body 标志**，靠信封的 `code` 字段判成败（`code === 0 || undefined` 即成功）。抓包中该响应**不含 `code` 字段**。
5. **失败响应既没有 `cmd` 也没有 `body`**，只有 `{ seq, ack, time, resp, code, error }`。因此**不能走基于 cmd 的匹配路径**，必须靠 `resp`（= 请求的 `seq`）匹配序号。详见 §2.4。
6. **`evotower_getlegionjoinmembers` 只返回 `roleId → score`，不含助力码**。所以「批量助力全军团」无法一步到位，必须逐个角色取码。


---

## 2. 报文格式

### 2.1 取自己的助力码

请求（`assist_code.jsonl` / `get_code.jsonl`，明文 75 字节）：

```
{ ack: 55, body: {}, time: 1789658867676, seq: 56, cmd: "evotower_getsharecode" }
```

明文 hex（`get_code.jsonl` 那帧，字段序 `ack,body,time,seq,cmd`）：

```
0805050361636b01380000000504626f647907020800050474696d6502dc27fbafa00100000503736571013800000503636d64051565766f746f7765725f6765747368617265636f6465
```

响应 `EvoTower_GetShareCodeResp`（明文 135 字节，body 47 字节）：

```
{ seq:57, ack:55, time:1789658866098, resp:56, cmd:"EvoTower_GetShareCodeResp",
  body: { shareCode: "11c48d50382ab70290ec5fcfc150d831" } }
```

内层 body 根 tag = `0x08`（Object，1 个字段），`shareCode` 的 key 与 value 都是 tag `0x05`（String，全新字符串，无引用表复用）。

### 2.2 用他人的助力码助力

请求（`assist_code.jsonl`，明文 125 字节）：

```
{ ack: 0, body: { shareCode: "6d2071fc600aa528ddbadfb5541fc1b5" },
  time: 1789658873188, seq: 57, cmd: "evotower_acceptsharebycode" }
```

明文 hex：

```
0805050361636b01000000000504626f6479072f080105097368617265436f646505203664323037316663363030616135323864646261646662353534316663316235050474696d6502643dfbafa0010000050373657101390000000503636d64051a65766f746f7765725f61636365707473686172656279636f6465
```

内层 body（47 字节）根 tag = `0x08`，1 个字段：`shareCode`(tag5) → 32 字符 hex 字符串(tag5)。

响应 `EvoTower_AcceptShareByCodeResp`（明文 95 字节，body 仅 2 字节）：

```
{ seq:58, ack:0, time:1789658872202, resp:57, cmd:"EvoTower_AcceptShareByCodeResp", body:{} }
```

### 2.3 相关状态命令（分析用，非必需）

- `evotower_getshareinfo` → `EvoTower_GetShareInfoResp`
  ```
  { shareTask: {
      helpRoleIdMap: {},      // 两次抓包均为空
      inviteRoleIdMap: {},    // 两次抓包均为空
      shareTaskMap: { "1":{typ:1,progress:0,claimedProgress:0},
                      "2":{typ:2,progress:0,claimedProgress:0},
                      "3":{typ:3,progress:0,claimedProgress:0} } } }
  ```
  `typ` 1/2/3 = 三个分享任务。抓包中 `progress` 全 0 —— 但注意 shareinfo 都是在**助力之前**查的，且助力后再没查过，所以**助力对进度的影响本次抓包无法判定**。
- `evotower_getlegionjoinmembers` → `EvoTower_GetLegionJoinMembersResp`：`{ memberScores: { "<roleId>": score } }`，29 个成员，**无助力码**。

---

### 2.4 失败响应信封（**没有 cmd、没有 body**）

`share_code_full1.jsonl` / `share_code_full2.jsonl` 各抓到一次失败。信封形状与成功响应**完全不同**：

```
{ seq:Int, ack:Int, time:Long, resp:Int, code:Int, error:String }
```

- **无 `cmd`** → 基于 cmd 的响应匹配路径（`_handlePromiseResponse` 里的向后兼容分支）第一条判断就是 `if (!cmd) return;`，**根本接不住**。
- **无 `body`** → 不能指望 body 里有失败标志。
- `resp` = 请求的 `seq`，所以**靠 `resp` 匹配序号的主路径可以正常命中**（`promises[packet.resp]`），随后按 `code !== 0` 拒绝。
- `error` 是服务端自带的中文文案，**是唯一能区分两种失败的信息**（除了 code 本身）。

实测两帧（字段逐字节取自抓包，明文分别为 122B / 98B）：

| 抓包 | 角色 | 请求 seq | `code` | `error` | 场景 |
| --- | --- | --- | --- | --- | --- |
| `share_code_full1.jsonl` | 海王 666543015 @26501服 | 68 | `12200100` | 本次活动已参与助力，无法助力其他伙伴 | 该角色**已助力过别人**，再助力别人 → 发方额度 1 次已用尽 |
| `share_code_full2.jsonl` | 38号战士 139075590 @9738服 | 51 | `12200090` | 对方已到最大助力人数 | 该角色没助力过，但**目标已被 3 次助力** |

明文 hex 参考：

```
# full1 失败响应（12200100）
080605037365710145000000050361636b0100000000050474696d650250f014b0a001000005047265737001440000000504636f646501a428ba0005056572726f720536e69cace6aca1e6b4bbe58aa8e5b7b2e58f82e4b88ee58aa9e58a9befbc8ce697a0e6b395e58aa9e58a9be585b6e4bb96e4bc99e4bcb4

# full2 失败响应（12200090）
080605037365710133000000050361636b0132000000050474696d65027c1117b0a001000005047265737001330000000504636f6465019a28ba0005056572726f72051ee5afb9e696b9e5b7b2e588b0e69c80e5a4a7e58aa9e58a9be4babae695b0
```

`code` 是 tag 1（Int），`error` 是 tag 5（String）。两个码的字节差：`a4 28 ba 00` = 12200100、`9a 28 ba 00` = 12200090（小端 Int32）。

### 2.5 两种失败的处理策略（自动助力的核心）

| code | 含义 | 应该是**终止型**还是**可重试** |
| --- | --- | --- |
| `12200100` | 这个发起角色已经用掉唯一一次助力机会 | **该角色在本活动内终止**，不能再派它助力任何人；换别的角色 |
| `12200090` | 这个目标已被助力满 3 次 | **该码在本活动内终止**，换目标码；持有该码的角色已达标 |

两个码都不会自愈，重试无意义。→ 自动助力应把「已助力过的角色」和「已满 3 次的目标」各自记入本地黑名单，避免重复撞（与营地挑战里 `campTargetPowerCache` 被拒一次即止的做法一致）。

⚠️ **前置探测目前不可行**：`evotower_getshareinfo` 的 `helpRoleIdMap` / `inviteRoleIdMap` 在**未助力过**的角色上都是空 `{}`（full2 的 38号战士助力前查过，全空），但**没有「已助力过别人」或「已被助力满 3 次」的角色查询 shareinfo 的抓包**，所以无法判断这两个 map 是否能提前暴露额度状态。见 §5 待补。

---

## 3. 复现验证（实现前闸门）

### 3.1 参考解码器（skill `xyzw-protocol-re`）

```
node verify_roundtrip.mjs local-data/weird_tower/get_code.jsonl          --dir send
  → 精确 17 / 仅tag 0 / 失败 0 / 未解密 7（明文心跳，预期）

node verify_roundtrip.mjs local-data/weird_tower/assist_code.jsonl       --dir send
  → 精确 15 / 仅tag 0 / 失败 0 / 未解密 1

node verify_roundtrip.mjs local-data/weird_tower/share_code_full1.jsonl  --dir send
  → 精确 2 / 失败 0 / 未解密 1（1 字节明文心跳）

node verify_roundtrip.mjs local-data/weird_tower/share_code_full2.jsonl  --dir send
  → 精确 5 / 失败 0
```
其中 `evotower_getsharecode`、`evotower_acceptsharebycode` 在四份抓包中**全部精确**。
（`--dir send` 只验请求方向；失败响应是 RECV，其信封结构由 §2.4 的探针逐字段确认。）

### 3.2 项目自身编码器（`src/utils/bonProtocol.js`）

`local-data/weird_tower/_verify_project_encoder.mjs` 直接用项目的 `bon.encode()` 重建：

```
[PASS] evotower_getsharecode（抓包字段序 ack,body,time,seq,cmd）      明文 75B
[PASS] evotower_acceptsharebycode（抓包字段序）                       明文 125B
[FAIL] 两条用项目 register() 字段序（cmd,ack,seq,time,body）          明文 75B/125B
       首个差异 @byte 4 —— 仅 key 顺序不同，长度与内容完全一致
```

> ⚠️ **重要认知修正**：`x` 方案密文头 4 字节是 `Math.random()` 随机种子（见 `bonProtocol.js` 的 `x.encrypt`），**密文永远不可能逐字节复现**。所有「逐字节复现」结论都必须建立在**解密后的明文**上，`verifyRoundTrip` 内部也是这么做的。

字段序差异不影响可用性：BON tag 8 是按键取值的 map，服务端按 key 解析；项目现有 100+ 命令一直用 `cmd,ack,seq,time,body` 顺序发送且工作正常。所以**不需要新增任何编码/构造逻辑**。

---

## 4. 落地方案（最小改动）

在 `src/utils/xyzwWebSocket.js` 的 `registerDefaultCommands()` 里加两行：

```js
.register("evotower_getsharecode")                                  // body {}
.register("evotower_acceptsharebycode", { shareCode: "" })          // 发送时传 params 覆盖
```

在 `_handlePromiseResponse` 的 `responseToCommandMap` 里补映射（key 为响应命令的小写）：

```js
evotower_getsharecoderesp: "evotower_getsharecode",
evotower_acceptsharebycoderesp: "evotower_acceptsharebycode",
```

调用（沿用现有 Promise 发送）：

```js
const { shareCode } = await ws.sendWithPromise("evotower_getsharecode", {});
await ws.sendWithPromise("evotower_acceptsharebycode", { shareCode });
```

> 注：这两条响应都带 `resp` 字段，主匹配路径（`promises[packet.resp]`）本来就能命中；补 `responseToCommandMap` 是为了让大小写兜底路径也正确（否则兜底会拿 `evotower_getsharecoderesp` 去比对 `evotower_getsharecode`，匹配不上）。成败判定看信封 `code`（`code === 0 || undefined` 为成功）。

### 4.1 错误处理（已落地）

失败响应没有 `cmd`，且服务端文案只在 `error` 字段里，而原来的拒绝路径只读 `errorCodeMap[code] || packet.hint` → 这两种失败会退化成「未知错误」，把「已助力过」和「对方已满」混成同一个字符串，**自动助力无法据此分流**。

已做的最小修复（2026-09-18）：

- 新增 `src/utils/protocolError.js`：把错误码表与错误信封解析抽成纯模块（`serverErrorCodeMap` / `describeServerError` / `createServerError`）。
  - 抽出去的原因：`xyzwWebSocket.js` 依赖 `@/` 别名，node 测试无法导入，而这两个码需要被回归测试锁住。
  - 文案优先级：**本地错误码表 → 服务端 `error` → `hint` → 「未知错误」**。本地表优先是为了让既有文案不受服务端版本变动影响（如 `200160` 的「模块未开启」被 `isModuleUnavailableError` 依赖）。
  - `createServerError` 额外把 `code` / `hint` / `error` 挂到错误对象上，配合 `helperTaskRunner.getErrorDetails` 做结构化判定。
- `errorCodeMap` 增加 `12200090` / `12200100`（共 34 条）；`xyzwWebSocket.js` 两处拒绝分支改用 `createServerError(packet)`。
- 新增回归 `test/protocolError.test.js`（7 例，含两条抓包真实字段值）。

调用侧判断建议**直接看 `error.code`**，不要匹配文案：

```js
try {
  await ws.sendWithPromise("evotower_acceptsharebycode", { shareCode });
} catch (err) {
  if (err.code === 12200100) return "SELF_EXHAUSTED";  // 换发起角色
  if (err.code === 12200090) return "TARGET_FULL";     // 换目标码
  throw err;
}
```

---

## 5. 未知项 / 需补抓包

§0 的两条业务约束、活动生命周期（三周一次、周期内不重置）与 §2.4 的失败形态**已确认**。剩余待补：

| # | 未知项 | 为什么重要 | 怎么补 |
| --- | --- | --- | --- |
| 1 | **`shareTask` 能否提前暴露额度状态** | 决定自动助力是「先查后打」还是「打了再看错误码」。`helpRoleIdMap`/`inviteRoleIdMap` 在未助力过的角色上全空，但**没有已助力 / 已满角色的 shareinfo 抓包** | 让「已助力过别人」的角色，以及「已被助力 3 次」的角色，各查一次 `evotower_getshareinfo` |
| 2 | **自己的码被别人助力后 `shareTask` 怎么变** | 需要它来判断「谁帮过我」、自动领奖 | 助力成功后立刻再查 `evotower_getshareinfo` |
| 3 | **周期键是否随周期滚动**（§0.2） | 决定黑名单何时清空。目前只有 1 个周期的样本 | 下一个黑市周（约 2026-10-02 起）再抓一次，比对 `taskMap` 最早键 |
| 4 | **能否跨服/跨军团助力** | 决定小号池怎么组（4 份抓包已跨 9724/9738/26501 三服） | 用异服角色的码试 |
| 5 | **`shareTaskMap` 的 typ1/2/3 具体是什么任务** | 决定进度目标与领奖时机 | 助力后对比 `progress`/`claimedProgress` |
| 6 | **助力奖励怎么领** —— `evotower_claimreward` 的请求参数未抓到 | 决定「助力后能否自动领奖」，否则只能助力不能拿奖 | 抓一次点「领取」按钮：游戏命令表里有 `evotower_claimreward`（见 `tools/7.7.12.runtime-trace.json` 字符串表），但抓包里没出现过，参数未知 |
| 7 | **窗口关闭期助力会报什么错** | 用于区分「活动已关」与「额度用尽」，避免把前者记进黑名单 | 在尾巴期（周五 00:00~12:00）或非黑市周试着助力一次 |

> 抓包时建议：助力**之前**查一次 `evotower_getshareinfo`，助力**之后**立刻再查一次 —— 这一组对照能一次性回答 1、2、5；
> 顺带把 `EvoTowerInfoResp` 一并留下，就能同时观察第 3 条。
> 第 6 条需要**点一次「领取」按钮**（4 份抓包里都没有领取动作——当时任务进度都是 0，无奖可领）。

---

## 6. 已确定的实现方案（2026-09-18 与 master 讨论定稿）

| 决策项 | 定论 |
| --- | --- |
| 集成形态 | **独立卡片**（不是塞进批量任务列表） |
| 助力码来源 | **只用选中角色池内部的码**，不支持手填外部码 |
| 领奖 | **本期不做**，只做助力。领奖命令 `evotower_claimreward` 参数未知，且本期窗口已过（下次黑市周 10/02 12:00 起），需补抓包后再做 |
| 分配算法 | **待 master 提供说明**（他明确说过「不是一对一的」，比较复杂） |
| 缓存/黑名单键 | **周期键**，不是日期键（见 §0.1） |

### 6.1 已完成：命令注册与验证（与算法无关的先决步骤）

`src/utils/xyzwWebSocket.js`：

```js
// registerDefaultCommands() 的「怪异咸将塔」段
.register("evotower_getshareinfo")
.register("evotower_getsharecode")
.register("evotower_acceptsharebycode", { shareCode: "" })

// responseToCommandMap（响应命令 = PascalCase 响应名小写化）
evotower_getshareinforesp: "evotower_getshareinfo",
evotower_getsharecoderesp: "evotower_getsharecode",
evotower_acceptsharebycoderesp: "evotower_acceptsharebycode",
```

验证：`local-data/weird_tower/_verify_share_commands.mjs` —— 用上述默认 body 经项目 `bon.encode()` 重新编码，
与四份抓包的内层 body **逐字节比对 11/11 全部 PASS**（含 3 条 `acceptsharebycode` 的 47B body）。

### 6.2 实现时必须遵守的领域约束（供算法设计参考）

1. **窗口**：助力仅在本周期「活动周」内可用，即黑市周起点 + **6.5 天**之前（周四 24:00 截止），
   **不含**最后 12 小时尾巴期；`isWeirdTowerActivityOpen` 是超集，不能直接用。
2. **额度**：每角色**发起 1 次**、每角色**接收 3 次**，均为**周期内总量**，不重置。
3. **数学上限**：池内 N 个角色 → 最多 N 次助力 → **最多只让 ⌊N/3⌋ 个角色被助力满 3 次**。
   「让所有号都满 3 次」在池内不可能，必须选出优先受益者（这正是算法要解决的）。
4. **失败即终止**：`12200100` → 该角色本周期不再派发；`12200090` → 该目标码本周期不再尝试。
5. **助力方向**：用**发起方**的连接发**目标方**的码；同一角色不能给自己助力。
6. **码可缓存**：同一周期内稳定不变（已两次采样验证）。

---

## 7. 附：分析脚本

| 脚本 | 用途 |
| --- | --- |
| `local-data/weird_tower/_inspect_sharecode.mjs` | dump 目标帧 rawHex + 信封字段 + 嵌套 body 的逐字段 tag（判断 Map/Object、字符串引用） |
| `local-data/weird_tower/_inspect_error_frames.mjs` | 同上，专看**失败信封**：逐字段 tag/类型 + 定位对应请求 + 断言「无 cmd / 无 body」 |
| `local-data/weird_tower/_verify_project_encoder.mjs` | 用项目自身 `bon.encode()` 复现明文并逐字节比对 |
| `local-data/weird_tower/_verify_share_commands.mjs` | 校验注册的默认 body 与抓包**内层 body** 逐字节一致（当前 11/11 PASS） |

四份抓包（均为 bridge `2026-09-16.1`，passive-capture）：

| 文件 | 角色 | 结果 |
| --- | --- | --- |
| `get_code.jsonl` | 世界国皇帝 130301444 @9724服 | 取码成功 |
| `assist_code.jsonl` | 同上 | 助力成功（用 `6d2071fc…`） |
| `share_code_full1.jsonl` | 海王 666543015 @26501服 | 失败 `12200100` |
| `share_code_full2.jsonl` | 38号战士 139075590 @9738服 | 失败 `12200090` |

> 注意 master 给的路径是 `.json`，磁盘上实际是 `.jsonl`。
> 自写 ESM 脚本 import skill/项目模块时，Windows 绝对路径必须写成 `file:///C:/...`（直接写 `C:/...` 会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`）。

跑法（项目 node ≥ 22）：

```powershell
node local-data/weird_tower/_verify_project_encoder.mjs
node local-data/weird_tower/_inspect_error_frames.mjs
```
