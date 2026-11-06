#!/usr/bin/env node
/* ============================================================
   Agnes 接入回归

   ============ 这个测试守的是什么 ============

   Agnes 是 OpenAI 兼容端点，但「兼容」不等于「一样」：

     · 文档没有 stream_options / reasoning_effort，严格网关会 400
     · 思考开关是 chat_template_kwargs.enable_thinking，不是推理强度
     · 部分档位把思考内联成 <think ...>，不拆会写进正文与历史
     · 节点在新加坡，首字节动辄 45 秒以上，原生看门狗会误杀
     · Cloudflare 拦截时返回 HTML，直接截断会甩用户一脸标签

   这些都不会表现为「完全连不上」，而是「连上了但很难用」。
   所以按真实分片边界逐项验证。
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORMATS,
  createThinkSplitter,
  createSSEFrames,
  errorDetail,
  connectionProfile,
} from "../scripts/formats.js";
import { PROVIDERS, knownModelCtx, knownModelVision, resolveDiscoveredModels } from "../scripts/store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

/** 按真实网络的分块方式喂解析器：一刀切在标签中间也要能拼回来。 */
function collectOpenAI() {
  let text = "";
  let reasoning = "";
  const parser = FORMATS.openai.createStreamParser({
    onText: (t) => {
      text += t;
    },
    onReasoning: (r) => {
      reasoning += r;
    },
  });
  const chunk = (delta) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
  return {
    parser,
    feedInChunks(s, size = 5) {
      for (let i = 0; i < s.length; i += size) parser.feed(s.slice(i, i + size));
    },
    finish() {
      parser.flush();
      return { text, reasoning };
    },
  };
}

console.log("[1] 供应方预设");

test("Agnes 预设默认走国内站", () => {
  const p = PROVIDERS.agnes;
  assert.ok(p, "PROVIDERS 里没有 agnes");
  assert.strictEqual(p.name, "Agnes AI");
  // 0.84.0 起默认 .cn：国内站与国际站的 Key 不通用，而用户大多在国内。
  // 国际站的 Key 也不会被卡住 —— 401 时会自动换站并写回（见 agnes-site-test）。
  assert.strictEqual(p.baseUrl, "https://apihub.agnes-ai.cn/v1");
  assert.strictEqual(p.defaultCtx, 524288);
  const ids = p.suggest.map((s) => s.id);
  assert.ok(ids.includes("agnes-3.0-flash"), "缺 3.0 Flash");
  assert.ok(ids.includes("agnes-2.5-flash"), "缺 2.5 Flash");
  assert.ok(/enable_thinking/.test(p.hint), "提示里要写清思考开关");
  assert.ok(/不通用/.test(p.hint), "提示里要写清两站 Key 不通用");
  assert.ok(/platform\.agnes-ai\.cn/.test(p.console), "控制台地址不对");
});

test("三个端点都带 format，来回切换不会残留上一个协议", () => {
  const eps = PROVIDERS.agnes.endpoints;
  assert.strictEqual(eps.length, 3);
  assert.strictEqual(eps[0].format, "openai");
  assert.strictEqual(eps[0].baseUrl, "https://apihub.agnes-ai.cn/v1");
  assert.strictEqual(eps[1].format, "openai");
  assert.strictEqual(eps[1].baseUrl, "https://apihub.agnes-ai.com/v1");
  assert.strictEqual(eps[2].format, "anthropic");
  assert.ok(eps.every((e) => !!e.format), "每个 chip 都必须带 format");
});

test("512K 窗口与图片输入能被自动带出", () => {
  assert.strictEqual(knownModelCtx("agnes-3.0-flash"), 524288);
  assert.strictEqual(knownModelVision("agnes-3.0-flash"), true);
  assert.strictEqual(knownModelVision("agnes-2.5-flash"), true);
});

test("模型发现过滤视频 / 图像模型，只留聊天模型", () => {
  const ids = resolveDiscoveredModels("agnes", [
    { id: "agnes-3.0-flash" },
    { id: "agnes-video-2.5" },
    { id: "agnes-image-2.1-flash" },
    { id: "agnes-2.5-flash" },
  ]).map((m) => m.id);
  assert.deepStrictEqual(ids, ["agnes-3.0-flash", "agnes-2.5-flash"]);
});

console.log("\n[2] 请求体：只发 Agnes 认识的字段");

const build = (baseUrl, effort) =>
  FORMATS.openai.buildRequest({
    baseUrl,
    apiKey: "k",
    modelId: "agnes-3.0-flash",
    messages: [{ role: "user", content: "ping" }],
    tools: [],
    stream: true,
    temperature: 0.3,
    maxTokens: 0,
    effort,
  }).body;

test("Agnes 不带 stream_options", () => {
  assert.strictEqual(build("https://apihub.agnes-ai.com/v1", "high").stream_options, undefined);
});

test("Agnes 不带 reasoning_effort，改用 chat_template_kwargs", () => {
  const high = build("https://apihub.agnes-ai.com/v1", "high");
  assert.strictEqual(high.reasoning_effort, undefined);
  assert.deepStrictEqual(high.chat_template_kwargs, { enable_thinking: true });
  const off = build("https://apihub.agnes-ai.com/v1", "minimal");
  assert.deepStrictEqual(off.chat_template_kwargs, { enable_thinking: false });
});

test("effort 为空时不动模型默认思考设置", () => {
  const body = build("https://apihub.agnes-ai.com/v1", null);
  assert.strictEqual(body.chat_template_kwargs, undefined);
});

test("其他 OpenAI 兼容服务保持原样", () => {
  const body = build("https://api.deepseek.com", "high");
  assert.deepStrictEqual(body.stream_options, { include_usage: true });
  assert.strictEqual(body.reasoning_effort, "high");
  assert.strictEqual(body.chat_template_kwargs, undefined);
});

test("URL 仍是 /v1/chat/completions", () => {
  const req = FORMATS.openai.buildRequest({
    baseUrl: "https://apihub.agnes-ai.com/v1",
    apiKey: "k",
    modelId: "agnes-3.0-flash",
    messages: [],
    tools: [],
    stream: true,
  });
  assert.strictEqual(req.url, "https://apihub.agnes-ai.com/v1/chat/completions");
});

console.log("\n[3] 内联 think 标签");

test("跨分片的 <think> 拆成思考链，正文只留答案", () => {
  const box = collectOpenAI();
  box.feedInChunks(
    'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"nk time=\\"2s\\">先核对"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"需求</thi"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"nk>答案在这里"}}]}\n\n',
    4
  );
  const out = box.finish();
  assert.strictEqual(out.reasoning, "先核对需求");
  assert.strictEqual(out.text, "答案在这里");
});

test("正文中间出现 <think> 不被吞（代码示例场景）", () => {
  const box = collectOpenAI();
  box.feedInChunks('data: {"choices":[{"delta":{"content":"写成 <think> 标签"}}]}\n\n');
  const out = box.finish();
  assert.strictEqual(out.text, "写成 <think> 标签");
  assert.strictEqual(out.reasoning, "");
});

test("没有闭合时，思考内容在收尾时全部归到思考链", () => {
  const box = collectOpenAI();
  box.feedInChunks('data: {"choices":[{"delta":{"content":"<thinking>想到一半"}}]}\n\n');
  const out = box.finish();
  assert.strictEqual(out.reasoning, "想到一半");
  assert.strictEqual(out.text, "");
});

test("完全没有 think 标签时文本一字不差", () => {
  const box = collectOpenAI();
  box.feedInChunks('data: {"choices":[{"delta":{"content":"普通回答"}}]}\n\n', 2);
  assert.strictEqual(box.finish().text, "普通回答");
});

test("拆分器自身：开头空白与属性都能识别", () => {
  let t = "";
  let r = "";
  const sp = createThinkSplitter({ onText: (x) => (t += x), onReasoning: (x) => (r += x) });
  sp.push("  \n<think foo=\"1\">甲</think>乙");
  sp.flush();
  assert.strictEqual(r, "甲");
  assert.strictEqual(t, "乙");
});

test("整包 JSON 也要拆（网关忽略 stream:true 的情况）", () => {
  const whole = FORMATS.openai.parseWhole(
    JSON.stringify({
      choices: [
        { message: { role: "assistant", content: "<think>先想</think>再答" }, finish_reason: "stop" },
      ],
    })
  );
  assert.strictEqual(whole.reasoning, "先想");
  assert.strictEqual(whole.text, "再答");
});

console.log("\n[4] 连接耐心值");

test("Agnes 首字节 90s / 连接 12s", () => {
  assert.deepStrictEqual(connectionProfile("https://apihub.agnes-ai.com/v1"), {
    firstByteSec: 90,
    connectSec: 12,
  });
});

test("其他服务沿用默认（0 = 原生侧 45s / 8s）", () => {
  assert.deepStrictEqual(connectionProfile("https://api.deepseek.com"), {
    firstByteSec: 0,
    connectSec: 0,
  });
});

test("原生桥收到 8 个参数，超时值没有被吞", async () => {
  let captured = null;
  globalThis.window = {
    DshNative: {
      postStream: (...args) => {
        captured = args;
      },
    },
  };
  const mod = await import(`../scripts/native-http.js?t=${Date.now()}`);
  mod.nativeStream({
    url: "https://apihub.agnes-ai.com/v1/chat/completions",
    headers: { Authorization: "Bearer k" },
    body: { model: "agnes-3.0-flash" },
    timeoutSec: 300,
    firstByteSec: 90,
    connectSec: 12,
    onEnd: () => {},
    onError: () => {},
  });
  assert.ok(captured, "没有调用原生桥");
  assert.strictEqual(captured.length, 8, `参数个数 ${captured.length}`);
  assert.strictEqual(captured[4], 300);
  assert.strictEqual(captured[5], "POST");
  assert.strictEqual(captured[6], 90);
  assert.strictEqual(captured[7], 12);
  delete globalThis.window;
});

test("Java 桥保留旧签名并新增按请求覆盖", () => {
  const java = fs.readFileSync(path.join(ROOT, "android/java/DshHttpBridge.java"), "utf8");
  assert.ok(/public void postStream\(String id, String url, String headersJson, String bodyJson, int timeoutSec, String method\)/.test(java), "旧签名被删了，老页面会白屏");
  assert.ok(/int firstByteSec, int connectSec\)/.test(java), "缺带耐心值的重载");
  assert.ok(/new Req\(conn, firstByteMs, STREAM_IDLE_MS\)/.test(java), "看门狗没用请求级首字节");
  assert.ok(/conn\.setConnectTimeout\(connectTimeoutMs\)/.test(java), "连接超时没用请求级值");
});

console.log("\n[5] 网关错误");

test("Cloudflare 校验页翻成人话", () => {
  const html = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cloudflare</body></html>";
  const msg = errorDetail(html);
  assert.ok(/Cloudflare/.test(msg), msg);
  assert.ok(!/<html/i.test(msg), "不能把标签甩给用户");
});

test("普通网页响应提示检查 Base URL", () => {
  const msg = errorDetail("<html><body>404 Not Found</body></html>");
  assert.ok(/Base URL/.test(msg), msg);
});

test("JSON 错误仍然只取 message", () => {
  assert.strictEqual(
    errorDetail('{"error":{"message":"Invalid token (request id: 123)","type":"AgnesAI_error"}}'),
    "Invalid token (request id: 123)"
  );
});

console.log("\n[6] SSE 分帧没被拆分器带坏");

test("注释心跳、[DONE] 与空行仍按原逻辑处理", () => {
  let n = 0;
  const frames = createSSEFrames(() => {
    n += 1;
  });
  frames.feed(": ping\n\n");
  frames.feed('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
  frames.feed("data: [DONE]\n\n");
  assert.strictEqual(n, 2, "心跳不应派发事件");
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
