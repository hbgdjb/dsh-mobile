/* ============================================================
   Traj — 中文控屏轨迹层（0.34.0）

   移植自「手机控屏经验层」（Python + SQLite），但**换了采集路线**：
   经验层靠外部采集器喂数据，语料是英文的；这一版改成
   **DSH 自己控屏时顺手录**（路线 A），指令天然是中文。

   为什么路线 A 能绕开经验层的死结：
     经验层 15,274 条轨迹里中文指令 0 条，检索器本身没问题
     （英文自检索 top1 均值 0.636，与官方 0.628 一致），
     问题是**语料语言和查询语言不匹配**。
     路线 A 的指令来自用户嘴里的中文，语料与查询同语言 ——
     这个错配从根上消失，不需要再靠分词技巧硬凑。

   ==================== 与原 Python 版的差异 ====================
   1. 载体：SQLite → localStorage 索引 + fs「traj」区域存全文。
      前端没有 SQLite，而 FTS5 全文索引也不存在，
      所以 BM25 改成**内存倒排索引**（语料量级几千条，够用）。
   2. 采集：不新增采集设施 —— 工具调用结果本来就在会话历史里，
      这一层只是把已有的数据**结构化落库**。
   3. 存储位置：APK 落在手机真实目录（可导出成语料文件），
      浏览器落在 IndexedDB。

   ==================== 三条硬约束 ====================
   A. 落库前脱敏：手机号 / 验证码 / 卡号 / 邮箱，一个都不能留。
   B. 只有「用户事后确认成功」的轨迹才有资格晋升为技能。
      这一层不给模型自己说「我做对了」的机会 —— 那是幻觉的温床。
   C. 检索结果只用于**注入 few-shot 示例**，不替代模型判断；
      且含裸坐标动作（ui_tap）的轨迹**整条排除**，
      因为拿坐标示例当范例，等于直接教模型输出坐标。
   ============================================================ */

import { state } from "./store.js";
import { mcpCall } from "./mcp.js";

/* ============================================================
   一、脱敏（移植 safety.py）
   ============================================================ */

const RE_PHONE = /(?<!\d)(1[3-9]\d{9})(?!\d)/g;
const RE_CARD = /(?<!\d)(\d{16,19})(?!\d)/g;
const RE_OTP = /^(?<!\d)(\d{4,8})(?!\d)$/;
const RE_EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** 会被脱敏的动作参数键（与 Python 版一致）。 */
const REDACT_ARG_KEYS = new Set(["text", "value", "input", "content"]);

/**
 * 脱敏：手机号 / 卡号 / 疑似验证码 / 邮箱。
 *
 * 顺序有讲究：先判「整串 4~8 位数字」（验证码），
 * 再处理卡号（16~19 位），最后手机号（11 位）、邮箱。
 * 卡号必须排在手机号前面 —— 16 位以上的数字串里
 * 恰好包含 11 位子串，先做手机号会把卡号打残。
 */
export function redact(text) {
  if (!text) return text;
  const s = String(text);
  const stripped = s.trim();
  // 整串 4~8 位数字 → 按验证码处理
  if (RE_OTP.test(stripped)) return "*".repeat(stripped.length);
  let out = s;
  out = out.replace(RE_CARD, (m) => m.slice(0, 4) + "*".repeat(m.length - 8) + m.slice(-4));
  out = out.replace(RE_PHONE, (m) => m.slice(0, 3) + "****" + m.slice(-4));
  out = out.replace(RE_EMAIL, (m, head, tail) => head + "***" + tail);
  return out;
}

/**
 * 动作参数脱敏。
 *
 * 只脱敏「会承载用户私人内容」的键 —— text/value/input/content。
 * 其他键（x/y/ref/match）保持原样：坐标和 ref 是回放必需的，
 * 把 ref 也抹了，轨迹就只剩一句没有动作的话。
 */
export function redactArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === "string" && REDACT_ARG_KEYS.has(k)) out[k] = redact(v);
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = redactArgs(v);
    else out[k] = v;
  }
  return out;
}

/** 递归脱敏任意结构（用于屏幕元素集合）。 */
export function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_ARG_KEYS.has(k) && typeof v === "string" ? redact(v) : redactDeep(v);
    }
    return out;
  }
  return value;
}

/* ============================================================
   二、M2 签名引擎（移植 signature.py）
   ============================================================ */

export const SIG_LEN = 16;
export const SIG_THRESHOLD = 0.85;

const RE_WS = /\s+/g;

/**
 * 归一化文本：NFKC + 小写 + 压空白 + 去首尾纯符号。
 *
 * 去符号的集合在原版基础上补了中文书名号与直角引号 ——
 * 中文界面里「」『』出现在标题里的频率很高，
 * 不剥掉的话「设置」和「『设置』」会算成两个不同的屏幕标签。
 */
const STRIP_CHARS = " \t\n\r·•-—_,，。:：|/\\<>[]()（）【】「」『』《》\"'“”";

// 字符类里 `-` 会构成"范围"，`]` `\` 等也会破坏正则 —— 逐字符转义后再拼。
const STRIP_CLASS = STRIP_CHARS.split("")
  .map((c) => c.replace(/[\\\]\^-]/g, "\\$&"))
  .join("");
const RE_STRIP_LEAD = new RegExp(`^[${STRIP_CLASS}]+`);
const RE_STRIP_TAIL = new RegExp(`[${STRIP_CLASS}]+$`);

export function normText(s) {
  if (!s) return "";
  let out = String(s).normalize("NFKC").toLowerCase();
  out = out.replace(RE_WS, " ").trim();
  return out.replace(RE_STRIP_LEAD, "").replace(RE_STRIP_TAIL, "");
}

/**
 * 元素标签链：**文字 → 描述 → #资源 id**。
 *
 * 与 DSH 自己的 ref 体系（0.33.0）完全一致 ——
 * 签名和 ref 用同一套标签，签名匹配到的屏幕，
 * ref 才真的能在上面定位到。
 */
export function labelOf(el) {
  const t = normText(el.text);
  if (t) return t;
  const d = normText(el.desc);
  if (d) return d;
  const rid = normText(el.resourceId || el.resource_id || "");
  return rid ? `#${rid}` : "";
}

/**
 * 可交互元素的 (type, 标签) 集合。
 *
 * 空标签元素（大量纯容器 View）会把签名稀释成「一堆 View|」，
 * 既没有判别力又让 Jaccard 虚高 —— 所以直接丢掉。
 */
export function pairsOf(elements) {
  const set = new Set();
  for (const el of elements || []) {
    if (!(el.clickable || el.editable || el.text || el.resourceId || el.resource_id)) continue;
    const lab = labelOf(el);
    if (!lab) continue;
    set.add(`${el.type || "View"}|${lab}`);
  }
  return set;
}

/** 签名 = hash(app + "|" + sorted(pairs))，取前 16 位。 */
export function computeSignature(pairs, app) {
  const payload = String(app || "").toLowerCase() + "|" + [...pairs].sort().join("|");
  // 同步 SHA-1：不能用 crypto.subtle（异步，且非安全上下文不可用）。
  return sha1(payload).slice(0, SIG_LEN);
}

/** 集合 Jaccard 相似度。 */
export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a || []);
  const B = b instanceof Set ? b : new Set(b || []);
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * 同步 SHA-1（返回 40 位十六进制小写）。
 *
 * 不能用 crypto.subtle —— 那是异步的，且在非安全上下文（http 页面）里根本不存在。
 *
 * 实现要点（这三点写错任何一处都会得到"看起来像 SHA-1 但就是不对"的结果）：
 *   1. 消息调度是 W[t] = ROTL1(W[t-3] ^ W[t-8] ^ W[t-14] ^ W[t-16])，最后一项是 t-16；
 *   2. 每处理完一个 64 字节分块，工作变量 a..e 必须**累加**回 h0..h4（h += a）；
 *   3. 所有中间量都要用 >>> 0 归一化成无符号 32 位，否则 JS 的 int32 符号位会污染结果。
 */
export function sha1(msg) {
  const text = String(msg == null ? "" : msg);
  // UTF-8 字节（不能用 text.length，那是 UTF-16 长度）
  const utf8 = unescape(encodeURIComponent(text));
  const len = utf8.length;

  // 填充：末尾 0x80，再补 8 字节比特长度（大端 64 位）
  const byteLen = (Math.floor((len + 8) / 64) + 1) * 64;
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < len; i += 1) bytes[i] = utf8.charCodeAt(i) & 0xff;
  bytes[len] = 0x80;
  const bitLen = len * 8;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes[byteLen - 8] = (hi >>> 24) & 0xff;
  bytes[byteLen - 7] = (hi >>> 16) & 0xff;
  bytes[byteLen - 6] = (hi >>> 8) & 0xff;
  bytes[byteLen - 5] = hi & 0xff;
  bytes[byteLen - 4] = (lo >>> 24) & 0xff;
  bytes[byteLen - 3] = (lo >>> 16) & 0xff;
  bytes[byteLen - 2] = (lo >>> 8) & 0xff;
  bytes[byteLen - 1] = lo & 0xff;

  const w = new Uint32Array(80);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  for (let off = 0; off < byteLen; off += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = off + i * 4;
      w[i] =
        ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    // 消息调度：W[t] = ROTL1(W[t-3] ^ W[t-8] ^ W[t-14] ^ W[t-16])
    for (let i = 16; i < 80; i += 1) {
      const n = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) >>> 0;
      w[i] = ((n << 1) | (n >>> 31)) >>> 0;
    }

    // 工作变量
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) {
        f = ((b & c) | (~b & d)) >>> 0;
        k = 0x5a827999;
      } else if (i < 40) {
        f = (b ^ c ^ d) >>> 0;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = ((b & c) | (b & d) | (c & d)) >>> 0;
        k = 0x8f1bbcdc;
      } else {
        f = (b ^ c ^ d) >>> 0;
        k = 0xca62c1d6;
      }
      const tmp = ((((a << 5) | (a >>> 27)) >>> 0) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = tmp;
    }

    // 关键：工作变量必须累加回 h0..h4
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/* ============================================================
   三、检索：BM25 + CJK bigram 二次过滤（移植 retrieval.py）
   ============================================================ */

const RE_WORD = /[a-zA-Z0-9_]+/g;
const RE_CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/;

/**
 * 检索用分词：CJK 逐字切开，拉丁词保持整词。
 *
 * 不切字的话，一整串汉字会被当成**一个** token，
 * 「打开微信」和「打开微博」在索引里毫无交集 —— 中文检索直接失效。
 */
export function tokenizeForFts(text) {
  if (!text) return "";
  const s = String(text).toLowerCase();
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (RE_CJK.test(ch)) {
      out.push(ch);
      i += 1;
    } else if (/[a-z0-9_]/.test(ch)) {
      RE_WORD.lastIndex = i;
      const m = RE_WORD.exec(s);
      if (m && m.index === i) {
        out.push(m[0]);
        i = m.index + m[0].length;
      } else i += 1;
    } else i += 1;
  }
  return out.join(" ");
}

/** 字符 bigram（中文）+ 词（英文），用于二次相似度过滤。 */
export function ngrams(text, n = 2) {
  const t = String(text || "").toLowerCase();
  const grams = new Set();
  const cjk = t.match(new RegExp(RE_CJK, "g")) || [];
  if (cjk.length >= n) {
    for (let i = 0; i <= cjk.length - n; i += 1) grams.add(cjk.slice(i, i + n).join(""));
  } else if (cjk.length) {
    for (const c of cjk) grams.add(c);
  }
  for (const w of t.match(RE_WORD) || []) grams.add(w);
  return grams;
}

/** 两段文本的 bigram Jaccard 相似度。 */
export function similarity(a, b) {
  const ga = ngrams(a);
  const gb = ngrams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}

/**
 * 构建 BM25 倒排索引。
 *
 * 单独暴露出来，是因为**同一份语料要反复查**时不该每次重建：
 * 离线评测里「15,274 条英文语料 × 300 次中文查询」，
 * 每次重建索引就是 450 万次分词 —— 慢到没法用。
 */
export function buildBm25Index(corpus) {
  const docs = (corpus || []).filter((d) => d && d.instruction);
  const df = new Map();
  const docTokens = [];
  const docLen = [];
  const index = new Map();
  docs.forEach((d, i) => {
    const text = `${d.instruction || ""} ${d.screenText || ""}`;
    const tokens = tokenizeForFts(text).split(" ").filter(Boolean);
    const counts = new Map();
    for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
    docTokens.push(counts);
    docLen.push(tokens.length);
    for (const t of counts.keys()) {
      if (!df.has(t)) df.set(t, []);
      df.get(t).push(i);
    }
  });
  for (const [t, list] of df) index.set(t, list);
  const avgdl = docLen.reduce((a, b) => a + b, 0) / (docLen.length || 1);
  return { docs, docTokens, docLen, index, avgdl, N: docs.length };
}

/**
 * 用已建好的索引检索。
 * @see buildBm25Index
 */
export function bm25SearchWithIndex(idx, query, opts = {}) {
  const limit = opts.limit ?? 2;
  const pool = opts.pool ?? 30;
  const minSim = opts.minSim ?? 0.15;
  if (!idx || !idx.N) return [];
  const qTokens = tokenizeForFts(query).split(" ").filter(Boolean);
  if (!qTokens.length) return [];

  const { docs, docTokens, docLen, index, avgdl, N } = idx;
  const k1 = 1.2;
  const b = 0.75;
  const scores = new Map();
  for (const token of new Set(qTokens.slice(0, 40))) {
    const hits = index.get(token);
    if (!hits || !hits.length) continue;
    const idf = Math.log(1 + (N - hits.length + 0.5) / (hits.length + 0.5));
    for (const i of hits) {
      const f = docTokens[i].get(token) || 0;
      const denom = f + k1 * (1 - b + (b * docLen[i]) / (avgdl || 1));
      const add = idf * ((f * (k1 + 1)) / (denom || 1));
      scores.set(i, (scores.get(i) || 0) + add);
    }
  }

  let rows = [...scores.entries()].map(([i, score]) => ({ i, score, doc: docs[i] }));
  if (opts.app) {
    const app = String(opts.app).toLowerCase();
    rows = rows.filter((r) => String(r.doc.app || "").toLowerCase() === app);
  }
  rows.sort((a, b2) => b2.score - a.score);
  rows = rows.slice(0, pool);

  const out = [];
  for (const r of rows) {
    const sim = similarity(query, r.doc.instruction || "");
    if (sim < minSim) continue;
    out.push({
      id: r.doc.id,
      app: r.doc.app || "",
      instruction: r.doc.instruction || "",
      sim: round4(sim),
      bm25: round4(r.score),
      outcome: r.doc.outcome || "",
      confirm: r.doc.confirm || "",
    });
  }
  out.sort((a, b2) => b2.sim - a.sim || b2.bm25 - a.bm25);
  return out.slice(0, limit);
}

/**
 * BM25 检索。
 *
 * 为什么不用 FTS5：前端没有 SQLite，WASM 装一个 SQLite 换来的
 * 只是一个全文索引 —— 不值。而语料量级是「几千条」，
 * 内存倒排索引每次查询重算也只要几毫秒。
 *
 * idf 用 Lucene 变体 log(1 + (N - n + 0.5)/(n + 0.5))：
 * 恒为正，不会像 FTS5 那样在高频词上出现负 idf 把相关文档踢下去。
 *
 * @param {Array<{id:string, instruction:string, screenText?:string, app?:string}>} corpus
 * @param {string} query
 * @param {{limit?:number, pool?:number, minSim?:number, app?:string}} opts
 */
export function bm25Search(corpus, query, opts = {}) {
  return bm25SearchWithIndex(buildBm25Index(corpus), query, opts);
}

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/* ============================================================
   四、屏幕摘要（移植 screen_digest）
   ============================================================ */

/** 压缩的屏幕摘要：可交互元素文本清单，供检索与提示词注入。 */
export function screenDigest(elements, limit = 60) {
  const parts = [];
  for (const el of (elements || []).slice(0, limit)) {
    parts.push(el.text ? `[${el.type}] ${el.text}` : `[${el.type}]`);
  }
  return parts.join(" ; ");
}

/* ============================================================
   五、dump 解析：从工具输出还原屏幕元素
   ============================================================ */

/**
 * 解析 ui_dump 的 **文本格式**。
 *
 * ============ 为什么文本格式够用（这是 P1 零 Java 改动的关键）============
 *
 * 文本格式每行是：
 *   #12 Button "登录" desc="登录按钮" [0,0][100,50] 中心(50,25) 可点
 *
 * 而 DSH 的标签链是「文字 → 描述 → #资源 id」。
 * renderText 只在「文字与描述都为空」时才补一行 id="..." ——
 * 也就是说：**标签链落到 #资源 id 的那些元素，恰好是文本格式里唯一会输出 id 的元素**。
 *
 * 所以文本格式**不丢任何标签信息**，JS 侧可以完整还原元素集合、
 * 算出与 JSON 格式一致的签名 —— 不必为了采集再读一次屏。
 */
export function parseDumpText(output) {
  const text = String(output || "");
  const app = (text.match(/^前台应用：(.+)$/m) || [])[1] || "";
  const lines = text.split(/\r?\n/);
  const elements = [];
  for (const line of lines) {
    const m = /^#(\d+)\s+(\S+)(.*)$/.exec(line.trim());
    if (!m) continue;
    const el = {
      type: m[2],
      text: "",
      desc: "",
      resourceId: "",
      clickable: false,
      editable: false,
    };
    let rest = (m[3] || "").trim();
    if (rest.startsWith('"')) {
      const tm = /^"([^"]*)"/.exec(rest);
      if (tm) {
        el.text = tm[1];
        rest = rest.slice(tm[0].length);
      }
    }
    const dm = /desc="([^"]*)"/.exec(rest);
    if (dm) el.desc = dm[1];
    const im = /\bid="([^"]*)"/.exec(rest);
    if (im) el.resourceId = im[1];
    el.clickable = /\s可点(\s|$)/.test(rest);
    el.editable = /\s可输入(\s|$)/.test(rest);
    elements.push(el);
  }
  return { app: app.trim(), elements };
}

/** 从一段输出里截出第一个完整 JSON 对象（跳过 JSON 字符串里的括号）。 */
function sliceJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return "";
}

/** 解析 ui_dump 的 **JSON 格式**（format=json）。 */
export function parseDumpJson(output) {
  const raw = sliceJsonObject(output);
  if (!raw) return { app: "", elements: [] };
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { app: "", elements: [] };
  }
  const elements = (obj.elements || []).map((e) => ({
    type: e.type || "View",
    text: e.text || "",
    desc: e.desc || "",
    resourceId: e.resource_id || "",
    clickable: !!e.clickable,
    editable: !!e.editable,
  }));
  return { app: obj.app || "", elements };
}

/** 自动判断格式并解析。 */
export function parseDump(output) {
  const s = String(output || "");
  if (s.trim().startsWith("{")) return parseDumpJson(s);
  const t = parseDumpText(s);
  if (t.elements.length) return t;
  return parseDumpJson(s);
}

/* ============================================================
   六、动作映射：DSH 的 ui_* 工具 → 经验层的动作词汇
   ============================================================ */

/**
 * 可回放的动作词汇（与经验层 Agent对接契约一致）。
 *
 * 只有落在这个集合里的动作才能被回放。
 * ui_tap 是**裸坐标** —— 它不在集合里，轨迹含它就整条不可回放。
 */
export const REPLAYABLE_TOOLS = new Set([
  "tap_by_text",
  "tap_by_ref",
  "long_press_by_text",
  "scroll",
  "wait",
  "wait_for",
  "back",
  "home",
  "open_app",
  "type_text",
]);

/**
 * 把一次 ui_* 工具调用翻译成经验层的动作。
 *
 * @returns {{tool:string, args:object, replayable:boolean}|null}
 */
export function mapAction(uiTool, args) {
  const a = args || {};
  switch (uiTool) {
    case "ui_tap_ref":
      return { tool: "tap_by_ref", args: { ref: String(a.ref || "") }, replayable: true };
    case "ui_click_text":
      return { tool: "tap_by_text", args: { text: String(a.match || "") }, replayable: true };
    case "ui_set_text":
      return { tool: "type_text", args: { text: String(a.text || "") }, replayable: true };
    case "ui_swipe":
      return {
        tool: "scroll",
        args: { x1: num(a.x1), y1: num(a.y1), x2: num(a.x2), y2: num(a.y2), ms: num(a.ms) },
        replayable: true,
      };
    case "ui_global": {
      const act = String(a.action || "");
      if (act === "back") return { tool: "back", args: {}, replayable: true };
      if (act === "home") return { tool: "home", args: {}, replayable: true };
      // enter / delete / space / recents / notifications / lock 在经验层
      // 没有对应回放工具 —— 如实标为不可回放，而不是硬凑一个近似的
      return { tool: `global_${act || "unknown"}`, args: { action: act }, replayable: false };
    }
    case "ui_tap":
      // 裸坐标：记下来但不可回放
      return { tool: "tap_xy", args: { x: num(a.x), y: num(a.y) }, replayable: false };
    case "app_launch":
      return { tool: "open_app", args: { target: String(a.target || a.package || "") }, replayable: true };
    default:
      return null;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ============================================================
   七、存储层
   ============================================================ */

const LS_INDEX = "dsh.mobile.traj.index.v1";
const LS_APPCACHE = "dsh.mobile.traj.appcache.v1";

export const TRAJ_AREA = "traj";

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
    console.warn("轨迹索引持久化失败：", err);
    return false;
  }
}

/** 索引里的一条（精简，检索只需要这些）。 */
function indexEntry(rec) {
  return {
    id: rec.id,
    ts: rec.startedAt,
    instruction: rec.instruction,
    app: rec.app,
    appVersion: rec.appVersion,
    outcome: rec.outcome,
    confirm: rec.confirm,
    steps: rec.steps.length,
    screens: rec.screens.length,
    replayable: rec.replayable,
    digest: rec.digest,
  };
}

/** 读取全部索引条目。 */
export function listIndex() {
  const list = readJson(LS_INDEX, []);
  return Array.isArray(list) ? list : [];
}

/** 索引条目 → 检索语料。 */
function toCorpus(entries) {
  return entries.map((e) => ({
    id: e.id,
    instruction: e.instruction || "",
    screenText: e.digest || "",
    app: e.app || "",
    outcome: e.outcome || "",
    confirm: e.confirm || "",
    replayable: e.replayable !== false,
  }));
}

/** 写入索引（覆盖同 id）。 */
function putIndex(entry) {
  const list = listIndex().filter((e) => e.id !== entry.id);
  list.push(entry);
  list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  writeJson(LS_INDEX, list);
  return entry;
}

/** 读一条完整轨迹（从 fs「traj」区域）。 */
export async function readTrajectory(id) {
  try {
    const { readDoc } = await import("./fs.js");
    const doc = await readDoc(TRAJ_AREA, `${id}.json`);
    return JSON.parse(doc.content);
  } catch {
    return null;
  }
}

/** 列出完整轨迹的 id（fs 区域）。 */
export async function listTrajectoryFiles() {
  try {
    const { listDocs } = await import("./fs.js");
    const docs = await listDocs(TRAJ_AREA);
    return (docs || []).map((d) => String(d.path || "").replace(/\.json$/, "")).filter(Boolean);
  } catch {
    return [];
  }
}

/** 删除一条轨迹（索引 + 全文）。 */
export async function removeTrajectory(id) {
  writeJson(
    LS_INDEX,
    listIndex().filter((e) => e.id !== id)
  );
  try {
    const { deleteDoc } = await import("./fs.js");
    await deleteDoc(TRAJ_AREA, `${id}.json`);
  } catch {
    /* 文件删不掉不算失败：索引已经没了 */
  }
}

/** 清空全部轨迹。 */
export async function clearTrajectories() {
  writeJson(LS_INDEX, []);
  try {
    const { clearArea } = await import("./fs.js");
    await clearArea(TRAJ_AREA);
  } catch {
    /* 忽略 */
  }
}

/* ============================================================
   八、app_version 缓存
   ============================================================ */

/**
 * 取应用的版本号（经验层强制要求 app_version：版本不符的技能只进检索、不回放）。
 *
 * 走一次 app_info MCP 调用，**按包名缓存** ——
 * 同���个 App 的版本在一条轨迹里不会变，没必要反复问。
 */
export async function appVersion(pkg) {
  if (!pkg) return "";
  const cache = readJson(LS_APPCACHE, {});
  if (cache[pkg]) return cache[pkg];
  try {
    const server = findLocalServer();
    if (!server) return "";
    const res = await mcpCall(server, "app_info", { target: pkg });
    const text = String(res?.text || "");
    const vm = /^版本\s+(.+)$/m.exec(text);
    if (!vm) return "";
    const version = vm[1].trim();
    cache[pkg] = version;
    writeJson(LS_APPCACHE, cache);
    return version;
  } catch {
    return "";
  }
}

function findLocalServer() {
  const list = state.settings?.mcpServers || [];
  for (const s of list) {
    if (!s.enabled) continue;
    if (String(s.url || "").includes("127.0.0.1") || String(s.url || "").includes("localhost")) return s;
  }
  return null;
}

/* ============================================================
   九、采集：运行期记录
   ============================================================ */

/** 当前正在采集的轨迹（一次 run 一条）。 */
let current = null;

/** 是否开启采集。 */
export function trajEnabled() {
  return state.settings?.trajEnabled !== false;
}

/**
 * 开始一条轨迹。
 * @param {string} instruction 用户这一轮说的话
 */
export function beginTrajectory(instruction) {
  if (!trajEnabled()) {
    current = null;
    return null;
  }
  current = {
    id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    instruction: redact(String(instruction || "").slice(0, 500)),
    startedAt: Date.now(),
    endedAt: 0,
    app: "",
    appVersion: "",
    screens: [],
    steps: [],
    digest: "",
    outcome: "",
    confirm: "",
    replayable: true,
  };
  return current;
}

/**
 * 采集一次工具调用。
 *
 * @param {string} toolName 完整工具名（mcp__<server>__ui_dump）
 * @param {object} args 参数
 * @param {{ok?:boolean, output?:string, ms?:number}} res 结果
 */
export function captureTool(toolName, args, res) {
  if (!current) return;
  const m = /^mcp__.*__([a-z_]+)$/.exec(String(toolName || ""));
  if (!m) return;
  const tool = m[1];
  const ok = res?.ok !== false;
  const output = String(res?.output || "");

  if (tool === "ui_dump") {
    const parsed = parseDump(output);
    if (!parsed.elements.length) return;
    const elements = redactDeep(parsed.elements);
    const pairs = pairsOf(elements);
    const screen = {
      id: `s_${current.screens.length + 1}`,
      ts: Date.now(),
      app: parsed.app || current.app,
      signature: computeSignature(pairs, parsed.app || current.app),
      pairs: [...pairs],
      elements,
      digest: screenDigest(elements),
    };
    current.screens.push(screen);
    if (screen.app) current.app = screen.app;
    // 上一个动作的「下一个屏幕」= 这次 dump 到的屏幕
    const prev = current.steps[current.steps.length - 1];
    if (prev && !prev.nextScreenId) prev.nextScreenId = screen.id;
    return;
  }

  const action = mapAction(tool, args);
  if (!action) return;
  const screen = current.screens[current.screens.length - 1];
  current.steps.push({
    seq: current.steps.length + 1,
    screenId: screen?.id || "",
    nextScreenId: "",
    action: { tool: action.tool, args: redactArgs(action.args) },
    replayable: action.replayable,
    ok,
    latencyMs: Number(res?.ms || 0),
    ts: Date.now(),
  });
  if (!action.replayable) current.replayable = false;
}

/**
 * 结束并落库。
 *
 * 只有「有实际控屏动作」的轨迹才入库 ——
 * 光读屏没动作的轨迹没有回放价值，只会稀释检索。
 */
export async function endTrajectory() {
  const rec = current;
  current = null;
  if (!rec) return null;
  if (!rec.steps.length) return null;

  rec.endedAt = Date.now();
  rec.digest = rec.screens
    .slice(0, 6)
    .map((s) => s.digest)
    .join(" ")
    .slice(0, 1200);

  try {
    rec.appVersion = await appVersion(rec.app);
  } catch {
    rec.appVersion = "";
  }

  const full = JSON.parse(JSON.stringify(rec));
  putIndex(indexEntry(full));
  try {
    const { writeDoc } = await import("./fs.js");
    await writeDoc(TRAJ_AREA, `${full.id}.json`, JSON.stringify(full));
  } catch (err) {
    console.warn("轨迹全文落盘失败：", err);
  }
  return full;
}

/** 放弃当前轨迹（运行出错时调用）。 */
export function abortTrajectory() {
  current = null;
}

/* ============================================================
   十、确认状态机
   ============================================================ */

/**
 * 标记轨迹结果。
 *
 * 只有 confirm === "human" 的轨迹才有资格晋升为技能 ——
 * 模型自己说「我做对了」不算数。
 */
export async function setOutcome(id, outcome) {
  const ok = outcome === "success" || outcome === "fail";
  const list = listIndex();
  const entry = list.find((e) => e.id === id);
  if (!entry) return false;
  entry.outcome = ok ? outcome : "";
  entry.confirm = ok ? "human" : "";
  writeJson(LS_INDEX, list);

  // 同步更新全文（如果还在）
  const full = await readTrajectory(id);
  if (full) {
    full.outcome = entry.outcome;
    full.confirm = entry.confirm;
    try {
      const { writeDoc } = await import("./fs.js");
      await writeDoc(TRAJ_AREA, `${full.id}.json`, JSON.stringify(full));
    } catch {
      /* 索引已经更新了，全文更新失败不阻塞 */
    }
  }
  return true;
}

/** 统计：给「轨迹库」页用。 */
export function trajStats() {
  const list = listIndex();
  const success = list.filter((e) => e.outcome === "success" && e.confirm === "human").length;
  const fail = list.filter((e) => e.outcome === "fail").length;
  const pending = list.filter((e) => !e.outcome).length;
  const steps = list.reduce((a, e) => a + (e.steps || 0), 0);
  return { total: list.length, success, fail, pending, steps };
}

/**
 * 检索相似轨迹。
 *
 * 只返回「已确认成功」的（与经验层一致）：
 * 拿一条失败轨迹当范例，等于教模型重复失败。
 * 含裸坐标动作的轨迹整条排除 —— 坐标示例会直接教模型输出坐标。
 */
export function searchTrajectories(instruction, opts = {}) {
  const list = listIndex();
  const corpus = toCorpus(
    list.filter((e) => e.outcome === "success" && e.confirm === "human" && e.replayable !== false)
  );
  return bm25Search(corpus, instruction, { limit: opts.limit ?? 5, pool: opts.pool ?? 30 });
}

/** 导出语料（JSONL），供离线评测。 */
export async function exportCorpus() {
  const list = listIndex();
  const lines = [];
  for (const e of list) {
    const full = await readTrajectory(e.id);
    if (!full) continue;
    lines.push(
      JSON.stringify({
        traj_id: full.id,
        instruction: full.instruction,
        app: full.app,
        app_version: full.appVersion,
        outcome: full.outcome,
        confirm: full.confirm,
        actions: (full.steps || []).map((s) => ({ tool: s.action.tool, args: s.action.args })),
      })
    );
  }
  return lines.join("\n");
}
