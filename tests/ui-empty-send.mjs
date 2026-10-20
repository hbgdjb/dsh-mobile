/**
 * 复现假设：空会话里发送第一条消息时，首页空态（renderHome）残留在消息列表下方。
 *
 * 症状预期：
 *   - #messages 缺少 .messages class（没有 flex/padding/gap 布局）
 *   - .home 节点仍然留在 DOM 里，且排在消息之后
 *   - 最后一条视觉消息不是最新消息
 *
 * 用法：node tests/ui-empty-send.mjs <rootDir> <label>
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
await page.waitForTimeout(500);

// 建一个空会话（模拟用户在抽屉里点"新会话"）
const made = await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  const s = store.createSession({ mode: "standard", title: "新会话" });
  store.save(true);
  return s.id;
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

const before = await page.evaluate(() => {
  const box = document.querySelector("#messages");
  return {
    boxClass: box?.className,
    hasHome: !!box?.querySelector(".home"),
    homeHeight: Math.round(box?.querySelector(".home")?.getBoundingClientRect().height || 0),
    msgCount: document.querySelectorAll(".msg").length,
  };
});
console.log(`\n===== ${LABEL} / 发消息前 =====`);
console.log(before);

await page.fill("#composer-input", "你好，这是第一条消息");
await page.waitForTimeout(150);
await page.click("#send-btn");
await page.waitForTimeout(1500);

const after = await page.evaluate(() => {
  const box = document.querySelector("#messages");
  const sc = document.querySelector("#chat-scroll");
  const scRect = sc.getBoundingClientRect();
  const home = box?.querySelector(".home");
  const kids = [...(box?.children || [])].map((e) => ({
    cls: e.className || e.tagName,
    h: Math.round(e.getBoundingClientRect().height),
    top: Math.round(e.getBoundingClientRect().top),
  }));
  const msgs = [...document.querySelectorAll(".msg")];
  const byTop = [...msgs].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const lastVisual = byTop[byTop.length - 1];
  return {
    boxClass: box?.className,
    boxDisplay: box ? getComputedStyle(box).display : null,
    boxPadLeft: box ? getComputedStyle(box).paddingLeft : null,
    boxGap: box ? getComputedStyle(box).gap : null,
    hasHome: !!home,
    homeHeight: home ? Math.round(home.getBoundingClientRect().height) : 0,
    childOrder: kids,
    msgCount: msgs.length,
    lastVisualText: lastVisual?.textContent?.trim().slice(0, 30) || "",
    // 首页残留在最后一条消息下方 → 底部会有一大块空白
    homeAfterMessages: home ? !!home.compareDocumentPosition(lastVisual) & Node.DOCUMENT_POSITION_PRECEDING : null,
    bottomGap: lastVisual ? Math.round(scRect.bottom - lastVisual.getBoundingClientRect().bottom) : null,
    atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight,
    scrollHeight: Math.round(sc.scrollHeight),
    clientHeight: Math.round(sc.clientHeight),
  };
});
console.log(`\n===== ${LABEL} / 发第一条消息后 =====`);
console.log(JSON.stringify(after, null, 2));
await page.screenshot({ path: `/tmp/shot-empty-${LABEL}.png` });

console.log("\n----- 结论 -----");
console.log(`#messages class      : "${after.boxClass}"  (期望 "messages")`);
console.log(`首页空态是否残留      : ${after.hasHome ? "是 ✗ 高度 " + after.homeHeight + "px" : "否 ✓"}`);
console.log(`底部空白              : ${after.bottomGap}px   atBottom=${after.atBottom}`);
console.log(`视觉上最后一条        : ${after.lastVisualText}`);

await browser.close();
server.close();
