/* ============================================================
   启动看门狗测试  boot-watchdog-test.mjs

   要锁住的是一个很具体的故障：
   Android 11 那批机器的出厂 WebView 停在 Chrome 83/84，只要有一个模块
   用了更高的语法（比如 ES2021 的 `||=`），整个 app.js 连同 import 图都不执行，
   启动动画 6 秒后照常退场 —— 用户看到一块纯黑，且永远等不到界面。

   三条用例：
     A 正常启动：面板不能出现（否则就是误挡）
     B 模块解析失败：面板必须出现，且写清 WebView 版本、给出重载入口
     C 慢设备晚到：面板先出来，界面真起来后必须自己撤掉

   注意 B/C 都不依赖真机 —— 用真浏览器 + 真 assets，故障是注入出来的。
   ============================================================ */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { loadAndroidMime } from "./android-serve.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const mime = await loadAndroidMime();

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? "  → " + detail : ""}`);
  }
}

/**
 * 每个用例独立的服务器，好按需改写 app.js / base.css。
 * cssPatch 用来模拟「旧内核丢弃某条样式声明」—— 那是布局塌陷的成因。
 */
function makeServer(transform, cssPatch) {
  return createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    if (p === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (cssPatch && p === "/styles/base.css") {
      const css = await readFile(join(ROOT, "styles/base.css"), "utf8");
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      res.end(cssPatch(css));
      return;
    }
    if (transform && p === "/scripts/app.js") {
      const r = await transform(null);
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(r);
      return;
    }
    try {
      const b = await readFile(f);
      res.writeHead(200, { "content-type": mime.mimeFor(f), "cache-control": "no-store" });
      res.end(b);
    } catch {
      res.writeHead(404, { "cache-control": "no-store" });
      res.end("");
    }
  });
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function open(server) {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  // 用一个 2020 年的 Android 11 机型 UA：Chrome 83 正好是 `||=` 支持线的下面
  const page = await browser.newPage({
    viewport: { width: 360, height: 720 },
    userAgent:
      "Mozilla/5.0 (Linux; Android 11; SM-G991B Build/RP1A.200720.012; wv) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/83.0.4103.106 " +
      "Mobile Safari/537.36",
  });
  // 字体走外网，在测试里没有意义，还会把 networkidle 拖到超时
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, body: "" }));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  return { page, errors, close: async () => { await page.close(); server.close(); } };
}

const TITLE = "界面没能启动";
const LAYOUT_TITLE = "界面没铺满屏幕";

/* ---------------- A 正常启动 ---------------- */
console.log("\nA · 正常启动不应出现诊断面板\n");
{
  const s = makeServer(null);
  const { page, errors, close } = await open(s);
  let ok = false;
  try {
    await page.waitForFunction(
      () => {
        const t = document.getElementById("tabbar");
        return t && t.children.length > 0;
      },
      null,
      { timeout: 20000 }
    );
    ok = true;
  } catch {
    ok = false;
  }
  check("界面在 20 秒内渲染出底部导航", ok, errors.slice(0, 2).join(" | "));

  // 看门狗最早 9 秒才可能报，这里必须跨过那个点确认它没报
  await page.waitForTimeout(10500);
  const hasPanel = await page.evaluate((t) => document.body.innerText.indexOf(t) >= 0, TITLE);
  check("等过 9 秒阈值后仍没有诊断面板", !hasPanel);
  const tabCount = await page.evaluate(() => {
    const t = document.getElementById("tabbar");
    return t ? t.children.length : -1;
  });
  check("底部导航仍然完整", tabCount >= 3, `子节点 ${tabCount}`);
  await close();
}

/* ---------------- B 模块解析失败 ---------------- */
console.log("\nB · app.js 解析失败必须给出原因\n");
{
  // 老内核遇到 `||=` 时的实际表现：整个模块解析失败，一行都不执行。
  // 这里直接注入一个语法错误来复现同一条路径。
  const s = makeServer(async () => "const broken = ;\n");
  const { page, close } = await open(s);
  let appeared = false;
  try {
    await page.waitForFunction(
      (t) => document.body.innerText.indexOf(t) >= 0,
      TITLE,
      { timeout: 16000 }
    );
    appeared = true;
  } catch {
    appeared = false;
  }
  check("诊断面板出现了", appeared);

  if (appeared) {
    const info = await page.evaluate(() => ({
      text: document.body.innerText,
      pre: (document.querySelector("pre") || {}).textContent || "",
      buttons: [...document.querySelectorAll("button")].map((b) => b.textContent),
      stored: localStorage.getItem("dsh.boot.fail.v1"),
      tab: (document.getElementById("tabbar") || { children: [] }).children.length,
    }));
    check("写明了 WebView 版本", /WebView Chrome \d+|WebView Chrome 未知/.test(info.pre), info.pre.slice(0, 80));
    check("写明了 Android 版本", /Android \d/.test(info.pre), info.pre.slice(0, 80));
    check("认出这是旧 WebView（Chrome 83）", /Chrome 83/.test(info.pre), info.pre.slice(0, 80));
    check("提示了去更新 WebView", /Android System WebView/.test(info.text));
    check("带上了导致失败的具体错误", /Unexpected token|SyntaxError/.test(info.pre), info.pre);
    check("给出「重新加载」", info.buttons.some((b) => b.indexOf("重新加载") >= 0), info.buttons.join("/"));
    check("给出「复制诊断信息」", info.buttons.some((b) => b.indexOf("复制诊断") >= 0), info.buttons.join("/"));
    check("诊断写进了 localStorage", !!info.stored && info.stored.length > 20);

    // 面板必须盖住启动动画（splash 的 z-index 是 9999）
    const z = await page.evaluate(() => {
      const all = [...document.querySelectorAll("body > div")];
      const panel = all.find((d) => d.innerText && d.innerText.indexOf("界面没能启动") >= 0);
      return panel ? getComputedStyle(panel).zIndex : "0";
    });
    check("层级高于启动动画(9999)", parseInt(z, 10) > 9999, `z-index=${z}`);

    // 顶部按钮要在视口内，别被状态栏盖住
    const btn = await page.locator("button:has-text('重新加载')").boundingBox();
    check("按钮完整可见", !!btn && btn.y > 0 && btn.x >= 0 && btn.x + btn.width <= 360, JSON.stringify(btn));
  }
  await close();
}

/* ---------------- C 慢设备：面板要能自愈 ---------------- */
console.log("\nC · 界面晚到时要自己撤掉面板\n");
{
  // 延迟 10.5 秒：9 秒阈值会先触发面板，随后真实界面到齐，面板应自行消失。
  const s = makeServer(async () => {
    const src = await readFile(join(ROOT, "scripts/app.js"), "utf8");
    await new Promise((r) => setTimeout(r, 10500));
    return src;
  });
  const { page, close } = await open(s);
  let sawPanel = false;
  try {
    await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, TITLE, { timeout: 14000 });
    sawPanel = true;
  } catch {
    sawPanel = false;
  }
  check("慢启动时面板先出现", sawPanel);

  let healed = false;
  try {
    await page.waitForFunction(
      (t) => {
        const tab = document.getElementById("tabbar");
        const up = tab && tab.children.length > 0;
        return up && document.body.innerText.indexOf(t) < 0;
      },
      TITLE,
      { timeout: 20000 }
    );
    healed = true;
  } catch {
    healed = false;
  }
  check("界面到齐后面板自动撤掉", healed);
  await close();
}

/* ---------------- D 界面起来了但塌了 ---------------- */
console.log("\nD · 布局塌陷也要报出来（不能只认「没启动」）\n");
{
  // 把 100vh / 100dvh 那几行删掉 —— 旧内核不认识 dvh 时就是这样：
  // 声明整条被丢弃，外壳没有高度，内容区塌成 0。
  const s = makeServer(null, (css) =>
    css.replace(/^\s*(min-height|height):\s*100(vh|dvh);\s*$/gm, "")
  );
  const { page, errors, close } = await open(s);

  let saw = false;
  try {
    await page.waitForFunction(
      (t) => document.body.innerText.indexOf(t) >= 0,
      LAYOUT_TITLE,
      { timeout: 16000 }
    );
    saw = true;
  } catch {
    saw = false;
  }
  check("界面塌陷时弹出面板", saw);
  check("没有 JS 报错（塌陷是纯样式问题）", errors.length === 0, errors.join(" | "));

  const info = await page.evaluate(() => {
    const t = document.body.innerText;
    const views = document.getElementById("views");
    const dev = document.querySelector(".device");
    return {
      text: t,
      viewsH: views ? Math.round(views.getBoundingClientRect().height) : -1,
      devH: dev ? Math.round(dev.getBoundingClientRect().height) : -1,
      winH: window.innerHeight,
      buttons: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()),
    };
  });

  check("写明了内容区实测高度", /#views\s+0\s*px/.test(info.text), info.text.split("\n").slice(0, 8).join(" / "));
  check("写明外壳高度和视口", new RegExp("\\.device\\s+" + info.devH + "\\s*px").test(info.text), info.text.slice(0, 200));
  check("确认布局真的塌了（内容区 < 120px）", info.viewsH < 120, `views=${info.viewsH}`);
  check("给出「运行自检」", info.buttons.some((b) => b.indexOf("运行自检") >= 0), info.buttons.join("/"));
  check("仍然给出「重新加载」", info.buttons.some((b) => b.indexOf("重新加载") >= 0), info.buttons.join("/"));

  // 面板不能自己消失 —— 塌陷状态下界面「在」，但确实是坏的
  await page.waitForTimeout(3000);
  const still = await page.evaluate((t) => document.body.innerText.indexOf(t) >= 0, LAYOUT_TITLE);
  check("塌陷面板不会自动撤掉", still);

  await close();
}

/* ---------------- E 自检入口可达 ---------------- */
console.log("\nE · 面板上的「运行自检」要真能打开诊断页\n");
{
  const s = makeServer(null, (css) =>
    css.replace(/^\s*(min-height|height):\s*100(vh|dvh);\s*$/gm, "")
  );
  const { page, close } = await open(s);
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, LAYOUT_TITLE, { timeout: 16000 });

  const btn = page.locator("button", { hasText: "运行自检" });
  await btn.click();
  let url = "";
  try {
    await page.waitForURL(/diagnose\.html/, { timeout: 12000 });
    url = page.url();
  } catch {
    url = page.url();
  }
  check("点「运行自检」跳到了 diagnose.html", /diagnose\.html/.test(url), url);

  // 到了诊断页，它自己要能跑起来（哪怕主界面是坏的）
  let ran = false;
  try {
    await page.waitForFunction(
      () => window.__dshSelfCheck && window.__dshSelfCheck.report().length > 100,
      null,
      { timeout: 25000 }
    );
    ran = true;
  } catch {
    ran = false;
  }
  check("诊断页在坏布局下也能跑完", ran);
  await close();
}

await browser.close();

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
