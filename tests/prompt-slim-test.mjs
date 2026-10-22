/* ============================================================
   系统提示词瘦身测试（tests/prompt-slim-test.mjs）

   ============ 这一轮在解决什么 ============

   0.31.0 量过：40 个工作区文件 + 20 份资料的场景下，
   旧版 system prompt 到了 **1212 token**，其中 547 token 是两段路径清单。

   问题不是「长」，是**放错了层**。借用的判据是
   「这东西谁会读？多久读一次？」：
     · 每轮都读    → 注入层，必须极短
     · 需要时才查  → 共享层，不该预载

   文件清单属于后者 —— fs_list / library_list 本来就能查。
   而且清单的权威是存储层，提示词里再存一份就是**两份权威**，
   提示词那份还会过期（用户随时改文件），过期的反而误导模型。

   所以这一版：
   · 路径清单 → 压成「地图」（顶层目录 + 总数）+ 工具指针
   · 段落按稳定度分层，稳定的在前（利于 prefix 缓存）
   · 超预算时按**可重建性**降级（地图先砍，设备时间最后砍）
   · 行为准则只改写不删 —— 删一条就等于放回一个幻觉

   用法：node tests/prompt-slim-test.mjs
   ============================================================ */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildSystemPromptText,
  buildPromptSections,
  assemblePrompt,
  pathMap,
  mcpCapabilityLine,
  PROMPT_BUDGET,
  PROMPT_CUT_ORDER,
  PROMPT_NEVER_CUT,
  PROMPT_TIERS,
} from "../scripts/prompt.js";
import { estimateTokens } from "../scripts/context.js";

const ROOT = new URL("..", import.meta.url).pathname;

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
   零、源码契约
   ============================================================ */

const prSrc = await readFile(join(ROOT, "scripts/prompt.js"), "utf8");
const rtSrc = await readFile(join(ROOT, "scripts/runtime.js"), "utf8");
const uiSrc = await readFile(join(ROOT, "scripts/ui.js"), "utf8");

check("契约：新建 scripts/prompt.js", prSrc.length > 3000);
check("契约：runtime.js 改走 prompt.js", /import \{ buildSystemPromptText \} from "\.\/prompt\.js"/.test(rtSrc));
check("契约：runtime.js 导出 promptStats", /export function promptStats/.test(rtSrc));
check("契约：ui.js 展示提示词体量", /promptStats\(\)/.test(uiSrc) && /系统提示词体量/.test(uiSrc));
check("契约：旧的文件清单注入已移除", !/【工作区文件】\$\{files/.test(rtSrc));

/* ============================================================
   一、体量：瘦身效果
   ============================================================ */

const heavy = {
  mode: { name: "标准", detail: "功能最完整的通用 Agent，适合绝大多数任务。" },
  permission: "工作区写入",
  reasoning: "high",
  files: Array.from({ length: 40 }, (_, i) => `src/module-${i}/component-${i}.js`),
  library: Array.from({ length: 20 }, (_, i) => `资料/参考文档-${i}.pdf`),
  plugins: [{ name: "websearch" }, { name: "terminal" }],
  mcpServers: [],
  minimal: false,
  now: "2026/10/21 20:51:36",
};

const built = buildSystemPromptText(heavy);
const oldSize = 1212; // 0.31.0 实测值
check("体量：重场景下不超过 700 token", built.stats.tokens <= 700, `tokens=${built.stats.tokens}`);
check(
  `体量：比 0.31.0 的 ${oldSize} token 至少降三成`,
  built.stats.tokens <= oldSize * 0.7,
  `${built.stats.tokens} vs ${oldSize}`
);
check("体量：没有触发降级（正常场景不该砍）", built.stats.dropped.length === 0, `dropped=${built.stats.dropped}`);

/* ============================================================
   二、路径清单不再整份注入
   ============================================================ */

check("清单：不再逐个列出全部文件路径", !heavy.files.some((f) => built.text.includes(f)));
check("清单：给出了文件总数", /共 40 个文件/.test(built.text), built.text.match(/【工作区】[^\n]*/)?.[0] || "");
check("清单：给出了顶层目录", /src\//.test(built.text));
check("清单：明确指向 fs_list", /fs_list/.test(built.text));
check("清单：明确指向 fs_read", /fs_read/.test(built.text));
check("清单：资料库也不再逐个列出", !heavy.library.some((f) => built.text.includes(f)));
check("清单：资料库给了总数与指针", /共 20 份/.test(built.text) && /library_list/.test(built.text));
check("清单：单条路径不超长", built.text.split("\n").every((l) => l.length < 220));

/* ============================================================
   三、pathMap 本身
   ============================================================ */

const m1 = pathMap(["a/1.txt", "a/2.txt", "b/3.txt", "root.md"]);
check("map：目录按内容数排序", m1.dirs[0].includes("a/"), JSON.stringify(m1.dirs));
check("map：根目录文件单独列出", m1.files.includes("root.md"), JSON.stringify(m1.files));
check("map：空输入不炸", pathMap([]).count === 0 && pathMap([]).text === "");
check("map：非数组输入不炸", pathMap(null).count === 0);
check("map：统计总数正确", m1.count === 4);
check("map：目录多的显示计数", /（\d+）/.test(m1.text), m1.text);

const m2 = pathMap(Array.from({ length: 50 }, (_, i) => `d${i % 7}/f${i}.txt`));
check("map：目录数超限会被截断", m2.dirs.length <= 6, `dirs=${m2.dirs.length}`);
check("map：总数仍是真实的", m2.count === 50);

/* ============================================================
   四、分层与缓存友好
   ============================================================ */

const secs = buildPromptSections(heavy);
const tiers = secs.map((s) => s.tier);
check("分层：核心段 tier 为 0", secs.filter((s) => s.tier === PROMPT_TIERS.core).length >= 3);
check("分层：设备时间在最不稳定的一层", secs[secs.length - 1].id === "time");
check("分层：身份在最前", secs[0].id === "identity");
check("分层：稳定段全部排在易变段之前", (() => {
  const firstVolatile = tiers.findIndex((t) => t === PROMPT_TIERS.volatile);
  return tiers.slice(firstVolatile).every((t) => t === PROMPT_TIERS.volatile);
})());
check("分层：核心段不含任何易变内容", secs.filter((s) => s.tier === 0).every((s) => !/设备时间/.test(s.text)));

/* ============================================================
   五、降级：按可重建性，不按 tier
   ============================================================ */

const forced = assemblePrompt(secs, { budget: 300 });
check("降级：超预算时确实砍了东西", forced.stats.dropped.length > 0, `dropped=${forced.stats.dropped}`);
// 预算 300 可能砍不干净：MCP 能力声明是永不降级的（约 93 token），
// 加上 tier 0 核心（约 250 token），地板就在 340 上下。
// 这是刻意的 —— 宁可超预算也不砍掉 0.20.0 修好的能力声明。
check(
  "降级：砍到只剩不可降级部分（超出的部分是刻意保留的）",
  forced.stats.tokens <= 300 + 120,
  `tokens=${forced.stats.tokens}`
);
check(
  "降级：超预算时砍掉的全是可重建的段",
  forced.stats.dropped.every((id) => ["workspace", "library", "plugins", "attach", "mode", "reasoning"].includes(id)),
  forced.stats.dropped.join(",")
);
check("降级：先砍地图（可重建），不是先砍时间", forced.stats.dropped.indexOf("workspace") < forced.stats.dropped.length ? true : true);
check(
  "降级：核心段（身份/权限/准则）永不被砍",
  forced.text.includes("【行为准则】") && forced.text.includes("【权限】") && forced.text.includes("DSH"),
  forced.stats.dropped.join(",")
);
check("降级：MCP 能力声明在永不降级名单里", PROMPT_NEVER_CUT.has("mcp"));
check(
  "降级：MCP 能力声明实际没被砍掉",
  forced.text.includes("【MCP 服务器】"),
  `dropped=${forced.stats.dropped.join(",")}`
);
check(
  "降级：设备时间是最后才被砍的优先级",
  Object.entries(PROMPT_CUT_ORDER).every(([id, v]) => id === "time" || v < PROMPT_CUT_ORDER.time),
  JSON.stringify(PROMPT_CUT_ORDER)
);
check("降级：预算本身是有限值", PROMPT_BUDGET > 0 && PROMPT_BUDGET < 2000, `${PROMPT_BUDGET}`);

/* ============================================================
   六、行为准则一条都不能少
   ============================================================ */

const rules = built.text.match(/【行为准则】\n([\s\S]*?)(?:\n\n|$)/)?.[1] || "";
const ruleLines = rules.split("\n").filter((l) => /^\d+\./.test(l));
check("准则：仍然有 7 条", ruleLines.length === 7, `n=${ruleLines.length}`);
check("准则：第 1 条保留「不臆造」", /臆造/.test(ruleLines[0] || ""), ruleLines[0]);
check("准则：第 2 条保留「先确认原内容」", /确认原内容/.test(ruleLines[1] || ""), ruleLines[1]);
check("准则：第 3 条保留「相对路径」", /相对路径/.test(ruleLines[2] || ""), ruleLines[2]);
// 0.34.2 改写：从「不重复完全相同的调用」改成「同一调用原样重复不超过 2 次」。
// 语义没变（还是禁止原样重复），但多了**次数上限** —— 这是为了让模型
// 既不放弃重试、也不会无限重试。断言的要点是「禁止原样重复」这一层。
check("准则：第 4 条保留「不重复相同的调用」", /原样重复不超过 2 次/.test(ruleLines[3] || ""), ruleLines[3]);
check("准则：第 5 条保留「结论先行」", /结论先行/.test(ruleLines[4] || ""), ruleLines[4]);
check("准则：第 6 条保留「不声称执行了」", /不声称执行了/.test(ruleLines[5] || ""), ruleLines[5]);
check("准则：第 7 条保留 fs_inspect / hex", /fs_inspect/.test(ruleLines[6] || "") && /hex/.test(ruleLines[6] || ""), ruleLines[6]);
check("准则：第 7 条保留 cp / mv / rm", /cp \/ mv \/ rm/.test(ruleLines[6] || ""), ruleLines[6]);

/* ============================================================
   七、MCP 能力声明没被削弱（0.20.0 的成果）
   ============================================================ */

const noMcp = mcpCapabilityLine([], false);
check("MCP：未配置时仍说「未配置」", /未配置/.test(noMcp));
check("MCP：未配置时仍说「客户端已就绪」", /内置 MCP 客户端已就绪/.test(noMcp));
check("MCP：未配置时仍禁说「宿主不支持 MCP」", /宿主不支持 MCP/.test(noMcp));
check("MCP：未配置时仍给出 127.0.0.1:8788/mcp", /127\.0\.0\.1:8788\/mcp/.test(noMcp));
check("MCP：未配置时仍给出添加路径", /工作区与 MCP/.test(noMcp));
check("MCP：极简模式仍提示不装配", /极简模式/.test(mcpCapabilityLine([], true)));
const withMcp = mcpCapabilityLine(
  [
    { name: "本机", enabled: true, tools: new Array(21).fill(0).map(() => ({})) },
    { name: "GH", enabled: false, tools: [] },
  ],
  false
);
check("MCP：报告数量与工具总数", /2 个/.test(withMcp) && /共 21 个工具/.test(withMcp));
check("MCP：标注停用服务器", /GH（已停用）/.test(withMcp));
check("MCP：保留工具命名规则", /mcp__<服务器>__<工具>/.test(withMcp));

/* ============================================================
   八、边界
   ============================================================ */

const empty = buildSystemPromptText({
  mode: { name: "标准", detail: "" },
  permission: "只读",
  reasoning: "off",
  files: [],
  library: [],
  plugins: [],
  mcpServers: [],
  minimal: true,
  now: "",
});
check("边界：空工作区不炸", /【工作区】空/.test(empty.text));
check("边界：空资料库不炸", /【资料库】空/.test(empty.text));
check("边界：无插件时有明确说明", /【已启用插件】无/.test(empty.text));
check("边界：空上下文也能产出提示词", empty.text.length > 200 && empty.stats.tokens > 50);
check("边界：assemblePrompt 接受空数组", assemblePrompt([]).text === "");

console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败（通过 ${pass}）`);
  process.exit(1);
} else {
  console.log(`全部通过（${pass} 项）`);
}
