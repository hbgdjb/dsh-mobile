/**
 * 界面宿主（WebView 侧）的渲染测试
 *
 * ============ 这套测试在防什么 ============
 *
 * 界面树是第三方内容。渲染层有两个方向都可能出错：
 *
 *   一、画不出来 —— 挂了界面，页面上什么都没有（和桌面版那个
 *       "注册成功但不显示" 是同一个病）
 *
 *   二、画得太自由 —— 插件通过 text/style/img 把东西塞进宿主页面，
 *       比如 <img src=x onerror=...>、style="position:fixed"、
 *       background:url(https://evil)
 *
 * 所以断言分两组：能画对的形状要出现，能作恶的东西要消失。
 *
 * 用法：node tests/ui-host-test.mjs
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
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
// 启动动画会盖住前面几秒，等它退场
await page.waitForTimeout(4200);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

/** 在页面里拿到 ui-host 模块（和 app 用的是同一个实例）。 */
async function host() {
  return await page.evaluate(async () => {
    const m = await import("./scripts/ui-host.js");
    window.__uih = m;
    return true;
  });
}
await host();

/* ---------------- 一、能画出来 ---------------- */

console.log("\n渲染\n");

await page.evaluate(() => {
  window.__events = [];
  window.__uih.setActionSink((e) => window.__events.push(e));
  window.__uih.mount({
    id: "t1",
    slot: "composer.toolbar",
    pluginId: "demo",
    tree: {
      type: "card",
      title: "写作助手",
      subtitle: "插件提供的工具条",
      children: [
        {
          type: "row",
          gap: "sm",
          children: [
            { type: "badge", text: "实验" },
            { type: "button", label: "润色", action: "polish" },
            { type: "button", label: "删掉", action: "drop", tone: "danger" },
          ],
        },
      ],
    },
  });
});

const slotVisible = await page.evaluate(() => {
  const el = document.querySelector('[data-ui-slot="composer.toolbar"]');
  return { hidden: el.hidden, children: el.children.length };
});
check("挂载后占位符显示出来", slotVisible.hidden === false && slotVisible.children === 1, JSON.stringify(slotVisible));

const cardText = await page.evaluate(() => {
  const card = document.querySelector('[data-ui-slot="composer.toolbar"] .uih--card');
  return card ? card.innerText.replace(/\s+/g, " ").trim() : "";
});
check(
  "卡片标题与按钮文案渲染正确",
  cardText.includes("写作助手") && cardText.includes("润色"),
  cardText
);

const btnCount = await page.evaluate(
  () => document.querySelectorAll('[data-ui-slot="composer.toolbar"] .uih__btn').length
);
check("两个按钮都在", btnCount === 2, `count=${btnCount}`);

/* ---------------- 二、交互能回到插件 ---------------- */

await page.evaluate(() => {
  document.querySelector('[data-ui-slot="composer.toolbar"] [data-ui-action="polish"]').click();
});
await page.waitForTimeout(80);
const clickEvent = await page.evaluate(() => window.__events[window.__events.length - 1] || null);
check(
  "按钮点击把 action 发出去",
  clickEvent && clickEvent.action === "polish" && clickEvent.mountId === "t1",
  JSON.stringify(clickEvent)
);

/* ---------------- 三、恶意内容被挡住 ---------------- */

await page.evaluate(() => {
  window.__uih.mount({
    id: "t2",
    slot: "sidebar.footer",
    pluginId: "evil",
    tree: {
      type: "column",
      children: [
        // 文本里带标签：必须原样显示，不能被解析
        { type: "text", text: "<img src=x onerror=alert(1)><script>alert(2)</script>" },
        // 属性里塞事件处理器与样式：必须被丢掉
        { type: "button", label: "点我", action: "go", onclick: "alert(3)", style: "position:fixed;inset:0" },
        // http 图片：必须整节点被拒
        { type: "image", src: "http://example.com/a.png" },
        // javascript: 伪协议
        { type: "image", src: "javascript:alert(4)" },
        // 不在白名单里的组件
        { type: "iframe", src: "https://example.com" },
      ],
    },
  });
});

const safety = await page.evaluate(() => {
  const root = document.querySelector('[data-ui-slot="sidebar.footer"]');
  return {
    imgTags: root.querySelectorAll("img").length,
    scriptTags: root.querySelectorAll("script").length,
    iframeTags: root.querySelectorAll("iframe").length,
    inlineAttrs: Array.from(root.querySelectorAll("*")).filter(
      (el) => el.getAttribute("onclick") || el.getAttribute("onerror") || el.getAttribute("style")
    ).length,
    text: root.innerText,
  };
});
check("文本里的标签按文字显示，没有变成元素", safety.imgTags === 0 && safety.scriptTags === 0);
check(
  "文本保留了原始字符串（说明走的是 textContent）",
  safety.text.includes("<img src=x onerror=alert(1)>"),
  safety.text.slice(0, 60)
);
check("内联事件与 style 被丢弃", safety.inlineAttrs === 0, `count=${safety.inlineAttrs}`);
check(
  "不在白名单里的组件显示为提示，不渲染",
  safety.iframeTags === 0 && safety.text.includes("不支持的组件：iframe"),
  `iframe=${safety.iframeTags}`
);

/* ---------------- 四、上限 ---------------- */

await page.evaluate(() => {
  const many = Array.from({ length: 500 }, (_, i) => ({ type: "text", text: `行 ${i}` }));
  window.__uih.mount({ id: "t3", slot: "settings.section", pluginId: "big", tree: { type: "column", children: many } });
});

const capped = await page.evaluate(() => {
  // 挂载点在设置页，当前不在那一屏 —— 直接从注册表看
  return window.__uih.listMounts().length;
});
check("超量节点被截断但仍然挂上", capped >= 3, `mounts=${capped}`);

/* ---------------- 五、重渲染后还在 ---------------- */

// 切到工作区再切回对话：整个对话页会被 innerHTML 重写
await page.click('.tab[data-view="workspace"]');
await page.waitForTimeout(300);
await page.click('.tab[data-view="chat"]');
await page.waitForTimeout(400);

const afterRebuild = await page.evaluate(() => {
  const el = document.querySelector('[data-ui-slot="composer.toolbar"]');
  return { hidden: el?.hidden, btns: el?.querySelectorAll(".uih__btn").length || 0 };
});
check(
  "页面重写之后插件界面自己贴回来",
  afterRebuild.hidden === false && afterRebuild.btns === 2,
  JSON.stringify(afterRebuild)
);

/* ---------------- 六、卸载 ---------------- */

await page.evaluate(() => {
  window.__uih.unmount("t1");
});
const afterUnmount = await page.evaluate(() => {
  const el = document.querySelector('[data-ui-slot="composer.toolbar"]');
  return { hidden: el.hidden, children: el.children.length };
});
check("卸载后占位符重新收起来", afterUnmount.hidden === true && afterUnmount.children === 0, JSON.stringify(afterUnmount));

/* ---------------- 七、按插件批量清 ---------------- */

await page.evaluate(() => {
  window.__uih.mount({ id: "a1", slot: "composer.toolbar", pluginId: "p1", tree: { type: "text", text: "A1" } });
  window.__uih.mount({ id: "a2", slot: "composer.toolbar", pluginId: "p1", tree: { type: "text", text: "A2" } });
  window.__uih.mount({ id: "b1", slot: "composer.toolbar", pluginId: "p2", tree: { type: "text", text: "B1" } });
});
const cleared = await page.evaluate(() => window.__uih.unmountPlugin("p1"));
const rest = await page.evaluate(() => window.__uih.listMounts().map((m) => m.id));
check("unmountPlugin 只清自己的", cleared === 2 && rest.includes("b1") && !rest.includes("a1"), `cleared=${cleared} rest=${rest}`);

/* ---------------- 八、开关与输入 ---------------- */

await page.evaluate(() => {
  window.__events = [];
  window.__uih.mount({
    id: "form",
    slot: "composer.toolbar",
    pluginId: "demo",
    tree: {
      type: "column",
      children: [
        { type: "switch", label: "自动润色", checked: false, action: "toggle" },
        { type: "input", name: "q", placeholder: "关键词", action: "submit" },
      ],
    },
  });
});

await page.click('[data-ui-slot="composer.toolbar"] .uih__switch');
await page.waitForTimeout(80);
const toggle = await page.evaluate(() => window.__events[window.__events.length - 1] || null);
check("开关点击发出新状态", toggle && toggle.action === "toggle" && toggle.value === true, JSON.stringify(toggle));

const onState = await page.evaluate(
  () => document.querySelector('[data-ui-slot="composer.toolbar"] .uih__switch').getAttribute("aria-checked")
);
check("开关本地状态已翻转（不等插件回包）", onState === "true", `aria-checked=${onState}`);

await page.fill('[data-ui-slot="composer.toolbar"] .uih__field', "天气");
await page.press('[data-ui-slot="composer.toolbar"] .uih__field', "Enter");
await page.waitForTimeout(80);
const submit = await page.evaluate(() => window.__events[window.__events.length - 1] || null);
check(
  "输入框回车把值发出去",
  submit && submit.action === "submit" && submit.name === "q" && submit.value === "天气",
  JSON.stringify(submit)
);

/* ---------------- 九、表格 ---------------- */

console.log("\n表格与分页签\n");

// settings.section 只有设置页里才有占位符 —— 走真实入口进去
await page.click('[data-act="open-drawer"]');
await page.waitForTimeout(350);
await page.click('[data-act="open-settings"]');
await page.waitForTimeout(600);

await page.evaluate(() => {
  window.__events = [];
  window.__uih.mount({
    id: "tbl",
    slot: "settings.section",
    pluginId: "demo",
    tree: {
      type: "table",
      columns: [
        { key: "name", label: "文件" },
        { key: "size", label: "大小", align: "right" },
        { key: "state", label: "状态" },
      ],
      rows: [
        ["README.md", "2.1 KB", { text: "已同步", tone: "ok" }],
        { name: "notes.txt", size: "18 KB", state: { text: "冲突", tone: "danger" } },
      ],
    },
  });
});

const table = await page.evaluate(() => {
  const root = document.querySelector('[data-ui-slot="settings.section"]');
  return {
    heads: Array.from(root.querySelectorAll(".uih__table th")).map((e) => e.textContent),
    rows: Array.from(root.querySelectorAll(".uih__table tbody tr")).map((tr) =>
      Array.from(tr.children).map((td) => td.textContent)
    ),
    tones: Array.from(root.querySelectorAll(".uih__table td[data-tone]")).map((e) => e.dataset.tone),
    rightAligned: root.querySelectorAll('.uih__table td[data-align="right"]').length,
  };
});
check(
  "表头按 columns 渲染",
  JSON.stringify(table.heads) === JSON.stringify(["文件", "大小", "状态"]),
  JSON.stringify(table.heads)
);
check(
  "数组行与对象行都能渲染",
  JSON.stringify(table.rows) ===
    JSON.stringify([
      ["README.md", "2.1 KB", "已同步"],
      ["notes.txt", "18 KB", "冲突"],
    ]),
  JSON.stringify(table.rows)
);
check("单元格语义色生效", table.tones.includes("ok") && table.tones.includes("danger"), table.tones.join(","));
check("数字列右对齐", table.rightAligned === 2, `count=${table.rightAligned}`);

await page.evaluate(() => {
  window.__uih.mount({
    id: "tbl-empty",
    slot: "settings.section",
    pluginId: "demo",
    tree: { type: "table", columns: [{ key: "a", label: "A" }], rows: [], empty: "还没有记录" },
  });
});
const emptyTable = await page.evaluate(() => {
  const root = document.querySelector('[data-ui-slot="settings.section"]');
  return root.querySelector(".uih__table-empty")?.textContent || "";
});
check("空表格给出说明而不是一片空白", emptyTable === "还没有记录", emptyTable);

const cappedTable = await page.evaluate(() => {
  const cols = Array.from({ length: 12 }, (_, i) => ({ key: `c${i}`, label: `C${i}` }));
  const rows = Array.from({ length: 150 }, (_, i) => cols.map((c) => `${i}-${c.key}`));
  window.__uih.mount({ id: "tbl-big", slot: "settings.section", pluginId: "demo", tree: { type: "table", columns: cols, rows } });
  const root = document.querySelector('[data-ui-slot="settings.section"]');
  // 按挂载 id 精确定位 —— 这一屏里不止一张表
  const wrap = root.querySelector('[data-mount-id="tbl-big"] .uih__table');
  return {
    cols: wrap?.querySelectorAll("th").length || 0,
    rows: wrap?.querySelectorAll("tbody tr").length || 0,
  };
});
check("列数与行数封顶（8 列 / 100 行）", cappedTable.cols === 8 && cappedTable.rows === 100, JSON.stringify(cappedTable));

/* ---------------- 十、分页签 ---------------- */

// 回对话页 —— 页签挂在输入框上方
await page.click('[data-act="back"]');
await page.waitForTimeout(500);

await page.evaluate(() => {
  window.__events = [];
  window.__uih.mount({
    id: "tabs1",
    slot: "composer.toolbar",
    pluginId: "demo",
    tree: {
      type: "tabs",
      name: "view",
      value: "a",
      action: "switch-tab",
      children: [
        { label: "概览", value: "a", children: [{ type: "text", text: "第一页内容" }] },
        { label: "明细", value: "b", children: [{ type: "text", text: "第二页内容" }] },
      ],
    },
  });
});

const tabsInit = await page.evaluate(() => {
  const root = document.querySelector('[data-ui-slot="composer.toolbar"]');
  return {
    labels: Array.from(root.querySelectorAll(".uih__tab")).map((b) => b.textContent),
    selected: Array.from(root.querySelectorAll(".uih__tab")).map((b) => b.getAttribute("aria-selected")),
    visible: Array.from(root.querySelectorAll(".uih__panel")).map((p) => !p.hidden),
    text: root.innerText,
  };
});
check("两个页签都在，默认选第一个", JSON.stringify(tabsInit.labels) === JSON.stringify(["概览", "明细"]) &&
  tabsInit.selected[0] === "true" && tabsInit.selected[1] === "false", JSON.stringify(tabsInit.selected));
check("只显示选中的那一页", JSON.stringify(tabsInit.visible) === JSON.stringify([true, false]) && tabsInit.text.includes("第一页内容"));

await page.evaluate(() => {
  document.querySelectorAll('[data-ui-slot="composer.toolbar"] .uih__tab')[1].click();
});
await page.waitForTimeout(80);

const tabsAfter = await page.evaluate(() => {
  const root = document.querySelector('[data-ui-slot="composer.toolbar"]');
  return {
    visible: Array.from(root.querySelectorAll(".uih__panel")).map((p) => !p.hidden),
    ev: window.__events[window.__events.length - 1] || null,
  };
});
check("点第二个页签，内容本地切换（不等插件）", JSON.stringify(tabsAfter.visible) === JSON.stringify([false, true]), JSON.stringify(tabsAfter.visible));
check("同时把 action 发出去", tabsAfter.ev && tabsAfter.ev.action === "switch-tab" && tabsAfter.ev.value === "b", JSON.stringify(tabsAfter.ev));

// 插件回一棵新树（内容变了，但没指定 value）—— 选中的页签不能被重置
await page.evaluate(() => {
  window.__uih.update("tabs1", {
    type: "tabs",
    name: "view",
    action: "switch-tab",
    children: [
      { label: "概览", value: "a", children: [{ type: "text", text: "第一页内容" }] },
      { label: "明细", value: "b", children: [{ type: "text", text: "第二页的新内容" }] },
    ],
  });
});
await page.waitForTimeout(80);
const kept = await page.evaluate(() => {
  const root = document.querySelector('[data-ui-slot="composer.toolbar"]');
  return {
    selected: Array.from(root.querySelectorAll(".uih__tab")).map((b) => b.getAttribute("aria-selected")),
    text: root.innerText,
  };
});
check(
  "更新树之后选中的页签不变（本地状态被记住）",
  kept.selected[1] === "true" && kept.text.includes("第二页的新内容"),
  JSON.stringify(kept.selected)
);

/* ---------------- 十一、页面无报错 ---------------- */

check("全程没有 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
server.close();
console.log(failed ? `\n${failed} 项失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
