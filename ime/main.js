/* ============================================================
   键盘前端 —— 渲染 + 事件 + 把 effect 交给原生

   ============ 这一层只做三件事 ============
   
     1. 把 state 画出来（候选条、键区、面板）
     2. 把触摸变成 action，交给 core/state.js 的 reduce
     3. 把 reduce 产出的 effect 交给 window.DshIme

   所有"该不该删字""回车要不要发送"的判断都在 core 里，
   这里一条 if 都不写 —— 这样那些判断才能在 node 里被测到。
   ============================================================ */

import { createLexicon, createEngine } from "./core/pinyin.js";
import { createReducer, initialState, flattenCandidates } from "./core/state.js";
import { createLearned } from "./core/learn.js";
import { startVoice, stopVoice, cancelVoice, onVoiceEvent, voiceAvailable } from "../scripts/voice.js";
import { rewrite, TASKS } from "./ai.js";
import { createPanel as createHandPanel, onPanelShown as onHandShown, onPanelHidden as onHandHidden } from "./handwrite.js";

const $ = (id) => document.getElementById(id);
const els = {
  cands: $("cands"),
  more: $("more"),
  keys: $("keys"),
  panel: $("panel"),
  panelTitle: $("panel-title"),
  panelBody: $("panel-body"),
  panelClose: $("panel-close"),
  toast: $("toast"),
};

const bridge = () => (typeof window !== "undefined" ? window.DshIme || null : null);

let engine = null;
let reduce = createReducer({ engine: null });
let state = initialState;

/* ============================================================
   输入记忆

   规则（学什么、加多少、什么时候封顶）全在 core/learn.js 里，
   这里有三个只跟运行环境有关的活：

     1. 把记忆喂给引擎（引擎持的是同一个 Map 的引用，改了就生效）
     2. 防抖写盘 —— 连打十个词只落盘一次
     3. 键盘被收起前强制 flush，别让最后几次选择跟着 WebView 一起消失
   ============================================================ */

/** 写盘防抖：连打十个词只落盘一次。 */
const LEARN_SAVE_MS = 1500;

const learned = createLearned();
let learnSaveTimer = null;

/** 记一次选择。真的要写盘时才排一次防抖。 */
function learnWord(text, kind) {
  if (learned.learn(text, kind)) scheduleLearnSave();
}

function scheduleLearnSave() {
  clearTimeout(learnSaveTimer);
  learnSaveTimer = setTimeout(saveLearned, LEARN_SAVE_MS);
}

function saveLearned() {
  clearTimeout(learnSaveTimer);
  learnSaveTimer = null;
  const b = bridge();
  if (!b || !b.setLearned) return;
  try {
    b.setLearned(JSON.stringify(learned.toJSON()));
  } catch (err) {
    console.warn("[ime] 输入记忆保存失败：", err?.message || err);
  }
}

/** 从原生读回记忆。读不到就当没有 —— 不该因为记忆丢了就不能打字。 */
function loadLearned() {
  const b = bridge();
  if (!b || !b.getLearned) return;
  try {
    const raw = b.getLearned();
    learned.load(raw ? JSON.parse(raw) : null);
  } catch (err) {
    console.warn("[ime] 输入记忆读取失败：", err?.message || err);
  }
}
let aiAbort = null;

/* ---------------- 键位 ---------------- */

const LETTERS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["shift", "z", "x", "c", "v", "b", "n", "m", "back"],
  ["mode", "sym", ",", "space", ".", "enter"],
];

const SYMBOLS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["@", "#", "$", "%", "&", "*", "-", "+", "=", "/"],
  ["(", ")", "[", "]", "{", "}", "<", ">", "\\", "|"],
  ["sym", ":", ";", "'", "\"", "!", "?", "~", "back", "enter"],
];

const GLYPH = {
  shift: "⇧",
  back: "⌫",
  enter: "↵",
  space: "空格",
};

/* ---------------- 渲染 ---------------- */

function renderCandidates() {
  const list = flattenCandidates(state.cand, state.page);
  els.cands.textContent = "";

  // ============ 拼音原文永远显示在候选左边 ============
  // 用户要能一眼核对"我打的拼音对不对" ——
  // 所以有候选时也不能把拼音藏起来。
  const bufEl = document.createElement("div");
  bufEl.className = "buffer";
  if (state.buffer) {
    bufEl.textContent = state.buffer;
    bufEl.dataset.role = "pinyin";
  } else {
    bufEl.textContent = state.mode === "zh" ? "拼音 / 英文" : "English";
    bufEl.dataset.role = "hint";
  }
  els.cands.appendChild(bufEl);

  // 没有任何候选时，拼音就是全部信息 —— 到这里就结束了
  if (!list.length) {
    els.more.disabled = true;
    return;
  }

  list.forEach((item, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cand";
    b.dataset.kind = item.kind;
    b.dataset.index = String(i);
    b.textContent = item.text;
    els.cands.appendChild(b);
  });
  els.more.disabled = !state.cand || flattenCandidates(state.cand, state.page + 1).length === 0;
}

function keyEl(label, opts = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "key";
  b.dataset.key = opts.key || label;
  if (opts.fn) b.dataset.fn = "true";
  if (opts.wide) b.dataset.wide = String(opts.wide);
  if (opts.accent) b.dataset.accent = "true";

  const text = opts.glyph || label;
  if (opts.shiftOn) b.dataset.shift = "true";
  b.textContent = text;
  return b;
}

function renderKeys() {
  const layer = state.panel === "symbol" ? SYMBOLS : LETTERS;
  els.keys.textContent = "";
  for (const row of layer) {
    const r = document.createElement("div");
    r.className = "row";
    for (const k of row) {
      if (k.length === 1) {
        r.appendChild(keyEl(k));
      } else if (k === "space") {
        r.appendChild(keyEl("space", { glyph: GLYPH.space, fn: true, wide: 3 }));
      } else if (k === "enter") {
        r.appendChild(keyEl("enter", { glyph: GLYPH.enter, fn: true, accent: true, wide: 1.5 }));
      } else if (k === "shift") {
        r.appendChild(keyEl("shift", { glyph: GLYPH.shift, fn: true, wide: 1.5 }));
      } else if (k === "back") {
        r.appendChild(keyEl("back", { glyph: GLYPH.back, fn: true, wide: 1.5 }));
      } else if (k === "mode") {
        r.appendChild(keyEl("mode", { glyph: state.mode === "zh" ? "中" : "EN", fn: true, wide: 1.5 }));
      } else if (k === "sym") {
        r.appendChild(keyEl("sym", { glyph: "符号", fn: true, wide: 1.5 }));
      } else {
        r.appendChild(keyEl(k, { fn: true }));
      }
    }
    els.keys.appendChild(r);
  }
}

function renderTools() {
  const tools = document.querySelectorAll(".tool");
  tools.forEach((t) => {
    const name = t.dataset.tool;
    t.dataset.active = String(state.panel === name || (name === "voice" && state.voice === "listening"));
    // 密码框里 AI / 语音 / 截图 / 手写不可用，直接置灰 ——
    // 让用户点一下再弹"不能用"是最差的体验
    if (state.ctx.isPassword) {
      t.disabled = name === "ai" || name === "voice" || name === "capture" || name === "hand";
    } else {
      t.disabled = false;
    }
  });
}

/** 上一次渲染时开着哪个面板。只用来判断"手写面板是不是刚被收起"。 */
let lastPanel = "";

function renderPanel() {
  const name = state.panel;
  // 手写面板的「清空」按钮已去掉，收起时要替用户清干净 ——
  // 否则写错的笔画会一直留在画布上，没有任何办法擦掉。
  if (lastPanel === "hand" && name !== "hand") onHandHidden();
  lastPanel = name;
  if (!name) {
    els.panel.hidden = true;
    // 手写面板是撑满键盘的，关掉时得把这个状态摘掉，
    // 否则下次打开 AI/短语面板会跟着一起变成全屏
    els.panel.classList.remove("is-hand");
    return;
  }
  els.panel.hidden = false;
  els.panelClose.hidden = name === "symbol";

  if (name === "symbol") {
    // 符号页直接铺在键区，不用面板
    els.panel.hidden = true;
    return;
  }

  els.panelTitle.textContent = {
    ai: "AI 改写",
    voice: "语音输入",
    hand: "手写输入",
    phrase: "快捷短语",
    clip: "剪贴板",
  }[name] || "面板";

  els.panelBody.textContent = "";
  // 手写面板要把留白吃掉、并且撑满整个键盘区域 ——
  // 常规面板是 218px 高的卡片，画布塞进去只剩 79px，写不开
  const isHand = name === "hand";
  els.panelBody.classList.toggle("is-flush", isHand);
  els.panel.classList.toggle("is-hand", isHand);
  if (name === "ai") renderAiPanel();
  else if (name === "voice") renderVoicePanel();
  else if (name === "hand") renderHandPanel();
  else if (name === "phrase") renderPhrasePanel();
  else if (name === "clip") renderClipPanel();
}

/**
 * 手写面板。
 *
 * 这个面板的 DOM 必须**复用** —— 别的地方每次渲染都清空 panelBody
 * 重建，但画布一旦重建，用户写了一半的字就没了。createHandPanel()
 * 内部只建一次，这里只是把它挂回去。
 */
function renderHandPanel() {
  els.panelBody.appendChild(
    createHandPanel({
      onPick: (ch) => {
        // keepPanel：写完一个字继续写，不要弹回拼音键盘
        dispatch({ type: "insert", text: ch, keepPanel: true });
        // 手写选中的字也是"我常用这个字"的证据，喂给输入记忆。
        // 学到的权重会作用在拼音候选的排序上，两条输入路径互相帮忙。
        if (ch.length === 1 && /[\u4e00-\u9fff]/.test(ch)) learnWord(ch, "char");
      },
    })
  );
  onHandShown();
}

function renderAiPanel() {
  const ai = state.ai;
  // 还没开始：先让用户选一个动作
  if (!ai || ai.status === "idle") {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = state.ctx.hasSelection
      ? "对选中的文字做什么？"
      : "没有选中文字，将对输入框里光标前的内容改写。";
    els.panelBody.appendChild(hint);

    const box = document.createElement("div");
    box.className = "row-btns";
    box.style.flexWrap = "wrap";
    Object.entries(TASKS).forEach(([key, t]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.textContent = t.label;
      b.dataset.ai = key;
      b.addEventListener("click", () => runAi(key));
      box.appendChild(b);
    });
    els.panelBody.appendChild(box);
    return;
  }

  if (ai.status === "running") {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = `${TASKS[ai.task]?.label || "改写"}中…`;
    els.panelBody.appendChild(hint);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = "取消";
    b.addEventListener("click", () => {
      dispatch({ type: "aiCancel" });
    });
    els.panelBody.appendChild(b);
    return;
  }

  if (ai.status === "error") {
    const out = document.createElement("div");
    out.className = "ai-out";
    out.dataset.state = "error";
    out.textContent = ai.error || "改写失败";
    els.panelBody.appendChild(out);
    const again = document.createElement("button");
    again.type = "button";
    again.className = "btn";
    again.textContent = "重试";
    again.addEventListener("click", () => runAi(ai.task));
    els.panelBody.appendChild(again);
    return;
  }

  const out = document.createElement("div");
  out.className = "ai-out";
  out.textContent = ai.text;
  els.panelBody.appendChild(out);

  const row = document.createElement("div");
  row.className = "row-btns";
  const use = document.createElement("button");
  use.type = "button";
  use.className = "btn";
  use.dataset.primary = "true";
  use.textContent = "替换原文";
  use.addEventListener("click", () => dispatch({ type: "aiReplace" }));
  const redo = document.createElement("button");
  redo.type = "button";
  redo.className = "btn";
  redo.textContent = "换一个";
  redo.addEventListener("click", () => runAi(ai.task));
  row.appendChild(redo);
  row.appendChild(use);
  els.panelBody.appendChild(row);
}

function renderVoicePanel() {
  const box = document.createElement("div");
  box.className = "rec";
  const dot = document.createElement("span");
  dot.className = "rec__dot";
  const txt = document.createElement("span");
  txt.textContent = state.voice === "listening" ? "正在听… 说完点下面" : "准备中…";
  box.appendChild(dot);
  box.appendChild(txt);
  els.panelBody.appendChild(box);

  const row = document.createElement("div");
  row.className = "row-btns";
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "btn";
  stop.dataset.primary = "true";
  stop.textContent = "结束并上屏";
  stop.addEventListener("click", () => dispatch({ type: "voice", op: "stop" }));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => dispatch({ type: "voice", op: "cancel" }));
  row.appendChild(cancel);
  row.appendChild(stop);
  els.panelBody.appendChild(row);
}

async function renderPhrasePanel() {
  const b = bridge();
  let items = [];
  try {
    items = b && b.listPhrases ? JSON.parse(b.listPhrases() || "[]") : [];
  } catch {
    items = [];
  }
  if (!items.length) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "还没有快捷短语。到 DSH → 设置 → 键盘与输入 里添加。";
    els.panelBody.appendChild(hint);
  } else {
    items.forEach((it) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "item";
      btn.textContent = it.text;
      if (it.title) {
        const s = document.createElement("small");
        s.textContent = it.title;
        btn.appendChild(s);
      }
      btn.addEventListener("click", () => dispatch({ type: "insert", text: it.text }));
      els.panelBody.appendChild(btn);
    });
  }

  // 输入记忆的出口放在这里：不占工具条位置，用户想清的时候找得到
  appendLearnRow();
}

/**
 * 面板底部那行"输入记忆：已记住 N 个词 [清空]"。
 *
 * 学习是自动的，就必须给一个可见的撤销入口 ——
 * 否则用户只会觉得"键盘开始乱猜我的词"，却不知道怎么办。
 */
function appendLearnRow() {
  const row = document.createElement("div");
  row.className = "hint";
  row.dataset.role = "learn";

  const n = learned.size;
  const txt = document.createElement("span");
  txt.textContent = n ? `输入记忆：已记住 ${n} 个词，常用词会自动往前排。` : "输入记忆：还没学过任何词。";
  row.appendChild(txt);

  if (n) {
    const btns = document.createElement("div");
    btns.className = "row-btns";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "btn";
    clear.textContent = "清空输入记忆";
    clear.addEventListener("click", () => {
      learned.clear();
      saveLearned();
      renderPanel();
      toast("已清空输入记忆");
    });
    btns.appendChild(clear);
    row.appendChild(btns);
  }

  els.panelBody.appendChild(row);
}

async function renderClipPanel() {
  const b = bridge();
  let items = [];
  try {
    items = b && b.listClipboard ? JSON.parse(b.listClipboard() || "[]") : [];
  } catch {
    items = [];
  }
  if (!items.length) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "剪贴板还没有内容。复制一段文字后回来看看。";
    els.panelBody.appendChild(hint);
    return;
  }
  items.forEach((text) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "item";
    btn.textContent = text.length > 90 ? `${text.slice(0, 90)}…` : text;
    btn.addEventListener("click", () => dispatch({ type: "insert", text }));
    els.panelBody.appendChild(btn);
  });
}

function render() {
  renderCandidates();
  renderKeys();
  renderTools();
  renderPanel();
}

/* ---------------- effect → 原生 ---------------- */

function applyEffect(effect) {
  const b = bridge();
  switch (effect.type) {
    case "commit":
      b?.commit(String(effect.text || ""));
      break;
    case "delete":
      b?.deleteBackward(Number(effect.count) || 1);
      break;
    case "move":
      b?.moveCursor(effect.dir === "right" ? "right" : "left");
      break;
    case "editorAction":
      b?.editorAction();
      break;
    case "vibrate":
      b?.vibrate();
      break;
    case "toast":
      toast(effect.msg);
      break;
    case "panel":
      // 面板由 state 驱动，这里只是允许原生做额外动作（预留）
      break;
    case "voice":
      if (effect.op === "start") startVoiceOnce();
      else if (effect.op === "stop") stopVoice();
      else cancelVoice();
      break;
    case "ai":
      if (effect.op === "cancel") {
        aiAbort?.abort();
        aiAbort = null;
      }
      break;
    case "capture":
      b?.captureScreen();
      break;
    case "learn":
      learnWord(effect.text, effect.kind);
      break;
    case "replaceSelection":
      b?.replaceSelection(String(effect.text || ""), String(effect.source || ""));
      break;
    default:
      break;
  }
}

function dispatch(action) {
  const r = reduce(state, action);
  state = r.state;
  r.effects.forEach(applyEffect);
  render();
}

/* ---------------- AI ---------------- */

async function readTargetText() {
  const b = bridge();
  if (!b || !b.getContext) return { text: "", selection: false };
  try {
    const ctx = JSON.parse(b.getContext() || "{}");
    return { text: String(ctx.selection || ctx.before || ""), selection: !!ctx.selection };
  } catch {
    return { text: "", selection: false };
  }
}

async function runAi(task) {
  const { text, selection } = await readTargetText();
  if (!text.trim()) {
    toast(selection ? "选中的是空的" : "先把光标放到要改写的文字后面");
    return;
  }

  dispatch({ type: "ai", task });

  aiAbort = new AbortController();
  try {
    const out = await rewrite(task, text, {
      signal: aiAbort.signal,
      config: readConfig(),
    });
    dispatch({ type: "aiDone", text: out, source: text });
  } catch (err) {
    if (err?.name === "AbortError") return;
    dispatch({ type: "aiFail", msg: err?.message || String(err) });
  } finally {
    aiAbort = null;
  }
}

function readConfig() {
  const b = bridge();
  try {
    return b && b.getConfig ? JSON.parse(b.getConfig() || "{}") : {};
  } catch {
    return {};
  }
}

/* ---------------- 语音 ---------------- */

function startVoiceOnce() {
  if (!voiceAvailable()) {
    toast("这台设备没有可用的语音识别");
    dispatch({ type: "voice", op: "cancel" });
    return;
  }
  startVoice({ lang: "zh-CN" });
}

onVoiceEvent((evt) => {
  if (evt.type === "final" && evt.text) {
    dispatch({ type: "voiceText", text: evt.text });
  } else if (evt.type === "error") {
    dispatch({ type: "voice", op: "cancel" });
    toast(evt.message || "语音识别失败");
  }
});

/* ---------------- 触摸 ---------------- */

let pressed = null;

function onDown(e) {
  const key = e.target.closest?.("[data-key]");
  if (key) {
    e.preventDefault(); // 关键：阻止焦点转移，否则输入框会失焦、键盘收起
    key.classList.add("is-down");
    pressed = key;
    handleKey(key.dataset.key);
    return;
  }

  const cand = e.target.closest?.(".cand");
  if (cand) {
    e.preventDefault();
    dispatch({ type: "candidate", index: Number(cand.dataset.index) || 0 });
  }
}

function onUp() {
  if (pressed) {
    pressed.classList.remove("is-down");
    pressed = null;
  }
}

function handleKey(k) {
  switch (k) {
    case "shift":
      dispatch({ type: "shift" });
      return;
    case "mode":
      dispatch({ type: "mode" });
      return;
    case "back":
      dispatch({ type: "backspace" });
      return;
    case "space":
      dispatch({ type: "space" });
      return;
    case "enter":
      dispatch({ type: "enter" });
      return;
    case "sym":
      dispatch({ type: "panel", name: state.panel === "symbol" ? "" : "symbol" });
      return;
    default: {
      // 字母键：shift 打开时输出大写（中文模式下无影响）
      const ch = state.shift ? k.toUpperCase() : k;
      dispatch({ type: "char", ch });
    }
  }
}

/* ---------------- 工具 ---------------- */

let toastTimer = null;
function toast(msg) {
  if (!msg) return;
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 1800);
}

/* ---------------- 初始化 ---------------- */

async function loadLexicon() {
  try {
    const res = await fetch("./lexicon.bin", { cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    // 先把记忆读进来再建引擎 —— 引擎建好后才能吃到加权
    loadLearned();
    engine = createEngine(createLexicon(buf), { learned: learned.map });
    reduce = createReducer({ engine });
    // 词库到位时用户可能已经在打了 —— 重算一次
    if (state.buffer) {
      const r = reduce(state, { type: "char", ch: state.buffer.slice(-1) });
      state = r.state;
    }
    render();
  } catch (err) {
    // 词库加载失败不致命：拼音候选空着，但仍能打英文、用短语
    console.warn("[ime] 词库加载失败：", err?.message || err);
    toast("词库加载失败，暂时只能打英文");
  }
}

function boot() {
  els.keys.addEventListener("pointerdown", onDown);
  els.keys.addEventListener("pointerup", onUp);
  els.keys.addEventListener("pointercancel", onUp);
  els.cands.addEventListener("pointerdown", onDown);
  els.more.addEventListener("click", () => dispatch({ type: "page", dir: 1 }));
  els.panelClose.addEventListener("click", () => dispatch({ type: "closePanel" }));

  document.querySelectorAll(".tool").forEach((t) => {
    t.addEventListener("click", () => {
      const name = t.dataset.tool;
      if (name === "voice") {
        if (state.voice === "listening") dispatch({ type: "voice", op: "stop" });
        else dispatch({ type: "voice", op: "start" });
        return;
      }
      if (name === "capture") {
        dispatch({ type: "capture" });
        return;
      }
      if (name === "ai") {
        // AI 打开时先给任务选择面板
        dispatch({ type: "panel", name: "ai" });
        state = { ...state, ai: null };
        render();
        return;
      }
      dispatch({ type: "panel", name });
    });
  });

  // 原生推输入框上下文：光标位置、密码框、是否有选区、是否多行
  window.__dshImeContext = (json) => {
    let patch = {};
    try {
      patch = JSON.parse(json || "{}");
    } catch {
      return;
    }
    dispatch({ type: "context", patch });
  };
  window.__dshImeReset = () => dispatch({ type: "reset" });

  render();
  loadLexicon();

  // 键盘被收起、进程被回收前，把还没落盘的记忆写掉。
  // 少了这一步，用户最后几次选择会跟着 WebView 一起消失。
  window.addEventListener("pagehide", saveLearned);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveLearned();
  });

  // 告诉原生"键盘页准备好了"，它会推一次上下文
  bridge()?.ready?.();
}

boot();
