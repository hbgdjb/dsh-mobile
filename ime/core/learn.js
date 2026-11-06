/* ============================================================
   输入记忆 —— 用户选过的词，以及它该加多少权重

   ============ 为什么要单独一个文件 ============
   
   这段逻辑是纯计算（加多少、什么时候封顶、超了淘汰谁），
   跟 DOM、跟原生桥都没关系。放在 core 里，就能在 node 里
   把"学一年以后会不会学歪"这种问题直接跑到，而不是等用户反馈。

   ============ 学什么 ============
   
   只学用户**从候选条里挑出来**的词。这是唯一诚实的信号：
   他看了一屏候选，选了这一个，说明下一个词他大概率还要它。

   不学的两类，理由各不相同：
     · 整句候选：一屏只有一个，学了也改变不了任何顺序
     · 按空格原样上屏的字母串：那不是"选词"，是"我要这串字母"

   ============ 为什么权重是 90 这个量级 ============
   
   引擎打分是 log(freq + learn)，词库里的 freq 从几十到几万。
   所以 learn 加 1、加 2 等于没加 —— 想看得见效果，就得加到
   和词频同量级。90 大约等于"这个词的词频翻了一倍多"。

   单字减半：单字误选的概率比词高得多（打 shi 顺手点了个"式"），
   而且单字候选本来就只有 9 个位置，加太猛会把常用字挤下去。

   ============ 上限 ============
   
   单个词封顶（词 900 / 字 450），总的封顶 500 条。
   不封顶的话，用一年以后词库就"学歪"了 —— 什么都往前提，
   等于什么都没提，还会把没学过的正常词全压下去。
   ============================================================ */

/** 一次选词加多少。 */
export const STEP_WORD = 90;
export const STEP_CHAR = 45;
/** 单个词/字能涨到多少。 */
export const CAP_WORD = 900;
export const CAP_CHAR = 450;
/** 最多记多少个词。超出时淘汰权重最低的。 */
export const MAX_ENTRIES = 500;

/** 只有纯汉字才学 —— 英文、数字、符号都不属于词库能命中的词。 */
const HAN = /^[\u4e00-\u9fff]+$/;

/**
 * 建一份输入记忆。
 *
 * @param {Object<string, number>} [initial] 从存储读回来的旧数据
 * @returns {{
 *   map: Map<string, number>,
 *   get: (word: string) => number,
 *   learn: (text: string, kind?: string) => boolean,
 *   clear: () => void,
 *   size: number,
 *   toJSON: () => Object<string, number>,
 * }}
 */
export function createLearned(initial) {
  const map = new Map();

  /** 把存储里的旧数据灌进来。读到的脏数据直接丢掉，不报错。 */
  function load(obj) {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(v);
      if (typeof k === "string" && k && Number.isFinite(n) && n > 0) {
        map.set(k, n);
      }
    }
    evict();
  }

  load(initial);

  /** 超出条数上限时，砍掉权重最低的那些。 */
  function evict() {
    if (map.size <= MAX_ENTRIES) return;
    const sorted = [...map.entries()].sort((a, b) => a[1] - b[1]);
    const drop = map.size - MAX_ENTRIES;
    for (let i = 0; i < drop; i += 1) map.delete(sorted[i][0]);
  }

  return {
    map,

    load,

    get(word) {
      return map.get(word) || 0;
    },

    /**
     * 记一次选择。
     *
     * @param {string} text 用户挑中的词或字
     * @param {string} [kind] whole / word / char
     * @returns {boolean} 是否有变化（false 表示被忽略或已封顶）
     */
    learn(text, kind) {
      const w = String(text || "");
      if (!w || kind === "whole") return false;
      if (!HAN.test(w)) return false;

      const isChar = w.length === 1;
      const step = isChar ? STEP_CHAR : STEP_WORD;
      const cap = isChar ? CAP_CHAR : CAP_WORD;
      const now = map.get(w) || 0;
      const next = Math.min(cap, now + step);

      // 已经封顶：不算变化，调用方就不用去写盘
      if (next === now) return false;

      map.set(w, next);
      evict();
      return true;
    },

    clear() {
      map.clear();
    },

    get size() {
      return map.size;
    },

    toJSON() {
      const obj = {};
      for (const [k, v] of map) obj[k] = v;
      return obj;
    },
  };
}
