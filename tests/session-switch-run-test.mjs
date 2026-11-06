#!/usr/bin/env node
/* ============================================================
   运行中切到别的会话（0.73.0）

   0.72.0 的隔离只做了存储层，界面还留着一个洞：
   A 会话在跑，用户切到 B 去写东西，发送键仍显示成绿色的「引导」。
   点下去 steerRun 发现 sessionId 不匹配直接 return —— 表现就是
   「打了字、点了发送，什么都没发生」。

   这一版：引导只属于正在看的那个会话；别的会话在跑时给一条可点的
   横条，会话列表也标出运行中。发送被拦下时要说清楚原因。
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
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.goto(`${ORIGIN}/index.html`, { waitUntil: "networkidle" });

/* 先建两个会话，再刷新，让界面按正常启动流程挂上 */
const ids = await page.evaluate(async () => {
  const st = await import("/scripts/store.js");
  const B = st.createSession({ mode: "standard", title: "另一个会话" });
  const A = st.createSession({ mode: "standard", title: "后台任务" });
  return { A: A.id, B: B.id };
});
await page.reload({ waitUntil: "networkidle" });
await page.evaluate(() => window.DshSplash?.exit?.());
await page.waitForTimeout(900);

/* 模型与假上游：第 1 轮拖 5 秒，留出切会话的时间 */
await page.evaluate(async () => {
  const st = await import("/scripts/store.js");
  st.setSettings({
    model: "run-probe",
    keys: { custom: "sk-test" },
    customModels: [
      { id: "run-probe", label: "切会话探针", apiModel: "probe", baseUrl: "https://api.test.local/v1",
        providerKey: "custom", ctx: 32000, vision: false, supportsEffort: false },
    ],
    memoryEnabled: false,
  });
  const orig = window.fetch.bind(window);
  const line = (o) => "data: " + JSON.stringify(o) + "\n\n";
  window.__round = 0;
  window.fetch = function (url, opts) {
    if (!String(url).includes("api.test.local")) return orig(url, opts);
    window.__round += 1;
    const round = window.__round;
    const text =
      line({ choices: [{ index: 0, delta: { content: "完成" }, finish_reason: "stop" }] }) +
      "data: [DONE]\n\n";
    const mk = () => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    // 奇数轮拖住：用来制造「运行中」；偶数轮立即返回，让引导后的收尾能跑完
    if (round % 2 === 1) return new Promise((r) => setTimeout(() => r(mk()), 5000));
    return Promise.resolve(mk());
  };
});

/* A 会话发一条，任务开始 */
await page.fill("#composer-input", "跑一个长任务");
await page.click("#send-btn");
await page.waitForTimeout(300);

const started = await page.evaluate(() => ({
  stopHidden: document.querySelector("#stop-live-btn")?.hidden,
  steer: document.querySelector("#send-btn")?.classList.contains("send--steer"),
  rounds: window.__round,
}));
check("A · 任务已启动、停止键可见", started.rounds === 1 && started.stopHidden === false, JSON.stringify(started));

/* 打开抽屉：运行中的会话要有标记 */
await page.click('[data-act="open-drawer"]');
await page.waitForTimeout(250);
const drawer = await page.evaluate(() => {
  const row = document.querySelector('.session-item[data-running="true"]');
  return {
    count: document.querySelectorAll('.session-item[data-running="true"]').length,
    title: row?.querySelector(".session-item__title")?.innerText || "",
    dot: !!row?.querySelector(".session-item__run"),
  };
});
check("抽屉 · 只有运行中的会话带标记", drawer.count === 1 && drawer.dot, JSON.stringify(drawer));
check("抽屉 · 标记落在「后台任务」上", drawer.title.includes("后台任务"), drawer.title);

/* 切到 B */
await page.click(`[data-act="open-session"][data-id="${ids.B}"]`);
await page.waitForTimeout(350);
const inB = await page.evaluate(() => ({
  active: document.querySelector(".session-item[data-active='true']")?.innerText || "",
  steer: document.querySelector("#send-btn")?.classList.contains("send--steer"),
  stopHidden: document.querySelector("#stop-live-btn")?.hidden,
  bannerHidden: document.querySelector("#run-away")?.hidden,
  banner: document.querySelector("#run-away .run-away__text")?.textContent || "",
}));
check("B · 发送键不再伪装成引导", inB.steer === false, String(inB.steer));
check("B · 停止键收起（避免误停别的会话）", inB.stopHidden === true, String(inB.stopHidden));
check("B · 出现「后台任务正在运行」横条", inB.bannerHidden === false && inB.banner.includes("后台任务"), JSON.stringify(inB));

/* B 里发送：应被明确拦下，而不是石沉大海 */
await page.fill("#composer-input", "这句不该发出去");
await page.click("#send-btn");
await page.waitForTimeout(300);
const blocked = await page.evaluate(async () => {
  const st = await import("/scripts/store.js");
  const b = st.state.sessions.find((x) => x.title === "另一个会话");
  const a = st.state.sessions.find((x) => x.title === "后台任务");
  return {
    toast: [...document.querySelectorAll("#toast-layer .toast")].map((x) => x.textContent).join(" | "),
    bMsgs: b?.messages.length || 0,
    aMsgs: a?.messages.length || 0,
    value: document.querySelector("#composer-input")?.value || "",
  };
});
check("B · 发送被拦下并说明原因", blocked.toast.includes("正在运行"), blocked.toast.slice(0, 90));
check("B · 没有生成消息，草稿仍保留", blocked.bMsgs === 0 && blocked.value.includes("这句不该发出去"), JSON.stringify(blocked));

/* 点横条回到 A，文字可以直接作为引导 */
await page.click("#run-away");
await page.waitForTimeout(350);
const back = await page.evaluate((aId) => ({
  active: window.__dshActive || null,
  title: document.querySelector(".appbar__title")?.innerText || "",
  steer: document.querySelector("#send-btn")?.classList.contains("send--steer"),
  stopHidden: document.querySelector("#stop-live-btn")?.hidden,
  bannerHidden: document.querySelector("#run-away")?.hidden,
}), ids.A);
const activeId = await page.evaluate(async () => (await import("/scripts/store.js")).state.activeSessionId);
check("横条 · 点一下回到运行中的会话", activeId === ids.A, `${activeId}`);
check("回到 A · 发送键恢复为引导、停止键回来", back.steer === true && back.stopHidden === false, JSON.stringify(back));
check("回到 A · 横条消失", back.bannerHidden === true, String(back.bannerHidden));

await page.click("#send-btn");
await page.waitForTimeout(350);
const steered = await page.evaluate(async () => {
  const st = await import("/scripts/store.js");
  const a = st.state.sessions.find((x) => x.title === "后台任务");
  return {
    steer: a?.messages.filter((m) => m.steer).map((m) => m.content) || [],
    toast: [...document.querySelectorAll("#toast-layer .toast")].map((x) => x.textContent).join(" | "),
  };
});
check("A · 引导真的落进当前会话", steered.steer.some((t) => t.includes("这句不该发出去")), JSON.stringify(steered.steer));
check("A · 给出「已加入引导」回执", steered.toast.includes("已加入引导"), steered.toast.slice(0, 80));

await page.waitForTimeout(5200);
const done = await page.evaluate(() => ({
  stopHidden: document.querySelector("#stop-live-btn")?.hidden,
  bannerHidden: document.querySelector("#run-away")?.hidden,
}));
check("结束后 · 停止键与横条都收回", done.stopHidden === true && done.bannerHidden === true, JSON.stringify(done));

/* 再验一次「没切回去、任务在后台结束」：横条要自己消失 */
await page.fill("#composer-input", "第二个长任务");
await page.click("#send-btn");
await page.waitForTimeout(250);
await page.click('[data-act="open-drawer"]');
await page.waitForTimeout(200);
await page.click(`[data-act="open-session"][data-id="${ids.B}"]`);
await page.waitForTimeout(300);
const awayRunning = await page.evaluate(() => ({
  bannerHidden: document.querySelector("#run-away")?.hidden,
  stopHidden: document.querySelector("#stop-live-btn")?.hidden,
}));
check("第二个任务 · 切到 B 后横条与停止键状态正确", awayRunning.bannerHidden === false && awayRunning.stopHidden === true, JSON.stringify(awayRunning));
await page.waitForTimeout(5400);
const awayDone = await page.evaluate(() => ({
  bannerHidden: document.querySelector("#run-away")?.hidden,
  stopHidden: document.querySelector("#stop-live-btn")?.hidden,
  steer: document.querySelector("#send-btn")?.classList.contains("send--steer"),
}));
check("后台结束后 · 横条自动消失、发送键回到普通态", awayDone.bannerHidden === true && awayDone.steer === false, JSON.stringify(awayDone));

await ctx.close();
await browser.close();
server.close();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
