/* ============================================================
   输入框多行显示（0.34.4）

   守的是两个用户可见的故障：
     ① 输入到第二行，框还是只有一行高 —— 看不见自己正在输的字
     ② 语音识别"没反应" —— 其实文字进去了，只是高度没涨所以看不见

   两者同一个根因：`compositionend` 在 WebView 里会丢，
   `ui.composing` 卡在 true，autoGrow 被永久跳过。
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
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

/* ---------------- 工具：在页面里模拟输入 ---------------- */

/** 直接设值并派发 input（可选 inputType），返回高度。 */
async function typeInto(value, inputType = "insertText") {
  return page.evaluate(
    async ({ value, inputType }) => {
      const el = document.querySelector("#composer-input");
      el.focus();
      el.value = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
      // autoGrow 走 rAF，等两帧
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        height: Math.round(el.getBoundingClientRect().height),
        scrollTop: Math.round(el.scrollTop),
        scrollHeight: Math.round(el.scrollHeight),
        clientHeight: Math.round(el.clientHeight),
        styleH: el.style.height,
      };
    },
    { value, inputType }
  );
}

async function lineHeight() {
  return page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    const cs = getComputedStyle(el);
    return Math.round(parseFloat(cs.lineHeight) || 22);
  });
}

/* ============================================================
   一、基本行为：高度跟随行数
   ============================================================ */

const lh = await lineHeight();
console.log(`\n（单行高约 ${lh}px，上限 132px）\n`);

const one = await typeInto("第一行");
check("单行：高度是一行", one.height > 0 && one.height < lh * 2.2, `${one.height}px`);

const two = await typeInto("第一行\n第二行");
check("两行：高度明显变高", two.height > one.height + lh * 0.6, `${one.height}px → ${two.height}px`);

const four = await typeInto("1\n2\n3\n4");
check("四行：继续变高", four.height > two.height + lh * 0.6, `${two.height}px → ${four.height}px`);

const back = await typeInto("只剩一行");
check("删回一行：高度也回落（不是只涨不缩）", back.height < four.height - lh * 0.6, `${four.height}px → ${back.height}px`);

/* ============================================================
   一之二、自动折行（不按回车，长句自己折到第二行）
   ============================================================ */

const shortLine = await typeInto("短");
const wrapped = await typeInto("这是一段很长的中文输入内容用来测试自动折行时候输入框会不会跟着变高如果不变高就会看不见正在输入的字");
check(
  "折行：长句自动折行后高度跟着涨",
  wrapped.height > shortLine.height + 20,
  `${shortLine.height}px → ${wrapped.height}px`
);

/* ============================================================
   一之三、逐字输入（真实中文输入法的路径）
   ============================================================ */

// 用户报的现象：一个字一个字往里打，框不涨；按一下退格，立刻涨到正确高度。
// 这正是"组合输入 + 高度写回被跳过"的组合症状，必须逐字验。
const perChar = await page.evaluate(async () => {
  const el = document.querySelector("#composer-input");
  el.value = "";
  el.focus();
  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

  const steps = [];
  const sentence = "这是一段通过输入法逐字输入的中文内容用来验证高度会不会跟着长";
  let acc = "";
  for (const ch of sentence) {
    acc += ch;
    el.value = acc;
    // 真实输入法在组合期间派发的正是 insertCompositionText
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    steps.push({ len: acc.length, h: Math.round(el.getBoundingClientRect().height) });
  }
  el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { steps, finalH: Math.round(el.getBoundingClientRect().height), styleH: el.style.height };
});

const firstChar = perChar.steps[0];
const lastChar = perChar.steps[perChar.steps.length - 1];
// 找到第一个高度发生变化的字 —— 这比"取中间点"可靠：
// 中间点可能还没折行（取决于字号和句子长度），取中点会误判。
const grownAt = perChar.steps.findIndex((x) => x.h > firstChar.h);
check(
  "逐字：输入过程中高度确实在增长（不是敲完才变）",
  grownAt > 0 && lastChar.h > firstChar.h,
  `第 ${grownAt + 1} 个字开始变高，${firstChar.h}px → ${lastChar.h}px`
);
check(
  "逐字：最终高度没退化成 auto",
  !/auto/.test(perChar.styleH || ""),
  `styleH=${perChar.styleH}`
);
check(
  "逐字：高度是单调不减的（不会中途缩回去）",
  perChar.steps.every((s, i) => i === 0 || s.h >= perChar.steps[i - 1].h),
  perChar.steps.map((s) => s.h).join(",")
);

/* ---------------- 只有 compositionupdate、没有 input 的输入法 ---------------- */

// 这是最坑的一种：组合期间只发 compositionupdate，input 要等上屏才发。
// 只在 input 里跟高度的话，用户逐字输入时框完全不动。
const cuOnly = await page.evaluate(async () => {
  const el = document.querySelector("#composer-input");
  el.value = "";
  el.focus();
  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

  const steps = [];
  const sentence = "这是一段只在组合更新时派发事件的中文内容用来验证高度是否还能跟着长";
  let acc = "";
  for (const ch of sentence) {
    acc += ch;
    el.value = acc;
    // 关键：只发 compositionupdate，**不发 input**
    el.dispatchEvent(
      new CompositionEvent("compositionupdate", { bubbles: true, data: acc })
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    steps.push(Math.round(el.getBoundingClientRect().height));
  }
  return { steps, finalH: Math.round(el.getBoundingClientRect().height), styleH: el.style.height };
});
check(
  "只有 compositionupdate：高度仍然跟着长",
  cuOnly.finalH > cuOnly.steps[0],
  `${cuOnly.steps[0]}px → ${cuOnly.finalH}px`
);
check(
  "只有 compositionupdate：样式不是 auto",
  !/auto/.test(cuOnly.styleH || ""),
  `styleH=${cuOnly.styleH}`
);

/* ---------------- 轮询兜底：完全不发事件也能跟上 ---------------- */

const pollOnly = await page.evaluate(async () => {
  const el = document.querySelector("#composer-input");
  el.value = "";
  el.focus();
  // 连 composition 事件都不发 —— 只改 value，模拟"事件全丢"的输入法
  el.value = "这是一段完全不派发任何输入事件的内容只靠聚焦轮询来兜底验证高度能不能跟上";
  // 轮询间隔 400ms，等两轮
  await new Promise((r) => setTimeout(r, 900));
  return { h: Math.round(el.getBoundingClientRect().height), styleH: el.style.height };
});
check(
  "轮询兜底：完全没事件时高度也能跟上",
  pollOnly.h > 32,
  `${pollOnly.h}px, styleH=${pollOnly.styleH}`
);

// 退格后应该收缩，且不会卡在 auto
const afterBackspace = await page.evaluate(async () => {
  const el = document.querySelector("#composer-input");
  el.value = "短";
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { h: Math.round(el.getBoundingClientRect().height), styleH: el.style.height };
});
check(
  "退格：高度收缩且样式仍是具体像素",
  afterBackspace.h < perChar.finalH && !/auto/.test(afterBackspace.styleH || ""),
  `${perChar.finalH}px → ${afterBackspace.h}px, styleH=${afterBackspace.styleH}`
);

/* ---------------- 重复调用同一高度：不能把高度退化成 auto ---------------- */

// 这一条守的是一个真实踩过的坑：
// autoGrow 为了少碰 DOM 做过「值没变就跳过写回」的优化，
// 而读 scrollHeight 前必须先把 height 设成 auto —— 一旦跳过写回，
// 高度就永久留在 auto 上（rows="1" 时 = 一行高），内容再多也看不见。
const same1 = await typeInto("一样的内容");
const same2 = await typeInto("一样的内容");
const same3 = await typeInto("一样的内容");
check(
  "重复：同样内容连测三次，高度不退化",
  same1.height === same2.height && same2.height === same3.height && same3.height > 0,
  `${same1.height} / ${same2.height} / ${same3.height}`
);
check(
  "重复：样式值是具体像素而不是 auto",
  !/auto/.test(same3.styleH || ""),
  `styleH=${same3.styleH}`
);

/* ============================================================
   二、核心回归：composing 卡住时高度仍然要涨
   ============================================================ */

await page.evaluate(() => {
  const el = document.querySelector("#composer-input");
  el.value = "";
  el.focus();
  // 只发 start、不发 end —— 精确复现「compositionend 丢失」
  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }));
});
const stuckOne = await typeInto("拼音组合中", "insertCompositionText");
const stuckTwo = await typeInto("拼音组合中\n第二行也该可见", "insertCompositionText");

check(
  "composing 卡住：第二行仍然撑高输入框",
  stuckTwo.height > stuckOne.height + lh * 0.6,
  `${stuckOne.height}px → ${stuckTwo.height}px`
);

// 清理残留标志
await page.evaluate(() => {
  document.querySelector("#composer-input").blur();
});

/* ============================================================
   三、超过上限后：高度封顶 + 滚动跟到底
   ============================================================ */

const many = await typeInto(Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 行`).join("\n"));
check("超长：高度封顶在 132px 附近", many.height <= 136 && many.height >= 120, `${many.height}px`);
check("超长：内部可滚动", many.scrollHeight > many.clientHeight + 4, `scrollHeight=${many.scrollHeight} client=${many.clientHeight}`);
check(
  "超长：滚动位置跟到底（正在输的那行可见）",
  many.scrollTop > 0 && Math.abs(many.scrollHeight - many.clientHeight - many.scrollTop) <= 2,
  `scrollTop=${many.scrollTop}`
);

/* ============================================================
   四、卡住的 composing 不能拦住发送
   ============================================================ */

await page.evaluate(() => {
  const el = document.querySelector("#composer-input");
  el.value = "";
  el.focus();
  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
});
// 立刻点发送：应当被拦（真的在组合）
const early = await page.evaluate(async () => {
  const { toastsSeen } = window.__composerTest || {};
  document.querySelector("#send-btn")?.click();
  await new Promise((r) => setTimeout(r, 200));
  return {
    messages: document.querySelectorAll(".msg").length,
    toast: document.querySelector("#toast-layer")?.textContent || "",
  };
});
check(
  "组合进行中：点发送会被拦（不发拼音）",
  early.messages === 0 || /要先/.test(early.toast) || /确认候选/.test(early.toast),
  `msg=${early.messages}`
);

// 等过 3 秒时效，再点一次：应当放行
await page.waitForTimeout(3300);
const already = await page.evaluate(async () => {
  const el = document.querySelector("#composer-input");
  el.value = "能被发出去的内容";
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  // 发送按钮的可用状态是异步刷新的（scheduleSendState），
  // 立刻点会点到还没启用的按钮 —— 等一拍再点。
  await new Promise((r) => setTimeout(r, 250));
  document.querySelector("#send-btn")?.click();
  await new Promise((r) => setTimeout(r, 600));
  return document.querySelectorAll(".msg").length;
});
check("composing 过期后：点发送能放行（不会永久发不出去）", already > 0, `msg=${already}`);

/* ============================================================
   五、源码契约
   ============================================================ */

const fs = await import("node:fs/promises");
const src = await fs.readFile(new URL("../scripts/ui.js", import.meta.url), "utf8");

// 只看 autoGrow 的函数体：注释里为了解释历史会原样引用旧代码，
// 用全文正则去查必然命中 —— 这种断言看起来在守契约，实际只是匹配到注释。
function bodyOf(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return "";
  return src.slice(at, src.indexOf("\n}", at) + 2);
}
check("契约：autoGrow 函数体不再看 composing", !/ui\.composing/.test(bodyOf("autoGrow")));
check("契约：组合期间也调 autoGrow", !/if \(!ui\.composing\) autoGrow\(\)/.test(src));
check("契约：有组合过期判定", /COMPOSING_STALE_MS/.test(src) && /function isComposingNow/.test(src));
check("契约：发送用 isComposingNow 而不是裸标志", /else if \(isComposingNow\(\)\)/.test(src));
check("契约：失焦时复位组合标志", /ui\.composing = false;\n  \}\);/.test(src));

await browser.close();
server.close();

console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败（通过 ${pass}）`);
  process.exit(1);
} else {
  console.log(`全部通过（${pass} 项）`);
}
