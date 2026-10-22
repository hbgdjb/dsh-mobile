/* ============================================================
   悬浮窗交互行为测试（tests/hud-interact-test.mjs）

   上一份是「读源码」的契约测试。这一份是**真的在浏览器里点**：
   渲染应用内的悬浮条（降级实现），输入文字、点发送、点停止，
   验证 window.__dshHudCommand 这条协议真的通。

   为什么必须真点：
   契约测试只能证明「代码写了那行」，证明不了「点了会触发」。
   悬浮条是应用内浮层 + pointer 事件，最容易出问题的地方就是
   「输入框里的字被当成拖动」「回车没发出」这类交互。

   ==================== 为什么用两个页面 ====================
   上一版把测试跑在真实 index.html 上，结果三项全挂：
   1) ui.js 加载时会 installHudCommandHandler()，
      把测试的 recorder 覆盖掉 → 记录到的调用是空数组；
   2) ui.js 的 HUD 轮询每 1.2s 用 hudEnabled(=false) 调
      removeInApp() → 浮条被整块摘掉，输入框随之消失。

   这两个都是「生产代码在正常工作」，不是缺陷。
   所以测试必须把降级浮条和生产逻辑隔开：
   · 场景 A：独立测试页，只加载 hud.js → 验证浮条交互本身
   · 场景 B：真实 index.html → 验证生产版 handler 的协议
   ============================================================ */

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

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log(`✓ ${name}${extra ? " " + extra : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${extra ? " " + extra : ""}`);
  }
}

/* 场景 A 的独立测试页：只加载 hud.js，不加载 ui.js。
   这样既不会有人覆盖 recorder，也没有人会 removeInApp()。 */
const HARNESS = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>HUD harness</title></head>
<body>
<script type="module">
  window.__hudCalls = [];
  window.__dshHudCommand = async (action, payload) => {
    window.__hudCalls.push({ action, payload });
    return "ok";
  };
  window.__hud = await import("/scripts/hud.js");
  window.__hudReady = true;
</script>
</body></html>`;

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    if (p === "/__hud-harness.html") {
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(HARNESS);
      return;
    }
    const f = join(ROOT, normalize(p));
    const b = await readFile(f);
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

/* ============================================================
   场景 A：降级浮条的交互
   ============================================================ */

const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/__hud-harness.html`, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__hudReady, null, { timeout: 10000 });

/* 一、渲染：展开后有输入框和两个按钮 */

const rendered = await page.evaluate(async () => {
  window.__hud.hudRender(
    {
      status: "tool",
      statusText: "正在执行：ui_tap",
      step: "STEP 2 · ui_tap",
      sessions: [{ title: "会话", state: "正在执行 ui_tap" }],
      tasks: [],
      messages: [
        { role: "user", text: "打开微信" },
        { role: "assistant", text: "好的，正在打开" },
      ],
      running: true,
      look: "tool",
      event: null,
      cueSeq: 1,
      badge: null,
    },
    true
  );
  await new Promise((r) => setTimeout(r, 300));
  const el = document.getElementById("dsh-hud-inapp");
  if (!el) return { missing: true };
  // 点一下展开
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 10, clientY: 10 }));
  await new Promise((r) => setTimeout(r, 300));
  return {
    missing: false,
    hasInput: !!el.querySelector(".hud-input"),
    hasSend: !!el.querySelector(".hud-send"),
    hasStop: !!el.querySelector(".hud-stop"),
    open: el.dataset.open,
    text: el.textContent || "",
    msgCount: el.querySelectorAll(".hud-msg").length,
    stopDisabled: el.querySelector(".hud-stop")?.disabled,
  };
});

check("渲染：悬浮条已出现", !rendered.missing);
check("渲染：有输入框", rendered.hasInput);
check("渲染：有发送按钮", rendered.hasSend);
check("渲染：有停止按钮", rendered.hasStop);
check("渲染：点按后展开", rendered.open === "true", `open=${rendered.open}`);
check("渲染：显示了最近消息", rendered.msgCount === 2, `count=${rendered.msgCount}`);
check("渲染：消息里有「你：打开微信」", rendered.text.includes("打开微信"));
check("渲染：运行中时停止按钮可点", rendered.stopDisabled === false);

/* 二、发消息：点「发送」要真的把文字交出去 */

await page.fill(".hud-input", "再加一句");
await page.click(".hud-send");
await page.waitForTimeout(200);

const afterSend = await page.evaluate(() => ({
  calls: window.__hudCalls,
  inputValue: document.querySelector(".hud-input")?.value,
}));

check("行为：点发送触发 send 指令", afterSend.calls.some((c) => c.action === "send"),
  JSON.stringify(afterSend.calls));
{
  const call = afterSend.calls.find((c) => c.action === "send");
  check("行为：指令带上了文字内容", call?.payload?.text === "再加一句", call?.payload?.text);
  check("行为：发完输入框清空", afterSend.inputValue === "", `value=${afterSend.inputValue}`);
}

/* 三、回车发送 */

await page.fill(".hud-input", "回车的");
await page.focus(".hud-input");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);

const afterEnter = await page.evaluate(() => window.__hudCalls);
check("行为：回车也能发", afterEnter.some((c) => c.action === "send" && c.payload?.text === "回车的"),
  JSON.stringify(afterEnter.map((c) => c.payload?.text)));

/* 四、停止 */

await page.click(".hud-stop");
await page.waitForTimeout(200);
const afterStop = await page.evaluate(() => window.__hudCalls);
check("行为：点停止触发 stop 指令", afterStop.some((c) => c.action === "stop"));

/* 五、空内容不发 */

const before = await page.evaluate(() => window.__hudCalls.length);
await page.fill(".hud-input", "   ");
await page.click(".hud-send");
await page.waitForTimeout(200);
const after = await page.evaluate(() => window.__hudCalls.length);
check("行为：空白内容不会发出指令", after === before, `${before} → ${after}`);

/* 六、没有运行中时停止按钮置灰 */

await page.evaluate(async () => {
  window.__hud.hudRender(
    { status: "idle", statusText: "空闲中", step: "", sessions: [], tasks: [], messages: [], running: false },
    true
  );
  await new Promise((r) => setTimeout(r, 300));
});
const idleStop = await page.evaluate(() => document.querySelector(".hud-stop")?.disabled);
check("行为：空闲时停止按钮禁用", idleStop === true, `disabled=${idleStop}`);

/* 七、收起时隐藏操作行 */

await page.evaluate(async () => {
  const el = document.getElementById("dsh-hud-inapp");
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 10, clientY: 10 }));
  await new Promise((r) => setTimeout(r, 200));
});
const collapsed = await page.evaluate(() => {
  const el = document.getElementById("dsh-hud-inapp");
  const act = el.querySelector(".hud-act");
  return { open: el.dataset.open, actDisplay: act ? getComputedStyle(act).display : "none" };
});
check("行为：收起后隐藏操作行", collapsed.actDisplay === "none", `display=${collapsed.actDisplay}`);

/* 八、点按钮不会误触发「点按浮条 → 收起」 */

await page.evaluate(async () => {
  window.__hud.hudRender(
    { status: "tool", statusText: "执行中", step: "", sessions: [], tasks: [], messages: [], running: true },
    true
  );
  await new Promise((r) => setTimeout(r, 200));
  const el = document.getElementById("dsh-hud-inapp");
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 10, clientY: 10 }));
  await new Promise((r) => setTimeout(r, 200));
});
await page.click(".hud-send");
await page.waitForTimeout(200);
const afterBtn = await page.evaluate(() => ({
  open: document.getElementById("dsh-hud-inapp")?.dataset.open,
  inputExists: !!document.querySelector(".hud-input"),
}));
check("行为：点发送后浮条不收起", afterBtn.open === "true", `open=${afterBtn.open}`);
check("行为：点发送后输入框还在", afterBtn.inputExists === true);

await page.close();

/* ============================================================
   场景 B：生产版 handler（真实 index.html）
   ============================================================ */

const real = await browser.newPage({ viewport: { width: 412, height: 915 } });
real.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await real.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await real.waitForTimeout(600);

const proto = await real.evaluate(async () => ({
  exists: typeof window.__dshHudCommand === "function",
  empty: await window.__dshHudCommand?.("send", { text: "   " }),
  unknown: await window.__dshHudCommand?.("ping", null),
  stopIdle: await window.__dshHudCommand?.("stop", null),
}));

check("协议：生产版 handler 已安装", proto.exists === true);
check("协议：空白内容被拒", proto.empty === "empty", `ret=${proto.empty}`);
check("协议：未知动作返回 unknown", proto.unknown === "unknown", `ret=${proto.unknown}`);
check("协议：空闲时停止返回 idle", proto.stopIdle === "idle", `ret=${proto.stopIdle}`);

await real.close();

await browser.close();
server.close();

console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败（通过 ${pass}）`);
  process.exit(1);
} else {
  console.log(`全部通过（${pass} 项）`);
}
