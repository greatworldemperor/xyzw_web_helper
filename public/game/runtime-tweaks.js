/*
 * runtime-tweaks.js — 游戏运行时增强（单开 index.html / 多开 multi-game.html 通用）
 *
 * 功能（均基于反编译实锤，2026-10-02，game bundle 2.48.2 / 22c3b）：
 *  1. muteMusic / muteSound — 进游戏直接静音。
 *     存储键 "MUSIC_OPEN"/"SOUND_OPEN"（LocalStorage, GLOBAL scope）+ cc.audioEngine 引擎级 hook 双保险。
 *     SoundManager 切后台/回前台会从存储重读开关，故写存储即可全生命周期生效。
 *  2. disablePowerSave — 关"省电模式"（AFK 屏保，master 指认：游戏内部就叫省电模式）。
 *     游戏档位 AFKGapConfig=[30秒,3分钟,5分钟,永不]；写 "AFK_GAP"=3（永不档，time=-1 →
 *     startTiming 里 e<=0 直接 return，定时器根本不装）。另探测模块管理器拿 AFKModule
 *     实例调 stopTiming() 清掉已装上的旧定时器（避免启动后头三分钟弹一次）。
 *  3. battleSpeed — PVE 战斗本地加速（默认十殿 Nightmare）。
 *     manager-factory.BATTLE_SPEED_BY_TYPE(type, speed) → battle 实例 timeScale
 *     → 战斗 update 里 dt *= timeScale。只影响本地动画播放节奏，不发任何协议帧；
 *     战斗胜负由服务端计算并下发（与微信端改 js 文件加速同一原理）。
 *
 * 注入方式：游戏本体 bundle（game/index.*.jsc 解密后 eval 执行）自带模块加载器
 * window.__require，本脚本在 cc 引擎加载后立即 hook 引擎音频，然后轮询模块就绪再操作。
 * 游戏 CDN 版本升级若改名/改结构：所有访问 try/catch 跳过 + console 日志，绝不弄挂游戏。
 *
 * 配置：localStorage "xyzwGameTweaks"（多开窗口经 storage-bridge 自动按 scope 隔离）。
 * URL 快速开关：?tweaks=off 强制停用本次会话。
 * 宿主 API：window.__xyzwGameTweaks = { version, read, write, applyNow, status, _internal }
 */
;(function () {
  "use strict"

  var STORAGE_KEY = "xyzwGameTweaks"
  var VERSION = "20261002.1"
  var MODULE_POLL_INTERVAL = 500
  var MODULE_POLL_MAX = 120 // 500ms * 120 = 60s
  var BATTLE_POLL_INTERVAL = 800

  var PAGE_PARAMS = new URLSearchParams(window.location.search)

  function log() {
    var args = Array.prototype.slice.call(arguments)
    args.unshift("[runtime-tweaks]")
    console.log.apply(console, args)
  }
  function warn() {
    var args = Array.prototype.slice.call(arguments)
    args.unshift("[runtime-tweaks]")
    console.warn.apply(console, args)
  }

  // ---------- 配置 ----------

  function defaultConfig() {
    return {
      enabled: true,
      muteMusic: true,
      muteSound: true,
      disablePowerSave: true,
      battleSpeed: {
        enabled: true,
        speed: 100,
        // BattleType 成员名的正则（不区分大小写）；^nightmare$ 精确匹配十殿，排除 nightmareStar 等
        pattern: "^nightmare$",
      },
    }
  }

  // 合并用户配置（只接受白名单字段，battleSpeed 深合并，speed 夹在 1~100；
  // 游戏调试面板滑条上限是 5，但 API 层 timeScale 未必夹取——实测若被游戏内部夹到 5，
  // 100 等效于游戏上限，无副作用）
  function normalizeConfig(raw) {
    var base = defaultConfig()
    if (!raw || typeof raw !== "object") return base
    if (typeof raw.enabled === "boolean") base.enabled = raw.enabled
    if (typeof raw.muteMusic === "boolean") base.muteMusic = raw.muteMusic
    if (typeof raw.muteSound === "boolean") base.muteSound = raw.muteSound
    if (typeof raw.disablePowerSave === "boolean")
      base.disablePowerSave = raw.disablePowerSave
    if (raw.battleSpeed && typeof raw.battleSpeed === "object") {
      var bs = raw.battleSpeed
      if (typeof bs.enabled === "boolean") base.battleSpeed.enabled = bs.enabled
      var n = Number(bs.speed)
      if (isFinite(n)) base.battleSpeed.speed = Math.min(100, Math.max(1, n))
      if (typeof bs.pattern === "string" && bs.pattern.length > 0) {
        try {
          new RegExp(bs.pattern, "i")
          base.battleSpeed.pattern = bs.pattern
        } catch (e) {
          /* 非法正则保持默认 */
        }
      }
    }
    return base
  }

  function readConfig() {
    var raw = null
    try {
      raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")
    } catch (e) {
      raw = null
    }
    var cfg = normalizeConfig(raw)
    if (PAGE_PARAMS.get("tweaks") === "off") {
      cfg.enabled = false
      log("URL 参数 tweaks=off，本次会话停用")
    }
    return cfg
  }

  function writeConfig(cfg) {
    var norm = normalizeConfig(cfg)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(norm))
    return norm
  }

  var cfg = readConfig()
  var status = {
    engineHook: null, // { music, sound } 引擎 hook 安装结果
    moduleApplied: false,
    moduleApplyError: null,
    afkTimerStopped: false,
    battleSpeedActive: false,
    battleSpeedSets: 0,
    lastBattleSpeedAt: null,
  }

  // ---------- 安全访问游戏模块加载器 ----------

  function requireModule(name) {
    try {
      if (typeof window.__require !== "function") return null
      return window.__require(name) || null
    } catch (e) {
      return null
    }
  }

  // ---------- 1) 引擎级音频 hook（cc 加载后立即装，覆盖游戏早期 BGM） ----------

  function hookAudioEngine() {
    var result = { music: false, sound: false }
    try {
      var ae = window.cc && cc.audioEngine
      if (!ae) return result
      if (ae.__xyzwTweaksHooked) {
        result.music = !!ae.__xyzwTweaksHookedMusic
        result.sound = !!ae.__xyzwTweaksHookedSound
        return result
      }
      if (cfg.muteMusic && typeof ae.playMusic === "function") {
        var origPlayMusic = ae.playMusic
        ae.playMusic = function () {
          return -1
        }
        ae.__xyzwTweaksHookedMusic = true
        result.music = true
      }
      if (cfg.muteSound) {
        var soundFns = ["play", "playEffect", "play2d"]
        var hookedAny = false
        for (var i = 0; i < soundFns.length; i++) {
          var fn = soundFns[i]
          if (typeof ae[fn] !== "function") continue
          ae[fn] = function () {
            return -1
          }
          hookedAny = true
        }
        ae.__xyzwTweaksHookedSound = hookedAny
        result.sound = hookedAny
      }
      ae.__xyzwTweaksHooked = true
    } catch (e) {
      warn("引擎音频 hook 失败（忽略）:", e && e.message)
    }
    return result
  }

  // ---------- 2) 模块级应用（游戏 bundle 就绪后一次性） ----------

  // 探测 AFKModule 实例并停掉已装的屏保定时器（防启动后头几分钟弹一次）
  function tryStopAfkTimer(di) {
    try {
      var moduleType = di && di.ModuleType && di.ModuleType.AFK
      if (moduleType == null) return false
      var indexUi = requireModule("index-ui")
      var afkModule =
        indexUi && typeof indexUi.GET_MODULE === "function"
          ? indexUi.GET_MODULE(moduleType)
          : null
      if (afkModule && typeof afkModule.stopTiming === "function") {
        afkModule.stopTiming()
        return true
      }
      // 兜底：AFKModule 模块若直接导出实例/带 stopTiming 的对象
      var mod = requireModule("AFKModule")
      if (mod && typeof mod.stopTiming === "function") {
        mod.stopTiming()
        return true
      }
    } catch (e) {
      /* 降级：最坏情况 = 启动后头几分钟屏保可能弹一次，点掉即不再弹 */
    }
    return false
  }

  function applyModuleLevel() {
    if (status.moduleApplied) return true
    var LS = requireModule("LocalStorage")
    if (!LS || !LS.instance) return false // 游戏模块未就绪，继续等
    try {
      // ① 音乐 / 音效开关（写官方存储；mute=false 时不动用户自己的设置）
      if (cfg.muteMusic) LS.instance.setBool("MUSIC_OPEN", false)
      if (cfg.muteSound) LS.instance.setBool("SOUND_OPEN", false)

      // 立即静音（不等 _onForeground 重读）
      var SM = requireModule("SoundManager")
      if (SM && SM.instance) {
        if (cfg.muteMusic && typeof SM.instance.setMusicVolume === "function")
          SM.instance.setMusicVolume(0)
        if (cfg.muteSound && typeof SM.instance.setEffectVolume === "function")
          SM.instance.setEffectVolume(0)
      }
      if (
        cfg.muteSound &&
        window.fgui &&
        fgui.UIConfig &&
        "isSoundOpen" in fgui.UIConfig
      ) {
        fgui.UIConfig.isSoundOpen = false
      }

      // ② 省电模式（屏保）→ 官方"永不"档
      if (cfg.disablePowerSave) {
        LS.instance.setNumber("AFK_GAP", 3)
        var di = requireModule("data-index")
        status.afkTimerStopped = tryStopAfkTimer(di)
      }

      status.moduleApplied = true
      log(
        "模块级配置已应用:",
        JSON.stringify({
          muteMusic: cfg.muteMusic,
          muteSound: cfg.muteSound,
          disablePowerSave: cfg.disablePowerSave,
          afkTimerStopped: status.afkTimerStopped,
        }),
      )
      startBattleSpeedPoller()
      return true
    } catch (e) {
      status.moduleApplyError = e && e.message
      warn("模块级应用失败（将重试）:", e && e.message)
      return false
    }
  }

  // ---------- 3) PVE 战斗加速轮询 ----------

  function resolveBattleTargets(di, patternStr) {
    var targets = []
    try {
      if (!di || !di.BattleType) return targets
      var re = new RegExp(patternStr, "i")
      var keys = Object.keys(di.BattleType)
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i]
        if (/^\d+$/.test(k)) continue // TS enum 反向映射（数字 key）
        var v = di.BattleType[k]
        if (typeof v === "number" && re.test(k)) targets.push({ key: k, value: v })
      }
    } catch (e) {
      /* 忽略 */
    }
    return targets
  }

  function startBattleSpeedPoller() {
    if (status.battleSpeedActive || !cfg.battleSpeed.enabled) return
    var mf = requireModule("manager-factory")
    var di = requireModule("data-index")
    if (!mf || !di || !di.BattleType) return
    if (
      typeof mf.GET_BATTLES_BY_TYPE !== "function" ||
      typeof mf.BATTLE_SPEED_BY_TYPE !== "function"
    ) {
      warn("manager-factory 缺少速度 API（跳过战斗加速）")
      return
    }
    var speed = cfg.battleSpeed.speed
    var targets = resolveBattleTargets(di, cfg.battleSpeed.pattern)
    if (!targets.length) {
      warn("battleSpeed pattern 未匹配到任何 BattleType:", cfg.battleSpeed.pattern)
      return
    }
    log(
      "战斗加速启动:",
      JSON.stringify({
        speed: speed,
        types: targets.map(function (t) {
          return t.key + "=" + t.value
        }),
      }),
    )
    status.battleSpeedActive = true
    setInterval(function () {
      try {
        for (var i = 0; i < targets.length; i++) {
          var t = targets[i].value
          var battles = mf.GET_BATTLES_BY_TYPE(t)
          if (!battles || !battles.length) continue
          var dirty = false
          for (var j = 0; j < battles.length; j++) {
            var b = battles[j]
            if (b && b.timeScale !== speed) {
              dirty = true
              break
            }
          }
          if (dirty) {
            mf.BATTLE_SPEED_BY_TYPE(t, speed)
            status.battleSpeedSets++
            status.lastBattleSpeedAt = new Date().toISOString()
            log("已设置战斗速度 x" + speed + "（type=" + targets[i].key + "）")
          }
        }
      } catch (e) {
        /* 单轮失败静默，下轮再试 */
      }
    }, BATTLE_POLL_INTERVAL)
  }

  // ---------- 宿主 API ----------

  window.__xyzwGameTweaks = {
    version: VERSION,
    read: function () {
      return JSON.parse(JSON.stringify(cfg))
    },
    write: function (next) {
      cfg = writeConfig(next)
      // 重装引擎 hook 的开/关不好回滚（幂等钩子），改完建议重载窗口
      log("配置已写入，建议重载窗口生效:", JSON.stringify(cfg))
      return this.read()
    },
    applyNow: function () {
      return applyModuleLevel()
    },
    status: status,
    // 测试钩子（纯函数）
    _internal: {
      normalizeConfig: normalizeConfig,
      resolveBattleTargets: resolveBattleTargets,
      defaultConfig: defaultConfig,
    },
  }

  // ---------- 启动 ----------

  if (!cfg.enabled) {
    log("enabled=false，本次不注入任何行为")
    return
  }

  status.engineHook = hookAudioEngine()
  if (status.engineHook.music || status.engineHook.sound) {
    log(
      "引擎音频 hook 已装:",
      JSON.stringify({ music: status.engineHook.music, sound: status.engineHook.sound }),
    )
  }

  // 游戏模块就绪轮询（game bundle 异步 eval，__require 出现即全部模块可用）
  var polls = 0
  var timer = setInterval(function () {
    polls++
    if (applyModuleLevel()) {
      clearInterval(timer)
      return
    }
    if (polls >= MODULE_POLL_MAX) {
      clearInterval(timer)
      warn("等待游戏模块超时（60s），模块级配置未应用；引擎 hook 仍有效")
    }
  }, MODULE_POLL_INTERVAL)

  log("已加载 v" + VERSION, JSON.stringify(cfg))
})()
