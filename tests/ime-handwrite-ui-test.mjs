/**
 * 手写输入端到端测试（真浏览器 + 真 wasm 推理）
 *
 * ============ 这套测试为什么必须跑真浏览器 ============
 *
 * core/handwrite.js 已经被 node 测过了，但那只证明"数学对"。
 * 真正会坏的是这几处，只有真环境才暴露：
 *
 *   · onnxruntime-web 能不能加载 .ort 格式（不是所有版本都行）
 *   · wasm 路径配错 → 模型加载静默失败
 *   · WebView 里没有 SharedArrayBuffer → 多线程版本直接崩
 *   · canvas 的 getImageData 拿到的到底是不是黑白
 *   · 面板尺寸为 0 时画布初始化成 1×1
 *
 * 而且这里跑的是**真模型**：喂 MMH 的标准笔迹，断言认出来的字对。
 * 这一条如果过，说明 JS 的预处理和 Python 定标时是一致的 ——
 * 否则精度会莫名其妙地掉，而看代码完全看不出问题。
 *
 * 用法：node tests/ime-handwrite-ui-test.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { loadAndroidMime } from "./android-serve.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

// MIME 直接用真机那张表（从 DshImeService.java 解析）。
// 以前这里自己写了一版"全对"的表，结果 0.57.0 在真机上
// .mjs 被打成 application/octet-stream，手写面板一点就报错，
// 而这条测试依然是绿的。测试比生产宽松，等于没测。
const androidMime = await loadAndroidMime();

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/ime/keyboard.html";
    // 浏览器会顺手要 favicon，本地测试没有这个文件，
    // 不拦掉会污染"页面有没有报错"这条断言
    if (p === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const b = await readFile(f);
    // 只给 content-type，不给 COOP/COEP —— 真机 WebView 也没有这两个头，
    // 给了就等于偷偷打开了 SharedArrayBuffer，测不到单线程路径
    res.writeHead(200, { "content-type": androidMime.mimeFor(f) });
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
const ctx = await browser.newContext({
  viewport: { width: 360, height: 290 },
  deviceScaleFactor: 2,
});

await ctx.addInitScript(() => {
  window.__calls = [];
  window.__ctx = { inputType: "text", isPassword: false, hasSelection: false, multiline: false, canRead: true };
  window.DshIme = {
    commit: (t) => window.__calls.push(["commit", String(t)]),
    deleteBackward: (n) => window.__calls.push(["delete", Number(n) || 1]),
    vibrate: () => window.__calls.push(["vibrate"]),
    ready: () => window.__calls.push(["ready"]),
    getContext: () => JSON.stringify(window.__ctx),
    getConfig: () => JSON.stringify({}),
    listPhrases: () => "[]",
    listClipboard: () => "[]",
    getLearned: () => "{}",
    setLearned: () => {},
  };
});

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.goto(`http://127.0.0.1:${port}/ime/keyboard.html`, { waitUntil: "load" });
await page.waitForTimeout(900);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};
const calls = () => page.evaluate(() => window.__calls.slice());

/* ---------------- 面板与加载 ---------------- */

console.log("\n面板与模型加载\n");

const hasTool = await page.evaluate(() => !!document.querySelector('.tool[data-tool="hand"]'));
check("工具条上有「手写」按钮", hasTool);

await page.click('.tool[data-tool="hand"]');
await page.waitForTimeout(300);

const panelState = await page.evaluate(() => ({
  open: !document.getElementById("panel").hidden,
  title: document.getElementById("panel-title").textContent,
  hasCanvas: !!document.querySelector(".hw__canvas"),
  canvasW: document.querySelector(".hw__canvas")?.width || 0,
  canvasH: document.querySelector(".hw__canvas")?.height || 0,
}));
check("点开后面板显示", panelState.open, JSON.stringify(panelState));
check("标题是「手写输入」", panelState.title === "手写输入", panelState.title);
check("画布有真实尺寸（不是 1×1）", panelState.canvasW > 100 && panelState.canvasH > 20, `${panelState.canvasW}×${panelState.canvasH}`);

// 等模型就绪。16.6MB 模型 + 11.3MB wasm，本地也就几秒，
// 但 CI 机器慢的时候要给它足够时间。
const t0 = Date.now();
let status = "";
for (let i = 0; i < 120; i += 1) {
  status = await page.evaluate(() => window.__dshHandwrite?._debug().status || "none");
  if (status === "ready" || status === "error") break;
  await page.waitForTimeout(500);
}
const loadMs = Date.now() - t0;
check("模型加载成功", status === "ready", `status=${status} ${loadMs}ms`);

if (status !== "ready") {
  const msg = await page.evaluate(() => document.querySelector(".hw__hint")?.textContent || "");
  console.log("  加载失败提示：", msg);
  console.log("  页面错误：", errors.slice(0, 5));
}

/* ---------------- 识别精度 ---------------- */

console.log("\n识别（真模型）\n");

const strokes = JSON.parse(await readFile(join(ROOT, "tests", "fixtures-hw-strokes.json"), "utf8"));

/** MMH 的坐标是 1024 方格、y 向上；手写板是 y 向下。 */
function toScreen(med) {
  return med.map((st) => st.map(([x, y]) => [x, 1024 - y]));
}

const results = [];
for (const [ch, med] of Object.entries(strokes)) {
  const cands = await page.evaluate(async (s) => {
    const r = await window.__dshHandwrite.recognize(s);
    return r.map((x) => x.char);
  }, toScreen(med));
  results.push({ ch, cands });
}

const top1 = results.filter((r) => r.cands[0] === r.ch).length;
const top5 = results.filter((r) => r.cands.slice(0, 5).includes(r.ch)).length;
const n = results.length;
console.log(`  样本 ${n} 字：${results.map((r) => r.ch + "→" + (r.cands[0] || "空")).join(" ")}`);
// JS 的渲染和 Python 定标时一致的话，top1 应当在 70% 以上；
// 这批是最简单的独体字，实际会更高。卡在 50% 说明预处理跑偏了。
check(`top1 ≥ 50%（实际 ${top1}/${n}）`, top1 / n >= 0.5, `${((top1 / n) * 100).toFixed(0)}%`);
check(`top5 ≥ 80%（实际 ${top5}/${n}）`, top5 / n >= 0.8, `${((top5 / n) * 100).toFixed(0)}%`);

const yi = results.find((r) => r.ch === "一");
check("「一」认成一", yi?.cands[0] === "一", JSON.stringify(yi?.cands));

/* ---------------- 手势与上屏 ---------------- */

console.log("\n手势与上屏\n");

// 清掉之前的候选，用鼠标画一条横线（约等于"一"）
await page.evaluate(() => window.__dshHandwrite.clearAll());
const box = await page.locator(".hw__canvas").boundingBox();
await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
await page.mouse.down();
for (let i = 1; i <= 10; i += 1) {
  await page.mouse.move(box.x + box.width * (0.25 + 0.05 * i), box.y + box.height * 0.5);
}
await page.mouse.up();

// 等自动识别（写完停 420ms 才认）
await page.waitForTimeout(2200);
const drawn = await page.evaluate(() => ({
  cands: [...document.querySelectorAll(".hw__cands .cand")].map((b) => b.textContent),
  hint: document.querySelector(".hw__hint")?.textContent || "",
}));
check("鼠标画一笔后出了候选", drawn.cands.length > 0, JSON.stringify(drawn));
check("画横线认成「一」", drawn.cands[0] === "一", JSON.stringify(drawn.cands.slice(0, 4)));

if (drawn.cands.length) {
  await page.click(".hw__cands .cand");
  await page.waitForTimeout(200);
  const c = await calls();
  check("点候选上屏", c.some((x) => x[0] === "commit" && x[1] === "一"), JSON.stringify(c.filter((x) => x[0] === "commit")));
  const stillOpen = await page.evaluate(() => !document.getElementById("panel").hidden);
  check("上屏后面板不关（可以接着写下一个字）", stillOpen);
  const after = await page.evaluate(() => ({
    n: document.querySelectorAll(".hw__cands .cand").length,
  }));
  check("上屏后画布和候选都清空", after.n === 0, JSON.stringify(after));
}

/* ---------------- 布局：没有多余按钮 ---------------- */

console.log("\n布局\n");

const layout = await page.evaluate(() => {
  const stage = document.querySelector(".hw__stage").getBoundingClientRect();
  const root = document.querySelector(".hw").getBoundingClientRect();
  return {
    bars: document.querySelectorAll(".hw__bar").length,
    btns: [...document.querySelectorAll(".hw button")].map((b) => b.textContent.trim()),
    stageH: Math.round(stage.height),
    stageBottom: Math.round(stage.bottom),
    rootBottom: Math.round(root.bottom),
  };
});
check("没有「退一笔 / 清空」按钮", layout.bars === 0, JSON.stringify(layout.btns));
check("画布把面板留白吃到底", Math.abs(layout.stageBottom - layout.rootBottom) <= 1, `${layout.stageBottom} vs ${layout.rootBottom}`);
check("画布高度撑开（≥150px）", layout.stageH >= 150, `${layout.stageH}px`);

/* ---------------- 收起即清空 ---------------- */

console.log("\n收起即清空\n");

// 没有清空按钮之后，"写错了怎么办"全靠这条路：关掉面板再打开就是白板
await page.evaluate(() => window.__dshHandwrite.clearAll());
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
await page.mouse.up();
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6);
await page.mouse.up();
await page.waitForTimeout(200);

const drawnStrokes = await page.evaluate(() => window.__dshHandwrite._debug().strokes);
check("画了两笔", drawnStrokes === 2, `strokes=${drawnStrokes}`);

await page.click("#panel-close");
await page.waitForTimeout(250);
const closed = await page.evaluate(() => ({
  open: !document.getElementById("panel").hidden,
  strokes: window.__dshHandwrite._debug().strokes,
}));
check("✕ 关掉面板", !closed.open);
check("关掉时画布已清空", closed.strokes === 0, `strokes=${closed.strokes}`);

await page.click('.tool[data-tool="hand"]');
await page.waitForTimeout(350);
const reopened = await page.evaluate(() => ({
  open: !document.getElementById("panel").hidden,
  strokes: window.__dshHandwrite._debug().strokes,
  cands: document.querySelectorAll(".hw__cands .cand").length,
  status: window.__dshHandwrite._debug().status,
}));
check("再点「手写」是白板", reopened.open && reopened.strokes === 0 && reopened.cands === 0, JSON.stringify(reopened));
check("重开不重载模型（仍 ready）", reopened.status === "ready", reopened.status);

/* ---------------- 收尾 ---------------- */

check("全程没有页面报错", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
server.close();

console.log(failed ? `\n${failed} 项失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
