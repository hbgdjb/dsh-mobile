/* ============================================================
   Prompt — 系统提示词的分层组装与瘦身

   ============ 这一版在解决什么 ============

   0.31.0 量过：system prompt 在「40 个工作区文件 + 20 份资料」的场景下
   到了 **1212 token**，其中 547 token 是两段路径清单。

   问题不是「长」，是**放错了层**。

   借用的判据（来自 GitHub mashanglinyu/luanyujia-workbench
   的 09-改造参考）：**「这东西谁会读？多久读一次？」**

   | 判据 | 归层 | 上限 |
   | --- | --- | --- |
   | 每轮都读 | 注入层 | 必须极短 |
   | 每场开场读一次 | 私有层 | ≤ 4KB |
   | 需要时才查 | 共享层 | 不预载，用工具查 |

   落到 DSH 上：
   · 身份 / 权限 / 行为准则 / MCP 能力声明 → **每轮都读** → 注入层
   · 工作区与资料库的文件清单 → **需要时才查**（fs_list / library_list
     本来就能查）→ **共享层，不该每轮预载**
   · 文件总数、顶层目录名 → 私有层，给模型一张「地图」就够，
     免得它凭记忆瞎猜文件名（猜错会直接失败）

   ============ 另一条：单一权威 ============

   文件清单的权威是**存储层 + fs_list 工具**，不是 system prompt。
   提示词里再存一份，就是存了两份权威 —— 而提示词那份会过期
   （用户随时在改文件），过期的那份反而会误导模型。

   ============ 第三条：缓存友好 ============

   messages[0] 是 system prompt，它一变，后面所有内容的 prefix 缓存
   就全废了。所以本文件把段落按**稳定度**排序：
   稳定的在前，易变的（设备时间）在最后。
   这样每轮只有最后几十个 token 失效。

   参考：09-改造参考/Hermes/02-主线/03-context-compaction.md
   与该仓库的 system prompt 瘦身章节。
   ============================================================ */

import { estimateTokens } from "./context.js";

/**
 * 段落分层。数字越小越稳定，越靠前（也就越容易被缓存命中）。
 * tier 0 = 必留，永不裁剪。
 */
export const PROMPT_TIERS = {
  core: 0, // 身份 / 权限 / 行为准则 —— 每轮都读，必须短
  state: 1, // 模式 / 插件 / MCP 能力 —— 用户改设置才变
  index: 2, // 工作区与资料库的「地图」—— 文件增删才变
  volatile: 3, // 设备时间 —— 每轮都变
};

/**
 * 降级优先级：数字越小越先被砍掉。
 *
 * 判据是**可重建性** —— 这段信息模型能不能自己再拿回来：
 * · 地图：能用 fs_list / library_list 重查 → 先砍
 * · 插件 / 附件说明：工具表与工具描述里都有 → 次砍
 * · 模式 / 推理强度：设置页里写着 → 再砍
 * · 设备时间：砍掉只省十几个 token，不值得 → 最后砍
 */
export const PROMPT_CUT_ORDER = {
  workspace: 10,
  library: 11,
  ui: 12,
  plugins: 20,
  attach: 30,
  mode: 40,
  reasoning: 50,
  time: 90,
};

/**
 * 永不降级的段落。
 *
 * mcp：这是 0.20.0 专门修的 bug —— 没有它，模型看到工具表里没有 mcp__*
 * 就会断言「宿主不支持 MCP」，而事实是客户端在、只是没配服务器。
 * 砍掉它等于把修好的 bug 放回去，代价比多占几十 token 大得多。
 * 宁可超预算也不砍。
 */
export const PROMPT_NEVER_CUT = new Set(["mcp"]);

/** system prompt 的软预算（token）。超了就按 PROMPT_CUT_ORDER 降级。 */
export const PROMPT_BUDGET = 640;

/**
 * 低于这个体量的段落不值得砍（砍了也省不下几个 token）。
 * 取 16 是为了让「推理强度」（约 21 token）可砍，而「设备时间」（约 12 token）不可砍。
 */
const MIN_CUTTABLE_TOKENS = 16;

/* ----------------------------------------------------------------
   一、共享层降级：文件清单 → 地图 + 指针
   ---------------------------------------------------------------- */

/** 取路径的顶层目录名；没有目录的算「根」。 */
function topDir(path) {
  const s = String(path || "");
  const i = s.indexOf("/");
  return i < 0 ? "" : s.slice(0, i);
}

/**
 * 把一堆路径压成「一张地图」：
 * 顶层目录（最多 maxDirs 个）+ 散落在根目录的文件名（最多 maxFiles 个）。
 *
 * 为什么不干脆不给？
 * 因为模型确实需要知道「大概有什么」才不会瞎猜文件名 ——
 * 猜错路径会直接失败，而一次 fs_list 的往返并不便宜。
 * 但给 40 条完整路径就完全反了：那是把共享层塞进了注入层。
 */
export function pathMap(paths, options = {}) {
  const maxDirs = options.maxDirs ?? 6;
  const maxFiles = options.maxFiles ?? 4;
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
  if (!list.length) return { text: "", dirs: [], files: [], count: 0 };

  const dirCount = new Map();
  const rootFiles = [];
  for (const p of list) {
    const d = topDir(p);
    if (!d) rootFiles.push(p);
    else dirCount.set(d, (dirCount.get(d) || 0) + 1);
  }

  // 目录多的排前面：模型最常要进的是那些内容多的目录
  const dirs = [...dirCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxDirs)
    .map(([name, n]) => (n > 1 ? `${name}/（${n}）` : `${name}/`));

  const files = rootFiles.slice(0, maxFiles);
  const more = Math.max(0, list.length - dirs.length - files.length);

  const parts = [];
  if (dirs.length) parts.push(dirs.join("、"));
  if (files.length) parts.push(files.join("、"));
  let text = parts.join(" · ");
  if (more > 0) text += ` …等 ${list.length} 项`;
  return { text, dirs, files, count: list.length };
}

/* ----------------------------------------------------------------
   二、注入层内容
   ---------------------------------------------------------------- */

/**
 * 行为准则。
 *
 * 这 7 条是 tier 0 里最大的一块（237 token），但**一条都不能删** ——
 * 删掉第 1 条模型就会臆造文件内容，删掉第 6 条就会谎报执行了工具。
 *
 * 能做的是**改写**：把长句压成短句，语义一条不少。
 * 原文写「绝不臆造文件内容或路径」，压缩后是「不臆造文件内容与路径」——
 * 少了三个字，意思没变。
 */
// 导出是为了让测试能直接断言每一条 —— 这段是 tier 0，改错一个字都会影响每一轮。
export const BEHAVIOR_RULES = [
  "1. 看文件先调工具，不臆造文件内容与路径。",
  "2. 写文件先确认原内容；一次只做必要改动，保留原结构。",
  "3. 路径用相对路径，不带前导斜杠，不越出工作区。",
  // 0.34.2 改写：原句「工具失败先说原因再换路径重试」把「重试」放在宾语位置，
  // 模型容易读成「先解释、然后再说」—— 实测表现是**失败后直接收工**。
  // 改成先把定性说死（中间状态 ≠ 结论），再给次数上限，行为才明确。
  "4. 工具失败是中间状态不是结论：换参数或换方法再试；同一调用原样重复不超过 2 次。",
  "5. 结论先行，中文，简洁；对比内容用表格，不要客套。",
  "6. 不声称执行了没实际调用的工具。",
  '7. 终端是白名单命令不是完整 Linux：看二进制用 fs_inspect，看字节用 fs_read(format="hex")，复制/移动/删除用 cp / mv / rm。',
];

const ATTACH_HINT =
  '【附件】uploads/ 是用户随消息发来的文件：文本直接附正文；二进制附类型与头部摘要；图片按视觉消息发送。要细节用 fs_inspect 或 fs_read(format="hex")，别用 cat 读二进制。';

/**
 * MCP 能力声明。
 *
 * 这段是 0.20.0 修 bug 的产物，**不能删也不能弱化** ——
 * 没有它，模型看到工具表里没有 mcp__* 就会断言「宿主不支持 MCP」，
 * 而事实是客户端在、只是没配服务器。删掉它等于把修好的 bug放回去。
 * 但措辞可以压：原文 4 行，改成 2 行。
 */
export function mcpCapabilityLine(mcpServers = [], minimal = false) {
  const servers = Array.isArray(mcpServers) ? mcpServers : [];
  if (!servers.length) {
    return [
      "【MCP 服务器】未配置（内置 MCP 客户端已就绪，只是还没添加服务器）。",
      "被问起 MCP 时正确回答是「客户端有，但没配服务器」，而不是「宿主不支持 MCP」。添加：设置 → 工作区与 MCP → 添加服务器；控制本机用 http://127.0.0.1:8788/mcp。",
      minimal ? "（当前是极简模式，MCP 工具不装配，切到标准模式才可用。）" : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const rows = servers.slice(0, 8).map((sv) => {
    const n = Array.isArray(sv.tools) ? sv.tools.length : 0;
    if (!sv.enabled) return `${sv.name}（已停用）`;
    if (!n) return `${sv.name}（未连接 · 还没拉到工具列表）`;
    return `${sv.name}（${n} 个工具）`;
  });
  const total = servers.reduce((n, sv) => n + (sv.enabled && Array.isArray(sv.tools) ? sv.tools.length : 0), 0);
  return [
    `【MCP 服务器】${servers.length} 个，共 ${total} 个工具：${rows.join("、")}`,
    total
      ? "调用名形如 mcp__<服务器>__<工具>，每次调用弹审批。"
      : "还没拉到工具：到「工作区与 MCP」点一次「测试连接」。",
    minimal ? "（当前是极简模式，MCP 工具不装配，切到标准模式才可用。）" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const REASONING_TEXT = {
  off: "Off — 不展开推理，直接给结论与产物。",
  low: "Low — 直接给结论，少解释，能一次做完就一次做完。",
  high: "High — 结论先行，关键步骤简要说明。",
  max: "Max — 先列关键假设，工具调用前确认路径与影响，结论附依据。",
};

/**
 * 控屏指导（0.33.0）。
 *
 * ============ 为什么它要「条件注入」============
 *
 * 控屏是本机 MCP 的能力，不是宿主的内建能力 ——
 * 用户没配本机 MCP（或者配了但没开本机控制）时，
 * 这段指导只会让模型知道一堆自己调不了的工具名，白花 token。
 *
 * 所以按「谁会读」判据：**只有当已连接的 MCP 服务器真的提供了 ui_* 工具时才注入**。
 *
 * ============ 它要改变的是什么 ============
 *
 * 之前 ui_dump 的输出每行都带「中心(x,y)」，提示词里也说「优先直接复制」——
 * 于是模型学会了**抄坐标**。抄坐标在分辨率变化、列表滚动、弹窗遮挡时会点歪，
 * 而且点歪之后模型往往不知道自己点歪了，会接着往下走。
 *
 * 改成：**优先按语义定位（ref / 文字），坐标只是最后手段**。
 * 这不增加任何工具调用次数，只是把选工具的优先级换对了。
 */
export function uiControlHint(mcpServers = []) {
  const servers = Array.isArray(mcpServers) ? mcpServers : [];
  let hasDump = false;
  let hasTapRef = false;
  for (const sv of servers) {
    if (!sv || !sv.enabled || !Array.isArray(sv.tools)) continue;
    for (const t of sv.tools) {
      const n = String(t?.name || "");
      if (n === "ui_dump") hasDump = true;
      if (n === "ui_tap_ref") hasTapRef = true;
    }
  }
  if (!hasDump && !hasTapRef) return "";
  const parts = [];
  if (hasDump && hasTapRef) {
    parts.push("优先 ui_dump(format=json) 取 ref，ui_tap_ref 点（重定位，不点歪）；");
  } else if (hasTapRef) {
    parts.push("优先 ui_tap_ref 按 ref 点（重定位）；");
  }
  parts.push("ui_click_text 按文字点；坐标仅作最后手段，定位不到就重读界面，不要猜坐标。");
  return `【控屏】${parts.join("")}`;
}

/**
 * 组装 system prompt 的各个段落。
 *
 * @param {Object} ctx
 * @param {Object} ctx.mode           当前模式 { name, detail }
 * @param {string} ctx.permission      权限文案
 * @param {string} ctx.reasoning       推理强度档位
 * @param {Array}  ctx.files           工作区条目（取 path）
 * @param {Array}  ctx.library         资料库条目（取 path）
 * @param {Array}  ctx.plugins         已启用插件
 * @param {Array}  ctx.mcpServers      MCP 服务器
 * @param {boolean} ctx.minimal        是否极简模式
 * @param {string} ctx.now             设备时间文案
 * @returns {Array<{id:string, tier:number, text:string}>}
 */
export function buildPromptSections(ctx = {}) {
  const mode = ctx.mode || { name: "标准", detail: "" };
  const paths = (ctx.files || []).map((f) => (typeof f === "string" ? f : f?.path)).filter(Boolean);
  const libPaths = (ctx.library || []).map((f) => (typeof f === "string" ? f : f?.path)).filter(Boolean);
  const plugins = (ctx.plugins || []).map((p) => p?.name).filter(Boolean);

  const sections = [];

  // ---- tier 0：注入层核心。每轮都读，必须短。 ----
  sections.push({
    id: "identity",
    tier: PROMPT_TIERS.core,
    text: "你是 DeepSeek Harness（DSH），运行在 Android 上的 Agent 宿主。遵循「Model + Harness = Agent」：你负责思考，宿主为你提供文件、终端、搜索、插件等能力。",
  });
  sections.push({
    id: "permission",
    tier: PROMPT_TIERS.core,
    text: `【权限】${ctx.permission || "工作区写入"}`,
  });
  sections.push({
    id: "rules",
    tier: PROMPT_TIERS.core,
    text: ["【行为准则】", ...BEHAVIOR_RULES].join("\n"),
  });

  // ---- tier 1：状态层。用户改设置才变。 ----
  sections.push({
    id: "mode",
    tier: PROMPT_TIERS.state,
    text: `【当前模式】${mode.name}模式${mode.detail ? ` — ${mode.detail}` : ""}`,
  });
  sections.push({
    id: "mcp",
    tier: PROMPT_TIERS.state,
    text: mcpCapabilityLine(ctx.mcpServers, ctx.minimal),
  });
  // 控屏指导：只在真的连上了带 ui_* 工具的 MCP 服务器时才出现（见 uiControlHint 的注释）
  const uiHint = uiControlHint(ctx.mcpServers);
  if (uiHint) {
    sections.push({
      id: "ui",
      tier: PROMPT_TIERS.state,
      text: uiHint,
    });
  }
  sections.push({
    id: "plugins",
    tier: PROMPT_TIERS.state,
    text: plugins.length
      ? `【已启用插件】${plugins.join("、")}（工具见工具表，名为 plugin__<插件>__<工具>）`
      : "【已启用插件】无",
  });
  sections.push({
    id: "attach",
    tier: PROMPT_TIERS.state,
    text: ATTACH_HINT,
  });
  sections.push({
    id: "reasoning",
    tier: PROMPT_TIERS.state,
    text: `【推理强度】${REASONING_TEXT[ctx.reasoning] || REASONING_TEXT.high}`,
  });

  // ---- tier 2：索引层（地图，不是清单）。文件增删才变。 ----
  const ws = pathMap(paths);
  sections.push({
    id: "workspace",
    tier: PROMPT_TIERS.index,
    text: ws.count
      ? `【工作区】共 ${ws.count} 个文件：${ws.text}。用 fs_list 看完整清单、fs_read 读内容。`
      : "【工作区】空。",
  });
  const lib = pathMap(libPaths, { maxDirs: 4, maxFiles: 3 });
  sections.push({
    id: "library",
    tier: PROMPT_TIERS.index,
    text: lib.count
      ? `【资料库】共 ${lib.count} 份（跨会话长期可用）：${lib.text}。用 library_list 看清单、library_read 读内容。`
      : "【资料库】空。",
  });

  // ---- tier 3：易变层。放最后，让 prefix 缓存只失效最后几十个 token。 ----
  sections.push({
    id: "time",
    tier: PROMPT_TIERS.volatile,
    text: `【设备时间】${ctx.now || ""}`,
  });

  return sections;
}

/**
 * 把段落拼成最终 system prompt，并在超预算时降级。
 *
 * 降级顺序按 PROMPT_CUT_ORDER（可重建性），**不是**按 tier。
 * 之前按 tier 砍会先砍掉「设备时间」（12 token）再砍「地图」，
 * 省下的 token 一样多，损失却大得多 —— 时间对模型有用，地图模型能自己查。
 *
 * tier 0 永不裁剪 —— 身份与行为准则是这层的全部意义。
 *
 * @returns {{ text: string, stats: Object }}
 */
export function assemblePrompt(sections, options = {}) {
  const budget = options.budget ?? PROMPT_BUDGET;
  const list = Array.isArray(sections) ? sections.filter((s) => s?.text) : [];

  const render = (kept) => kept.map((s) => s.text).filter(Boolean).join("\n\n");

  let kept = list.slice();
  const dropped = [];
  let text = render(kept);

  // 降级：按可重建性从小到大，一次砍一段，砍完重算
  for (let guard = 0; guard < 12; guard += 1) {
    if (estimateTokens(text) <= budget) break;
    const victims = kept
      .filter((s) => s.tier > PROMPT_TIERS.core)
      .filter((s) => !PROMPT_NEVER_CUT.has(s.id))
      .filter((s) => estimateTokens(s.text) >= MIN_CUTTABLE_TOKENS)
      .sort((a, b) => (PROMPT_CUT_ORDER[a.id] ?? 60) - (PROMPT_CUT_ORDER[b.id] ?? 60));
    if (!victims.length) break;
    const target = victims[0];
    kept = kept.filter((s) => s.id !== target.id);
    dropped.push(target.id);
    text = render(kept);
  }

  const stats = {
    tokens: estimateTokens(text),
    budget,
    sections: list.length,
    dropped,
    tierTokens: list.map((s) => ({ id: s.id, tier: s.tier, tokens: estimateTokens(s.text) })),
  };
  return { text, stats };
}

/**
 * 一次到位：分组装 + 组装。
 * @returns {{ text: string, stats: Object }}
 */
export function buildSystemPromptText(ctx = {}, options = {}) {
  return assemblePrompt(buildPromptSections(ctx), options);
}
