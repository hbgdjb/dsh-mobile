/* ============================================================
   悬浮窗：长回复能滑、滑到哪儿不被刷新冲掉（0.62.0）

   ============ 为什么要单独测 ============

   「消息能换行」只是第一层。真正的坑在后面：

   1. 快照每 1.2s 推一次，流式输出时几乎每次都变。
      每次重写 innerHTML 都会把 scrollTop 打回 0 ——
      正在读长回复的人每 1.2 秒被弹回顶部，功能等于没做。
   2. 浮条容器原来挂 touch-action:none（为了拖动），
      但 touch-action 是沿祖先链取交集的，子元素的滚动会被一起禁掉。
   3. 展开态高度不设上限，一条长回复能把浮窗顶出屏幕。

   这三条都不会在「看一眼截图」时暴露，所以在这里钉住。
   ============================================================ */

import { chromium } from "playwright";
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

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}${extra ? " " + extra : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${extra ? " " + extra : ""}`);
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = join(ROOT, decodeURIComponent(url.pathname));
    const body = await readFile(p);
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});

const LONG = "这次周会主要确定三件事：移动端本周五封版、补一轮小屏验证、下周重排设置分组。".repeat(12);

function snapshot(text) {
  return {
    status: "replying",
    statusText: "正在回复…",
    step: "STEP 3",
    sessions: [{ title: "周会纪要整理", state: "回复中" }],
    tasks: [{ title: "生成会议纪要", progress: 62 }],
    messages: [
      { role: "user", text: "帮我把这次周会整理成纪要" },
      { role: "assistant", text },
    ],
    running: true,
    look: "plain",
  };
}

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  const rect = await page.evaluate(
    async ({ snap }) => {
      const hud = await import("./scripts/hud.js");
      hud.hudRender(snap, true);
      const el = document.querySelector("#dsh-hud-inapp");
      const r = el.getBoundingClientRect();
      const opt = { bubbles: true, clientX: r.left + 8, clientY: r.top + 8 };
      el.dispatchEvent(new PointerEvent("pointerdown", opt));
      el.dispatchEvent(new PointerEvent("pointerup", opt));
      return r.toJSON();
    },
    { snap: snapshot(LONG) }
  );
  void rect;
  return page;
}

/* ============================================================
   一、滚动位置要活过刷新
   ============================================================ */

console.log("[1] 读长回复时刷新不会把人弹回顶部");
const page = await open(412, 915);

const mid = await page.evaluate(async ({ snap }) => {
  const hud = await import("./scripts/hud.js");
  const body = document.querySelector("#dsh-hud-inapp .hud-body");
  body.scrollTop = 140;
  const before = body.scrollTop;
  // 模拟 1.2s 后的下一次快照：内容只多一个字
  hud.hudRender({ ...snap, messages: [...snap.messages.slice(0, 1), { role: "assistant", text: snap.messages[1].text + "。" }] }, true);
  await new Promise((r) => requestAnimationFrame(r));
  return { before, after: body.scrollTop, scrollable: body.scrollHeight > body.clientHeight + 1 };
}, { snap: snapshot(LONG) });

check("长回复确实撑出了滚动条", mid.scrollable === true, "");
check("确实滚到了中间（不是 0）", mid.before > 40, `${mid.before}px`);
check(
  "滚到中间时刷新后位置不变",
  mid.after === mid.before,
  `刷新前 ${mid.before} → 刷新后 ${mid.after}`
);

const bottom = await page.evaluate(async ({ snap }) => {
  const hud = await import("./scripts/hud.js");
  const body = document.querySelector("#dsh-hud-inapp .hud-body");
  body.scrollTop = body.scrollHeight;
  await new Promise((r) => requestAnimationFrame(r));
  hud.hudRender({ ...snap, statusText: "正在回复…" }, true);
  await new Promise((r) => requestAnimationFrame(r));
  return {
    atBottom: body.scrollHeight - body.scrollTop - body.clientHeight,
  };
}, { snap: snapshot(LONG) });

check("停在底部时刷新继续跟到底", bottom.atBottom <= 2, `离底 ${bottom.atBottom}px`);

/* ============================================================
   二、小屏：展开后不能顶出屏幕
   ============================================================ */

console.log("\n[2] 小屏 320×640");
const sm = await open(320, 640);
const small = await sm.evaluate(async ({ snap }) => {
  const hud = await import("./scripts/hud.js");
  hud.hudRender(snap, true);
  const el = document.querySelector("#dsh-hud-inapp");
  const body = el.querySelector(".hud-body");
  const r = el.getBoundingClientRect();
  return {
    height: Math.round(r.height),
    viewport: window.innerHeight,
    bodyHeight: body.clientHeight,
    scrollable: body.scrollHeight > body.clientHeight + 1,
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
  };
}, { snap: snapshot(LONG) });

check("浮窗整体不高于屏幕", small.height <= small.viewport - 8, `${small.height}px / ${small.viewport}px`);
check("小屏上消息区照样能滚", small.scrollable === true, `${small.bodyHeight}px 可视`);
check("没有横向溢出", small.overflowX === false, "");

await browser.close();
server.close();

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
