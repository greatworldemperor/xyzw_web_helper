# 金鱼（秋季活动 autumn_*）协议备忘

> 来源：`local-data/goldenfish/use_one_item.jsonl`（2026-09-25 抓包，`wss://xxz-xyzw.hortorgames.com/agent`，x 方案 px 帧）
> 实现：`src/utils/batch/tasksGoldenfish.js`，入口 `/admin/batch-daily-tasks` → 批量功能「金鱼」标签页。

## 命令

### 投道具（投一个道具）

```
SEND autumn_useitem  body = { itemNum: 1 }
```

- 请求体**只有数量**，没有 itemId —— 服务端自动扣减投掷道具（抓包中账号道具 1006 余量 344400）。
- 响应 `Autumn_UseItemResp`：
  - `reward: [{ type, itemId, value, ext }]` —— 本次投掷奖励（抓包：`itemId 1006 ×10`）
  - `distance` / `roleAutumn.distance` —— 前进距离（=itemNum）
  - `roleAutumn: { areaId, itemNum, distance, lastUseItemTime, lastUseItemNum, incUId, groupIdId }`
  - `role.items: { "1006": { quantity }, "5286": { quantity } }` —— 道具余额快照

### 排行榜（暂未接入批量）

```
SEND autumn_getrolerank  body = {}          （ack = UseItemResp 的 seq）
RESP Autumn_GetRoleRankResp  list: [{ roleId, serverId, name, itemNum, rank, distance, score, ... }]
```

## 实现要点

- 每账号每次调用只发 1 次 `{ itemNum: 1 }`（与抓包逐字节一致）；道具不足 / 活动未开（错误文案含「未开启/已结束/无效的/不足」）视为正常跳过，不算失败。
- 限流 400340 → warning 后 break（不能 continue 跳过 sleep 造成连发，同逍遥津）。
- 批量页面新栏目「金鱼」：`taskGroupDefinitions` + tab-pane + 自由模板分组 `goldenfish`；自由模板回归测试 `test/flexibleTemplate.test.js` 已同步（batch 任务总数 36→37）。
