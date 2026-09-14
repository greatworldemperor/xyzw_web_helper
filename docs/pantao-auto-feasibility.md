# 自动蟠桃园可行性分析

> 数据来源（三路对照）：
> ① HTTPCanary 真实环境抓包 `local-data/pantao/batch{1,3,4}/*.bin`（2026-09-13 周日，官方客户端，每帧独立保存，248 个文件去重后 55 唯一帧）
> ② 本项目 H5 环境抓包 `local-data/pantao/pantao_fail_to_enter.jsonl`（bridge 产出，push-level-research 页面，17 事件）
> ③ 参考脚本 `scripts/全自动蟠桃园.js`（LEGION_PAYLOAD 模块注入式 userscript）+ 既有盐场分析 `docs/saltfield-deploy-team-enter-feasibility.md`
>
> 解码与验证产物：`local-data/pantao-analysis/`（`_pantao_decoded.txt` 全帧解码、`_pantao_uniq.txt` 去重时间线、`_verify_bins.txt` 复现验证、`decode_bins.mjs` / `dedupe_bins.mjs` / `verify_bins.mjs`）

---

## 0. 一句话结论

**部分具备条件。** 协议基础设施（主连接、BON 编解码、命令注册框架）与入口链（查战场 → 进战场 → 布阵）已经打通：`payload_enterbf` / `payload_setbattleteam` 两条核心命令的线格式已从官方客户端抓包中逐字节还原并复现验证通过，且官方客户端下**全链成功**。但有两个硬缺口：

1. **客户端校验风险（唯一硬性风险，无法离线验证）**：H5 环境（`h5web` 口径）发 `payload_setbattleteam` 被 **3000070** 拒绝；本项目 WS 用 `mix` 口径在盐场 `war_*` 写命令上全过、在蟠桃任务领取上也在产线正常，但 `payload_enterbf` / `payload_setbattleteam` 这类"进战场写命令"**未实测**。只有周日活动窗口能验证。
2. **战斗动作协议全部缺失**：HTTPCanary 逐条保存漏掉了 20:00:08–20:21:38 的整段战斗流量——行军/攻击/上车/拾取/车辆道具/复活等命令的 cmd 名与请求体一个都没抓到，而这些正是"自动蟠桃"的主体。

---

## 1. 活动机制速览（本次抓包确认）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 活动窗口 | 周日晚，**战场 20:00 整开始（`state:"started"` 推送 20:00:00.203）**，主连接 20:29:21 被服务端断开（`conn timeout`），与 PeachInfoV2 代码注释"Sunday 18:00-20:30"吻合 → 战斗约 30 分钟，18:00 起可查询/准备 | batch3/batch4 帧时间 |
| 战场实例 | `bfId = "YYMMDD:实例号"`（本次 `"260913:14517"`；同日另一俱乐部为 `"260913:14323"`）→ **按日期+对战俱乐部对分配，无法预测，必须运行时获取** | batch3 / H5 抓包 |
| 连接结构 | 蟠桃战场用**独立 WSS 连接**（batch3 的 seq 从 1 重新计数，命令带 `hint=bfId`），与盐场战场连接同构；主连接用 `legion_getpayloadbf`（空 body）查战场信息 | batch1 seq=64 vs batch3 seq=1 |
| 布阵内容 | `payload_setbattleteam { bfId, battleTeam Map<槽位,heroId>, lordWeaponId, petUId }`，与盐场 `war_setbattleteam` 同款；官方客户端布阵前调了 `hero_calcpowerbyteam`（同一阵容、petUId 传空串）与 `presetteam_getinfo` | batch1 seq=65 / batch3 seq=2 |
| 登场确认 | `Payload_SetBattleTeamResp`（**无 `resp` 字段，靠 `ack=客户端seq` 匹配**，同盐场广播式）：`bf.roles[roleId].state → "idle"` + `tileDataMap.tileData["22_10"].memberMap`（即落点坐标 x=22,y=10） | batch3 响应帧 |
| 任务体系 | `Legion_GetPayloadTaskResp`：`payloadTask{ phase:"2609", taskMap{typ:1..35}, legionPoint, selfPoint }`；战斗中服务端推 `Task_PayloadNotify{id:24}`。项目已有 `batchClaimPeachTasks`（`legion_getpayloadtask`/`legion_claimpayloadtask`/`legion_claimpayloadtaskprogress`）在产线运行 | batch1/batch4 |

## 2. 已还原协议（逐字节复现验证 19/19 通过）

对全部 55 唯一帧跑「解码 → 重建 → 逐字节比对」：**19 种命令全部精确**（`_verify_bins.txt`），包括两条核心写命令：

```
payload_enterbf        : OK 逐字节一致   body={bfId:"260913:14517"}  hint=bfId
payload_setbattleteam  : OK 逐字节一致   body={bfId, battleTeam Map{0:116,1:102,2:112,3:107,4:106},
                                          lordWeaponId:9, petUId:"92-4AU"}  hint=bfId
legion_getpayloadbf    : OK 逐字节一致   body={}（主连接）
```

信封与编码同盐场：`px` 头 + `x` 方案 + BON，`body` 为嵌套 BON（tag 7），心跳为 1 字节 `0x00`。项目 `bonProtocol.js` / `CommandRegistry` 的 `hint` 绑定机制可直接复用。

主连接周边命令（官方客户端开场序列）：`legion_getinfo`、`legion_getpayloadbf{}`、`hero_calcpowerbyteam{battleTeam,lordWeaponId,petUId:""}`、`presetteam_getinfo{}`、`rank_getroleinfo{roleId,bottleType:0,includeBottleTeam:false,isSearch:false}`、`bottlehelper_getinfo{}`（后两个属宝瓶玩法，与蟠桃战斗无关）。

## 3. 官方客户端真实时序（2026-09-13 周日）

| 时间(CST) | 连接 | 动作 | 结果 |
| --- | --- | --- | --- |
| 19:59:47–20:00:04 | 主连接 | `legion_getinfo` → `legion_getpayloadbf` → `hero_calcpowerbyteam` → `presetteam_getinfo` | 全部成功 |
| 19:59:51.9 | 战场连接(seq=1) | `payload_enterbf{bfId}` | 5s 后 `_sys/ack` 确认 |
| 20:00:00.2 | 战场连接 | `Payload_StateChangeNotify{bf:{state:"started"}}` | 战斗开始 |
| 20:00:08.1 | 战场连接(seq=2) | `payload_setbattleteam{...}` | **86ms 内成功**，`state:"idle"`，落点 tile (22,10) |
| 20:00:08–20:21:38 | — | **【整段战斗流量缺失】** 行军/攻击/上车/拾取/道具 | ❌ 未保存 |
| 20:21:38–20:29:21 | 主连接 | 仅心跳/ack/聊天推送/`Task_PayloadNotify{id:24}`/`Activity_GetResp` | 20:29:21 `conn timeout` |

H5 环境对照（同一晚 20:00:35，本项目 push-level-research 页面，`h5web` 口径）：`hero_calcpowerbyteam` ✅、`Payload_CarMoveNotify` 推送 ✅ 能收（说明 H5 连接能进战场 UI 收推送），但 `payload_setbattleteam` → **`code 3000070`「检测到您使用的客户端数据异常，请使用官方最新客户端」**，重试同样被拒。

## 4. 3000070 风险归因（关键闸门）

| 客户口径 | 盐场 `war_setbattleteam`(登场) | 盐场 `war_startbattle`(攻击) | 蟠桃 `payload_setbattleteam`(布阵) | 蟠桃任务领取 |
| --- | --- | --- | --- | --- |
| 官方客户端 | — | — | ✅ 成功（本次抓包） | — |
| H5 `h5web`（游戏 iframe） | ✅（09-12 抓包） | ❌ 3000070 | ❌ 3000070（09-13） | — |
| 本项目 WS `mix` | ✅ 产线验证 | 未测 | **❓ 未测（本次问题的核心）** | ✅ 产线运行 |

结论：
1. 蟠桃族的客户端校验**比盐场严格**——`h5web` 连"布阵"都过不了（盐场下 `h5web` 可登场、可行军，只是攻击被拒）。
2. 本项目 `mix` 口径是目前最有希望的非官方口径：盐场全部写命令（除攻击）都过，蟠桃读命令+任务领取也过。但**"进战场写命令"是否放行无法离线推断，必须周日实战一次 `payload_enterbf` 才能定**。
3. 若 `mix` 被拒，轻量协议路线对蟠桃基本宣告不可行（与盐场不同，蟠桃没有"能进场但不能打"的中间态），届时只能保留任务领取/信息展示类自动化。

## 5. 缺失清单（决定自动化能做多少）

| # | 缺失项 | 影响 | 补齐方式 |
| --- | --- | --- | --- |
| 1 | `legion_getpayloadbf` **响应**体 | 不知道 bfId 和战场票据（是否含 `info.sid` 供 `sid2=` 连入，同盐场）从哪取；项目 PeachInfoV2 只用过其中的 `legions[0/1].id` | 下次抓包必抓；或活动期间用项目 WS 发一条实测 |
| 2 | `Payload_EnterBfResp`（进战场大快照） | 战场数据模型（roles/carMap/itemMap/tileDataMap/constant）在线格式里的真实形态未知；H5 推送只见识了 `bf.carMap` 一个切片 | 下次抓包必抓 |
| 3 | 战斗动作命令（行军/攻击/上车/拾取/车辆道具/复活）的 cmd 与请求体 | **自动化主体缺失**。参考脚本给出模块方法名（`sendMarch`/`sendGetCar`/`sendBattle`/`sendPickItem`/`sendUse`/`startBattle`），推测 cmd 形如 `payload_march`/`payload_getcar`/`payload_startbattle`…，但 body 无法凭空构造 | 下次抓包：每个动作前后各留 5–10s 帧 |
| 4 | `mix` 口径过不过 payload 写命令 | 决定整条轻量路线生死 | 下周日 20:00 前用项目 WS 实测 `payload_enterbf` |

参考脚本本身（`全自动蟠桃园.js`）**不能直接用**：它跑在游戏 H5 运行时里（`__require('ModuleManager')`），而该路线的 `payload_setbattleteam` 已实测 3000070。它的价值是"字典"：方法名 ↔ 数据结构（`lPWarData.battlefield{self,roles,carData,itemData}`、`lpMatchDay.stage`、复活字段 `reviveTime`），是下次抓包时定位 cmd 与解析响应的对照钥匙。

## 6. 若条件补齐后的落地草案（轻量路线，复用盐场骨架）

1. `xyzwWebSocket.js`：`legion_getpayloadbf` 已注册 ✅；新增 `payload_enterbf` / `payload_setbattleteam`（+后续动作命令）——战场连接可整体复用 `XyzwLegionWarWebSocketClient`（`sid2` 票据机制待缺失项 #1 确认是否同盐场）。
2. 布阵素材：`role_getroleinfo` 的 `battleTeam`/`lordWeaponId`/`pet.petUId`（盐场已验证的同款转换，`Map<槽位,heroId>`；本次抓包再次确认官方布阵 = 主阵容口径）。
3. 编排层：活动窗口（周日 20:00 前）→ `legion_getpayloadbf` 取 bfId → 战场连接 `payload_enterbf` → 等 `state:"started"` → `payload_setbattleteam` →（缺失项 #3 补齐后）上车/攻击/拾取循环 + 复活重试。
4. 响应匹配：`Payload_SetBattleTeamResp` 无 `resp` 字段，按 `ack` 匹配（同盐场广播式，勿用序号 Promise 匹配）。
5. UI：复用盐场队长入口形态（TokenImport 工具栏下拉 + 独立路由页）。

## 7. 下次抓包指引（2026-09-20 周日）

- **最优先**：`legion_getpayloadbf` 的响应、`payload_enterbf` 的响应（两个大快照）。
- **其次**：战斗期每个动作（移动一段、攻击一次、上/下车、拾取一个、用一次车辆道具、死亡复活）前后 5–10 秒的帧。
- HTTPCanary 逐条保存漏帧太严重（本次 248 个文件里 193 个是重复/心跳/聊天）：若工具支持，**一次性整段导出**；或分小段（每个动作一段）而不是逐消息保存。另外注意 bin 文件名时间戳是"导出时间"而非抓包时间（本批平均晚约 30 分钟），排序请以帧内 `time` 字段为准。
- 抓包同时，用项目 WS 发一条 `payload_enterbf`（bfId 从 PeachInfoV2 同款调用拿 `legions` 后再想办法，或先只发空 body 看 code）——直接验证 §4 的核心闸门。

## 8. 平台伪装工具（3000070 归因验证，2026-09-14 新增）

针对 §4 的核心闸门，已实现 H5 环境的 platformExt 覆写工具，可在**不放弃 bridge 抓包**的前提下把上报口径改成受信任值：

**关键事实链**（实现依据）：
- `game-defines.a175e.js` 第 4 行 `gt.PLATFORM = 'h5web'`（第 13 行 `gt.GAME_VERSION = '1.89.8-wx'`）是全入口唯一来源；游戏逻辑包（CDN 加载）在运行时读该全局拼装 WS 请求体。
- 账号 bin（如 wechat.bin）解码后 `platformExt: "mix"` —— **authuser 登录请求本就上报 mix**，而战场仍标记 `hortor-h5web` ⇒ 服务端 loginPlatform 取自 **WS 请求体上报的 platformExt**，覆写该全局即命中要害。

**实现**（5 处）：
1. `public/game/platform-spoof.js`（新增）：在 game-defines 之后、main/cocos/CDN 之前执行，按 localStorage 配置覆写 `window.PLATFORM`（可选 `GAME_VERSION`）；默认关闭，完全无副作用。暴露 `window.__xyzwPlatformSpoof = {KEY, read, write, clear, applied}`。
2. `public/game/index.html` + `public/game/multi-game.html`：脚本链在 `game-defines.a175e.js` 之后插入 `platform-spoof.js?v=20260914.2`；普通运行时读取 `xyzwPlatformSpoof`，批量运行时读取独立的 `xyzwMultiGamePlatformSpoof`。
3. `src/views/PushLevelResearch.vue`：控制卡新增「平台伪装」开关 + 「伪装目标」选择（mix 推荐 / h5），落盘 localStorage 并提示"重载运行时后生效"。
4. `src/views/GameMultiPlayer.vue`：批量运行时新增独立「平台伪装」开关、目标选择和「重载全部窗口」按钮；配置修改后写入每个账号的隔离存储。
5. `src/utils/gameLauncher.js`：批量启动时将批量伪装配置种入每个 `multi-game:<scope>:` 账号空间，不读取研究页配置。

**验证步骤**（下次战斗窗口，周日 20:00 蟠桃 / 盐场开战）：
1. 研究页开启「平台伪装」（目标 mix）→ 重载运行时 → 载入并登录，开 WSS 抓包；批量页需单独开启批量窗口内的开关，两者互不影响；
2. **立即验证伪装生效**：抓到的 `role_getroleinfo` 等请求体 `platformExt` 应为 `"mix"` 而非 `"h5web"`（research bridge 的 jsonl 里有 decoded body，直接可查；不生效则说明还有别的上报通道，回退本节重新归因）；
3. 等开战执行布阵（`payload_setbattleteam`）或盐场 `war_startbattle`：**不再返回 3000070 ⇒ 证实 h5web 口径是触发原因**，且项目 H5 环境从此可用于战斗动作抓包（解决 §7 的补抓困境）；若仍 3000070 ⇒ 平台假设排除，转向 clientVersion 或其它指纹（此时可经 `__xyzwPlatformSpoof.write({gameVersion:"2.21.2-fa918e1997301834-wx"})` 做第二变量实验）。

**风险与回退**：开关关闭即恢复原始口径；mix 口径为官方主流值（盐场 369/436 人），游戏逻辑包按 `GAME_ID='xyzw_mix'` 构建，理论上兼容，但若伪装后游戏功能异常，先回退再报告。默认不动 `GAME_VERSION`（单变量原则，避免影响资源热更判断）。

---

_分析脚本与解码产物：`local-data/pantao-analysis/`（可对任意新增 bin 重跑 `decode_bins.mjs` → `dedupe_bins.mjs` → `verify_bins.mjs`；`_verify_spoof.mjs` 为伪装工具行为验证 17 项断言）_
