#!/usr/bin/env node
/* ============================================================
   cordis 迷你容器 —— 补齐后的核心 API 回归测试

   这些 API 不是照着感觉写的，是对齐真实 cordis
   （@deepseek-ai/cordis@4.0.2 的 src/reflect.ts、src/fiber.ts、
   src/events.ts、src/registry.ts）逐条实现的。

   真实插件 dsh-our-free-model@2.5.9 把这些 API 用得最狠，
   每一个都有对应的实测用例。

   用法：node tests/cordis-api-test.mjs
   ============================================================ */

import assert from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE_DIR = path.join(ROOT, "android", "node");

const { createContainer, applyPlugin } = require(path.join(NODE_DIR, "cordis-lite.js"));
const { createLlmService } = require(path.join(NODE_DIR, "llm-service.js"));

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
    if (e && e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
  }
}

/** 造一个带假 llm 服务的容器。 */
function makeContainer(services = {}) {
  const logs = [];
  const container = createContainer({
    services,
    log: (level, scope, message) => logs.push({ level, scope, message }),
  });
  return { container, logs };
}

/* ============================================================
   1. ctx.get —— 机会性查找
   ============================================================ */

console.log("\n[1] ctx.get（机会性查找，缺失返回 undefined）");

await test("get 返回已提供的服务", () => {
  const { container } = makeContainer({ alpha: { v: 1 } });
  const ctx = container.contextFor(["alpha"]);
  assert.deepStrictEqual(ctx.get("alpha"), { v: 1 });
});

await test("get 缺失服务返回 undefined（不抛错）", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.strictEqual(ctx.get("nothingHere"), undefined);
});

await test("get 支持点号路径", () => {
  const { container } = makeContainer({ remote: { session: { id: "s1" } } });
  const ctx = container.contextFor(["remote"]);
  assert.deepStrictEqual(ctx.get("remote.session"), { id: "s1" });
});

await test("get 缺失的点号路径也返回 undefined", () => {
  const { container } = makeContainer({ remote: {} });
  const ctx = container.contextFor(["remote"]);
  assert.strictEqual(ctx.get("remote.session"), undefined);
});

await test("get 与 inject 无关：没声明也能取到", () => {
  const { container } = makeContainer({ alpha: 1 });
  const ctx = container.contextFor([]);
  assert.strictEqual(ctx.get("alpha"), 1);
});

/* ============================================================
   2. ctx.effect —— 卸载时的清理
   ============================================================ */

console.log("\n[2] ctx.effect（对齐 cordis fiber.effect）");

await test("effect 主体立即执行", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let ran = false;
  ctx.effect(() => { ran = true; });
  assert.strictEqual(ran, true);
});

await test("effect 返回的 disposer 被记录，卸载时逆序执行", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const order = [];
  ctx.effect(() => () => order.push("first"));
  ctx.effect(() => () => order.push("second"));
  ctx.__dispose();
  assert.deepStrictEqual(order, ["second", "first"], "要逆序");
});

await test("effect 返回 undefined 不报错（无清理动作）", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.doesNotThrow(() => ctx.effect(() => { /* 只做事，不清理 */ }));
});

await test("effect 返回 null 不报错", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.doesNotThrow(() => ctx.effect(() => null));
});

await test("effect 返回可迭代对象 → 每个元素都是 disposer", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const order = [];
  ctx.effect(() => [() => order.push("a"), () => order.push("b")]);
  ctx.__dispose();
  assert.deepStrictEqual(order, ["b", "a"]);
});

await test("effect 返回 Promise → 兑现后取 disposer", async () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let cleaned = false;
  ctx.effect(() => Promise.resolve(() => { cleaned = true; }));
  await new Promise((r) => setTimeout(r, 10));
  ctx.__dispose();
  assert.strictEqual(cleaned, true);
});

await test("effect 返回非法类型 → 抛 TypeError('Invalid effect')", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.throws(() => ctx.effect(() => 42), /Invalid effect/);
});

await test("effect 主体抛错 → 已收集的 disposer 照样执行", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let cleaned = false;
  assert.throws(() => {
    ctx.effect(() => {
      ctx.effect(() => () => { cleaned = true; });
      throw new Error("boom");
    });
  }, /boom/);
  assert.strictEqual(cleaned, true);
});

await test("effect 的返回值本身是个 disposer，可以单独调用", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let cleaned = false;
  const dispose = ctx.effect(() => () => { cleaned = true; });
  dispose();
  assert.strictEqual(cleaned, true);
});

await test("effect 接受 label 参数（诊断用）", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.doesNotThrow(() => ctx.effect(() => () => {}, "my label"));
});

/* ============================================================
   3. ctx.inject —— 等服务齐了再跑
   ============================================================ */

console.log("\n[3] ctx.inject（对齐 cordis registry.inject）");

await test("依赖齐了 → 回调立即执行", () => {
  const { container } = makeContainer({ alpha: 1, beta: 2 });
  const ctx = container.contextFor([]);
  let called = false;
  ctx.inject(["alpha", "beta"], () => { called = true; });
  assert.strictEqual(called, true);
});

await test("依赖缺失 → 回调不执行（不报错）", () => {
  const { container } = makeContainer({ alpha: 1 });
  const ctx = container.contextFor([]);
  let called = false;
  ctx.inject(["alpha", "missingOne"], () => { called = true; });
  assert.strictEqual(called, false, "缺服务时必须挂起");
});

await test("依赖后来到位 → 回调自动补跑", () => {
  const { container } = makeContainer({ alpha: 1 });
  const ctx = container.contextFor([]);
  let called = false;
  ctx.inject(["alpha", "latecomer"], () => { called = true; });
  assert.strictEqual(called, false);
  container.provide("latecomer", 99);
  assert.strictEqual(called, true, "服务到位后要补跑");
});

await test("inject 回调拿到的作用域 ctx 上有依赖服务", () => {
  const { container } = makeContainer({ alpha: { v: 7 } });
  const ctx = container.contextFor([]);
  let seen = null;
  ctx.inject(["alpha"], (scoped) => { seen = scoped.alpha; });
  assert.deepStrictEqual(seen, { v: 7 });
});

await test("作用域 ctx 继承了 effect 等核心 API", () => {
  const { container } = makeContainer({ alpha: 1 });
  const ctx = container.contextFor([]);
  let hasEffect = false;
  ctx.inject(["alpha"], (scoped) => {
    hasEffect = typeof scoped.effect === "function";
  });
  assert.strictEqual(hasEffect, true);
});

await test("inject 回调抛错 → 不影响其它插件", () => {
  const { container } = makeContainer({ alpha: 1 });
  const ctx = container.contextFor([]);
  assert.doesNotThrow(() => {
    ctx.inject(["alpha"], () => { throw new Error("callback boom"); });
  });
});

await test("inject 支持点号路径依赖", () => {
  const { container } = makeContainer({ remote: { session: { id: "s" } } });
  const ctx = container.contextFor([]);
  let called = false;
  ctx.inject(["remote.session"], () => { called = true; });
  assert.strictEqual(called, true);
});

/* ============================================================
   4. 事件 —— ctx.on / ctx.emit / ctx.once
   ============================================================ */

console.log("\n[4] 事件（对齐 cordis EventsService）");

await test("on 订阅后 emit 能收到", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const seen = [];
  ctx.on("some-event", (payload) => seen.push(payload));
  ctx.emit("some-event", 42);
  assert.deepStrictEqual(seen, [42]);
});

await test("on 返回退订函数", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let count = 0;
  const dispose = ctx.on("e", () => { count += 1; });
  ctx.emit("e");
  dispose();
  ctx.emit("e");
  assert.strictEqual(count, 1);
});

await test("once 只触发一次", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let count = 0;
  ctx.once("e", () => { count += 1; });
  ctx.emit("e");
  ctx.emit("e");
  assert.strictEqual(count, 1);
});

await test("emit 给所有监听器派发", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const seen = [];
  ctx.on("e", (v) => seen.push("a" + v));
  ctx.on("e", (v) => seen.push("b" + v));
  ctx.emit("e", 1);
  assert.deepStrictEqual(seen, ["a1", "b1"]);
});

await test("监听器抛错不影响其它监听器", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const seen = [];
  ctx.on("e", () => { throw new Error("listener boom"); });
  ctx.on("e", () => seen.push("ok"));
  assert.doesNotThrow(() => ctx.emit("e"));
  assert.deepStrictEqual(seen, ["ok"]);
});

await test("emit 无人监听时不报错", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.doesNotThrow(() => ctx.emit("nobody-listens"));
});

/* ============================================================
   5. ctx.fiber —— 插件自己的身份
   ============================================================ */

console.log("\n[5] ctx.fiber");

await test("fiber.entry.options.id 是插件 id", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([], { id: "my-plugin", name: "My Plugin" });
  assert.strictEqual(ctx.fiber.entry.options.id, "my-plugin");
});

await test("fiber.runtime.callback 是 apply 函数", () => {
  const { container } = makeContainer();
  const apply = () => {};
  const ctx = container.contextFor([], { id: "x", apply });
  assert.strictEqual(ctx.fiber.runtime.callback, apply);
});

await test("没有 meta 时 fiber 也不炸", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.ok(ctx.fiber);
  assert.ok(ctx.fiber.entry.options.id);
});

/* ============================================================
   6. applyPlugin —— 装载与失败隔离
   ============================================================ */

console.log("\n[6] applyPlugin（装载与失败隔离）");

await test("apply 成功 → 返回 disposer", () => {
  const { container } = makeContainer();
  const res = applyPlugin(container, { id: "p", apply: () => {} });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(typeof res.disposer, "function");
});

await test("apply 抛错 → 不影响，错误被记下", () => {
  const { container } = makeContainer();
  const res = applyPlugin(container, { id: "p", apply: () => { throw new Error("bad"); } });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /bad/);
});

await test("apply 抛错时已注册的 effect 被清理（不留定时器）", () => {
  const { container } = makeContainer();
  let cleaned = false;
  const res = applyPlugin(container, {
    id: "p",
    apply: (ctx) => {
      ctx.effect(() => () => { cleaned = true; });
      throw new Error("bad");
    },
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(cleaned, true, "失败的插件不能留下悬空资源");
});

await test("apply 返回函数 → 该函数即 disposer", () => {
  const { container } = makeContainer();
  let disposed = false;
  const res = applyPlugin(container, { id: "p", apply: () => () => { disposed = true; } });
  res.disposer();
  assert.strictEqual(disposed, true);
});

await test("disposer 同时清理 effect 与插件自有 disposer", () => {
  const { container } = makeContainer();
  const order = [];
  const res = applyPlugin(container, {
    id: "p",
    apply: (ctx) => {
      ctx.effect(() => () => order.push("effect"));
      return () => order.push("own");
    },
  });
  res.disposer();
  assert.deepStrictEqual(order, ["own", "effect"]);
});

await test("apply 能拿到声明的服务", () => {
  const { container } = makeContainer({ alpha: { v: 5 } });
  let seen = null;
  const res = applyPlugin(container, {
    id: "p", inject: ["alpha"], apply: (ctx) => { seen = ctx.alpha; },
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(seen, { v: 5 });
});

/* ============================================================
   7. llm 服务 —— 模型供应方注册表
   ============================================================ */

console.log("\n[7] llm 服务（对齐 @deepseek-ai/dsh-llm 契约）");

/** 造一个满足 adapter 契约的假 adapter。 */
function fakeAdapter() {
  return {
    providerInfo(provider) { return { provider, name: "Fake " + provider }; },
    async *stream() { /* 空流 */ },
  };
}

await test("registerAdapter 返回带 .replace 的句柄", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  const handle = llm.registerAdapter(["p1"], fakeAdapter());
  assert.strictEqual(typeof handle, "function", "句柄本身要能当函数调用");
  assert.strictEqual(typeof handle.replace, "function", "句柄要带 .replace");
});

await test("注册后路由表里有该路由", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  llm.registerAdapter(["p1"], fakeAdapter());
  assert.deepStrictEqual(llm.listRoutes().map((r) => r.provider), ["p1"]);
});

await test("调用句柄 → 释放路由", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  const handle = llm.registerAdapter(["p1"], fakeAdapter());
  handle();
  assert.strictEqual(llm.routeCount(), 0);
});

await test("replace 原子换路由集", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  const handle = llm.registerAdapter(["p1"], fakeAdapter());
  handle.replace(["p2", "p3"]);
  const providers = llm.listRoutes().map((r) => r.provider).sort();
  assert.deepStrictEqual(providers, ["p2", "p3"]);
});

await test("replace([]) 合法 —— 保持注册但持有零路由", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  const handle = llm.registerAdapter(["p1"], fakeAdapter());
  handle.replace([]);
  assert.strictEqual(llm.routeCount(), 0);
});

await test("重复注册同一路由 → 抛 DUPLICATE_ADAPTER", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  llm.registerAdapter(["p1"], fakeAdapter());
  assert.throws(() => llm.registerAdapter(["p1"], fakeAdapter()), /DUPLICATE_ADAPTER/);
});

await test("初始注册空路由集 → 抛 INVALID_ADAPTER", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  assert.throws(() => llm.registerAdapter([], fakeAdapter()), /INVALID_ADAPTER/);
});

await test("adapter 缺 stream 方法 → 抛 INVALID_ADAPTER", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  assert.throws(() => llm.registerAdapter(["p1"], { providerInfo() {} }), /INVALID_ADAPTER/);
});

await test("释放后 replace → 抛 REGISTRATION_DISPOSED", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  const handle = llm.registerAdapter(["p1"], fakeAdapter());
  handle();
  assert.throws(() => handle.replace(["p2"]), /REGISTRATION_DISPOSED/);
});

await test("replace 遇到冲突 → 抛错且当前路由不变", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  llm.registerAdapter(["other"], fakeAdapter());
  const handle = llm.registerAdapter(["p1"], fakeAdapter());
  assert.throws(() => handle.replace(["other"]), /DUPLICATE_ADAPTER/);
  assert.deepStrictEqual(llm.listRoutes().map((r) => r.provider).sort(), ["other", "p1"]);
});

await test("registerConfigurableProviders 返回带 .replace 的句柄", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  const handle = llm.registerConfigurableProviders([
    { provider: "p1", displayName: "P1", settingsNs: "ns1", settingsPath: [] },
  ]);
  assert.strictEqual(typeof handle, "function");
  assert.strictEqual(typeof handle.replace, "function");
  assert.strictEqual(llm.listDirectory().length, 1);
});

await test("registerModelDiscovery 返回撤销函数", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  const dispose = llm.registerModelDiscovery("ns1", async () => []);
  assert.strictEqual(typeof dispose, "function");
  assert.ok(llm.getDiscovery("ns1"));
  dispose();
  assert.strictEqual(llm.getDiscovery("ns1"), undefined);
});

await test("同一命名空间重复发现 → 抛 DUPLICATE_DISCOVERY", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  llm.registerModelDiscovery("ns1", async () => []);
  assert.throws(() => llm.registerModelDiscovery("ns1", async () => []), /DUPLICATE_DISCOVERY/);
});

await test("路由变化会通知宿主", () => {
  const { container } = makeContainer();
  const seen = [];
  const llm = createLlmService({ ctx: container, onRoutes: (r) => seen.push(r) });
  llm.registerAdapter(["p1"], fakeAdapter());
  assert.ok(seen.length > 0, "要通知宿主");
  assert.strictEqual(seen[seen.length - 1][0].provider, "p1");
});

await test("路由变化会发 llm/adapters-updated 事件", () => {
  const { container } = makeContainer();
  const llm = createLlmService({ ctx: container });
  const ctx = container.contextFor([]);
  let fired = 0;
  ctx.on("llm/adapters-updated", () => { fired += 1; });
  llm.registerAdapter(["p1"], fakeAdapter());
  assert.ok(fired > 0, "要发事件");
});

/* ---------------- 汇总 ---------------- */

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
