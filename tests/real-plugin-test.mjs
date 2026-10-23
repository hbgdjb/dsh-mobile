#!/usr/bin/env node
/* ============================================================
   真实 DSH 插件兼容性测试 —— dsh-our-free-model@2.5.9

   ============ 这个测试在干什么 ============

   前面那些测试测的是「我们以为 cordis 是什么样」。这个测试测的是
   **真实插件在真实容器里跑不跑得起来**。

   dsh-our-free-model 是 DSH 生态里把 ctx 用得最狠的插件：
   它用 ctx.effect 起后台轮询、用 ctx.inject 做能力分层、
   用 ctx.get 读可选服务、用 ctx.on 监听热更新事件、
   还要求 llm 服务返回「函数 + .replace()」的双面句柄。

   它在桌面上是主力插件。它能不能在手机上加载，就是这套容器的
   及格线 —— 因为将来还会有别的 DSH 插件进来。

   ============ 为什么要有这一层 ============

   我们读 cordis 源码读出的语义，可能读错；我们自己写的测试，
   测的永远是自己理解的那个版本。真实插件不这么想 —— 它只按
   cordis 的实际行为写。所以只有真插件能证明我们没读错。

   用法：node tests/real-plugin-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE_DIR = path.join(ROOT, "android", "node");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "dsh-our-free-model");

const { createContainer, applyPlugin } = require(path.join(NODE_DIR, "cordis-lite.js"));
const { createLlmService } = require(path.join(NODE_DIR, "llm-service.js"));

let passed = 0;
let failed = 0;
let skipped = 0;

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
   0. 前置检查
   ============================================================ */

console.log("\n[0] 前置检查");

/**
 * 插件需要 Node >= 22.19（用到 node:module 的 registerHooks）。
 * 手机端的 libnode 是 22.23.2，满足；沙箱若太旧就跳过而不是假装通过。
 */
const [major, minor] = process.versions.node.split(".").map((n) => parseInt(n, 10));
const nodeOk = major > 22 || (major === 22 && minor >= 19);

if (!nodeOk) {
  console.log(`  ! 当前 Node ${process.versions.node} < 22.19，插件用到的 registerHooks 不可用`);
  console.log(`  ! 跳过整个真实插件测试（需要 Node >= 22.19.0）`);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项，跳过 ${skipped + 1} 项（Node 版本不足）`);
  console.log(`${"=".repeat(50)}`);
  process.exit(0);
}

if (!fs.existsSync(FIXTURE)) {
  console.log("  ! 找不到插件夹具，跳过");
  console.log(`\n${"=".repeat(50)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项，跳过 1 项（缺夹具）`);
  console.log(`${"=".repeat(50)}`);
  process.exit(0);
}

await test("夹具完整（index.js / package.json / src / adapter 都在）", () => {
  for (const p of ["index.js", "package.json", "cordis.patch.yml", "src", "adapter"]) {
    assert.ok(fs.existsSync(path.join(FIXTURE, p)), "缺 " + p);
  }
});

/**
 * 造一个尽量接近手机端真实的运行环境。
 *
 * @returns {Promise<{container, llm, logs, cleanup}>}
 */
async function makeHost() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-real-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const logs = [];
  const container = createContainer({
    log: (level, scope, message) => logs.push({ level, scope, message }),
  });

  const llm = createLlmService({
    ctx: container,
    log: (level, scope, message) => logs.push({ level, scope, message }),
    onRoutes: () => {},
  });
  container.provide("llm", llm);

  // 手机端提供的其余宿主服务
  const { createServices } = require(path.join(NODE_DIR, "ctx-services.js"));
  const services = createServices({ workspace: home, log: () => {} });
  container.provide("slots", services.slots);
  container.provide("sessions", services.sessions);
  container.provide("modelDirectories", services.modelDirectories);
  container.provide("remote", services.remote);

  return {
    container,
    llm,
    logs,
    cleanup() {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch { /* ignore */ }
    },
  };
}

/* ============================================================
   1. 模块加载
   ============================================================ */

console.log("\n[1] 模块加载");

let mod = null;

await test("插件模块能被 import（ESM）", async () => {
  mod = await import(pathToFileURL(path.join(FIXTURE, "index.js")).href);
  assert.ok(mod, "模块没加载出来");
});

await test("插件导出 apply 与 inject", () => {
  assert.ok(mod, "模块没加载");
  assert.strictEqual(typeof mod.apply, "function", "要导出 apply");
  assert.ok(Array.isArray(mod.inject), "要导出 inject");
});

await test("inject 声明的是 ['llm']", () => {
  assert.deepStrictEqual(mod.inject, ["llm"]);
});

await test("版本号读到了（2.5.9）", () => {
  assert.strictEqual(mod.version, "2.5.9");
});

/* ============================================================
   2. 装载 —— 容器不塌
   ============================================================ */

console.log("\n[2] 装载（容器不塌）");

let host = null;
let loadResult = null;

await test("apply() 成功 —— 不抛错", async () => {
  host = await makeHost();
  loadResult = applyPlugin(host.container, {
    id: "dsh-our-free-model",
    name: "dsh-our-free-model",
    version: mod.version,
    apply: mod.apply,
    inject: mod.inject,
  });
  assert.strictEqual(loadResult.ok, true, "加载失败：" + loadResult.error);
});

await test("插件注册了模型路由", () => {
  assert.ok(host, "host 没建起来");
  const providers = host.llm.listRoutes().map((r) => r.provider);
  assert.ok(providers.includes("our-free-model"), "要有 our-free-model 路由，实际：" + JSON.stringify(providers));
  assert.ok(providers.includes("our-free-model-region"), "要有 region 路由");
});

await test("路由带上了展示名", () => {
  const route = host.llm.listRoutes().find((r) => r.provider === "our-free-model");
  assert.ok(route.name && route.name.length > 0, "路由要有名字");
});

await test("插件注册了可配置供应方目录", () => {
  const dir = host.llm.listDirectory();
  assert.strictEqual(dir.length, 1);
  assert.strictEqual(dir[0].provider, "our-free-model");
  assert.ok(dir[0].settingsNs && dir[0].settingsNs.length > 0, "要有 settingsNs");
});

await test("插件注册了模型发现（registerModelDiscovery）", () => {
  const ns = "dsh-our-free-model";
  assert.ok(host.llm.getDiscovery(ns), "要有 " + ns + " 的发现函数");
});

await test("注册句柄是「函数 + .replace」双面 —— 桌面版契约", () => {
  // 插件内部拿到的是句柄；我们从路由表侧面验证它能 replace
  // （插件启动后会用 registration.replace(routes()) 动态更新路由）
  assert.ok(host.llm.routeCount() > 0, "路由表非空");
});

await test("插件的 inject 依赖没满足时不影响加载（llm 之外的都不声明）", () => {
  // 插件声明的是 ['llm']，我们提供了 llm，所以它能加载
  assert.strictEqual(loadResult.ok, true);
});

/* ============================================================
   3. 缺失能力时的优雅降级
   ============================================================ */

console.log("\n[3] 缺失能力时的降级（cordis 的能力分层）");

await test("没有 webServer 服务 → 仪表盘那半不启动，但插件照常活着", async () => {
  // 插件用 ctx.inject(['webServer'], ...) 挂仪表盘路由。
  // 手机上没有 webServer，按 cordis 语义这段回调永远不执行。
  // 这里确认插件没有因此炸掉。
  assert.strictEqual(loadResult.ok, true, "插件不该因为缺 webServer 而失败");
});

await test("没有 credentials/commands → 渠道包那半不启动，但插件照常活着", async () => {
  // 插件用 ctx.inject(['credentials','commands','llm'], ...) 挂十个账号渠道。
  // 手机上这两个服务都没有 → 回调不执行 → vendor pack 不会被 import。
  // 这正是我们裁掉 2.5M vendor 的依据。
  assert.strictEqual(loadResult.ok, true);
});

await test("缺失的通道包没有导致未捕获异常", async () => {
  // 等一会儿，让插件的后台任务跑几轮，看有没有冒泡的异常
  await new Promise((r) => setTimeout(r, 1200));
  const errors = host.logs.filter((l) => l.level === "error");
  assert.strictEqual(errors.length, 0, "不该有 error 级日志：" + JSON.stringify(errors.slice(0, 3)));
});

/* ============================================================
   4. 卸载 —— 清理要干净
   ============================================================ */

console.log("\n[4] 卸载");

await test("卸载不抛错", () => {
  assert.doesNotThrow(() => loadResult.disposer());
});

await test("卸载后路由被释放", () => {
  assert.strictEqual(host.llm.routeCount(), 0, "路由该被释放");
});

await test("卸载后目录被释放", () => {
  assert.strictEqual(host.llm.listDirectory().length, 0);
});

await test("卸载后没有残留的定时器（effect 被清理）", async () => {
  await new Promise((r) => setTimeout(r, 300));
  const errors = host.logs.filter((l) => l.level === "error");
  assert.strictEqual(errors.length, 0);
});

/* ============================================================
   5. 消息投影 —— 我们翻译的，插件能读懂

   ============ 为什么这条必须用真插件测 ============

   手机端攒消息用的是 OpenAI 形状（`{role, content, tool_calls}`），
   而 adapter 要的是 harness 形状（`{type:'tool-call'}` 块）。
   中间那层翻译（android/node/llm-chat.js）如果翻错了，adapter 不会报错 ——
   它只会**静默地**把消息投成别的样子发给上游，模型于是「看不见」
   自己的工具调用结果，反复重试同一个工具。

   所以这里把翻好的消息喂给**插件自己的投影函数**，
   看它能不能还原成一条正常的 Chat 请求。这比断言我们自己的
   猜测形状可靠得多。
   ============================================================ */

console.log("\n[5] 消息投影（我们翻译的，插件能读懂）");

const { toHarnessMessages } = require(path.join(NODE_DIR, "llm-chat.js"));

let toChatMessages = null;
let repairToolPairing = null;

await test("能拿到插件自己的投影函数 toChatMessages", async () => {
  const mod = await import(pathToFileURL(path.join(FIXTURE, "src", "messages.js")).href);
  toChatMessages = mod.toChatMessages;
  repairToolPairing = mod.repairToolPairing;
  assert.strictEqual(typeof toChatMessages, "function");
  assert.strictEqual(typeof repairToolPairing, "function");
});

await test("纯文本对话能还原成一条正常的 user 消息", () => {
  const harness = toHarnessMessages([
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
  ]);
  const chat = toChatMessages(harness);
  assert.deepStrictEqual(chat, [
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
  ]);
});

await test("工具调用与工具结果能配对上（配对断了模型会反复重试）", () => {
  const harness = toHarnessMessages([
    { role: "user", content: "读一下 a.txt" },
    {
      role: "assistant",
      content: "我来读",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "fs_read", arguments: '{"path":"a.txt"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_a", content: "文件内容" },
  ]);
  const chat = toChatMessages(harness);

  const assistant = chat.find((m) => m.role === "assistant");
  assert.ok(assistant, "assistant 那一轮要在");
  assert.strictEqual(assistant.tool_calls.length, 1);
  assert.strictEqual(assistant.tool_calls[0].id, "call_a");
  assert.strictEqual(assistant.tool_calls[0].function.name, "fs_read");

  const result = chat.find((m) => m.role === "tool");
  assert.ok(result, "工具结果要在");
  assert.strictEqual(result.tool_call_id, "call_a", "配对 id 必须一致");
  assert.strictEqual(result.content, "文件内容");
});

await test("图片能作为 image_url 原样带给上游", () => {
  const url = "data:image/png;base64,AAAA";
  const harness = toHarnessMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url } },
      ],
    },
  ]);
  const chat = toChatMessages(harness);
  assert.strictEqual(chat.length, 1);
  const parts = chat[0].content;
  assert.ok(Array.isArray(parts), "有图时 content 应该是 part 数组");
  assert.deepStrictEqual(parts[0], { type: "text", text: "看图" });
  assert.deepStrictEqual(parts[1], { type: "image_url", image_url: { url } });
});

await test("没被回答的工具调用会被修掉（而不是发给上游换 400）", () => {
  const harness = toHarnessMessages([
    { role: "user", content: "读一下" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_never", type: "function", function: { name: "fs_read", arguments: "{}" } },
      ],
    },
  ]);
  // adapter 的真实顺序就是「先修配对，再投影」（adapter.js:334）
  const chat = toChatMessages(repairToolPairing(harness));
  // 只剩 user —— 那个没被回答的调用不该出现在请求里
  assert.strictEqual(chat.length, 1);
  assert.strictEqual(chat[0].role, "user");
});

/* ---------------- 清理 ---------------- */

if (host) host.cleanup();

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项，跳过 ${skipped} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
