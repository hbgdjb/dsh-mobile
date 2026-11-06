/**
 * OpenDesign 供应商测试（0.67.0 重写）
 *
 * 上一版整个建立在一个错误前提上：把 OpenDesign 当成本机 5712 端口的
 * 「od proxy」，不校验 Key、上下文 200K、预置 claude-sonnet-4-5 等模型。
 * 实际上 open-design.ai 是**订阅制云端模型网关**：
 *
 *   amr-link.open-design.ai/v1  推理（/models、/chat/completions）  → sk-amr-… 真 Key
 *   amr-api.open-design.ai      账户 / 钱包 / 额度                → vela_ctrl_… controlKey
 *
 * 所以这里的断言几乎全部反转：必须有真 Key、不能标 local、不能塞占位符、
 * 模型不能硬编码（套餐不同可用模型不同，走 GET /v1/models 实时探测）。
 *
 * 用法：node tests/opendesign-provider-test.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { FORMATS } from "../scripts/formats.js";

const ROOT = process.argv[2] || new URL("..", import.meta.url).pathname;
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

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

/* ---------- 1. 协议层：/v1/models 探测（纯 Node，不需要浏览器） ---------- */
{
  const seen = [];
  const fakeRequest = async ({ url, headers }) => {
    seen.push({ url, auth: headers.Authorization });
    return {
      status: 200,
      text: JSON.stringify({
        data: [
          { id: "deepseek-v4.1-flash" },
          { id: "claude-haiku-5.5" },
          { id: "kimi-k2.7-code" },
        ],
      }),
    };
  };
  const out = await FORMATS.openai.listModels({
    baseUrl: "https://amr-link.open-design.ai/v1",
    apiKey: "sk-amr-testkey",
    request: fakeRequest,
  });
  check("探测打的是 /v1/models", seen[0]?.url === "https://amr-link.open-design.ai/v1/models", seen[0]?.url);
  check("鉴权头是 Bearer 真 Key", seen[0]?.auth === "Bearer sk-amr-testkey", seen[0]?.auth);
  check("解析出套餐模型（不是写死的目录）",
    out.items.length === 3 && out.items.some((it) => it.id === "deepseek-v4.1-flash"),
    out.items.map((i) => i.id).join(", "));

  let emptyErr = "";
  try {
    await FORMATS.openai.listModels({ baseUrl: "https://amr-link.open-design.ai/v1", apiKey: "", request: fakeRequest });
  } catch (e) { emptyErr = e.message; }
  check("没填 Key 时明确要求先填 Key", /Key/.test(emptyErr), emptyErr);
}

/* ---------- 2. 浏览器：预设、Key 语义与界面 ---------- */
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.evaluate(() => window.DshSplash?.exit?.());
await page.waitForTimeout(1200);

const def = await page.evaluate(async () => {
  const st = await import("./scripts/store.js");
  const p = st.PROVIDERS.opendesign;
  return p ? {
    name: p.name, baseUrl: p.baseUrl, format: p.format, local: !!p.local,
    placeholder: p.placeholderKey || "", ctx: p.defaultCtx,
    suggest: (p.suggest || []).map((s) => (typeof s === "string" ? s : s.id)),
    endpoints: p.endpoints || [], console: p.console, hint: p.hint,
  } : null;
});
check("PROVIDERS 里有 opendesign", !!def, def?.name);
check("名字标明是 Cloud API（不是本地代理）", /Cloud API/.test(def?.name || "") && !/本地/.test(def?.name || ""), def?.name);
check("端点指向云端 amr-link /v1", def?.baseUrl === "https://amr-link.open-design.ai/v1", def?.baseUrl);
check("默认协议是 Chat Completions", def?.format === "openai", String(def?.format));
check("没有标 local", def?.local === false, String(def?.local));
check("没有占位 Key", def?.placeholder === "", def?.placeholder || "（空）");
check("常用模型是 12 个核实过的真实 ID（不是显示名）",
  def?.suggest.length === 12 &&
  def.suggest.every((id) => /^[a-z0-9._-]+$/.test(id)) &&
  def.suggest.includes("deepseek-v4.1-flash"),
  def?.suggest.join(", ") || "（空）");
check("两个协议场景且各带格式",
  def?.endpoints.length === 2 &&
  def.endpoints.some((e) => e.format === "openai" && /\/v1$/.test(e.baseUrl)) &&
  def.endpoints.some((e) => e.format === "anthropic" && !/\/v1$/.test(e.baseUrl)),
  JSON.stringify(def?.endpoints));
check("控制台指向 Cloud dashboard", /open-design\.ai\/cloud\/dashboard/.test(def?.console || ""), def?.console);
check("说明写清套餐与 50 MiB 上限",
  /Go \/ Plus \/ Pro \/ Max/.test(def?.hint || "") && /50 MiB/.test(def?.hint || ""),
  (def?.hint || "").slice(0, 60) + "…");

/* Key 语义：反转旧断言 —— 没 Key 就是没 Key */
const keys = await page.evaluate(async () => {
  const st = await import("./scripts/store.js");
  st.state.settings.keys = {};
  const none = st.apiKeyFor({ providerKey: "opendesign" });
  const noneHas = st.hasKeyFor({ providerKey: "opendesign" });
  const ollama = st.apiKeyFor({ providerKey: "ollamaNative" });
  st.state.settings.keys = { opendesign: "sk-amr-abc123" };
  const withKey = st.apiKeyFor({ providerKey: "opendesign" });
  const withKeyHas = st.hasKeyFor({ providerKey: "opendesign" });
  st.state.settings.keys = {};
  return { none, noneHas, withKey, withKeyHas, ollama };
});
check("无 Key 时返回空串（不再塞 od-local）", keys.none === "", keys.none || "（空）");
check("无 Key 时视为未配置", keys.noneHas === false, String(keys.noneHas));
check("有 Key 时原样使用", keys.withKey === "sk-amr-abc123", keys.withKey);
check("有 Key 时视为已配置", keys.withKeyHas === true, String(keys.withKeyHas));
check("没误伤真正的本地服务（ollamaNative 仍免 Key）", keys.ollama === "ollama-local", String(keys.ollama));

/* 账号与服务列表 */
await page.evaluate(() => document.querySelector('[data-act="open-settings"]')?.click());
await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector('[data-act="settings-cat"][data-value="account"]')?.click());
await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector('[data-act="open-account"]')?.click());
await page.waitForSelector("#sheet-layer .provider-row__name", { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(400);

const row = await page.evaluate(() => {
  const el = document.querySelector('[data-act="open-provider"][data-slot="opendesign"]');
  return el ? el.innerText.replace(/\n/g, " | ") : null;
});
check("列表里出现 OpenDesign Cloud API", !!row && /OpenDesign/.test(row) && /Cloud API/.test(row), row || "没找到");
check("未填 Key 时如实显示「未配置 Key」", !!row && /未配置 Key/.test(row), row || "");
check("不再谎称「无需 Key」", !!row && !/无需 Key/.test(row), row || "");
await page.screenshot({ path: "/tmp/shot-od-list.png" });

/* 添加模型面板 */
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector('[data-act="new-custom-model"]')?.click());
await page.waitForTimeout(500);

const form = await page.evaluate(async () => {
  const sel = document.querySelector("#cm-provider");
  if (!sel) return { error: "没有供应方下拉" };
  sel.value = "opendesign";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const key = document.querySelector("#cm-key");
  return {
    option: sel.options[sel.selectedIndex]?.textContent.trim(),
    base: document.querySelector("#cm-base")?.value || "",
    fmt: document.querySelector("#cm-format")?.value || "",
    ctx: document.querySelector("#cm-ctx")?.value || "",
    keyPlaceholder: key?.placeholder || "",
    suggest: [...document.querySelectorAll("#cm-suggest .chip")].map((c) => c.textContent.trim()),
    scenes: [...document.querySelectorAll("#cm-scenes .chip")].map((c) => ({
      label: c.textContent.trim(), url: c.dataset.url, format: c.dataset.format || "",
    })),
  };
});
check("下拉里有 OpenDesign 且不带 5712", /OpenDesign/.test(form.option || "") && !/5712/.test(form.option || ""), form.option);
check("切换后云端端点自动填好", form.base === "https://amr-link.open-design.ai/v1", form.base);
check("切换后格式是 openai", form.fmt === "openai", form.fmt);
check("Key 占位不再写「可留空」", !/可留空/.test(form.keyPlaceholder), form.keyPlaceholder || "（空）");
const suggestIds = form.suggest.map((s) => String(s).split(" · ")[0]);
check("常用模型只给真实 ID，没有显示名 / 旧的假 ID",
  suggestIds.length === 12 &&
  suggestIds.every((id) => /^[a-z0-9._-]+$/.test(id)) &&
  !suggestIds.some((id) => /claude-sonnet-4-5|deepseek-chat/.test(id)) &&
  suggestIds.includes("deepseek-v4.1-flash"),
  suggestIds.join(" / ") || "（空）");
check("端点场景 chip 带协议信息",
  form.scenes.length === 2 && form.scenes.every((s) => s.format),
  JSON.stringify(form.scenes));

/* 点 Messages 场景：地址与格式要一起切，否则打出 404 */
const switched = await page.evaluate(async () => {
  const chip = [...document.querySelectorAll("#cm-scenes .chip")].find((c) => /Messages/.test(c.textContent));
  if (!chip) return { error: "没有 Messages 场景" };
  chip.click();
  await new Promise((r) => setTimeout(r, 200));
  return {
    base: document.querySelector("#cm-base")?.value || "",
    fmt: document.querySelector("#cm-format")?.value || "",
    preview: document.querySelector("#cm-endpoint-preview")?.textContent || "",
  };
});
check("Messages 场景把格式切到 anthropic", switched.fmt === "anthropic", switched.fmt);
check("Messages 场景把 /v1 去掉", switched.base === "https://amr-link.open-design.ai", switched.base);
check("端点预览跟着变成 /v1/messages", /\/v1\/messages/.test(switched.preview || ""), (switched.preview || "").slice(0, 90));
await page.screenshot({ path: "/tmp/shot-od-add.png" });

/* ---------- 汇总 ---------- */
const fail = results.filter((r) => !r.ok);
console.log(`\n${results.length - fail.length}/${results.length} 项通过`);
await browser.close();
server.close();
process.exit(fail.length ? 1 : 0);
