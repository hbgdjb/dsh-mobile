#!/usr/bin/env node
/* ============================================================
   对话页在「插件模型」下的渲染

   ============ 这个测试守的是什么 ============

   0.41.5 出过一次白屏：用户选中插件提供的模型后，对话界面整个没了。

   根因不是崩溃、不是网络，而是一行渲染代码：

     ui.js renderContextBar
       esc(model.label.replace("DeepSeek-", ""))

   插件模型条目在同步时没有写 `label`。`undefined.replace` 抛 TypeError，
   renderContextBar 抛 → renderChat 抛 → 整页渲染中断，屏幕空白。

   这类错误在纯 Node 测试里看不见（不碰 DOM），在真机上又没有任何报错
   （WebView 控制台用户看不到）。所以必须真的用浏览器渲染一遍。

   ============ 没有浏览器怎么办 ============

   跳过并说明原因，不假装通过。
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let passed = 0;
let failed = 0;
let skipped = 0;

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

/** 找一个能用的 Chromium。 */
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const p of candidates) {
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
  console.log("\n[跳过] 没有可用的 Chromium 或 playwright —— 这一项必须在真浏览器里跑");
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项，跳过 1 项`);
  process.exit(0);
}

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(String(req.url || "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const KEY = "dsh.mobile.state.v1";

/** 把一份 state 塞进浏览器 localStorage，返回打开好的页面。 */
async function openWith(browser, mutate) {
  // 先拿一份默认 state
  const seedCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const seedPage = await seedCtx.newPage();
  await seedPage.goto(ORIGIN, { waitUntil: "networkidle" });
  await seedPage.waitForTimeout(600);
  const entries = await seedPage.evaluate(() =>
    Object.entries(localStorage).map(([name, value]) => ({ name, value }))
  );
  await seedCtx.close();

  const found = entries.find((e) => e.name === KEY);
  assert.ok(found, "页面要写出 state 到 localStorage");

  const st = JSON.parse(found.value);
  st.settings = st.settings || {};
  mutate(st);

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: {
      cookies: [],
      origins: [{ origin: ORIGIN, localStorage: [{ name: KEY, value: JSON.stringify(st) }] }],
    },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

const browser = await playwright.chromium.launch({ executablePath: chrome });

console.log("\n[1] 插件模型（旧条目，没有 label）不能让对话页白掉");

await test("选中插件模型后，输入框与顶栏都在", async () => {
  // 故意不给 label —— 复现 0.41.5 之前同步出来的形状
  const { ctx, page, errors } = await openWith(browser, (st) => {
    st.settings.customModels = [
      {
        id: "node__echo__echo-1",
        name: "回声模型",
        apiModel: "echo-1",
        provider: "node__echo",
        nodeProvider: "echo",
        source: "node-llm",
        ctx: 32000,
      },
    ];
    st.settings.model = "node__echo__echo-1";
  });
  try {
    const info = await page.evaluate(() => ({
      composer: !!document.querySelector(".composer-wrap"),
      meta: !!document.querySelector(".chat__meta"),
      chips: Array.from(document.querySelectorAll(".chat__meta .chip")).map((e) =>
        (e.innerText || "").trim()
      ),
    }));
    assert.ok(info.composer, "输入框要在 —— 没有它就是白屏");
    assert.ok(info.meta, "顶栏要在");
    assert.deepStrictEqual(errors, [], "不能有未捕获错误：" + errors.join(" | "));
  } finally {
    await ctx.close();
  }
});

await test("顶栏那颗 chip 显示的是插件给的模型名", async () => {
  const { ctx, page } = await openWith(browser, (st) => {
    st.settings.customModels = [
      { id: "node__echo__echo-1", name: "回声模型", apiModel: "echo-1", provider: "node__echo", source: "node-llm" },
    ];
    st.settings.model = "node__echo__echo-1";
  });
  try {
    const chips = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".chat__meta .chip")).map((e) => (e.innerText || "").trim())
    );
    assert.ok(
      chips.some((c) => c.includes("回声模型")),
      "应该显示「回声模型」，实际：" + JSON.stringify(chips)
    );
  } finally {
    await ctx.close();
  }
});

await test("点顶栏的模型 chip 打开面板不会崩", async () => {
  const { ctx, page, errors } = await openWith(browser, (st) => {
    st.settings.customModels = [
      { id: "node__echo__echo-1", label: "回声模型", name: "回声模型", apiModel: "echo-1", provider: "node__echo", source: "node-llm" },
    ];
    st.settings.model = "node__echo__echo-1";
  });
  try {
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('[data-act="open-model"]');
      if (!el) return false;
      el.click();
      return true;
    });
    assert.ok(clicked, "顶栏应该有可点的模型 chip");
    await page.waitForTimeout(500);
    const text = await page.evaluate(() => (document.body.innerText || "").trim());
    assert.ok(text.length > 0, "点完之后页面不能是空的");
    assert.deepStrictEqual(errors, [], "开关面板不能抛错：" + errors.join(" | "));
  } finally {
    await ctx.close();
  }
});

await browser.close();
server.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项，跳过 ${skipped} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
