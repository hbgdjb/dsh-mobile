/**
 * 模型顺序一致性测试：会话上方「选择模型」与设置里的大类顺序必须完全一致。
 *
 * 做法：
 *   1) 注入多个厂牌的模型（乱序添加）
 *   2) 打开会话上方的「选择模型」面板，读出厂牌分组顺序
 *   3) 打开设置 →「模型管理」，读出厂牌分组顺序
 *   4) 打开设置 →「账号与服务」，读出服务列表顺序
 *   5) 三者 + PROVIDERS 定义顺序，四者必须一致
 *
 * 用法：node tests/model-order-test.mjs <rootDir> <label>
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = process.argv[2] || new URL("..", import.meta.url).pathname;
const LABEL = process.argv[3] || "current";
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
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

// 注入多个厂牌的模型（故意乱序添加），并给几个大厂也放上模型
await page.evaluate(async () => {
  const st = await import("./scripts/store.js");
  const mk = (id, label, slot, provider) => ({
    id,
    label,
    apiModel: id,
    provider,
    providerKey: slot,
    baseUrl: "https://example.test/v1",
    ctx: 128000,
    custom: true,
  });
  st.state.settings.customModels = [
    mk("zzz-last", "Zebra 自定义", "custom", "自定义"),
    mk("grok-4", "Grok 4", "openrouter", "OpenRouter"),
    mk("llama-3", "Llama 3", "ollama", "Ollama"),
    mk("ds-v4", "DeepSeek V4", "deepseek", "DeepSeek"),
    mk("glm-5", "GLM 5", "glm", "智谱 GLM"),
    mk("gpt-4.1", "GPT-4.1", "openai", "OpenAI"),
    mk("qwen3", "Qwen3", "qwen", "通义千问 · 阿里云百炼"),
    mk("mm-2", "MiniMax M2", "minimax", "MiniMax"),
  ];
  st.state.settings.model = "ds-v4";
  st.state.settings.keys = { deepseek: "sk-test" };
  st.state.settings.baseUrl = "https://example.test/v1";
  st.state.settings.apiKey = "sk-test";
  st.createSession({ mode: "standard", title: "顺序验证" });
  st.save(true);
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(700);

// 读出设置里的厂牌定义顺序（PROVIDERS 的 key 顺序）
const definedOrder = await page.evaluate(async () => {
  const st = await import("./scripts/store.js");
  const out = [];
  for (const [slot, p] of Object.entries(st.PROVIDERS)) out.push({ slot, name: p.name });
  window.__providerOrder = out;
  return out;
});

// 1) 会话上方 → 模型 chip → 「选择模型」
await page.click('.chip[data-act="open-model"]');
await page.waitForSelector('[data-act="open-model-list"]', { timeout: 8000 });
await page.click('[data-act="open-model-list"]');
await page.waitForSelector('[data-act="set-model"]', { timeout: 8000 });
await page.waitForTimeout(300);

const pickerGroups = await page.evaluate(() => {
  // 只读「选择模型」面板里的分组标题
  const scope = document.querySelector("#sheet-layer .sheet") || document;
  return [...scope.querySelectorAll(".model-group__head .eyebrow:first-child")].map((e) => e.textContent.trim());
});

const pickerOrder = await page.evaluate(() => {
  // 厂牌名 → slot 的映射，从 model 行反推
  const rows = [...document.querySelectorAll('[data-act="set-model"]')];
  const byLabel = new Map();
  for (const r of rows) {
    const name = r.querySelector(".card__sub")?.textContent?.split(" · ")[0]?.trim() || "";
    byLabel.set(r.dataset.value, name);
  }
  return byLabel;
});
await page.screenshot({ path: `/tmp/shot-modelorder-picker-${LABEL}.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// 2) 设置 → 模型管理
// 设置页入口在抽屉里：先开抽屉，再进设置，再进「当前模型」分类里的「模型管理」
await page.evaluate(() => {
  const el = document.querySelector('[data-act="open-drawer"], .appbar [data-act="menu"]');
  if (el) el.click();
});
await page.waitForTimeout(500);
await page.evaluate(() => {
  const el = document.querySelector('[data-act="open-settings"]');
  if (el) el.click();
});
await page.waitForTimeout(600);
await page.evaluate(() => {
  // 「模型管理」入口在设置的「账号与服务」分类下
  const el = document.querySelector('[data-act="settings-cat"][data-value="account"]');
  if (el) el.click();
});
await page.waitForTimeout(700);
await page.evaluate(() => {
  const el = document.querySelector('[data-act="open-models"]');
  if (el) el.click();
});
await page.waitForSelector("#sheet-layer .sheet .model-group__head", { timeout: 8000 }).catch(() => {
  console.log("  [warn] 未等到模型管理分组标题");
});
await page.waitForTimeout(400);

const manageGroups = await page.evaluate(() => {
  const scope = document.querySelector("#sheet-layer .sheet") || document;
  return [...scope.querySelectorAll(".model-group__head .eyebrow:first-child")].map((e) => e.textContent.trim());
});
await page.screenshot({ path: `/tmp/shot-modelorder-manage-${LABEL}.png` });

// 3) 设置 → 账号与服务
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await page.evaluate(() => {
  const el = document.querySelector('[data-act="open-account"]');
  if (el) el.click();
});
await page.waitForSelector("#sheet-layer .sheet .provider-row__name", { timeout: 8000 }).catch(() => {
  console.log("  [warn] 未等到账号与服务列表");
});
await page.waitForTimeout(400);
const accountOrder = await page.evaluate(() => {
  const scope = document.querySelector("#sheet-layer .sheet") || document;
  return [...scope.querySelectorAll(".provider-row__name")].map((e) => e.textContent.trim());
});
await page.screenshot({ path: `/tmp/shot-modelorder-account-${LABEL}.png` });

console.log(`\n===== ${LABEL} / 模型顺序一致性 =====`);
console.log("PROVIDERS 定义顺序 :", definedOrder.length, "个 →", JSON.stringify(definedOrder.map((x) => x.name)));
console.log("选择模型 · 厂牌分组 :", JSON.stringify(pickerGroups));
console.log("模型管理 · 厂牌分组 :", JSON.stringify(manageGroups));
console.log("账号与服务 · 服务序 :", accountOrder.length, "个");

// 判定：两个面板的厂牌名序列必须一致
const samePickerManage = JSON.stringify(pickerGroups) === JSON.stringify(manageGroups);

// 判定：选择模型的厂牌名序列必须与 PROVIDERS 定义顺序（按显示名过滤后）一致
// definedOrder 是 [{slot,name}]，按定义顺序取 name，再只保留面板里真实出现的那些
const definedNames = definedOrder.map((x) => x.name);
const expectedNames = definedNames.filter((n) => pickerGroups.includes(n));
const pickerMatchesDefined = JSON.stringify(pickerGroups) === JSON.stringify(expectedNames);

// 判定：账号与服务的服务顺序必须是 PROVIDERS 定义顺序（全量，不做过滤）
const accountMatchesDefined = JSON.stringify(accountOrder) === JSON.stringify(definedNames);

console.log("\n----- 判定 -----");
console.log(`选择模型 == 模型管理（顺序一致） : ${samePickerManage ? "✓" : "✗"}`);
console.log(`选择模型 == 设置大类定义顺序      : ${pickerMatchesDefined ? "✓" : "✗"}`);
console.log(`  期望 : ${JSON.stringify(expectedNames)}`);
console.log(`  实际 : ${JSON.stringify(pickerGroups)}`);
console.log(`账号与服务 == 设置大类定义顺序    : ${accountMatchesDefined ? "✓" : "✗"}`);

await browser.close();
server.close();
process.exit(samePickerManage && pickerMatchesDefined && accountMatchesDefined ? 0 : 1);
