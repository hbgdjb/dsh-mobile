/**
 * 对比实验：在同一份渲染逻辑下（可指定 root 目录）测量
 *   A) 消息之间的间距 / 宽度
 *   B) 发送后底部空白
 *
 * 用法：node tests/ui-compare.mjs <rootDir> <label>
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

// 注入 16 条历史
const injected = await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  const s = store.createSession({ mode: "standard", title: "测试会话" });
  const now = Date.now();
  for (let i = 0; i < 8; i++) {
    store.addMessage(s.id, { id: `u${i}`, role: "user", content: `第${i + 1}条用户消息`, ts: now - (8 - i) * 60000, status: "done" });
    store.addMessage(s.id, { id: `a${i}`, role: "assistant", content: `第${i + 1}条回复`, ts: now - (8 - i) * 60000, status: "done", reasoning: "", tools: [] });
  }
  store.save(true);
  return store.state.sessions[0].messages.length;
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);

const measure = async (label) => {
  const r = await page.evaluate(() => {
    const sc = document.querySelector("#chat-scroll");
    const msgs = [...document.querySelectorAll(".msg")];
    const box = document.querySelector("#messages");
    const scRect = sc.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    const gaps = [];
    for (let i = 1; i < msgs.length; i++) {
      gaps.push(Math.round(msgs[i].getBoundingClientRect().top - msgs[i - 1].getBoundingClientRect().bottom));
    }
    const last = msgs[msgs.length - 1];
    return {
      domMsgs: msgs.length,
      // #messages 容器的左右内边距与总宽
      boxWidth: Math.round(boxRect.width),
      boxPadLeft: getComputedStyle(box).paddingLeft,
      boxPadRight: getComputedStyle(box).paddingRight,
      boxDisplay: getComputedStyle(box).display,
      boxGap: getComputedStyle(box).gap,
      msgWidths: [...new Set(msgs.map((e) => Math.round(e.getBoundingClientRect().width)))],
      bubbleWidths: [...new Set([...document.querySelectorAll(".msg__bubble")].map((e) => Math.round(e.getBoundingClientRect().width)))],
      gapsBetweenMsgs: [...new Set(gaps)],
      // 发送后：最后一条消息底边 → 容器底边
      bottomGap: last ? Math.round(scRect.bottom - last.getBoundingClientRect().bottom) : null,
      scrollTop: Math.round(sc.scrollTop),
      scrollHeight: Math.round(sc.scrollHeight),
      clientHeight: Math.round(sc.clientHeight),
      atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight,
      overflowX: sc.scrollWidth - sc.clientWidth,
    };
  });
  console.log(`\n===== ${LABEL} / ${label} =====`);
  console.log(JSON.stringify(r, null, 2));
  return r;
};

const A = await measure("A. 打开已有会话");

// 发送一条新消息（会真的发请求，模型没配会失败，但消息节点已插入）
await page.fill("#composer-input", "新问题：请给我一份周会提纲");
await page.waitForTimeout(200);
await page.click("#send-btn");
await page.waitForTimeout(1500);
const B = await measure("B. 发送一条新消息后");

console.log("\n----- 结论 -----");
console.log(`消息间距(gap)      : ${A.gapsBetweenMsgs.join(",")}`);
console.log(`消息宽度          : ${A.msgWidths.join(",")} / 容器 ${A.boxWidth} / 视口 412`);
console.log(`发送后底部空白    : ${B.bottomGap}px  atBottom=${B.atBottom}px`);
console.log(`横向溢出          : ${B.overflowX}px`);

await browser.close();
server.close();
