#!/usr/bin/env node
/**
 * 把模拟器打成**单文件 HTML**。
 *
 *   node tools/goldenfish-simulator/build.mjs
 *   → tools/goldenfish-simulator/dist/goldenfish-simulator.html
 *
 * esbuild 会把 main.js + engine.js + 真实生产模块
 * （src/utils/goldenfishConsumePlan.js、src/utils/goldenfishFinishPlan.js）
 * 全部打进一个 IIFE，产物零依赖、双击即用。
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const tplPath = path.join(dir, "index.html");
const outPath = path.join(dir, "dist", "goldenfish-simulator.html");

const result = await build({
  entryPoints: [path.join(dir, "main.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome100", "firefox100", "safari15"],
  write: false,
  minify: false,
  legalComments: "none",
  logLevel: "warning",
});

const js = result.outputFiles[0].text;
const tpl = fs.readFileSync(tplPath, "utf8");
if (!tpl.includes("/*__BUNDLE__*/")) {
  throw new Error("index.html 里找不到 /*__BUNDLE__*/ 占位符");
}
// 用函数替换：避免 $& / $1 之类被当作替换模式
const html = tpl.replace("/*__BUNDLE__*/", () => js);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, "utf8");

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log(`✅ 打包完成: ${outPath}`);
console.log(`   bundle ${kb(js.length)}  ·  html ${kb(html.length)}`);
