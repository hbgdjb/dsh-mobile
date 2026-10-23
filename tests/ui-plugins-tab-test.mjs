#!/usr/bin/env node
/* ============================================================
   插件页 —— 两类插件在同一個页面里

   ============ 这个测试守的是什么 ============

   手机上有两套插件：跑在 Node 里的（能提供工具与模型）、跑在页面沙箱里的
   （只能做授权动作）。以前 Node 插件的安装入口藏在「设置」里，
   而「插件」页只有页面内插件 —— 用户打开插件页会以为装不进来。

   现在插件页用分段切换两类。这个测试守两件事：
     1. 分段在、能切；
     2. 切到哪一类就渲染哪一类，不白屏。

   浏览器里没有 Node 运行时，所以 Node 分段会显示「需要手机上的 Node 运行时」——
   这本身也是要守的行为：不能说「没有插件」，那会让人以为装不上。

   用法：node tests/ui-plugins-tab-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

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
  }
}

function findChrome() {
  const list = [
    process.env.CHROME_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  for (const p of list) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

const chrome = findChrome();
let playwright = null;
if (chrome) {
  try {
    playwright = await import("playwright");
  } catch {
    playwright = null;
  }
}

if (!chrome || !playwright) {
  console.log("\n[跳过] 没有可用的 Chromium 或 playwright");
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项，跳过 1 项`);
  process.exit(0);
}

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(String(req.url || "/").split("?")[0]);
    const target = p === "/" ? "/index.html" : p;
    const file = join(ROOT, normalize(target).replace(/^(\.\.[/\\])+/, ""));
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await playwright.chromium.launch({ executablePath: chrome });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.goto(ORIGIN, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

/** 切到插件页。 */
async function openPlugins() {
  await page.evaluate(() => {
    document.querySelector('[data-act="tab"][data-view="plugins"]')?.click();
  });
  await page.waitForTimeout(400);
}

console.log("\n[1] 插件页的两类分段");

await test("默认进 Node 分段，并且不是一句「没有插件」", async () => {
  await openPlugins();
  const info = await page.evaluate(() => ({
    tabs: Array.from(document.querySelectorAll('[data-act="plugins-tab"]')).map((e) => ({
      value: e.dataset.value,
      pressed: e.getAttribute("aria-pressed"),
      text: (e.innerText || "").trim(),
    })),
    body: (document.body.innerText || "").trim(),
  }));
  assert.strictEqual(info.tabs.length, 3, "已安装 / 发现 / 页面内 三段");
  assert.strictEqual(info.tabs[0].value, "node");
  assert.strictEqual(info.tabs[0].pressed, "true", "默认选中已安装");
  assert.ok(/已安装/.test(info.tabs[0].text), "分段文案：" + info.tabs[0].text);
  assert.strictEqual(info.tabs[1].value, "market", "中间是插件市场");
  assert.ok(/发现/.test(info.tabs[1].text));
  // 浏览器里没有 Node 运行时：要说明原因，而不是假装「没有插件」
  assert.ok(
    /需要手机上的 Node 运行时/.test(info.body),
    "浏览器里应说明需要手机环境，实际：" + info.body.slice(0, 200)
  );
  assert.deepStrictEqual(errors, []);
});

await test("切到页面内分段，看到原来的插件列表", async () => {
  await page.evaluate(() => {
    document.querySelector('[data-act="plugins-tab"][data-value="page"]')?.click();
  });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => ({
    pressed: document
      .querySelector('[data-act="plugins-tab"][data-value="page"]')
      ?.getAttribute("aria-pressed"),
    body: (document.body.innerText || "").trim(),
  }));
  assert.strictEqual(info.pressed, "true");
  assert.ok(/已启用/.test(info.body), "页面内分段应显示启用数量");
  assert.ok(/安装页面内插件/.test(info.body), "页面内插件的安装入口要在");
  assert.deepStrictEqual(errors, []);
});

await test("切回 Node 分段仍然正常", async () => {
  await page.evaluate(() => {
    document.querySelector('[data-act="plugins-tab"][data-value="node"]')?.click();
  });
  await page.waitForTimeout(300);
  const body = await page.evaluate(() => (document.body.innerText || "").trim());
  assert.ok(/需要手机上的 Node 运行时|安装 Node 插件/.test(body), "实际：" + body.slice(0, 160));
  assert.deepStrictEqual(errors, []);
});

await browser.close();
server.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
