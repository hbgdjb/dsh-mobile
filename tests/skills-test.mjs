#!/usr/bin/env node
/* ============================================================
   技能包：安装 / 列出 / 读取 / 分页 / 覆盖

   起点是用户截图：他把 onetake 的 SKILL.md 包传上来，让模型装。
   模型翻完给了三条结论，每条都对：

     包内没有 plugin.json     → DSH 插件格式不匹配
     工作区内没有 skills 目录 → 没地方装
     需要 python3 + playwright → 跑不起来

   结论对，但用户要的是"装上"。技能包不是 npm 插件，它只需要一份
   SKILL.md。这一版把它当成一等公民，这里逐条验证：

     · 从 .zip 装（最常见的入口）
     · 从已解压目录装（模型常先 unzip 再装）
     · 没有 SKILL.md 时，错误里要说清"这不是技能包"
     · 重名加后缀、force 覆盖
     · skill_read 读 SKILL.md 与引用文件，长文分页
     · 系统提示里出现技能清单（否则模型不知道装过）
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

/* ---------- 最小 zip 构造器（store 模式） ---------- */
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
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(0, 14);
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

const SKILL_MD = `---
name: onetake
version: "1.2.0"
license: MIT
metadata:
  author: someone
description: "把产品做成 15 秒动效短片：动效字、真实界面、一镜到底。"
---

# onetake

先读 references/rhythm.md，再写 composition.html。

渲染：\`python3 scripts/render.py\`
`;

const LONG_MD = `---
name: long-skill
description: 一个很长的技能说明，用来验证分页。
---

${"段落内容。".repeat(1400)}
`;
// 1400 × 5 字 ≈ 7000 字符，超过默认 6000 的单页上限

const zip = makeZip([
  { name: "onetake/SKILL.md", data: SKILL_MD },
  { name: "onetake/references/rhythm.md", data: "# 节奏\n每 4 拍一个重音。\n" },
  { name: "onetake/scripts/render.py", data: "print('hi')\n" },
  { name: "onetake/assets/logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
]);

const longZip = makeZip([
  { name: "long-skill/SKILL.md", data: LONG_MD },
  { name: "long-skill/references/a.md", data: "a\n" },
]);

const noSkillZip = makeZip([
  { name: "pkg/package.json", data: '{"name":"x"}' },
  { name: "pkg/index.js", data: "module.exports = {};\n" },
]);

/* ---------- 起服务 ---------- */
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
  async ([z, lz, nz]) => {
    const st = await import("./scripts/store.js");
    await st.writeBinaryFile("uploads/onetake-skill.zip", z, "application/zip", 4096);
    await st.writeBinaryFile("uploads/long-skill.zip", lz, "application/zip", 8192);
    await st.writeBinaryFile("uploads/plain-pkg.zip", nz, "application/zip", 2048);
    window.__tools = await import("./scripts/tools.js");
    window.__store = st;
  },
  [zip.toString("base64"), longZip.toString("base64"), noSkillZip.toString("base64")]
);

const call = (name, args) =>
  page.evaluate(
    async ([n, a]) => {
      const r = await window.__tools.TOOLS[n].run(a);
      return { ok: r.ok, output: String(r.output || "") };
    },
    [name, args]
  );

/* ---------------- 一、从 zip 安装 ---------------- */
console.log("\n从 zip 安装\n");

const a = await call("skill_install", { source: "uploads/onetake-skill.zip" });
check("装成功", a.ok, a.output.split("\n")[0]);
check("id 取自 frontmatter 的 name", a.output.includes("skills/onetake/"), a.output.split("\n")[0]);
check("文件数是 4 个（不含内部的 .dsh-skill.json）", a.output.includes("4 个文件"), a.output.split("\n")[0]);
check("说明了入口是 SKILL.md", a.output.includes("skill_read(id=\"onetake\")"), a.output);
check("提到了包内的 references", a.output.includes("references/rhythm.md"), a.output);

const files = await page.evaluate(() =>
  window.__store.listFiles().map((f) => f.path).filter((p) => p.startsWith("skills/onetake/"))
);
check("落盘路径在 skills/onetake/ 下", files.includes("skills/onetake/SKILL.md"), files.join(", "));
check("条目路径剥掉了顶层 onetake/", files.includes("skills/onetake/references/rhythm.md"));
check("二进制也写出来了", files.includes("skills/onetake/assets/logo.png"));
check("写了元数据", files.includes("skills/onetake/.dsh-skill.json"));

/* ---------------- 二、列出 ---------------- */
console.log("\n列出\n");

const l = await call("skill_list", {});
check("skill_list 有 onetake", l.ok && l.output.includes("onetake"), l.output);
check("带了 description 摘要", l.output.includes("动效短片"), l.output);
check("name 与 id 相同时不重复显示", !/onetake（onetake）/.test(l.output), l.output);

/* ---------------- 三、读取 ---------------- */
console.log("\n读取\n");

const r = await call("skill_read", { id: "onetake" });
check("默认读 SKILL.md", r.ok && r.output.includes("# onetake"), r.output.slice(0, 80));
check("保留 frontmatter（模型要看 name/description）", r.output.includes("name: onetake"));
check("头部标了总字符数", /共 \d+ 字符/.test(r.output), r.output.split("\n")[0]);

const ref = await call("skill_read", { id: "onetake", path: "references/rhythm.md" });
check("能读引用文件", ref.ok && ref.output.includes("每 4 拍一个重音"), ref.output.slice(0, 80));

const bin = await call("skill_read", { id: "onetake", path: "assets/logo.png" });
check("二进制不硬读，给 hex 的替代", !bin.ok && bin.output.includes('format="hex"'), bin.output);

const trav = await call("skill_read", { id: "onetake", path: "../uploads/onetake-skill.zip" });
check("拒绝 .. 越界", !trav.ok && trav.output.includes("相对路径"), trav.output);

const miss = await call("skill_read", { id: "onetake", path: "references/nope.md" });
check("读错路径时列出这个技能的真实文件", !miss.ok && miss.output.includes("references/rhythm.md"), miss.output.slice(0, 120));

const noSkill = await call("skill_read", { id: "nope" });
check("没有这个技能时指向 skill_list", !noSkill.ok && noSkill.output.includes("skill_list"), noSkill.output);

/* ---------------- 四、长文分页 ---------------- */
console.log("\n分页\n");

await call("skill_install", { source: "uploads/long-skill.zip" });
const p1 = await call("skill_read", { id: "long-skill", limit: 1000 });
check("第一页只给 limit 个字符", p1.ok && p1.output.includes("本次 0–1000"), p1.output.split("\n")[0]);
check("末尾给下一页的 offset", /offset=1000/.test(p1.output), p1.output.slice(-120));
check("说明还剩多少字符", /还有 \d+ 字符/.test(p1.output));

const p2 = await call("skill_read", { id: "long-skill", offset: 1000, limit: 1000 });
check("第二页从 offset 开始", p2.ok && p2.output.includes("本次 1000–2000"), p2.output.split("\n")[0]);

const over = await call("skill_read", { id: "long-skill", offset: 999999 });
check("offset 越界如实报错", !over.ok && over.output.includes("超出文件长度"), over.output);

/* ---------------- 五、重复安装与覆盖 ---------------- */
console.log("\n重复安装\n");

const dup = await call("skill_install", { source: "uploads/onetake-skill.zip" });
check("重名时自动加后缀，不静默覆盖", dup.ok && dup.output.includes("skills/onetake-2/"), dup.output.split("\n")[0]);

const before = await page.evaluate(() => window.__store.state.skills.length);
const forced = await call("skill_install", { source: "uploads/onetake-skill.zip", force: true });
check("force 覆盖回原 id", forced.ok && forced.output.includes("skills/onetake/"), forced.output.split("\n")[0]);
const after = await page.evaluate(() => window.__store.state.skills.length);
check("覆盖不会在 state 里留下重复条目", after === before, `${before} → ${after}`);

/* ---------------- 六、不是技能包 ---------------- */
console.log("\n不是技能包\n");

const bad = await call("skill_install", { source: "uploads/plain-pkg.zip" });
check("没有 SKILL.md 时安装失败", !bad.ok, bad.output);
check("说清了技能包的形状", bad.output.includes("SKILL.md") && bad.output.includes("references/"), bad.output);
check("顺带区分 JS 插件（需要 package.json）", bad.output.includes("package.json") || bad.output.includes("插件页"), bad.output);

const ghost = await call("skill_install", { source: "uploads/nope.zip" });
check("源不存在时给可操作提示", !ghost.ok && ghost.output.includes("找不到"), ghost.output);

/* ---------------- 七、从已解压目录安装 ---------------- */
console.log("\n从目录安装\n");

const unz = await page.evaluate(async () => {
  const r = await window.__tools.TOOLS.shell.run({ command: "mkdir -p pkg && cd pkg && unzip ../uploads/onetake-skill.zip" });
  return { ok: r.ok, output: String(r.output || "") };
});
check("先解压到 pkg/", unz.ok && unz.output.includes("已解压"), unz.output.split("\n")[0]);

const dir = await call("skill_install", { source: "pkg/onetake", id: "onetake-dir" });
check("从目录装成功", dir.ok, dir.output.split("\n")[0]);
check("装到指定的 id", dir.output.includes("skills/onetake-dir/"), dir.output.split("\n")[0]);

/* ---------------- 八、系统提示里能看到 ---------------- */
console.log("\n系统提示\n");

const prompt = await page.evaluate(async () => {
  const pr = await import("./scripts/prompt.js");
  const st = window.__store;
  return pr.buildSystemPromptText({
    skills: st.state.skills,
    files: st.listFiles(),
    mode: { name: "标准" },
    permission: "工作区写入",
    reasoning: "high",
    now: "",
  }).text;
});
check("提示词里有【已装技能】", prompt.includes("【已装技能】"), prompt.slice(0, 200));
check("列了技能 id 与说明", prompt.includes("onetake") && prompt.includes("动效短片"));
check("告诉模型用 skill_read 读全文", prompt.includes("skill_read"));

/* ---------------- 九、跨会话可见 ---------------- */
// 技能是"装一次，所有会话可用"。如果 skills/ 落进会话私有区，
// 在 A 装完切到 B，state.skills 里还有这一条、skill_read 却读不到文件 ——
// 列表里有、读出来是空，是最难查的那种不一致。
console.log("\n跨会话\n");

const cross = await page.evaluate(async () => {
  const st = window.__store;
  const old = st.state.activeSessionId;
  st.state.activeSessionId = "s_another_session";
  const r = await window.__tools.TOOLS.skill_read.run({ id: "onetake" });
  const files = st.listFiles().filter((f) => f.path.startsWith("skills/onetake/")).length;
  st.state.activeSessionId = old;
  return { ok: r.ok, chars: String(r.output || "").length, files };
});
check("换一个会话仍能读到技能", cross.ok && cross.chars > 100, JSON.stringify(cross));
check("文件也还在（skills/ 是共享目录）", cross.files > 0, `files=${cross.files}`);

/* ---------------- 十、走真实执行链路（含审批） ---------------- */
// 前面的用例都直接调 TOOLS.skill_install.run，绕过了审批与超时。
// 真正跑起来是 executeTool：sensitive 工具先过 decideApproval。
console.log("\n执行链路\n");

const exec = await page.evaluate(async () => {
  const t = await import("./scripts/tools.js");
  const okRun = await t.executeTool(
    "skill_install",
    { source: "uploads/onetake-skill.zip", id: "onetake-exec" },
    { requestApproval: async () => true }
  );
  const denied = await t.executeTool(
    "skill_install",
    { source: "uploads/onetake-skill.zip", id: "onetake-denied" },
    { requestApproval: async () => false }
  );
  const noChannel = await t.executeTool("skill_install", { source: "uploads/onetake-skill.zip", id: "onetake-bg" });
  return {
    okRun: { ok: okRun.ok, status: okRun.status, head: String(okRun.output || "").split("\n")[0] },
    denied: { ok: denied.ok, status: denied.status },
    noChannel: { ok: noChannel.ok, status: noChannel.status },
  };
});
check("审批放行后真的装上", exec.okRun.ok && exec.okRun.status === "done", JSON.stringify(exec.okRun));
check("用户拒绝则不装", !exec.denied.ok && exec.denied.status === "denied", JSON.stringify(exec.denied));
check("没有审批通道时跳过而不是静默放行", !exec.noChannel.ok && exec.noChannel.status === "denied", JSON.stringify(exec.noChannel));

/* ---------------- 十一、只读权限 ---------------- */
console.log("\n只读\n");

const ro = await page.evaluate(async () => {
  const st = await window.__store;
  const old = st.state.settings.permission;
  st.state.settings.permission = "readonly";
  const r = await window.__tools.TOOLS.skill_install.run({ source: "uploads/onetake-skill.zip" });
  st.state.settings.permission = old;
  return { ok: r.ok, output: String(r.output || "") };
});
check("只读权限下拒绝安装", !ro.ok && ro.output.includes("只读"), ro.output);

/* ---------------- 收尾 ---------------- */
await browser.close();
server.close();

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
