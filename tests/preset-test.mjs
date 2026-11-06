/* ============================================================
   工作模式（设计 / 代码 / 办公 / 学习）测试（tests/preset-test.mjs）

   这一轮加的东西有三层，任何一层断了都是**静默**失败：
     ① 选了不生效      —— 用户以为切了模式，模型收到的 prompt 里什么都没有
     ② 不选也生效      —— 没选模式的老用户凭空多出 100+ token
     ③ 学习模式不记档  —— 回答照常，学习库里空空如也，用户过几天才发现

   所以逐层钉：数据结构 → prompt 注入 → 工具装配 → UI 接线。

   用法：node tests/preset-test.mjs
   ============================================================ */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PRESETS, PRESET_LIST, createSession, setSessionPreset, state, activeSession } from "../scripts/store.js";
import { buildPromptSections, assemblePrompt, PROMPT_TIERS } from "../scripts/prompt.js";
import { estimateTokens } from "../scripts/context.js";
import { availableToolNames } from "../scripts/tools.js";

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

const storeSrc = await readFile(join(ROOT, "scripts/store.js"), "utf8");
const promptSrc = await readFile(join(ROOT, "scripts/prompt.js"), "utf8");
const runtimeSrc = await readFile(join(ROOT, "scripts/runtime.js"), "utf8");
const toolsSrc = await readFile(join(ROOT, "scripts/tools.js"), "utf8");
const uiSrc = await readFile(join(ROOT, "scripts/ui.js"), "utf8");
const screensSrc = await readFile(join(ROOT, "scripts/screens.js"), "utf8");

/* ============================================================
   一、数据结构
   ============================================================ */

const ids = PRESET_LIST.map((p) => p.id);
check("四个模式都在", ["design", "code", "office", "learn"].every((id) => ids.includes(id)), ids.join(","));
check("没有多余模式", PRESET_LIST.length === 4, `实际 ${PRESET_LIST.length}`);
check("id 唯一", new Set(ids).size === ids.length);

for (const p of PRESET_LIST) {
  const ok = p.name && p.brief && p.intro && p.prompt && p.id === p.id;
  check(`字段完整：${p.id}`, Boolean(ok));
}

// 契约文本要短 —— system prompt 每轮都发，预算只有 1100
for (const p of PRESET_LIST) {
  const t = estimateTokens(p.prompt);
  check(`${p.id} 契约体积可控（≤150 token）`, t <= 150, `${t} token`);
}

/* ============================================================
   二、每条契约必须带上它那条最关键的判据
   ============================================================ */

check("设计：要求交付能直接打开", /直接打开/.test(PRESETS.design.prompt));
check("设计：拒绝「简约大气」当方向", /简约/.test(PRESETS.design.prompt));
check("代码：先读再改", /先读再改/.test(PRESETS.code.prompt));
check("代码：要求真跑一次", /真跑/.test(PRESETS.code.prompt));
check("办公：产物落到文件", /文件/.test(PRESETS.office.prompt));
check("办公：数字标来源", /来源/.test(PRESETS.office.prompt));
check("学习：点名 learn_add", /learn_add/.test(PRESETS.learn.prompt));
check("学习：只记结论不存原文", /不要存整段原文/.test(PRESETS.learn.prompt));
check("学习：说明哪些不记", /不记/.test(PRESETS.learn.prompt));

/* ============================================================
   三、prompt 注入
   ============================================================ */

const baseCtx = {
  mode: { name: "标准", detail: "" },
  permission: "工作区写入",
  files: [],
  library: [],
  plugins: [],
  mcpServers: [],
  now: "2026-11-02 11:00",
};

const noPreset = buildPromptSections(baseCtx);
check("没选模式 → 没有 preset 段", !noPreset.some((s) => s.id === "preset"));

const withPreset = buildPromptSections({ ...baseCtx, preset: { name: "设计", prompt: PRESETS.design.prompt } });
const seg = withPreset.find((s) => s.id === "preset");
check("选了模式 → 有 preset 段", Boolean(seg));
check("preset 段文本就是契约原文", seg?.text === PRESETS.design.prompt);
check("preset 属于状态层（非核心，可被裁剪）", seg?.tier === PROMPT_TIERS.state, String(seg?.tier));

const idxMode = withPreset.findIndex((s) => s.id === "mode");
const idxPreset = withPreset.findIndex((s) => s.id === "preset");
check("preset 紧跟在 mode 之后", idxPreset === idxMode + 1, `mode=${idxMode} preset=${idxPreset}`);

// 空 prompt 不该塞一段空文本
const emptyPreset = buildPromptSections({ ...baseCtx, preset: { name: "空", prompt: "" } });
check("空白契约不产生空段", !emptyPreset.some((s) => s.id === "preset"));

// 正常预算下四份都不被裁
for (const p of PRESET_LIST) {
  const { stats } = assemblePrompt(buildPromptSections({ ...baseCtx, preset: { name: p.name, prompt: p.prompt } }));
  check(`预算内不丢弃：${p.id}`, !stats.dropped.includes("preset"), `dropped=${stats.dropped.join(",") || "无"}`);
}

/* ============================================================
   四、store：会话级存储
   ============================================================ */

const beforeMode = state.settings.mode;
state.settings.mode = "standard";

const s1 = createSession({ mode: "standard" });
check("新建会话默认不选模式", s1.preset === null, String(s1.preset));

const s2 = createSession({ mode: "standard", preset: "design" });
check("createSession 可带 preset", s2.preset === "design");

const s3 = createSession({ mode: "standard", preset: "不存在的模式" });
check("未知 preset 被忽略，退化成 null", s3.preset === null);

setSessionPreset(s1.id, "code");
check("setSessionPreset 写入成功", state.sessions.find((s) => s.id === s1.id).preset === "code");

setSessionPreset(s1.id, null);
check("传 null 等于取消", state.sessions.find((s) => s.id === s1.id).preset === null);

setSessionPreset(s1.id, "office");
setSessionPreset(s1.id, "office");
check("重复设同一个值不炸", state.sessions.find((s) => s.id === s1.id).preset === "office");

check("不存在的会话返回 null", setSessionPreset("s_not_exist", "design") === null);

// 两个会话各管各的
const sA = createSession({ mode: "standard", preset: "design" });
const sB = createSession({ mode: "standard", preset: "learn" });
check("模式跟着会话走，不互相污染",
  state.sessions.find((s) => s.id === sA.id).preset === "design" &&
  state.sessions.find((s) => s.id === sB.id).preset === "learn");

state.settings.mode = beforeMode;

/* ============================================================
   五、工具装配
   ============================================================ */

check("学习模式源码里挂了 learn_add", /preset\.id === "learn" \? \["learn_add"\]/.test(toolsSrc));
check("learn_add 已注册进 TOOLS", /learn_add: \{/.test(toolsSrc));

// 极简模式是白名单，学习模式的记录工具必须能穿过去
check("极简模式下学习模式仍保留 learn_add",
  /mode === "minimal"[\s\S]{0,220}learn_add/.test(toolsSrc));

// 这一条是踩过的坑：readFile 返回 {content}，当字符串用第一次不报错、第二次才炸
check("learn_add 没把 readFile 的返回值当字符串",
  /const readText = async/.test(toolsSrc) && /await readText\(monthPath\)/.test(toolsSrc));
check("索引也用 readText 读", /await readText\(indexPath\)/.test(toolsSrc));

/* ============================================================
   六、接线（源码契约，防止改漏）
   ============================================================ */

check("runtime 把 preset 交给 prompt", /preset: preset \? \{ name: preset\.name, prompt: preset\.prompt \} : undefined/.test(runtimeSrc));
check("runtime 导入了 currentPreset", /currentPreset,/.test(runtimeSrc));
check("prompt 有 preset 段", /id: "preset"/.test(promptSrc));
check("preset 有裁剪优先级", /preset: 45/.test(promptSrc));

check("首页渲染了模式按钮", /data-act="set-preset"/.test(screensSrc));
check("ui 处理了 set-preset", /case "set-preset":/.test(uiSrc));
check("ui 导入了 setSessionPreset", /setSessionPreset,/.test(uiSrc));

// 首页重绘后 .reveal 会停在 opacity:0 —— 少了这句，切模式标题就消失
check("首页重绘补了 reveal",
  /box\.querySelectorAll\("\.reveal"\)\.forEach\(\(el\) => el\.classList\.add\("is-in"\)\)/.test(uiSrc));

// 语法基线不在这里重复：tests/legacy-syntax-test.mjs 用 acorn 按 ES2020 逐文件解析，
// 还能区分「真的用了」和「注释里提到」——本文件用字符串匹配会误伤 ui.js 里那条注释。
const legacySrc = await readFile(join(ROOT, "tests/legacy-syntax-test.mjs"), "utf8");
check("语法基线测试存在且覆盖 scripts/", /const DIRS = \["scripts"/.test(legacySrc));

/* ============================================================ */

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
