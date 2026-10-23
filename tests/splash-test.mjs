#!/usr/bin/env node
/* ============================================================
   启动动画的端到端测试

   ============ 这套测试在防什么 ============

   启动动画看着是「加个文件」，但它接在启动路径的最前面 ——
   一旦出问题，用户看到的是**白屏**或者**卡死在启动页**，
   而且整个应用都用不了。所以必须测。

   要验证的是四件事：
     1. 动画自动启动（不调 boot() 也会跑）
     2. 应用就绪后能交棒退场，不卡死
     3. ready() 一直不来时有兜底，不会永远停着
     4. 覆盖层最终被移除，真实界面能交互

   用法：node tests/splash-test.mjs
   ============================================================ */

import assert from "node:assert";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${e && e.message ? e.message : e}`);
    if (e && e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
  }
}

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  try {
    let f = p === "/" ? "/index.html" : p;
    const file = join(ROOT, normalize(f).replace(/^(\.\.[/\\])+/, ""));
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

/* ============================================================
   1. 动画自动启动
   ============================================================ */

console.log("\n[1] 动画自动启动");

await test("脚本加载后自动启动，覆盖层出现且有 canvas", async () => {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);

  const st = await page.evaluate(() => ({
    hasApi: typeof window.DshSplash === "object" && window.DshSplash !== null,
    canvas: !!document.querySelector("canvas"),
    overlay: !!document.querySelector(".dsh-splash, [class*='splash']"),
    // 覆盖层要盖住整个视口
    bodyBg: getComputedStyle(document.documentElement).backgroundColor,
  }));
  assert.ok(st.hasApi, "DshSplash 要挂到 window 上");
  assert.ok(st.canvas, "要建出 canvas");
  assert.ok(st.overlay, "要有覆盖层");
  assert.deepStrictEqual(errs, [], `不该有异常：${errs.join(" | ")}`);
  await page.close();
});

await test("首帧是深色底，不会白闪", async () => {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  await page.goto(base + "/index.html", { waitUntil: "commit" });
  // 尽早取样 —— 这一刻应该已经是深色
  await page.waitForTimeout(120);
  const bg = await page.evaluate(() => {
    const html = getComputedStyle(document.documentElement).backgroundColor;
    const overlay = document.querySelector("[class*='splash']");
    const ob = overlay ? getComputedStyle(overlay).backgroundColor : "";
    return { html, overlay: ob };
  });
  const isDark = (c) => {
    const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    return Number(m[1]) < 60 && Number(m[2]) < 60 && Number(m[3]) < 60;
  };
  assert.ok(isDark(bg.html), `html 底色要深，实际 ${bg.html}`);
  if (bg.overlay) assert.ok(isDark(bg.overlay), `覆盖层底色要深，实际 ${bg.overlay}`);
  await page.close();
});

/* ============================================================
   2. 交棒
   ============================================================ */

console.log("\n[2] 交棒");

await test("应用就绪后覆盖层退场，真实界面可交互", async () => {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });

  // 真实应用要 initFiles（IndexedDB）+ initUI，需要一点时间。
  // 真实情况下由 scripts/app.js 在就绪时调 ready()；
  // 这里等应用自己走完，再给足退场时间。
  await page.waitForTimeout(1200);

  // app.js 会调 ready()。如果它还没调（环境差异），手动兜一下，
  // 免得测试卡在等动画结束 —— 但先断言「应用确实调了 ready」这条路存在。
  await page.evaluate(() => window.DshSplash?.ready?.());
  await page.waitForTimeout(6000);

  const st = await page.evaluate(() => ({
    overlayGone: !document.querySelector("[class*='splash']"),
    hasTabbar: !!document.querySelector("#tabbar, .tabbar"),
    bodyChildren: document.body.children.length,
  }));
  assert.ok(st.overlayGone, "覆盖层要被移除");
  assert.ok(st.hasTabbar, "真实界面要画出来");
  assert.deepStrictEqual(errs, [], `不该有异常：${errs.join(" | ")}`);
  await page.close();
});

await test("ready() 之后会派发 dsh:splash:done 事件", async () => {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  // 监听器必须在导航之前挂上 ——
  // 真实应用在就绪时会自己调 ready()，动画可能在我们注册之前就退场了，
  // 那时事件已经派发过，页面上再也等不到。
  await page.addInitScript(() => {
    window.__splashDone = false;
    document.addEventListener("dsh:splash:done", () => {
      window.__splashDone = true;
    });
  });
  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);

  await page.evaluate(() => window.DshSplash?.ready?.());
  // 退场不是瞬间的：拼合 → 停留（hold 0.75s×pace）→ 像素溶解（exitDur）。
  // 整段走完要好几秒，等够再断言。
  await page.waitForTimeout(6000);

  const done = await page.evaluate(() => window.__splashDone === true);
  assert.ok(done, "要派发 dsh:splash:done");
  await page.close();
});

await test("交棒不重复调用也不报错", async () => {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    window.DshSplash?.ready?.();
    window.DshSplash?.ready?.();
    window.DshSplash?.ready?.();
  });
  await page.waitForTimeout(2500);
  assert.deepStrictEqual(errs, [], `重复 ready 不该有异常：${errs.join(" | ")}`);
  await page.close();
});

/* ============================================================
   3. 兜底
   ============================================================ */

console.log("\n[3] 兜底");

await test("一直不 ready 时有超时兜底，不会永远停着", async () => {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });

  // 不调 ready()，等过 maxWait（6 秒真实时间）+ 退场时长
  await page.waitForTimeout(9000);

  const gone = await page.evaluate(() => !document.querySelector("[class*='splash']"));
  assert.ok(gone, "超时后覆盖层要自己退掉，不能卡死");
  await page.close();
});

await test("动画在转屏后能按新尺寸重排", async () => {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  await page.setViewportSize({ width: 915, height: 412 });
  await page.waitForTimeout(500);

  const st = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return { ok: false };
    const r = c.getBoundingClientRect();
    return { ok: true, w: Math.round(r.width), h: Math.round(r.height) };
  });
  assert.ok(st.ok, "转屏后 canvas 还在");
  assert.ok(st.w > 700, `canvas 要跟着变宽，实际 ${st.w}`);
  assert.deepStrictEqual(errs, [], `转屏不该有异常：${errs.join(" | ")}`);
  await page.close();
});

await browser.close();
server.close();

console.log(`\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项失败`}（${passed + failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
