#!/usr/bin/env node
/* ============================================================
   精简 semver（scripts/semver-lite.js）

   这个解析器决定「装哪个版本」。装错版本比装不上更难查：
   插件能加载，但 API 对不上，报的是一堆看不懂的错。

   所以这里按 npm 的真实规则测，重点两处：

     · `^0.x` 的语义（0.x 时只允许 patch 变）—— DSH 生态几乎全是 0.x
     · 预发布版本的匹配规则 —— DSH 生态全是 rc / alpha

   用法：node tests/semver-lite-test.mjs
   ============================================================ */

import assert from "node:assert";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const sv = await import(pathToFileURL(path.join(ROOT, "scripts", "semver-lite.js")).href);

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

console.log("\n[1] 解析版本");

await test("标准三段式", () => {
  const v = sv.parseVersion("1.2.3");
  assert.deepStrictEqual([v.major, v.minor, v.patch], [1, 2, 3]);
  assert.deepStrictEqual(v.pre, []);
});

await test("预发布与构建号", () => {
  const v = sv.parseVersion("0.2.1-rc.2+build.7");
  assert.strictEqual(v.major, 0);
  assert.strictEqual(v.minor, 2);
  assert.strictEqual(v.patch, 1);
  assert.deepStrictEqual(v.pre, ["rc", "2"]);
  assert.strictEqual(v.build, "build.7");
});

await test("不是版本号的返回 null，而不是抛错", () => {
  assert.strictEqual(sv.parseVersion("not-a-version"), null);
  assert.strictEqual(sv.parseVersion(""), null);
});

console.log("\n[2] 比较");

await test("数字段依次比较", () => {
  assert.strictEqual(sv.compareVersions("1.0.0", "1.0.1"), -1);
  assert.strictEqual(sv.compareVersions("2.0.0", "1.9.9"), 1);
  assert.strictEqual(sv.compareVersions("1.2.3", "1.2.3"), 0);
});

await test("预发布小于正式版", () => {
  assert.strictEqual(sv.compareVersions("1.0.0-alpha", "1.0.0"), -1);
  assert.strictEqual(sv.compareVersions("1.0.0", "1.0.0-alpha"), 1);
});

await test("预发布标识符：数字段小于字母段", () => {
  assert.strictEqual(sv.compareVersions("1.0.0-alpha.1", "1.0.0-alpha.2"), -1);
  assert.strictEqual(sv.compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
  assert.strictEqual(sv.compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
});

console.log("\n[3] 脱字符 ^");

await test("^1.2.3：允许 minor/patch 升，不允许换主版本", () => {
  assert.ok(sv.satisfies("1.2.3", "^1.2.3"));
  assert.ok(sv.satisfies("1.9.9", "^1.2.3"));
  assert.ok(!sv.satisfies("2.0.0", "^1.2.3"));
  assert.ok(!sv.satisfies("1.2.2", "^1.2.3"));
});

await test("^0.2.3：0.x 时只允许 patch 变（这条最容易错）", () => {
  assert.ok(sv.satisfies("0.2.3", "^0.2.3"));
  assert.ok(sv.satisfies("0.2.9", "^0.2.3"));
  assert.ok(!sv.satisfies("0.3.0", "^0.2.3"), "0.3 属于不兼容变更");
});

await test("^0.0.3：锁死在 patch", () => {
  assert.ok(sv.satisfies("0.0.3", "^0.0.3"));
  assert.ok(!sv.satisfies("0.0.4", "^0.0.3"));
});

console.log("\n[4] 波浪号 ~ 与比较符");

await test("~1.2.3：只允许 patch 变", () => {
  assert.ok(sv.satisfies("1.2.9", "~1.2.3"));
  assert.ok(!sv.satisfies("1.3.0", "~1.2.3"));
});

await test("~1.2：等价于 1.2.x", () => {
  assert.ok(sv.satisfies("1.2.5", "~1.2"));
  assert.ok(!sv.satisfies("1.3.0", "~1.2"));
});

await test(">= <= > <", () => {
  assert.ok(sv.satisfies("2.0.0", ">=1.0.0"));
  assert.ok(!sv.satisfies("0.9.0", ">=1.0.0"));
  assert.ok(sv.satisfies("1.0.0", "<=1.0.0"));
  assert.ok(sv.satisfies("1.0.1", ">1.0.0"));
});

await test("1.x / 1.2.x 简写", () => {
  assert.ok(sv.satisfies("1.9.0", "1.x"));
  assert.ok(!sv.satisfies("2.0.0", "1.x"));
  assert.ok(sv.satisfies("1.2.7", "1.2.x"));
  assert.ok(!sv.satisfies("1.3.0", "1.2.x"));
});

console.log("\n[5] 逻辑组合");

await test("|| 是或", () => {
  const r = "^1 || ^2";
  assert.ok(sv.satisfies("1.5.0", r));
  assert.ok(sv.satisfies("2.0.0", r));
  assert.ok(!sv.satisfies("3.0.0", r));
});

await test("空格是且", () => {
  assert.ok(sv.satisfies("1.5.0", ">=1.0.0 <2.0.0"));
  assert.ok(!sv.satisfies("2.5.0", ">=1.0.0 <2.0.0"));
});

await test("* 接受任意正式版，但不接受预发布", () => {
  assert.ok(sv.satisfies("1.0.0", "*"));
  assert.ok(!sv.satisfies("1.0.0-beta", "*"), "npm 的 * 不匹配预发布");
});

console.log("\n[6] 预发布匹配（DSH 生态的关键）");

await test("^1.2.3 不匹配 1.2.4-beta.1", () => {
  assert.ok(!sv.satisfies("1.2.4-beta.1", "^1.2.3"), "范围里没写预发布，就不该选到预发布");
});

await test("^1.2.3-beta.1 匹配同 triple 的预发布", () => {
  assert.ok(sv.satisfies("1.2.3-beta.2", "^1.2.3-beta.1"));
  assert.ok(sv.satisfies("1.2.3", "^1.2.3-beta.1"), "正式版当然也匹配");
});

await test("^0.2.0-rc.1 不匹配 0.2.1-rc.1（triple 不同）", () => {
  assert.ok(!sv.satisfies("0.2.1-rc.1", "^0.2.0-rc.1"));
});

console.log("\n[7] 挑版本（真实数据）");

await test("dsh-settings 的版本表：^0.1.7-rc.1 || ^0.2.0-rc.1", () => {
  // 这是 npm 上真实存在的版本序列
  const versions = [
    "0.1.5-rc.3",
    "0.1.6-alpha.2",
    "0.1.7-alpha.1",
    "0.1.7-rc.1",
    "0.1.7-rc.2",
    "0.2.0-rc.1",
    "0.2.0-rc.2",
    "0.2.1-alpha.1",
    "0.2.1-rc.2",
  ];
  const picked = sv.maxSatisfying(versions, "^0.1.7-rc.1 || ^0.2.0-rc.1");
  // 0.2.1-rc.2 的 triple 是 0.2.1，和 0.2.0-rc.1 不同 → 按 npm 规则不选它
  assert.strictEqual(picked, "0.2.0-rc.2", "实际选出：" + picked);
});

await test("没有符合的版本时返回 null，而不是乱选一个", () => {
  assert.strictEqual(sv.maxSatisfying(["1.0.0", "2.0.0"], "^3.0.0"), null);
});

await test("乱序版本表里挑最高的", () => {
  const picked = sv.maxSatisfying(["0.9.0", "0.11.0", "0.10.5"], "^0.10.0");
  assert.strictEqual(picked, "0.10.5");
});

await test("看不懂的范围要报错，而不是当通配符", () => {
  assert.throws(() => sv.parseRange("^^1.2.3"), /看不懂/);
});

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
