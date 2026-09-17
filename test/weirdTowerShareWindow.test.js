import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVITY_PHASES,
  CYCLE_MS,
  DAY_MS,
  HOUR_MS,
  SHARE_WINDOW_MS,
  WEEK_MS,
  WEIRD_TOWER_CYCLE_ANCHOR,
  describeWeirdTowerShareState,
  getWeirdTowerCycleInfo,
  getWeirdTowerCycleKey,
  isWeirdTowerShareWindowOpen,
  isWeirdTowerTailWindow,
} from "../src/utils/weirdTowerShareWindow.js";

const ANCHOR_MS = new Date(WEIRD_TOWER_CYCLE_ANCHOR).getTime();

/** 以「锚点 + N 个周期 + 周期内偏移」构造时刻，避免测试依赖机器时区 */
const at = (cycleIndex, offsetMs = 0) =>
  new Date(ANCHOR_MS + cycleIndex * CYCLE_MS + offsetMs);

test("活动三周一轮：黑市周 → 招募周 → 宝箱周 依次轮转", () => {
  assert.deepEqual(ACTIVITY_PHASES, ["黑市周", "招募周", "宝箱周"]);

  assert.equal(getWeirdTowerCycleInfo(at(13, 0)).phase, "黑市周");
  assert.equal(getWeirdTowerCycleInfo(at(13, WEEK_MS)).phase, "招募周");
  assert.equal(getWeirdTowerCycleInfo(at(13, 2 * WEEK_MS)).phase, "宝箱周");
  // 下一个周期重新从黑市周开始
  assert.equal(getWeirdTowerCycleInfo(at(14, 0)).phase, "黑市周");
  assert.equal(getWeirdTowerCycleInfo(at(14, 0)).cycleIndex, 14);
});

test("活动周是 6.5 天不是 7 天：助力在周四 24:00 截止", () => {
  assert.equal(SHARE_WINDOW_MS, 6.5 * DAY_MS);

  // 周期起点（周五 12:00）到 6.5 天前一刻都开着
  assert.equal(isWeirdTowerShareWindowOpen(at(13, 0)), true);
  assert.equal(isWeirdTowerShareWindowOpen(at(13, SHARE_WINDOW_MS - 1)), true);

  // 到 6.5 天整（周五 00:00）就关了
  assert.equal(isWeirdTowerShareWindowOpen(at(13, SHARE_WINDOW_MS)), false);
});

test("尾巴期：黑市周仍在，但战斗与助力已关闭", () => {
  const tailStart = at(13, SHARE_WINDOW_MS);
  const tailEnd = at(13, WEEK_MS); // 周五 12:00，下一个活动周开始

  // 尾巴起点：黑市周判定仍为 true（这正是「不能拿它判断助力」的原因）
  assert.equal(getWeirdTowerCycleInfo(tailStart).isBlackMarketWeek, true);
  assert.equal(isWeirdTowerTailWindow(tailStart), true);
  assert.equal(isWeirdTowerShareWindowOpen(tailStart), false);

  // 尾巴内任意时刻
  assert.equal(isWeirdTowerTailWindow(at(13, SHARE_WINDOW_MS + HOUR_MS)), true);
  assert.equal(isWeirdTowerTailWindow(new Date(tailEnd.getTime() - 1)), true);
  assert.equal(isWeirdTowerShareWindowOpen(new Date(tailEnd.getTime() - 1)), false);

  // 尾巴结束 → 进入招募周，不再是尾巴期
  assert.equal(getWeirdTowerCycleInfo(tailEnd).phase, "招募周");
  assert.equal(isWeirdTowerTailWindow(tailEnd), false);
});

test("非黑市周与锚点之前一律不可助力", () => {
  assert.equal(isWeirdTowerShareWindowOpen(at(13, WEEK_MS)), false); // 招募周
  assert.equal(isWeirdTowerShareWindowOpen(at(13, 2 * WEEK_MS)), false); // 宝箱周

  // 锚点之前
  assert.equal(getWeirdTowerCycleInfo(new Date(ANCHOR_MS - 1)), null);
  assert.equal(isWeirdTowerShareWindowOpen(new Date(ANCHOR_MS - 1)), false);
  assert.equal(getWeirdTowerCycleKey(new Date(ANCHOR_MS - 1)), null);
  assert.equal(describeWeirdTowerShareState(new Date(ANCHOR_MS - 1)).state, "before-start");
});

test("周期键按周期变化，且同一周期内稳定", () => {
  assert.equal(getWeirdTowerCycleKey(at(13, 0)), "c13");
  assert.equal(getWeirdTowerCycleKey(at(13, SHARE_WINDOW_MS)), "c13");
  assert.equal(getWeirdTowerCycleKey(at(13, 2 * WEEK_MS)), "c13");
  assert.equal(getWeirdTowerCycleKey(at(14, 0)), "c14");

  // 关键点：跨越「周四 24:00」这个助力截止时刻，周期键不变
  // —— 一次活动内不重置，所以黑名单不能按日失效
  assert.equal(
    getWeirdTowerCycleKey(at(13, SHARE_WINDOW_MS - 1)),
    getWeirdTowerCycleKey(at(13, SHARE_WINDOW_MS + 1)),
  );
});

test("窗口状态描述：四种状态与下次开放时间", () => {
  assert.equal(describeWeirdTowerShareState(at(13, 0)).state, "open");
  assert.equal(describeWeirdTowerShareState(at(13, 0)).open, true);

  const tail = describeWeirdTowerShareState(at(13, SHARE_WINDOW_MS));
  assert.equal(tail.state, "tail");
  assert.equal(tail.open, false);
  // 尾巴期结束后要等下一个周期
  assert.equal(tail.nextOpenMs, ANCHOR_MS + 14 * CYCLE_MS);

  const off = describeWeirdTowerShareState(at(13, WEEK_MS));
  assert.equal(off.state, "not-black-market");
  assert.equal(off.nextOpenMs, ANCHOR_MS + 14 * CYCLE_MS);

  // 开放中给出关闭时刻 = 周期起点 + 6.5 天
  assert.equal(
    describeWeirdTowerShareState(at(13, 0)).closeAtMs,
    ANCHOR_MS + 13 * CYCLE_MS + SHARE_WINDOW_MS,
  );
});

test("对齐真实抓包：2026-09-17 23:26（北京）助力窗口仍开放，属周期 #13", () => {
  const capturedAt = new Date(2026, 8, 17, 23, 26); // 本地时区；抓包共 4 份都在此时段
  const info = getWeirdTowerCycleInfo(capturedAt);

  assert.equal(info.cycleIndex, 13);
  assert.equal(info.phase, "黑市周");
  assert.equal(info.isBlackMarketWeek, true);
  assert.equal(isWeirdTowerShareWindowOpen(capturedAt), true);
  assert.equal(isWeirdTowerTailWindow(capturedAt), false);

  // 黑市周窗口起点 = 2026-09-11 12:00（与 EvoTowerInfoResp.taskMap 最早键 260911 吻合）
  assert.equal(new Date(info.cycleStartMs).getDate(), 11);
  assert.equal(new Date(info.cycleStartMs).getHours(), 12);

  // 抓包时刻距离助力截止只剩约 34 分钟
  assert.equal(info.shareCloseMs - capturedAt.getTime(), 34 * 60 * 1000);
});

test("对齐真实时间：2026-09-18 00:00 之后进入尾巴期；12:00 起下一活动周", () => {
  const tail = new Date(2026, 8, 18, 0, 0); // 周五 00:00，助力刚关闭
  assert.equal(isWeirdTowerShareWindowOpen(tail), false);
  assert.equal(isWeirdTowerTailWindow(tail), true);

  const noon = new Date(2026, 8, 18, 12, 0);
  assert.equal(isWeirdTowerTailWindow(noon), false);
  assert.equal(getWeirdTowerCycleInfo(noon).phase, "招募周");
  assert.equal(isWeirdTowerShareWindowOpen(noon), false);
});

test("非法输入不抛异常", () => {
  assert.equal(getWeirdTowerCycleInfo(new Date("invalid")), null);
  assert.equal(isWeirdTowerShareWindowOpen(new Date("invalid")), false);
  assert.equal(getWeirdTowerCycleKey(new Date("invalid")), null);
  assert.equal(describeWeirdTowerShareState(new Date("invalid")), null);
});

test("接受毫秒时间戳，行为与 Date 一致", () => {
  const d = at(13, HOUR_MS);
  assert.deepEqual(getWeirdTowerCycleInfo(d.getTime()), getWeirdTowerCycleInfo(d));
  assert.equal(
    isWeirdTowerShareWindowOpen(d.getTime()),
    isWeirdTowerShareWindowOpen(d),
  );
});
