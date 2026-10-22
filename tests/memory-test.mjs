/* ============================================================
   长期记忆与防幻觉测试（tests/memory-test.mjs）

   移植自「DSH 长期记忆系统提示词 + 记忆模块」方案，
   守的是那条闭环：upsert → retrieve → buildPrompt → applyUpdates。

   为什么必须测：
   这套东西的失败是**静默**的。记忆没写进去、标签没剥掉、检索没命中，
   都不会报错，只会让模型继续编 —— 而这正是它要解决的事。

   特别关注两个最容易翻车的地方：
   1) <memory_update> 标签漏到用户眼前（流式时更会闪半截 JSON）
   2) 记忆写进去了但检索不到（等于白写）
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
function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}${extra ? " " + extra : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${extra ? " " + extra : ""}`);
  }
}

/* ============================================================
   一、源码契约（读代码）
   ============================================================ */

const memSrc = await readFile(join(ROOT, "scripts/memory.js"), "utf8");
const rtSrc = await readFile(join(ROOT, "scripts/runtime.js"), "utf8");
const uiSrc = await readFile(join(ROOT, "scripts/ui.js"), "utf8");
const scSrc = await readFile(join(ROOT, "scripts/screens.js"), "utf8");
const stSrc = await readFile(join(ROOT, "scripts/store.js"), "utf8");

/**
 * 剥掉注释再做「不该出现某关键字」的反向断言。
 *
 * 这些文件里大量引用了旧写法（「SQLite → localStorage」就是在讲迁移），
 * 不剥掉的话反向契约会永远误报。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}
const memCode = stripComments(memSrc);

check("模块：memory.js 存在且导出四步闭环", /export function upsert/.test(memSrc)
  && /export function retrieve/.test(memSrc)
  && /export function buildPromptBlock/.test(memSrc)
  && /export function applyUpdates/.test(memSrc));

check("模块：持久化用 localStorage 分片（不是 SQLite）", /localStorage/.test(memSrc)
  && !/sqlite/i.test(memCode));

check("模块：按档案隔离记忆", /profileKey/.test(memSrc));

check("规则：提示词含「不知言不知」硬约束", /不知言不知/.test(memSrc));
check("规则：提示词含「有据可依」硬约束", /有据可依/.test(memSrc));
check("规则：提示词要求标注来源", /来源可溯/.test(memSrc));
check("规则：提示词要求冲突以新为准", /冲突以新为准/.test(memSrc));
check("规则：提示词要求时效性信息加边界", /时效加边界/.test(memSrc));

check("回流：提示词要求模型输出 memory_update 标签", /<memory_update>/.test(memSrc));

check("注入：runtime 用 buildPromptBlock 拼进 system prompt", /buildPromptBlock\(/.test(rtSrc));
check("注入：system prompt 走 buildFullSystemPrompt", /buildFullSystemPrompt/.test(rtSrc));

check("剥离：runtime 流式用过滤器挡标签", /createTagFilter/.test(rtSrc));
check("剥离：runtime 把标签内容落库", /persistTags/.test(rtSrc));
check("剥离：标签不回灌给模型", /stripMemoryTags\(streamed\)/.test(rtSrc));

check("纠正：识别「不对/错了」类纠正信号", /detectCorrection/.test(rtSrc) && /CORRECTION_SIGNALS/.test(memSrc));
check("纠正：纠正类记忆置信度置 1", /type === "correction" \? 1/.test(memSrc));

check("开关：设置里有 memoryEnabled", /memoryEnabled: true/.test(stSrc));
check("开关：ui 有 toggle-memory 开关", /case "toggle-memory"/.test(uiSrc));
check("可见可删：有「我的记忆」面板", /function memorySheet/.test(uiSrc));
check("可见可删：可单条删除", /delete-memory/.test(uiSrc));
check("可见可删：可全部清空", /clear-memories/.test(uiSrc));
check("可见可删：设置页有入口", /open-memory/.test(scSrc));

/* ============================================================
   二、行为验证（真的跑起来）
   ============================================================ */

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

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

/* 二之一：写入 → 检索 → 注入 */

const w = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  m.clearAll();
  m.upsert("preference", "称呼", "老张", 0.9);
  m.upsert("fact", "产品名", "DSH 移动端宿主", 0.9);
  m.upsert("preference", "语言", "简体中文", 0.9);
  m.upsert("correction", "部署环境", "生产环境用 Docker", 1);
  return {
    all: m.listAll().length,
    hit: m.retrieve("该怎么称呼我").map((e) => e.key),
    miss: m.retrieve("量子计算 天气预报").map((e) => e.key),
    prompt: m.buildPromptBlock("该怎么称呼我", "BASE"),
  };
});

check("写入：四条记忆全部落库", w.all === 4, `count=${w.all}`);
check("检索：问「怎么称呼我」能命中「称呼」", w.hit.includes("称呼"), JSON.stringify(w.hit));
check("检索：无关问题不硬塞记忆", w.miss.length === 0, JSON.stringify(w.miss));
check("注入：prompt 包含记忆条目", w.prompt.includes("老张"), "");
check("注入：prompt 包含纠正类记忆", w.prompt.includes("Docker"), "");
check("注入：prompt 保留了基础段", w.prompt.startsWith("BASE"), "");
check("注入：prompt 含防幻觉规则", w.prompt.includes("不知言不知"), "");

// 「记忆为空」必须先真正清空：纠正类记忆按设计永远注入，
// 带着它测「空」是测不出规则注入的
const empty = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  m.clearAll();
  const p = m.buildPromptBlock("不相干的queryxyz", "BASE");
  return { p, n: m.listAll().length };
});
check("注入：记忆为空时仍注入规则", empty.p.includes("不知言不知")
  && empty.p.includes("暂无相关记录"), `n=${empty.n}`);

/* 二之二：同键覆盖 + 纠正不被降级 */

const o = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  m.clearAll();
  m.upsert("correction", "关键事实", "正确值", 1);
  m.upsert("fact", "关键事实", "随便一个值", 0.9); // 后写，但不能把纠正降级
  const e = m.listAll().find((x) => x.key === "关键事实");
  const typeAfter = e.type;
  m.upsert("fact", "普通事实", "v1", 0.9);
  m.upsert("fact", "普通事实", "v2", 0.9);
  const e2 = m.listAll().find((x) => x.key === "普通事实");
  return { conf: e.confidence, typeAfter, ordinary: e2.value, count: m.listAll().length };
});

check("覆盖：同键后写覆盖先写", o.ordinary === "v2", o.ordinary);
check("覆盖：纠正类不被普通写入降级", o.conf === 1, `conf=${o.conf}`);
check("覆盖：纠正类保留 correction 类型", o.typeAfter === "correction", o.typeAfter);

/* 二之三：applyUpdates 落库 + 剥离标签 */

const a = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  m.clearAll();
  const reply =
    '好的老张。\n<memory_update>{"type":"preference","key":"称呼","value":"老张"}</memory_update>\n<memory_update>{"type":"fact","key":"项目","value":"DSH"}</memory_update>';
  const cleaned = m.applyUpdates(reply);
  return {
    cleaned,
    hasTag: cleaned.includes("memory_update"),
    count: m.listAll().length,
    keys: m.listAll().map((e) => e.key).sort(),
  };
});

check("剥离：正文里不再有标签", a.hasTag === false, JSON.stringify(a.cleaned));
check("剥离：正文内容保留", a.cleaned.includes("好的老张"), JSON.stringify(a.cleaned));
check("落库：标签内容进了记忆库", a.count === 2, `count=${a.count}`);
check("落库：键名正确", a.keys.join(",") === "称呼,项目" || a.keys.join(",") === "项目,称呼", a.keys.join(","));

/* 二之四：非法 JSON 的标签不炸库也不留在正文 */

const bad = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  m.clearAll();
  const cleaned = m.applyUpdates('正常内容 <memory_update>这不是 JSON</memory_update> 尾巴');
  return { cleaned, count: m.listAll().length };
});
check("容错：非法 JSON 标签不导致崩溃", typeof bad.cleaned === "string", "");
check("容错：非法 JSON 标签不写进库", bad.count === 0, `count=${bad.count}`);
check("容错：非法 JSON 标签仍从正文剥掉", !bad.cleaned.includes("memory_update"), bad.cleaned);

/* 二之五：流式过滤器 —— 标签分片吐出来也不能漏 */

const stream = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");

  // 模拟模型逐字吐出：正文 + 标签 + 正文
  const full =
    '回答开始。<memory_update>{"type":"preference","key":"称呼","value":"老张"}</memory_update>回答结束。';
  const f = m.createTagFilter();
  let shown = "";
  for (const ch of full) shown += f.push(ch);
  shown += f.flush();
  return {
    shown,
    leaked: shown.includes("memory_update") || shown.includes("老张"),
    tags: f.tags.length,
    text: f.text,
  };
});

check("流式：逐字吐也不漏标签", stream.leaked === false, JSON.stringify(stream.shown));
check("流式：正文完整保留", stream.shown.includes("回答开始。") && stream.shown.includes("回答结束。"), stream.shown);
check("流式：标签内容被收集下来", stream.tags === 1, `tags=${stream.tags}`);

/* 二之六：未闭合的标签也不能漏到正文 */

const partial = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  const f = m.createTagFilter();
  let shown = "";
  for (const ch of '正文<memory_update>{"type":"fac') shown += f.push(ch);
  shown += f.flush();
  return { shown, leaked: shown.includes("memory_update") };
});
check("流式：未闭合标签不漏到正文", partial.leaked === false, JSON.stringify(partial.shown));

/* 二之七：纠正信号检测 */

const corr = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  return {
    a: m.detectCorrection("不对，是另一回事"),
    b: m.detectCorrection("你搞错了，应该是 B"),
    c: m.detectCorrection("帮我看下这个文件"),
    d: m.detectCorrection("重新说一遍刚才那个"),
  };
});
check("纠正：识别「不对」", corr.a === true);
check("纠正：识别「你搞错了」", corr.b === true);
check("纠正：识别「重新说」", corr.d === true);
check("纠正：普通问句不误判", corr.c === false);

/* 二之八：纠正上下文里的记忆按 correction 落库（置信度 1） */

const forced = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  m.clearAll();
  m.persistTags(['{"type":"fact","key":"环境","value":"测试环境"}'], { correcting: true });
  const e = m.listAll()[0];
  return { type: e.type, conf: e.confidence };
});
check("纠正：纠正上下文里按 correction 落库", forced.type === "correction", forced.type);
check("纠正：纠正上下文里置信度为 1", forced.conf === 1, `conf=${forced.conf}`);

/* 二之九：删除与清空 */

const rm = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  m.clearAll();
  m.upsert("fact", "A", "1", 0.9);
  m.upsert("fact", "B", "2", 0.9);
  const ok = m.remove("A");
  const afterOne = m.listAll().length;
  m.clearAll();
  return { ok, afterOne, afterAll: m.listAll().length };
});
check("删除：删掉指定条目", rm.ok === true && rm.afterOne === 1, `afterOne=${rm.afterOne}`);
check("删除：全部清空", rm.afterAll === 0, `afterAll=${rm.afterAll}`);

/* 二之十：档案隔离 —— 换个档案名就是另一个记忆库 */

const prof = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  const store = await import("/scripts/store.js");
  m.clearAll();
  m.upsert("fact", "X", "1", 0.9);
  const before = m.listAll().length;
  store.setSettings({ profileName: "另一个档案" });
  const other = m.listAll().length;
  store.setSettings({ profileName: "本机用户" });
  const back = m.listAll().length;
  m.clearAll();
  return { before, other, back };
});
check("隔离：换档案后看不到原档案的记忆", prof.other === 0, `other=${prof.other}`);
check("隔离：换回来记忆还在", prof.back === prof.before, `back=${prof.back}`);

/* 二之十一：同义改写召回（概念组） */

const recall = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  m.clearAll();
  m.upsert("preference", "称呼", "老张", 0.9);
  m.upsert("fact", "数据库", "PostgreSQL 15", 0.9);
  m.upsert("preference", "代码风格", "2 空格缩进，不加分号", 0.9);
  const cases = [
    ["怎么称呼我", "称呼"],
    ["我叫什么", "称呼"],
    ["我是谁", "称呼"],
    ["db 是哪个", "数据库"],
    ["用的什么数据库", "数据库"],
    ["格式化习惯", "代码风格"],
    ["写代码要加分号吗", "代码风格"],
  ];
  const rows = cases.map(([q, want]) => {
    const got = m.retrieve(q).map((e) => e.key);
    return { q, want, got, ok: got.includes(want) };
  });
  const neg = ["量子计算 天气预报", "帮我订一张机票"].map((q) => m.retrieve(q).map((e) => e.key));
  m.clearAll();
  return { rows, neg, hit: rows.filter((r) => r.ok).length, total: rows.length };
});
for (const r of recall.rows) {
  check(`召回：同义问法「${r.q}」能命中「${r.want}」`, r.ok, JSON.stringify(r.got));
}
check("召回：同义改写召回率 100%", recall.hit === recall.total, `${recall.hit}/${recall.total}`);
check("召回：无关问题不误召回", recall.neg.every((n) => n.length === 0), JSON.stringify(recall.neg));

/* 二之十二：注入规模有硬上限 */

const scale = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  const out = [];
  for (const n of [5, 20, 50, 200]) {
    m.clearAll();
    for (let i = 0; i < n; i += 1) m.upsert("correction", `纠正${i}`, `纠正值 ${i}`, 1);
    out.push({ n, ...m.memoryBudget("随便问") });
  }
  m.clearAll();
  for (let i = 0; i < 100; i += 1) m.upsert("fact", `普通${i}`, `普通值 ${i}`, 0.9);
  const many = m.memoryBudget("普通值");
  m.clearAll();
  return { out, many };
});
for (const r of scale.out) {
  check(`上限：纠正 ${r.n} 条时注入行数不超上限`, r.lines <= r.limits.maxEntries, `lines=${r.lines}`);
  check(`上限：纠正 ${r.n} 条时 token 不超预算`, r.tokens <= r.limits.maxTokens + 400, `tokens=${r.tokens}`);
}
check("上限：纠正类最多注入 maxCorrections 条", scale.out[3].lines <= scale.out[3].limits.maxCorrections, `lines=${scale.out[3].lines}`);
check("上限：100 条普通记忆也不超行数上限", scale.many.lines <= scale.many.limits.maxEntries, `lines=${scale.many.lines}`);

/* 二之十三：记忆块与上下文预算挂钩 */

const budget = await page.evaluate(async () => {
  const m = await import("/scripts/memory.js");
  m.clearAll();
  for (let i = 0; i < 200; i += 1) m.upsert("fact", `事实${i}`, `内容 ${i}`, 0.9);
  const small = m.memoryBudget("内容", { maxTokens: 60 });
  const big = m.memoryBudget("内容", { maxTokens: 2000 });
  m.clearAll();
  return { small, big };
});
check("预算：maxTokens 越小注入越少", budget.small.lines < budget.big.lines, `small=${budget.small.lines} big=${budget.big.lines}`);
check("预算：注入行数不超 maxEntries", budget.big.lines <= budget.big.limits.maxEntries, `lines=${budget.big.lines}`);

await browser.close();
server.close();

console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败（通过 ${pass}）`);
  process.exit(1);
} else {
  console.log(`全部通过（${pass} 项）`);
}
