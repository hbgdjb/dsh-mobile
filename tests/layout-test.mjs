/**
 * 布局回归测试（UI 层）：
 *   1) 空会话发送第一条消息后，首页空态不得残留在消息列表下方
 *   2) 消息容器必须带 .messages class（否则 padding/gap/flex 全部失效，消息贴边变宽）
 *   3) 发送后容器底部必须是最新回复，不能有一整屏空白
 *   4) 任何元素不得横向溢出滚动容器
 *
 * 用法：node tests/layout-test.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
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
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

// ---- 场景一：空会话发送第一条消息 ----
await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  store.createSession({ mode: "standard", title: "布局测试" });
  store.save(true);
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(700);

await page.fill("#composer-input", "第一条消息");
await page.waitForTimeout(120);
await page.click("#send-btn");
await page.waitForTimeout(1200);

const r1 = await page.evaluate(() => {
  const box = document.querySelector("#messages");
  const sc = document.querySelector("#chat-scroll");
  const scRect = sc.getBoundingClientRect();
  const msgs = [...document.querySelectorAll(".msg")];
  const byTop = [...msgs].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const last = byTop[byTop.length - 1];
  const kids = [...box.children].map((e) => e.className);
  return {
    boxClass: box.className,
    padLeft: getComputedStyle(box).paddingLeft,
    display: getComputedStyle(box).display,
    hasHome: !!box.querySelector(".home"),
    homeIndex: kids.findIndex((c) => c.includes("home")),
    msgCount: msgs.length,
    msgWidths: [...new Set(msgs.map((e) => Math.round(e.getBoundingClientRect().width)))],
    overflowX: sc.scrollWidth - sc.clientWidth,
    overflowRight: [...document.querySelectorAll(".msg, .msg *")]
      .filter((e) => e.getBoundingClientRect().right > scRect.right + 1)
      .map((e) => e.className),
    lastIsNewest: last?.dataset.msg?.startsWith("a_") || false,
    // 首页残留会让容器高度多出一整屏
    homeHeight: Math.round(box.querySelector(".home")?.getBoundingClientRect().height || 0),
  };
});

check("容器带 .messages class", r1.boxClass.includes("messages"), `"${r1.boxClass}"`);
check("容器保留左右内边距", r1.padLeft !== "0px", `padding-left=${r1.padLeft}`);
check("首页空态已清除", !r1.hasHome && r1.homeIndex === -1, `home高度=${r1.homeHeight}`);
check("消息未超出容器宽度", r1.msgWidths.every((w) => w <= 412), `宽度=${r1.msgWidths.join(",")}`);
check("无横向溢出", r1.overflowX === 0 && r1.overflowRight.length === 0, r1.overflowRight.join(","));
check("容器末尾是最新回复", r1.lastIsNewest);

// ---- 场景二：长会话（渲染窗口）不得回归 ----
await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  const s = store.createSession({ mode: "standard", title: "长会话" });
  const now = Date.now();
  for (let i = 0; i < 100; i++) {
    store.addMessage(s.id, { id: `u${i}`, role: "user", content: `用户第${i + 1}条`, ts: now - (100 - i) * 30000, status: "done" });
    store.addMessage(s.id, { id: `a${i}`, role: "assistant", content: `助手第${i + 1}条`, ts: now - (100 - i) * 30000, status: "done", reasoning: "", tools: [] });
  }
  store.save(true);
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);

const r2 = await page.evaluate(() => {
  const box = document.querySelector("#messages");
  const sc = document.querySelector("#chat-scroll");
  const msgs = [...document.querySelectorAll(".msg")];
  const ids = msgs.map((e) => e.dataset.msg);
  const byTop = [...msgs].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((e) => e.dataset.msg);
  return {
    boxClass: box.className,
    domCount: msgs.length,
    orderOk: ids.join(",") === byTop.join(","),
    hasHome: !!box.querySelector(".home"),
    overflowX: sc.scrollWidth - sc.clientWidth,
    atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight,
  };
});

check("长会话：容器 class 正确", r2.boxClass.includes("messages"), `"${r2.boxClass}"`);
check("长会话：无首页残留", !r2.hasHome);
check("长会话：渲染窗口生效", r2.domCount === 60, `DOM消息数=${r2.domCount}`);
check("长会话：顺序单调", r2.orderOk);
check("长会话：无横向溢出", r2.overflowX === 0);
check("长会话：停在底部", r2.atBottom === 0, `atBottom=${r2.atBottom}`);
check("无未捕获异常", errors.length === 0, errors.join(" | "));

console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
await browser.close();
server.close();
process.exit(failed === 0 ? 0 : 1);
