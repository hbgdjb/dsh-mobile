/* ============================================================
   DSH 键盘（IME）白边回归测试

   ============ 这个测试在防什么 ============

   用户反馈：「DSH 键盘选中后无法启动，唤起后只在屏幕底部出现一条白边」。

   根因（AOSP InputMethodService.setInputView 源码确认）：

       mInputFrame.addView(view, new FrameLayout.LayoutParams(
               MATCH_PARENT, WRAP_CONTENT));

   框架用**它自己的** LayoutParams 覆盖了我们返回的 View 的布局参数。
   所以"给 WebView 设固定高度的 LayoutParams"这种常规做法在这里无效 ——
   WebView 没有内在高度，在 WRAP_CONTENT 的父容器里测出来是 0，
   键盘就塌成屏幕底部一条缝，缝里露的是 IME 窗口的白背景。

   这个测试锁住三件事，任何一条被改回去，白边就会复发：
     1. 视图容器覆写了 onMeasure 并硬写固定高度（不能靠 LayoutParams）
     2. IME Service 有独立主题，窗口背景是透明的（不继承浅色应用主题）
     3. manifest 里给 IME Service 声明了那个主题

   用法：node tests/ime-layout-test.mjs
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

const service = await readFile(`${ROOT}android/java/DshImeService.java`, "utf8");
const styles = await readFile(`${ROOT}android/res/values/styles.xml`, "utf8");
const build = await readFile(`${ROOT}android/build-apk.sh`, "utf8");

console.log("\n高度测量\n");

await test("视图容器覆写 onMeasure（框架会覆盖 LayoutParams，只能靠它）", () => {
  assert.ok(
    service.includes("protected void onMeasure("),
    "没找到 onMeasure 覆写 —— 框架覆盖 LayoutParams 后高度会塌成 0"
  );
});

await test("onMeasure 里用 setMeasuredDimension 写死高度", () => {
  assert.ok(
    service.includes("setMeasuredDimension("),
    "onMeasure 没有用 setMeasuredDimension 固定高度"
  );
});

await test("容器高度来自 KEYBOARD_DP，不是硬编码像素", () => {
  assert.ok(service.includes("KEYBOARD_DP"), "找不到 KEYBOARD_DP 常量");
  assert.ok(
    /KEYBOARD_DP\s*\*\s*dm\.density/.test(service),
    "高度没有按 density 换算，横竖屏/不同 dpi 会错"
  );
});

await test("onCreateInputView 返回的是容器而不是裸 WebView", () => {
  // 返回语句必须是容器（box），不能是裸 WebView
  const fn = service.match(/public View onCreateInputView\(\)\s*\{[\s\S]*?\n    \}/);
  assert.ok(fn, "找不到 onCreateInputView 方法");
  const body = fn[0];
  assert.ok(
    /return\s+box\s*;/.test(body),
    "onCreateInputView 没有返回容器视图（box）"
  );
  assert.ok(
    /container\s*=\s*box\s*;/.test(body),
    "容器没有被保存到字段 —— 第二次调用会重建 WebView"
  );
});

await test("WebView 填满容器（MATCH_PARENT）", () => {
  assert.ok(
    service.includes("ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT"),
    "WebView 没有按 MATCH_PARENT 填满容器"
  );
});

console.log("\n窗口与背景\n");

await test("IME 使用独立主题，不继承浅色应用主题", () => {
  assert.ok(styles.includes("DshImeTheme"), "styles.xml 里没有 DshImeTheme");
});

await test("主题窗口背景透明（白边的直接来源）", () => {
  const m = styles.match(/<style name="DshImeTheme"[\s\S]*?<\/style>/);
  assert.ok(m, "找不到 DshImeTheme 定义");
  assert.ok(
    m[0].includes("android:windowBackground") &&
      m[0].includes("transparent"),
    "DshImeTheme 的 windowBackground 不是透明"
  );
});

await test("manifest 注入里给 IME Service 声明了主题", () => {
  const idx = build.indexOf(".DshImeService");
  assert.ok(idx > 0, "build-apk.sh 里没有注入 DshImeService");
  const block = build.slice(idx, idx + 400);
  assert.ok(
    block.includes('android:theme="@style/DshImeTheme"'),
    "IME Service 没有声明 android:theme —— 会继承浅色应用主题，白边必然出现"
  );
});

await test("窗口高度是 WRAP_CONTENT（不能 MATCH_PARENT，那是全屏）", () => {
  assert.ok(
    service.includes("WindowManager.LayoutParams.WRAP_CONTENT"),
    "窗口没有设 WRAP_CONTENT"
  );
});

await test("窗口与 decorView 背景被清成透明", () => {
  assert.ok(
    service.includes("setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT))"),
    "窗口背景没有清成透明"
  );
  assert.ok(
    service.includes("decor.setBackgroundDrawable(null)"),
    "decorView 背景没有清掉"
  );
});

await test("inputArea 容器背景也被清掉", () => {
  assert.ok(
    service.includes("android.R.id.inputArea"),
    "没有处理 inputArea 容器"
  );
});

await test("getWindow() 是 Dialog，必须再取一层 .getWindow()", () => {
  // getWindow() 返回 SoftInputWindow（Dialog），没有 getAttributes()
  assert.ok(
    service.includes("getWindow().getWindow()"),
    "没有用 getWindow().getWindow() 取真正的 Window —— 编译不过"
  );
});

console.log("\n失败兜底\n");

await test("主框架加载失败有可见提示（不再只留白边）", () => {
  assert.ok(
    service.includes("onReceivedError"),
    "没有处理 WebView 加载失败"
  );
  assert.ok(
    service.includes("showError("),
    "没有加载失败提示"
  );
});

await test("启动超时有兜底提示", () => {
  assert.ok(
    service.includes("键盘启动超时"),
    "没有启动超时兜底"
  );
});

console.log(`\n${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
