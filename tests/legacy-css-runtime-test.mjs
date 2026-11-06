/* ============================================================
   旧内核样式复现测试  legacy-css-runtime-test.mjs

   上一版（0.57.3）修了 JS 语法，界面能起来了，但用户看到的是：
   标题栏 + 四个导航项贴在顶部，下面一片全黑 —— 内容区高度是 0。

   原因是 CSS：`.device { height: 100dvh }`。dvh 是 Chrome 108 的单位，
   2020 年的 Android 11 机型（WebView 85~107）不认识，**整条声明被丢弃**，
   容器没有高度 → `.views { flex: 1 }` 撑不开 → 全塌。

   这里不是"断言我写了 vh"，而是**真的把老内核会丢弃的声明删掉**，
   再看布局还在不在。旧内核的行为是确定的：不认识的单位/属性，整条丢。

   所以服务器把 CSS 里
     · 含 dvh / svh / lvh 的行       → 删（Chrome 108 才认识）
     · 以 inset: 开头的行            → 删（Chrome 87 才认识）
   然后要求布局完全正常。删掉之后还能撑住，才说明兜底是真的。
   ============================================================ */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { loadAndroidMime } from "./android-serve.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const mime = await loadAndroidMime();
const VIEW_H = 720;

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? "  → " + detail : ""}`);
  }
}

/* 老内核会丢弃的声明 */
function degrade(css) {
  return css
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (/^(.*:)?.*\b\d+(\.\d+)?(dvh|svh|lvh)\b/.test(t)) return false;
      if (/^inset\s*:/.test(t)) return false;
      return true;
    })
    .join("\n");
}

const DROPPED = new Set();

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  if (p === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
  try {
    const buf = await readFile(f);
    if (p.endsWith(".css")) {
      const before = buf.toString("utf8");
      const after = degrade(before);
      if (before !== after) DROPPED.add(p);
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      res.end(after);
      return;
    }
    res.writeHead(200, { "content-type": mime.mimeFor(f), "cache-control": "no-store" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "cache-control": "no-store" });
    res.end("");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 360, height: VIEW_H }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, body: "" }));
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9500); // 跨过启动动画与看门狗阈值

console.log("\n旧内核样式（丢弃 dvh / inset）下的布局\n");
check("确实降级了几个样式表", DROPPED.size >= 1, [...DROPPED].join(" "));

const m = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const h = (e) => (e ? Math.round(e.getBoundingClientRect().height) : -1);
  const top = (e) => (e ? Math.round(e.getBoundingClientRect().top) : -1);
  const bar = q(".tabbar");
  return {
    device: h(q(".device")),
    app: h(q(".app")),
    views: h(q("#views")),
    chat: h(q(".chat")),
    tabbar: h(bar),
    tabbarTop: top(bar),
    composer: !!q("#composer-input"),
    home: !!q(".messages--empty"),
    splash: document.querySelectorAll(".dsh-splash").length,
    panel: document.body.innerText.indexOf("界面没能启动") >= 0,
    viewport: window.innerHeight,
  };
});

console.log("  实测:", JSON.stringify(m));

check("整屏容器有高度（靠在 vh 兜底上）", m.device >= VIEW_H - 4, `device=${m.device}`);
check("内容区被撑开", m.views > 300, `views=${m.views}`);
check("对话页有高度", m.chat > 300, `chat=${m.chat}`);
check("底部导航贴着屏幕底", Math.abs(m.tabbarTop + m.tabbar - VIEW_H) <= 2, `tabbarTop=${m.tabbarTop} h=${m.tabbar}`);
check("输入框渲染出来了", m.composer);
check("首页空态渲染出来了", m.home);
check("启动动画已退场", m.splash === 0);
check("没有误报「界面没能启动」", !m.panel);
check("没有页面错误", errors.length === 0, errors.slice(0, 2).join(" | "));

await page.screenshot({ path: "/workspace/legacy-render.png" });
await browser.close();
server.close();

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
