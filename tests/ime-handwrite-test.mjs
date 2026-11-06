#!/usr/bin/env node
/* ============================================================
   手写识别内核测试

   ============ 这套测试在防什么 ============

   手写这条链的 bug 有个共同点：**不报错，只是认错字**。
   归一化偏 20%，模型照样输出一个"看起来合理"的字；字典索引错一位，
   每个字都变成隔壁那个。这些在真机上完全没法排查。

   所以这里全部用数值断言，把三段各自钉死：

     ① 归一化 —— 字必须**居中**在方框里，长宽比不能变
     ② 张量   —— 形状、值域、三通道一致
     ③ 解码   —— blank 要屏蔽、白名单要生效、字典索引不能错位

   其中"字典索引错位"是最致命也最容易犯的：CTC 的 blank 占 0，
   字典第 1 行才是第一个字。差一位，所有字集体错位成隔壁字符，
   而表现只是"认得不太准"，很难联想到是索引问题。

   用法：node tests/ime-handwrite-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const hw = await import(pathToFileURL(path.join(ROOT, "ime", "core", "handwrite.js")).href);
const { normalizeInk, paintInk, toTensor, softmax, ctcCandidates, buildVocabulary } = hw;

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

const SIZE = hw.RASTER_SIZE;
const PAD = 18;

/* ---------------- ① 归一化 ---------------- */

console.log("\n归一化\n");

await test("太短的笔迹不出手（一个点、一条短线）", () => {
  assert.strictEqual(normalizeInk([]), null);
  assert.strictEqual(normalizeInk([[[10, 10]]]), null, "单个点不该出候选");
  assert.strictEqual(normalizeInk([[[0, 0], [3, 2]]]), null, "3px 的线认出来必然是瞎猜");
});

await test("长边贴到内框，短边按比例 —— 比例不能变", () => {
  // 一个 200×50 的扁字：缩放后应当是 4:1
  const ink = normalizeInk([[[0, 0], [200, 0], [200, 50], [0, 50]]]);
  assert.ok(ink, "应当归一化成功");
  const xs = ink.strokes.flat().map((p) => p[0]);
  const ys = ink.strokes.flat().map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  assert.ok(Math.abs(w / h - 4) < 0.05, `宽高比应当是 4，实际 ${(w / h).toFixed(2)}`);
});

await test("字在方框里居中，不是贴左上角", () => {
  const ink = normalizeInk([[[50, 50], [150, 50], [150, 100], [50, 100]]]);
  const xs = ink.strokes.flat().map((p) => p[0]);
  const ys = ink.strokes.flat().map((p) => p[1]);
  const left = Math.min(...xs);
  const right = SIZE - Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = SIZE - Math.max(...ys);
  assert.ok(Math.abs(left - right) < 1.5, `左右留白要相等：${left.toFixed(1)} vs ${right.toFixed(1)}`);
  assert.ok(Math.abs(top - bottom) < 1.5, `上下留白要相等：${top.toFixed(1)} vs ${bottom.toFixed(1)}`);
  assert.ok(left >= PAD - 1, `不能越过内框：${left.toFixed(1)} < ${PAD}`);
});

await test("写在小角落的字，也会被铺满方框（用户不用瞄准）", () => {
  const tiny = normalizeInk([[[0, 0], [20, 0], [20, 20], [0, 20]]]);
  const big = normalizeInk([[[0, 0], [200, 0], [200, 200], [0, 200]]]);
  const span = (ink) => {
    const xs = ink.strokes.flat().map((p) => p[0]);
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(Math.abs(span(tiny) - span(big)) < 1e-6, "20px 的字和 200px 的字归一化后应当一样大");
});

await test("多笔画都保留，顺序不变", () => {
  const ink = normalizeInk([
    [[0, 0], [10, 0]],
    [[0, 100], [100, 100]],
    [[50, 0], [50, 100]],
  ]);
  assert.strictEqual(ink.strokes.length, 3);
});

await test("非法坐标被丢掉，不会产生 NaN", () => {
  const ink = normalizeInk([[[0, 0], [NaN, 5], [100, 100], [null, 3]]]);
  assert.ok(ink);
  for (const [x, y] of ink.strokes.flat()) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), `出现了非法坐标 ${x},${y}`);
  }
});

/* ---------------- ② 光栅化 ---------------- */

console.log("\n光栅化\n");

function mockCtx() {
  const calls = { fillRect: null, strokes: [], arcs: [] };
  return {
    calls,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    fillRect: (...a) => {
      calls.fillRect = a;
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {
      calls.strokes.push(this.lineWidth);
    },
    arc(x, y, r) {
      calls.arcs.push([x, y, r]);
    },
    fill() {},
  };
}

await test("先铺白底再画墨", () => {
  const ctx = mockCtx();
  paintInk(ctx, normalizeInk([[[0, 0], [100, 100]]]));
  assert.deepStrictEqual(ctx.calls.fillRect, [0, 0, SIZE, SIZE]);
  assert.ok(ctx.calls.strokes.length > 0, "应当画了至少一笔");
});

await test("单点笔画也落墨（否则「氵」会少一笔）", () => {
  const ctx = mockCtx();
  paintInk(ctx, { strokes: [[[10, 10]]], size: SIZE });
  assert.strictEqual(ctx.calls.arcs.length, 1);
});

await test("线宽跟着画布走，不会细成 1px 或粗成一团", () => {
  const w = hw.inkWidth(SIZE);
  assert.ok(w >= 10 && w <= 20, `线宽应当在 10~20，实际 ${w}`);
  // 相对比例要稳定：换画布大小时粗细占的比例不变
  const r1 = hw.inkWidth(160) / 160;
  const r2 = hw.inkWidth(320) / 320;
  assert.ok(Math.abs(r1 - r2) < 0.01, `粗细比例应当一致：${r1} vs ${r2}`);
});

/* ---------------- ③ 张量 ---------------- */

console.log("\n张量\n");

await test("形状是 [3, 48, 48]", () => {
  const gray = new Uint8ClampedArray(SIZE * SIZE).fill(255);
  const t = toTensor(gray, SIZE, SIZE);
  assert.strictEqual(t.width, 48);
  assert.strictEqual(t.height, 48);
  assert.strictEqual(t.data.length, 3 * 48 * 48);
});

await test("白纸 = +1，全黑 = -1（PP-OCR 的 [-1,1] 归一化）", () => {
  const white = toTensor(new Uint8ClampedArray(SIZE * SIZE).fill(255), SIZE, SIZE);
  const black = toTensor(new Uint8ClampedArray(SIZE * SIZE).fill(0), SIZE, SIZE);
  assert.ok(Math.abs(white.data[0] - 1) < 1e-6, `白应当是 +1，实际 ${white.data[0]}`);
  assert.ok(Math.abs(black.data[0] + 1) < 1e-6, `黑应当是 -1，实际 ${black.data[0]}`);
});

await test("三个通道完全一致（手写是单色墨）", () => {
  const gray = new Uint8ClampedArray(SIZE * SIZE);
  for (let i = 0; i < gray.length; i += 1) gray[i] = (i * 37) % 256;
  const t = toTensor(gray, SIZE, SIZE);
  const plane = 48 * 48;
  for (let i = 0; i < plane; i += 7) {
    assert.strictEqual(t.data[i], t.data[i + plane], `通道 0/1 在 ${i} 不一致`);
    assert.strictEqual(t.data[i], t.data[i + 2 * plane], `通道 0/2 在 ${i} 不一致`);
  }
});

await test("细笔画不会被缩样丢掉（盒式滤波的作用）", () => {
  // 160×160 里一条 2px 宽的竖线，缩到 48 后应当还能看到墨
  const gray = new Uint8ClampedArray(SIZE * SIZE).fill(255);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 79; x <= 81; x += 1) gray[y * SIZE + x] = 0;
  }
  const t = toTensor(gray, SIZE, SIZE);
  const mid = 24 * 48 + 24;
  assert.ok(t.data[mid] < 0.5, `中间应当是墨，实际 ${t.data[mid]}`);
});

/* ---------------- ④ 解码 ---------------- */

console.log("\n解码\n");

await test("softmax 归一化到 1", () => {
  const p = softmax([1, 2, 3], 0, 3);
  const sum = p[0] + p[1] + p[2];
  assert.ok(Math.abs(sum - 1) < 1e-6, `和应当是 1，实际 ${sum}`);
  assert.ok(p[2] > p[1] && p[1] > p[0], "大的 logit 概率要更大");
});

await test("softmax 不会溢出（18385 维里的极值）", () => {
  const logits = new Float32Array(18385).fill(-50);
  logits[7] = 900;
  const p = softmax(logits, 0, logits.length);
  assert.ok(Number.isFinite(p[7]), "极值不能变 NaN/Infinity");
  assert.ok(Math.abs(p[7] - 1) < 1e-6, "900 分应当独占全部概率");
});

function fakeProbs(frames, classes, place) {
  // place: { [frame]: [[class, prob], ...] }
  const p = new Float32Array(frames * classes);
  for (let t = 0; t < frames; t += 1) {
    const base = t * classes;
    p.fill(0, base, base + classes);
    for (const [c, v] of place[t] || []) p[base + c] = v;
  }
  return p;
}

await test("blank（索引 0）绝不进候选", () => {
  const p = fakeProbs(4, 10, { 0: [[0, 0.99], [3, 0.5]], 1: [[0, 0.9]] });
  const out = ctcCandidates(p, 4, 10, { limit: 5 });
  assert.ok(out.every((x) => x.index !== 0), "blank 出现在候选里了");
});

await test("按峰值排序，跨帧取最大", () => {
  const p = fakeProbs(3, 10, {
    0: [[5, 0.3]],
    1: [[7, 0.8]],
    2: [[5, 0.6], [9, 0.2]],
  });
  const out = ctcCandidates(p, 3, 10, { limit: 3 });
  assert.deepStrictEqual(out.map((x) => x.index), [7, 5, 9], JSON.stringify(out));
});

await test("白名单外的一律不出现", () => {
  const p = fakeProbs(2, 10, { 0: [[4, 0.9], [6, 0.8]] });
  const out = ctcCandidates(p, 2, 10, { limit: 5, allowed: new Set([6]) });
  assert.deepStrictEqual(out.map((x) => x.index), [6]);
});

await test("limit 生效", () => {
  const place = { 0: [] };
  for (let c = 1; c < 10; c += 1) place[0].push([c, 0.1 * c]);
  const p = fakeProbs(1, 10, place);
  const out = ctcCandidates(p, 1, 10, { limit: 4 });
  assert.strictEqual(out.length, 4);
});

/* ---------------- ⑤ 字典索引 ---------------- */

console.log("\n字典索引\n");

const dictText = "一\n二\n三\n四";
const vocab = buildVocabulary(dictText, null);

await test("blank 占索引 0，字典第一行是索引 1", () => {
  assert.strictEqual(vocab.chars[0], "", "索引 0 必须是 blank");
  assert.strictEqual(vocab.chars[1], "一", "字典第一行应当是索引 1");
  assert.strictEqual(vocab.chars[4], "四");
});

await test("末尾补的空格在最后一格（CTC 里要有它）", () => {
  assert.strictEqual(vocab.chars[vocab.chars.length - 1], " ");
});

await test("白名单按字符过滤，不是按位置", () => {
  const v = buildVocabulary(dictText, new Set(["二", "四"]));
  assert.deepStrictEqual([...v.allowed].sort((a, b) => a - b), [2, 4]);
});

await test("空字典只剩 blank 和空格，不会崩", () => {
  const v = buildVocabulary("", null);
  assert.strictEqual(v.chars[0], "");
  assert.strictEqual(v.allowed.size, 0);
});

await test("真实字典：常用字都在，索引对得上", () => {
  const text = fs.readFileSync(path.join(ROOT, "ime", "model", "ppocrv5-dict.txt"), "utf8");
  const v = buildVocabulary(text, null);
  assert.ok(v.chars.length > 18000, `字典太小：${v.chars.length}`);
  const i = v.chars.indexOf("中");
  assert.ok(i > 0, "「中」应当能在字典里找到");
  assert.strictEqual(v.chars[i], "中", "索引反查必须回到同一个字");
});

/* ---------------- 收尾 ---------------- */

console.log(`\n${passed} 通过 / ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
