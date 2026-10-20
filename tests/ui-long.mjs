/**
 * 长会话（触发 RENDER_WINDOW 渲染窗口）下的布局回归测量。
 * 用法：node tests/ui-long.mjs <rootDir> <label>
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = process.argv[2] || new URL("..", import.meta.url).pathname;
const LABEL = process.argv[3] || "current";
const N = Number(process.argv[4] || 100);
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
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

await page.evaluate(async (N) => {
  const store = await import("./scripts/store.js");
  const s = store.createSession({ mode: "standard", title: "长会话" });
  const now = Date.now();
  for (let i = 0; i < N; i++) {
    store.addMessage(s.id, { id: `u${i}`, role: "user", content: `用户第${i + 1}条`, ts: now - (N - i) * 30000, status: "done" });
    store.addMessage(s.id, { id: `a${i}`, role: "assistant", content: `助手第${i + 1}条回复`, ts: now - (N - i) * 30000, status: "done", reasoning: "", tools: [] });
  }
  store.save(true);
}, N);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);

const measure = async (label) => {
  const r = await page.evaluate(() => {
    const sc = document.querySelector("#chat-scroll");
    const box = document.querySelector("#messages");
    const msgs = [...document.querySelectorAll(".msg")];
    const scRect = sc.getBoundingClientRect();
    // DOM 顺序 vs 数据顺序
    const domIds = msgs.map((e) => e.dataset.msg);
    // 视觉顺序（按 top 排序）
    const byTop = [...msgs].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((e) => e.dataset.msg);
    const last = msgs[msgs.length - 1];
    const lastByTop = byTop.length ? document.querySelector(`[data-msg="${byTop[byTop.length - 1]}"]`) : null;
    const more = document.querySelector(".chat__more");
    return {
      domMsgCount: msgs.length,
      moreText: more?.textContent || "(无)",
      moreHidden: more?.hidden,
      moreDisplay: more ? getComputedStyle(more).display : null,
      moreRect: more ? { w: Math.round(more.getBoundingClientRect().width), h: Math.round(more.getBoundingClientRect().height) } : null,
      // 顺序是否单调递增
      orderMonotonic: domIds.join(",") === byTop.join(","),
      firstIds: domIds.slice(0, 3),
      lastIds: domIds.slice(-3),
      // 最后一条消息（视觉上最底）
      lastVisualId: byTop[byTop.length - 1] || null,
      lastVisualText: lastByTop?.textContent?.trim().slice(0, 30) || "",
      bottomGap: lastByTop ? Math.round(scRect.bottom - lastByTop.getBoundingClientRect().bottom) : null,
      atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight,
      scrollTop: Math.round(sc.scrollTop),
      scrollHeight: Math.round(sc.scrollHeight),
      clientHeight: Math.round(sc.clientHeight),
      overflowX: sc.scrollWidth - sc.clientWidth,
      overflowRight: [...document.querySelectorAll(".msg, .chat__more")]
        .filter((e) => e.getBoundingClientRect().right > scRect.right + 1)
        .map((e) => `${e.className} right=${Math.round(e.getBoundingClientRect().right)}`),
    };
  });
  console.log(`\n===== ${LABEL} / ${label} =====`);
  console.log(JSON.stringify(r, null, 2));
  return r;
};

const A = await measure("A. 打开长会话");
await page.screenshot({ path: `/tmp/shot-${LABEL}-A.png` });

// 发送一条新消息
await page.fill("#composer-input", "新问题");
await page.waitForTimeout(150);
await page.click("#send-btn");
await page.waitForTimeout(1500);
const B = await measure("B. 发送新消息后");
await page.screenshot({ path: `/tmp/shot-${LABEL}-B.png` });

console.log("\n----- 结论 -----");
console.log(`DOM 消息数        : ${A.domMsgCount} → ${B.domMsgCount}`);
console.log(`折叠提示          : ${A.moreText}`);
console.log(`视觉顺序单调      : ${A.orderMonotonic} / ${B.orderMonotonic}`);
console.log(`底部空白          : A=${A.bottomGap}px  B=${B.bottomGap}px  (atBottom B=${B.atBottom})`);
console.log(`横向溢出          : ${B.overflowX}px ${B.overflowRight.join(",")}`);

await browser.close();
server.close();
