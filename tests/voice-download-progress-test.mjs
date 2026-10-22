/* ============================================================
   语音模型下载进度条实时刷新（0.35.0 补）

   守的是一个用户可见的故障：
   下载进行中，进度条纹丝不动；点一下别的按钮，它才跳到当前值。

   根因：判断"当前是不是设置页"时写成了 `ui.screen === "settings"`，
   而那个字段根本不存在（实际叫 `ui.view`）—— 条件恒为假，
   重绘从来没被触发过。事件到了、状态也存了，就是没人去画。
   ============================================================ */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}${extra ? " " + extra : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${extra ? " " + extra : ""}`);
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = join(ROOT, decodeURIComponent(url.pathname));
    const body = await readFile(p);
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

/* ============================================================
   一、局部绘制：只改两个属性，不重建页面
   ============================================================ */

const painted = await page.evaluate(async () => {
  const ui = await import("./scripts/ui.js");

  // 造出与设置页一致的节点结构
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="dl-host">
       <div id="voice-dl-label">正在下载离线模型 0%</div>
       <div id="voice-dl-bar" style="width:0%"></div>
     </div>`
  );

  const bar0 = document.querySelector("#voice-dl-bar");

  ui.paintVoiceProgress(37);
  const at37 = {
    w: document.querySelector("#voice-dl-bar").style.width,
    t: document.querySelector("#voice-dl-label").textContent,
    sameNode: document.querySelector("#voice-dl-bar") === bar0,
  };

  ui.paintVoiceProgress(88);
  const at88 = {
    w: document.querySelector("#voice-dl-bar").style.width,
    t: document.querySelector("#voice-dl-label").textContent,
  };

  // 边界：负数 / 超 100 / 垃圾输入
  ui.paintVoiceProgress(-5);
  const neg = document.querySelector("#voice-dl-bar").style.width;
  ui.paintVoiceProgress(150);
  const over = document.querySelector("#voice-dl-bar").style.width;
  ui.paintVoiceProgress("abc");
  const junk = document.querySelector("#voice-dl-bar").style.width;

  // 元素不存在时不能抛
  const host = document.querySelector("#dl-host");
  host.remove();
  let threw = false;
  try {
    ui.paintVoiceProgress(50);
  } catch {
    threw = true;
  }

  return { at37, at88, neg, over, junk, threw };
});

console.log("\n[1] 局部绘制");
check("37% → 宽度 37%", painted.at37.w === "37%", painted.at37.w);
check("37% → 文字同步", painted.at37.t.includes("37"), painted.at37.t);
check("88% → 宽度 88%", painted.at88.w === "88%", painted.at88.w);
check("是同一个 DOM 节点（没重建）", painted.at37.sameNode, "");
check("负数钳到 0%", painted.neg === "0%", painted.neg);
check("超过 100 钳到 100%", painted.over === "100%", painted.over);
check("垃圾输入按 0% 处理", painted.junk === "0%", painted.junk);
check("元素不存在时不抛异常", painted.threw === false, "");

/* ============================================================
   二、契约：事件路径确实会调到绘制
   ============================================================ */

const uiSrc = await readFile(join(ROOT, "scripts/ui.js"), "utf8");
const scrSrc = await readFile(join(ROOT, "scripts/screens.js"), "utf8");

console.log("\n[2] 契约");

// 这一条直接守住本次的 bug：ui.screen 不存在，写它等于永不重绘。
// 注释里会提到这个字段名（解释历史），所以先剥掉注释再判。
const uiNoComment = uiSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
check(
  "契约：不再引用不存在的 ui.screen",
  !/ui\.screen/.test(uiNoComment),
  (uiNoComment.match(/ui\.screen/g) || []).length + " 处"
);

check(
  "契约：refreshVoicePanel 用 ui.view 判断",
  /function refreshVoicePanel\(\)[\s\S]{0,400}ui\.view === "settings"/.test(uiSrc)
);

// 百分比跳动只能走局部绘制，不能走整页重绘
const downloadBlock = uiSrc.slice(
  uiSrc.indexOf('if (e.type === "download")'),
  uiSrc.indexOf('if (e.type === "download")') + 900
);
check("契约：进度跳动走 paintVoiceProgress", /paintVoiceProgress\(e\.pct\)/.test(downloadBlock));
check(
  "契约：进度跳动不调用 renderMain",
  !/renderMain\(/.test(downloadBlock.replace(/refreshVoicePanel\(\)/g, "")),
  "download 分支里出现了 renderMain"
);

check(
  "契约：解压/完成才整页重绘",
  /e\.state === "unzip" \|\| e\.pct >= 100[\s\S]{0,160}refreshVoicePanel\(\)/.test(uiSrc)
);

check("契约：进度条有稳定 id", /id="voice-dl-bar"/.test(scrSrc));
check("契约：进度文字有稳定 id", /id="voice-dl-label"/.test(scrSrc));

/* ============================================================
   三、下载中不打断别处输入
   ============================================================ */

console.log("\n[3] 不打断输入");

const typingSafe = await page.evaluate(async () => {
  const ui = await import("./scripts/ui.js");
  document.body.insertAdjacentHTML(
    "beforeend",
    `<input id="other-field" value="改到一半的内容">
     <div id="voice-dl-bar" style="width:0%"></div>
     <div id="voice-dl-label">0%</div>`
  );
  const field = document.querySelector("#other-field");
  field.focus();
  field.setSelectionRange(3, 3);
  const before = field.value;

  // 连续 20 次进度更新（模拟 20 个百分比）
  for (let i = 0; i <= 20; i += 1) ui.paintVoiceProgress(i * 5);

  const after = document.querySelector("#other-field");
  return {
    sameNode: after === field,
    value: after.value,
    focused: document.activeElement === after,
    width: document.querySelector("#voice-dl-bar").style.width,
  };
});

check("20 次进度更新后输入框还是同一节点", typingSafe.sameNode, "");
check("20 次更新不影响正在输入的内容", typingSafe.value === "改到一半的内容", typingSafe.value);
check("20 次更新不抢焦点", typingSafe.focused, "");
check("最终宽度正确", typingSafe.width === "100%", typingSafe.width);

await browser.close();
server.close();

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
