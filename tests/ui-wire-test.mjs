/**
 * 界面宿主的接线测试（UI 层）
 *
 * ============ 这套测试在补哪条缝 ============
 *
 * 另外三套分别测了：
 *   ui-service       Node 侧服务逻辑
 *   ui-channel       真进程 + 真通道的协议
 *   ui-host          真页面里的渲染与安全
 *
 * 但把两边接起来的那段代码 —— `scripts/ui.js` 里的 wireUiHost() ——
 * 一直是靠人眼看的。它出错的形态很典型：
 *
 *   推送来了没画（漏了 uiAttach）
 *   按钮点了没回传（漏了 setActionSink）
 *   页面重建后界面消失（漏了 attach 时机）
 *
 * 这些都不会报错，只是「点了没反应」。
 *
 * 所以这里用一个假的原生桥把通道两头接起来，
 * 走真实的事件路径：__dshNodeEvent → ui-host → DOM → 点击 → DshNode.call
 *
 * 用法：node tests/ui-wire-test.mjs
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

/**
 * 假的原生桥。
 *
 * 只实现页面真正用到的部分：
 *   status()   轮询用
 *   call()     页面 → Node 的请求
 * 回包走 window.__dshNodeResponse，推送走 window.__dshNodeEvent ——
 * 与真机上的路径完全一样，不是绕过一层直接调函数。
 */
await page.addInitScript(() => {
  window.__calls = [];
  window.__connected = false;
  let seq = 0;

  window.DshNode = {
    status() {
      return JSON.stringify({
        available: true,
        installed: true,
        running: true,
        channelConnected: window.__connected,
        channelPort: 12345,
      });
    },
    start() {},
    stop() {},
    call(method, json) {
      const id = `m${++seq}`;
      let params = {};
      try {
        params = JSON.parse(json || "{}");
      } catch {}
      window.__calls.push({ method, params });

      // 真机上是异步回来的；这里也异步，否则会掩盖时序问题
      setTimeout(() => {
        if (method === "ui.action") {
          window.__dshNodeResponse(id, true, JSON.stringify({ ok: true }));
          return;
        }
        if (method === "ui.snapshot") {
          window.__dshNodeResponse(
            id,
            true,
            JSON.stringify({
              mounts: [
                {
                  id: "snap-mounted",
                  slot: "composer.toolbar",
                  pluginId: "demo",
                  order: 0,
                  tree: { type: "text", text: "从快照恢复的界面" },
                },
              ],
            })
          );
          return;
        }
        if (method === "plugins.list") {
          window.__dshNodeResponse(id, true, JSON.stringify({ plugins: [], diagnostics: {} }));
          return;
        }
        if (method === "llm.routes") {
          window.__dshNodeResponse(id, true, JSON.stringify({ routes: [] }));
          return;
        }
        window.__dshNodeResponse(id, true, JSON.stringify({}));
      }, 5);
      return id;
    },
  };
});

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(4200); // 等启动动画退场

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

/* ---------------- 一、推送 → 渲染 ---------------- */

console.log("\n接线\n");

await page.evaluate(() => {
  window.__dshNodeEvent(
    "ui.mount",
    JSON.stringify({
      id: "wire-1",
      slot: "composer.toolbar",
      pluginId: "demo",
      pluginName: "接线测试",
      order: 0,
      tree: {
        type: "row",
        gap: "sm",
        children: [
          { type: "badge", text: "推送来的" },
          { type: "button", label: "点我", action: "ping" },
        ],
      },
    })
  );
});
await page.waitForTimeout(150);

const rendered = await page.evaluate(() => {
  const el = document.querySelector('[data-ui-slot="composer.toolbar"]');
  return {
    hidden: el?.hidden,
    text: el?.innerText.replace(/\s+/g, " ").trim() || "",
    hasBtn: !!el?.querySelector('[data-ui-action="ping"]'),
  };
});
check(
  "通道推来的 ui.mount 真的画到了页面上",
  rendered.hidden === false && rendered.hasBtn && rendered.text.includes("推送来的"),
  JSON.stringify(rendered)
);

/* ---------------- 二、点击 → 回传 ---------------- */

await page.click('[data-ui-slot="composer.toolbar"] [data-ui-action="ping"]');
await page.waitForTimeout(200);

const afterClick = await page.evaluate(() => {
  const c = window.__calls.filter((x) => x.method === "ui.action");
  return { count: c.length, last: c[c.length - 1] || null };
});
check(
  "点按钮把 ui.action 发给了 Node",
  afterClick.count === 1 && afterClick.last.params.id === "wire-1" && afterClick.last.params.action === "ping",
  JSON.stringify(afterClick.last)
);

/* ---------------- 三、推送 update / unmount ---------------- */

await page.evaluate(() => {
  window.__dshNodeEvent("ui.update", JSON.stringify({ id: "wire-1", tree: { type: "text", text: "已经改成这样" } }));
});
await page.waitForTimeout(120);
const updated = await page.evaluate(
  () => document.querySelector('[data-ui-slot="composer.toolbar"]').innerText.trim()
);
check("ui.update 换了内容", updated === "已经改成这样", updated);

await page.evaluate(() => {
  window.__dshNodeEvent("ui.unmount", JSON.stringify({ id: "wire-1" }));
});
await page.waitForTimeout(120);
const gone = await page.evaluate(() => {
  const el = document.querySelector('[data-ui-slot="composer.toolbar"]');
  return { hidden: el.hidden, children: el.children.length };
});
check("ui.unmount 把这块收起来", gone.hidden === true && gone.children === 0, JSON.stringify(gone));

/* ---------------- 四、通道连上时拉快照 ---------------- */

const beforeSnap = await page.evaluate(() => window.__calls.filter((x) => x.method === "ui.snapshot").length);
await page.evaluate(() => {
  window.__connected = true; // 轮询会看到「从没连上 → 连上了」
});
await page.waitForTimeout(1800);

const snap = await page.evaluate(() => ({
  calls: window.__calls.filter((x) => x.method === "ui.snapshot").length,
  text: document.querySelector('[data-ui-slot="composer.toolbar"]')?.innerText.trim() || "",
}));
check("通道一连上就拉了 ui.snapshot", snap.calls > beforeSnap, `before=${beforeSnap} after=${snap.calls}`);
check("快照里的界面被贴回来了", snap.text.includes("从快照恢复的界面"), snap.text);

/* ---------------- 五、页面重建后快照界面还在 ---------------- */

await page.click('.tab[data-view="workspace"]');
await page.waitForTimeout(300);
await page.click('.tab[data-view="chat"]');
await page.waitForTimeout(400);
const afterNav = await page.evaluate(
  () => document.querySelector('[data-ui-slot="composer.toolbar"]')?.innerText.trim() || ""
);
check("切页回来界面仍然在", afterNav.includes("从快照恢复的界面"), afterNav);

/* ---------------- 六、自动重载开关 ---------------- */

// 设置里打开「自动重载」后，通道一连上就该去开监听
await page.evaluate(async () => {
  const st = await import("/scripts/store.js");
  st.setSettings({ pluginWatch: true });
});
await page.evaluate(() => {
  window.__connected = false;
});
await page.waitForTimeout(1200); // 让轮询看到"断开"
await page.evaluate(() => {
  window.__connected = true;
});
await page.waitForTimeout(1800);

const watchCall = await page.evaluate(() => {
  const c = window.__calls.filter((x) => x.method === "plugins.watch");
  return c.length ? c[c.length - 1].params : null;
});
check(
  "打开设置后，通道连上会自动开启目录监听",
  watchCall && watchCall.on === true,
  JSON.stringify(watchCall)
);

/* ---------------- 七、无报错 ---------------- */

check("全程没有 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
server.close();
console.log(failed ? `\n${failed} 项失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
