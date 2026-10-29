/**
 * system prompt 的「前缀稳定性」测试
 *
 * ============ 为什么要专门测这个 ============
 *
 * DeepSeek 的上下文缓存是按**前缀**命中的：从头开始连续相同的
 * token 才算命中，第一个不同的字节之后就全部算 miss。
 *
 * 所以 system prompt 里「谁在前、谁在后」直接决定缓存命中率：
 * 把每轮都变的内容（时间、按 query 检索的记忆）写在前面，
 * 后面所有固定内容（行为准则、回答规则）就跟着一起失效，
 * 每轮白付一次 prefill。
 *
 * 这些顺序问题肉眼看不出来 —— 文本内容一个字都没少，
 * 只是慢了，而「慢了」不会有人报 bug。只能靠测试守住。
 *
 * 用法：node tests/prompt-prefix-test.mjs
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
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const data = await page.evaluate(async () => {
  const { buildSystemPromptText } = await import("/scripts/prompt.js");
  const { buildMemoryBlock, upsert, clearAll } = await import("/scripts/memory.js");
  const { toolSchemas } = await import("/scripts/tools.js");

  clearAll();
  // 造几条记忆：一条纠正是「永远带上」的，其余按 query 检索
  upsert("correction", "称呼", "叫我老王，不要叫先生", 0.95);
  upsert("preference", "文风", "喜欢短句，少用形容词", 0.9);
  upsert("fact", "项目代号", "内部代号是「青鸟」", 0.9);
  upsert("fact", "周报模板", "周报分三块：进展、风险、下周计划", 0.9);

  const ctx = {
    mode: { name: "标准", detail: "" },
    permission: "工作区写入",
    reasoning: "high",
    files: [{ path: "notes/a.md" }, { path: "notes/b.md" }],
    library: [],
    plugins: [],
    mcpServers: [],
    minimal: false,
    now: "2026/10/25 15:20:00",
    memoryRules: (await import("/scripts/memory.js")).RULES,
  };

  const build = (query, now) => {
    const base = buildSystemPromptText({ ...ctx, now }).text;
    const block = buildMemoryBlock(query, { maxTokens: 800 });
    return { base, block, full: block ? `${base}\n\n${block}` : base };
  };

  const a = build("帮我写周报", "2026/10/25 15:20:00");
  const b = build("帮我写周报", "2026/10/25 15:21:00"); // 只改时间
  const c = build("今天几号", "2026/10/25 15:20:00"); // 只改 query

  function commonPrefix(x, y) {
    let i = 0;
    const n = Math.min(x.length, y.length);
    while (i < n && x[i] === y[i]) i += 1;
    return i;
  }

  const rulesAt = a.full.indexOf("【回答规则】");
  const rulesEnd = a.full.indexOf("\n", a.full.indexOf("</memory_update>") >= 0 ? 0 : rulesAt) ;
  const blockAt = a.block ? a.full.lastIndexOf(a.block) : -1;

  // 工具表顺序
  const names = toolSchemas().map((t) => t.function.name);
  const sorted = [...names].sort((x, y) => x.localeCompare(y));

  return {
    fullLen: a.full.length,
    baseLen: a.base.length,
    blockLen: a.block.length,
    prefixSameQueryDiffTime: commonPrefix(a.full, b.full),
    prefixDiffQuery: commonPrefix(a.full, c.full),
    rulesAt,
    rulesEndToken: a.full.indexOf("【回答规则】") + "【回答规则】".length,
    blockAt,
    rulesInBase: a.base.includes("【回答规则】"),
    blockAfterBase: blockAt >= a.base.length - 4,
    toolCount: names.length,
    toolSorted: JSON.stringify(names) === JSON.stringify(sorted),
    notSortedSample: names.slice(0, 6),
    tail: a.full.slice(-a.block.length - 40),
  };
});

console.log("\n前缀稳定性\n");

check(
  "回答规则已经前移到固定段（不再跟在记忆数据后面）",
  data.rulesInBase === true,
  `规则位置 ${data.rulesAt}，base 长度 ${data.baseLen}`
);

check(
  "记忆数据块挂在整段 system 的最末尾",
  data.blockAfterBase === true && data.blockAt > data.rulesAt,
  `块起始 ${data.blockAt}，base 末尾 ${data.baseLen}`
);

// 只改时间时，公共前缀应该一直走到「设备时间」那几个数字为止。
// 差的那几个字符就是时间本身 —— 它已经是 base 的最后一段了。
check(
  "只改时间只影响末尾那几个数字（前面全命中）",
  data.prefixSameQueryDiffTime >= data.baseLen - 8,
  `公共前缀 ${data.prefixSameQueryDiffTime} / base ${data.baseLen}（差 ${data.baseLen - data.prefixSameQueryDiffTime} 字符，即时间本身）`
);

// 换 query 时，公共前缀至少要覆盖到「规则」结束
check(
  "换问题也能命中到规则为止（规则不再随数据失效）",
  data.prefixDiffQuery >= data.rulesEndToken,
  `公共前缀 ${data.prefixDiffQuery}，规则结束于 ${data.rulesEndToken}`
);

check(
  "工具表按名字排序（注册顺序变了也不影响前缀）",
  data.toolSorted === true,
  `共 ${data.toolCount} 个：${data.notSortedSample.join("、")}`
);

check("全程没有 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
server.close();
console.log(failed ? `\n${failed} 项失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
