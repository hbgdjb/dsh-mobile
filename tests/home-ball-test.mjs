/* ============================================================
   首页小球（0.65.0）

   用户的原话是「把新任务开始前中间那个球，换成我们悬浮窗上那个小球」。

   原来那颗是纯 CSS 画的静态球（.orb + 两只眼睛 + 上下浮动）。
   现在换成 DshBall —— 悬浮窗用的同一份代码，会眨眼、呼吸、眼神跟着手指走。

   这里守五件事：
     ① 首页给的是画布，旧 CSS 球彻底退场（不留死样式）
     ② 冷启动（还没有会话）就得有球 —— 这条曾经真的挂不上
     ③ 重渲染不能重建画布：重建会让动画从第 0 帧重来，看着像抽搐
     ④ 离开对话页要停 rAF，回来要接着动（不能白耗电，也不能回来是死的）
     ⑤ 关掉动效 / 系统减少动效时只画一帧静态球
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

async function boot(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  if (opts.reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.DshSplash?.exit?.());
  await page.waitForTimeout(1400);
  return page;
}

/* ============================================================
   一、长相：画布在、旧球没了
   ============================================================ */

console.log("[1] 首页那颗球");
const page = await boot();

const look = await page.evaluate(() => {
  const c = document.querySelector("#home-ball");
  const ctx = c?.getContext("2d");
  const mid = c ? ctx.getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1).data : null;
  return {
    hasCanvas: !!c,
    hasLegacyOrb: !!document.querySelector(".orb"),
    hasLegacyEye: !!document.querySelector(".orb__eye"),
    inlineSize: c?.getAttribute("style") || "",
    bitmap: c ? [c.width, c.height] : null,
    dpr: window.devicePixelRatio,
    midAlpha: mid ? mid[3] : 0,
    // 球体是蓝底 + 浅色肚皮，取一个不透明的非纯黑像素就说明确实画了东西
    midColor: mid ? [mid[0], mid[1], mid[2]].join(",") : "",
  };
});

check("首页渲染出画布 #home-ball", look.hasCanvas === true, "");
check("旧的 CSS 球已经退场", look.hasLegacyOrb === false && look.hasLegacyEye === false, "");
check("画布按 side 设了内联尺寸（72 → 115.2）", /115\.2px/.test(look.inlineSize), look.inlineSize);
check(
  "位图按 DPR 放大",
  look.bitmap && look.bitmap[0] === Math.round(72 * 1.6 * look.dpr),
  `${look.bitmap} @${look.dpr}x`
);
check("球真的画上去了（像素不透明）", look.midAlpha === 255, `alpha ${look.midAlpha} / rgb ${look.midColor}`);

/* ============================================================
   二、重渲染不重开动画
   ============================================================ */

console.log("\n[2] 重渲染");
const before = await page.evaluate(async () => {
  const c = document.querySelector("#home-ball");
  const ball = c.__dshBall;
  const ui = await import("/scripts/ui.js");
  ui.renderAll();
  await new Promise((r) => setTimeout(r, 200));
  const next = document.querySelector("#home-ball");
  return {
    // 整块重绘会换掉 canvas 节点，但球要接着同一份状态画
    sameBall: next.__dshBall === ball,
    only: document.querySelectorAll("#home-ball").length,
    size: next.getAttribute("style"),
  };
});
check("重渲染沿用同一颗球（动画不从第 0 帧重来）", before.sameBall === true, "");
check("没有出现第二块画布", before.only === 1, `${before.only} 块`);
check("重绑后尺寸仍然正确", /115\.2px/.test(before.size), before.size);

/* ============================================================
   三、离开对话页停、回来接着动
   ============================================================ */

console.log("\n[3] 切页");
const away = await page.evaluate(async () => {
  document.querySelector('[data-act="tab"][data-view="workspace"]')?.click();
  await new Promise((r) => setTimeout(r, 350));
  const c = document.querySelector("#home-ball");
  const a = c.toDataURL();
  await new Promise((r) => setTimeout(r, 450));
  const b = c.toDataURL();
  return { hidden: document.querySelector("#view-workspace")?.dataset.active === "true", frozen: a === b };
});
check("切到工作区", away.hidden === true, "");
check("离开后 rAF 停下（画面不再变）", away.frozen === true, "");

const back = await page.evaluate(async () => {
  document.querySelector('[data-act="tab"][data-view="chat"]')?.click();
  await new Promise((r) => setTimeout(r, 300));
  const c = document.querySelector("#home-ball");
  const a = c.toDataURL();
  await new Promise((r) => setTimeout(r, 500));
  const b = c.toDataURL();
  return { moving: a !== b };
});
check("回到对话页又动起来", back.moving === true, "");

/* ============================================================
   四、发消息之后：画布随首页一起消失
   ============================================================ */

console.log("\n[4] 有消息之后");
const withMsg = await page.evaluate(async () => {
  const st = await import("/scripts/store.js");
  const ui = await import("/scripts/ui.js");
  const s = st.activeSession() || st.createSession({ mode: "standard", title: "测试会话" });
  st.addMessage(s.id, { id: "m1", role: "user", status: "done", ts: Date.now(), content: "你好", tools: [] });
  ui.renderAll();
  await new Promise((r) => setTimeout(r, 300));
  return { canvas: !!document.querySelector("#home-ball"), msgs: document.querySelectorAll(".msg").length };
});
check("有消息后首页画布被移除", withMsg.canvas === false, "");
check("消息正常渲染", withMsg.msgs >= 1, `${withMsg.msgs} 条`);

/* ============================================================
   五、动效开关 / 系统偏好
   ============================================================ */

console.log("\n[5] 静态模式");
const calm = await page.evaluate(async () => {
  const st = await import("/scripts/store.js");
  const ui = await import("/scripts/ui.js");
  // 回到空会话：画布要重新出现
  const s = st.createSession({ mode: "standard", title: "空会话" });
  st.switchSession(s.id);
  st.setSettings({ motion: false });
  ui.renderAll();
  await new Promise((r) => setTimeout(r, 300));
  const c = document.querySelector("#home-ball");
  if (!c) return { missing: true };
  const a = c.toDataURL();
  await new Promise((r) => setTimeout(r, 450));
  const b = c.toDataURL();
  return { missing: false, still: a === b, painted: c.toDataURL().length > 2000 };
});
check("关掉动效后球还在", calm.missing === false, "");
check("关掉动效后画面不动", calm.still === true, "");
check("静态模式下也画满了球（不是空白画布）", calm.painted === true, "");

/* 系统偏好：prefers-reduced-motion */
const page2 = await boot({ reducedMotion: true });
const sys = await page2.evaluate(async () => {
  const c = document.querySelector("#home-ball");
  if (!c) return { missing: true };
  const a = c.toDataURL();
  await new Promise((r) => setTimeout(r, 450));
  return { missing: false, still: a === b2(c), painted: a.length > 2000 };
  function b2(el) {
    return el.toDataURL();
  }
});
check("系统要求减少动效时也静态", sys.missing === false && sys.still === true, "");
check("（同上）不是空白画布", sys.painted === true, "");

await browser.close();
server.close();

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
