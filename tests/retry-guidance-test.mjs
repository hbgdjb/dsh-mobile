/* ============================================================
   工具失败后的重试引导（0.34.2）
   解决：控屏命令失败后，模型把「工具报错」读成「任务失败」，
        直接向用户复述错误、结束这一轮，完全不再尝试。
   ============================================================ */

import { failureNote, failureIsRecoverable } from "../scripts/runtime.js";
import { BEHAVIOR_RULES } from "../scripts/prompt.js";

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
   一、哪些失败算「中间状态」
   ============================================================ */

check("可恢复：普通执行失败", failureIsRecoverable("error") === true);
check("可恢复：状态为 undefined 也算失败", failureIsRecoverable(undefined) === true);
check("不可恢复：权限拒绝", failureIsRecoverable("denied") === false);
check("不可恢复：需用户处理", failureIsRecoverable("needs_user") === false);

/* ============================================================
   二、提示内容
   ============================================================ */

const first = failureNote("error", 1);
check("首次失败：给出「中间状态」定性", first.includes("中间状态"), first.slice(0, 30));
check("首次失败：明确说不是任务结论", first.includes("不是任务结论"));
check("首次失败：给出重试动作", first.includes("换参数或换方法再试"));
check("首次失败：给出次数上限", first.includes("超过 2 次"));

const second = failureNote("error", 2);
check("第二次失败：仍是同一段引导", second === first);

const third = failureNote("error", 3);
check("第三次失败：改为劝阻重复", third.includes("已经原样失败 3 次"), third.slice(0, 30));
check("第三次失败：给出替代路径", third.includes("换成不同的参数") && third.includes("重新读"));
check("第三次失败：不再说「再试一次」", !third.includes("换参数或换方法再试"));

const fifth = failureNote("error", 5);
check("第五次失败：次数正确反映", fifth.includes("已经原样失败 5 次"));

/* ============================================================
   三、终局失败不该被鼓励重试
   ============================================================ */

check("权限拒绝：不追加任何引导", failureNote("denied", 1) === "");
check("需用户处理：不追加任何引导", failureNote("needs_user", 1) === "");
check("权限拒绝：累计多次也不追加", failureNote("denied", 9) === "");

/* ============================================================
   四、提示词第 4 条
   ============================================================ */

const rule4 = BEHAVIOR_RULES.find((r) => r.startsWith("4."));
check("提示词：第 4 条存在", !!rule4, rule4);
check("提示词：明确「中间状态」", /中间状态/.test(rule4 || ""));
check("提示词：明确「不是结论」", /不是结论/.test(rule4 || ""));
check("提示词：给出次数上限", /不超过 2 次/.test(rule4 || ""));
// 旧措辞「先说原因再换路径重试」有歧义（可以把「重试」读成「然后再说」），不能回来
check("提示词：旧措辞已移除", !/先说原因再换路径重试/.test(rule4 || ""));

/* ============================================================
   五、源码契约
   ============================================================ */

const fs = await import("node:fs/promises");
const rt = await fs.readFile(new URL("../scripts/runtime.js", import.meta.url), "utf8");

check("契约：失败提示接进了 tool message", /failureNote\(res\.status, times\)/.test(rt));
check("契约：按「工具名+参数」识别原样重复", /sameCallFailures\.get\(sig\)/.test(rt));
check("契约：成功后清零计数", /sameCallFailures\.delete\(/.test(rt));
check("契约：提示只进 convo 不进 UI", /let withHint = body;/.test(rt) && !/msg\.content \+= .*TOOL_FAILURE_HINT/.test(rt));
check("契约：提示经过 sanitizeUntrusted", /sanitizeUntrusted\(withHint\)/.test(rt));

console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败（通过 ${pass}）`);
  process.exit(1);
} else {
  console.log(`全部通过（${pass} 项）`);
}
