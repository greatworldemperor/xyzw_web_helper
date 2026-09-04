# 主线推关（pushLevel）协议抓包研究

> 首次记录：2026-08-30
>
> 本文基于 `captures/push_level` 一批本地抓包（第 3 关打完进入第 4 关的完整过程，共 26 个 bin 帧），使用根目录 [decode\_captures.mjs](../decode_captures.mjs)（x 方案解密 + BON 解码）解析，并与当前仓库源码交叉验证。角色 ID 等账号身份数据不做原值记录。
>
> 本文明确区分已验证事实、合理推断和待确认内容。
>
> **2026-09-02 更新**：`outputCode` 生成算法已从游戏战斗引擎资源包（`TEST_REMOTE_MODULE`，远程 CDN 动态加载）完整逆向，见第 4 章。原"唯一堵点"已解决。

## 1. 结论

主线推关的已验证客户端流程是：服务器下发战斗数据（随机种子、双方阵容），客户端生成战斗结果，再提交战报。客户端的 `outputCode` 公式已经完整逆向，但这本身不能证明服务器一定会重新模拟整场战斗。

`outputCode = Md5(JSONExt.stringify(ClientBattleResult))`，即**对完整战斗结算对象（含随机种子、每个角色的伤害/血量/治疗等战绩统计）的 MD5 哈希**，已通过官方运行时和 09:40 日志中的完整原文确认（见第 4、7.2 章）。

当前开发前提是用户提供的服务端行为：服务器只检查提交的 `outputCode` 是否符合公式，不重新模拟战斗过程。该前提尚未通过“自定义成功结果”的一次受控线上提交独立验证，因此不能把它写成已确认协议事实。后续实现应把公式生成、请求字段和服务器接受效果分开测试。

推关与换皮闯关（`towers_start`/`towers_fight`，服务端直接结算、无战报）机制完全不同，不能复用。

另存在一条**服务端权威**的旁路：`fight_calcleveltime`（服务器计算战斗耗时）→ 等待 → `fight_level`（服务器直接判定胜负），即 [src/views/PushingLevels.vue](../src/views/PushingLevels.vue) 当前实现的"战斗推关"。该路径完全由服务端计算，客户端不可控；走 `outputCode` 路线才能真正拿回战斗控制权。

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

- `fight_endlevel` 发出后客户端立即请求下一关，说明该次官方战斗流程在 endlevel 后进入了下一步；这不能单独证明服务器采用的是公式校验、服务端重放还是混合校验。

### 2.1 Fight\_StartLevelResp（已验证，抓包实测）

```js
{
  resp: 27,                       // 对应请求 seq
推关与换皮闯关（`towers_start`/`towers_fight`，服务端直接结算、无战报）机制完全不同，不能复用。
  body: {
    battleData: {
      randomSeed: 1677,           // 本场战斗随机种子
      version: 240514,            // 战斗协议版本
      leftTeam: {                 // 我方
        roleId: "721****022",
        tapAttack: 54,            // 点击攻击力（tap 类战斗）
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

### 2.2 fight\_endlevel 战报（已验证，抓包实测）

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

26 帧中大量为重复帧（同一消息被抓 2\~5 次，推测抓包工具对多个连接或多次记录了同一帧）与心跳（`_sys/ack`）、广播（`System_NewChatMessageNotify`、`Activity_Notify`、`Discount_GetDiscountInfoResp`）无关流量。末尾两帧 `_sys/error { code: -1, error: "conn timeout" }` 为抓包会话超时，与推关无关。

## 3. 当前项目相关现状

- [src/utils/xyzwWebSocket.js](../src/utils/xyzwWebSocket.js) 已注册 `fight_startlevel`（注释“获取 battleVersion”），但仅在三处用于初始化战斗版本号：[src/views/GameFeatures.vue](../src/views/GameFeatures.vue)、[src/views/BatchDailyTasks.vue](../src/views/BatchDailyTasks.vue)、[src/utils/batch/connectionManager.js](../src/utils/batch/connectionManager.js)。

- `fight_endlevel` 已注册；`Fight_StartLevelResp` 和 `Fight_EndLevelResp` 均加入响应映射，Promise 仍优先按 `resp` 字段匹配。

- 仓库内最接近的功能是“一键换皮闯关”（[src/utils/batch/tasksTower.js](../src/utils/batch/tasksTower.js)，`towers_start`/`towers_fight` 服务端直接结算），机制与主线推关不同。

- 游戏资源包 [src/xyzw/index.js](../src/xyzw/index.js) 含 `NotDelayStartPushLevel`、`SeasonPushLevel`、`LocalPushLevel` 等客户端开关/信号，证明游戏客户端存在“推图”概念，但战斗结算模块不在仓库内。

## 4. outputCode 生成算法（已完整逆向，2026-09-02）

### 4.1 来源

战斗引擎位于远程 CDN 动态加载的资源包 `TEST_REMOTE_MODULE`（版本 `5cf54`，下载自 `https://xxz-xyzw-res.hortorgames.com/remote/`，XXTEA 解密密钥 `0Aed5E79bbEa69f8`，经 Babel 反混淆后分析）。`ts-md5` 实现位于 `launcher` 资源包（标准 ts-md5 包，自校验 `hashStr("hello") === "5d41402abc4b2a76b9719d911017c592"`，UTF-8 编码后取 MD5）。

### 4.2 核心算法（引擎 `BattleWorld.getBattleResult(isWin, false)`）

```js
// 主线关卡走单队版（CommonBattleWorld），多队战斗走 getMultiTeamBattleResult，结构一致

// ① inputCode（不上报服务器，仅客户端自校验）
battleData.leftTeams = undefined;     // 序列化时被 JSON.stringify 丢弃
battleData.rightTeams = undefined;
battleData.result = null;             // 键保留，值为 null
inputCode = Md5.hashStr(JSONExt.stringify(battleData));

// ② outputCode（提交给 fight_endlevel 的防作弊码）
result = new ClientBattleResult();
result.id = battleData.id;
result.type = battleData.mode;
result.isWin = isWin;
result.version = battleData.version;
result.seed = world.random.seed;       // ← battleData.randomSeed 决定
result.sponsor = ClientBattleResultTeam.create(leftTeam, [...成员战绩], extMap);
result.accept = ClientBattleResultTeam.create(rightTeam, [...成员战绩], extMap);
result.statistic = Map(...);           // 战斗统计
// 哈希时刻的字段状态（关键！以下字段仍是构造默认值）：
//   totalFrame=0, battleVersion="", inputCode="", outputCode="", log="",
//   round=0, isTimeout=0, sponsor/accept 为战斗中记录的成员战绩
//   memoMode/memos 置 undefined（序列化丢弃）、sponsors/accepts/gameResults 置 undefined（丢弃）
outputCode = Md5.hashStr(JSONExt.stringify(result));
// 哈希之后才回填：round=curRound, totalFrame=EndTick-StartTick,
//                inputCode, outputCode, battleVersion=BATTLE_VERSION
```

`JSONExt.stringify = JSON.stringify(obj, Map→普通对象转换)`，无缩进，键序 = 属性插入顺序（即 `ClientBattleResult` 构造顺序）。`ClientBattleResult` 构造键序：`id, isWin, seed, totalFrame, version, battleVersion, memoMode, inputCode, outputCode, log, sponsor, accept, type, round, isTimeout, statistic, sponsors, accepts, gameResults, memos`（undefined 的键在 JSON 中被丢弃）。

**结论：outputCode 的哈希输入是“种子 + 胜负 + 全部参战成员逐人战绩（伤害/受击/治疗/血量/怒气/峰值统计等）”。** 已知公式和字段顺序后，可以在本地构造候选 `ClientBattleResult` 并计算 MD5；但候选结果是否能被服务器接受，仍取决于服务端实际校验模型。用户提供的“只校验公式”前提支持轻方案，尚待一次受控提交验证，不能再推断为“必须真实模拟”或“必然可以伪造”。

### 4.3 成员战绩（TeamMember，哈希内容的主体）

引擎遍历 `recordContext.record`（战斗中每个参战者的记录），对每个成员构造：

```js
{
  heroId, type, skin, skinName, color, club, level, star, order,
  index, slot,
  damage:      Math.ceil(造成伤害),      // Decimal 高精度数取整
  takeDamage:  Math.ceil(受到伤害),
  treatment:  Math.ceil(治疗量),
  hp:          Math.ceil(剩余血量),
  rage:        Math.ceil(怒气),          // energy 同值
  maxAttr: { SINGLE_DAMAGE, ATTACK_DAMAGE, BATTLE_DAMAGE },  // 峰值记录 Map
  statistic: { BossUnusedSkill?, BossAngerIsFull? },          // 仅特定关卡
  enchantMap
}
```

`sponsor`/`accept`（ClientBattleResultTeam）除成员数组外还含双方 `CurHP` 扩展值（`pickupContext.getCampHp(camp, false)`）。当前 09:40 原文和本地逐字回放表明 `name`、`headImg`、`avatarFrame` 均存在于哈希输入中；不要按旧的“哈希后回填、不参与哈希”结论实现。

### 4.4 tapTimes / autoTapTimes / battleTime（已验证，来自 game 资源包 `LevelModule._trySendService`）

```js
tapTimes     = CompLord.saveLordAttack;      // 每波次数组，元素=点击时刻的 battleTick
autoTapTimes = CompLord.saveAutoLordAttack;  // 每波次压缩为 [首次tick, 间隔, 次数]
battleTime   = statistics.EndTick - statistics.StartTick;  // tick 数（非秒）
log          = 生产环境恒为 ""
```

- **battleTick 是引擎模拟 tick**（非墙钟时间），tapTimes 抓包样本 `[173,179,13,...]` 即 tick 序列。

- 引擎回放：`battleData.leftTeam.lordAttackTime`（非空时）经 `CompPlaybackFire` 逐 tick 触发攻击；`lordAutoAttackTime` 元素 `[start, interval, count]` 按 `(tick-start)/interval` 为整数时触发。

- 游戏自身"快速推关"（autoClickType 开启时）在**请求 startLevel 之后**向 `battleData.leftTeam.lordAutoAttackTime` 注入 `[0, 40, 500]`（autoSpeed 1.25）或 `[0, 52, 500]`（autoSpeed 1.6），再以无头模式跑完战斗——这就是我们要复刻的确定性输入。

### 4.5 完整战斗流程（LevelModule / UICompQuickLevel，game 资源包）

```text
FightService.startLevel({})            → battleData（randomSeed, leftTeam, rightTeam, options）
  ↓
battleData.leftTeam.lordAutoAttackTime = [[0,40,500]] × 波次数   （开自动点击时注入）
  ↓
_calInputCode()                         → options.extend.inputCode
  ↓
BattleManager.instance.startQuickLevelBattleById(battleData, ROLE, autoAttack, interval, timeScale)
  = _serverBattleFactory.createBattleById({battleData, extend:{noRender:true}}, Bottom)
  ↓
world.syncTime = () => serverTime;  world.startBattle();  world.quickBattle();
  ↓
world.BattleEndSignal.once(isWin => {
  statistics.set(EndTick, world.tickCount);
  result = world.getBattleResult(isWin, false);       // ← outputCode 在此生成
  battleTick = EndTick - StartTick;
})
  ↓
FightService.endLevel({levelId, battleTime: battleTick, tapTimes, autoTapTimes, outputCode, log:""})
  ↓
Fight_EndLevelResp                       → reward / 下一关状态
```

关键角色：

- `_serverBattleFactory = new ServerBattleLauncher`（game 包 `BattleManager.init`），与渲染用的 `ClientBattleLauncher` 平行，由 `BattleManager.update` 驱动，`noRender:true` 纯无头。

- `quickBattle()`：`timeScale = QUICK_TIME_SCALE` + `executeMode |= Headless|BattleView`，极速模拟。

- 多波次关卡：同一 world 内通过 `CompStepStart`/`CompLevel.curStep` 推进，只有 `isLastStep` 胜利才发 endLevel。

- `UseQuickLevelResult` 客户端开关：无头预跑结果（`QuickLevelUtil{levelId, battleTick, lordAutoAttackTime, outputCode}`）可直接替换可见战斗回放的战报。这证明官方客户端支持预先生成并复用无头战斗结果；它不能独立证明服务端只检查 outputCode，也不能排除服务端对 battleData、时间表或关卡状态的额外校验。

### 4.6 服务端校验模型（用户前提与待验证项）

用户明确提供的开发前提是：服务端只验证 `outputCode` 是否符合 `Md5(JSONExt.stringify(ClientBattleResult))`，不会重新模拟战斗过程。这个前提目前没有通过自定义战报线上提交独立确认。现阶段应同时保留三个待区分模型：

1. **公式模型（当前轻方案目标）**：服务端按请求中的结果和 `outputCode` 验证公式，合成的成功结果可以通过。
2. **重放模型（历史强推断）**：服务端持有同构引擎，以 startLevel 的 battleData 和 endLevel 的 tapTimes/autoTapTimes 重放，再比对结果哈希。
3. **混合模型**：服务端至少检查公式，同时检查 levelId、战斗时间、请求状态、输入时间表或结果字段的部分一致性。

`UseQuickLevelResult`、`battleTick` 和官方无头引擎只能说明客户端存在确定性预跑路径，不能在三种模型之间作出选择。只有一次受控的自定义成功结果提交，配合一个故意改动 digest 的对照请求，才能区分公式模型与更强校验。因此：

- 重方案用游戏自己的引擎（iframe 内 `_serverBattleFactory`）以相同 battleData 和时间表生成官方结果，是兼容性保底，但“必然通过”仍需当前版本受控确认；

- 轻方案可以先按用户前提实现本地合成和 `fight_endlevel`，但在验证前不得批量发送；

- A 连接拿 battleData、iframe 引擎算码、B 连接提交是否可行，也属于待验证的跨连接行为，不能仅凭客户端代码确认。

### 4.7 引擎机制补充验证（2026-09-02 第二轮，均已对照反混淆源码确认）

1. **类型转换链路（实现的关键前提）**：游戏网络层 `getData` 返回前会依据类型元数据把 BON 解码出的普通对象**递归转换为类型实例**（launcher 的 `DataBase.setValue` 模式，`leftTeam`/`rightTeam` 的 Map 字段随之恢复）。引擎 `initBattle` 直接消费**类型化 battleData**（成员是带 Map 和方法的实例），不能直接喂普通对象。因此：

   - 首选让 iframe 内游戏自身的 `FightService.startLevel` 产生 battleData（天然已类型化），算码后由同一连接提交；

   - 若跨连接把 helper 抓到的普通对象传入 iframe，必须先在 iframe 内用游戏的类型元数据做一次 `setValue` 式恢复，不能直接 `startQuickLevelBattleById`。
2. **战斗缓存**：`ServerBattleLauncher` 按 `battleData.id` 缓存已创建战斗（`idBattles` Map），`createBattleById` 对同一 id 直接返回缓存实例。每次 `fight_startlevel` 的 battleData.id 均为新值，正常推关无冲突；但重复驱动同一 id 会拿到已结束的旧战斗。
3. **`_calInputCode`** **精确行为**（LevelModule）：临时 `battleData.result = null`、`leftTeams/rightTeams = undefined` → `JSONExt.stringify` → `Md5` → 回填，结果挂在 `options.extend.inputCode`。与 4.2 ① 完全一致。
4. **多波次推进**（游戏自带小号本地推关 `LocalPushLevelTask`）：胜利且非最后一波 → `changeComponent(CompStepStart)` 原地继续下一波；最后一波胜利 → `FightService.level({})` 收尾；失败 → 回 `CompLevelStart` + `CompStepStart` 重开。波间节奏由 `WIN_DELAY_TIME` / `FAIL_DELAY_TIME` 控制。
5. **`_calTimeScale`**：`options.getExt(BattleDataOption.AutoSpeed, 100) / 100` 保留 2 位小数（autoSpeed=100 → 1.0），无头模式再叠加 `QUICK_TIME_SCALE` 极速模拟。
6. **攻击时间表回放与记录**：`CompPlaybackFire` 逐 tick 回放 `lordAttackTime`；`CompLord` 按波次记录 `saveLordAttack`（逐 tick 数组）与 `saveAutoLordAttack`（压缩 `[首次tick, 间隔, 次数]`），分别对应 `fight_endlevel` 的 `tapTimes` / `autoTapTimes`。
7. **模块定位**：`BattleManager` 注册名为 `manager-factory`（内部 ID `f02e8sK0OpBwJTHNFAZdqJr`），iframe 内 `__require('manager-factory')` 即可取到；helper 的 BON 解码器（[src/utils/bonProtocol.js](../src/utils/bonProtocol.js)）已支持 Map tag，与游戏解码格式兼容。

## 5. 实现方案：本地无头引擎推关（outputCode 路线）

游戏本体已由本 helper 同源托管（[public/game/](../public/game/)，[src/views/GamePlayer.vue](../src/views/GamePlayer.vue) iframe 内嵌）。同源 iframe 的 `window.__require` 可直接取到全部模块。方案：

1. **注入驱动脚本**到 GamePlayer iframe（父页面同源可直接 `contentWindow` 操作）：

   - `__require` 取 `BattleManager`、`JSONExt`、`Md5`、`Configs` 等模块；

   - 复刻 4.5 流程：注入 `[0,40,500]` 自动攻击表 → `startQuickLevelBattleById` 无头跑图 → 收集 `{outputCode, battleTick, saveLordAttack, saveAutoLordAttack(压缩)}`。
2. **helper 侧（token 连接）**：`fight_startlevel` 拿 battleData → 传给 iframe 引擎模拟 → 拿回战报 → `fight_endlevel` 提交；循环推进。注意 4.7-1：battleData 必须先经类型恢复（或直接由 iframe 内游戏自身 `FightService` 发起 startlevel）才能喂给引擎。
3. 战斗版本号需与角色一致（`BattleConst.BATTLE_VERSION`，现有 [src/utils/xyzwWebSocket.js](../src/utils/xyzwWebSocket.js) 已有 fight\_startlevel 拉版本号的用法）。
4. iframe 中需先完成角色登录（现有 BIN/上号器链路）并等待 configs 就绪，才能创建战斗。

风险与待验证：

- iframe 内 `ROLE`（角色数据）与 helper token 账号必须一致，否则 leftTeam/tapAttack 等属性对不上（battleData 本身由服务器按请求账号生成，模拟只消费 battleData，理论上一致；`role` 参数仅用于 `extend`，影响 `isAutoAttack` 等本地行为，需实测）。

- 多波次、BOSS 关（`isLastStep`）、`IsActLevel` 活动关的行为差异需实测。

- 反作弊风控强度未知：无头模拟的 battleTick 精确性由引擎保证，但提交频率应仿人工（现有 PushingLevels 的节奏控制可复用）。

## 6. 被动研究器与 2026-09-02 日志结论

由于真实账号只能用于登录和被动观察，当前项目没有把主动推关/无头模拟接入研究页。研究入口为 [src/views/PushLevelResearch.vue](../src/views/PushLevelResearch.vue)，iframe 桥为 [public/game/push-level-research-bridge.js](../public/game/push-level-research-bridge.js)。桥的工作范围是：

- 临时接收页面内存中的 BIN，并复用当前版本的 `PlatformManager.encryptUserInfo`、`authorizeDeferred` 和官方 `GameLogin/LoginManager` 登录链路；不写入 IndexedDB。

- 记录官方运行时的模块加载、控制台、全局异常和 WebSocket 生命周期/帧摘要。

- 用 `px` 的 XOR 去头和 `pl` 的 LZ4/XOR 方案解密，再用 BON 解码器尝试还原协议消息。

- 识别 `Fight_StartLevelResp`、`fight_endlevel` 及其响应，并把官方 `TGA log` 中的 `c_battleLevelStart`、`c_battleSuccess`、`c_battleFail`、`c_battleEnd` 归一化为战斗事件。

- 通过 JSONL 下载统一导出事件、战斗摘要、协议帧、运行时版本和错误；原始完整十六进制帧必须由用户主动开启，默认关闭。

桥在 `passive-capture` 模式下拒绝主动 `battle:start`、`battle:simulate` 和 `battle:end` 命令，也不包装官方战斗 API。后续分析以用户手动操作后下载的 JSONL 为唯一输入，不在真实账号上试发未知报文。

### 6.1 已分析日志

2026-09-02 的一份研究日志包含 4845 行记录（1 行下载元数据 + 4844 个事件），其中有 317 个 WebSocket 帧和 18 个 TGA 战斗事件。有效战斗链为：

```text
1795 start -> success
1796 start -> success
1797 start -> success
1798 start -> success
1799 start -> success
1800 start -> success
1801 start -> success
1802 start -> success
1803 start（日志结束时已开始）
```

1798 的官方 TGA 结算日志包含：

```js
{
  level: 1798,
  randomSeed: 3320,
  battleTime: 25,
  battleTick: 734,
  touchTimes: 0,
  attackTimes: 0,
  inputCode: "cb5fef1e886650cd1f249791875a7e2f",
  outputCode: "beea844d2ec426f90872c3085ae5cf7f",
  battleVersion: "7f91491b47",
  version: "1.89.8-wx",
  codeVersion: "2.43.3",
  configVersion: "6d59b68496"
}
```

这证明 `battleData` 不是没有产生，而是官方客户端还提供了一条比网络解码更直接的观测入口：`console.info("TGA log", "c_battleLevelStart", data)` 和 `console.info("TGA log", "c_battleSuccess", data)`。研究页必须消费这些事件，不能只等待主动调用 `fight_startlevel` 后产生的桥响应。

## 7. 获取 ClientBattleResult 哈希原文的方法

`outputCode` 的哈希原文不能从摘要值反推，正确做法是在官方客户端内部调用 MD5 的位置做**只读旁路捕获**。历史研究日志已经记录官方动态模块名为 `ts-md5`，因此研究桥按以下优先级工作：

1. 扫描 `ts-md5` 及动态 `__require` 模块，寻找 `Md5.hashStr` / `hashString`；包装函数只记录第一个字符串参数和原返回值，不改变输入、返回值或网络行为。
2. 扫描 `JSONExt.stringify`、相关序列化导出和可识别的 `stringify` 方法，记录包含 `sponsor`、`accept`、`isWin`、`battleVersion`、`totalFrame`、`statistic` 等战斗字段的完整字符串，作为 MD5 钩子的交叉证据。
3. 监听官方 TGA 日志中的 `c_battleLevelStart.inputCode` 和 `c_battleSuccess/c_battleFail.outputCode`，按 digest 将哈希调用与具体关卡、seed、battleTick 配对，写入 `hash:matched` 事件。

哈希原文捕获默认关闭。用户在研究页手动开启“哈希原文”后，正常操作一至数场战斗，再下载 JSONL；当前桥版本会优先直连 `ts-md5.Md5.hashStr` / `hashAsciiStr`，日志中关注：

```text
hash:hooks                 实际安装了哪些只读钩子
hash:candidate             官方 MD5 调用的摘要和长度
hash:matched               digest、完整 preimage、关卡/seed 配对
hash:stringify-candidate   序列化原文候选（MD5 钩子不可见时的兜底）
battle:tga:start/result    官方战斗上下文
protocol:message           解码后的协议包（如当前版本可还原）
```

该流程不调用 `fight_startlevel`、无头模拟或 `fight_endlevel`，也不改写 MD5 返回值；真实账号只产生官方游戏本来就会产生的登录和手动战斗流量。完整 `preimage` 可能包含角色战斗数据，回传前应检查日志内容。

### 7.1 09:12 日志复盘与修复

`push-level-research-2026-09-02T09-12-58-588Z.jsonl` 共 1062 行，下载头显示桥版本 `2026-09-02.6`、哈希捕获开启。日志中有 245 个 WebSocket 收发帧、5 个战斗开始、3 个战斗结果和 6 组主线起止协议；1808、1809、1810 均完成 `c_battleSuccess`，同时 `Fight_EndLevelResp` 正常返回，说明登录和战斗观察链路没有问题。

该文件的 `hash:hooks` 仅列出：

```text
module:13.bkdrHashStr
module:13.bkdrHashStrFast
module:13.toJsonStringSB
```

虽然 `module:require` 已证明 `ts-md5` 模块存在，旧版 `installHashHooks()` 只做递归扫描，扫描预算可能在 `13` 模块上耗尽，未把 `ts-md5.Md5.hashStr` 装进去；所以 `hash:candidate`、`hash:matched` 和 stringify 候选均为 0。这不是官方未计算 `outputCode`，也不是日志导出丢失原文。

桥版本 `2026-09-03.15` 已包含即时哈希 hook、延迟模块补钩、WebSocket 帧复制解密、`runtime:state` 和 `runtime:capabilities` 只读诊断；`ts-md5.Md5.hashStr`/`hashAsciiStr` 以及 `13.toJsonStringSB` 等 hook 可在运行时开关后立即生效。真实研究运行时仍保持 `passive-capture`，正常手动完成一场战斗应出现 `hash:matched`，其 `preimage` 可用于复算 `outputCode`。

研究页的最近战斗摘要在收到新的 `battle:tga:start` 或 `battle:protocol:start` 时会清空上一场的结果字段，避免下一关开始时沿用上一关的 `battleTime`/`outputCode`。

### 7.2 09:40 日志：完整 outputCode 原文已捕获

日志文件：`local-data/push_level/push-level-research-2026-09-02T09-40-29-334Z.jsonl`。这次使用桥版本 `2026-09-02.8`，完成了 1808-1810、1812-1814 等多场正常成功战斗，并捕获到 9 条 `hash:matched` 原文：6 条 inputCode、3 条 outputCode。3 条 outputCode 分别对应 1812、1813、1814；当前桥已升级为 `2026-09-03.15`，该日志作为历史 `.8` 版本的原始证据保留。

每条 outputCode 的 `preimage` 都能用本地 Node MD5 复算，9 条记录全部一致。outputCode 哈希时刻的顶层键顺序稳定为：

```text
id, isWin, seed, totalFrame, version, battleVersion, inputCode,
outputCode, log, sponsor, accept, type, round, isTimeout, statistic
```

`sponsor` 和 `accept` 的键顺序为：

```text
roleId, name, headImg, avatarFrame, power, teamInfo, ext
```

`teamInfo` 成员的键顺序为：

```text
heroId, color, level, order, index, rage, club, slot, star,
damage, takeDamage, treatment, hp, energy, skin, skinName, type,
maxAttr, statistic, skillDamage, skillTreatment, enchantMap
```

实际样本中敌方 `teamInfo` 既有 3 个也有 15 个成员，不能固定写死数组长度。`maxAttr` 使用数字键 `2`、`3`、`4`；空的统计对象和 `enchantMap` 也会保留在哈希原文中。该日志解决了“只能看到 outputCode 摘要、无法知道原文”的研究堵点，但没有解决“自定义成功结果是否被服务器接受”的线上验证问题。

## 8. BIN 登录兼容性记录

当前远程版本的登录模块与早期上号脚本不同：`data-index.LoginService` 只暴露 `manifest`，不存在 `mix`；`LoginManager` 位于独立的 `LoginManager` 模块，`LoginManager.instance.login()` 才是 `GameLogin` 使用的入口。该方法内部依次执行 `PlatformManager.instance.authorizeDeferred.promise`、`LoginService.authUser`、网络连接和 `RoleService.getRoleInfo`。

研究桥现在按当前版本的官方链路处理临时 BIN：

```text
BIN -> decrypt/BON decode -> saveInfo.info
  -> PlatformManager.instance.encryptUserInfo = saveInfo.info
  -> authorizeDeferred.resolve(saveInfo.info)
  -> 复用 GameLogin，或仅在不处于 GameLogin 时调用 LoginManager.instance.login(true)
```

不能在 `GameLogin` 已经等待认证时并发启动多个 `LoginManager.login` 协程；此前会造成 launcher 响应表异常并报 `Cannot read properties of undefined (reading 'root')`。2026-09-03 使用 `wechat.bin` 的只读复测已确认 BIN 解码、`authUser`、WebSocket 建立、`role_getroleinfo`/`Role_GetRoleInfoResp` 和 BON 解码正常；最终 `GameRunning`/`ROLE.authed` 仍需结合运行时事件和能力快照判断。当前桥为 `2026-09-03.15`，该修复只影响研究页登录准备，不会主动发送任何 `fight_*` 命令。

### 8.1 2026-09-03 运行时与无头入口复测

今天使用的 `wechat.bin` 大小为 1628 字节，仅在浏览器页面内存中使用，未写入仓库。复测记录到：

- BIN 解码字段包含 `platform`、`platformExt`、`info`、`serverId`、`scene`、`referrerInfo`，其中 `platformExt=mix`；认证请求 hook 已将这些字段用于当前官方 `authUser` 链路。

- 官方模块可通过 `__require('manager-factory')` 定位。`BattleManager` 原型包含 `startQuickLevelBattleById(battleData, ROLE, autoAttack, autoAttackInterval, timeScale)`，该入口使用服务端战斗工厂并设置 `noRender`。

- `FightService.startLevel({})` 返回官方响应对象，必须先调用 `getData()`；其中 `battleData` 是官方类型实例，不是响应外壳或父页面普通对象。

- `runtime:capabilities` 在当前远程会话中报告 `FightService`、`BattleData`、`BattleResult`、`BattleManager` 和 quick battle 入口存在，但 `_serverBattleFactory=false`，因此 `readyForHeadless=false`。

- 直接调用官方 `BattleManager.init()` 的只读初始化探测因缺少 `seasonBattleTypes` 配置失败；今天没有完成官方无头战斗生成，也没有发送 `fight_endlevel`。

研究桥现已增加隔离的 `headless-test=1` 测试模式和 `headless:generate` 命令，但该命令要求 `testOnly=true`、单 iframe 只允许一场，并且只用于生成/观察结果；普通 `research=push-level` 页面仍保持 `passive-capture`，主动战斗和结算命令继续锁定。

桥版本 `2026-09-03.16` 把无头引导从"盲调 `init()`"升级为诊断优先的引导顺序：`headless:diagnose`（只读）会输出 `BattleManager` 实例字段、`init`/`updateServerFactory`/`startQuickLevelBattleById` 的源码预览，并在 `manager-factory`/`data-index`/`Game` 可达模块中搜索 `ServerBattleLauncher`/`ClientBattleLauncher`/`seasonBattleTypes` 等指针；`headless:generate` 依次尝试官方 `init()` → `updateServerFactory()` → 直接构造 `ServerBattleLauncher` 并挂到 `_serverBattleFactory`，每一步的结果都写入 `headless:bootstrap` 事件，失败原因和完整诊断随事件返回。这仍然不发送 `fight_endlevel`，且受 `testOnly=true` 与单场上限约束。研究页新增"官方无头引擎测试"卡片：打开 `headless-test=1` iframe、注入 BIN、读取能力、运行初始化诊断和生成单场官方结果。

### 8.2 2026-09-03 拦截实验与服务器容差探测（80号战士）

在 80号战士（9780服，roleId 647473183，当前约 2049 关，战斗可胜）上，以官方无头引擎生成的真实胜利结果为基底，做**单点微调 + 重算 outputCode** 的提交实验，探测服务器验算严格度。每轮独立 headless iframe（单场/单提上限），`fight_endlevel` 的 `levelId`、`battleTime`、`tapTimes`/`autoTapTimes` 保持官方原值，仅改动战绩字段后重算哈希提交。

已完成的 5 轮实验（提交后服务器返回 `Fight_EndLevelResp` body 395 字节 = 成功响应；失败/拒绝为 106 字节；ROLE.levelId 持续推进即被接受）：

| 轮 | 微调                                  | 提交关卡 | 服务器判定 |
| - | ----------------------------------- | ---- | ----- |
| 1 | 我方主力 HP 276845688 -> 276845687（-1）  | 2049 | 接受，推进 |
| 2 | 我方主力 HP -> 226845688（-5000万，约 -18%） | 2067 | 接受，推进 |
| 3 | 我方主力 HP -> 0（全扣光）                   | 2076 | 接受，推进 |
| 4 | 我方主力 rage -> 0                      | 2097 | 接受，推进 |
| 5 | 我方主力 damage +1亿                     | 2108 | 接受，推进 |

**结论（已验证事实）**：服务器对 `fight_endlevel` 提交的战报中 sponsor HP、rage、damage 等战绩字段**不做数值/守恒重放校验**——即使 HP 扣到 0、怒气清零、伤害凭空加 1亿，只要 `outputCode` 与提交内容自洽（MD5 公式正确），服务器就接受并推进关卡。这推翻了此前"服务器会重新模拟战斗验算"的假设；服务器校验的核心是 **outputCode 公式自洽性**（以及 levelId 等必需字段完整），而非战绩数值真实性。

**推论（合理推断）**：只要持有官方引擎生成的真实战斗结果作为"骨架"（保证字段类型、键序、种子等格式正确），单点篡改战绩数值是安全的。此前 9070 关"伪造胜利"失败（800080）的真正原因不是"数值被重放校验"，而更可能是：直接把失败结果的 isWin 改 true 但保留"我方全灭/hp=0、敌方存活"的矛盾形态 + 缺失 levelId 等字段问题（200020），而非服务器对数值本身验算。后续实现可基于"真实结果 + 自洽哈希"自由调整战绩展示数值。

## 9. 后续重方案与轻方案实施计划

完整的交接级实施计划、字段契约、生成器接口、`fight_endlevel` 注册点、调度器状态机、受控验证矩阵和安全边界见 [docs/mainline-pushlevel-implementation-plan.md](mainline-pushlevel-implementation-plan.md)。

简要路线是：

```text
先做纯本地 ClientBattleResult/MD5 fixture
  -> 注册 fight_endlevel 并做协议桩测试
  -> 做轻方案 dry-run
  -> 用测试账号单场验证合成结果
  -> 再接入 interval + jitter 调度器

重方案 iframe 无头引擎作为官方兼容基准和失败回退，
研究页继续保持 passive-capture，不直接变成发送器。
```

另外，仓库外部注入脚本 [scripts/7.7.12.js](../scripts/7.7.12.js) 中发现了独立的 `skip150` 客户端配置 Hook。它通过 `window.__require("Configs")` 包装 `Configs.LevelConf.getById`，在 `2..150` 关把本地配置的 `monsters` 改为 `[[[0]]]`；这不是本节的 `fight_startlevel`/`fight_endlevel` 协议链，也没有在该 Hook 中发现直接构造 `outputCode` 或发送 `fight_endlevel` 的代码。完整的混淆层、AST 范围、隔离 VM 证据、边界差分和真实 H5 待验证项见 [docs/reverse-engineering/7.7.12-skip150.md](reverse-engineering/7.7.12-skip150.md)。因此，主线协议研究不能把 `skip150` 的本地配置改写直接当作服务器接受规则；二者仍需分别验证。

