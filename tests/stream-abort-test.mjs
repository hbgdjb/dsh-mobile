#!/usr/bin/env node
/**
 * 「HTTP 200 之后断流」的回归
 *
 * ============ 这套测试在守什么 ============
 *
 * 截图里那条失败长这样：
 *
 *     ⚠ 请求失败（HTTP 200）。 · Software caused connection abort
 *      连接失败 · 200
 *
 * HTTP 200 和「失败」同时出现，本身就说明状态码被用错了地方。
 * 实际链路是：
 *
 *     1. 服务端返回 200，请求已经连上
 *     2. 读 SSE 流时 socket 被对端/中间网络掐断
 *     3. 原生桥报 error，status = 0
 *     4. runtime 写成 `code = err.httpStatus || status` → 0 || 200 = 200
 *     5. 200 被当成错误码：文案「请求失败（HTTP 200）」，
 *        重试层看到 200 判定不可重试，状态条显示「连接失败 · 200」
 *
 * 于是一次流抖动直接终结整轮对话。工具循环每多一步就多一次断流机会，
 * 越长的任务越容易失败 —— 这就是「为什么容易请求失败」。
 *
 * 这里同时守两层：
 *   · 纯逻辑：streamBroken 可重试、produced 优先、英文报错翻中文
 *   · 端到端：真的走原生桥，200→断流 能自动重试；已吐字则不重试且说清原因
 *
 * 用法：node tests/stream-abort-test.mjs
 */
import assert from "node:assert";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { retryable, withRetry } from "../scripts/retry.js";
import { humanizeNetworkError } from "../scripts/native-http.js";

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${e && e.message ? e.message : e}`);
  }
};

console.log("\n纯逻辑\n");

test("streamBroken 可重试（此前 200 让它被判成终局）", () => {
  const err = Object.assign(new Error("响应中途断开"), { httpStatus: 0, streamBroken: true });
  assert.equal(retryable(err), true);
});

test("已经吐过字仍然不重试，哪怕 streamBroken", () => {
  const err = Object.assign(new Error("响应中途断开"), {
    httpStatus: 0,
    streamBroken: true,
    produced: true,
  });
  assert.equal(retryable(err), false);
});

test("真的 HTTP 200 不会被当成可重试错误", () => {
  // 200 只可能来自"这条请求成功了"，不该出现在错误对象上。
  // 保留这条断言，防止有人又把 status 直接塞进 httpStatus。
  assert.equal(retryable(Object.assign(new Error("x"), { httpStatus: 200 })), false);
});

test("503 仍然可重试，401 仍然不可重试", () => {
  assert.equal(retryable(Object.assign(new Error("x"), { httpStatus: 503 })), true);
  assert.equal(retryable(Object.assign(new Error("x"), { httpStatus: 401 })), false);
});

test("Software caused connection abort 翻成中文", () => {
  const t = humanizeNetworkError("SocketException: Software caused connection abort");
  assert.ok(t.includes("连接已建立后被中断"), t);
  assert.ok(!/SocketException/.test(t), t);
});

test("断流重试三次仍失败时，错误对象还带着 streamBroken", async () => {
  let n = 0;
  const err = Object.assign(new Error("响应中途断开"), { httpStatus: 0, streamBroken: true });
  await assert.rejects(
    withRetry(
      async () => {
        n += 1;
        throw err;
      },
      { attempts: 3 }
    ),
    (e) => e.streamBroken === true
  );
  assert.equal(n, 3);
});

console.log(`\n纯逻辑：${passed} 通过，${failed} 失败\n`);

/* ---------------- 端到端 ---------------- */

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
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(4200);

let e2eFailed = 0;
let e2ePassed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (ok) e2ePassed += 1;
  else e2eFailed += 1;
};

/**
 * 装一个假的原生桥。
 *
 * 为什么必须走原生分支：截图里的错误是 Android 的 SocketException，
 * 浏览器 fetch 分支根本走不到那段代码 —— 只在 fetch 上打桩永远测不到。
 */
async function installBridge() {
  await page.evaluate(() => {
    window.__hits = 0;
    window.__plan = { mode: "ok" };
    const frame = (text) =>
      `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content: text } }] })}\n\n` +
      `data: ${JSON.stringify({
        id: "1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { total_tokens: 12 },
      })}\n\n` +
      "data: [DONE]\n\n";

    window.DshNative = {
      postStream(id, url, headers, body, timeoutSec, method, firstByteSec, connectSec) {
        window.__hits += 1;
        const n = window.__hits;
        const plan = window.__plan;
        const send = (o, delay) =>
          setTimeout(() => window.__dshNativeEvent(JSON.stringify({ id, ...o })), delay);
        const die = (delay) =>
          send(
            {
              type: "error",
              status: 0,
              message: "SocketException: Software caused connection abort",
              body: "",
            },
            delay
          );

        if (plan.mode === "stall" && n === 1) {
          send({ type: "status", status: 200 }, 5);
          die(40);
          return;
        }
        if (plan.mode === "stallAfterText" && n === 1) {
          send({ type: "status", status: 200 }, 5);
          send(
            {
              type: "chunk",
              data: `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content: "我先说一句" } }] })}\n\n`,
            },
            10
          );
          die(50);
          return;
        }
        if (plan.mode === "stallAfterTextTwice" && n <= 2) {
          send({ type: "status", status: 200 }, 5);
          send(
            {
              type: "chunk",
              data: `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content: `半截${n}` } }] })}\n\n`,
            },
            10
          );
          die(50);
          return;
        }
        if (plan.mode === "finishThenDie" && n === 1) {
          // 发到 finish_reason 就断，收尾的 [DONE] 没发出来 ——
          // 网关最常见的"发完就关连接"。
          send({ type: "status", status: 200 }, 5);
          send(
            {
              type: "chunk",
              data:
                `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content: plan.reply || "整段都在" } }] })}\n\n` +
                `data: ${JSON.stringify({
                  id: "1",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: { total_tokens: 9 },
                })}\n\n`,
            },
            10
          );
          die(45);
          return;
        }
        send({ type: "status", status: 200 }, 5);
        send({ type: "chunk", data: frame(plan.reply || "好了") }, 10);
        send({ type: "end" }, 25);
      },
      abort() {},
    };
  });
}

async function runOnce(plan) {
  return await page.evaluate(async (p) => {
    const store = await import("/scripts/store.js");
    const rt = await import("/scripts/runtime.js");

    store.setSettings({
      model: "stream-probe",
      keys: { custom: "sk-test" },
      customModels: [
        {
          id: "stream-probe",
          label: "断流探针",
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

    const session = store.createSession({ mode: "standard", title: "断流测试" });
    const msg = {
      id: `probe-${Date.now()}`,
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
    let err = "";
    try {
      await rt.runAgent({
        session,
        text: "说点什么",
        msg,
        attachments: [],
        signal: ac.signal,
        onChange: () => {},
      });
    } catch (e) {
      err = String((e && e.message) || e);
    }

    const st = store.modelStatusOf("stream-probe");
    return {
      hits: window.__hits,
      status: msg.status,
      content: msg.content,
      error: msg.error || err,
      retry: msg.retry || null,
      modelStatus: st ? { ok: st.ok, status: st.status, phase: st.phase || "", httpStatus: st.httpStatus || 0 } : null,
      banner:
        document.querySelector(".conn-note__text")?.textContent?.trim() ||
        document.querySelector(".conn-pill")?.textContent?.trim() ||
        "",
    };
  }, plan);
}

console.log("端到端（原生桥）\n");

await installBridge();

/* ---------------- 一、200 后立刻断：应当自动重试 ---------------- */

const a = await runOnce({ mode: "stall", reply: "重试之后好了" });
check("200 后断流会自动重试并拿到结果", a.status === "done" && a.content.includes("重试之后好了"), JSON.stringify(a));
check("确实打了两次请求", a.hits === 2, `hits=${a.hits}`);
check("状态码不再被当成 200 错误", !/HTTP 200）/.test(a.error), a.error);

/* ---------------- 二、200 后先吐字再断：回滚重发 ---------------- */

const b = await runOnce({ mode: "stallAfterText", reply: "重发之后好了" });
check("吐过字后断流会回滚重发", b.hits === 2, `hits=${b.hits}`);
check("回滚干净：半截内容没有留在消息里", !b.content.includes("我先说一句"), b.content);
check("重发后拿到完整结果", b.status === "done" && b.content.includes("重发之后好了"), b.content);

/* ---------------- 二·补、第二次还断：不再回滚，说清原因 ---------------- */

const b2 = await runOnce({ mode: "stallAfterTextTwice", reply: "不该出现" });
check("回滚只做一次：第二次断流不再重发", b2.hits === 2, `hits=${b2.hits}`);
check("第二次断流保留半截内容", b2.content.includes("半截2"), b2.content);
check("错误说明是「响应中途断开」", /响应中途断开/.test(b2.error), b2.error);
check("明确说明为什么没有自动重试", /没有自动重试/.test(b2.error), b2.error);
check("不再出现「请求失败（HTTP 200）」", !/请求失败（HTTP 200）/.test(b2.error), b2.error);
check("英文 SocketException 已翻成中文", !/SocketException|Software caused/.test(b2.error), b2.error);

/* ---------------- 三、状态条不再显示「连接失败 · 200」 ---------------- */

check("modelStatus 记的是网络错误而不是 HTTP 200", b2.modelStatus && b2.modelStatus.status === 0, JSON.stringify(b2.modelStatus));
check("modelStatus 标出了断流阶段", b2.modelStatus && b2.modelStatus.phase === "stream", JSON.stringify(b2.modelStatus));
check("保留了真实的 HTTP 200 供展示", b2.modelStatus && b2.modelStatus.httpStatus === 200, JSON.stringify(b2.modelStatus));

// 状态条文案由 ui.js 的 modelConnection 产出，它不在 chat 视图时不会重绘，
// 所以这里直接盯源码里的分支：断流走「响应中断」，不走 `连接失败 · ${status}`。
const uiSrc = await readFile(new URL("../scripts/ui.js", import.meta.url), "utf8");
const streamBranch = uiSrc.slice(uiSrc.indexOf('st.phase === "stream"'), uiSrc.indexOf('st.status === 429'));
check(
  "状态条写「响应中断」而不是「连接失败 · 200」",
  streamBranch.includes("响应中断") && !streamBranch.includes("连接失败"),
  streamBranch.replace(/\s+/g, " ").slice(0, 120)
);

/* ---------------- 四、finish_reason 已到、只差 [DONE] ---------------- */

const d = await runOnce({ mode: "finishThenDie", reply: "整段都在这里" });
check(
  "finish_reason 已到、只差 [DONE] 时按成功处理",
  d.status === "done" && d.content.includes("整段都在这里"),
  JSON.stringify(d)
);
check("这种收尾断流不重发（内容已经完整）", d.hits === 1, `hits=${d.hits}`);

/* ---------------- 五、连都没连上时不能冒充断流 ---------------- */

const c = await runOnce({ mode: "ok" });
check("正常请求仍然是 done", c.status === "done" && c.content.includes("好了"), JSON.stringify(c));
check("正常请求只打一次", c.hits === 1, `hits=${c.hits}`);
check("成功时没有断流标记", !c.modelStatus || c.modelStatus.phase !== "stream", JSON.stringify(c.modelStatus));

check("全程没有 JS 报错", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
server.close();

console.log(`\n结果：纯逻辑 ${passed} 通过 / ${failed} 失败；端到端 ${e2ePassed} 通过 / ${e2eFailed} 失败`);
if (failed + e2eFailed > 0) process.exit(1);
