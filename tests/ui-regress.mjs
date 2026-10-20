/**
 * 复现 0.21.0 的两个 UI 回归：
 *  A) 消息间距被放宽、宽度超出屏幕
 *  B) 每发一句话下方空出一整块屏幕，底部不是最新消息
 *
 * 用法：node tests/ui-regress.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
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
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console.error]", m.text());
});
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

// ---------- 注入一个已有的会话（模拟老用户已有历史） ----------
//
// 两个坑必须避开，否则测出来的是"假回归"：
//
// 1) 注入时机：必须在页面脚本执行**之前**写入 localStorage。
//    之前是"打开页面 → evaluate 里写 localStorage → reload"，
//    可应用启动后 store.js 会周期性 save()，在 reload 之前就把注入内容覆盖掉了，
//    reload 后读到的其实是空会话（DBG 打出 out=[] 就是这个原因）。
//    现在改用 addInitScript：在任何页面脚本之前写入，一次导航即生效。
//
// 2) 存储布局：0.21.0 起会话正文改为「每会话一个分片键」（dsh.mobile.sessions.v1.<sid>），
//    主键 dsh.mobile.state.v1 只留索引 {id,title,updatedAt}。
//    只写主键的话，主键里的 messages 会被启动时的 save() 瘦身洗掉，历史一条都留不下。
await page.addInitScript(() => {
  const now = Date.now();
  const msgs = [];
  for (let i = 0; i < 8; i++) {
    msgs.push({ id: `u${i}`, role: "user", content: `这是第 ${i + 1} 条用户消息，用来撑开一点历史。`, ts: now - (8 - i) * 60000, status: "done" });
    msgs.push({ id: `a${i}`, role: "assistant", content: `这是第 ${i + 1} 条回复。`, ts: now - (8 - i) * 60000, status: "done", reasoning: "", tools: [] });
  }
  const session = { id: "s_test", title: "测试会话", createdAt: now - 600000, updatedAt: now, mode: "standard", model: "", workspace: "默认工作区", messages: msgs };
  const st = {
    settings: { mode: "standard", model: "", customModels: [], keys: {}, modelOverrides: {}, modelStatus: {}, modelCatalog: {}, mcpServers: [] },
    sessions: [session],
    activeSessionId: "s_test",
    runs: [],
    diagnostics: { requests: [] },
    files: [],
  };
  localStorage.setItem("dsh.mobile.state.v1", JSON.stringify(st));
  // 分片键：正文在这里（与 store.js 的 LS_SESSIONS 约定一致）
  localStorage.setItem("dsh.mobile.sessions.v1.s_test", JSON.stringify(session));
  // 当前会话 id 单独一个键
  localStorage.setItem("dsh.mobile.active.v1", "s_test");
});

// addInitScript 已就位，直接导航即可让应用带着注入的历史启动
await page.goto(base + "/index.html", { waitUntil: "networkidle" });
await page.waitForTimeout(900);

const measure = async (label) => {
  const r = await page.evaluate(() => {
    const sc = document.querySelector("#chat-scroll");
    const box = document.querySelector("#messages");
    const msgs = [...document.querySelectorAll(".msg")];
    const users = [...document.querySelectorAll(".msg--user")];
    const asst = [...document.querySelectorAll(".msg--assistant")];
    const rect = (e) => {
      const b = e.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) };
    };
    const last = msgs[msgs.length - 1];
    return {
      scrollTop: Math.round(sc.scrollTop),
      scrollHeight: Math.round(sc.scrollHeight),
      clientHeight: Math.round(sc.clientHeight),
      scrollWidth: Math.round(sc.scrollWidth),
      clientWidth: Math.round(sc.clientWidth),
      msgCount: msgs.length,
      moreBtn: !!document.querySelector(".chat__more"),
      moreText: document.querySelector(".chat__more")?.textContent || "",
      userWidths: users.map((e) => Math.round(e.getBoundingClientRect().width)),
      asstWidths: asst.map((e) => Math.round(e.getBoundingClientRect().width)),
      bubbleWidths: [...document.querySelectorAll(".msg__bubble")].map((e) => Math.round(e.getBoundingClientRect().width)),
      lastMsg: last ? rect(last) : null,
      lastMsgText: last?.textContent?.slice(0, 40) || "",
      // 底部空白：最后一条消息底边到滚动容器底边的距离
      bottomGap: last ? Math.round(sc.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom) : null,
      // 子元素超出容器
      overflowRight: [...document.querySelectorAll(".msg, .msg *")]
        .filter((e) => e.getBoundingClientRect().right > sc.getBoundingClientRect().right + 1)
        .slice(0, 5)
        .map((e) => `${e.className}|${Math.round(e.getBoundingClientRect().right)}`),
    };
  });
  console.log(`\n== ${label}`);
  console.log(JSON.stringify(r, null, 2));
  return r;
};

const a = await measure("A. 打开已有会话（历史 16 条）");

// ---------- 发一条新消息（走 sendMessage 路径：伪造 runAgent 不发网络请求） ----------
// 直接调 store 的 addMessage + ui 的发送流程会触发网络；这里用 UI 层等价操作：
// 模拟用户输入并点击发送
await page.fill("#composer-input", "新问题：请给我一份周会提纲");
await page.waitForTimeout(200);
await page.click("#send-btn");
await page.waitForTimeout(1200);

const b = await measure("B. 发送一条新消息后");

console.log("\n=== 判定 ===");
console.log("横向溢出:", b.overflowRight.length ? "有 ✗ " + b.overflowRight.join(", ") : "无 ✓");
console.log(
  "底部空白:",
  b.bottomGap,
  "px",
  b.bottomGap > 200 ? "✗ 过大（底部不是最新消息）" : "✓"
);
console.log(
  "用户气泡宽度:",
  a.userWidths.slice(0, 3),
  "→",
  b.userWidths.slice(-1),
  b.userWidths.some((w) => w > b.clientWidth) ? "✗ 超出屏幕宽度" : "✓"
);

await page.screenshot({ path: new URL("../artifacts/ui-after-send.png", import.meta.url).pathname, fullPage: false });
await browser.close();
server.close();
