/**
 * 系统提示词中的「能力声明」测试。
 *
 * 起因是一个很典型的失败：
 *
 *   用户问 Agent「检查一下当前运行时的工具注册表」，Agent 回答
 *   「这个宿主目前没有内置 MCP 客户端，所以外部 MCP 服务器对我不可见」。
 *
 * 这句话是错的 —— 宿主内置了完整的 MCP 客户端，只是**没配服务器**。
 * 但 Agent 只能看到工具表：表里没有 mcp__* 工具，它就只能推出「没有这个能力」。
 *
 * 这类错误很危险：它不是幻觉，而是**从真实观察中得出的错误结论**，
 * 用户看到的是「AI 说我的 App 没有这个功能」，会直接怀疑整个产品。
 *
 * 解法不是让模型猜，而是把能力状态写进系统提示词。
 * 这个文件就是在守这件事：提示词必须明确告诉模型
 *   1) 有没有 MCP 客户端
 *   2) 配了几个服务器、各自状态
 *   3) 没配时该引导用户去哪加
 *
 * 用法：node tests/prompt-test.mjs
 */
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
function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name} ${extra}`);
  } else {
    fail += 1;
    console.log(`✗ ${name} ${extra}`);
  }
}

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
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

/* ============ 1. 没有配置 MCP 服务器时 ============ */

const empty = await page.evaluate(async () => {
  const store = await import("/scripts/store.js");
  const rt = await import("/scripts/runtime.js");
  store.state.settings.mcpServers = [];
  const prompt = rt.buildSystemPrompt();
  return { prompt, hasMcpLine: prompt.includes("【MCP 服务器】") };
});

check("提示词里有 MCP 服务器状态行", empty.hasMcpLine);
check("未配置时明确说是「未配置」而不是「不支持」", /未配置/.test(empty.prompt));
check(
  "未配置时说明「客户端已就绪」",
  /内置 MCP 客户端已就绪/.test(empty.prompt),
  "这是防止模型把「没配服务器」误判成「没有客户端」的关键一句"
);
check(
  "未配置时给出添加路径",
  /工作区与 MCP/.test(empty.prompt),
  "模型要能告诉用户去哪加，而不是干说没有"
);
check(
  "未配置时给出本机 MCP 的地址",
  /127\.0\.0\.1:8788\/mcp/.test(empty.prompt),
  "控制手机这条最常用的路径必须能被模型说清楚"
);
check(
  "未配置时明确禁止说「宿主不支持 MCP」",
  /而不是/.test(empty.prompt) && /宿主不支持 MCP/.test(empty.prompt)
);

/* ============ 2. 配了服务器、且已拉到工具 ============ */

const withTools = await page.evaluate(async () => {
  const store = await import("/scripts/store.js");
  const rt = await import("/scripts/runtime.js");
  store.state.settings.mcpServers = [
    { id: "local", name: "本机", url: "http://127.0.0.1:8788/mcp", enabled: true, tools: new Array(21).fill(0).map((_, i) => ({ name: `t${i}` })) },
    { id: "gh", name: "GitHub", url: "https://example.com/mcp", enabled: false, tools: [] },
  ];
  return rt.buildSystemPrompt();
});
check("有服务器时报告数量", /【MCP 服务器】2 个/.test(withTools), withTools.match(/【MCP 服务器】[^\n]*/)?.[0] || "");
check("有服务器时报出总工具数", /共 21 个工具/.test(withTools));
check("列出每个服务器的名字与工具数", /本机（21 个工具）/.test(withTools));
check("停用的服务器标注为已停用", /GitHub（已停用）/.test(withTools));
check("说明工具命名规则", /mcp__<服务器>__<工具>/.test(withTools));

/* ============ 3. 配了服务器但还没拉到工具 ============ */

const noTools = await page.evaluate(async () => {
  const store = await import("/scripts/store.js");
  const rt = await import("/scripts/runtime.js");
  store.state.settings.mcpServers = [
    { id: "x", name: "未连上的", url: "https://example.com/mcp", enabled: true, tools: [] },
  ];
  return rt.buildSystemPrompt();
});
check("未拉到工具时标注未连接", /未连上的（未连接/.test(noTools));
check("未拉到工具时提示去测试连接", /测试连接/.test(noTools));

/* ============ 4. 极简模式要说明 MCP 不会被装配 ============ */

const minimal = await page.evaluate(async () => {
  const store = await import("/scripts/store.js");
  const rt = await import("/scripts/runtime.js");
  store.state.settings.mode = "minimal";
  store.state.settings.mcpServers = [];
  const p = rt.buildSystemPrompt();
  store.state.settings.mode = "standard";
  return p;
});
check("极简模式提示 MCP 工具不装配", /极简模式/.test(minimal));

/* ============ 5. 提示词整体仍然结构完整 ============ */

const full = await page.evaluate(async () => {
  const rt = await import("/scripts/runtime.js");
  return rt.buildSystemPrompt();
});
check("提示词含当前模式", /【当前模式】/.test(full));
check("提示词含权限", /【权限】/.test(full));
check("提示词含插件列表", /【已启用插件】/.test(full));
check("提示词含行为准则", /【行为准则】/.test(full));
check("提示词不是空串", full.length > 400, `${full.length} 字符`);

check("无未捕获异常", pageErr === 0, `${pageErr} 个`);

await browser.close();
server.close();

console.log("");
console.log(fail === 0 ? `✓ 全部通过（${pass} 项）` : `✗ ${fail} 项失败（共 ${pass + fail} 项）`);
process.exit(fail === 0 ? 0 : 1);
