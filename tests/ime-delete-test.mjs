/* ============================================================
   退格（DSH 键盘 → 应用输入框）回归测试

   ============ 这个测试在防什么 ============

   用户反馈：「一但字打到应用上，回退键就不起作用了」。

   缓冲里还有拼音时，退格删的是键盘自己的 buffer —— 看着一切正常。
   一旦字上屏（commit 到应用），退格就要走原生的
   deleteSurroundingText 了，于是失灵。

   根因：deleteSurroundingText / deleteSurroundingTextInCodePoints
   的返回值只表示"请求我接了"，**不表示字真的没了**。
   WebView、Flutter、部分自绘输入框都会返回 true 却什么都不做。
   原来的实现只看返回值 → 永远不去试删除键 → 按下去毫无反应。

   行为层面由 tests/java/DeleteTest.java 真跑（假输入框模拟各种失败）。
   这里锁住 Android 侧的接线，防止被改回去。

   用法：node tests/ime-delete-test.mjs
   ============================================================ */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url).pathname;

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.log(`  ✗ ${name}\n    ${err?.message || err}`);
  }
}

const bridge = await readFile(`${ROOT}android/java/DshImeBridge.java`, "utf8");
const del = await readFile(`${ROOT}android/java/DshDelete.java`, "utf8");
const build = await readFile(`${ROOT}android/build-apk.sh`, "utf8");
const state = await readFile(`${ROOT}ime/core/state.js`, "utf8");
const main = await readFile(`${ROOT}ime/main.js`, "utf8");

console.log("\nJS 侧（缓冲为空才走原生）\n");

await test("有拼音时退格只删 buffer，不动应用里的字", () => {
  const seg = state.slice(state.indexOf('case "backspace"'), state.indexOf('case "space"'));
  assert.match(seg, /if \(state\.buffer\)/, "应先判断缓冲");
  assert.match(seg, /slice\(0, -1\)/, "应只截掉缓冲最后一个字母");
});

await test("缓冲为空时发出 delete effect", () => {
  const seg = state.slice(state.indexOf('case "backspace"'), state.indexOf('case "space"'));
  assert.match(seg, /type:\s*"delete"/);
});

await test("delete effect 会调到桥的 deleteBackward", () => {
  assert.match(main, /case "delete":\s*\n\s*b\?\.deleteBackward\(/);
});

console.log("\n原生侧（不能再只看返回值）\n");

await test("deleteBackward 交给 DshDelete 决策", () => {
  assert.match(bridge, /deleter\.delete\(n\)/, "应调用决策状态机");
});

await test("不再有\"只看返回值就收工\"的写法", () => {
  // 老写法：boolean ok = c.deleteSurroundingTextInCodePoints(...); if (!ok) ...
  assert.ok(
    !/boolean\s+ok\s*=\s*(false|true)\s*;/.test(bridge),
    "又回到只看返回值的写法了 —— 静默失败的输入框会再次退格失灵"
  );
});

await test("有选区时删选区本身", () => {
  assert.match(bridge, /getSelectedText\(0\)/);
  assert.match(bridge, /commitText\("", 1\)/);
});

await test("deleteSurroundingText 包在 batchEdit 里（WebView 需要）", () => {
  assert.match(bridge, /beginBatchEdit\(\)/);
  assert.match(bridge, /endBatchEdit\(\)/);
});

await test("仍然优先用码点版本（emoji 不被劈两半）", () => {
  assert.match(bridge, /deleteSurroundingTextInCodePoints/);
});

await test("删除键兜底发的是 KEYCODE_DEL 的按下+抬起", () => {
  assert.match(bridge, /KeyEvent\.KEYCODE_DEL/);
  assert.match(bridge, /KeyEvent\.ACTION_DOWN/);
  assert.match(bridge, /KeyEvent\.ACTION_UP/);
});

await test("composing 兜底用绝对下标（ExtractedText.selectionEnd）", () => {
  assert.match(bridge, /getExtractedText\(new ExtractedTextRequest\(\), 0\)/);
  assert.match(bridge, /setComposingRegion\(start, end\)/);
});

console.log("\n决策状态机\n");

await test("校验靠回读比对，不靠返回值", () => {
  assert.match(del, /getTextBeforeCursor|before\(/, "应回读");
  assert.match(del, /equals\(snapshot\.toString\(\)\)/, "应比对内容");
});

await test("校验是延迟的（避免异步输入框被误判成失败）", () => {
  assert.match(del, /VERIFY_MS/);
  assert.match(del, /clock\.after\(/);
});

await test("连按并进同一条链（不会删过头）", () => {
  assert.match(del, /if \(running\) return;/);
  assert.match(del, /count \+= want;/);
});

await test("光标在最前面时什么都不做（避免误触返回）", () => {
  assert.match(del, /before\.length\(\) == 0\) return;/);
});

await test("DshDelete 被编进 APK", () => {
  assert.match(build, /DshImeActivity DshCaptureService DshDelete MainActivity/);
});

console.log("\nAI 改写（同一条删除路径）\n");

await test("改写用\"选中区间 + 提交\"一步覆盖，不再先删后写", () => {
  assert.match(bridge, /private boolean selectBefore\(/);
  assert.match(bridge, /c\.setSelection\(start, end\)/);
});

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
