/* ============================================================
   样式兼容性测试  legacy-css-test.mjs

   和 JS 那条锁是一对：JS 遇到不认识的语法会整份不执行，
   CSS 遇到不认识的属性/值则是**只丢弃那一条声明** —— 听起来温和得多，
   但落到 `height: 100dvh` 上就是"容器没有高度"，整个界面塌成一条。

   2020 年的 Android 11 机型出厂 WebView 是 Chrome 83/84，这条线之前：
     · dvh / svh / lvh           → Chrome 108
     · inset 简写                → Chrome 87
     · flex 容器里的 gap          → Chrome 84
     · :is() / :where()          → Chrome 88
     · aspect-ratio              → Chrome 88
     · color-mix()               → Chrome 111
     · @container                → Chrome 105

   规则：用新特性的地方，前面必须先写一条老写法兜底。
   ============================================================ */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? "\n      " + detail : ""}`);
  }
}

const DIRS = ["styles", "ime", "splash"];
const files = [];
for (const d of DIRS) {
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (extname(p) === ".css") files.push(p);
    }
  })(join(ROOT, d));
}

/** 去掉注释，保留换行（行号不变）。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** 把 CSS 摊平成声明列表：每条带属性、值、所在行、块深度。 */
function declarations(css) {
  const out = [];
  const lines = css.split("\n");
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // 先处理本行里的括号，再抠声明 —— 顺序影响深度，但声明本身不跨行
    const re = /([-a-zA-Z]+)\s*:\s*([^;{}]+);/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      out.push({ prop: m[1].toLowerCase(), value: m[2].trim(), line: i + 1, depth, text: raw });
    }
    for (const ch of raw) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return out;
}

console.log(`\n样式文件 · ${files.length} 个\n`);

const VH_UNITS = /\b\d+(\.\d+)?(dvh|svh|lvh)\b/;
const HEIGHT_PROPS = new Set(["height", "min-height", "max-height"]);

const badDvh = [];
for (const f of files) {
  const src = stripComments(readFileSync(f, "utf8"));
  const decls = declarations(src);
  for (let i = 0; i < decls.length; i++) {
    const d = decls[i];
    if (!HEIGHT_PROPS.has(d.prop) || !VH_UNITS.test(d.value)) continue;
    // 往前找：同深度、同属性、用 vh 的兜底声明，中间不能跨出当前块
    let ok = false;
    for (let j = i - 1; j >= 0 && j >= i - 12; j--) {
      const p = decls[j];
      if (p.depth < d.depth) break; // 已经出了这个块
      if (p.depth === d.depth && p.prop === d.prop && /\b\d+(\.\d+)?vh\b/.test(p.value)) {
        ok = true;
        break;
      }
    }
    if (!ok) badDvh.push(`${relative(ROOT, f)}:${d.line}  ${d.prop}: ${d.value}`);
  }
}
check(
  "dvh/svh/lvh 都先写了 vh 兜底",
  badDvh.length === 0,
  badDvh.slice(0, 8).join("\n      ")
);

/* inset 简写：老内核整条丢弃，必须先逐边写 */
const badInset = [];
for (const f of files) {
  const src = stripComments(readFileSync(f, "utf8"));
  const decls = declarations(src);
  for (let i = 0; i < decls.length; i++) {
    const d = decls[i];
    if (d.prop !== "inset") continue;
    const got = new Set();
    for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
      const p = decls[j];
      if (p.depth < d.depth) break;
      if (p.depth === d.depth && ["top", "right", "bottom", "left"].includes(p.prop)) got.add(p.prop);
    }
    if (got.size < 4) {
      badInset.push(`${relative(ROOT, f)}:${d.line}  inset: ${d.value}（缺 ${["top", "right", "bottom", "left"].filter((k) => !got.has(k)).join("/")}）`);
    }
  }
}
check(
  "inset 简写前面都逐边写过 top/right/bottom/left",
  badInset.length === 0,
  badInset.slice(0, 8).join("\n      ")
);

/* 这些特性目前不提供兜底，就不该出现 */
const BANNED = [
  { re: /:has\(/, name: ":has()（Chrome 105，没有等价降级）" },
  { re: /@container\b/, name: "@container（Chrome 105）" },
  { re: /\baspect-ratio\s*:/, name: "aspect-ratio（Chrome 88）" },
  { re: /\btext-wrap\s*:\s*(balance|pretty)/, name: "text-wrap: balance（Chrome 114）" },
];
for (const rule of BANNED) {
  const hits = [];
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"));
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (rule.re.test(lines[i])) hits.push(`${relative(ROOT, f)}:${i + 1}`);
    }
  }
  check(`没有使用 ${rule.name}`, hits.length === 0, hits.slice(0, 6).join("  "));
}

/* 允许但必须带兜底的 */
console.log("\n带兜底的写法\n");

const colorMix = [];
for (const f of files) {
  const src = stripComments(readFileSync(f, "utf8"));
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/color-mix\(/.test(lines[i])) {
      const prop = (lines[i].match(/^\s*([-a-zA-Z]+)\s*:/) || [])[1];
      const prevLine = lines[i - 1] || "";
      // 上一条同属性声明就算兜底
      const ok = prop && new RegExp(`^\\s*${prop}\\s*:`).test(prevLine);
      colorMix.push({ at: `${relative(ROOT, f)}:${i + 1}`, ok, prop });
    }
  }
}
check(
  "color-mix 的颜色都有上一条同属性兜底",
  colorMix.every((c) => c.ok),
  colorMix.filter((c) => !c.ok).map((c) => `${c.at}（${c.prop}）`).slice(0, 6).join("\n      ")
);

/* 关键：整屏容器的高度必须真的能用 vh 算出来 */
const base = readFileSync(join(ROOT, "styles/base.css"), "utf8");
check("`.device` 有 height: 100vh 兜底", /\.device\s*\{[^}]*height:\s*100vh;/m.test(base));
check("`.stage` 有 min-height: 100vh 兜底", /\.stage\s*\{[^}]*min-height:\s*100vh;/m.test(base));

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
