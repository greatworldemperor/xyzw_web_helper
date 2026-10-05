/**
 * h5web 反代注入 —— 三条路线（nginx / Cloudflare Worker / vite dev）共用同一套语义。
 *
 * 原理：把官方现行 H5（https://xxz-xyzw-res.hortorgames.com/h5web/）反代到我们域名的
 * /h5web-proxy/ 路径下，响应经过时注入本地镜像同款的辅助脚本（同源 = 注入有效）：
 *
 *   注入 A（main.2a00e.js 标签之前）：
 *     - platform-spoof.js     平台口径 hook（与镜像 index.html 相对位置一致：settings/game-defines 之后、main 之前）
 *     - first-frame-spoof.js  首帧改写（默认关闭，读 localStorage 开关）
 *     - boot-shim 内联        官方 boot 不等桥就绪；镜像的 boot 会等 __pushResearchSh1Ready（桥 sha1），
 *                             这里用 defineProperty 包装 window.boot 复刻同一语义。
 *   注入 B（main.2a00e.js 标签之后、官方内联 boot 之前）：
 *     - runtime-tweaks.js / xh.js / diagnose_require.js / push-level-research-bridge.js
 *
 * 注入脚本从 /game/* 读取：
 *   - nginx 路线：本服务器即镜像，/game/* 天然存在
 *   - vite dev 路线：public/game/* 由 dev server 服务
 *   - Cloudflare Pages：dist/game/* 由 env.ASSETS 服务（build 时随 dist 部署）
 *
 * ⚠️ 与 worker.js 内的 applyH5WebInjection 保持同步（worker 无法 import，复制了一份）。
 * ⚠️ 永远不要反代游戏 WS / API（wss://xxz-xyzw-new…、/login/authuser）——浏览器直连官方，
 *    每用户出口 IP = 自己；全员过服务器 = 单 IP 秒限流 + 封号风险。
 */

export const H5WEB_UPSTREAM = "https://xxz-xyzw-res.hortorgames.com";
export const H5WEB_UPSTREAM_BASE = "/h5web/";
export const H5WEB_PROXY_PREFIX = "/h5web-proxy";

const SCRIPT_A = [
  // 通道覆盖：官方 /h5web/ 现行 GAME_ID=xyzwdouyinh5（抖音H5 退役通道——公告强制引导迁移、无关闭按钮，
  // 登录入口已关）；改用镜像已验证可登录的 xyzw_mix（master 10-06 镜像登录实测通过），版本串保持官方现行。
  `<script>window.GAME_ID="xyzw_mix";</script>`,
  `<script src="/game/platform-spoof.js?v=20260916.2" charset="utf-8"></script>`,
  `<script src="/game/first-frame-spoof.js?v=20260921.1" charset="utf-8"></script>`,
  `<script>/* [h5web-proxy] boot-shim: official boot waits for bridge sha1 ready (same as local mirror) */` +
    `(function(){var _b=null;try{Object.defineProperty(window,"boot",{configurable:true,` +
    `get:function(){if(!_b)return void 0;return function(){var a=arguments,s=this;` +
    `var go=function(){_b.apply(s,a)};` +
    `Promise.resolve(window.__pushResearchSh1Ready||!0).then(go,go);}},` +
    `set:function(v){_b=v}})}catch(e){}})();</script>`,
].join("");

const SCRIPT_B = [
  `<script src="/game/runtime-tweaks.js?v=20261002.3" charset="utf-8"></script>`,
  `<script src="/game/xh.js" charset="utf-8"></script>`,
  `<script src="/game/diagnose_require.js" charset="utf-8"></script>`,
  `<script src="/game/push-level-research-bridge.js?v=20260907.13" charset="utf-8"></script>`,
].join("");

/**
 * SDK 剥离（镜像形态对齐）：镜像 index.html 根本没有 HORTOR SDK（sdk_agent/apm/thinkingdata 全无），
 * 游戏对此有守卫、走 token 注入路径（镜像登录实测通过）。反代页若保留 SDK，会走官方退役的
 * 原生登录流（公告死端弹窗，GAME_ID 覆盖无效——SDK 在 head 更早初始化）→ 必须剥离。
 * 剥离后 head 内联初始化脚本会因 HORTOR_AGENT 未定义自我中止（一条 console TypeError，无害，
 * 与镜像形态完全一致：__HORTOR_SDK__ === undefined）。
 */
const SDK_STRIP_RULES = [
  [
    `<script src="https://cdn.hortor.net/sdk/sdk_agent.min.js"></script>`,
    `<script>/* [h5web-proxy] HORTOR SDK stripped (mirror parity) */</script>`,
  ],
  [
    `src="https://cdn.hortor.net/sdk/lib/web-apm-iife.bundle.js"`,
    `src="data:text/javascript,//"`,
  ],
  [
    `src="https://cdn.hortor.net/sdk/lib/thinkingdata.umd.min.js"`,
    `src="data:text/javascript,//"`,
  ],
  [
    `window.HORTOR_AGENT.tga = thinkingdata;`,
    // 惰性黑洞 SDK 桩：现行官方 chunk（index.0a88d.js 等）的平台加载/日志模块需要 SDK 存在
    // （tga.tagLog 写埋点，缺了会把原始错误吞掉）。tga=Proxy 黑洞（任何方法=无操作），
    // init 回调成功；其余 SDK 方法未定义（真缺了会在 console 露出真实错误）。
    `var __h5wTga=new Proxy(function(){return __h5wTga},{get:function(){return __h5wTga},apply:function(){return __h5wTga}});window.HORTOR_AGENT={tga:__h5wTga,init:function(cb){try{cb&&cb(!0)}catch(e){}}};window.__HORTOR_SDK__=window.HORTOR_AGENT;`,
  ],
];

/**
 * 唯一锚点 = 完整 main 标签（官方 index.html 中精确出现一次）。
 * ⚠️ 必须单锚点单次替换：nginx sub_filter 的多条规则在原始流上匹配，
 *    两条锚点重叠时后一条会被抑制（10-06 生产踩坑）——JS 顺序 replace 无此问题，
 *    但为三端语义一致统一用单锚点。
 */
const ANCHOR_MAIN_TAG = `<script src="main.2a00e.js" charset="utf-8"></script>`;

/** 官方现行 index.html 的锚点自检（构建期/测试用：hash 变了要同步改锚点） */
export const H5WEB_ANCHOR_EXPECT = { ANCHOR_MAIN_TAG };

/**
 * 对官方 h5web 的 HTML 应用注入。非 HTML 内容不要调用。
 * 返回注入后的 HTML；锚点缺失时原样返回（官方 bundle 结构变更的兜底）。
 */
export function applyH5WebInjection(html) {
  if (typeof html !== "string" || !html.includes(ANCHOR_MAIN_TAG)) return html;
  let out = html;
  for (const [find, replace] of SDK_STRIP_RULES) {
    out = out.replace(find, replace);
  }
  return out.replace(
    ANCHOR_MAIN_TAG,
    SCRIPT_A + ANCHOR_MAIN_TAG + SCRIPT_B,
  );
}

/** 把 /h5web-proxy/ 前缀的路径映射为上游路径（含 /h5web 基准路径） */
export function mapProxyPathToUpstream(pathname) {
  let rest = pathname.startsWith(H5WEB_PROXY_PREFIX)
    ? pathname.slice(H5WEB_PROXY_PREFIX.length)
    : pathname;
  if (!rest || rest === "/") rest = "/index.html";
  return H5WEB_UPSTREAM_BASE.replace(/\/$/, "") + rest;
}

/**
 * 桥内相对路径加载的辅助脚本（sh1 库等）在反代页会解析到 /h5web-proxy/ 下，
 * 官方没有这些文件 → 从本地镜像 /game/* 供出（三端各自实现，名单在此同步）。
 * push-level-research-bridge.js 的相对加载全集：sh1.js / sh1.readable.js?v=…（10-06 实测）
 */
export const H5WEB_LOCAL_AUX_RE = /^\/h5web-proxy\/(sh1(?:\.readable)?\.js)(?:\?.*)?$/;
