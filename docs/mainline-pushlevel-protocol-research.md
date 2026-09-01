# 主线推关（pushLevel）协议抓包研究

> 首次记录：2026-08-30
>
> 本文基于 `captures/push_level` 一批本地抓包（第 3 关打完进入第 4 关的完整过程，共 26 个 bin 帧），使用根目录 [decode_captures.mjs](../decode_captures.mjs)（x 方案解密 + BON 解码）解析，并与当前仓库源码交叉验证。角色 ID 等账号身份数据不做原值记录。
>
> 本文明确区分已验证事实、合理推断和待确认内容。
>
> **2026-09-02 更新**：`outputCode` 生成算法已从游戏战斗引擎资源包（`TEST_REMOTE_MODULE`，远程 CDN 动态加载）完整逆向，见第 4 章。原"唯一堵点"已解决。

## 1. 结论

主线推关是**客户端权威战斗**：服务器下发战斗数据（随机种子、双方阵容），客户端本地模拟整场战斗，再提交战报，用 `outputCode` 防作弊校验码证明战斗按指定种子真实进行。

`outputCode = Md5(JSONExt.stringify(ClientBattleResult))`，即**对完整战斗结算对象（含随机种子、每个角色的伤害/血量/治疗等全部战绩统计）的 MD5 哈希**，已完整逆向（见第 4 章）。

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

**结论：outputCode 是"种子 + 胜负 + 全部参战成员逐人战绩（伤害/受击/治疗/血量/怒气/暴击峰值等）"的 MD5。无法凭空伪造——必须真实跑一遍与服务器一致的确定性模拟（种子相同、输入时间表相同 → 战绩逐位相同）。**

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

`sponsor`/`accept`（ClientBattleResultTeam）除成员数组外还含双方 `CurHP` 扩展值（`pickupContext.getCampHp(camp, false)`）。**avatarFrame/name/headImg 在哈希之后才用 `encodeURIComponent` 回填，不参与哈希。**

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
- `UseQuickLevelResult` 客户端开关：无头预跑结果（`QuickLevelUtil{levelId, battleTick, lordAutoAttackTime, outputCode}`）可直接替换可见战斗回放的战报再次提交——证明**服务端校验只看 battleData 种子 + 提交的时间表 + outputCode 的一致性，与哪个连接、是否渲染无关**。

### 4.6 服务端校验模型（强推断）

服务端持有同构引擎：以 `fight_startlevel` 下发的 battleData（含 randomSeed）+ `fight_endlevel` 提交的 tapTimes/autoTapTimes 重放模拟，重算 ClientBattleResult 哈希与 outputCode 比对。因此：

- 用**游戏自己的引擎**（iframe 内 `_serverBattleFactory`）以相同种子+时间表模拟，outputCode 必然通过校验；
- 战报与连接无关——可以 A 连接拿 battleData、iframe 引擎算码、B 连接提交（也可以全走同一条连接）。

### 4.7 引擎机制补充验证（2026-09-02 第二轮，均已对照反混淆源码确认）

1. **类型转换链路（实现的关键前提）**：游戏网络层 `getData` 返回前会依据类型元数据把 BON 解码出的普通对象**递归转换为类型实例**（launcher 的 `DataBase.setValue` 模式，`leftTeam`/`rightTeam` 的 Map 字段随之恢复）。引擎 `initBattle` 直接消费**类型化 battleData**（成员是带 Map 和方法的实例），不能直接喂普通对象。因此：
   - 首选让 iframe 内游戏自身的 `FightService.startLevel` 产生 battleData（天然已类型化），算码后由同一连接提交；
   - 若跨连接把 helper 抓到的普通对象传入 iframe，必须先在 iframe 内用游戏的类型元数据做一次 `setValue` 式恢复，不能直接 `startQuickLevelBattleById`。
2. **战斗缓存**：`ServerBattleLauncher` 按 `battleData.id` 缓存已创建战斗（`idBattles` Map），`createBattleById` 对同一 id 直接返回缓存实例。每次 `fight_startlevel` 的 battleData.id 均为新值，正常推关无冲突；但重复驱动同一 id 会拿到已结束的旧战斗。
3. **`_calInputCode` 精确行为**（LevelModule）：临时 `battleData.result = null`、`leftTeams/rightTeams = undefined` → `JSONExt.stringify` → `Md5` → 回填，结果挂在 `options.extend.inputCode`。与 4.2 ① 完全一致。
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
3. 战斗版本号需与角色一致（`BattleConst.BATTLE_VERSION`，现有 [src/utils/xyzwWebSocket.js](../src/utils/xyzwWebSocket.js) 已有 fight_startlevel 拉版本号的用法）。
4. iframe 中需先完成角色登录（现有 BIN/上号器链路）并等待 configs 就绪，才能创建战斗。

风险与待验证：

- iframe 内 `ROLE`（角色数据）与 helper token 账号必须一致，否则 leftTeam/tapAttack 等属性对不上（battleData 本身由服务器按请求账号生成，模拟只消费 battleData，理论上一致；`role` 参数仅用于 `extend`，影响 `isAutoAttack` 等本地行为，需实测）。
- 多波次、BOSS 关（`isLastStep`）、`IsActLevel` 活动关的行为差异需实测。
- 反作弊风控强度未知：无头模拟的 battleTick 精确性由引擎保证，但提交频率应仿人工（现有 PushingLevels 的节奏控制可复用）。
