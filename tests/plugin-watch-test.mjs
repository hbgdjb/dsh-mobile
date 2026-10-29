#!/usr/bin/env node
/* ============================================================
   插件目录自动重载的测试

   ============ 这套测试在防什么 ============

   自动重载最容易出的不是"不触发"，而是**触发得太早**：

     编辑器保存是「清空 → 写一半 → 再写」，第一次事件来的时候
     文件还是空的。这时候重载一定语法错误，插件当场挂掉。

   所以断言不只看"改完有没有重载"，还要看：
     · 连续保存多次，只重载一次（防抖）
     · 文件还没写完时不动手（等稳定）
     · 写坏了不会把旧版本弄丢（失败时旧版本继续跑）

   另外两条容易被忽略的：
     · 装 npm 依赖时 node_modules 里有上千个文件，不能每个都重载
     · 删掉插件目录，插件要从内存里卸掉

   用法：node tests/plugin-watch-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE_DIR = path.join(ROOT, "android", "node");

const { createContainer } = require(path.join(NODE_DIR, "cordis-lite.js"));
const { createHost } = require(path.join(NODE_DIR, "plugin-host.js"));
const { createWatcher } = require(path.join(NODE_DIR, "watcher.js"));

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 脚手架 ---------------- */

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-watch-"));
  fs.mkdirSync(path.join(ws, "plugins"), { recursive: true });
  return ws;
}

/** 写一个插件。 */
function writePlugin(ws, dir, code, pkg) {
  const d = path.join(ws, "plugins", dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "package.json"),
    JSON.stringify(
      pkg || { name: dir, version: "1.0.0", main: "main.js", dsh: { permissions: [] } },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(d, "main.js"), code);
  return d;
}

/**
 * 建 workspace + host + watcher。
 *
 * 收集所有推给页面的消息 —— 自动重载是纯推送驱动的，
 * 页面不轮询，所以"推了什么"就是它的全部可观察行为。
 */
async function makeRig() {
  const ws = makeWorkspace();
  const container = createContainer({});
  const events = [];
  const host = createHost({
    workspace: ws,
    container,
    log: () => {},
    onTools: () => {},
  });
  const watcher = createWatcher({
    workspace: ws,
    host,
    log: () => {},
    send: (event, data) => events.push({ event, data }),
  });
  return { ws, host, watcher, events };
}

/** 等某个推送出现（带超时）。 */
async function waitFor(events, name, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find((e) => e.event === name);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

/* ============================================================
   1. 基本触发
   ============================================================ */

console.log("\n自动重载\n");

await test("改了文件 → 自动重载，插件跑的是新代码", async () => {
  const { ws, host, watcher, events } = await makeRig();
  const v1 = `exports.inject=['tools'];exports.apply=function(ctx){ctx.tools.registerTool({name:'w1',description:'x'},()=>1);};`;
  const dir = writePlugin(ws, "w1", v1);

  const a = host.loadAll();
  await a;
  assert.strictEqual((await host.callTool("w1", {})), 1, "初始是 v1");

  watcher.start();
  try {
    fs.writeFileSync(path.join(dir, "main.js"), v1.replace("()=>1", "()=>2"));
    watcher.notify(path.join(dir, "main.js"));

    const done = await waitFor(events, "watch.reloaded");
    assert.ok(done, `应该收到 watch.reloaded，实际：${JSON.stringify(events)}`);
    assert.strictEqual(await host.callTool("w1", {}), 2, "重载后应该是 v2");
  } finally {
    watcher.stop();
  }
});

await test("连续保存多次只重载一次（防抖）", async () => {
  const { ws, host, watcher, events } = await makeRig();
  const code = `exports.apply=function(){};`;
  const dir = writePlugin(ws, "deb", code);
  await host.loadAll();

  watcher.start();
  try {
    const file = path.join(dir, "main.js");
    // 模拟编辑器保存：清空 → 写 → 再写
    for (let i = 0; i < 4; i += 1) {
      fs.writeFileSync(file, `${code}\n// pass ${i}`);
      watcher.notify(file);
      await sleep(60);
    }

    await waitFor(events, "watch.reloaded", 5000);
    await sleep(600); // 再等一会儿，看会不会又冒出来一次

    const count = events.filter((e) => e.event === "watch.reloaded").length;
    assert.strictEqual(count, 1, `应该只重载一次，实际 ${count} 次`);
  } finally {
    watcher.stop();
  }
});

await test("同一个插件在一轮重载中又改了 → 结束后再补一次", async () => {
  const { ws, host, watcher, events } = await makeRig();
  const dir = writePlugin(ws, "again", `exports.apply=function(){};`);
  await host.loadAll();

  watcher.start();
  try {
    const file = path.join(dir, "main.js");
    fs.writeFileSync(file, `exports.apply=function(){};// A`);
    watcher.notify(file);
    // 防抖窗口之后、重载进行中再改一次
    await sleep(500);
    fs.writeFileSync(file, `exports.apply=function(){};// B`);
    watcher.notify(file);

    await waitFor(events, "watch.reloaded", 6000);
    await sleep(1200);
    const count = events.filter((e) => e.event === "watch.reloaded").length;
    assert.ok(count >= 2, `后一次改动不该丢，实际重载 ${count} 次`);
  } finally {
    watcher.stop();
  }
});

/* ============================================================
   2. 不该触发的情况
   ============================================================ */

console.log("\n不该触发的时候\n");

await test("node_modules 里的变化被忽略", async () => {
  const { ws, host, watcher, events } = await makeRig();
  const dir = writePlugin(ws, "nm", `exports.apply=function(){};`);
  await host.loadAll();

  const nm = path.join(dir, "node_modules", "some-dep");
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, "index.js"), "module.exports={};");

  watcher.start();
  try {
    watcher.notify(path.join(nm, "index.js"));
    watcher.notify(path.join(dir, "node_modules", "other", "x.js"));
    await sleep(1200);
    assert.strictEqual(
      events.filter((e) => e.event === "watch.reloading").length,
      0,
      "装依赖时重载会把设备卡死 —— node_modules 必须被忽略"
    );
  } finally {
    watcher.stop();
  }
});

await test("临时文件与隐藏文件被忽略", async () => {
  const { ws, host, watcher, events } = await makeRig();
  const dir = writePlugin(ws, "tmpf", `exports.apply=function(){};`);
  await host.loadAll();
  watcher.start();
  try {
    for (const name of ["main.js~", ".main.js.swp", "notes.tmp", ".DS_Store"]) {
      watcher.notify(path.join(dir, name));
    }
    await sleep(1000);
    assert.strictEqual(events.filter((e) => e.event === "watch.reloading").length, 0);
  } finally {
    watcher.stop();
  }
});

await test("插件目录之外的变化被忽略", async () => {
  const { ws, host, watcher, events } = await makeRig();
  await host.loadAll();
  watcher.start();
  try {
    watcher.notify(path.join(ws, "README.md"));
    watcher.notify(path.join(ws, "uploads", "a.txt"));
    await sleep(900);
    assert.strictEqual(events.filter((e) => e.event === "watch.reloading").length, 0);
  } finally {
    watcher.stop();
  }
});

/* ============================================================
   3. 失败与恢复
   ============================================================ */

console.log("\n写坏的时候\n");

await test("改成语法错误 → 报错，但旧版本继续可用", async () => {
  const { ws, host, watcher, events } = await makeRig();
  const good = `exports.inject=['tools'];exports.apply=function(ctx){ctx.tools.registerTool({name:'keep',description:'x'},()=>'ok');};`;
  const dir = writePlugin(ws, "bad", good);
  await host.loadAll();
  assert.strictEqual(await host.callTool("keep", {}), "ok");

  watcher.start();
  try {
    fs.writeFileSync(path.join(dir, "main.js"), "syntax ((( error");
    watcher.notify(path.join(dir, "main.js"));

    const err = await waitFor(events, "watch.error", 6000);
    assert.ok(err, "应该推送 watch.error");
    assert.ok(err.data.error && err.data.error.length > 0, "要带上原因");

    // 关键：坏代码不该让插件消失
    assert.strictEqual(
      await host.callTool("keep", {}),
      "ok",
      "重载失败必须回滚到旧版本，不能让插件直接消失"
    );
  } finally {
    watcher.stop();
  }
});

await test("文件一直在写（不稳定）时跳过，不乱重载", async () => {
  const { ws, host, watcher, events } = await makeRig();
  const dir = writePlugin(ws, "busy", `exports.apply=function(){};`);
  await host.loadAll();

  watcher.start();
  try {
    const file = path.join(dir, "main.js");
    // 每 60ms 改一次，一直不稳定。
    // 每次写入的长度也在变 —— 只靠 mtime 的话，某些文件系统
    // 时间戳精度粗到一秒，会误判成"稳定了"。
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      try {
        fs.writeFileSync(file, `exports.apply=function(){};// ${step} ${"x".repeat(step % 7)}`);
      } catch {
        /* ignore */
      }
    }, 60);
    watcher.notify(file);

    // 等它放弃（防抖 400ms + 稳定性窗口 3s）
    const err = await waitFor(events, "watch.error", 8000);
    clearInterval(timer);

    assert.ok(err, `应该推送 watch.error：${JSON.stringify(events)}`);
    assert.ok(
      /一直在变/.test(err.data.error || ""),
      `应该明确说"文件一直在变，跳过"，实际：${JSON.stringify(err.data)}`
    );
  } finally {
    watcher.stop();
  }
});

/* ============================================================
   4. 目录增删
   ============================================================ */

console.log("\n目录增删\n");

await test("新装的插件目录 → 自动加载", async () => {
  const { ws, host, watcher, events } = await makeRig();
  await host.loadAll(); // 一开始什么插件都没有

  watcher.start();
  try {
    const dir = writePlugin(
      ws,
      "fresh",
      `exports.inject=['tools'];exports.apply=function(ctx){ctx.tools.registerTool({name:'fresh_t',description:'新'},()=>'hi');};`
    );
    watcher.notify(path.join(dir, "main.js"));

    const done = await waitFor(events, "watch.reloaded", 6000);
    assert.ok(done, `应该触发加载：${JSON.stringify(events)}`);
    assert.strictEqual(await host.callTool("fresh_t", {}), "hi", "新插件应该能用了");
  } finally {
    watcher.stop();
  }
});

await test("删掉插件目录 → 插件从内存里卸掉", async () => {
  const { ws, host, watcher, events } = await makeRig();
  const dir = writePlugin(
    ws,
    "gone",
    `exports.inject=['tools'];exports.apply=function(ctx){ctx.tools.registerTool({name:'gone_t',description:'x'},()=>1);};`
  );
  await host.loadAll();
  assert.ok(host.listTools().some((t) => t.name === "gone_t"));

  watcher.start();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    // 删目录时事件可能指到目录本身，也可能指到里面的文件
    watcher.notify(path.join(dir, "main.js"));

    const done = await waitFor(events, "watch.unloaded", 6000);
    assert.ok(done, `应该推送 watch.unloaded：${JSON.stringify(events)}`);
    assert.strictEqual(
      host.listTools().some((t) => t.name === "gone_t"),
      false,
      "插件都删了，工具不该还在"
    );
  } finally {
    watcher.stop();
  }
});

/* ============================================================
   5. 开关与状态
   ============================================================ */

console.log("\n开关\n");

await test("start / stop 改变运行状态", async () => {
  const { watcher, events } = await makeRig();
  assert.strictEqual(watcher.status().running, false);

  const r = watcher.start();
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(watcher.status().running, true);
  assert.ok(events.some((e) => e.event === "watch.state" && e.data.running === true));

  watcher.stop();
  assert.strictEqual(watcher.status().running, false);
});

await test("重复 start 不会建第二个监听", async () => {
  const { watcher } = await makeRig();
  watcher.start();
  const second = watcher.start();
  assert.strictEqual(second.already, true);
  watcher.stop();
});

/* ============================================================
   6. 真的用 fs.watch 跑一遍
   ============================================================ */

console.log("\n真实文件监听\n");

await test("不调 notify，直接写文件也能触发（真 inotify）", async () => {
  const { ws, host, watcher, events } = await makeRig();
  const v1 = `exports.inject=['tools'];exports.apply=function(ctx){ctx.tools.registerTool({name:'real_w',description:'x'},()=>'v1');};`;
  const dir = writePlugin(ws, "real", v1);
  await host.loadAll();

  const started = watcher.start();
  if (!started.ok) {
    // 平台不支持 recursive watch：如实报出来，不当成通过
    throw new Error(`这台机器不支持目录监听：${started.error}`);
  }

  try {
    fs.writeFileSync(path.join(dir, "main.js"), v1.replace("'v1'", "'v2'"));
    const done = await waitFor(events, "watch.reloaded", 8000);
    assert.ok(done, `真写文件应该触发重载：${JSON.stringify(events)}`);
    assert.strictEqual(await host.callTool("real_w", {}), "v2");
  } finally {
    watcher.stop();
  }
});

/* ---------------- 收尾 ---------------- */

console.log(`\n${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
