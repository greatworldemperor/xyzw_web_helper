# 推关研究页（游戏 Runtime 综合分析平台）使用说明

> 适用桥版本：`2026-09-09.1`（此前 `2026-09-07.13` 及更早版本导出的 WSS `rawHex` 存在大帧截断，见文末「已知限制」）
>
> 页面入口：`/admin/push-level-research`（游戏 iframe：`/game/index.html?research=push-level`）

## 1. 页面定位与安全边界

该页面是**只读的运行时观测平台**：把官方游戏 H5 加载到同源 iframe 中，被动记录 HTTP、WebSocket 和运行时事件，用于协议分析、战斗研究。

- 页面**不会主动发送任何游戏业务请求**（如 `fight_startlevel`、`fight_endlevel`、`club_attack` 等）。
- 桥内 `BLOCKED_COMMANDS` 硬性阻止 `battle:start` / `battle:simulate` / `battle:end` 三类命令；`headless:generate` / `headless:submit-bypass` 仅能在 `headless-test=1` 的独立页面且带显式确认标志时运行，普通研究页无法触发。
- 日志会自动脱敏常见凭据字段（token、密码、authorization、openid、ukey 等），但**下载后仍请检查再回传**。

## 2. 使用前置条件

- 需要一个**已保存 BIN** 的账号（选择"研究账号"下拉）或一个 `.bin` 文件（临时导入到内存）。
- 建议在可见浏览器窗口使用。页面隐藏时 Cocos 帧循环会暂停，登录/游戏进程可能不推进。

## 3. 控件说明

### 3.1 头部

| 控件 | 行为 | 说明 |
| --- | --- | --- |
| 运行时状态标签 | 显示 未加载 / 连接中 / 已就绪 / 异常 | iframe 就绪后才可操作其余控件 |
| **重载运行时** | `gameFrame.src` 加时间戳重新加载 iframe | 页面日志保留，iframe 内的桥状态（事件缓冲、hook）全部重置 |

### 3.2 账号与抓包开关

| 控件 | 行为 | 说明 |
| --- | --- | --- |
| **研究账号** | 下拉选择已保存 BIN 的账号 | 切换时自动检查该账号的 BIN 是否可读 |
| **导入到内存** | 选择本地 `.bin` 文件 | BIN 只存当前页面内存，刷新后即失效 |
| **HTTP 抓包** | 开关 → `runtime:http-capture` | 记录 fetch / XHR 请求与响应**摘要**（见 4.2） |
| **WSS 抓包** | 开关 → `runtime:wss-capture` | 记录 WebSocket 帧与协议解码（cmd / seq / ack / body 预览） |
| **原始帧** | 开关 → `runtime:capture` | 在 WSS 事件中附带完整二进制十六进制（`rawHex`）；**必须开启才能拿到完整协议 body** |
| **哈希原文** | 开关 → `runtime:hash-capture` | 安装只读 MD5 hook，记录 `outputCode` / `inputCode` 的哈希输入原文（`hash:matched`） |
| **自动滚动** | 开关 | 新日志自动滚到底部，纯界面行为 |

### 3.3 操作按钮

| 按钮 | 桥命令 | 行为 |
| --- | --- | --- |
| **探测模块** | `runtime:probe` | 探测游戏运行时可用模块（FightService、BattleManager 等），结果写入日志 |
| **载入并登录** | `account:load` | 把选中的 BIN 交给官方上号器（`stageBinData` → 自动重启 iframe → 官方 `LoginManager.login`），完成后状态标签显示"登录完成" |
| **下载全部 / HTTP 日志 / WSS 日志 / Runtime 日志** | — | 按事件前缀分类导出 JSONL（见 4） |
| **清空日志** | — | 清空页面日志（桥内事件缓冲不受影响，页面无直接读取入口） |

只读观测模式标签为常驻提示，非按钮。

## 4. 日志格式

### 4.1 JSONL 结构

每个下载文件首行是元数据头，之后每行一个事件：

```jsonc
// 头部
{
  "format": "xyzw-runtime-analysis-jsonl",
  "version": 2,
  "category": "all | http | wss | runtime",
  "downloadedAt": "...",
  "bridgeVersion": "2026-09-09.1",
  "mode": "passive-capture",
  "selectedToken": { "id": "...", "name": "...", "server": "..." },
  "captureHttp": true,
  "captureWss": true,
  "captureRawFrames": true,
  "captureHashPreimages": false,
  "captureStats": { "httpEvents": 0, "wssEvents": 0, "runtimeEvents": 0, "hashMatches": 0, "errors": 0 },
  "eventCount": 30
}
// 事件行示例（WSS）
{ "id": 1083, "source": "iframe", "event": "ws:send", "at": "...", "payload": {
    "url": "wss://.../agent", "frame": { "kind": "arraybuffer", "byteLength": 270, "headHex": "7078...", "scheme": "px", "rawHex": "7078..." },
    "decoded": { "ack": 0, "seq": 50, "cmd": "club_attack", "time": 1788862524922, "body": { "kind": "typed-array", "byteLength": 202, "headHex": "0807..." } } } }
```

### 4.2 各类日志的内容与裁剪规则

| 分类 | 事件前缀 | 内容 | 裁剪规则 |
| --- | --- | --- | --- |
| HTTP | `http:request` / `http:response` / `http:error` | 方法、URL（去 query）、请求/响应头、响应体摘要 | 非 JSON 文本只保留前 **4000** 字符并标记 `truncated`；JSON 响应体按摘要裁剪（深度 ≤ 6、对象键 ≤ 400、数组 ≤ 400），字符串字段上限 **262144**（2026-09-09.1 起）；二进制响应不记录 body |
| WSS | `ws:open` / `ws:send` / `ws:message` / `ws:close` / `ws:error` | 帧摘要 + 协议解码 + 原始帧 | `headHex` 只预览前 64 字节；`decoded.body.headHex` 只预览 body 前 64 字节；开启「原始帧」后 `rawHex` 为完整二进制十六进制（上限 256KB 帧，2026-09-09.1 起不再被 12000 字符截断） |
| Runtime | `bridge:ready`、`module:require`、`runtime:state`、`runtime:capabilities`、`account:*`、`hash:*`、`battle:*`、`console:*`、`page:*` 等 | 运行时探测、账号登录、哈希捕获、控制台与异常 | 同 HTTP 的 JSON 摘要规则 |

### 4.3 事件缓冲上限

- 桥内事件缓冲：**5000 条**（页面实时接收，不影响导出）。
- 页面日志缓冲：**10000 条**（超出后最早的被丢弃）。
- 页面列表只显示最近 **500** 条（可用搜索框筛选）。

## 5. 推荐工作流

1. **选择账号**（或导入临时 `.bin`）。
2. **载入并登录**，等待状态变为"登录完成"。
3. 按需打开 **WSS 抓包**（研究协议必开）、**原始帧**（要完整 body 必开）、**HTTP 抓包**、**哈希原文**。
4. 在 iframe 内**手动操作游戏**（如打一次营地挑战、推一关），页面会自动记录事件。
5. 点 **WSS 日志** / **HTTP 日志** 分别下载，用分析脚本（如 `local-data/analyze_camp_data.mjs` 的 px 解密 + BON 解码）离线还原。

## 6. 已知限制与注意点

1. **WSS `rawHex` 截断（已修复）**：桥版本 ≤ `2026-09-07.13` 时，`summarize` 对超过 12000 字符的字符串统一截断并追加 `"...[truncated]"`，导致**超过约 6000 字节的帧**（如 7KB 的 `Club_AttackResp`、16KB 的 `Club_GetInfoResp`）完整二进制丢失。`2026-09-09.1` 起 `rawHex` 使用独立上限（256KB 帧），普通长字符串仍受 12000 保护。**升级桥后需强制刷新页面**才能生效；此前导出的截断文件无法恢复。
2. **HTTP 没有"原始响应体完整保留"开关**：HTTP 日志是摘要式设计（见 4.2），需要完整响应体时建议从 WSS 协议命令侧获取，或对目标接口单独抓包。
3. **`decoded.body` 只有 64 字节预览**：完整协议 body 只存在于 `rawHex`（需开启「原始帧」），解析方式为 `px` 帧 XOR 去头后 BON 解码（`pl` 帧走 LZ4/XOR）。
4. **脱敏是启发式的**：下载前应检查 `roleToken`、头像 URL 等字段；如需回传请先自行审查。
5. **登录依赖 BIN**：选择账号时若提示"无 BIN"，需先在 Token 导入页为该账号保存登录 BIN。
