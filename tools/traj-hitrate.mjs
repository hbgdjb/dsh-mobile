/* ============================================================
   中文检索命中率 —— 对照实验

   ============ 这个实验要回答什么 ============
   经验层的死结：15,274 条轨迹里中文指令 0 条，
   拿中文指令去检索，top1 相似度全是 0.000。

   但那**不能证明检索器坏了** —— 只能证明语料语言和查询语言不匹配。
   这一版改走路线 A（DSH 自己控屏时录），指令天然是中文，
   于是问题变成：**中文语料上，命中率到底能不能上去？**

   三组对照：
     A. 中文语料 + 中文查询   ← 实验组，路线 A 的真实场景
     B. 英文语料 + 英文查询   ← 检索器能力基线（应该很高）
     C. 英文语料 + 中文查询   ← 未污染对照（应该接近 0）

   C 的作用：如果 C 也很高，说明检索器在乱匹配，
   A 的高分就没有意义。B 与 C 一起给 A 定了标尺。

   用法：
     node tools/traj-hitrate.mjs                  # 用内置合成语料
     node tools/traj-hitrate.mjs <corpus.jsonl>   # 用真实导出的语料
   ============================================================ */

import { readFileSync, existsSync } from "node:fs";
import {
  bm25Search,
  buildBm25Index,
  bm25SearchWithIndex,
  tokenizeForFts,
  similarity,
} from "../scripts/traj.js";

/* ---------------- 合成中文语料 ---------------- */

/** 中文控屏任务的模板化改写，覆盖常见 App 与动作。 */
const CN_TEMPLATES = [
  ["打开{app}应用", "open_app"],
  ["在{app}里搜索{word}", "tap_by_text"],
  ["进入{app}的{page}页面", "tap_by_text"],
  ["给{who}发一条消息说{msg}", "type_text"],
  ["查看{app}的{page}列表", "tap_by_text"],
  ["把{app}里的{word}删掉", "tap_by_text"],
  ["在{app}设置里打开{page}", "tap_by_text"],
  ["退出{app}回到桌面", "home"],
  ["返回上一页", "back"],
  ["在{app}中查找附近的{word}", "tap_by_text"],
  ["把{word}分享到{app}", "tap_by_text"],
  ["打开{app}的日历看今天的安排", "tap_by_text"],
  ["在{app}里播放{word}", "tap_by_text"],
  ["下载{app}里的{word}文件", "tap_by_text"],
  ["在{app}中新建一个{page}", "tap_by_text"],
  ["确认提交{app}的{page}", "tap_by_text"],
  ["把{app}的通知关掉", "tap_by_text"],
  ["在{app}里刷新{page}", "tap_by_text"],
  ["查看{app}里{who}发来的消息", "tap_by_text"],
  ["打开{app}并进入设置", "tap_by_text"],
];

const APPS = ["微信", "支付宝", "淘宝", "抖音", "淘宝", "美团", "钉钉", "飞书", "知乎", "小红书", "哔哩哔哩", "京东", "拼多多", "携程", "高德地图"];
const PAGES = ["设置", "我的", "首页", "消息", "收藏", "历史记录", "隐私", "账号安全", "支付", "订单"];
const WORDS = ["天气", "电影票", "外卖", "快递", "优惠券", "附近", "攻略", "报价", "攻略", "评价"];
const WHO = ["张三", "李四", "王五", "同事群", "家人群", "朋友"];
const MSG = ["在开会", "文件发你了", "明天见", "收到"];

/** 伪随机（固定种子）—— 实验必须可复现。 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function synthChineseCorpus(n) {
  const rng = makeRng(20261021);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const out = [];
  const seen = new Set();
  let guard = 0;
  while (out.length < n && guard < n * 60) {
    guard += 1;
    const [tpl] = pick(CN_TEMPLATES);
    const text = tpl
      .replace("{app}", pick(APPS))
      .replace("{page}", pick(PAGES))
      .replace("{word}", pick(WORDS))
      .replace("{who}", pick(WHO))
      .replace("{msg}", pick(MSG));
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({
      traj_id: `cn_${out.length}`,
      instruction: text,
      app: "com.example",
      outcome: "success",
      confirm: "human",
      actions: [{ tool: "tap_by_text", args: { text: "确定" } }],
    });
  }
  return out;
}

/* ---------------- 英文语料（对照组 B / C） ---------------- */

const EN_TEMPLATES = [
  "Open the {app} app and view the {page} page",
  "Search for {word} in {app}",
  "Send a message to {who} saying {msg}",
  "Open {app} settings and turn on {page}",
  "Delete the {word} item from {app}",
  "Share the {word} to {app}",
  "Go back to the home screen",
  "Refresh the {page} list in {app}",
];

function synthEnglishCorpus(n) {
  const rng = makeRng(991133);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const apps = ["Zoho Meet", "Alibaba", "WhatsApp", "Spotify", "Amazon", "Google Maps", "Telegram", "Netflix"];
  const pages = ["scheduled meetings", "settings", "notifications", "profile", "orders"];
  const words = ["weather", "tickets", "coupons", "reviews", "nearby"];
  const who = ["the group chat", "my manager", "Alice", "the team"];
  const msg = ["meeting at 3", "file attached", "see you"];
  const out = [];
  const seen = new Set();
  let guard = 0;
  while (out.length < n && guard < n * 60) {
    guard += 1;
    const tpl = pick(EN_TEMPLATES);
    const text = tpl
      .replace("{app}", pick(apps))
      .replace("{page}", pick(pages))
      .replace("{word}", pick(words))
      .replace("{who}", pick(who))
      .replace("{msg}", pick(msg));
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({
      traj_id: `en_${out.length}`,
      instruction: text,
      app: "com.example",
      outcome: "success",
      confirm: "human",
      actions: [{ tool: "tap_by_text", args: { text: "OK" } }],
    });
  }
  return out;
}

/** 英文语料：优先用经验层里的真实语料，其次才用合成。 */
const EN_CORPUS_PATH = "/tmp/exp/手机控屏_经验层/data/sft_corpus.jsonl";

function loadEnglishCorpus(fallbackN) {
  if (existsSync(EN_CORPUS_PATH)) {
    try {
      const rows = readFileSync(EN_CORPUS_PATH, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      if (rows.length) {
        return {
          rows: rows.map((r) => ({
            traj_id: r.traj_id,
            instruction: r.instruction || "",
            app: "com.example",
            outcome: "success",
            confirm: "human",
            actions: r.actions || [],
          })),
          source: `经验层真实语料（${rows.length} 条）`,
        };
      }
    } catch (err) {
      console.error(`读不到经验层语料，改用合成：${err.message}`);
    }
  }
  const rows = synthEnglishCorpus(fallbackN);
  return { rows, source: `内置合成英文语料（${rows.length} 条）` };
}

/* ---------------- 评测 ---------------- */

/**
 * 对一组语料做「留一法」自检索：
 * 拿每条轨迹自己的指令当查询，看 top1 是不是它自己。
 *
 * 这是命中率的上界 —— 真实场景的查询是**新指令**，
 * 不会和历史指令逐字相同。所以这里同时报一个「改写查询」组：
 * 把指令做一点扰动（换同义词、去掉礼貌词），模拟真实的新说法。
 */
function evaluate(corpus, { rewrite = null, indexCorpus = null } = {}) {
  // 索引语料可以比查询样本大得多：
  // 15,274 条全量做留一法是 1.5 亿次打分，跑不动；
  // 但索引必须包含全量，否则测的不是「真实库里的表现」。
  const idx = buildBm25Index(
    (indexCorpus || corpus).map((c) => ({
      id: c.traj_id,
      instruction: c.instruction,
      screenText: "",
      app: c.app || "",
      outcome: c.outcome || "",
      confirm: c.confirm || "",
    }))
  );
  let top1 = 0;
  let top3 = 0;
  let sumSim = 0;
  const misses = [];
  for (const c of corpus) {
    const q = rewrite ? rewrite(c.instruction) : c.instruction;
    const hits = bm25SearchWithIndex(idx, q, { limit: 3, pool: 50, minSim: 0 });
    if (!hits.length) {
      misses.push({ q, note: "无召回" });
      continue;
    }
    sumSim += hits[0].sim;
    if (hits[0].id === c.traj_id) top1 += 1;
    else misses.push({ q, got: hits[0].instruction, sim: hits[0].sim });
    if (hits.slice(0, 3).some((h) => h.id === c.traj_id)) top3 += 1;
  }
  const n = corpus.length || 1;
  return {
    n: corpus.length,
    top1: top1 / n,
    top3: top3 / n,
    avgSim: sumSim / n,
    misses: misses.slice(0, 8),
  };
}

/** 中文改写：模拟「新说法」——去掉礼貌词、换等价说法。 */
const CN_REWRITE = [
  [/^请/, ""],
  [/帮我/g, "帮忙"],
  [/一下$/g, ""],
  [/^打开/g, "启动"],
  [/^在/g, "进入"],
  [/(打开|启动)/g, "开启"],
  [/里/g, "中"],
];

/** 英文改写：小幅变形。 */
const EN_REWRITE = [
  [/^Open/g, "Launch"],
  [/^Search for/g, "Look up"],
  [/^Send a message to/g, "Message"],
  [/\bapp\b/g, "application"],
];

function applyRewrite(text, rules) {
  let out = text;
  for (const [re, to] of rules) out = out.replace(re, to);
  return out;
}

/* ---------------- 主流程 ---------------- */

function readCorpusArg() {
  const p = process.argv[2];
  if (!p) return null;
  try {
    const raw = readFileSync(p, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    console.error(`读不到语料文件 ${p}：${err.message}`);
    process.exit(1);
  }
}

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function printRow(label, r) {
  console.log(
    `  ${label.padEnd(26, " ")} top1 ${fmtPct(r.top1).padStart(7)}   top3 ${fmtPct(r.top3).padStart(7)}   平均相似度 ${r.avgSim.toFixed(4)}`
  );
}

const custom = readCorpusArg();
const cn = custom || synthChineseCorpus(300);
const enPack = loadEnglishCorpus(cn.length);
const en = enPack.rows;

console.log("");
console.log("中文检索命中率对照实验");
console.log("=".repeat(78));
if (custom) {
  console.log(`语料来源：${process.argv[2]}（${cn.length} 条）`);
} else {
  console.log(`中文语料：内置合成 ${cn.length} 条 · 英文语料：${enPack.source}`);
}
console.log("");

console.log("A. 中文语料 + 中文查询（实验组 · 路线 A 的真实场景）");
const a1 = evaluate(cn);
const a2 = evaluate(cn, { rewrite: (t) => applyRewrite(t, CN_REWRITE) });
printRow("原指令查询", a1);
printRow("改写后查询（模拟新说法）", a2);
if (a2.misses.length) {
  console.log("    改写后未命中样例：");
  for (const m of a2.misses.slice(0, 4)) {
    console.log(`      「${m.q}」→ 召回了「${m.got || "—"}」（相似度 ${(m.sim || 0).toFixed(3)}）`);
  }
}

console.log("");
console.log("B. 英文语料 + 英文查询（检索器能力基线）");
const enSample = en.slice(0, 300);
const b1 = evaluate(enSample, { indexCorpus: en });
const b2 = evaluate(enSample, { indexCorpus: en, rewrite: (t) => applyRewrite(t, EN_REWRITE) });
printRow(`原指令查询（抽样 ${enSample.length} / 库 ${en.length}）`, b1);
printRow("改写后查询", b2);

console.log("");
console.log("C. 英文语料 + 中文查询（未污染对照 · 应当接近 0）");
const cIdx = buildBm25Index(
  en.map((c) => ({
    id: c.traj_id,
    instruction: c.instruction,
    screenText: "",
    app: c.app || "",
  }))
);
let cSum = 0;
let cTop1 = 0;
for (const c of cn) {
  const hits = bm25SearchWithIndex(cIdx, c.instruction, { limit: 1, pool: 50, minSim: 0 });
  if (hits.length) {
    cSum += hits[0].sim;
    if (hits[0].id === c.traj_id) cTop1 += 1;
  }
}
console.log(
  `  ${"中文查询打进英文库".padEnd(26, " ")} top1 ${fmtPct(cTop1 / (cn.length || 1)).padStart(7)}   平均相似度 ${(cSum / (cn.length || 1)).toFixed(4)}`
);

console.log("");
console.log("=".repeat(78));
const verdict = [];
if (a2.top1 >= 0.5) verdict.push(`中文改写查询 top1 ${fmtPct(a2.top1)} —— 机制成立，中文语料能被中文检索召回`);
else if (a2.top1 >= 0.2) verdict.push(`中文改写查询 top1 ${fmtPct(a2.top1)} —— 机制基本成立，但泛化一般，建议继续攒语料`);
else verdict.push(`中文改写查询 top1 ${fmtPct(a2.top1)} —— 偏低，需要排查（分词 / 阈值 / 语料多样性）`);
if (cSum / (cn.length || 1) < 0.05) verdict.push("对照 C 接近 0 —— 检索器没有在乱匹配，A 组的分数是真实的");
else verdict.push(`对照 C 的平均相似度 ${(cSum / (cn.length || 1)).toFixed(4)} 偏高 —— 检索器可能存在乱匹配，A 组结论需谨慎`);
console.log(`结论：${verdict.join("；")}。`);
console.log("");

// 分词抽样：让人能肉眼确认切字是否正常
console.log("分词抽样（中文）：");
for (const s of ["打开微信搜一下天气", "在支付宝里查看账单", "给同事发消息说在开会"]) {
  console.log(`  「${s}」→ ${tokenizeForFts(s)}`);
}
console.log("");
console.log(`bigram 相似度抽样：「打开微信」vs「打开微信」= ${similarity("打开微信", "打开微信").toFixed(3)}，` +
  `「打开微信」vs「打开微博」= ${similarity("打开微信", "打开微博").toFixed(3)}`);
console.log("");
