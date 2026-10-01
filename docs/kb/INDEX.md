# 知识库索引（L0 · 唯一入口）

> 项目：`xyzw_web_helper_kai` — Vue3+Vite 的「咸鱼之王 / XYZW」第三方自动化站
> 建立：2026-10-01；**2026-10-02 迁入仓库 `docs/kb/`**（随 git 走，换电脑 clone 即恢复）
> 覆盖：全量源码 + 18 篇工作日志 + 27 篇 docs + local-data 抓包
> **用法：开工先读本文件 → 按「任务路由表」只读需要的 2~3 个子文件。不要全量扫代码。**

### 这棵树在哪 / 换电脑还会在吗

| 资产 | 位置 | 随 git 走 |
|---|---|---|
| **知识库（本目录）** | `docs/kb/` | ✅ 是 |
| **Skill（3 个）** | `C:\Users\worldemperor\.workbuddy\skills\` | ❌ 否 → 用仓库内 `docs/skills/install.sh` 一键装回 |
| 每日工作日志 | `.workbuddy/memory/2026-*.md` | ❌ 否（`.gitignore:84` 忽略 `.workbuddy/`） |

⇒ **换电脑步骤：clone 仓库 → `bash docs/skills/install.sh` → 开工。**

---

## 一、知识树（分级）

```
L0  INDEX.md ← 你在这里（索引 + 路由 + 红线 + 当前状态）
│
├─ L1 架构与全局（先建立坐标系）
│   ├─ 01-architecture.md        分层架构 / 目录地图 / 数据流 / 状态管理
│   ├─ 02-toolchain-deploy.md    运行时路径 / 构建 / 测试基线 / 部署 / 推送 / 服务器
│   ├─ 03-protocol-connection.md 帧与BON / WS客户端 / 连接管理 / 多开 / 平台伪装
│   ├─ 04-workflow.md            标准开发流 / 新增任务N步 / 新增命令 / UI接线红线 / 证据规范
│   └─ 05-redlines.md            全局红线与踩坑（犯错前必读）
│
├─ L2 活动（业务主战场）
│   ├─ activity-goldenfish.md          金鱼秋季活动（当前主战场）
│   ├─ activity-saltfield.md           盐场（军团战）
│   ├─ activity-xiaoyaojin-camp.md     逍遥津 + 营地挑战
│   ├─ activity-pantao-weirdtower.md   蟠桃 + 怪异塔助力
│   └─ activity-misc.md                白玉/预约/黑市/宝箱/竞技场/副本/挂机/答题/推关…全部常驻
│
├─ L2 模块（基础设施）
│   ├─ module-batch-engine.md    批量执行引擎：任务定义→执行→调度→重试→UI
│   └─ module-auth-token.md      认证与Token：三种登录、BIN、按需刷新、连接锁
│
└─ L2 参考（查表）
    ├─ ref-protocol-catalog.md   所有命令 cmd 总表 + 响应匹配
    └─ ref-assets-docs.md        local-data 抓包/工具脚本清单 + docs 索引 + 测试清单
```

> 旧文件 `.workbuddy/memory/mod-*.md`（toolchain / bon-frame / goldenfish）**已并入本知识树**，
> 内容以此处为准；保留原文件仅为历史对照。

---

## 二、任务路由表（先查这里）

| 我要做的事 | 读 |
|---|---|
| 部署上线 / 回滚 / 看服务器状态 | `02-toolchain-deploy.md` |
| 构建失败、测试变红、跑测试 | `02-toolchain-deploy.md` §测试基线 |
| 新增一个批量任务 | `04-workflow.md` §新增批量任务 + `module-batch-engine.md` |
| 新增/修改一条协议命令 | `04-workflow.md` §新增命令 + `03-protocol-connection.md` + `ref-protocol-catalog.md` |
| 解码抓包 / 逆向协议 | `03-protocol-connection.md` + `ref-assets-docs.md`（工具）+ skill `xyzw-protocol-re` |
| 用 bin 实机验证某个操作 | `ref-assets-docs.md`（bin-test）+ skill `xyzw-bin-test` |
| 金鱼活动（消耗/收尾/领奖） | `activity-goldenfish.md` |
| 盐场（组队/登场/攻击） | `activity-saltfield.md` |
| 逍遥津 / 营地挑战 | `activity-xiaoyaojin-camp.md` |
| 蟠桃 / 怪异塔助力 | `activity-pantao-weirdtower.md` |
| 白玉 / 预约 / 黑市 / 宝箱 / 副本 / 挂机 / 答题 / 推关… | `activity-misc.md` |
| Token 导入 / 登录 / 刷新 / 限流 | `module-auth-token.md` |
| 连接失败 / 重连 / 多开 / 平台伪装 | `03-protocol-connection.md` |
| 遇到看不懂的 bug / 想当然的坑 | `05-redlines.md` |
| 找抓包文件 / 文档 / 某个测试 | `ref-assets-docs.md` |
| 查某个 cmd 的参数与响应 | `ref-protocol-catalog.md` |

---

## 三、全局红线速查（完整版见 `05-redlines.md`）

1. 🔴 **永远不要手写 BON 解码器** — 只用 `src/utils/bonProtocol.js`（或 `local-data/goldenfish/_gf.mjs`）。
2. 🔴 **UI 接线是"三处"（实际五处）**：任务模块导出 + 页面 import/解构 + `createFlexibleTaskHandlers` 展开 + 模板 `n-button` + `flexibleTemplate` 注册。**"导出函数" ≠ "有入口"**。
3. 🔴 **补推 GitHub 前不要跑 `deploy/update.sh`**（会把线上 `reset --hard` 回退到 myrepo 旧 tip）。
4. 🔴 **进度在 `activity_get.task`，不在 `role` 上**。
5. 🔴 **开箱/招募/钓鱼只认整批 10**（余数被服务端拒）。
6. 🔴 **宝箱积分 ≥1000 才一键兑光，<1000 不兑**；钻石箱一律不开、木箱留 200。
7. 🔴 **未注册的命令发不出去**（`CommandRegistry.register` 先注册）。
8. 🔴 **建连必须走 `tokenStore.createWebSocketConnection`**，勿直接 `new WebSocket`。
9. 🔴 **多开存储必须带 scopeId 前缀**，串号即事故。
10. 🔴 **不要自动化盐场 PVP**（`war_startbattle` 被 3000070 拦）。
11. 🔴 **运行时路径已变更**：node = `C:\Users\worldemperor\.workbuddy\binaries\node\versions\22.22.2-5\node.exe`（`-3` 已不存在）。
12. 🔴 **`src/utils/batch/smartOpenBox.js` 不要照金鱼口径改**（那是日常开箱，与活动积分消耗不通用）。

---

## 四、当前状态（截至 2026-10-01 15:38，master 叫停存档）

**项目定位**：无后端、纯前端（localStorage + IndexedDB + 直连游戏 WSS）；生产部署在腾讯云 `http://111.229.64.152/`，桌面端为主。

**代码 tip**：`c962c0a7`（本地 = 线上；线上 commit 校验为 `c962c0a`，2026-10-01 17:52 部署）。

**✅ 自动领取进度奖励已打通（2026-10-01 17:52 上线）**：
根因 = 生产漏注册 `activity_claimtaskreward` + `GOLDENFISH_ENTER_GAME_SEQUENCE` 19/36 帧
（抛 `Unknown cmd` → 连接 `close 1006` → 全帧入队）。已补注册（36/36，注册表 189→207）。
实测 9740服/9767：进主城 29/36 → **77/77 轮全部入账**（21s）。
旧结论「账号级 bin 进不了角色会话」**已推翻**（真因是**会话被占用**；账号级 bin + serverId 注入完全可用）。
新增自检工具 `local-data/_check_registry.mjs`（改命令后必跑）。

**⚠️ GitHub 未同步（补推前禁止跑 `deploy/update.sh`）**：本地比 `myrepo` **领先 11 个提交**（见下方清单 + `c962c0a7`）。

**⚠️ GitHub 未同步（补推前禁止跑 `deploy/update.sh`）**：
本地 `personal-main-merge-main` 比 `myrepo/personal-main-merge-main`(= `5032f1a7`, 09-30 14:40) **领先 11 个提交**：
`5ff4cacf`(合并鱼) `dfd66f48`(合并鱼撤出模板) `ac85d9e0` `b3ab09ba` `75d1d936`(批量日志) `0a615a04`(滚底)
`83156215`(金鱼以响应为准+账号级重跑) `2df6f788`(p=去roleId) `bfadd6fa`(claim按钮) `ceb1dcf3`(claim双因素)
`c962c0a7`(补注册 claim 命令 + init 19 帧 —— **自动领取打通**)。
工作区干净（仅剩未跟踪 `_probe_activity_full.json` / `xyzw-bin-test.zip`）。

**金鱼第一阶段**：
- ✅ 已攻克并上线：进度奖领取挂死 ROOT CAUSE = **①进主城初始化序列(36帧) + ②首帧口径对齐游戏本体(h5/1.89.8-wx / scene:"")** 双因素（`ceb1dcf`）。四次实证 E4/E7/E9/E10。
- 🔴 **2026-10-01 17:42 追加定案（比双因素更根本）**：生产还漏注册了命令 —— `activity_claimtaskreward` **从未注册**、
  init 序列 **19/36 帧未注册**（含 `role_backclaimreward`）⇒ 生产发送即抛 `Unknown cmd`、连接被打成 `close 1006`、后续全帧入队。
  已补注册（36/36，注册表 189→207，**未提交**）。修复后 **9767 自动领取实测 77/77 全部入账**（21 秒）。
  ⚠️ 旧结论「账号级 bin 进不了角色会话」**已推翻**：真因是**会话被占用**；账号级 bin + serverId 注入完全可用。
  ⚠️ 教训：bin-test 的 `commands:`/`runInitSequence` 会自动兜底注册，**掩盖了生产缺口** ⇒ 必须跑 `_check_registry.mjs`。
- ⏸️ **未解卡点**：`mobile.bin`（账号级 bin）注入 serverId 后 `authuser` 成功，但该 token 建的 WS 会话**所有角色命令 200020**（账号级 info 签出的 token 进不了角色会话）；rolebin 四号(9754-9757)被反复测试后也打不进（疑会话残留，master 说无长冷却）。
- ⏭️ 下次续接线索：① 抓多开窗口原生登录 HTTP 全序列(`captureHttp=true`)看 authuser→WS 间有无二次换签/选服；② 从批量页诊断 `refresh.req.binB64` 提取新鲜角色 bin；③ 干净时段重试；④ 先问 master 跑到哪个号。

**待办队列**：
- 阶段 C：金鱼收尾 `goldenfishFinishPlan.js` 全套纯函数**未接生产**（`tasksGoldenfish.js` 只 import 了 4 个纯函数）；`ConsumptionProgressCard.vue` 仍硬编码旧期 `activityId=2512261`、item `5261/5262`。
- Excel「金鱼精算1」返还率口径待 master 拍板。
- 盐场：`war_startmarch`/`war_startattackbuilding`/`war_speedup` 未实现（建筑攻击实测 20/20 成功，可自动化）；下周开战窗口验证 `first-frame-spoof.js` 对 3000070 的影响。
- 怪异塔：`evotower_claimreward` 参数未知，待 10-02 窗口补抓。
