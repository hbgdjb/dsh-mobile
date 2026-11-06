#!/usr/bin/env node
/* ============================================================
   AI 改写测试

   ============ 这套测试在防什么 ============

   键盘里的 AI 是最容易"看起来成功、其实坏了"的功能：

     · 端点回了 SSE，但解析器只认整包 JSON → 面板空白
     · 端点忽略 stream，回了整包 → 同上
     · 没有配置模型，却发了请求 → 401 之后弹一句看不懂的话
     · 用户点了取消，请求还在跑 → 白花钱

   所以这些都用注入的假传输覆盖掉，不依赖真实网络。

   用法：node tests/ime-ai-test.mjs
   ============================================================ */

import assert from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { rewrite, TASKS } = await import(pathToFileURL(path.join(ROOT, "ime", "ai.js")).href);

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

const CONFIG = { baseUrl: "https://api.test.local/v1", apiKey: "sk-test", apiModel: "probe" };

/** 造一段 SSE 文本。 */
function sse(...parts) {
  return parts
    .map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
    .join("") + "data: [DONE]\n\n";
}

console.log("\n任务定义\n");

await test("五类任务都有标签和指令", () => {
  const keys = Object.keys(TASKS);
  assert.strictEqual(keys.length, 5, keys.join(","));
  for (const k of keys) {
    assert.ok(TASKS[k].label, `${k} 缺 label`);
    assert.ok(TASKS[k].instruction.length > 10, `${k} 的指令太短`);
  }
});

console.log("\n返回解析\n");

await test("SSE 分片拼接成完整文本", async () => {
  const out = await rewrite("polish", "这句话需要润色", {
    config: CONFIG,
    request: async () => sse("今天", "天气", "不错。"),
  });
  assert.strictEqual(out, "今天天气不错。");
});

await test("端点忽略 stream、回整包 JSON 也能解析", async () => {
  const out = await rewrite("fix", "有错别字", {
    config: CONFIG,
    request: async () =>
      JSON.stringify({ choices: [{ message: { content: "没有错别字。" } }] }),
  });
  assert.strictEqual(out, "没有错别字。");
});

await test("返回空内容时报错，而不是静默成功", async () => {
  await assert.rejects(
    () => rewrite("polish", "x", { config: CONFIG, request: async () => "data: [DONE]\n\n" }),
    /没有返回内容/
  );
});

console.log("\n配置与错误\n");

await test("没配模型时说清楚下一步该干什么", async () => {
  await assert.rejects(() => rewrite("polish", "x", { config: {}, request: async () => "" }), /设置/);
});

await test("缺 Key 也拦住", async () => {
  await assert.rejects(
    () => rewrite("polish", "x", { config: { baseUrl: "https://a/v1", apiModel: "m" }, request: async () => "" }),
    /设置/
  );
});

await test("未知任务直接拒", async () => {
  await assert.rejects(() => rewrite("nope", "x", { config: CONFIG }), /未知的改写任务/);
});

await test("空原文不发请求", async () => {
  let called = 0;
  await assert.rejects(
    () =>
      rewrite("polish", "   ", {
        config: CONFIG,
        request: async () => {
          called += 1;
          return "";
        },
      }),
    /没有可改写的文字/
  );
  assert.strictEqual(called, 0, "空文本不该发请求");
});

console.log("\n地址拼装\n");

await test("baseUrl 以 /v1 结尾时补 chat/completions", async () => {
  let seen = "";
  await rewrite("polish", "x", {
    config: CONFIG,
    request: async ({ url }) => {
      seen = url;
      return sse("ok");
    },
  });
  assert.strictEqual(seen, "https://api.test.local/v1/chat/completions");
});

await test("baseUrl 已经是完整端点时不重复拼", async () => {
  let seen = "";
  await rewrite("polish", "x", {
    config: { ...CONFIG, baseUrl: "https://api.test.local/v1/chat/completions" },
    request: async ({ url }) => {
      seen = url;
      return sse("ok");
    },
  });
  assert.strictEqual(seen, "https://api.test.local/v1/chat/completions");
});

console.log("\n重试与取消\n");

await test("503 之后自动重试并成功", async () => {
  let n = 0;
  const out = await rewrite("polish", "x", {
    config: CONFIG,
    request: async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error("HTTP 503"), { httpStatus: 503 });
      return sse("重试成功");
    },
  });
  assert.strictEqual(out, "重试成功");
  assert.strictEqual(n, 2);
});

await test("401 不重试", async () => {
  let n = 0;
  await assert.rejects(
    () =>
      rewrite("polish", "x", {
        config: CONFIG,
        request: async () => {
          n += 1;
          throw Object.assign(new Error("HTTP 401"), { httpStatus: 401 });
        },
      }),
    /401/
  );
  assert.strictEqual(n, 1, "Key 错了重试也没用");
});

await test("取消后立刻停止", async () => {
  const ac = new AbortController();
  let n = 0;
  const p = rewrite("polish", "x", {
    config: CONFIG,
    signal: ac.signal,
    request: async () => {
      n += 1;
      ac.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  await assert.rejects(p, (e) => e.name === "AbortError");
  assert.strictEqual(n, 1);
});

await test("请求体带上了原文与任务指令", async () => {
  let body = null;
  await rewrite("translate", "今天天气不错", {
    config: CONFIG,
    request: async ({ body: b }) => {
      body = b;
      return sse("The weather is nice today.");
    },
  });
  assert.ok(body, "应该有请求体");
  assert.strictEqual(body.messages.at(-1).content, "今天天气不错");
  assert.ok(body.messages.some((m) => m.content.includes("翻译")), "应该带上任务指令");
  assert.strictEqual(body.stream, true);
});

console.log(`\n${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
