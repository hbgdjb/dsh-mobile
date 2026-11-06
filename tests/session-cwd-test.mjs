#!/usr/bin/env node
/* ============================================================
   会话级 cwd（0.73.0）

   0.72.0 把工作区按会话隔离了，但 shell 的 `cd` 还是模块级单值：
   A 会话里 `cd parts` 之后切到 B，B 的 `cat 01.html` 会去 B 自己的
   parts/ 找 —— 找不到时模型会误判成「文件丢了」，又开始整份重写。

   这里验证：cwd 按会话分桶、切会话不串、切回来还在、删会话能清掉。
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

const ids = await page.evaluate(async () => {
  const st = await import("./scripts/store.js");
  const tools = await import("./scripts/tools.js");
  window.__st = st;
  window.__tools = tools;
  st.setSettings({ isolateWorkspace: true });
  const A = st.createSession({ mode: "standard", title: "会话 A" });
  await st.writeFile("parts/a.html", "<h1>A</h1>\n");
  const B = st.createSession({ mode: "standard", title: "会话 B" });
  await st.writeFile("parts/b.html", "<h1>B</h1>\n");
  await st.writeFile("uploads/note.txt", "B note\n");
  return { A: A.id, B: B.id };
});

const run = (command) =>
  page.evaluate(async (cmd) => {
    const r = await window.__tools.TOOLS.shell.run({ command: cmd });
    return { ok: r.ok, output: String(r.output || "") };
  }, command);
const switchTo = (id) => page.evaluate((sid) => window.__st.switchSession(sid), id);

/* ---------- A 会话建立 cwd ---------- */
await switchTo(ids.A);
const cdA = await run("cd parts");
check("A · cd 成功", cdA.ok && cdA.output === "/workspace/parts", cdA.output);
const catA = await run("cat a.html");
check("A · cd 后能读到本会话文件", catA.ok && catA.output.includes("<h1>A</h1>"), catA.output.slice(0, 40));

/* ---------- 切到 B：cwd 不跟过去 ---------- */
await switchTo(ids.B);
const pwdB = await run("pwd");
check("B · 切过来 cwd 回到根目录，不继承 A 的 parts/", pwdB.ok && pwdB.output === "/workspace", pwdB.output);
const lsB = await run("ls");
check("B · 根目录列表里没有 A 的 parts/a.html", lsB.ok && !lsB.output.includes("parts/a.html"), lsB.output.replace(/\n/g, " | ").slice(0, 80));
const catAInB = await run("cat a.html");
check("B · 读不到 A 的文件（隔离仍生效）", catAInB.ok === false, catAInB.output.slice(0, 60));

const cdB = await run("cd uploads");
check("B · 自己 cd 到 uploads", cdB.ok && cdB.output === "/workspace/uploads", cdB.output);
const catB = await run("cat note.txt");
check("B · 在 uploads 下读到自己的文件", catB.ok && catB.output.includes("B note"), catB.output.slice(0, 40));

/* ---------- 切回 A：A 的 cwd 还在，B 的也在 ---------- */
await switchTo(ids.A);
const pwdA2 = await run("pwd");
check("A · 切回来仍在 parts/", pwdA2.ok && pwdA2.output === "/workspace/parts", pwdA2.output);
const catA2 = await run("cat a.html");
check("A · 切回来仍能读到自己的文件", catA2.ok && catA2.output.includes("<h1>A</h1>"), catA2.output.slice(0, 40));

await switchTo(ids.B);
const pwdB2 = await run("pwd");
check("B · 切回来仍在 uploads/（两个会话各记各的）", pwdB2.ok && pwdB2.output === "/workspace/uploads", pwdB2.output);

/* ---------- 删会话清理 ---------- */
const cleared = await page.evaluate((sid) => {
  window.__tools.forgetShellCwd(sid);
  return window.__tools.currentShellCwd();
}, ids.B);
check("forgetShellCwd 清掉该会话的 cwd", cleared === "", JSON.stringify(cleared));
const pwdB3 = await run("pwd");
check("清理后 B 的 pwd 回到根", pwdB3.ok && pwdB3.output === "/workspace", pwdB3.output);

/* ---------- 工具描述 ---------- */
const desc = await page.evaluate(() => window.__tools.TOOLS.shell.description);
check("工具描述写明 cd 只在当前会话内保留", desc.includes("当前会话") && desc.includes("pwd 可查"), "");

await browser.close();
server.close();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
