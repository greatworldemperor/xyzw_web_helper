# 无限重试推送脚本
# 用法: 在仓库目录下运行  .\push_retry.ps1
# 因网络问题可能失败,此脚本会无限重试直到成功。

$ErrorActionPreference = "Stop"

# ---------- 配置 ----------
# 你的 GitHub 账号
$GithubUser = "greatworldemperor"
# 仓库名
$RepoName   = "xyzw_web_helper"
# 目标分支
$Branch     = "feature/flexible-batch-task-template"
# 远程名 (origin 当前指向 w1249178256,这里用一个新的远程名避免混淆)
$RemoteName = "mine"
$RemoteUrl  = "https://github.com/$GithubUser/$RepoName.git"

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $RepoDir

# ---------- 确保远程存在 ----------
$existing = git remote get-url $RemoteName 2>$null
if (-not $existing) {
    Write-Host "[info] 添加远程 $RemoteName -> $RemoteUrl"
    git remote add $RemoteName $RemoteUrl
} else {
    Write-Host "[info] 远程 $RemoteName 已存在: $existing"
}

# ---------- 无限重试 ----------
$attempt = 0
while ($true) {
    $attempt++
    Write-Host ""
    Write-Host "===== 第 $attempt 次尝试推送 ($Branch -> $RemoteName) =====" -ForegroundColor Cyan
    git push -u $RemoteName $Branch
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "===== 推送成功! =====" -ForegroundColor Green
        break
    }
    $wait = 10
    Write-Host "[warn] 推送失败 (exit=$LASTEXITCODE)。$wait 秒后重试..." -ForegroundColor Yellow
    Start-Sleep -Seconds $wait
}
