# 批量运行时同步模型（多开页面）

批量运行时页面（`src/views/GameMultiPlayer.vue`）的输入同步：**只有「同步源」窗口的鼠标 / 触摸事件会转发给其他窗口**，从窗口只回放、不上报。

## 三种模式

| 模式 | 存储值 | 行为 |
| --- | --- | --- |
| 不同步（默认） | `none` | 所有窗口互不影响，不监听、不转发 |
| 分组同步 | `group` | 以 Token 管理的分组为单位，**每组只有组长**能驱动本组其他窗口；单人分组不参与；未分组窗口不参与 |
| 全局同步 | `global` | 所有窗口（含未分组）视为一个大组，同步源 = **第一个分组的组长**（没有可用分组时不生效），其余窗口只接收 |

模式存在 `localStorage.multiGameSyncMode`，默认 `none`（安全默认：不会误操控其他账号）。

## 分组来源（唯一：Token 管理）

批量运行时页面**不维护自己的分组、也没有固定槽位**（9/12 的「6 个固定组 + `i % 6` 顺序分配」已废弃）：

- 分组清单直接引用 Token 管理里的分组（`multiGameTokenGroups`，稳定键 `serverId:roleId`）；
- **只显示「本次已打开窗口所在」的分组**——Token 管理里存在的其它分组（账号没勾选 / 没打开）不会出现在同步栏里；
- 没有任何已打开窗口落在分组内时，同步栏给出提示且全局 / 分组同步都不会生效（不会拿「窗口顺序第一个」之类的东西兜底）；
- 分组归属只在 Token 管理里编辑，批量页只维护「顺序 + 组长 + 模式」三项本地状态，避免同一份数据两处改。

## 分组与组长

- 分组归属 = Token 管理里的分组（`multiGameTokenGroups`，稳定键 `serverId:roleId`），批量页不复制这份数据。
- 分组**顺序**由批量页自己维护（`multiGameSyncGroupOrder`，分组 id 数组）：拖动同步栏里的 ⠿ 手柄，或用 chip 上的 ← / → 按钮调整。它决定「第一个分组」，也就是全局同步源。
- **组长**默认 = 该组窗口顺序第一个；两种方式手动指定：
  1. 同步栏 chip 里的「组长」下拉；
  2. 点击窗口卡片上该组的分组标签。
  指定值存 `localStorage.multiGameSyncMasters`（分组 id → scopeId）。组长关窗或换组后自动回退为组内第一个。
- 一个窗口可属于多个分组：它可以是 A 组组长（发送）同时又是 B 组成员（接收），这种角色在窗口角标上显示「组长 + 跟随」。

## 父子页面协议（send / receive 两个方向）

宿主页面按角色给每个 iframe 下发 `{channel:"multi-game-sync", version:2, type:"config", send, receive, enabled, throttleMs}`：

- `send`：本窗口是同步源 → 捕获本地事件并上报 `type:"user-event"`；
- `receive`：本窗口是从 → 接收 `type:"forward-event"` 并回放；
- `enabled`：兼容旧版 bridge（只认单个开关，视为双向）；
- 事件仍按 canvas 归一化坐标（0–1）映射，16ms 节流。

> ⚠️ **两个通道的版本号必须各自独立**：
> - `multi-game` 通道（`user-event` / `ready` / `fatal` / `control-result`）＝ **version 1**，宿主页面按 1 校验；
> - `multi-game-sync` 通道（`config` / `forward-event`）＝ **version 2**。
>
> 2026-09-15 踩过坑：把 bridge 里唯一的 `VERSION` 从 1 升到 2，`user-event` 也跟着变成 2，宿主把组长上报的事件全部丢弃 → **同步静默失效**（表现为「同步功能怎么失效了」，无任何报错）。现在 bridge 用 `EVENT_VERSION=1` / `SYNC_VERSION=2` 两个常量，宿主对 `user-event` 同时接受 1 和 2，`test/multiGameSyncBridge.test.js` 把这个契约钉住了。

窗口增减、窗口顺序（← / → 移动窗口）、分组归属变化都会重算角色并重新下发。

## 旧设置的迁移

旧版（9/12～9/14）用 `multiGameSyncGroups` 存「每个分组一个启用开关」。新模式只存一个 `multiGameSyncMode`，所以首次读取时：**没存过模式 + 旧记录里有任何一个已启用 → 迁移为「分组同步」**（保留旧 key 不删，方便回滚）。没启用过任何分组的用户仍然是「不同步」。


## 相关文件

| 文件 | 职责 |
| --- | --- |
| `src/utils/multiGameSyncPlan.js` | 纯逻辑：模式归一化、分组排序、组长解析、角色/targets 计算（单测 `test/multiGameSyncPlan.test.js`） |
| `src/utils/gameLauncher.js` | localStorage key 常量（含旧版 key 常量，仅用于迁移） |
| `src/views/GameMultiPlayer.vue` | 同步栏 UI、角色下发、事件转发、滚动隔离兜底 |
| `public/game/multi-game-sync-bridge.js` | iframe 内：按 send / receive 捕获或回放事件、滚动副作用隔离（`test/multiGameSyncBridge.test.js` 真跑这个脚本） |

> 改动 `public/game/*.js` 后必须 bump `public/game/multi-game.html` 里的 `?v=`（同步桥接脚本当前为 `?v=20260915.2`），并同步 `test/multiGameBootstrap.test.js` 的清单，否则会命中强缓存。
