import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};
const s = createServer(async (req, res) => {
  try {
    let p = req.url.split("?")[0];
    if (p === "/") p = "/index.html";
    const f = join(ROOT, normalize(p));
    const b = await readFile(f);
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
await new Promise((r) => s.listen(0, r));
const port = s.address().port;

const b = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--force-device-scale-factor=2"],
});
const p = await b.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
await p.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await p.waitForTimeout(4600);

await p.evaluate(async () => {
  const st = await import("/scripts/store.js");
  const ui = await import("/scripts/ui-host.js");
  window.__uih = ui;
  st.createSession({ mode: "standard", title: "把周报整理一下" });
  st.save(true);
});
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(4600);

// 对话页：输入框上方的插件工具条
await p.evaluate(async () => {
  const ui = await import("/scripts/ui-host.js");
  ui.mount({
    id: "shot-toolbar",
    slot: "composer.toolbar",
    pluginId: "writing-kit",
    tree: {
      type: "row",
      gap: "sm",
      align: "center",
      children: [
        { type: "badge", text: "写作套件", tone: "accent" },
        { type: "text", text: "选中文字后可", tone: "muted", size: "sm" },
        { type: "button", label: "润色", action: "polish" },
        { type: "button", label: "缩写", action: "shorten" },
        { type: "button", label: "改成周报", action: "weekly", tone: "primary" },
      ],
    },
  });
  ui.mount({
    id: "shot-overlay",
    slot: "shell.overlay",
    pluginId: "writing-kit",
    tree: {
      type: "card",
      title: "本周已写 3 篇",
      subtitle: "距离目标还差 2 篇 · 周五前",
      children: [{ type: "progress", value: 0.6, label: "3 / 5 篇" }],
    },
  });
});
await p.waitForTimeout(300);
await p.screenshot({ path: "artifacts/ui-slot-chat.png" });

// 抽屉底部
await p.evaluate(async () => {
  const ui = await import("/scripts/ui-host.js");
  ui.mount({
    id: "shot-drawer",
    slot: "sidebar.footer",
    pluginId: "writing-kit",
    tree: {
      type: "row",
      gap: "sm",
      align: "center",
      children: [
        { type: "badge", text: "本周 3 篇" },
        { type: "text", text: "写作套件", tone: "muted", size: "sm" },
      ],
    },
  });
});
await p.click('[data-act="open-drawer"]');
await p.waitForTimeout(500);
await p.screenshot({ path: "artifacts/ui-slot-drawer.png" });

// 设置页
await p.evaluate(async () => {
  const ui = await import("/scripts/ui-host.js");
  ui.mount({
    id: "shot-settings",
    slot: "settings.section",
    pluginId: "writing-kit",
    tree: {
      type: "card",
      title: "写作套件",
      subtitle: "v1.2.0 · 由插件提供",
      children: [
        {
          type: "column",
          gap: "sm",
          children: [
            { type: "switch", label: "发送前自动检查错别字", checked: true, action: "toggle-typo" },
            { type: "select", label: "默认文风", options: [{ value: "plain", label: "平实" }, { value: "weekly", label: "周报" }], value: "weekly", action: "style" },
            { type: "button", label: "打开插件设置", action: "open", tone: "ghost" },
          ],
        },
      ],
    },
  });
});
await p.click('[data-act="close-drawer"]');
await p.waitForTimeout(300);
await p.evaluate(async () => {
  const ui = await import("/scripts/ui.js");
  // 直接走导航：设置页
  document.querySelector('[data-act="open-drawer"]').click();
});
await p.waitForTimeout(300);
await p.click('[data-act="open-settings"]');
await p.waitForTimeout(700);
await p.screenshot({ path: "artifacts/ui-slot-settings.png" });

// 表格与分页签
await p.evaluate(async () => {
  const ui = await import("/scripts/ui-host.js");
  ui.mount({
    id: "shot-tabs",
    slot: "settings.section",
    pluginId: "writing-kit",
    order: 9,
    tree: {
      type: "tabs",
      name: "kit-view",
      value: "list",
      action: "kit-tab",
      children: [
        {
          label: "本周",
          value: "list",
          children: [
            {
              type: "table",
              columns: [
                { key: "doc", label: "文档" },
                { key: "words", label: "字数", align: "right" },
                { key: "state", label: "状态" },
              ],
              rows: [
                ["周报 · 第 43 周", "1,284", { text: "已发布", tone: "ok" }],
                ["需求评审纪要", "862", { text: "草稿", tone: "muted" }],
                ["接口变更说明", "2,105", { text: "待确认", tone: "warn" }],
              ],
            },
          ],
        },
        {
          label: "统计",
          value: "stat",
          children: [{ type: "text", text: "共 3 篇 · 4,251 字 · 平均 1,417 字", tone: "muted", size: "sm" }],
        },
      ],
    },
  });
});
await p.evaluate(async () => {
  const ui = await import("/scripts/ui.js");
  document.querySelector('[data-act="back"]')?.click();
});
await p.waitForTimeout(500);
await p.click('[data-act="open-drawer"]');
await p.waitForTimeout(300);
await p.click('[data-act="open-settings"]');
await p.waitForTimeout(600);
// 表格在设置页最下面，滚到底再拍
await p.evaluate(() => {
  const sc = document.querySelector(".settings.scroll");
  if (sc) sc.scrollTop = sc.scrollHeight;
});
await p.waitForTimeout(400);
await p.screenshot({ path: "artifacts/ui-slot-table.png" });

await b.close();
s.close();
console.log("ok");
