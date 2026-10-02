# 怪异塔 · 俱乐部 legion buff 协议分析

> 抓包：`local-data/weird_tower/evotower_get_buff.jsonl`（2026-10-02 22:49，38 帧，`30号战士-0-139063046` @ 9730 服）
> 解码脚本：`local-data/weird_tower/_decode_get_buff.mjs`（自实现通用 BON 解码 + `getEnc(scheme).decrypt`）
>角色：`436742908` / momo302 / 战力 631,631,695 / 俱乐部「第二批」`legionId=7203672`

---

## 一、结论速览

| 问题 | 答案 |
|---|---|
| buff 由什么决定 | 本俱乐部**本期已参与怪异塔战斗的角色数量**（`memberScores` 的 key 数量） |
| 档位| 4 档，阈值推断为 10 / 15 / 20 / 25 人 |
| 领取命令 | `evotower_claimlegionprivilege`，**空 body**，**一次只领一档**，需连点 N 次 |
| 已解锁档位怎么查 | 顶层 `legionPrivilege` 字段（`{1:1, 2:1, 3:1}`）= **全部已解锁档位**，不是本次结果 |
| 本次结果怎么看 | 嵌套 `body.evoTower.legionPrivilege`（`{2:1}` 表示本次领到第2 档） |
| 本次实际领取 | 21 人 → 解锁 1/2/3 档，**第 4 档（25人）未达** |
| 项目现状 |❌ `evotower_claimlegionprivilege` **未注册**、未接线 |

---

## 二、抓包时序（去重后的关键帧）

```
seq 43  evotower_getinfo            → EvoTowerInfoResp   legionPrivilege = {}          ← 领取前：空
seq 44  arena_getarearank           （无关）
seq 45  tower_getrank               （无关）
seq 46  boss_getrank                （无关）
seq 47  evotower_getinfo            → EvoTowerInfoResp   legionPrivilege = {}          ← 再次确认：领取前空
seq 48  discount_getdiscountinfo    （无关）
seq 49  evotower_getlegionjoinmembers → GetLegionJoinMembersResp  memberScores = 21 人
--- 点「领取 buff」按钮 ---
seq 50  evotower_claimlegionprivilege → ClaimLegionPrivilegeResp  evoTower: {1:1}
seq 51  evotower_getlegionjoinmembers → 21 人（不变）
seq 52  evotower_claimlegionprivilege → ClaimLegionPrivilegeResp  evoTower: {2:1}
seq 53  evotower_claimlegionprivilege → ClaimLegionPrivilegeResp  evoTower: {3:1}
seq 54  evotower_getlegionjoinmembers → 21 人（不变）
```

**master 手动点了 3 次领取按钮**，对应 3 档 buff。第 4 档因为人数不够，UI 上应该是灰的/点不动。

---

## 三、协议结构详解

### 3.1 `evotower_getlegionjoinmembers` → 参与人数的唯一数据源

请求 body **空** `{}`。

响应：
```json
{
  "memberScores": {
    "135107854": 319,
    "139056393": 9,
    "139057210": 9,
    "139063046": 9,
    "139066197": 9,
    "139067888": 9,
    "139069314": 9,
    "436730758": 9,
    "436731190": 9,
    "436733214": 9,
    "436733582": 9,
    "436741450": 9,
    "436741844": 9,
    "436742288": 9,
    "436742908": 9,
    "436743574": 9,
    "436744052": 9,
    "436744943": 9,
    "436745723": 9,
    "616736676": 1,
    "703935668": 176
  }
}
```

- **key = roleId，value = 该角色最高层数**（`towerId` 口径，`towerId=9` → 第 1 章 10 层）。
- **共 21 个 key → 21 人本期参与过战斗**。
- 三次调用（seq 49/51/54）返回**完全一致**，说明这是**稳定状态快照**，不是增量。
- 注意 `616736676: 1` —— 只打了第 1 层，但**只要 key 存在就算 1 个人**。所以门槛只数人头，不看层数高低。

>⚠️ 现有实现 `ClubWeirdTowerInfo.vue` 只把 `memberScores` 用来显示列表，**没有用它算档位**。这是可以零成本复用的现成数据。

### 3.2 `evotower_claimlegionprivilege` → 领取

请求 body **空** `{}`（无taskId / 无档位参数，**服务端决定给你哪一档**）。

响应（三次结构完全相同，只`evoTower.legionPrivilege` 变）：
```json
{
  "legionPrivilege": { "1": 1, "2": 1, "3": 1 },
  "evoTower": {
    "legionPrivilege": { "2": 1 }
  }
}
```

| 字段 | 语义 |
|---|---|
| 顶层 `legionPrivilege` | **俱乐部已解锁的全部档位集合**。三次调用都是 `{1,2,3}` |
| `evoTower.legionPrivilege` | **本次新领到的档位**。seq50=`{1:1}`、seq52=`{2:1}`、seq53=`{3:1}` |

**这是最容易踩的坑**：顶层 `legionPrivilege` 不是「本次结果」。如果拿它做增量判断，会误判成「第一次就全领完了」。

档位编号 = 从 1 开始的档位序号，与「10/15/20/25 人」的映射关系**服务端内部维护**，协议里不下发阈值。UI 阈值文案只能从游戏客户端拿。

### 3.3 `evotower_getinfo` → 领取前后不变

两次 `getinfo`（seq 43 / 47）都在领取前，`legionPrivilege: {}` 都为空。

`EvoTowerInfoResp` 里另一个相关字段：
```json
"bindLegionId": 7203672
```
**俱乐部归属已绑定**（角色 `436742908` 已完成过一次战斗）。这印证了 master 的规则 0/1/2：
- 未绑定时 `bindLegionId = 0`，且 `getlegionjoinmembers` 返回空 →拿不到 buff。
- 首次战斗后绑定 → 才能查名单、领buff。

---

## 四、档位阈值推断

| 档位 | 人数阈值 | 21 人是否达成 | 抓包证据 |
|---|---|---|---|
| 1 | 10 | ✅ | seq 50 领到 `{1:1}` |
| 2 | 15 | ✅ | seq 52 领到 `{2:1}` |
| 3 | 20 | ✅ | seq 53 领到 `{3:1}` |
| 4 | 25 | ❌ | 三次响应顶层 `legionPrivilege` 始终无 `4` |

阈值来自 master 的活动规则说明（10/15/20/25），抓包侧只能验证到「21 人恰好命中 1/2/3 三档、未命中第 4 档」——**协议本身不下发阈值**，实现时不要硬编码猜测逻辑，要以游戏 UI 为准。

---

## 五、项目缺口

| 项 | 状态 |
|---|---|
| `evotower_getlegionjoinmembers` | ✅ 已注册（`xyzwWebSocket.js:258`），已用于 `ClubWeirdTowerInfo.vue` |
| `evotower_claimlegionprivilege` | ❌ **未注册**（`xyzwWebSocket.js` 无此条，响应映射表也没有） |
| 档位 UI | ❌ 无。`ClubWeirdTowerInfo.vue` 只渲染成员列表，没有 buff 档位区|
| 自动领取 | ❌ 无。需连点 N 次（N = 已解锁但未领的档位数） |

### 落地建议（若要实现）

1. **注册命令**（`src/utils/xyzwWebSocket.js`）：
   ```js
   .register("evotower_claimlegionprivilege")   // body: {} 空
   ```
   响应映射表加`evotower_claimlegionprivilegeresp: "evotower_claimlegionprivilege"`。

2. **读档位**：`evotower_getinfo` → `evoTower.legionPrivilege` 给出已解锁档位（注意：**领完之后这里才会有值**，领取前是 `{}`）。判断「有无未领档位」不能只看这个字段，要配合 `memberScores` 人数算。

3. **人数 → 档位映射**：在 `ClubWeirdTowerInfo.vue` 里用 `Object.keys(memberScores).length`算出档位进度，阈值 10/15/20/25 硬编码在配置里（**标注来源：活动规则，非协议**）。

4. **自动领取循环**：调N 次直到 `body.evoTower.legionPrivilege` 为空 / 返回空对象。注意别用顶层 `legionPrivilege` 判断。

5. **边界**：`bindLegionId === 0` 时（首次战斗前）不可领取，直接跳过。

---

## 六、落地实现（2026-10-02 已完成）

### 文件清单

| 文件 | 作用 |
|---|---|
| `src/utils/weirdTowerLegionBuff.js` | **纯逻辑**（无IO）：阈值表 / 人数→档位 / 顶层vs嵌套解析 / 状态构建 / 汇总 / 领取前置校验 |
| `src/components/Club/ClubWeirdTowerLegionBuff.vue` | UI 组件：四档卡片 + 进度条 + 一键领取（连点 N 次） |
| `src/components/Club/ClubWeirdTowerInfo.vue` | **接线**：新增 `rawMemberScores` 状态，模板挂 buff 组件并传 `memberScores`（避免重复请求） |
| `src/utils/xyzwWebSocket.js` | 注册 `evotower_claimlegionprivilege`（L277）+ 响应映射（L1185） |
| `test/weirdTowerLegionBuff.test.js` | **30 例**单元测试（含 21人/边界/非法入参/口径反证） |
| `tools/weirdtower/legion-buff-replay.mjs` | **真实抓包离线回放21 例**（随 git 走） |

### 关键实现决策

**1. 人数复用，不重复请求**
`ClubWeirdTowerInfo.vue` 已经拉了 `memberScores`，把它存进新增的 `rawMemberScores` 传给 buff 组件。
组件优先用 props，只在 props 为空时才自己发 `getlegionjoinmembers`。

**2. 领取循环用嵌套字段判断终止**
```js
for (let i = 0; i < maxRounds; i++) {
  const resp = await send(CMD_CLAIM_LEGION_PRIVILEGE, {});
  const claimedNow = pickClaimedThisTime(resp);       // 读 body.evoTower.legionPrivilege
  if (isEmptyClaim(resp) || claimedNow.length === 0) break;
  gotTiers.push(...claimedNow);
}
```
`maxRounds = min(4, pendingCount + 1)`，双保险防死循环。

**3. 四档全部实做**
阈值 `[0, 10, 15, 20, 25]` 硬编码在 `weirdTowerLegionBuff.js`，UI 固定渲染 4 张卡片。
第 4 档（25 人）在 21 人的抓包里没走到，但逻辑与前三档完全同构，**由 `test` + `replay` 的 25 人边界用例覆盖**。

**4. 未绑定/无人参与 双重gate**
`canClaim({ bindLegionId, participantCount })` 返回 `{ok, reason}`，UI 用 `n-alert` 显示原因，按钮置灰。

### 验证结果

| 项 | 结果 |
|---|---|
| `node --test test/weirdTowerLegionBuff.test.js` |✅ **30/30** |
| `node tools/weirdtower/legion-buff-replay.mjs` | ✅ **21/21**（真实抓包字节） |
| 既有分享测试 `weirdTowerShare{Plan,Window}` | ✅ 29/29 无回归 |
| Vue SFC 编译（2 个组件） | ✅ 通过 |
| `vite build` |✅ 5204 modules → built in 1m23s |
| bundle 冒烟 | ✅ `[0,10,15,20,25]` / `claimable` / 命令名 / 组件文案 全部命中 |

### 🔴 回放脚本抓到的自身 bug（已修）

第一版`tools/weirdtower/legion-buff-replay.mjs` 把抓包**信封**当成了**业务 body**：
```js
// ✗ 错：envelope = { seq, ack, time, resp, cmd, body:{...} }
const memberScores = frames[0]?.body?.memberScores;      // → undefined
// ✓ 对
const memberScores = frames[0]?.body?.memberScores;      // frames[i].body 已是业务 body
```
21 例里14 例红。**教训**：抓包信封有两层（`envelope.body` 才是业务字段），
写回放断言前先`console.log` 一次真实结构，别照着 `decoded` 字段名想当然。

---

## 七、附：解码脚本

### 通用解码（看协议用）
`local-data/weird_tower/_decode_get_buff.mjs`（在 local-data，不随 git）
```bash
node local-data/weird_tower/_decode_get_buff.mjs local-data/weird_tower/evotower_get_buff.jsonl evotower
```
第二个参数是 cmd 过滤子串（大小写不敏感）。脚本要点：
- 帧 `scheme: "px"` → 必须先 `getEnc("x").decrypt()`（XOR + 去4 字节头），否则 BON 首字节是 `0x70` 报`unknown tag 112`。
- 自实现 BON 解码器，因为项目 `bon.decode` 对嵌套 `tag7 bytes` 不递归解，且根tag 处理与抓包信封不一致。
- 🔴 **业务字段在 `envelope.body`**，不是 `envelope`。

### 回放校验（跑测试用，随 git）
```bash
node tools/weirdtower/legion-buff-replay.mjs           # 自动探测抓包路径
node tools/weirdtower/legion-buff-replay.mjs <jsonl>   # 显式指定
```
抓包自动探测 `local-data/` → `../captures_keep/`（`local-data/` 在 .gitignore里）。

---

## 八、业务口径修正（master 2026-10-03）：领取内置进爬塔流程

### master 的原话

> 我在意的是业务逻辑，不是代码怎么写。如果每次爬塔，都会获取这个数据的话，
> 那么直接对比自己是否已经领取到了最高 buff，如果可以领取而没有领取，那就领取，
> 否则直接爬塔。**而不必做成单独的一个按钮。**

### 口径变化

| | 初版（错） | 修正后（对） |
|---|---|---|
| 领取触发 | 用户点独立按钮 | **爬塔流程前置步骤**，能领就领 |
| 定位 | 主功能 | 爬塔的附带动作 |
| UI | 四档卡片 + 领取按钮 | 四档卡片**只读展示** + 「爬塔时自动领取」提示 |

理由：爬塔本来就要拉 `memberScores`（人数已在手），领取是纯增益动作，
**没有任何理由让用户记住"还要去点另一个按钮"**。这也和既有的
`claimPendingEvoTowerRewards`（爬塔前补领章节奖励，否则 `readyfight` 被拒 12200020）
是同一个模式。

### 🔴 但「对比自己是否已领取最高档」这个判据在协议上不可用

master 设想的前端判据是「拿已解锁档位和已领取档位比对」。抓包证明这条路走不通：

| 证据 | 值 |
|---|---|
| `getinfo`（seq 43/47，**领取前**） | `legionPrivilege: {}` ← **空的** |
| 首次 `claim` 响应（seq 50，**只领了第 1 档**） | 顶层已是 `{1:1, 2:1, 3:1}` |

⇒ 顶层 `legionPrivilege` **无法区分「已解锁」与「已领取」**：
   领取前它空、领取后它给全量。若拿它做增量判断，会在第一次响应就误判成「已全领完」。

### 采用的替代判据：把判断权交给服务端

不去推断「我该领第几档」，改成**发空 body 试探**：

```js
// 爬塔前：发一次，服务端给档位就继续领，给空就收手
for (let i = 0; i < 4; i++) {
  const resp = await send("evotower_claimlegionprivilege", {});   // 空 body
  const claimedNow = pickClaimedThisTime(resp);   // 嵌套 = 本次结果
  if (claimedNow.length === 0) break;             // 服务端不再给 = 领完了
  gotTiers.push(...claimedNow);
}
```

| 场景 | 行为 | 请求数 |
|---|---|---|
| 未绑定俱乐部 | 查 `bindLegionId === 0` → 直接跳过 | 1（仅 getinfo） |
| 已领完 | 试探 1 次，服务端给空 → 收手 | 2（getinfo + 1 claim） |
| 21 人 3 档未领 | 连发 4 次（3 次领到 + 1 次探测） | 5 |
| 25 人 4 档未领 | 发 4 次（满档上界） | 5 |

**双重保险**：`for (let i = 0; i < 4; i++)` 硬上界（4 档到顶），
即使协议行为异常也不可能死循环。

### 🔴 任何失败都不阻塞爬塔

buff 是**增益**不是**前置条件**（对比 `claimPendingEvoTowerRewards` 失败会导致
`readyfight` 被拒、必须中断）。所以：

- `getinfo` 失败 → `skipped: "getinfo-failed"`，直接返回去爬塔
- `claim` 失败 → `skipped: "claim-failed"`，**保留已领档位**继续爬塔
- 不抛异常，只记warning 日志

### 落地位置

| 文件 | 位置 | 说明 |
|---|---|---|
| `src/utils/weirdTowerLegionBuff.js` | `autoClaimLegionBuffDuringClimb({send, onLog, timing})` | 依赖注入，send 由调用方注入 → 可测 |
| `src/utils/batch/tasksTower.js` | L784 `climbWeirdTower` 内，章节补领之后 | 批量爬塔 |
| `src/components/Tower/WeirdTowerStatus.vue` | L525 `batchClimb` 内，章节补领之后 | 单号爬塔 |
| `src/components/Club/ClubWeirdTowerLegionBuff.vue` | 按钮移除，改`handleClaimAll` 复用同一函数 | 只读展示 |

**依赖注入的意义**：`send` 由调用方传入，测试里用脚本化的假 send，
能精确断言「发了几次 claim、每次拿到什么」，不需要 mock 整个 tokenStore。

### 新增测试（11 例，累计 41）

```
autoClaim：未绑定 → 跳过，不发 claim
autoClaim：已领完 → 只发 1 次 claim 就收手
autoClaim：21 人未领 → 连发 4 次
autoClaim：🔴 顶层给全量时也不误判（必须发满 4 次）
autoClaim：4 档全解锁 → 领满 4 档不超发
autoClaim：getinfo 失败 → 跳过，不阻塞
autoClaim：claim 中途失败 → 保留已领档位，不抛
autoClaim：首次 claim 失败 → 正常返回
autoClaim：日志回调拿到每次档位
autoClaim：未注入 send → 安全返回
autoClaim：脏响应（只有顶层）→ 视为领完，不死循环
```

其中「顶层给全量时也不误判」是**反证测试**：脚本化 4 次响应顶层全是 `{1,2,3}`，
若实现误用顶层判断，claim 只会发 1 次，测试会红。
