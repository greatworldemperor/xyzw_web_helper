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

# ③ scp（🔴 多文件 scp 有时传旧包！务必单独重传 bundle 并 verify）
scp -i $KEY local-data/_deploy.bundle local-data/_remote_deploy.sh root@111.229.64.152:/tmp/

# ④ 服务器构建
$SSH "cp /tmp/_remote_deploy.sh /tmp/deploy_build.sh && bash /tmp/deploy_build.sh"
#   脚本内部：fetch bundle → reset --hard FETCH_HEAD → pnpm i → build → nginx reload
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
