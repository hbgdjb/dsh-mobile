#!/usr/bin/env node
/* ============================================================
   四种协议跑完整对话（含一次工具调用）

   ============ 这个测试在补哪条缝 ============

   formats-test 测的是"翻译"本身：给一段响应，能不能解析对。
   但真正会出问题的是**来回**：模型要工具 → 我们执行 → 把结果翻译
   回它认识的形状 → 它接着说。

   这一步四家的差别最大：
     · OpenAI   → {role:"tool", tool_call_id}
     · Anthropic→ {role:"user", content:[{type:"tool_result"}]}
     · Gemini   → {role:"user", parts:[{functionResponse}]}
     · Ollama   → {role:"tool", tool_name}

   翻错任何一处，第二轮就会 400 —— 用户看到的是"模型不回了"。

   用法：node tests/format-chat-test.mjs
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
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";
try {
  await readFile(CHROME).catch(() => {});
} catch {
  console.log("跳过：没有 Chromium");
  process.exit(0);
}

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

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });

/** 假上游：按路径认出是哪家协议，第一轮给工具调用，第二轮给结论。 */
await ctx.addInitScript(() => {
  window.__reqs = [];
  window.__round = 0;

  const sseLines = (arr) => arr.map((x) => `data: ${JSON.stringify(x)}\n\n`).join("");

  const openaiRound = (second) =>
    second
      ? sseLines([
          { choices: [{ delta: { content: "结果是 2" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 20 } },
        ]) + "data: [DONE]\n\n"
      : sseLines([
          { choices: [{ delta: { content: "我来算" } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "calc", arguments: '{"expression":"1+1"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]) + "data: [DONE]\n\n";

  const anthropicRound = (second) =>
    second
      ? [
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"结果是 2"}}',
          "",
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
          "",
        ].join("\n")
      : [
          'event: message_start',
          'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
          "",
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我来算"}}',
          "",
          'event: content_block_start',
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"calc"}}',
          "",
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"expression\\":\\"1+1\\"}"}}',
          "",
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}',
          "",
        ].join("\n");

  const geminiRound = (second) =>
    second
      ? sseLines([
          { candidates: [{ content: { parts: [{ text: "结果是 2" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 } },
        ])
      : sseLines([
          { candidates: [{ content: { parts: [{ text: "我来算" }] } }] },
          { candidates: [{ content: { parts: [{ functionCall: { name: "calc", args: { expression: "1+1" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 } },
        ]);

  const ollamaRound = (second) =>
    second
      ? '{"message":{"role":"assistant","content":"结果是 2"},"done":false}\n' +
        '{"done":true,"done_reason":"stop","prompt_eval_count":9,"eval_count":4}\n'
      : '{"message":{"role":"assistant","content":"我来算"},"done":false}\n' +
        '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"calc","arguments":{"expression":"1+1"}}}]},"done":false}\n' +
        '{"done":true,"done_reason":"stop","prompt_eval_count":8,"eval_count":2}\n';

  const orig = window.fetch;
  window.fetch = function (url, opts) {
    const u = String(url);
    if (!u.includes("api.test.local")) return orig.call(window, url, opts);

    let body = {};
    try {
      body = JSON.parse(opts && opts.body ? opts.body : "{}");
    } catch {
      body = {};
    }
    window.__reqs.push({ url: u, headers: (opts && opts.headers) || {}, body });

    const second = window.__round > 0;
    window.__round += 1;

    const text = (s, type = "text/event-stream") =>
      Promise.resolve(new Response(s, { status: 200, headers: { "content-type": type } }));

    if (u.includes("/v1/messages")) return text(anthropicRound(second));
    if (u.includes(":streamGenerateContent")) return text(geminiRound(second));
    if (u.includes("/api/chat")) return text(ollamaRound(second), "application/x-ndjson");
    return text(openaiRound(second));
  };
});

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(3600);

/**
 * 跑一轮：模型先要工具，工具执行完再总结。
 * 返回 UI 上的最终文本、工具卡、以及两次请求的原文。
 */
async function runOnce({ id, format, providerKey, baseUrl, apiModel }) {
  return await page.evaluate(
    async (cfg) => {
      const store = await import("/scripts/store.js");
      const rt = await import("/scripts/runtime.js");

      store.setSettings({
        model: cfg.id,
        keys: { [cfg.providerKey]: "sk-test" },
        customModels: [
          {
            id: cfg.id,
            label: cfg.id,
            apiModel: cfg.apiModel,
            baseUrl: cfg.baseUrl,
            providerKey: cfg.providerKey,
            format: cfg.format,
            ctx: 32000,
            vision: false,
            supportsEffort: false,
          },
        ],
        memoryEnabled: false,
        maxSteps: 2,
      });

      window.__reqs = [];
      window.__round = 0;

      const session = store.createSession({ mode: "standard", title: cfg.id });
      const msg = {
        id: `probe-${cfg.id}`,
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
          text: "算一下 1+1",
          msg,
          attachments: [],
          signal: ac.signal,
          onChange: () => {},
        });
      } catch (e) {
        err = e && e.message ? e.message : String(e);
      }

      return {
        status: msg.status,
        content: msg.content,
        error: err || msg.error || "",
        tools: (msg.tools || []).map((t) => ({ name: t.name, status: t.status, output: String(t.output || "") })),
        reqs: window.__reqs,
      };
    },
    { id, format, providerKey, baseUrl, apiModel }
  );
}

console.log("\n四种协议各跑一轮（工具调用 → 结果回灌）\n");

/* ---------------- OpenAI 兼容 ---------------- */
{
  const r = await runOnce({
    id: "fmt-openai",
    format: "openai",
    providerKey: "custom",
    baseUrl: "https://api.test.local/v1",
    apiModel: "probe-openai",
  });
  check("OpenAI：对话完成并带出结论", r.status === "done" && /结果是 2/.test(r.content), r.content.slice(0, 40));
  check("OpenAI：工具真的执行了", r.tools.length === 1 && r.tools[0].name === "calc" && /1\+1 = 2/.test(r.tools[0].output), JSON.stringify(r.tools));
  check("OpenAI：打了两次请求", r.reqs.length === 2, `reqs=${r.reqs.length}`);
  const second = r.reqs[1] || { body: {} };
  const toolMsg = (second.body.messages || []).find((m) => m.role === "tool");
  check("OpenAI：工具结果以 role=tool 回灌", !!toolMsg && toolMsg.tool_call_id === "call_1", JSON.stringify(toolMsg && toolMsg.role));
}

/* ---------------- Anthropic ---------------- */
{
  const r = await runOnce({
    id: "fmt-anthropic",
    format: "anthropic",
    providerKey: "anthropic",
    baseUrl: "https://api.test.local/anth",
    apiModel: "claude-probe",
  });
  check("Anthropic：对话完成并带出结论", r.status === "done" && /结果是 2/.test(r.content), r.content.slice(0, 40));
  check("Anthropic：工具真的执行了", r.tools.length === 1 && r.tools[0].name === "calc" && /1\+1 = 2/.test(r.tools[0].output), JSON.stringify(r.tools));
  const req = r.reqs[0] || { headers: {}, body: {} };
  check("Anthropic：走 /v1/messages 且用 x-api-key", /\/anth\/v1\/messages$/.test(req.url) && req.headers["x-api-key"] === "sk-test", req.url);
  check("Anthropic：max_tokens 必填项带上了", Number(req.body.max_tokens) > 0, String(req.body.max_tokens));
  const second = r.reqs[1] || { body: {} };
  const last = (second.body.messages || [])[second.body.messages.length - 1] || {};
  check(
    "Anthropic：工具结果并进 user.tool_result",
    last.role === "user" && Array.isArray(last.content) && last.content[0] && last.content[0].type === "tool_result",
    JSON.stringify(last.role)
  );
}

/* ---------------- Gemini ---------------- */
{
  const r = await runOnce({
    id: "fmt-gemini",
    format: "gemini",
    providerKey: "google",
    baseUrl: "https://api.test.local/gem/v1beta",
    apiModel: "gemini-probe",
  });
  check("Gemini：对话完成并带出结论", r.status === "done" && /结果是 2/.test(r.content), r.content.slice(0, 40));
  check("Gemini：工具真的执行了", r.tools.length === 1 && r.tools[0].name === "calc" && /1\+1 = 2/.test(r.tools[0].output), JSON.stringify(r.tools));
  const req = r.reqs[0] || { url: "", headers: {}, body: {} };
  check("Gemini：走 :streamGenerateContent?alt=sse", /:streamGenerateContent\?alt=sse$/.test(req.url), req.url);
  check("Gemini：Key 在 header 不在 URL", req.headers["x-goog-api-key"] === "sk-test" && req.url.indexOf("key=") < 0);
  const second = r.reqs[1] || { body: {} };
  const contents = second.body.contents || [];
  const lastParts = (contents[contents.length - 1] || {}).parts || [];
  check(
    "Gemini：工具结果以 functionResponse 回灌",
    lastParts[0] && lastParts[0].functionResponse && lastParts[0].functionResponse.name === "calc",
    JSON.stringify(lastParts[0] && Object.keys(lastParts[0]))
  );
}

/* ---------------- Ollama 原生 ---------------- */
{
  const r = await runOnce({
    id: "fmt-ollama",
    format: "ollama",
    providerKey: "ollamaNative",
    baseUrl: "https://api.test.local/oll",
    apiModel: "qwen2.5:7b",
  });
  check("Ollama：对话完成并带出结论", r.status === "done" && /结果是 2/.test(r.content), r.content.slice(0, 40));
  check("Ollama：工具真的执行了", r.tools.length === 1 && r.tools[0].name === "calc" && /1\+1 = 2/.test(r.tools[0].output), JSON.stringify(r.tools));
  const req = r.reqs[0] || { url: "", body: {} };
  check("Ollama：走 /api/chat", /\/oll\/api\/chat$/.test(req.url), req.url);
  const second = r.reqs[1] || { body: {} };
  const msgs = second.body.messages || [];
  check("Ollama：工具结果以 role=tool 回灌", msgs.some((m) => m.role === "tool"), JSON.stringify(msgs.map((m) => m.role)));
}

check("全程没有 JS 报错", errors.length === 0, errors.join(" | ").slice(0, 120));

await browser.close();
server.close();
console.log(`\n${failed ? "失败 " + failed + " 项" : "全部通过"}`);
process.exit(failed ? 1 : 0);
