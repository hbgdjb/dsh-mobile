/* ============================================================
   Agnes 国内站 / 国际站回归（tests/agnes-site-test.mjs）

   ============ 这一轮修的是什么 ============

   用户：「我发现 agnes 的端口填的是国际站的端口，而我的 key 是国内站生成的。」

   这就解释了上一轮为什么怎么洗 Key 都没用：两站是同一套 API、同样的
   `Invalid token` 报错，只有域名不同（.com / .cn），而各自只认自己的 Key。
   应用把默认地址写死成 .com，国内站用户的 Key 永远不可能生效。

   要做三件事：
     1. 默认走国内站（用户大多在国内，.cn 是境内节点）
     2. 401/403 时自动试另一个站，成功就写回配置
     3. 两站都失败时明确说「已排除站点」，别让用户继续在字符上找问题

   顺带一个必须一起修的坑：isAgnesEndpoint 原来只认 .com。
   不认 .cn 的话，国内站端点拿不到双鉴权头、宽容首字节和参数裁剪，
   会变成一条「能用但处处别扭」的路径。

   运行：node tests/agnes-site-test.mjs
   ============================================================ */

import assert from "node:assert";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import {
  agnesSiteOf,
  agnesAltBaseUrl,
  formatOf,
  connectionProfile,
} from "../scripts/formats.js";
import { authChecklist } from "../scripts/apikeys.js";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log(`✓ ${name}${extra ? ` ${extra}` : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${extra ? ` ${extra}` : ""}`);
  }
}

console.log("\n[1] 站点识别");
{
  check("国内站识别为 cn", agnesSiteOf("https://apihub.agnes-ai.cn/v1") === "cn");
  check("国际站识别为 intl", agnesSiteOf("https://apihub.agnes-ai.com/v1") === "intl");
  check("无路径也认", agnesSiteOf("https://apihub.agnes-ai.cn") === "cn");
  check("带端口也认", agnesSiteOf("https://apihub.agnes-ai.cn:443/v1") === "cn");
  check("大小写不敏感", agnesSiteOf("https://APIHUB.AGNES-AI.CN/v1") === "cn");
  check("其他服务返回空", agnesSiteOf("https://api.openai.com/v1") === "");
  check("空值返回空", agnesSiteOf("") === "");
  check("后缀伪装不误判", agnesSiteOf("https://apihub.agnes-ai.com.evil.io/v1") === "");
  check("前缀伪装不误判", agnesSiteOf("https://notagnes-ai.cn/v1") === "");
}

console.log("\n[2] 换站地址");
{
  check(
    "cn → com 保留路径",
    agnesAltBaseUrl("https://apihub.agnes-ai.cn/v1") === "https://apihub.agnes-ai.com/v1"
  );
  check(
    "com → cn 保留路径",
    agnesAltBaseUrl("https://apihub.agnes-ai.com/v1") === "https://apihub.agnes-ai.cn/v1"
  );
  check("无路径互换", agnesAltBaseUrl("https://apihub.agnes-ai.com") === "https://apihub.agnes-ai.cn");
  check("自定义路径一并保留", agnesAltBaseUrl("https://apihub.agnes-ai.com/openai/v1") === "https://apihub.agnes-ai.cn/openai/v1");
  check("非 Agnes 返回空", agnesAltBaseUrl("https://api.deepseek.com") === "");
  check("空值返回空", agnesAltBaseUrl("") === "");
}

console.log("\n[3] 协议层认 .cn（这是最容易漏的一处）");
{
  const base = {
    modelId: "agnes-2.5-flash",
    messages: [{ role: "user", content: "ping" }],
    tools: [],
    stream: true,
    temperature: 0.3,
    maxTokens: 16,
    effort: null,
  };
  const oa = formatOf("openai").buildRequest({
    ...base,
    baseUrl: "https://apihub.agnes-ai.cn/v1",
    apiKey: "sk-abc",
  });
  check("国内站不带 stream_options（说明被当成 Agnes 了）", !("stream_options" in oa.body));
  const anth = formatOf("anthropic").buildRequest({
    ...base,
    baseUrl: "https://apihub.agnes-ai.cn/v1",
    apiKey: "sk-abc",
  });
  check("国内站 Anthropic 档双鉴权头", anth.headers.Authorization === "Bearer sk-abc" && anth.headers["x-api-key"] === "sk-abc");
  check("国内站也放宽首字节", connectionProfile("https://apihub.agnes-ai.cn/v1").firstByteSec === 90);
  check("其他服务不受影响", connectionProfile("https://api.deepseek.com").firstByteSec === 0);
}

console.log("\n[4] 自查清单把「Key 与站点同源」放第一条");
{
  const items = authChecklist("agnes");
  check("首条讲站点一致", /必须与站点一致/.test(items[0]), items[0].slice(0, 40));
  check("首条给出两个域名", items[0].includes("apihub.agnes-ai.cn") && items[0].includes("apihub.agnes-ai.com"));
  check("提到两站 Key 不通用", /不通用/.test(items[0]));
}

console.log("\n[5] 端到端：默认地址与自动换站");

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
  window.__reqs = [];
  // 按域名给状态码，模拟「这一站的 Key 不被接受」
  window.__rules = {};
  window.__answer = "pong";
  window.DshNative = {
    postStream(id, url, headersJson, bodyJson, timeoutSec, method) {
      const body = JSON.parse(bodyJson || "{}");
      const isGet = String(method || "POST").toUpperCase() === "GET";
      window.__reqs.push({ url, headers: JSON.parse(headersJson || "{}"), stream: body.stream !== false });
      const hit = Object.keys(window.__rules).find((k) => url.includes(k));
      const status = hit ? window.__rules[hit] : 200;
      setTimeout(() => {
        const send = (o) => window.__dshNativeEvent && window.__dshNativeEvent(JSON.stringify(o));
        send({ id, type: "status", status });
        if (status >= 200 && status < 300) {
          if (isGet) {
            // 拉模型列表走 GET，真实网关回一整包 JSON
            send({
              id,
              type: "chunk",
              data: JSON.stringify({
                object: "list",
                data: [
                  { id: "agnes-2.5-flash", object: "model" },
                  { id: "agnes-3.0-flash", object: "model" },
                ],
              }),
            });
          } else if (body.stream === false) {
            // testModel 走非流式：真实网关回一整包 JSON
            send({
              id,
              type: "chunk",
              data: JSON.stringify({
                id: "x",
                choices: [{ message: { role: "assistant", content: window.__answer }, finish_reason: "stop" }],
                usage: { total_tokens: 3 },
              }),
            });
          } else {
            send({ id, type: "chunk", data: `data: {"id":"x","choices":[{"delta":{"content":"${window.__answer}"},"finish_reason":null}]}\n\n` });
            send({ id, type: "chunk", data: `data: {"id":"x","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n` });
          }
          send({ id, type: "end" });
        } else {
          send({
            id,
            type: "error",
            status,
            message: `HTTP ${status}`,
            body: JSON.stringify({ error: { message: "Invalid token", type: "AgnesAI_error" } }),
          });
        }
      }, 5);
    },
    abort() {},
    getBinary() {},
  };
});

await page.goto(ORIGIN, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const prep = await page.evaluate(async () => {
  const st = await import("/scripts/store.js");
  st.setSettings({
    model: "agnes-site",
    keys: { ...st.state.settings.keys, agnes: "sk-CN-ONLY-abcdef123456" },
    memoryEnabled: false,
    maxSteps: 2,
  });
  st.addCustomModels([
    {
      id: "agnes-site",
      label: "Agnes 站点测试",
      apiModel: "agnes-2.5-flash",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      provider: "Agnes AI",
      providerKey: "agnes",
      format: "openai",
      ctx: 262144,
      vision: false,
      supportsEffort: false,
    },
  ]);
  st.setSettings({ model: "agnes-site" });
  const p = st.PROVIDERS.agnes;
  return {
    preset: p.baseUrl,
    endpoints: (p.endpoints || []).map((e) => e.baseUrl),
    console: p.console,
  };
});
check("预设默认走国内站", prep.preset === "https://apihub.agnes-ai.cn/v1", prep.preset);
check("端点场景含国内站", prep.endpoints.includes("https://apihub.agnes-ai.cn/v1"));
check("端点场景含国际站", prep.endpoints.includes("https://apihub.agnes-ai.com/v1"));
check("控制台指向国内站", /platform\.agnes-ai\.cn/.test(prep.console), prep.console);

// ---- 场景 A：国际站地址 + 只有国内站认的 Key ----
const a = await page.evaluate(async () => {
  const rt = await import("/scripts/runtime.js");
  const st = await import("/scripts/store.js");
  window.__reqs = [];
  window.__rules = { "apihub.agnes-ai.com": 401 };
  let out = null;
  let err = "";
  try {
    out = await rt.testModel("agnes-site");
  } catch (e) {
    err = e.message;
  }
  return {
    out,
    err,
    reqs: window.__reqs.map((r) => r.url),
    saved: st.modelBaseUrl(st.allModels().find((m) => m.id === "agnes-site")),
  };
});
check("A · 连接成功（换站生效）", !a.err && !!a.out, a.err);
check("A · 第一次打国际站", /agnes-ai\.com/.test(a.reqs[0] || ""), a.reqs[0]);
check("A · 第二次打国内站", a.reqs.length === 2 && /agnes-ai\.cn/.test(a.reqs[1] || ""), a.reqs[1]);
check("A · 返回 siteSwitched", a.out?.siteSwitched === true);
check("A · 返回 siteNote", /国内站/.test(a.out?.siteNote || ""), a.out?.siteNote?.slice(0, 30));
check("A · 配置写回 .cn", a.saved === "https://apihub.agnes-ai.cn/v1", a.saved);

// ---- 场景 B：对话链路也会换站 ----
const b = await page.evaluate(async () => {
  const rt = await import("/scripts/runtime.js");
  const st = await import("/scripts/store.js");
  // 退回国际站，模拟老用户存档（这一版之前默认就是 .com）
  st.saveModelOverride("agnes-site", { baseUrl: "https://apihub.agnes-ai.com/v1" });
  window.__reqs = [];
  window.__rules = { "apihub.agnes-ai.com": 401 };
  const session = st.createSession({ mode: "standard", title: "站点切换" });
  const msg = {
    id: "probe-site",
    role: "assistant",
    content: "",
    reasoning: "",
    tools: [],
    steps: 0,
    status: "running",
    createdAt: Date.now(),
  };
  session.messages.push(msg);
  await rt.runAgent({
    session,
    text: "ping",
    msg,
    attachments: [],
    signal: new AbortController().signal,
    onChange: () => {},
  });
  return {
    status: msg.status,
    content: msg.content,
    error: msg.error || "",
    reqs: window.__reqs.map((r) => r.url),
    saved: st.modelBaseUrl(st.allModels().find((m) => m.id === "agnes-site")),
  };
});
check("B · 对话没有失败", b.status === "done", `${b.status} ${b.error}`);
check("B · 拿到了回复", /pong/.test(b.content), b.content);
check("B · 先国际站后国内站", b.reqs.length === 2 && /\.com/.test(b.reqs[0]) && /\.cn/.test(b.reqs[1]), b.reqs.join(" → "));
check("B · 对话成功后也写回配置", b.saved === "https://apihub.agnes-ai.cn/v1", b.saved);

// ---- 场景 C：反方向 ----
const c = await page.evaluate(async () => {
  const rt = await import("/scripts/runtime.js");
  const st = await import("/scripts/store.js");
  st.saveModelOverride("agnes-site", { baseUrl: "https://apihub.agnes-ai.cn/v1" });
  window.__reqs = [];
  window.__rules = { "apihub.agnes-ai.cn": 401 };
  let out = null;
  let err = "";
  try {
    out = await rt.testModel("agnes-site");
  } catch (e) {
    err = e.message;
  }
  return {
    out,
    err,
    reqs: window.__reqs.map((r) => r.url),
    saved: st.modelBaseUrl(st.allModels().find((m) => m.id === "agnes-site")),
  };
});
check("C · 国际站 Key 也能反向切过去", c.out?.siteSwitched === true && c.out?.site === "intl");
check("C · 请求顺序 .cn → .com", /\.cn/.test(c.reqs[0] || "") && /\.com/.test(c.reqs[1] || ""), c.reqs.join(" → "));
check("C · 配置写回 .com", c.saved === "https://apihub.agnes-ai.com/v1", c.saved);

// ---- 场景 D：两站都拒绝 ----
const d = await page.evaluate(async () => {
  const rt = await import("/scripts/runtime.js");
  const st = await import("/scripts/store.js");
  st.saveModelOverride("agnes-site", { baseUrl: "https://apihub.agnes-ai.com/v1" });
  window.__reqs = [];
  window.__rules = { "apihub.agnes-ai.com": 401, "apihub.agnes-ai.cn": 401 };
  let err = null;
  try {
    await rt.testModel("agnes-site");
  } catch (e) {
    err = { message: e.message, hint: e.hint || "", status: e.httpStatus };
  }
  return {
    err,
    count: window.__reqs.length,
    saved: st.modelBaseUrl(st.allModels().find((m) => m.id === "agnes-site")),
  };
});
check("D · 两站都试过", d.count === 2, String(d.count));
check("D · 仍然抛错", !!d.err);
check("D · hint 明确说两站都拒绝", /两站都拒绝/.test(d.err?.hint || ""), (d.err?.hint || "").slice(-40));
check("D · 失败不改配置", d.saved === "https://apihub.agnes-ai.com/v1", d.saved);

// ---- 场景 E：403 也会换站 ----
const e = await page.evaluate(async () => {
  const rt = await import("/scripts/runtime.js");
  const st = await import("/scripts/store.js");
  st.saveModelOverride("agnes-site", { baseUrl: "https://apihub.agnes-ai.com/v1" });
  window.__reqs = [];
  window.__rules = { "apihub.agnes-ai.com": 403 };
  const out = await rt.testModel("agnes-site");
  return { out, reqs: window.__reqs.length };
});
check("E · 403 也当成可能的站点问题", e.out?.siteSwitched === true, String(e.reqs));

// ---- 场景 F：非 Agnes 不折腾 ----
const f = await page.evaluate(async () => {
  const st = await import("/scripts/store.js");
  st.addCustomModels([
    {
      id: "other-site",
      label: "别的服务",
      apiModel: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      provider: "DeepSeek",
      providerKey: "deepseek",
      format: "openai",
      ctx: 64000,
      vision: false,
      supportsEffort: false,
    },
  ]);
  st.setSettings({ model: "other-site", keys: { ...st.state.settings.keys, deepseek: "sk-x" } });
  const rt = await import("/scripts/runtime.js");
  window.__reqs = [];
  window.__rules = { "api.deepseek.com": 401 };
  let err = null;
  try {
    await rt.testModel("other-site");
  } catch (e) {
    err = e.message;
  }
  return { count: window.__reqs.length, err };
});
check("F · 非 Agnes 只请求一次", f.count === 1, String(f.count));
check("F · 非 Agnes 直接报错", !!f.err);

// ---- 场景 G：拉模型列表时也换站 ----
const g = await page.evaluate(async () => {
  const rt = await import("/scripts/runtime.js");
  window.__reqs = [];
  window.__rules = { "apihub.agnes-ai.com": 401 };
  const out = await rt.fetchModelList({
    format: "openai",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    apiKey: "sk-CN-ONLY",
    providerKey: "agnes",
  });
  return {
    switchedTo: out.switchedTo || "",
    ids: (out.items || []).map((i) => i.id),
    reqs: window.__reqs.map((r) => r.url),
  };
});
check("G · 拉列表也换站", g.switchedTo === "https://apihub.agnes-ai.cn/v1", g.switchedTo);
check("G · 返回模型 ID", g.ids.includes("agnes-2.5-flash"), g.ids.join(","));
check("G · 只多一次请求", g.reqs.length === 2, g.reqs.join(" → "));

check("无页面异常", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
server.close();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
