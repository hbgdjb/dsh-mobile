/**
 * 只读工具并行的测试
 *
 * ============ 这套测试在守什么 ============
 *
 * 并行是一把双刃剑，两个方向都可能出事：
 *
 *   一、该并行的没并行 —— 只是慢，用户能忍
 *   二、不该并行的并行了 —— 两个 write 同时落盘，谁后写谁赢，
 *       文件内容变成掷骰子。这种 bug 平时看不出来，出事时无法复现。
 *
 * 所以第一条断言是「白名单里没有写操作」，比测速度重要得多。
 *
 * 第二条是顺序：模型说「先读 A 再读 B」，界面上和回灌给它的结果
 * 都必须是 A、B —— 并行最容易把这层顺序打乱。
 *
 * 用法：node tests/tool-parallel-test.mjs
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
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });

/**
 * 假端点：第一轮返回三个 fs_read 的 tool_calls，第二轮给出结论。
 *
 * 三个都是只读、都相邻 —— 正是应该并行的那一批。
 */
await ctx.addInitScript(() => {
  window.__round = 0;
  window.__toolOrder = [];

  const line = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

  function toolCallDelta(i, name, args) {
    return line({
      id: "1",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: i,
                id: `call_${i}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    });
  }

  const orig = window.fetch;
  window.fetch = function (url, opts) {
    const u = String(url);
    if (!u.includes("api.test.local")) return orig.call(window, url, opts);

    let body = {};
    try {
      body = JSON.parse(opts?.body || "{}");
    } catch {}
    const hasToolResult = (body.messages || []).some((m) => m.role === "tool");
    window.__toolOrder = (body.messages || [])
      .filter((m) => m.role === "tool")
      .map((m) => String(m.content || "").slice(0, 12));

    if (!hasToolResult) {
      window.__round += 1;
      const text =
        toolCallDelta(0, "fs_read", { path: "a.txt" }) +
        toolCallDelta(1, "fs_read", { path: "b.txt" }) +
        toolCallDelta(2, "fs_read", { path: "missing.txt" }) +
        line({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
        "data: [DONE]\n\n";
      return Promise.resolve(
        new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } })
      );
    }

    const done =
      line({ id: "1", choices: [{ index: 0, delta: { content: "三个都看过了。" } }] }) +
      line({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      "data: [DONE]\n\n";
    return Promise.resolve(
      new Response(done, { status: 200, headers: { "content-type": "text/event-stream" } })
    );
  };
});

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(4200);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

/* ---------------- 一、白名单边界 ---------------- */

console.log("\n白名单\n");

const safe = await page.evaluate(async () => {
  const rt = await import("/scripts/runtime.js");
  const probe = [
    "fs_list",
    "fs_read",
    "fs_inspect",
    "library_list",
    "library_read",
    "calc",
    "now",
    "fs_write",
    "fs_delete",
    "shell",
    "run_code",
    "library_save",
    "plugin__node__anything",
    "mcp__demo__tap",
    "web_search",
    "spawn_subagent",
  ];
  const out = {};
  probe.forEach((n) => {
    out[n] = rt.isParallelSafeTool(n);
  });
  return out;
});

const shouldBeSafe = ["fs_list", "fs_read", "fs_inspect", "library_list", "library_read", "calc", "now"];
const shouldNotBeSafe = [
  "fs_write",
  "fs_delete",
  "shell",
  "run_code",
  "library_save",
  "plugin__node__anything",
  "mcp__demo__tap",
  "web_search",
  "spawn_subagent",
];

const wrongSafe = shouldBeSafe.filter((n) => !safe[n]);
const wrongUnsafe = shouldNotBeSafe.filter((n) => safe[n]);
check(
  "只读工具在并行白名单里",
  wrongSafe.length === 0,
  wrongSafe.length ? `缺了：${wrongSafe.join("、")}` : shouldBeSafe.join("、")
);
check(
  "写操作 / 终端 / 插件 / MCP 一律不并行",
  wrongUnsafe.length === 0,
  wrongUnsafe.length ? `混进来了：${wrongUnsafe.join("、")}` : `排除 ${shouldNotBeSafe.length} 个`
);

/* ---------------- 二、顺序不乱 ---------------- */

console.log("\n顺序\n");

const run = await page.evaluate(async () => {
  const store = await import("/scripts/store.js");
  const rt = await import("/scripts/runtime.js");

  // 造两个存在的文件 + 一个不存在的（third 会失败，正好测乱序）
  // 必须 await：writeFile 是异步的（要走真实文件后端落盘），
  // 不等的话 fs_read 跑去读的时候文件还没写出来
  await store.writeFile("a.txt", "AAA");
  await store.writeFile("b.txt", "BBB");

  store.setSettings({
    model: "par-probe",
    keys: { custom: "sk-test" },
    customModels: [
      {
        id: "par-probe",
        label: "并行探针",
        apiModel: "probe",
        baseUrl: "https://api.test.local/v1",
        providerKey: "custom",
        ctx: 32000,
        vision: false,
        supportsEffort: false,
      },
    ],
    memoryEnabled: false,
    maxSteps: 3,
  });

  const session = store.createSession({ mode: "standard", title: "并行测试" });
  const msg = {
    id: "par-1",
    role: "assistant",
    content: "",
    reasoning: "",
    tools: [],
    steps: 0,
    status: "running",
    createdAt: Date.now(),
  };
  session.messages.push(msg);

  const t0 = Date.now();
  await rt.runAgent({
    session,
    text: "读这三个文件",
    msg,
    attachments: [],
    signal: new AbortController().signal,
    onChange: () => {},
  });

  return {
    ms: Date.now() - t0,
    status: msg.status,
    names: msg.tools.map((t) => t.name),
    args: msg.tools.map((t) => t.args?.path || ""),
    outputs: msg.tools.map((t) => String(t.output || "").slice(0, 20)),
    toolOrder: window.__toolOrder,
    content: msg.content,
  };
});

check(
  "三张卡片按模型给的顺序排列",
  JSON.stringify(run.args) === JSON.stringify(["a.txt", "b.txt", "missing.txt"]),
  JSON.stringify(run.args)
);
check("三张卡片都是 fs_read", run.names.every((n) => n === "fs_read"), JSON.stringify(run.names));
check(
  "成功与失败混在一起也不乱序（前两个读到内容，第三个报错）",
  run.outputs[0].includes("AAA") && run.outputs[1].includes("BBB") && !run.outputs[2].includes("AAA"),
  JSON.stringify(run.outputs)
);
check(
  "回灌给模型的工具结果也是同样顺序",
  run.toolOrder[0].includes("AAA") && run.toolOrder[1].includes("BBB"),
  JSON.stringify(run.toolOrder)
);
check("这一轮正常收尾", run.status === "done" && run.content.includes("三个都看过了"), run.status);

/* ---------------- 三、没有报错 ---------------- */

check("全程没有 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
server.close();
console.log(failed ? `\n${failed} 项失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
