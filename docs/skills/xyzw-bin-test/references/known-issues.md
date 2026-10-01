# 已知问题与未解项

> 最近一次核查：**2026-10-01**（此前版本停在 2026-09-30，结论已被推翻，见 §1）。

## 1. ~~Node 直连 role_getroleinfo 返回 200020~~ ✅ 已解（2026-10-01 定案）

**原现象**：authuser 成功并返回 `{roleToken, roleId(=账号uid)}`，但 WS 里 `role_getroleinfo` / `activity_claimtaskreward`
等**角色命令**一律 `200020`，而 `activity_get` 正常。

**根因（双因素，缺一不可）**：
```
受理 = ① 首帧口径对齐游戏本体（role_getroleinfo → {platformExt:"h5", clientVersion:"1.89.8-wx", scene:""}）
     + ② 进主城初始化序列（36 帧，含 role_backclaimreward 进城结算标记）
```
- 此前批量页用的是**自编口径** `{platformExt:"mix", clientVersion:"2.21.2-…"}`，且连接后**直接发 claim**，
  服务端认为会话「未进入游戏」⇒ 静默丢弃（批量页）/ 断线 1006（Node）。
- **实证**：E4（9754 成功）、E7（9755 干净号复刻，**实领 5287×8 入账**）、E9（9756，initdelay=0）、
  E10（9757，得到业务码 `3200020`「奖励已领取」= 受理正常）。
- **反例**：只发 firstframe 不发 init（E2/E3）→ 仍断线。
- **生产化**：commit `ceb1dcf3`（2026-10-01 13:52 上线）
  ① `src/utils/xyzwWebSocket.js` L118 把 `role_getroleinfo` 注册 body 改为 `h5 / 1.89.8-wx`（仅此帧带，无 3000070 污染）；
  ② `src/utils/batch/tasksGoldenfish.js` L1727 `GOLDENFISH_ENTER_GAME_SEQUENCE`（36 帧）前置到 claim 步骤。

**仍有效的注意事项**：
- **`3200020` = 奖励已领取**（正常业务拒绝，不是失败）。
- init 帧间隔 **0ms 会触发风控**（生产版 0ms 曾挂死；E9 单变量复现）。默认 250ms。
- **同角色频繁重连会触发服务端会话冷却**（`200020` 泛滥、数分钟自愈）⇒ 批量重跑间隔别太激进（3s 过激）。

---

## 2. ~~账号级 bin 签出的 token 进不了角色会话~~ ❌ 结论错误，已推翻（2026-10-01 17:40）

> **本条原结论是误判，保留作对照。真实原因是「该角色当时被别的客户端占用」，不是 bin 类型问题。**

**原现象**：`mobile.bin`（账号级，serverId=null）注入 serverId 后 authuser 成功，但角色命令 `200020`。

**推翻证据（2026-10-01 17:40）**：
```bash
RUN --bin D:/my_projects/xyzw/gh_repo/mobile.bin --server 9767     # 账号级 bin + 注入 serverId
→ authuser 200 / 287B → ✅ 冒烟 role_getroleinfo 成功（含 role 数据）
```
⇒ **账号级 bin + 注入 serverId 完全可用**。

**🔴 真正的原因与真相**：
1. `local-data/_cmp_bins.mjs` 实测：`rolebin-9754`(9754) / `rolebin-1009754`(1009754) / `rolebin-2009754`(2009754) /
   `fresh-28a-0`(9755) —— **四个不同服的 bin `info` 完全相同**（sha `09d64898`、timestamp `1790514993`、DID `9fd311e9`），
   **唯一差异是 `serverId`**。⇒ 所谓"角色级 bin"本质就是「账号 info + serverId」，
   `mobile.vue` 的 `createRoleBin = {...bin, serverId}` **本来就是正确实现**。
2. `serverlist` 响应**不给每个角色独立签名信息**（只有 roleId/serverId/name/level/power/loginAt），
   所以注入 serverId 是唯一（也是正确的）构造方式。
3. **`200020` 的真正来源 = 该角色会话被占用**（批量页在跑 / 游戏客户端在线 / master 正在操作该号）。
   当初 `_rev_9767.txt` 报 200020，是因为 master 当时正在 9721→9740 区间收号。

**⚠️ 环境坑**：`gh_repo/mobile.bin`（DID `9fd311e9…`）与批量页 rolebins **同一环境**；
`local-data/login_bin/mobile.bin`（DID `e7d3f629…`、info 08-22）**是另一环境**，两者不可混用比较。

**教训**：把「被占用」误判成「结构不支持」，会浪费一整天。**先排除"会话被占用"再谈协议层差异。**

---

## 3. ⏸️ 生产 28a claim 中段挂死（未解）

**现象**：批量页选 28a 跑「领取进度奖励」（`local-data/goldenfish/claimprogressrewards_fail_again.jsonl`）：
`p=` 四字段 ✓、init 序列前 3 帧成功（54~177ms），**第 4 帧 `role_getfirstmonthdate` 挂死 8000ms**（无响应，非 200020、非业务码）。

**已排除**：0 间隔假设（E9 9756 干净号 initdelay=0 **成功**）、`fight_startlevel` 前奏假设（E10 9757 复刻 28a 时序，claim 得 `3200020` = 受理正常）。
双因素方案已四连验证（E4/E7/E9/E10），28a 的失败模式在 bin-test **不可复现**。

**最大嫌疑**：28a 当时正在 master 的**多开窗口里在线**（第二客户端会话冲突）。
**下一步**：换干净号在批量页重测；先问 master 该号是否在线。

---

## 4. authuser 响应的「roleId」命名误导

authuser 返回的 `roleId` 字段实际是**账号 uid**（与 `role_getroleinfo` 响应的 `uid` 一致）。
角色真正的 roleId 在 `role_getroleinfo` 响应的 `role.roleId`（另一套 id 体系）。
写断言时不要拿 authuser 的 `roleId` 去比对 serverlist 的 `roleId`。

## 5. 服务器 id 两套体系

- 显示 id（9721）与内部 id（9748 = 显示 + 27）；
- 角色槽：`x+27`(a) / `1000000+x+27`(b) / `2000000+x+27`(c)；
- `serverlist` 返回的 `serverId` 就是内部 id，可直接用于注入构造 roleBin。

## 6. 道具 id 命名（master 2026-09-30 口径）

- `5287` = 金鱼普通道具（开包产出硬通货）
- `5288` = 金鱼特殊道具（250 个兑换金鱼 = 活动最终目的，保护名单）
- `5286` = 每日投币/投道具用（消耗活动赠品，保护名单）
- 「普通道具」一词（不带"金鱼"前缀）= 非金鱼道具（英雄碎片包等）

---

## 7. 🔴 命令注册覆盖率缺口（2026-10-01 发现并修复 —— 生产 claim 挂死的真因）

**现象**：实机 `--run claim` 抛 `Error: Unknown cmd: activity_claimtaskreward`；
且异常把连接打成 `close 1006`，之后**每一帧都只入队**（`WebSocket 未连接，消息已入队: xxx` 无限循环）。

**两处缺口**（用 `local-data/_check_registry.mjs` 实测）：
1. `activity_claimtaskreward` **从未注册**（`xyzwWebSocket.js` 里它只出现在注释中）⇒ 生产「领取进度奖励」按钮必然抛错。
2. `GOLDENFISH_ENTER_GAME_SEQUENCE` 36 帧里 **19 帧未注册**（`role_backclaimreward`、`role_getfirstmonthdate`、
   `system_getchatmessage`、`invite_getinfo`、`collection_getinfo`、`friend_*`、`pkroom_*` …）⇒ 原覆盖率仅 **17/36**。

**已修**：补注册全部 19 帧 + `activity_claimtaskreward`；响应映射 `activity_rewardresp` 改为数组
`["activity_claimsignreward", "activity_claimtaskreward"]`。复检 **36/36**，注册表 189 → 207。

**🔴 为什么之前的实验没发现？**
bin-test 的 `commands:` 模式与 `runInitSequence()` 都会**自动兜底注册**：
```js
if (!ws.registry.commands.has(item.cmd)) ws.registry.register(item.cmd);
```
⇒ **研究 harness 比生产宽松，掩盖了缺口**（E4/E7 因此"看起来"通过）。
**教训：协议命令的注册覆盖率必须单独核查**，别把 harness 的通过当成生产可用。

**排查命令**：
```bash
node --import ./local-data/_alias_loader.mjs local-data/_check_registry.mjs
# 输出 init 序列注册覆盖率 + claim 相关命令 + 注册表总量
```

**同类隐患**：任何新增到 `GOLDENFISH_ENTER_GAME_SEQUENCE` / 新任务里的命令，都必须同时进
`registerDefaultCommands`，否则生产抛 `Unknown cmd`。建议把 `_check_registry.mjs` 纳入改动的自检清单。

**✅ 修复后实测通过（2026-10-01 17:42，9767/40a）**：
```
进主城初始化序列：29/36 帧成功
进度奖励补领：77 个达标未领轮次
进度奖励领取完成：77/77 轮（record 校验全部入账）   ← 服务端 record 确认
全程 21 秒（init 12s + 领奖 8s）
```

---

## 8. 代码/文档整洁问题（2026-10-01 核查发现）

| 问题 | 位置 | 状态 |
|---|---|---|
| ✅ **运行命令漏了 `--import ./local-data/_alias_loader.mjs`** —— 照原文档跑必然 `ERR_MODULE_NOT_FOUND: '@/stores'` 崩溃 | SKILL.md 使用流程 | **已修**（所有命令加 loader；已在 pipeline.md §7 说明三个作用） |
| ✅ **`bin-test.mjs` 双连接**：模块末尾 `connect().then(main)` 与 `main()` 内的 `await connect()` 各建一条会话，同 token 两会话互相踢（`close 1006`），可能是"频繁重连触发风控"的来源 | `bin-test.mjs` 末尾 + `connect()` | **已修**（末尾改 `main()`；`connect()` 开头先关旧 socket）。修复后复跑只剩 1 次 `onConnect`/`open`，无 1006 |
| `ROLE_DEFAULTS` 是**死常量**（定义后全文件无引用）；实际生效口径来自生产 registry 的 `h5/1.89.8-wx` | `local-data/bin-test/bin-test.mjs` L71–77 | 待清理：删除，或让它真正参与，避免下次误判首帧口径 |
| `--firstframe game` 已**冗余**（取值与生产默认相同） | 同上 | 保留无害，但别再当成"必须加的修复" |
| 注释称 `role_backclaimreward` 是「末帧 / 最后一帧」，实测是 36 帧中的**第 31 帧** | `tasksGoldenfish.js` L1723；`bin-test.mjs` L298-300 | 建议改为「进城结算标记帧」 |
| skill `scripts/bin-test.mjs` 快照与权威实现**会漂移** | skill 目录 | 每次使用前 `diff` 比对（见 SKILL.md「唯一权威实现」） |
