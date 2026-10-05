# L1 · 工具链与部署

## 0. 环境硬约束（Windows / Git Bash）

| 项 | 值 |
|---|---|
| node | `C:\Users\worldemperor\.workbuddy\binaries\node\versions\22.22.2-5\node.exe`（⚠️ 旧记忆的 `-3` **已不存在**；`node` 在 PATH 即指向它，直接写 `node` 最稳） |
| python | `C:\Users\worldemperor\.workbuddy\binaries\python\versions\3.13.12\python.exe` |
| git | `"/c/Program Files/Git/cmd/git.exe" -c maintenance.auto=false`（commit 用 `-F` 传消息文件） |
| bash | `"/c/Program Files/Git/bin/bash.exe"` |
| 工作目录 | `D:/my_projects/xyzw/gh_repo/xyzw_web_helper_kai` |

- Bash 缺 coreutils ⇒ 命令输出落盘后用 **node 读**，不要 `cat/head/tail`。
- 追加/写 md 用 **Edit/Write 工具**，**禁用 `node -e` 模板字符串**（内容含反引号必炸）。

## 1. 构建

```bash
cd /d/my_projects/xyzw/gh_repo/xyzw_web_helper_kai
node node_modules/vite/bin/vite.js build --outDir ._tmp_build --emptyOutDir
```
- ⚠️ 直接 `vite build` 会 `emptyOutDir` **清空 `dist/`** ⇒ 站点根静态文件必须放仓库 `public/` 并 commit（别 scp 绕过）。
- 🔴 esbuild 默认 ascii ⇒ 产物里中文是 `\uXXXX` ⇒ **线上 grep 中文必假阴性**。要 grep 就用"压缩无关"的片段（如 `fishTarget:1140`、`{roleToken:i.roleToken,sessId:a,connId:c,isRestore:0}`）。

## 2. 测试基线

```bash
node --test --test-reporter=tap test/*.test.js
```
- 测试文件 **52 个**；当前基线 **555 tests / 554 pass / 1 fail**。
- **唯一历史红**：`test/tasksTower.test.js`「skinChallenge surfaces command failures to the log」——expected `failed`、actual `completed`（断言未随"单步失败隔离"新口径更新，**与改动无关**，别去修它除非 master 要求）。
- 历史红 `campChallengeTodayOppo` / `goldenfishShop` 现已转绿。
- 补充校验：`node --check` **抓不到忘 import**；SFC 语法用 `local-data/_sfc_batch_check.mjs` 检查。

## 3. 部署（bundle 直连服务器 · 第一阶段默认路径）

**背景**：金鱼第一阶段约束 = **不 push GitHub**（联网不稳、耗时），改动只走 bundle 直连。本地 commit 照常。

```bash
KEY="C:/Users/worldemperor/.ssh/id_xyzw_server"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@111.229.64.152"

# ① 看服务器当前 HEAD（决定 bundle 范围）
$SSH "cd /opt/xyzw_web_helper && git log -1 --oneline"

# ② 本地打 bundle（从服务器 HEAD 到本地 HEAD）
git bundle create local-data/_deploy.bundle <server_HEAD>..HEAD

# ③ scp（🔴 bundle 必须传成 /tmp/deploy.bundle —— _remote_deploy.sh 读的就是这个名字！
#    2026-10-03 事故：传成 /tmp/_deploy.bundle ⇒ 脚本 fetch 到上次遗留的旧 bundle ⇒
#    线上被 reset --hard 回退 5 个提交。脚本现已兼容两个名字，但仍统一传 deploy.bundle 最稳）
scp -i $KEY local-data/_deploy.bundle local-data/_remote_deploy.sh root@111.229.64.152:/tmp/deploy.bundle
#    _remote_deploy.sh 另传一份到 /tmp/_remote_deploy.sh（脚本读的名字）：
scp -i $KEY local-data/_remote_deploy.sh root@111.229.64.152:/tmp/_remote_deploy.sh

# ④ 服务器构建
$SSH "cp /tmp/_remote_deploy.sh /tmp/deploy_build.sh && bash /tmp/deploy_build.sh"
#   脚本内部：fetch bundle → reset --hard FETCH_HEAD → pnpm i → build → nginx reload
#   🔴 末行「完成：… commit=<short>」必须与本次要上的 HEAD 一致，不一致 = 上错了（立即查 bundle 文件名）
```

**服务器**：`111.229.64.152`（腾讯云 OpenCloudOS 9.4）｜仓库 `/opt/xyzw_web_helper`｜分支 `personal-main-merge-main`｜nginx root = `dist/`
**远端**：`myrepo = greatworldemperor`（推送目标）；`origin` **勿推**。
- 快连被短拒时等 1~2 分钟重试。
- 🔴 **本地领先 myrepo 时，绝对不要跑 `deploy/update.sh`**——它的 `git reset --hard origin/<分支>` 会把线上回退到旧 tip。
- 回滚：`rm -rf dist && mv dist.bak dist && systemctl reload nginx`。

## 4. 部署核验（新旧双验，缺一不可）

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://111.229.64.152/          # 期望 200
curl -s http://111.229.64.152/ | grep -oE 'assets/index-[^"]+\.js'       # 入口 hash（与构建日志比对）
curl -sI http://111.229.64.152/assets/DOESNOTEXIST.js | head -1          # 期望 404（缓存策略未破）
```
- 用 `grep -rl "<新文案>" dist/assets/` 定位改动的 chunk，再 `curl` 该 chunk（期望 `200` + `application/javascript`）。
- 必须**双向验证**：`[新]` 特征命中 + `[旧]` 特征 **0 命中**（证明旧代码删干净）。
- 多文件 scp 后**先 verify bundle 内容**（`git bundle verify` / `git bundle list-heads`）再构建。

## 5. GitHub 推送（代理绕过）

```bash
unset *_PROXY
bash local-data/_push_now.sh               # 主线 personal-main-merge-main：IP×后端矩阵，成功即停
bash local-data/_push_branch.sh <branch>   # 非主线；FORCE=1 加 --force-with-lease
bash local-data/_fetch_branch.sh <branch>  # 看分叉：left/right 计数 + 双向提交列表
```
- `local-data/_gh_proxy.mjs` 把 github TLS 引到可达 IP（SNI 仍 github.com）；需与 push 同一条**前台**命令。
- ⚠️ **多分支必须串行**（共用固定端口 19020+i / 19060+i，并行会冲突/输出覆盖）；网络失败**整体重试**，实测第二次常成。
- `! [rejected] (fetch first)` = **引用层问题，不是网络** → fetch myrepo（坏对象加 `--refetch`）→ 看分叉 → `merge --no-ff` → 再推。合并前先看远端有没有**有意下线的功能**。

## 6. 运行时/框架坑

- Vite 开发服务器端口 3000；`pnpm run dev` / `build` / `preview`。
- `pnpm run testr` / `testd` 是老的 token 测试脚本，`testr` 因未配置的 `@utils` 别名**长期失败**，忽略。
- `pnpm exec tsc --noEmit -p tsconfig.app.json`：14 文件 139 错（历史债，非本次引入）。
- `pnpm exec eslint`：当前安装**找不到 eslint 命令** ⇒ lint 无法执行。
- `git diff --check` 在 Windows 上可能因 CRLF 噪音失败；`git diff --check -- ':!*.md'` 更clean。

## 7. [h5web-proxy] 官方 H5 实时反代（三路线，2026-10-06）

**目的**：官方现行 H5（`https://xxz-xyzw-res.hortorgames.com/h5web/`）反代到本站 `/h5web-proxy/`，
HTML 注入本地镜像同款辅助脚本（同源=注入有效）→ **版本永远自动跟随官方周更**，
消灭「每周改 game-defines 两行」的 runtime 校准 SOP。本地 `/game/` 镜像保留为回退。

**注入语义（三端共用，唯一权威 = `scripts/h5web-inject.mjs`）**：
- 唯一锚点 = 完整标签 `<script src="main.2a00e.js" charset="utf-8"></script>`，单次替换注入：
  `[platform-spoof][first-frame-spoof][boot-shim] main标签 [runtime-tweaks][xh][diagnose][push-level-research-bridge]`
- ⚠️ **必须单锚点单规则**：nginx sub_filter 多条规则在**原始流**上匹配，锚点重叠时后一条被抑制
  （10-06 生产踩坑：A 锚点吞了 `main.2a00e.js` 文本导致 B 永不生效；JS 顺序 replace 是链式的，无此问题）。
- boot-shim：`Object.defineProperty(window,'boot',…)` 包装 setter/getter，官方 boot 调用前等
  `__pushResearchSh1Ready`（桥 sha1 就绪），复刻本地镜像内联 boot 的等待语义。
- 注入脚本从 `/game/*` 加载（nginx=本机镜像 / vite=public/game / CF Pages=env.ASSETS 的 dist/game）。

**三条路线**：
1. **nginx（生产，已上线）**：`deploy/nginx-xyzw.conf` → `/etc/nginx/conf.d/xyzw.conf`（备份在服务器同名 .bak.<ts>）。
   `proxy_cache_path /var/cache/nginx/h5web` + `map $upstream_http_content_type $h5web_cache_ctl`
   （HTML→no-cache，其余→immutable 一年）都在 conf.d（http 上下文）里，无需动 nginx.conf。
   缓存目录需预建：`mkdir -p /var/cache/nginx/h5web`（否则 nginx -t emerg）。
2. **Cloudflare Worker（随下次 push 生效）**：`worker.js` proxies 表新增 `/h5web-proxy` 表项
   （`pathPrefix:'/h5web'` + `injectH5Web:true` + `Accept-Encoding: identity`），HTML 注入 /
   非 HTML 走 `caches.default` 边缘缓存；`/game/*` 由 `env.ASSETS`（dist/game）同源服务。
3. **vite dev（本地测试）**：`vite.config.js` 的 `h5webProxyPlugin()` 中间件，dev server 起 `/h5web-proxy/*`。

**GamePlayer**：右上角「镜像 / 官方反代」切换（localStorage `gameplayer:source`），反代=`/h5web-proxy/index.html`。

**限流红线**：只代理静态资源。游戏 WS（wss://xxz-xyzw-new…/agent）与 authuser 登录**浏览器直连官方**
（WS 无同源限制，每用户出口 IP=自己）—— 全员协议流量过服务器 = 单 IP 秒限流 + 封号风险，绝不反代协议。
静态资源加缓存后官方 CDN 每文件只见 1 次请求（比每用户直连更省）。

**验证清单**（三端通用）：`/h5web-proxy/` 200 且 HTML 含 6 个 `/game/*` 注入 + boot-shim；
顺序 A(spoof) < main < B(bridge) < 内联 boot(var debug)；settings/game-defines/main 均 200；
HTML `Cache-Control: no-cache`、资源 `immutable`；`X-H5Web-Inject: on`（vite/worker）/`X-H5Web-Proxy: 1`（nginx）。
**锚点自检**：官方 bundle 若改结构（main hash 变化），三端锚点同步更新（grep `main.2a00e.js`）。

### 7.1 桥内相对路径加载的兜底（10-06 生产首测修复）

push-level-research-bridge 以**相对路径**加载 sha1 库（`sh1.js` / `sh1.readable.js?v=…`，
相对加载全集仅此两个）——镜像页解析到 `/game/` 没问题；反代页解析到 `/h5web-proxy/` 下，官方没有 → 404 →
`__pushResearchSh1Ready` 拒绝 → boot-shim 永不执行 → **白屏卡死**（10-06 首测现象）。
三端修复：① sh1 路径映射到本地镜像（nginx 正则 location `try_files /game/$1`；vite/worker 直接从 public/game / env.ASSETS 供出）；
② boot-shim 改为 resolve/reject 都放行 boot（`then(go,go)`，防未来同类失败再现白屏）。
**教训：注入第三方脚本时，把它的一切相对路径子资源列入反代兜底清单。**

### 7.2 反代 location 必须 `^~`（10-06 生产首测第二坑）

站点级静态资源正则 `location ~* \.(json|png|...)$`（try_files =404）会**抢走** /h5web-proxy/ 下所有
同后缀请求（nginx 规则：正则 location 优先于普通前缀）——Cocos 资源 `assets/**/config.*.json` 全 404，
游戏黑屏（引擎已 boot、资源加载失败）。修复：反代主体 `location ^~ /h5web-proxy/`（压制全部正则），
sh1 兜底改为 `location =`（精确匹配，优先级最高）。
**教训：给"前缀反代"选 location 时，必须审查站点已有正则 location 的后缀表。**
