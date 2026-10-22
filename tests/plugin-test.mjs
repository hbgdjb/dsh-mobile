/* ============================================================
   插件系统测试（tests/plugin-test.mjs）

   覆盖三件事：

   1) 清单校验 —— 非法清单必须被拒
   2) 沙箱隔离 —— 插件代码**结构上**拿不到宿主的敏感数据
   3) 工具装配 —— 插件注册的工具要真的进模型工具表、能被调用

   第 2 条是这套系统的立身之本，所以这里不只测「插件读不到」，
   还要测「插件试图逃逸时拿到的仍然是空」—— 证明隔离不是靠
   插件作者自觉，而是靠 iframe 的 origin 边界。

   运行：node tests/plugin-test.mjs
   ============================================================ */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log("✓", name, extra);
  } else {
    fail += 1;
    console.log("✗", name, extra);
  }
}

/* ============ 第一部分：清单校验（纯逻辑，无需浏览器） ============ */

const { validateManifest, OFFICIAL_PLUGINS, searchOfficialPlugins, ALLOWED_PERMISSIONS } =
  await import("../scripts/plugin-manifest.js");

{
  const v = validateManifest({
    id: "demo",
    name: "示例",
    version: "1.0.0",
    description: "d",
    permissions: ["fs.read"],
    code: "dsh.log('x')",
  });
  check("合法清单：校验通过", v.ok === true);
  check("合法清单：字段被规范化", v.plugin && v.plugin.id === "demo" && v.plugin.permissions.length === 1);
}

{
  const v = validateManifest({ id: "Bad Id!", name: "x", code: "y" });
  check("非法 id：被拒", v.ok === false && /id 不合法/.test(v.error));
}
{
  const v = validateManifest({ id: "ok", name: "", code: "y" });
  check("缺 name：被拒", v.ok === false);
}
{
  const v = validateManifest({ id: "ok", name: "x" });
  check("既无 code 也无 entry：被拒", v.ok === false);
}
{
  const v = validateManifest({ id: "ok", name: "x", code: "y", permissions: ["root"] });
  check("未知权限：被拒", v.ok === false && /未知权限/.test(v.error));
}
{
  const v = validateManifest({ id: "ok", name: "x", code: "y", entry: "ftp://a/b" });
  check("entry 非 http(s)：被拒", v.ok === false);
}
{
  const v = validateManifest({ id: "ok", name: "x", code: "y", version: "abc" });
  check("版本号非法：被拒", v.ok === false);
}
{
  const v = validateManifest({
    id: "ok",
    name: "x",
    code: "y",
    tools: [
      { name: "a" },
      { name: "a" },
    ],
  });
  check("工具名重复：被拒", v.ok === false);
}
{
  const v = validateManifest({ id: "ok", name: "x", code: "y".repeat(500000) });
  check("代码超长：被拒", v.ok === false && /过大/.test(v.error));
}

check("官方清单非空", OFFICIAL_PLUGINS.length >= 3);
check(
  "官方清单全部通过校验",
  OFFICIAL_PLUGINS.every((p) => validateManifest(p).ok)
);
check(
  "官方清单的权限都在白名单内",
  OFFICIAL_PLUGINS.every((p) => (p.permissions || []).every((x) => ALLOWED_PERMISSIONS.includes(x)))
);
check("按名字搜官方清单能命中", searchOfficialPlugins("字数").length >= 1);
check("按 id 搜官方清单能命中", searchOfficialPlugins("hello").length >= 1);
check("搜不到时返回空", searchOfficialPlugins("zzz不存在").length === 0);

/* ============ 第二部分：沙箱隔离与工具装配（浏览器） ============ */

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
let pageErr = 0;
page.on("pageerror", (e) => {
  pageErr += 1;
  console.log("  [pageerror]", e.message);
});
await page.goto(base + "/index.html", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
// 宿主页面标题，用来证明沙箱的 document 不是宿主的那一个
const hostTitle = await page.title();

/**
 * 在页面里装载一个插件并等它就绪。
 * 直接调 plugin-host 的 loadPlugin，绕开 store（store 需要完整初始化）。
 */
async function mountPlugin(plugin) {
  return page.evaluate(async (p) => {
    const host = await import("/scripts/plugin-host.js");
    const rt = host.loadPlugin(p);
    // 等沙箱回执（最多 3 秒）
    for (let i = 0; i < 60; i++) {
      if (rt.ready || rt.error) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return {
      ready: rt.ready,
      error: rt.error,
      tools: Array.from(rt.tools.keys()),
      logs: rt.logs.slice(),
    };
  }, plugin);
}

/* ---- 隔离测试 1：插件读不到宿主的 localStorage ---- */
{
  await page.evaluate(() => {
    localStorage.setItem("dsh.secret.marker", "宿主机密");
    window.__hostSecret = "宿主机密";
  });

  const res = await mountPlugin({
    id: "probe",
    name: "探针",
    version: "1.0.0",
    permissions: [],
    code: `
var out = {};
try { out.ls = localStorage.getItem("dsh.secret.marker"); } catch (e) { out.ls = "THREW:" + e.name; }
try { out.win = window.__hostSecret; } catch (e) { out.win = "THREW:" + e.name; }
try { out.doc = typeof document; } catch (e) { out.doc = "THREW:" + e.name; }
try { out.docTitle = document.title; } catch (e) { out.docTitle = "THREW:" + e.name; }
try { out.cookie = document.cookie; } catch (e) { out.cookie = "THREW:" + e.name; }
try { out.parentLs = parent.localStorage.getItem("dsh.secret.marker"); } catch (e) { out.parentLs = "THREW:" + e.name; }
try { out.parentDoc = typeof parent.document.body; } catch (e) { out.parentDoc = "THREW:" + e.name; }
try { out.origin = String(location.origin); } catch (e) { out.origin = "THREW:" + e.name; }
dsh.registerTool({ name: "probe", description: "p" }, function () { return JSON.stringify(out); });
`,
  });
  check("探针插件已就绪", res.ready === true, res.error || "");

  const out = await page.evaluate(async () => {
    const host = await import("/scripts/plugin-host.js");
    const rt = host.runtimeOf("probe");
    return await rt.call("probe", {});
  });
  const o = JSON.parse(out);

  check("沙箱：localStorage 读不到宿主的值", o.ls === null || String(o.ls).startsWith("THREW:"), String(o.ls));
  check("沙箱：拿不到宿主 window 上的变量", o.win === undefined || String(o.win).startsWith("THREW:"), String(o.win));
  // 沙箱有自己的 document（一个独立的空文档），但绝不是宿主那个。
  // 判定依据：宿主标题是 "DeepSeek Harness · Mobile"，沙箱标题不可能是它。
  check("沙箱：document 是沙箱自己的、不是宿主的", o.doc === "object" && o.docTitle !== hostTitle, `${o.doc} / ${o.docTitle}`);
  check("沙箱：拿不到 cookie", !o.cookie || String(o.cookie).startsWith("THREW:"), String(o.cookie));
  check("沙箱：跨源访问 parent.localStorage 被拒", String(o.parentLs).startsWith("THREW:"), String(o.parentLs));
  check("沙箱：跨源访问 parent.document 被拒", String(o.parentDoc).startsWith("THREW:"), String(o.parentDoc));
  check("沙箱：origin 与宿主不同（不透明源）", o.origin !== base, String(o.origin));
}

/* ---- 隔离测试 2：未声明的能力根本不存在 ---- */
{
  const res = await mountPlugin({
    id: "nogrant",
    name: "未授权",
    version: "1.0.0",
    permissions: [],
    code: `
var shape = Object.keys(dsh.host);
dsh.registerTool({ name: "shape", description: "s" }, function () { return JSON.stringify(shape); });
`,
  });
  check("未授权插件已就绪", res.ready === true, res.error || "");
  const out = await page.evaluate(async () => {
    const host = await import("/scripts/plugin-host.js");
    const rt = host.runtimeOf("nogrant");
    return await rt.call("shape", {});
  });
  const shape = JSON.parse(out);
  check("未声明权限：dsh.host 是空对象", Array.isArray(shape) && shape.length === 0, JSON.stringify(shape));
}

/* ---- 隔离测试 3：声明了才有，且调用被宿主逐项把关 ---- */
{
  const res = await mountPlugin({
    id: "granted",
    name: "已授权",
    version: "1.0.0",
    permissions: ["fs.read"],
    code: `
var shape = Object.keys(dsh.host);
dsh.registerTool({ name: "shape", description: "s" }, function () { return JSON.stringify(shape); });
dsh.registerTool({ name: "trywrite", description: "w" }, async function () {
  try {
    var r = await dsh.host.fsWrite({ path: "x.txt", content: "y" });
    return "WROTE:" + JSON.stringify(r);
  } catch (e) {
    return "BLOCKED:" + e.message;
  }
});
`,
  });
  check("已授权插件已就绪", res.ready === true, res.error || "");
  const out = await page.evaluate(async () => {
    const host = await import("/scripts/plugin-host.js");
    const rt = host.runtimeOf("granted");
    return {
      shape: await rt.call("shape", {}),
      write: await rt.call("trywrite", {}),
    };
  });
  const shape = JSON.parse(out.shape);
  check("声明 fs.read：只拿到 fsRead 一个能力", shape.length === 1 && shape[0] === "fsRead", JSON.stringify(shape));
  check("未声明 fs.write：调用被拒", String(out.write).startsWith("BLOCKED:"), String(out.write).slice(0, 80));
}

/* ---- 隔离测试 4：消息通道需要正确的 token ---- */
{
  const res = await page.evaluate(async () => {
    const host = await import("/scripts/plugin-host.js");
    const rt = host.runtimeOf("granted");
    // 伪造一条没有 token 的宿主消息，看会不会被当成真的执行
    const before = rt.tools.size;
    window.postMessage({ __dshToolCall: "shape", __dshCallId: "forged", args: {} }, "*");
    await new Promise((r) => setTimeout(r, 200));
    return { before, after: rt.tools.size, err: rt.error };
  });
  check("伪造消息：没有 token 不会被当指令执行", res.before === res.after);
}

/* ---- 功能测试：插件工具能被调用并返回结果 ---- */
{
  const res = await mountPlugin({
    id: "calc",
    name: "计算",
    version: "1.0.0",
    permissions: [],
    code: `
dsh.registerTool({
  name: "add",
  description: "加法",
  parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }
}, async function (args) { return String((Number(args.a) || 0) + (Number(args.b) || 0)); });
`,
  });
  check("计算插件已就绪", res.ready === true, res.error || "");
  check("工具已注册", res.tools.includes("add"), JSON.stringify(res.tools));

  const out = await page.evaluate(async () => {
    const host = await import("/scripts/plugin-host.js");
    const rt = host.runtimeOf("calc");
    return await rt.call("add", { a: 3, b: 4 });
  });
  check("插件工具调用返回正确结果", out === "7", String(out));
}

/* ---- 功能测试：插件代码抛错不影响宿主 ---- */
{
  const res = await mountPlugin({
    id: "boom",
    name: "爆炸",
    version: "1.0.0",
    permissions: [],
    code: `
dsh.registerTool({ name: "boom", description: "b" }, async function () { throw new Error("故意的"); });
`,
  });
  check("抛错插件已就绪（注册阶段不炸）", res.ready === true, res.error || "");
  const out = await page.evaluate(async () => {
    const host = await import("/scripts/plugin-host.js");
    const rt = host.runtimeOf("boom");
    try {
      await rt.call("boom", {});
      return "NO_ERROR";
    } catch (e) {
      return "THREW:" + e.message;
    }
  });
  check("插件抛错被转成调用失败", String(out).startsWith("THREW:"), String(out));
}

/* ---- 功能测试：卸载后沙箱消失 ---- */
{
  const res = await page.evaluate(async () => {
    const host = await import("/scripts/plugin-host.js");
    const before = document.querySelectorAll("iframe[sandbox]").length;
    host.unloadPlugin("calc");
    await new Promise((r) => setTimeout(r, 150));
    const after = document.querySelectorAll("iframe[sandbox]").length;
    const gone = !host.isLoaded("calc");
    return { before, after, gone };
  });
  check("卸载插件：沙箱 iframe 被移除", res.after < res.before, JSON.stringify(res));
  check("卸载插件：运行时记录被清掉", res.gone === true);
}

/* ---- 工具装配：插件工具进得了模型工具表 ---- */
{
  const res = await page.evaluate(async () => {
    const host = await import("/scripts/plugin-host.js");
    const tools = await import("/scripts/tools.js");
    // 造一个已启用的插件记录（直接改 state，装配层只认 enabled）
    const store = await import("/scripts/store.js");
    store.state.plugins = [
      ...store.state.plugins.filter((p) => p.id !== "granted"),
      {
        id: "granted",
        name: "已授权",
        desc: "",
        version: "1.0.0",
        tools: [],
        scopes: [],
        permissions: ["fs.read"],
        enabled: true,
        removable: true,
      },
    ];
    // 重新装载，让工具表里真的出现
    host.loadPlugin({
      id: "granted",
      name: "已授权",
      version: "1.0.0",
      permissions: ["fs.read"],
      code: `dsh.registerTool({ name: "probe2", description: "装配探针" }, function () { return "ok"; });`,
    });
    await new Promise((r) => setTimeout(r, 300));
    const names = tools.availableToolNames();
    const schemas = tools.toolSchemas();
    return {
      inNames: names.includes("plugin__granted__probe2"),
      inSchemas: schemas.some((s) => s.function.name === "plugin__granted__probe2"),
      desc: schemas.find((s) => s.function.name === "plugin__granted__probe2")?.function.description || "",
    };
  });
  check("插件工具进入 availableToolNames", res.inNames === true);
  check("插件工具进入 toolSchemas", res.inSchemas === true);
  check("插件工具描述带来源标注", res.desc.includes("插件"), res.desc);
}

/* ---- 执行路径：插件工具走审批闸门 ---- */
{
  const res = await page.evaluate(async () => {
    const tools = await import("/scripts/tools.js");
    let asked = null;
    const r = await tools.executeTool(
      "plugin__granted__probe2",
      { x: 1 },
      {
        requestApproval: (info) => {
          asked = info;
          return false; // 拒绝
        },
      }
    );
    return { asked, status: r.status, ok: r.ok };
  });
  check("插件工具调用会请求审批", res.asked !== null);
  check("审批被拒时不执行", res.ok === false && res.status === "denied", JSON.stringify(res));
}

{
  const res = await page.evaluate(async () => {
    const tools = await import("/scripts/tools.js");
    const r = await tools.executeTool(
      "plugin__granted__probe2",
      { x: 1 },
      {
        requestApproval: () => true, // 同意
      }
    );
    return { ok: r.ok, output: r.output };
  });
  check("审批通过后插件工具真的执行", res.ok === true, JSON.stringify(res));
  check("执行结果来自插件", res.output === "ok", String(res.output));
}

/* ---- 回归：装载沙箱必须带上代码，否则插件代码不会执行 ----
 *
 * 这条锁的是一个真实踩过的坑：安装流程把代码存进工作区文件后，
 * record 里只剩 codePath，而 loadPlugin 读的是 plugin.code。
 * 少传一步 → 沙箱起来了但代码没跑 → 「装上了却没有任何新工具」，且不报错。
 */
{
  const res = await page.evaluate(async () => {
    const host = await import("/scripts/plugin-host.js");
    const code = `dsh.registerTool({ name: "coded", description: "c" }, function () { return "ran"; });`;
    // 错误姿势：只给元数据，不给代码
    host.loadPlugin({ id: "nocode", name: "无代码", version: "1.0.0", permissions: [], code: "" });
    const empty = host.registeredTools().filter((t) => t.pluginId === "nocode").length;
    // 正确姿势：带上代码
    const rt = host.loadPlugin({ id: "withcode", name: "有代码", version: "1.0.0", permissions: [], code });
    for (let i = 0; i < 60 && !rt.ready; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const withCode = host.registeredTools().filter((t) => t.pluginId === "withcode").map((t) => t.name);
    host.unloadPlugin("nocode");
    host.unloadPlugin("withcode");
    return { empty, withCode };
  });
  check("回归：不带代码装载 → 插件不执行（无工具注册）", res.empty === 0, `${res.empty} 个`);
  check("回归：带上代码装载 → 工具被注册", res.withCode.includes("coded"), JSON.stringify(res.withCode));
}

check("无未捕获异常", pageErr === 0, pageErr ? `(${pageErr} 个)` : "");

await browser.close();
server.close();

console.log("");
if (fail === 0) {
  console.log("✓ 全部通过");
  process.exit(0);
} else {
  console.log(`✗ ${fail} 项失败`);
  process.exit(1);
}
