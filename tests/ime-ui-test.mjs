/**
 * 键盘页面测试（浏览器里跑，用假原生桥）
 *
 * ============ 这套测试在补什么 ============
 *
 * core 里的逻辑已经被 node 测过了。但"键区点下去有没有反应"
 * 只有在真 DOM 里才知道：事件绑定、委托、preventDefault、
 * 面板开关、置灰状态 —— 这些错了，逻辑再对也用不了。
 *
 * 原生桥换成假的，只记录"调了什么"，便于断言。
 *
 * 用法：node tests/ime-ui-test.mjs
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
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/ime/keyboard.html";
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
const ctx = await browser.newContext({
  viewport: { width: 360, height: 290 },
  deviceScaleFactor: 2,
});

/** 假原生桥：只记录调用，不做真事。 */
await ctx.addInitScript(() => {
  window.__calls = [];
  window.__ctx = { inputType: "text", isPassword: false, hasSelection: false, multiline: false, canRead: true };

  window.DshIme = {
    commit: (t) => window.__calls.push(["commit", String(t)]),
    deleteBackward: (n) => window.__calls.push(["delete", Number(n) || 1]),
    deleteForward: (n) => window.__calls.push(["deleteForward", Number(n) || 1]),
    moveCursor: (d) => window.__calls.push(["move", d]),
    editorAction: () => window.__calls.push(["send"]),
    vibrate: () => window.__calls.push(["vibrate"]),
    ready: () => window.__calls.push(["ready"]),
    getContext: () => JSON.stringify(window.__ctx),
    getConfig: () => JSON.stringify({ baseUrl: "https://api.test.local/v1", apiKey: "k", apiModel: "m" }),
    listPhrases: () => JSON.stringify([{ title: "打招呼", text: "收到，谢谢" }]),
    listClipboard: () => JSON.stringify(["剪贴板里的一段内容"]),
    captureScreen: () => window.__calls.push(["capture"]),
    replaceSelection: (t, s) => window.__calls.push(["replace", String(t), String(s)]),
    switchIme: () => window.__calls.push(["switch"]),
    // 输入记忆：getLearned 一开始是空的，setLearned 收下键盘写回来的数据
    getLearned: () => window.__learned || "{}",
    setLearned: (j) => {
      window.__learned = String(j);
      window.__calls.push(["learned", String(j)]);
    },
  };
  // 语音桥不给 → voiceAvailable() 返回 false，点语音会提示不可用
});

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message + " @" + (e.stack || "").split("\n")[1]));
await page.goto(`http://127.0.0.1:${port}/ime/keyboard.html`, { waitUntil: "networkidle" });
// 等词库加载完（1.3MB 本地资源，很快）
await page.waitForTimeout(900);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const calls = async () => await page.evaluate(() => window.__calls.slice());

/** 点一个键（用 key 里的字符找）。 */
async function tapKey(k) {
  await page.click(`.key[data-key="${k}"]`);
  await page.waitForTimeout(60);
}

async function typeLetters(word) {
  for (const ch of word) await tapKey(ch);
}

console.log("\n渲染\n");

const layout = await page.evaluate(() => ({
  rows: document.querySelectorAll(".keys .row").length,
  keys: document.querySelectorAll(".key").length,
  hasInput: !!document.querySelector("input, textarea, [contenteditable]"),
}));
check("键区渲染出 4 行", layout.rows === 4, `rows=${layout.rows}`);
check("按键数量合理", layout.keys >= 30, `keys=${layout.keys}`);
check("页面里没有输入元素（否则会抢焦点）", !layout.hasInput);

/* ---------------- 拼音输入 ---------------- */

console.log("\n拼音\n");

await typeLetters("nihao");
const candText = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".cand")).map((b) => b.textContent)
);
check("打 nihao 出候选，且首位是「你好」", candText[0] === "你好", JSON.stringify(candText.slice(0, 5)));

/* ---------------- 拼音与候选同屏 ---------------- */

const both = await page.evaluate(() => {
  const bar = document.getElementById("cands");
  const buf = bar.querySelector(".buffer");
  return {
    barText: bar.textContent,
    bufferText: buf ? buf.textContent : null,
    bufferRole: buf ? buf.dataset.role : null,
    candFirst: bar.querySelector(".cand")?.textContent || null,
    // 拼音块和候选块必须都在同一个候选条里
    sameRow: !!(buf && bar.querySelector(".cand")),
    order: Array.from(bar.children).map((n) => n.className),
  };
});
check(
  "有候选时拼音仍然显示（能核对打的对不对）",
  both.bufferText === "nihao",
  JSON.stringify(both)
);
check("拼音和推荐文字同屏共存", both.sameRow && both.candFirst === "你好", JSON.stringify(both.order));
check("拼音块排在候选前面", both.order[0] === "buffer", JSON.stringify(both.order));

await page.click(".cand");
await page.waitForTimeout(80);
let c = await calls();
check(
  "点候选把文字交给原生 commit",
  c.some((x) => x[0] === "commit" && x[1] === "你好"),
  JSON.stringify(c.filter((x) => x[0] === "commit"))
);

/* ---------------- 拼音随输入实时变化 ---------------- */

console.log("\n拼音联动\n");

await page.evaluate(() => (window.__calls.length = 0));
await typeLetters("niha");
const afterBack = await page.evaluate(() => {
  const b = document.querySelector("#cands .buffer");
  return { text: b?.textContent || null, cands: document.querySelectorAll(".cand").length };
});
check("拼音实时跟随输入显示", afterBack.text === "niha", JSON.stringify(afterBack));

// 清空缓冲，供后续用例使用
for (let i = 0; i < 6; i++) await tapKey("back");
const cleared = await page.evaluate(() => ({
  text: document.querySelector("#cands .buffer")?.textContent || "",
  role: document.querySelector("#cands .buffer")?.dataset.role || "",
}));
check("缓冲清空后拼音块回到提示态", cleared.text === "拼音 / 英文" && cleared.role === "hint", JSON.stringify(cleared));

/* ---------------- 输入记忆 ---------------- */

console.log("\n输入记忆\n");

await typeLetters("shi");
const beforeLearn = await page.evaluate(() =>
  [...document.querySelectorAll("#cands .cand")].map((b) => b.textContent)
);
check("学之前 shi 的首位是「是」", beforeLearn[0] === "是", JSON.stringify(beforeLearn.slice(0, 4)));

// 点一次「时」—— 用户从候选里挑中它，这是"我常用这个词"的唯一证据
const di = beforeLearn.indexOf("时");
check("候选里有「时」", di >= 0, JSON.stringify(beforeLearn.slice(0, 6)));
if (di >= 0) await page.click(`#cands .cand >> nth=${di}`);
await page.waitForTimeout(100);
const picked = await calls();
check(
  "点「时」确实上屏了它",
  picked.some((x) => x[0] === "commit" && x[1] === "时"),
  JSON.stringify(picked.filter((x) => x[0] === "commit"))
);

// 学习是防抖写盘的（连打十个词只落盘一次），等它一下
await page.waitForTimeout(1700);
const learnedCall = (await calls()).find((x) => x[0] === "learned");
check("选择被记下来并写进原生存储", !!learnedCall, JSON.stringify(learnedCall));
let stored = {};
try {
  stored = JSON.parse(learnedCall?.[1] || "{}");
} catch {
  stored = {};
}
check("存的是「时」以及它的权重", (stored["时"] || 0) > 0, JSON.stringify(stored));

// 收尾：把缓冲清干净，别把状态带给后面的用例
for (let i = 0; i < 4; i++) await tapKey("back");

/* ---------------- 退格 ---------------- */

console.log("\n退格\n");

await page.evaluate(() => (window.__calls.length = 0));
await typeLetters("ni");
await tapKey("back"); // 退掉拼音里的 i
await tapKey("back"); // 退掉 n，缓冲空
await tapKey("back"); // 这时才该删输入框
c = await calls();
const dels = c.filter((x) => x[0] === "delete");
check("缓冲为空之前不乱删输入框", dels.length === 1, JSON.stringify(dels));

// 上屏之后（缓冲为空）退格必须每次都真正交给原生 ——
// 少发一次，用户看到的就是"回退键不起作用"
await page.evaluate(() => (window.__calls.length = 0));
await tapKey("back");
await tapKey("back");
await tapKey("back");
c = await calls();
const dels3 = c.filter((x) => x[0] === "delete");
check("上屏后连按三次退格，三次都要交给原生", dels3.length === 3, JSON.stringify(c));

/* ---------------- 空格与回车 ---------------- */

console.log("\n空格与回车\n");

await page.evaluate(() => (window.__calls.length = 0));
await typeLetters("nihao");
await tapKey("space");
c = await calls();
check("空格上屏候选", c.some((x) => x[0] === "commit" && x[1] === "你好"));

await page.evaluate(() => (window.__calls.length = 0));
await typeLetters("nihao");
await tapKey("enter");
c = await calls();
check("回车也上屏候选，不吞字母", c.some((x) => x[0] === "commit" && x[1] === "你好"));
check("有拼音时不该触发发送", !c.some((x) => x[0] === "send"));

await page.evaluate(() => (window.__calls.length = 0));
await tapKey("enter");
c = await calls();
check("缓冲为空时回车触发编辑器动作", c.some((x) => x[0] === "send"));

/* ---------------- 中英切换 ---------------- */

console.log("\n中英切换\n");

await page.evaluate(() => (window.__calls.length = 0));
await tapKey("mode");
await tapKey("a");
c = await calls();
check("英文模式直接上屏字母", c.some((x) => x[0] === "commit" && x[1] === "a"));
await tapKey("mode"); // 切回中文

/* ---------------- 面板 ---------------- */

console.log("\n面板\n");

await page.click('.tool[data-tool="phrase"]');
await page.waitForTimeout(200);
const phrase = await page.evaluate(() => ({
  open: !document.getElementById("panel").hidden,
  items: Array.from(document.querySelectorAll("#panel-body .item")).map((b) => b.textContent),
}));
check("短语面板打开并列出条目", phrase.open && phrase.items.some((t) => t.includes("收到")), JSON.stringify(phrase.items));

await page.evaluate(() => (window.__calls.length = 0));
await page.click("#panel-body .item");
await page.waitForTimeout(120);
c = await calls();
check("点短语直接插入", c.some((x) => x[0] === "commit" && x[1].includes("收到")));

await page.click('.tool[data-tool="clip"]');
await page.waitForTimeout(200);
const clip = await page.evaluate(() => ({
  open: !document.getElementById("panel").hidden,
  text: document.getElementById("panel-body").textContent,
}));
check("剪贴板面板列出内容", clip.open && clip.text.includes("剪贴板里的一段内容"), clip.text.slice(0, 40));

await page.click("#panel-close");
await page.waitForTimeout(150);
check("面板可以关掉", await page.evaluate(() => document.getElementById("panel").hidden));

await page.click('.tool[data-tool="ai"]');
await page.waitForTimeout(200);
const ai = await page.evaluate(() => ({
  open: !document.getElementById("panel").hidden,
  title: document.getElementById("panel-title").textContent,
  actions: Array.from(document.querySelectorAll("#panel-body [data-ai]")).map((b) => b.textContent),
}));
check("AI 面板列出五类动作", ai.open && ai.actions.length === 5, JSON.stringify(ai.actions));
await page.click("#panel-close");

/* ---------------- 截图 ---------------- */

console.log("\n截图\n");

await page.evaluate(() => (window.__calls.length = 0));
await page.click('.tool[data-tool="capture"]');
await page.waitForTimeout(120);
c = await calls();
check("点截图把请求交给原生", c.some((x) => x[0] === "capture"), JSON.stringify(c));

/* ---------------- 密码框 ---------------- */

console.log("\n安全\n");

await page.evaluate(() => {
  window.__ctx.isPassword = true;
  window.__dshImeContext(JSON.stringify(window.__ctx));
});
await page.waitForTimeout(200);
const disabled = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".tool")).map((t) => [t.dataset.tool, t.disabled])
);
const map = Object.fromEntries(disabled);
check(
  "密码框里 AI / 语音 / 截图置灰",
  map.ai && map.voice && map.capture && !map.clip && !map.phrase,
  JSON.stringify(map)
);

await page.evaluate(() => {
  window.__ctx.isPassword = false;
  window.__dshImeContext(JSON.stringify(window.__ctx));
});
await page.waitForTimeout(150);

/* ---------------- 符号页 ---------------- */

console.log("\n符号页\n");

await tapKey("sym");
await page.waitForTimeout(150);
const sym = await page.evaluate(() => ({
  first: document.querySelector(".key")?.dataset.key,
  keys: document.querySelectorAll(".key").length,
}));
check("符号页切出来且不是字母", sym.first !== "q" && sym.keys > 20, JSON.stringify(sym));
await tapKey("sym");

/* ---------------- 无报错 ---------------- */

check("全程没有 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
server.close();
console.log(failed ? `\n${failed} 项失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
