/**
 * 平台伪装（platform spoof）—— 3000070 归因验证工具
 *
 * 背景（2026-09-13 蟠桃/盐场抓包结论）：
 *   - game-defines.a175e.js 将 gt.PLATFORM 固定为 'h5web'，gt.GAME_VERSION 固定为 '1.89.8-wx'，
 *     官方 H5 入口因此以 platformExt:"h5web" 上报，服务端战场标记为 loginPlatform:"hortor-h5web"。
 *   - 盐场战场 436 人中 hortor-h5web 仅 1 人（本入口）；蟠桃 payload_setbattleteam 在该口径下被
 *     code 3000070（客户端数据异常）拒绝，而账号 bin 里的 authuser 登录请求本就携带 platformExt:"mix"。
 *   - 由此推断：服务端 3000070 校验取的是 WS 请求体上报的 platformExt（来自本全局），而非登录请求。
 *
 * 原理：
 *   本文件在 game-defines 之后、main/cocos/CDN 游戏逻辑之前执行，
 *   按配置覆写 window.PLATFORM（可选 GAME_VERSION），使后续所有游戏模块读到的都是伪装值。
 *   游戏逻辑对 platformExt 的引用发生在运行时（模块初始化晚于本脚本），因此全局覆写可以覆盖
 *   登录后所有 WS 请求体（role_getroleinfo 等）。
 *
 * 开关：普通运行时使用 localStorage["xyzwPlatformSpoof"]，批量运行时使用
 * localStorage["xyzwMultiGamePlatformSpoof"]。批量运行时的存储桥会为每个账号提供
 * 独立空间，因此两套配置互不读取、互不影响：
 *   {"enabled":true,"platform":"h5","gameVersion":""}
 *   - enabled=false 或缺省键 → 完全不干预（原始 h5web 口径）。
 *   - platform：覆写 gt.PLATFORM。⚠️ 实测结论（2026-09-16，source/4.js 源码 + wechat.bin
 *     实测 authuser）：**网页环境下可登录的值只有 h5 / h5web**。
 *     · "mix" 不是 _platformExtMapping 的 key（是 wx/ios/android/bytedance 的映射输出）
 *       → 查表 undefined → getter 抛 TypeError → 崩溃；
 *     · "wx"（及 ios/android/qq/bytedance）会让 PlatformManager 走对应 App SDK 登录分支
 *       （isWeChat = ("wx"===PLATFORM) → PlatformWX），网页环境没有这些 SDK 桥 → 登录卡死；
 *     · 服务端对 mix 口径没有任何拦截（用 platformExt:"mix" 的真实 bin 直连 authuser
 *       实测成功返回 roleToken）——所以「想上 mix 口径」本来就不该走游戏客户端伪装，
 *       而是走项目轻量 WS 客户端（注册口径本来就是 mix）。
 *   - gameVersion：可选，覆写 gt.GAME_VERSION（默认留空保持 1.89.8-wx）。
 *
 * 验证方法：
 *   1. 研究页开启开关 → 重载运行时 → 载入并登录，抓 WSS；
 *   2. 查看 role_getroleinfo 等请求体 platformExt 是否变为伪装值（生效判定）；
 *   3. 下一个战斗窗口（周日 20:00 蟠桃 / 盐场开战）执行布阵等写命令，
 *      不再返回 3000070 即证实 h5web 口径是触发原因。
 *
 * 宿主 API：window.__xyzwPlatformSpoof = { KEY, read, write, clear, applied }
 */
(function () {
  "use strict";

  var isMultiGameRuntime = /(?:^|\/)multi-game\.html$/i.test(
    String(window.location && window.location.pathname || "")
  );
  var LS_KEY = isMultiGameRuntime
    ? "xyzwMultiGamePlatformSpoof"
    : "xyzwPlatformSpoof";
  var DEFAULTS = { enabled: false, platform: "h5", gameVersion: "" };

  /**
   * 2026-09-16 实测（source/4.js + wechat.bin 直连 authuser 成功）：
   * 网页环境可登录的 PLATFORM 只有 h5 / h5web。"mix" 不是映射表 key（崩溃）；
   * "wx" 等会切到 App SDK 登录分支（网页无 SDK 桥，卡死）。mix 口径走项目轻量 WS。
   */
  var PLATFORM_KEYS = ["h5", "h5web"];
  var PLATFORM_EXT_HINT = { h5: "h5", h5web: "h5web" };

  function normalizePlatform(value) {
    var v = String(value || "").trim();
    if (!v) return "";
    return PLATFORM_KEYS.indexOf(v) >= 0 ? v : "";
  }

  function readConfig() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var cfg = JSON.parse(raw);
      if (!cfg || typeof cfg !== "object" || cfg.enabled !== true) return null;
      var platform = normalizePlatform(cfg.platform);
      if (cfg.platform && !platform) {
        console.warn(
          "[platform-spoof] 配置的 platform=" + cfg.platform + " 在网页环境不可登录" +
          "（可用：" + PLATFORM_KEYS.join("/") + "；mix 是 wx 渠道的输出值、wx 会切 App SDK 分支），已忽略覆写"
        );
      }
      return {
        enabled: true,
        platform: platform || DEFAULTS.platform,
        gameVersion: typeof cfg.gameVersion === "string" ? cfg.gameVersion : "",
      };
    } catch (error) {
      return null;
    }
  }

  function writeConfig(patch) {
    var next = Object.assign({}, DEFAULTS);
    try {
      var current = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      if (current && typeof current === "object") Object.assign(next, current);
    } catch (error) {}
    Object.assign(next, patch || {});
    var normalized = normalizePlatform(next.platform);
    if (normalized) {
      next.platform = normalized;
    } else {
      console.warn(
        "[platform-spoof] 写入的 platform=" + next.platform + " 在网页环境不可登录，回退默认 " + DEFAULTS.platform
      );
      next.platform = DEFAULTS.platform;
    }
    if (typeof next.gameVersion !== "string") next.gameVersion = "";
    next.enabled = next.enabled === true;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    } catch (error) {}
    return next;
  }

  function clearConfig() {
    try {
      localStorage.removeItem(LS_KEY);
    } catch (error) {}
  }

  var cfg = readConfig();
  var applied = { active: false, from: "", platform: "", gameVersion: "" };

  if (cfg) {
    applied.from = String(window.PLATFORM || "?") + " / " + String(window.GAME_VERSION || "?");
    try {
      if (cfg.platform && window.PLATFORM !== cfg.platform) window.PLATFORM = cfg.platform;
      if (cfg.gameVersion && window.GAME_VERSION !== cfg.gameVersion) window.GAME_VERSION = cfg.gameVersion;
      applied.active = true;
      applied.platform = String(window.PLATFORM);
      applied.gameVersion = String(window.GAME_VERSION);
      applied.extHint = PLATFORM_EXT_HINT[applied.platform] || "?";
      console.log(
        "[platform-spoof] 生效:", JSON.stringify(applied),
        "→ 预期上报 platformExt:" + applied.extHint
      );
    } catch (error) {
      console.warn("[platform-spoof] 覆写失败:", error && error.message);
    }
  } else {
    console.log("[platform-spoof] 未启用（localStorage." + LS_KEY + " 缺省或 enabled=false）");
  }

  window.__xyzwPlatformSpoof = {
    KEY: LS_KEY,
    read: readConfig,
    write: writeConfig,
    clear: clearConfig,
    applied: applied,
  };
})();
