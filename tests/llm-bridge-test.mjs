#!/usr/bin/env node
/* ============================================================
   llm 桥接层的回归测试（scripts/llm-bridge.js）

   这一层跑在 WebView 里，测的是「Node 侧注册的模型供应方
   怎么落到手机端的模型表里」。

   用法：node tests/llm-bridge-test.mjs
   ============================================================ */

import assert from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

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

/* ============================================================
   假的原生桥 + 假的 store
   ============================================================ */

/**
 * 装一个假的原生桥。
 *
 * @param {object} opts
 *   opts.handlers  方法 → 处理函数
 */
function installFakeBridge(opts = {}) {
  const handlers = opts.handlers || {};
  // 默认实现：路由事件一到，llm-bridge 会重新问一遍清单。
  // 用例没给这两个方法时不能让它以「没有这个方法」失败 ——
  // 那是测试环境的缺口，不是被测代码的问题。
  const withDefaults = {
    "llm.routes": async () => ({ routes: [], directory: [], namespaces: [] }),
    "llm.models": async (params) => ({ provider: params.provider, models: [] }),
    ...handlers,
  };
  globalThis.window = {
    DshNode: {
      status: () =>
        JSON.stringify({
          available: true,
          running: true,
          installed: true,
          downloading: false,
          percent: 0,
          channelConnected: true,
          channelPort: 12345,
        }),
      call: (method, paramsJson) => {
        fakeSeq += 1;
        const id = "j" + fakeSeq;
        const params = paramsJson ? JSON.parse(paramsJson) : {};
        const fn = withDefaults[method];
        setTimeout(() => {
          if (!fn) {
            globalThis.window.__dshNodeResponse(id, false, "没有这个方法：" + method);
            return;
          }
          Promise.resolve()
            .then(() => fn(params))
            .then((r) =>
              globalThis.window.__dshNodeResponse(
                id,
                true,
                JSON.stringify(r === undefined ? null : r)
              )
            )
            .catch((e) =>
              globalThis.window.__dshNodeResponse(id, false, String(e?.message || e))
            );
        }, 2);
        return id;
      },
      respond: () => {},
      start: () => {},
      stop: () => {},
      download: () => {},
    },
  };
}

/**
 * 假桥的请求 id 计数。
 *
 * 必须跨 installFakeBridge 调用共享 —— node-runtime 的 pending 表是模块级的，
 * 而每次重建假桥会把计数清零。清零后两轮请求都从 j1 开始，
 * 后一轮的 promise 会被前一轮的响应误唤醒/丢弃，表现为「明明有数据却同步出 0 条」。
 *
 * 真机上 id 由 Java 侧单调生成，不会撞。
 */
let fakeSeq = 0;

/** 记录 upsert 进来的模型条目。 */
let upserted = [];
/** 记录 store 模块的调用。 */
const storeCalls = [];

/* 假的 store —— llm-bridge 只用到 upsertCustomModel。 */
const storeMock = {
  upsertCustomModel(model) {
    storeCalls.push({ fn: "upsertCustomModel", model });
    upserted.push(model);
    return model;
  },
};

/**
 * 装载 llm-bridge，并把它的 store 依赖换成假的。
 *
 * 因为 llm-bridge 用的是静态 import，没法直接注入 ——
 * 所以这里用「模块注册表」的办法：先注册假的 store，
 * 再 import llm-bridge。
 */
let modCounter = 0;
async function loadBridge() {
  const suffix = `?v=${++modCounter}`;
  // node-runtime 必须用不带后缀的路径 —— llm-bridge 内部导入的也是它，
  // 必须是同一个模块实例，否则事件订阅收不到推送。
  const nr = await import(pathToFileURL(path.join(ROOT, "scripts/node-runtime.js")).href);
  // window 刚被换成假桥，钩子得重装一遍 ——
  // 否则 window.__dshNodeEvent 不存在，推送收不到。
  nr.ensureNodeHooks();
  const lb = await import(pathToFileURL(path.join(ROOT, "scripts/llm-bridge.js")).href + suffix);
  // 订阅要赶在事件派发之前 —— 否则新实例还没挂上监听，
  // 注入的 llm.routes 事件没人接，路由表会是空的。
  lb.ensureLlmRouteSubscription();
  return { nr, lb };
}

/* ============================================================
   1. 路由订阅
   ============================================================ */

console.log("\n[1] 路由订阅");

await test("llm.routes 事件会更新路由表", async () => {
  installFakeBridge();
  const { nr, lb } = await loadBridge();
  lb.ensureLlmRouteSubscription();
  nr.nodeOnEvent(() => {}); // 确保钩子已装
  // 直接派发一个事件
  globalThis.window.__dshNodeEvent("llm.routes", {
    routes: [{ provider: "our-free-model", name: "Our Free Model" }],
  });
  const routes = lb.llmRoutes();
  assert.strictEqual(routes.length, 1);
  assert.strictEqual(routes[0].provider, "our-free-model");
  assert.strictEqual(routes[0].name, "Our Free Model");
});

await test("没有原生桥时不订阅也不报错", async () => {
  delete globalThis.window;
  const { lb } = await loadBridge();
  assert.doesNotThrow(() => lb.ensureLlmRouteSubscription());
  assert.strictEqual(lb.llmRoutes().length, 0);
});

/* ============================================================
   2. 模型同步
   ============================================================ */

console.log("\n[2] 模型同步");

await test("syncLlmModels 把发现的模型并进模型表", async () => {
  installFakeBridge();
  const { lb } = await loadBridge();
  upserted = [];
  // 先注入路由
  globalThis.window.__dshNodeEvent("llm.routes", {
    routes: [{ provider: "our-free-model", name: "Our Free Model" }],
  });
  const added = lb.syncLlmModels({
    models: [
      {
        id: "deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        provider: "our-free-model",
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  });
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0].apiModel, "deepseek-v4.1-flash");
  assert.strictEqual(added[0].source, "node-llm");
  assert.strictEqual(added[0].nodeProvider, "our-free-model");
  assert.strictEqual(added[0].ctx, 128000);
  // label 是所有界面读的显示名（模型卡标题、抽屉底部、设置摘要）。
  // 少了它，界面上是 undefined —— 用户会以为「模型没切换过来」。
  assert.strictEqual(added[0].label, "DeepSeek V4.1 Flash", "必须有 label");
  assert.strictEqual(added[0].name, "DeepSeek V4.1 Flash");
});

await test("模型 id 带供应方前缀（避免与别的模型撞车）", async () => {
  installFakeBridge();
  const { lb } = await loadBridge();
  globalThis.window.__dshNodeEvent("llm.routes", {
    routes: [{ provider: "our-free-model", name: "Our Free Model" }],
  });
  const added = lb.syncLlmModels({
    models: [{ id: "model-x", name: "X", provider: "our-free-model" }],
  });
  assert.ok(added[0].id.includes("our-free-model"));
  assert.ok(added[0].id.includes("model-x"));
});

await test("没有发现结果时不塞占位条目（不给用户点了就报错的模型）", async () => {
  installFakeBridge();
  const { lb } = await loadBridge();
  globalThis.window.__dshNodeEvent("llm.routes", {
    routes: [{ provider: "our-free-model", name: "Our Free Model" }],
  });
  const added = lb.syncLlmModels({ models: [] });
  assert.strictEqual(added.length, 0, "不该塞占位条目");
});

await test("没有路由时同步是空操作", async () => {
  installFakeBridge();
  const { lb } = await loadBridge();
  const added = lb.syncLlmModels({
    models: [{ id: "m", name: "M", provider: "p" }],
  });
  assert.strictEqual(added.length, 0);
});

/* ============================================================
   3. 完整同步（走通道）
   ============================================================ */

await test("syncNodeLlmModels 走通道问清单并并入模型表", async () => {
  installFakeBridge({
    handlers: {
      "llm.routes": async () => ({
        routes: [{ provider: "our-free-model", name: "Our Free Model" }],
        directory: [{ provider: "our-free-model" }],
        namespaces: ["dsh-our-free-model"],
      }),
      "llm.models": async (params) => ({
        provider: params.provider,
        models: [
          {
            id: "kimi-k3",
            name: "Kimi K3",
            provider: params.provider,
            contextWindow: 256000,
            maxTokens: 16384,
          },
        ],
      }),
    },
  });
  const { lb } = await loadBridge();
  const added = await lb.syncNodeLlmModels();
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0].apiModel, "kimi-k3");
  assert.strictEqual(added[0].ctx, 256000);
});

await test("一个供应方问失败不影响其它供应方", async () => {
  installFakeBridge({
    handlers: {
      "llm.routes": async () => ({
        routes: [{ provider: "a" }, { provider: "b" }],
        directory: [],
        namespaces: [],
      }),
      "llm.models": async (params) => {
        if (params.provider === "a") throw new Error("这个供应方挂了");
        return { models: [{ id: "ok-model", name: "OK", provider: "b" }] };
      },
    },
  });
  const { lb } = await loadBridge();
  const added = await lb.syncNodeLlmModels();
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0].apiModel, "ok-model");
});

await test("通道没连上时不报错，返回空", async () => {
  installFakeBridge({
    handlers: {},
  });
  const { lb } = await loadBridge();
  const added = await lb.syncNodeLlmModels();
  assert.ok(Array.isArray(added));
});

await test("路由变化会顺带把新模型拉进模型表（装完插件就能看到）", async () => {
  installFakeBridge({
    handlers: {
      "llm.routes": async () => ({
        routes: [{ provider: "new-route", name: "新供应方" }],
        directory: [],
        namespaces: [],
      }),
      "llm.models": async (params) => ({
        provider: params.provider,
        models: [{ id: "m-new", name: "新模型", provider: params.provider }],
      }),
    },
  });
  const { lb } = await loadBridge();
  lb.ensureLlmRouteSubscription();
  upserted = [];

  // 模拟「用户刚装好插件 / 刚点了重新加载」
  globalThis.window.__dshNodeEvent("llm.routes", {
    routes: [{ provider: "new-route", name: "新供应方" }],
  });
  // 同步是异步的（要真的去问 adapter 有哪些模型）
  await new Promise((r) => setTimeout(r, 80));

  // 直接看手机端模型表本体 —— upserted 只是测试里一个记录数组，
  // 而 llm-bridge 用的是真实 store（静态 import 换不掉）。
  const store = await import(pathToFileURL(path.join(ROOT, "scripts/store.js")).href);
  const list = store.state.settings.customModels || [];
  const found = list.find((m) => m.apiModel === "m-new");
  assert.ok(
    found,
    "路由事件之后模型条目要自动出现，否则用户装完插件会发现选择器里空空的；实际：" +
      JSON.stringify(list.map((m) => m.apiModel))
  );
  assert.strictEqual(found.source, "node-llm");
  assert.strictEqual(found.nodeProvider, "new-route");
});

/* ============================================================
   4. 模型条目的识别
   ============================================================ */

console.log("\n[4] 模型条目的识别");

await test("isNodeLlmModel 认得出 Node 侧的模型", async () => {
  const { lb } = await loadBridge();
  assert.strictEqual(lb.isNodeLlmModel({ source: "node-llm" }), true);
  assert.strictEqual(lb.isNodeLlmModel({ provider: "node__our-free-model" }), true);
  assert.strictEqual(lb.isNodeLlmModel({ provider: "deepseek" }), false);
  assert.strictEqual(lb.isNodeLlmModel(null), false);
});

await test("nodeProviderOf 取得到供应方名", async () => {
  const { lb } = await loadBridge();
  assert.strictEqual(lb.nodeProviderOf({ nodeProvider: "our-free-model" }), "our-free-model");
  assert.strictEqual(lb.nodeProviderOf({ provider: "node__our-free-model" }), "our-free-model");
  assert.strictEqual(lb.nodeProviderOf({ provider: "deepseek" }), "");
});

/* ============================================================
   5. 流式调用（第 2 步：让插件模型真的跑起来）
   ============================================================ */

console.log("\n[5] 流式调用");

/**
 * 装一个会「流式」回话的假通道。
 *
 * llm.chat 的契约是：立刻返回 { started: true }，正文走事件。
 * 所以这里在返回之前把 chunk / done 事件排进队列 ——
 * 页面侧必须先订阅再调用，否则会漏掉（真实链路里也是这个顺序）。
 */
function installStreamingBridge(chunks, doneEvent, opts = {}) {
  installFakeBridge({
    handlers: {
      "llm.chat": async (params) => {
        const callId = params.callId;
        const emit = globalThis.window.__dshNodeEvent;
        setTimeout(() => {
          // 分两批发，模拟 Node 侧的攒批推送
          for (let i = 0; i < chunks.length; i += 1) {
            emit("llm.chunk", { callId, chunks: [chunks[i]] });
          }
          if (opts.neverDone !== true) emit("llm.done", { callId, ...doneEvent });
        }, 3);
        return { started: true, callId };
      },
      "llm.abort": async () => ({ aborted: true }),
      ...(opts.handlers || {}),
    },
  });
}

await test("文本增量按顺序喂给 onText，结束后返回 finish", async () => {
  installStreamingBridge(
    [
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "你" },
      { type: "text-delta", index: 0, text: "好" },
      { type: "block-end", index: 0, block: { type: "text", text: "你好" } },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    ],
    { ok: true, finish: "stop" }
  );
  const { lb } = await loadBridge();

  let text = "";
  const usage = [];
  const r = await lb.streamViaNode({
    provider: "our-free-model",
    model: "m1",
    messages: [{ role: "user", content: "hi" }],
    onText: (t) => {
      text += t;
    },
    onUsage: (u) => usage.push(u),
  });

  assert.strictEqual(text, "你好");
  assert.strictEqual(r.finish, "stop");
  assert.deepStrictEqual(r.calls, []);
  assert.strictEqual(usage.at(-1).total_tokens, 7);
});

await test("工具调用按 index 聚合出 {id, name, args}", async () => {
  installStreamingBridge(
    [
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "我查一下" },
      { type: "block-start", index: 1, blockType: "tool-call" },
      { type: "tool-call-delta", index: 1, id: "call_a", name: "fs_read", argumentsDelta: '{"pa' },
      { type: "tool-call-delta", index: 1, argumentsDelta: 'th":"a"}' },
      {
        type: "block-end",
        index: 1,
        block: { type: "tool-call", id: "call_a", name: "fs_read", arguments: '{"path":"a"}' },
      },
    ],
    { ok: true, finish: "tool-calls" }
  );
  const { lb } = await loadBridge();
  const r = await lb.streamViaNode({
    provider: "our-free-model",
    model: "m1",
    messages: [{ role: "user", content: "读 a" }],
  });
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].id, "call_a");
  assert.strictEqual(r.calls[0].name, "fs_read");
  // block-end 带的是装配好的最终形态，以它为准
  assert.strictEqual(r.calls[0].args, '{"path":"a"}');
});

await test("reasoning 增量单独走 onReasoning，不混进正文", async () => {
  installStreamingBridge(
    [
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "reasoning-delta", index: 0, text: "想一想" },
      { type: "block-start", index: 1, blockType: "text" },
      { type: "text-delta", index: 1, text: "答案" },
    ],
    { ok: true, finish: "stop" }
  );
  const { lb } = await loadBridge();
  let text = "";
  let reasoning = "";
  await lb.streamViaNode({
    provider: "p",
    model: "m",
    messages: [],
    onText: (t) => {
      text += t;
    },
    onReasoning: (t) => {
      reasoning += t;
    },
  });
  assert.strictEqual(reasoning, "想一想");
  assert.strictEqual(text, "答案");
});

await test("Node 报错时抛出可读的错误", async () => {
  installStreamingBridge([], { ok: false, error: "额度用完了", code: "EMPTY_RESPONSE" });
  const { lb } = await loadBridge();
  await assert.rejects(
    () => lb.streamViaNode({ provider: "p", model: "m", messages: [] }),
    /额度用完了/
  );
});

await test("用户主动停止 → AbortError（页面据此不报错）", async () => {
  installStreamingBridge([], { ok: false, aborted: true, error: "已停止" });
  const { lb } = await loadBridge();
  await assert.rejects(
    () => lb.streamViaNode({ provider: "p", model: "m", messages: [] }),
    (e) => e.name === "AbortError"
  );
});

await test("signal 已 abort 时立刻拒绝，不发请求", async () => {
  let called = false;
  installFakeBridge({
    handlers: {
      "llm.chat": async () => {
        called = true;
        return { started: true };
      },
    },
  });
  const { lb } = await loadBridge();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => lb.streamViaNode({ provider: "p", model: "m", messages: [], signal: ac.signal }),
    (e) => e.name === "AbortError"
  );
  assert.strictEqual(called, false, "已经停了就不该再发出去");
});

await test("中途 abort 会通知 Node 停下来（不然额度还在烧）", async () => {
  const aborted = [];
  installFakeBridge({
    handlers: {
      "llm.chat": async (params) => {
        // 一直不回 done，模拟还在生成
        setTimeout(() => {
          globalThis.window.__dshNodeEvent("llm.chunk", {
            callId: params.callId,
            chunks: [{ type: "text-delta", index: 0, text: "……" }],
          });
        }, 3);
        return { started: true, callId: params.callId };
      },
      "llm.abort": async (params) => {
        aborted.push(params.callId);
        return { aborted: true };
      },
    },
  });
  const { lb } = await loadBridge();
  const ac = new AbortController();
  const p = lb.streamViaNode({ provider: "p", model: "m", messages: [], signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(() => p, (e) => e.name === "AbortError");
  // llm.abort 走通道是异步的 —— 等它落地再看结果
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(aborted.length, 1, "应该向 Node 发了 llm.abort");
  assert.ok(aborted[0], "callId 要带对");
});

await test("同一时间两个生成互不串台（callId 对号入座）", async () => {
  installFakeBridge({
    handlers: {
      "llm.chat": async (params) => {
        const { callId } = params;
        setTimeout(() => {
          const emit = globalThis.window.__dshNodeEvent;
          emit("llm.chunk", { callId, chunks: [{ type: "text-delta", index: 0, text: params.model }] });
          emit("llm.done", { callId, ok: true, finish: "stop" });
        }, 3);
        return { started: true, callId };
      },
    },
  });
  const { lb } = await loadBridge();

  let a = "";
  let b = "";
  await Promise.all([
    lb.streamViaNode({ provider: "p", model: "A", messages: [], onText: (t) => (a += t) }),
    lb.streamViaNode({ provider: "p", model: "B", messages: [], onText: (t) => (b += t) }),
  ]);
  assert.strictEqual(a, "A");
  assert.strictEqual(b, "B");
});

/* ---------------- 汇总 ---------------- */

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
