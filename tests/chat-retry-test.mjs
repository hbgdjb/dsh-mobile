/**
 * 模型请求重试的端到端测试（UI 层）
 *
 * ============ 这套测试在补哪条缝 ============
 *
 * `retry-test.mjs` 测的是纯逻辑：该不该重试、等多久。
 * 但在真实链路里，还有两件事只有跑起来才知道：
 *
 *   1. 第一次 503、第二次 200 时，界面上的消息能不能正常出结果
 *   2. 「已经吐了一半字」到底判得准不准 —— 判错就会重复输出
 *
 * 这里用一个假端点把 HTTP 层接过来，跑完整的 runAgent。
 *
 * 用法：node tests/chat-retry-test.mjs
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
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });

/**
 * 假模型端点。
 *
 * 行为由 window.__plan 控制，测试可以在运行时改：
 *   { fails: 2, status: 503 }  前两次返回错误，第三次正常
 *   { streamThenDie: true }    先吐一段，然后断开
 */
await ctx.addInitScript(() => {
  window.__plan = { fails: 0, status: 503 };
  window.__hits = 0;

  const sse = (text) =>
    [
      `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content: text } }] })}`,
      "",
      `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { total_tokens: 12 } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

  const orig = window.fetch;
  window.fetch = function (url, opts) {
    const u = String(url);
    if (!u.includes("api.test.local")) return orig.call(window, url, opts);

    window.__hits += 1;
    const plan = window.__plan;

    if (plan.fails > 0) {
      plan.fails -= 1;
      const headers = { "content-type": "application/json" };
      if (plan.retryAfter) headers["retry-after"] = String(plan.retryAfter);
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: "服务端繁忙" } }), {
          status: plan.status || 503,
          headers,
        })
      );
    }

    if (plan.streamThenDie) {
      // 吐一段就断：模拟流式中途断网
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content: "前半段" } }] })}\n\n`
            )
          );
          setTimeout(() => controller.error(new Error("连接被重置")), 30);
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    }

    return Promise.resolve(
      new Response(sse(plan.reply || "你好，我是模型。"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );
  };
});

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(4200); // 启动动画

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

/** 配好一个假模型，并跑一轮对话。 */
async function runOnce(plan) {
  return await page.evaluate(async (p) => {
    const store = await import("/scripts/store.js");
    const rt = await import("/scripts/runtime.js");

    store.setSettings({
      model: "retry-probe",
      keys: { custom: "sk-test" },
      customModels: [
        {
          id: "retry-probe",
          label: "重试探针",
          apiModel: "probe",
          baseUrl: "https://api.test.local/v1",
          providerKey: "custom",
          ctx: 32000,
          vision: false,
          supportsEffort: false,
        },
      ],
      memoryEnabled: false,
      maxSteps: 1,
    });

    window.__plan = p;
    window.__hits = 0;

    const session = store.createSession({ mode: "standard", title: "重试测试" });
    const msg = {
      id: "probe-1",
      role: "assistant",
      content: "",
      reasoning: "",
      tools: [],
      steps: 0,
      status: "running",
      createdAt: Date.now(),
    };
    session.messages.push(msg);

    const ac = new AbortController();
    await rt.runAgent({
      session,
      text: "说点什么",
      msg,
      attachments: [],
      signal: ac.signal,
      onChange: () => {},
    });

    return {
      hits: window.__hits,
      status: msg.status,
      content: msg.content,
      error: msg.error || "",
      retry: msg.retry || null,
    };
  }, plan);
}

console.log("\n端到端\n");

/* ---------------- 一、503 → 重试 → 成功 ---------------- */

// 第一次 503，第二次成功。退避是 ~800ms，等它跑完
const r1 = await runOnce({ fails: 1, status: 503, reply: "重试之后成功了" });
check("503 之后自动重试并拿到结果", r1.status === "done" && r1.content.includes("重试之后成功了"), JSON.stringify(r1));
check("确实打了两次请求", r1.hits === 2, `hits=${r1.hits}`);
check("成功后清掉了重试提示", r1.retry === null, JSON.stringify(r1.retry));

/* ---------------- 二、401 不重试 ---------------- */

const r2 = await runOnce({ fails: 3, status: 401 });
check("401 一次就停（Key 错重试无意义）", r2.hits === 1, `hits=${r2.hits}`);
check("401 报的是鉴权类错误", r2.status === "error" && /Key|401|鉴权|认证/i.test(r2.error), r2.error.slice(0, 60));

/* ---------------- 三、已经吐字后断流 → 不重试 ---------------- */

const r3 = await runOnce({ streamThenDie: true });
check("流式中途断掉只打一次（避免重复输出）", r3.hits === 1, `hits=${r3.hits}`);
check("断流后状态是错误，不是假装完成", r3.status === "error", r3.status);
check("已经显示过的半段没有丢", r3.content.includes("前半段"), r3.content.slice(0, 40));

/* ---------------- 四、Retry-After 太长 → 不自动等 ---------------- */

const r4 = await runOnce({ fails: 1, status: 429, retryAfter: 60 });
check("429 要求等 60 秒时不自动等", r4.hits === 1, `hits=${r4.hits}`);
check("错误里说明了要等多久", /60 秒/.test(r4.error), r4.error.slice(0, 80));

/* ---------------- 五、连续两次失败后成功 ---------------- */

const r5 = await runOnce({ fails: 2, status: 502, reply: "第三次终于通了" });
check("连续两次失败后仍然能成功", r5.status === "done" && r5.content.includes("第三次终于通了"), JSON.stringify(r5));
check("一共试了三次", r5.hits === 3, `hits=${r5.hits}`);

/* ---------------- 六、无报错 ---------------- */

check("全程没有 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
server.close();
console.log(failed ? `\n${failed} 项失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
