/* ============================================================
   DSH 键盘截图链路回归测试

   ============ 这个测试在防什么 ============

   用户反馈：「截图无法正常运行」。

   原来的实现有四个断点，任意一个都会让截图拿不到：

     ① 中转 Activity 是手工 new 出来的「野生实例」
        —— startActivityForResult 依赖真实的 Activity token 与
           result 回调通道，野生实例根本收不到 onActivityResult。
        必须用 Context.startActivity 让系统真正创建它。

     ② manifest 里 android:noHistory="true"
        —— 授权对话框弹出时中转 Activity 被销毁，回调直接丢失。

     ③ 截图记录里的 path 是绝对路径
        —— 而主应用 DshFsBridge.resolve(area, path) 把 path 当
           「区域区内相对路径」处理，绝对路径必然越界 / 找不到。

     ④ setTheme() 写在 super.onCreate() 之后
        —— 主题生效太晚，授权页会闪一帧白底。

   这个测试把这四点连同「投递链路完整」一起锁死。

   用法：node tests/ime-capture-test.mjs
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

const act = await readFile(`${ROOT}android/java/DshImeActivity.java`, "utf8");
const svc = await readFile(`${ROOT}android/java/DshCaptureService.java`, "utf8");
const bridge = await readFile(`${ROOT}android/java/DshImeBridge.java`, "utf8");
const imeSvc = await readFile(`${ROOT}android/java/DshImeService.java`, "utf8");
const state = await readFile(`${ROOT}android/java/DshImeState.java`, "utf8");
const fs = await readFile(`${ROOT}android/java/DshFsBridge.java`, "utf8");
const build = await readFile(`${ROOT}android/build-apk.sh`, "utf8");
const imeJs = await readFile(`${ROOT}scripts/ime.js`, "utf8");

console.log("\n中转 Activity 生命周期\n");

await test("不再手工 new DshImeActivity", () => {
  // 注释里会提到这个反例，只看真正的代码行
  const code = act
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
  assert.ok(
    !/new\s+DshImeActivity\s*\(/.test(code),
    "仍存在手工 new 的野生 Activity —— startActivityForResult 收不到结果"
  );
});

await test("用 Context.startActivity 真正启动中转 Activity", () => {
  assert.match(act, /ctx\.startActivity\s*\(/, "应通过 ctx.startActivity 启动");
  assert.match(act, /new Intent\(ctx,\s*DshImeActivity\.class\)/, "应显式指定目标 Activity");
  assert.match(act, /FLAG_ACTIVITY_NEW_TASK/, "来自 IME Service 的 Context 需要 NEW_TASK");
});

await test("Activity 自己在 onCreate 里发起授权（startActivityForResult）", () => {
  // 授权发起必须发生在 Activity 内部，而不是在静态方法里对野生实例调用
  const createIdx = act.indexOf("protected void onCreate");
  const after = act.slice(createIdx, createIdx + 4000);
  assert.match(after, /startActivityForResult\s*\(/, "onCreate 内应调用 startActivityForResult");
});

await test("onActivityResult 里真正启动截图服务", () => {
  assert.match(act, /DshCaptureService\.start\s*\(/, "应启动 DshCaptureService");
  assert.match(act, /resultCode == RESULT_OK/, "应判断 RESULT_OK");
});

await test("setTheme 在 super.onCreate 之前（避免闪白底）", () => {
  const ti = act.indexOf("setTheme(");
  const si = act.indexOf("super.onCreate(");
  assert.ok(ti > 0 && si > 0, "应同时存在 setTheme 与 super.onCreate");
  assert.ok(ti < si, "setTheme 必须写在 super.onCreate 之前");
});

await test("不再用静态字段保存待回调实例", () => {
  assert.ok(
    !/awaitingCapture|awaitingMic/.test(act),
    "静态 awaiting 引用已无必要且容易漏回收"
  );
});

console.log("\nmanifest\n");

await test("DshImeActivity 不再声明 noHistory", () => {
  const idx = build.indexOf(".DshImeActivity");
  assert.ok(idx > 0, "manifest 注入里应有 DshImeActivity");
  const seg = build.slice(idx, idx + 400);
  assert.ok(
    !seg.includes("noHistory"),
    "noHistory 会让授权对话框弹出时中转 Activity 被销毁，回调丢失"
  );
});

await test("DshImeActivity 仍是 exported=false + excludeFromRecents", () => {
  const idx = build.indexOf(".DshImeActivity");
  const seg = build.slice(idx, idx + 400);
  assert.match(seg, /android:exported="false"/);
  assert.match(seg, /android:excludeFromRecents="true"/);
});

await test("截图前台服务声明 mediaProjection 类型 + 权限", () => {
  assert.match(build, /android:foregroundServiceType="mediaProjection"/);
  assert.match(build, /FOREGROUND_SERVICE_MEDIA_PROJECTION/);
});

console.log("\n落盘与投递\n");

await test("截图记录的 path 是 workspace 区内相对路径", () => {
  assert.ok(
    /rec\.put\("path",\s*"uploads\/"\s*\+\s*out\.getName\(\)\)/.test(svc),
    "path 必须是 uploads/<name> 这种区域相对路径"
  );
  assert.ok(
    !/rec\.put\("path",\s*out\.getAbsolutePath\(\)\)/.test(svc),
    "绝对路径会被 DshFsBridge 判为越界"
  );
});

await test("同时保留绝对路径备用字段", () => {
  assert.match(svc, /rec\.put\("absPath",\s*out\.getAbsolutePath\(\)\)/);
});

await test("落盘目录与 DshFsBridge 的 workspace 区一致", () => {
  assert.match(svc, /new File\(new File\(root,\s*"workspace"\),\s*"uploads"\)/);
  assert.match(fs, /name = "workspace"/, "DshFsBridge 的默认区应是 workspace");
});

await test("DshFsBridge 把 path 当区域相对路径解析", () => {
  assert.ok(fs.includes('replaceAll("^/+", "")'), "应剥掉前导斜杠当相对路径");});

await test("截图会投递回主应用（直投或入队）", () => {
  assert.match(svc, /DshImeState\.toMain\(/);
  assert.match(svc, /DshImeState\.queueShot\(/);
  assert.match(state, /drainShots/);
});

await test("主应用侧能接住截图并加为附件", () => {
  assert.match(imeJs, /receiveImeShot/);
  assert.match(imeJs, /area:\s*"workspace"/);
});

console.log("\n触发链路\n");

await test("IME 桥把截图请求转给 Service", () => {
  assert.match(bridge, /captureScreen\s*\(\)/);
  assert.match(bridge, /service\.startCapture\(\)/);
});

await test("Service 隐藏键盘后再发起授权（授权框不被自己截到）", () => {
  assert.match(imeSvc, /requestHideSelf/);
  assert.match(imeSvc, /DshImeActivity\.startCapture\(this\)/);
});

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
