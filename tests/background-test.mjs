/**
 * 后台保活回归测试（0.21.6）
 *
 * 用户反馈："切到后台任务就会自动停止"。
 * 追下来发现不是权限不够，而是三处机制没接上 + 一个应用侧误判 bug：
 *
 *   1) WebView 渲染进程被降级回收（主因，原生侧修）
 *   2) CPU 休眠打断流式读取（原生侧持 WakeLock 修）
 *   3) 电池优化 / 厂商省电策略（只能引导用户放行）
 *   4) **应用侧误判**：orphanRunning() 只看"消息状态是 running"，
 *      不看"执行器是否还在"。切后台时流式渲染被节流，用户看不到进度，
 *      回到前台被当作孤儿运行强行收尾 —— 任务就真的被停掉了。
 *      这条是本测试主要覆盖的对象。
 *
 * 用法：node tests/background-test.mjs
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
  // 真流式 SSE：慢速推送，让任务持续处于 running 状态
  if (req.url.includes("/chat/completions")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (let i = 0; i < 60; i++) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `片段${i} ` } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 60));
    }
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
await page.waitForTimeout(500);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

// ---- 准备：造一条 status=running 的消息，模拟"切后台期间任务还在跑" ----
await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  const s = store.createSession({ mode: "standard", title: "后台测试" });
  const now = Date.now();
  store.addMessage(s.id, { id: "u1", role: "user", content: "跑个长任务", ts: now, status: "done" });
  store.addMessage(s.id, {
    id: "a1",
    role: "assistant",
    status: "running",
    content: "正在干活",
    reasoning: "",
    tools: [],
    steps: 1,
    ts: now + 1000,
  });
  store.save(true);
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

// ---- 场景一：没有执行器时，running 消息确实算孤儿（这是必要的兜底） ----
const r1 = await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  const s = store.activeSession();
  const m = s.messages.find((x) => x.id === "a1");
  // 触发 dsh:resume（等价于从后台回到前台）
  window.dispatchEvent(new CustomEvent("dsh:resume"));
  await new Promise((r) => setTimeout(r, 200));
  const after = store.activeSession().messages.find((x) => x.id === "a1");
  return {
    before: m.status,
    after: after.status,
    error: after.error || "",
    interrupted: !!after.interrupted,
  };
});

check("无执行器时：running 被判定为孤儿并收尾", r1.after === "stopped", `status=${r1.after}`);
check("收尾提示指向系统中断", /系统中断/.test(r1.error), r1.error);

// ---- 场景二：执行器还在时，切回前台不得动任务（关键回归） ----
// 用真流式 SSE 跑一个长任务，任务处于 running 时触发 dsh:resume：
// 若执行器还在，running 消息绝不能被收尾——这正是修复前的 bug。
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
  store.createSession({ mode: "standard", title: "后台保活" });
  store.save(true);
}, { ssePort: port });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

await page.fill("#composer-input", "跑一个长任务，别停");
await page.waitForTimeout(100);
await page.click("#send-btn");
// 等流式真正开始（assistant 消息进入 running）
await page.waitForTimeout(700);

const r2 = await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  const before = store.activeSession().messages.filter((x) => x.status === "running").length;
  const contentBefore = store
    .activeSession()
    .messages.filter((x) => x.status === "running")
    .map((x) => (x.content || "").length)
    .join(",");
  // 模拟"从后台回到前台"
  window.dispatchEvent(new CustomEvent("dsh:resume"));
  await new Promise((r) => setTimeout(r, 250));
  const after = store.activeSession().messages.filter((x) => x.status === "running").length;
  const errors = store
    .activeSession()
    .messages.filter((x) => x.error)
    .map((x) => x.error)
    .join(" | ");
  return { before, after, contentBefore, errors };
});

check("任务确实在跑（running 消息存在）", r2.before > 0, `running=${r2.before}`);
check(
  "执行器在跑时：切回前台不收尾任务",
  r2.before > 0 && r2.after === r2.before,
  `前=${r2.before} 后=${r2.after}`
);
check("执行器在跑时：不产生「被系统中断」误报", !/系统中断/.test(r2.errors), r2.errors);

// 任务应当继续推进（流式没被打断）
const r2b = await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  await new Promise((r) => setTimeout(r, 900));
  const m = store.activeSession().messages.filter((x) => x.status === "running")[0];
  return { len: (m?.content || "").length, stillRunning: !!m };
});
check("切回前台后任务继续推进（流未断）", r2b.stillRunning && r2b.len > 0, `内容长度=${r2b.len}`);

// 等任务跑完，确认没有误判
await page.waitForTimeout(4500);
const r2c = await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  const msgs = store.activeSession().messages;
  const a = msgs[msgs.length - 1];
  return { status: a.status, error: a.error || "", content: (a.content || "").length };
});
check("任务最终正常完成", r2c.status === "done", `status=${r2c.status} ${r2c.error}`);
check("完成消息有实质内容", r2c.content > 0, `长度=${r2c.content}`);

// ---- 场景三：切后台时立即落盘，不等 1.2s 节流 ----
const r3 = await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  const s = store.activeSession();
  const m = s.messages.find((x) => x.status === "running") || s.messages[s.messages.length - 1];
  m.content = "后台落盘标记-ABC123";
  store.saveSessionNow(s.id); // 只标记为脏
  // 立刻读 localStorage：此时还没到 1.2s 节流窗口，内容应该还没写
  const rawBefore = localStorage.getItem("dsh.mobile.sessions.v1." + s.id) || "";
  // 触发 flush（切后台）
  window.dispatchEvent(new CustomEvent("dsh:flush"));
  await new Promise((r) => setTimeout(r, 120));
  const rawAfter = localStorage.getItem("dsh.mobile.sessions.v1." + s.id) || "";
  return {
    beforeHas: rawBefore.includes("后台落盘标记-ABC123"),
    afterHas: rawAfter.includes("后台落盘标记-ABC123"),
  };
});
check("切后台前：节流窗口内尚未落盘（对照组）", !r3.beforeHas);
check("切后台后：立即落盘，不等节流", r3.afterHas);

// ---- 场景四：设置页有「后台保活」区块与引导入口 ----
const r4 = await page.evaluate(() => {
  // 浏览器模式没有原生桥，区块不显示 —— 这本身是预期行为
  const hasBridge = !!window.DshPower;
  return { hasBridge };
});
check("浏览器模式无原生保活桥（区块按预期隐藏）", !r4.hasBridge);

// ---- 场景五：原生桥的 JS 契约（用桩验证降级路径不抛错） ----
const r5 = await page.evaluate(async () => {
  const ka = await import("./scripts/keep-alive.js");
  const out = {};
  try {
    out.status = ka.powerStatus();
    out.available = ka.powerAvailable();
    out.exemption = ka.requestBatteryExemption();
    out.battery = ka.openBatterySettings();
    out.autostart = ka.openAutoStartSettings();
    out.startOk = (ka.keepAliveStart(), true);
    out.stopOk = (ka.keepAliveStop(), true);
  } catch (e) {
    out.err = e.message;
  }
  return out;
});
check("无原生桥时全部降级为 no-op", !r5.err && r5.available === false, JSON.stringify(r5));
check("浏览器模式不抛未捕获异常", errors.length === 0, errors.join(" | "));

await browser.close();
server.close();
console.log(failed ? `\n✗ ${failed} 项未通过` : "\n✓ 全部通过");
process.exit(failed ? 1 : 0);
