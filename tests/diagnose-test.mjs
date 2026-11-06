/* ============================================================
   自检页测试  diagnose-test.mjs

   自检页的价值全在「准不准」上：它要是把好的报成坏的，用户会去修不存在的问题；
   把坏的报成好的，那这东西就白做了。所以这里的用例都是**真的把环境弄坏**，
   再看它报什么 —— 不是断言"我写了某个字符串"。

   五个用例：
     A 正常环境      → 结论必须是「全部通过」，六个分组都得到齐
     B 旧内核丢 dvh  → 结论必须是「布局塌了」，且数字和真实尺寸一致
     C 模型文件 404  → 结论必须是「读不到」
     D .mjs 类型错   → 结论必须是「类型标错」而不是「读不到」（两者下一步不同）
     E 纯浏览器      → 没有原生桥时判"跳过"，不能吓唬人

   四条额外检查放在 A 里：报告文本可读、重查可用、窄屏不溢出、页面无报错。
   ============================================================ */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
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
    console.log(`  ✗ ${name}${detail ? "\n      " + detail : ""}`);
  }
}

/**
 * @param {object} opts
 * @param {(css:string)=>string} [opts.cssPatch]  改写 base.css（模拟旧内核丢弃声明）
 * @param {(p:string)=>string|null} [opts.status] 返回 "404" / "octet-stream" 等强制行为
 * @param {boolean} [opts.native]                 是否模拟原生壳
 */
function makeServer(opts = {}) {
  return createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    if (p === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    const forced = opts.status ? opts.status(p) : null;
    if (forced === "404") {
      res.writeHead(404, { "cache-control": "no-store" });
      res.end("");
      return;
    }

    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    try {
      let body = await readFile(f);
      let ct = mime.mimeFor(f);

      if (opts.cssPatch && p === "/styles/base.css") {
        body = Buffer.from(opts.cssPatch(body.toString("utf8")), "utf8");
        ct = "text/css; charset=utf-8";
      }
      if (forced === "octet-stream") ct = "application/octet-stream";

      res.writeHead(200, { "content-type": ct, "cache-control": "no-store" });
      res.end(body);
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

async function open(server, opts = {}) {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const ctx = await browser.newContext({
    viewport: { width: opts.width || 360, height: 720 },
    deviceScaleFactor: 2,
    // 用一台真实机型的 UA：Android 版本 / WebView 版本都从 UA 里取，
    // 用 Playwright 默认的桌面 UA 会把这些检查全部跑偏
    userAgent:
      opts.ua ||
      "Mozilla/5.0 (Linux; Android 11; SM-G991B Build/RP1A.200720.012; wv) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 " +
        "Mobile Safari/537.36",
  });

  if (opts.native) {
    // 真机上 Capacitor 在页面脚本之前注入，这里照做
    await ctx.addInitScript(() => {
      window.Capacitor = { isNativePlatform: function () { return true; } };
      var names = ["DshNative", "DshFs", "DshImeHost", "DshNode", "DshMcp", "DshSpeech", "DshHud", "DshKeepAlive", "DshPower"];
      for (var i = 0; i < names.length; i++) window[names[i]] = {};
    });
  }

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto(`http://127.0.0.1:${port}/diagnose.html`, { waitUntil: "domcontentloaded" });

  // 等到 phase === "done" —— 不能用"报告长度 > 200"来判断，
  // 重查时旧报告还在，那个条件会立刻满足，测出来的是上一轮的结果。
  await waitDone(page, 40000);

  return {
    page,
    errors,
    report: () => page.evaluate(() => window.__dshSelfCheck.report()),
    groups: () => page.evaluate(() => window.__dshSelfCheck.groups().map((g) => g.id + ":" + g.items.length)),
    close: async () => {
      await page.close();
      server.close();
    },
  };
}

async function waitDone(page, timeout) {
  try {
    await page.waitForFunction(
      () => window.__dshSelfCheck && window.__dshSelfCheck.phase() === "done",
      null,
      { timeout: timeout || 40000 }
    );
  } catch {
    /* 让断言去报 */
  }
}

/* ---------------- A 正常环境 ---------------- */
console.log("\nA · 正常环境：必须全绿，且六个分组都在\n");
{
  const s = makeServer();
  const { page, errors, report, groups, close } = await open(s, { native: true });

  const rep = await report();
  const gs = await groups();

  check("六个分组齐全", gs.length === 7, gs.join(" "));
  check("每个分组都有条目", gs.every((g) => parseInt(g.split(":")[1], 10) > 0), gs.join(" "));
  check("结论是「全部通过」", /结论：全部通过/.test(rep), rep.split("\n").slice(0, 6).join(" / "));
  check("没有任何 FAIL", !/\bFAIL\b/.test(rep), rep.split("\n").filter((l) => /FAIL/.test(l)).join(" / "));

  check("读到 WebView 版本", /WebView 内核 → Chrome \d+/.test(rep));
  check("dvh 实测通过", /height: 100dvh → 支持/.test(rep));
  check("外壳高度 ≈ 视口", /外壳 \.device → 72\d px/.test(rep), rep.split("\n").find((l) => /device/.test(l)) || "");
  check("内容区有高度", /内容区 #views → \d{3} px/.test(rep));
  check("mjs 类型正确", /ort\.wasm\.min\.mjs → HTTP 200 · application\/javascript/.test(rep));

  check("报告是纯文本、可直接粘贴", rep.indexOf("DSH 自检报告") === 0 && rep.length > 500, String(rep.length));
  check("报告末尾带原始 UA", /【原始】/.test(rep) && /UA Mozilla/.test(rep));

  check("页面无报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  // 「重查」必须真的能再跑一遍，而不是灰按钮
  const before = await page.evaluate(() => window.__dshSelfCheck.groups().length);
  await page.click('button[data-act="rerun"]');
  await waitDone(page, 40000);
  const reran = await page.evaluate(() => window.__dshSelfCheck.phase() === "done");
  const after = await page.evaluate(() => window.__dshSelfCheck.groups().length);
  check("「重查」能重跑且分组不重复堆积", reran && after === before, `${before} → ${after}`);

  // 探针要有判别力：好的过、坏的不行。
  // 只验"全都通过"是不够的 —— 一个永远返回 true 的假实现也能让上面的断言全绿。
  const probe = await page.evaluate(async () => {
    const p = window.__dshSelfCheck.probeModule;
    const good = await p("await 1; export default 0;");
    const bad = await p("this is not { valid javascript");
    const bad2 = await p("export default 1; await 1; await 2;");
    return { good, bad, bad2 };
  });
  check("探针认可合法模块", probe.good === true, JSON.stringify(probe));
  check("探针拒绝语法错误的模块", probe.bad === false, JSON.stringify(probe));

  // 复制按钮存在（剪贴板要权限，这里只验入口）
  const hasCopy = await page.evaluate(() => !!document.querySelector('button[data-act="copy"]'));
  check("有「复制」按钮", hasCopy);

  // 复制被拦时，报告必须仍然"带得走" —— 摊在页面上让人手动选
  await page.evaluate(() => {
    try {
      navigator.clipboard.writeText = () => Promise.reject(new Error("blocked"));
    } catch {}
    document.execCommand = () => false;
  });
  await page.click('button[data-act="copy"]');
  await page.waitForTimeout(400);
  const raw = await page.evaluate(() => {
    const n = document.getElementById("sc-raw");
    return n ? { len: n.innerText.length, hasHead: /DSH 自检报告/.test(n.innerText) } : null;
  });
  check("复制失败时把报告摊在页面上", !!raw && raw.hasHead && raw.len > 500, JSON.stringify(raw));

  await close();
}

/* ---------------- A2 窄屏不溢出 ---------------- */
console.log("\nA2 · 320px 窄屏下不能横向溢出\n");
{
  const s = makeServer();
  const { page, close } = await open(s, { width: 320 });
  const m = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  check("没有横向滚动", m.scrollW <= m.clientW + 1, JSON.stringify(m));
  await close();
}

/* ---------------- B 旧内核丢 dvh ---------------- */
console.log("\nB · 模拟旧内核丢弃 dvh：必须报「布局塌了」\n");
{
  const s = makeServer({
    cssPatch: (css) => css.replace(/^\s*(min-height|height):\s*100(vh|dvh);\s*$/gm, ""),
  });
  const { page, report, close } = await open(s, { native: true });
  const rep = await report();

  check("结论是「布局塌了」", /结论：布局塌了/.test(rep), rep.split("\n").slice(3, 6).join(" / "));
  check("指出内容区高度为 0", /内容区 #views → 0 px/.test(rep), rep.split("\n").find((l) => /#views/.test(l)) || "");
  check("指出外壳没撑满", /外壳 \.device → \d{2,3} px/.test(rep));
  check("指出导航条位置异常", /导航条位置 → 顶 \d+ px \/ 底距 \d+ px/.test(rep));

  // 面板上红的那几条要能对上
  const reds = await page.evaluate(() =>
    window.__dshSelfCheck
      .groups()
      .flatMap((g) => g.items.filter((i) => i.status === "bad").map((i) => i.label))
  );
  check("红色项包含「内容区」与「外壳」", reds.some((l) => /内容区/.test(l)) && reds.some((l) => /外壳/.test(l)), reds.join("/"));

  await close();
}

/* ---------------- C 模型文件 404 ---------------- */
console.log("\nC · 模型文件缺失：报「读不到」\n");
{
  const s = makeServer({ status: (p) => (p.endsWith("ppocrv5.ort") ? "404" : null) });
  const { report, close } = await open(s, { native: true });
  const rep = await report();

  check("结论是「读不到」", /结论：有 1 个关键文件读不到/.test(rep), rep.split("\n").slice(3, 6).join(" / "));
  check("点名了是哪个文件", /ppocrv5\.ort → HTTP 404/.test(rep));
  check("提示重装（不是报 bug）", /重装/.test(rep));
  await close();
}

/* ---------------- D .mjs 类型错 ---------------- */
console.log("\nD · .mjs 类型标错：必须和「读不到」分开\n");
{
  // 这正是 0.57.0 线上那个 bug：文件在，但类型是 octet-stream
  const s = makeServer({ status: (p) => (p.endsWith(".mjs") ? "octet-stream" : null) });
  const { report, close } = await open(s, { native: true });
  const rep = await report();

  check("结论是「类型标错」", /结论：有 1 个文件类型标错了/.test(rep), rep.split("\n").slice(3, 6).join(" / "));
  check("没有误报成「读不到」", !/读不到/.test(rep.split("\n")[3]), rep.split("\n")[3]);
  check("说明这是安装包问题、重装无效", /重装无效/.test(rep));
  check("那一条是 FAIL", /FAIL\s+ort\.wasm\.min\.mjs/.test(rep));
  await close();
}

/* ---------------- E 纯浏览器 ---------------- */
console.log("\nE · 纯浏览器（无原生桥）：判跳过，不吓人\n");
{
  const s = makeServer();
  // 不注入 Capacitor，同时换成不带 wv 的桌面 UA —— 这才是"真的在浏览器里打开"。
  // 带 wv 的 UA 表示"某个应用的 WebView"，那时缺 Capacitor 才是异常，会判 warn。
  const { page, report, close } = await open(s, {
    ua:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/120.0.0.0 Safari/537.36",
  });
  const rep = await report();

  const nativeItems = await page.evaluate(() => {
    const g = window.__dshSelfCheck.groups().find((x) => x.id === "native");
    return g ? g.items.map((i) => i.status) : [];
  });
  check("原生能力那组全是 skip", nativeItems.length > 0 && nativeItems.every((s) => s === "skip"), nativeItems.join(","));
  check("宿主标成纯网页", /宿主 → 纯网页/.test(rep));
  check("没有因为缺原生能力而报 FAIL", !/\bFAIL\b/.test(rep), rep.split("\n").filter((l) => /FAIL/.test(l)).join(" / "));
  await close();
}

await browser.close();

console.log(`\n通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
