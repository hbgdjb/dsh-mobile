#!/usr/bin/env node
/* ============================================================
   shell 兼容层：把截图里那 20% 的失败命令变成成功

   0.69.0 之前，模型在长任务里习惯性回落 GNU/coreutils 写法：
     sed -n '620,760p' …          → 沙箱没有 sed
     grep … | head -60            → "-60 文件不存在"
     cd chenzhong && wc -l …      → 沙箱没有 cd
   三条各失败一次，一轮任务里就攒出约 20% 的失败率。

   这里按真实命令逐条验证：不是"报错变好听了"，而是真的跑出结果。
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
  // 800 行，带 id / section，用来复现截图里的取片段命令
  const lines = Array.from({ length: 800 }, (_, i) => {
    if (i === 619) return '<section id="sec-620">第六百二十行</section>';
    if (i === 759) return '<section id="sec-760">第七百六十行</section>';
    return `<div id="id-${i + 1}">第 ${i + 1} 行 foo</div>`;
  });
  await st.writeFile("chenzhong/index.html", lines.join("\n"));
  await st.writeFile("other/index.html", "OTHER-INDEX\n");
  window.__tools = await import("./scripts/tools.js");
});

const run = (command) =>
  page.evaluate(async (cmd) => {
    const r = await window.__tools.TOOLS.shell.run({ command: cmd });
    return { ok: r.ok, output: String(r.output || "") };
  }, command);

/* ---------- 截图里的四条失败命令 ---------- */
const sed = await run("sed -n '620,760p' chenzhong/index.html");
check("sed -n 'A,Bp' 不再失败", sed.ok === true, sed.output.slice(0, 40));
check("sed 取的是正确的行区间", sed.output.startsWith('<section id="sec-620">') && sed.output.includes('sec-760'), `${sed.output.split("\n").length} 行`);
check("sed 片段长度 141 行", sed.output.split("\n").length === 141, String(sed.output.split("\n").length));

const head60 = await run('grep -n \'id="\' chenzhong/index.html | head -60');
check("grep | head -60（老式计数）不再失败", head60.ok === true, head60.output.slice(0, 40));
check("head -60 截到 60 行", head60.output.split("\n").length === 60, String(head60.output.split("\n").length));

const head40 = await run('grep -n "<section\\|</section>\\|</body>\\|</html>" chenzhong/index.html | head -40');
check("BRE 的 \\| 分支被接住", head40.ok === true && head40.output.includes("sec-620"), head40.output.slice(0, 60));

const withCd = await run('cd chenzhong && wc -l index.html && grep -o "id=\\"[^\\"]*\\"" index.html | head -40');
check("cd <目录> && … 不再失败", withCd.ok === true, withCd.output.slice(0, 50));
check("cd 后按前缀找对文件", withCd.output.includes("chenzhong") || withCd.output.includes("id-"), withCd.output.slice(0, 60));

/* ---------- 兼容层的其余边界 ---------- */
const tailLegacy = await run("tail -5 chenzhong/index.html");
check("tail -5 老式写法", tailLegacy.ok === true && tailLegacy.output.includes("第 800 行"), tailLegacy.output.slice(0, 40));

const sedOne = await run("sed -n '5p' chenzhong/index.html");
check("sed 'Np' 单行", sedOne.ok === true && sedOne.output.includes("id-5"), sedOne.output.slice(0, 40));

const sedAll = await run("sed -n '1,$p' chenzhong/index.html | wc -l");
check("sed '1,$p' 配合管道", sedAll.ok === true && sedAll.output.includes("800"), sedAll.output);

const sedSub = await run("sed 's/foo/bar/g' chenzhong/index.html | head -n 1");
check("sed 简单替换", sedSub.ok === true && sedSub.output.includes("bar"), sedSub.output.slice(0, 50));

const sedPipe = await run("cat chenzhong/index.html | sed -n '3,4p'");
check("sed 从 stdin 取行片段", sedPipe.ok === true && sedPipe.output.includes("id-3"), sedPipe.output.slice(0, 50));

const normal = await run("head -n 700 chenzhong/index.html | tail -n 2");
check("原有 head -n N 写法不受影响", normal.ok === true && normal.output.includes("第 700 行"), normal.output.slice(0, 50));

const only = await run('grep -o "id-[0-9]*" chenzhong/index.html | head -n 3');
check("grep -o 只输出匹配片段", only.ok === true && only.output.split("\n").length === 3, only.output.slice(0, 50));

const cwdPick = await run("cd chenzhong && cat index.html | head -n 1");
check("cd 后同名文件优先取本目录", cwdPick.ok === true && cwdPick.output.includes("id-1"), cwdPick.output.slice(0, 50));

// find 在 0.78 里补上了（模型找文件的标准写法）。这里改用一个
// 确实不打算实现、也最容易写错成它的命令：awk。
const bad = await run("awk '{print $1}' parts/01.html");
check("真不支持的命令仍明确报错", bad.ok === false, "");
check("报错里给了可操作替代", bad.output.includes("head -n") && bad.output.includes("fs_inspect"), "");

const desc = await page.evaluate(() => window.__tools.TOOLS.shell.description);
check("工具描述列全了 head/tail/grep", desc.includes("head -n N") && desc.includes("grep") && desc.includes("sed"), "");
check("工具描述写明禁用项", desc.includes("awk") && desc.includes("curl"), "");

await browser.close();
server.close();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
