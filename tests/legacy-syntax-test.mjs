/* ============================================================
   语法基线测试  legacy-syntax-test.mjs

   为什么需要这条锁：
   Android 11 那批机器（2020 年）出厂 WebView 常停在 Chrome 83/84。
   浏览器遇到不认识的语法，不是"跳过那一句"，而是**整个脚本文件拒绝执行**。
   一个 `||=`（ES2021 / Chrome 85）就足以让 ui.js 连同 app.js 一起失效，
   用户看到的是纯黑。

   所以这里把前端可执行代码卡在两档：
     · 模块代码 → ES2020（Chrome 80+，覆盖 83/84）
     · index.html 内联的看门狗 → ES5（它要在最坏的内核上都要跑起来）

   失败的提示会给出文件、行号和原始报错，改起来是直接的。
   ============================================================ */

import { parse } from "acorn";
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

/* ---------------- 模块代码：ES2020 ---------------- */
const DIRS = ["scripts", "ime", "splash"];
const SKIP = new Set(["vendor", "node_modules"]);

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP.has(name)) collect(p, out);
    } else if (extname(p) === ".js" || extname(p) === ".mjs") {
      out.push(p);
    }
  }
  return out;
}

function lineOf(src, pos) {
  return src.slice(0, pos).split("\n").length;
}

/**
 * 用解析器给的注释区间把注释挖空（保留换行，行号不变）。
 *
 * 必须做这一步：禁用语法经常出现在注释里（"别用 `||=`，Chrome 85 才有"），
 * 直接全文正则扫会把说明当成违规，测试就变成狼来了。
 * 手写状态机在这里不可靠 —— ui.js 里正则字面量和中文引号会把状态带偏，
 * 所以直接问 acorn 要 onComment 的区间。
 */
function maskComments(src) {
  const spans = [];
  try {
    parse(src, {
      ecmaVersion: 2020,
      sourceType: "module",
      allowHashBang: true,
      onComment: (block, text, startPos, endPos) => spans.push([startPos, endPos]),
    });
  } catch {
    return src; // 解析不了的由前面的用例报，这里不重复
  }
  const chars = src.split("");
  for (const [a, b] of spans) {
    for (let i = a; i < b; i++) if (chars[i] !== "\n") chars[i] = " ";
  }
  return chars.join("");
}

const files = [];
for (const d of DIRS) collect(join(ROOT, d), files);

console.log(`\n模块代码 · ES2020（Chrome 80+）· ${files.length} 个文件\n`);

const broken = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  try {
    parse(src, { ecmaVersion: 2020, sourceType: "module", allowHashBang: true });
  } catch (e) {
    broken.push(`${relative(ROOT, f)}:${lineOf(src, e.pos)}  ${e.message}`);
  }
}

check(
  `全部 ${files.length} 个模块都能被 Chrome 80 解析`,
  broken.length === 0,
  broken.slice(0, 8).join("\n      ")
);

/* 逐条点名常见的高版本语法，比"解析失败"更好搜、更好改 */
const FORBIDDEN = [
  { re: /\|\|=/, name: "逻辑或赋值 ||=（ES2021 / Chrome 85）", hint: "改成 if (!a) a = b" },
  { re: /&&=/, name: "逻辑与赋值 &&=（ES2021 / Chrome 85）", hint: "改成 if (a) a = b" },
  { re: /\?\?=/, name: "空值赋值 ??=（ES2021 / Chrome 85）", hint: "改成 if (a == null) a = b" },
  { re: /\bstructuredClone\b/, name: "structuredClone（Chrome 98）", hint: "用 JSON 或手写深拷贝" },
  { re: /\bObject\.hasOwn\b/, name: "Object.hasOwn（Chrome 93）", hint: "用 Object.prototype.hasOwnProperty.call" },
  { re: /\.at\(\s*-?\d/, name: "Array.prototype.at（Chrome 92）", hint: "用 [a.length - 1]" },
  { re: /\.findLast\(/, name: "findLast（Chrome 97）", hint: "倒序 for 循环" },
  { re: /\.toSorted\(|\.toReversed\(/, name: "toSorted / toReversed（Chrome 110）", hint: "slice().sort()" },
  { re: /\bstatic\s*\{/, name: "类静态初始化块（Chrome 94）", hint: "挪到类外赋值" },
  { re: /^await\s/m, name: "顶层 await（Chrome 89）", hint: "包进 async 函数" },
];

/* diagnose.js 里这些词是**探测目标**，不是使用：
   它要把 `||=`、`static {}` 这类代码字符串喂给 new Function，看能不能解析，
   从而判断这台机器的内核支不支持。扫它就全是误报。
   它另有更严的一道锁（下面按 ES5 解析），不靠这条兜。 */
const NOT_USING_JUST_PROBING = new Set(["diagnose.js"]);

for (const rule of FORBIDDEN) {
  const hits = [];
  for (const f of files) {
    if (NOT_USING_JUST_PROBING.has(f.split("/").pop())) continue;
    const src = maskComments(readFileSync(f, "utf8"));
    const m = rule.re.exec(src);
    if (m) hits.push(`${relative(ROOT, f)}:${lineOf(src, m.index)}`);
  }
  check(`没有使用 ${rule.name}`, hits.length === 0, hits.slice(0, 5).join("  ") + `  → ${rule.hint}`);
}

/* ---------------- index.html 内联脚本：ES5 ---------------- */
console.log("\n启动看门狗（index.html 内联）· ES5\n");

const html = readFileSync(join(ROOT, "index.html"), "utf8");
const inline = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html)) !== null) inline.push(m[1]);

check("确实找到了内联脚本", inline.length > 0, `找到 ${inline.length} 段`);

let inlineBad = [];
for (let i = 0; i < inline.length; i++) {
  if (!inline[i].trim()) continue;
  try {
    parse(inline[i], { ecmaVersion: 5, sourceType: "script" });
  } catch (e) {
    inlineBad.push(`第 ${i + 1} 段 第 ${lineOf(inline[i], e.pos)} 行：${e.message}`);
  }
}

check("内联脚本是纯 ES5（最坏的内核也能执行）", inlineBad.length === 0, inlineBad.join("\n      "));

/* 看门狗的关键行为得真的写在页面里 */
check("看门狗监听了 error", /addEventListener\(\s*["']error["']/.test(html));
check("看门狗监听了 unhandledrejection", /addEventListener\(\s*["']unhandledrejection["']/.test(html));
check("看门狗不等 DOMContentLoaded 就计时", /\n\s*arm\(\);/.test(html));

/* ---------------- 自检页脚本：ES5 ----------------
   这一段比上面更严，理由也更强：
   自检页是"应用挂了之后"唯一还能打开的东西。它要是用了新语法，
   在最需要它的那台机器上会跟着一起挂 —— 诊断工具自己先死，
   等于整个排障通道被封掉。
   所以它按 ES5 校验，比模块代码（ES2020）低一整档。 */
console.log("\n自检页脚本 · ES5（比模块更严）\n");

const diagPath = join(ROOT, "scripts/diagnose.js");
let diagOk = false;
let diagErr = "";
try {
  const src = readFileSync(diagPath, "utf8");
  parse(src, { ecmaVersion: 5, sourceType: "script" });
  diagOk = true;
} catch (e) {
  diagErr = typeof e.pos === "number"
    ? `${lineOf(readFileSync(diagPath, "utf8"), e.pos)} 行：${e.message}`
    : e.message;
}
check("scripts/diagnose.js 是纯 ES5", diagOk, diagErr);

/* 自检页不能依赖应用的样式 —— 样式坏了正是要查的东西之一 */
const diagHtml = readFileSync(join(ROOT, "diagnose.html"), "utf8");
check(
  "diagnose.html 不引 styles/*.css",
  !/<link[^>]+href=["'][^"']*styles\//i.test(diagHtml),
  "自检页若依赖应用样式，样式出问题时它自己也排不出版"
);
check(
  "diagnose.html 不引模块脚本",
  !/<script[^>]+type=["']module["']/i.test(diagHtml),
  "模块图断了 import 就不执行，自检页必须用普通 script"
);
check(
  "diagnose.html 没有内联脚本（逻辑全在 diagnose.js 里，便于测试）",
  !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(diagHtml)
);

/* 布局探针必须保持"只有样式、没有脚本" —— 它是零副作用的测量工具 */
const probeHtml = readFileSync(join(ROOT, "layout-probe.html"), "utf8");
check("layout-probe.html 不含脚本", !/<script/i.test(probeHtml));
check(
  "layout-probe.html 引了 base.css（否则量不出真布局）",
  /styles\/base\.css/.test(probeHtml)
);
check(
  "layout-probe.html 保持了 .stage > .device > .app > .views > .tabbar 层级",
  /class="stage"[\s\S]*class="device"[\s\S]*class="app"[\s\S]*class="views"[\s\S]*class="tabbar"/.test(probeHtml)
);

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
