#!/usr/bin/env node
/* ============================================================
   键盘内核（状态机）测试

   ============ 这套测试在防什么 ============

   输入法的 bug 有一个共同点：**只在特定应用、特定按键顺序下出现**。
   真机上极难复现，所以判断逻辑必须能在沙箱里被完整跑一遍。

   这里断言的都是"用户会骂人"的场景：

     · 打了 nihao 按回车，字没了
     · 拼音没选完，退格删掉了输入框里的字
     · 密码框里 AI 按钮还能点
     · 选了"北京"之后，后面打的"你好"跟着丢了

   用法：node tests/ime-state-test.mjs
   ============================================================ */

import assert from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { createName } = { createName: null };
const { createEngine } = await import(pathToFileURL(path.join(ROOT, "ime", "core", "pinyin.js")).href);
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

/* ---------------- 假词库（与 pinyin 测试同一套思路） ---------------- */

const SYL = ["ni", "hao", "wo", "ai", "zhong", "guo", "bei", "jing", "shi", "de", "xian", "xi", "an"];
const WORDS = {
  nihao: [["你好", 9000]],
  woaini: [["我爱你", 2000]],
  zhongguo: [["中国", 20000]],
  beijing: [["北京", 15000]],
  xian: [["先", 8000], ["西安", 3000]],
  ni: [["你", 50000]],
  hao: [["好", 60000]],
  wo: [["我", 80000]],
  ai: [["爱", 20000]],
  zhong: [["中", 40000]],
  guo: [["国", 30000]],
  bei: [["北", 20000]],
  jing: [["京", 18000]],
  shi: [["是", 100000]],
  de: [["的", 100000]],
  xi: [["西", 9000]],
  an: [["安", 9000]],
};

const lexicon = {
  syllables: new Set(SYL),
  lookup: (k) => (WORDS[k] || []).map(([word, freq]) => ({ word, freq, span: 1 })),
  charsOf: (s) => (WORDS[s] || []).map(([word, freq]) => ({ word, freq })),
};

const engine = createEngine(lexicon);
const reduce = createReducer({ engine });

/** 跑一串 action，返回最终 state 和收集到的全部 effect。 */
function run(actions, from = initialState) {
  let state = from;
  const effects = [];
  for (const a of actions) {
    const r = reduce(state, a);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const types = (effects) => effects.map((e) => e.type);
const commits = (effects) => effects.filter((e) => e.type === "commit").map((e) => e.text);

console.log("\n基础输入\n");

await test("英文模式：字母直接上屏", () => {
  const { effects } = run([{ type: "char", ch: "a" }], { ...initialState, mode: "en" });
  assert.deepStrictEqual(commits(effects), ["a"]);
});

await test("英文模式：shift 上屏大写并自动复位", () => {
  const { state, effects } = run(
    [{ type: "shift" }, { type: "char", ch: "a" }],
    { ...initialState, mode: "en" }
  );
  assert.deepStrictEqual(commits(effects), ["A"]);
  assert.strictEqual(state.shift, false);
});

await test("中文模式：字母进缓冲，不上屏", () => {
  const { state, effects } = run([{ type: "char", ch: "n" }, { type: "char", ch: "i" }]);
  assert.strictEqual(state.buffer, "ni");
  assert.strictEqual(commits(effects).length, 0, "拼音阶段不该往输入框写东西");
  assert.ok(state.cand, "应该有候选");
});

await test("候选里能看到「你」", () => {
  const { state } = run([...("ni".split("").map((ch) => ({ type: "char", ch })))]);
  const list = flattenCandidates(state.cand, 0);
  assert.ok(list.some((x) => x.text === "你"), JSON.stringify(list.map((x) => x.text)));
});

console.log("\n退格\n");

await test("有缓冲时退格只删缓冲，不碰输入框", () => {
  const { state, effects } = run([
    { type: "char", ch: "n" },
    { type: "char", ch: "i" },
    { type: "backspace" },
  ]);
  assert.strictEqual(state.buffer, "n");
  assert.ok(!types(effects).includes("delete"), "不该删输入框里的字");
});

await test("缓冲空了才删输入框", () => {
  const { effects } = run([{ type: "backspace" }]);
  assert.ok(types(effects).includes("delete"));
});

await test("退格把拼音删光后候选也清空", () => {
  const { state } = run([
    { type: "char", ch: "n" },
    { type: "backspace" },
  ]);
  assert.strictEqual(state.buffer, "");
  assert.strictEqual(state.cand, null);
});

console.log("\n空格与回车（最关键的两条）\n");

await test("空格：有缓冲时上屏首选，不插空格", () => {
  const { state, effects } = run([...("nihao".split("").map((ch) => ({ type: "char", ch }))), { type: "space" }]);
  assert.deepStrictEqual(commits(effects), ["你好"]);
  assert.strictEqual(state.buffer, "");
});

await test("空格：缓冲为空时上屏一个空格", () => {
  const { effects } = run([{ type: "space" }]);
  assert.deepStrictEqual(commits(effects), [" "]);
});

await test("回车：有缓冲时必须上屏，绝不吞掉拼音", () => {
  const { state, effects } = run([...("nihao".split("").map((ch) => ({ type: "char", ch }))), { type: "enter" }]);
  const out = commits(effects);
  assert.strictEqual(out.length, 1, `应该有一次 commit，实际 ${JSON.stringify(out)}`);
  assert.strictEqual(out[0], "你好");
  assert.strictEqual(state.buffer, "");
  assert.ok(!types(effects).includes("editorAction"), "有拼音时不该触发发送");
});

await test("回车：拼音无法组词时原样上屏字母", () => {
  const { effects } = run([{ type: "char", ch: "q" }, { type: "char", ch: "w" }, { type: "enter" }]);
  assert.deepStrictEqual(commits(effects), ["qw"]);
});

await test("回车：缓冲为空 + 单行输入框 → 触发编辑器动作（发送）", () => {
  const { effects } = run([{ type: "enter" }], { ...initialState, ctx: { ...initialState.ctx, multiline: false } });
  assert.ok(types(effects).includes("editorAction"));
});

await test("回车：缓冲为空 + 多行输入框 → 换行", () => {
  const { effects } = run([{ type: "enter" }], { ...initialState, ctx: { ...initialState.ctx, multiline: true } });
  assert.deepStrictEqual(commits(effects), ["\n"]);
  assert.ok(!types(effects).includes("editorAction"));
});

console.log("\n选候选与剩余缓冲\n");

await test("选候选：上屏并清空整串", () => {
  const { state, effects } = run([
    ...("nihao".split("").map((ch) => ({ type: "char", ch }))),
    { type: "candidate", index: 0 },
  ]);
  assert.deepStrictEqual(commits(effects), ["你好"]);
  assert.strictEqual(state.buffer, "");
});

await test("选多字词后，后面的输入要留下（beijing → 选北京 → 剩 nihao）", () => {
  const seq = [..."beijingnihao".split("").map((ch) => ({ type: "char", ch }))];
  const mid = run(seq);
  const list = flattenCandidates(mid.state.cand, 0);
  const idx = list.findIndex((x) => x.text === "北京");
  assert.ok(idx >= 0, `候选里要有北京：${JSON.stringify(list.map((x) => x.text))}`);

  const after = run([{ type: "candidate", index: idx }], mid.state);
  assert.deepStrictEqual(commits(after.effects), ["北京"]);
  assert.strictEqual(after.state.buffer, "nihao", `剩余缓冲应为 nihao，实际 ${after.state.buffer}`);
  assert.ok(after.state.cand, "剩余部分应该继续出候选");
});

await test("翻页不越界", () => {
  const { state } = run([
    ...("ni".split("").map((ch) => ({ type: "char", ch }))),
    { type: "page", dir: -1 },
    { type: "page", dir: -5 },
  ]);
  assert.strictEqual(state.page, 0);
});

console.log("\n模式与安全\n");

await test("切英文清空拼音缓冲", () => {
  const { state } = run([{ type: "char", ch: "n" }, { type: "mode" }]);
  assert.strictEqual(state.mode, "en");
  assert.strictEqual(state.buffer, "");
  assert.strictEqual(state.cand, null);
});

await test("密码框：切进来强制英文并清空一切", () => {
  const { state } = run(
    [{ type: "context", patch: { isPassword: true } }],
    { ...initialState, mode: "zh", buffer: "ni", panel: "ai" }
  );
  assert.strictEqual(state.mode, "en");
  assert.strictEqual(state.buffer, "");
  assert.strictEqual(state.panel, "");
  assert.strictEqual(state.ai, null);
});

await test("密码框：AI 被拒并给出提示", () => {
  const { state, effects } = run([{ type: "ai", task: "polish" }], {
    ...initialState,
    ctx: { ...initialState.ctx, isPassword: true },
  });
  assert.ok(types(effects).includes("toast"));
  assert.strictEqual(state.panel, "", "不该打开 AI 面板");
});

await test("密码框：语音与截图也被拒", () => {
  const base = { ...initialState, ctx: { ...initialState.ctx, isPassword: true } };
  assert.ok(types(run([{ type: "voice", op: "start" }], base).effects).includes("toast"));
  assert.ok(types(run([{ type: "capture" }], base).effects).includes("toast"));
});

console.log("\n面板与插入\n");

await test("面板开关是切换语义", () => {
  const a = run([{ type: "panel", name: "clip" }]);
  assert.strictEqual(a.state.panel, "clip");
  const b = run([{ type: "panel", name: "clip" }], a.state);
  assert.strictEqual(b.state.panel, "");
});

await test("打开面板前先把拼音上屏", () => {
  const { state, effects } = run([
    ...("nihao".split("").map((ch) => ({ type: "char", ch }))),
    { type: "panel", name: "phrase" },
  ]);
  assert.deepStrictEqual(commits(effects), ["你好"]);
  assert.strictEqual(state.panel, "phrase");
});

await test("插入文本（短语/剪贴板）直接上屏并清缓冲", () => {
  const { state, effects } = run([
    { type: "char", ch: "n" },
    { type: "insert", text: "收到，我看一下" },
  ]);
  assert.deepStrictEqual(commits(effects), ["收到，我看一下"]);
  assert.strictEqual(state.buffer, "");
});

await test("语音结果直接上屏，不进组合态", () => {
  const { state, effects } = run([
    { type: "voice", op: "start" },
    { type: "voiceText", text: "帮我约个会" },
  ]);
  assert.deepStrictEqual(commits(effects), ["帮我约个会"]);
  assert.strictEqual(state.voice, "idle");
});

console.log("\nAI 流程\n");

await test("AI 改写：发起 → 完成 → 替换，整条路径", () => {
  const a = run([{ type: "ai", task: "polish" }]);
  assert.strictEqual(a.state.panel, "ai");
  assert.ok(a.effects.some((e) => e.type === "ai" && e.op === "start" && e.task === "polish"));

  const b = run([{ type: "aiDone", text: "润色后的句子", source: "原句" }], a.state);
  assert.strictEqual(b.state.ai.status, "done");

  const c = run([{ type: "aiReplace" }], b.state);
  const rep = c.effects.find((e) => e.type === "replaceSelection");
  assert.ok(rep, "应该发出替换动作");
  assert.strictEqual(rep.text, "润色后的句子");
  assert.strictEqual(c.state.panel, "");
});

await test("AI 失败不替换，只显示原因", () => {
  const a = run([{ type: "ai", task: "translate" }]);
  const b = run([{ type: "aiFail", msg: "网络断了" }], a.state);
  assert.strictEqual(b.state.ai.status, "error");
  const c = run([{ type: "aiReplace" }], b.state);
  assert.ok(!c.effects.some((e) => e.type === "replaceSelection"));
});

await test("取消 AI 会通知原生中止请求", () => {
  const a = run([{ type: "ai", task: "polish" }]);
  const b = run([{ type: "aiCancel" }], a.state);
  assert.ok(b.effects.some((e) => e.type === "ai" && e.op === "cancel"));
});

console.log("\n其他\n");

await test("有缓冲时左右键不跳光标，只提示", () => {
  const { effects } = run([{ type: "char", ch: "n" }, { type: "move", dir: "left" }]);
  assert.ok(types(effects).includes("toast"));
  assert.ok(!types(effects).includes("move"));
});

await test("reset 清空缓冲但保留输入框上下文与模式", () => {
  const before = { ...initialState, mode: "en", buffer: "ni", ctx: { ...initialState.ctx, multiline: true } };
  const { state } = run([{ type: "reset" }], before);
  assert.strictEqual(state.buffer, "");
  assert.strictEqual(state.mode, "en");
  assert.strictEqual(state.ctx.multiline, true);
});

await test("未知 action 不改状态也不抛错", () => {
  const { state, effects } = run([{ type: "what" }]);
  assert.strictEqual(state.buffer, "");
  assert.strictEqual(effects.length, 0);
});

console.log(`\n${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
