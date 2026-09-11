# xyzw_web_helper 部署说明（手动更新版）

服务器：`111.229.64.152`（腾讯云，OpenCloudOS 9.4，nginx 1.26.3）

## 线上实际结构

| 项目 | 位置 |
|------|------|
| 代码目录（git 仓库） | `/opt/xyzw_web_helper` |
| 分支 | `personal-main-merge-main` |
| 远端 | `https://ghfast.top/https://github.com/greatworldemperor/xyzw_web_helper.git` |
| nginx 站点配置 | `/etc/nginx/conf.d/xyzw.conf`（RHEL 风格，无 sites-enabled） |
| 站点根（静态托管） | `/opt/xyzw_web_helper/dist` ← 构建产物**原地生效**，无需拷贝 |
| node / pnpm | nvm 管理，node v22.22.0 / pnpm 10.32.1（`/root/.nvm`） |

> ⚠️ nginx 配置内含 4 个 `/api` 反代（微信扫码、微信登录、手机号验证码、Hortor 登录）。
> 改动该文件时**必须保留这些 location**，否则线上接口失效。备份见 `deploy/nginx-xyzw.conf`。

## 日常更新（一条命令）

```bash
sudo bash /opt/xyzw_web_helper/deploy/update.sh
```

脚本做的事：`加载 nvm → git fetch + reset --hard origin/<分支> → pnpm install → pnpm build → 校验 dist/index.html → reload nginx`。

## 登录服务器

```bash
ssh -i <你的私钥> root@111.229.64.152
```

## 手动分步（等同 update.sh）

```bash
cd /opt/xyzw_web_helper
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"   # 关键：加载 node/pnpm
git fetch origin personal-main-merge-main
git reset --hard origin/personal-main-merge-main
pnpm install --frozen-lockfile
pnpm build
nginx -t && systemctl reload nginx
```

## 未来迁移 Cloudflare Pages

本项目已产出 `dist/_worker.js`（`vite.config.js` 自动拷贝 `worker.js`），天然适配：

1. Cloudflare Dashboard → Pages → 连接 GitHub 仓库 `greatworldemperor/xyzw_web_helper`
2. Build command：`pnpm build`，Build output directory：`dist`，环境变量 `NODE_VERSION=20`
3. 之后每次 push 自动构建发布，无需再维护这台服务器。
4. 注意：若迁 CF，`/api/*` 反代需改为 Cloudflare Functions 或 Workers，不能沿用 nginx。

## 备注

- 服务器上另有一份旧克隆 `/root/xyzw_web_helper`（remote 是直连 github，非加速镜像），非当前线上目录，可忽略或清理。
