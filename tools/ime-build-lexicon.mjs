#!/usr/bin/env node
/* ============================================================
   拼音词库构建（一次性，产物入库）

   ============ 为什么是离线构建 ============
   
   手机输入法最怕两件事：冷启动慢、打字时卡顿。两件事都跟
   "在运行时把几万条数据变成 JS 对象"有关：
   
     3 万条 JSON.parse → 150-300ms + 8-15MB 堆
   
   所以词库在构建期就压成二进制，运行时只解析 64 字节的头，
   查询靠二分。加载一次约 1.1MB，堆占用 1.2MB。

   ============ 数据来源（全部 MIT） ============
   
     pinyin-data/pinyin.txt          单字多读音（U+4F60: nǐ # 你）
     phrase-pinyin-data/pinyin.txt   词级拼音（银行: yín háng）
     jieba/dict.txt                  词频（词 频次 词性）

   用法：
     node tools/ime-build-lexicon.mjs [--max-words 30000]
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "lexicon-src");
const OUT = path.join(HERE, "..", "ime", "lexicon.bin");

const argMax = process.argv.indexOf("--max-words");
const MAX_WORDS = argMax > 0 ? Number(process.argv[argMax + 1]) || 30000 : 30000;

/* ---------------- 带调拼音 → 无声调 ---------------- */

/**
 * 逐字符映射，而不是 NFD 分解。
 *
 * 原因：NFD 会把 lǜ 拆成 l + u + ̈ + ̀ ，去掉组合符之后变成 "lu" ——
 * 而用户输入 ü 用的是 v 键，键必须是 "lv"。逐个字符映射才能把
 * ü 家族正确落到 v 上。
 */
const TONE = {
  ā: "a", á: "a", ǎ: "a", à: "a",
  ē: "e", é: "e", ě: "e", è: "e",
  ī: "i", í: "i", ǐ: "i", ì: "i",
  ō: "o", ó: "o", ǒ: "o", ò: "o",
  ū: "u", ú: "u", ǔ: "u", ù: "u",
  ǖ: "v", ǘ: "v", ǚ: "v", ǜ: "v", ü: "v",
  ń: "n", ň: "n", ǹ: "n",
  ḿ: "m", ẁ: "w", ẃ: "w", ẅ: "w", ỳ: "y", ý: "y", ỷ: "y", ỹ: "y",
  ê: "e",
};

/** "yín háng" → ["yin","hang"] */
function toSyllables(pinyin) {
  const out = [];
  for (const raw of String(pinyin).trim().split(/\s+/)) {
    let s = "";
    for (const ch of raw) {
      const low = ch.toLowerCase();
      if (TONE[low] !== undefined) s += TONE[low];
      else if (low >= "a" && low <= "z") s += low;
      // 其余（撇号、声调数字等）直接丢弃
    }
    if (s) out.push(s);
  }
  return out;
}

/* ---------------- 读三个源 ---------------- */

function readLines(file) {
  return fs.readFileSync(file, "utf8").split("\n");
}

/** 单字 → 全部读音。char.txt: `U+4F60: nǐ  # 你` */
function loadChars() {
  const map = new Map(); // 字 → Set<音节>
  for (const line of readLines(path.join(SRC, "char.txt"))) {
    if (!line || line.startsWith("#")) continue;
    const m = /^U\+([0-9A-Fa-f]+):\s*([^#]+)(?:#\s*(.*))?$/.exec(line.trim());
    if (!m) continue;
    const ch = String.fromCodePoint(parseInt(m[1], 16));
    if (ch.length !== 1) continue;
    const pys = m[2].split(",").map((x) => toSyllables(x)[0]).filter(Boolean);
    if (!pys.length) continue;
    if (!map.has(ch)) map.set(ch, new Set());
    pys.forEach((p) => map.get(ch).add(p));
  }
  return map;
}

/** 词 → 音节数组。phrase.txt: `银行: yín háng` */
function loadPhrases() {
  const map = new Map();
  for (const line of readLines(path.join(SRC, "phrase.txt"))) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const word = line.slice(0, i).trim();
    const pinyin = line.slice(i + 1).trim();
    if (!word || !pinyin) continue;
    const syl = toSyllables(pinyin);
    if (syl.length !== word.length) continue; // 音节数必须等于字数
    map.set(word, syl);
  }
  return map;
}

/** 词 → 频次。dict.txt: `词 频次 词性` */
function loadFreq() {
  const map = new Map();
  for (const line of readLines(path.join(SRC, "freq.txt"))) {
    if (!line) continue;
    const parts = line.split(" ");
    if (parts.length < 2) continue;
    const n = Number(parts[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    map.set(parts[0], n);
  }
  return map;
}

/* ---------------- 组词条 ---------------- */

const isHan = (ch) => /[\u4e00-\u9fff]/.test(ch);


/**
 * 人工修正表。
 *
 * ============ 两类词 ============
 *
 * 1. **多音字**：逐字拼会把"银行"拼成 yinxing、"长大"拼成 changda。
 *    phrase-pinyin-data 里有一部分，缺的那些在这里补。
 *
 * 2. **jieba 词典没有的新词**：微信、抖音、外卖、小程序……
 *    那份词典有些年头了，日常说的词它不认识，但它们必须能打出来。
 *
 * 频次给得偏高：这些是高频日常词，排在候选前面才合理。
 */
const MANUAL = [
  // ---- 多音字 ----
  ["银行", ["yin", "hang"], 60000],
  ["行业", ["hang", "ye"], 50000],
  ["行走", ["xing", "zou"], 20000],
  ["重庆", ["chong", "qing"], 50000],
  ["重新", ["chong", "xin"], 60000],
  ["重复", ["chong", "fu"], 40000],
  ["重要", ["zhong", "yao"], 80000],
  ["长城", ["chang", "cheng"], 40000],
  ["长大", ["zhang", "da"], 50000],
  ["校长", ["xiao", "zhang"], 40000],
  ["音乐", ["yin", "yue"], 60000],
  ["快乐", ["kuai", "le"], 50000],
  ["还有", ["hai", "you"], 90000],
  ["西藏", ["xi", "zang"], 20000],
  ["的确", ["di", "que"], 50000],
  ["目的", ["mu", "di"], 50000],
  ["了解", ["liao", "jie"], 60000],
  ["为了", ["wei", "le"], 90000],
  ["觉得", ["jue", "de"], 90000],
  ["睡觉", ["shui", "jiao"], 50000],
  ["角色", ["jue", "se"], 30000],
  ["处理", ["chu", "li"], 70000],
  ["到处", ["dao", "chu"], 30000],
  ["便宜", ["pian", "yi"], 40000],
  ["方便", ["fang", "bian"], 60000],
  ["得到", ["de", "dao"], 70000],
  ["禁止", ["jin", "zhi"], 30000],
  ["不禁", ["bu", "jin"], 15000],
  ["尽管", ["jin", "guan"], 40000],
  ["尽力", ["jin", "li"], 30000],
  ["差不多", ["cha", "bu", "duo"], 60000],
  ["出差", ["chu", "chai"], 30000],
  ["请假", ["qing", "jia"], 30000],
  ["假期", ["jia", "qi"], 30000],
  ["数目", ["shu", "mu"], 20000],
  ["数学", ["shu", "xue"], 40000],
  ["传说", ["chuan", "shuo"], 30000],
  ["传记", ["zhuan", "ji"], 8000],

  // ---- jieba 词典里没有的日常词 ----
  ["微信", ["wei", "xin"], 120000],
  ["朋友圈", ["peng", "you", "quan"], 60000],
  ["公众号", ["gong", "zhong", "hao"], 50000],
  ["小程序", ["xiao", "cheng", "xu"], 50000],
  ["二维码", ["er", "wei", "ma"], 50000],
  ["支付宝", ["zhi", "fu", "bao"], 90000],
  ["抖音", ["dou", "yin"], 70000],
  ["淘宝", ["tao", "bao"], 70000],
  ["拼多多", ["pin", "duo", "duo"], 40000],
  ["快递", ["kuai", "di"], 60000],
  ["外卖", ["wai", "mai"], 60000],
  ["直播", ["zhi", "bo"], 60000],
  ["高铁", ["gao", "tie"], 50000],
  ["地铁", ["di", "tie"], 50000],
  ["网约车", ["wang", "yue", "che"], 20000],
  ["充电宝", ["chong", "dian", "bao"], 20000],
  ["验证码", ["yan", "zheng", "ma"], 40000],
  ["登录", ["deng", "lu"], 50000],
  ["注册", ["zhu", "ce"], 50000],
  ["密码", ["mi", "ma"], 60000],
  ["备份", ["bei", "fen"], 30000],
  ["缓存", ["huan", "cun"], 30000],
  ["接口", ["jie", "kou"], 40000],
  ["部署", ["bu", "shu"], 30000],
  ["版本", ["ban", "ben"], 60000],
  ["更新", ["geng", "xin"], 80000],
  ["截图", ["jie", "tu"], 40000],
  ["键盘", ["jian", "pan"], 50000],
  ["输入法", ["shu", "ru", "fa"], 40000],
  ["语音", ["yu", "yin"], 50000],
  ["模型", ["mo", "xing"], 60000],
  ["智能", ["zhi", "neng"], 60000],
  ["人工智能", ["ren", "gong", "zhi", "neng"], 40000],
  ["文件", ["wen", "jian"], 80000],
  ["文件夹", ["wen", "jian", "jia"], 40000],
  ["图片", ["tu", "pian"], 60000],
  ["视频", ["shi", "pin"], 70000],
  ["消息", ["xiao", "xi"], 80000],
  ["通知", ["tong", "zhi"], 60000],
  ["设置", ["she", "zhi"], 80000],
  ["搜索", ["sou", "suo"], 70000],
  ["分享", ["fen", "xiang"], 60000],
  ["保存", ["bao", "cun"], 60000],
];

function build() {
  console.log("读取源文件…");
  const chars = loadChars();
  const phrases = loadPhrases();
  const freq = loadFreq();
  console.log(`  单字 ${chars.size} · 词组 ${phrases.size} · 词频 ${freq.size}`);

  /** 音节集合：只收"真的能拼出来"的音节，用来做切分的合法性判断 */
  const syllableSet = new Set();
  for (const [, pys] of chars) pys.forEach((p) => syllableSet.add(p));
  console.log(`  音节 ${syllableSet.size} 个`);

  /**
   * 每个字的首选读音。
   *
   * ============ 为什么需要它 ============
   *
   * phrase-pinyin-data 覆盖的是成语和固定搭配，常用词反而缺得厉害：
   * 手机、问题、现在、时候 —— 一个都没有。
   *
   * 所以词条要有第二个来源：拿 jieba 的高频词，逐字查首选读音拼出来。
   * 代价是多音字可能拼错（"长大"可能拼成 changda），所以下面还有一张
   * 人工修正表兜住最常用的那些。
   */
  const primary = new Map();
  for (const [ch, pys] of chars) {
    const first = [...pys][0];
    if (first) primary.set(ch, first);
  }

  // ---- 单字表：按频次降序，只留常用（jieba 有频次或字表里排前的） ----
  const charList = [];
  for (const [ch, pys] of chars) {
    if (!isHan(ch)) continue;
    const f = freq.get(ch) || 0;
    // 没有频次的生僻字不进单字表 —— 它们几乎不会被单独输入，
    // 留着只会稀释候选。词库里出现时仍能整词上屏。
    if (f <= 0) continue;
    charList.push({ word: ch, syl: [...pys][0], f, all: [...pys] });
  }
  charList.sort((a, b) => b.f - a.f);
  console.log(`  单字入表 ${charList.length}`);

  // ---- 词条：phrase 表优先，缺的用单字首读音拼 ----
  const words = [];
  const seenWord = new Set();
  const pushWord = (word, syl, f) => {
    if (seenWord.has(word)) return;
    if (!syl || syl.length !== word.length) return;
    if (!syl.every((s) => syllableSet.has(s))) return;
    seenWord.add(word);
    words.push({ word, syl, f });
  };

  // 人工修正表：多音字 + jieba 词典里没有的新词。优先级最高。
  for (const [word, syl, f] of MANUAL) pushWord(word, syl, f);

  // phrase-pinyin-data：拼音最准（按词标注，多音字不会错）
  for (const [word, syl] of phrases) {
    if (word.length < 2 || word.length > 4) continue;
    if (![...word].every(isHan)) continue;
    const f = freq.get(word) || 600; // 没有词频的给一个中等分，不至于垫底
    pushWord(word, syl, f);
  }

  // 补词：jieba 高频词里 phrase 表没有的，逐字拼
  for (const [word, f] of freq) {
    if (word.length < 2 || word.length > 4) continue;
    if (![...word].every(isHan)) continue;
    if (seenWord.has(word)) continue;
    const syl = [...word].map((ch) => primary.get(ch));
    if (syl.some((x) => !x)) continue;
    pushWord(word, syl, f);
  }
  words.sort((a, b) => b.f - a.f || a.word.length - b.word.length);
  const kept = words.slice(0, MAX_WORDS);
  console.log(`  词组入表 ${kept.length} / ${words.length}`);

  return { charList, kept, syllableSet };
}

/* ---------------- 二进制 ---------------- */

/** FNV-1a 32 位。够快，分布够散，碰撞靠字符串比对兜住。 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function encode({ charList, kept, syllableSet }) {
  const sylList = [...syllableSet].sort();
  const sylId = new Map(sylList.map((s, i) => [s, i]));

  // ---- 记录（词 + 单字统一一张表，按拼音键排序） ----
  const entries = [];
  for (const w of kept) {
    entries.push({ key: w.syl.join(""), word: w.word, f: w.f, n: w.syl.length });
  }
  // 单字也要能用整串查询命中（输入 "ni" 时"你"要出现在词候选里）
  for (const c of charList) {
    entries.push({ key: c.syl, word: c.word, f: c.f, n: 1 });
  }
  // 同一个 key + 同一个词可能重复（词组与单字表都收了单字），去重
  const uniq = new Map();
  for (const e of entries) {
    const k = `${e.key}\u0000${e.word}`;
    const prev = uniq.get(k);
    if (!prev || prev.f < e.f) uniq.set(k, e);
  }
  // ============ 必须按 hash 排序，不能按 key ============
  //
  // 读取端是"二分 hash 数组 + 线性扫同 hash 的记录"。二分要求
  // 数组本身升序 —— 按 key 的字典序排，hash 值就是乱序的，
  // 二分永远找不到（表现为"常用词全查不到，只剩逐字拼"）。
  //
  // 同 hash 的记录必须相邻，所以第二排序键是 key 本身，
  // 保证输出稳定、可复现。
  for (const e of uniq.values()) e.hash = fnv1a(e.key);
  const list = [...uniq.values()].sort((a, b) =>
    a.hash - b.hash || (a.key < b.key ? -1 : a.key > b.key ? 1 : b.f - a.f)
  );

  // ---- 区段 ----
  const sylBuf = Buffer.from(sylList.map((s) => s + "\u0000").join(""), "utf8");

  const keyBytes = [];
  const wordBytes = [];
  let keyOff = 0;
  let wordOff = 0;
  const rec = [];
  for (const e of list) {
    const kb = Buffer.from(e.key, "utf8");
    const wb = Buffer.from(e.word, "utf8");
    rec.push({
      hash: e.hash,
      keyOff,
      keyLen: kb.length,
      wordOff,
      wordLen: wb.length,
      n: e.n,
      f: e.f,
    });
    keyBytes.push(kb);
    wordBytes.push(wb);
    keyOff += kb.length;
    wordOff += wb.length;
  }
  const keyBuf = Buffer.concat(keyBytes);
  const wordBuf = Buffer.concat(wordBytes);

  const hashBuf = Buffer.alloc(rec.length * 4);
  const recBuf = Buffer.alloc(rec.length * 16);
  rec.forEach((r, i) => {
    hashBuf.writeUInt32LE(r.hash, i * 4);
    const o = i * 16;
    recBuf.writeUInt32LE(r.keyOff, o);
    recBuf.writeUInt16LE(r.keyLen, o + 4);
    recBuf.writeUInt32LE(r.wordOff, o + 6);
    recBuf.writeUInt8(r.wordLen, o + 10);
    recBuf.writeUInt8(Math.min(255, r.n), o + 11);
    recBuf.writeUInt32LE(Math.min(0xffffffff, r.f), o + 12);
  });

  // ---- 单字索引：音节 → 该音节下的字（按频次降序） ----
  const bySyl = new Map();
  for (const c of charList) {
    const sid = sylId.get(c.syl);
    if (sid === undefined) continue;
    if (!bySyl.has(sid)) bySyl.set(sid, []);
    bySyl.get(sid).push(c);
  }
  const chrIndex = [...bySyl.keys()].sort((a, b) => a - b);
  const chrHead = Buffer.alloc(chrIndex.length * 8);
  const chrChars = [];
  let chrOffChars = 0;
  chrIndex.forEach((sid, i) => {
    const arr = bySyl.get(sid).sort((a, b) => b.f - a.f);
    chrHead.writeUInt16LE(sid, i * 8);
    chrHead.writeUInt32LE(chrOffChars, i * 8 + 2);
    chrHead.writeUInt16LE(Math.min(65535, arr.length), i * 8 + 6);
    for (const c of arr) {
      const b = Buffer.alloc(4);
      b.writeUInt16LE(c.word.charCodeAt(0), 0);
      b.writeUInt16LE(Math.min(65535, c.f), 2);
      chrChars.push(b);
    }
    chrOffChars += arr.length;
  });
  const chrBuf = Buffer.concat([chrHead, ...chrChars]);

  // ---- 拼装 ----
  const headerLen = 64;
  const offs = {};
  let cur = headerLen;
  const push = (name, buf) => {
    offs[name] = { off: cur, len: buf.length };
    cur += buf.length;
    return buf;
  };
  const bSyl = push("syl", sylBuf);
  const bHash = push("hash", hashBuf);
  const bRec = push("rec", recBuf);
  const bKey = push("key", keyBuf);
  const bWord = push("word", wordBuf);
  const bChr = push("chr", chrBuf);

  const head = Buffer.alloc(headerLen);
  head.write("DSHL", 0, "ascii");
  head.writeUInt16LE(1, 4); // version
  head.writeUInt16LE(sylList.length, 6);
  head.writeUInt32LE(list.length, 8); // 记录数
  // 单字索引的**条目数**（按音节分组的组数），不是单字总数 ——
  // 读取端要拿它算字池起点，靠 length 反推会算错
  head.writeUInt32LE(chrIndex.length, 12);
  const slots = [
    ["syl", 16],
    ["hash", 24],
    ["rec", 32],
    ["key", 40],
    ["word", 48],
    ["chr", 56],
  ];
  for (const [name, at] of slots) {
    head.writeUInt32LE(offs[name].off, at);
    head.writeUInt32LE(offs[name].len, at + 4);
  }

  return Buffer.concat([head, bSyl, bHash, bRec, bKey, bWord, bChr], cur);
}

/* ---------------- 主流程 ---------------- */

console.log("\n构建词库\n");
const built = build();
const bin = encode(built);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, bin);

const kb = (bin.length / 1024).toFixed(0);
console.log(`\n写入 ${path.relative(process.cwd(), OUT)} · ${kb} KB`);
console.log(`合计词条 ${built.kept.length} · 单字 ${built.charList.length}`);
