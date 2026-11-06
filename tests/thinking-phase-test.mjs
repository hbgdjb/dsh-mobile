#!/usr/bin/env node
/* ============================================================
   思维链落地 + 运行阶段反馈（0.69.0）

   用户反馈："第二次询问时模型准备了约一分半，疑似是没有展现思维链
   导致的人误以为连接失败。"

   拆成两件事守：
     ① 解析层：各家网关的推理字段不统一，只认 reasoning_content 会
        把整段思考静默丢掉 —— 界面上就是"想了一分半啥也没有"。
     ② 渲染层：请求已送达但模型还没吐字的那段时间，必须明确说出
        "已连接 / 正在思考 / 可能要一分钟"，而不是只留一枚"工作中"。
   ============================================================ */

import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { FORMATS } from "../scripts/formats.js";

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
const sse = (data, event = "") => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

function feed(formatId, body) {
  let reasoning = "";
  let text = "";
  const parser = FORMATS[formatId].createStreamParser({
    onText: (t) => { text += t; },
    onReasoning: (t) => { reasoning += t; },
    onToolDelta: () => {},
  });
  for (let i = 0; i < body.length; i += 7) parser.feed(body.slice(i, i + 7));
  parser.flush();
  return { reasoning, text };
}

/* ============================================================
   一、解析层：推理字段别名
   ============================================================ */
console.log("\n[1] 思维链字段别名");

check(
  "OpenAI：reasoning_content 仍正常",
  feed("openai", sse({ choices: [{ delta: { reasoning_content: "先想想" } }] })).reasoning === "先想想"
);
for (const key of ["reasoning", "thought", "thinking"]) {
  check(
    `OpenAI：delta.${key} 不再被丢弃`,
    feed("openai", sse({ choices: [{ delta: { [key]: "嗯…" } }] })).reasoning === "嗯…"
  );
}
check(
  "OpenAI：非字符串推理字段不误入正文",
  feed("openai", sse({ choices: [{ delta: { reasoning: { text: "x" }, content: "正文" } }] })).text === "正文"
);
for (const key of ["reasoning_content", "reasoning", "thought", "thinking"]) {
  const whole = FORMATS.openai.parseWhole(
    JSON.stringify({ choices: [{ message: { content: "答", [key]: "想过了" }, finish_reason: "stop" }] })
  );
  check(`OpenAI 整包：message.${key}`, whole && whole.reasoning === "想过了");
}
check(
  "Anthropic：reasoning_delta",
  feed(
    "anthropic",
    sse({ type: "content_block_delta", delta: { type: "reasoning_delta", reasoning: "推一下" } }, "content_block_delta")
  ).reasoning === "推一下"
);
check(
  "Ollama：msg.reasoning",
  feed("ollama", `${JSON.stringify({ message: { content: "", reasoning: "本地想想" }, done: true })}\n`).reasoning ===
    "本地想想"
);

/* ============================================================
   二、渲染层：阶段标与空思维链占位
   ============================================================ */
console.log("\n[2] 运行阶段与等待反馈");

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const body = await readFile(join(ROOT, decodeURIComponent(url.pathname)));
    res.writeHead(200, { "content-type": MIME[extname(url.pathname)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

/** 改一条运行中消息的字段并重绘。 */
async function paint(patch, waitMs = 0) {
  return await page.evaluate(async ({ patch, waitMs }) => {
    const st = await import("./scripts/store.js");
    const s = st.activeSession() || st.createSession({ mode: "standard", title: "阶段测试" });
    let m = s.messages.find((x) => x.id === "m-phase");
    if (!m) {
      st.addMessage(s.id, {
        id: "m-phase",
        role: "assistant",
        status: "running",
        ts: Date.now(),
        startedAt: Date.now(),
        content: "",
        reasoning: "",
        tools: [],
        timeline: [],
        steps: 1,
        phase: "connecting",
      });
      m = s.messages.find((x) => x.id === "m-phase");
    }
    Object.assign(m, patch);
    const ui = await import("./scripts/ui.js");
    ui.renderAll();
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    const badge = document.querySelector(".runbadge");
    const pending = document.querySelector(".thinking-pending");
    return {
      badge: !!badge,
      label: badge?.querySelector(".runbadge__label")?.textContent || "",
      phase: badge?.dataset.phase || "",
      time: badge?.querySelector(".runbadge__time")?.textContent || "",
      pending: !!pending,
      hint: pending?.querySelector(".thinking-pending__hint")?.textContent || "",
      tag: pending?.querySelector(".thinking-pending__tag")?.textContent || "",
      body: document.querySelector(".msg__body")?.textContent || "",
    };
  }, { patch, waitMs });
}

const phases = [
  ["connecting", "正在连接…", "正在连接模型服务…"],
  ["waiting", "已连接 · 等待模型", "已连接，等待模型响应…"],
  ["thinking", "正在思考", "模型正在思考…"],
  ["streaming", "正在输出", "正在生成回答…"],
  ["acting", "执行工具中", "正在执行工具…"],
];
for (const [phase, label, body] of phases) {
  const v = await paint({ phase, status: "running", content: "", reasoning: "", tools: [], timeline: [] });
  check(`阶段 ${phase} 的状态标是「${label}」`, v.label === label && v.phase === phase, v.label);
  check(`阶段 ${phase} 的正文提示`, v.body.includes(body), v.body.trim().slice(0, 30));
}

const early = await paint({ phase: "waiting", startedAt: Date.now() - 3000 });
check("空思维链时占位卡出现", early.pending === true, "");
check("占位卡标明「尚未收到思维链」", early.tag.includes("尚未收到"), early.tag);
check("短等待时明确说连接正常", early.hint.includes("连接正常"), early.hint);

const mid = await paint({ phase: "waiting", startedAt: Date.now() - 30000 });
check("30 秒升级为「深度思考」提示", mid.hint.includes("深度思考"), mid.hint);

const long = await paint({ phase: "waiting", startedAt: Date.now() - 65000 });
check("65 秒说明「可能要 1 分钟以上」", long.hint.includes("1 分钟以上"), long.hint);
check("长等待仍明确说连接正常", long.hint.includes("连接正常"), long.hint);

const veryLong = await paint({ phase: "waiting", startedAt: Date.now() - 120000 });
check("两分钟后给出可操作建议", veryLong.hint.includes("停止后重试"), veryLong.hint);

const withReason = await paint({
  phase: "thinking",
  reasoning: "先看看目录里有什么",
  startedAt: Date.now() - 3000,
  timeline: [{ type: "reasoning", from: 0, to: 10 }],
});
check("思维链一到，占位卡立刻撤掉", withReason.pending === false, "");

const withContent = await paint({
  phase: "streaming",
  content: "已经写好。",
  reasoning: "",
  startedAt: Date.now() - 3000,
  timeline: [{ type: "text", from: 0, to: 5 }],
});
check("正文一到，占位卡也不留", withContent.pending === false, "");

const done = await paint({ phase: "thinking", status: "done", content: "完成。", reasoning: "", startedAt: Date.now() - 3000, timeline: [] });
check("结束后状态标消失", done.badge === false, "");
check("结束后占位卡消失", done.pending === false, "");

/* 秒数由计时器自己走，不该靠重建 DOM */
const ticking = await paint({ phase: "waiting", status: "running", content: "", reasoning: "", startedAt: Date.now() - 20000, timeline: [] }, 900);
check("等待秒数会自己走", parseFloat(ticking.time) >= 20, ticking.time);

/* 关掉动效就真的不动 */
const motion = await page.evaluate(() => {
  document.documentElement.classList.add("no-motion");
  const bar = document.querySelector(".thinking-pending__bars i");
  const pulse = document.querySelector(".thinking-pending__pulse");
  return bar ? { bar: getComputedStyle(bar).animationName, pulse: getComputedStyle(pulse).animationName } : null;
});
check("no-motion 下占位卡动画停住", motion && motion.bar === "none" && motion.pulse === "none", JSON.stringify(motion));

await browser.close();
server.close();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
