# L2 · 参考 · 数据资产与文档索引

## 1. `local-data/`（⚠️ **已 gitignore**，不进仓库，仅本机）

### 部署 / 推送工具
| 文件 | 用途 |
|---|---|
| `_push_now.sh` | 主线 push（IP×后端矩阵，成功即停） |
| `_push_branch.sh <branch>` | 非主线 push（`FORCE=1` → `--force-with-lease`） |
| `_fetch_branch.sh <branch>` | 看分叉（left/right 计数 + 双向提交列表） |
| `_gh_proxy.mjs` | github TLS 引到可达 IP（SNI 仍 github.com） |
| `_remote_deploy.sh` / `_deploy.bundle` | bundle 直连部署 |

### 抓包与解码
| 路径 | 内容 |
|---|---|
| `goldenfish/_gf.mjs` | **标准解码工具**：`cmds \| sends \| struct \| grep \| num \| dump`（底层 = 生产 `bonProtocol.js`） |
| `goldenfish/` | `21a_fail_wss-diag` vs `21a_success_xyzw-runtime-wss`（**同 token 双样本对照**）、`goldenfish_claimProgressRewards.jsonl`、`merge_fish_claim_rewards.jsonl`、`fish_auto_merge.jsonl`、`rolebins/`(9754-9757)、`_consumption_decoded.txt`、`_probe_openbox.mjs`、`27c_ws_handshake_url.txt` |
| `camp_data/` | 76 文件，`log_for_debug9|10|11.txt`、`design.txt`(业务伪代码) |
| `saltfield/` + `saltfield/analysis/` | 78 文件，`260926_data/`、`runtime_saltfield_failed_to_setout.jsonl`、saltfield-wss 日志 |
| `pantao/`(54) + `pantao-analysis/` | 蟠桃抓包与离线分析 |
| `push_level/` | 推关 bin、`headless_result_1841.json`、`verify_official_1841.mjs` |
| `xiaoyaojin/` | `xinyaojin_full.jsonl` |
| `weird_tower/` · `weekly_events/` · `misc/`(白玉/黑市) · `login_bin/` · `shop/` | 各活动抓包 |

### 运行时 / 冒烟 / 校验
| 路径 | 用途 |
|---|---|
| `bin-test/bin-test.mjs` | **实机实测**（走真实生产代码路径）。🔴 **必须带 `--import ./local-data/_alias_loader.mjs`**，否则裸 node 解析不了 `@/` 别名直接崩。用法：`--bin <bin> [--server id] [--auto] --run smoke\|claim\|claimone:<missionId>\|pipeline\|commands:<file>`；开关 `--skipsmoke` / `--initdelay <ms>` / `--skipclear` / `--skipupgrade`；claim 模式自动前置 36 帧 init。✅ 2026-10-01 实测通过（28a/9755） |
| `_scan_bins.mjs` / `_cmp_init.mjs` | 只读工具：扫描所有 bin 的 serverId 分布 / 比对生产 init 序列与 json 是否逐帧一致 |
| `_alias_loader.mjs` | 解决裸 node 的 `@/` 别名 + TS strip + `window/localStorage/import.meta.env` 垫片 |
| `_ws_env/node_modules/ws` | bin-test 依赖 |
| `_smoke_*.mjs` | 页面冒烟（多数支持 `baseUrl`）：`_smoke_claim_btn` · `_smoke_whitejade_pkroom` · `_smoke_log_ring` · `_smoke_log_header` · `_smoke_sim_ui` · `_smoke_server_select` · `_smoke_bintool` · `_smoke_sync_source` |
| `_sfc_batch_check.mjs` | SFC 语法校验（`node --check` 抓不到忘 import） |

### 其它
- `tools/goldenfish-simulator/`（`build.mjs` → 单文件 HTML）→ `public/goldenfish-simulator.html`（**已上线，改它须 commit**）
- `scripts/` = 游戏 Userscript 源（`自动盐场.js` / `全自动蟠桃园.js` / `新锁头盐场阵容.js` / `盐场攻击弹窗不消失(1).js` / `7.7.12.js` / `7.7.12.deobfuscated.runtime-assisted.js`）
- `tools/` = 反混淆工具链（`instrument-7.7.12-runtime.cjs` / `split-runtime-traced.cjs` / `collect-runtime-trace.cjs` / `deobfuscate-7.7.12.cjs`）
- `deploy/` = `update.sh` 等（🔴 **本地领先 myrepo 时勿跑**）
- `public/game/` = `sh1.js`(上号器) · `sh1.readable.js` · `first-frame-spoof.js` · `platform-spoof.js` · `push-level-research-bridge.js` · `multi-game-storage-bridge.js` · `multi-game.html` · `answer.json`

## 2. 相关 Skill（用户级 `C:\Users\worldemperor\.workbuddy\skills\`）

| Skill | 用途 | 关键附属文件 |
|---|---|---|
| `xyzw-protocol-re` | 解码 runtime-analysis jsonl 的 BON 帧、还原请求体、逐字节复现验证 | — |
| `xyzw-bin-test` | 用 bin 实机登录角色实测任意操作逻辑（替代让 master 手动测） | `references/pipeline.md`（**bin→WSS 全链路权威文档**）、`references/known-issues.md` |
| `xyzw-web-helper-deploy` | 部署上线到 `http://111.229.64.152/`（§2b = bundle 直连路径） | — |

### Skill 的位置与迁移（换电脑必看）

- Skill 装在 **`C:\Users\worldemperor\.workbuddy\skills\`**（用户级，**不随 git**）。
- 仓库内 **`docs/skills/`** 有存档 + **`docs/skills/install.sh`** 一键装回：
  ```bash
  bash docs/skills/install.sh
  ```
- 🔴 **`xyzw-bin-test` 的脚本不在 skill 里**，唯一权威实现是项目内 `local-data/bin-test/bin-test.mjs`
  （2026-10-02 移除了 skill 内的副本 —— 它曾漂移一整代，还留着修复前的 `...data` 多塞 roleId 的 bug）。
- 运行必须带 `--import ./local-data/_alias_loader.mjs`（裸 node 解析不了 `@/` 别名）。

> ⚠️ 反过来，skill 的 `references/` 只放 skill 专属细节；**项目级事实一律查 `docs/kb/`**（见本文件顶部 INDEX 的路由表）。双向索引已建立。

## 3. `docs/` 索引（25 篇）

| 文件 | 主题 |
|---|---|
| `goldenfish-claim-session-gap-analysis.md` | **金鱼进度奖 claim 会话缺口分析（10-01，核心）** |
| `goldenfish-autumn-protocol.md` | 金鱼秋季活动协议备忘 |
| `fish-merge-and-artifactbook-protocol.md` | 养鱼合并 + 图鉴点亮协议（含 §6 切阵自动合并） |
| `camp-challenge-protocol-research.md` | 营地挑战协议与节点模型（§2.2.1 / §6.1 / §9.1 是关键） |
| `xiaoyaojin-activity-protocol.md` | 逍遥津协议 |
| `pantao-protocol-catalog.md` / `pantao-auto-feasibility.md` | 蟠桃协议表 / 可行性 |
| `saltfield-protocol-catalog.md` | 盐场协议表 |
| `saltfield-auto-ui-design.md` | 盐场自动 UI 设计 |
| `saltfield-deploy-team-enter-feasibility.md` | 盐场部署/组队/进场可行性 |
| `weird-tower-share-code-protocol.md` / `weird-tower-share-assist-design.md` | 怪异塔助力共享码协议 / 设计 |
| `weekly-event-blackmarket-analysis.md` | 黑市周协议 |
| `monday-jade-and-pkroom-appoint-protocol.md` | 周一白玉 + 预约比赛 |
| `mobile-phone-login-protocol-research.md` | 手机号登录协议（三批抓包 + 失败分支清单） |
| `mainline-pushlevel-protocol-research.md` / `mainline-pushlevel-implementation-plan.md` | 主线推关协议 / 实施方案 |
| `push-level-research-usage.md` | 推关研究页使用说明 |
| `pushlevel-tolerance-experiment-20260903.md` | 容差探测实验 |
| `runtime-frame-spoof-verification.md` | 3000070 首帧口径改写验证 |
| `multi-game-sync-modes.md` | 多开同步模型 |
| `flexible-batch-template-task-logic.md` | 自由模板每个任务的 UI 标签/命令/条件/循环/`completed` 语义（⚠️ 部分数字已过期） |
| `reverse-engineering/README.md` | 逆向目录入口 |
| `reverse-engineering/7.7.12-skip150.md` | skip150 客户端配置 Hook 结论 |
| `reverse-engineering/7.7.12-deobfuscation-progress.md` | 7.7.12 反混淆进度 |

## 4. 测试清单（`test/`，52 个文件；基线 554/555）

**批量/引擎**：`batchCmdRegistry` · `flexibleTemplate` · `helperTaskRunner` · `logRing` · `dailyTaskRunnerSelection` · `tasksHangUp` · `tasksTower`(🔴 唯一红) · `tasksXianMaster`
**金鱼**：`tasksGoldenfishConsume` · `fishMerge` · `goldenfishConsumePlan` 相关
**活动**：`xiaoyaojinPlan` · `tasksXiaoyaojinCoupon` · `campChallengePlanner` · `campChallengeTodayOppo` · `pantao*` · `saltfieldDeploy` · `whiteJadeAndPkroomAppoint` · `weirdTowerShare*`
**推关**：`pushLevelConfig` · `pushLevelDryRun` · `pushLevelEndLevel` · `pushLevelOutputCode` · `pushLevelResultTemplate` · `pushLevelScheduler` · `pushLevelTokenAdapter`
**认证/多开/其它**：`tokenRefreshPolicy` · `hortorLogin` · `serverRole` · `worker` · `multiGameBootstrap` · `multiGamePageWarning` · `towerClimbLimit` · `towerClimbLimit` · `skinChallenge`(在 tasksTower 内) · `protocolError` · `tokenSort`

跑法：`node --test --test-reporter=tap test/*.test.js`

## 5. 仓库根目录的其它文档

| 文件 | 说明 |
|---|---|
| `PROJECT_CONTEXT.md` | 面向开发的快速交接文档（**末次更新 2026-08-26，早于金鱼/盐场/逍遥津大量工作 ⇒ 只读架构部分，活动状态看本知识库**） |
| `CLAUDE.md` | 较完整的开发指导（部分目录/接口/测试描述滞后） |
| `KNOWN_ISSUES.md` | 风险清单（见下） |
| `README.md` | 用户使用与部署说明（其中 `server/app.py` 部分**与当前工作区不一致**） |
| `CHANGELOG.md` | 版本历史 |
| `LOCAL_TOKEN_CHANGES.md` | Token 相关历史改动 |

## 6. KNOWN_ISSUES 摘要

- **P0**：① `BatchDailyTasks.vue` 用 `eval(taskName)` 动态执行；② Token **明文存 localStorage**；③ `worker.js` 旧微信代理 `Access-Control-Allow-Origin: *`（Hortor 登录路由已收紧）；④ README 暴露默认 `admin/admin123`。
- **P1**：⑤ WS Promise 超时定时器未清理；⑥ 断连未统一 reject 挂起请求；⑦ Token Store 初始化非幂等；⑧ 自动路由重复注入 + 热更新 API 误用；⑨ `tsc --noEmit` 14 文件 139 错；⑩ ESLint 命令缺失；⑪ 主 chunk ~4.7MB。
- **P2**：⑬ `BatchDailyTasks.vue` 单文件 >10000 行；⑭ `DailyTasks.vue` 仍有 Mock；⑮ 周几判断误用 `|`；⑯ README 描述的 `server/app.py` 不在仓库。
- **文档优先级**：当前源码/测试/配置 > `PROJECT_CONTEXT.md` > `KNOWN_ISSUES.md` > `CLAUDE.md` > `README.md`。
  ⚠️ 但活动态以 **本知识库 + `.workbuddy/memory/` 最新日志** 为准。
