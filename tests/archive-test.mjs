#!/usr/bin/env node
/* ============================================================
   压缩包：解压 / 读条目 / 空目录 / 路径提示

   起点是用户截图里那条真实的失败链：
     mkdir -p onetake_pkg && cd onetake_pkg && unzip ../uploads/onetake-skill.zip >/dev/null 2>&1; ls
     → onetake_pkg/ 下没有文件
     fs_read uploads/onetake-skill.zip/onetake/安装说明.md   → 文件不存在
     fs_inspect pkg                                          → 文件不存在

   根因不是模型笨：`unzip` 只实现了 -l 列表，却对 `unzip x.zip` 也返回
   ok:true。命令既不干活也不报错，模型只能按「解压成功了」往下走，
   接着去 ls 空目录、把 zip 当目录拼路径。

   这里按真实命令逐条验证修复：真解压、-d、只读、zip slip、
   fs_read("包!条目")、空目录不算失败、错误信息带 shell 目录。
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

/* ---------- 最小 zip 构造器（store 模式，不压缩） ----------
   不依赖系统 zip 命令，测试自带夹具；也能精确造出 `../` 这种恶意条目。
   我们的解包器不校验 CRC，这里 crc 填 0。 */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lh.writeUInt16LE(0, 8); // method: store
    lh.writeUInt32LE(0, 10); // time + date
    lh.writeUInt32LE(0, 14); // crc
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(0, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082",
  "hex"
);

const pkg = makeZip([
  { name: "onetake/", data: "" },
  { name: "onetake/skills/", data: "" },
  { name: "onetake/安装说明.md", data: "# 安装说明\n\n把 onetake 目录放进 plugins。\n" },
  { name: "onetake/README.md", data: "# onetake\n\nA plugin.\n" },
  { name: "onetake/package.json", data: '{"name":"onetake","version":"1.0.0","main":"main.js"}\n' },
  { name: "onetake/main.js", data: "export default {};\n" },
  { name: "onetake/icon.png", data: PNG },
]);

// 恶意包：条目想跳出解压目录
const evil = makeZip([
  { name: "../escaped.txt", data: "SHOULD-NOT-WRITE\n" },
  { name: "/abs.txt", data: "SHOULD-NOT-WRITE\n" },
  { name: "safe/ok.txt", data: "OK\n" },
]);

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

await page.evaluate(
  async ([p, e]) => {
    const st = await import("./scripts/store.js");
    await st.writeBinaryFile("uploads/onetake-skill.zip", p);
    await st.writeBinaryFile("uploads/evil.zip", e);
    await st.writeFile("README.md", "root readme\n");
    window.__tools = await import("./scripts/tools.js");
    window.__st = st;
  },
  [pkg.toString("base64"), evil.toString("base64")]
);

const run = (command) =>
  page.evaluate(async (cmd) => {
    const r = await window.__tools.TOOLS.shell.run({ command: cmd });
    return { ok: r.ok, output: String(r.output || "") };
  }, command);
const tool = (name, args) =>
  page.evaluate(
    async ([n, a]) => {
      const r = await window.__tools.TOOLS[n].run(a);
      return { ok: r.ok, output: String(r.output || "") };
    },
    [name, args]
  );
const exists = (p) =>
  page.evaluate(async (path) => {
    const f = await window.__st.readFile(path);
    return f ? String(f.content ?? "") : null;
  }, p);
const top = (n) => n; // 只是让判据读起来清楚

/* ---------- ① unzip 真的解压 ---------- */

const original = await run("cd /; rm -rf onetake_pkg; mkdir -p onetake_pkg && cd onetake_pkg && unzip ../uploads/onetake-skill.zip > /dev/null 2>&1; ls");
check("截图里的原始命令现在能解出文件", original.ok && original.output.includes("onetake/安装说明.md"), original.output.slice(0, 80));

const md = await exists("onetake_pkg/onetake/安装说明.md");
check("解压出来的文本内容正确", md === "# 安装说明\n\n把 onetake 目录放进 plugins。\n", JSON.stringify(md));

const readme = await exists("onetake_pkg/onetake/README.md");
check("同包多文件都落盘", readme === "# onetake\n\nA plugin.\n", JSON.stringify(readme));

const pngInfo = await run("file onetake_pkg/onetake/icon.png");
check("二进制条目按字节写出（不是当文本）", pngInfo.output.includes("PNG"), pngInfo.output);

const catIt = await run("cd /; cat onetake_pkg/onetake/main.js");
check("解压出的文件能被 cat 当文本读", catIt.ok && catIt.output === "export default {};\n", JSON.stringify(catIt.output));

/* ---------- ② -l 仍然只列表，且说明没落盘 ---------- */

const listed = await run("cd /; unzip -l uploads/onetake-skill.zip");
check("-l 仍只列条目", listed.ok && listed.output.includes("onetake/安装说明.md"), "");
check("-l 明确说明条目还没落盘", listed.output.includes("还没有落盘") && listed.output.includes("unzip "), "");
const listedOnly = await exists("onetake/安装说明.md");
check("-l 不会偷偷往工作区写文件", listedOnly === null, String(listedOnly));

/* ---------- ③ -d 指定目录 / 覆盖计数 ---------- */

const toDest = await run("cd /; rm -rf out2; unzip uploads/onetake-skill.zip -d out2");
check("-d 能指定解压目录", toDest.ok && toDest.output.includes("out2/onetake/"), toDest.output.split("\n")[0]);
check("-d 后文件确实在目标目录", (await exists("out2/onetake/package.json")) !== null, "");

const again = await run("cd /; unzip uploads/onetake-skill.zip -d out2");
check("重复解压会如实报告覆盖数量", again.ok && again.output.includes("覆盖 5 个"), again.output.split("\n")[0]);

/* ---------- ④ zip slip ---------- */

const slip = await run("cd /; rm -rf safe_dir; unzip uploads/evil.zip -d safe_dir");
check("zip slip：解压成功但跳过不安全条目", slip.ok && slip.output.includes("跳过 2 个"), slip.output.split("\n")[0]);
check("zip slip：没有写到上级目录", (await exists("escaped.txt")) === null, String(await exists("escaped.txt")));
check("zip slip：绝对路径条目也没写出去", (await exists("abs.txt")) === null, String(await exists("abs.txt")));
check("zip slip：正常条目照常解出", (await exists("safe_dir/safe/ok.txt")) === "OK\n", String(await exists("safe_dir/safe/ok.txt")));

/* ---------- ⑤ 只读权限 ---------- */

const ro = await page.evaluate(async () => {
  const st = await import("./scripts/store.js");
  st.setSettings({ permission: "readonly" });
  const r = await window.__tools.TOOLS.shell.run({ command: "unzip uploads/onetake-skill.zip -d ro_dir" });
  st.setSettings({ permission: "auto" });
  return { ok: r.ok, output: String(r.output || "") };
});
check("只读权限下解压被拒绝并说明", !ro.ok && ro.output.includes("只读"), ro.output);
check("只读权限下没有写文件", (await exists("ro_dir/onetake/README.md")) === null, "");

/* ---------- ⑥ fs_read 直接读包内条目 ---------- */

const bang = await tool("fs_read", { path: "uploads/onetake-skill.zip!onetake/安装说明.md" });
check("fs_read 用 包!条目 读到内容", bang.ok && bang.output.includes("把 onetake 目录放进 plugins"), bang.output.slice(0, 60));

const slash = await tool("fs_read", { path: "uploads/onetake-skill.zip/onetake/README.md" });
check("fs_read 用 包/条目 也能读（模型最常写的形状）", slash.ok && slash.output.includes("A plugin"), slash.output.slice(0, 60));

const miss = await tool("fs_read", { path: "uploads/onetake-skill.zip!onetake/不存在.md" });
check("条目写错时列出包内文件", !miss.ok && miss.output.includes("包内共 5 个文件") && miss.output.includes("onetake/main.js"), miss.output.split("\n")[0]);

const binEntry = await tool("fs_inspect", { path: "uploads/onetake-skill.zip!onetake/icon.png" });
check("fs_inspect 能看包内二进制条目", binEntry.ok && binEntry.output.includes("PNG"), binEntry.output.split("\n")[1]);

/* ---------- ⑦ 空目录不是失败 ---------- */

const emptyLs = await run("cd /; mkdir -p empty_dir && ls empty_dir");
check("ls 空目录返回成功（不再计入工具失败）", emptyLs.ok, JSON.stringify(emptyLs.output));
check("ls 空目录会列出附近有什么", emptyLs.output.includes("现有顶层"), emptyLs.output.replace(/\n/g, " | "));

/* ---------- ⑧ 错误信息带上 shell 目录与类型标记 ---------- */

const cwdHint = await run("cd /; cd onetake_pkg");
check("先进入解压目录", cwdHint.ok, "");
const missByCwd = await tool("fs_inspect", { path: "pkg" });
check("fs_* 找不到时说明当前 shell 目录", missByCwd.output.includes("当前 shell 目录是 onetake_pkg/"), missByCwd.output.split("\n")[1] || "");
check("可用文件里标注压缩包", missByCwd.output.includes("[压缩包]"), "");
const zipAsDir = await tool("fs_read", { path: "uploads/onetake-skill.zip/会诊.md" });
check(
  "把 zip 当目录时，直接按包内条目处理并列出包内文件",
  !zipAsDir.ok && zipAsDir.output.includes("没有条目") && zipAsDir.output.includes("fs_read(path=\"uploads/onetake-skill.zip!条目名\")"),
  zipAsDir.output.split("\n")[0]
);

/* ---------- ⑨ 不存在的包 ---------- */

const noSuch = await run("cd /; unzip uploads/nope.zip");
check("包不存在时报错并给候选", !noSuch.ok && noSuch.output.includes("文件不存在"), noSuch.output.split("\n")[0]);

console.log(`\n${fail ? "✗" : "✓"} ${fail ? `${fail} 项失败` : "全部通过"}（通过 ${pass}）`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
