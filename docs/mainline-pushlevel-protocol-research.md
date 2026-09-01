# 主线推关（pushLevel）协议抓包研究

> 首次记录：2026-08-30
>
> 本文基于 `captures/push_level` 一批本地抓包（第 3 关打完进入第 4 关的完整过程，共 26 个 bin 帧），使用根目录 [decode_captures.mjs](../decode_captures.mjs)（x 方案解密 + BON 解码）解析，并与当前仓库源码交叉验证。角色 ID 等账号身份数据不做原值记录。
>
> 本文明确区分已验证事实、合理推断和待确认内容。

## 1. 结论

主线推关是**客户端权威战斗**：服务器下发战斗数据（随机种子、双方阵容），客户端本地模拟整场战斗，再提交战报，用 `outputCode` 防作弊校验码证明战斗按指定种子真实进行。

当前项目**没有**推关功能。协议链路已基本摸清，唯一堵点是 `fight_endlevel.body.outputCode` 的生成算法——战斗结算模块是游戏运行时动态加载的资源包，仓库内 [src/xyzw/index.js](../src/xyzw/index.js) 搜不到 `outputCode`、`tapTimes`、`fight_endlevel` 任何字样。

推关与换皮闯关（`towers_start`/`towers_fight`，服务端直接结算、无战报）机制完全不同，不能复用。

## 2. 已验证的协议流程

抓包中一次成功推关（第 3 关 → 第 4 关）的有效序列（按消息内 `time` 排序，重复帧已去重）：

```text
客户端                              服务器
  │ fight_startlevel  (seq 24, body: {})          │
  │ ────────────────────────────────────────────► │
  │                                               │
  │                    Fight_StartLevelResp (resp: 24/27)  ← 本关战斗数据
  │ ◄──────────────────────────────────────────── │
  │                                               │
  │ (客户端本地模拟战斗，无网络包)                    │
  │                                               │
  │ fight_endlevel  (seq 26)                      │
  │ ────────────────────────────────────────────► │
  │                                               │
  │ (约 0.07s 后，不等结算展示)                      │
  │ fight_startlevel  (seq 27, body: {})          │
  │ ────────────────────────────────────────────► │
  │                                               │
  │                    Fight_StartLevelResp (resp: 27, levelId: 4)
  │ ◄──────────────────────────────────────────── │
```

要点：

- `fight_startlevel` 恒定空 `body: {}`，服务器自动返回**下一关**的战斗数据；关卡进度由服务器维护。
- `fight_endlevel` 发出后客户端立即请求下一关，说明服务器已在 endlevel 时结算通过。

### 2.1 Fight_StartLevelResp（已验证，抓包实测）

```js
{
  resp: 27,                       // 对应请求 seq
  cmd: "Fight_StartLevelResp",
  body: {
    battleData: {
      randomSeed: 1677,           // 本场战斗随机种子
      version: 240514,            // 战斗协议版本
      leftTeam: {                 // 我方
        roleId: "721****022",
        tapAttack: 54,            // 点击攻击力（tap 类战斗）
        lordSkill: [],
        levelWeaponSkillId: [],
        petPassiveSkillIds: []
      },
      rightTeam: {                // 敌方怪物，key 为场上格位 index
        "12": { id: 100052, type: 1, index: 12, level: 4, /* 其余字段全 0 */ },
        "14": { id: 100053, type: 1, index: 14, level: 4 },
        "27": { id: 4,      type: 1, index: 27, level: 4 }
      },
      options: {
        levelId: 4,               // 本关关卡号
        autoSpeed: 100,
        IsActLevel: 0             // 0 = 主线关卡
      }
    }
  }
}
```

### 2.2 fight_endlevel 战报（已验证，抓包实测）

```js
{
  ack: 26, seq: 26,
  cmd: "fight_endlevel",
  body: {
    levelId: 3,                          // 刚打完的关卡
    battleTime: 105,                     // 战斗时长（单位待确认，可能为秒或帧）
    tapTimes: [[173,179,13,18,24,29,35,40,45,50,55,60,65,71,82,87]],
                                         // 手动点击时间戳序列（本场 16 次点击；单位与排序规则待确认）
    autoTapTimes: [[]],                  // 自动挂机点击序列，未使用则为空数组
    outputCode: "7839434dd92e0e50995a2d4710a244a2",  // 32 位十六进制，MD5 样式防作弊校验码
    log: ""
  }
}
```

### 2.3 抓包噪音说明

26 帧中大量为重复帧（同一消息被抓 2~5 次，推测抓包工具对多个连接或多次记录了同一帧）与心跳（`_sys/ack`）、广播（`System_NewChatMessageNotify`、`Activity_Notify`、`Discount_GetDiscountInfoResp`）无关流量。末尾两帧 `_sys/error { code: -1, error: "conn timeout" }` 为抓包会话超时，与推关无关。

## 3. 当前项目相关现状

- [src/utils/xyzwWebSocket.js](../src/utils/xyzwWebSocket.js) 已注册 `fight_startlevel`（注释“获取 battleVersion”），但仅在三处用于初始化战斗版本号：[src/views/GameFeatures.vue](../src/views/GameFeatures.vue)、[src/views/BatchDailyTasks.vue](../src/views/BatchDailyTasks.vue)、[src/utils/batch/connectionManager.js](../src/utils/batch/connectionManager.js)。
- `fight_endlevel` 未注册；`Fight_StartLevelResp` 未加入响应映射（当前依赖 `resp` 字段匹配机制，可能无需映射，待实测确认）。
- 仓库内最接近的功能是“一键换皮闯关”（[src/utils/batch/tasksTower.js](../src/utils/batch/tasksTower.js)，`towers_start`/`towers_fight` 服务端直接结算），机制与主线推关不同。
- 游戏资源包 [src/xyzw/index.js](../src/xyzw/index.js) 含 `NotDelayStartPushLevel`、`SeasonPushLevel`、`LocalPushLevel` 等客户端开关/信号，证明游戏客户端存在“推图”概念，但战斗结算模块不在仓库内。

## 4. 唯一堵点：outputCode 生成算法

`outputCode` 是 32 位十六进制（MD5 样式）。本次抓包只有第 3 关一个样本：

```text
levelId=3, battleTime=105,
tapTimes=[[173,179,13,18,24,29,35,40,45,50,55,60,65,71,82,87]],
autoTapTimes=[[]], log=""
→ outputCode = "7839434dd92e0e50995a2d4710a244a2"
```

合理推断：输入至少包含战斗结果与行为轨迹（randomSeed、tapTimes、battleTime、levelId 等的组合哈希），但具体拼装方式无法从仓库内代码获得。

## 5. 后续研究计划

1. **从运行时 H5 提取战斗结算模块（首选）**：在真实游戏页面用 `window.__require()` 遍历模块，搜索 `outputCode`/`tapTimes` 关键字定位结算代码，逆出拼装算法。做法可参考 `../scripts` 下盐场/蟠桃 Userscript 的模块获取方式。
2. **补抓完整结算响应**：本次抓包缺少 `fight_startlevel`（resp 24，第 3 关战斗数据）与 `fight_endlevel`（resp 26）的响应帧，下次抓包需覆盖完整一次推关，确认结算响应中的奖励结构和下一步状态字段。
3. **确认 battleTime 与 tapTimes 的单位**：结合多个关卡样本对比（时长不同的关卡）推断单位与排序规则。
4. **（谨慎）试探服务器校验强度**：用伪造/复用的 `outputCode` 走一次 `fight_endlevel`，观察是否被拒。存在触发风控的风险，仅在算法久攻不下时考虑。
5. 算法破解后在 [src/utils/xyzwWebSocket.js](../src/utils/xyzwWebSocket.js) 注册 `fight_endlevel`，并在“资源”分组新增批量推关入口（遵循项目任务入口约定）。
