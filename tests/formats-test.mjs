#!/usr/bin/env node
/* ============================================================
   四种接口协议的请求构造与流解析

   ============ 这个测试守的是什么 ============

   0.66 之前整站只会说一种话：OpenAI Chat Completions。
   现在 formats.js 里一家一个适配器，最容易出的错不是"完全不能用"，
   而是**差一点**：

     · Anthropic 的 system 还留在 messages 里 → 400
     · Gemini 的 schema 带了 additionalProperties → 400
     · Ollama 的 NDJSON 被当成 SSE → 一个字都读不出来
     · 工具参数分片拼错 → 工具拿到半个 JSON，静默失败

   这些都不会在界面上报错，只会表现为"这个模型好像不太行"。
   所以这里按字节喂：把 fixture 切成 5~9 个字符的块，验证解析
   不依赖分块边界 —— 真实网络就是这样一刀一刀切过来的。
   ============================================================ */

import assert from "node:assert";
import { FORMATS, accumulateToolCall } from "../scripts/formats.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${e && e.message ? e.message : e}`);
  }
}

/** 把一段文本切碎喂进去，模拟真实网络分块。 */
function feedInChunks(parser, text, size = 7) {
  for (let i = 0; i < text.length; i += size) parser.feed(text.slice(i, i + size));
  parser.flush();
}

function collect(formatId) {
  const out = { text: "", reasoning: "", calls: [], usage: null, finish: null };
  const calls = [];
  const parser = FORMATS[formatId].createStreamParser({
    onText: (t) => {
      out.text += t;
    },
    onReasoning: (t) => {
      out.reasoning += t;
    },
    onToolDelta: (deltas) => {
      (deltas || []).forEach((d) => accumulateToolCall(calls, d));
    },
    onUsage: (u) => {
      out.usage = u;
    },
  });
  return {
    parser,
    result() {
      out.calls = calls.filter(Boolean);
      out.finish = parser.finish;
      out.error = parser.error;
      return out;
    },
  };
}

const sse = (event, data) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

console.log("\n[1] 请求构造");

test("OpenAI：URL、Bearer、stream_options 与 reasoning_effort", () => {
  const req = FORMATS.openai.buildRequest({
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-1",
    modelId: "deepseek-chat",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    stream: true,
    temperature: 0.3,
    maxTokens: 0,
    effort: "high",
  });
  assert.strictEqual(req.url, "https://api.deepseek.com/v1/chat/completions");
  assert.strictEqual(req.headers.Authorization, "Bearer sk-1");
  assert.deepStrictEqual(req.body.stream_options, { include_usage: true });
  assert.strictEqual(req.body.reasoning_effort, "high");
  assert.strictEqual(req.body.max_tokens, undefined, "maxTokens 为 0 时不该出现");
});

test("OpenAI：非流式不带 stream_options", () => {
  const req = FORMATS.openai.buildRequest({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk",
    modelId: "gpt-4.1",
    messages: [],
    tools: [],
    stream: false,
    temperature: 0.2,
    maxTokens: 16,
  });
  assert.strictEqual(req.body.stream_options, undefined);
  assert.strictEqual(req.body.max_tokens, 16);
});

test("Anthropic：/v1/messages 不重复、system 提到顶层、max_tokens 必填", () => {
  for (const base of ["https://api.anthropic.com", "https://api.anthropic.com/v1", "https://api.anthropic.com/v1/messages"]) {
    const req = FORMATS.anthropic.buildRequest({
      baseUrl: base,
      apiKey: "sk-ant",
      modelId: "claude-sonnet-4-5",
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "hi" },
      ],
      tools: [],
      stream: true,
      temperature: 1.7,
      maxTokens: 0,
    });
    assert.strictEqual(req.url, "https://api.anthropic.com/v1/messages", base);
    assert.strictEqual(req.headers["x-api-key"], "sk-ant");
    assert.strictEqual(req.headers["anthropic-version"], "2023-06-01");
    assert.strictEqual(req.body.system, "你是助手");
    assert.ok(
      !req.body.messages.some((m) => m.role === "system"),
      "system 不能留在 messages 里"
    );
    assert.strictEqual(req.body.max_tokens, 8192, "留空要补默认值，否则 400");
    assert.strictEqual(req.body.temperature, 1, "Anthropic 的温度上限是 1");
  }
});

test("Anthropic：工具声明用 input_schema，工具结果并进 user", () => {
  const req = FORMATS.anthropic.buildRequest({
    baseUrl: "https://api.anthropic.com",
    apiKey: "k",
    modelId: "claude",
    messages: [
      { role: "user", content: "算一下" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "t1", type: "function", function: { name: "calc", arguments: '{"a":1}' } }],
      },
      { role: "tool", tool_call_id: "t1", content: "2" },
    ],
    tools: [{ type: "function", function: { name: "calc", description: "算", parameters: { type: "object", properties: {} } } }],
    stream: true,
    temperature: 0.3,
    maxTokens: 100,
  });
  assert.strictEqual(req.body.tools[0].name, "calc");
  assert.ok(req.body.tools[0].input_schema, "必须是 input_schema，不是 parameters");
  const last = req.body.messages[req.body.messages.length - 1];
  assert.strictEqual(last.role, "user");
  assert.strictEqual(last.content[0].type, "tool_result");
  assert.strictEqual(last.content[0].tool_use_id, "t1");
});

test("Gemini：alt=sse、x-goog-api-key、contents 角色与 schema 清洗", () => {
  const req = FORMATS.gemini.buildRequest({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "gk",
    modelId: "models/gemini-2.5-pro",
    messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "好", tool_calls: [{ id: "c1", function: { name: "calc", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "2" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "calc",
          description: "算",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { a: { type: "number" } },
            required: ["a"],
          },
        },
      },
    ],
    stream: true,
    temperature: 0.3,
    maxTokens: 256,
  });
  assert.ok(/\/v1beta\/models\/gemini-2\.5-pro:streamGenerateContent\?alt=sse$/.test(req.url), req.url);
  assert.strictEqual(req.headers["x-goog-api-key"], "gk");
  assert.ok(req.body.contents.every((c) => c.role !== "model" || true));
  assert.strictEqual(req.body.contents[0].role, "user");
  assert.strictEqual(req.body.systemInstruction.parts[0].text, "你是助手");
  const decl = req.body.tools[0].functionDeclarations[0];
  assert.strictEqual(decl.parameters.type, "OBJECT");
  assert.strictEqual(decl.parameters.additionalProperties, undefined, "Gemini 不认 additionalProperties");
  const last = req.body.contents[req.body.contents.length - 1];
  assert.strictEqual(last.parts[0].functionResponse.name, "calc", "工具结果要能找回函数名");
});

test("Ollama：去 /v1 走 /api/chat，num_predict 映射", () => {
  for (const base of ["http://localhost:11434", "http://localhost:11434/v1", "http://localhost:11434/api"]) {
    const req = FORMATS.ollama.buildRequest({
      baseUrl: base,
      apiKey: "ollama-local",
      modelId: "qwen2.5:7b",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      stream: true,
      temperature: 0.4,
      maxTokens: 128,
    });
    assert.strictEqual(req.url, "http://localhost:11434/api/chat", base);
    assert.strictEqual(req.body.options.num_predict, 128);
    assert.strictEqual(req.body.options.temperature, 0.4);
    assert.strictEqual(req.headers.Authorization, undefined, "占位符不该往外发");
    assert.strictEqual(req.body.messages[0].content, "hi");
  }
});

console.log("\n[2] 流解析（按 7 字节切块）");

test("OpenAI：文本 + 工具分片 + usage + finish", () => {
  const box = collect("openai");
  const body =
    sse("", { choices: [{ delta: { content: "你" } }] }) +
    sse("", { choices: [{ delta: { content: "好" } }] }) +
    sse("", {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "calc", arguments: '{"a":' } }],
          },
        },
      ],
    }) +
    sse("", {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    }) +
    sse("", { choices: [], usage: { total_tokens: 42 } }) +
    "data: [DONE]\n\n";
  feedInChunks(box.parser, body);
  const r = box.result();
  assert.strictEqual(r.text, "你好");
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].name, "calc");
  assert.strictEqual(r.calls[0].args, '{"a":1}');
  assert.strictEqual(r.calls[0].id, "call_1");
  assert.strictEqual(r.finish, "tool_calls");
  assert.strictEqual(r.usage.total_tokens, 42);
});

test("Anthropic：命名事件 + input_json_delta 拼接", () => {
  const box = collect("anthropic");
  const body =
    sse("message_start", { type: "message_start", message: { usage: { input_tokens: 12 } } }) +
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }) +
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }) +
    sse("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "calc" },
    }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"a":' },
    }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "1}" },
    }) +
    sse("ping", { type: "ping" }) +
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 7 },
    }) +
    sse("message_stop", { type: "message_stop" });
  feedInChunks(box.parser, body);
  const r = box.result();
  assert.strictEqual(r.text, "你好");
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].name, "calc");
  assert.strictEqual(r.calls[0].args, '{"a":1}');
  assert.strictEqual(r.finish, "tool_calls");
  assert.strictEqual(r.usage.prompt_tokens, 12);
  assert.strictEqual(r.usage.completion_tokens, 7);
});

test("Gemini：thought 走推理、functionCall 合成 id、usage 合并", () => {
  const box = collect("gemini");
  const body =
    sse("", { candidates: [{ content: { parts: [{ text: "你" }] } }] }) +
    sse("", { candidates: [{ content: { parts: [{ text: "想一想", thought: true }] } }] }) +
    sse("", { candidates: [{ content: { parts: [{ functionCall: { name: "calc", args: { a: 1 } } }] } }] }) +
    sse("", {
      candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    });
  feedInChunks(box.parser, body);
  const r = box.result();
  assert.strictEqual(r.text, "你");
  assert.strictEqual(r.reasoning, "想一想");
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].id, "call_g_0");
  assert.strictEqual(r.calls[0].args, '{"a":1}');
  assert.strictEqual(r.finish, "stop");
  assert.strictEqual(r.usage.total_tokens, 8);
});

test("Ollama：NDJSON 逐行、末行无换行、重复工具去重", () => {
  const box = collect("ollama");
  const body =
    '{"message":{"role":"assistant","content":"你"},"done":false}\n' +
    '{"message":{"role":"assistant","content":"好"},"done":false}\n' +
    '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"calc","arguments":{"a":1}}}]},"done":false}\n' +
    '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"calc","arguments":{"a":1}}}]},"done":false}\n' +
    '{"done":true,"done_reason":"stop","prompt_eval_count":4,"eval_count":2}';
  feedInChunks(box.parser, body, 11);
  const r = box.result();
  assert.strictEqual(r.text, "你好");
  assert.strictEqual(r.calls.length, 1, "同一批 tool_calls 被推了两次，只能算一个");
  assert.strictEqual(r.calls[0].name, "calc");
  assert.strictEqual(r.calls[0].args, '{"a":1}');
  assert.strictEqual(r.usage.total_tokens, 6);
  assert.strictEqual(r.finish, "stop");
});

console.log("\n[3] 整包解析（网关忽略 stream:true）");

test("OpenAI", () => {
  const w = FORMATS.openai.parseWhole(
    JSON.stringify({
      choices: [{ message: { content: "整包", tool_calls: [{ id: "c", function: { name: "calc", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      usage: { total_tokens: 9 },
    })
  );
  assert.strictEqual(w.text, "整包");
  assert.strictEqual(w.toolCalls[0].name, "calc");
  assert.strictEqual(w.finish, "tool_calls");
});

test("Anthropic", () => {
  const w = FORMATS.anthropic.parseWhole(
    JSON.stringify({
      content: [
        { type: "thinking", thinking: "嗯" },
        { type: "text", text: "整包" },
        { type: "tool_use", id: "t", name: "calc", input: { a: 1 } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 4 },
    })
  );
  assert.strictEqual(w.reasoning, "嗯");
  assert.strictEqual(w.text, "整包");
  assert.strictEqual(w.toolCalls[0].args, '{"a":1}');
  assert.strictEqual(w.finish, "tool_calls");
  assert.strictEqual(w.usage.total_tokens, 7);
});

test("Gemini", () => {
  const w = FORMATS.gemini.parseWhole(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "整包" }, { functionCall: { name: "calc", args: {} } }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
    })
  );
  assert.strictEqual(w.text, "整包");
  assert.strictEqual(w.finish, "length");
  assert.strictEqual(w.usage.total_tokens, 3);
});

test("Ollama", () => {
  const w = FORMATS.ollama.parseWhole(
    JSON.stringify({ message: { content: "整包", tool_calls: [{ function: { name: "calc", arguments: {} } }] }, done: true, done_reason: "length" })
  );
  assert.strictEqual(w.text, "整包");
  assert.strictEqual(w.finish, "length");
  assert.strictEqual(w.toolCalls.length, 1);
});

console.log("\n[4] 流内错误");

test("Anthropic 的 error 事件", () => {
  const box = collect("anthropic");
  feedInChunks(box.parser, sse("error", { type: "error", error: { type: "overloaded_error", message: "服务过载" } }));
  assert.strictEqual(box.result().error, "服务过载");
});

test("Gemini 的 blockReason", () => {
  const box = collect("gemini");
  feedInChunks(box.parser, sse("", { promptFeedback: { blockReason: "SAFETY" } }));
  assert.ok(/SAFETY/.test(box.result().error || ""));
});

test("Ollama 的 error 行", () => {
  const box = collect("ollama");
  feedInChunks(box.parser, '{"error":"model not found"}\n');
  assert.strictEqual(box.result().error, "model not found");
});

console.log("\n[5] 工具聚合");

test("id / name 覆盖、args 拼接、index 缺省递增", () => {
  const calls = [];
  accumulateToolCall(calls, { index: 0, id: "a", name: "calc", args: '{"x"' });
  accumulateToolCall(calls, { index: 0, id: "a", name: "calc", args: ":1}" });
  accumulateToolCall(calls, { index: 1, name: "now", args: "{}" });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].name, "calc", "重复的 name 不能拼成 calc_calc");
  assert.strictEqual(calls[0].args, '{"x":1}');
  assert.strictEqual(calls[1].name, "now");
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
