#!/usr/bin/env node
/* ============================================================
   工具参数解析：把"差一点就合法"的 JSON 救回来

   起点是截图里那张卡片：

     shell 参数解析失败
     工具参数不是合法 JSON：Unexpected non-whitespace character
     after JSON at position 83 (line 1 column 84)

   `after JSON` 说明**对象本身是完整的**，只是后面多了东西。
   模型输出两个对象、或者对象后面跟一句解释、或者套了 ```json 围栏，
   都会长这样。这些都不该让整次调用失败 —— 内容都在，只是多了外壳。

   这里逐条验证：能无损修的修好，猜不出来的如实失败，
   绝不用一个被猜歪的参数去执行写文件。
   ============================================================ */

import { parseToolArgs, argsErrorText } from "../scripts/toolargs.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}${extra ? " " + extra : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${extra ? " " + extra : ""}`);
  }
}

const ok = (raw) => {
  const r = parseToolArgs(raw);
  return r.ok ? r : { ok: false, error: r.error, raw };
};

/* ---------------- 一、正常路径 ---------------- */
console.log("\n正常\n");

check("普通对象", ok('{"command":"ls -la"}').value.command === "ls -la");
check("空串当空对象", parseToolArgs("").ok && Object.keys(parseToolArgs("").value).length === 0);
check("null 当空对象", parseToolArgs(null).ok);
check("数组也接受", ok('[1,2,3]').value.length === 3);
check("正常输入不标记修复", !parseToolArgs('{"a":1}').repaired);

const zh = ok('{"command":"echo 中文 空格","path":"技能/说明.md"}');
check("中文原样保留", zh.value.command === "echo 中文 空格" && zh.value.path === "技能/说明.md", JSON.stringify(zh.value));

/* ---------------- 二、截图那条：对象后面还有东西 ---------------- */
console.log("\n多余字符\n");

const two = ok('{"command":"ls -la"}{"command":"pwd"}');
check("两个对象粘在一起 → 取第一个", two.value.command === "ls -la", JSON.stringify(two.value));
check("并标记为修复过", two.repaired === "截取第一个完整对象", two.repaired);
check("知道后面还有内容", two.extra === true);

const tail = ok('{"command":"pwd"} 以上是参数');
check("对象后跟一句解释 → 取对象", tail.value.command === "pwd", JSON.stringify(tail.value));

const nl = ok('{"command":"cd /workspace"}\n\n好的，我来看看。');
check("对象后跟自然语言 → 取对象", nl.value.command === "cd /workspace");

const arr = ok('[{"a":1}] 后面还有字');
check("数组后面跟字也能取出来", Array.isArray(arr.value) && arr.value[0].a === 1);

/* ---------------- 三、代码围栏 ---------------- */
console.log("\n代码围栏\n");

const fence = ok('```json\n{"command":"pwd"}\n```');
check("```json 围栏", fence.value.command === "pwd", JSON.stringify(fence.value));
check("标记为去掉围栏", fence.repaired === "去掉代码围栏", fence.repaired);

const fence2 = ok('```\n{"command":"pwd"}\n```');
check("无语言标记的围栏", fence2.value.command === "pwd");

/* ---------------- 四、字符串里的裸换行 ---------------- */
console.log("\n裸控制字符\n");

const multi = ok('{"command":"echo A\necho B"}');
check("多行命令里的真实换行被转义", multi.value.command === "echo A\necho B", JSON.stringify(multi.value.command));
check("标记为转义换行", multi.repaired === "转义字符串里的换行", multi.repaired);

const tab = ok('{"command":"echo\tA"}');
check("制表符也能修", tab.value.command === "echo\tA");

const already = ok('{"command":"echo A\\necho B"}');
check("已经转义过的不重复转义", already.value.command === "echo A\necho B", JSON.stringify(already.value.command));

/* ---------------- 五、尾逗号 ---------------- */
console.log("\n尾逗号\n");

const comma = ok('{"command":"pwd",}');
check("对象尾逗号", comma.value.command === "pwd", JSON.stringify(comma.value));
check("标记为去掉逗号", comma.repaired === "去掉多余的逗号", comma.repaired);

const comma2 = ok('{"a":[1,2,],"b":2,}');
check("数组与对象尾逗号一起去", comma2.value.a.length === 2 && comma2.value.b === 2);

/* ---------------- 六、不能误伤字符串内容 ---------------- */
console.log("\n不误伤\n");

const braces = ok('{"command":"echo \\"{\\" \\"}\\"","note":"a,b"}');
check("字符串里的花括号不影响配平", braces.value.command === 'echo "{" "}"', JSON.stringify(braces.value));

const quote = ok('{"command":"echo \\"hello\\""}');
check("字符串里的转义引号不截断", quote.value.command === 'echo "hello"', JSON.stringify(quote.value));

const url = ok('{"url":"https://x.com/a?b=1&c=2"}');
check("URL 里的 & 与冒号原样", url.value.url === "https://x.com/a?b=1&c=2");

const code = ok('{"code":"if (a) { b(); }"}');
check("代码里的花括号", code.value.code === "if (a) { b(); }");

/* ---------------- 七、真的坏：如实失败，不瞎猜 ---------------- */
console.log("\n无法修复\n");

const broken = parseToolArgs('{"command": ');
check("少右括号 → 失败", !broken.ok, broken.ok ? "竟然成功了" : broken.error);

const noQuote = parseToolArgs('{command: "pwd"}');
check("key 没引号 → 失败（不猜）", !noQuote.ok);

const text = argsErrorText("Unexpected end of JSON input", '{"command": ');
check("错误文案说清已尝试过什么", text.includes("已尝试") && text.includes("代码围栏"), text.split("\n")[1] || "");
check("错误文案给出可操作的下一步", text.includes("单个 JSON 对象") && text.includes("\\n"), text);
check("错误文案附上原文开头", text.includes('{"command":'), text);

/* ---------------- 收尾 ---------------- */
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
