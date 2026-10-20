/**
 * 端到端复现：真实模拟"用户发消息 → 助手流式回复"，检查
 *   1) 消息宽度是否超出屏幕
 *   2) 消息间距是否被放宽
 *   3) 底部是否为最新回复
 *
 * 用法：node tests/ui-e2e.mjs <rootDir> <label>
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
await page.waitForTimeout(400);

// 拦截 API，直接返回一段 SSE 风格的流式回复
await page.route("**/*", async (route) => {
  const req = route.request();
  const url = req.url();
  if (url.includes("/chat/completions") || url.includes("/v1/")) {
    const body = [
      'data: {"choices":[{"delta":{"content":"## 周会提纲\\n\\n**结论**\\n- 项目 A 延期两周，原因是依赖方接口未就绪\\n- 本周营收环比 +8%，主要来自渠道 B\\n\\n**归因**\\n1. 排期：需求变更未走评审\\n2. 资源：两名前端被抽调\\n\\n**动作**\\n| 事项 | 负责人 | 期限 |\\n|---|---|---|\\n| 补齐依赖接口 | 张 | 周五 |\\n| 冻结非关键需求 | 李 | 下周一 |"}}]}',
      'data: [DONE]',
    ].join("\n\n");
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "access-control-allow-origin": "*" },
      body,
    });
    return;
  }
  route.continue();
});

// 配好一个"可用"的假模型
await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  store.state.settings.customModels = [
    { id: "fake", label: "Fake", apiModel: "fake", provider: "自定义", providerKey: "custom", baseUrl: "https://example.invalid/v1", ctx: 128000, custom: true },
  ];
  store.state.settings.model = "fake";
  store.state.settings.apiKey = "sk-test";
  store.state.settings.baseUrl = "https://example.invalid/v1";
  store.save(true);
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

// 建一个新会话（空）→ 模拟真实使用：从空会话发第一条
await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  store.createSession({ mode: "standard", title: "周会" });
  store.save(true);
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

await page.fill("#composer-input", "帮我写一份周会提纲");
await page.waitForTimeout(150);
await page.click("#send-btn");
await page.waitForTimeout(2500);

const r = await page.evaluate(() => {
  const sc = document.querySelector("#chat-scroll");
  const box = document.querySelector("#messages");
  const scRect = sc.getBoundingClientRect();
  const msgs = [...document.querySelectorAll(".msg")];
  const byTop = [...msgs].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const last = byTop[byTop.length - 1];
  const gaps = [];
  for (let i = 1; i < byTop.length; i++) gaps.push(Math.round(byTop[i].getBoundingClientRect().top - byTop[i - 1].getBoundingClientRect().bottom));
  return {
    boxClass: box.className,
    boxPadLeft: getComputedStyle(box).paddingLeft,
    hasHome: !!box.querySelector(".home"),
    msgCount: msgs.length,
    msgWidths: [...new Set(msgs.map((e) => Math.round(e.getBoundingClientRect().width)))],
    bubbleWidths: [...new Set([...document.querySelectorAll(".msg__bubble")].map((e) => Math.round(e.getBoundingClientRect().width)))],
    gapsBetweenMsgs: [...new Set(gaps)],
    bodyWidths: [...new Set([...document.querySelectorAll(".msg__body")].map((e) => Math.round(e.getBoundingClientRect().width)))],
    overflowX: sc.scrollWidth - sc.clientWidth,
    overflowRight: [...document.querySelectorAll(".msg, .msg *")]
      .filter((e) => e.getBoundingClientRect().right > scRect.right + 1)
      .map((e) => `${e.className}@${Math.round(e.getBoundingClientRect().right)}`),
    bottomGap: last ? Math.round(scRect.bottom - last.getBoundingClientRect().bottom) : null,
    atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight,
    lastIsNewest: last?.dataset.msg?.startsWith("a_") || false,
    lastText: last?.textContent?.trim().slice(0, 60) || "",
  };
});
console.log(`\n===== ${LABEL} / 空会话首条消息（真实流式回复） =====`);
console.log(JSON.stringify(r, null, 2));
await page.screenshot({ path: `/tmp/shot-e2e-${LABEL}.png` });

console.log("\n----- 判定 -----");
console.log(`容器 class        : ${r.boxClass}`);
console.log(`首页空态残留      : ${r.hasHome ? "是 ✗" : "否 ✓"}`);
console.log(`消息宽度          : ${r.msgWidths.join(",")} (视口 412, 应 ≤412 且两侧有 16px 内边距)`);
console.log(`消息间距          : ${r.gapsBetweenMsgs.join(",")}`);
console.log(`横向溢出          : ${r.overflowX}px ${r.overflowRight.join(", ")}`);
console.log(`底部空白          : ${r.bottomGap}px  atBottom=${r.atBottom}`);
console.log(`底部是最新回复    : ${r.lastIsNewest ? "是 ✓" : "否 ✗"}`);

await browser.close();
server.close();
