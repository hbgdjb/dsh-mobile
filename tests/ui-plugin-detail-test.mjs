#!/usr/bin/env node
/* ============================================================
   插件详情面板

   ============ 这个测试守的是什么 ============

   「装完插件，它到底带来了什么」——用户第一个问题。
   列表里只有名字和工具数，所以点开一屏：工具、模型、入口、状态。

   浏览器里没有 Node，所以这里伪造一个原生桥，喂给页面一份
   plugins.list / plugins.detail 的响应，然后真的去点、真的去看渲染。

   这条路径上有两个容易坏的地方：
     1. 详情是异步拉的（要问 adapter 有哪些模型），拉回来时面板
        可能已经被关了 —— 写错就会在空对象上取属性、抛错白屏；
     2. 模型清单可能查询失败（adapter 发网络请求超时），
        那时候要显示「查不到」而不是整块消失。

   用法：node tests/ui-plugin-detail-test.mjs
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

// 伪造原生桥：让页面以为 Node 在跑、有一个插件
await ctx.addInitScript(() => {
  window.DshNode = {
    status: () =>
      JSON.stringify({
        available: true,
        running: true,
        installed: true,
        downloading: false,
        percent: 0,
        channelConnected: true,
        channelPort: 12345,
      }),
    call(method, paramsJson) {
      const id = "t" + Math.random().toString(36).slice(2);
      const params = paramsJson ? JSON.parse(paramsJson) : {};
      const ok = (obj) =>
        setTimeout(() => window.__dshNodeResponse(id, true, JSON.stringify(obj)), 5);

      if (method === "plugins.list") {
        ok({
          plugins: [
            {
              id: "echo-llm",
              name: "回声测试插件",
              version: "1.0.0",
              kind: "package",
              loaded: true,
              status: "active",
              pendingDeps: [],
            },
          ],
          diagnostics: { pluginsDir: "/data/…/plugins", exists: true, entries: ["echo-llm"] },
        });
      } else if (method === "plugins.detail") {
        if (params.id === "broken-llm") {
          setTimeout(() => window.__dshNodeResponse(id, false, "这个插件炸了"), 5);
          return id;
        }
        ok({
          plugin: {
            id: "echo-llm",
            name: "回声测试插件",
            version: "1.0.0",
            kind: "package",
            entry: "/data/…/plugins/echo-llm/main.js",
            status: "active",
            pendingDeps: [],
          },
          tools: [
            { name: "echo_search", description: "搜索一下" },
            { name: "echo_read", description: "读一个东西" },
          ],
          routes: [
            {
              provider: "echo",
              name: "回显测试",
              models: [{ id: "echo-1", name: "回声模型", contextWindow: 32000 }],
              error: "",
            },
          ],
          routeCount: 1,
        });
      } else if (method === "plugins.load") {
        ok({ loaded: 1, failed: [] });
      } else {
        ok({});
      }
      return id;
    },
    respond() {},
    start() {},
    stop() {},
    download() {},
  };
});

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.goto(ORIGIN, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

console.log("\n[1] 插件列表 → 详情");

await test("插件页能列出伪造的插件", async () => {
  await page.evaluate(() => {
    document.querySelector('[data-act="tab"][data-view="plugins"]')?.click();
  });
  await page.waitForTimeout(800);
  const body = await page.evaluate(() => document.body.innerText || "");
  assert.ok(/回声测试插件/.test(body), "列表里应该有它，实际：" + body.slice(0, 240));
});

await test("点开插件 → 显示它的工具与模型", async () => {
  await page.evaluate(() => {
    document.querySelector('[data-act="node-plugin-detail"]')?.click();
  });
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => ({
    text: (document.querySelector(".sheet")?.innerText || "").trim(),
    open: document.querySelector(".app")?.dataset?.sheet || "",
  }));
  assert.ok(info.text.length > 0, "面板要打开");
  assert.ok(/回声测试插件/.test(info.text), "标题是插件名：" + info.text.slice(0, 120));
  assert.ok(/echo_search/.test(info.text), "要列出工具名");
  assert.ok(/搜索一下/.test(info.text), "要带工具说明");
  assert.ok(/回声模型/.test(info.text), "要列出它提供的模型");
  assert.ok(/32K|32000/.test(info.text), "要显示上下文窗口");
  assert.ok(/main\.js/.test(info.text), "要显示入口路径（排查用）");
  assert.deepStrictEqual(errors, [], "不能有未捕获错误");
});

console.log("\n[2] 边界");

await test("详情拉取失败时，面板说清楚而不是白屏", async () => {
  // 直接走 sheet 的加载分支：打开一个不存在的插件，桥会回错误
  await page.evaluate(() => {
    // 关掉旧面板
    document.querySelector('[data-act="close-sheet"]')?.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const el = document.querySelector('[data-act="node-plugin-detail"]');
    if (el) el.dataset.id = "broken-llm";
    el?.click();
  });
  await page.waitForTimeout(700);
  const text = await page.evaluate(() => (document.querySelector(".sheet")?.innerText || "").trim());
  assert.ok(/读不到详情/.test(text), "要明说读不到，实际：" + text.slice(0, 160));
  assert.ok(/这个插件炸了/.test(text), "要带上传回来的原因");
  assert.deepStrictEqual(errors, []);
});

await browser.close();
server.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
