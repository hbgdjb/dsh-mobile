#!/usr/bin/env node
/* ============================================================
   两侧工作区路径一致性检查

   ============ 为什么单独一个测试 ============

   页面写文件走 DshFsBridge（Java），Node 读插件走 DshNodeRuntime（Java）
   传进去的 argv。两边必须指向**同一个目录**。

   这两处差一层目录时，不会报任何错：
     · 页面写入成功，工作区列表里也看得见；
     · Node 照常启动，日志一切正常；
     · 只是插件列表永远是 0 —— 用户看到的是「明明放了文件，却说未找到插件」。

   这种 bug 在真机上极难定位（要靠对比 node.log 里的路径和手机文件管理器）。
   所以用静态检查守住：改任一边的拼接方式，这个测试立刻红。

   用法：node tests/workspace-path-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const JAVA = path.join(ROOT, "android", "java");

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

const nodeRuntime = fs.readFileSync(path.join(JAVA, "DshNodeRuntime.java"), "utf8");
const fsBridge = fs.readFileSync(path.join(JAVA, "DshFsBridge.java"), "utf8");

/** 取出一个方法的方法体（够用的括号配平，不追求完整解析）。 */
function methodBody(source, signature) {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `找不到方法：${signature}`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("括号没配平：" + signature);
}

console.log("\n[1] 两侧的工作区拼接");

await test("DshNodeRuntime 传给 Node 的工作区带 workspace 这一层", () => {
  const body = methodBody(nodeRuntime, "private static String workspacePath(Context ctx)");
  assert.ok(
    /new File\(\s*ext\s*,\s*"workspace"\s*\)/.test(body),
    "workspacePath 必须返回 <root>/workspace —— 根目录不是工作区。实际方法体：\n" + body
  );
  assert.ok(
    !/return ext\.getAbsolutePath\(\)/.test(body),
    "不能直接返回根目录：页面把文件写在 <root>/workspace 下"
  );
});

await test("fallback 分支同样带 workspace", () => {
  const body = methodBody(nodeRuntime, "private static String workspacePath(Context ctx)");
  assert.ok(
    /new File\(\s*ctx\.getFilesDir\(\)\s*,\s*"workspace"\s*\)/.test(body),
    "getExternalFilesDir 拿不到时也要落到 <filesDir>/workspace，否则又差一层"
  );
});

await test("DshFsBridge 的区域目录是 <root>/<area 名>", () => {
  const body = methodBody(fsBridge, "private File areaDir(String area)");
  assert.ok(/new File\(\s*root\s*,\s*name\s*\)/.test(body), "区域目录 = root + 区域名");
  assert.ok(/"workspace"\.equals|name = "workspace"/.test(body), "workspace 是其中一个区域名");
});

await test("两边拼出来的名字一致（都是 workspace，不是 Workspace/工作区）", () => {
  const node = methodBody(nodeRuntime, "private static String workspacePath(Context ctx)");
  const area = methodBody(fsBridge, "private File areaDir(String area)");
  assert.ok(node.includes('"workspace"'));
  assert.ok(area.includes('"workspace"'));
});

console.log("\n[2] Node 侧怎么用这个路径");

const nodeMain = fs.readFileSync(path.join(ROOT, "android", "node", "main.js"), "utf8");

await test("插件目录 = <工作区>/plugins", () => {
  assert.ok(
    /PLUGIN_DIR\s*=\s*'plugins'/.test(fs.readFileSync(path.join(ROOT, "android", "node", "plugin-host.js"), "utf8")),
    "插件目录名必须是 plugins"
  );
  assert.ok(nodeMain.includes("path.join(workspace, 'plugins')"), "main.js 要按 <工作区>/plugins 建目录");
});

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
