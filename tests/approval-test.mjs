/**
 * 审批策略测试。
 *
 * ============ 这一轮修的是什么 ============
 *
 * 用户反馈「自动放行似乎有问题，还是不停弹出审核」。
 *
 * 查下来：只有**内置工具**读了 `state.settings.approval`，
 * MCP 工具和插件工具走的是另外两条分支，**无条件**调 requestApproval。
 *
 * 于是同一个设置在不同工具上表现不一致：
 *   内置的 fs_write、shell → 自动放行，不弹
 *   MCP 的 app_launch、插件的 note → 每次都弹
 *
 * 用户不可能知道"这个开关只管一部分工具"，他只会觉得开关坏了。
 *
 * 顺带还发现两处对「没有审批通道」的处理正好相反：
 *   runMcpTool：   `if (!ok)`      → undefined 为真 → 拒绝（误伤）
 *   runPluginTool：`if (ok === false)` → undefined 为假 → 放行（误放）
 *
 * 用法：node tests/approval-test.mjs
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
await page.waitForTimeout(800);

/* ---------- 准备：一个 MCP 服务器 + 一个代码插件 ---------- */

const ready = await page.evaluate(async () => {
  const store = await import("/scripts/store.js");
  const host = await import("/scripts/plugin-host.js");

  // MCP：地址指向一个必然连不上的端口 —— 我们只关心"有没有弹审批"，
  // 不关心请求本身成不成功。
  store.state.settings.mcpServers = [
    {
      id: "srv",
      name: "测试服务器",
      url: "http://127.0.0.1:1/mcp",
      enabled: true,
      tools: [{ name: "probe", description: "探针", inputSchema: { type: "object", properties: {} } }],
    },
  ];

  // 插件：必须先登记到 state.plugins —— executeTool 会校验 enabled，
  // 只装沙箱不登记会被判「未启用」。
  store.state.plugins.push({
    id: "acme",
    name: "ACME",
    desc: "测试用",
    version: "1.0.0",
    enabled: true,
    preinstalled: false,
    removable: true,
    tools: ["add"],
    scopes: [],
    permissions: [],
  });

  // 插件：真沙箱，注册一个 add 工具
  const rt = host.loadPlugin({
    id: "acme",
    name: "ACME",
    version: "1.0.0",
    permissions: [],
    code: `dsh.registerTool({ name: "add", description: "加法" }, function (a) { return Number(a.x) + Number(a.y); });`,
  });
  for (let i = 0; i < 60 && !rt.ready; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return { pluginReady: rt.ready };
});
check("测试插件沙箱已就绪", ready.pluginReady === true);

/* ---------- 工具：跑一次并记录"审批有没有被调用" ---------- */

/**
 * @param {string} toolName
 * @param {object} args
 * @param {"ask"|"auto"|"never"} policy
 * @param {"allow"|"deny"|"none"} reply "none" 表示上下文里没有审批通道
 */
async function run(toolName, args, policy, reply) {
  return page.evaluate(
    async ({ toolName, args, policy, reply }) => {
      const store = await import("/scripts/store.js");
      const tools = await import("/scripts/tools.js");
      store.state.settings.approval = policy;

      let asked = 0;
      let lastInfo = null;
      const ctx = {};
      if (reply !== "none") {
        ctx.requestApproval = (info) => {
          asked += 1;
          lastInfo = info;
          return reply === "allow";
        };
      }

      const r = await tools.executeTool(toolName, args, ctx);
      return {
        asked,
        status: r.status,
        ok: r.ok,
        output: String(r.output || "").slice(0, 80),
        label: lastInfo?.label || "",
      };
    },
    { toolName, args, policy, reply }
  );
}

/* ============ 1. 自动放行：三条路径都不该弹 ============ */

{
  const mcp = await run("mcp__srv__probe", {}, "auto", "allow");
  check("自动放行 · MCP 工具不弹审批", mcp.asked === 0, `asked=${mcp.asked}`);
  check("自动放行 · MCP 工具不是被拒", mcp.status !== "denied", mcp.status);
}

{
  const plugin = await run("plugin__acme__add", { x: 2, y: 3 }, "auto", "allow");
  check("自动放行 · 插件工具不弹审批", plugin.asked === 0, `asked=${plugin.asked}`);
  check("自动放行 · 插件工具真的执行了", plugin.ok === true && plugin.output === "5", plugin.output);
}

{
  const builtin = await run("fs_write", { path: "approval-test/t.txt", content: "x" }, "auto", "allow");
  check("自动放行 · 内置敏感工具不弹审批", builtin.asked === 0, `asked=${builtin.asked}`);
  check("自动放行 · 内置敏感工具真的执行了", builtin.ok === true, builtin.status);
}

/* ============ 2. 逐次询问：三条路径都要弹 ============ */

{
  const mcp = await run("mcp__srv__probe", {}, "ask", "deny");
  check("逐次询问 · MCP 工具会弹审批", mcp.asked === 1, `asked=${mcp.asked}`);
  check("逐次询问 · 拒绝后 MCP 不执行", mcp.status === "denied");
  check("逐次询问 · MCP 审批标签标明来源", /MCP · 测试服务器 · probe/.test(mcp.label), mcp.label);
}

{
  const plugin = await run("plugin__acme__add", { x: 1, y: 1 }, "ask", "deny");
  check("逐次询问 · 插件工具会弹审批", plugin.asked === 1, `asked=${plugin.asked}`);
  check("逐次询问 · 拒绝后插件不执行", plugin.status === "denied");
  check("逐次询问 · 插件审批标签标明来源", /插件 · ACME · add/.test(plugin.label), plugin.label);
}

{
  const allowed = await run("plugin__acme__add", { x: 4, y: 4 }, "ask", "allow");
  check("逐次询问 · 同意后插件执行", allowed.ok === true && allowed.output === "8", allowed.output);
}

/* ============ 3. 全部拒绝：不弹，直接拒 ============ */

{
  const mcp = await run("mcp__srv__probe", {}, "never", "allow");
  check("全部拒绝 · MCP 不弹审批", mcp.asked === 0, `asked=${mcp.asked}`);
  check("全部拒绝 · MCP 被拒", mcp.status === "denied");
}

{
  const plugin = await run("plugin__acme__add", { x: 1, y: 2 }, "never", "allow");
  check("全部拒绝 · 插件不弹审批", plugin.asked === 0, `asked=${plugin.asked}`);
  check("全部拒绝 · 插件被拒", plugin.status === "denied");
}

/* ============ 4. 没有审批通道（子 Agent / 后台任务） ============ */

//
// 这一组锁的是两个方向相反的旧 bug：
//   MCP   旧代码 `if (!ok)`         → undefined 为真 → 误拒
//   插件  旧代码 `if (ok === false)` → undefined 为假 → 误放
//
// 正确语义只有一个：没有审批通道时，敏感操作一律不做。

{
  const mcp = await run("mcp__srv__probe", {}, "ask", "none");
  check("无审批通道 · MCP 被跳过而不是放行", mcp.status === "denied", mcp.status);
  check("无审批通道 · MCP 的拒绝原因说得清", /没有审批通道/.test(mcp.output), mcp.output);
}

{
  const plugin = await run("plugin__acme__add", { x: 9, y: 9 }, "ask", "none");
  check("无审批通道 · 插件被跳过（旧代码会静默放行）", plugin.status === "denied", plugin.status);
  check("无审批通道 · 插件确实没执行", plugin.output !== "18", plugin.output);
}

{
  const builtin = await run("fs_write", { path: "approval-test/y.txt", content: "y" }, "ask", "none");
  check("无审批通道 · 内置敏感工具被跳过", builtin.status === "denied", builtin.status);
}

/* ============ 5. 只读权限：优先于任何审批策略 ============ */

{
  const res = await page.evaluate(async () => {
    const store = await import("/scripts/store.js");
    const tools = await import("/scripts/tools.js");
    store.state.settings.approval = "auto"; // 即使自动放行
    store.state.settings.permission = "readonly";
    let asked = 0;
    const r = await tools.executeTool("plugin__acme__add", { x: 1, y: 1 }, {
      requestApproval: () => {
        asked += 1;
        return true;
      },
    });
    store.state.settings.permission = "full";
    return { status: r.status, asked };
  });
  check("只读模式 · 自动放行也不能越过", res.status === "denied", res.status);
  check("只读模式 · 不弹审批（直接拒）", res.asked === 0, `asked=${res.asked}`);
}

/* ============ 6. Safety Net 仍然优先于自动放行 ============ */

{
  const res = await page.evaluate(async () => {
    const store = await import("/scripts/store.js");
    const tools = await import("/scripts/tools.js");
    store.state.settings.approval = "auto";
    store.state.settings.permission = "full";
    const r = await tools.executeTool("shell", { command: "rm -rf /" }, { requestApproval: () => true });
    return { status: r.status, output: String(r.output || "").slice(0, 60) };
  });
  check("自动放行 · 破坏性命令仍被护栏拦下", res.status === "blocked", `${res.status} ${res.output}`);
}

check("无未捕获异常", pageErr === 0, `${pageErr} 个`);

await browser.close();
server.close();

console.log("");
console.log(fail === 0 ? `✓ 全部通过（${pass} 项）` : `✗ ${fail} 项失败（共 ${pass + fail} 项）`);
process.exit(fail === 0 ? 0 : 1);
