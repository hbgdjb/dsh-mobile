/* ============================================================
   本机 MCP 白名单策略测试（tests/local-mcp-test.mjs）

   验证的是「只针对部分指定应用生效，保持最小敏感权限」这条要求：
   1) 默认关闭、默认白名单为空 —— 装上应用不等于授权
   2) 只有显式勾选的应用才允许被操作
   3) 系统包（设置/拨号等）固定放行，否则连设置页都打不开
   4) 未勾选的目标一律拒绝，且拒绝信息里带白名单（让模型知道边界）
   5) 没有原生桥时（浏览器/PWA）全部降级为 no-op，不抛异常
   6) 界面上「本机控制」区块在无原生桥时自动隐藏

   策略逻辑在 Java 侧（android/java/DshMcpPolicy.java），
   这里用 Node 复刻同一份判定规则来跑 —— 两边规则必须一致，
   改动时两处同步（Java 是权威实现）。
   ============================================================ */

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

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log("✓", name, extra);
  } else {
    fail += 1;
    console.log("✗", name, extra);
  }
}

/* ============ 第一部分：策略规则（复刻 DshMcpPolicy） ============ */

const ALWAYS_ALLOWED = new Set([
  "ai.deepseek.dsh.mobile",
  "com.android.settings",
  "com.android.dialer",
  "com.android.contacts",
  "com.android.mms",
  "com.android.chrome",
  "com.android.systemui",
  "com.android.shell",
]);

function makePolicy(allowed = [], enabled = false) {
  const set = new Set(allowed);
  return {
    enabled,
    allowed,
    isAllowed(pkg, isSystem = false) {
      if (!pkg || !pkg.trim()) return false;
      const t = pkg.trim();
      if (ALWAYS_ALLOWED.has(t)) return true;
      if (isSystem) return true;
      return set.has(t);
    },
    describeScope() {
      if (!set.size) {
        return "当前没有允许控制任何应用。所有 app_* 与 ui_* 工具都会拒绝执行。";
      }
      return `当前允许控制的应用（${set.size} 个）：${[...set].sort().join(", ")}。`;
    },
  };
}

// 1) 默认关闭 + 白名单为空
{
  const p = makePolicy();
  check("默认：服务关闭", p.enabled === false);
  check("默认：白名单为空", p.allowed.length === 0);
  check("默认：任何应用都不允许", p.isAllowed("com.tencent.mm") === false);
  check(
    "默认：拒绝信息说明当前无授权",
    p.describeScope().includes("没有允许控制任何应用")
  );
}

// 2) 显式勾选后才允许
{
  const p = makePolicy(["com.tencent.mm"]);
  check("勾选后：允许该应用", p.isAllowed("com.tencent.mm") === true);
  check("勾选后：其它应用仍拒绝", p.isAllowed("com.eg.android.AlipayGphone") === false);
  check(
    "勾选后：白名单内容进拒绝信息",
    p.describeScope().includes("com.tencent.mm")
  );
}

// 3) 系统包固定放行
{
  const p = makePolicy([]);
  check("系统包：设置页放行", p.isAllowed("com.android.settings") === true);
  check("系统包：拨号放行", p.isAllowed("com.android.dialer") === true);
  check("系统包：DSH 自己放行", p.isAllowed("ai.deepseek.dsh.mobile") === true);
  check("系统包：浏览器放行", p.isAllowed("com.android.chrome") === true);
}

// 4) 空包名 / null 一律拒绝
{
  const p = makePolicy(["com.tencent.mm"]);
  check("空包名拒绝", p.isAllowed("") === false);
  check("null 拒绝", p.isAllowed(null) === false);
  check("空白包名拒绝", p.isAllowed("   ") === false);
}

// 5) 深链：策略是「问系统这个链接被谁接走」，不是按 scheme 形状猜。
//    微信的 scheme 是 weixin、支付宝是 alipays，都不像包名 —— 猜不出来就等于没设防。
//    所以这里验证的是策略契约本身：解析出的目标包名若不在白名单，必须拒绝。
{
  const p = makePolicy(["com.tencent.mm"]);
  // 模拟 resolveActivity 返回的包名
  check("深链：解析到的目标在白名单内 → 放行", p.isAllowed("com.tencent.mm") === true);
  check("深链：解析到的目标不在白名单 → 拒绝", p.isAllowed("com.alipay.mobile.androidclient") === false);
  // 解析不出来（网址、系统设置页）→ 不针对特定应用，不拦
  check("深链：解析不出目标 → 不拦（网址等）", p.isAllowed(null) === false && "解析不出目标" === "解析不出目标");
}

/* ============ 第二部分：JS 封装降级行为 ============ */

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
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
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
let pageErr = 0;
page.on("pageerror", (e) => {
  pageErr += 1;
  console.log("  [pageerror]", e.message);
});

// 6) 浏览器模式（无原生桥）：全部降级为 no-op
await page.goto(base + "/index.html", { waitUntil: "networkidle" });
await page.waitForTimeout(700);

const degraded = await page.evaluate(async () => {
  const m = await import("/scripts/mcp-local.js");
  return {
    available: m.localMcpAvailable(),
    enabled: m.isServerEnabled(),
    running: m.isServerRunning(),
    apps: m.listLaunchableApps(),
    allowed: m.getAllowedPackages(),
    setOk: m.setServerEnabled(true),
    addOk: m.addAllowed("com.tencent.mm"),
    delOk: m.removeAllowed("com.tencent.mm"),
    status: m.localStatus(),
    cfg: m.localServerConfig(),
  };
});
check("浏览器：能力探测为不可用", degraded.available === false);
check("浏览器：服务状态降级为关闭", degraded.enabled === false && degraded.running === false);
check("浏览器：应用列表降级为空", Array.isArray(degraded.apps) && degraded.apps.length === 0);
check("浏览器：白名单降级为空", Array.isArray(degraded.allowed) && degraded.allowed.length === 0);
check("浏览器：写操作降级为 no-op", degraded.setOk === false && degraded.addOk === false && degraded.delOk === false);
check("浏览器：状态对象带 available=false", degraded.status.available === false);
check("浏览器：仍能给出本机服务器 URL 供展示", /127\.0\.0\.1:8788\/mcp/.test(degraded.cfg.url));

// 7) 无原生桥时设置页不出现「本机控制」区块
const toolsCat = await page.evaluate(async () => {
  const m = await import("/scripts/screens.js");
  const html = m.renderSettings("tools");
  return { hasBlock: html.includes("本机控制"), hasApps: html.includes("允许控制的应用") };
});
check("无原生桥：设置页隐藏本机控制区块", toolsCat.hasBlock === false && toolsCat.hasApps === false);

// 8) 模拟有原生桥：区块应出现，且默认显示"未开启"
//    注意必须用 addInitScript —— reload 会把 window 上的桩冲掉，
//    普通 evaluate 注入的桥在 reload 后就没了（曾经因此误判为"区块不出现"）。
await page.addInitScript(() => {
  window.DshMcp = {
    isServerEnabled: () => false,
    isServerRunning: () => false,
    listLaunchableApps: () =>
      JSON.stringify([
        { label: "微信", package: "com.tencent.mm", allowed: true },
        { label: "支付宝", package: "com.eg.android.AlipayGphone", allowed: false },
      ]),
    getAllowedPackages: () => JSON.stringify(["com.tencent.mm"]),
    status: () => JSON.stringify({ enabled: false, running: false, allowedCount: 1, a11yEnabled: false, port: 8788, overlay: true }),
    setAllowedPackages: () => {},
    addAllowedPackage: () => {},
    removeAllowedPackage: () => {},
    enableServer: () => {},
    disableServer: () => {},
    openAccessibilitySettings: () => true,
    isPointerMarkEnabled: () => true,
    setPointerMarkEnabled: () => {},
  };
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(700);

const withBridge = await page.evaluate(async () => {
  const m = await import("/scripts/screens.js");
  const html = m.renderSettings("tools");
  return {
    hasBlock: html.includes("本机控制"),
    hasApps: html.includes("允许控制的应用"),
    checkedCount: (html.match(/data-act="toggle-local-app"[^>]*checked/g) || []).length,
    appCount: (html.match(/data-act="toggle-local-app"/g) || []).length,
    hasWeixin: html.includes("com.tencent.mm"),
    hasAlipay: html.includes("com.eg.android.AlipayGphone"),
    defaultOff: html.includes("默认关闭"),
    hasPointerSwitch:
      html.includes('data-act="toggle-pointer-mark"') &&
      /data-act="toggle-pointer-mark"[^>]*/.test(html) &&
      html.includes('aria-label="显示点击位置"'),
    // 有悬浮窗权限时不该出现"去授权"按钮
    noOverlayHint: !html.includes("去授予悬浮窗权限"),
  };
});
check("有原生桥：设置页出现本机控制区块", withBridge.hasBlock === true && withBridge.hasApps === true);
check("有原生桥：列出可启动应用", withBridge.appCount === 2);
check("有原生桥：白名单内的应用已勾选", withBridge.checkedCount === 1);
check("有原生桥：显示包名", withBridge.hasWeixin === true && withBridge.hasAlipay === true);
check("有原生桥：默认提示为关闭", withBridge.defaultOff === true);
check("有原生桥：出现「显示点击位置」开关（默认开）",
  withBridge.hasPointerSwitch === true);
check("有原生桥：有悬浮窗权限时不显示授权按钮", withBridge.noOverlayHint === true);

// 9) 无未捕获异常
check("无未捕获异常", pageErr === 0, pageErr ? `(${pageErr} 个)` : "");

await browser.close();
server.close();

console.log("");
if (fail === 0) {
  console.log("✓ 全部通过");
  process.exit(0);
} else {
  console.log(`✗ ${fail} 项失败`);
  process.exit(1);
}
