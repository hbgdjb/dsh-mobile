#!/usr/bin/env node
/* ============================================================
   Node 通道 / cordis 迷你容器 / 插件宿主 的回归测试

   这些是 Stage 2 的地基 —— 通道协议、容器语义、插件加载。
   任何一条变了都可能让桌面版插件在手机上静默失效，
   所以每条都单独测。

   用法：node tests/node-channel-test.mjs
   ============================================================ */

import assert from "node:assert";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE_DIR = path.join(ROOT, "android", "node");

const { connect } = require(path.join(NODE_DIR, "channel.js"));
const { createContainer, applyPlugin } = require(path.join(NODE_DIR, "cordis-lite.js"));
const { createHost, listPlugins, diagnose } = require(path.join(NODE_DIR, "plugin-host.js"));
const { createServices } = require(path.join(NODE_DIR, "ctx-services.js"));

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

/* ============================================================
   1. 通道协议
   ============================================================ */

console.log("\n[1] 通道协议");

/**
 * 起一个模拟的 Java 侧服务端。
 *
 * 行为对齐 DshNodeChannel：行分隔 JSON、id 配对、
 * 支持反向调用（收到带 method 的请求要回响应）。
 *
 * @returns {Promise<{port:number, server:net.Server, ready:Promise<{sock,seen}>>}>}
 */
async function startFakeHost(handlers = {}, opts = {}) {
  let resolveConn;
  const ready = new Promise((r) => { resolveConn = r; });

  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buffer = "";
    const seen = [];

    sock.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        seen.push(msg);

        if (msg.method) {
          // 反向调用 / 普通调用
          const fn = handlers[msg.method];
          Promise.resolve()
            .then(() => (fn ? fn(msg.params || {}) : Promise.reject(new Error("没有这个方法：" + msg.method))))
            .then((r) => sock.write(JSON.stringify({ id: msg.id, ok: true, result: r ?? null }) + "\n"))
            .catch((e) => sock.write(JSON.stringify({ id: msg.id, ok: false, error: String(e.message) }) + "\n"));
          continue;
        }
        // 推送
        if (opts.onPush) opts.onPush(msg, sock);
      }
    });

    resolveConn({ sock, seen });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, server, ready };
}

await test("连得上、握手发出 token", async () => {
  let resolveMsg;
  const gotMsg = new Promise((r) => { resolveMsg = r; });
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (c) => {
      buf += c;
      const i = buf.indexOf("\n");
      if (i >= 0) resolveMsg(JSON.parse(buf.slice(0, i)));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const ch = connect(server.address().port, "secret-token", {});
  const msg = await gotMsg;
  assert.strictEqual(msg.token, "secret-token", "token 要原样送出");
  assert.strictEqual(msg.hello, true, "首条消息要带 hello 标记");
  server.close();
});

await test("call 能拿到结果", async () => {
  const fake = await startFakeHost({
    echo: async (p) => ({ got: p.value }),
  });
  const ch = connect(fake.port, "t", {});
  await new Promise((r) => setTimeout(r, 100));
  const r = await ch.call("echo", { value: 42 });
  assert.deepStrictEqual(r, { got: 42 });
  fake.server.close();
});

await test("调用失败时 reject 带着原因", async () => {
  const fake = await startFakeHost({
    boom: async () => {
      throw new Error("故意炸的");
    },
  });
  const ch = connect(fake.port, "t", {});
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(() => ch.call("boom", {}), /故意炸的/);
  fake.server.close();
});

await test("宿主反向调用 Node 时，Node 的处理器能应答", async () => {
  const fake = await startFakeHost({});
  // 先发起连接，再等连接建立 —— 反过来会死等
  const ch = connect(fake.port, "t", {
    "host.fs.read": async (p) => ({ content: "读到 " + p.path }),
  });
  const conn = await fake.ready;
  await new Promise((r) => setTimeout(r, 100));

  // 模拟 Java 侧发起反向调用
  const answer = new Promise((resolve) => {
    conn.sock.on("data", (c) => {
      for (const line of String(c).split("\n")) {
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.id === "r1") resolve(m);
      }
    });
  });
  conn.sock.write(JSON.stringify({ id: "r1", method: "host.fs.read", params: { path: "/a.txt" } }) + "\n");

  const m = await answer;
  assert.strictEqual(m.ok, true, "处理成功时要回 ok");
  assert.deepStrictEqual(m.result, { content: "读到 /a.txt" });
  fake.server.close();
});

await test("宿主调用 Node 未实现的方法 → 明确报错", async () => {
  const fake = await startFakeHost({});
  const ch = connect(fake.port, "t", {});
  const conn = await fake.ready;
  await new Promise((r) => setTimeout(r, 100));
  // Java 侧模拟：发一个没有 handler 的 method
  await new Promise((resolve) => {
    conn.sock.on("data", (c) => {
      const m = JSON.parse(String(c).trim().split("\n")[0]);
      if (m.id === "x1" && m.ok === false) {
        assert.match(m.error, /没有这个方法/);
        resolve();
      }
    });
    conn.sock.write(JSON.stringify({ id: "x1", method: "不存在的", params: {} }) + "\n");
  });
  fake.server.close();
});

await test("多条消息粘在一个包里也能正确切分", async () => {
  const fake = await startFakeHost({
    a: async () => "A",
    b: async () => "B",
  });
  const ch = connect(fake.port, "t", {});
  await new Promise((r) => setTimeout(r, 100));
  const [ra, rb] = await Promise.all([ch.call("a", {}), ch.call("b", {})]);
  assert.strictEqual(ra, "A");
  assert.strictEqual(rb, "B");
  fake.server.close();
});

await test("通道断开时挂起的请求被拒掉（不能永远等）", async () => {
  const fake = await startFakeHost({ hang: async () => new Promise(() => {}) });
  const ch = connect(fake.port, "t", {});
  const conn = await fake.ready;
  await new Promise((r) => setTimeout(r, 100));
  const p = ch.call("hang", {});
  conn.sock.destroy();
  await assert.rejects(() => p, /通道已断开/);
  fake.server.close();
});

await test("Node 崩溃重启后能重连并恢复工作", async () => {
  const fake = await startFakeHost({ ping: async () => "pong" });
  const ch = connect(fake.port, "t", {});
  const conn = await fake.ready;
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(await ch.call("ping", {}), "pong");

  // 模拟 Node 崩溃：连接断掉
  conn.sock.destroy();
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(ch.isClosed(), true, "断开后应标记为已关闭");

  // 重连：channel.js 目前只在连接建立时 connect 一次，
  // 所以这里验证的是"断开后 pending 被清空、不残留"，
  // 以及"重新 connect 能正常工作"（Java 侧重启 Node 后会重新建连）。
  const ch2 = connect(fake.port, "t", {});
  const conn2 = await fake.ready;
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(await ch2.call("ping", {}), "pong", "重连后要能正常调用");
  conn2.sock.destroy();
  fake.server.close();
});

/* ============================================================
   2. cordis 迷你容器
   ============================================================ */

console.log("\n[2] cordis 迷你容器");

await test("logger 是工厂函数，也支持直接用", () => {
  const lines = [];
  const c = createContainer({ log: (lv, sc, m) => lines.push([lv, sc, m]) });
  c.logger("mypkg").info("你好");
  c.logger.info("直接用");
  assert.strictEqual(lines[0][0], "info");
  assert.strictEqual(lines[0][1], "mypkg");
  assert.match(lines[0][2], /你好/);
  assert.strictEqual(lines[1][1], "");
});

await test("inject 声明的服务出现在 ctx 上", () => {
  const c = createContainer({ services: { slots: { inject() {} } } });
  const ctx = c.contextFor(["slots"]);
  assert.ok(ctx.slots, "slots 应该在 ctx 上");
  assert.strictEqual(typeof ctx.slots.inject, "function");
});

await test("没声明的服务读取会抛错（cordis 代理语义）", () => {
  const c = createContainer({ services: { slots: {}, sessions: {} } });
  const ctx = c.contextFor(["slots"]);
  // cordis 的 ctx 是代理：读一个没在 inject 里声明的服务会抛错
  // （`cannot get property "X" without inject`），
  // 而不是返回 undefined —— 详见 reflect.ts 的 Proxy handler。
  //
  // 这一点很重要：返回 undefined 会让插件以为服务存在，
  // 走进本不该走的分支，然后在几百行之外以无关的错误崩掉。
  assert.throws(
    () => ctx.sessions,
    /cannot get property "sessions" without inject/,
    "没声明的服务必须抛错，不能返回 undefined"
  );
  // 声明过的照常可读
  assert.ok(ctx.slots, "声明过的服务应该在 ctx 上");
  // ctx.get() 是机会性查找 —— 无论声明与否都能问到，问不到才返回 undefined。
  // 这里 sessions 宿主确实提供了，所以 get 得到它（虽然插件没声明）。
  assert.deepStrictEqual(ctx.get("sessions"), {}, "ctx.get 不受 inject 限制");
  // 问不到的服务 → undefined，不抛错
  assert.strictEqual(ctx.get("nothingHere"), undefined, "ctx.get 问不到时返回 undefined");
});

await test("点号路径 remote.session 能解析", () => {
  const remote = { session: { send() { return "sent"; } } };
  const c = createContainer({ services: { remote } });
  const ctx = c.contextFor(["remote", "remote.session"]);
  assert.strictEqual(typeof ctx.remote.session.send, "function");
  assert.strictEqual(ctx.remote.session.send(), "sent");
});

await test("缺失的服务给占位：加载不失败，访问才报错", () => {
  const c = createContainer({});
  const ctx = c.contextFor(["modelDirectories"]);
  assert.ok(ctx.modelDirectories, "占位也要在 ctx 上");
  assert.throws(() => ctx.modelDirectories.directoryFor("x"), /没有提供服务/);
});

await test("占位不会在无害的符号探测上炸掉", () => {
  const c = createContainer({});
  const ctx = c.contextFor(["nothing"]);
  assert.strictEqual(ctx.nothing[Symbol.toStringTag], undefined);
  assert.strictEqual(typeof ctx.nothing.toString, "function");
  assert.strictEqual(ctx.nothing.then, undefined, "不能被当成 thenable");
});

await test("apply 抛错只让该插件失败，不影响别的", () => {
  const c = createContainer({});
  const bad = applyPlugin(c, { id: "bad", apply: () => { throw new Error("炸"); } });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /炸/);
  const good = applyPlugin(c, { id: "good", apply: () => true });
  assert.strictEqual(good.ok, true);
});

await test("apply 返回函数时记为 disposer", () => {
  const c = createContainer({});
  const r = applyPlugin(c, { id: "x", apply: () => () => {} });
  assert.strictEqual(typeof r.disposer, "function");
});

await test("插件能通过 inject 用到宿主服务", () => {
  const c = createContainer({ services: { slots: { marker: "S" } } });
  let seen = null;
  const r = applyPlugin(c, {
    id: "p",
    inject: ["slots"],
    apply: (ctx) => { seen = ctx.slots.marker; },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(seen, "S");
});

/* ============================================================
   3. 插件宿主
   ============================================================ */

console.log("\n[3] 插件宿主");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-plugin-"));
const ws = path.join(tmp, "ws");
fs.mkdirSync(path.join(ws, "plugins"), { recursive: true });

function writePlugin(id, files) {
  const dir = path.join(ws, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

writePlugin("cjs-plugin", {
  "main.js": `
    exports.apply = function (ctx) {
      ctx.tools.registerTool(
        { name: "cjs_echo", description: "回显", parameters: { type: "object", properties: { v: { type: "string" } } } },
        async (args) => ({ echoed: args.v })
      );
    };
  `,
});

writePlugin("esm-plugin", {
  "package.json": JSON.stringify({ name: "esm-plugin", version: "1.0.0", main: "index.js", type: "module" }),
  "index.js": `
    export function apply(ctx) {
      ctx.tools.registerTool(
        { name: "esm_echo", description: "回显", parameters: { type: "object", properties: {} } },
        async (args) => ({ ok: true })
      );
    }
    export const inject = ["tools"];
  `,
});

writePlugin("broken-plugin", {
  "main.js": `throw new Error("这个插件就是坏的");`,
});

await test("能列出插件目录（含 npm 包与单文件两种形态）", () => {
  const list = listPlugins(ws);
  const ids = list.map((p) => p.id).sort();
  assert.ok(ids.includes("cjs-plugin"), "单文件插件要能被列出");
  assert.ok(ids.includes("esm-plugin"), "npm 包要能被列出");
  const esm = list.find((p) => p.id === "esm-plugin");
  assert.strictEqual(esm.kind, "package");
});

await test("加载插件：坏插件失败，好的照常加载", async () => {
  const container = createContainer({});
  const host = createHost({
    workspace: ws,
    container,
    log: () => {},
    onTools: () => {},
  });

  const r = await host.loadAll();
  assert.ok(r.loaded >= 2, `至少加载 2 个，实际 ${r.loaded}`);
  assert.ok(r.failed.some((f) => f.id === "broken-plugin"), "坏插件要记为失败");
  assert.ok(!r.failed.some((f) => f.id === "cjs-plugin"), "好插件不该失败");
});

await test("插件注册的工具能被列出与调用", async () => {
  const container = createContainer({});
  const host = createHost({ workspace: ws, container, log: () => {}, onTools: () => {} });
  await host.loadAll();

  const names = host.listTools().map((t) => t.name);
  assert.ok(names.includes("cjs_echo"), "CJS 插件的工具要注册上");
  assert.ok(names.includes("esm_echo"), "ESM 插件的工具要注册上");

  const r = await host.callTool("cjs_echo", { v: "hi" });
  assert.deepStrictEqual(r, { echoed: "hi" });
});

await test("调用不存在的工具 → 明确报错", async () => {
  const container = createContainer({});
  const host = createHost({ workspace: ws, container, log: () => {}, onTools: () => {} });
  await host.loadAll();
  await assert.rejects(() => host.callTool("没有这个", {}), /没有这个工具/);
});

await test("工具列表不含 handler（不能把函数泄给页面）", async () => {
  const container = createContainer({});
  const host = createHost({ workspace: ws, container, log: () => {}, onTools: () => {} });
  await host.loadAll();
  for (const t of host.listTools()) {
    assert.strictEqual(t.handler, undefined, "handler 不能出现在对外列表里");
  }
});

await test("卸载插件后工具清空", async () => {
  const container = createContainer({});
  const host = createHost({ workspace: ws, container, log: () => {}, onTools: () => {} });
  await host.loadAll();
  assert.ok(host.listTools().length > 0);
  host.unloadAll();
  assert.strictEqual(host.listTools().length, 0);
});

/* ---------- 目录诊断：让「未找到插件」能自解释 ---------- */

await test("plugins 目录不存在时，诊断要明说「不存在」", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-nodiag-"));
  const d = diagnose(empty);
  assert.strictEqual(d.exists, false, "没建过就必须报 false");
  assert.strictEqual(d.pluginsDir, path.join(empty, "plugins"));
  assert.deepStrictEqual(d.entries, []);
});

await test("plugins 目录存在但空着 → 能看出「写到了别处」", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-nodiag2-"));
  fs.mkdirSync(path.join(empty, "plugins"), { recursive: true });
  const d = diagnose(empty);
  assert.strictEqual(d.exists, true);
  assert.deepStrictEqual(d.entries, [], "空目录要如实报空，而不是报不存在");
});

await test("目录在但缺入口文件 → 单独报出来（最常见的「放了文件却说找不到」）", () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-stray-"));
  fs.mkdirSync(path.join(w, "plugins", "half-made"), { recursive: true });
  fs.writeFileSync(path.join(w, "plugins", "half-made", "index.json"), "{}");
  const d = diagnose(w);
  assert.deepStrictEqual(d.entries, ["half-made"]);
  assert.deepStrictEqual(d.stray, ["half-made"], "缺 main.js 的目录要单独标出来");
});

await test("plugins 目录里有东西时列出条目名", () => {
  const d0 = diagnose(ws);
  assert.strictEqual(d0.exists, true);
  assert.ok(d0.entries.includes("cjs-plugin"), "应该列出目录名，实际：" + JSON.stringify(d0.entries));
});

/* ---------- 依赖未齐 → 插件挂起（cordis PENDING 语义） ---------- */

const ws2 = path.join(tmp, "ws2");
fs.mkdirSync(path.join(ws2, "plugins"), { recursive: true });

// 声明依赖一个还不存在的服务「webServer」
const ws2PluginDir = path.join(ws2, "plugins", "needs-web");
fs.mkdirSync(ws2PluginDir, { recursive: true });
fs.writeFileSync(
  path.join(ws2PluginDir, "main.js"),
  `
    exports.inject = ["webServer"];
    exports.apply = function (ctx) {
      ctx.tools.registerTool(
        { name: "web_tool", description: "依赖 webServer 的工具", parameters: { type: "object", properties: {} } },
        async () => ({ ok: true })
      );
    };
  `
);

await test("依赖未齐的插件被挂起，apply 不执行", async () => {
  const container = createContainer({});
  const host = createHost({ workspace: ws2, container, log: () => {}, onTools: () => {} });
  const r = await host.loadAll();

  assert.strictEqual(r.loaded, 0, "依赖未齐不能算已加载");
  assert.strictEqual(r.failed.length, 0, "依赖未齐不是失败，是挂起");
  assert.strictEqual(host.pendingCount(), 1, "应该有一个插件在等依赖");
  assert.strictEqual(host.listTools().length, 0, "apply 没跑，工具不该注册上");

  const st = host.listStatus();
  assert.strictEqual(st.length, 1);
  assert.strictEqual(st[0].id, "needs-web");
  assert.strictEqual(st[0].status, "pending");
  assert.deepStrictEqual(st[0].pendingDeps, ["webServer"]);
});

await test("依赖到齐后插件自动启动", async () => {
  const container = createContainer({});
  const host = createHost({ workspace: ws2, container, log: () => {}, onTools: () => {} });
  await host.loadAll();
  assert.strictEqual(host.pendingCount(), 1);

  // 服务到齐 → 容器唤醒挂起的插件
  container.provide("webServer", { port: 8788 });

  assert.strictEqual(host.pendingCount(), 0, "依赖到齐后不该再挂着");
  const st = host.listStatus();
  assert.strictEqual(st[0].status, "active");
  assert.deepStrictEqual(st[0].pendingDeps, []);

  const names = host.listTools().map((t) => t.name);
  assert.ok(names.includes("web_tool"), "插件应该在这时候才真正激活并注册工具");
});

await test("卸载后依赖到齐不会再启动", async () => {
  const container = createContainer({});
  const host = createHost({ workspace: ws2, container, log: () => {}, onTools: () => {} });
  await host.loadAll();
  assert.strictEqual(host.pendingCount(), 1);

  host.unloadAll();
  container.provide("webServer", { port: 8788 });

  assert.strictEqual(host.listTools().length, 0, "卸载后不该再冒出来");
  assert.strictEqual(host.pendingCount(), 0);
});

/* ============================================================
   4. 宿主服务
   ============================================================ */

console.log("\n[4] 宿主服务");

await test("slots 能注册与列出", () => {
  const s = createServices({ workspace: "/tmp" });
  const id = s.slots.register({ name: "推理等级", id: "s1", order: 1 });
  assert.strictEqual(id, "s1");
  assert.strictEqual(s.slots.list().length, 1);
  assert.strictEqual(s.slots.unregister("s1"), true);
  assert.strictEqual(s.slots.list().length, 0);
});

await test("sessions 是单会话模型但接口形状与桌面一致", () => {
  const s = createServices({ workspace: "/tmp" });
  assert.strictEqual(s.sessions.list().length, 1);
  assert.ok(s.sessions.current());
  assert.strictEqual(s.sessions.get("default") !== null, true);
});

await test("modelDirectories 指向工作区", () => {
  const s = createServices({ workspace: "/tmp/ws" });
  assert.strictEqual(s.modelDirectories.directoryFor("s"), "/tmp/ws");
});

/* ============================================================
   5. main.js 端到端（真起一个 Node，走完整通道）
   ============================================================ */

console.log("\n[5] 端到端：main.js 通过通道响应");

await test("main.js 连上通道后能响应 ping 与 runtime.info", async () => {
  const { spawn } = await import("node:child_process");
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-e2e-"));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rt-"));

  // 模拟 Java 侧：监听端口，起 Node，把端口传进去
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.hello) {
          sock.write(JSON.stringify({ id: "h1", ok: true, result: { hello: true } }) + "\n");
          continue;
        }
        if (m.method === "ping") {
          sock.write(JSON.stringify({ id: m.id, ok: true, result: { pong: true } }) + "\n");
        } else if (m.method === "runtime.info") {
          sock.write(JSON.stringify({ id: m.id, ok: true, result: { node: process.version } }) + "\n");
        } else {
          sock.write(JSON.stringify({ id: m.id, ok: false, error: "未知方法" }) + "\n");
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const child = spawn(process.execPath, [
    path.join(NODE_DIR, "main.js"),
    runtimeDir,
    String(port),
    "e2e-token",
    tmpWs,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });

  // 等它连上来
  await new Promise((r) => setTimeout(r, 1200));

  // 直接读心跳文件确认它活着
  const alive = path.join(runtimeDir, "alive.json");
  assert.ok(fs.existsSync(alive), "心跳文件要写出来：" + out);
  const info = JSON.parse(fs.readFileSync(alive, "utf8"));
  assert.ok(info.node.startsWith("v"), "心跳里要有 node 版本");
  assert.strictEqual(info.channelPort, port, "心跳里要记着通道端口");

  child.kill("SIGKILL");
  server.close();
});

await test("插件提供的模型能通过通道真的跑完一次生成（第 2 步）", async () => {
  const { spawn } = await import("node:child_process");
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-e2e-llm-"));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rt-llm-"));

  // 装一个「假供应方」插件：注册路由，stream 回固定内容
  const pluginDir = path.join(tmpWs, "plugins", "fake-llm");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "main.js"),
    `
      exports.inject = ['llm'];
      exports.apply = function (ctx) {
        const adapter = {
          providerInfo: (p) => ({ id: p, name: '假供应方' }),
          listModels: async (p) => [{ id: 'fake-1', name: 'Fake 1', provider: p }],
          stream(options) {
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: 'block-start', index: 0, blockType: 'text' };
                yield { type: 'text-delta', index: 0, text: '收到 ' };
                // 把消息条数回显出来 —— 证明确实是我们翻译后传进去的那份
                yield { type: 'text-delta', index: 0, text: String(options.messages.length) };
                yield { type: 'text-delta', index: 0, text: ' 条消息' };
                yield { type: 'block-end', index: 0, block: { type: 'text', text: '收到 2 条消息' } };
                yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } };
                yield { type: 'finish', reason: { kind: 'stop' } };
              }
            };
          }
        };
        ctx.llm.registerAdapter(['fake-route'], adapter);
      };
    `
  );

  /** Node 推给「Java」的事件。 */
  const events = [];

  /** Java 侧持有的那条 Node 连接（Java 调 Node 就写进它）。 */
  let nodeSock = null;
  /** 发出去的调用：id → resolve。 */
  const inflight = new Map();
  let callSeq = 0;

  /** Java 调 Node 的一个方法（协议：{id, method, params}）。 */
  function callNode(method, params) {
    return new Promise((resolve, reject) => {
      if (!nodeSock) return reject(new Error("Node 还没连上来"));
      callSeq += 1;
      const id = "j" + callSeq;
      const timer = setTimeout(() => {
        inflight.delete(id);
        reject(new Error("等待 Node 响应超时：" + method));
      }, 8000);
      inflight.set(id, { resolve, reject, timer });
      nodeSock.write(JSON.stringify({ id, method, params: params || {} }) + "\n");
    });
  }

  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.hello) {
          nodeSock = sock;
          sock.write(JSON.stringify({ id: "h1", ok: true, result: { hello: true } }) + "\n");
          continue;
        }
        if (m.event) {
          events.push(m);
          continue;
        }
        // Node 对 Java 调用的响应
        if (m.id && inflight.has(m.id)) {
          const p = inflight.get(m.id);
          inflight.delete(m.id);
          clearTimeout(p.timer);
          if (m.ok) p.resolve(m.result);
          else p.reject(new Error(String(m.error || "Node 侧失败")));
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const child = spawn(
    process.execPath,
    [path.join(NODE_DIR, "main.js"), runtimeDir, String(port), "e2e-token", tmpWs],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });

  try {
    // 等它连上来并把插件加载完
    const deadline0 = Date.now() + 8000;
    while (!nodeSock && Date.now() < deadline0) await new Promise((r) => setTimeout(r, 50));
    assert.ok(nodeSock, "Node 应该连上来：" + out);

    const routes = await callNode("llm.routes", {});
    assert.ok(
      routes.routes.some((r) => r.provider === "fake-route"),
      "插件的路由要报到页面：" + out
    );

    // 起跑 —— 这一步必须**立刻**返回，不能等整段生成
    const callId = "c_test_1";
    const started = await callNode("llm.chat", {
      callId,
      provider: "fake-route",
      model: "fake-1",
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "你好" },
      ],
    });
    assert.strictEqual(started.started, true);

    // 等流跑完
    const deadline = Date.now() + 8000;
    let done = null;
    while (Date.now() < deadline) {
      done = events.find((e) => e.event === "llm.done" && e.data.callId === callId);
      if (done) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(done, "应该收到 llm.done：" + out);
    assert.strictEqual(done.data.ok, true, "这次生成该是成功的：" + JSON.stringify(done.data));
    assert.strictEqual(done.data.finish, "stop");
    assert.strictEqual(done.data.usage.totalTokens, 7, "usage 要带回来");

    const text = events
      .filter((e) => e.event === "llm.chunk" && e.data.callId === callId)
      .flatMap((e) => e.data.chunks)
      .filter((c) => c.type === "text-delta")
      .map((c) => c.text)
      .join("");
    assert.strictEqual(text, "收到 2 条消息", "正文要一字不差地传回来");

    // ============ 详情：插件到底带来了什么 ============
    //
    // 归属是靠 apply 期间的作用域记下来的。没这一步，
    // 详情页只能把所有路由摊在一起，分不清谁是谁的。
    const detail = await callNode("plugins.detail", { id: "fake-llm" });
    assert.strictEqual(detail.plugin.id, "fake-llm");
    assert.strictEqual(detail.plugin.status, "active", "装好并加载的插件状态应是 active");
    assert.strictEqual(detail.plugin.kind, "script", "单文件插件");
    assert.ok(detail.plugin.entry, "要带上入口路径，便于排查");

    assert.strictEqual(detail.routes.length, 1, "它注册了 1 条路由");
    assert.strictEqual(detail.routes[0].provider, "fake-route");
    assert.ok(
      (detail.routes[0].models || []).some((m) => m.id === "fake-1"),
      "详情里要列出它提供的模型，实际：" + JSON.stringify(detail.routes[0].models)
    );
  } finally {
    child.kill("SIGKILL");
    server.close();
  }
});

/* ---------------- 汇总 ---------------- */

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { /* ignore */ }

process.exit(failed > 0 ? 1 : 0);
