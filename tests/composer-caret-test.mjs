#!/usr/bin/env node
/* ============================================================
   输入框焦点 / 光标跨重绘（0.71.0）

   ============ 用户看到的两个故障 ============

     ① 「写的字还是要点一下才输到对话框内」
     ② 「无法在已输入对话框的字的前面打字，会自动延继到句子末尾」

   实测诊断（_diag-input）：正常打字 / 组合输入 / 400ms 轮询下光标都稳，
   但只要 renderChat 整块重建输入框，焦点立刻丢、光标跳到末尾。
   旧代码用 `el.value = ui.draft` 回填草稿，在 Android WebView 里还会让
   InputConnection(Editable) 与 DOM 值失步，之后输入法只能往句末追加。

   这里守的是：重绘前后必须是同一个 textarea 节点，焦点/选区/组合文字
   全部原样保留；程序写入（@ 引用、语音）要插在光标处而不是拼到句末。
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const body = await readFile(join(ROOT, decodeURIComponent(url.pathname)));
    res.writeHead(200, { "content-type": MIME[extname(url.pathname)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

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

const browser = await playwright.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

/** 触发一次整页重建（等价于切换会话 / 插件安装 / 回到对话页）。 */
const rebuild = () =>
  page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    st.emit({ type: "plugin:install" });
  });

const snap = () =>
  page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    return {
      value: el?.value || "",
      start: el?.selectionStart,
      end: el?.selectionEnd,
      focused: document.activeElement === el,
      same: window.__savedInput === el,
      placeholder: el?.placeholder || "",
    };
  });

const seed = (value, caret) =>
  page.evaluate(({ value, caret }) => {
    const el = document.querySelector("#composer-input");
    window.__savedInput = el;
    el.value = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    el.focus();
    el.setSelectionRange(caret, caret);
  }, { value, caret });

console.log("\n[1] 整页重绘：焦点与光标不能丢");

await test("重绘前后是同一个 textarea 节点", async () => {
  await seed("abcdef", 3);
  await rebuild();
  await page.waitForTimeout(60);
  const s = await snap();
  assert.strictEqual(s.same, true, "节点被换掉了 —— 输入法连接会断");
});

await test("重绘后焦点仍在输入框（不需要「点一下」才能打字）", async () => {
  await seed("abcdef", 3);
  await rebuild();
  await page.waitForTimeout(60);
  const s = await snap();
  assert.strictEqual(s.focused, true, "焦点丢了");
});

await test("重绘后光标停在原来的位置，不跳句末", async () => {
  await seed("abcdef", 3);
  await rebuild();
  await page.waitForTimeout(60);
  const s = await snap();
  assert.strictEqual(s.value, "abcdef");
  assert.strictEqual(s.start, 3, `光标应在 3，实际 ${s.start}`);
  assert.strictEqual(s.end, 3);
});

await test("重绘后在句子前面打字，字落在光标处而不是句末", async () => {
  await seed("abcdef", 3);
  await rebuild();
  await page.waitForTimeout(60);
  await page.keyboard.type("X");
  await page.waitForTimeout(60);
  const s = await snap();
  assert.strictEqual(s.value, "abcXdef", `实际：${s.value}`);
  assert.strictEqual(s.start, 4);
});

await test("组合输入中重绘：拼音原文不丢，焦点仍在", async () => {
  await page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    window.__savedInput = el;
    el.value = "abc";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    el.focus();
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    el.value = "abc拼音";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "拼音" }));
  });
  await rebuild();
  await page.waitForTimeout(60);
  const s = await snap();
  assert.strictEqual(s.value, "abc拼音", "组合中的文字丢了");
  assert.strictEqual(s.focused, true, "组合输入被重绘打断（焦点丢失）");
});

console.log("\n[2] 程序写入要插在光标处");

await test("@ 引用文件插到光标处，不是拼到句末", async () => {
  await seed("abcdef", 3);
  const inserted = await page.evaluate(() => {
    const b = document.createElement("button");
    b.dataset.act = "mention-file";
    b.dataset.path = "a.txt";
    document.querySelector("#app").appendChild(b);
    b.click();
    b.remove();
    const el = document.querySelector("#composer-input");
    return { value: el.value, start: el.selectionStart };
  });
  assert.strictEqual(inserted.value, "abc@a.txt def", `实际：${inserted.value}`);
  assert.strictEqual(inserted.start, 3 + "@a.txt ".length, "光标应落在插入内容之后");
});

await test("setComposerValue 保留光标（同值不重写 value）", async () => {
  await seed("abcdef", 3);
  const r = await page.evaluate(async () => {
    const el = document.querySelector("#composer-input");
    let writes = 0;
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    Object.defineProperty(el, "value", {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { writes += 1; desc.set.call(this, v); },
    });
    // 借「填入预设提示词」这条真实路径触发 setComposerValue
    const b = document.createElement("button");
    b.dataset.act = "quick";
    b.dataset.prompt = "abcdef";
    document.querySelector("#app").appendChild(b);
    b.click();
    b.remove();
    return { writes, start: el.selectionStart, value: el.value };
  });
  assert.strictEqual(r.value, "abcdef");
  assert.strictEqual(r.writes, 0, `值相同不应该重写 value，实际写了 ${r.writes} 次`);
  assert.strictEqual(r.start, 3, "光标不该被推到末尾");
});

console.log("\n[3] 源码契约：少打断输入法");

const src = await readFile(join(ROOT, "scripts/ui.js"), "utf8");

await test("renderChat 复用 textarea 节点", () => {
  assert.ok(src.includes("fresh.replaceWith(stash.node)"), "没有复用节点");
  assert.ok(src.includes("prevInput.remove()"), "重绘前没有摘出旧节点");
});

await test("复用节点时不再回填 value", () => {
  assert.ok(src.includes("if (!stash) restoreDraft()"), "仍在无条件 restoreDraft");
});

await test("草稿保存不再排除运行中（引导打字也不丢）", () => {
  // 比注释更精确：只盯那行实际的条件判断，别被说明文字里的字样误伤
  assert.ok(
    !src.includes('if (prevInput && typeof prevInput.value === "string" && !ui.run)'),
    "renderChat 里还有 !ui.run 限制"
  );
  assert.ok(
    src.includes('if (prevInput && typeof prevInput.value === "string") {'),
    "草稿保存条件不对"
  );
});

await test("组合期间轮询不再改高度", () => {
  assert.ok(src.includes("if (!isComposingNow()) growIfChanged()"), "轮询仍在组合期改高度");
});

await test("placeholder 只在变化时写", () => {
  assert.ok(src.includes("if (input.placeholder !== ph) input.placeholder = ph"), "仍在无条件写 placeholder");
});

await test("没有未捕获的页面错误", () => {
  assert.deepStrictEqual(errors, [], errors.join(" | "));
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
