#!/usr/bin/env node
/* ============================================================
   桌面宿主服务（android/node/host-services.js）

   ============ 这个测试守的是什么 ============

   插件在 `inject` 里写 `settings` / `web` / `commands` 这些名字，
   cordis 的语义是「声明了但宿主没提供 → fiber 停在 PENDING，
   apply 根本不执行」，而且不报错。

   所以这些服务不是「锦上添花」，是「插件能不能启动」的开关。
   这里测两件事：

     1. 每个服务的接口行为（注册、读取、变更、清理）
     2. 最后一节：真的塞进容器，插件声明 inject 之后 apply 确实跑了

   用法：node tests/host-services-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_DIR = path.join(HERE, "..", "android", "node");

const { createHostServices } = require(path.join(NODE_DIR, "host-services.js"));
const { createContainer } = require(path.join(NODE_DIR, "cordis-lite.js"));

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

/** 造一个假的根上下文：只提供 emit（事件记录）和 currentScope。 */
function fakeRoot(events = []) {
  let scope = null;
  return {
    emit: (...args) => events.push(args),
    currentScope: () => scope,
    /** 模拟「现在某个插件在 apply」，返回一个可手动触发的收尾函数。 */
    enterScope() {
      const disposers = [];
      scope = { onDispose: (fn) => disposers.push(fn) };
      return () => {
        scope = null;
        for (const fn of disposers.reverse()) {
          try {
            fn();
          } catch {
            /* 清理失败不影响断言 */
          }
        }
      };
    },
  };
}

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-svc-"));
}

/* ============================================================
   ctx.settings
   ============================================================ */

console.log("\n[1] settings");

await test("注册后拿到默认值", async () => {
  const ws = tmpWorkspace();
  const root = fakeRoot();
  const { settings } = createHostServices({ ctx: root, workspace: ws });

  // schemastery 的 schema 就是个「调用即应用默认值」的函数
  const schema = (value) => ({ mode: "fast", limit: 10, ...(value || {}) });
  const scope = settings.register("demo", schema);

  assert.deepStrictEqual(scope.get(), { mode: "fast", limit: 10 });
  assert.deepStrictEqual(settings.get("demo"), { mode: "fast", limit: 10 });
});

await test("update 是合并：第二次更新不会丢掉第一次的键", async () => {
  const ws = tmpWorkspace();
  const { settings } = createHostServices({ ctx: fakeRoot(), workspace: ws });
  // 不带 schema（schema 只负责填默认值/校验，不该影响合并语义）
  const scope = settings.register("demo", null);

  await scope.update({ a: 1, b: { c: 2 } });
  await scope.update({ b: { d: 3 } });

  // b 是深层对象：两次写的是不同的键，都要在
  assert.deepStrictEqual(scope.get(), { a: 1, b: { c: 2, d: 3 } });
});

await test("replace 是整体替换（用来做「恢复默认」）", async () => {
  const ws = tmpWorkspace();
  const { settings } = createHostServices({ ctx: fakeRoot(), workspace: ws });
  const scope = settings.register("demo", (v) => ({ a: 1, b: { c: 2, d: 3 }, ...(v || {}) }));

  await scope.update({ b: { c: 99 } });
  await settings.replace("demo", { a: 5 });
  assert.deepStrictEqual(scope.get(), { a: 5, b: { c: 2, d: 3 } }, "没写的键回落到默认值");
});

await test("mutate 按路径改，不会碰到没提到的字段", async () => {
  const ws = tmpWorkspace();
  const { settings } = createHostServices({ ctx: fakeRoot(), workspace: ws });
  const scope = settings.register("demo", (v) => ({ a: 1, b: { c: 2, d: 3 }, ...(v || {}) }));

  await settings.mutate("demo", [
    { op: "set", path: ["b", "c"], value: 42 },
    { op: "unset", path: ["b", "d"] },
  ]);
  assert.deepStrictEqual(scope.get(), { a: 1, b: { c: 42 } });
});

await test("值落盘，重新读回来还在（重启不丢设置）", async () => {
  const ws = tmpWorkspace();
  const first = createHostServices({ ctx: fakeRoot(), workspace: ws });
  const s1 = first.settings.register("demo", (v) => ({ mode: "fast", ...(v || {}) }));
  await s1.update({ mode: "thorough" });

  const file = path.join(ws, "settings.json");
  assert.ok(fs.existsSync(file), "应该写出 settings.json");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(onDisk.demo, { mode: "thorough" });

  // 新实例读同一个文件
  const second = createHostServices({ ctx: fakeRoot(), workspace: ws });
  const s2 = second.settings.register("demo", (v) => ({ mode: "fast", ...(v || {}) }));
  assert.deepStrictEqual(s2.get(), { mode: "thorough" }, "重启后要读回用户设置");
});

await test("schema 不认的值：报错，而且不写盘", async () => {
  const ws = tmpWorkspace();
  const { settings } = createHostServices({ ctx: fakeRoot(), workspace: ws });
  // 一个会拒绝的 schema：mode 只能是 slow/fast
  const schema = (v) => {
    const m = (v && v.mode) || "fast";
    if (m !== "slow" && m !== "fast") throw new Error(`mode 只能是 slow 或 fast，收到 ${m}`);
    return { mode: m };
  };
  const scope = settings.register("strict", schema);

  await assert.rejects(() => scope.update({ mode: "乱写" }), /只能是 slow 或 fast/);
  assert.deepStrictEqual(scope.get(), { mode: "fast" }, "失败后值不该被改");
  const file = path.join(ws, "settings.json");
  const onDisk = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  assert.strictEqual(onDisk.strict, undefined, "校验失败不该落盘");
});

await test("同一个命名空间不能注册两次", async () => {
  const { settings } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  settings.register("dup", (v) => v || {});
  assert.throws(() => settings.register("dup", (v) => v || {}), /已经被注册/);
});

await test("命名空间必须是小写短横线", async () => {
  const { settings } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  assert.throws(() => settings.register("Bad_Name", (v) => v || {}), /小写短横线/);
});

await test("值变了才发 settings/updated", async () => {
  const events = [];
  const { settings } = createHostServices({ ctx: fakeRoot(events), workspace: tmpWorkspace() });
  const scope = settings.register("demo", (v) => ({ n: 0, ...(v || {}) }));

  await scope.update({ n: 1 });
  const hits = events.filter((e) => e[0] === "settings/updated");
  assert.strictEqual(hits.length, 1, "变一次发一次");

  await scope.update({ n: 1 }); // 同值
  assert.strictEqual(
    events.filter((e) => e[0] === "settings/updated").length,
    1,
    "值没变不该再发"
  );
});

await test("插件卸载时，它注册的命名空间跟着消失", async () => {
  const root = fakeRoot();
  const { settings } = createHostServices({ ctx: root, workspace: tmpWorkspace() });

  const dispose = root.enterScope();
  settings.register("temp", (v) => v || {});
  assert.ok(settings.get("temp"), "注册期间可读");

  dispose();
  assert.strictEqual(settings.get("temp"), undefined, "插件卸载后命名空间应该没了");
});

await test("configure({auto:false}) 返回 disposer，重复配置报错", async () => {
  const { settings } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });

  const owner = {}; // 桌面版这里传的是 ctx.fiber，我们只要是个稳定引用
  const dispose = settings.configure({ auto: false }, owner);
  assert.strictEqual(typeof dispose, "function", "插件把它塞进 ctx.effect，必须能拿到函数");
  assert.strictEqual(settings.presentationCount(), 1);

  // 同一个实例配置两次在桌面版里也是抛错
  assert.throws(() => settings.configure({ auto: false }, owner), /已经配置过/);

  dispose();
  assert.strictEqual(settings.presentationCount(), 0, "释放后可以重新配置");
});

await test("describe() 在没有 entry 模型时返回空数组，而不是抛错", () => {
  const { settings } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  // 真实插件会 describe().find(e => e.ns === 'web')，拿不到就跳过
  assert.deepStrictEqual(settings.describe({ redactSecrets: true }), []);
});

/* ============================================================
   ctx.web
   ============================================================ */

console.log("\n[2] web");

/** 一个最小的搜索 provider。 */
const searchProvider = (id, available = true) => ({
  id,
  available: () => available,
  // 故意不看 maxResults —— 测的就是「provider 多给了，接缝要截」
  search: async () => ({
    sources: Array.from({ length: 5 }, (_, i) => ({
      title: `${id}-${i}`,
      url: `https://example.com/${id}/${i}`,
    })),
  }),
});

await test("注册的搜索 provider 能被 search() 选中", async () => {
  const { web } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  web.registerSearchProvider(searchProvider("ddg"));

  const r = await web.search({ query: "dsh" });
  assert.strictEqual(r.sources.length, 5, "没限制时原样返回");
  assert.strictEqual(r.sources[0].title, "ddg-0");
});

await test("maxResults 在这一层强制截断（和桌面版一致）", async () => {
  const { web } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  web.registerSearchProvider(searchProvider("ddg"));
  const r = await web.search({ query: "x", maxResults: 2 });
  assert.strictEqual(r.sources.length, 2, "provider 给了 5 条，接缝要截到 2");
  assert.strictEqual(r.truncated, true);
});

await test("没有可用 provider 时报 WEB_PROVIDER_UNAVAILABLE", async () => {
  const { web } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  await assert.rejects(
    () => web.search({ query: "x" }),
    (e) => e.code === "WEB_PROVIDER_UNAVAILABLE"
  );
});

await test("多个可用 provider 且没配置 → AMBIGUOUS，而不是悄悄用第一个", async () => {
  const { web } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  web.registerSearchProvider(searchProvider("a"));
  web.registerSearchProvider(searchProvider("b"));

  await assert.rejects(
    () => web.search({ query: "x" }),
    (e) => e.code === "WEB_PROVIDER_AMBIGUOUS"
  );

  // 显式配置后就能选
  web.searchProvider = "b";
  const r = await web.search({ query: "x" });
  assert.strictEqual(r.sources[0].title, "b-0");
});

await test("配置了一个没注册的 id → CONFIGURED_MISSING", async () => {
  const { web } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  web.registerSearchProvider(searchProvider("a"));
  web.searchProvider = "不存在";
  await assert.rejects(
    () => web.search({ query: "x" }),
    (e) => e.code === "WEB_PROVIDER_CONFIGURED_MISSING"
  );
});

await test("同一个 id 注册两次要拦（否则后注册的会悄悄顶掉）", () => {
  const { web } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  web.registerSearchProvider(searchProvider("dup"));
  assert.throws(
    () => web.registerSearchProvider(searchProvider("dup")),
    (e) => e.code === "WEB_DUPLICATE_PROVIDER"
  );
});

await test("插件卸载后 provider 被撤掉", async () => {
  const root = fakeRoot();
  const { web } = createHostServices({ ctx: root, workspace: tmpWorkspace() });

  const dispose = root.enterScope();
  web.registerSearchProvider(searchProvider("temp"));
  assert.strictEqual(web.listProviders().search.length, 1);

  dispose();
  assert.strictEqual(web.listProviders().search.length, 0, "卸载后不该还在");
  await assert.rejects(
    () => web.search({ query: "x" }),
    (e) => e.code === "WEB_PROVIDER_UNAVAILABLE"
  );
});

/* ============================================================
   ctx.commands
   ============================================================ */

console.log("\n[3] commands");

await test("注册后能列出与查找", () => {
  const { commands } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  commands.register({ name: "export", description: "导出会话" });

  assert.deepStrictEqual(commands.list(), [{ name: "export", description: "导出会话" }]);
  assert.ok(commands.find(null, "export"));
  assert.strictEqual(commands.find(null, "没有"), undefined);
});

await test("同名命令不能注册两次", () => {
  const { commands } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  commands.register({ name: "dup" });
  assert.throws(() => commands.register({ name: "dup" }), /已经被注册/);
});

await test("执行命令时给出明确原因，而不是假装成功", async () => {
  const { commands } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  commands.register({ name: "export" });
  await assert.rejects(() => commands.execute(null, "/export"), /需要桌面端的会话上下文/);
});

await test("不存在的命令报错要说清楚是哪个", async () => {
  const { commands } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  await assert.rejects(() => commands.execute(null, "/nothing"), /没有这个命令：nothing/);
});

/* ============================================================
   ctx.systemPrompt
   ============================================================ */

console.log("\n[4] systemPrompt");

await test("段落、上下文、变量能拼成一段文本", async () => {
  const { systemPrompt } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  systemPrompt.section("你是一个助手。");
  systemPrompt.context("当前项目：dsh-mobile");
  systemPrompt.variable("日期", () => "2026-10-23");

  const text = await systemPrompt.assemble();
  assert.ok(text.includes("你是一个助手。"));
  assert.ok(text.includes("当前项目：dsh-mobile"));
  assert.ok(text.includes("日期: 2026-10-23"));
});

await test("什么都没注册时 assemble 返回空串（不是 undefined）", async () => {
  const { systemPrompt } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  assert.strictEqual(await systemPrompt.assemble(), "");
});

await test("插件卸载后它贡献的段落消失", async () => {
  const root = fakeRoot();
  const { systemPrompt } = createHostServices({ ctx: root, workspace: tmpWorkspace() });
  const dispose = root.enterScope();
  systemPrompt.section("临时段落");
  assert.ok((await systemPrompt.assemble()).includes("临时段落"));
  dispose();
  assert.strictEqual(await systemPrompt.assemble(), "");
});

/* ============================================================
   ctx.sessionQuery
   ============================================================ */

console.log("\n[5] sessionQuery");

await test("列得出当前会话，查得到它的标题", async () => {
  const { sessionQuery } = createHostServices({
    ctx: fakeRoot(),
    workspace: tmpWorkspace(),
    currentSession: { id: "s1", title: "今天聊的" },
  });
  const list = await sessionQuery.listSessions();
  assert.deepStrictEqual(list, [{ id: "s1", title: "今天聊的" }]);
  assert.strictEqual(await sessionQuery.readTitle("s1"), "今天聊的");
  assert.strictEqual(await sessionQuery.readTitle("别处"), "");
});

await test("没有历史索引时 filterSessions 如实返回空，而不是编", async () => {
  const { sessionQuery } = createHostServices({ ctx: fakeRoot(), workspace: tmpWorkspace() });
  assert.deepStrictEqual(await sessionQuery.filterSessions([{ kind: "title", value: "x" }]), []);
});

/* ============================================================
   最后一节：真的塞进容器，看插件能不能启动
   ============================================================ */

console.log("\n[6] 塞进容器：声明了就能启动");

await test("插件 inject 这五个服务后，apply 真的执行了", async () => {
  const ws = tmpWorkspace();
  const container = createContainer({ log: () => {} });
  const { settings, web, commands, systemPrompt, sessionQuery } = createHostServices({
    ctx: container.root,
    workspace: ws,
  });

  container.provide("settings", settings);
  container.provide("web", web);
  container.provide("commands", commands);
  container.provide("systemPrompt", systemPrompt);
  container.provide("sessionQuery", sessionQuery);

  let ran = false;
  let sawServices = null;

  const plugin = {
    name: "needs-host-services",
    inject: ["settings", "web", "commands", "systemPrompt", "sessionQuery"],
    apply(ctx) {
      ran = true;
      sawServices = {
        settings: typeof ctx.settings.register === "function",
        web: typeof ctx.web.registerSearchProvider === "function",
        commands: typeof ctx.commands.register === "function",
        systemPrompt: typeof ctx.systemPrompt.section === "function",
        sessionQuery: typeof ctx.sessionQuery.listSessions === "function",
      };

      // 真用一遍：注册设置、注册 provider、注册命令
      ctx.settings.register("demo", (v) => ({ on: true, ...(v || {}) }));
      ctx.web.registerSearchProvider({ id: "demo", available: () => true, search: async () => ({ sources: [] }) });
      ctx.commands.register({ name: "demo-cmd" });
      ctx.systemPrompt.section("demo 贡献的一段");
    },
  };

  // 走宿主那条路（plugin-host 里就是 container.apply(plugin)）
  const applied = container.apply(plugin);

  assert.strictEqual(ran, true, "apply 必须执行 —— 不执行就是 fiber 停在 PENDING");
  assert.deepStrictEqual(sawServices, {
    settings: true,
    web: true,
    commands: true,
    systemPrompt: true,
    sessionQuery: true,
  });
  assert.strictEqual(applied.ok, true);

  // 注册的东西真的进了服务
  assert.deepStrictEqual(settings.get("demo"), { on: true });
  assert.strictEqual(web.listProviders().search.length, 1);
  assert.deepStrictEqual(commands.list(), [{ name: "demo-cmd", description: "" }]);
  assert.ok((await systemPrompt.assemble()).includes("demo 贡献的一段"));
});

await test("少一个服务就整插件不启动（这正是之前的问题）", async () => {
  const container = createContainer({ log: () => {} });
  const { settings } = createHostServices({ ctx: container.root, workspace: tmpWorkspace() });
  container.provide("settings", settings);
  // 故意不提供 web

  let ran = false;
  const applied = container.apply({
    name: "needs-web",
    inject: ["settings", "web"],
    apply() {
      ran = true;
    },
  });

  assert.strictEqual(ran, false, "缺 web 时 apply 不该执行");
  assert.strictEqual(applied.pending, true, "应该被记为挂起，而不是失败");
});

await test("照真实插件的写法走一遍（inject 只写 web，其余用 ctx.inject 分层）", async () => {
  const ws = tmpWorkspace();
  const container = createContainer({ log: () => {} });
  const host = createHostServices({ ctx: container.root, workspace: ws });

  const tools = [];
  container.provide("tools", {
    register(t) {
      tools.push(t);
      return () => {};
    },
    list: () => tools,
  });
  container.provide("settings", host.settings);
  container.provide("web", host.web);

  const result = { applied: false, configured: null, injectedTools: 0 };

  // dsh-free-search 的形状：顶层 inject 只有 ["web"]，
  // settings / tools 都靠 ctx.inject 分层拿到 —— 缺一个不影响整体启动。
  const applied = container.apply({
    name: "like-free-search",
    inject: ["web"],
    apply(ctx) {
      result.applied = true;

      // 它注册自己的搜索实现
      ctx.web.registerSearchProvider({
        id: "ddg",
        available: () => true,
        search: async () => ({ sources: [{ title: "hi", url: "https://example.com" }] }),
      });
      ctx.web.searchProvider = "ddg";

      // 它声明「我自带设置页」
      ctx.inject(["settings"], (sctx) => {
        result.configured = sctx.settings.configure({ auto: false }, ctx.fiber);
      });

      // 它注册工具
      ctx.inject(["tools"], (sctx) => {
        sctx.tools.register({ name: "free_search", description: "搜索" });
        result.injectedTools += 1;
      });
    },
  });

  assert.strictEqual(applied.pending, undefined, "顶层 inject 只有 web，应当直接启动");
  assert.strictEqual(result.applied, true);
  assert.strictEqual(typeof result.configured, "function", "configure 要返回 disposer");
  assert.strictEqual(result.injectedTools, 1, "分层 inject 的回调要被执行");
  assert.strictEqual(host.web.listProviders().search[0].id, "ddg");
  assert.strictEqual(tools.length, 1);

  // 注册了就能真的用
  const r = await host.web.search({ query: "x" });
  assert.strictEqual(r.sources[0].title, "hi");
});

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
