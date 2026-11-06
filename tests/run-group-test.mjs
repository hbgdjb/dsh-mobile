#!/usr/bin/env node
/* ============================================================
   「N 步进程」折叠组 + 子任务卡

   ============ 这个测试守的是什么 ============

   0.66.0 把思考与工具卡片收进一个可折叠的组里，并把
   spawn_subagent 从"像 shell 命令的工具卡"改成"子任务卡"。
   这两件事都只能靠真浏览器验证，因为全部落在 DOM 上：

     1. 运行中必须自动展开 —— 收起来了用户就判断不出它是不是卡住。
     2. 有待审批的调用时必须强制展开 —— 折进去用户找不到该点哪里。
     3. 用户手动开合过，结束后要保持用户的选择，而不是被自动收起覆盖。
     4. 子任务卡的序号要按发生顺序稳定递增，展开是结论不是 JSON 参数。

   ============ 没有浏览器怎么办 ============
   跳过并说明原因，不假装通过。
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
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  return list.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
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
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

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
  server.close();
  process.exit(0);
}

const KEY = "dsh.mobile.state.v1";

const REASON = "先看看目录里有什么，再决定读哪几个文件。";

/** 一条带时间线的助手消息；status 决定它是不是"运行中"。 */
function makeMessage({ id = "m1", status = "done", waiting = false } = {}) {
  const tools = [
    { id: `${id}-t1`, name: "fs_list", status: "done", args: { path: "scripts" }, argLabel: "scripts", output: "a.js", ms: 90 },
    { id: `${id}-t2`, name: "fs_read", status: "done", args: { path: "a.js" }, argLabel: "a.js", output: "// x", ms: 120 },
    {
      id: `${id}-t3`,
      name: "spawn_subagent",
      status: waiting ? "waiting" : "done",
      args: { task: "探索模型管理与模型选取面板的实现，找出格式下拉落在哪个函数" },
      argLabel: "探索模型管理与模型选取面板的实现",
      output: waiting ? "" : "模型面板在 modelParamsSheet，探测状态机是 cmProbe。",
      ms: 8200,
    },
    {
      id: `${id}-t4`,
      name: "spawn_subagent",
      status: "done",
      args: { task: "梳理 LLM 请求链路" },
      argLabel: "梳理 LLM 请求链路",
      output: "从 sendMessage 到 chatAttempt，中间还有一轮工具回灌。",
      ms: 6100,
    },
  ];
  return {
    id,
    role: "assistant",
    status,
    ts: Date.now(),
    content: "看完了，结论如下。",
    reasoning: REASON,
    timeline: [
      { type: "reasoning", from: 0, to: REASON.length },
      { type: "tool", id: `${id}-t1` },
      { type: "tool", id: `${id}-t2` },
      { type: "tool", id: `${id}-t3` },
      { type: "tool", id: `${id}-t4` },
      { type: "text", from: 0, to: null },
    ],
    tools,
  };
}

async function openWith(browser, message) {
  const seedCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const seedPage = await seedCtx.newPage();
  await seedPage.goto(ORIGIN, { waitUntil: "networkidle" });
  await seedPage.waitForTimeout(700);
  const st = JSON.parse(await seedPage.evaluate((k) => localStorage.getItem(k), KEY));
  await seedCtx.close();

  // 只放用户消息：助手消息开机后再注入。
  // 开机时若发现「有 running 消息但没有活的 run」，会把状态收成中断 ——
  // 那正好把我们要测的 running / waiting 抹掉。
  st.sessions = [
    {
      id: "s1",
      title: "折叠组",
      createdAt: Date.now() - 60000,
      updatedAt: Date.now(),
      mode: st.settings.mode,
      preset: null,
      model: st.settings.model,
      workspace: "默认工作区",
      messages: [{ id: "u1", role: "user", content: "看看这几个文件", ts: Date.now() - 5000 }],
    },
  ];
  st.activeSessionId = "s1";

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: { cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: KEY, value: JSON.stringify(st) }] }] },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await page.waitForTimeout(2600);
  await page.evaluate(async (msg) => {
    const store = await import("/scripts/store.js");
    const ui = await import("/scripts/ui.js");
    const s = store.activeSession();
    if (s) s.messages.push(msg);
    ui.renderAll();
  }, message);
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}

const groupState = (page, id) =>
  page.evaluate((mid) => {
    const el = document.querySelector(`.msg--assistant[data-msg="${mid}"] .msg__flow .run-group`);
    if (!el) return null;
    const body = el.querySelector(":scope > .run-group__body");
    return {
      open: el.dataset.open,
      wait: el.dataset.wait,
      title: (el.querySelector(".run-group__title")?.textContent || "").trim(),
      meta: (el.querySelector(".run-group__meta")?.textContent || "").trim(),
      bodyVisible: body ? getComputedStyle(body).display !== "none" : false,
      steps: body ? body.children.length : 0,
      kinds: body ? [...body.children].map((c) => (c.classList.contains("tool") ? "tool" : "reasoning")) : [],
    };
  }, id);

const browser = await playwright.chromium.launch({ executablePath: chrome });

console.log("\n[1] 结束后自动收起，组头写清几步");

await test("已完成的消息：组收起，头写「5 步进程 / 4 次工具调用」", async () => {
  const { ctx, page, errors } = await openWith(browser, makeMessage({ id: "done1" }));
  try {
    const g = await groupState(page, "done1");
    assert.ok(g, "要有折叠组");
    assert.strictEqual(g.open, "false", "结束后应自动收起");
    assert.strictEqual(g.bodyVisible, false, "收起时步骤不可见");
    assert.ok(g.title.includes("5 步"), "标题要带步数（1 段思考 + 4 个工具）：" + g.title);
    assert.ok(g.meta.includes("4 次工具调用"), "副信息要带工具次数：" + g.meta);
    assert.strictEqual(g.steps, 5, "组里应有 5 个步骤，实际：" + g.steps);
    // 结论不能被折进去
    const body = await page.evaluate(
      (mid) => document.querySelector(`.msg--assistant[data-msg="${mid}"] .msg__flow .msg__body--seg`)?.textContent || "",
      "done1"
    );
    assert.ok(body.includes("看完了"), "结论要留在组外：" + body);
    assert.deepStrictEqual(errors, [], "不能有未捕获错误：" + errors.join(" | "));
  } finally {
    await ctx.close();
  }
});

console.log("\n[2] 手动开合");

await test("点组头展开，再点收起", async () => {
  const { ctx, page } = await openWith(browser, makeMessage({ id: "done2" }));
  try {
    await page.evaluate(() => document.querySelector(".msg__flow .run-group__head").click());
    await page.waitForTimeout(350);
    const open = await groupState(page, "done2");
    assert.strictEqual(open.open, "true", "点一下要展开");
    assert.strictEqual(open.bodyVisible, true, "展开后步骤可见");

    await page.evaluate(() => document.querySelector(".msg__flow .run-group__head").click());
    await page.waitForTimeout(350);
    const closed = await groupState(page, "done2");
    assert.strictEqual(closed.open, "false", "再点一下要收起");
  } finally {
    await ctx.close();
  }
});

console.log("\n[3] 运行中自动展开");

await test("还在跑的消息：组默认展开，头写「进行中」", async () => {
  const { ctx, page } = await openWith(browser, makeMessage({ id: "run1", status: "running" }));
  try {
    const g = await groupState(page, "run1");
    assert.strictEqual(g.open, "true", "运行中要展开，否则看不出是不是卡住");
    assert.ok(g.meta.includes("进行中"), "副信息要写进行中：" + g.meta);
  } finally {
    await ctx.close();
  }
});

console.log("\n[4] 待审批时强制展开");

await test("有调用在等审批：组强制展开，点收起不生效", async () => {
  const { ctx, page } = await openWith(browser, makeMessage({ id: "wait1", waiting: true }));
  try {
    const g = await groupState(page, "wait1");
    assert.strictEqual(g.open, "true", "有待审批必须展开");
    assert.strictEqual(g.wait, "true", "要有待处理标记");
    assert.ok(g.title.includes("待处理"), "标题要写待处理：" + g.title);

    await page.evaluate(() => document.querySelector(".msg__flow .run-group__head").click());
    await page.waitForTimeout(350);
    const after = await groupState(page, "wait1");
    assert.strictEqual(after.open, "true", "有审批在等时不能收起");
    const toast = await page.evaluate(() => document.querySelector(".toast")?.textContent || "");
    assert.ok(toast.includes("审批"), "点收起要给出原因，实际：" + toast);
  } finally {
    await ctx.close();
  }
});

console.log("\n[5] 子任务卡");

await test("标题是「子任务 1 / 子任务 2」，不是 spawn_subagent", async () => {
  const { ctx, page } = await openWith(browser, makeMessage({ id: "task1" }));
  try {
    await page.evaluate(() => document.querySelector(".msg__flow .run-group__head").click());
    await page.waitForTimeout(400);
    const heads = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".msg__flow .tool--task .tool__name")).map((e) => (e.textContent || "").trim())
    );
    assert.deepStrictEqual(heads, ["子任务 1", "子任务 2"], "实际：" + JSON.stringify(heads));
    const raw = await page.evaluate(() => (document.querySelector(".msg__flow")?.innerText || "").includes("spawn_subagent"));
    assert.strictEqual(raw, false, "不该把内部工具名暴露给用户");
  } finally {
    await ctx.close();
  }
});

await test("展开子任务卡：给任务与结论，不给 JSON 参数", async () => {
  const { ctx, page } = await openWith(browser, makeMessage({ id: "task2" }));
  try {
    await page.evaluate(() => document.querySelector(".msg__flow .run-group__head").click());
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector(".msg__flow .tool--task .tool__head").click());
    await page.waitForTimeout(350);
    const card = await page.evaluate(() => {
      const el = document.querySelector(".msg__flow .tool--task");
      return {
        open: el.dataset.open,
        text: (el.innerText || "").trim(),
        labels: Array.from(el.querySelectorAll(".tool__label")).map((e) => (e.textContent || "").trim()),
        code: el.querySelectorAll(".tool__code").length,
      };
    });
    assert.strictEqual(card.open, "true", "点开要展开");
    assert.ok(card.labels.includes("任务"), "要有任务段：" + JSON.stringify(card.labels));
    assert.ok(card.labels.includes("结论"), "要有结论段：" + JSON.stringify(card.labels));
    assert.ok(card.text.includes("探索模型管理"), "任务全文要在：" + card.text.slice(0, 60));
    assert.ok(card.text.includes("modelParamsSheet"), "结论要在：" + card.text.slice(0, 120));
    assert.strictEqual(card.code, 0, "不该再出现 JSON 参数块");
    assert.ok(!card.text.includes("调用参数"), "不该有「调用参数」：" + card.text);
  } finally {
    await ctx.close();
  }
});

await test("普通工具卡没被顺手改坏", async () => {
  const { ctx, page } = await openWith(browser, makeMessage({ id: "task3" }));
  try {
    await page.evaluate(() => document.querySelector(".msg__flow .run-group__head").click());
    await page.waitForTimeout(400);
    const plain = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".msg__flow .tool:not(.tool--task) .tool__name")).map((e) => (e.textContent || "").trim())
    );
    assert.deepStrictEqual(plain, ["fs_list", "fs_read"], "普通工具仍显示工具名：" + JSON.stringify(plain));
  } finally {
    await ctx.close();
  }
});

await browser.close();
server.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
