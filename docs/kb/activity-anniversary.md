# L2 · 周年庆（临时活动）

> 实现：`src/utils/batch/tasksAnnDaily.js`（每日奖励 5 个）+ `src/utils/batch/tasksAnnBoss.js`
> （一次性奖励 / 每日签到助力 / 闯关打BOSS，2026-10-17）
> 文档：`docs/anniversary-daily-reward-protocol.md`（warOrder 每日奖励，2026-10-16）
>   · `docs/anniversary-daily-boss-protocol.md`（一次性 + celebrate + towers，2026-10-17）
> 抓包：`local-data/ann_daily/`（warOrder 24 帧 bin）
>   · `local-data/anniversary/ann_daily_boss_full.jsonl`（158 帧 runtime jsonl，9736服法王）
> 测试：`test/annDailyClaim.test.js` · `test/annBossTasks.test.js`

## 状态：✅ 已上线（批量页「临时活动」tab，4 个按钮）

| 按钮 | 命令 | 奖励（抓包实证） |
|---|---|---|
| 领取周年庆每日奖励 | `activity_warordertaskclaim {2610169, 2610169XX}` ×5 | 道具 5290 ×1/个 |
| 领取周年庆一次性奖励 | `common_claimtotalreward {2610167, 261016701}` | 5292 + 37011 各 ×1 |
| 领取周年庆每日奖励/助力 | `celebrate_sign` → `celebrate_claimfullserver[1]` → `linkcard_readcard{90111,1}` → `celebrate_claimfullserver[2]` → `celebrate_claimpersonal[1]` | 集卡 90111、金币 1001 ×10/×3 |
| 周年庆攻打BOSS | `towers_getinfo/start/fight {actId: 2610163}` | 每场金币 1001 ×2~5 + 券 40009 ×1~3 |

## 关键结论

- **闯关 actId = 2610163（固定）**，与换皮闯关 `getTowerActId()` 按周五推算的值不同
  （当周 = 2610161）⇒ **换皮闯关入口打不了本活动**（空响应 → "活动信息获取失败"），
  这是"界面相同但功能无法执行"的根因，不是 bug。
- 闯关 = 六宫格 BOSS，每 BOSS 8 层；每日重置（towerData 归零、levelRewardMap 保留）；
  周五开 BOSS1 / 周六 BOSS2 / 周日 BOSS3 / 周一 BOSS4 / 周二 BOSS5 / 周三 BOSS6 / 周四全开。
- **每 BOSS 最多 10 战**（8 关 + 失败冗余，master 口径）；通关判 `towerData.pass === true`，
  单场胜负主判 `battleData.result.isWin`（兜底 `accept.ext.curHP === 0` / winCnt 上涨）。
- 请求注册 6 个新命令（注册表 212 → 218）；`celebrate_sign` 成功回
  `Celebrate_GetCelebrateInfoResp`（不是 `_signresp`），别被名字骗了。
- `Towers_GetInfoResp` 有**两层 towerData**（外层信息 + 内层六宫格 Map），取数先归一化。
- 客户端会发 `system_custom`（`act:multiTower:*` 本地簿记）和 `team_setteam`（读阵容），
  自动化都不需要 replicate；出问题再补。
- 请求复现：`_verify_reencode.mjs` 11/11 逐字段一致（字节差 = BON 键序，服务端无感）。

## ⚠️ 活动结束清理（按先例）

移除 `tasksAnnBoss.js` 导出 + 页面 3 按钮 + flexibleTemplate 3 个 task 项；
`tasksAnnDaily.js`（warOrder）同；测试与两份 protocol 文档保留作历史记录。
下期轮换：改 `tasksAnnBoss.js` 顶部常量（actId / configId / cardId / 档位）即可。
