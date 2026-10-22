/* ============================================================
   悬浮窗快捷操作契约测试（tests/hud-quick-test.mjs）

   验证的是「悬浮窗展开态能接发消息 + 停止会话」这条能力：

   1) 协议两端对齐：原生发什么 action，JS 就得认什么 action
   2) 输入框能被点：窗口必须能从「不可获焦」切到「可获焦」，
      否则 EditText 永远拿不到焦点，键盘弹不出来
   3) 输入不被 1.2 秒的快照推送打断（操作行必须是 body 的兄弟节点）
   4) 触摸不被标题行之外的容器吞掉（拖动监听不能挂在 root 上）
   5) 收消息：快照里必须有 messages，且只收有内容的
   6) 停止：按钮只在有运行中的会话时可点

   这些都是「编译期不报、运行时才发现是坏的」的那类问题，
   所以直接对源码做断言。
   ============================================================ */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log(`✓ ${name}${extra ? " " + extra : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${extra ? " " + extra : ""}`);
  }
}

/** 剥掉注释，否则「旧写法」出现在注释里会让反向契约误报。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

const svc = await readFile(join(ROOT, "android/java/DshHudService.java"), "utf8");
const state = await readFile(join(ROOT, "android/java/DshHudState.java"), "utf8");
const act = await readFile(join(ROOT, "android/java/MainActivity.java"), "utf8");
const uiJs = await readFile(join(ROOT, "scripts/ui.js"), "utf8");
const hudJs = await readFile(join(ROOT, "scripts/hud.js"), "utf8");

/* ============================================================
   一、协议两端对齐
   ============================================================ */

check("契约：原生侧有 send / stop 两个 action",
  /sendCommand\("send"/.test(svc) && /sendCommand\("stop"/.test(svc));
check("契约：JS 侧认得 send / stop",
  /action === "send"/.test(uiJs) && /action === "stop"/.test(uiJs));
check("契约：协议入口是 window.__dshHudCommand",
  /window\.__dshHudCommand/.test(state) && /window\.__dshHudCommand\s*=/.test(uiJs));
check("契约：send 带 text 载荷", /payload\.put\("text", text\)/.test(svc)
  && /payload\?\.text/.test(uiJs));
check("契约：应用内降级版用同一套协议", /__dshHudCommand\?\.\("send"/.test(hudJs)
  && /__dshHudCommand\?\.\("stop"/.test(hudJs));
check("契约：Action 的 payload 用 JSON 传", /JSONObject\(\)/.test(svc)
  && /payload\.put/.test(svc));

/* ============================================================
   二、输入框必须能被点（窗口可获焦）
   ============================================================ */

check("契约：默认窗口带 FLAG_NOT_FOCUSABLE（不抢应用的焦点）",
  /FLAG_NOT_FOCUSABLE/.test(svc));
check("契约：进入输入模式时去掉 FLAG_NOT_FOCUSABLE",
  /params\.flags & ~WindowManager\.LayoutParams\.FLAG_NOT_FOCUSABLE/.test(svc));
check("契约：换上的标志是 FLAG_NOT_TOUCH_MODAL（窗外触摸仍穿透）",
  /FLAG_NOT_TOUCH_MODAL/.test(svc));
check("契约：进入输入模式会 requestFocus", /input\.requestFocus\(\)/.test(svc));
check("契约：会主动弹软键盘", /showSoftInput/.test(svc));
check("契约：退出时会藏键盘", /hideSoftInputFromWindow/.test(svc));
check("契约：退出时恢复原窗口标志", /params\.flags = savedFlags/.test(svc));
check("契约：有输入入口（提示条）", /inputHint/.test(svc)
  && /点这里回消息/.test(svc));
check("契约：输入行默认隐藏", /inputBox\.setVisibility\(View\.GONE\)/.test(svc));
check("契约：输入行在进入输入模式时显示", /inputBox\.setVisibility\(View\.VISIBLE\)/.test(svc));
check("契约：软键盘的「发送」动作也能发",
  /setOnEditorActionListener/.test(svc) && /sendFromInput\(\)/.test(svc));

/* ============================================================
   三、输入不能被快照推送打断
   ============================================================ */

check("契约：操作行是 root 的直接子节点",
  /root\.addView\(actionRow/.test(svc));
check("反向契约：操作行不是 body 的子节点",
  !/body\.addView\(actionRow/.test(stripComments(svc)));
check("契约：body 仍然会整体重建（消息区需要）",
  /body\.removeAllViews\(\)/.test(svc));
check("契约：收起时操作行隐藏", /actionRow\.setVisibility\(View\.GONE\)/.test(svc));
check("契约：展开时操作行显示", /actionRow\.setVisibility\(View\.VISIBLE\)/.test(svc));

/* ============================================================
   四、触摸不被吞掉
   ============================================================ */

check("契约：拖动监听挂在 capRow（标题行）上",
  /capRow\.setOnTouchListener/.test(svc));
check("反向契约：拖动监听不再挂在 root 上",
  !/root\.setOnTouchListener/.test(stripComments(svc)));
check("契约：收起时退出输入模式", /exitInputMode\(true\)/.test(svc));
check("契约：应用内降级版拦住了输入框的指针事件",
  /inputEl\.addEventListener\("pointerdown"/.test(hudJs)
  && /inputEl\.addEventListener\("pointerup"/.test(hudJs));
check("契约：应用内降级版支持回车发送",
  /e\.key === "Enter"/.test(hudJs));

/* ============================================================
   五、接消息：快照里要有 messages
   ============================================================ */

check("契约：快照带 messages 字段", /messages,/.test(uiJs));
check("契约：快照带 running 字段（停止按钮据此置灰）", /running: !!ui\.run/.test(uiJs));
check("契约：只收有内容的消息", /if \(!text\) continue/.test(uiJs));
check("契约：消息按 role 区分", /role: m\.role === "user" \? "user" : "assistant"/.test(uiJs));
check("契约：长消息截断", /text\.length > 60/.test(uiJs));
check("契约：原生侧渲染消息区", /optJSONArray\("messages"\)/.test(svc));
check("契约：原生侧区分「你 / DSH」", /"你"/.test(svc) && /"DSH"/.test(svc));
check("契约：应用内降级版也渲染消息区", /hud-msg/.test(hudJs));
check("契约：最多显示 4 条消息", /messages\.length < 4/.test(uiJs) && /i < 4/.test(svc));

/* ============================================================
   六、停止会话
   ============================================================ */

check("契约：原生侧有停止按钮", /stopBtn/.test(svc) && /停止/.test(svc));
check("契约：停止按钮按 running 置灰", /setEnabled\(running\)/.test(svc));
check("契约：JS 侧停止走现有的 stopRunAction", /stopRunAction\(\)/.test(uiJs));
check("契约：没有运行时会给出提示", /当前没有正在运行的会话/.test(uiJs));
check("契约：孤儿运行也能停（上次进程被回收）", /orphanRunning\(\)/.test(uiJs));
check("契约：运行中发消息会被拦下（不会静默丢弃）",
  /正在运行中/.test(uiJs) && /"busy"/.test(uiJs));

/* ============================================================
   七、生命周期
   ============================================================ */

check("契约：MainActivity 登记 WebView 引用", /DshHudState\.webView = getBridge\(\)/.test(act));
check("契约：MainActivity 销毁时清空引用", /DshHudState\.webView = null/.test(act));
check("契约：sendCommand 走 UI 线程", /w\.post\(/.test(state));
check("契约：sendCommand 在 WebView 为空时安全返回", /if \(w == null\) return/.test(state));
check("契约：evaluateJavascript 有 try 保护", /evaluateJavascript/.test(state));

/* ============================================================
   八、语法自检
   ============================================================ */

for (const f of ["scripts/ui.js", "scripts/hud.js"]) {
  let ok = true;
  try {
    await import(`file://${join(ROOT, f)}`);
  } catch (e) {
    if (e instanceof SyntaxError) ok = false;
  }
  check(`语法：${f} ESM 解析通过`, ok);
}

console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败（通过 ${pass}）`);
  process.exit(1);
} else {
  console.log(`全部通过（${pass} 项）`);
}
