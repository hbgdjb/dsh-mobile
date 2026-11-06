/**
 * 时间线测试
 *
 * ============ 这套测试在守什么 ============
 *
 * 一条助手消息以前只存三个桶：msg.reasoning、msg.tools、msg.content，
 * 渲染时固定排成「思考 → 工具 → 正文」。可 Agent 的实际节奏是
 * 「想 → 调工具 → 看结果 → 再想 → 再调」，三桶一平铺，这个顺序就没了。
 *
 * 现在额外记 msg.timeline，但刻意没把文本搬进去 ——
 * reasoning / content 仍是唯一副本，timeline 只描述「哪一段落在哪里」。
 * 这个设计只要切片算错一个字符，界面上就会多出或少掉半句话，
 * 所以第二组断言专门比对「切出来的段拼回去，必须逐字等于原文」。
 *
 * 第三组守降级：旧会话没有 timeline，必须仍然按老布局渲染出来，
 * 不能因为字段缺失就变成一片空白。
 *
 * 用法：node tests/timeline-test.mjs
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
 * 假端点：三轮，每轮都是「先想、再动手」。
 *
 * 第一轮的思考故意拆成两个 delta 发 —— 真实的推理流就是这样一片片到的，
 * 如果每次 delta 都新开一段，界面上会出现一堆只有一个字的思考块。
 */
await ctx.addInitScript(() => {
  const line = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const delta = (d) => line({ id: "1", choices: [{ index: 0, delta: d }] });
  const finish = (reason) => line({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: reason }] });
  const call = (id, name, args) =>
    delta({
      tool_calls: [
        { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    });

  const orig = window.fetch;
  window.fetch = function (url, opts) {
    const u = String(url);
    if (!u.includes("api.test.local")) return orig.call(window, url, opts);

    let body = {};
    try {
      body = JSON.parse(opts?.body || "{}");
    } catch {}
    const toolRounds = (body.messages || []).filter((m) => m.role === "tool").length;

    let text = "";
    if (toolRounds === 0) {
      text =
        delta({ reasoning_content: "先看看目录里有什么。" }) +
        delta({ reasoning_content: "体积不小，但静态站点可以直接发。" }) +
        call("call_one", "shell", { cmd: "echo one" }) +
        finish("tool_calls") +
        "data: [DONE]\n\n";
    } else if (toolRounds === 1) {
      text =
        delta({ reasoning_content: "目录正常，开始发布。" }) +
        call("call_two", "shell", { cmd: "echo two" }) +
        finish("tool_calls") +
        "data: [DONE]\n\n";
    } else {
      text =
        delta({ reasoning_content: "发布完了，验证一下线上。" }) +
        delta({ content: "已同步。" }) +
        finish("stop") +
        "data: [DONE]\n\n";
    }
    return Promise.resolve(
      new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } })
    );
  };
});

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// 步骤（思考/工具）现在收在「N 步进程」组里，顺序断言得先把它摊平再比。
// 0.66.0 之前它们是 .msg__flow 的直接子元素，所以这个摊平是新增的。
await page.addInitScript(() => {
  window.flatKinds = (flow) => {
    const out = [];
    if (!flow) return out;
    const kindOf = (c) =>
      c.classList.contains("reasoning")
        ? "reasoning"
        : c.classList.contains("tool")
          ? "tool"
          : c.classList.contains("run-group")
            ? null
            : "text";
    [...flow.children].forEach((c) => {
      if (c.classList.contains("run-group")) {
        const body = c.querySelector(":scope > .run-group__body");
        if (body) [...body.children].forEach((k) => out.push(kindOf(k)));
      } else {
        const k = kindOf(c);
        if (k) out.push(k);
      }
    });
    return out;
  };
});
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(4200);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

/* ---------------- 一、运行一轮，看时间线记成什么样 ---------------- */

console.log("\n记录\n");

const run = await page.evaluate(async () => {
  const store = await import("/scripts/store.js");
  const rt = await import("/scripts/runtime.js");

  store.setSettings({
    model: "tl-probe",
    keys: { custom: "sk-test" },
    customModels: [
      {
        id: "tl-probe",
        label: "时间线探针",
        apiModel: "probe",
        baseUrl: "https://api.test.local/v1",
        providerKey: "custom",
        ctx: 32000,
        vision: false,
        supportsEffort: false,
      },
    ],
    memoryEnabled: false,
    maxSteps: 4,
    showReasoning: true,
  });

  const session = store.createSession({ mode: "standard", title: "时间线测试" });
  const msg = {
    id: "tl-1",
    role: "assistant",
    content: "",
    reasoning: "",
    tools: [],
    steps: 0,
    status: "running",
    createdAt: Date.now(),
  };
  session.messages.push({ id: "tl-u1", role: "user", content: "同步", ts: Date.now() });
  session.messages.push(msg);

  await rt.runAgent({
    session,
    text: "同步",
    msg,
    attachments: [],
    signal: new AbortController().signal,
    onChange: () => {},
  });

  // 按段切片，拼回两段完整文本，用来验证「切片没丢字」
  const segs = msg.timeline || [];
  const piecesOf = (type) =>
    segs
      .filter((s) => s.type === type)
      .map((s) => {
        const src = type === "reasoning" ? msg.reasoning : msg.content;
        const to = s.to === null || s.to === undefined ? src.length : s.to;
        return src.slice(s.from, to);
      });

  store.switchSession(session.id);
  store.save(true);
  return {
    status: msg.status,
    kinds: segs.map((s) => s.type),
    reasonPieces: piecesOf("reasoning"),
    textPieces: piecesOf("text"),
    reasoning: msg.reasoning,
    content: msg.content,
    tools: msg.tools.map((t) => t.name),
    timeline: segs.map((s) => ({ type: s.type, from: s.from, to: s.to })),
  };
});

check("三轮跑完", run.status === "done", run.status);
check(
  "顺序是「想→做→想→做→想→说」",
  JSON.stringify(run.kinds) ===
    JSON.stringify(["reasoning", "tool", "reasoning", "tool", "reasoning", "text"]),
  JSON.stringify(run.kinds)
);
check("两次工具调用都记下来了", run.tools.length === 2, JSON.stringify(run.tools));
check(
  "同一步里连着来的两个思考 delta 合成一段",
  run.timeline.filter((s) => s.type === "reasoning").length === 3,
  `共 ${run.timeline.filter((s) => s.type === "reasoning").length} 段思考`
);

/* ---------------- 二、切片不许丢字 ---------------- */

console.log("\n切片\n");

check(
  "思考段拼回去等于原文",
  run.reasonPieces.join("") === run.reasoning,
  `拼回 ${run.reasonPieces.join("").length} 字 / 原文 ${run.reasoning.length} 字`
);
check(
  "正文段拼回去等于原文（前后空行不属于任何段）",
  run.textPieces.join("") === run.content.trim(),
  `${JSON.stringify(run.textPieces)} vs ${JSON.stringify(run.content.trim())}`
);
check(
  "第一段思考只覆盖第一句",
  (run.timeline[0].to || 0) > 0 && (run.timeline[0].to || 0) < run.reasoning.length,
  `to=${run.timeline[0].to} / 全长 ${run.reasoning.length}`
);
check(
  "最后一段思考封口在出现正文之前",
  run.timeline[4].to === run.reasoning.length,
  `to=${run.timeline[4].to} / 全长 ${run.reasoning.length}`
);

/* ---------------- 三、界面按时间线排 ---------------- */

console.log("\n渲染\n");

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(4200);

const view = await page.evaluate(() => {
  const el = document.querySelector('.msg--assistant[data-msg="tl-1"]');
  if (!el) return { missing: true };
  const flow = el.querySelector(".msg__flow");
  const legacy = el.querySelector(".msg__legacy");
  return {
    flowHidden: flow ? flow.hidden : null,
    legacyHidden: legacy ? legacy.hidden : null,
    kinds: flatKinds(flow),
    firstReasonText: flow?.querySelector(".reasoning__text")?.textContent || "",
    hint: flow?.querySelector(".reasoning__hint")?.textContent || "",
    bodyText: [...(flow?.children || [])]
      .filter((c) => c.classList.contains("msg__body"))
      .map((c) => c.textContent.trim())
      .join(" / "),
  };
});

check("时间线容器可见", view.flowHidden === false, JSON.stringify(view.flowHidden));
check("旧布局收起来了", view.legacyHidden === true, JSON.stringify(view.legacyHidden));
check(
  "DOM 顺序与时间线一致",
  JSON.stringify(view.kinds) === JSON.stringify(["reasoning", "tool", "reasoning", "tool", "reasoning", "text"]),
  JSON.stringify(view.kinds)
);
check(
  "第一段思考有内容（折叠态也能点开看）",
  view.firstReasonText.includes("先看看目录"),
  JSON.stringify(view.firstReasonText.slice(0, 24))
);
check("折叠标题带首句摘要", view.hint.length > 0, JSON.stringify(view.hint));
check("正文落在最后一段", view.bodyText.includes("已同步"), JSON.stringify(view.bodyText));

/* ---------------- 四、旧消息仍能渲染 ---------------- */

console.log("\n降级\n");

const legacyView = await page.evaluate(async () => {
  const store = await import("/scripts/store.js");
  const s = store.createSession({ mode: "standard", title: "旧消息" });
  // 刻意不带 timeline：这就是 0.60.0 之前存下来的消息
  s.messages.push(
    { id: "old-u1", role: "user", content: "老问题", ts: Date.now() - 9000 },
    {
      id: "old-a1",
      role: "assistant",
      status: "done",
      content: "老回答。",
      reasoning: "老思考。",
      tools: [{ id: "ot1", name: "shell", argLabel: "旧调用", status: "done", args: {}, output: "ok", ms: 12 }],
      steps: 1,
      ts: Date.now() - 8000,
    }
  );
  store.save(true);
  store.switchSession(s.id);
  const ui = await import("/scripts/ui.js");
  ui.renderAll();
  await new Promise((r) => setTimeout(r, 400));
  const el = document.querySelector('.msg--assistant[data-msg="old-a1"]');
  if (!el) return { missing: true };
  return {
    flowHidden: el.querySelector(".msg__flow")?.hidden,
    legacyHidden: el.querySelector(".msg__legacy")?.hidden,
    reasonText: el.querySelector(".reasoning__text")?.textContent || "",
    toolCount: el.querySelectorAll(".tool").length,
    body: el.querySelector(".body-slot .msg__body")?.textContent?.trim() || "",
  };
});

check("旧消息仍在", !legacyView.missing, JSON.stringify(legacyView));
check("旧消息走老布局", legacyView.flowHidden === true && legacyView.legacyHidden === false, JSON.stringify([legacyView.flowHidden, legacyView.legacyHidden]));
check("思考、工具、正文都没少", legacyView.reasonText.includes("老思考") && legacyView.toolCount === 1 && legacyView.body.includes("老回答"), JSON.stringify([legacyView.reasonText, legacyView.toolCount, legacyView.body]));

/* ---------------- 五、关掉思考显示后顺序依然对 ---------------- */

console.log("\n隐藏思考\n");

const hidden = await page.evaluate(async () => {
  const store = await import("/scripts/store.js");
  const ui = await import("/scripts/ui.js");
  store.switchSession(store.state.sessions.find((x) => x.messages.some((m) => m.id === "tl-1")).id);
  store.setSettings({ showReasoning: false });
  ui.renderAll();
  await new Promise((r) => setTimeout(r, 400));
  const flow = document.querySelector('.msg--assistant[data-msg="tl-1"] .msg__flow');
  if (!flow) return { missing: true };
  return {
    kinds: flatKinds(flow),
    text: flow.textContent.trim(),
  };
});

check(
  "思考段整段撤掉，工具和正文保持原顺序",
  JSON.stringify(hidden.kinds) === JSON.stringify(["tool", "tool", "text"]),
  JSON.stringify(hidden.kinds)
);
check("撤掉思考没带走正文", (hidden.text || "").includes("已同步"), JSON.stringify((hidden.text || "").slice(-20)));

check("没有页面报错", errors.length === 0, errors.join(" | "));

console.log(`\n${failed ? "✗" : "✓"} ${failed ? `${failed} 项失败` : "全部通过"}\n`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
