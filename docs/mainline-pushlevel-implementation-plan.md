# 主线自动推关实施方案与交接说明

> 文档版本：2026-09-02
>
> 用途：为后续开发者或其他 AI 提供可以直接接手的完整上下文、实施顺序和验收标准。
>
> 目标：前台方案。服务器下发关卡数据和随机种子，网页端构造成功战报并发送给服务器；不依赖服务器自行模拟战斗。最终轻方案不依赖游戏 iframe，也不运行真实战斗过程。

## 1. 目标与范围

### 1.1 最终目标

用户可以为一个或多个账号设置基础间隔和随机偏移：

```text
等待 baseInterval + random(-jitter, +jitter)
    -> fight_startlevel({})
    -> 读取当前 battleData / levelId / randomSeed
    -> 构造 isWin=true 的 ClientBattleResult
    -> JSONExt 等价序列化
    -> MD5 得到 outputCode
    -> fight_endlevel({ levelId, battleTime, tapTimes, autoTapTimes, outputCode, log })
    -> 等待服务器响应并确认下一关
```

这里的“前台”指**客户端负责生成并提交战斗结果**，不是指必须显示游戏画面。最终轻方案可以完全运行在 Vue/TypeScript/WebSocket 代码中。

### 1.2 方案命名

本项目后续使用以下定义，避免“轻/重”含义漂移：

| 方案 | 运行时 | 是否运行真实战斗 | 作用 |
|---|---|---:|---|
| 重方案 | 同源游戏 iframe + 官方运行时，必要时使用官方无头引擎 | 可选 | 兼容性保底、研究、验证序列化和结果生成 |
| 轻方案 | Vue/TypeScript + 现有 WebSocket/BON | 否 | 最终生产方案，按间隔直接生成成功信息 |
| 当前旧方案 | helper WebSocket + `fight_calcleveltime`/`fight_level` | 服务器计算 | 现有功能，不属于目标前台方案 |

### 1.3 不在本次目标内的内容

- 不重写完整游戏战斗引擎。
- 不依赖服务端自行计算战斗过程。
- 不把研究页的被动捕获模式改成默认主动发送模式。
- 不把用户真实 Token、BIN、完整登录响应或未脱敏日志提交到仓库。
- 不把“增加随机延迟”描述成封禁风险的保证；它只能降低固定节奏特征，不能绕过风控。

## 2. 当前已经确认的事实

证据分为三类：抓包/源码直接确认、用户提供的服务端前提、尚待一次受控提交确认。

### 2.1 抓包和客户端源码直接确认

#### 主线协议序列

真实抓包 `local-data/push_level` 已确认：

```text
fight_startlevel({})
    -> Fight_StartLevelResp
    -> 客户端本地战斗，没有逐回合战斗网络包
    -> fight_endlevel({...})
    -> Fight_EndLevelResp
    -> 再次 fight_startlevel({})
```

`fight_startlevel` 请求 body 是空对象。关卡进度由服务器维护，客户端不在请求中指定下一关。

#### `Fight_StartLevelResp` 的核心内容

```js
{
  battleData: {
    id: 0,
    mode: 0,
    randomSeed: 6313,
    version: 240514,
    leftTeam: {...},
    rightTeam: {...},
    options: {
      levelId: 1812,
      autoSpeed: 100,
      IsActLevel: 0
    }
  }
}
```

实际字段数量会随账号阵容、敌方阵容和关卡变化。不能只读取 `randomSeed`，必须保留完整 `battleData`，特别是 `leftTeam`、`rightTeam` 和 `options.levelId`。

#### `fight_endlevel` 的请求体

```js
{
  levelId,
  battleTime,
  tapTimes,
  autoTapTimes,
  outputCode,
  log: ""
}
```

真实 09:40 日志中，外层 body 为 BON 编码，普通请求解码后长度约 142 字节；响应为 `Fight_EndLevelResp`。当前 helper 已注册 `fight_endlevel`，并有本地 BON/x 编解码回环测试。

#### `battleTime` 的单位

官方 TGA 日志同时记录人类可读的战斗时间和引擎 tick。例如 1812：

```text
TGA battleTime = 17
TGA battleTick = 447
fight_endlevel battleTime = 447
```

因此发送给 `fight_endlevel` 的 `battleTime` 应使用 `battleTick`，不是 TGA 日志中较小的秒数。调度器的等待时间另设字段，不能与协议 `battleTime` 混用。

### 2.2 `outputCode` 的哈希原文已经确认

官方客户端调用点已经通过研究桥捕获，公式为：

```text
outputCode = Md5.hashStr(JSONExt.stringify(ClientBattleResult))
```

`JSONExt.stringify` 的关键行为是：

- 等价于无缩进 `JSON.stringify`。
- `Map` 会转为普通对象。
- `undefined` 属性会被 JSON 序列化丢弃。
- 普通对象键顺序必须保持官方插入顺序。

真实 09:40 日志中有 9 条 `hash:matched`：

- 6 条 inputCode 原文，其中部分是同一关卡重复计算。
- 3 条 outputCode 原文，分别对应 1812、1813、1814。
- 所有原文使用本地 Node MD5 复算均一致。

这意味着 MD5 算法、UTF-8 输入、官方调用入口和结果原文都已取得，不需要再从 digest 反推字符串。

### 2.3 `ClientBattleResult` 的哈希时刻结构

1812/1813/1814 的 outputCode 原文顶层键顺序稳定为：

```js
{
  id: 0,
  isWin: true,
  seed: 6313,
  totalFrame: 0,
  version: 240514,
  battleVersion: "",
  inputCode: "",
  outputCode: "",
  log: "",
  sponsor: {...},
  accept: {...},
  type: 0,
  round: 0,
  isTimeout: 0,
  statistic: {}
}
```

这是**计算 outputCode 的时刻**的对象。官方在计算 MD5 后才回填 `round`、`totalFrame`、`inputCode`、`outputCode` 和 `battleVersion`，所以不能把战斗结束后最终展示对象直接拿来哈希。

### 2.4 双方队伍结构

```js
{
  roleId,
  name,
  headImg,
  avatarFrame,
  power,
  teamInfo: [...],
  ext: {
    curHP
  }
}
```

每个 `teamInfo` 成员的稳定字段集合为：

```js
{
  heroId,
  color,
  level,
  order,
  index,
  rage,
  club,
  slot,
  star,
  damage,
  takeDamage,
  treatment,
  hp,
  energy,
  skin,
  skinName,
  type,
  maxAttr,
  statistic,
  skillDamage,
  skillTreatment,
  enchantMap
}
```

样本显示：

- 我方 `sponsor.teamInfo` 通常为 5 个成员。
- 敌方 `accept.teamInfo` 可能是 3 个，也可能是 15 个。
- 成员伤害、受击、治疗、剩余 HP、怒气和 `maxAttr` 会变化。
- `statistic`、`skillDamage`、`skillTreatment`、`enchantMap` 在普通样本中可能为空，但必须保留字段。
- `sponsor.ext.curHP` 会变化，不能固定写死为 0。

### 2.5 inputCode 与 outputCode 的区别

`inputCode` 不是最终提交字段，它是对 battleData 的客户端自校验：

```js
battleData.leftTeams = undefined;
battleData.rightTeams = undefined;
battleData.result = null;
inputCode = Md5.hashStr(JSONExt.stringify(battleData));
```

09:40 日志中的 inputCode 原文包含完整 `leftTeam`、`rightTeam`、`options` 和配置字段，说明生成 inputCode 时不能用简化对象。

`outputCode` 才是 `fight_endlevel` 要提交的 32 位十六进制字符串。

## 3. 研究器当前状态

### 3.1 研究页面

入口：[src/views/PushLevelResearch.vue](../src/views/PushLevelResearch.vue)

已具备：

- 同源游戏 iframe。
- 临时 BIN 文件载入到当前页面内存，不自动写 IndexedDB。
- 模块探测。
- 控制台、全局异常和 WebSocket 生命周期/帧摘要。
- 官方 TGA 战斗日志归一化。
- `px` XOR 去头、`pl` LZ4/XOR 解密和 BON 外层解析。
- `ts-md5.Md5.hashStr`/`hashAsciiStr` 的只读捕获。
- JSONL 日志下载。
- 新战斗开始时清除上一场摘要，避免混入上一场 outputCode。

### 3.2 iframe 桥

入口：[public/game/push-level-research-bridge.js](../public/game/push-level-research-bridge.js)

当前桥版本：`2026-09-03.19`。

启动页已经使用版本 query，见 [public/game/index.html](../public/game/index.html)：

```html
push-level-research-bridge.js?v=20260903.19
```

`index.html` 全静态加载（patch/main/cocos/xh/diagnose_require/bridge/boot），不再使用 document.write 动态加载 `sh1.js`（document.write 会切断后续静态脚本解析）；上号器由桥 v19 在 DOMContentLoaded 后动态注入：`research=push-level` 被动页跳过，普通运行时与 `headless-test=1` iframe 均注入（headless iframe 需带 `bin_id=<tokenId>` 让 sh1 自动登录并进入主城，从而完成 `ServerBattleLauncher` 初始化）。

桥固定为 `passive-capture`：

- 阻止 `battle:start`。
- 阻止 `battle:simulate`。
- 阻止 `battle:end`。
- 不包装官方战斗 API。
- 不修改官方 MD5 返回值。
- 不主动发送未知战斗包。

这条安全边界必须保留。若以后需要重方案主动执行，应另建显式的 test-only 入口，并且不能让生产研究页默认获得主动权限。

### 3.3 当前登录兼容链

当前远程版本不存在旧版 `data-index.LoginService.mix`。正确链路是：

```text
BIN 解码 -> saveInfo.info
    -> PlatformManager.instance.encryptUserInfo = saveInfo.info
    -> authorizeDeferred.resolve(saveInfo.info)
    -> 官方 GameLogin 继续
    -> LoginManager.instance.login()
    -> LoginService.authUser()
    -> NetworkManager.connect()
    -> RoleService.getRoleInfo()
```

用 `wechat.bin` 自测已确认 BIN 解码、`authUser`、WebSocket 建立、`role_getroleinfo`/`Role_GetRoleInfoResp` 和 BON 解码正常；当前研究 iframe 的最终 `GameRunning`/`ROLE.authed` 状态仍受官方页面初始化时序影响，不能仅凭 `GameLogin` 快照判断失败。不要恢复调用 `LoginService.mix`。

## 4. 重方案：官方运行时保底

重方案不是最终目标，而是用于解决版本差异、验证官方数据结构和在轻方案失败时提供兼容保底。

### 4.1 重方案 A：被动研究模式

当前已经实现的是这一层：

```text
同源 iframe
    -> 用户手动登录/手动推关
    -> 记录官方 TGA、WS、模块、MD5 调用
    -> 下载 JSONL
```

它不应该承担自动发送。用途是：

- 确认远程版本和模块名。
- 捕获新的 `ClientBattleResult` 样本。
- 发现 BOSS、多波次、活动关的字段差异。
- 对比官方 outputCode 与本地生成器。

### 4.2 重方案 B：官方无头引擎保底

如果某些关卡的服务端接受规则比当前前提复杂，重方案可以让 iframe 使用官方无头引擎：

```text
FightService.startLevel({})
    -> 官方类型化 battleData
    -> BattleManager.instance.startQuickLevelBattleById(...)
    -> noRender / quickBattle
    -> BattleEndSignal
    -> getBattleResult(true, false)
    -> 官方 outputCode
    -> FightService.endLevel(...)
```

这个方案的优势是官方类型、配置、成员统计和序列化天然一致；缺点是依赖 Cocos、远程 CDN、动态资源、账号会话和 iframe 内存，批量运行成本较高。

如果采用这一层，必须单独解决：

1. `battleData` 必须是官方类型实例，不是父页面普通对象。
2. `ServerBattleLauncher` 的 `battleData.id` 缓存不能重复复用已结束战斗。
3. 多波次只能在最后一波胜利后提交 endLevel。
4. 每个 iframe 一次只绑定一个账号，避免 `localStorage` 和角色状态互相覆盖。
5. 生产部署必须锁定或记录远程 bundle 版本，不能静默切换到结构不兼容版本。

### 4.3 重方案与轻方案的关系

```text
重方案：官方运行时负责“准确生成结果”
轻方案：本项目代码负责“按已确认公式生成结果”

重方案用于建立基准和处理未知差异。
轻方案用于最终无 iframe、低资源、可批量调度。
```

轻方案的每个新版本应先用重方案或历史真实原文做离线对比，通过后才允许接入正式调度器。

## 5. 轻方案：纯网页端合成成功结果

轻方案不需要加载 `public/game`，只使用现有 Token WebSocket、BON 和 MD5。

### 5.1 建议目录

后续可按以下边界新增文件，避免把逻辑继续堆进 `PushingLevels.vue`：

```text
src/utils/pushLevel/
  battleData.js       // startLevel 响应解包、关卡和阵容归一化
  jsonExt.js          // JSONExt 等价序列化，保留键序和 Map 规则
  outputCode.js       // ClientBattleResult 构造和 MD5
  endLevel.js         // fight_endlevel payload 构造
  scheduler.js        // 间隔、随机偏移、暂停、重试和状态机
  types.js            // JSDoc/TypeScript 数据契约（可选）
```

测试可新增：

```text
test/pushLevelOutputCode.test.js
test/pushLevelScheduler.test.js
test/pushLevelEndLevel.test.js
```

### 5.2 `outputCode` 生成器职责

建议 API：

```js
buildOutputCode({
  battleData,
  isWin: true,
  sponsorMembers,
  acceptMembers,
  sponsorCurHp,
  acceptCurHp,
}) -> {
  result,
  serialized,
  outputCode,
}
```

实现要求：

1. `result.seed = battleData.randomSeed`。
2. `result.version = battleData.version`。
3. `result.id = battleData.id ?? 0`。
4. `result.type = battleData.mode ?? 0`。
5. 计算时 `isWin=true`。
6. 计算时 `totalFrame=0`、`battleVersion=""`、`inputCode=""`、`outputCode=""`、`log=""`、`round=0`、`isTimeout=0`、`statistic={}`，除非新的官方样本证明某字段不同。
7. 顶层字段必须按官方插入顺序建立，不能先 spread 一个字段顺序未知的对象。
8. `sponsor` 和 `accept` 必须拥有 `roleId/name/headImg/avatarFrame/power/teamInfo/ext` 结构。
9. `teamInfo` 中每个成员必须拥有稳定字段集合，即使数值是 0 或对象为空也不能随意删除。
10. 敌方成员数量必须从当前 battleData/模板动态决定，不能固定为 3 或 15。
11. `maxAttr` 的键必须保持官方形式：`2`、`3`、`4`。
12. 计算原文使用 UTF-8 MD5，输出小写 32 位十六进制。

### 5.3 成员模板策略

建议按可靠性分三层：

#### 第一层：从当前 battleData 复制身份字段

从 `leftTeam.teamInfo`、`leftTeam.team`、`rightTeam.team` 复制：

```text
heroId/id, type, skin, skinName, color, club,
level, star, order, index, slot, enchantMap 等
```

结果战绩字段再使用合成值。

#### 第二层：固定成功统计模板

在“服务器只检查 outputCode 公式”的前提下，先使用最小成功模板：

```text
damage/takeDamage/treatment/hp/rage/energy = 0
maxAttr = {2: 0, 3: 0, 4: 0}
statistic = {}
skillDamage = {}
skillTreatment = {}
enchantMap = {}
```

注意：这只是需要一次受控提交才能确认的实现假设，不应在真实主账号上试验。

#### 第三层：使用已捕获的真实结果作基准

如果最小模板不被接受，可让重方案或一次安全样本提供真实 `sponsor/accept` 结构，再按关卡/敌方人数建立模板。不要把完整真实账号数据直接硬编码进仓库；模板应脱敏并只保留必要结构。

### 5.4 `fight_endlevel` 集成

需要修改 [src/utils/xyzwWebSocket.js](../src/utils/xyzwWebSocket.js)：

```js
registerDefaultCommands(reg) {
  return reg
    .register("fight_startlevel")
    .register("fight_endlevel")
}
```

正常注册即可让 `CommandRegistry` 使用 BON 编码 params。除非抓包证明 body 需要特殊包装，不要使用 `rawBody: true`。

响应映射建议加入兼容项：

```js
fight_endlevelresp: "fight_endlevel"
```

当前 Promise 响应处理优先使用 `resp` 字段匹配，因此映射不是严格必要，但加入后便于没有 `resp` 的旧响应兼容。

需要确认的请求调用形态：

```js
await tokenStore.sendMessageWithPromise(
  tokenId,
  "fight_endlevel",
  {
    levelId,
    battleTime: battleTick,
    tapTimes: [[]],
    autoTapTimes: [[]],
    outputCode,
    log: "",
  },
  timeout,
);
```

不要把 `battleVersion` 自动注入 endLevel，除非新的真实报文确认它是 body 字段。当前抓包的 endLevel body 顶层没有该字段。

### 5.5 自动调度器

建议为每个账号维护独立状态：

```text
idle
connecting
ready
waiting
starting
building-result
submitting
confirming
paused
stopped
error
```

伪代码：

```js
while (state.running && !state.stopRequested) {
  await waitWithJitter(settings.baseInterval, settings.jitter, state);

  const start = await startLevel(tokenId);
  const battle = normalizeBattleData(start);
  const generated = buildOutputCode({
    battleData: battle,
    isWin: true,
    template: settings.resultTemplate,
  });
  const payload = buildEndLevelPayload({
    battleData: battle,
    outputCode: generated.outputCode,
    battleTime: settings.syntheticBattleTick,
    tapTimes: settings.tapTimes,
    autoTapTimes: settings.autoTapTimes,
  });

  const response = await endLevel(tokenId, payload);
  assertProgress(response, battle.options.levelId);
}
```

调度参数建议：

```js
{
  baseIntervalMs: 30000,
  jitterMs: 5000,
  minIntervalMs: 5000,
  maxIntervalMs: 120000,
  syntheticBattleTick: 447,
  tapTimes: [[]],
  autoTapTimes: [[]],
  maxRetries: 1,
  autoContinue: true
}
```

这些只是安全的初始默认值，不是协议事实。真正上线前应根据服务器返回和测试账号调节。

随机延迟实现应满足：

```text
delay = clamp(baseInterval + random(-jitter, +jitter), min, max)
```

优先使用 `crypto.getRandomValues`，没有时才退回普通随机数。每次等待前记录实际 delay，但不要把随机数种子或 Token 写入日志。

### 5.6 失败和重试规则

`fight_endlevel` 可能改变关卡状态，因此不能像普通 GET 请求一样无限重试。

建议：

- WebSocket 在发送前断开：重连后重新获取 startLevel，不复用旧 battleData。
- endLevel 发送后超时：先查询角色关卡或再次请求 startLevel，判断是否已经推进，再决定是否重试。
- 收到 `Fight_EndLevelResp`：记录响应 code、role.levelId、奖励和下一关状态。
- outputCode 错误：停止该账号，不连续重复提交。
- 关卡不匹配：停止该账号并记录 `expectedLevel/responseLevel`。
- 达到重试上限：进入 `paused/error`，等待用户处理。

## 6. 现有正式页面的关系

### 6.1 当前 [PushingLevels.vue](../src/views/PushingLevels.vue)

当前实现是旧的服务器权威旁路：

```text
fight_calcleveltime
    -> 等待服务器返回的时间
    -> fight_level
```

它不生成 outputCode，不属于目标轻方案。第一阶段不要直接替换它，避免把已能工作的路径和研究中的合成路径绑在一起。

推荐新增独立的前台合成推关模式，或者先新增独立页面/开关：

```text
服务器权威模式：保留现有行为
前台合成模式：新 generator + fight_endlevel + scheduler
研究模式：PushLevelResearch，只读捕获
```

### 6.2 UI 配置建议

正式轻方案页面至少需要：

- 账号选择。
- 基础间隔。
- 随机偏移范围。
- 最大连续错误次数。
- 自动继续开关。
- 开始/暂停/停止。
- 当前关卡、最近 seed、最近 outputCode 摘要。
- 最近响应 code 和服务器关卡。
- 本地生成的 serialized 长度和 MD5 校验状态。
- “仅生成不发送” dry-run 选项。

不要让“研究模式”的原文捕获默认打开，因为 `ClientBattleResult` 原文可能包含大量角色和阵容数据。

## 7. 分阶段实施计划

### Phase 0：冻结证据和边界

- [x] 保存原始 push_level 抓包。
- [x] 记录 `fight_startlevel`/`fight_endlevel` 字段。
- [x] 捕获 inputCode/outputCode 哈希原文。
- [x] 用本地 MD5 复算 09:40 的 9 条匹配记录。
- [x] 研究页固定被动模式。
- [x] 确认真实 BIN 登录链路。
- [ ] 把 1 条 outputCode 原文脱敏成测试 fixture，不包含真实角色身份或 Token。

### Phase 1：纯本地序列化和 MD5 模块（已完成）

- [x] 实现 `jsonExt.js`。
- [x] 实现 `outputCode.js`。
- [x] 实现 inputCode 计算辅助函数。
- [x] 用 1812、1813、1814 三组官方原文做逐字回放测试。
- [x] 断言原文长度、顶层键顺序、MD5 digest 完全一致。
- [x] 覆盖敌方 3 人和 15 人两种结构。
- [x] 覆盖 `undefined`、空 Map、数字键和空数组。

完成标准：不连接网络，仅凭脱敏 fixture 得到与日志相同的 digest。当前已用 09:40 的 3 条 outputCode 原文逐字回放，digest 与原文长度全部一致。

### Phase 2：协议发送层（已完成基础接入）

- [x] 在 `CommandRegistry` 注册 `fight_endlevel`。
- [x] 加入响应映射。
- [x] 写 payload 编码测试，确认 BON body 的字段和值。
- [x] 写真实 BON/x 编解码回环测试。
- [x] 不修改现有 `fight_level` 路径。

完成标准：测试桩 WebSocket 能看到正确 cmd、body 字段和响应处理。

### Phase 3：单账号 dry-run（已完成基础接入）

- [x] 从 startLevel 和角色/预设阵容响应读取数据，本地生成 payload，不默认发送。
- [x] 页面展示：levelId、seed、成员数量、serialized 长度、outputCode 和 payload。
- [x] 结果生成器拒绝不完整双方阵容，避免静默生成错误哈希。
- [x] 不把完整原文默认写入生产日志。

完成标准：对同一 battleData 多次生成结果完全确定，时间调度不会改变 outputCode。

### Phase 4：受控提交验证

这一阶段必须使用用户明确允许的测试账号，且一次只验证一场。不要在真实主账号上盲试。

建议测试矩阵：

| 试验 | 内容 | 目的 |
|---|---|---|
| A | 官方正常成功结果 | 基线，确认账号和关卡状态 |
| B | 公式正确的合成 `isWin=true` 结果 | 验证用户提供的服务端前提 |
| C | B 的 outputCode 改 1 个字符 | 确认服务端错误边界 |

每次只允许一个 endLevel 请求。必须记录：

- 请求前关卡。
- levelId/seed。
- outputCode。
- 响应 code。
- 响应 role.levelId。
- 下一次 startLevel 的 levelId。
- 是否重复连接或超时。

如果 B 成功，轻方案的核心假设得到验证；如果 B 失败，立即停止轻方案，回到重方案分析服务端所需字段。

### Phase 5：调度器和单账号正式模式（已完成代码接入，待线上验收）

- [x] 实现状态机。
- [x] 实现 interval/jitter/clamp。
- [x] 实现发送后确认，不盲重试。
- [x] 实现暂停和停止，并覆盖提交中停止/暂停恢复竞态。
- [x] 页面默认关闭提交和自动继续，单场动作需要二次确认。
- [x] 将 `isWin` 和整数 `battleTime` 提炼为冻结的共享战斗配置；默认目标为胜利、`447` tick，预览和调度启动共用同一份配置快照。
- [x] `buildPushLevelDryRun()` 将目标结果带入 `outputCode` 哈希，并将指定 tick 带入 `fight_endlevel` payload。
- [ ] 先只允许一个账号运行的真实测试。
- [ ] 运行稳定后再评估多账号并发。

完成标准：测试账号连续多场推进，日志能还原每一轮的 start、生成、end、response、confirm。

### Phase 6：重方案兜底和轻方案切换

- [ ] 将 iframe 官方运行时作为可选 fallback，而不是默认依赖。
- [ ] 对轻方案失败的关卡保存 battleData 和合成结果摘要。
- [ ] 允许用户选择“此账号回退官方无头引擎”或“暂停等待分析”。
- [ ] 记录远程 bundle 版本和研究桥版本。
- [x] 研究桥增加只读 `runtime:capabilities`，只有检测到 `_serverBattleFactory` 后才报告可运行官方无头引擎。
- [x] 增加隔离的 `headless-test=1` 单场测试命令；该命令要求 `testOnly=true`，每个 iframe 最多运行一场，且只生成结果、不发送结算。
- [x] 官方无头引擎实测打通（桥 v19，2026-09-03）：headless iframe 带 `bin_id` 由 sh1 自动登录进主城，`_serverBattleFactory` 初始化成功，首场官方无头战斗生成完整结果且与本地公式复算一致（见协议研究文档 8.3）。**当前可直接用于单场无头结果生成；自动连续推关仍未启用**（尚未做真实 `fight_endlevel` 受控提交）。
- [ ] 真实账号 `fight_endlevel` 单场受控提交（公式在官方引擎侧已获基准验证，待服务器接受度确认；成功后即可启用自动连续推关）。
- [ ] 不让 passive bridge 获得自动发送权限。

桥版本 `2026-09-03.16` 已把无头引导升级为诊断优先：只读 `headless:diagnose` 输出 `BattleManager` 实例字段、`init`/`updateServerFactory`/`startQuickLevelBattleById` 源码预览，并在可达模块中搜索 `ServerBattleLauncher`/`ClientBattleLauncher`/`seasonBattleTypes`；`headless:generate` 依次尝试 `init()` → `updateServerFactory()` → 直接构造 Launcher 挂到 `_serverBattleFactory`，每步结果写入 `headless:bootstrap`。研究页新增“官方无头引擎测试”卡片（headless-test iframe + BIN 注入 + 能力/诊断/单场生成）。下一次运行时测试应先在 `headless:diagnose` 里确认 `seasonBattleTypes` 的来源和 `init()` 期待的参数，再决定用哪种引导方式，而不是猜测配置形状。

2026-09-03 实测更新（桥 v16→v18，见协议研究文档 8.2/8.3）：已用真实 BIN 完成登录链路与能力快照；`BattleManager.init()` 无参、直接 `new ClientBattleLauncher().initialize()` + `new ServerBattleLauncher().initialize()`；`ClientBattleLauncher.initialize()` 正常，**`ServerBattleLauncher.initialize()` 抛 `seasonBattleTypes` undefined**，堆栈定位 `TEST_REMOTE_MODULE/index.5cf54.jsc:1:1350521`。`seasonBattleTypes` 持有者在可达模块中不存在（懒加载赛季模块填充），且 headless-test 会话稳定停在 GameLogin、不自动进入 GameRunning。**桥 v19 实测已打通**：headless iframe 改带 `bin_id=<tokenId>` 由 sh1 自动登录进主城（GameRunning）后，`_serverBattleFactory`/`readyForHeadless` 为 true；首场官方无头战斗（1841 关）成功生成完整 `ClientBattleResult`（outputCode=`ee22765831858a8dab7af8c4fb133699`，battleTick=448），且本地按文档公式重建哈希时刻对象复算 digest 与官方**完全一致**（serializedLen=2805，样本在 local-data）。剩余工作：真实 `fight_endlevel` 单场受控提交（公式在官方引擎侧已获基准验证）。

## 8. 测试与验收清单

### 8.1 单元测试

- MD5 标准测试：`hello -> 5d41402abc4b2a76b9719d911017c592`。
- outputCode 三个已知原文 digest 全部一致。
- 同一输入重复生成完全一致。
- `Map` 和普通对象序列化一致。
- `undefined` 字段被丢弃，`null` 字段保留。
- 顶层键顺序与官方一致。
- enemy teamInfo 3/15 人都能生成。
- battleTime 不参与 outputCode 原文，除非官方新证据证明参与。

### 8.2 协议测试

- `fight_startlevel` body 是空对象。
- `Fight_StartLevelResp` 能取得 battleData。
- `fight_endlevel` body 使用 `battleTick` 作为 battleTime。
- response 可以按 `resp` 匹配。
- endLevel 超时不会自动重复造成重复结算。

### 8.3 运行测试

- 账号断线后能停止在安全状态。
- startLevel 返回异常时不构造并发送 endLevel。
- levelId 不连续时暂停。
- 服务器返回错误 code 时记录并停止/等待。
- jitter 计算受 min/max 限制。
- 刷新页面不会默认恢复正在发送的任务。

### 8.4 构建命令

当前 package scripts 没有统一 test 命令，已有测试通常直接用 Node 执行。开发完成后至少运行：

```bash
node --check <新增纯 JS 文件>
npm run build
git diff --check
```

若新增 Node test 文件，再执行：

```bash
node --test test/<相关测试>.test.js
```

## 9. 安全和数据处理要求

1. `wechat.bin`、Token、`roleToken`、`encryptCombUser`、登录响应和完整角色 JSON 不得写入仓库。
2. 日志下载前默认脱敏，只有用户主动开启哈希原文捕获才保存 `preimage`。
3. 研究页保持 `passive-capture`，不得把 `battle:start`/`battle:end` 解锁作为普通调试按钮。
4. 任何主动 endLevel 验证都必须显式 test-only，并且一次只发一场。
5. 不把“随机偏移”当作封禁规避保证；应提供暂停、错误停止和用户确认。
6. 生产轻方案不需要 iframe 时，应让其不加载游戏 bundle，减少资源、会话和账号状态耦合。
7. WebSocket 断线后不能复用旧的 battleData、seed 或 outputCode；必须重新 startLevel。
8. 不要从下载日志中的加密原始帧直接复制请求 body；使用已确认的 CommandRegistry/BON 编码路径。

## 10. 给后续 AI 的接手顺序

后续 AI 接手时建议按以下顺序读取：

1. 本文档。
2. [docs/mainline-pushlevel-protocol-research.md](mainline-pushlevel-protocol-research.md)。
3. [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md) 中的 pushLevel 段落。
4. [src/utils/xyzwWebSocket.js](../src/utils/xyzwWebSocket.js) 的 `CommandRegistry`、`registerDefaultCommands` 和 Promise 响应处理。
5. [src/stores/tokenStore.ts](../src/stores/tokenStore.ts) 的 `sendMessageWithPromise` 和连接生命周期。
6. [src/views/PushingLevels.vue](../src/views/PushingLevels.vue) 的旧服务器权威实现，只作为对照，不要直接覆盖。
7. [src/views/PushLevelResearch.vue](../src/views/PushLevelResearch.vue) 与 [public/game/push-level-research-bridge.js](../public/game/push-level-research-bridge.js) 的被动研究实现。
8. 09:40 日志中的 `hash:matched` 记录和脱敏 fixture。
9. [docs/reverse-engineering/README.md](reverse-engineering/README.md) 与 [docs/reverse-engineering/7.7.12-skip150.md](reverse-engineering/7.7.12-skip150.md) 中的注入脚本/`skip150` 逆向记录；该路径是本地 `LevelConf` 配置 Hook，不要与 `fight_endlevel` 结果提交路径混用。

研究 iframe 的 `index.html` 默认只加载当前研究桥；旧版 `sh1.js` 上号器通过 `legacy-tools=1` 或 `bin_id` 显式启用，`diagnose_require.js` 通过 `diagnose=1` 显式启用。不要因为看到旧脚本文件仍在仓库中，就假设它会参与当前研究流程。

第一项编码工作应是：

```text
先实现纯本地 outputCode 生成器和 fixture 测试
    -> 再注册 fight_endlevel
    -> 再做 dry-run 页面
    -> 最后才考虑受控发送和调度器
```

不要第一步就改 `PushingLevels.vue` 或在真实账号上发送合成战报。

## 11. 当前状态结论

截至 2026-09-02：

- 协议基本形状已确认。
- outputCode 的 MD5 原文已真实捕获。
- 9 条哈希原文已本地复算一致。
- 当前版本的登录兼容链已验证。
- 被动研究器和日志下载已实现。
- `fight_endlevel` 的 helper 注册、响应映射和 BON/x 回环测试已完成。
- 纯本地结果生成器、敌方 3/15 人模板和角色/预设阵容模板已完成。
- 调度器、随机间隔、暂停/停止和单场页面已完成代码接入。
- “公式正确的合成成功结果能否推进关卡”尚未在服务器上做受控确认。

截至 2026-09-03，项目已经完成**生成器、协议接入、dry-run 页面、统一战斗配置和调度器代码**；主线专项测试为 `35/35` 通过，研究桥语法和相关编辑器诊断无错误。重方案**已通过真实服务器验收**（桥 v21，见协议研究文档 8.2/8.3）：headless iframe 由 sh1 登录进主城后 `_serverBattleFactory` 就绪；官方无头引擎真实打赢（80号战士 1964 关）→ 提交（body 完整 6 键，`battleData.options` 为类型实例需兼容取 levelId）→ **服务器接受并推进（role.levelId=1965）**，证明"官方无头引擎 + 提交"链路可真实自动连续推关（仅限能打赢的关卡）。**伪造胜利不可行**：9070 关（130301444）引擎真实打输后无论仅改 isWin 还是合成"胜利形态/守恒自洽"战绩（含官方快推时间表）均被拒（200020→800080 战斗异常），服务器校验结果真实性。轻方案公式实现与官方引擎输出 bit 级一致，但自定义成功结果无服务器接受可能（服务器校验战斗真实性）；轻方案实际价值转为"结果预览/引擎一致对照"，真实推关应走重方案（官方引擎打赢才提交）。