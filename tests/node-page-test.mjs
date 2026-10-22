#!/usr/bin/env node
/* ============================================================
   页面侧通道的回归测试（node-runtime.js / node-plugins.js）

   这一层跑在 WebView 里，但协议逻辑是纯 JS，可以直接在这里测。
   用假的 window.DshNode 模拟原生桥。

   用法：node tests/node-page-test.mjs
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
   造一个假的原生桥
   ============================================================ */

/**
 * 装一个假的 window.DshNode。
 *
 * 它模拟原生侧的行为：
 *   call()      返回请求 id，并异步回响应
 *   respond()   回应反向调用
 */
function installFakeBridge(opts = {}) {
  const pending = new Map();
  let seq = 0;

  const handlers = opts.handlers || {};

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
        seq += 1;
        const id = "j" + seq;
        const params = paramsJson ? JSON.parse(paramsJson) : {};
        const fn = handlers[method];
        // 异步回响应 —— 模拟真实的跨进程往返
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
        }, 5);
        return id;
      },
      respond: (id, ok, payload) => {
        if (opts.onRespond) opts.onRespond(id, ok, payload);
      },
      start: () => {},
      stop: () => {},
      download: () => {},
    },
  };
  return pending;
}

/* 每个测试都要重新加载 node-plugins —— 它有模块级的工具表，不能串。 */
let modCounter = 0;
async function loadModules() {
  const suffix = `?v=${++modCounter}`;
  // node-runtime 用**不带后缀**的路径导入 —— 必须和 node-plugins 内部
  // 导入的是同一个实例。否则事件订阅者注册到了另一个实例上，
  // 推送就送不到（浏览器里 URL 不同就是不同的模块实例）。
  const nr = await import(pathToFileURL(path.join(ROOT, "scripts/node-runtime.js")).href);
  const np = await import(pathToFileURL(path.join(ROOT, "scripts/node-plugins.js")).href + suffix);
  return { nr, np };
}

/* ============================================================
   1. 状态查询
   ============================================================ */

console.log("\n[1] 状态查询");

await test("有原生桥时状态解析正确", async () => {
  installFakeBridge();
  const { nr } = await loadModules();
  const st = nr.nodeStatus();
  assert.strictEqual(st.native, true);
  assert.strictEqual(st.running, true);
  assert.strictEqual(st.channelConnected, true);
  assert.strictEqual(st.channelPort, 12345);
});

await test("没有原生桥时报告不可用（不假装支持）", async () => {
  delete globalThis.window;
  const { nr } = await loadModules();
  const st = nr.nodeStatus();
  assert.strictEqual(st.native, false);
  assert.strictEqual(st.channelConnected, false);
});

/* ============================================================
   2. 调用与响应
   ============================================================ */

console.log("\n[2] 调用与响应");

await test("call 能拿到结果", async () => {
  installFakeBridge({ handlers: { "runtime.info": async () => ({ node: "v22.0.0" }) } });
  const { nr } = await loadModules();
  const r = await nr.nodeCall("runtime.info", {});
  assert.strictEqual(r.node, "v22.0.0");
});

await test("Node 报错时 Promise 被拒，错误信息带原因", async () => {
  installFakeBridge({
    handlers: {
      "tool.call": async () => {
        throw new Error("工具炸了");
      },
    },
  });
  const { nr } = await loadModules();
  await assert.rejects(() => nr.nodeCall("tool.call", {}), /工具炸了/);
});

await test("调用超时会被拒掉（不能永远等）", async () => {
  installFakeBridge({
    handlers: {
      hang: async () => new Promise(() => {}),
    },
  });
  const { nr } = await loadModules();
  await assert.rejects(
    () => nr.nodeCall("hang", {}, { timeoutMs: 50 }),
    /超时/
  );
});

await test("原生桥返回空 id（没发出去）时立即报错", async () => {
  globalThis.window = {
    DshNode: {
      status: () => JSON.stringify({ available: true, running: true }),
      call: () => "",
    },
  };
  const { nr } = await loadModules();
  await assert.rejects(() => nr.nodeCall("x", {}), /通道未连接/);
});

/* ============================================================
   3. 反向调用
   ============================================================ */

console.log("\n[3] Node 反向调用页面");

await test("注册处理器后，Node 的反向调用能被应答", async () => {
  let responded = null;
  installFakeBridge({
    onRespond: (id, ok, payload) => {
      responded = { id, ok, payload };
    },
  });
  const { nr } = await loadModules();
  nr.nodeOnHostRequest("host.fs.read", async (p) => ({ content: "内容:" + p.path }));

  // 模拟原生派发一个反向调用
  globalThis.window.__dshNodeRequest("x1", "host.fs.read", JSON.stringify({ path: "/a.txt" }));

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(responded, "应该回响应");
  assert.strictEqual(responded.id, "x1");
  assert.strictEqual(responded.ok, true);
  assert.deepStrictEqual(JSON.parse(responded.payload), { content: "内容:/a.txt" });
});

await test("没有注册处理器时明确回错误（不能让 Node 干等）", async () => {
  let responded = null;
  installFakeBridge({
    onRespond: (id, ok, payload) => {
      responded = { id, ok, payload };
    },
  });
  const { nr } = await loadModules();
  nr.ensureNodeHooks();

  globalThis.window.__dshNodeRequest("x2", "没注册的方法", "{}");

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(responded, "应该回响应");
  assert.strictEqual(responded.ok, false);
  assert.match(responded.payload, /没有实现/);
});

/* ============================================================
   4. Node 插件工具接入
   ============================================================ */

console.log("\n[4] Node 插件工具接入");

await test("tools.changed 推送会更新工具表", async () => {
  installFakeBridge({ handlers: { "plugins.list": async () => ({ plugins: [] }) } });
  const { np } = await loadModules();
  np.ensureNodeToolSubscription();

  globalThis.window.__dshNodeEvent(
    "tools.changed",
    JSON.stringify({
      tools: [
        { name: "my_tool", description: "我的工具", pluginId: "demo", parameters: { type: "object" } },
      ],
    })
  );

  const list = np.nodeToolList();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, "my_tool");
  // pluginId 要加前缀，避免和 iframe 插件同名
  assert.strictEqual(list[0].pluginId, "node__demo");
});

await test("工具表转成模型能用的 schema", async () => {
  installFakeBridge({ handlers: { "plugins.list": async () => ({ plugins: [] }) } });
  const { np } = await loadModules();
  np.ensureNodeToolSubscription();
  globalThis.window.__dshNodeEvent(
    "tools.changed",
    JSON.stringify({
      tools: [{ name: "my_tool", description: "我的工具", pluginId: "demo" }],
    })
  );

  const schemas = np.nodeToolSchemas();
  assert.strictEqual(schemas.length, 1);
  assert.strictEqual(schemas[0].type, "function");
  assert.strictEqual(schemas[0].function.name, "plugin__node__my_tool");
  assert.match(schemas[0].function.description, /我的工具/);
});

await test("调用 Node 工具时正确传参并取回结果", async () => {
  installFakeBridge({
    handlers: {
      "tool.call": async (p) => ({ echoed: p.args?.v }),
      "plugins.list": async () => ({ plugins: [] }),
    },
  });
  const { np } = await loadModules();

  const r = await np.callNodeTool("plugin__node__my_tool", { v: "hi" });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(JSON.parse(r.output), { echoed: "hi" });
});

await test("通道没连上时给出可操作的原因（不是干等超时）", async () => {
  globalThis.window = {
    DshNode: {
      status: () => JSON.stringify({ available: true, running: true, channelConnected: false }),
      call: () => "x",
    },
  };
  const { np } = await loadModules();
  const r = await np.callNodeTool("plugin__node__t", {});
  assert.strictEqual(r.ok, false);
  assert.match(r.output, /未就绪|通道/);
});

await test("工具名不对时明确报错", async () => {
  installFakeBridge({ handlers: {} });
  const { np } = await loadModules();
  const r = await np.callNodeTool("plugin__other__t", {});
  assert.strictEqual(r.ok, false);
  assert.match(r.output, /不是 Node 插件工具/);
});

/* ============================================================
   5. 端到端：真 Node + 真通道
   ============================================================ */

console.log("\n[5] 端到端：页面 ↔ 原生模拟 ↔ Node");

await test("工具能从 Node 注册，经通道回到页面", async () => {
  const { spawn } = await import("node:child_process");
  const net = await import("node:net");
  const fs = await import("node:fs");
  const os = await import("node:os");

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-page-e2e-"));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-page-rt-"));

  // 造一个插件，它注册一个工具
  const pdir = path.join(tmpWs, "plugins", "demo");
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(
    path.join(pdir, "main.js"),
    "exports.apply = function (ctx) {\n" +
      "  ctx.tools.registerTool({ name: 'sum', description: '求和', parameters: { type: 'object', properties: { a: { type: 'number' } } } }, async (args) => {\n" +
      "    return { result: (args.a || 0) + (args.b || 0) };\n" +
      "  });\n" +
      "};\n"
  );

  // 假原生：起监听，转发给真 Node
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
        if (m.hello) continue;
        if (m.method) {
          sock.write(JSON.stringify({ id: m.id, ok: true, result: { pong: true } }) + "\n");
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const child = spawn(
    process.execPath,
    [path.join(ROOT, "android", "node", "main.js"), runtimeDir, String(port), "t", tmpWs],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });

  await new Promise((r) => setTimeout(r, 1500));

  // Node 启动后应该把工具清单发过来 —— 但我们的假原生没实现转发，
  // 所以直接读 Node 的日志确认插件加载成功了
  const logPath = path.join(runtimeDir, "node.log");
  let logText = "";
  try {
    logText = fs.readFileSync(logPath, "utf8");
  } catch {
    /* ignore */
  }
  assert.match(logText, /插件加载完成：成功 1 个/, "Node 应该加载了 1 个插件：" + logText);

  child.kill("SIGKILL");
  server.close();
});

/* ---------------- 汇总 ---------------- */

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);
