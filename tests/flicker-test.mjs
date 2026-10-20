/**
 * 频闪量化测试：深度思考流式输出时，展开的思考过程区域不应反复重播动画。
 *
 * 关键：要真流式。用本地 SSE 服务器分批推送 reasoning，
 * 每批之间有真实延迟，复现"边思考边显示"的场景。
 *
 * 测量：
 *   1) fadeIn/riseIn 动画触发次数（重建 DOM 会让动画重播）
 *   2) .reasoning 子树被整体替换的次数
 *   3) .reasoning__text 的高度抖动
 *
 * 用法：node tests/flicker-test.mjs <rootDir> <label>
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = process.argv[2] || new URL("..", import.meta.url).pathname;
const LABEL = process.argv[3] || "current";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

// ---- 静态资源 + 真流式 SSE（同一端口同源，避免 CORS 预检拦掉流式请求） ----
const staticServer = createServer(async (req, res) => {
  if (req.url.includes("/chat/completions")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const LINE = "为了回答这个问题，我需要先分析用户提到的三个约束条件，并逐一权衡可行性。";
    // 分 40 批推送，每批 25ms —— 模拟真实流式
    for (let i = 0; i < 40; i++) {
      const piece = LINE.slice((i * 7) % LINE.length, ((i * 7) % LINE.length) + 24);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: piece } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 25));
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "最终答案：可行，建议分两期推进。" } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const b = await readFile(f);
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
await new Promise((r) => staticServer.listen(0, r));
const staticPort = staticServer.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.goto(`http://127.0.0.1:${staticPort}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

// 配模型（指向本地 SSE 服务器）
await page.evaluate(async ({ ssePort }) => {
  const store = await import("./scripts/store.js");
  store.state.settings.customModels = [
    {
      id: "fake",
      label: "Fake",
      apiModel: "fake",
      provider: "自定义",
      providerKey: "custom",
      baseUrl: `http://127.0.0.1:${ssePort}/v1`,
      ctx: 128000,
      custom: true,
    },
  ];
  store.state.settings.model = "fake";
  store.state.settings.apiKey = "sk-test";
  store.state.settings.baseUrl = `http://127.0.0.1:${ssePort}/v1`;
  store.state.settings.showReasoning = true;
  store.createSession({ mode: "standard", title: "深度思考" });
  store.save(true);
}, { ssePort: staticPort });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

// 装探针
await page.evaluate(async () => {
  window.__probe = { animStarts: 0, animByTarget: {}, slotReplacements: 0, heights: [], reasonLens: [] };
  document.addEventListener(
    "animationstart",
    (e) => {
      if (e.animationName === "fadeIn" || e.animationName === "riseIn") {
        window.__probe.animStarts++;
        const k = e.target.className || e.target.tagName;
        window.__probe.animByTarget[k] = (window.__probe.animByTarget[k] || 0) + 1;
      }
    },
    true
  );
  // 文档级观察：任何 .reasoning 子树被移除都算一次整体重建
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.removedNodes) {
        if (n.nodeType === 1 && (n.classList?.contains("reasoning") || n.querySelector?.(".reasoning__text"))) {
          window.__probe.slotReplacements++;
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  window.__probeTimer = setInterval(() => {
    const t = document.querySelector(".reasoning__text");
    if (t) window.__probe.heights.push(Math.round(t.getBoundingClientRect().height));
  }, 16);
  const storeMod = await import("./scripts/store.js");
  window.__store = storeMod;
  window.__probeTimer2 = setInterval(() => {
    const s = storeMod.activeSession();
    const m = s?.messages?.[s.messages.length - 1];
    if (m) window.__probe.reasonLens.push(m.reasoning?.length || 0);
  }, 16);
});

await page.fill("#composer-input", "深度思考一下这个问题");
await page.waitForTimeout(150);
await page.click("#send-btn");

// 等思考区出现 → 展开
await page.waitForSelector(".reasoning__toggle", { timeout: 15000 });
await page.waitForTimeout(80);
await page.click(".reasoning__toggle");
await page.waitForTimeout(100);

// 等流式结束
// 等这一轮真正跑完（消息状态不再是 running）
await page
  .waitForFunction(
    () => {
      const st = window.__store;
      const s = st?.activeSession?.();
      const m = s?.messages?.[s.messages.length - 1];
      return m && m.status !== "running" && m.content.length > 0;
    },
    { timeout: 30000 }
  )
  .catch(() => console.log("  [warn] 等待流式结束超时"));
await page.waitForTimeout(700);

const r = await page.evaluate(() => {
  clearInterval(window.__probeTimer);
  clearInterval(window.__probeTimer2);
  const p = window.__probe;
  const h = p.heights;
  let jitter = 0;
  for (let i = 2; i < h.length; i++) if (h[i] < h[i - 1] - 1) jitter++;
  const rl = p.reasonLens || [];
  return {
    animStarts: p.animStarts,
    animByTarget: p.animByTarget,
    slotReplacements: p.slotReplacements,
    heightSamples: h.length,
    heightJitter: jitter,
    distinctHeights: [...new Set(h)].length,
    reasoningOpen: document.querySelector(".reasoning")?.dataset.open,
    labelText: document.querySelector(".reasoning__label")?.textContent,
    msgStatus: (() => {
      const el = document.querySelector('.msg--assistant');
      return el ? el.className + " | " + (el.querySelector(".msg__stamp")?.textContent || "") : null;
    })(),
    lastMsgDump: (() => {
      const st = window.__store;
      const m = st?.activeSession?.()?.messages?.slice(-1)[0];
      return m ? { status: m.status, reasoningMs: m.reasoningMs, clen: m.content.length } : null;
    })(),
    labelExists: !!document.querySelector(".reasoning__label"),
    reasonLenSamples: rl.length,
    reasonLenDistinct: [...new Set(rl)].length,
    reasonLenFinal: rl.length ? rl[rl.length - 1] : 0,
  };
});

console.log(`\n===== ${LABEL} / 深度思考展开（真流式） =====`);
console.log(JSON.stringify(r, null, 2));
await page.screenshot({ path: `/tmp/shot-flicker-${LABEL}.png` });

console.log("\n----- 判定 -----");
console.log(`思考区整体重建次数 : ${r.slotReplacements}  ${r.slotReplacements > 3 ? "✗ 频繁重建 → 频闪" : "✓"}`);
console.log(`动画触发次数       : ${r.animStarts}  ${r.animStarts > 3 ? "✗ 动画重播 → 频闪" : "✓"}  ${JSON.stringify(r.animByTarget)}`);
console.log(`高度抖动次数       : ${r.heightJitter}`);
console.log(`流式确认           : reasoning 长度采样 ${r.reasonLenSamples} 次 / ${r.reasonLenDistinct} 个不同值 / 末值 ${r.reasonLenFinal}`);
console.log(`展开态             : ${r.reasoningOpen}`);
console.log(`标题文字           : ${JSON.stringify(r.labelText)}  标签节点存在=${r.labelExists}`);

await browser.close();
staticServer.close();
