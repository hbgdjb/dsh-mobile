#!/usr/bin/env node
/**
 * 常用 Unix 过滤命令的回归
 *
 * ============ 这套测试在补哪条缝 ============
 *
 * 截图里两次工具失败都不是模型乱写，而是它写了最标准的 Unix 写法：
 *
 *     grep -o -E '…' SKILL.md | sort -u        → 沙箱没有 sort
 *     cd ~ 2>/dev/null && pwd; ls -d …          → cd 没识别出来
 *
 * 第一条整条管道红掉；第二条更糟，回了句「沙箱终端不支持 cd」——
 * 而 cd 明明是支持的，只是后面跟了个 stderr 重定向，正则没匹配上。
 *
 * 模型接下来会换写法重试，失败率就是这么堆起来的。所以这里按
 * 「模型真的会写什么」逐条验证，而不是按「我们实现了什么」。
 *
 * 用法：node tests/shell-unix-test.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const b = await readFile(f);
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });

await page.evaluate(async () => {
  const st = await import("./scripts/store.js");
  await st.writeFile(
    "uploads/onetake/SKILL.md",
    "# onetake\n\n见 references/usage.md 与 scripts/run.sh\n另外 cases/a-b.md 和 scripts/run.sh\n"
  );
  await st.writeFile("pkg/a.md", "x\ny\n");
  await st.writeFile("pkg/b.md", "z\n");
  await st.writeFile("pkg/sub/c.json", "{}\n");
  await st.writeFile("names.txt", "c\nb\na\nb\nc\nc\n");
  await st.writeFile("lines.txt", "a:1:foo\nb:2:bar\nc:3:baz\n");
  await st.writeFile("nums.txt", "10\n2\n33\n4\n");
  window.__tools = await import("./scripts/tools.js");
});

const run = (command) =>
  page.evaluate(async (cmd) => {
    const r = await window.__tools.TOOLS.shell.run({ command: cmd });
    return { ok: r.ok, output: String(r.output || "") };
  }, command);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail.replace(/\n/g, " | ").slice(0, 120) : ""}`);
  if (ok) passed += 1;
  else failed += 1;
};

console.log("\n截图里的两条\n");

// 第一条：grep -o -E … | sort -u。以前整条失败，就卡在没有 sort。
const c1 = await run(
  `echo "=== SKILL.md 里引用到的相对路径:"; grep -o -E '(lib|scripts|references|templates|looks|gallery|cases)/[A-Za-z0-9_./-]+' uploads/onetake/SKILL.md | sort -u`
);
check("grep -o -E | sort -u 整条成功", c1.ok, c1.output);
check("去重后的三个路径都在", ["cases/a-b.md", "references/usage.md", "scripts/run.sh"].every((p) => c1.output.includes(p)), c1.output);
check("重复的 scripts/run.sh 被去掉（只出现一次）", c1.output.split("scripts/run.sh").length - 1 === 1, c1.output);

// 第二条：cd ~ 2>/dev/null && pwd; ls -a; ls -d …
const c2 = await run(
  `cd ~ 2>/dev/null && pwd; echo "-- HOME files:"; ls -a; echo "-- skills dirs:"; ls -d .claude/.claude/skills .agents/.agents/skills 2>/dev/null; echo "(end)"`
);
check("cd ~ 2>/dev/null && pwd 整条成功", c2.ok, c2.output);
check("cd ~ 落到工作区根", c2.output.includes("/workspace"), c2.output);
check("后面的 ls -a 照常执行", c2.output.includes("names.txt"), c2.output);
// 0.79：`2>/dev/null` 真的静默了。以前只是把这三个字符删掉，
// 错误照样返回；现在失败的错误输出被吞掉，但退出码保留 ——
// 所以后面那句 `echo "(end)"` 照常执行，也不会冒出「不存在」。
check(
  "ls -d 探测不到目录时不污染输出（2>/dev/null 已生效）",
  c2.output.includes("(end)") && !c2.output.includes("不存在") && !c2.output.includes("这一步失败"),
  c2.output
);
check("不再出现「不支持 cd」", !c2.output.includes("不支持 `cd`"), c2.output);

console.log("\n过滤命令\n");

const sortU = await run("sort -u names.txt");
check("sort -u 去重", sortU.ok && sortU.output.trim() === "a\nb\nc", JSON.stringify(sortU.output));

const sortR = await run("sort -r names.txt | head -n 1");
check("sort -r 倒序 + 管道", sortR.ok && sortR.output.trim() === "c", JSON.stringify(sortR.output));

const sortN = await run("sort -n nums.txt");
check("sort -n 按数值排（不是字典序）", sortN.ok && sortN.output.trim().split("\n")[0] === "2", JSON.stringify(sortN.output));

const sortK = await run("sort -t: -k2 -n lines.txt");
check("sort -k 按第 2 列", sortK.ok && sortK.output.trim().split("\n")[0].includes("1"), JSON.stringify(sortK.output));

const uniqC = await run("sort names.txt | uniq -c");
check("sort | uniq -c 计数正确", uniqC.ok && /3 c/.test(uniqC.output) && /2 b/.test(uniqC.output), uniqC.output);
check("uniq -c 末尾没有多余空行", !/\n\s*1\s*$/.test(uniqC.output), JSON.stringify(uniqC.output.slice(-20)));

const cut1 = await run("cut -d: -f1 lines.txt");
check("cut -d: -f1 取第一列", cut1.ok && cut1.output.trim() === "a\nb\nc", JSON.stringify(cut1.output));

const cut2 = await run("cut -d: -f2-3 lines.txt");
check("cut -f2-3 取范围", cut2.ok && cut2.output.trim().split("\n")[0] === "1:foo", JSON.stringify(cut2.output));

const tr1 = await run("cat names.txt | tr '\\n' ','");
check("tr '\\n' ',' 换行转换", tr1.ok && tr1.output.startsWith("c,b,a"), JSON.stringify(tr1.output));

const tr2 = await run("echo hello | tr -d l");
check("tr -d 删字符", tr2.ok && tr2.output.trim() === "heo", JSON.stringify(tr2.output));

const base = await run("basename pkg/sub/c.json");
check("basename", base.ok && base.output.trim() === "c.json", base.output);

const baseSuf = await run("basename pkg/sub/c.json .json");
check("basename 去后缀", baseSuf.ok && baseSuf.output.trim() === "c", baseSuf.output);

const dir = await run("dirname pkg/sub/c.json");
check("dirname", dir.ok && dir.output.trim() === "pkg/sub", dir.output);

const statS = await run("stat -c %s pkg/a.md");
check("stat -c %s 给字节数", statS.ok && statS.output.trim() === "4", statS.output);

const duS = await run("du -sh pkg");
check("du -sh 是目录总量", duS.ok && duS.output.includes("pkg") && /\d/.test(duS.output), duS.output);

const rp = await run("realpath pkg/sub/c.json");
check("realpath 给绝对路径", rp.ok && rp.output.trim() === "/workspace/pkg/sub/c.json", rp.output);

console.log("\nfind 与 ls -d\n");

const f1 = await run('find . -name "*.md"');
check("find . -name 找到所有 md", f1.ok && f1.output.includes("./pkg/a.md") && f1.output.includes("./uploads/onetake/SKILL.md"), f1.output);

const f2 = await run('find pkg -name "*.md"');
check("find 带起点时输出带起点前缀", f2.ok && f2.output.includes("pkg/a.md") && !f2.output.includes("./a.md"), f2.output);

const f3 = await run("find . -type d");
check("find -type d 列出目录", f3.ok && f3.output.includes("./pkg/sub"), f3.output);

const f4 = await run("find . -maxdepth 1 -type f");
check("find -maxdepth 1 不深入子目录", f4.ok && f4.output.includes("./names.txt") && !f4.output.includes("pkg/a.md"), f4.output);

const lsD = await run("ls -d pkg pkg/sub");
check("ls -d 只回路径本身", lsD.ok && lsD.output.trim() === "pkg\npkg/sub", lsD.output);

const lsMissing = await run("ls -d nope-1 nope-2");
// 0.79 改了语义：全都不存在时按真 ls 返回非零。
// 以前这里故意返回 ok:true，结果是
//   `ls -d skills ... 2>/dev/null || echo "没有"` 里的 echo 永远不执行，
// 模型只能自己从五行「不存在」里推断结论 —— 截图里那条命令正是这么失败的一环。
check(
  "ls -d 全不存在按真 ls 失败（|| 才兜得住）",
  !lsMissing.ok && lsMissing.output.includes("没有那个文件或目录"),
  lsMissing.output
);
const lsFallback = await run("ls -d nope-1 nope-2 2>/dev/null || echo FALLBACK");
check("于是 2>/dev/null || echo 能正常兜底", lsFallback.ok && lsFallback.output.trim() === "FALLBACK", lsFallback.output);

console.log("\n路径与重定向\n");

await run("cd /");
const home = await run("cd ~; pwd");
check("cd ~ 回工作区根", home.ok && home.output.trim() === "/workspace", home.output);

const homeSub = await run("cd ~/pkg; pwd; ls");
check("cd ~/pkg 进子目录", homeSub.ok && homeSub.output.includes("/workspace/pkg") && homeSub.output.includes("a.md"), homeSub.output);

await run("cd /");
const stderr1 = await run("ls -d pkg 2>/dev/null");
check("2>/dev/null 被忽略，参数不串味", stderr1.ok && stderr1.output.trim() === "pkg", stderr1.output);

const stderr2 = await run("cat nope.md 2>/dev/null; echo AFTER");
check("失败时后面的步骤照常执行", stderr2.output.includes("AFTER"), stderr2.output);

console.log("\n|| 与 true\n");

const or1 = await run("cat nope.md || echo FALLBACK");
check("a || b：a 失败时执行 b", or1.ok && or1.output.includes("FALLBACK"), or1.output);

const or2 = await run("echo OK || echo FALLBACK");
check("a || b：a 成功时跳过 b", or2.ok && or2.output.includes("OK") && !or2.output.includes("FALLBACK"), or2.output);

const or3 = await run("rm -rf no-such-dir || true");
check("rm -rf … || true 整条成功", or3.ok, or3.output);

const or4 = await run("awk '{print}' names.txt || echo SKIP");
check("不支持的命令后面跟 || echo 能兜住", or4.ok && or4.output.includes("SKIP"), or4.output);

const notCd = await run("cd /");
check("复位到根", notCd.ok && notCd.output.trim() === "/workspace", notCd.output);

check("全程没有 JS 报错", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
server.close();

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
