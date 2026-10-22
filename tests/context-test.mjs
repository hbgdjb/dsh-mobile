/* ============================================================
   上下文压缩测试（tests/context-test.mjs）

   这一轮加了两层东西，都不花模型 token：
   1) 零 token 压缩（compactMessages）
      —— 工具输出才是 Agent 循环里真正吃 token 的东西，
         一次读 300KB 文件就能顶掉几千 token 的对话。
   2) 双阈值 + 锚点保护（trimMessages v2）
      —— 旧版一刀切到底，会把「任务锚点」和「意图锚点」一起砍掉。

   这两层的失败是**静默**的：压缩过头会让模型重跑命令、
   砍掉用户最后一句话会让模型答非所问，而且都不报错。
   所以必须逐条钉住。

   context.js 无 DOM 依赖，可直接在 Node 里断言。
   用法：node tests/context-test.mjs
   ============================================================ */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { trimMessages, compactMessages, estimateTokens, TRIM_DEFAULTS } from "../scripts/context.js";

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
   零、源码契约（读代码）
   ============================================================ */

const ctxSrc = await readFile(join(ROOT, "scripts/context.js"), "utf8");
const rtSrc = await readFile(join(ROOT, "scripts/runtime.js"), "utf8");
const uiSrc = await readFile(join(ROOT, "scripts/ui.js"), "utf8");

check("契约：context.js 导出 compactMessages", /export function compactMessages/.test(ctxSrc));
check("契约：context.js 导出 TRIM_DEFAULTS", /export const TRIM_DEFAULTS/.test(ctxSrc));
check("契约：runtime.js 引入 compactMessages", /import \{[^}]*compactMessages[^}]*\} from "\.\/context\.js"/.test(rtSrc));
check("契约：runtime.js 在裁剪前先做零 token 压缩", rtSrc.indexOf("compactMessages(convo)") < rtSrc.indexOf("trimMessages(packed.messages"));
check("契约：ui.js 展示压缩统计", /contextPack/.test(uiSrc));

/* ============================================================
   一、零 token 压缩：重复输出 → 指针
   ============================================================ */

const dup = compactMessages([
  { role: "system", content: "sys" },
  { role: "user", content: "跑一下" },
  { role: "assistant", tool_calls: [{ id: "c1", function: { name: "shell", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content: "同样的输出" },
  { role: "assistant", tool_calls: [{ id: "c2", function: { name: "shell", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c2", content: "同样的输出" },
]);
const toolContents = dup.messages.filter((m) => m.role === "tool").map((m) => m.content);
check("重复：第二次相同输出被替换为指针", toolContents[1].includes("与之前相同的"), toolContents[1]);
check("重复：指针不是空串（否则模型会重跑命令）", toolContents[1].length > 0 && toolContents[1].trim() !== "");
check("重复：指针里写明了工具名", toolContents[1].includes("shell"));
check("重复：第一次出现的内容保持原样", toolContents[0] === "同样的输出");
check("重复：压缩计数为 1", dup.compacted === 1, `compacted=${dup.compacted}`);
check("重复：回收 token 记到了统计里", dup.reclaimed > 0, `reclaimed=${dup.reclaimed}`);

/* ============================================================
   二、零 token 压缩：旧输出 → 占位（不删空）
   ============================================================ */

const old = compactMessages(
  [
    { role: "system", content: "sys" },
    { role: "user", content: "第一轮" },
    { role: "assistant", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "X".repeat(2000) },
    { role: "user", content: "第二轮" },
    { role: "user", content: "第三轮" },
    { role: "user", content: "第四轮" },
  ],
  { keepRecentTurns: 1 },
);
const oldTool = old.messages.find((m) => m.role === "tool");
check("旧输出：被换成占位文案", oldTool.content.includes("已清理的旧工具输出"), oldTool.content);
check("旧输出：占位不是空串", oldTool.content.trim() !== "");
check("旧输出：占位写明调了什么工具", oldTool.content.includes("read_file"));
check("旧输出：占位写明清了多少", /约 \d+ 字符/.test(oldTool.content), oldTool.content);
check("旧输出：占位写明怎么拿回来", oldTool.content.includes("重新调用"), oldTool.content);
check("旧输出：原始大段内容不再出现", !oldTool.content.includes("XXXX"));
check("旧输出：占位比原文短很多", oldTool.content.length < 2000);

/* ============================================================
   三、零 token 压缩：近期超大输出 → 头尾截断
   ============================================================ */

const big = "头".repeat(3000) + "尾标记";
const trunc = compactMessages(
  [
    { role: "system", content: "sys" },
    { role: "user", content: "u" },
    { role: "assistant", tool_calls: [{ id: "c1", function: { name: "shell", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: big },
  ],
  { keepRecentTurns: 5, maxToolChars: 1000 },
);
const truncTool = trunc.messages.find((m) => m.role === "tool");
check("截断：近期超大输出被截短", truncTool.content.length < big.length, `${truncTool.content.length}/${big.length}`);
check("截断：保留了开头", truncTool.content.startsWith("头"));
check("截断：保留了结尾", truncTool.content.includes("尾标记"));
check("截断：中间被明确标注省略", truncTool.content.includes("已省略"));
check("截断：不是空串", truncTool.content.trim() !== "");

/* ============================================================
   四、零 token 压缩：超大 tool_call 参数 → 截断
   ============================================================ */

const args = compactMessages([
  { role: "system", content: "sys" },
  { role: "user", content: "u" },
  {
    role: "assistant",
    tool_calls: [{ id: "c1", function: { name: "write_file", arguments: JSON.stringify({ data: "Y".repeat(5000) }) } }],
  },
]);
const call = args.messages.find((m) => m.tool_calls)?.tool_calls?.[0];
check("参数：超长参数被替换为截断对象", call.function.arguments.includes("__truncated"));
check("参数：保留了预览", call.function.arguments.includes("preview"));
check("参数：参数长度明显变短", call.function.arguments.length < 3000, `${call.function.arguments.length}`);

/* ============================================================
   五、零 token 压缩：旧图片 → 文本占位
   ============================================================ */

const img = compactMessages([
  { role: "system", content: "sys" },
  {
    role: "user",
    content: [
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,CCC" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,DDD" } },
    ],
  },
]);
const parts = img.messages.find((m) => m.role === "user").content;
const imgs = parts.filter((p) => p.type === "image_url").length;
const phs = parts.filter((p) => p.type === "text" && p.text.includes("旧图片已移除")).length;
check("图片：只保留最近 keepImages 张", imgs === 3, `imgs=${imgs}`);
check("图片：旧的换成文本占位", phs === 1, `phs=${phs}`);
check("图片：占位不是空串", parts.some((p) => p.type === "text" && p.text.trim() !== ""));

/* ============================================================
   六、零 token 压缩：幂等 + 不动 system 段
   ============================================================ */

const idem = compactMessages(dup.messages);
check("幂等：重复压缩不会再改内容", idem.messages.filter((m) => m.role === "tool").every((m, i) => m.content === toolContents[i]));
const sysMsg = dup.messages[0];
check("system 段：压缩后仍排在最前且内容不变", sysMsg.role === "system" && sysMsg.content === "sys");
check("system 段：位置未被打乱", dup.messages[0].role === "system");

/* ============================================================
   七、双阈值：未到触发线不裁剪
   ============================================================ */

const small = [{ role: "system", content: "s" }, { role: "user", content: "你好" }];
const noTrim = trimMessages(small, 128000);
check("阈值：远未超预算时不裁剪", noTrim.removed === 0);
check("阈值：level 为 none", noTrim.level === "none", `level=${noTrim.level}`);

/* 造一个用量在 50%~70% 之间的会话 */
function makeConvo(turns, charsPerTurn) {
  const out = [{ role: "system", content: "s" }];
  for (let i = 0; i < turns; i += 1) {
    out.push({ role: "user", content: `问题${i} ${"问".repeat(charsPerTurn)}` });
    out.push({ role: "assistant", content: `回答${i} ${"答".repeat(charsPerTurn)}` });
  }
  return out;
}

// 估算：中文约 1 token/字 → 每轮约 2*charsPerTurn token
const midConvo = makeConvo(60, 200); // ≈ 24000 token，占 128K 的 19%
const mid = trimMessages(midConvo, 128000);
check("阈值：用量不高时不裁剪", mid.removed === 0, `removed=${mid.removed}`);

// 用小窗口把它推到 50%~70% 之间
const win = 40000;
const midRatio = trimMessages(makeConvo(60, 200), win);
check("阈值：50%~70% 之间只预警不裁剪", midRatio.level === "prepare" && midRatio.removed === 0, `level=${midRatio.level}`);

// 超过 70% → 真的裁
const overRatio = trimMessages(makeConvo(200, 200), win);
check("阈值：超过触发线才裁剪", overRatio.removed > 0, `removed=${overRatio.removed}`);
check("阈值：裁剪时 level 为 trim", overRatio.level === "trim");

/* ============================================================
   八、锚点保护
   ============================================================ */

const anchorConvo = makeConvo(200, 200);
const anchored = trimMessages(anchorConvo, win);
const keptUserTexts = anchored.messages.filter((m) => m.role === "user").map((m) => m.content);
check("锚点：最早的任务锚点仍在", keptUserTexts.some((t) => t.startsWith("问题0 ")), `kept=${keptUserTexts.length}`);
check("锚点：最后的意图锚点仍在", keptUserTexts.some((t) => t.startsWith("问题199 ")));
check("锚点：至少保留 1 条真实用户消息", keptUserTexts.length >= 1, `n=${keptUserTexts.length}`);
check("锚点：裁剪后仍有首轮用户消息（protectFirstN）", keptUserTexts[0]?.startsWith("问题0 "));

/* 尾部用户消息保护：构造最后一条消息是 assistant 的情况 */
const tailUser = trimMessages(
  [
    { role: "system", content: "s" },
    { role: "user", content: "唯一真实需求" },
    ...Array.from({ length: 120 }, (_, i) => [
      { role: "user", content: `填充${i} ${"填".repeat(400)}` },
      { role: "assistant", content: `回${i} ${"回".repeat(400)}` },
    ]).flat(),
  ],
  20000,
);
const tailTexts = tailUser.messages.filter((m) => m.role === "user").map((m) => m.content);
check("锚点：极端裁剪后仍留有真实用户消息", tailTexts.length >= 1, `n=${tailTexts.length}`);

/* ============================================================
   九、裁剪目标比例 + 保护不越界
   ============================================================ */

const ratio = trimMessages(makeConvo(400, 200), win);
check("目标：裁剪后用量落到目标比例附近", ratio.used <= ratio.budget * TRIM_DEFAULTS.targetRatio + 4000, `used=${ratio.used} target=${Math.floor(ratio.budget * TRIM_DEFAULTS.targetRatio)}`);
check("目标：裁剪结果仍带裁剪说明", ratio.messages.some((m) => m.role === "system" && String(m.content).includes("上下文裁剪")));

/* ============================================================
   十、边界：空数组 / 只有 system
   ============================================================ */

const empty = trimMessages([], 128000);
check("边界：空数组不报错", Array.isArray(empty.messages) && empty.removed === 0);
const onlySys = trimMessages([{ role: "system", content: "s" }], 128000);
check("边界：只有 system 时不裁剪", onlySys.removed === 0 && onlySys.messages.length === 1);
const cEmpty = compactMessages([]);
check("边界：compactMessages 空数组安全", cEmpty.messages.length === 0 && cEmpty.compacted === 0);
const cNoTools = compactMessages([{ role: "system", content: "s" }, { role: "user", content: "hi" }]);
check("边界：无工具输出时不产生压缩", cNoTools.compacted === 0, `compacted=${cNoTools.compacted}`);

/* ============================================================
   十一、估算函数没被改坏
   ============================================================ */

check("估算：中文按字计", estimateTokens("你好世界") <= 8, `${estimateTokens("你好世界")}`);
check("估算：英文按 3.6 字符/token", estimateTokens("a".repeat(360)) <= 105, `${estimateTokens("a".repeat(360))}`);

console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败（通过 ${pass}）`);
  process.exit(1);
} else {
  console.log(`全部通过（${pass} 项）`);
}
