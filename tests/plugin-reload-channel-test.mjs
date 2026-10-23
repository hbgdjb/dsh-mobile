#!/usr/bin/env node
/* ============================================================
   热重载的通道层端到端测试

   上一套测试测的是「宿主 API 直接调用」。
   这一套测的是**真起一个 Node 进程、连真通道**，
   走页面侧会用到的那些方法：

     plugins.list → plugins.reload → tool.call

   为什么要单独测一层：
   页面上的「重载」按钮走的就是这条路径。
   宿主 API 对、通道方法名写错，页面照样点不动 ——
   那种错只有端到端才抓得到。

   用法：node tests/plugin-reload-channel-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE_DIR = path.join(ROOT, "android", "node");

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
    if (e && e.stack) console.error(e.stack.split("\n").slice(1, 5).join("\n"));
  }
}

/**
 * 起一个 Node 进程 + 模拟 Java 侧的通道服务端。
 *
 * 返回一个可以直接调 Node 方法的 client。
 */
async function startNodeWithWorkspace(workspace) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rl-rt-"));

  const pending = new Map();
  let seq = 0;
  /** Node 连上来的 socket —— 请求要通过它发出去。 */
  const sockets = new Set();

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error || "调用失败"));
        }
      }
    });
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sockets.delete(sock));
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const child = spawn(
    process.execPath,
    [path.join(NODE_DIR, "main.js"), runtimeDir, String(port), "tok", workspace],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let log = "";
  child.stdout.on("data", (d) => {
    log += d.toString();
  });
  child.stderr.on("data", (d) => {
    log += d.toString();
  });

  // 等它连上来
  await new Promise((r) => setTimeout(r, 1500));

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `c${++seq}`;
      pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ id, method, params }) + "\n";
      if (!sockets.size) {
        pending.delete(id);
        reject(new Error(`Node 没连上通道。日志：\n${log.slice(-600)}`));
        return;
      }
      for (const s of sockets) s.write(payload);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method} 超时。Node 日志：\n${log.slice(-600)}`));
        }
      }, 15000);
    });

  return {
    call,
    getLog: () => log,
    stop: () => {
      child.kill("SIGKILL");
      server.close();
    },
  };
}

/* ============================================================
   1. 通道上的重载
   ============================================================ */

console.log("\n[1] 通道上的热重载");

await test("改代码 → 通道重载 → tool.call 拿到新值", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rl-ws-"));
  const pdir = path.join(ws, "plugins", "ch-plugin");
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(
    path.join(pdir, "main.js"),
    `
      exports.apply = function (ctx) {
        ctx.tools.registerTool({ name: "ch_echo", description: "通道回声" }, () => ({ v: 1 }));
      };
    `
  );

  const node = await startNodeWithWorkspace(ws);
  try {
    const before = await node.call("tool.call", { name: "ch_echo", args: {} });
    assert.deepStrictEqual(before, { v: 1 }, "重载前是旧值");

    // 改代码
    fs.writeFileSync(
      path.join(pdir, "main.js"),
      `
        exports.apply = function (ctx) {
          ctx.tools.registerTool({ name: "ch_echo", description: "通道回声" }, () => ({ v: 2 }));
        };
      `
    );

    const r = await node.call("plugins.reload", { id: "ch-plugin" });
    assert.ok(r && r.ok, `重载要成功：${JSON.stringify(r)}`);

    const after = await node.call("tool.call", { name: "ch_echo", args: {} });
    assert.deepStrictEqual(after, { v: 2 }, "重载后是新值");
  } finally {
    node.stop();
  }
});

await test("plugins.list 能报出 failed 状态和原因", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rl-ws2-"));
  const pdir = path.join(ws, "plugins", "bad-plugin");
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, "main.js"), `syntax ((( error`);

  const node = await startNodeWithWorkspace(ws);
  try {
    const r = await node.call("plugins.list", {});
    const row = (r.plugins || []).find((p) => p.id === "bad-plugin");
    assert.ok(row, `列表里要有这个插件：${JSON.stringify(r.plugins)}`);
    assert.strictEqual(row.status, "failed", `状态要是 failed，实际 ${row.status}`);
    assert.ok(row.error && row.error.length > 0, "要带上失败原因");
  } finally {
    node.stop();
  }
});

await test("plugins.reload 不带 id 就是重载全部", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rl-ws3-"));
  const pdir = path.join(ws, "plugins", "all-plugin");
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(
    path.join(pdir, "main.js"),
    `
      exports.apply = function (ctx) {
        ctx.tools.registerTool({ name: "all_echo", description: "全部" }, () => ({ v: 1 }));
      };
    `
  );

  const node = await startNodeWithWorkspace(ws);
  try {
    fs.writeFileSync(
      path.join(pdir, "main.js"),
      `
        exports.apply = function (ctx) {
          ctx.tools.registerTool({ name: "all_echo", description: "全部" }, () => ({ v: 3 }));
        };
      `
    );
    const r = await node.call("plugins.reload", {});
    assert.ok(r && r.ok, `重载要成功：${JSON.stringify(r)}`);
    assert.ok(Array.isArray(r.results) && r.results.length >= 1, "要报出每个插件的结果");

    const after = await node.call("tool.call", { name: "all_echo", args: {} });
    assert.deepStrictEqual(after, { v: 3 }, "重载后是新值");
  } finally {
    node.stop();
  }
});

await test("plugins.loadnew 只加载新的，不重跑已在跑的", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rl-ws4-"));
  const pdir = path.join(ws, "plugins", "count-plugin");
  fs.mkdirSync(pdir, { recursive: true });
  const counter = path.join(ws, "apply-count.txt");
  fs.writeFileSync(
    path.join(pdir, "main.js"),
    `
      const fs = require("fs");
      exports.apply = function (ctx) {
        const f = ${JSON.stringify(counter)};
        let n = 0;
        try { n = parseInt(fs.readFileSync(f, "utf8") || "0", 10) || 0; } catch {}
        fs.writeFileSync(f, String(n + 1));
        ctx.tools.registerTool({ name: "cnt", description: "计数" }, () => ({ n: n + 1 }));
      };
    `
  );

  const node = await startNodeWithWorkspace(ws);
  try {
    const first = parseInt(fs.readFileSync(counter, "utf8") || "0", 10);
    assert.strictEqual(first, 1, "启动时 apply 一次");

    // 再调一次 loadnew —— 已经在跑的不该被重跑
    await node.call("plugins.loadnew", {});
    const second = parseInt(fs.readFileSync(counter, "utf8") || "0", 10);
    assert.strictEqual(second, 1, `已加载的不能被重跑，实际 ${second}`);

    // 装个新插件，再 loadnew
    const p2 = path.join(ws, "plugins", "second-plugin");
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(
      path.join(p2, "main.js"),
      `
        exports.apply = function (ctx) {
          ctx.tools.registerTool({ name: "second", description: "第二个" }, () => "ok");
        };
      `
    );
    await node.call("plugins.loadnew", {});
    const r = await node.call("tool.call", { name: "second", args: {} });
    assert.strictEqual(r, "ok", "新插件要能跑");
    const third = parseInt(fs.readFileSync(counter, "utf8") || "0", 10);
    assert.strictEqual(third, 1, "装新插件也不能重跑旧的");
  } finally {
    node.stop();
  }
});

/* ---------------- 收尾 ---------------- */

console.log(`\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项失败`}（${passed + failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
