#!/usr/bin/env node
/* ============================================================
   运行中的输入引导（0.70.0）

   之前 sendMessage 在 ui.run 存在时直接 return，发送键被换成「停止」，
   模型跑到一半用户想补一句指令，只能干等或干脆中断重发。

   现在：运行中输入框继续可用，文字作为「引导」排进队列，runtime 在
   工具循环边界注入 convo；模型准备收尾时补的指令也不会丢，会再跑一轮。

   本测试用假上游记录每次请求里的 messages，验证引导真的进了请求，
   而不是只在界面上冒了个泡。全程离线。
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

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};
const TAG = "用户在执行过程中补充的指令";

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

/** 直接调 runAgent：pollAt 指定第几次 takeSteer 吐出引导。 */
async function runtimeCase(page, { firstTool, pollAt, delay = 0 }) {
  return page.evaluate(async ({ firstTool, pollAt, delay }) => {
    const st = await import("/scripts/store.js");
    const rt = await import("/scripts/runtime.js");
    // CONFIG 里的 fetch 安装逻辑（这里重写一份，避免字符串拼接转义）
    st.setSettings({
      model: "steer-probe", keys: { custom: "sk-test" },
      customModels: [{ id: "steer-probe", label: "引导探针", apiModel: "probe",
        baseUrl: "https://api.test.local/v1", providerKey: "custom",
        ctx: 32000, vision: false, supportsEffort: false }],
      memoryEnabled: false,
    });
    const orig = window.fetch.bind(window);
    const line = (o) => "data: " + JSON.stringify(o) + "\n\n";
    window.__reqs = [];
    window.__round = 0;
    window.__firstTool = firstTool;
    window.fetch = function (url, opts) {
      if (!String(url).includes("api.test.local")) return orig(url, opts);
      window.__round += 1;
      const round = window.__round;
      try { window.__reqs.push(JSON.parse(opts.body).messages); } catch (e) {}
      const mk = (t) => new Response(t, { status: 200, headers: { "content-type": "text/event-stream" } });
      let text;
      if (firstTool && round === 1) {
        const args = JSON.stringify({ expression: "1+1" });
        text = line({ choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, id: "call_1", type: "function", function: { name: "calc", arguments: args },
        }] } }] }) + line({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
      } else {
        text = line({ choices: [{ index: 0, delta: { content: "完成" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
      }
      if (!delay) return Promise.resolve(mk(text));
      return new Promise((r) => setTimeout(() => r(mk(text)), delay));
    };

    const session = st.createSession({ mode: "standard", title: "引导测试" });
    const msg = { id: "a1", role: "assistant", content: "", reasoning: "", tools: [], steps: 0, status: "running", ts: Date.now() };
    session.messages.push(msg);
    let n = 0;
    await rt.runAgent({
      session, text: "初始任务", msg, attachments: [],
      signal: new AbortController().signal, onChange: () => {},
      pollSteer: () => { n += 1; return n === pollAt ? ["把标题改成 B"] : []; },
    });
    // 只认 role=user 的引导消息：系统提示里也写了「补充的指令」这几个字，
    // 不过滤 role 会把 system prompt 误判成引导。
    const steerMsgs = (msgs) =>
      (msgs || []).filter((m) => m.role === "user" && String(m.content || "").includes("执行过程中补充的指令"));
    return {
      rounds: window.__round,
      reqs: window.__reqs.length,
      firstHas: steerMsgs(window.__reqs[0]).length > 0,
      secondHas: steerMsgs(window.__reqs[1]).length > 0,
      tagCount: window.__reqs.reduce((n, msgs) => n + steerMsgs(msgs).length, 0),
      hasText: window.__reqs.some((msgs) =>
        (msgs || []).some((m) => m.role === "user" && String(m.content || "").includes("把标题改成 B"))
      ),
      steerCount: msg.steerCount || 0,
      steerPending: msg.steerPending || 0,
      status: msg.status,
      content: msg.content,
    };
  }, { firstTool, pollAt, delay });
}

/* ---------- A. runtime：工具循环边界注入 ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: "networkidle" });

  const a = await runtimeCase(page, { firstTool: true, pollAt: 2 });
  check("A · 引导前进了下一次请求", a.secondHas && a.hasText, `rounds=${a.rounds} reqs=${a.reqs}`);
  check("A · 不是启动时就塞进去（第 1 次请求没有引导）", a.firstHas === false, `firstHas=${a.firstHas}`);
  check("A · 引导只注入一次不重复", a.tagCount === 1, `tagCount=${a.tagCount}`);
  check("A · steerCount 记到消息上", a.steerCount === 1 && a.steerPending === 0, `count=${a.steerCount} pending=${a.steerPending}`);
  check("A · 跑完正常收尾", a.rounds === 2 && a.status === "done", `rounds=${a.rounds} status=${a.status}`);

  /* ---------- B. runtime：模型刚要收尾时补的指令不丢 ---------- */
  const b = await runtimeCase(page, { firstTool: false, pollAt: 2 });
  check("B · 收尾前的引导让模型再跑一轮", b.rounds === 2, `rounds=${b.rounds}`);
  check("B · 第二轮请求带着引导", b.secondHas && b.hasText, `secondHas=${b.secondHas}`);
  check("B · 两段回答之间留了空行", b.content.includes("\n\n"), JSON.stringify(b.content.slice(0, 40)));
  check("B · 状态仍是完成", b.status === "done", b.status);

  /* ---------- C. runtime：没有引导时行为不变 ---------- */
  const c = await runtimeCase(page, { firstTool: false, pollAt: -1 });
  check("C · 无引导时一轮就结束（回归）", c.rounds === 1 && c.status === "done", `rounds=${c.rounds} status=${c.status}`);
  check("C · 请求里没有引导包装", !c.hasText && c.tagCount === 0, `tagCount=${c.tagCount}`);

  /* ---------- D. 提示词规则 ---------- */
  const rules = await page.evaluate(async () => (await import("/scripts/prompt.js")).BEHAVIOR_RULES.join("\n"));
  check("D · 规则写明不要推倒重来", rules.includes("保留已完成工作") && rules.includes("补充的指令"), "");
  check("D · 规则写明拼接与写回的正确写法", rules.includes("cat a b > out") && rules.includes("sed -i"), "");
  await ctx.close();
}

/* ---------- E. UI：运行中输入、按钮、气泡、状态回执 ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => window.DshSplash?.exit?.());
  await page.waitForTimeout(900);

  await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    st.setSettings({
      model: "steer-probe", keys: { custom: "sk-test" },
      customModels: [{ id: "steer-probe", label: "引导探针", apiModel: "probe",
        baseUrl: "https://api.test.local/v1", providerKey: "custom",
        ctx: 32000, vision: false, supportsEffort: false }],
      memoryEnabled: false,
    });
    const orig = window.fetch.bind(window);
    const line = (o) => "data: " + JSON.stringify(o) + "\n\n";
    window.__reqs = [];
    window.__round = 0;
    window.fetch = function (url, opts) {
      if (!String(url).includes("api.test.local")) return orig(url, opts);
      window.__round += 1;
      const round = window.__round;
      try { window.__reqs.push(JSON.parse(opts.body).messages); } catch (e) {}
      const mk = (t) => new Response(t, { status: 200, headers: { "content-type": "text/event-stream" } });
      let text;
      if (round === 1) {
        const args = JSON.stringify({ expression: "1+1" });
        text = line({ choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, id: "call_1", type: "function", function: { name: "calc", arguments: args },
        }] } }] }) + line({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
      } else {
        text = line({ choices: [{ index: 0, delta: { content: "完成" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
      }
      // 第 1 次请求留足 900ms，保证「输入引导 → 待生效回执」这个窗口能被观察到
      return new Promise((r) => setTimeout(() => r(mk(text)), round === 1 ? 900 : 300));
    };
  });

  // 启动一轮运行（第 1 次请求有 420ms 延迟，留出输入引导的窗口）
  await page.fill("#composer-input", "初始任务");
  await page.click("#send-btn");
  await page.waitForTimeout(120);

  const duringEmpty = await page.evaluate(() => ({
    stopVisible: !document.querySelector("#stop-live-btn")?.hidden,
    placeholder: document.querySelector("#composer-input")?.placeholder || "",
    btnLabel: document.querySelector("#send-btn")?.getAttribute("aria-label") || "",
  }));
  check("E · 运行中停止入口独立可见", duringEmpty.stopVisible === true, "");
  check("E · 输入框提示改为可补充指令", duringEmpty.placeholder.includes("补充指令"), duringEmpty.placeholder);
  check("E · 没打字时主按钮仍是停止", duringEmpty.btnLabel.includes("停止"), duringEmpty.btnLabel);

  await page.fill("#composer-input", "补充：把标题改掉");
  await page.waitForTimeout(120);
  const typed = await page.evaluate(() => {
    const b = document.querySelector("#send-btn");
    return { steer: b?.classList.contains("send--steer"), label: b?.getAttribute("aria-label") || "", stop: b?.dataset.stop };
  });
  check("E · 打字后主按钮变成引导态", typed.steer === true && typed.label.includes("引导") && typed.stop === "false", JSON.stringify(typed));

  await page.click("#send-btn");
  await page.waitForTimeout(150);
  const after = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const s = (st.state.sessions || []).find((x) => x.id === st.state.activeSessionId);
    const m = s ? [...(s.messages || [])].reverse().find((x) => x.role === "assistant") : null;
    return {
      bubble: document.querySelector(".msg--steer")?.innerText || "",
      badge: document.querySelector(".msg__steer")?.innerText || "",
      value: document.querySelector("#composer-input")?.value || "",
      label: document.querySelector(".runbadge__label")?.innerText || "",
      pending: m?.steerPending, count: m?.steerCount, status: m?.status,
    };
  });
  check("E · 引导落成了带徽标的用户气泡", after.bubble.includes("补充：把标题改掉") && after.badge === "引导", JSON.stringify(after.bubble));
  check("E · 发送后输入框清空", after.value === "", JSON.stringify(after.value));
  check("E · 状态标给出「待生效」回执", after.label.includes("引导待生效"), `${after.label} | ${JSON.stringify({ pending: after.pending, count: after.count, status: after.status })}`);

  // 等第 1 次请求返回、工具跑完、第 2 次请求发出
  await page.waitForTimeout(1800);
  const served = await page.evaluate(() => ({
    rounds: window.__round,
    secondHas: (window.__reqs[1] || []).some((m) => m.role === "user" && String(m.content || "").includes("执行过程中补充的指令")),
    steerText: (window.__reqs[1] || []).some((m) => m.role === "user" && String(m.content || "").includes("补充：把标题改掉")),
    stopHidden: document.querySelector("#stop-live-btn")?.hidden,
    label: document.querySelector(".runbadge__label")?.innerText || "",
  }));
  check("E · 引导真的进了第 2 次请求", served.secondHas && served.steerText, `rounds=${served.rounds} secondHas=${served.secondHas}`);
  check("E · 运行结束后停止入口收回", served.stopHidden === true, String(served.stopHidden));
  const steerMeta = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const s = (st.state.sessions || []).find((x) => x.id === st.state.activeSessionId);
    const m = s ? [...(s.messages || [])].reverse().find((x) => x.role === "assistant") : null;
    return { count: m?.steerCount || 0, pending: m?.steerPending || 0 };
  });
  check("E · 生效后 steerCount 变为 1、待生效清零", steerMeta.count === 1 && steerMeta.pending === 0, JSON.stringify(steerMeta));

  await ctx.close();
}

await browser.close();
server.close();
const fail = results.filter((r) => !r.ok).length;
console.log(`\n结果：${results.length - fail} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
