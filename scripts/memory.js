/* ============================================================
   Memory — 长期记忆库（防幻觉）

   移植自「DSH 长期记忆模块」（Python + SQLite），核心是同一条闭环：

       写入 upsert → 检索 retrieve → 注入 buildPrompt → 更新 applyUpdates

   为什么要它：
   模型的回答依据默认是「参数化记忆」——训练时压缩进来的统计规律。
   它不知道你的产品、你的数据、你和它之前约定过什么，
   但被问到时往往会自信地编一个。这就是幻觉的结构性来源。

   记忆库把依据换成「已验证记录」：
   涉及用户与业务的事实一律从库里取，取不到就承认不知道。
   不是靠提示词求模型「别编」，而是**不给它编的空间**。

   ==================== 与原 Python 版的差异 ====================
   1. 载体：SQLite → localStorage（前端无 SQLite，且 DSH 是纯前端运行时）。
      记忆条目量级很小（几十~几百条），JSON 足够。
   2. 隔离：user_id → profileName（DSH 是单人多设备，没有多用户概念，
      用「本机用户」这个 profile 名做键，将来多档案可扩展）。
   3. 检索：仍是关键词命中 + 置信度排序。生产可换向量检索，
      升级路径见 README。
   4. 额外补了三样原版没有的：
      · 纠正信号检测（"不对/错了/重新说" → confidence 1.0 且置顶）
      · 滚动摘要（每 N 轮入库一份，替代原始长历史）
      · 记忆可见可删（「我的记忆」页面）

   数据流上的关键约束：
   - 记忆**只影响 system prompt**，不影响用户可见的正文。
   - <memory_update> 标签必须在落库前从正文剥掉，否则用户会看到
     一段 JSON —— 这是本模块最容易犯的错。
   ============================================================ */

import { state } from "./store.js";
import { estimateTokens } from "./context.js";
import { checkMemoryEntry, wrapAsData, defang } from "./inject.js";

const LS_MEM = "dsh.mobile.memories.v1";
const LS_SUMMARY = "dsh.mobile.summaries.v1";

/** 记忆类型：preference 偏好 / fact 事实 / correction 纠正 / agreement 共识 / summary 会话摘要 */
export const MEMORY_TYPES = {
  preference: { label: "偏好", hint: "你习惯怎么做" },
  fact: { label: "事实", hint: "客观信息、产品与业务细节" },
  correction: { label: "纠正", hint: "我之前说错了，以你为准" },
  agreement: { label: "共识", hint: "我们确认过的结论" },
  summary: { label: "摘要", hint: "早期对话的浓缩" },
};

/* ============================================================
   持久化
   ============================================================ */

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn("记忆库持久化失败：", key, err);
    return false;
  }
}

/** 当前档案名：DSH 单人多机，用设置里的「档案名称」做隔离键。 */
export const profileKey = () =>
  String(state?.settings?.profileName || "本机用户").trim() || "本机用户";

/** 全部记忆：{ [profile]: { [key]: entry } } */
function allMemories() {
  return readJson(LS_MEM, {});
}

/* ============================================================
   一、写入 / 更新
   ============================================================ */

/**
 * 写入或更新一条记忆。同键覆盖。
 *
 * 两条「不降级」规则：
 * 1. 置信度取 max 而不是覆盖：一条 correction（1.0）不该被后来的
 *    普通 fact（0.9）冲淡 —— 用户明确纠正过的事实，不该退回"猜测"级别。
 * 2. 类型同样不降级：纠正类记忆一旦建立，后来的普通写入不能把它改成 fact。
 *    因为检索时纠正类有 2 倍加权（置顶），类型被冲掉等于「纠正优先」这条策略失效。
 *    反过来，一条 fact 被后来的 correction 覆盖是正常的 —— 那是更强的信息。
 */
export function upsert(type, key, value, confidence = 0.9) {
  const k = String(key || "").trim();
  const v = String(value ?? "").trim();
  if (!k || !v) return null;
  // 安全闸：记忆是持久化 sink —— 写进去以后每一轮都注入。
  // 模型输出（可能被网页/文件/MCP 结果诱导）到这里的路径，
  // 是「提示词注入 → 持久化提权」的自提权链。命中即拒绝落库。
  const check = checkMemoryEntry(type, k, v);
  if (!check.ok) {
    console.warn("记忆写入被拒绝：", check.reason, { key: k });
    return null;
  }
  const p = profileKey();
  const all = allMemories();
  const mine = all[p] || {};
  const prev = mine[k];
  const isCorrection = type === "correction";
  const prevWasCorrection = prev?.type === "correction";
  const conf = Math.max(
    Number(confidence) || 0,
    prevWasCorrection ? 1 : prev?.confidence || 0
  );
  const entry = {
    // 纠正优先：已经是纠正的，除非新写的也是纠正，否则类型不变
    type: isCorrection || !prevWasCorrection ? (MEMORY_TYPES[type] ? type : "fact") : "correction",
    key: k,
    value: v,
    confidence: Math.min(1, conf),
    updatedAt: Date.now(),
    createdAt: prev?.createdAt || Date.now(),
  };
  mine[k] = entry;
  all[p] = mine;
  writeJson(LS_MEM, all);
  return entry;
}

/* ============================================================
   二、检索
   ============================================================ */

/**
 * 同义概念组：把「同一个意思的不同说法」映射到同一个概念 id。
 *
 * 为什么需要它：纯关键词命中对「同义改写」是瞎的。
 * 记忆里存的是「称呼 → 老张」，用户问的是「我叫什么」——
 * 字面不重叠，检索就等于没写进去。
 * 这类失败是**静默**的：模型看不到记忆，就继续编。
 *
 * 做法：正文里只要出现组内任一说法，就给这串文本打上概念标记
 * 「@概念id」；查询和记忆两侧都打标记，标记相同即视为命中。
 *
 * 组的粒度刻意保守：只收「在同一个项目里几乎必然指同一件事」的词。
 * 太泛的组（比如把「环境」「配置」放一起）会把不相关的记忆钓上来，
 * 宁可漏召回，也不要错召回 —— 错召回更危险：
 * 它会让模型拿一条不相干的记忆当依据去回答，性质上仍是幻觉。
 */
export const CONCEPT_GROUPS = [
  { id: "name", words: ["称呼", "名字", "姓名", "叫什么", "我是谁", "叫我", "怎么称呼", "昵称"] },
  { id: "db", words: ["数据库", "db", "datastore", "数据存储", "postgres", "mysql", "sqlite"] },
  { id: "codestyle", words: ["代码风格", "格式化", "风格", "分号", "缩进", "lint", "代码规范"] },
  { id: "deploy", words: ["部署", "部署环境", "线上", "生产", "上线", "服务器"] },
  { id: "lang", words: ["语言", "回复语言", "简体中文", "中文回复", "英文回复"] },
  { id: "tz", words: ["时区", "timezone", "utc", "标准时间"] },
  { id: "backup", words: ["备份", "备份策略", "快照", "定时备份"] },
  { id: "editor", words: ["编辑器", "ide", "编辑器配置"] },
  { id: "package", words: ["包管理", "依赖", "包管理器", "npm", "pnpm", "yarn"] },
];

/** 概念标记前缀。不会和真实词冲突（真实词里不会出现 @）。 */
const CONCEPT_PREFIX = "@";

/** 命中的概念 id 集合。ASCII 词按词边界匹配，避免 "db" 命中 "dbindex"。 */
function conceptsOf(text) {
  const s = String(text || "").toLowerCase();
  const out = new Set();
  if (!s) return out;
  for (const g of CONCEPT_GROUPS) {
    for (const w of g.words) {
      const lw = w.toLowerCase();
      const hit = /^[a-z0-9]+$/.test(lw)
        ? new RegExp(`(^|[^a-z0-9])${lw}([^a-z0-9]|$)`, "i").test(s)
        : s.includes(lw);
      if (hit) {
        out.add(CONCEPT_PREFIX + g.id);
        break;
      }
    }
  }
  return out;
}

/**
 * 分词：英文/数字按词，中文按 2 字滑窗。
 *
 * 为什么中文要滑窗：中文没有空格，按词切需要词典；2 字滑窗虽然会产生
 * 「支付/付宝」这类噪声词，但在短文本召回上够用，而且零依赖。
 */
export function tokens(text) {
  const s = String(text || "").toLowerCase();
  const words = new Set(s.match(/[a-z0-9]+/g) || []);
  const han = s.match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i + 1 < han.length; i += 1) words.add(han[i] + han[i + 1]);
  if (han.length) words.add(han.join(""));
  for (const c of conceptsOf(s)) words.add(c);
  return words;
}

/**
 * 检索与 query 相关的记忆，按 置信度 × 命中度 排序。
 *
 * 命中为 0 的不返回 —— 记忆库不是垃圾桶，塞满上下文反而稀释重点。
 *
 * 命中分两类，分别计权：
 * - 字面命中：关键词真的出现在 key/value 里
 * - 概念命中：命中了同一个 CONCEPT_GROUPS 概念（同义改写）
 * 概念命中的权重比字面低一档：它是「很可能相关」，不是「确定相关」。
 */
export function retrieve(query, limit = 8) {
  const p = profileKey();
  const mine = allMemories()[p] || {};
  const q = tokens(query);
  const qConcepts = new Set([...q].filter((t) => t.startsWith(CONCEPT_PREFIX)));
  const scored = [];
  for (const entry of Object.values(mine)) {
    const t = tokens(`${entry.key} ${entry.value}`);
    let overlap = 0;
    let conceptHit = 0;
    for (const tk of q) {
      if (tk.startsWith(CONCEPT_PREFIX)) continue;
      if (t.has(tk)) overlap += 1;
    }
    for (const ck of qConcepts) if (t.has(ck)) conceptHit += 1;
    if (!overlap && !conceptHit) continue;
    // 纠正类永远靠前：用户明确纠正过的事，不能被普通记忆盖过
    const boost = entry.type === "correction" ? 2 : 1;
    const score = entry.confidence * (1 + overlap + conceptHit * 0.8) * boost;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
  return scored.slice(0, limit).map((s) => s.entry);
}

/** 当前档案的全部记忆，按更新时间倒序（管理页用）。 */
export function listAll() {
  const p = profileKey();
  const mine = allMemories()[p] || {};
  return Object.values(mine).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 删除一条记忆。 */
export function remove(key) {
  const p = profileKey();
  const all = allMemories();
  if (!all[p]) return false;
  const had = Object.prototype.hasOwnProperty.call(all[p], key);
  delete all[p][key];
  writeJson(LS_MEM, all);
  return had;
}

/** 清空当前档案的全部记忆。 */
export function clearAll() {
  const all = allMemories();
  delete all[profileKey()];
  writeJson(LS_MEM, all);
}

/* ============================================================
   三、注入：拼装记忆块
   ============================================================ */

/** 把记忆条目格式化成提示词里的一行行。 */
export function formatEntries(entries) {
  if (!entries.length) return "（暂无相关记录）";
  return entries
    // defang：记忆内容里如果带 < 或 >，换成视觉等价但不闭合的字符。
    // 否则一条 value 里的 </memory-context> 就能伪造围栏闭合，
    // 让模型以为「记忆块结束了，后面是系统指令」。
    .map((e) => `- [${MEMORY_TYPES[e.type]?.label || "事实"}] ${defang(e.key)}：${defang(e.value)}`)
    .join("\n");
}

/**
 * 防幻觉规则块。
 *
 * 六条规则里，第 1、3 条是主力：把「有据可依」和「不知言不知」变成硬约束。
 * 第 6 条是这套系统的回流入口 —— 没有它，记忆库永远写不进东西。
 */
export const RULES = [
  "1. 有据可依：涉及用户身份、偏好、历史约定、产品事实，只能依据上方记忆库或用户本次明确陈述，禁止推测、补全、编造。",
  "2. 来源可溯：使用记忆库信息时，句末标注（来源：长期记忆库）。",
  "3. 不知言不知：记忆库未覆盖且你无法确认的问题，明确回答「我没有相关记录，无法确认」，禁止给出貌似合理的猜测。",
  "4. 冲突以新为准：用户本次说法与记忆库冲突时，以本次为准，并提示「这与之前记录不一致，我将更新记忆」。",
  "5. 时效加边界：价格、版本、数据、新闻等时效性信息，不得凭训练记忆断言，须说明知识截止时间或建议核实。",
  '6. 出现稳定偏好 / 重要事实 / 用户纠正时，在回复末尾输出：\n<memory_update>{"type":"preference|fact|correction|agreement","key":"键名","value":"内容"}</memory_update>',
].join("\n");

/**
 * 注入规模上限。
 *
 * 为什么记忆块必须自己设上限：
 * 记忆块挂在 system 段上，而上下文裁剪只裁历史回合、**不裁 system**。
 * 换句话说，记忆块是唯一一块「只增不减、还不受预算约束」的内容 ——
 * 不设上限，它会随对话单调增长，直到把窗口撑爆。
 *
 * 三个上限：
 * - maxCorrections：纠正类最多带几条（按更新时间倒序取新的）
 * - maxEntries：记忆列表总行数
 * - maxTokens：记忆块本身的 token 上限（超了就按顺序停）
 */
export const MEMORY_LIMITS = {
  maxCorrections: 6,
  maxEntries: 12,
  maxTokens: 1200,
};

/**
 * 构造注入到 system prompt 末尾的记忆块。
 *
 * 记忆为空时**也注入规则**（不含记忆列表）。
 * 原因：一条记录都没有不代表不需要防幻觉 —— 恰恰是最容易编的时候。
 *
 * @param {string} query 本轮用户输入（用作检索 query）
 * @param {string} base 基础 system prompt
 * @param {{ maxCorrections?: number, maxEntries?: number, maxTokens?: number }} [options]
 */
export function buildPromptBlock(query, base = "", options = {}) {
  const lim = { ...MEMORY_LIMITS, ...(options || {}) };
  const entries = retrieve(query, lim.maxEntries);
  // 纠正类永远带上：用户明确纠正过的事，不该因为本轮没提到就被忘掉
  // 但要限量 —— 纠正是「置顶」，不是「全量倾倒」
  const always = listAll()
    .filter((e) => e.type === "correction")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, lim.maxCorrections);
  const merged = [];
  const seen = new Set();
  for (const e of [...always, ...entries]) {
    if (seen.has(e.key)) continue;
    if (merged.length >= lim.maxEntries) break;
    seen.add(e.key);
    merged.push(e);
  }
  // 按 token 预算逐条累加：超了就停，保证注入块有硬上界
  const kept = [];
  let used = 0;
  for (const e of merged) {
    const line = `- [${MEMORY_TYPES[e.type]?.label || "事实"}] ${e.key}：${e.value}`;
    const cost = estimateTokens(line);
    if (kept.length && used + cost > lim.maxTokens) break;
    kept.push(e);
    used += cost;
  }
  const list = kept.length ? formatEntries(kept) : "- （暂无相关记录）";
  return [
    base,
    "",
    // 围栏 + 显式声明：模型看到裸的记忆条目时，
    // 分不清这是「事实记录」还是「让我执行的任务」。
    // 围栏把两者切开，声明把意图说死。
    wrapAsData(list),
    "",
    "【回答规则】",
    RULES,
  ]
    .filter((x) => x !== undefined && x !== null)
    .join("\n");
}

/**
 * 记忆块的规模体检：给设置页与测试用。
 *
 * 返回注入行数与 token 估算 —— 用来确认「记忆库变大了」这件事
 * 不会静悄悄地挤占上下文。
 */
export function memoryBudget(query = "", options = {}) {
  const lim = { ...MEMORY_LIMITS, ...(options || {}) };
  const block = buildPromptBlock(query, "", options);
  const lines = block.split("\n").filter((l) => l.startsWith("- ["));
  return {
    lines: lines.length,
    tokens: estimateTokens(block),
    limits: lim,
  };
}

/* ============================================================
   四、更新：解析 <memory_update> 标签
   ============================================================ */

/** 纠正信号：用户说「不对/错了/不是/重新说」等。 */
const CORRECTION_SIGNALS = [
  "不对", "错了", "不是这样", "不是的", "搞错", "记错", "重新说", "说反了",
  "应该是", "更正", "纠正", "明明是", "你搞混",
];

/** 从用户输入里检测纠正信号。 */
export function detectCorrection(text) {
  const s = String(text || "");
  return CORRECTION_SIGNALS.some((sig) => s.includes(sig));
}

const TAG_RE = /<memory_update>([\s\S]*?)<\/memory_update>/g;

/** 未闭合的标签开头（流式过程中会短暂出现），也要藏起来。 */
const PARTIAL_TAG_RE = /<memory_update>[\s\S]*$/;

/**
 * 从文本里剥掉 <memory_update> 标签。
 *
 * 两类都要处理：
 * - 完整标签：<memory_update>{...}</memory_update>
 * - 未闭合的开头：<memory_update>{"type":"fact",...   （流式还没吐完）
 *
 * 第二种是关键：**流式渲染时用户会看到半截 JSON**。
 * 宁可先藏住，等它闭合后一起删掉。
 */
export function stripMemoryTags(text) {
  const s = String(text || "");
  if (!s.includes("<memory_update")) return s;
  return s.replace(TAG_RE, "").replace(PARTIAL_TAG_RE, "");
}

/**
 * 解析回复里的 <memory_update> 标签：落库，并从正文剥掉。
 *
 * 返回剥离后的正文 —— **调用方必须用返回值覆盖正文**，
 * 否则用户会在气泡里看到一段 JSON。
 */
export function applyUpdates(replyText) {
  const raw = String(replyText || "");
  if (!raw.includes("<memory_update>")) return raw;
  const found = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(raw)) !== null) {
    found.push(m[1]);
  }
  for (const one of found) {
    try {
      const d = JSON.parse(one.trim());
      const type = MEMORY_TYPES[d.type] ? d.type : "fact";
      const confidence = type === "correction" ? 1 : 0.9;
      upsert(type, d.key, d.value, confidence);
    } catch {
      // 标签里不是合法 JSON：忽略这一条，但正文里的标签照样要剥掉
      continue;
    }
  }
  // 剥掉标签与残留空行
  return stripMemoryTags(raw).replace(/\n{3,}/g, "\n\n").trim();
}

/* ============================================================
   五、流式过滤器
   ============================================================ */

/**
 * 把收集到的标签原文落库。
 *
 * 单独一个函数，是为了和 applyUpdates 共用同一套落库逻辑，
 * 也为了让「流式收集」和「整段解析」两条路径行为一致。
 */
export function persistTags(rawTags, { correcting = false } = {}) {
  const list = Array.isArray(rawTags) ? rawTags : [rawTags];
  let count = 0;
  const rejected = [];
  for (const raw of list) {
    try {
      const d = JSON.parse(String(raw || "").trim());
      if (!d || !d.key) continue;
      // 用户这次在纠正我们 → 记忆按 correction 落库，置信度 1.0，检索置顶
      const type = correcting ? "correction" : MEMORY_TYPES[d.type] ? d.type : "fact";
      const confidence = type === "correction" ? 1 : 0.9;
      if (upsert(type, d.key, d.value, confidence)) count += 1;
      else rejected.push(d.key);
    } catch {
      continue;
    }
  }
  // 被拒的记忆要让人知道 —— 静默失败会让人以为「记下了」，
  // 而实际上一条规则可能已经被悄悄丢弃。
  if (rejected.length) {
    console.warn("记忆写入被拒绝：", rejected.join("、"));
    if (typeof globalThis !== "undefined" && typeof globalThis.__dshOnMemoryRejected === "function") {
      globalThis.__dshOnMemoryRejected(rejected);
    }
  }
  return count;
}

/**
 * 边流边剥掉 <memory_update> 标签。
 *
 * 为什么不能等流完了再剥：
 * 标签是分片吐出来的。用户会先看到 `<memory_update>{"type":"pref`，
 * 然后才看到闭合。哪怕只闪一帧，也是「模型吐了一段 JSON」的观感。
 *
 * 做法：维护一个「还没确认是不是标签」的尾巴缓冲。
 * - 遇到完整标签：整段丢掉
 * - 遇到可能是标签开头的尾巴：先扣住不输出，等下一个分片再判断
 * - 确认是正文：立即输出
 *
 * 代价：正文里如果真的出现 "<memory_update" 这几个字，会被当成标签处理。
 * 这是可接受的 —— 这串字符本身在正常回答里几乎不出现。
 */
export function createTagFilter() {
  let buf = "";
  let out = "";
  const tags = [];
  const OPEN = "<memory_update";
  const CLOSE = "</memory_update>";

  return {
    /** 送入一个分片，返回这一分片里可以安全显示的正文。 */
    push(delta) {
      buf += String(delta || "");
      let emit = "";
      for (;;) {
        const i = buf.indexOf(OPEN);
        if (i >= 0) {
          const c = buf.indexOf(CLOSE, i);
          if (c < 0) {
            // 标签还没闭合：输出标签之前的内容，剩下的扣住
            emit += buf.slice(0, i);
            buf = buf.slice(i);
            break;
          }
          // 完整标签：收集内容并丢弃 [i, c+CLOSE.length)
          tags.push(buf.slice(i + OPEN.length, c));
          emit += buf.slice(0, i);
          buf = buf.slice(c + CLOSE.length);
          continue;
        }
        // 没有标签：但结尾可能是个不完整的标签开头，扣住它
        const keep = partialTagTail(buf, OPEN);
        emit += buf.slice(0, buf.length - keep);
        buf = buf.slice(buf.length - keep);
        break;
      }
      out += emit;
      return emit;
    },
    /** 流结束：把剩下的缓冲吐出来（未闭合的标签按噪声丢掉）。 */
    flush() {
      const rest = stripMemoryTags(buf);
      buf = "";
      out += rest;
      return rest;
    },
    /** 已输出的完整正文。 */
    get text() {
      return out;
    },
    /** 收集到的标签原始内容（不含标签本身）。 */
    get tags() {
      return tags;
    },
  };
}

/** buf 结尾有多长的一段是 OPEN 的前缀（要扣住的那部分）。 */
function partialTagTail(buf, OPEN) {
  const max = Math.min(buf.length, OPEN.length - 1);
  for (let n = max; n > 0; n -= 1) {
    if (buf.endsWith(OPEN.slice(0, n))) return n;
  }
  return 0;
}

/* ============================================================
   六、滚动摘要（解决上下文截断导致的前后矛盾）
   ============================================================ */

/** 每这么多轮生成一份摘要入库。 */
export const SUMMARY_EVERY = 12;

/** 取某个会话已有多少条有效消息（用于判断该不该做摘要）。 */
export function countTurns(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter((m) => m && m.content && m.role !== "system").length;
}

/**
 * 生成一份会话摘要并存档。
 *
 * 这条摘要会进入记忆库，在后续轮次被检索到，
 * 从而弥补「长对话早期信息已滑出上下文窗口」的问题。
 */
export function saveSummary(sessionId, title, text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const key = `会话摘要:${sessionId}`;
  return upsert("summary", key, `【${title || "会话"}】${t}`, 0.85);
}

/** 读取全部会话摘要。 */
export function listSummaries() {
  return listAll().filter((e) => e.type === "summary");
}

/* ============================================================
   统计（管理页用）
   ============================================================ */

export function stats() {
  const all = listAll();
  const byType = {};
  for (const e of all) byType[e.type] = (byType[e.type] || 0) + 1;
  return { total: all.length, byType, profile: profileKey() };
}
