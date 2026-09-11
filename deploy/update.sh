#!/usr/bin/env bash
#
# xyzw_web_helper — 服务器手动更新（在服务器上直接运行）
# 用法：sudo bash /opt/xyzw_web_helper/deploy/update.sh
#
# 说明（与本机 111.229.64.152 实际环境对齐）：
#   - 代码目录 /opt/xyzw_web_helper 本身即 git 仓库
#   - nginx 站点根直接指向 /opt/xyzw_web_helper/dist（构建产物原地生效，无需拷贝）
#   - node/pnpm 由 nvm 管理，非交互式 shell 不会自动加载，脚本内显式 source
#
set -euo pipefail

APP_DIR="/opt/xyzw_web_helper"
BRANCH="personal-main-merge-main"   # 与仓库当前分支一致

# ---- 加载 nvm / pnpm ----
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"

echo "==> node $(node -v) / pnpm $(pnpm -v)"

cd "$APP_DIR"

echo "==> 拉取最新代码 ($BRANCH)"
git fetch origin "$BRANCH"
# 服务器为纯部署目录：强制对齐远程，避免本地手改导致冲突
git reset --hard "origin/$BRANCH"
echo "    当前提交：$(git log -1 --oneline)"

echo "==> 安装依赖"
pnpm install --frozen-lockfile

echo "==> 备份当前 dist（构建失败可回滚）"
rm -rf "$APP_DIR/dist.bak"
cp -r "$APP_DIR/dist" "$APP_DIR/dist.bak" 2>/dev/null || true

echo "==> 构建（vite build → dist/，nginx 直接托管）"
pnpm build

echo "==> 校验产物"
test -f "$APP_DIR/dist/index.html" && echo "    dist/index.html OK"

echo "==> 重载 nginx"
nginx -t && systemctl reload nginx

echo "==> 完成：$(date '+%F %T')  commit=$(git rev-parse --short HEAD)"
