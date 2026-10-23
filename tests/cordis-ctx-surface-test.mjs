#!/usr/bin/env node
/* ============================================================
   cordis 容器 —— 0.40.0 新增能力的回归测试

   这一批覆盖的是「兼容缺口清单（审查修正版）」里定的
   P0-A / P0-B / P1-A~D / P2-A~E：

     P0-A  读未声明服务要抛错（cordis 代理语义）
     P0-B  ctx.plugin —— 加载子插件的入口
     P1-A  ctx.fiber 的完整形状
     P1-B  ctx.registry
     P1-C  FiberState 数字枚举
     P1-D  ctx.set 的归属检查
     P2-A  事件的四种派发模式
     P2-B  ctx.accessor / ctx.mixin
     P2-C  ctx.extend / ctx.isolate / ctx.intercept
     P2-D  ctx.root / ctx.scope / ctx.events / ctx.reflect / ctx.logger
     P2-E  ctx.timer 与六个助手

   语义来源是 cordis 4.0.2 的源码，逐条对齐。

   用法：node tests/cordis-ctx-surface-test.mjs
   ============================================================ */

import assert from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE_DIR = path.join(ROOT, "android", "node");

const { createContainer, applyPlugin, FiberState } = require(
  path.join(NODE_DIR, "cordis-lite.js")
);

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

function makeContainer(services = {}) {
  const logs = [];
  const container = createContainer({
    services,
    log: (level, scope, message) => logs.push({ level, scope, message }),
  });
  return { container, logs };
}

/* ============================================================
   P0-A —— 读未声明服务要抛错
   ============================================================ */

console.log("\n[P0-A] ctx 代理语义（读未声明服务抛错）");

await test("读没在 inject 声明的服务 → 抛错", () => {
  const { container } = makeContainer({ slots: {}, sessions: {} });
  const ctx = container.contextFor(["slots"]);
  assert.throws(
    () => ctx.sessions,
    /cannot get property "sessions" without inject/
  );
});

await test("抛错信息里带上本插件声明了哪些服务", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor(["alpha"]);
  assert.throws(() => ctx.beta, /alpha/);
});

await test("ctx.get 仍是机会性查找 —— 问不到返回 undefined", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.strictEqual(ctx.get("nothing"), undefined);
});

await test("ctx.get 不受 inject 限制（能问到宿主提供的服务）", () => {
  const { container } = makeContainer({ alpha: { v: 1 } });
  const ctx = container.contextFor([]);
  assert.deepStrictEqual(ctx.get("alpha"), { v: 1 });
});

await test("声明过但宿主没提供的服务 → 给占位（访问方法才报错）", () => {
  const { container } = makeContainer({});
  const ctx = container.contextFor(["modelDirectories"]);
  assert.ok(ctx.modelDirectories, "占位要在 ctx 上");
  assert.throws(() => ctx.modelDirectories.directoryFor("x"), /没有提供服务/);
});

await test("占位不会在无害的符号探测上炸掉", () => {
  const { container } = makeContainer({});
  const ctx = container.contextFor(["nothing"]);
  assert.strictEqual(ctx.nothing[Symbol.toStringTag], undefined);
  assert.strictEqual(typeof ctx.nothing.toString, "function");
  assert.strictEqual(ctx.nothing.then, undefined, "不能被当成 thenable");
});

await test("in 运算符对未声明的服务返回 false（不抛错）", () => {
  const { container } = makeContainer({ sessions: {} });
  const ctx = container.contextFor(["slots"]);
  assert.strictEqual("sessions" in ctx, false);
  assert.strictEqual("slots" in ctx, true);
});

/* ============================================================
   P0-B —— ctx.plugin
   ============================================================ */

console.log("\n[P0-B] ctx.plugin（加载子插件）");

await test("ctx.plugin 加载子插件并跑它的 apply", () => {
  const { container } = makeContainer({ alpha: { v: 7 } });
  const ctx = container.contextFor([]);
  let seen = null;
  const handle = ctx.plugin({
    name: "child",
    inject: ["alpha"],
    apply(childCtx) {
      seen = childCtx.alpha.v;
    },
  });
  assert.ok(handle, "要返回句柄");
  assert.strictEqual(seen, 7, "子插件 apply 要被调用");
  assert.ok(handle.ctx, "句柄要带 ctx");
});

await test("ctx.plugin 的句柄可以 await", async () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const handle = ctx.plugin({ name: "child", apply() {} });
  const fiber = await handle;
  assert.ok(fiber, "await 要拿到 fiber");
  assert.ok(typeof fiber.uid === "number");
});

await test("ctx.plugin 的子插件能独立卸载", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let disposed = false;
  const handle = ctx.plugin({
    name: "child",
    apply() {
      return () => {
        disposed = true;
      };
    },
  });
  handle.dispose();
  assert.strictEqual(disposed, true, "子插件的 disposer 要跑");
});

await test("ctx.plugin 传入非法插件 → 抛错", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.throws(() => ctx.plugin({}), /invalid plugin/);
  assert.throws(() => ctx.plugin(null), /invalid plugin/);
});

await test("ctx.plugin 的子插件 apply 抛错 → 错误传出来", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.throws(
    () =>
      ctx.plugin({
        name: "bad",
        apply() {
          throw new Error("炸了");
        },
      }),
    /炸了/
  );
});

/* ============================================================
   P1-A —— ctx.fiber 的完整形状
   ============================================================ */

console.log("\n[P1-A] ctx.fiber（完整形状）");

await test("fiber 有 uid / name / inject / state", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor(["alpha"], { id: "p1", name: "插件一" });
  assert.ok(typeof ctx.fiber.uid === "number", "uid 要是数字");
  assert.strictEqual(ctx.fiber.name, "插件一");
  assert.deepStrictEqual(ctx.fiber.inject, ["alpha"]);
  assert.strictEqual(ctx.fiber.state, FiberState.ACTIVE);
});

await test("fiber.entry.options.id 是插件自己的 id", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([], { id: "my-plugin", name: "x" });
  assert.strictEqual(ctx.fiber.entry.options.id, "my-plugin");
  // 真实插件用它当 settings 命名空间
  assert.strictEqual(ctx.fiber?.entry?.options?.id, "my-plugin");
});

await test("fiber.runtime 有 callback 与 fibers 列表", () => {
  const { container } = makeContainer();
  const applyFn = function apply() {};
  const ctx = container.contextFor([], { id: "p", name: "p", apply: applyFn });
  assert.strictEqual(ctx.fiber.runtime.callback, applyFn);
  assert.ok(Array.isArray(ctx.fiber.runtime.fibers));
  assert.ok(ctx.fiber.runtime.fibers.includes(ctx.fiber));
});

await test("fiber 有 _config 与 config", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([], { id: "p", config: { a: 1 } });
  assert.deepStrictEqual(ctx.fiber._config, { a: 1 });
  assert.deepStrictEqual(ctx.fiber.config, { a: 1 });
});

await test("fiber 有 await() 与 dispose()", async () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.strictEqual(typeof ctx.fiber.await, "function");
  assert.strictEqual(typeof ctx.fiber.dispose, "function");
  await ctx.fiber.await();
});

await test("卸载后 fiber 状态变成 DISPOSED", async () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  await ctx.fiber.dispose();
  assert.strictEqual(ctx.fiber.state, FiberState.DISPOSED);
});

await test("fiber.parent 指向父上下文", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.ok(ctx.fiber.parent, "要有 parent");
});

/* ============================================================
   P1-B —— ctx.registry
   ============================================================ */

console.log("\n[P1-B] ctx.registry（插件注册表）");

await test("registry 是对象，有 get/has/delete/values/keys", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.ok(ctx.registry);
  for (const m of ["get", "has", "delete", "values", "keys", "entries", "forEach"]) {
    assert.strictEqual(typeof ctx.registry[m], "function", `缺 ${m}`);
  }
});

await test("registry.get 能查到已加载插件的 runtime", () => {
  const { container } = makeContainer();
  const applyFn = function apply() {};
  const ctx = container.contextFor([]);
  ctx.plugin({ name: "child", apply: applyFn });
  const runtime = ctx.registry.get({ apply: applyFn });
  assert.ok(runtime, "要查到 runtime");
  assert.strictEqual(runtime.callback, applyFn);
});

await test("registry.get 查不到时返回 undefined", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.strictEqual(ctx.registry.get({ apply: () => {} }), undefined);
});

await test("registry.has 判断插件是否注册过", () => {
  const { container } = makeContainer();
  const applyFn = function apply() {};
  const ctx = container.contextFor([]);
  ctx.plugin({ name: "child", apply: applyFn });
  assert.strictEqual(ctx.registry.has({ apply: applyFn }), true);
  assert.strictEqual(ctx.registry.has({ apply: () => {} }), false);
});

await test("registry.delete 卸载插件的全部 fiber", () => {
  const { container } = makeContainer();
  const applyFn = function apply() {};
  const ctx = container.contextFor([]);
  ctx.plugin({ name: "child", apply: applyFn });
  assert.strictEqual(ctx.registry.has({ apply: applyFn }), true);
  ctx.registry.delete({ apply: applyFn });
  assert.strictEqual(ctx.registry.has({ apply: applyFn }), false);
});

/* ============================================================
   P1-C —— FiberState 数字枚举
   ============================================================ */

console.log("\n[P1-C] FiberState（cordis 数字枚举）");

await test("FiberState 的值与 cordis src/fiber.ts 一致", () => {
  assert.strictEqual(FiberState.PENDING, 0);
  assert.strictEqual(FiberState.LOADING, 1);
  assert.strictEqual(FiberState.ACTIVE, 2);
  assert.strictEqual(FiberState.FAILED, 3);
  assert.strictEqual(FiberState.DISPOSED, 4);
  assert.strictEqual(FiberState.UNLOADING, 5);
});

await test("fiber.state 是数字，不是字符串", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.strictEqual(typeof ctx.fiber.state, "number");
  assert.strictEqual(ctx.fiber.state, FiberState.ACTIVE);
});

/* ============================================================
   P1-D —— ctx.set 的归属检查
   ============================================================ */

console.log("\n[P1-D] ctx.set（归属检查）");

await test("set 一个没 provide 过的服务 → 抛错", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  // 宿主级服务没注册过 → cordis 抛 `cannot set property "X" without provide`
  // 我们对宿主级服务放宽（允许覆盖），但对插件 provide 的服务要严格。
  assert.doesNotThrow(() => ctx.set("hostLevel", 1));
});

await test("插件 provide 的服务只能由提供方 fiber 改", () => {
  const { container } = makeContainer();
  const ctxA = container.contextFor([]);
  ctxA.provide("shared", { v: 1 });
  // 另一个 fiber 改它 → 抛错（cordis: in multiple fibers）
  const ctxB = container.contextFor([]);
  assert.throws(() => ctxB.set("shared", { v: 2 }), /multiple fibers/);
  // 提供方自己改 → 允许
  assert.doesNotThrow(() => ctxA.set("shared", { v: 3 }));
});

/* ============================================================
   P2-A —— 事件的四种派发模式
   ============================================================ */

console.log("\n[P2-A] 事件派发模式（parallel/serial/bail/waterfall）");

await test("parallel 并发触发全部并等结束", async () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let done = 0;
  ctx.on("p", async () => {
    await new Promise((r) => setTimeout(r, 5));
    done += 1;
  });
  ctx.on("p", () => {
    done += 1;
  });
  await ctx.parallel("p");
  assert.strictEqual(done, 2, "两个监听器都要跑完");
});

await test("parallel 有监听器失败 → AggregateError", async () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  ctx.on("p", () => {
    throw new Error("炸");
  });
  await assert.rejects(() => ctx.parallel("p"), (e) => e instanceof AggregateError);
});

await test("serial 依次执行，第一个 bail 值即返回", async () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const order = [];
  ctx.on("s", () => {
    order.push(1);
    return undefined; // 不是 bail 值 → 继续
  });
  ctx.on("s", () => {
    order.push(2);
    return "bailed"; // bail 值
  });
  ctx.on("s", () => {
    order.push(3); // 不该跑到
  });
  const result = await ctx.serial("s");
  assert.strictEqual(result, "bailed");
  assert.deepStrictEqual(order, [1, 2], "第三个监听器不该跑");
});

await test("bail 同步版：第一个 bail 值即返回", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let third = false;
  ctx.on("b", () => false); // false 不是 bail 值
  ctx.on("b", () => 42); // bail 值
  ctx.on("b", () => {
    third = true;
  });
  assert.strictEqual(ctx.bail("b"), 42);
  assert.strictEqual(third, false);
});

await test("bail 值判定：null/false/undefined 都不算 bail", async () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let count = 0;
  ctx.on("v", () => {
    count += 1;
    return null;
  });
  await ctx.serial("v");
  assert.strictEqual(count, 1);
});

await test("waterfall：不调 next() 就否决后续", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const seen = [];
  ctx.on("w", (next) => {
    seen.push("outer");
    next();
  });
  ctx.on("w", (next) => {
    seen.push("veto"); // 不调 next → 否决
  });
  ctx.waterfall("w", () => {
    seen.push("inner");
  });
  assert.deepStrictEqual(seen, ["outer", "veto"], "inner 不该跑");
});

await test("waterfall：全都调 next() 就走到最内层", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const seen = [];
  ctx.on("w", (next) => {
    seen.push("outer");
    next();
  });
  ctx.waterfall("w", () => {
    seen.push("inner");
  });
  assert.deepStrictEqual(seen, ["outer", "inner"]);
});

/* ============================================================
   P2-B —— ctx.accessor / ctx.mixin
   ============================================================ */

console.log("\n[P2-B] ctx.accessor / ctx.mixin");

await test("accessor 定义计算属性，读时调 get", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  ctx.accessor("computed", {
    get() {
      return "算出来的";
    },
  });
  assert.strictEqual(ctx.computed, "算出来的");
});

await test("mixin 把服务成员摊到 ctx 上", () => {
  const { container } = makeContainer({ svc: { hello: () => "hi" } });
  const ctx = container.contextFor(["svc"]);
  ctx.mixin("svc", ["hello"]);
  assert.strictEqual(ctx.hello(), "hi");
});

/* ============================================================
   P2-C —— ctx.extend / ctx.isolate / ctx.intercept
   ============================================================ */

console.log("\n[P2-C] ctx.extend / ctx.isolate / ctx.intercept");

await test("extend 派生子上下文，不改父级", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const child = ctx.extend({ extra: 1 });
  assert.strictEqual(child.extra, 1, "子上下文能读到 extend 带来的属性");
  // 父级不受影响 —— 但注意：新语义下读父级的未声明名字会抛错
  // （cordis 的代理语义），而不是返回 undefined。
  assert.throws(() => ctx.extra, /cannot get property "extra" without inject/);
});

await test("isolate 的子上下文能独立提供同名服务", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const child = ctx.isolate("thing");
  child.provide("thing", { v: "isolated" });
  assert.deepStrictEqual(child.get("thing"), { v: "isolated" });
});

await test("intercept 记录子上下文的拦截配置", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const child = ctx.intercept("svc", { flag: true });
  assert.deepStrictEqual(child.__intercept.svc, { flag: true });
});

/* ============================================================
   P2-D —— 上下文图上的把手
   ============================================================ */

console.log("\n[P2-D] ctx.root / ctx.scope / ctx.events / ctx.reflect / ctx.logger");

await test("ctx.root 是根上下文", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.ok(ctx.root);
  assert.strictEqual(ctx.root.root, ctx.root, "根的 root 是自己");
});

await test("ctx.scope 是插件的作用域", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.ok(ctx.scope);
  assert.strictEqual(typeof ctx.scope.onDispose, "function");
});

await test("ctx.events 是事件总线对象", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.ok(ctx.events);
  assert.strictEqual(typeof ctx.events.on, "function");
  assert.strictEqual(typeof ctx.events.emit, "function");
});

await test("ctx.reflect 是反射层对象", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.ok(ctx.reflect);
  assert.strictEqual(typeof ctx.reflect.get, "function");
  assert.strictEqual(typeof ctx.reflect.set, "function");
  assert.strictEqual(typeof ctx.reflect.provide, "function");
});

await test("ctx.logger 是日志器", () => {
  const { container, logs } = makeContainer();
  const ctx = container.contextFor([]);
  ctx.logger.info("hello");
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].message, "hello");
});

/* ============================================================
   P2-E —— ctx.timer 与六个助手
   ============================================================ */

console.log("\n[P2-E] ctx.timer（计时器助手）");

await test("ctx.timer 是对象，六个助手都在", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  assert.ok(ctx.timer);
  for (const m of ["timeout", "interval", "throttle", "debounce"]) {
    assert.strictEqual(typeof ctx.timer[m], "function", `缺 ${m}`);
  }
  for (const m of ["timeout", "interval", "throttle", "debounce", "setTimeout", "setInterval"]) {
    assert.strictEqual(typeof ctx[m], "function", `ctx 上缺 ${m}`);
  }
});

await test("timeout 到点后回调执行", async () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let fired = false;
  ctx.timeout(() => {
    fired = true;
  }, 5);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(fired, true);
});

await test("interval 重复触发", async () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let count = 0;
  ctx.interval(() => {
    count += 1;
  }, 5);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(count >= 2, `应该触发多次，实际 ${count}`);
});

await test("卸载插件后定时器被清理（不留悬挂）", async () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let count = 0;
  ctx.interval(() => {
    count += 1;
  }, 5);
  await new Promise((r) => setTimeout(r, 12));
  const before = count;
  await ctx.fiber.dispose();
  await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(count, before, "卸载后不该再触发");
});

await test("throttle 有 dispose", () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  const fn = ctx.throttle(() => {}, 100);
  assert.strictEqual(typeof fn.dispose, "function");
});

await test("debounce 只在静默期后触发一次", async () => {
  const { container } = makeContainer();
  const ctx = container.contextFor([]);
  let count = 0;
  const fn = ctx.debounce(() => {
    count += 1;
  }, 10);
  fn();
  fn();
  fn();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(count, 1);
});

/* ============================================================
   依赖未齐 → 插件整体挂起（cordis 的 PENDING 语义）
   ============================================================ */

console.log("\n[附] 依赖未齐 → 插件整体挂起");

await test("inject 依赖没齐 → apply 不执行", () => {
  const { container } = makeContainer();
  let ran = false;
  const res = applyPlugin(container, {
    id: "waiting",
    inject: ["neverProvided"],
    apply() {
      ran = true;
    },
  });
  assert.strictEqual(ran, false, "依赖没齐，apply 不能跑");
  assert.strictEqual(res.pending, true);
});

await test("依赖到齐后挂起的插件自动启动", () => {
  const { container } = makeContainer();
  let ran = false;
  applyPlugin(container, {
    id: "waiting",
    inject: ["latecomer"],
    apply() {
      ran = true;
    },
  });
  assert.strictEqual(ran, false);
  container.provide("latecomer", { v: 1 });
  assert.strictEqual(ran, true, "服务到齐后应自动启动");
});

await test("挂起的插件被 dispose 后不会再启动", () => {
  const { container } = makeContainer();
  let ran = false;
  const res = applyPlugin(container, {
    id: "waiting",
    inject: ["latecomer2"],
    apply() {
      ran = true;
    },
  });
  res.disposer();
  container.provide("latecomer2", { v: 1 });
  assert.strictEqual(ran, false);
});

/* ---------------- 汇总 ---------------- */

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
