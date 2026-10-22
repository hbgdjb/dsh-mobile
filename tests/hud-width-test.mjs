/* ============================================================
   悬浮窗尺寸与透明度（0.35.2）

   用户反馈：展开后的详细浮窗"瘦高"，一行内容被截得只剩半句；
   而且底色太实，挡在别的应用上面很碍事。

   改动：展开态宽度上限 238 → 300（dp/px），底色 alpha 0.80 → 0.68。

   这里要守住三件事：
     ① 加宽真的生效，且**没有把高度带上去**（每行都是单行，行数只由数据条数决定）
     ② 小屏不溢出（悬浮窗是 FLAG_LAYOUT_NO_LIMITS，出屏不会裁，只会少一截看不见）
     ③ 原生侧与应用内降级版**两套实现的数值一致** —— 不一致的话，
        APK 和浏览器里看到的是两个东西，改一边等于没改完
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

/* ============================================================
   一、应用内降级版：真实渲染测量
   ============================================================ */

async function renderHud(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  return page.evaluate(async () => {
    const hud = await import("./scripts/hud.js");
    hud.hudRender(
      {
        status: "thinking",
        statusText: "正在分析你的问题",
        step: "读取 scripts/memory.js 并统计条目数",
        sessions: [
          { title: "关于语音输入的讨论", state: "运行中" },
          { title: "打包 0.35.2", state: "等待" },
        ],
        tasks: [{ title: "下载离线语音模型", progress: 45 }],
        messages: [
          { role: "user", text: "帮我看看这个报错是什么意思" },
          { role: "assistant", text: "这是 SDK 版本不匹配导致的" },
        ],
        running: true,
        look: "thinking",
      },
      true
    );

    const el = document.querySelector("#dsh-hud-inapp");
    if (!el) return { error: "没有渲染出浮条" };

    // 展开：pointerdown + pointerup 且没有位移
    const r = el.getBoundingClientRect();
    const opt = { bubbles: true, clientX: r.left + 8, clientY: r.top + 8 };
    el.dispatchEvent(new PointerEvent("pointerdown", opt));
    el.dispatchEvent(new PointerEvent("pointerup", opt));
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll(".hud-body .hud-row, .hud-body .hud-msg")];

    // 把宽度强行改成 250 / 300，看高度变不变
    el.style.width = "250px";
    const h250 = el.getBoundingClientRect().height;
    el.style.width = "300px";
    const h300 = el.getBoundingClientRect().height;
    el.style.width = "";

    return {
      open: el.dataset.open,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      maxWidth: cs.maxWidth,
      bg: cs.backgroundColor,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      rowCount: rows.length,
      rowWhiteSpace: rows.length ? getComputedStyle(rows[0]).whiteSpace : "",
      h250: Math.round(h250),
      h300: Math.round(h300),
    };
  }).finally(() => page.close());
}

console.log("[1] 应用内浮条（412px 视口）");
const big = await renderHud(412, 915);

check("浮条已展开", big.open === "true", String(big.open));
check("展开态宽度到 300", big.width >= 290 && big.width <= 310, `${big.width}px`);
check(
  "比原来的 250 宽",
  big.width > 250,
  `${big.width}px > 250px`
);
check(
  "底色 alpha 降到 0.68",
  /rgba\(\s*20\s*,\s*24\s*,\s*33\s*,\s*0\.68\s*\)/.test(big.bg),
  big.bg
);
check(
  "每行都是单行（宽度变化不会换行）",
  big.rowWhiteSpace === "nowrap",
  big.rowWhiteSpace
);
check(
  "高度不随宽度变化",
  big.h250 === big.h300,
  `250px 宽时 ${big.h250}px 高 / 300px 宽时 ${big.h300}px 高`
);
check("有内容行（不是空壳）", big.rowCount >= 4, `${big.rowCount} 行`);
check("没有横向溢出", big.overflowX === false, "");

/* ============================================================
   二、小屏：不能顶出屏幕
   ============================================================ */

console.log("\n[2] 小屏 320px");
const small = await renderHud(320, 640);

// max-width 是 min(300px, 100vw-24px) → 320 时应该是 296
check("小屏宽度被钳到 296 以内", small.width <= 296, `${small.width}px`);
check("小屏没有横向溢出", small.overflowX === false, "");
check(
  "小屏底色同样是 0.68",
  /rgba\(\s*20\s*,\s*24\s*,\s*33\s*,\s*0\.68\s*\)/.test(small.bg),
  small.bg
);

/* ============================================================
   三、原生侧：数值必须与降级版一致
   ============================================================ */

console.log("\n[3] 原生侧契约");

const svc = await readFile(join(ROOT, "android/java/DshHudService.java"), "utf8");
const hudJs = await readFile(join(ROOT, "scripts/hud.js"), "utf8");

/** 剥注释：历史值会写在注释里解释改动，反向断言会被误导。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}
const svcNoComment = stripComments(svc);

check("契约：展开态上限 300dp", /W_MAX_DP\s*=\s*300/.test(svcNoComment), "");
check("契约：收起态仍是 238dp", /W_COLLAPSED_DP\s*=\s*238/.test(svcNoComment), "");
check(
  "契约：底色 alpha 是 0xAD（0.68）",
  /#AD141821/.test(svcNoComment),
  (svcNoComment.match(/#C{0,1}C?141821/) || []).join(",")
);
check(
  "契约：不再出现旧的 #CC141821",
  !/#CC141821/.test(svcNoComment),
  "旧值还在"
);
check("契约：有小屏钳制", /int clampWidth\(float wantDp\)/.test(svcNoComment), "");
check(
  "契约：所有 setMaxWidth 都走钳制",
  (svcNoComment.match(/setMaxWidth\(/g) || []).length ===
    (svcNoComment.match(/setMaxWidth\(clampWidth\(/g) || []).length,
  `共 ${(svcNoComment.match(/setMaxWidth\(/g) || []).length} 处`
);
check(
  "契约：胶囊行在展开/收起时切换宽度",
  /capsule\.setMaxWidth\(clampWidth\(W_COLLAPSED_DP\)\)/.test(svcNoComment) &&
    /capsule\.setMaxWidth\(clampWidth\(W_MAX_DP\)\)/.test(svcNoComment)
);
check(
  "契约：输入框跟着加宽到 190",
  /dp\(190\), dp\(34\)/.test(svcNoComment),
  ""
);

// 两套实现数值一致
check(
  "契约：降级版也有 300",
  /max-width:min\(300px,calc\(100vw - 24px\)\)/.test(hudJs),
  ""
);
check(
  "契约：降级版 alpha 也是 0.68",
  /background:rgba\(20,24,33,\.68\)/.test(hudJs),
  ""
);
check(
  "契约：降级版不再出现旧的 250 / .92",
  !/max-width:250px/.test(hudJs) && !/rgba\(20,24,33,\.92\)/.test(hudJs),
  "旧值还在"
);

await browser.close();
server.close();

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
