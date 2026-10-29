#!/usr/bin/env node
/* ============================================================
   界面宿主的通道层端到端测试

   上一套测的是两半：Node 侧服务（ui-service）、页面侧渲染（ui-host）。
   这一套测的是**中间那条缝** —— 真起一个 Node 进程、真连 TCP 通道，
   走页面实际会走的路径：

     插件 apply → ui.mount 推送 → ui.snapshot → ui.action → ui.update

   为什么必须单独测这一层：
   两半各自都对，方法名写错一个字（ui.action vs ui.act）页面照样点不动。
   那种错只有端到端才抓得到。

   用法：node tests/ui-channel-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

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
 * 起一个 Node 进程 + 假 Java 侧通道。
 *
 * 与热重载那套的区别：这里要**收推送**（event），
 * 因为界面挂载完全是推送驱动的 —— 页面不轮询。
 */
async function startNode(workspace) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ui-rt-"));

  const pending = new Map();
  const events = [];
  const sockets = new Set();
  let seq = 0;

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
        if (msg.event) {
          events.push({ event: msg.event, data: msg.data });
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
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));

  await new Promise((r) => setTimeout(r, 1600));

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `c${++seq}`;
      pending.set(id, { resolve, reject });
      if (!sockets.size) {
        pending.delete(id);
        reject(new Error(`Node 没连上通道。日志：\n${log.slice(-800)}`));
        return;
      }
      for (const s of sockets) s.write(JSON.stringify({ id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method} 超时。日志：\n${log.slice(-800)}`));
        }
      }, 15000);
    });

  return {
    call,
    events,
    /** 找某个事件的记录。 */
    find: (name) => events.filter((e) => e.event === name),
    reset: () => (events.length = 0),
    getLog: () => log,
    stop: () => {
      child.kill("SIGKILL");
      server.close();
    },
  };
}

/** 写一个带 package.json 的插件（清单里有权限声明）。 */
function writePlugin(ws, id, { permissions = [], surfaces = [], code }) {
  const dir = path.join(ws, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: `dsh-plugin-${id}`,
        version: "1.0.0",
        main: "main.js",
        dsh: { displayName: id, permissions, surfaces },
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(dir, "main.js"), code);
  return dir;
}

/**
 * 插件在宿主里的真实 id。
 *
 * 不是目录名 —— 是清单里的 name。这个区别踩过一次：
 * `plugins.reload({id:'life'})` 查不到 `dsh-plugin-life`，
 * 于是走了「首次加载」分支，旧实例没卸、新实例又挂了一遍。
 */
const pluginIdOf = (dirName) => `dsh-plugin-${dirName}`;

/* ============================================================
   1. 挂载
   ============================================================ */

console.log("\n[1] 挂载");

await test("插件 apply 时挂的界面会推给页面", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ui-ws-"));
  writePlugin(ws, "toolbar", {
    permissions: ["ui.slot"],
    surfaces: ["composer.toolbar"],
    code: `
      exports.inject = ['slots'];
      exports.apply = function (ctx) {
        const r = ctx.slots.mount('composer.toolbar', {
          type: 'row',
          gap: 'sm',
          children: [
            { type: 'badge', text: '通道' },
            { type: 'button', label: '跑一下', action: 'run' },
          ],
        }, { id: 'ch-toolbar' });
        if (!r.ok) throw new Error(r.error);
      };
    `,
  });

  const node = await startNode(ws);
  try {
    const mounts = node.find("ui.mount");
    assert.strictEqual(mounts.length, 1, `应该收到一次 ui.mount，实际 ${mounts.length}`);
    const d = mounts[0].data;
    assert.strictEqual(d.id, "ch-toolbar");
    assert.strictEqual(d.slot, "composer.toolbar");
    assert.strictEqual(d.pluginId, pluginIdOf("toolbar"));
    assert.strictEqual(d.tree.children[1].label, "跑一下");
  } finally {
    node.stop();
  }
});

await test("没声明 ui.slot 的插件挂不上去，原因能拿到", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ui-ws2-"));
  writePlugin(ws, "stingy", {
    permissions: ["fs.read"],
    code: `
      exports.inject = ['slots', 'tools'];
      exports.apply = function (ctx) {
        const r = ctx.slots.mount('composer.toolbar', { type: 'text', text: 'x' });
        ctx.tools.registerTool({ name: 'mount_result', description: '挂载结果' }, () => r);
      };
    `,
  });

  const node = await startNode(ws);
  try {
    assert.strictEqual(node.find("ui.mount").length, 0, "不该有挂载推送");
    const r = await node.call("tool.call", { name: "mount_result", args: {} });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /ui\.slot/);
  } finally {
    node.stop();
  }
});

await test("挂到清单没声明的挂载点也被拒", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ui-ws3-"));
  writePlugin(ws, "narrow", {
    permissions: ["ui.slot"],
    surfaces: ["settings.section"],
    code: `
      exports.inject = ['slots', 'tools'];
      exports.apply = function (ctx) {
        const r = ctx.slots.mount('shell.overlay', { type: 'text', text: 'x' });
        ctx.tools.registerTool({ name: 'narrow_result', description: '结果' }, () => r);
      };
    `,
  });

  const node = await startNode(ws);
  try {
    const r = await node.call("tool.call", { name: "narrow_result", args: {} });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /settings\.section/);
  } finally {
    node.stop();
  }
});

/* ============================================================
   2. 快照与交互
   ============================================================ */

console.log("\n[2] 快照与交互");

await test("ui.snapshot 能把挂载连树一起给回来", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ui-ws4-"));
  writePlugin(ws, "snap", {
    permissions: ["ui.slot"],
    code: `
      exports.inject = ['slots'];
      exports.apply = function (ctx) {
        ctx.slots.mount('sidebar.footer', { type: 'text', text: '抽屉底部' }, { id: 'snap-1' });
      };
    `,
  });

  const node = await startNode(ws);
  try {
    const r = await node.call("ui.snapshot", {});
    assert.strictEqual(r.mounts.length, 1);
    assert.strictEqual(r.mounts[0].id, "snap-1");
    assert.strictEqual(r.mounts[0].tree.text, "抽屉底部");
  } finally {
    node.stop();
  }
});

await test("ui.action 调插件回调，返回的树推成 ui.update", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ui-ws5-"));
  writePlugin(ws, "clicky", {
    permissions: ["ui.slot"],
    surfaces: ["composer.toolbar"],
    code: `
      exports.inject = ['slots'];
      exports.apply = function (ctx) {
        const id = 'clicky-1';
        const r = ctx.slots.mount('composer.toolbar', {
          type: 'button', label: '原样', action: 'go'
        }, { id });
        if (!r.ok) throw new Error(r.error);
        ctx.slots.onAction(id, function (action, value) {
          return { type: 'text', text: '收到 ' + action + ':' + value };
        });
      };
    `,
  });

  const node = await startNode(ws);
  try {
    node.reset();
    const out = await node.call("ui.action", { id: "clicky-1", action: "go", value: 7 });
    assert.strictEqual(out.ok, true, out.error);

    const updates = node.find("ui.update");
    assert.strictEqual(updates.length, 1, `应该有一次 ui.update，实际 ${updates.length}`);
    assert.strictEqual(updates[0].data.tree.text, "收到 go:7");
  } finally {
    node.stop();
  }
});

await test("回调抛错时 ui.action 如实返回原因", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ui-ws6-"));
  writePlugin(ws, "angry", {
    permissions: ["ui.slot"],
    surfaces: ["composer.toolbar"],
    code: `
      exports.inject = ['slots'];
      exports.apply = function (ctx) {
        const id = 'angry-1';
        ctx.slots.mount('composer.toolbar', { type: 'button', label: '炸', action: 'boom' }, { id });
        ctx.slots.onAction(id, function () { throw new Error('回调炸了'); });
      };
    `,
  });

  const node = await startNode(ws);
  try {
    const out = await node.call("ui.action", { id: "angry-1", action: "boom" });
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /回调炸了/);
  } finally {
    node.stop();
  }
});

/* ============================================================
   3. 生命周期
   ============================================================ */

console.log("\n[3] 生命周期");

await test("重载插件：旧的先卸、新的再挂", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ui-ws7-"));
  const codeV1 = `
    exports.inject = ['slots'];
    exports.apply = function (ctx) {
      ctx.slots.mount('composer.toolbar', { type: 'text', text: 'v1' }, { id: 'life-1' });
    };
  `;
  const dir = writePlugin(ws, "life", {
    permissions: ["ui.slot"],
    surfaces: ["composer.toolbar"],
    code: codeV1,
  });

  const node = await startNode(ws);
  try {
    node.reset();
    fs.writeFileSync(
      path.join(dir, "main.js"),
      codeV1.replace("'v1'", "'v2'")
    );

    const r = await node.call("plugins.reload", { id: pluginIdOf("life") });
    assert.ok(r && r.ok, `重载要成功：${JSON.stringify(r)}`);

    const order = node.events.filter((e) => e.event === "ui.unmount" || e.event === "ui.mount");
    const unmountIdx = order.findIndex((e) => e.event === "ui.unmount");
    const mountIdx = order.findIndex((e) => e.event === "ui.mount");
    assert.ok(unmountIdx >= 0, "重载要先卸掉旧界面");
    assert.ok(mountIdx > unmountIdx, "新的界面要在卸载之后挂上");

    const snap = await node.call("ui.snapshot", {});
    const mine = snap.mounts.filter((m) => m.id === "life-1");
    assert.strictEqual(mine.length, 1, "同一个 id 不该留下两份");
    assert.strictEqual(mine[0].tree.text, "v2", "应该是新代码的界面");
  } finally {
    node.stop();
  }
});

await test("ui.list 能看出哪些挂上了、哪些只注册未渲染", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ui-ws8-"));
  writePlugin(ws, "mixed", {
    permissions: ["ui.slot"],
    code: `
      exports.inject = ['slots'];
      exports.apply = function (ctx) {
        ctx.slots.mount('composer.toolbar', { type: 'text', text: '真的挂上' }, { id: 'real-1' });
        // 老写法：传一个组件函数
        ctx.slots.register({ id: 'legacy-1', name: 'composer.toolbar' }, function Component() {});
      };
    `,
  });

  const node = await startNode(ws);
  try {
    const r = await node.call("ui.list", {});
    const real = r.mounts.find((m) => m.id === "real-1");
    const legacy = r.mounts.find((m) => m.id === "legacy-1");
    assert.ok(real && real.rendered === true, "新接口挂的应该标 rendered");
    assert.ok(legacy, "老接口的注册记录也要在");
    assert.strictEqual(legacy.rendered, false);
    assert.match(legacy.reason, /跨进程/);
  } finally {
    node.stop();
  }
});

/* ============================================================
   4. 示例插件
   ============================================================ */

console.log("\n[4] 示例插件");

await test("tests/fixtures/writing-kit 装上就能用", async () => {
  // 这个 fixture 同时是文档：README 让用户照抄的那份代码就是它。
  // 它要是坏了，文档里的写法就是错的 —— 所以放进测试里跑一遍。
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ui-ws9-"));
  const src = path.join(ROOT, "tests", "fixtures", "writing-kit");
  const dst = path.join(ws, "plugins", "writing-kit");
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }

  const node = await startNode(ws);
  try {
    const mounts = node.find("ui.mount");
    assert.strictEqual(mounts.length, 1, `示例插件应该挂上一块：${node.getLog().slice(-500)}`);
    const d = mounts[0].data;
    assert.strictEqual(d.slot, "composer.toolbar");
    assert.strictEqual(d.tree.children[0].text, "写作套件");

    // 点一下，应该收到 update
    node.reset();
    const out = await node.call("ui.action", { id: d.id, action: "polish" });
    assert.strictEqual(out.ok, true, out.error);
    const upd = node.find("ui.update");
    assert.strictEqual(upd.length, 1, "应该回推一棵新树");
    assert.match(upd[0].data.tree.children[1].text, /已润色/);

    // 同一份能力也给 AI 用
    const tool = await node.call("tool.call", {
      name: "writing_polish",
      args: { text: "今天开会讨论了三件事" },
    });
    assert.strictEqual(tool.ok, true);
    assert.match(tool.output, /润色结果/);
  } finally {
    node.stop();
  }
});

/* ---------------- 收尾 ---------------- */

console.log(`\n${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
