# L1 · 全局红线与踩坑（犯错前必读）

## A. 协议 / 数据

1. **永远不要手写 BON 解码器** — 只用 `src/utils/bonProtocol.js`；工具用 `local-data/goldenfish/_gf.mjs`。
   手写遇 `double` 错位 → 假结论"字段不存在"。
2. **`Number(null) === 0`** — 已踩 3 次。可选数值必须**显式判空**（`!= null`），否则 0 会伪装成合法值。
3. **`payload.decoded.body` 只是摘要**，不可直接用；body 常是**嵌套 BON bytes，要再解一层**。
4. **大帧截断**：`>6003` 字节截断。
5. **`BonEncoder.getBytes()` 默认共享视图** → 要独立副本用 `getBytes(true)`。
6. **`px` 帧先 XOR 去头再 BON 解码**；`pl` 帧才走 LZ4/XOR。别混。
7. **被动桥 hook 的 `ws:open` URL 会丢 query**（曾造出"裸 agent"假象）⇒ 握手层结论**以 DevTools 为准**。

## B. 连接 / 命令

8. **未注册的 cmd 发不出去** → `CommandRegistry.register` 先注册，否则只能超时。
9. **响应匹配靠 `resp === seq`**；命令名不一致必须补 `responseToCommandMap`，漏映射 = Promise 超时。
10. **建连必须走 `tokenStore.createWebSocketConnection`**（锁/跨标签页/刷新三件事都在里面），勿直接 `new WebSocket`。
11. **连接锁必须配对释放**；`acquireConnectionLock` 10s 超时。
12. **role token 短命**：导入只落 BIN/URL，建连时按需刷新，**不预取、不落库**。
13. **战斗命令依赖 `battleVersion`**，须先经 `fight_startlevel` 前奏。
14. **多开存储必须带 `scopeId` 前缀**（`multi-game:${scopeId}:`），串号即事故。
15. **服务端会话冷却**：同角色频繁重连会触发（表现为 `200020` 泛滥、数分钟自愈）。
    批量重跑间隔别太激进（3s 过激，曾导致 28a 类挂死）。怀疑账号时**换干净号 + 等 2~3 分钟**再试。

## C. UI 接线

16. 🔴 **"导出函数" ≠ "有入口"** — 独立入口必须五处齐全（详见 `04-workflow.md` §2）。
    漏 UI 层时**冒烟 dump 不出来**，部署后才会发现"没有这个按钮"。已踩 3 次。
17. **金鱼/活动类"独立入口"（claimProgressRewards / openPacks / clearItems / upgradeChain）历史只做了函数层**，UI 层曾集体漏接。

## D. 部署 / Git

18. 🔴 **本地领先 myrepo 时不要跑 `deploy/update.sh`** — 会 `reset --hard origin/<分支>` 把线上回退到旧 tip。
19. **多文件 scp 有时传旧包** → bundle 单独重传 + `git bundle verify` / `list-heads` 确认后再构建。
20. **`origin` 勿推**，推送目标只有 `myrepo`（greatworldemperor）。
21. **push 前 `unset *_PROXY`**；多个分支**必须串行**推送（共用固定端口）。
22. **`! [rejected] (fetch first)` = 引用层问题≠网络** → fetch → `merge --no-ff` → 再推。
23. **站点根静态文件必须放仓库 `public/` 并 commit**（vite `emptyOutDir` 会清 `dist/`）。别 scp 绕过。
24. **esbuild 默认 ascii** ⇒ 产物中文是 `\uXXXX` ⇒ **grep 中文必假阴性**。用压缩无关片段定位。

## E. 业务口径

25. **进度在 `activity_get` 的 `task`，不在 `role` 上**。
26. **开箱/招募/钓鱼只认整批 10**（余数被服务端拒，向下对齐）。
27. **宝箱积分 ≥1000 才一键兑光（`item_batchclaimboxpointreward`），<1000 不兑（攒着）**；钻石箱一律不开、木箱留 200。
28. **`src/utils/batch/smartOpenBox.js` 不要照金鱼口径改** — 那是日常开箱（兑满 9 档得钻石），与活动积分消耗互不通用。
29. **不要自动化盐场 PVP**（`war_startbattle` 被 3000070 拦）。
30. **保护名单道具**：`5288`(硬通货) / `5286`(每日投币) / `1013` / `1001` / `1012` / `2001-2005`。
31. **`batchClearItems`（清空道具）在金鱼收尾前勿跑**（清单含 5287）。
32. **邮件累积 ≥32000 才领**。

## F. 工具链

33. **运行时路径已变更**：node = `C:\Users\worldemperor\.workbuddy\binaries\node\versions\22.22.2-5\node.exe`（`-3` 已不存在）。
34. **写 md 禁用 `node -e` 模板字符串**（反引号必炸）→ 用 Edit/Write 工具。
35. **`node --check` 抓不到忘 import** — 用 `local-data/_sfc_batch_check.mjs` 或直接构建。
36. **收尾/核验别把输出截断到看不出结论**（master 明确要求）。

## G. 方法论（认知类）

37. **对照实验材料要先"并排"再下结论**。
38. **单变量隔离**，一次只质疑一个假设。
39. **成功样本立刻用干净号复刻**（防被会话污染误导）。
40. **"游戏指令大概率共用同一套路子"只能当反查方向，不能当事实**。
41. **UI 资源已加载 / H5 方法名存在 ≠ Vue 页面已有可用游戏会话。**
42. 🔴 **解码出来的 JSON 只是「视图」，键的类型会被抹平** —— BON 里 `map{int 5 => int 4}` 解出来显示成
    `{"5": 4}`，照抄成对象字面量 `{ 5: 4 }` 会被编码成**字符串键**（`05 01 35` vs `01 05 00 00 00`，
    差 2 字节），服务端不认。**凡 map 的键是数字，必须回看原始字节并用 `new Map([[k,v]])`**。
    实证：`activity_claimweekactreward`（`local-data/misc/_verify_weekact.mjs`，`fd14e99d`）。
    ⇒ 别信解码 JSON，别信肉眼看代码，只信「编码回字节是否逐字节一致」。
43. **裸 node 跑测试若 import `xyzwWebSocket.js`**（顶部有 vite 别名 `@/stores`）会 `ERR_MODULE_NOT_FOUND`；
    测试内先 `await import("../local-data/_alias_loader.mjs")` 装别名钩子再动态 import 即可。
    同理 `local-data/_check_registry.mjs` 要 `node --import ./local-data/_alias_loader.mjs ...`。
44. **`vite build --outDir ._tmp_build --emptyOutDir` 会被沙箱删除保护拦**
    （`[SAFE_DELETE_BULK_CONFIRM_REQUIRED]` count>50）。换**全新空目录** + 不带 `--emptyOutDir` 绕过。
