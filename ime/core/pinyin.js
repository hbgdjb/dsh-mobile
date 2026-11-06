/* ============================================================
   拼音引擎 —— 音节切分 + 词图 DP + 候选排序

   ============ 为什么不用现成的输入法库 ============
   
   能跑在 WebView 里的中文输入法方案，基本都要么依赖系统 IME，
   要么体积几十 MB。这里只需要"全拼 → 候选"，那就自己写：
   一片 ArrayBuffer + 一个 DP，不到 300 行，行为完全可控。

   ============ 两条硬性要求 ============
   
   1. 永远有输出。用户打 qwerty 也得能上屏，不能卡住。
      所以每个音节都有一条"单字边"兜底。
   
   2. 快。每次按键都要重算候选，热路径必须在毫秒级。
      所以只做二分查找，不建 trie、不建对象图。

   ============ 词库格式 ============
   
   见 tools/ime-build-lexicon.mjs。这里只关心怎么读：
   64 字节头 → 六个区段 → 二分。
   ============================================================ */

/** 词库头长度，与构建脚本保持一致。 */
const HEADER_LEN = 64;

/** 一条记录 16 字节：keyOff(4) keyLen(2) wordOff(4) wordLen(1) syllCount(1) freq(4)。 */
const REC_SIZE = 16;

/** 单字索引条目 8 字节：syllableId(2) offset(4) count(2)。 */
const CHR_HEAD = 8;

/** 词图 DP 里"多一个词"的代价。越大越倾向于长词少切。 */
const WORD_COST = 2.2;

/** 一次查询最多看几个音节跨度（4 音节 ≈ 4 字词）。 */
const MAX_SPAN = 4;

/**
 * 解析二进制词库。
 *
 * @param {ArrayBuffer} buffer
 * @returns {{syllables:Set<string>, lookup:Function, charsOf:Function, stats:object}}
 */
export function createLexicon(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);

  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "DSHL") throw new Error("词库格式不对（magic 不匹配）");

  const sylCount = dv.getUint16(6, true);
  const recCount = dv.getUint32(8, true);
  // 12 存的是"音节分组数"，不是单字总数
  const chrGroups = dv.getUint32(12, true);

  const sec = {};
  for (const [name, at] of [
    ["syl", 16],
    ["hash", 24],
    ["rec", 32],
    ["key", 40],
    ["word", 48],
    ["chr", 56],
  ]) {
    sec[name] = { off: dv.getUint32(at, true), len: dv.getUint32(at + 4, true) };
  }

  const dec = new TextDecoder();

  // 音节表：\0 分隔
  const sylText = dec.decode(bytes.subarray(sec.syl.off, sec.syl.off + sec.syl.len));
  const syllables = new Set(sylText.split("\u0000").filter(Boolean));

  // 哈希区复制成 Uint32Array：二分要随机访问几万次，
  // DataView 每次 getUint32 都要查表，复制一份（120KB）快得多
  const hashes = new Uint32Array(
    buffer.slice(sec.hash.off, sec.hash.off + sec.hash.len > 0 ? sec.hash.off + sec.hash.len : sec.hash.off)
  );

  const recBase = sec.rec.off;
  const keyBase = sec.key.off;
  const wordBase = sec.word.off;
  const chrBase = sec.chr.off;

  function keyAt(i) {
    const o = recBase + i * REC_SIZE;
    const off = dv.getUint32(o, true);
    const len = dv.getUint16(o + 4, true);
    return dec.decode(bytes.subarray(keyBase + off, keyBase + off + len));
  }

  function wordAt(i) {
    const o = recBase + i * REC_SIZE;
    const off = dv.getUint32(o + 6, true);
    const len = dv.getUint8(o + 10);
    return dec.decode(bytes.subarray(wordBase + off, wordBase + off + len));
  }

  function freqAt(i) {
    return dv.getUint32(recBase + i * REC_SIZE + 12, true);
  }

  function spanAt(i) {
    return dv.getUint8(recBase + i * REC_SIZE + 11) || 1;
  }

  /** 二分找 key 的首次出现位置。 */
  function lowerBound(target) {
    let lo = 0;
    let hi = hashes.length - 1;
    let ans = hashes.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      // 哈希相等不代表 key 相等（碰撞），往左继续找，
      // 保证拿到的是这一串同哈希记录里的第一条
      if (hashes[mid] >= target) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return ans;
  }

  /**
   * 查一个拼音键（不带分隔）。
   *
   * @param {string} key 例如 "yinhang"
   * @returns {Array<{word:string, freq:number, span:number}>}
   */
  function lookup(key) {
    if (!key || !hashes.length) return [];
    const h = fnv1a(key);
    let i = lowerBound(h);
    const out = [];
    // 从同哈希的第一条开始往后扫，直到哈希变化或 key 变化
    for (; i < hashes.length && hashes[i] === h; i += 1) {
      if (keyAt(i) === key) {
        out.push({ word: wordAt(i), freq: freqAt(i), span: spanAt(i) });
      }
    }
    return out;
  }

  /** 某个音节下的单字（已按频次降序）。 */
  function charsOf(syl) {
    const headCount = chrGroups;
    let lo = 0;
    let hi = headCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const o = chrBase + mid * CHR_HEAD;
      const sid = dv.getUint16(o, true);
      const s = syllableName(sid);
      if (s === syl) {
        const off = dv.getUint32(o + 2, true);
        const cnt = dv.getUint16(o + 6, true);
        const poolBase = chrBase + headCount * CHR_HEAD;
        const out = [];
        for (let k = 0; k < cnt; k += 1) {
          const p = poolBase + (off + k) * 4;
          out.push({
            word: String.fromCharCode(dv.getUint16(p, true)),
            freq: dv.getUint16(p + 2, true),
          });
        }
        return out;
      }
      if (s < syl) lo = mid + 1;
      else hi = mid - 1;
    }
    return [];
  }

  /** 音节 id → 音节串。构建时按字典序排过，可以直接二分。 */
  const sylArr = [...syllables].sort();
  function syllableName(id) {
    return sylArr[id] || "";
  }

  return {
    syllables,
    lookup,
    charsOf,
    stats: { syllables: sylCount, entries: recCount, charGroups: chrGroups },
  };
}

/** 和构建脚本同一套 FNV-1a。 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* ============================================================
   引擎
   ============================================================ */

/**
 * 归一化用户输入。
 *
 * - 小写
 * - 撇号是"强制切分标记"，不能直接删掉，要记下位置
 * - 非 a-z 一律丢弃（数字和符号走别的路径）
 *
 * @returns {{text:string, breaks:Set<number>}|null}
 */
function normalize(input) {
  const raw = String(input || "").toLowerCase();
  let text = "";
  const breaks = new Set();
  for (const ch of raw) {
    if (ch === "'") {
      // 断点落在当前已输入的字符之后
      if (text.length) breaks.add(text.length);
      continue;
    }
    if (ch >= "a" && ch <= "z") text += ch;
  }
  if (!text) return null;
  return { text, breaks };
}

/**
 * 建音节格。
 *
 * ============ 只从"可达位置"出发 ============
 *
 * 一开始写成"每个字符位置都必须能起一个音节"，结果 lv 被判非法：
 * 位置 1 是 "v"，它不是任何音节的起点，但它是 "lv" 的后半截 ——
 * 整串明明可以切，却被否掉了。
 *
 * 正确做法是从 0 出发做一次可达性扩展：只有真正落在音节边界上的
 * 位置才继续往下切。末尾可达，整串才合法。
 *
 * @returns {{grid:Array<Array<{len:number,syl:string,end:number}>>, reach:boolean[]}|null}
 */
function buildGrid({ text, breaks }, syllables) {
  const n = text.length;
  const grid = new Array(n);
  const reach = new Array(n + 1).fill(false);
  for (let i = 0; i < n; i += 1) grid[i] = [];
  reach[0] = true;

  for (let i = 0; i < n; i += 1) {
    if (!reach[i]) continue;
    for (let len = 1; len <= 6 && i + len <= n; len += 1) {
      // 跨过强制断点的切片不允许（用户用撇号指定了切分位置）
      let crossed = false;
      for (let b = i + 1; b < i + len; b += 1) {
        if (breaks.has(b)) {
          crossed = true;
          break;
        }
      }
      if (crossed) continue;

      const s = text.slice(i, i + len);
      if (!syllables.has(s)) continue;
      grid[i].push({ len, syl: s, end: i + len });
      reach[i + len] = true;
    }
  }

  if (!grid[0].length || !reach[n]) return null;
  return { grid, reach };
}

/**
 * 词图 DP：从后往前算"从位置 i 到末尾的最优切法"。
 *
 * 打分 = Σ ( log(freq) + 学习加成 ) − 词成本 − 非首位单字罚
 *
 * ============ 为什么"非首位的单字"要罚 ============
 *
 * 词库里的单字频次是**字频**（"在"72 万、"被"10 万、"中"24 万），
 * 多字词是**词频**（"北京"3.4 万、"现在"3.4 万）。两者不是一个量纲，
 * 而路径分数是逐项相加的 —— 单字必然碾压多字词：
 *
 *   beijing  → 被(11.6) + 经(10.0) = 21.5   打败   北京(10.4)
 *   zhongguo → 中(12.4) + 过(11.5) = 23.9   打败   中国(11.8)
 *   xianzai  → 西安(7.9) + 在(13.5) = 21.4  打败   现在(10.4)
 *
 * 于是整句候选退化成"逐字最优拼接"，出来的是"被经""中过""西安在"
 * 这种根本不存在的东西，而且排在第一位。
 *
 * ============ 为什么只罚"非首位" ============
 *
 * 给每个单字都加固定成本，会连"xian → 先"一起打死
 * （"先"会被"西安"顶掉）。而**首位单字是常态**：
 * 打 xian，"先"就是这句话唯一的一个字，它不该被罚。
 *
 * 真正说明"凑不出词"的是**后面还跟着单字**：
 * "西安"后面那个"在"、"被"后面那个"经"。
 *
 * 罚分取 12（约等于"词频低 16 万倍"）是刻意的：它让 DP 表现得像
 * "最大词覆盖"—— 只要存在能覆盖这段拼音的词，就一定用词；
 * 实在没有词，才退回逐字。于是 "woaibeijing" 得到"我爱北京"，
 * 而不是"我爱被经"。
 *
 * best[i] 存在 ⟺ 从 i 能走到末尾。所以 best[0] 存在就等于"整串被覆盖"。
 */
function bestPath({ grid, reach }, text, lexicon, learnScore) {
  const n = text.length;
  const best = new Array(n + 1).fill(null);
  best[n] = { score: 0, words: [] };

  const scoreOf = (freq) => Math.log(Math.max(1, freq) + 1);
  const CHAIN_COST = 12;

  for (let i = n - 1; i >= 0; i -= 1) {
    if (!reach[i] || !grid[i].length) continue;
    // 整串的第一个成分免罚：单独一个"先"是完整的输入，不是凑不出词
    const penalize = i > 0;
    let pick = null;

    // 依次尝试 1..4 个音节组成的键
    let key = "";
    let pos = i;
    for (let span = 0; span < MAX_SPAN && pos < n; span += 1) {
      // 同一位置有多种音节切法时，长音节优先（xian 优先于 xi+an）
      const chosen = grid[pos][grid[pos].length - 1];
      key += chosen.syl;
      const end = chosen.end;

      for (const h of lexicon.lookup(key)) {
        const rest = best[end];
        if (!rest) continue;
        const isSingle = h.word.length === 1;
        const cost = WORD_COST + (isSingle && penalize ? CHAIN_COST : 0);
        const score = scoreOf(h.freq) + learnScore(h.word) - cost + rest.score;
        if (!pick || score > pick.score) {
          pick = { score, word: h.word, end };
        }
      }
      pos = end;
    }

    // 单字兜底：保证任何合法音节都能出一个字，不至于"打不出东西"
    const single = grid[i][grid[i].length - 1];
    const rest = best[single.end];
    if (rest) {
      const chars = lexicon.charsOf(single.syl);
      for (let k = 0; k < Math.min(3, chars.length); k += 1) {
        const c = chars[k];
        const cost = WORD_COST * 1.35 + (penalize ? CHAIN_COST : 0);
        const score = scoreOf(c.freq) + learnScore(c.word) - cost + rest.score;
        if (!pick || score > pick.score) {
          pick = { score, word: c.word, end: single.end };
        }
      }
    }

    if (pick) {
      const tail = best[pick.end];
      best[i] = { score: pick.score, words: [pick.word, ...(tail ? tail.words : [])] };
    }
  }

  return best[0] || null;
}

/**
 * 建一个拼音引擎。
 *
 * @param {object} lexicon createLexicon() 的返回值
 * @param {object} [opts]
 *   opts.learned  Map<string, number> 用户学习加成（P2 接持久化）
 */
export function createEngine(lexicon, opts = {}) {
  const learned = opts.learned || null;

  /**
   * 某个词的学习加成 —— **独立加分，不出现在词频里**。
   *
   * ============ 为什么不能加进 freq ============
   *
   * 最初的做法是 log(freq + learn)，看着很自然，实际完全没用：
   * 词库里"北京"3.4 万、"被"10 万，你往 3.4 万里加 450，
   * log 之后只挪了 0.013 分，用户根本感觉不到自己"被记住"了。
   *
   * 改成在 log 域直接加分，量级就是"几次选择抵得上翻倍"：
   *   学 1 次（权重 90）  → +0.30
   *   学 3 次（权重 270） → +0.90
   *   学 8 次（权重 720） → +2.40（封顶）
   *
   * 2.5 分的上限是刻意留的：再多的话，"北京"这种词打一次就永远
   * 霸占首位，用户偶尔选错一次就再也纠不回来了。
   */
  const LEARN_PER_POINT = 300;
  const LEARN_CAP = 2.5;
  const learnScore = (word) => {
    const w = learned ? learned.get(word) || 0 : 0;
    return w ? Math.min(LEARN_CAP, w / LEARN_PER_POINT) : 0;
  };

  /**
   * 算候选。
   *
   * @param {string} input 用户已输入的字母
   * @param {{limit?:number}} [options]
   * @returns {{buffer:string, whole:string[], words:string[], chars:Array<{word,freq}>}|null}
   *   null 表示这段输入根本无法用拼音解释（调用方应原样上屏）
   */
  function candidates(input, options = {}) {
    const limit = options.limit || 9;
    const norm = normalize(input);
    if (!norm) return null;

    const lattice = buildGrid(norm, lexicon.syllables);
    if (!lattice) return null;

    const path = bestPath(lattice, norm.text, lexicon, learnScore);
    const grid = lattice.grid;
    const first = grid[0][grid[0].length - 1];

    // 词候选：从第一个音节开始，逐步加长键
    const wordSeen = new Set();
    const words = [];
    let key = "";
    let pos = 0;
    for (let span = 0; span < MAX_SPAN && pos < norm.text.length; span += 1) {
      const chosen = grid[pos][grid[pos].length - 1];
      key += chosen.syl;
      pos = chosen.end;
      for (const h of lexicon.lookup(key)) {
        if (wordSeen.has(h.word)) continue;
        wordSeen.add(h.word);
        words.push({ word: h.word, freq: h.freq, span: h.span, consumed: key.length });
      }
    }
    // 覆盖字母多的词优先 —— 打 beijing 先出"北京"(7 个字母)
    // 而不是"被"(3 个字母)。用户敲了两个音节，要的就是一个两音节的词；
    // 按频率排会让"被"(10 万) 永远压在"北京"(3.4 万) 上面。
    // 同长度时才比词频，学习加成也在这一层生效。
    const scoreOf = (f) => Math.log(Math.max(1, f) + 1);
    words.sort(
      (a, b) =>
        b.consumed - a.consumed ||
        scoreOf(b.freq) + learnScore(b.word) - (scoreOf(a.freq) + learnScore(a.word))
    );

    // 单字也吃学习加成：打 "shi" 找"是"这种事，一天要发生几十次。
    // slice() 是因为 charsOf 每次返回新数组，但排序还是复制一份更保险，
    // 别哪天 charsOf 改成返回内部缓存就悄悄把词库顺序改了。
    const scoreOfChar = (f) => Math.log(Math.max(1, f) + 1);
    const chars = lexicon
      .charsOf(first.syl)
      .slice()
      .sort(
        (a, b) =>
          scoreOfChar(b.freq) + learnScore(b.word) - (scoreOfChar(a.freq) + learnScore(a.word))
      )
      .slice(0, limit);

    // ============ 整句候选只在"不是硬拼两个单字"时才给 ============
    //
    // 原来只要 path 走通就拼成整句，于是 beijing 得到"被经"、
    // zhongguo 得到"中过" —— 两个单字硬拼出来的假词，还排在第一位。
    // 但一刀切地砍掉也不对：woaini 在词库里没有"我爱你"也没有"我爱"，
    // 整句只能靠"我+爱+你"拼出来，而那恰恰是对的。
    //
    // 判据：路径里含多字词（真词），或者成分数 ≥3（三个字组成的句子，
    // 硬拼出假词的概率远低于两个）。
    //
    // 只含两个单字的（"被经""中过"）一律不给，因为那种情况下
    // words 列表里本来就有更好的选择，不需要整句。
    const parts = path ? path.words : [];
    const worthWhole = parts.some((w) => w.length > 1) || parts.length >= 3;
    const whole = path && worthWhole ? [path.words.join("")] : [];

    const kept = words.slice(0, limit * 2);
    return {
      buffer: norm.text,
      whole,
      words: kept.map((w) => w.word),
      // 上屏时要知道每个候选消耗几个字母 —— 不然选了"北京"之后
      // 无法从 "beijingnihao" 里正确剩下 "nihao"
      wordItems: kept.map((w) => ({ word: w.word, consumed: w.consumed })),
      chars,
      firstLen: first.syl.length,
    };
  }

  return { candidates, lexicon };
}
