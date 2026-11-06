#!/usr/bin/env node
/* ============================================================
   模型探测：四家的端点、鉴权、分页与错误

   ============ 这个测试守的是什么 ============

   "填完 Base URL 和 Key 就自动列出模型"是这次改版的核心体验。
   端点差一个字符、鉴权放错 header、分页只取第一页，用户在界面上
   看到的都是同一句话：「没有取到模型列表」—— 没法排查。

   所以这里起一个假上游，把四家的真实响应结构各摆一份，验证：
     · OpenAI 先试 /models 失败后能退回 /v1/models
     · Anthropic 用 x-api-key，并且会翻页
     · Gemini 用 x-goog-api-key、去掉 models/ 前缀、过滤掉 embedding
     · Ollama 打的是 /api/tags
     · 401 会带 httpStatus 抛出来（UI 才能显示鉴权失败而不是"网络错误"）

   全程离线，不碰真 Key。
   ============================================================ */

import assert from "node:assert";
import { createServer } from "node:http";
import { FORMATS } from "../scripts/formats.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${e && e.message ? e.message : e}`);
  }
}

const seen = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  seen.push({ path: url.pathname, search: url.search, headers: req.headers });
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  // OpenAI：/models 404，/v1/models 才有 —— 真实世界里很常见
  if (url.pathname === "/openai/models") return send(404, { error: { message: "not found" } });
  if (url.pathname === "/openai/v1/models") {
    return send(200, { object: "list", data: [{ id: "gpt-4.1" }, { id: "o4-mini" }] });
  }

  // Anthropic：分页
  if (url.pathname === "/anth/v1/models") {
    if (!url.searchParams.get("after_id")) {
      return send(200, {
        data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }],
        has_more: true,
        last_id: "claude-sonnet-4-5",
      });
    }
    return send(200, {
      data: [{ id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }],
      has_more: false,
      last_id: "claude-haiku-4-5",
    });
  }

  // Gemini：带 models/ 前缀、混了 embedding、还有下一页
  if (url.pathname === "/gem/v1beta/models") {
    if (!url.searchParams.get("pageToken")) {
      return send(200, {
        models: [
          { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-004", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
        ],
        nextPageToken: "p2",
      });
    }
    return send(200, {
      models: [
        { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
      ],
    });
  }

  // Ollama
  if (url.pathname === "/oll/api/tags") {
    return send(200, { models: [{ name: "qwen2.5:7b" }, { name: "llama3.1:8b" }] });
  }

  // 401
  if (url.pathname === "/bad/v1/models") return send(401, { error: { message: "invalid api key" } });
  // 200 但空列表
  if (url.pathname === "/empty/v1/models") return send(200, { data: [] });
  // 不是 JSON
  if (url.pathname === "/html/v1/models") return send(200, "<html>gateway</html>");

  return send(404, { error: { message: "no route" } });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/** 和 runtime.fetchModelList 注入的那个 request 同形。 */
async function request({ url, method, headers }) {
  const res = await fetch(url, { method, headers });
  return { status: res.status, text: await res.text() };
}

const idsOf = (r) => r.items.map((i) => i.id);

console.log("\n[1] OpenAI 兼容：多路径回退");

await test("先试 /models 失败，退回 /v1/models", async () => {
  seen.length = 0;
  const r = await FORMATS.openai.listModels({
    baseUrl: `${BASE}/openai`,
    apiKey: "sk-1",
    request,
  });
  assert.deepStrictEqual(idsOf(r), ["gpt-4.1", "o4-mini"]);
  assert.strictEqual(seen[0].path, "/openai/models");
  assert.strictEqual(seen[1].path, "/openai/v1/models");
  assert.strictEqual(seen[0].headers.authorization, "Bearer sk-1");
  assert.ok(r.endpoint.indexOf("?") < 0, "endpoint 不该带 query");
});

await test("200 但空列表 → 明确报错，而不是返回空数组", async () => {
  await assert.rejects(
    () => FORMATS.openai.listModels({ baseUrl: `${BASE}/empty`, apiKey: "k", request }),
    /没有返回模型列表|列表为空/
  );
});

await test("非 JSON 响应也不会崩", async () => {
  await assert.rejects(
    () => FORMATS.openai.listModels({ baseUrl: `${BASE}/html`, apiKey: "k", request }),
    /没有返回模型列表/
  );
});

console.log("\n[2] Anthropic");

await test("用 x-api-key + anthropic-version，不用 Bearer", async () => {
  seen.length = 0;
  const r = await FORMATS.anthropic.listModels({
    baseUrl: `${BASE}/anth`,
    apiKey: "sk-ant",
    request,
  });
  assert.strictEqual(seen[0].path, "/anth/v1/models");
  assert.strictEqual(seen[0].headers["x-api-key"], "sk-ant");
  assert.strictEqual(seen[0].headers["anthropic-version"], "2023-06-01");
  assert.strictEqual(seen[0].headers.authorization, undefined);
  assert.deepStrictEqual(idsOf(r), ["claude-sonnet-4-5", "claude-haiku-4-5"]);
});

await test("has_more 时用 after_id 翻页", async () => {
  seen.length = 0;
  await FORMATS.anthropic.listModels({ baseUrl: `${BASE}/anth`, apiKey: "k", request });
  assert.ok(seen[1].search.indexOf("after_id=claude-sonnet-4-5") >= 0, seen[1].search);
});

await test("display_name 被带进 items.label", async () => {
  const r = await FORMATS.anthropic.listModels({ baseUrl: `${BASE}/anth`, apiKey: "k", request });
  assert.strictEqual(r.items[0].label, "Claude Sonnet 4.5");
});

console.log("\n[3] Gemini");

await test("x-goog-api-key 放头里，URL 不带 key", async () => {
  seen.length = 0;
  await FORMATS.gemini.listModels({ baseUrl: `${BASE}/gem/v1beta`, apiKey: "gk", request });
  const first = seen[0];
  assert.strictEqual(first.path, "/gem/v1beta/models");
  assert.strictEqual(first.headers["x-goog-api-key"], "gk");
  assert.ok(first.search.indexOf("key=") < 0, "Key 不能出现在 URL 里");
});

await test("去掉 models/ 前缀、过滤 embedding、翻页合并", async () => {
  const r = await FORMATS.gemini.listModels({ baseUrl: `${BASE}/gem/v1beta`, apiKey: "gk", request });
  assert.deepStrictEqual(idsOf(r), ["gemini-2.5-pro", "gemini-2.5-flash"]);
  assert.strictEqual(r.items[0].ctx, 1048576, "inputTokenLimit 要带出来");
  assert.ok(
    idsOf(r).every((id) => id.indexOf("models/") !== 0),
    "前缀必须去掉，否则请求时会拼成 /models/models/…"
  );
});

console.log("\n[4] Ollama");

await test("打 /api/tags，而不是 /v1/models", async () => {
  seen.length = 0;
  const r = await FORMATS.ollama.listModels({ baseUrl: `${BASE}/oll`, apiKey: "ollama-local", request });
  assert.strictEqual(seen[0].path, "/oll/api/tags");
  assert.deepStrictEqual(idsOf(r), ["qwen2.5:7b", "llama3.1:8b"]);
});

console.log("\n[5] 错误");

await test("401 带 httpStatus 抛出来（UI 才能区分鉴权失败与网络错误）", async () => {
  let err = null;
  try {
    await FORMATS.openai.listModels({ baseUrl: `${BASE}/bad`, apiKey: "k", request });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "应该抛错");
  assert.strictEqual(err.httpStatus, 401);
  // 0.81.0 起不再武断下「Key 无效」的结论：一把在电脑上有效的 Key
  // 被拒，可能是没带上 / 填错槽 / 选错协议 / 权限问题。
  assert.ok(/401|API Key/.test(err.message), err.message);
  assert.ok(!/无效或已过期/.test(err.message), err.message);
});

await test("没填 Key 时给的是可操作的话", async () => {
  await assert.rejects(
    () => FORMATS.openai.listModels({ baseUrl: `${BASE}/openai`, apiKey: "", request }),
    /API Key/
  );
});

server.close();
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
