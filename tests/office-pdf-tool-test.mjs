/* ============================================================
   PDF 工具链路测试（tests/office-pdf-tool-test.mjs）

   纯函数的测试在 office-pdf-test.mjs。这里只问一件事：
   装进工具表之后，模型真的能通过 pdf_create / pdf_read 干活吗？

   要守的点：
     1) 工具只在办公插件启用时出现（关掉就不该占 schema）
     2) pdf_create 真的把文件写进工作区，且能被 pdf_read 读回来
     3) 图片从工作区读，不要求模型传 base64
     4) 路径写错、文件不是 PDF、扫描件，都要给人话，而不是抛异常

   运行：node tests/office-pdf-tool-test.mjs
   ============================================================ */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gz": "application/gzip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ""}`);
  }
};

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(String(req.url || "/").split("?")[0]);
    const file = join(ROOT, normalize(p === "/" ? "/index.html" : p).replace(/^(\.\.[/\\])+/, ""));
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});
await page.goto(ORIGIN, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

console.log("\n[1] 工具只在办公插件启用时出现");
{
  const info = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const t = await import("/scripts/tools.js");
    const pi = await import("/scripts/plugin-install.js");
    const before = t.availableToolNames();
    await pi.setPluginEnabled("office", false);
    const off = t.availableToolNames();
    await pi.setPluginEnabled("office", true);
    const on = t.availableToolNames();
    st.setSettings({ approval: "auto" });
    return { before, off, on };
  });
  check("启用时有 pdf_create", info.on.includes("pdf_create"));
  check("启用时有 pdf_read", info.on.includes("pdf_read"));
  check("关掉办公插件后没有", !info.off.includes("pdf_create") && !info.off.includes("pdf_read"));
  check("默认设置下就有", info.before.includes("pdf_create") && info.before.includes("pdf_read"));
}

console.log("\n[2] pdf_create 写出来的东西能被 pdf_read 读回来");
{
  const res = await page.evaluate(async () => {
    const t = await import("/scripts/tools.js");
    const out = await t.executeTool("pdf_create", {
      path: "exports/quarter.pdf",
      title: "季度分析",
      blocks: [
        { type: "h1", text: "第三季度经营分析" },
        { type: "p", text: "收入 **1.24 亿元**，同比增长 18.4%。" },
        { type: "bullets", items: ["华东 +22.1%", "华南 +19.6%"] },
        { type: "table", rows: [["区域", "收入"], ["华东", "4,820"], ["华南", "3,150"]] },
        { type: "pagebreak" },
        { type: "h2", text: "附：口径说明" },
        { type: "p", text: "收入为不含税口径。" },
      ],
    });
    return { ok: out.ok, output: out.output, export: out.export || null };
  });
  check("生成成功", res.ok === true, res.output.split("\n")[0]);
  check("报出页数", /2 页/.test(res.output), res.output.split("\n")[0]);
  check("带 export 元信息", !!res.export && res.export.path === "exports/quarter.pdf");

  const read = await page.evaluate(async () => {
    const t = await import("/scripts/tools.js");
    const st = await import("/scripts/store.js");
    const out = await t.executeTool("pdf_read", { path: "exports/quarter.pdf" });
    return { ok: out.ok, output: out.output, exists: !!st.listFiles().find((f) => f.path === "exports/quarter.pdf") };
  });
  check("文件真的在工作区", read.exists === true);
  check("读到标题", read.ok && read.output.includes("第三季度经营分析"));
  check("读到正文", read.output.includes("1.24 亿元") && read.output.includes("18.4%"));
  check("读到表格", read.output.includes("4,820"));
  check("读到第二页", read.output.includes("附：口径说明"));
  check("报出总页数", /2 页/.test(read.output));
}

console.log("\n[3] 图片从工作区读");
{
  const res = await page.evaluate(async (b64) => {
    const st = await import("/scripts/store.js");
    await st.writeBinaryFile("assets/chart.jpg", b64, "image/jpeg", 0);
    const t = await import("/scripts/tools.js");
    const out = await t.executeTool("pdf_create", {
      path: "exports/with-image.pdf",
      blocks: [{ type: "p", text: "下图是收入结构：" }, { type: "image", src: "assets/chart.jpg", caption: "图 1 收入结构" }],
    });
    return { ok: out.ok, output: out.output };
  }, readFileSync(new URL("./fixtures/chart.jpg", import.meta.url)).toString("base64"));
  check("带图生成成功", res.ok === true, res.output.split("\n")[0]);
  check("报告含 1 张图", /含 1 张图/.test(res.output));

  const read = await page.evaluate(async () => {
    const t = await import("/scripts/tools.js");
    const out = await t.executeTool("pdf_read", { path: "exports/with-image.pdf" });
    return out.output;
  });
  check("图注可读", read.includes("图 1 收入结构"));
}

console.log("\n[4] 出错时说人话");
{
  const a = await page.evaluate(async () => {
    const t = await import("/scripts/tools.js");
    return (await t.executeTool("pdf_read", { path: "nope.pdf" })).output;
  });
  check("文件不存在有提示", /不存在/.test(a), a.slice(0, 40));

  const b = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    await st.writeFile("drafts/note.md", "# 这不是 PDF\n");
    const t = await import("/scripts/tools.js");
    return (await t.executeTool("pdf_read", { path: "drafts/note.md" })).output;
  });
  check("拿文本冒充 PDF 会说清楚", /不是 PDF/.test(b), b.slice(0, 40));

  const c = await page.evaluate(async () => {
    const t = await import("/scripts/tools.js");
    return (await t.executeTool("pdf_create", { path: "exports/empty.pdf" })).output;
  });
  check("没内容时报错", /没有内容/.test(c), c.slice(0, 40));

  const d = await page.evaluate(async () => {
    const t = await import("/scripts/tools.js");
    return (await t.executeTool("pdf_create", { path: "exports/x.txt", markdown: "hi" })).output;
  });
  check("后缀不是 pdf 时提示", /\.pdf/.test(d), d.slice(0, 40));

  const e = await page.evaluate(async (b64) => {
    const st = await import("/scripts/store.js");
    await st.writeBinaryFile("assets/scan.pdf", b64, "application/pdf", 0);
    const t = await import("/scripts/tools.js");
    return (await t.executeTool("pdf_read", { path: "assets/scan.pdf" })).output;
  }, readFileSync(new URL("./fixtures/scanned.pdf", import.meta.url)).toString("base64"));
  check("扫描件说明需要 OCR", /OCR|扫描/.test(e), e.split("\n").slice(0, 2).join(" / "));
}

console.log("\n[5] 页面无报错");
check("没有未捕获异常", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
server.close();
console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
