/* ============================================================
   后台挂起检测（0.34.3）
   现象：控屏指令偶尔「卡死」几十秒，切回 DSH 立刻恢复。
   根因：Android 把后台 WebView 进程挂起了。
   本测试验证：能测出来、能告诉模型、正常调用一个字不多说。
   ============================================================ */

import { suspendNote } from "../scripts/runtime.js";

let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`✓ ${name}${detail ? ` ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${detail ? ` ${detail}` : ""}`);
  }
}

/* ============================================================
   一、阈值：正常调用不能被误判
   ============================================================ */

check("正常：200ms 的点击不提示", suspendNote(200) === "");
check("正常：1.5 秒的 ui_dump 不提示", suspendNote(1500) === "");
check("正常：5 秒的慢 dump 不提示", suspendNote(5000) === "");
check("边界：9.9 秒仍不提示", suspendNote(9900) === "");
check("边界：刚好 10 秒开始提示", suspendNote(10000) !== "");
check("异常：45 秒提示", suspendNote(45000) !== "");

/* ============================================================
   二、提示内容
   ============================================================ */

const note = suspendNote(45000);
check("提示：指出实际耗时", note.includes("45.0 秒"), note.slice(0, 40));
check("提示：说明是系统挂起", note.includes("被系统挂起"));
check("提示：指出屏幕可能已变", note.includes("屏幕内容可能已经变化"));
check("提示：给出动作（先 ui_dump）", note.includes("ui_dump") && note.includes("确认当前界面"));
check("提示：明确禁止沿用旧坐标/ref", note.includes("不要沿用挂起前的坐标或 ref"));

// 时长格式化：不能出现 45.0 秒 之外的怪值
check("提示：60 秒写法正确", suspendNote(60000).includes("60.0 秒"));
check("提示：12.3 秒写法正确", suspendNote(12300).includes("12.3 秒"));

/* ============================================================
   三、异常输入不能炸
   ============================================================ */

check("容错：undefined", suspendNote(undefined) === "");
check("容错：null", suspendNote(null) === "");
check("容错：字符串数字", suspendNote("20000") !== "");
check("容错：负数", suspendNote(-100) === "");
check("容错：NaN", suspendNote(NaN) === "");

/* ============================================================
   四、源码契约
   ============================================================ */

const fs = await import("node:fs/promises");
const rt = await fs.readFile(new URL("../scripts/runtime.js", import.meta.url), "utf8");
const ui = await fs.readFile(new URL("../scripts/ui.js", import.meta.url), "utf8");

check("契约：阈值 10 秒", /const SUSPEND_MS = 10000;/.test(rt));
check("契约：成功调用也会带挂起提示", /if \(suspendNoteText\) withHint =/.test(rt));
check("契约：失败时两条提示都保留", /suspendNoteText \? `\$\{withHint\}/.test(rt));
check("契约：工具上打挂起标记", /if \(suspend\) tool\.suspended = true;/.test(rt));
check("契约：UI 显示「含挂起」", /含挂起/.test(ui));
check("契约：UI 有解释文案", /被系统挂起在后台/.test(ui));
// 不能变成"只要慢就报错" —— 挂起不是失败，不能改 status
check("契约：挂起不改变成功状态", !/tool\.status = .*suspended/.test(rt));
// 只对 MCP 工具判断：读大文件慢 10 秒是正常的，不能误标成「系统挂起」
check("契约：只对 MCP 工具判定挂起", /isMcpTool\(tool\.name\) \? suspendNote/.test(rt));
check("契约：工具消息侧同样限定", /isMcpTool\(call\.name\) \? suspendNote/.test(rt));

console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败（通过 ${pass}）`);
  process.exit(1);
} else {
  console.log(`全部通过（${pass} 项）`);
}
