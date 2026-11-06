#!/usr/bin/env node
/* ============================================================
   「添加模型」面板：格式下拉 / 端点预览 / 自动探测 / 多选批量

   ============ 这个测试守的是什么 ============

   0.66.0 把模型接入从「只有 OpenAI 兼容」扩成四种协议，
   探测也从「点按钮拉一次」改成「填了就自己探」。这两件事
   都会在真机上出问题、而且只在真机上出问题：

     1. 探测是异步的，用户连着改两次端点 —— 先发后到的旧结果
        会把新结果盖掉。状态机用 seq + AbortController 挡，
        但只有真的跑一遍才验证得出来。
     2. 格式下拉与「图片输入」「推理强度」两个开关是联动的，
        置灰逻辑写在 DOM 上（disabled + aria-checked），
        纯 Node 测不到。
     3. 批量加入要一次写多条，写入形状错了（少 format、少
        providerKey）要等用户真发消息才会炸。

   所以这里用真浏览器 + 本地假上游跑一遍：四种格式各探一次，
   勾两个模型加入，回到 localStorage 里核对落库形状。

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

/* ---------------- 本地假上游 ----------------
   为什么要同源：跨域 GET 带 x-api-key 会先发预检，Playwright 的
   route 拦截要额外补 OPTIONS 与 CORS 头，测的就不是被测代码了。
   直接让测试自己的静态服务器兼任假上游，零跨域噪音。 */

const HITS = [];

async function serveMock(req, res) {
  const url = String(req.url || "");
  const p = url.split("?")[0];
  HITS.push(p);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "POST") {
    // 加入模型后会自动验活一次，给一个 OpenAI 形状的成功响应
    if (/\/chat\/completions$/.test(p)) {
      return json(200, {
        choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    return json(200, { ok: true });
  }

  if (p === "/mock/v1/models") {
    return json(200, {
      object: "list",
      data: [{ id: "gpt-alpha" }, { id: "gpt-beta" }, { id: "gpt-gamma" }],
    });
  }
  if (p === "/mock/anth/v1/models") {
    return json(200, {
      data: [
        { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" },
        { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
      ],
      has_more: false,
    });
  }
  if (p === "/mock/gem/v1beta/models") {
    return json(200, {
      models: [
        { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      ],
    });
  }
  if (p === "/mock/oll/api/tags") {
    return json(200, { models: [{ name: "llama3.2:3b" }, { name: "qwen2.5:7b" }] });
  }
  if (p === "/mock/fail/v1/models") {
    return json(500, { error: { message: "upstream boom" } });
  }
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const handled = await serveMock(req, res);
    if (handled !== null || res.writableEnded) return;
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

/** 空模型状态起步：这样顶栏 → 运行模式 → 「模型」走的是「添加模型」那条路。 */
async function openEmptyModelState(browser) {
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
  st.settings.customModels = [];
  st.settings.model = null;
  st.settings.keys = {};

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
  await page.waitForTimeout(1000);
  return { ctx, page, errors };
}

/** 顶栏胶囊 → 运行模式 → 模型 → 添加模型。 */
async function openModelForm(page) {
  await page.click(".appbar__pill");
  await page.waitForTimeout(350);
  const opened = await page.evaluate(() => {
    const el = document.querySelector('#sheet-layer [data-act="open-models"], #sheet-layer [data-act="open-model"]');
    if (!el) return false;
    el.click();
    return true;
  });
  assert.ok(opened, "运行模式面板里要有「模型」入口");
  await page.waitForTimeout(400);
  const added = await page.evaluate(() => {
    const el = document.querySelector('#sheet-layer [data-act="new-custom-model"]');
    if (!el) return false;
    el.click();
    return true;
  });
  assert.ok(added, "模型管理里要有「添加模型」");
  await page.waitForTimeout(450);
  const has = await page.evaluate(() => !!document.querySelector("#cm-format"));
  assert.ok(has, "添加模型面板里要有接口格式下拉");
}

/** 直接改 value 并派发事件：模拟用户输入，绕开 fill 对 type=password 的处理。 */
async function typeInto(page, selector, value, evt = "input") {
  await page.evaluate(
    ({ selector, value, evt }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error("找不到 " + selector);
      el.value = value;
      el.dispatchEvent(new Event(evt, { bubbles: true }));
    },
    { selector, value, evt }
  );
}

async function setSelect(page, selector, value) {
  await page.evaluate(
    ({ selector, value }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error("找不到 " + selector);
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { selector, value }
  );
}

const readModels = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("dsh.mobile.state.v1") || "{}").settings?.customModels || [];
    } catch {
      return [];
    }
  });

const rowsOf = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#cm-models .cm-model-row")).map((r) => {
      const i = r.querySelector("[data-cm-pick]");
      return { id: i ? i.value : "", disabled: !!(i && i.disabled), cls: r.className };
    })
  );

const browser = await playwright.chromium.launch({ executablePath: chrome });

console.log("\n[1] 面板结构：四种格式都在，端点预览不是空话");

await test("格式下拉列出 OpenAI / Anthropic / Gemini / Ollama 四种", async () => {
  const { ctx, page, errors } = await openEmptyModelState(browser);
  try {
    await openModelForm(page);
    const opts = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#cm-format option")).map((o) => ({
        v: o.value,
        t: (o.innerText || "").trim(),
      }))
    );
    assert.deepStrictEqual(opts.map((o) => o.v), ["openai", "anthropic", "gemini", "ollama"]);
    opts.forEach((o) => assert.ok(o.t.length > 0, `${o.v} 要有中文标签`));
    assert.deepStrictEqual(errors, [], "面板不能抛错：" + errors.join(" | "));
  } finally {
    await ctx.close();
  }
});

await test("端点预览会写出「实际请求」的真实地址", async () => {
  const { ctx, page } = await openEmptyModelState(browser);
  try {
    await openModelForm(page);
    await typeInto(page, "#cm-base", `${ORIGIN}/mock/v1`);
    // 展示时 safeUrl 会把 scheme 省掉，只留 host+path —— 这里按这个形状比
    const hostPath = `${ORIGIN}/mock/v1/chat/completions`.replace(/^https?:\/\//, "");
    const t = await page.evaluate(() => document.querySelector("#cm-endpoint-preview")?.innerHTML || "");
    assert.ok(t.includes(hostPath), "实际：" + t);

    // 换格式后同一份 base 要推算出不同地址
    await setSelect(page, "#cm-format", "anthropic");
    const t2 = await page.evaluate(() => document.querySelector("#cm-endpoint-preview")?.innerHTML || "");
    assert.ok(t2.includes("/messages"), "Anthropic 应该打到 /messages，实际：" + t2);
    assert.ok(!t2.includes("/chat/completions"), "不该还留着 OpenAI 的路径：" + t2);
  } finally {
    await ctx.close();
  }
});

console.log("\n[2] 格式与开关联动：非 OpenAI 格式要置灰");

await test("选 Anthropic 后，图片与推理强度两个开关都禁用", async () => {
  const { ctx, page } = await openEmptyModelState(browser);
  try {
    await openModelForm(page);
    await setSelect(page, "#cm-format", "anthropic");
    const g = await page.evaluate(() => {
      const one = (k) => {
        const row = document.querySelector(`[data-gate="${k}"]`);
        const sw = row?.querySelector(".switch");
        return {
          disabled: !!(sw && sw.disabled),
          checked: sw?.getAttribute("aria-checked"),
          sub: (row?.querySelector(".settings__row-sub")?.textContent || "").trim(),
          off: row?.classList.contains("is-disabled"),
        };
      };
      return { effort: one("effort"), vision: one("vision"), hint: (document.querySelector("#cm-format-hint")?.textContent || "").trim() };
    });
    assert.ok(g.vision.disabled, "图片输入要禁用");
    assert.ok(g.effort.disabled, "推理强度要禁用");
    assert.strictEqual(g.vision.checked, "false", "禁用时 aria 要落到 false");
    assert.ok(g.vision.sub.includes("仅 OpenAI"), "要说明为什么不能用，实际：" + g.vision.sub);
    assert.ok(g.effort.sub.includes("仅 OpenAI"), "实际：" + g.effort.sub);
    assert.ok(g.vision.off, "整行要有置灰的类名");
    assert.ok(g.hint.length > 0, "格式说明不能空");
  } finally {
    await ctx.close();
  }
});

await test("切回 OpenAI，两个开关恢复可用", async () => {
  const { ctx, page } = await openEmptyModelState(browser);
  try {
    await openModelForm(page);
    await setSelect(page, "#cm-format", "gemini");
    await setSelect(page, "#cm-format", "openai");
    const on = await page.evaluate(() => {
      const sw = document.querySelector('[data-gate="vision"] .switch');
      return { disabled: sw.disabled, sub: (document.querySelector('[data-gate="vision"] .settings__row-sub')?.textContent || "").trim() };
    });
    assert.strictEqual(on.disabled, false, "OpenAI 下要能开");
    assert.ok(on.sub.includes("image_url"), "要回到 OpenAI 的说明，实际：" + on.sub);
  } finally {
    await ctx.close();
  }
});

console.log("\n[3] 填了端点与 Key 就自己探测");

await test("填 Key 后自动列出模型，并标出协议", async () => {
  const { ctx, page, errors } = await openEmptyModelState(browser);
  try {
    await openModelForm(page);
    await typeInto(page, "#cm-base", `${ORIGIN}/mock/v1`);
    await typeInto(page, "#cm-key", "sk-test-123", "change");
    await page.waitForTimeout(900);
    const rows = await rowsOf(page);
    assert.deepStrictEqual(rows.map((r) => r.id), ["gpt-alpha", "gpt-beta", "gpt-gamma"]);
    const meta = await page.evaluate(() => (document.querySelector("#cm-models .cm-probe__meta")?.textContent || "").trim());
    assert.ok(meta.includes("/mock/v1/models"), "要写明探的是哪个地址，实际：" + meta);
    assert.deepStrictEqual(errors, [], "不能有未捕获错误：" + errors.join(" | "));
  } finally {
    await ctx.close();
  }
});

await test("Anthropic 格式走 /v1/models 且认 display_name", async () => {
  const { ctx, page } = await openEmptyModelState(browser);
  try {
    await openModelForm(page);
    await setSelect(page, "#cm-format", "anthropic");
    await typeInto(page, "#cm-base", `${ORIGIN}/mock/anth`);
    await typeInto(page, "#cm-key", "sk-ant-1", "change");
    await page.waitForTimeout(900);
    const rows = await rowsOf(page);
    assert.deepStrictEqual(rows.map((r) => r.id), ["claude-sonnet-4-5", "claude-haiku-4-5"]);
    const text = await page.evaluate(() => (document.querySelector("#cm-models")?.innerText || ""));
    assert.ok(text.includes("Claude Sonnet 4.5"), "要显示 display_name：" + text);
  } finally {
    await ctx.close();
  }
});

await test("Gemini 剥掉 models/ 前缀，并滤掉不能对话的模型", async () => {
  const { ctx, page } = await openEmptyModelState(browser);
  try {
    await openModelForm(page);
    await setSelect(page, "#cm-format", "gemini");
    await typeInto(page, "#cm-base", `${ORIGIN}/mock/gem`);
    await typeInto(page, "#cm-key", "AIza-test", "change");
    await page.waitForTimeout(900);
    const rows = await rowsOf(page);
    assert.deepStrictEqual(rows.map((r) => r.id), ["gemini-2.5-pro"]);
    assert.ok(
      HITS.some((h) => h.startsWith("/mock/gem/v1beta/models")),
      "要打 /v1beta/models，实际打过：" + JSON.stringify(HITS.slice(-4))
    );
  } finally {
    await ctx.close();
  }
});

await test("Ollama 原生走 /api/tags，不填 Key 也能探", async () => {
  const { ctx, page } = await openEmptyModelState(browser);
  try {
    await openModelForm(page);
    // 选「Ollama（原生）」预设：它是本地的，没有 Key 也该自己去问
    await setSelect(page, "#cm-provider", "ollamaNative");
    await page.waitForTimeout(200);
    await typeInto(page, "#cm-base", `${ORIGIN}/mock/oll`);
    // 本地服务不校验 Key：只改端点、不填 Key 就该自己探
    await page.waitForTimeout(1400);
    const rows = await rowsOf(page);
    assert.deepStrictEqual(rows.map((r) => r.id), ["llama3.2:3b", "qwen2.5:7b"]);
    const fmt = await page.evaluate(() => document.querySelector("#cm-format").value);
    assert.strictEqual(fmt, "ollama", "选 Ollama 预设要自动把格式切到 ollama");
  } finally {
    await ctx.close();
  }
});

await test("探测失败给的是能动手的话，不是一句「失败」", async () => {
  const { ctx, page } = await openEmptyModelState(browser);
  try {
    await openModelForm(page);
    await typeInto(page, "#cm-base", `${ORIGIN}/mock/fail/v1`);
    await typeInto(page, "#cm-key", "sk-bad", "change");
    await page.waitForTimeout(1200);
    const box = await page.evaluate(() => {
      const el = document.querySelector("#cm-models");
      return {
        err: !!el?.querySelector(".model-test--err"),
        text: (el?.innerText || "").trim(),
        retry: !!el?.querySelector('[data-act="fetch-models"]'),
      };
    });
    assert.ok(box.err, "要有失败态：" + box.text);
    assert.ok(box.retry, "要给重试按钮");
    assert.ok(/HTTP\s*5\d\d|boom|服务器/.test(box.text), "要带具体原因：" + box.text);
  } finally {
    await ctx.close();
  }
});

console.log("\n[4] 多选批量加入");

await test("勾两个 → 加入所选 → 一次落库两条，带着 format 与 providerKey", async () => {
  const { ctx, page, errors } = await openEmptyModelState(browser);
  try {
    await openModelForm(page);
    await setSelect(page, "#cm-format", "anthropic");
    await typeInto(page, "#cm-base", `${ORIGIN}/mock/anth`);
    await typeInto(page, "#cm-key", "sk-ant-1", "change");
    await page.waitForTimeout(900);

    await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll("#cm-models [data-cm-pick]"));
      boxes.slice(0, 2).forEach((b) => {
        b.checked = true;
        b.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
    const btn = await page.evaluate(() => {
      const b = document.querySelector('[data-act="add-selected-models"]');
      return { disabled: b.disabled, text: (b.innerText || "").trim() };
    });
    assert.strictEqual(btn.disabled, false, "勾了就该能点");
    assert.ok(btn.text.includes("2"), "按钮上要显示数量，实际：" + btn.text);

    await page.evaluate(() => document.querySelector('[data-act="add-selected-models"]').click());
    await page.waitForTimeout(700);

    const models = await readModels(page);
    assert.strictEqual(models.length, 2, "一次加两个，实际：" + JSON.stringify(models.map((m) => m.apiModel)));
    assert.deepStrictEqual(models.map((m) => m.apiModel).sort(), ["claude-haiku-4-5", "claude-sonnet-4-5"]);
    const slot = await page.evaluate(() => document.querySelector("#cm-provider").value);
    models.forEach((m) => {
      assert.strictEqual(m.format, "anthropic", "要记住协议：" + JSON.stringify(m));
      assert.strictEqual(m.providerKey, slot, "要记住供应方：" + m.providerKey);
      assert.strictEqual(m.vision, false, "非 OpenAI 不该记成开了图片");
      assert.strictEqual(m.supportsEffort, false, "非 OpenAI 不该记成开了推理强度");
      assert.ok(String(m.baseUrl).endsWith("/mock/anth"), "要记住端点：" + m.baseUrl);
      assert.ok(Number(m.ctx) >= 4000, "上下文窗口要有值：" + m.ctx);
    });
    // 加完列表要标成已添加，并禁用勾选，避免重复加
    const after = await rowsOf(page);
    assert.ok(after.every((r) => r.disabled), "已添加的行要禁用：" + JSON.stringify(after));
    assert.ok(after[0].cls.includes("is-added"), "已添加的行要有标记");
    assert.deepStrictEqual(errors, [], "不能有未捕获错误：" + errors.join(" | "));
  } finally {
    await ctx.close();
  }
});

await test("全选按可见范围来：过滤后只全选筛出来的那些", async () => {
  const { ctx, page } = await openEmptyModelState(browser);
  try {
    await openModelForm(page);
    await typeInto(page, "#cm-base", `${ORIGIN}/mock/v1`);
    await typeInto(page, "#cm-key", "sk-test-123", "change");
    await page.waitForTimeout(900);

    await typeInto(page, "#cm-model-filter", "beta");
    await page.evaluate(() => document.querySelector('[data-act="select-all-models"]').click());
    const picked = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#cm-models [data-cm-pick]"))
        .filter((b) => b.checked)
        .map((b) => b.value)
    );
    assert.deepStrictEqual(picked, ["gpt-beta"], "只该选到筛出来的那一个：" + JSON.stringify(picked));
  } finally {
    await ctx.close();
  }
});

await test("再点一次全选就全不选，按钮回到禁用", async () => {
  const { ctx, page } = await openEmptyModelState(browser);
  try {
    await openModelForm(page);
    await typeInto(page, "#cm-base", `${ORIGIN}/mock/v1`);
    await typeInto(page, "#cm-key", "sk-test-123", "change");
    await page.waitForTimeout(900);
    await page.evaluate(() => document.querySelector('[data-act="select-all-models"]').click());
    await page.evaluate(() => document.querySelector('[data-act="select-all-models"]').click());
    const s = await page.evaluate(() => ({
      checked: Array.from(document.querySelectorAll("#cm-models [data-cm-pick]")).filter((b) => b.checked).length,
      disabled: document.querySelector('[data-act="add-selected-models"]').disabled,
    }));
    assert.strictEqual(s.checked, 0);
    assert.strictEqual(s.disabled, true);
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
