#!/usr/bin/env node
/* ============================================================
   shell 兼容层第二批：模型拼接页面时踩的五条

   用户日志（模型自述）逐条对应：
     "cat 处理多个文件时会插入 ==> 文件名 <== 头，导致产物被污染"
       → cat 分支错套了 head/tail 的多文件头，还用 "\n" join 多插空行
     "沙箱的 grep -c 行为异常，会输出匹配内容，而非计数"
       → 根本没实现 -c，落回默认全行输出
     "sed -i 在沙箱里不会写回原文件"
       → -i 被当普通 flag 忽略，只打印结果
     "含分号的 s/// 被拦截"
       → 不加引号时，脚本里的分号被 runShell 当成语句分隔符
     "沙箱的 cd 行为不稳定，我改用完整相对路径操作"
       → cwd 不跨工具调用保留，模型把 cd 与后续命令分成两次调用就丢

   因为工具不好用，模型被迫「重写 parts/12.html 再重新拼接」，
   那三处 CSS 精修的返工就是这么来的。这里按真实命令逐条验证。
   全程离线，用页面里的虚拟工作区。
   ============================================================ */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const body = await readFile(join(ROOT, decodeURIComponent(url.pathname)));
    res.writeHead(200, { "content-type": MIME[extname(url.pathname)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });

await page.evaluate(async () => {
  const st = await import("./scripts/store.js");
  await st.writeFile("parts/01.html", "<h1>A</h1>\n");
  await st.writeFile("parts/02.html", "<p>B;C</p>\n");
  await st.writeFile("parts/12.html", "OLD;CONTENT\n");
  await st.writeFile("parts/semi.txt", "a;b\n");
  await st.writeFile("root.txt", "ROOT\n");
  window.__tools = await import("./scripts/tools.js");
  window.__st = st;
});

const run = (command) =>
  page.evaluate(async (cmd) => {
    const r = await window.__tools.TOOLS.shell.run({ command: cmd });
    return { ok: r.ok, output: String(r.output || "") };
  }, command);
const read = (p) => page.evaluate(async (path) => (await window.__st.readFile(path))?.content ?? "(无)", p);
const reset = () => run("cd /");

/* ---------- ① cat 多文件：纯拼接，不插文件名头 ---------- */
await reset();
const catMany = await run("cat parts/01.html parts/02.html");
check("cat 多文件不再有 ==> 文件名 <== 头", catMany.ok && !catMany.output.includes("==>"), catMany.output.slice(0, 50));
check("cat 多文件是纯拼接（不补空行）", catMany.output === "<h1>A</h1>\n<p>B;C</p>\n", JSON.stringify(catMany.output));

const merged = await run("cat parts/01.html parts/02.html > parts/merged.html");
check("cat a b > out 命令本身成功", merged.ok, "");
const mergedBody = await read("parts/merged.html");
check("重定向产物干净，无文件名头", mergedBody === "<h1>A</h1>\n<p>B;C</p>\n", JSON.stringify(mergedBody));

const pipedLines = await run("cat parts/01.html parts/02.html | wc -l");
// 两个文件各一行、都以换行结尾 → 真 wc -l 是 2。以前这里按 split("\n")
// 数出 3（末尾换行被当成多一行），模型据此判断行数会一直差 1。
check("纯拼接后行数正确（管道计数）", pipedLines.ok && pipedLines.output.includes("2 行"), pipedLines.output);

const echoSemi = await run("echo 'x;y' > parts/echo.txt");
check("引号内的分号不会被切段", echoSemi.ok && (await read("parts/echo.txt")) === "x;y", JSON.stringify(await read("parts/echo.txt")));
const appended = await run("echo TAIL >> parts/echo.txt");
check(">> 是纯追加（不自动插换行）", appended.ok && (await read("parts/echo.txt")) === "x;yTAIL", JSON.stringify(await read("parts/echo.txt")));

/* ---------- ② grep -c：给计数，不给内容 ---------- */
const cOne = await run("grep -c h1 parts/01.html");
check("grep -c 单文件返回纯数字", cOne.ok && cOne.output.trim() === "1", cOne.output);
const cZero = await run("grep -c zzz parts/01.html");
check("grep -c 无匹配返回 0（不是「没有匹配」）", cZero.ok && cZero.output.trim() === "0", cZero.output);
const cMulti = await run("grep -c h1 parts/01.html parts/02.html");
check("grep -c 多文件按 文件:计数 输出", cMulti.ok && cMulti.output.includes("parts/01.html:1") && cMulti.output.includes("parts/02.html:0"), cMulti.output.replace(/\n/g, " | "));
const cPipe = await run("cat parts/01.html | grep -c h1");
check("grep -c 从管道取输入", cPipe.ok && cPipe.output.trim() === "1", cPipe.output);
const gN = await run("grep -n h1 parts/01.html");
check("grep -n 仍输出带行号的内容（回归）", gN.ok && /^1: <h1>/.test(gN.output), gN.output.slice(0, 40));
const gO = await run('grep -o "h1" parts/01.html');
// <h1>A</h1> 里 "h1" 出现两次（开/闭标签），-o 会输出两行纯片段
check("grep -o 仍只输出匹配片段（回归）", gO.ok && gO.output.trim() === "h1\nh1" && !gO.output.includes("<"), gO.output.replace(/\n/g, " | "));

/* ---------- ③ sed -i：真的写回原文件 ---------- */
const sedI = await run("sed -i 's/OLD/NEW/g' parts/12.html");
check("sed -i 返回成功且不倾倒文件内容", sedI.ok && !sedI.output.includes("NEW;CONTENT"), sedI.output);
check("sed -i 写回了原文件", (await read("parts/12.html")) === "NEW;CONTENT\n", JSON.stringify(await read("parts/12.html")));

const sedNoI = await run("sed 's/NEW/DRY/g' parts/12.html");
check("不带 -i 时仍只输出、不写盘", sedNoI.ok && sedNoI.output.includes("DRY") && (await read("parts/12.html")) === "NEW;CONTENT\n", sedNoI.output.slice(0, 40));

const sedSemiQuoted = await run("sed -i 's/;/；/g' parts/12.html");
check("含分号的 s///（加引号）不再被拦", sedSemiQuoted.ok, sedSemiQuoted.output);
check("含分号的替换真的写回", (await read("parts/12.html")).includes("NEW；CONTENT"), JSON.stringify(await read("parts/12.html")));

const sedSemiBare = await run("sed -i s/a;b/OK/g parts/semi.txt");
check("含分号的 s///（不加引号）也被接住", sedSemiBare.ok, sedSemiBare.output);
check("不加引号的分号脚本写回正确", (await read("parts/semi.txt")) === "OK\n", JSON.stringify(await read("parts/semi.txt")));

const sedMulti = await run("sed -i 's/OLD/NEW/g;s/CONTENT/DONE/g' parts/12.html");
check("分号分隔的多条 s/// 逐条生效", sedMulti.ok && (await read("parts/12.html")) === "NEW；DONE\n", JSON.stringify(await read("parts/12.html")));

const sedRange = await run("sed -n '1p' parts/01.html");
check("sed -n 'A,Bp' 取行片段不受影响（回归）", sedRange.ok && sedRange.output.includes("<h1>A</h1>"), sedRange.output.slice(0, 40));

/* ---------- ④ cd：跨工具调用保留 ---------- */
await reset();
const cdAlone = await run("cd parts");
check("cd 单独一次调用成功", cdAlone.ok && cdAlone.output === "/workspace/parts", cdAlone.output);
const afterCd = await run("cat 01.html");
check("下一次调用仍按 cd 的目录找文件", afterCd.ok && afterCd.output.includes("<h1>A</h1>"), afterCd.output.slice(0, 40));
const pwdIn = await run("pwd");
check("pwd 反映当前目录", pwdIn.ok && pwdIn.output === "/workspace/parts", pwdIn.output);
const lsIn = await run("ls");
// cd 之后按相对当前目录显示（真 shell 如此）。以前恒给全路径，模型看到
// `parts/01.html` 会以为 cd 没生效，后面每条命令都重写全路径。
check(
  "cd 后 ls 只列本目录、且是相对路径",
  lsIn.ok && lsIn.output.includes("01.html") && !lsIn.output.includes("parts/01.html") && !lsIn.output.includes("root.txt"),
  lsIn.output.replace(/\n/g, " | ").slice(0, 90)
);
const fullRel = await run("cat parts/01.html");
check("cd 后仍可用完整相对路径", fullRel.ok && fullRel.output.includes("<h1>A</h1>"), fullRel.output.slice(0, 40));
await reset();
const pwdRoot = await run("pwd");
check("cd / 能回到根", pwdRoot.ok && pwdRoot.output === "/workspace", pwdRoot.output);
const lsRoot = await run("ls");
check("回到根后 ls 重新包含根级文件", lsRoot.ok && lsRoot.output.includes("root.txt"), "");

/* ---------- ⑤ 权限与工具描述 ---------- */
await page.evaluate(() => window.__st.setSettings({ permission: "readonly" }));
const roSed = await run("sed -i 's/NEW/XX/g' parts/12.html");
check("只读权限下 sed -i 明确拒绝写回", roSed.ok === false && roSed.output.includes("只读"), roSed.output);
check("只读权限下原文件未被改动", !(await read("parts/12.html")).includes("XX"), "");
await page.evaluate(() => window.__st.setSettings({ permission: "workspace" }));

const desc = await page.evaluate(() => window.__tools.TOOLS.shell.description);
check("工具描述写明 sed -i 可原地写回", desc.includes("sed -i") && desc.includes("原地写回"), "");
check("工具描述写明 cat 多文件纯拼接", desc.includes("纯拼接") && desc.includes("没有文件名头"), "");
check("工具描述写明 cd 跨调用保留且限定在当前会话", desc.includes("当前会话") && desc.includes("pwd 可查"), "");
check("工具描述仍列出 grep 与禁用项", desc.includes("grep") && desc.includes("awk") && desc.includes("curl"), "");
const bad = await run("awk '{print $1}' parts/01.html");
check("真不支持的命令仍明确报错并给替代", bad.ok === false && bad.output.includes("sed -i") && bad.output.includes(">>"), "");

await browser.close();
server.close();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
