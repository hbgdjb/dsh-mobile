/* ============================================================
   键盘内核 —— 按键 → 状态 → 要做的动作

   ============ 为什么做成纯函数 ============
   
   输入法最怕的是"某个应用里突然不能删字"。这类 bug 在真机上
   极难复现：要特定的应用、特定的输入框、特定的按键顺序。
   
   所以把判断逻辑和「真正操作输入框」彻底分开：
   
     reduce(state, action) → { state, effects[] }
   
   这一层不碰 InputConnection、不碰 DOM。原生侧只实现一个
   apply(effect)。测试里换成记录器，就能把每个按键序列的
   行为完整断言出来 —— 包括"在微信里会怎样"。

   ============ 一条铁律 ============
   
   缓冲区里有字母时，回车**绝不能**把它丢掉。
   用户打了 nihao 又按回车，最差也要上屏"你好"，
   而不是什么都没发生 —— 那是输入法最不可原谅的行为。
   ============================================================ */

/** 中英切换、面板、语音、AI 的初始状态。 */
export const initialState = Object.freeze({
  mode: "zh",
  shift: false,
  buffer: "",
  cand: null,
  page: 0,
  panel: "",
  voice: "idle",
  ai: null,
  /** 输入框能力快照，由原生在 onStartInput 时推过来。 */
  ctx: {
    inputType: "text",
    isPassword: false,
    canRead: false,
    hasSelection: false,
    multiline: false,
  },
});

const PAGE_SIZE = 9;

/**
 * 把候选摊平成"按下标就能取"的一张表。
 *
 * 顺序：整句 → 词 → 单字。每条带 consumed（消耗几个字母），
 * 上屏后要从缓冲里切掉对应长度。
 */
export function flattenCandidates(cand, page = 0) {
  if (!cand) return [];
  const firstLen = cand.firstLen || 1;
  const wordItems = cand.wordItems || [];
  const wordTexts = new Set(wordItems.map((it) => it.word));

  const list = [];

  // ============ 整句候选要给词候选让位 ============
  //
  // 打 beijing 时整句和词都是"北京"，以前两条都会留下：
  // 候选条上出现两个一模一样的"北京"，用户不知道点哪个；
  // 更糟的是点第一条（整句）不会被学习记住 —— 因为整句不学。
  //
  // 所以：整句如果同时也是个词，就丢掉整句那条，让词候选留下。
  // 真正的整句（"我爱北京"）词候选里没有，照常保留。
  for (const w of cand.whole || []) {
    if (wordTexts.has(w)) continue;
    list.push({ text: w, consumed: cand.buffer.length, kind: "whole" });
  }
  for (const it of wordItems) {
    list.push({ text: it.word, consumed: it.consumed || firstLen, kind: "word" });
  }
  for (const c of cand.chars || []) list.push({ text: c.word, consumed: firstLen, kind: "char" });

  // 去重：同一个字既在词候选又在单字候选里时（"是"），只留先出现的那个
  const seen = new Set();
  const uniq = [];
  for (const it of list) {
    if (seen.has(it.text)) continue;
    seen.add(it.text);
    uniq.push(it);
  }
  const from = page * PAGE_SIZE;
  return uniq.slice(from, from + PAGE_SIZE);
}

function totalPages(cand) {
  if (!cand) return 1;
  const n = (cand.whole?.length || 0) + (cand.words?.length || 0) + (cand.chars?.length || 0);
  return Math.max(1, Math.ceil(n / PAGE_SIZE));
}

/**
 * 建一个 reducer。
 *
 * @param {object} deps
 *   deps.engine  createEngine() 的返回值（只读）
 */
export function createReducer(deps = {}) {
  const engine = deps.engine || null;

  /** 重算候选。返回 patch。 */
  function recompute(buffer, page = 0) {
    if (!engine || !buffer) return { cand: null, page: 0 };
    const c = engine.candidates(buffer, { limit: PAGE_SIZE * 2 });
    return { cand: c, page: c ? page : 0 };
  }

  /**
   * 上屏一个候选，并从缓冲里切掉它消耗的部分。
   * 剩下的字母继续组句 —— 这是输入法该有的行为。
   */
  function takeCandidate(state, item, effects) {
    effects.push({ type: "commit", text: item.text });
    effects.push({ type: "vibrate" });
    // 用户从候选里挑了它 —— 这就是"我常用这个词"的唯一证据。
    // 状态机不碰存储（要保持纯函数），只把这件事报出去。
    effects.push({ type: "learn", text: item.text, kind: item.kind || "word" });
    const rest = state.buffer.slice(Math.min(item.consumed, state.buffer.length));
    const patch = recompute(rest, 0);
    return { ...state, buffer: rest, ...patch, panel: "" };
  }

  /**
   * 把缓冲里的首选上屏。
   *
   * 没有候选（无法切分）时，把缓冲原样上屏 ——
   * 用户打了一串字母按回车，就是想输入它。
   */
  function commitComposition(state, effects) {
    if (!state.buffer) return null;
    const list = flattenCandidates(state.cand, state.page);
    const pick = list[0];
    if (pick) return takeCandidate(state, pick, effects);
    effects.push({ type: "commit", text: state.buffer });
    effects.push({ type: "vibrate" });
    return { ...state, buffer: "", cand: null, page: 0 };
  }

  function reduce(state, action) {
    const effects = [];
    const a = action || {};

    switch (a.type) {
      /* ---------------- 字母 ---------------- */
      case "char": {
        const ch = String(a.ch || "");
        if (!ch) return { state, effects };

        // 英文模式：直接上屏，不进缓冲
        if (state.mode === "en") {
          const out = state.shift ? ch.toUpperCase() : ch;
          effects.push({ type: "commit", text: out });
          effects.push({ type: "vibrate" });
          // 上屏一个大写字母后自动回到小写（常见的 shift 行为）
          return { state: { ...state, shift: false }, effects };
        }

        const buffer = state.buffer + ch.toLowerCase();
        const patch = recompute(buffer, 0);
        // 拼音打不出来（比如输入了 q w 这种）就先留在缓冲里，
        // 由 UI 显示原始字母，用户可退格或空格原样上屏
        return { state: { ...state, buffer, ...patch, panel: "" }, effects };
      }

      /* ---------------- 退格 ---------------- */
      case "backspace": {
        if (state.buffer) {
          const buffer = state.buffer.slice(0, -1);
          const patch = recompute(buffer, 0);
          return { state: { ...state, buffer, ...patch }, effects };
        }
        effects.push({ type: "delete", count: 1 });
        return { state, effects };
      }

      /* ---------------- 空格 ---------------- */
      case "space": {
        if (state.buffer) {
          const next = commitComposition(state, effects);
          if (next) return { state: next, effects };
        }
        effects.push({ type: "commit", text: " " });
        effects.push({ type: "vibrate" });
        return { state, effects };
      }

      /* ---------------- 回车 ---------------- */
      case "enter": {
        // 缓冲非空：先上屏，绝不吞掉已打的字母
        if (state.buffer) {
          const next = commitComposition(state, effects);
          if (next) return { state: next, effects };
        }
        if (state.ctx.multiline) {
          effects.push({ type: "commit", text: "\n" });
        } else {
          effects.push({ type: "editorAction" });
        }
        effects.push({ type: "vibrate" });
        return { state, effects };
      }

      /* ---------------- 候选 ---------------- */
      case "candidate": {
        const list = flattenCandidates(state.cand, state.page);
        const item = list[Number(a.index) || 0];
        if (!item) return { state, effects };
        return { state: takeCandidate(state, item, effects), effects };
      }

      case "page": {
        if (!state.cand) return { state, effects };
        const max = totalPages(state.cand) - 1;
        const page = Math.max(0, Math.min(max, state.page + (Number(a.dir) || 0)));
        return { state: { ...state, page }, effects };
      }

      /* ---------------- 模式与修饰 ---------------- */
      case "mode": {
        const mode = a.mode || (state.mode === "zh" ? "en" : "zh");
        // 切模式时清缓冲：留着拼音去按英文键只会更乱
        return {
          state: { ...state, mode, buffer: "", cand: null, page: 0, shift: false, panel: "" },
          effects,
        };
      }

      case "shift": {
        return { state: { ...state, shift: !state.shift }, effects };
      }

      /* ---------------- 面板 ---------------- */
      case "panel": {
        const name = a.name || "";
        const next = state.panel === name ? "" : name;
        // 打开面板时把拼音缓冲上屏，避免面板关掉后残留
        if (next && state.buffer) {
          const cleared = commitComposition(state, effects);
          if (cleared) return { state: { ...cleared, panel: next }, effects };
        }
        return { state: { ...state, panel: next }, effects };
      }

      case "closePanel": {
        return { state: { ...state, panel: "" }, effects };
      }

      /* ---------------- 直接插入文本（短语、剪贴板、语音、AI 结果、手写） ---------------- */
      case "insert": {
        const text = String(a.text || "");
        if (!text) return { state, effects };
        effects.push({ type: "commit", text });
        effects.push({ type: "vibrate" });
        // keepPanel：手写选完一个字继续写下一个，别把面板收掉 ——
        // 写"你好"要点两次手写按钮就太蠢了
        return {
          state: { ...state, buffer: "", cand: null, page: 0, panel: a.keepPanel ? state.panel : "" },
          effects,
        };
      }

      /* ---------------- 语音 ---------------- */
      case "voice": {
        const op = a.op;
        if (op === "start") {
          if (state.ctx.isPassword) {
            effects.push({ type: "toast", msg: "密码框里不能用语音输入" });
            return { state, effects };
          }
          effects.push({ type: "voice", op: "start" });
          return { state: { ...state, voice: "listening", panel: "voice" }, effects };
        }
        if (op === "stop" || op === "cancel") {
          effects.push({ type: "voice", op });
          return { state: { ...state, voice: "idle", panel: op === "stop" ? state.panel : "" }, effects };
        }
        return { state, effects };
      }

      case "voiceText": {
        // 识别结果直接上屏，不进组合态
        const text = String(a.text || "");
        if (!text) return { state, effects };
        effects.push({ type: "commit", text });
        effects.push({ type: "vibrate" });
        return { state: { ...state, voice: "idle", panel: "" }, effects };
      }

      /* ---------------- AI ---------------- */
      case "ai": {
        if (state.ctx.isPassword) {
          effects.push({ type: "toast", msg: "密码框里不能用 AI 改写" });
          return { state, effects };
        }
        const task = a.task || "polish";
        effects.push({ type: "ai", op: "start", task });
        return { state: { ...state, panel: "ai", ai: { task, status: "running", text: "", source: "" } }, effects };
      }

      case "aiDone": {
        return {
          state: { ...state, ai: { ...(state.ai || {}), status: "done", text: String(a.text || ""), source: a.source || "" } },
          effects,
        };
      }

      case "aiFail": {
        // 错误信息存 error，**不能**存 text —— text 是待替换的正文，
        // 存成错误消息的话，用户一点"替换"就会把"网络断了"贴进输入框
        return {
          state: {
            ...state,
            ai: { ...(state.ai || {}), status: "error", text: "", error: String(a.msg || "改写失败") },
          },
          effects,
        };
      }

      case "aiReplace": {
        // 只有成功拿到结果才允许替换
        if (state.ai?.status !== "done") return { state, effects };
        const text = state.ai?.text || "";
        if (!text) return { state, effects };
        effects.push({ type: "replaceSelection", text, source: state.ai?.source || "" });
        effects.push({ type: "vibrate" });
        return { state: { ...state, panel: "", ai: null }, effects };
      }

      case "aiCancel": {
        effects.push({ type: "ai", op: "cancel" });
        return { state: { ...state, panel: "", ai: null }, effects };
      }

      /* ---------------- 截图 ---------------- */
      case "capture": {
        if (state.ctx.isPassword) {
          effects.push({ type: "toast", msg: "密码框里不能截图" });
          return { state, effects };
        }
        effects.push({ type: "capture" });
        effects.push({ type: "vibrate" });
        return { state, effects };
      }

      /* ---------------- 光标 ---------------- */
      case "move": {
        if (state.buffer) {
          // 有拼音缓冲时，左右键既然在编辑拼音，就不该跳到输入框里
          effects.push({ type: "toast", msg: "先把拼音选完" });
          return { state, effects };
        }
        effects.push({ type: "move", dir: a.dir === "right" ? "right" : "left" });
        return { state, effects };
      }

      /* ---------------- 上下文 ---------------- */
      case "context": {
        const ctx = { ...state.ctx, ...(a.patch || {}) };
        // 密码框：强制英文、清掉一切残留
        if (ctx.isPassword) {
          return {
            state: { ...state, ctx, mode: "en", buffer: "", cand: null, panel: "", ai: null },
            effects,
          };
        }
        return { state: { ...state, ctx }, effects };
      }

      /* ---------------- 复位 ---------------- */
      case "reset": {
        return {
          state: { ...initialState, ctx: state.ctx, mode: state.mode },
          effects,
        };
      }

      default:
        return { state, effects };
    }
  }

  return reduce;
}
