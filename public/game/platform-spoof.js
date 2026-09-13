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
 * 开关（localStorage，宿主页与游戏 iframe 同源共享）：
 *   localStorage["xyzwPlatformSpoof"] = {"enabled":true,"platform":"mix","gameVersion":""}
 *   - enabled=false 或缺省键 → 完全不干预（原始 h5web 口径）。
 *   - platform：覆写 gt.PLATFORM。可选值参考：'mix'（官方主流口径，369/436 且项目 WS 已验证）、
 *     'h5'（官方 H5 口径，58 人有击杀记录）。
 *   - gameVersion：可选，覆写 gt.GAME_VERSION（默认留空保持 1.89.8-wx，先单变量验证平台假设；
 *     如需同时伪装版本可设 "2.21.2-fa918e1997301834-wx"，即项目 WS 已验证的口径）。
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

  var LS_KEY = "xyzwPlatformSpoof";
  var DEFAULTS = { enabled: false, platform: "mix", gameVersion: "" };

  function readConfig() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var cfg = JSON.parse(raw);
      if (!cfg || typeof cfg !== "object" || cfg.enabled !== true) return null;
      return {
        enabled: true,
        platform: typeof cfg.platform === "string" && cfg.platform ? cfg.platform : DEFAULTS.platform,
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
    if (typeof next.platform !== "string" || !next.platform) next.platform = DEFAULTS.platform;
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
      console.log("[platform-spoof] 生效:", JSON.stringify(applied));
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
