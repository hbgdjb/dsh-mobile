#!/usr/bin/env node
/* ============================================================
   拼音引擎测试

   ============ 这套测试在防什么 ============

   输入法最让人恼火的失败不是"候选不准"，而是**打不出来**：

     · 打了个不在词库里的词，光标卡住，什么都上不去
     · 一段能切分的拼音被判成"非法"，退回英文
     · 退格之后状态错乱，剩下的字母再也拼不出字

   所以断言的重点是「永远有输出」，其次才是「首选对不对」。

   用假词库测：逻辑与数据解耦，几秒跑完，也不受词库构建影响。

   用法：node tests/ime-pinyin-test.mjs
   ============================================================ */

import assert from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { createEngine } = await import(pathToFileURL(path.join(ROOT, "ime", "core", "pinyin.js")).href);

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

/* ---------------- 假词库 ---------------- */

const SYL = [
  "ni", "hao", "wo", "ai", "zhong", "guo", "bei", "jing",
  "xi", "an", "xian", "lv", "lü", "de", "shi", "shu", "zi",
];

const WORDS = {
  nihao: [["你好", 9000]],
  woaini: [["我爱你", 2000]],
  zhongguo: [["中国", 20000]],
  beijing: [["北京", 15000]],
  xian: [["先", 8000], ["西安", 3000], ["现", 7000]],
  ni: [["你", 50000], ["尼", 900], ["泥", 700]],
  hao: [["好", 60000], ["号", 9000], ["豪", 800]],
  wo: [["我", 80000]],
  ai: [["爱", 20000], ["哎", 900]],
  zhong: [["中", 40000], ["种", 12000], ["重", 9000]],
  guo: [["国", 30000], ["过", 20000]],
  xi: [["西", 9000], ["洗", 3000], ["系", 6000]],
  an: [["安", 9000], ["按", 6000]],
  lv: [["绿", 6000], ["旅", 5000]],
  de: [["的", 100000], ["得", 30000], ["地", 20000]],
  shi: [["是", 100000], ["事", 30000], ["时", 25000]],
};

const fakeLexicon = {
  syllables: new Set(SYL),
  lookup(key) {
    return (WORDS[key] || []).map(([word, freq]) => ({
      word,
      freq,
      span: Math.max(1, Math.ceil(key.length / 3)),
    }));
  },
  charsOf(syl) {
    return (WORDS[syl] || []).map(([word, freq]) => ({ word, freq }));
  },
};

const engine = createEngine(fakeLexicon);

/** 便捷断言：候选里要有某个词。 */
function has(cand, word) {
  return (
    cand &&
    (cand.whole.includes(word) || cand.words.includes(word) || cand.chars.some((c) => c.word === word))
  );
}

/** 首选（整句优先，其次词候选第一位）。 */
function top(cand) {
  if (!cand) return "";
  if (cand.whole.length) return cand.whole[0];
  if (cand.words.length) return cand.words[0];
  return cand.chars[0]?.word || "";
}

console.log("\n基本词组\n");

await test("nihao → 你好", () => {
  const c = engine.candidates("nihao");
  assert.ok(c, "应该能切分");
  assert.ok(has(c, "你好"), `候选里要有"你好"：${JSON.stringify(c)}`);
  assert.strictEqual(top(c), "你好");
});

await test("woaini → 我爱你", () => {
  const c = engine.candidates("woaini");
  assert.ok(has(c, "我爱你"), JSON.stringify(c));
});

await test("zhongguo → 中国", () => {
  const c = engine.candidates("zhongguo");
  assert.ok(has(c, "中国"), JSON.stringify(c));
});

await test("beijing → 北京", () => {
  const c = engine.candidates("beijing");
  assert.ok(has(c, "北京"), JSON.stringify(c));
});

console.log("\n多音与歧义\n");

await test("xian 同时给出「先」和「西安」", () => {
  const c = engine.candidates("xian");
  assert.ok(has(c, "先"), "单字应该出现");
  assert.ok(has(c, "西安"), "两字词应该出现");
});

await test("lv 用 v 表示 ü", () => {
  const c = engine.candidates("lv");
  assert.ok(has(c, "绿"), JSON.stringify(c));
});

await test("撇号强制切分：xi'an", () => {
  const c = engine.candidates("xi'an");
  assert.ok(c, "带撇号也要能切");
  assert.ok(has(c, "西") || has(c, "安"), JSON.stringify(c));
  // 不允许把它当成整音节 xian（那样会出"西安/先"而不是"西"+"安"）
  assert.strictEqual(c.buffer, "xian");
});

console.log("\n边界\n");

await test("空输入返回 null", () => {
  assert.strictEqual(engine.candidates(""), null);
  assert.strictEqual(engine.candidates("   "), null);
  assert.strictEqual(engine.candidates("'''"), null);
});

await test("无法切分（qwerty）返回 null，交给上层原样上屏", () => {
  // q/w/e/r/t/y 虽然都在音节表里，但组合不成连续音节
  assert.strictEqual(engine.candidates("qwertyuiop"), null);
});

await test("非字母字符被丢弃，不会炸", () => {
  const c = engine.candidates("ni123hao!!!");
  assert.ok(c, "应该忽略数字与符号");
  assert.strictEqual(c.buffer, "nihao");
});

await test("超长输入不卡死", () => {
  const t0 = Date.now();
  const c = engine.candidates("nihaonihaonihaonihaonihao");
  const ms = Date.now() - t0;
  assert.ok(ms < 300, `超长输入耗时 ${ms}ms`);
  assert.ok(c, "要有输出");
});

await test("逐字降级：词库里没有的组合也能出字", () => {
  // "shide" 在词库里没有整词，但 shi + de 都有单字
  const c = engine.candidates("shide");
  assert.ok(c, "必须有输出，不能卡住");
  assert.ok(c.whole.length || c.words.length || c.chars.length);
  assert.ok(has(c, "是") || has(c, "的"), JSON.stringify(c));
});

await test("候选不重复", () => {
  const c = engine.candidates("nihao");
  const all = [...c.whole, ...c.words, ...c.chars.map((x) => x.word)];
  assert.strictEqual(new Set(all).size >= 2, true, JSON.stringify(all));
  // chars 内部不能有重复
  const set = new Set(c.chars.map((x) => x.word));
  assert.strictEqual(set.size, c.chars.length);
});

await test("limit 生效", () => {
  const c = engine.candidates("shi", { limit: 2 });
  assert.ok(c.chars.length <= 2);
});

console.log("\n性能\n");

await test("200 次查询 < 200ms（假词库，纯算法开销）", () => {
  const t0 = Date.now();
  for (let i = 0; i < 200; i += 1) engine.candidates("zhongguo");
  const ms = Date.now() - t0;
  assert.ok(ms < 200, `实际 ${ms}ms`);
});

console.log(`\n${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
