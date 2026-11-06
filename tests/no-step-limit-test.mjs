/**
 * 工具调用步数不设上限（0.67.0）
 *
 * 旧实现把 maxSteps 夹在 4..100（默认 24），跑满就抛
 * 「已达到最大步数…可在设置中调高上限」。长任务被硬砍一刀。
 * 现在默认无限，靠「模型不再返回工具调用」自然结束，用户随时可点停止。
 *
 * 本测试故意让假上游连续 120 步都返回工具调用（超过旧的硬上限 100），
 * 第 121 步才给结论，断言它真的跑完、没有抛步数错误。
 * 另外验证：默认配置里没有 maxSteps、老配置里的 maxSteps 会被迁移清掉、
 * 设置页不再有加减控件、显式设 maxSteps 时内部限流仍生效（给自动化用）。
 *
 * 用法：node tests/no-step-limit-test.mjs
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
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const TOOL_STEPS = 120; // 旧上限 100，默认 24

/** 假上游：前 TOOL_STEPS 步每步一个 calc 调用，之后给一句结论收尾。 */
const installFake = (limit) => `
  window.__round = 0;
  window.__LIMIT = ${limit};
  const line = (o) => "data: " + JSON.stringify(o) + "\\n\\n";
  const orig = window.fetch;
  window.fetch = function (url, opts) {
    const u = String(url);
    if (!u.includes("api.test.local")) return orig.call(window, url, opts);
    window.__round += 1;
    let text;
    if (window.__round <= window.__LIMIT) {
      text =
        line({ id: "1", choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, id: "call_" + window.__round, type: "function",
          function: { name: "calc", arguments: "{\\"expression\\":\\"1+1\\"}" },
        }] } }] }) +
        line({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
        "data: [DONE]\\n\\n";
    } else {
      text =
        line({ id: "1", choices: [{ index: 0, delta: { content: "全部完成" }, finish_reason: "stop" }] }) +
        "data: [DONE]\\n\\n";
    }
    return Promise.resolve(new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } }));
  };
`;

async function runAgent(page, extra = null) {
  return page.evaluate(async (extraSettings) => {
    const store = await import("/scripts/store.js");
    const rt = await import("/scripts/runtime.js");
    store.setSettings({
      model: "steps-probe",
      keys: { custom: "sk-test" },
      customModels: [{
        id: "steps-probe", label: "步数探针", apiModel: "probe",
        baseUrl: "https://api.test.local/v1", providerKey: "custom",
        ctx: 32000, vision: false, supportsEffort: false,
      }],
      memoryEnabled: false,
    });
    if (extraSettings) store.setSettings(extraSettings);
    const session = store.createSession({ mode: "standard", title: "步数测试" });
    const msg = {
      id: "steps-1", role: "assistant", content: "", reasoning: "",
      tools: [], steps: 0, status: "running", createdAt: Date.now(),
    };
    session.messages.push(msg);
    let error = "";
    try {
      await rt.runAgent({
        session, text: "一直算下去", msg, attachments: [],
        signal: new AbortController().signal, onChange: () => {},
      });
    } catch (e) {
      error = e?.message || String(e);
    }
    return {
      steps: msg.steps, status: msg.status, tools: msg.tools.length,
      content: msg.content, error: error || msg.error || "", rounds: window.__round,
    };
  }, extra);
}

/* ---------- 1. 默认无限：120 步工具调用后自然收尾 ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  await ctx.addInitScript(installFake(TOOL_STEPS));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => window.DshSplash?.exit?.());
  await page.waitForTimeout(900);

  const dflt = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    return { maxSteps: st.state.settings.maxSteps };
  });
  check("默认配置里没有 maxSteps", dflt.maxSteps === undefined, String(dflt.maxSteps));

  const run = await runAgent(page);
  check(`连续 ${TOOL_STEPS} 步工具调用没有被步数上限打断`,
    run.error === "" && /最大步数|步数限流/.test(run.error) === false,
    `error=${run.error || "（无）"} steps=${run.steps} rounds=${run.rounds}`);
  check("一直跑到模型自行收尾", run.rounds === TOOL_STEPS + 1, `rounds=${run.rounds}`);
  check("步数计数超过旧的 100 上限", run.steps > 100, `steps=${run.steps}`);
  check("工具卡片数与步数一致", run.tools === TOOL_STEPS, `tools=${run.tools}`);
  check("结论正常落库", /全部完成/.test(run.content), run.content.slice(-40));
  check("消息状态是完成", run.status === "done", run.status);

  /* ---------- 2. 设置页不再有加减控件 ---------- */
  await page.evaluate(() => document.querySelector('[data-act="open-settings"]')?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('[data-act="settings-cat"][data-value="agent"]')?.click());
  await page.waitForTimeout(300);
  const settings = await page.evaluate(() => {
    const t = document.body.innerText || "";
    return {
      controls: document.querySelectorAll('[data-act="max-steps"]').length,
      hasUnlimited: /不设上限/.test(t),
      hasOldLabel: /单次最大步数/.test(t),
    };
  });
  check("设置页没有步数加减控件", settings.controls === 0, String(settings.controls));
  check("设置页写明不设上限", settings.hasUnlimited, String(settings.hasUnlimited));
  check("旧的「单次最大步数」文案已移除", !settings.hasOldLabel, String(settings.hasOldLabel));

  /* ---------- 3. 内部限流仍可用于自动化（显式设正数才生效） ---------- */
  // 上一轮把 __round 跑到 121 了，不重置的话这一轮第一下就收到结论。
  // LIMIT 调高，保证上游一直返回工具调用，只能靠内部限流收口。
  await page.evaluate(() => { window.__round = 0; window.__LIMIT = 9999; });
  const limited = await runAgent(page, { maxSteps: 2 });
  check("显式 maxSteps=2 时内部限流生效",
    /内部设定的步数限流（2）/.test(limited.error) && limited.steps === 2 && limited.status === "error",
    `error=${limited.error} steps=${limited.steps} status=${limited.status}`);

  await ctx.close();
}

/* ---------- 4. 老配置里的 maxSteps 必须被迁移清掉 ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const seed = await ctx.newPage();
  await seed.goto(`${ORIGIN}/index.html`, { waitUntil: "networkidle" });
  await seed.waitForTimeout(600);
  await seed.evaluate(() => {
    const key = "dsh.mobile.state.v1";
    const st = JSON.parse(localStorage.getItem(key));
    st.settings.maxSteps = 24;
    st.settings.stepsBoosted = true;
    localStorage.setItem(key, JSON.stringify(st));
  });
  await seed.close();

  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const migrated = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const raw = JSON.parse(localStorage.getItem("dsh.mobile.state.v1"));
    return {
      inState: st.state.settings.maxSteps,
      inRaw: raw.settings.maxSteps,
      boosted: raw.settings.stepsBoosted,
    };
  });
  check("老配置的 maxSteps=24 被清掉（否则升级后照样 24 步被拦）",
    migrated.inState === undefined && migrated.inRaw === undefined,
    JSON.stringify(migrated));
  check("旧的 stepsBoosted 标记一并清掉", migrated.boosted === undefined, String(migrated.boosted));
  await ctx.close();
}

const fail = results.filter((r) => !r.ok);
console.log(`\n${results.length - fail.length}/${results.length} 项通过`);
await browser.close();
server.close();
process.exit(fail.length ? 1 : 0);
