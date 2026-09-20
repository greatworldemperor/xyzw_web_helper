# 3000070 归因验证：runtime 首帧口径改写

> 目标：证明（或证伪）**「服务端按 WS 首帧上报的 `platformExt` / `clientVersion` 拦截战斗类动作」**这个猜测。
> 现状（2026-09-21）：猜测**未证实**。要证实必须做到——在游戏 runtime 里成功执行「盐场攻击敌人」或「蟠桃布阵上场」。

## 1. 为什么要改帧，而不是改全局

| 方案 | 做法 | 结论 |
|---|---|---|
| `platform-spoof.js` | 覆写 `window.PLATFORM` | ❌ 网页环境能登录的只有 `h5` / `h5web`；`mix` 不是 `_platformExtMapping` 的 key（getter 抛错），`wx` 会切到 App SDK 登录分支（网页无桥，卡死） |
| **`first-frame-spoof.js`** | hook `WebSocket.prototype.send`，直接改帧字节 | ✅ 与登录口径解耦，想上什么口径就写什么 |

游戏 runtime 首帧实测（`pantao1/role_login.jsonl`）：

```
cmd=role_getroleinfo
body = { platform:"hortor", platformExt:"h5", inviteUid:0,
         clientVersion:"1.89.8-wx", scene:"" }
```

真实客户端（项目协议客户端 `bonProtocol.js` 的注册口径）上报的是：

```
platformExt:"mix"   clientVersion:"2.21.2-fa918e1997301834-wx"
```

## 2. 帧格式与就地替换

```
帧 = px 头(70 78 + 2 字节 key material) + XOR(数据段) + BON
```

XOR key `t` 由头里第 3、4 字节每隔 2 位取 1 位拼出；加密时**保留原 4 字节头**，因此服务端算出的 `t` 不变。

首帧明文（tag7 = 带长度的 bytes，包着嵌套 BON）：

```
08 05
  05 03 "ack"          01 00000000
  05 04 "body"         07 58 <88 字节嵌套 BON>
  05 04 "time"         02 …
  05 03 "seq"          01 01000000
  05 03 "cmd"          05 10 "role_getroleinfo"
```

嵌套 BON 内：

```
05 08 "platform"       05 06 "hortor"
05 0b "platformExt"    05 02 "h5"          ← 替换目标
05 09 "inviteUid"      01 00000000
05 0d "clientVersion"  05 09 "1.89.8-wx"   ← 替换目标
05 05 "scene"          05 00 ""
```

**替换算法（不重编码整帧，只动必要字节）**：

1. XOR 解出明文 → 解析 BON（记录每个节点的字节区间）
2. 找到目标 key 的值节点，要求它是 **tag5 字面量字符串**（tag99 引用时安全跳过，不改）
3. 生成新的 `tag5 + varint(len) + utf8` 字节，就地替换
4. **自内向外修正所有包住它的 tag7 长度字段**（body 是 tag7，长度必须同步；varint 变长时会重建字节数组）

其余字节原样不动 —— 比「解码成对象再重编码」安全得多（int64/float/未知 tag 都不会被改写）。

## 3. 开关

| 场景 | localStorage key |
|---|---|
| 单开 runtime（`game/index.html`，研究页） | `xyzwFrameSpoof` |
| 多开 runtime（`game/multi-game.html`） | `xyzwMultiGameFrameSpoof`（每个窗口经 storage bridge 独立隔离，宿主写入时同步 `multi-game:<scope>:` 前缀副本） |

```json
{
  "enabled": true,
  "observeOnly": false,
  "rules": [
    { "cmd": "role_getroleinfo",
      "fields": { "platformExt": "mix",
                  "clientVersion": "2.21.2-fa918e1997301834-wx" } }
  ]
}
```

- `enabled=false` / 键缺省 → 完全不安装 hook。
- `observeOnly=true` → **只记录不改字节**：用来先确认字段确实在帧里、现值是什么。
- `rules[].cmd` 为空串表示匹配所有命令（需要给其它命令加字段时用）。
- 脚本必须在游戏逻辑建连前执行 —— 已排在 `platform-spoof.js` 之后、`main.js` / `cocos2d` 之前。

宿主 API（同源页面可直接读）：

```js
gameFrame.contentWindow.__xyzwFrameSpoof
// { read, write, clear, applied, stats, records, patchFrame, pxDecrypt, pxEncrypt, readCmd, _debug }
// stats = { frames, parsed, matched, patched, failed }
// records = [{ at, cmd, applied|observed, changes: [{key, from, to}] }]（最多 20 条）
```

## 4. 下周盐场验证 SOP

1. **先用只观察模式校准**：研究页 → 首帧改写开启 + 「只观察」开启 → 重载运行时 → 载入并登录
   → 「读取改写状态」→ 确认 `命中 >= 1`，日志里 `frame-spoof` 记录的 `from` 是 `h5` / `1.89.8-wx`。
   - 如果 `命中=0`：说明首帧不是 `role_getroleinfo` 或字段不在帧里，先看日志再继续。
2. **关掉只观察**，重载运行时再登录一次 → 确认 `改写 >= 1`。
   - 同时开着 WSS 抓包，抓到的 send 帧里 `platformExt` 应为 `mix`。
3. **开战后在 runtime 里执行战斗类动作**（盐场攻击敌人），对照三次结果：

| 现象 | 结论 |
|---|---|
| 改写生效、**仍 3000070** | ❌ 口径不是原因 → 拦的是别的（战斗类型/目标合法性/命令结构），转去对比真实客户端命令结构 |
| 改写生效、**不再 3000070**（动作成功） | ✅ 证实口径是原因 → 后续把口径固化到项目客户端 |
| 改写未生效（改写=0） | 工具没跑起来，回到步骤 1 |

4. 把 WSS 日志 + `frame-spoof` 记录一起下载留档。

## 5. 已知边界

- 只改 **send** 帧，不改接收帧。
- 非 px 头（不是 `70 78`）、解析失败的帧 → 原样放行，不抛错。
- 值是 tag99（字符串引用）或不是字符串 → 跳过该字段。
- 除 `role_getroleinfo` 外，登录/鉴权（authuser）走的是别的通道；若步骤 3 仍失败，下一步要确认服务端是不是在**登录时**就记住了口径（那需要连登录请求一起改）。

## 6. 代码位置

| 文件 | 作用 |
|---|---|
| `public/game/first-frame-spoof.js` | 注入脚本（hook + 就地替换 + 配置） |
| `public/game/index.html`、`public/game/multi-game.html` | 加载顺序：`platform-spoof.js` 之后、`main.2a00e.js` 之前 |
| `src/views/PushLevelResearch.vue` | 研究页开关（单开）：启用/只观察/口径 + 「读取改写状态」 |
| `src/views/GameMultiPlayer.vue` | 多开页开关：启用/只观察（批量独立配置） |
| `src/utils/gameLauncher.js` | 多开启动时把配置复制到每个窗口的隔离空间 |
| `test/firstFrameSpoof.test.js` | 12 个用例，含「改写后仍能被项目 BON 库正确解码」的交叉验证 |
| `test/multiGameBootstrap.test.js` | runtime 加载清单（新增脚本后必须同步 `expectedRuntimeFiles`） |
