/* ============================================================
   运行状态标（0.63.0）

   用户的原话是「DSH 也应该有一个可以代表正在运行的动效标」。

   背景：工具跑起来之后，屏幕可能十几秒没有任何变化，
   原来只有静态的「STEP 2」「正在思考…」—— 分不清在干活还是卡住了。

   这里守四件事：
     ① 运行中才有，结束就不该留着一个"永远在跳"的标
     ② 秒数会自己走，而且走的是真实起点（不是从 0 重算）
     ③ 刷新秒数不能重建 DOM —— 否则四格动画每 0.2 秒从头播，像抽搐
     ④ 关了动效就不能再动，保持「设置里关掉就是真关掉」
   ============================================================ */

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

async function boot() {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    const st = await import("./scripts/store.js");
    const s = st.activeSession() || st.createSession({ mode: "standard", title: "测试会话" });
    st.addMessage(s.id, {
      id: "m-run",
      role: "assistant",
      status: "running",
      ts: Date.now() - 5000,
      startedAt: Date.now() - 5000,
      content: "",
      reasoning: "先看看目录里有什么",
      tools: [],
      steps: 2,
      tokens: 100,
    });
    const ui = await import("./scripts/ui.js");
    ui.renderAll();
  });
  await page.waitForTimeout(300);
  return page;
}

/* ============================================================
   一、运行中：标在、秒数在走
   ============================================================ */

console.log("[1] 运行中");
const page = await boot();

const first = await page.evaluate(() => {
  const el = document.querySelector(".runbadge");
  const bar = el?.querySelector(".runbadge__bars i");
  return {
    exists: !!el,
    label: el?.querySelector(".runbadge__label")?.textContent || "",
    time: el?.querySelector(".runbadge__time")?.textContent || "",
    bars: el?.querySelectorAll(".runbadge__bars i").length || 0,
    anim: bar ? getComputedStyle(bar).animationName : "",
    dur: bar ? getComputedStyle(bar).animationDuration : "",
  };
});

check("运行中渲染出状态标", first.exists === true, "");
check("文案是「工作中」", first.label === "工作中", first.label);
check("四格跳动都在", first.bars === 4, `${first.bars} 格`);
check("四格挂上了动画", first.anim === "runBar", first.anim);
check("节奏是呼吸级的（>0.8s）", parseFloat(first.dur) >= 0.8, first.dur);
check("秒数按真实起点算（≥5 秒）", parseFloat(first.time) >= 5, first.time);

/* 秒数要自己走，而且不能靠重建 DOM 走 */
const before = await page.evaluate(() => {
  const el = document.querySelector(".runbadge");
  el.__probe = "same-node";
  return el.querySelector(".runbadge__time").textContent;
});
await page.waitForTimeout(900);
const after = await page.evaluate(() => {
  const el = document.querySelector(".runbadge");
  return { text: el.querySelector(".runbadge__time").textContent, same: el.__probe === "same-node" };
});

check("秒数自己会走", parseFloat(after.text) > parseFloat(before), `${before} → ${after.text}`);
check("刷新秒数没有重建节点（动画不会重播）", after.same === true, String(after.same));

/* ============================================================
   二、结束之后：标必须消失
   ============================================================ */

console.log("\n[2] 结束之后");
const done = await page.evaluate(async () => {
  const st = await import("/scripts/store.js");
  const ui = await import("/scripts/ui.js");
  const s = st.activeSession();
  const m = s.messages.find((x) => x.id === "m-run");
  m.status = "done";
  m.content = "纪要已整理好。";
  m.duration = 8200;
  ui.renderAll();
  await new Promise((r) => setTimeout(r, 300));
  return { badge: !!document.querySelector(".runbadge") };
});
check("结束后状态标消失", done.badge === false, "");

/* ============================================================
   三、关掉动效就真的不动
   ============================================================ */

console.log("\n[3] 动效开关");
const page2 = await boot();
const motionOff = await page2.evaluate(() => {
  document.documentElement.classList.add("no-motion");
  const bar = document.querySelector(".runbadge__bars i");
  const cs = getComputedStyle(bar);
  return {
    state: cs.animationPlayState,
    dur: cs.animationDuration,
    transform: cs.transform,
  };
});
check(
  "no-motion 下动画停住",
  motionOff.state === "paused" || parseFloat(motionOff.dur) < 0.01,
  `${motionOff.state} / ${motionOff.dur}`
);

await browser.close();
server.close();

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
