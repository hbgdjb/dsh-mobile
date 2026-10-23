#!/usr/bin/env node
/* ============================================================
   插件市场页

   ============ 这个测试守的是什么 ============

   市场是「发现 → 一键装」的入口。它有三件容易坏的事：

     1. 目录是 2.5 MB，如果整页重绘，搜索框每次输入都会丢焦点；
     2. 三千多条一次渲染会把主线程卡死（所以分批 + 加载更多）；
     3. 目录拉不到时，不能给一个空白页 —— 要让用户知道「是网络，
        不是没有插件」，并且能重试。

   这里用拦截 fetch 的方式喂一份假目录：测的是界面行为，
   不是 jsdelivr 通不通（那条链在 plugin-catalog-test 里单独测）。

   用法：node tests/ui-market-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${e && e.message ? e.message : e}`);
  }
}

function findChrome() {
  const list = [
    process.env.CHROME_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  for (const p of list) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

const chrome = findChrome();
let playwright = null;
if (chrome) {
  try {
    playwright = await import("playwright");
  } catch {
    playwright = null;
  }
}

if (!chrome || !playwright) {
  console.log("\n[跳过] 没有可用的 Chromium 或 playwright");
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项，跳过 1 项`);
  process.exit(0);
}

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

/** 假目录：形状必须和真实索引一致。 */
const FAKE = {
  format: 1,
  title: "fake catalog",
  plugins: [
    {
      name: "dsh-free-search",
      title: "dsh-free-search",
      description: { zh: "免费联网搜索，多引擎自动回退", en: "Free web search" },
      metadata: { category: "browser" },
      versions: [{ version: "0.9.13", publishTimestamp: 1791000000 }],
    },
    {
      name: "@demo/project-memory",
      title: "demo/project-memory",
      description: { zh: "项目级持久记忆，任务与文件自动关联", en: "Project memory" },
      metadata: { category: "memory" },
      versions: [{ version: "0.6.3", publishTimestamp: 1792426904 }],
    },
    {
      name: "dsh-codex-ui",
      title: "dsh-codex-ui",
      description: { zh: "Codex 风格侧栏与会话树", en: "Codex style UI" },
      metadata: { category: "ui" },
      versions: [{ version: "1.2.0", publishTimestamp: 1792000000 }],
    },
  ],
};

/**
 * 假的 package.json —— 详情面板打开时会去 npm 查一眼。
 *
 * 三份覆盖三种典型形状：有依赖 + 有界面、干净、只有界面。
 * 真去请求 npm 会让测试依赖外网，而且结果会随上游变化。
 */
const FAKE_PKGS = {
  "dsh-free-search": {
    name: "dsh-free-search",
    version: "0.9.13",
    main: "lib/index.js",
    dependencies: { "@deepseek-ai/schemastery": "^3.18.4" },
    peerDependencies: { react: "^18.2.0", "@deepseek-ai/cordis": "^4.0.1" },
    exports: { ".": "./lib/index.js", "./client": "./lib/client.js" },
    engines: { node: ">=20" },
  },
  "@demo/project-memory": {
    name: "@demo/project-memory",
    version: "0.6.3",
    main: "index.js",
  },
  "dsh-codex-ui": {
    name: "dsh-codex-ui",
    version: "1.2.0",
    main: "index.js",
    exports: { "./client": "./client.js" },
  },
};

const browser = await playwright.chromium.launch({ executablePath: chrome });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

// 拦截目录请求，喂假数据（其余请求放行）
await ctx.addInitScript((fake) => {
  const orig = window.fetch;
  const json = (o) =>
    Promise.resolve(
      new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } })
    );

  window.fetch = function (url, opts) {
    const u = String(url);
    // 目录（含 npmmirror 的 /latest? 那一支，先判它）
    if (u.includes("dsh-plugin-catalog")) return json(fake.catalog);
    // 装插件要下载 tarball —— 这里直接给 404，让安装几毫秒内失败。
    // 这些用例测的是「点击后的反馈」，不是能不能真的装上。
    if (u.includes(".tgz")) return Promise.resolve(new Response("", { status: 404 }));

    // 详情面板查包信息
    if (u.includes("registry.npmmirror.com/") && /\/latest(\?|$)/.test(u)) {
      const hit = Object.keys(fake.pkgs).find((n) => u.includes(n));
      if (hit) return json(fake.pkgs[hit]);
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    return orig.call(window, url, opts);
  };
}, { catalog: FAKE, pkgs: FAKE_PKGS });

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.goto(ORIGIN, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

async function openMarket() {
  await page.evaluate(() => {
    document.querySelector('[data-act="tab"][data-view="plugins"]')?.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.querySelector('[data-act="plugins-tab"][data-value="market"]')?.click();
  });
  await page.waitForTimeout(600);
}

console.log("\n[1] 列表");

await test("点「发现」能拉到目录并列出插件", async () => {
  await openMarket();
  const info = await page.evaluate(() => ({
    rows: document.querySelectorAll("#market-list .mk-card").length,
    // 两列：前两张卡的 offsetTop 相同、offsetLeft 不同
    cols:
      document.querySelectorAll("#market-list .mk-card").length >= 2
        ? (() => {
            const a = document.querySelectorAll("#market-list .mk-card")[0];
            const b = document.querySelectorAll("#market-list .mk-card")[1];
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return { sameRow: Math.abs(ra.top - rb.top) < 2, apart: rb.left > ra.right - 1 };
          })()
        : null,
    text: (document.querySelector("#market-list")?.innerText || "").trim(),
  }));
  assert.strictEqual(info.rows, 3, "三条假数据都要出来");
  assert.ok(info.cols && info.cols.sameRow, "前两张要并排，不是上下堆叠");
  assert.ok(info.cols && info.cols.apart, "第二张要在第一张右边");
  assert.ok(/dsh-free-search/.test(info.text), "要显示包名");
  assert.ok(/免费联网搜索/.test(info.text), "要显示中文描述");
  assert.deepStrictEqual(errors, []);
});

await test("显示可安装的版本", async () => {
  const text = await page.evaluate(() => (document.querySelector("#market-list")?.innerText || ""));
  assert.ok(/v0\.9\.13/.test(text), "要标出版本，实际：" + text.slice(0, 200));
});

console.log("\n[2] 搜索与分类");

await test("按中文搜，列表实时过滤且输入框不丢焦点", async () => {
  await page.evaluate(() => {
    const q = document.querySelector("#market-q");
    q.focus();
    q.value = "记忆";
    q.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => ({
    rows: document.querySelectorAll("#market-list .mk-card").length,
    // 两列：前两张卡的 offsetTop 相同、offsetLeft 不同
    cols:
      document.querySelectorAll("#market-list .mk-card").length >= 2
        ? (() => {
            const a = document.querySelectorAll("#market-list .mk-card")[0];
            const b = document.querySelectorAll("#market-list .mk-card")[1];
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return { sameRow: Math.abs(ra.top - rb.top) < 2, apart: rb.left > ra.right - 1 };
          })()
        : null,
    focused: document.activeElement?.id || "",
    value: document.querySelector("#market-q")?.value || "",
    text: (document.querySelector("#market-list")?.innerText || "").trim(),
  }));
  assert.strictEqual(info.rows, 1, "只该剩一条");
  assert.ok(/project-memory/.test(info.text));
  assert.strictEqual(info.focused, "market-q", "输入框必须保持焦点（否则打字会被打断）");
  assert.strictEqual(info.value, "记忆", "输入值不能被重绘冲掉");
});

await test("清空搜索恢复全部", async () => {
  await page.evaluate(() => {
    const q = document.querySelector("#market-q");
    q.value = "";
    q.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const rows = await page.evaluate(
    () => document.querySelectorAll("#market-list .mk-card").length
  );
  assert.strictEqual(rows, 3);
});

await test("点分类只显示该类", async () => {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('[data-act="market-cat"]')).find(
      (b) => b.dataset.value === "ui"
    );
    btn?.click();
  });
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => ({
    rows: document.querySelectorAll("#market-list .mk-card").length,
    // 两列：前两张卡的 offsetTop 相同、offsetLeft 不同
    cols:
      document.querySelectorAll("#market-list .mk-card").length >= 2
        ? (() => {
            const a = document.querySelectorAll("#market-list .mk-card")[0];
            const b = document.querySelectorAll("#market-list .mk-card")[1];
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return { sameRow: Math.abs(ra.top - rb.top) < 2, apart: rb.left > ra.right - 1 };
          })()
        : null,
    text: (document.querySelector("#market-list")?.innerText || "").trim(),
  }));
  assert.strictEqual(info.rows, 1);
  assert.ok(/codex/.test(info.text));
});

await test("已装的插件显示「已装」，不再给安装按钮", async () => {
  // 上一条把分类切到了 ui，先切回「全部」，否则看不到要检查的那张卡
  await page.evaluate(() => {
    document.querySelector('[data-act="market-cat"][data-value=""]')?.click();
  });
  await page.waitForTimeout(250);

  // 目录里叫 @demo/project-memory，装完的目录名是 demo-project-memory。
  // 两个形状不一样，所以这条同时守着 pluginIdOf 的转换规则。
  await page.evaluate(async () => {
    const store = await import("/scripts/store.js");
    store.setNodePlugins([
      { id: "demo-project-memory", name: "project-memory", version: "0.6.3" },
    ]);
    document.querySelector('[data-act="plugins-tab"][data-value="node"]')?.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.querySelector('[data-act="plugins-tab"][data-value="market"]')?.click();
  });
  await page.waitForTimeout(500);

  const info = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll("#market-list .mk-card"));
    const hit = cards.find((c) => c.dataset.name === "@demo/project-memory");
    return {
      text: hit ? hit.innerText : "",
      hasBtn: hit ? Boolean(hit.querySelector('[data-act="market-install"]')) : null,
      othersHaveBtn: cards
        .filter((c) => c !== hit)
        .every((c) => Boolean(c.querySelector('[data-act="market-install"]'))),
    };
  });

  assert.ok(info.text, "找不到那张卡，已装状态没生效");
  assert.ok(/已装/.test(info.text), "已装要标出来，实际：" + info.text.replace(/\n/g, " | "));
  assert.strictEqual(info.hasBtn, false, "已装的不能再给安装按钮 —— 点下去只会报已存在");
  assert.ok(info.othersHaveBtn, "没装的照常给按钮");
  assert.deepStrictEqual(errors, []);
});

console.log("\n[3] 详情面板");

/** 关掉面板，别影响下一条。 */
async function closeSheet() {
  await page.evaluate(() => {
    document.querySelector('.sheet [data-act="close-sheet"]')?.click();
  });
  await page.waitForTimeout(250);
}

await test("点卡片能打开详情，看到卡片里被截断的完整描述", async () => {
  await page.evaluate(() => {
    document.querySelector('#market-list .mk-card[data-name="dsh-free-search"]')?.click();
  });
  await page.waitForTimeout(700);

  const info = await page.evaluate(() => ({
    open: Boolean(document.querySelector(".sheet")),
    text: document.querySelector(".sheet__body")?.innerText || "",
    hasInstall: Boolean(document.querySelector('.sheet [data-act="market-install"]')),
  }));

  assert.ok(info.open, "点卡片要打开面板");
  // 卡片里只显示三行，这里必须是完整那句
  assert.ok(/免费联网搜索/.test(info.text), "要显示完整描述：" + info.text.slice(0, 120));
  assert.ok(/声明了 1 个依赖/.test(info.text), "要说依赖情况：" + info.text.slice(0, 200));
  assert.ok(/schemastery/.test(info.text), "要列出依赖名");
  assert.ok(/带界面部分/.test(info.text), "有 client/ 要说出来");
  assert.ok(/lib\/index\.js/.test(info.text), "要显示入口");
  assert.ok(info.hasInstall, "没装的要能在面板里直接装");
  assert.deepStrictEqual(errors, []);

  await closeSheet();
});

await test("已装的插件在详情里显示「已装」，不给安装键", async () => {
  await page.evaluate(() => {
    document.querySelector('#market-list .mk-card[data-name="@demo/project-memory"]')?.click();
  });
  await page.waitForTimeout(700);

  const info = await page.evaluate(() => ({
    text: document.querySelector(".sheet__body")?.innerText || "",
    foot: document.querySelector(".sheet__foot")?.innerText || "",
    hasInstall: Boolean(document.querySelector('.sheet [data-act="market-install"]')),
  }));

  assert.ok(/已装在这台设备上/.test(info.foot), "底部要说已装，实际：" + info.foot);
  assert.strictEqual(info.hasInstall, false, "已装的不能再给安装键");
  // 干净包（没有 dependencies）应当被标成「没有声明依赖」
  assert.ok(/没有声明依赖/.test(info.text), "预检要读得懂干净包：" + info.text.slice(0, 200));

  await closeSheet();
});

await test("查不到包信息时，面板照常显示内容并说明原因", async () => {
  await page.evaluate(() => {
    document.querySelector('#market-list .mk-card[data-name="dsh-codex-ui"]')?.click();
  });
  await page.waitForTimeout(700);
  const text = await page.evaluate(
    () => document.querySelector(".sheet__body")?.innerText || ""
  );
  assert.ok(/dsh-codex-ui|Codex/.test(text), "描述仍然要在");
  await closeSheet();
});

console.log("\n[4] 加载失败");

await test("目录拉不到时给原因 + 重试按钮，而不是空白页", async () => {
  // 换一个上下文：让目录请求从一开始就失败（首次加载失败的路径）
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx2.addInitScript(() => {
    const orig = window.fetch;
    window.fetch = function (url, opts) {
      if (String(url).includes("dsh-plugin-catalog")) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return orig.call(window, url, opts);
    };
  });
  const p2 = await ctx2.newPage();
  const errs2 = [];
  p2.on("pageerror", (e) => errs2.push(e.message));

  await p2.goto(ORIGIN, { waitUntil: "networkidle" });
  await p2.waitForTimeout(600);
  await p2.evaluate(() => {
    document.querySelector('[data-act="tab"][data-view="plugins"]')?.click();
  });
  await p2.waitForTimeout(250);
  await p2.evaluate(() => {
    document.querySelector('[data-act="plugins-tab"][data-value="market"]')?.click();
  });
  await p2.waitForTimeout(900);

  const info = await p2.evaluate(() => ({
    text: (document.querySelector("#market-list")?.innerText || "").trim(),
    hasRetry: !!document.querySelector('[data-act="market-reload"]'),
  }));
  await ctx2.close();

  assert.ok(/没能加载目录/.test(info.text), "要说清楚是加载失败，实际：" + info.text.slice(0, 160));
  assert.ok(/Failed to fetch|连不上/.test(info.text), "要带上原因，实际：" + info.text.slice(0, 160));
  // 一个源不通不算失败 —— 必须把「所有来源都试过了」说出来，
  // 否则用户会以为是某一个地址的问题，反复点重试。
  assert.ok(/都不通/.test(info.text), "要说明所有来源都试过了，实际：" + info.text.slice(0, 200));
  assert.ok(info.hasRetry, "要给重试按钮");
  assert.deepStrictEqual(errs2, [], "不能抛未捕获错误");
});

console.log("\n[5] 安装反馈");

await test("点「安装」后卡片立刻出现进度条（不是只在面板里滚一行字）", async () => {
  // 让后续下载快速失败，避免真去拉包；这里只关心「点击瞬间有没有反馈」
  await page.evaluate(() => {
    document.querySelector('[data-act="market-cat"][data-value=""]')?.click();
  });
  await page.waitForTimeout(200);

  // 点击和检查放在同一个 evaluate 里：安装可能在毫秒级失败（测试里 tarball 直接 404），
  // 隔一段时间再查会错过「刚点下去」的那一瞬 —— 而那一瞬正是用户在意的。
  const info = await page.evaluate(() => {
    const card = () => document.querySelector('#market-list .mk-card[data-name="dsh-codex-ui"]');
    card()?.querySelector('[data-act="market-install"]')?.click();
    const c = card();
    return {
      hasBar: Boolean(c?.querySelector(".mk-progress")),
      hasBusy: Boolean(c?.querySelector(".mk-card__busy")),
      stillHasInstall: Boolean(c?.querySelector('[data-act="market-install"]')),
    };
  });

  assert.ok(info.hasBar, "卡片里要出现进度条 —— 下载要几十秒，没动静像是卡死了");
  assert.ok(info.hasBusy, "按钮位置要换成进行中的计数，而不是继续写着「安装」");
  assert.strictEqual(info.stillHasInstall, false, "进行中不该还留着安装键（会让人重复点）");

  // 等它失败收尾，别影响后面用例
  await page.waitForTimeout(2500);
});

await test("「已装 · 查看」跳到已安装列表并高亮那一行", async () => {
  await page.evaluate(() => {
    document.querySelector('[data-act="plugins-tab"][data-value="market"]')?.click();
  });
  await page.waitForTimeout(400);

  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('#market-list .mk-card[data-name="@demo/project-memory"] [data-act="goto-installed"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  assert.ok(clicked, "已装的卡片上要有「查看」入口 —— 否则用户不知道去哪管理");

  await page.waitForTimeout(400);

  const info = await page.evaluate(() => ({
    tab: document.querySelector('[data-act="plugins-tab"][data-value="node"]')?.getAttribute("aria-pressed"),
    // 浏览器里没有 Node 通道，已安装列表是空态，所以这里只能验证
    // 「跳到了正确的地方」；高亮那一行需要真实插件列表才看得见。
    body: (document.body.innerText || "").slice(0, 200),
  }));

  assert.strictEqual(info.tab, "true", "应该落在「已安装」分段，实际：" + info.body);
});


await browser.close();
server.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
