#!/usr/bin/env node
/* ============================================================
   Node 插件热重载的测试

   ============ 这套测试在防什么 ============

   热重载最容易出的不是「不生效」，而是**假生效**：
   显示重载成功，代码其实还是旧的。

   原因有两个，都必须测到：
     · 模块缓存没破 —— CJS 要删 require.cache，ESM 要动模块加载器
     · 旧 fiber 没销毁 —— 同一个插件两个实例同时跑，
       宿主服务（settings / web）的注册会撞车

   所以断言不只是「重载后返回了新值」，
   还要断言「失败时旧版本还在跑」——
   因为一个改坏的文件不该让插件彻底消失。

   用法：node tests/plugin-reload-test.mjs
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
const reload = require(path.join(NODE_DIR, "plugin-reload.js"));
const { createHmrService } = require(path.join(NODE_DIR, "hmr-service.js"));

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

/* ---------------- 测试脚手架 ---------------- */

/** 建一个临时工作区，里面放插件目录。 */
function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-reload-"));
  fs.mkdirSync(path.join(ws, "plugins"), { recursive: true });
  return ws;
}

/** 写一个插件目录。 */
function writePlugin(ws, id, files) {
  const dir = path.join(ws, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

/** 建一个容器 + 宿主。 */
function makeHost(ws, opts = {}) {
  const container = createContainer({});
  const pushed = [];
  const host = createHost({
    workspace: ws,
    container,
    log: () => {},
    onTools: (list) => {
      pushed.push(list);
      if (opts.onTools) opts.onTools(list);
    },
  });
  return { container, host, pushed };
}

/* ============================================================
   1. CJS 热重载
   ============================================================ */

console.log("\n[1] CJS 热重载");

await test("改代码后重载生效，工具返回新值", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "cjs-plugin", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "echo", description: "回声" }, () => ({ v: 1 }));
      }
      module.exports = { apply };
    `,
  });
  const { host } = makeHost(ws);
  await host.loadAll();
  assert.deepStrictEqual(await host.callTool("echo", {}), { v: 1 });

  // 改代码
  writePlugin(ws, "cjs-plugin", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "echo", description: "回声" }, () => ({ v: 2 }));
      }
      module.exports = { apply };
    `,
  });

  const r = await host.reloadOne("cjs-plugin");
  assert.ok(r.ok, `重载要成功：${r.error}`);
  assert.deepStrictEqual(await host.callTool("echo", {}), { v: 2 }, "要跑新代码");
});

await test("子模块改了也能生效（require.cache 要清到子文件）", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "sub-plugin", {
    "main.js": `
      const lib = require("./lib.js");
      function apply(ctx) {
        ctx.tools.registerTool({ name: "sub_echo", description: "子模块回声" }, () => ({ v: lib.v }));
      }
      module.exports = { apply };
    `,
    "lib.js": `module.exports = { v: 1 };`,
  });
  const { host } = makeHost(ws);
  await host.loadAll();
  assert.deepStrictEqual(await host.callTool("sub_echo", {}), { v: 1 });

  // 只改子模块
  writePlugin(ws, "sub-plugin", {
    "lib.js": `module.exports = { v: 2 };`,
  });
  const r = await host.reloadOne("sub-plugin");
  assert.ok(r.ok, `重载要成功：${r.error}`);
  assert.deepStrictEqual(await host.callTool("sub_echo", {}), { v: 2 }, "子模块要换新实现");
});

await test("node_modules 里的依赖不被清理（避免重建单例）", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "dep-plugin", {
    "package.json": JSON.stringify({ name: "dep-plugin", version: "1.0.0", main: "main.js" }),
    "main.js": `
      const dep = require("./node_modules/dep/index.js");
      function apply(ctx) {
        ctx.tools.registerTool({ name: "dep_echo", description: "依赖回声" }, () => ({ v: dep.v }));
      }
      module.exports = { apply };
    `,
    "node_modules/dep/index.js": `module.exports = { v: 1 };`,
  });
  const { host } = makeHost(ws);
  await host.loadAll();
  assert.deepStrictEqual(await host.callTool("dep_echo", {}), { v: 1 });

  const depPath = path.join(ws, "plugins", "dep-plugin", "node_modules", "dep", "index.js");
  const cachedBefore = require.cache[depPath];
  assert.ok(cachedBefore, "依赖应该在 require.cache 里");

  await host.reloadOne("dep-plugin");
  assert.ok(require.cache[depPath], "依赖不该被清出缓存");
});

/* ============================================================
   2. ESM 热重载
   ============================================================ */

console.log("\n[2] ESM 热重载");

await test(
  reload.supportsEsmReload
    ? "有 registerHooks 时，ESM 入口与子模块都换成新代码"
    : "没有 registerHooks 时如实报不支持，且旧版本继续跑",
  async () => {
    const ws = makeWorkspace();
    writePlugin(ws, "esm-plugin", {
      "package.json": JSON.stringify({ name: "esm-plugin", version: "1.0.0", type: "module" }),
      "main.js": `
        import { v } from "./lib.js";
        export function apply(ctx) {
          ctx.tools.registerTool({ name: "esm_echo", description: "ESM 回声" }, () => ({ v }));
        }
      `,
      "lib.js": `export const v = 1;`,
    });
    const { host } = makeHost(ws);
    await host.loadAll();
    assert.deepStrictEqual(await host.callTool("esm_echo", {}), { v: 1 });

    writePlugin(ws, "esm-plugin", {
      "main.js": `
        import { v } from "./lib.js";
        export function apply(ctx) {
          ctx.tools.registerTool({ name: "esm_echo", description: "ESM 回声" }, () => ({ v }));
        }
      `,
      "lib.js": `export const v = 2;`,
    });

    const r = await host.reloadOne("esm-plugin");

    if (!reload.supportsEsmReload) {
      // ============ 降级路径 ============
      // 破不了 ESM 子模块缓存就必须说不行。
      // 假装成功更糟：用户以为换上了，行为却是旧的。
      assert.ok(!r.ok, "没有 registerHooks 时不能报成功");
      assert.ok(r.degraded === true, "要标成降级");
      assert.ok(/registerHooks/.test(r.error || ""), `错误要说清原因：${r.error}`);
      assert.deepStrictEqual(await host.callTool("esm_echo", {}), { v: 1 }, "旧版本仍在运行");
      return;
    }

    assert.ok(r.ok, `重载要成功：${r.error}`);
    assert.deepStrictEqual(await host.callTool("esm_echo", {}), { v: 2 }, "要跑新代码");
  }
);

await test("形态判定：type=module 的包判为 ESM，普通包判为 CJS", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "esm-pkg", {
    "package.json": JSON.stringify({ name: "esm-pkg", version: "1.0.0", type: "module" }),
    "main.js": `export function apply() {}`,
  });
  writePlugin(ws, "cjs-pkg", {
    "package.json": JSON.stringify({ name: "cjs-pkg", version: "1.0.0" }),
    "main.js": `module.exports = { apply() {} };`,
  });
  const wsDir = path.join(ws, "plugins");
  assert.strictEqual(reload.detectModuleKind(path.join(wsDir, "esm-pkg", "main.js"), path.join(wsDir, "esm-pkg")), "esm");
  assert.strictEqual(reload.detectModuleKind(path.join(wsDir, "cjs-pkg", "main.js"), path.join(wsDir, "cjs-pkg")), "cjs");
});

/* ============================================================
   3. 失败与回滚
   ============================================================ */

console.log("\n[3] 失败与回滚");

await test("新代码起不来时回滚，旧版本继续跑", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "rollback-plugin", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "rb_echo", description: "回滚回声" }, () => ({ v: 1 }));
      }
      module.exports = { apply };
    `,
  });
  const { host } = makeHost(ws);
  await host.loadAll();
  assert.deepStrictEqual(await host.callTool("rb_echo", {}), { v: 1 });

  // 改成会抛错的版本
  writePlugin(ws, "rollback-plugin", {
    "main.js": `
      function apply(ctx) {
        throw new Error("故意炸的");
      }
      module.exports = { apply };
    `,
  });

  const r = await host.reloadOne("rollback-plugin");
  assert.ok(!r.ok, "重载要报失败");
  assert.ok(r.restored === true, "要回滚到旧版本");
  assert.deepStrictEqual(await host.callTool("rb_echo", {}), { v: 1 }, "旧工具还能用");
  assert.ok(/故意炸的/.test(r.error || ""), `错误要说清原因：${r.error}`);
});

await test("加载失败的插件在 listStatus 里显示 failed 且带原因", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "broken", {
    "main.js": `this is not valid javascript ((( `,
  });
  const { host } = makeHost(ws);
  await host.loadAll();

  const status = host.listStatus();
  const row = status.find((s) => s.id === "broken");
  assert.ok(row, "失败的插件要出现在 listStatus 里");
  assert.strictEqual(row.status, "failed", `状态要是 failed，实际 ${row.status}`);
  assert.ok(row.error && row.error.length > 0, "要带上失败原因");
});

/* ============================================================
   4. 工具表一致性
   ============================================================ */

console.log("\n[4] 工具表一致性");

await test("重载后旧工具消失、新工具出现", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "tool-plugin", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "old_tool", description: "旧工具" }, () => "old");
      }
      module.exports = { apply };
    `,
  });
  const { host } = makeHost(ws);
  await host.loadAll();
  assert.ok(host.listTools().some((t) => t.name === "old_tool"), "旧工具要注册上");

  writePlugin(ws, "tool-plugin", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "new_tool", description: "新工具" }, () => "new");
      }
      module.exports = { apply };
    `,
  });
  const r = await host.reloadOne("tool-plugin");
  assert.ok(r.ok, `重载要成功：${r.error}`);

  const names = host.listTools().map((t) => t.name);
  assert.ok(!names.includes("old_tool"), "旧工具要消失");
  assert.ok(names.includes("new_tool"), "新工具要出现");
});

await test("重载一个插件不影响别的插件的工具", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "p1", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "p1_tool", description: "一" }, () => "1");
      }
      module.exports = { apply };
    `,
  });
  writePlugin(ws, "p2", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "p2_tool", description: "二" }, () => "2");
      }
      module.exports = { apply };
    `,
  });
  const { host } = makeHost(ws);
  await host.loadAll();
  assert.ok(host.listTools().some((t) => t.name === "p2_tool"));

  await host.reloadOne("p1");
  const names = host.listTools().map((t) => t.name);
  assert.ok(names.includes("p2_tool"), "别的插件的工具不能被误删");
});

await test("工具归属于正确的插件", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "owner-plugin", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "owned", description: "有主的" }, () => "x");
      }
      module.exports = { apply };
    `,
  });
  const { host } = makeHost(ws);
  await host.loadAll();
  const t = host.listTools().find((x) => x.name === "owned");
  assert.ok(t, "工具要注册上");
  assert.strictEqual(t.pluginId, "owner-plugin", `归属要是插件 id，实际 ${t.pluginId}`);
});

/* ============================================================
   5. 并发与批量
   ============================================================ */

console.log("\n[5] 并发与批量");

await test("并发重载不交叉（apply 不能同时进行）", async () => {
  const ws = makeWorkspace();
  // 插件每被 apply 一次就记一笔，用来验证两次重载是排队的，
  // 而不是并行的 —— 并行的话 cordis-lite 的活动作用域会串，
  // 工具和模型路由的归属就乱了。
  const marker = path.join(ws, "apply-count.txt");
  writePlugin(ws, "race-plugin", {
    "main.js": `
      const fs = require("fs");
      const path = require("path");
      function apply(ctx) {
        const f = path.join(${JSON.stringify(marker)});
        let n = 0;
        try { n = parseInt(fs.readFileSync(f, "utf8") || "0", 10) || 0; } catch {}
        n += 1;
        fs.writeFileSync(f, String(n));
        ctx.tools.registerTool({ name: "race", description: "并发" }, () => ({ n }));
      }
      module.exports = { apply };
    `,
  });
  const { host } = makeHost(ws);
  await host.loadAll();

  const p1 = host.reloadOne("race-plugin");
  const p2 = host.reloadOne("race-plugin");

  // 第一个重载结束后，第二个还没开始 —— 这就是串行的证据。
  // 如果是并行的，这里就已经是 2 了。
  await p1;
  const afterFirst = parseInt(fs.readFileSync(marker, "utf8") || "0", 10);
  assert.strictEqual(afterFirst, 2, `第一个重载后 apply 次数应为 2，实际 ${afterFirst}`);

  await p2;
  const afterSecond = parseInt(fs.readFileSync(marker, "utf8") || "0", 10);
  assert.strictEqual(afterSecond, 3, `第二个重载后 apply 次数应为 3，实际 ${afterSecond}`);
});

await test("reloadAll 会把每个插件都重载一遍", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "all1", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "a1", description: "一" }, () => ({ v: 1 }));
      }
      module.exports = { apply };
    `,
  });
  writePlugin(ws, "all2", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "a2", description: "二" }, () => ({ v: 1 }));
      }
      module.exports = { apply };
    `,
  });
  const { host } = makeHost(ws);
  await host.loadAll();

  writePlugin(ws, "all1", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "a1", description: "一" }, () => ({ v: 2 }));
      }
      module.exports = { apply };
    `,
  });

  const r = await host.reloadAll();
  assert.ok(r.ok, `整体要成功：${JSON.stringify(r.failed)}`);
  assert.ok(r.results.length >= 2, `要重载每个插件，实际 ${r.results.length}`);
  assert.deepStrictEqual(await host.callTool("a1", {}), { v: 2 }, "改过的要换新代码");
  assert.deepStrictEqual(await host.callTool("a2", {}), { v: 1 }, "没改的也要能跑");
});

/* ============================================================
   6. ctx.hmr
   ============================================================ */

console.log("\n[6] ctx.hmr");

await test("ctx.hmr.reloadSelf 能重载调用者自己", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "self-plugin", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "self_echo", description: "自重载" }, async () => {
          const r = await ctx.hmr.reloadSelf();
          return { reloaded: r.ok };
        });
      }
      // 必须声明 inject —— cordis 语义：不声明就不给
      module.exports = { apply, inject: ["hmr"] };
    `,
  });
  const container = createContainer({});
  let host = null;
  const pushed = [];
  host = createHost({
    workspace: ws,
    container,
    log: () => {},
    onTools: (l) => pushed.push(l),
  });
  container.provide(
    "hmr",
    createHmrService({ ctx: container.root, host, allowOthers: false })
  );
  await host.loadAll();

  const r = await host.callTool("self_echo", {});
  assert.deepStrictEqual(r, { reloaded: true }, "自重载要成功");
});

await test("ctx.hmr 默认不允许跨插件重载", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "a-plugin", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "try_other", description: "越权" }, async () => {
          try {
            await ctx.hmr.reload("b-plugin");
            return { denied: false };
          } catch (e) {
            return { denied: true, message: String(e.message || e) };
          }
        });
      }
      module.exports = { apply, inject: ["hmr"] };
    `,
  });
  writePlugin(ws, "b-plugin", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "b_echo", description: "被" }, () => "b");
      }
      module.exports = { apply };
    `,
  });
  const container = createContainer({});
  const host = createHost({ workspace: ws, container, log: () => {}, onTools: () => {} });
  container.provide(
    "hmr",
    createHmrService({ ctx: container.root, host, allowOthers: false })
  );
  await host.loadAll();

  const r = await host.callTool("try_other", {});
  assert.strictEqual(r.denied, true, "跨插件重载要被拒绝");
  assert.ok(/只能重载自己/.test(r.message || ""), `要说清原因：${r.message}`);
});

await test("没声明 hmr 的插件拿不到这个服务（cordis 语义：不声明不给）", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "no-hmr", {
    "main.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "probe", description: "探测" }, () => {
          // 没在 inject 里声明 —— 访问就该被容器拦下来
          try {
            const v = ctx.hmr;
            return { got: v !== undefined && v !== null };
          } catch (e) {
            return { got: false, blocked: String(e.message || e) };
          }
        });
      }
      module.exports = { apply };
    `,
  });
  const container = createContainer({});
  const host = createHost({ workspace: ws, container, log: () => {}, onTools: () => {} });
  container.provide(
    "hmr",
    createHmrService({ ctx: container.root, host, allowOthers: false })
  );
  await host.loadAll();

  const r = await host.callTool("probe", {});
  assert.strictEqual(r.got, false, "没在 inject 里声明就不该拿到");
  assert.ok(/inject/.test(r.blocked || ""), `要说明是 inject 的问题：${r.blocked}`);
});

/* ============================================================
   7. 入口解析
   ============================================================ */

console.log("\n[7] 入口解析");

await test("只写 exports 不写 main 的包也能找到入口", async () => {
  const ws = makeWorkspace();
  writePlugin(ws, "exports-pkg", {
    "package.json": JSON.stringify({
      name: "exports-pkg",
      version: "1.0.0",
      exports: { ".": { import: "./lib/entry.js" } },
    }),
    "lib/entry.js": `
      function apply(ctx) {
        ctx.tools.registerTool({ name: "exports_echo", description: "exports 入口" }, () => "ok");
      }
      module.exports = { apply };
    `,
  });
  const { host } = makeHost(ws);
  const r = await host.loadAll();
  assert.ok(r.loaded >= 1, `要加载成功：${JSON.stringify(r.failed)}`);
  assert.ok(host.listTools().some((t) => t.name === "exports_echo"), "工具要注册上");
});

/* ---------------- 收尾 ---------------- */

console.log(
  `\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项失败`}（${passed + failed} 项）`
);
console.log(
  `  运行环境：registerHooks ${reload.supportsEsmReload ? "可用（ESM 走完整热重载）" : "不可用（ESM 如实降级）"}`
);
process.exit(failed === 0 ? 0 : 1);
