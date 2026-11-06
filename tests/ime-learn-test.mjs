#!/usr/bin/env node
/* ============================================================
   输入记忆测试

   ============ 这套测试在防什么 ============

   "记忆学习"最容易出的两种毛病，都是用户会直接骂出来的：

     · 学了跟没学一样 —— 打十遍"背景"，它还是排在"北京"后面。
       根因通常是加成量级不对：往 3.4 万的词频里加 450，
       log 之后只挪了 0.01 分，肉眼永远看不见。

     · 学歪了 —— 误点一次就永远霸占首位，再也纠不回来。
       根因是没有上限、没有淘汰。

   所以这里一半断言"学得动"，一半断言"学不坏"。

   用真词库跑：这条链的坑几乎都在真实词频的量级上，
   假词库（每个词几百频次）反而测不出来。

   用法：node tests/ime-learn-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { createLexicon, createEngine } = await import(
  pathToFileURL(path.join(ROOT, "ime", "core", "pinyin.js")).href
);
const { createLearned, STEP_WORD, STEP_CHAR, CAP_WORD, CAP_CHAR, MAX_ENTRIES } = await import(
  pathToFileURL(path.join(ROOT, "ime", "core", "learn.js")).href
);
const { createReducer, initialState, flattenCandidates } = await import(
  pathToFileURL(path.join(ROOT, "ime", "core", "state.js")).href
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

/* ---------------- 真词库 ---------------- */

const bin = fs.readFileSync(path.join(ROOT, "ime", "lexicon.bin"));
const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const lexicon = createLexicon(ab);

/** 造一个"刚装好、还没学过任何词"的引擎。 */
function freshEngine() {
  const learned = createLearned();
  return { learned, engine: createEngine(lexicon, { learned: learned.map }) };
}

const wordsOf = (engine, input) => engine.candidates(input, { limit: 9 })?.words || [];
const charsOf = (engine, input) =>
  (engine.candidates(input, { limit: 9 })?.chars || []).map((c) => c.word);
const wholeOf = (engine, input) => engine.candidates(input, { limit: 9 })?.whole?.[0] || "";

/* ============================================================
   一、学得动
   ============================================================ */

console.log("\n学习生效\n");

await test("初始状态：beijing 首位是「北京」（不是「被」）", () => {
  const { engine } = freshEngine();
  assert.strictEqual(wordsOf(engine, "beijing")[0], "北京", JSON.stringify(wordsOf(engine, "beijing")));
});

await test("学 8 次「背景」后，它超过「北京」排到首位", () => {
  const { learned, engine } = freshEngine();
  for (let i = 0; i < 8; i += 1) learned.learn("背景", "word");
  assert.strictEqual(wordsOf(engine, "beijing")[0], "背景", JSON.stringify(wordsOf(engine, "beijing")));
});

await test("学 3 次不足以翻转 —— 误选一次不能立刻改天换地", () => {
  const { learned, engine } = freshEngine();
  for (let i = 0; i < 3; i += 1) learned.learn("背景", "word");
  assert.strictEqual(wordsOf(engine, "beijing")[0], "北京", JSON.stringify(wordsOf(engine, "beijing")));
});

await test("单字也吃学习：shi 学会了「时」就往前站", () => {
  const { learned, engine } = freshEngine();
  const before = charsOf(engine, "shi");
  assert.strictEqual(before[0], "是", JSON.stringify(before));
  for (let i = 0; i < 6; i += 1) learned.learn("时", "char");
  assert.strictEqual(charsOf(engine, "shi")[0], "时", JSON.stringify(charsOf(engine, "shi")));
});

await test("学习只影响学过的词，别的输入不受牵连", () => {
  const { learned, engine } = freshEngine();
  const before = wholeOf(engine, "zhongguo");
  for (let i = 0; i < 20; i += 1) learned.learn("背景", "word");
  assert.strictEqual(wholeOf(engine, "zhongguo"), before, "学「背景」不该动到「中国」");
  assert.strictEqual(wordsOf(engine, "zhongguo")[0], "中国");
});

/* ============================================================
   二、学不坏
   ============================================================ */

console.log("\n上限与淘汰\n");

await test("词权重封顶，连学 50 次也不超过 CAP_WORD", () => {
  const { learned } = freshEngine();
  for (let i = 0; i < 50; i += 1) learned.learn("北京", "word");
  assert.strictEqual(learned.get("北京"), CAP_WORD);
});

await test("单字权重单独封顶（比词低一半）", () => {
  const { learned } = freshEngine();
  for (let i = 0; i < 50; i += 1) learned.learn("是", "char");
  assert.strictEqual(learned.get("是"), CAP_CHAR);
  assert.ok(CAP_CHAR < CAP_WORD, "单字上限应该低于词");
});

await test("封顶之后再学，不算变化（调用方不必写盘）", () => {
  const { learned } = freshEngine();
  for (let i = 0; i < 20; i += 1) learned.learn("北京", "word");
  assert.strictEqual(learned.learn("北京", "word"), false);
});

await test(`总条数封顶 ${MAX_ENTRIES}，超了淘汰权重最低的`, () => {
  const { learned } = freshEngine();
  // 用纯汉字造词名（学习只认汉字，带数字的会被直接拒掉）
  const han = (i) => String.fromCharCode(0x4e00 + i);
  for (let i = 0; i < 100; i += 1) learned.learn(`${han(i)}低`, "word");
  for (let i = 0; i < 500; i += 1) {
    for (let k = 0; k < 3; k += 1) learned.learn(`${han(i)}高`, "word");
  }
  assert.strictEqual(learned.size, MAX_ENTRIES);
  // 权重低的那批应该被淘汰干净
  assert.strictEqual(learned.get(`${han(0)}低`), 0, "最弱的词该被淘汰");
  assert.ok(learned.get(`${han(499)}高`) > 0, "权重高的词要留下");
});

await test("不学整句（kind=whole）—— 学它改变不了任何顺序", () => {
  const { learned } = freshEngine();
  assert.strictEqual(learned.learn("我爱北京", "whole"), false);
  assert.strictEqual(learned.size, 0);
});

await test("不学英文、数字、符号", () => {
  const { learned } = freshEngine();
  for (const t of ["hello", "123", "，", "abc中文"]) {
    assert.strictEqual(learned.learn(t, "word"), false, `不该学 ${t}`);
  }
  assert.strictEqual(learned.size, 0);
});

/* ============================================================
   三、存得住
   ============================================================ */

console.log("\n持久化\n");

await test("toJSON / 重新 load 后，学习效果原样还在", () => {
  const a = freshEngine();
  for (let i = 0; i < 8; i += 1) a.learned.learn("背景", "word");
  assert.strictEqual(wordsOf(a.engine, "beijing")[0], "背景");

  // 模拟"键盘被杀掉、重新打开"
  const saved = JSON.parse(JSON.stringify(a.learned.toJSON()));
  const b = freshEngine();
  b.learned.load(saved);
  assert.strictEqual(wordsOf(b.engine, "beijing")[0], "背景", "重启后记忆应该还在");
});

await test("存储里的脏数据不会把键盘搞崩", () => {
  const { learned } = freshEngine();
  learned.load({
    正常词: 120,
    负权重: -50,
    零权重: 0,
    非数字: "abc",
    "": 100,
    无穷: Infinity,
  });
  assert.strictEqual(learned.get("正常词"), 120);
  assert.strictEqual(learned.get("负权重"), 0);
  assert.strictEqual(learned.get("零权重"), 0);
  assert.strictEqual(learned.get("非数字"), 0);
  assert.strictEqual(learned.get("无穷"), 0);
  assert.strictEqual(learned.size, 1);
});

await test("load 传 null / 非对象也不炸", () => {
  const { learned } = freshEngine();
  for (const bad of [null, undefined, 42, "x", []]) {
    assert.doesNotThrow(() => learned.load(bad));
  }
});

await test("清空后回到没学过的状态", () => {
  const { learned, engine } = freshEngine();
  for (let i = 0; i < 8; i += 1) learned.learn("背景", "word");
  assert.strictEqual(wordsOf(engine, "beijing")[0], "背景");
  learned.clear();
  assert.strictEqual(learned.size, 0);
  assert.strictEqual(wordsOf(engine, "beijing")[0], "北京");
});

/* ============================================================
   四、状态机的接线
   ============================================================ */

console.log("\n状态机接线\n");

/** 打一串字母，返回 state + 全部 effect。 */
function type(engine, letters) {
  const reduce = createReducer({ engine });
  let state = initialState;
  const effects = [];
  for (const ch of letters) {
    const r = reduce(state, { type: "char", ch });
    state = r.state;
    effects.push(...r.effects);
  }
  return { reduce, state, effects };
}

await test("点候选会产出一条 learn effect", () => {
  const { engine } = freshEngine();
  const { reduce, state } = type(engine, "beijing");
  const r = reduce(state, { type: "candidate", index: 0 });
  const learn = r.effects.filter((e) => e.type === "learn");
  assert.strictEqual(learn.length, 1, JSON.stringify(r.effects));
  assert.strictEqual(learn[0].text, "北京");
  assert.strictEqual(learn[0].kind, "word");
});

await test("单字即使从词候选里点，权重也按单字档算（减半）", () => {
  const { learned } = freshEngine();
  // 词库里单字也是词条，所以"是"的 kind 是 word；
  // 但权重必须按字数走，否则单字一次 +90，八次就霸榜了
  assert.strictEqual(learned.learn("是", "word"), true);
  assert.strictEqual(learned.get("是"), STEP_CHAR);
});

await test("空格上屏首选也学 —— 用户按空格就是认可了它", () => {
  const { engine } = freshEngine();
  const { reduce, state } = type(engine, "beijing");
  const r = reduce(state, { type: "space" });
  const learn = r.effects.find((e) => e.type === "learn");
  assert.ok(learn, JSON.stringify(r.effects));
  assert.strictEqual(learn.text, "北京");
});

await test("打不出候选、空格原样上屏字母时不学", () => {
  const { engine } = freshEngine();
  // qwerty 无法切分，空格会把字母原样上屏
  const { reduce, state } = type(engine, "qwerty");
  assert.strictEqual(state.cand, null);
  const r = reduce(state, { type: "space" });
  assert.strictEqual(r.effects.filter((e) => e.type === "learn").length, 0, JSON.stringify(r.effects));
});

await test("退格不产生 learn", () => {
  const { engine } = freshEngine();
  const { reduce, state } = type(engine, "beijing");
  const r = reduce(state, { type: "backspace" });
  assert.strictEqual(r.effects.filter((e) => e.type === "learn").length, 0);
});

/* ---------------- 汇总 ---------------- */

console.log(`\n${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
