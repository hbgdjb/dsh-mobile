#!/usr/bin/env node
/* ============================================================
   一条命令里的多步、计数与重定向

   截图里那条失败是这么写的：
     head -n 7 pkg/SKILL.md; echo ===; wc -c pkg/SKILL.md; echo ===; grep -c '' pkg/SKILL.md

   它想一次拿到「开头几行 + 字节数 + 行数」，这是模型探查文件的标准动作。
   实际却整条标红，原因是最后一段 `grep -c ''` 被当成「没给模式」。
   连带暴露的还有：
     - 前面 head/wc 明明成功了，输出被丢掉，只剩一句用法错误
     - 多步命令只回最后一段，模型只能拆成四次调用重跑
     - wc -l 比真 shell 多一行、wc -c 给的是字符数
     - `wc -l < file` 把 `<` 当文件名
     - `rm -rf 不存在的目录` 报错，害得清理步骤一上来就红
   这里按真实写法逐条钉住。
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

const SKILL = "---\nname: onetake\n---\n\n# onetake\n正文\n";
await page.evaluate(async (skill) => {
  const st = await import("./scripts/store.js");
  await st.writeFile("onetake-install/onetake/SKILL.md", skill);
  await st.writeFile("a.md", "l1\nl2\nl3\n");
  await st.writeFile("cn.md", "一二三\n");
  window.__tools = await import("./scripts/tools.js");
  window.__st = st;
}, SKILL);

const run = (command) =>
  page.evaluate(async (cmd) => {
    const r = await window.__tools.TOOLS.shell.run({ command: cmd });
    return { ok: r.ok, output: String(r.output || "") };
  }, command);

await run("cd /");

/* ---------- ① 截图里那条命令，原样跑 ---------- */

const shot = await run(
  "head -n 7 onetake-install/onetake/SKILL.md; echo ===; wc -c onetake-install/onetake/SKILL.md; echo ===; grep -c '' onetake-install/onetake/SKILL.md"
);
check("截图里的多步命令整体成功", shot.ok === true, shot.output.slice(0, 60).replace(/\n/g, " | "));
check("第一段 head 的内容还在", shot.output.includes("name: onetake"), shot.output.slice(0, 40).replace(/\n/g, " | "));
check("第二段 wc -c 的结果还在（字节数）", /40 字节/.test(shot.output), shot.output.replace(/\n/g, " | ").slice(0, 80));
check("第三段 grep -c '' 给出 6 行", /(^|\n)6(\n|$)/.test(shot.output), shot.output.replace(/\n/g, " | ").slice(-40));

/* ---------- ② 空模式：grep -c '' / grep '' ---------- */

const countEmpty = await run("grep -c '' onetake-install/onetake/SKILL.md");
check("grep -c '' 单独调用返回行数", countEmpty.ok && countEmpty.output.trim() === "6", countEmpty.output);
const grepEmpty = await run("grep '' a.md");
check("grep '' 输出全部行（不是报错）", grepEmpty.ok && grepEmpty.output === "l1\nl2\nl3", JSON.stringify(grepEmpty.output));
const countCaret = await run("grep -c '^' a.md");
check("grep -c '^' 与 grep -c '' 一致", countCaret.ok && countCaret.output.trim() === "3", countCaret.output);
const usage = await run("grep -c");
check("真没给模式时仍提示用法", !usage.ok && usage.output.includes("用法"), usage.output);

/* ---------- ③ 行数 / 字节数跟真 shell 对齐 ---------- */

const wcL = await run("wc -l a.md");
check("wc -l 数换行，不把末尾换行算成多一行", wcL.ok && wcL.output.includes("3 行"), wcL.output);
const wcC = await run("wc -c a.md");
check("wc -c 是字节数（ASCII 同长）", wcC.ok && wcC.output.includes("9 字节"), wcC.output);
const wcCn = await run("wc -c cn.md");
check("wc -c 对中文按 UTF-8 字节算（一二三 + 换行 = 10）", wcCn.ok && wcCn.output.includes("10 字节"), wcCn.output);
const wcM = await run("wc -m cn.md");
check("wc -m 才是字符数", wcM.ok && wcM.output.includes("4 字符"), wcM.output);

const tailOne = await run("tail -n 1 a.md");
check("tail -n 1 拿到最后一行内容（不是空行）", tailOne.ok && tailOne.output.trim() === "l3", JSON.stringify(tailOne.output));
const headOne = await run("head -n 1 a.md");
check("head -n 1 拿到第一行", headOne.ok && headOne.output === "l1", JSON.stringify(headOne.output));

/* ---------- ④ 多步命令的每段输出都要回来 ---------- */

const twoEcho = await run("echo A; echo B");
check("echo A; echo B 两段都在", twoEcho.ok && twoEcho.output === "A\nB", JSON.stringify(twoEcho.output));
const three = await run("cd /; wc -l a.md; echo --; wc -c a.md");
check("wc + 分隔符 + wc 三段按顺序返回", three.ok && /3 行[\s\S]*--[\s\S]*9 字节/.test(three.output), three.output.replace(/\n/g, " | "));

/* ---------- ⑤ 部分失败：前面的输出不能丢 ---------- */

const mid = await run("cd /; cat a.md; cat nope.md; echo AFTER");
check("中间一段失败时，前后成功的输出都保留", mid.output.includes("l1") && mid.output.includes("AFTER"), mid.output.replace(/\n/g, " | ").slice(0, 90));
check("失败段被点名，带原命令", mid.output.includes("[这一步失败]") && mid.output.includes("cat nope.md"), mid.output.replace(/\n/g, " | ").slice(-60));
check("退出码跟最后一段（末尾成功 → 整体成功）", mid.ok === true, String(mid.ok));

const lastBad = await run("cd /; echo OK; cat nope.md");
check("最后一段失败 → 整体算失败", lastBad.ok === false, String(lastBad.ok));
check("但前面 echo 的输出仍然在", lastBad.output.includes("OK"), lastBad.output.replace(/\n/g, " | ").slice(0, 50));
const andStop = await run("cd /; cat nope.md && echo NEVER");
check("&& 后面的不再执行", andStop.ok === false && !andStop.output.includes("NEVER"), andStop.output.replace(/\n/g, " | ").slice(0, 60));

/* ---------- ⑥ 输入重定向 ---------- */

const inRedir = await run("wc -l < a.md");
check("wc -l < 文件 读的是文件内容", inRedir.ok && inRedir.output.includes("3 行"), inRedir.output);
const inGrep = await run("grep -c l2 < a.md");
check("grep -c … < 文件 也能用", inGrep.ok && inGrep.output.trim() === "1", inGrep.output);
const inMissing = await run("wc -l < nope.md");
check("输入文件不存在时说清楚（不写文件）", !inMissing.ok && inMissing.output.includes("不存在"), inMissing.output);
const ltPattern = await run('grep -n "<section" a.md');
check("grep 模式里的 < 不被当成输入重定向", ltPattern.ok && ltPattern.output.includes("没有匹配"), ltPattern.output);

/* ---------- ⑦ rm -f 的静默语义 ---------- */

const rmForce = await run("cd /; rm -rf not-there; echo done");
check("rm -rf 不存在的目录不报错", rmForce.ok === true && rmForce.output.includes("done"), rmForce.output.replace(/\n/g, " | "));
const rmPlain = await run("rm not-there");
check("rm 不带 -f 时仍然如实报不存在", !rmPlain.ok && rmPlain.output.includes("不存在"), rmPlain.output);

/* ---------- ⑧ cd 之后 ls 给相对路径 ---------- */

await run("cd /");
const lsRel = await run("cd onetake-install; ls");
check("cd 后 ls 显示相对当前目录的路径", lsRel.ok && lsRel.output.trim() === "onetake/SKILL.md", JSON.stringify(lsRel.output));
await run("cd /");
const catRel = await run("cd onetake-install; head -n 1 onetake/SKILL.md");
check("按 ls 给的相对路径能直接读", catRel.ok && catRel.output.trim() === "---", catRel.output);
const cdAbs = await run("cd /; cd /workspace/onetake-install; ls");
check("cd 绝对路径（带 /workspace）也能落到正确目录", cdAbs.ok && cdAbs.output.trim() === "onetake/SKILL.md", JSON.stringify(cdAbs.output));

await run("cd /");
const cdUp = await run("cd onetake-install/onetake; cd ..; pwd");
check("cd .. 回到上一层（不是把 .. 当目录名）", cdUp.ok && cdUp.output.trim() === "/workspace/onetake-install", cdUp.output);
const cdUpRel = await run("cd /; cd onetake-install/onetake; cd ../..; pwd");
check("cd ../.. 一路回到根", cdUpRel.ok && cdUpRel.output.trim() === "/workspace", cdUpRel.output);
const catUp = await run("cd /; cd onetake-install/onetake; head -n 1 ../../a.md");
check("cd 之后用 ../ 读外层文件", catUp.ok && catUp.output.trim() === "l1", catUp.output);
const cdEmpty = await run("cd /; cd no-such-dir");
check("cd 到不存在的目录会说明它还是空的", cdEmpty.ok && cdEmpty.output.includes("还没有文件"), cdEmpty.output.replace(/\n/g, " | "));
const cdTwice = await run("cd /; cd onetake-install; cd onetake-install; pwd");
check("重复 cd 同一目录不会叠成 a/a", cdTwice.ok && cdTwice.output.trim() === "/workspace/onetake-install", cdTwice.output.replace(/\n/g, " | "));
await run("cd /");

console.log(`\n${fail ? `✗ ${fail} 项失败` : "全部通过"}（通过 ${pass}）`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
