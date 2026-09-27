# 周一白玉 & 预约比赛 指令分析

## 抓包来源

| 文件 | 时间 | 账号（token 名） | 内容 |
| --- | --- | --- | --- |
| `local-data/misc/monday_white_jade.jsonl` | 2026-09-27T18:12 | 世界国皇帝-0-130301444（9724 服） | 重复领取白玉 |
| `local-data/misc/monday_white_jade1.jsonl` | 2026-09-27T18:26 | 特别单纯-1-484687187（9724 服） | **首次**领取白玉 |
| `local-data/misc/watch.jsonl` | 2026-09-27T18:14 | 世界国皇帝-0-130301444 | 重复预约比赛 |
| `local-data/misc/watch1.jsonl` | 2026-09-27T18:26 | 特别单纯-1-484687187 | **首次**预约比赛（全流程，含 PKRoom_* 家族） |

> ⚠️ 两个账号**都是首次预约**（该活动不定期出现，频繁时每天都有，稀疏时一个月一次）。
> 这一点很关键 —— 见下文「预约比赛的错误码」。

**验证状态**：四个抓包的 SEND 帧全部逐字节精确复现（`verify_roundtrip.mjs --dir send`）：

- `monday_white_jade.jsonl` 精确 2/2
- `monday_white_jade1.jsonl` 精确 2/2
- `watch.jsonl` 精确 3/3
- `watch1.jsonl` 精确 14/14（另有 6 条明文心跳，预期）

合计 **21/21 精确复现、0 失败** —— 所有命令的编码格式均已完全掌握。

---

## 一、每周一领 100 白玉 —— `activity_claimrolluppack`

### 请求（两个账号完全一致）

```json
{
  "ack": 0,
  "body": { "id": 17 },
  "time": 1790533593098,
  "seq": 44,
  "cmd": "activity_claimrolluppack"
}
```

明文 87 字节，`px`(x) 方案。**body 只有 `id` 一个字段（BON Int tag 1），本次 = 17。**

### 响应（成功）

响应命令 `Activity_ClaimRollUpPackResp`，`resp` 回指请求 seq。

账号 A（重复领，18:12）：
```json
{
  "role": {
    "items": { "1022": { "quantity": 180281 } },
    "statisticsTime": { "night:mare:buy:17": 1790532755 }
  },
  "reward": [{ "type": 3, "itemId": 1022, "value": 100, "ext": 0 }]
}
```

账号 B（首次领，18:26）：
```json
{
  "role": {
    "items": { "1022": { "quantity": 192352 } },
    "statisticsTime": { "night:mare:buy:17": 1790533593 }
  },
  "reward": [{ "type": 3, "itemId": 1022, "value": 100, "ext": 0 }]
}
```

**两个账号的 `id` 都是 17、都发 100 白玉、`itemId` 都是 1022** → 结论高度确定：

1. **`itemId 1022` = 白玉**（与 `src/components/Common/IdentityCard.vue` 既有物品表一致）。
2. **`id` 是卡包 ID，不是活动 ID。** `statisticsTime` 的键 `night:mare:buy:17` 反证了这点。
3. **「每周一」闸门完全在服务端**，靠 `night:mare:buy:<id>` 的时间戳判定（值是领取当下的秒级时间戳）。**客户端不需要判星期几** —— 无脑调用即可，重复领服务端自己会挡。
4. **首次/重复领取的响应结构完全相同**（都是成功 + 100 白玉），说明服务端不会因为「已领过」而返回不同结构 —— 本次两条都是成功路径。
5. 卡包配置表 = `RollUpPackConf`（`src/xyzw/index.js:23638`，字段 `id / merchandise / condition`）。
6. **`id` 不止 17 一个**（键结构 `night:mare:buy:<id>` 说明是按 id 铺开的一批礼包）。**待枚举**：需要打开梦魇活动逐个点开礼包领取，记录每条 `body.id`。

### 落地（`src/utils/xyzwWebSocket.js`）

```js
// registerDefaultCommands()
.register("activity_claimrolluppack", { id: 17 })
```

```js
// responseToCommandMap
activity_claimrolluppackresp: "activity_claimrolluppack",
```

⚠️ `id` 必须是 **number**（BON Int tag 1）。从字符串键/正则取出来的一律 `Number(id)`。
⚠️ 失败响应**没有 `cmd` 也没有 `body`**，成败只看 `code`，原因只能读 `error`。
（白玉这条成功路径走的是 `*Resp`，没问题；但注意**并非所有错误信封都带 `resp`** —— 见第二部分。）

> **范围约定（master 定）**：只有 `id:17` 这一个卡包是**免费**的，其余卡包均收费 → **本工具只做 17，不做枚举**。

---

## 二、预约/关注比赛 —— `pkroom_appoint`

> **需求约定（master 定）**：预约**只是为了拿系统到点发的邮件奖励**，不是为了看比赛。
> 因此**不做「取消预约」**，也**不需要**任何 PK 房查询命令
> （`pkroom_getfightroominfo` / `getfightroomdetail` / `getinfo` / `getfightroomhistory` / `system_getchatmessage`
> 全是 UI 展示用，与本需求无关）。

### 请求（两个账号完全一致）

```json
{
  "ack": 0,
  "body": {},
  "time": 1790533632914,
  "seq": 54,
  "cmd": "pkroom_appoint"
}
```

明文 68 字节。**body 是空对象 `{}`（BON 空 map，2 字节 `08 00`），一个参数都没有。**

### 响应 —— 「首次预约」也走错误码！

`watch1.jsonl` 是**首次预约**（master 已确认），服务端仍然回了错误信封：

```json
{
  "seq": 58, "ack": 0, "time": 1790533633073,
  "code": 11900050,
  "error": "感谢您预约本场比赛，开赛后可领取奖励"
}
```

紧接着的 `SyncResp`（`resp: 54`，回指同一请求）：

```json
{
  "seq": 59, "ack": 0, "time": 1790533633075, "resp": 54,
  "cmd": "SyncResp",
  "body": { "role": { "statistics": { "pk:appoint:room:id": 119131529 } } }
}
```

### 🔑 核心结论：`code 11900050` 是「已受理」语义，不是失败

两个账号（一个重复、一个首次）返回**完全相同**的 `code 11900050` + 同一句文案。
→ **这个 code 是幂等的「已受理/已登记」通知，不是业务失败。**

**判成功的唯一可靠依据 = `SyncResp` 里有没有 `statistics["pk:appoint:room:id"]`，绝对不要判 `code`。**
如果把 `11900050` 当失败写进错误处理，会 100% 误报「预约失败」。

### 🔑 预约目标不可由客户端指定

`pkroom_appoint` **零参数** —— 预约哪场由服务端根据当前 PK 房间状态决定。场次 ID `119131529` 完全是服务端下发到 `statistics` 的。

### 响应时序：一个请求收两条响应

实测顺序（`seq 54` 请求 → `seq 58` 错误信封 → `seq 59` SyncResp）：

```
[ws:send]    pkroom_appoint        seq=54  body={}
[ws:message] (无 cmd 信封)          seq=58  code=11900050  error="感谢您预约本场比赛…"
[ws:message] SyncResp              seq=59  resp=54  statistics["pk:appoint:room:id"]=119131529
```

### ✅ 已实测确认：那条信封**不会**干扰 Promise

**重要更正**：该错误信封的字段是 `{seq, ack, time, code, error}` —— **既没有 `resp`，也没有 `cmd`**。
（此前误以为它带 `resp:54`，实为看错。已用真实抓包逐帧核对确认。）

因此它在 `_handlePromiseResponse` 里的走向是：

1. `if (packet.resp !== undefined && ...)` → **不命中**（没有 `resp` 字段）；
2. `const cmd = packet.cmd; if (!cmd) return;` → **直接 return**（没有 `cmd`）。

→ **它是一条被完全忽略的无效帧，不会 reject、不会 delete pending。**
→ 2ms 后到达的 `SyncResp`（带 `resp:54`）正常命中 resp 分支，把 Promise **resolve** 成
   `body.role.statistics["pk:appoint:room:id"]`。

用真实抓包复刻 `_handlePromiseResponse` 顺序跑过一遍，确认 Promise 被 SyncResp 正确 resolve、房号拿得到。
（验证脚本：`local-data/misc/_verify_appoint_flow2.mjs`）

**结论：按普通 Promise 用法即可，无需特殊处理。**
只需注意 **判成功要看 `statistics`，不要看 `code`** —— 因为错误信封被忽略，`code` 根本不会进入你的回调。

### 落地（`src/utils/xyzwWebSocket.js`）

```js
// registerDefaultCommands()
.register("pkroom_appoint")
```

```js
// responseToCommandMap —— 挂到 syncresp 数组
syncresp: [
  // ...既有项
  "pkroom_appoint",
],
```

⚠️ **不要**写 `pkroom_appointresp` —— 这次成功/首次路径根本不走 `*Resp`，只走 `SyncResp` + 错误信封。

---

## 三、`watch1.jsonl` 的完整全流程（背景资料）

`watch1.jsonl` 内容完整得多，暴露了整个 **`pkroom_*` 命令家族**。
**⚠️ 下表除 `pkroom_appoint` 外，其余均为「看比赛」UI 所需，本需求不用（见第二部分范围约定）**，
此处仅作为背景与延伸参考保留。

### 时序全貌

| 时间 (UTC+8) | 方向 | 命令 | seq | 关键内容 |
| --- | --- | --- | --- | --- |
| 18:26:33 | send | `activity_claimrolluppack` | 44 | `{id:17}` |
| 18:26:33 | recv | `Activity_ClaimRollUpPackResp` | 48 | 白玉 +100，`night:mare:buy:17` |
| 18:26:46 | send | `discount_getdiscountinfo` | 45 | `{}` |
| 18:26:46 | recv | `Discount_GetDiscountInfoResp` | 49 | `discountList[]` |
| 18:26:48 | send | **`pkroom_getfightroominfo`** | 46 | `{}` ← **拿到房号** |
| 18:26:48 | recv | `PKRoom_GetFightRoomInfoResp` | 50 | **`roomId:"119131529"`** 四圣王决赛 |
| 18:26:48 | send | `pkroom_getfightroomdetail` | 47 | `{roomId:"119131529"}` |
| 18:26:48 | recv | `PKRoom_GetFightRoomDetailResp` | 51 | 14 名选手详情、规则、战力 |
| 18:26:48 | send | `system_getchatmessage` | 48 | `{channel:[6]}` |
| 18:26:48 | recv | `System_GetChatMessageResp` | 52 | 聊天 |
| 18:26:48 | send | `pkroom_getinfo` | 49 | `{}` |
| 18:26:48 | recv | `PKRoom_GetInfoResp` | 53 | `advanceRoomCnt: 14` |
| 18:26:51 | send | `pkroom_getfightroominfo` | 50 | `{}`（重查，`hot` 值变了） |
| 18:26:51 | send | `pkroom_getfightroomdetail` | 51 | 同上 |
| 18:26:51 | send | `pkroom_getfightroomhistory` | 53 | `{date:"2026/09"}` |
| 18:26:51 | recv | `PKRoom_GetFightRoomHistoryResp` | 57 | 历史赛事列表 |
| 18:26:52 | send | **`pkroom_appoint`** | 54 | `{}` ← **预约** |
| 18:26:53 | recv | (无 cmd 信封) | 58 | `code:11900050` |
| 18:26:53 | recv | `SyncResp` | 59 | `pk:appoint:room:id = 119131529` |

**注意：`PKRoom_GetFightRoomInfoResp.roomId` = `119131529`，与 `SyncResp` 的 `pk:appoint:room:id` 完全一致。**
→ 证实：预约的就是「当前 PK 房」，且客户端上一步就能通过 `pkroom_getfightroominfo` 提前知道房号。

### 命令参数表（全部实测、全部精确复现）

| 命令 | 请求 body | 说明 |
| --- | --- | --- |
| `pkroom_getfightroominfo` | `{}` | **无需参数**，返回当前 PK 房 `roomId/roomName/leaderName/curRoleNum/rule/startTime/hot` |
| `pkroom_getfightroomdetail` | `{ "roomId": "119131529" }` | ⚠️ **roomId 是字符串！**（BON tag 5，见下） |
| `pkroom_getinfo` | `{}` | 返回 `{ advanceRoomCnt: 14 }` |
| `pkroom_getfightroomhistory` | `{ "date": "2026/09" }` | 历史赛事，date 格式 `YYYY/MM` |
| `pkroom_appoint` | `{}` | 预约当前房 |
| `system_getchatmessage` | `{ "channel": [6] }` | channel 6 = PK 房聊天 |
| `discount_getdiscountinfo` | `{}` | 折扣列表 |

### ⚠️ 坑：`roomId` 必须是字符串

明文逐字节核对（`pkroom_getfightroomdetail`）：

```
05 06 72 6f 6f 6d 49 64 | 05 09 31 31 39 31 33 31 35 32 39
     └── "roomId"         │  └── "119131529"  (9 字节)
   key tag=0x05 (string)  └ value tag=0x05 (string)
```

**`roomId` 的 BON tag = 5（string），不是 1（int）。** 抓包里 `"119131529"` 是**带引号的字符串**。
→ 从 `PKRoom_GetFightRoomInfoResp` 拿到的 `roomId` 本身就是字符串，**直接透传即可，千万别 `Number()`**。
（这与白玉 `activity_claimrolluppack` 的 `id` 恰好相反 —— 那个必须 number。）

### 响应信封命名规律

| 请求命令 | 响应命令 |
| --- | --- |
| `pkroom_getfightroominfo` | `PKRoom_GetFightRoomInfoResp` → 小写键 `pkroom_getfightroominforesp` |
| `pkroom_getfightroomdetail` | `PKRoom_GetFightRoomDetailResp` |
| `pkroom_getinfo` | `PKRoom_GetInfoResp` |
| `pkroom_getfightroomhistory` | `PKRoom_GetFightRoomHistoryResp` |
| `pkroom_appoint` | **无 \*Resp**（走 `SyncResp` + 错误信封） |

---

## 四、四份抓包交叉验证结论

| 结论 | 证据 |
| --- | --- |
| `itemId 1022` = 白玉 | 两账号两次领取，`reward.value` 均 100 |
| 白玉 `id=17` 两账号一致 | A:17 / B:17 |
| 白玉「每周一」在服务端 | `statisticsTime["night:mare:buy:17"]` 两账号均写入 |
| `pkroom_appoint` 零参数 | A/B 两份 body 均 `{}`，明文 68B |
| `11900050` 是「已受理」非失败 | **首次**（B）与**重复**（A）返回完全相同的 code + 文案 |
| 预约房号由服务端下发 | `SyncResp` → `pk:appoint:room:id` |
| 预约房号 = 当前 PK 房 | `PKRoom_GetFightRoomInfoResp.roomId` 与之完全相同 |
| `roomId` 是 string | BON tag 5 逐字节核对 |
| 错误信封不带 `resp` | `pkroom_appoint` 信封字段仅 `{seq,ack,time,code,error}` |

---

## 五、已实现的落地

### 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/utils/xyzwWebSocket.js` | 注册 `activity_claimrolluppack`（默认 `{id:17}`）+ `pkroom_appoint`（无参）；响应映射加 `activity_claimrolluppackresp`，`syncresp` 数组加 `"pkroom_appoint"` |
| `src/utils/whiteJade.js` | 新增：白玉常量与响应解析（`describeWhiteJadeClaim`） |
| `src/utils/pkroomAppoint.js` | 新增：预约语义判定（`isPkroomAppointAcceptedNotice` / `describePkroomAppointResult`） |
| `src/utils/protocolError.js` | 补注：并非所有错误信封都带 `resp` |
| `test/whiteJadeAndPkroomAppoint.test.js` | 新增回归测试 15 例，fixture 逐字取自四份抓包 |

### 调用示例

```js
// 周一白玉（无需判星期，随时可调；重复领由服务端挡）
const body = await ws.sendWithPromise("activity_claimrolluppack", {
  id: WHITE_JADE_PACK_ID, // 17
});
const jade = describeWhiteJadeClaim(body);
if (jade.ok) console.log(`领到 ${jade.quantity} 白玉`);

// 预约比赛（零参数；成功后回 SyncResp，房号在 statistics）
const sync = await ws.sendWithPromise("pkroom_appoint", {});
const res = describePkroomAppointResult(sync);
if (res.ok) console.log(`已预约房间 ${res.roomId}`);
```

### 验证结果

- `node --test test/whiteJadeAndPkroomAppoint.test.js` → **15/15 通过**
- 全量 `node --test "test/*.test.js"` → 315 例、311 通过、**4 失败均为既有基线**
  （`campChallengeTodayOppo` 3 例依赖当天星期 + `tasksTower` 1 例，与本次改动无关）
- `vite build --outDir ._tmp_build --emptyOutDir --minify false` → **成功（44s）**

---

## 六、待办（可选，非阻塞）

1. ~~枚举白玉卡包 id~~ → **已明确不需要**（只有 17 免费，其余收费）。
2. ~~确认无 cmd 错误信封是否提前 resolve~~ → **已确认不会**（该信封无 `resp` 无 `cmd`，被直接忽略）。
3. ~~取消预约命令~~ → **已明确不需要**（预约只为拿邮件奖励）。
4. 可选：若将来要展示「下次可预约时间」，可抓 `startTime` 字段做倒计时（当前不需要）。

---

## 附：验证命令

```bash
N="C:/Users/worldemperor/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
S="C:/Users/worldemperor/.workbuddy/skills/xyzw-protocol-re/scripts"
for f in monday_white_jade monday_white_jade1 watch watch1; do
  $N "$S/verify_roundtrip.mjs" "local-data/misc/$f.jsonl" --dir send
done
```

解码脚本：`local-data/misc/_analyze_misc.mjs`（可传文件名参数，默认解原两份）
响应链路验证：`local-data/misc/_verify_appoint_flow2.mjs`
