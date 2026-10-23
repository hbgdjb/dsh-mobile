#!/usr/bin/env node
/* ============================================================
   Node 插件安装器（scripts/plugin-install-node.js）

   测三件事：
     1. 两种压缩格式能不能解开（zip / tar.gz）；
     2. 能不能从乱七八糟的目录结构里认出「插件根」；
     3. 该拦的包有没有被拦（没入口、缺 node_modules 的依赖）。

   样例包在 tests/fixtures/archives/，用 python 的 zipfile / tarfile 生成，
   不是手搓的字节 —— 这样才能保证解析器对的是真实工具产物。

   用法：node tests/plugin-install-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ARCH = path.join(HERE, "fixtures", "archives");

const mod = await import(pathToFileURL(path.join(ROOT, "scripts", "plugin-install-node.js")).href);
const { unpackZip, unpackTarGz, unpackAny, planInstall } = mod;

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

const read = (n) => new Uint8Array(fs.readFileSync(path.join(ARCH, n)));
const textOf = (entry) => new TextDecoder("utf-8").decode(entry.bytes);

console.log("\n[1] 解压");

await test("zip（deflate）能解出文件内容", async () => {
  const entries = await unpackZip(read("nested.zip"));
  const paths = entries.map((e) => e.path).sort();
  assert.ok(paths.includes("package/index.js"));
  assert.ok(paths.includes("package/package.json"));
  const pkg = entries.find((e) => e.path === "package/package.json");
  assert.strictEqual(JSON.parse(textOf(pkg)).name, "@demo/hello-plugin");
});

await test("zip（store，不压缩）也能解", async () => {
  const entries = await unpackZip(read("flat.zip"));
  const paths = entries.map((e) => e.path).sort();
  assert.deepStrictEqual(paths, ["README.md", "main.js"]);
  assert.strictEqual(textOf(entries.find((e) => e.path === "main.js")), "exports.apply = () => {};");
});

await test("tar.gz（npm pack 的形态）能解", async () => {
  const entries = await unpackTarGz(read("pkg.tgz"));
  const paths = entries.map((e) => e.path).sort();
  assert.deepStrictEqual(paths, ["package/main.js", "package/package.json", "package/src/util.js"]);
});

await test("unpackAny 按内容而不是扩展名判断格式", async () => {
  // 名字故意给错：内容是 zip，名字说 .tgz
  const entries = await unpackAny("mystery.tgz", read("flat.zip"));
  assert.ok(entries.some((e) => e.path === "main.js"));
});

await test("认不出的格式明确报错", async () => {
  await assert.rejects(() => unpackAny("x.bin", new Uint8Array([1, 2, 3, 4])), /认不出/);
});

console.log("\n[2] 认插件根");

await test("剥掉包裹层，把 @scope/name 变成可用的目录名", async () => {
  const plan = planInstall(await unpackZip(read("nested.zip")));
  assert.strictEqual(plan.id, "demo-hello-plugin", "scope 要并进目录名，避免撞车");
  assert.strictEqual(plan.name, "@demo/hello-plugin");
  assert.strictEqual(plan.version, "1.2.3");
  assert.strictEqual(plan.entry, "index.js");
  const rels = plan.files.map((f) => f.rel).sort();
  assert.deepStrictEqual(rels, ["index.js", "lib/helper.js", "package.json"]);
});

await test("打包垃圾（__MACOSX）不装", async () => {
  const plan = planInstall(await unpackZip(read("nested.zip")));
  assert.ok(!plan.files.some((f) => f.rel.includes("__MACOSX")), "不该把 __MACOSX 装进去");
});

await test("没有包裹层时直接用根目录的 main.js", async () => {
  const plan = planInstall(await unpackZip(read("flat.zip")));
  assert.strictEqual(plan.entry, "main.js");
  assert.strictEqual(plan.files.length, 2);
});

await test("tgz 的 package/ 前缀被剥掉，入口按 package.json 的 main 找", async () => {
  const plan = planInstall(await unpackTarGz(read("pkg.tgz")));
  assert.strictEqual(plan.id, "tgz-plugin");
  assert.strictEqual(plan.entry, "main.js");
  assert.strictEqual(plan.version, "2.0.0");
});

console.log("\n[3] 该拦的拦，该提醒的提醒");

await test("找不到入口 → 明确拒绝（普通 npm 库不是插件）", async () => {
  const entries = await unpackZip(read("noentry.zip"));
  assert.throws(() => planInstall(entries), /找不到插件入口/);
});

await test("声明了依赖却没有 node_modules → 给出警告而不是假装能跑", async () => {
  const plan = planInstall(await unpackZip(read("deps.zip")));
  assert.strictEqual(plan.id, "needs-deps");
  assert.strictEqual(plan.warnings.length, 1);
  assert.ok(/lodash/.test(plan.warnings[0]), "要指出依赖名：" + plan.warnings[0]);
  assert.ok(/node_modules/.test(plan.warnings[0]));
});

await test("没有 package.json → 警告缺元信息，但仍可安装", async () => {
  const plan = planInstall(await unpackZip(read("flat.zip")));
  assert.ok(plan.warnings.some((w) => w.includes("没有 package.json")));
});


console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
