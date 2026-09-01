# 无限重试推送脚本：应对 GitHub 连接不稳定
# 用法:
#   .\push_retry.ps1                    # 推送 main 到 myrepo
#   .\push_retry.ps1 -Branch dev        # 推送其他分支
#   .\push_retry.ps1 -Remote origin     # 推送到其他远程
#   .\push_retry.ps1 -Force             # 非快进时强制推送(仅推自己的仓库时使用)
param(
    [string]$Remote = "myrepo",
    [string]$Branch = "main",
    [int]$IntervalSeconds = 5,
    [switch]$Force
)

$extra = @()
if ($Force) { $extra += "--force" }

$attempt = 0
while ($true) {
    $attempt++
    Write-Host "[尝试 #$attempt] 推送 $Branch -> $Remote ..." -ForegroundColor Cyan
    git push $Remote $Branch @extra
    if ($LASTEXITCODE -eq 0) {
        Write-Host "推送成功（共尝试 $attempt 次）。" -ForegroundColor Green
        exit 0
    }
    Write-Host "失败，$IntervalSeconds 秒后重试 (Ctrl+C 停止)..." -ForegroundColor Yellow
    Start-Sleep -Seconds $IntervalSeconds
}
