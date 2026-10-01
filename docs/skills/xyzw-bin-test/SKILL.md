---
name: xyzw-bin-test
description: 用 bin 文件实机登录咸鱼之王角色并实测任意操作逻辑（金鱼活动第一阶段七步全流程、任意命令序列）。当 master 给出 bin 文件要求实测/验证角色操作、或在写代码前需要用真实账号验证协议行为时使用。产出真实执行结果，替代「让 master 手动测试」。
agent_created: true
---

# xyzw bin 实测（咸鱼之王角色操作实机验证）

## 目的

拿到 bin 文件后，**直接实机登录对应角色**、执行要验证的操作逻辑（金鱼第一阶段全流程或任意命令序列），
拿到真实结果后再写/改业务代码。避免「代码写完 → master 手动测试 → 发现字段错误 → 返工」的循环。

## 硬性前提

1. 在项目根目录运行：`D:/my_projects/xyzw/gh_repo/xyzw_web_helper_kai`（脚本用相对路径引用 `src/utils`）。
2. Node：`C:\Users\worldemperor\.workbuddy\binaries\node\versions\**22.22.2-5**\node.exe`
   （⚠️ 2026-10-01 校正：旧文档写的 `22.22.2-3` **目录已不存在**；`node` 在 PATH 即指向 `22.22.2-5`，直接写 `node` 最稳）。
3. `ws` 包已装在 `local-data/_ws_env/node_modules/ws`；缺失时安装：
   ```
   cd local-data/_ws_env && node <npm-cli.js路径> install ws@8 --no-save --prefix .
   ```
4. ⚠️ **会话独占**：同一角色同时只能有一个客户端。实测前确认该角色**没有**被批量页运行中、也没有游戏客户端在线——
   否则所有角色命令返回 `200020`（空 hint）。**这是最常见失败原因**，脚本会在冒烟失败时提示。
   ⚠️ 另：**每次 authuser 会作废同账号的旧会话** ⇒ 实测期间不要在批量页触发该账号的 Token 刷新。
5. 授权：实跑会**真实消耗/领取**（开箱、领奖、开包、清空道具、升星）。每次实跑前确认 master 授权过该操作范围。
   顺带确认 master 当时**没有**在批量页跑那批号（他会告诉你跑到哪个服）。

## 唯一权威实现

**脚本只有一份**：项目内 `local-data/bin-test/bin-test.mjs`（✅ 唯一权威，随代码演进）。
本 skill **不再自带脚本副本**（2026-10-02 移除）—— 历史教训：副本会漂移，
2026-10-01 曾发现内嵌快照落后一整代（缺 init 序列 / `--firstframe`，且还在用修复前的
`...data` 拼 token 多塞 `roleId`），那一天里不得不手动同步了两次。
⇒ 需要跑测试一律直接调 `local-data/bin-test/bin-test.mjs`，不要拷、不要留副本。

## 与项目知识库的关系（双向索引）

- 本 skill 的 `references/` 只放**本 skill 专属**的操作细节（登录链路、已知问题/实验记录）。
- **项目级事实**（架构、红线、协议命令表、数据资产、其它活动）一律查 **仓库内 `docs/kb/`**：
  - 入口 `docs/kb/INDEX.md`（任务路由表）
  - 协议/错误码 `docs/kb/ref-protocol-catalog.md`
  - 数据资产（含 jsonl 格式区分）`docs/kb/ref-assets-docs.md`
  - 金鱼活动全貌 `docs/kb/activity-goldenfish.md`
- 反过来，`docs/kb/ref-assets-docs.md` 也登记了本 skill 及其附属文件。
- ⚠️ 本 skill 装在 `~/.workbuddy/skills/`（**不随 git**），换电脑用仓库里的
  `docs/skills/install.sh` 一键装回（存档在 `docs/skills/xyzw-bin-test/`）。

配套资产：
- `local-data/_alias_loader.mjs` —— 裸 node 的 `@/` 别名 + TS strip + `window/localStorage/import.meta.env` 垫片
- `local-data/goldenfish/init-commands.json` —— 进主城初始化序列（36 帧，**与生产 `GOLDENFISH_ENTER_GAME_SEQUENCE` 逐帧一致**）
- `local-data/goldenfish/_gf.mjs` —— 抓包解码（`cmds|sends|struct|grep|num|dump`，底层走生产 `bonProtocol.js`）

## 登录链路（bin → WSS）

📄 **完整链路、批量页路径 vs bin-test 路径逐项对照、可执行检查清单：见 [references/pipeline.md](references/pipeline.md)。**

极简版：
```
bin → g_utils.parse(_raw)
  角色级(serverId≠null) → 直接用
  账号级(serverId=null) → g_utils.encode({..._raw, serverId}, "lx")
→ POST /login/authuser (Content-Type: application/octet-stream)
→ {roleToken, roleId(=账号uid!)}  → p= = {roleToken, sessId, connId, isRestore:0}   ← 必须四字段
→ wss://xxz-xyzw.hortorgames.com/agent?p=…&e=x&lang=chinese
→ XyzwWebSocketClient.init() → 心跳 5s → sendWithPromise（响应按 resp===seq 匹配）
```
- **serverId 编码**：内部 id = 显示 id + 27；同一服三槽：`x+27`(a) / `1000000+x+27`(b) / `2000000+x+27`(c)。
  例：显示 9721 → 9748 / 1009748 / 2009748。
- **账号级 bin 可列全部角色**：`POST /login/serverlist`（同 bin）→ `data.roles`；`--auto` 默认选 `loginAt` 最旧（最闲置）。
- 🔴 **首帧口径**：生产与 bin-test 都发 `role_getroleinfo = {clientVersion:"1.89.8-wx", platformExt:"h5", …}`（游戏本体原值）。
  （bin-test 复用生产 registry，故**默认即对齐**；`--firstframe game` 现已冗余。）

## 🔴 角色命令受理的双因素（claim 挂死根因，2026-10-01 定案）

```
受理 = ① 首帧口径对齐游戏本体（h5 / 1.89.8-wx / scene:""）
     + ② 进主城初始化序列（36 帧，含 role_backclaimreward 进城结算标记）
```
- `--run claim` 会自动先跑 36 帧 init，再调 `goldenfishClaimProgressRewards`。
- 业务码 **`3200020` = 奖励已领取**（正常业务拒绝，不是失败）。
- init 帧间隔默认 **250ms**；**0ms 会触发服务端风控挂死**（E9 单变量复现过）。
- 只发首帧不发 init（E2/E3）→ claim 仍断线 1006。

## 使用流程

🔴 **所有命令都必须带 `--import ./local-data/_alias_loader.mjs`**，否则裸 node 解析不了 vite 的 `@/` 别名，
会直接 `ERR_MODULE_NOT_FOUND: Cannot find package '@/stores'` 崩溃。
（该 loader 做三件事：`@/` 别名解析、TS strip、补 `window/localStorage/sessionStorage/import.meta.env` 垫片。）

```bash
cd /d/my_projects/xyzw/gh_repo/xyzw_web_helper_kai
NODE="C:/Users/worldemperor/.workbuddy/binaries/node/versions/22.22.2-5/node.exe"
RUN() { "$NODE" --import ./local-data/_alias_loader.mjs local-data/bin-test/bin-test.mjs "$@"; }
```

1. **拿到 bin 后先问清**：测哪个角色（`--server` 内部 id）、要不要真实消耗（pipeline 会真实领奖/开包/清空/升星）、
   以及 **master 当时有没有在批量页跑这批号**。
2. **冒烟**（默认，不消耗资源）—— 登录 + `role_getroleinfo` + `activity_get` 快照：
   ```bash
   RUN --bin <bin路径> [--server <内部id>] [--auto]
   ```
   ✅ 判据：出现 `冒烟 role_getroleinfo #n: 成功（含 role 数据）` ⇒ **bin → WSS 全链路已通**。
   （`activity_get: code=undefined` 是**正常**输出——成功响应不带 `code` 字段。）
3. **只读命令序列**（不动状态）：
   ```bash
   RUN --bin <bin> --server <id> --run commands:<json路径>
   ```
   JSON 格式 `[{"cmd":"xxx","params":{...}}]`；响应体（截断 800 字）写入 `commands-result-*.json`。
   脚本会**自动兜底注册**未注册命令（init 序列里大量 getinfo 类不在生产注册表）。
4. **单发领奖诊断**（验证 claim 是否被受理 / 是否把会话打挂）：
   ```bash
   RUN --bin <bin> --server <id> --run claimone:<missionId>
   ```
   响应后自动补发 `activity_get` 探测会话存活。
5. **只跑领奖**（自动前置 36 帧 init）：
   ```bash
   RUN --bin <bin> --server <id> --run claim
   ```
6. **跑第一阶段全流程**（⚠️ 真实消耗）：
   ```bash
   RUN --bin <bin> --server <id> --run pipeline [--skipclear] [--skipupgrade]
   ```
7. **诊断直连**（绕过 authuser，用批量页录制的新鲜 token —— 用于「同 token 浏览器通/Node 不通」类问题）：
   ```
   ① 批量页勾选「连接诊断」→ 跑一次任务 → 「导出诊断」得 wss-diag-*.jsonl
   ② DIAG_FILE=<jsonl路径> RUN
   ```
   取 jsonl 里最后一条 `ws.connect` 的 `actualToken` 直连。
8. **分析结果**：控制台 + `local-data/bin-test/log-*.txt`。

### 可选开关
| 开关 | 作用 |
|---|---|
| `--auto` | 账号级 bin 自动选 `loginAt` 最旧（最闲置）的角色 |
| `--firstframe game` | 覆盖 `role_getroleinfo` body 为游戏本体原值（**现已冗余**，默认即此口径） |
| `--skipsmoke` | 跳过 role_getroleinfo 冒烟（排查 200020 时用） |
| `--initdelay <ms>` | init 序列帧间隔（默认 250；**0 会触发风控**） |
| `--skipclear` / `--skipupgrade` | pipeline 跳过「清空道具」/「升星链」 |

## ⚠️ 请求体字段必须对齐抓包（血泪教训）

- `activity_claimtaskreward` 请求体 = **`{activityId, missionId}`**（漏 `activityId` → 服务端不响应 → 超时，且领取**不生效**）。
- `activity_get` 的 task 表对**零进度任务不下发键** → 读进度时缺失槽位按 **0** 处理（不要当「不可读」跳过）。
- 新命令接入前，**先抓一份真实请求**对齐字段，不要想当然。
- 命令参考：`docs/goldenfish-autumn-protocol.md`（authuser/serverlist/openpack/lottery/claimtaskreward 全记录）。

## 金鱼道具经济（写断言时用）

- **5287** = 金鱼普通道具（开包产出）；**5288** = 金鱼特殊道具（250 个兑换金鱼 = 活动最终目的，**保护名单**）；
  **5286** = 每日投币/投道具用（**保护名单**）。其它保护名单：`1013` / `1001` / `1012` / `2001-2005`。
- 5287 → 5288 产出率 **25%**（+ 保底 bias ∈ [-5,5]；实测 684→174）。
- 宝箱：木 1 / 青铜 10 / 黄金 20 / 铂金 50 分，**单帧必须恰好开 10 个**；木箱保留 200 个、**钻石不开**。
- 钓鱼掉落：鱼竿 11.11%、招募令 11.11%、各档宝箱（**正向带进库存** → 并行时扣减校验只认「净耗 > 消耗数」为异常）。
- 邮件（宝箱周返还）累积 **≥ 32000 才领**（4 轮 × 8000）。

## 常见失败速查

| 现象 | 首查 |
|---|---|
| 角色命令全 `200020`、`activity_get` 正常 | 会话被占用（批量页/游戏客户端）或**账号级 bin**（见 pipeline.md §6） |
| claim 静默挂死 / 断线 1006 | 未跑 36 帧 init，或 init 间隔 0ms 触发风控 |
| `Unknown cmd` | 命令未注册 → 脚本已兜底注册；生产接入需 `registerDefaultCommands` |
| authuser 非 200 / 无 roleToken | bin 过期或 serverId 注入错（内部 id = 显示 id + 27） |
| 跑了别的号导致 master 断线 | 违反了「authuser 作废同账号旧会话」——**下次先问** |
