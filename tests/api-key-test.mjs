/* ============================================================
   API Key 诊断回归（tests/api-key-test.mjs）

   ============ 这一轮修的是什么 ============

   用户：「Agnes 模型填入 API Key 后显示 Key 无效，但在电脑上是有效的。」

   顺着链路查下来，问题不是「App 把 Key 弄坏了」—— 标准 OpenAI 协议下
   请求头拼得完全正确（`Authorization: Bearer sk-…`）。真正的问题是
   **一旦被拒，用户拿不到任何能自查的信息，而结论下得又太武断**：

     1. 原生桥把 4xx 的响应体放在 err.body，testModel 的 catch 却只用
        err.message（"HTTP 401"）。服务端真正的原因 —— `Invalid token`、
        `Token not provided`、额度不足 —— 全被丢掉。
     2. 401 和 403 一律标成「Key 无效」。403 其实是权限 / 来源被拒
        （Cloudflare、模型未开通），跟字符对错无关。
     3. 改完 Key，旧的连接状态还挂在状态条上，看起来像「改了也没用」。
     4. Key 是分槽保存的。填到 A 槽、模型挂在 B 槽时，请求带着另一把
        Key 出去，服务端回 401，用户检查键本身怎么都没错。
     5. 从聊天软件 / 备忘录粘贴的 Key 常带空格、换行、`Bearer ` 前缀或
        中文引号。桌面客户端多半容错，APK 直接拼进请求头就变
        `Bearer Bearer sk-…` → 401。

   这个测试守：归一化、Agnes 双鉴权头、服务端原文不丢、槽位诊断、
   状态清理、界面文案。

   运行：node tests/api-key-test.mjs
   ============================================================ */

import assert from "node:assert";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { normalizeApiKey, keyShape, authChecklist } from "../scripts/apikeys.js";
import { httpHint, authFailureHint, formatOf, normalizeFormat } from "../scripts/formats.js";

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
    console.log(`✓ ${name} ${extra}`);
  } else {
    fail += 1;
    console.log(`✗ ${name} ${extra}`);
  }
}

console.log("\n[1] Key 归一化（纯逻辑）");
{
  const cases = [
    ["干净的 Key 原样保留", "sk-abcDEF123456", "sk-abcDEF123456"],
    ["首尾空格", "  sk-abcDEF123456  ", "sk-abcDEF123456"],
    ["中间换行", "sk-abc\nDEF123456", "sk-abcDEF123456"],
    ["制表符 + 空格", "sk-\tabc DEF123456", "sk-abcDEF123456"],
    ["Bearer 前缀", "Bearer sk-abcDEF123456", "sk-abcDEF123456"],
    ["整行 Authorization", "Authorization: Bearer sk-abcDEF123456", "sk-abcDEF123456"],
    ["大小写不敏感", "bearer  sk-abcDEF123456", "sk-abcDEF123456"],
    ["英文双引号", '"sk-abcDEF123456"', "sk-abcDEF123456"],
    ["英文单引号", "'sk-abcDEF123456'", "sk-abcDEF123456"],
    ["中文引号", "“sk-abcDEF123456”", "sk-abcDEF123456"],
    ["全角空格", "\u3000sk-abcDEF123456\u3000", "sk-abcDEF123456"],
    ["NBSP", "\u00a0sk-abcDEF123456\u00a0", "sk-abcDEF123456"],
    ["零宽空格", "sk-\u200babcDEF123456", "sk-abcDEF123456"],
    ["BOM 前缀", "\ufeffsk-abcDEF123456", "sk-abcDEF123456"],
    ["空值", "", ""],
    ["null", null, ""],
  ];
  for (const [name, raw, want] of cases) {
    check(name, normalizeApiKey(raw).key === want, JSON.stringify(normalizeApiKey(raw).key));
  }
  check("干净值 changed=false", normalizeApiKey("sk-abcDEF123456").changed === false);
  check("脏值 changed=true", normalizeApiKey("Bearer sk-abc").changed === true);
  check("脏值给出清理说明", normalizeApiKey("Bearer sk-abc").notes.length >= 1);
}

console.log("\n[2] 脱敏形态与自查清单");
{
  const s = keyShape("sk-abcDEF123456");
  check("长度正确", s.length === 15, String(s.length));
  check("掩码不回显全文", !s.masked.includes("abcDEF123456"), s.masked);
  check("掩码保留前后缀", s.masked.startsWith("sk-") && s.masked.includes("3456"), s.masked);
  check("空 Key 标记 empty", keyShape("").empty === true);
  const agnes = authChecklist("agnes").join("\n");
  check("Agnes 清单含官方 Base URL", agnes.includes("apihub.agnes-ai.com/v1"));
  check("Agnes 清单提示端点档位", agnes.includes("标准 · OpenAI 兼容"));
  check("Agnes 清单提示别带 Bearer", agnes.includes("Bearer"));
  const generic = authChecklist("custom").join("\n");
  check("通用清单提示核对域名", generic.includes("同一个地址") || generic.includes("Base URL"));
}

console.log("\n[3] 401 / 403 诊断正文");
{
  const d = authFailureHint(401, "Invalid token (request id: xxx)", {
    slot: "agnes",
    shape: keyShape("sk-abcDEF123456"),
    cleaned: ["去掉了空格或换行"],
    filledElsewhere: ["deepseek", "custom"],
    providerKey: "agnes",
  });
  check("401 带服务端原文", d.includes("Invalid token"));
  check("401 说明读的是哪个槽", d.includes("agnes"));
  check("401 显示脱敏形态", d.includes("sk-…"));
  check("401 提示可能填错槽", d.includes("deepseek"));
  check("401 说明已自动清理", d.includes("已自动清理"));
  check("401 带 Agnes 自查清单", d.includes("apihub.agnes-ai.com/v1"));

  const noTok = authFailureHint(401, "Token not provided", { slot: "agnes", providerKey: "agnes" });
  check("Token not provided 单独分支", noTok.includes("根本没有 Key"));

  const f403 = authFailureHint(403, "Forbidden", { slot: "agnes", providerKey: "agnes" });
  check("403 不武断说 Key 无效", f403.includes("不等于 Key 拼错"));
  check("403 提示权限 / 来源", f403.includes("权限"));
  check("403 提示换网络", f403.includes("Wi-Fi"));

  check("httpHint(401) 不再断言 Key 无效或过期", !httpHint(401).includes("无效或已过期"), httpHint(401));
  check("httpHint(403) 仍说明权限", httpHint(403).includes("权限"));
}

console.log("\n[4] 协议适配：Agnes 的 Anthropic 档双鉴权头");
{
  const anth = formatOf("anthropic");
  const openai = formatOf("openai");
  const base = { modelId: "agnes-2.5-flash", messages: [{ role: "user", content: "ping" }], tools: [], stream: false, temperature: 0.3, maxTokens: 16, effort: null };
  const agnesReq = anth.buildRequest({ ...base, baseUrl: "https://apihub.agnes-ai.com/v1", apiKey: "sk-abc" });
  check("Agnes /v1/messages 路径", agnesReq.url.endsWith("/v1/messages"), agnesReq.url);
  check("Agnes Anthropic 档带 x-api-key", agnesReq.headers["x-api-key"] === "sk-abc");
  check("Agnes Anthropic 档同时带 Authorization", agnesReq.headers.Authorization === "Bearer sk-abc");

  const otherReq = anth.buildRequest({ ...base, baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-abc" });
  check("官方 Anthropic 不多加 Authorization", !otherReq.headers.Authorization);

  const oa = openai.buildRequest({ ...base, baseUrl: "https://apihub.agnes-ai.com/v1", apiKey: "sk-abc" });
  check("OpenAI 档 Authorization 正确", oa.headers.Authorization === "Bearer sk-abc");
  check("Agnes 不带 stream_options（回归）", !("stream_options" in oa.body));
  check("normalizeFormat 兜底", normalizeFormat("nonsense") === "openai");
}

console.log("\n[5] 浏览器端到端：填 Key → 401 → 诊断");

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(String(req.url || "/").split("?")[0]);
    const target = p === "/" ? "/index.html" : p;
    const file = join(ROOT, normalize(target).replace(/^(\.\.[/\\])+/, ""));
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
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.addInitScript(() => {
  window.__captured = [];
  window.__nextStatus = 401;
  window.__nextBody = JSON.stringify({
    error: { message: "Invalid token (request id: 20261106ABC)", type: "AgnesAI_error" },
  });
  window.DshNative = {
    postStream(id, url, headersJson, bodyJson) {
      window.__captured.push({
        url,
        headers: JSON.parse(headersJson || "{}"),
        body: JSON.parse(bodyJson || "{}"),
      });
      const status = window.__nextStatus;
      const body = window.__nextBody;
      setTimeout(() => {
        window.__dshNativeEvent &&
          window.__dshNativeEvent(JSON.stringify({ id, type: "error", status, message: "HTTP " + status, body }));
      }, 5);
    },
    abort() {},
    getBinary() {},
  };
});

await page.goto(ORIGIN, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

const setup = await page.evaluate(async () => {
  const st = await import("/scripts/store.js");
  st.addCustomModels([
    {
      id: "agnes-test",
      label: "Agnes 测试",
      apiModel: "agnes-2.5-flash",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      provider: "Agnes AI",
      providerKey: "agnes",
      format: "openai",
      ctx: 262144,
      custom: true,
    },
  ]);
  // 故意在另一个槽也放一把 Key，用来验证「填错槽」提示
  st.setSettings({
    model: "agnes-test",
    keys: { ...st.state.settings.keys, agnes: "sk-REALKEY-abcdef123456", deepseek: "sk-OTHER" },
  });
  return { key: st.apiKeyFor(st.currentModel()), diag: st.keyDiagnosis(st.currentModel()) };
});
check("槽位读到正确 Key", setup.key === "sk-REALKEY-abcdef123456", setup.key);
check("keyDiagnosis 报告 agnes 槽", setup.diag.slot === "agnes");
check("keyDiagnosis 检出别处也填过 Key", setup.diag.filledElsewhere.includes("deepseek"));
check("keyDiagnosis 掩码不回显全文", !setup.diag.shape.masked.includes("REALKEY-abcdef"));

const r401 = await page.evaluate(async () => {
  const rt = await import("/scripts/runtime.js");
  const st = await import("/scripts/store.js");
  const r = {};
  try {
    await rt.testModel("agnes-test");
    r.threw = false;
  } catch (e) {
    r.threw = true;
    r.message = e.message;
    r.hint = e.hint || "";
    r.httpStatus = e.httpStatus;
  }
  r.status = st.modelStatusOf("agnes-test");
  r.captured = window.__captured.slice(-1)[0] || null;
  return r;
});
check("401 抛出错误", r401.threw === true);
check("message 保留服务端原文", /Invalid token/.test(r401.message || ""), r401.message);
check("message 不再是干巴巴的 HTTP 401", (r401.message || "").trim() !== "HTTP 401");
check("status.error 是服务端原文", /Invalid token/.test(r401.status?.error || ""), r401.status?.error);
check("status.status = 401", r401.status?.status === 401);
check("status.hint 存在", !!r401.status?.hint);
check("hint 说明读的槽位", /agnes/.test(r401.status?.hint || ""));
check("hint 带 Agnes 官方地址", /apihub\.agnes-ai\.com\/v1/.test(r401.status?.hint || ""));
check("err.hint 挂到错误对象", /自查/.test(r401.hint || ""));
check("请求头是单个 Bearer", r401.captured?.headers?.Authorization === "Bearer sk-REALKEY-abcdef123456", r401.captured?.headers?.Authorization);
check("请求打到 /v1/chat/completions", (r401.captured?.url || "").endsWith("/v1/chat/completions"));

console.log("\n[6] 改 Key 后清掉陈旧状态");
{
  const r = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    st.setModelStatus("agnes-test", { ok: false, status: 401, error: "Invalid token" });
    const before = !!st.modelStatusOf("agnes-test");
    st.setSettings({ keys: { ...st.state.settings.keys, agnes: "sk-NEWKEY-9999" } });
    return { before, after: !!st.modelStatusOf("agnes-test"), key: st.apiKeyFor(st.currentModel()) };
  });
  check("改 Key 前状态存在", r.before === true);
  check("改 Key 后陈旧状态被清掉", r.after === false);
  check("新 Key 生效", r.key === "sk-NEWKEY-9999", r.key);
}

console.log("\n[7] 归档里的脏 Key 也会在请求前洗净");
{
  const r = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const rt = await import("/scripts/runtime.js");
    // 绕过 setSettings，模拟老版本直接写进 localStorage 的脏值
    st.state.settings.keys.agnes = "  Bearer sk-DIRTY-KEY\n";
    const cleaned = st.apiKeyFor(st.currentModel());
    try { await rt.testModel("agnes-test"); } catch { /* 预期 401 */ }
    return { cleaned, captured: window.__captured.slice(-1)[0] || null };
  });
  check("apiKeyFor 洗净归档脏值", r.cleaned === "sk-DIRTY-KEY", r.cleaned);
  check("请求头没有 Bearer Bearer", r.captured?.headers?.Authorization === "Bearer sk-DIRTY-KEY", r.captured?.headers?.Authorization);
}

console.log("\n[8] 403 走「无权限」分支，不再误标 Key 无效");
{
  const r = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const rt = await import("/scripts/runtime.js");
    window.__nextStatus = 403;
    window.__nextBody = JSON.stringify({ error: { message: "Forbidden by gateway" } });
    st.setSettings({ keys: { ...st.state.settings.keys, agnes: "sk-NEWKEY-9999" } });
    let hint = "";
    let message = "";
    try { await rt.testModel("agnes-test"); } catch (e) { hint = e.hint || ""; message = e.message; }
    const label = await (async () => {
      // modelConnection 是 ui.js 内部函数，通过状态条 DOM 间接验证
      const pill = document.querySelector(".conn-pill, .conn-note__text");
      return pill ? pill.textContent.trim() : "";
    })();
    return { hint, message, status: st.modelStatusOf("agnes-test"), label };
  });
  check("403 status 记录正确", r.status?.status === 403);
  check("403 hint 说明不等于 Key 拼错", /不等于 Key 拼错/.test(r.hint));
  check("403 hint 提示权限 / 来源", /权限/.test(r.hint));
  check("403 message 带服务端原文", /Forbidden/.test(r.message), r.message);
}

console.log("\n[9] 非鉴权错误不生成诊断");
{
  const r = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const rt = await import("/scripts/runtime.js");
    window.__nextStatus = 429;
    window.__nextBody = JSON.stringify({ error: { message: "rate limited" } });
    st.setSettings({ keys: { ...st.state.settings.keys, agnes: "sk-RATE-1" } });
    let hint = null;
    try { await rt.testModel("agnes-test"); } catch (e) { hint = e.hint; }
    return { hint, status: st.modelStatusOf("agnes-test") };
  });
  check("429 不带 auth 诊断", !r.hint, String(r.hint));
  check("429 status 记录正确", r.status?.status === 429);
}

console.log("\n[10] 界面状态条文案");
{
  const r = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const ui = await import("/scripts/ui.js");
    st.setModelStatus("agnes-test", {
      ok: false,
      status: 401,
      error: "Invalid token",
      hint: "服务端没有接受这把 Key。\n自查：确认复制的是完整 Key。",
    });
    const c401 = ui.modelConnection("agnes-test");
    st.setModelStatus("agnes-test", { ok: false, status: 403, error: "Forbidden" });
    const c403 = ui.modelConnection("agnes-test");
    st.setModelStatus("agnes-test", { ok: true, status: 200, ms: 120 });
    const cOk = ui.modelConnection("agnes-test");
    return { l401: c401.label, d401: c401.detail, l403: c403.label, lOk: cOk.label };
  });
  check("401 label 不再是「Key 无效」", r.l401 === "Key 未被接受 · 401", r.l401);
  check("401 detail 拼上服务端原文", /Invalid token/.test(r.d401));
  check("401 detail 拼上诊断", /自查/.test(r.d401));
  check("403 label 是「无权限 · 403」", r.l403 === "无权限 · 403", r.l403);
  check("成功仍显示已连接", r.lOk.startsWith("已连接"), r.lOk);
}

check("无页面异常", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
server.close();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
