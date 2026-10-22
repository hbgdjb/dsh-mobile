/**
 * 插件界面的端到端测试。
 *
 * 覆盖用户真正会走的那条路：
 *   插件页 → 安装插件 → 填清单 URL → 拉取并检查 → 看权限 → 安装 → 出现在已装列表 → 详情页有沙箱信息 → 卸载
 *
 * 用法：node tests/plugin-ui-test.mjs
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

/* 一份测试用的第三方插件清单（从 URL 拉的那条路径） */
const TEST_PLUGIN = {
  id: "uihello",
  name: "UI 测试插件",
  version: "0.3.1",
  description: "一个专门用来验证安装流程的第三方插件。",
  author: "someone",
  homepage: "https://example.com/uihello",
  permissions: ["fs.read"],
  tools: [{ name: "uihello", description: "打个招呼" }],
  code: `
dsh.registerTool({ name: "uihello", description: "打个招呼", parameters: { type: "object", properties: {} } }, function (args) {
  return "hello from uihello";
});
`,
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
  const p = decodeURIComponent(req.url.split("?")[0]);
  // 插件清单：模拟第三方站点
  if (p === "/uihello.json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(TEST_PLUGIN));
    return;
  }
  try {
    let f = p === "/" ? "/index.html" : p;
    const file = join(ROOT, normalize(f).replace(/^(\.\.[/\\])+/, ""));
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
await page.waitForTimeout(900);

/* ---------- 1. 插件页有「安装插件」入口 ---------- */
await page.click('.tab[data-view="plugins"]');
await page.waitForTimeout(400);

const entry = await page.evaluate(() => {
  const row = [...document.querySelectorAll('[data-act="plugin-search"]')].find((e) => e.classList.contains("creator-row"));
  return {
    found: !!row,
    text: row ? row.textContent.replace(/\s+/g, " ").trim() : "",
  };
});
check("插件页有「安装插件」入口", entry.found, entry.text);
check("入口文案提到官方清单或地址", /官方清单|插件清单地址/.test(entry.text), entry.text);

/* ---------- 2. 打开安装面板：URL 输入框 + 官方清单 ---------- */
await page.click('.creator-row[data-act="plugin-search"]');
await page.waitForTimeout(400);

const sheet = await page.evaluate(() => {
  const s = document.querySelector(".sheet");
  return {
    open: !!s,
    title: s?.querySelector(".sheet__title")?.textContent || "",
    hasUrlInput: !!s?.querySelector("#plugin-url"),
    urlPlaceholder: s?.querySelector("#plugin-url")?.getAttribute("placeholder") || "",
    hasFetchBtn: !!s?.querySelector('[data-act="plugin-fetch-url"]'),
    hasSearch: !!s?.querySelector("#catalog-search"),
    officialCount: s?.querySelectorAll("#catalog-list .plugin-card").length || 0,
    officialNames: [...(s?.querySelectorAll("#catalog-list .plugin-card__name") || [])].map((e) => e.textContent.trim()),
    hasInstallBtns: (s?.querySelectorAll('#catalog-list [data-act="install-plugin"]').length || 0),
  };
});
check("安装面板已打开", sheet.open, sheet.title);
check("有插件清单地址输入框", sheet.hasUrlInput, sheet.urlPlaceholder);
check("有「拉取并检查」按钮", sheet.hasFetchBtn);
check("有官方清单搜索框", sheet.hasSearch);
check("官方清单有条目", sheet.officialCount >= 3, `${sheet.officialCount} 条：${sheet.officialNames.join(" / ")}`);
check("官方清单条目有安装按钮", sheet.hasInstallBtns >= 3, `${sheet.hasInstallBtns} 个`);

/* 官方清单搜索 */
await page.fill("#catalog-search", "字数");
await page.waitForTimeout(500);
// 搜索是就地隐藏（display:none），所以要数「可见」的条目
const searched = await page.evaluate(() => {
  const cards = [...document.querySelectorAll("#catalog-list .plugin-card")];
  const visible = cards.filter((c) => c.style.display !== "none");
  return {
    count: visible.length,
    total: cards.length,
    names: visible.map((c) => c.querySelector(".plugin-card__name")?.textContent.trim()),
  };
});
check(
  "按名字搜官方清单能过滤",
  searched.count >= 1 && searched.count < searched.total,
  `${searched.count}/${searched.total}：${searched.names.join("/")}`
);
await page.fill("#catalog-search", "");
await page.waitForTimeout(400);

/* ---------- 3. 填 URL → 拉取并检查 → 摊开权限 ---------- */
await page.fill("#plugin-url", base + "/uihello.json");
await page.click('[data-act="plugin-fetch-url"]');
await page.waitForTimeout(1200);

const inspect = await page.evaluate(() => {
  const c = document.querySelector("#plugin-inspect .card");
  const txt = c?.textContent.replace(/\s+/g, " ").trim() || "";
  const kvs = [...(c?.querySelectorAll(".kv") || [])].map((e) => ({
    k: e.querySelector("span")?.textContent.trim(),
    v: e.querySelector("b")?.textContent.trim(),
  }));
  return {
    hasCard: !!c,
    txt,
    kvs,
    hasInstallBtn: !!document.querySelector('#plugin-inspect [data-act="plugin-confirm-install"]'),
    warnings: [...document.querySelectorAll("#plugin-inspect .key-warning span")].map((e) => e.textContent.trim()),
  };
});
check("URL 清单被拉取并渲染出预览卡", inspect.hasCard, inspect.txt.slice(0, 80));
const permKv = inspect.kvs.find((x) => x.k === "申请能力");
check("预览卡摊开了申请能力", !!permKv && permKv.v.includes("读取工作区文件"), permKv?.v || "无");
const toolKv = inspect.kvs.find((x) => x.k === "提供工具");
check("预览卡列出插件提供的工具", !!toolKv && toolKv.v.includes("uihello"), toolKv?.v || "无");
check("预览卡有确认安装按钮", inspect.hasInstallBtn);
check("权限风险有提示", inspect.warnings.length >= 1, inspect.warnings.join(" | "));

/* ---------- 4. 安装 ---------- */
await page.click('#plugin-inspect [data-act="plugin-confirm-install"]');
await page.waitForTimeout(1500);

const installed = await page.evaluate(async () => {
  const { state } = await import("/scripts/store.js");
  const host = await import("/scripts/plugin-host.js");
  const p = state.plugins.find((x) => x.id === "uihello");
  return {
    inState: !!p,
    enabled: p?.enabled,
    codePath: p?.codePath,
    source: p?.source,
    permissions: p?.permissions,
    tools: (host.registeredTools ? host.registeredTools() : []).map((t) => t.name),
    loaded: host.isLoaded ? host.isLoaded("uihello") : false,
  };
});
check("插件已写入已装列表", installed.inState);
check("安装后默认启用", installed.enabled === true);
check("代码落到工作区文件", /plugins\/uihello\/main\.js/.test(installed.codePath || ""), installed.codePath);
check("记录了来源", !!installed.source, installed.source);
check("记录了权限声明", (installed.permissions || []).includes("fs.read"), JSON.stringify(installed.permissions));
check("沙箱已装载", installed.loaded === true);
check("插件工具已注册", (installed.tools || []).includes("uihello"), JSON.stringify(installed.tools));

/* 已装列表在插件页可见 */
await page.click('.sheet [data-act="close-sheet"]');
await page.waitForTimeout(500);
const listed = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#view-plugins .plugin-row")];
  return {
    count: rows.length,
    names: rows.map((r) => r.querySelector(".plugin-row__name")?.textContent.trim()).filter(Boolean),
  };
});
check("已装插件出现在插件页", listed.names.includes("UI 测试插件"), listed.names.join(" / "));

/* ---------- 5. 详情页有沙箱说明 ---------- */
await page.click('#view-plugins .plugin-row__name[data-id="uihello"]');
await page.waitForTimeout(500);
const detail = await page.evaluate(() => {
  const s = document.querySelector(".sheet");
  const txt = s?.textContent.replace(/\s+/g, " ").trim() || "";
  return {
    has: !!s,
    txt,
    hasUninstall: !!s?.querySelector('[data-act="uninstall-plugin"][data-id="uihello"]'),
  };
});
check("插件详情页已打开", detail.has);
check("详情页说明沙箱运行环境", /独立 iframe 沙箱/.test(detail.txt));
check("详情页列出申请能力", /读取工作区文件/.test(detail.txt));
check("详情页有卸载按钮", detail.hasUninstall);

/* ---------- 6. 卸载 ---------- */
await page.click('.sheet [data-act="uninstall-plugin"][data-id="uihello"]');
await page.waitForTimeout(1200);

const after = await page.evaluate(async () => {
  const { state } = await import("/scripts/store.js");
  const host = await import("/scripts/plugin-host.js");
  return {
    inState: state.plugins.some((x) => x.id === "uihello"),
    loaded: host.isLoaded ? host.isLoaded("uihello") : false,
    tools: (host.registeredTools ? host.registeredTools() : []).map((t) => t.name),
  };
});
check("卸载后从已装列表移除", after.inState === false);
check("卸载后沙箱已销毁", after.loaded === false);
check("卸载后工具不再注册", !(after.tools || []).includes("uihello"), JSON.stringify(after.tools));

check("无未捕获异常", pageErr === 0, `${pageErr} 个`);

await browser.close();
server.close();

console.log(`\n${fail === 0 ? "✓ 全部通过" : `✗ ${fail} 项失败`}（${pass + fail} 项）`);
process.exit(fail === 0 ? 0 : 1);
