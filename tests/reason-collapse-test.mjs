#!/usr/bin/env node
/* ============================================================
   回复完成后自动收起思考链（0.71.0）

   运行中展开思考与进程是为了让人看得出「没卡住」；但跑完之后那几屏
   文字会把结论和输入框顶得很远，接着打字得先滑半天。用户要求：
   一次回复完成后自动收起，方便操作。

   两条边界必须守住：
     · 只收一次 —— 收完之后用户手动展开回看，不该被下一次重绘又合上；
     · 重跑允许再收 —— 消息重新进入 running 后，下一次结束仍要自动收起。
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
const KEY = "dsh.mobile.state.v1";

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${e?.message || e}`);
  }
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
    const buf = await readFile(join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, "")));
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const chrome = [process.env.CHROME_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
  .filter(Boolean)
  .find((p) => { try { return fs.existsSync(p); } catch { return false; } });
let playwright = null;
if (chrome) { try { playwright = await import("playwright"); } catch { playwright = null; } }
if (!chrome || !playwright) {
  console.log("\n[跳过] 没有 Chromium / playwright，必须在真浏览器里验证");
  server.close();
  process.exit(0);
}

const REASON = "先列目录看看有哪些文件，再挑几个读。";
function makeRunningMessage(id = "m1") {
  return {
    id,
    role: "assistant",
    status: "running",
    ts: Date.now(),
    content: "",
    reasoning: REASON,
    timeline: [
      { type: "reasoning", from: 0, to: null },
      { type: "tool", id: `${id}-t1` },
      { type: "text", from: 0, to: null },
    ],
    tools: [
      { id: `${id}-t1`, name: "fs_list", status: "done", args: { path: "scripts" }, argLabel: "scripts", output: "a.js", ms: 80 },
    ],
  };
}

async function openWithRunning(browser) {
  const seedCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const seedPage = await seedCtx.newPage();
  await seedPage.goto(ORIGIN, { waitUntil: "networkidle" });
  await seedPage.waitForTimeout(700);
  const st = JSON.parse(await seedPage.evaluate((k) => localStorage.getItem(k), KEY));
  await seedCtx.close();

  st.sessions = [
    {
      id: "s1",
      title: "自动收起",
      createdAt: Date.now() - 60000,
      updatedAt: Date.now(),
      mode: st.settings.mode,
      preset: null,
      model: st.settings.model,
      workspace: "默认工作区",
      messages: [{ id: "u1", role: "user", content: "看看文件", ts: Date.now() - 5000 }],
    },
  ];
  st.activeSessionId = "s1";
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: { cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: KEY, value: JSON.stringify(st) }] }] },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await page.waitForTimeout(2200);
  await page.evaluate(async (msg) => {
    const store = await import("/scripts/store.js");
    const ui = await import("/scripts/ui.js");
    const s = store.activeSession();
    if (s) s.messages.push(msg);
    ui.renderAll();
  }, makeRunningMessage());
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}

const view = (page) =>
  page.evaluate(() => {
    const g = document.querySelector(".msg__flow .run-group");
    const r = document.querySelector(".msg__flow .reasoning");
    return {
      group: g?.dataset.open || "",
      reason: r?.dataset.open || "",
      reasonId: r?.querySelector(".reasoning__toggle")?.getAttribute("data-id") || "",
    };
  });

/** 改状态并重绘（等价于 runAgent 的 finally 把 status 落定）。 */
const settle = (page, status) =>
  page.evaluate(async (st) => {
    const store = await import("/scripts/store.js");
    const ui = await import("/scripts/ui.js");
    const s = store.activeSession();
    const m = s?.messages.find((x) => x.role === "assistant");
    if (m) {
      m.status = st;
      m.content = "看完了。";
      m.timeline[m.timeline.length - 1] = { type: "text", from: 0, to: null };
    }
    ui.renderAll();
  }, status);

const browser = await playwright.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });

console.log("\n[1] 运行中：展开，且用户可手动开合");

await test("运行中进程组默认展开，思考段默认折叠", async () => {
  const { ctx, page, errors } = await openWithRunning(browser);
  try {
    const v = await view(page);
    assert.strictEqual(v.group, "true", "运行中要展开，否则看不出是不是卡住");
    assert.strictEqual(v.reason, "false", "思考段默认折叠");
    assert.deepStrictEqual(errors, [], errors.join(" | "));
  } finally {
    await ctx.close();
  }
});

console.log("\n[2] 完成后自动收起");

await test("手动展开组与思考段，回复结束后两者都自动收起", async () => {
  const { ctx, page } = await openWithRunning(browser);
  try {
    // 组：running 默认开 → 点一下关 → 再点一下开（留下用户手动展开的痕迹）
    await page.evaluate(() => document.querySelector(".run-group__head").click());
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector(".run-group__head").click());
    await page.waitForTimeout(200);
    // 思考段：点开
    await page.evaluate(() => document.querySelector(".reasoning__toggle").click());
    await page.waitForTimeout(200);
    const before = await view(page);
    assert.strictEqual(before.group, "true", "前置：组应处于展开");
    assert.strictEqual(before.reason, "true", "前置：思考段应处于展开");
    assert.ok(before.reasonId.startsWith("m1#"), "思考段开关键应带消息 id：" + before.reasonId);

    await settle(page, "done");
    await page.waitForTimeout(350);
    const after = await view(page);
    assert.strictEqual(after.group, "false", "回复完成后进程组要自动收起");
    assert.strictEqual(after.reason, "false", "回复完成后思考链要自动收起");
  } finally {
    await ctx.close();
  }
});

await test("结论仍在组外可见（收起不影响正文）", async () => {
  const { ctx, page } = await openWithRunning(browser);
  try {
    await settle(page, "done");
    await page.waitForTimeout(300);
    const text = await page.evaluate(() => document.querySelector(".msg__flow")?.innerText || "");
    assert.ok(text.includes("看完了"), "结论不该被折进去：" + text.slice(0, 80));
  } finally {
    await ctx.close();
  }
});

console.log("\n[3] 只收一次 / 重跑再收");

await test("收起后用户手动展开，再重绘不会被反复合上", async () => {
  const { ctx, page } = await openWithRunning(browser);
  try {
    await settle(page, "done");
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector(".run-group__head").click());
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector(".reasoning__toggle").click());
    await page.waitForTimeout(200);
    const opened = await view(page);
    assert.strictEqual(opened.group, "true", "用户手动展开组");
    assert.strictEqual(opened.reason, "true", "用户手动展开思考段");

    await page.evaluate(async () => (await import("/scripts/ui.js")).renderAll());
    await page.waitForTimeout(300);
    const kept = await view(page);
    assert.strictEqual(kept.group, "true", "不该被反复自动收起");
    assert.strictEqual(kept.reason, "true", "思考段不该被反复自动收起");
  } finally {
    await ctx.close();
  }
});

await test("消息重跑（再进 running 再结束）会再自动收起一次", async () => {
  const { ctx, page } = await openWithRunning(browser);
  try {
    await settle(page, "done");
    await page.waitForTimeout(250);
    await page.evaluate(() => document.querySelector(".run-group__head").click());
    await page.waitForTimeout(150);
    assert.strictEqual((await view(page)).group, "true", "前置：手动展开");

    await settle(page, "running");
    await page.waitForTimeout(200);
    await settle(page, "done");
    await page.waitForTimeout(300);
    assert.strictEqual((await view(page)).group, "false", "重跑结束后应再次自动收起");
  } finally {
    await ctx.close();
  }
});

console.log("\n[4] 源码契约");

const src = await readFile(join(ROOT, "scripts/ui.js"), "utf8");
await test("updateMessages 里挂了完成收口", () => {
  assert.ok(src.includes("if (s) collapseFinishedReasoning(s);"), "没在 updateMessages 里调用");
});
await test("收口会清 flowOpen 与按消息前缀的 reasoningOpen", () => {
  assert.ok(src.includes("flowOpen.delete(m.id)"), "没清进程组展开态");
  assert.ok(src.includes("k.indexOf(`${m.id}#`) === 0"), "没按消息前缀清思考段");
});
await test("用 collapsedOnFinish 保证只收一次，running 时撤标记", () => {
  assert.ok(src.includes("collapsedOnFinish.delete(m.id)"), "重跑时没撤标记");
  assert.ok(src.includes("if (collapsedOnFinish.has(m.id)) continue;"), "没有只收一次的判据");
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
