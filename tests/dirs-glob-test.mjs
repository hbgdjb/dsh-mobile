#!/usr/bin/env node
/* ============================================================
   目录与通配符：模型处理一个上传包时会用到的写法

   第二类高频失败不是「命令不存在」，而是「命令存在但只认一种形状」：
     rm -rf onetake_pkg     → 只删文件，目录报「不存在」
     ls *.zip               → 把 *.zip 当目录名
     cat parts/*.html       → 同上
     grep -rn "x" .         → 把 "." 当文件去读
     cat pkg                → 只回「文件不存在」，其实是目录

   每条都会让模型换写法重试，失败率就是这么堆起来的。
   这里按真实写法逐条验证。
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
  await st.writeFile("parts/02.html", "<p>B</p>\n");
  await st.writeFile("parts/notes.md", "# 笔记\n");
  await st.writeFile("uploads/one.zip", "PK-not-really");
  await st.writeFile("uploads/two.zip", "PK-not-really");
  await st.writeFile("pkg/onetake/main.js", "export default {};\n");
  await st.writeFile("pkg/onetake/package.json", '{"name":"onetake"}\n');
  await st.writeFile("pkg/onetake/skills/a.md", "# A\n");
  window.__tools = await import("./scripts/tools.js");
  window.__st = st;
});

const run = (command) =>
  page.evaluate(async (cmd) => {
    const r = await window.__tools.TOOLS.shell.run({ command: cmd });
    return { ok: r.ok, output: String(r.output || "") };
  }, command);
const read = (p) =>
  page.evaluate(async (path) => {
    const f = await window.__st.readFile(path);
    return f ? String(f.content ?? "") : null;
  }, p);

await run("cd /");

/* ---------- ① 通配符 ---------- */

const lsZip = await run("ls uploads/*.zip");
check("ls *.zip 能列出匹配文件", lsZip.ok && lsZip.output.includes("uploads/one.zip") && lsZip.output.includes("uploads/two.zip"), lsZip.output.replace(/\n/g, " | "));

const lsMd = await run("ls parts/*.md");
check("ls *.md 只给匹配的那一个", lsMd.ok && lsMd.output.trim() === "parts/notes.md", JSON.stringify(lsMd.output));

const lsNone = await run("ls parts/*.css");
check("通配符没匹配到时是成功（不是失败）", lsNone.ok && lsNone.output.includes("没有匹配"), lsNone.output);

const catGlob = await run("cat parts/*.html");
check("cat parts/*.html 按文件名顺序纯拼接", catGlob.ok && catGlob.output === "<h1>A</h1>\n<p>B</p>\n", JSON.stringify(catGlob.output));

const catGlobOut = await run("cat parts/*.html > parts/all.html");
check("cat 通配符 + 重定向能合成一个文件", catGlobOut.ok && (await read("parts/all.html")) === "<h1>A</h1>\n<p>B</p>\n", JSON.stringify(await read("parts/all.html")));

/* ---------- ② 把目录当文件 ---------- */

const catDir = await run("cat pkg");
check("cat 目录时明确指出这是目录", !catDir.ok && catDir.output.includes("是目录") && catDir.output.includes("ls pkg"), catDir.output);

const headDir = await run("head -n 3 pkg");
check("head 目录时也给同样的提示（不是「文件不存在」）", !headDir.ok && headDir.output.includes("是目录"), headDir.output);

const wcDir = await run("wc -l pkg");
check("wc 目录时也提示是目录", wcDir.output.includes("是目录"), wcDir.output);

/* ---------- ③ rm -r ---------- */

const rmNoR = await run("rm pkg");
check("rm 目录不加 -r 时说明要加 -r", !rmNoR.ok && rmNoR.output.includes("-r"), rmNoR.output);
check("rm 失败时没有误删文件", (await read("pkg/onetake/main.js")) !== null, "");

const rmRf = await run("cd /; cp -r pkg pkg_copy");
check("cp -r 复制目录成功", rmRf.ok && rmRf.output.includes("3 个文件"), rmRf.output);
check("cp -r 后副本内容在", (await read("pkg_copy/onetake/main.js")) === "export default {};\n", "");
check("cp -r 后源目录还在", (await read("pkg/onetake/main.js")) !== null, "");

const rmDir = await run("rm -rf pkg_copy");
check("rm -rf 能递归删目录", rmDir.ok && rmDir.output.includes("3 个文件"), rmDir.output);
check("rm -rf 之后文件真的没了", (await read("pkg_copy/onetake/main.js")) === null, String(await read("pkg_copy/onetake/main.js")));
check("rm -rf 没有碰到同前缀的别的文件", (await read("pkg/onetake/main.js")) !== null, "");

/* ---------- ④ cp / mv 的目录语义 ---------- */

const cpInto = await run("cd /; mkdir -p stage && cp parts/01.html parts/02.html stage/");
check("cp 多文件到目录（尾斜杠）", cpInto.ok && (await read("stage/01.html")) === "<h1>A</h1>\n" && (await read("stage/02.html")) === "<p>B</p>\n", cpInto.output);

const mvDir = await run("cd /; mv stage stage2");
check("mv 目录能整体改名", mvDir.ok && (await read("stage2/01.html")) !== null, mvDir.output);
check("mv 之后旧目录不在了", (await read("stage/01.html")) === null, String(await read("stage/01.html")));

const cpNoR = await run("cd /; cp pkg pkg2");
check("cp 目录不加 -r 时说明要加 -r", !cpNoR.ok && cpNoR.output.includes("-r"), cpNoR.output);

/* ---------- ⑤ grep -r ---------- */

const grepDot = await run('cd /; grep -rn "export" .');
check(
  'grep -rn "x" . 能递归搜当前目录',
  grepDot.ok && grepDot.output.trim() === "pkg/onetake/main.js:1: export default {};",
  grepDot.output.split("\n").slice(0, 3).join(" | ")
);

const grepDir = await run('cd /; grep -rn "export" pkg');
check("grep -r 指定目录", grepDir.ok && grepDir.output.includes("pkg/onetake/main.js"), grepDir.output);

const grepNoR = await run('cd /; grep "onetake" pkg');
check("grep 不加 -r 对目录给出提示", grepNoR.output.includes("是目录"), grepNoR.output);

/* ---------- ⑥ 只读 ---------- */

const ro = await page.evaluate(async () => {
  const st = await import("./scripts/store.js");
  st.setSettings({ permission: "readonly" });
  const a = await window.__tools.TOOLS.shell.run({ command: "rm -rf pkg" });
  const b = await window.__tools.TOOLS.shell.run({ command: "cp -r pkg pk3" });
  st.setSettings({ permission: "auto" });
  return { rm: { ok: a.ok, output: String(a.output || "") }, cp: { ok: b.ok, output: String(b.output || "") } };
});
check("只读时 rm -rf 被拒绝", !ro.rm.ok && ro.rm.output.includes("只读"), ro.rm.output);
check("只读时 cp -r 被拒绝", !ro.cp.ok && ro.cp.output.includes("只读"), ro.cp.output);
check("只读拒绝后文件仍在", (await read("pkg/onetake/main.js")) !== null, "");

console.log(`\n${fail ? "✗" : "✓"} ${fail ? `${fail} 项失败` : "全部通过"}（通过 ${pass}）`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
