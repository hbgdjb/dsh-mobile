#!/usr/bin/env node
/* ============================================================
   真实词库的加载与查询测试

   上一套用假词库测算法；这一套测**实际构建出来的 lexicon.bin**：
   二进制格式读写是否对得上、常用词能不能查到、加载够不够快。

   ============ 为什么格式错误必须在这里被抓到 ============
   
   二进制布局只要有一个偏移写错，查询就会"查得到但出来是乱码"，
   或者干脆什么都查不到。这种错误在 UI 上表现为"打不出字"，
   和"词库里没有这个词"看起来一模一样，很难区分。
   
   所以这里直接用真实产物断言具体的词。

   用法：node tests/ime-lexicon-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BIN = path.join(ROOT, "ime", "lexicon.bin");
const { createLexicon, createEngine } = await import(
  pathToFileURL(path.join(ROOT, "ime", "core", "pinyin.js")).href
);

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

if (!fs.existsSync(BIN)) {
  console.error(`词库不存在：${BIN}\n先跑 node tools/ime-build-lexicon.mjs`);
  process.exit(1);
}

console.log(`\n词库 ${(fs.statSync(BIN).size / 1024).toFixed(0)} KB\n`);

const t0 = Date.now();
const buf = fs.readFileSync(BIN);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const lexicon = createLexicon(ab);
const loadMs = Date.now() - t0;
const engine = createEngine(lexicon);

await test("加载成功且规模合理", () => {
  assert.ok(lexicon.stats.entries > 25000, `词条数 ${lexicon.stats.entries}`);
  assert.ok(lexicon.syllables.size > 380, `音节数 ${lexicon.syllables.size}`);
});

await test(`加载耗时 < 100ms（实际 ${loadMs}ms）`, () => {
  assert.ok(loadMs < 100, `实际 ${loadMs}ms`);
});

console.log("\n常用词\n");

const cases = [
  ["nihao", "你好"],
  ["zhongguo", "中国"],
  ["beijing", "北京"],
  ["woaini", "我爱你"],
  ["xiexie", "谢谢"],
  ["duibuqi", "对不起"],
  ["mingtian", "明天"],
  ["gongzuo", "工作"],
  ["shouji", "手机"],
  ["weixin", "微信"],
  ["zhongwen", "中文"],
  ["shijian", "时间"],
  ["wenti", "问题"],
  ["xianzai", "现在"],
];

for (const [input, want] of cases) {
  await test(`${input} → ${want}`, () => {
    const c = engine.candidates(input);
    assert.ok(c, "应该能切分");
    const all = [...c.whole, ...c.words];
    assert.ok(all.includes(want), `候选：${JSON.stringify(all.slice(0, 6))}`);
  });
}

console.log("\n多音字与歧义\n");

await test("xian 同时给出「先」和「西安」", () => {
  const c = engine.candidates("xian");
  const all = [...c.whole, ...c.words, ...c.chars.map((x) => x.word)];
  assert.ok(all.includes("先"), JSON.stringify(all.slice(0, 8)));
  assert.ok(all.includes("西安"), JSON.stringify(all.slice(0, 8)));
});

await test("yinhang → 银行（不是「银航」）", () => {
  const c = engine.candidates("yinhang");
  const all = [...c.whole, ...c.words];
  assert.ok(all.includes("银行"), JSON.stringify(all.slice(0, 6)));
});

await test("chongqing → 重庆", () => {
  const c = engine.candidates("chongqing");
  const all = [...c.whole, ...c.words];
  assert.ok(all.includes("重庆"), JSON.stringify(all.slice(0, 6)));
});

await test("lv 用 v 打 ü", () => {
  const c = engine.candidates("lv");
  assert.ok(c, "应该能切");
  const all = [...c.chars.map((x) => x.word), ...c.words];
  assert.ok(all.length > 0);
});

console.log("\n边界\n");

await test("乱码输入返回 null", () => {
  assert.strictEqual(engine.candidates("zzzzzzzz"), null);
});

await test("生僻组合也能逐字出候选", () => {
  const c = engine.candidates("yigeyongyu");
  assert.ok(c, "必须有输出");
  assert.ok(c.whole.length || c.words.length || c.chars.length);
});

console.log("\n性能\n");

await test("冷启动后 200 次查询 < 200ms", () => {
  const t = Date.now();
  for (let i = 0; i < 200; i += 1) engine.candidates("zhongguo");
  const ms = Date.now() - t;
  assert.ok(ms < 200, `实际 ${ms}ms`);
});

await test("长输入单次 < 30ms", () => {
  const t = Date.now();
  engine.candidates("woxiangmingtianqubeijingchuchai");
  const ms = Date.now() - t;
  assert.ok(ms < 30, `实际 ${ms}ms`);
});

console.log(`\n${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
