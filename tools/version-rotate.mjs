#!/usr/bin/env node
/**
 * version-rotate.mjs — 咸鱼之王 clientVersion 每周换串一键脚本（2026-10-24 固化）
 *
 * 背景 SOP：src/utils/clientVersion.js 头部注释 + docs/kb/02-toolchain-deploy.md §3/§4。
 * 每周五版本轮换后，唯一人工点 = 在 PC 微信里打开一次小游戏（触发 CDN 下载新构建），
 * 其余全部由本脚本完成。重复跑安全（幂等），失败即停（fail-fast），不许猜。
 *
 * 用法：
 *   node tools/version-rotate.mjs         # detect 段：发现新构建 → 解包 → 提串 → 改文件 → 测试（停在 commit 前）
 *   node tools/version-rotate.mjs --yes   # 全流程：detect + commit + bundle 部署 + 双向核验
 *
 * 内建红线（历史踩坑焊死，见 docs/kb/05-redlines.md）：
 *   - 不 push GitHub（本脚本无任何 push 操作）。
 *   - bundle 必须单独 scp，且远端文件名必须是 /tmp/deploy.bundle（10-03 事故：名字错 → 线上被回退 5 提交）。
 *   - 服务器侧 git bundle verify 通过后才构建。
 *   - 构建末行 commit=<short> 必须等于本地 HEAD，否则判上错立即停。
 *   - 双向核验：新串命中 + 旧串 0 命中（服务器侧与公网侧各验一遍）。
 *     旧串恰好 1 次命中降级为 WARN 不阻塞（CLIENT_VERSION_PREV 常量合法残留）；≥2 次判失败。
 *   - 路径零硬编码：用户目录/微信 uid 动态发现，两台机器通用。
 */

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- 常量（跨机器无关） ----------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CV_FILE = path.join(ROOT, 'src/utils/clientVersion.js');
const UNPACK_TOOL = path.join(ROOT, 'tools/saltfield/wxapkg-decrypt.mjs');
const LOCAL_DATA = path.join(ROOT, 'local-data');
const STATE_FILE = path.join(LOCAL_DATA, '_version_rotate_state.json');
const BUNDLE_PATH = path.join(LOCAL_DATA, '_deploy.bundle');
const REMOTE_DEPLOY_SH = path.join(LOCAL_DATA, '_remote_deploy.sh');

const APPID_DIR = 'wx0840558555a454ed'; // 咸鱼之王小游戏 appid（全网一致，非机器特定）
const XWECHAT_USERS_DIR = path.join(os.homedir(), 'AppData/Roaming/Tencent/xwechat/radium/users');

const SERVER_HOST = '111.229.64.152';
const SERVER_REPO = '/opt/xyzw_web_helper';
const SSH_KEY = path.join(os.homedir(), '.ssh/id_xyzw_server');
const SSH_COMMON = ['-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null'];

// 测试范围：引用/覆盖 CLIENT_VERSION 的测试（grep test/ 仅 firstFrameSpoof 直接引用）+ pantao 5 件套
const TEST_FILES = [
  'test/firstFrameSpoof.test.js',
  'test/pantaoPlan.test.js',
  'test/pantaoState.test.js',
  'test/pantaoTasks.test.js',
  'test/pantaoMarchPath.test.js',
  'test/pantaoBroadcast.test.js',
];

const VERSION_RE = /\d+\.\d+\.\d+-[0-9a-f]+-wx/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const short = (h) => h.slice(0, 7);
const todayMMDD = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- 基础工具 ----------
function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`✓ ${msg}`);
}
function step(msg) {
  console.log(`\n== ${msg}`);
}

function sh(cmd, args, { timeout = 120_000, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  if (r.error) fail(`${cmd} 执行异常: ${r.error.message}`);
  if (r.status !== 0) {
    if (r.stderr) console.error(r.stderr.trim());
    fail(`${cmd} ${args[0] ?? ''} 失败 (exit=${r.status})`);
  }
  if (!quiet && r.stderr && r.stderr.includes('fatal')) console.error(r.stderr.trim());
  return r.stdout;
}

function ssh(cmd, { timeout = 120_000 } = {}) {
  const r = spawnSync('ssh', [...SSH_COMMON, `root@${SERVER_HOST}`, cmd], { encoding: 'utf8', timeout });
  if (r.error) fail(`ssh 执行异常: ${r.error.message}`);
  if (r.status !== 0) {
    if (r.stderr) console.error(r.stderr.trim());
    fail(`ssh 失败: ${cmd}`);
  }
  return r.stdout.trim();
}

function scp(localPath, remotePath, { timeout = 120_000 } = {}) {
  // 🔴 每次调用 = 一条独立 scp（bundle 与脚本必须分开传，多文件 scp 会留旧文件）
  sh('scp', [...SSH_COMMON, localPath, `root@${SERVER_HOST}:${remotePath}`], { timeout, quiet: true });
}

// ---------- 状态文件 ----------
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeState(patch) {
  fs.mkdirSync(LOCAL_DATA, { recursive: true });
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// ---------- 发现微信小游戏包目录 ----------
function findPackageRoot() {
  if (!fs.existsSync(XWECHAT_USERS_DIR)) {
    fail(`未找到微信数据目录: ${XWECHAT_USERS_DIR}\n  确认 PC 微信已登录且下载过小游戏`);
  }
  const roots = [];
  for (const uid of fs.readdirSync(XWECHAT_USERS_DIR)) {
    const p = path.join(XWECHAT_USERS_DIR, uid, 'applet/packages', APPID_DIR);
    if (fs.existsSync(p)) roots.push(p);
  }
  if (roots.length === 0) {
    fail(`users/*/applet/packages/ 下没有 ${APPID_DIR}\n  提示：先在 PC 微信里打开一次咸鱼之王小游戏`);
  }
  if (roots.length > 1) {
    console.log(`  发现 ${roots.length} 个微信用户目录含该小游戏，取构建号最大者`);
  }
  return roots;
}

function latestBuild(roots) {
  let best = null; // { build, dir }
  for (const root of roots) {
    for (const name of fs.readdirSync(root)) {
      if (!/^\d+$/.test(name)) continue;
      const b = Number(name);
      if (!best || b > best.build) best = { build: b, dir: path.join(root, name) };
    }
  }
  if (!best) fail(`包目录里没有任何数字构建号目录: ${roots.join(', ')}`);
  return best;
}

// ---------- 解包 + 提串 ----------
function unpackGameJs(build, dir) {
  const outDir = path.join(LOCAL_DATA, `wxapkg-${build}`);
  const gameJs = path.join(outDir, 'game.js');
  if (fs.existsSync(gameJs)) {
    ok(`复用已有解包产物 local-data/wxapkg-${build}/game.js`);
    return gameJs;
  }
  const wxapkg = path.join(dir, '__APP__.wxapkg');
  if (!fs.existsSync(wxapkg) || fs.statSync(wxapkg).size === 0) {
    fail(`__APP__.wxapkg 不存在或为空: ${wxapkg}\n  若刚打开游戏，请等下载完成再重跑`);
  }
  step(`解包构建 ${build} 的 __APP__.wxapkg`);
  execFileSync(process.execPath, [UNPACK_TOOL, wxapkg, outDir], { stdio: 'inherit' });
  if (!fs.existsSync(gameJs)) fail(`解包后未见 game.js: ${outDir}`);
  ok(`解包完成 → local-data/wxapkg-${build}/game.js`);
  return gameJs;
}

function extractVersion(gameJs) {
  const src = fs.readFileSync(gameJs, 'utf8');
  const hits = [...new Set(src.match(VERSION_RE) ?? [])];
  if (hits.length === 0) {
    fail('game.js 中未找到形如 "x.y.z-<hash>-wx" 的版本串（格式可能变了，人工确认）');
  }
  if (hits.length > 1) {
    fail(`game.js 中命中 ${hits.length} 个候选串，无法唯一定位，人工确认:\n  ${hits.join('\n  ')}`);
  }
  return hits[0];
}

// ---------- 修改 clientVersion.js（幂等，4 处精确替换，全部断言唯一命中） ----------
function patchClientVersion({ newV, newBuild }) {
  const today = todayMMDD();
  let src = fs.readFileSync(CV_FILE, 'utf8');
  const cur = src.match(/export const CLIENT_VERSION = "([^"]+)"/)?.[1];
  if (!cur) fail('clientVersion.js 解析不到 CLIENT_VERSION 常量');
  if (cur === newV) {
    ok(`CLIENT_VERSION 已是 ${newV}，跳过改文件（幂等）`);
    return { oldV: cur, patched: false };
  }
  const oldV = cur;
  const prevOld = src.match(/export const CLIENT_VERSION_PREV = "([^"]+)"/)?.[1];
  if (!prevOld) fail('clientVersion.js 解析不到 CLIENT_VERSION_PREV 常量');

  // ① 版本史「当前」行 → 历史行 + 新当前行（并从中解析 oldStart / oldBuild 供后面用）
  const curLineRe = new RegExp(
    `^ \\*   - ${esc(oldV)}（(\\d{2}-\\d{2}) 起，官方 (\\d+) 构建真串）：当前。$`, 'm');
  const m = src.match(curLineRe);
  if (!m) fail(`版本史中找不到「当前」行（格式可能漂移，人工确认）:\n  期望形如:  *   - ${oldV}（MM-DD 起，官方 N 构建真串）：当前。`);
  const [, oldStart, oldBuildStr] = m;
  const oldBuild = Number(oldBuildStr);
  const historyLine = ` *   - ${oldV}（${oldStart}~${today}，官方 ${oldBuild} 构建真串）。`;
  const newCurLine = ` *   - ${newV}（${today} 起，官方 ${newBuild} 构建真串）：当前。`;
  src = src.replace(curLineRe, `${historyLine}\n${newCurLine}`);

  // ② CLIENT_VERSION 常量
  const cvRe = new RegExp(`export const CLIENT_VERSION = "${esc(oldV)}";`);
  if (src.split(cvRe).length - 1 !== 1) fail('CLIENT_VERSION 常量行未唯一命中，中止');
  src = src.replace(cvRe, `export const CLIENT_VERSION = "${newV}";`);

  // ③ CLIENT_VERSION_PREV 常量
  const prevRe = new RegExp(`export const CLIENT_VERSION_PREV = "${esc(prevOld)}";`);
  if (src.split(prevRe).length - 1 !== 1) fail('CLIENT_VERSION_PREV 常量行未唯一命中，中止');
  src = src.replace(prevRe, `export const CLIENT_VERSION_PREV = "${oldV}";`);

  // ④ 回退行
  const rollbackRe = /^ \* 回退：改回 "[^"]+" 即恢复 \d{2}-\d{2} 状态。$/m;
  if (!rollbackRe.test(src)) fail('回退行格式漂移，人工确认');
  src = src.replace(rollbackRe, ` * 回退：改回 "${oldV}" 即恢复 ${oldStart} 状态。`);

  fs.writeFileSync(CV_FILE, src, 'utf8');
  ok(`clientVersion.js 已更新: ${oldV} → ${newV}（PREV ← ${prevOld}，版本史 + 回退行同步）`);
  return { oldV, oldBuild, oldStart, patched: true };
}

// ---------- 测试 ----------
function runTests() {
  step('跑测试（firstFrameSpoof + pantao×5）');
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...TEST_FILES],
    { encoding: 'utf8', cwd: ROOT, timeout: 180_000 });
  const tail = (r.stdout ?? '').trim().split('\n').slice(-8).join('\n');
  console.log(tail);
  if (r.status !== 0) fail(`测试失败 (exit=${r.status})`);
  const pass = r.stdout?.match(/^# pass (\d+)$/m)?.[1];
  ok(`测试 ${pass ?? '?'} 全过`);
}

// ---------- git ----------
function git(args, { capture = true } = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) {
    if (r.stderr) console.error(r.stderr.trim());
    fail(`git ${args.join(' ')} 失败 (exit=${r.status})`);
  }
  return capture ? (r.stdout ?? '').trim() : undefined;
}

function commit(oldV, newV, newBuild) {
  step('commit（不 push）');
  const dirty = spawnSync('git', ['diff', '--quiet', '--', 'src/utils/clientVersion.js'], { cwd: ROOT }).status !== 0;
  if (!dirty) {
    const lastMsg = git(['log', '-1', '--format=%s']);
    if (lastMsg.includes(newV)) {
      ok(`工作区干净且最新提交已含 ${newV}（${short(git(['rev-parse', 'HEAD']))}），跳过 commit`);
      return;
    }
    fail('clientVersion.js 无待提交改动，且最新提交不含新串——状态矛盾，人工检查');
  }
  git(['add', 'src/utils/clientVersion.js']);
  const msg = `chore: clientVersion 每周换串 ${oldV.split('-')[0]}→${newBuild}（${newV}）`;
  const msgFile = path.join(LOCAL_DATA, '_vr_commit_msg.txt');
  fs.writeFileSync(msgFile, msg + '\n', 'utf8');
  git(['commit', '-F', msgFile]);
  ok(`已提交 ${short(git(['rev-parse', 'HEAD']))}：${msg}`);
}

// ---------- 部署（bundle 直连，红线全断言） ----------
async function deployAndVerify({ oldV, newV }) {
  step('部署：bundle 直连服务器');
  const head = git(['rev-parse', 'HEAD']);

  const serverHead = ssh(`cd ${SERVER_REPO} && git rev-parse HEAD`);
  ok(`服务器 HEAD = ${short(serverHead)}`);
  if (spawnSync('git', ['merge-base', '--is-ancestor', serverHead, 'HEAD'], { cwd: ROOT }).status !== 0) {
    fail(`服务器 HEAD ${short(serverHead)} 不是本地 HEAD 祖先（疑似分叉）——人工介入，禁止硬上`);
  }

  git(['bundle', 'create', BUNDLE_PATH, `${serverHead}..HEAD`]);
  git(['bundle', 'verify', BUNDLE_PATH]); // 本地 verify，失败即抛
  ok(`本地 bundle 就绪: ${serverHead.slice(0, 7)}..${short(head)}`);

  scp(BUNDLE_PATH, '/tmp/deploy.bundle'); // 🔴 单独一条，名字必须是 /tmp/deploy.bundle
  ok('scp bundle → /tmp/deploy.bundle');
  scp(REMOTE_DEPLOY_SH, '/tmp/_remote_deploy.sh');
  ok('scp 部署脚本 → /tmp/_remote_deploy.sh');

  const verifyOut = ssh(`cd ${SERVER_REPO} && git bundle verify /tmp/deploy.bundle 2>&1`);
  if (!verifyOut.includes(serverHead)) fail(`服务器侧 bundle verify 未指向服务器 HEAD ${short(serverHead)}，中止`);
  ok('服务器侧 bundle verify 通过');

  step('服务器构建（fetch → reset → pnpm build → nginx reload，约 1 分钟）');
  const buildOut = ssh('cp /tmp/_remote_deploy.sh /tmp/deploy_build.sh && bash /tmp/deploy_build.sh 2>&1',
    { timeout: 300_000 });
  console.log(buildOut.trim().split('\n').slice(-3).join('\n'));
  const doneCommit = buildOut.match(/完成：\S+ \S+ commit=([0-9a-f]+)/)?.[1];
  if (doneCommit !== short(head)) {
    fail(`构建末行 commit=${doneCommit ?? '无'} ≠ 本地 HEAD ${short(head)}——上错了，立即排查 bundle 文件名`);
  }
  ok(`构建末行 commit 断言通过 (${doneCommit})`);

  step('双向核验');
  const newFiles = ssh(`cd ${SERVER_REPO}/dist && grep -rl '${newV}' assets/ | head -5`);
  if (!newFiles) fail(`服务器 dist/assets/ 新串 0 命中（${newV}）`);
  ok(`服务器侧新串命中: ${newFiles.replace(/\n/g, ' ')}`);
  const oldFileCount = Number(ssh(`cd ${SERVER_REPO}/dist && grep -rl '${esc(oldV)}' assets/ | wc -l`));
  const oldVerdict = oldFileCount === 0 ? 'PASS（0 命中）'
    : oldFileCount === 1 ? `WARN（${oldFileCount} 文件命中——预期为 CLIENT_VERSION_PREV 常量残留，不阻塞）`
    : `FAIL（${oldFileCount} 文件命中旧串，异常）`;
  if (oldFileCount >= 2) fail(`服务器侧旧串核验 ${oldVerdict}`);
  ok(`服务器侧旧串: ${oldVerdict}`);

  const chunks = newFiles.split('\n').filter(Boolean);
  for (const chunk of chunks) {
    const url = `http://${SERVER_HOST}/assets/${chunk}`;
    const res = await fetch(url);
    if (!res.ok) fail(`公网 ${url} → HTTP ${res.status}`);
    const text = await res.text();
    const newHits = text.split(newV).length - 1;
    const oldHits = text.split(oldV).length - 1;
    if (newHits < 1) fail(`公网 chunk ${chunk} 新串 0 命中`);
    ok(`公网 ${chunk}: HTTP ${res.status}，新串 ${newHits} 命中，旧串 ${oldHits} 命中` +
      (oldHits === 1 ? '（PREV 残留，WARN 不阻塞）' : oldHits >= 2 ? '（异常）' : ''));
    if (oldHits >= 2) fail(`公网 chunk ${chunk} 旧串 ${oldHits} 次命中，异常`);
  }
  ok('双向核验全绿');
}

// ---------- 主流程 ----------
async function main() {
  const doDeploy = process.argv.includes('--yes');
  console.log(`version-rotate：${doDeploy ? '全流程（含部署）' : 'detect 段（停在 commit 前）'}`);

  step('发现微信小游戏包目录');
  const roots = findPackageRoot();
  const { build, dir } = latestBuild(roots);
  ok(`最新构建 = ${build}（${dir}）`);

  const state = readState();
  if ((state.lastBuild ?? 0) >= build) {
    console.log(`\n✓ 已是最新（state.lastBuild=${state.lastBuild} ≥ ${build}），无事可做`);
    return;
  }

  const gameJs = unpackGameJs(build, dir);
  const newV = extractVersion(gameJs);
  ok(`真串 = ${newV}`);

  const cvNow = fs.readFileSync(CV_FILE, 'utf8').match(/export const CLIENT_VERSION = "([^"]+)"/)?.[1];
  if (cvNow === newV) {
    writeState({ lastBuild: build, lastVersion: newV, phase: 'noop' });
    console.log(`\n✓ 构建 ${build} 提取串与当前 CLIENT_VERSION 相同（无需换串/首次初始化状态），已记录，退出`);
    return;
  }

  const patchResult = patchClientVersion({ newV, newBuild: build });
  runTests();

  if (!doDeploy) {
    writeState({ pendingBuild: build, pendingVersion: newV, oldVersion: patchResult.oldV, phase: 'detected' });
    console.log(`\n── detect 完成，停在 commit 前 ──`);
    console.log(`  新串: ${newV}   旧串: ${patchResult.oldV}`);
    console.log(`  确认无误后执行: node tools/version-rotate.mjs --yes`);
    return;
  }

  commit(patchResult.oldV, newV, build);
  await deployAndVerify({ oldV: patchResult.oldV, newV });
  writeState({ lastBuild: build, lastVersion: newV, phase: 'deployed', pendingBuild: undefined, pendingVersion: undefined, oldVersion: undefined });
  console.log(`\n✅ 换串完成：${patchResult.oldV} → ${newV}（构建 ${build}），已上线并双向核验通过`);
}

main().catch((e) => fail(e.stack ?? String(e)));
