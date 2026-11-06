/* ============================================================
   手写输入 —— 面板、笔迹采集、模型推理

   ============ 为什么在 WebView 里跑而不是写成原生 ============

   键盘本身就是个网页。笔迹天然是 canvas 上的一串坐标，
   如果走原生就得把坐标序列跨进程传过去、渲染成位图、再传回来，
   三跳都可能在某个 ROM 上出岔子（这个项目已经踩过 Activity
   生命周期和 InputConnection 的坑了）。

   用 onnxruntime-web 直接在页面里推理：坐标不用出门，
   而且这套代码能在沙箱里用真浏览器跑通 —— 不用等真机。
   代价是 wasm 有 11 MB，认了。

   ============ 什么时候加载 ============

   模型 16.6 MB，绝不能在键盘弹出时就加载 —— 那会让每一次
   唤起输入法都卡一下。改成**第一次点「手写」才加载**，
   加载期间面板里显示进度，用户能看到在干什么。
   ============================================================ */

import {
  normalizeInk,
  paintInk,
  toTensor,
  softmax,
  ctcCandidates,
  buildVocabulary,
  IMAGE_HEIGHT,
} from "./core/handwrite.js";

const ORT_PATH = "./vendor/ort/ort.wasm.min.mjs";
const MODEL_PATH = "./model/ppocrv5.ort";
const DICT_PATH = "./model/ppocrv5-dict.txt";

/** 写完停多久开始认。太快会把"停一下再写下一笔"当成写完。 */
const IDLE_RECOGNIZE_MS = 420;

let ortMod = null;
let session = null;
let vocab = null;
let loading = null;

const state = {
  status: "idle", // idle | loading | ready | error
  error: "",
  cands: [],
  busy: false,
};

/** 只建一次的证据：面板每次重绘都会清空 panelBody，画布不能被清掉。 */
let dom = null;
let strokes = [];
let current = null;
let idleTimer = null;
let ctx = null;
let canvas = null;
let dpr = 1;

/* ---------------- 模型 ---------------- */

/**
 * 从词库二进制里扫出所有用到的汉字。
 *
 * ============ 为什么直接扫字节，不解析词库 ============
 *
 * pinyin.js 里已经有完整的词库解析器，但它解出来的是"拼音 → 词条列表"，
 * 要凑出字符集还得再遍历一遍，而且得把 engine 传进来、多一层依赖。
 *
 * 这里只需要"哪些字在库里"这一个信息。汉字在 UTF-8 里一律是
 * E4..E9 开头的三字节，扫一遍 8 MB 只要几毫秒，而且词库格式
 * 以后怎么改都不会影响这段 —— 它是字节层面的，不是结构层面的。
 *
 * 白名单的收益是实测的：不加 87.7%，加 91%（top1）。
 */
function scanLexiconChars(buf) {
  const set = new Set();
  const n = buf.length;
  for (let i = 0; i + 2 < n; i += 1) {
    const b = buf[i];
    if (b < 0xe4 || b > 0xe9) continue;
    if ((buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80) continue;
    const cp = ((b & 0x0f) << 12) | ((buf[i + 1] & 0x3f) << 6) | (buf[i + 2] & 0x3f);
    if (cp >= 0x4e00 && cp <= 0x9fff) {
      set.add(String.fromCodePoint(cp));
      i += 2;
    }
  }
  return set;
}

/**
 * 词库读不到时的兜底白名单：一级常用字。
 *
 * 手写本来就是"拼音打不出、也不想切输入法"时的兜底手段，
 * 它自己再依赖词库加载成功，就不够兜底了。这一份写死在代码里，
 * 断网、词库损坏都还在。
 */
const FALLBACK_COMMON =
  "的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感见明问力理尔点文几定本公特做外孩相西果走将月十实向声车全信重三机工物气每并别真打太新比才便夫再书部水像眼等体却加电主界门利海受听表德少克代员许稜先口由死安写性马光白或住难望教命花结乐色更拉东神记处让母父应直字场平报友关放至张认接告入笑内英军候民岁往何度山觉路带万男边风解叫任金快原吃妈变通师立象数四失满战远格士音轻目条呢病始达深完今提求清王化空业思切怎非找片罗钱吗语元喜曾离飞科言干流欢约各即指合反题必该论交终林请医晚制球决传画保读运及则房早院量苦火布品近坐产答星精视五连司巴奇管类未朋且婚台夜青北队久乎越观落尽形影红爸百令周吧识步希亚术留市半热送兴造谈容极随演收首根讲整式取照办强石古华諣拿计您装似足双妻尼转诉米称丽客南领节衣站黑刻统断福城故历惊脸选包紧争另建维绝树系伤示愿持千史谁草吉"
    .split("");

/**
 * 把底层异常翻译成用户能照做的一句话。
 *
 * 直接甩 "Failed to fetch dynamically imported module" 给用户，
 * 等于什么都没说。这几种失败在真机上各对应一个具体动作，
 * 分开说才有意义。
 */
function explainError(err) {
  const msg = err?.message || String(err || "");
  if (/dynamically imported module|MIME type|module script/i.test(msg)) {
    return "手写组件被拦截（键盘资源类型不对），请更新到最新版";
  }
  if (/SharedArrayBuffer|threads/i.test(msg)) {
    return "系统 WebView 不支持多线程 wasm，已尝试单线程仍失败";
  }
  if (/WebAssembly|CompileError|magic|unexpected/i.test(msg)) {
    return "系统 WebView 版本过旧，不支持手写识别";
  }
  if (/fetch|404|NetworkError|Load failed/i.test(msg)) {
    return "手写模型文件缺失或读取失败";
  }
  return msg;
}

/**
 * wasm 能力预检。
 *
 * 手写唯一的运行时依赖是 WebAssembly。国产 ROM 上仍有停在
 * Chromium 6x/7x 的 WebView（系统组件不给更新），那里连 SIMD
 * 都没有，ORT 会在编译阶段抛一句没人看得懂的 CompileError。
 * 提前检一下，换成人话，也让"重试"这个按钮不至于点了白点。
 */
function wasmSupport() {
  if (typeof WebAssembly !== "object") return "nope";
  // 一段最小的 SIMD 模块（v128 常量 + i32x4.splat），能过说明有 SIMD
  const simd = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
    253, 15, 253, 98, 11,
  ]);
  try {
    if (WebAssembly.validate(simd)) return "simd";
  } catch {
    /* 老引擎对未知 opcode 直接抛，按无 SIMD 处理 */
  }
  return "basic";
}

async function ensureModel(onProgress) {
  if (session) return;
  if (loading) return loading;

  loading = (async () => {
    state.status = "loading";
    state.error = "";
    onProgress?.("正在检查运行环境…", 0.02);

    const support = wasmSupport();
    if (support === "nope") {
      throw new Error("WebAssembly 不可用");
    }
    if (support === "basic") {
      // 没有 SIMD 也让它试一次：部分实现只是 validate 保守，
      // 真跑起来能过。真过不去，下面的 catch 会给出人话。
      console.warn("[handwrite] 无 SIMD 支持，可能无法加载模型");
    }

    onProgress?.("正在加载识别引擎…", 0.05);
    const dictRes = await fetch(DICT_PATH, { cache: "force-cache" });
    // 缺文件时 serveAsset 会返回 200 + 空体，光看 ok 不够，字表长度才是实锤
    const dictText = dictRes.ok ? await dictRes.text() : "";
    if (dictText.length < 1000) throw new Error("字典文件缺失（ppocrv5-dict.txt）");

    // 白名单优先用键盘自己的词库：词库里的字才是这个输入法该给的中文字
    let common = null;
    try {
      const res = await fetch("./lexicon.bin", { cache: "force-cache" });
      if (res.ok) {
        const scanned = scanLexiconChars(new Uint8Array(await res.arrayBuffer()));
        if (scanned.size > 500) common = scanned;
      }
    } catch {
      common = null;
    }
    vocab = buildVocabulary(dictText, common || new Set(FALLBACK_COMMON));
    if (!vocab.allowed.size) vocab = buildVocabulary(dictText, null);
    onProgress?.("正在加载识别模型…", 0.25);

    ortMod = await import(ORT_PATH);
    const { env, InferenceSession } = ortMod;
    // wasmPaths 必须给**绝对** URL。给相对路径时 ORT 会按"模块所在目录"
    // 再拼一次，结果变成 /ime/vendor/ort/vendor/ort/xxx.wasm 直接 404。
    env.wasm.wasmPaths = new URL("./vendor/ort/", document.baseURI).href;
    // WebView 里通常拿不到 SharedArrayBuffer（没有 cross-origin-isolated），
    // 多线程版本会直接报错。强制单线程，慢一点但一定能跑。
    env.wasm.numThreads = 1;
    env.wasm.proxy = false;
    env.logLevel = "error";

    onProgress?.("正在准备模型…", 0.35);
    // 自己 fetch 再建会话，而不是让 ORT 去 fetch：文件缺失时 ORT 只抛
    // 一句 "Can't create session"，分不清是路径错、权限错还是文件坏。
    const modelRes = await fetch(MODEL_PATH, { cache: "force-cache" });
    if (!modelRes.ok) throw new Error("手写模型文件缺失（ppocrv5.ort）");
    const modelBuf = await modelRes.arrayBuffer();
    if (modelBuf.byteLength < 1000000) throw new Error("手写模型文件不完整，请重新安装");

    onProgress?.("正在初始化模型…", 0.55);
    session = await InferenceSession.create(modelBuf, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });

    state.status = "ready";
    state.error = "";
    onProgress?.("", 1);
  })().catch((err) => {
    state.status = "error";
    state.error = explainError(err);
    console.warn("[handwrite] 加载失败：", err);
    throw err;
  });

  try {
    await loading;
  } finally {
    loading = null;
  }
}

/* ---------------- 推理 ---------------- */

/** 离屏画布上把笔迹画出来，再读成灰度数组。 */
function rasterize(ink) {
  const off = document.createElement("canvas");
  off.width = ink.size;
  off.height = ink.size;
  const c = off.getContext("2d", { willReadFrequently: true });
  paintInk(c, ink);
  const { data } = c.getImageData(0, 0, ink.size, ink.size);
  // 只取红通道：三个通道本来就被 paintInk 画成同一色
  const gray = new Uint8ClampedArray(ink.size * ink.size);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) gray[j] = data[i];
  return { gray, w: ink.size, h: ink.size };
}

/**
 * 认一次。
 * @param {number[][][]} inkStrokes 屏幕坐标的笔迹
 * @returns {Promise<{char: string, score: number}[]>}
 */
export async function recognize(inkStrokes) {
  if (!session) throw new Error("模型还没加载");
  const ink = normalizeInk(inkStrokes);
  if (!ink) return [];

  const { gray, w, h } = rasterize(ink);
  const tensor = toTensor(gray, w, h);

  const input = new ortMod.Tensor("float32", tensor.data, [1, 3, IMAGE_HEIGHT, tensor.width]);
  const out = await session.run({ x: input });

  // 输出名模型里叫 fetch_name_0，不硬编码 —— 换模型时不至于直接崩
  const key = session.outputNames[0];
  const logits = out[key];
  const dims = logits.dims; // [1, T, C]
  const frames = dims[1];
  const classes = dims[2];
  const raw = logits.data;

  // 逐帧 softmax 再取峰值：CTC 的 blank 概率要在同一帧内比较才有意义。
  // 这里不用 softmax() 而是就地算 —— 每帧 18385 维，48 帧就是 88 万个
  // 元素，用返回新数组的版本等于每次识别多分配 3.5 MB 临时内存，
  // 连写几个字就会看到 GC 抖动。
  const probs = new Float32Array(frames * classes);
  for (let t = 0; t < frames; t += 1) {
    const base = t * classes;
    let max = -Infinity;
    for (let c = 0; c < classes; c += 1) {
      const v = raw[base + c];
      if (v > max) max = v;
    }
    let sum = 0;
    for (let c = 0; c < classes; c += 1) {
      const e = Math.exp(raw[base + c] - max);
      probs[base + c] = e;
      sum += e;
    }
    for (let c = 0; c < classes; c += 1) probs[base + c] /= sum;
  }

  const picked = ctcCandidates(probs, frames, classes, {
    limit: 9,
    allowed: vocab.allowed,
  });

  return picked
    .map((it) => ({ char: vocab.chars[it.index] || "", score: it.score }))
    .filter((it) => it.char);
}

/* ---------------- 画布 ---------------- */

function layoutCanvas() {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w;
  canvas.height = h;
  redraw();
}

function redraw() {
  if (!ctx || !canvas) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#111";
  ctx.fillStyle = "#111";
  ctx.lineWidth = Math.max(2.5, 7 * dpr);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const seq of strokes) {
    if (!seq.length) continue;
    if (seq.length === 1) {
      ctx.beginPath();
      ctx.arc(seq[0][0], seq[0][1], ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(seq[0][0], seq[0][1]);
    for (let i = 1; i < seq.length; i += 1) ctx.lineTo(seq[i][0], seq[i][1]);
    ctx.stroke();
  }

  // 当前这一笔
  if (current && current.length) {
    ctx.beginPath();
    ctx.moveTo(current[0][0], current[0][1]);
    for (let i = 1; i < current.length; i += 1) ctx.lineTo(current[i][0], current[i][1]);
    ctx.stroke();
  }
}

function pointOf(e) {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
}

function onDown(e) {
  if (state.busy) return;
  e.preventDefault();
  canvas.setPointerCapture?.(e.pointerId);
  current = [pointOf(e)];
  clearTimeout(idleTimer);
  redraw();
}

function onMove(e) {
  if (!current) return;
  e.preventDefault();
  const p = pointOf(e);
  const last = current[current.length - 1];
  // 太密的点不存：既省内存，也让后续归一化不受抖动影响
  if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 2 * dpr) return;
  current.push(p);
  redraw();
}

function onUp(e) {
  if (!current) return;
  e?.preventDefault?.();
  if (current.length) strokes.push(current);
  current = null;
  redraw();
  clearTimeout(idleTimer);
  // 写完停一下就认，不用用户再点一次按钮
  idleTimer = setTimeout(() => {
    runRecognize().catch(() => {});
  }, IDLE_RECOGNIZE_MS);
}

async function runRecognize() {
  if (state.busy) return;
  if (!strokes.length) {
    state.cands = [];
    renderCands();
    return;
  }
  state.busy = true;
  setHint("识别中…");
  try {
    const res = await recognize(strokes);
    state.cands = res;
    renderCands();
    setHint(res.length ? "" : "没认出来，再写写看");
  } catch (err) {
    console.warn("[handwrite] 识别失败：", err);
    setHint("识别失败：" + (err?.message || err));
  } finally {
    state.busy = false;
  }
}

/* ---------------- DOM ---------------- */

let hintEl = null;
let candsEl = null;
let rootEl = null;

function setHint(text, action) {
  if (!hintEl) return;
  hintEl.textContent = "";
  if (!text) {
    hintEl.hidden = true;
    hintEl.classList.remove("hw__hint--act");
    return;
  }
  hintEl.hidden = false;
  const label = document.createElement("span");
  label.className = "hw__hint-txt";
  label.textContent = text;
  // 面板只有一行宽，长原因会被省略号吃光；title 让用户还能看到全文
  label.title = text;
  hintEl.appendChild(label);

  if (!action) {
    hintEl.classList.remove("hw__hint--act");
    return;
  }
  hintEl.classList.add("hw__hint--act");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hw__retry";
  btn.dataset.act = action.id || "retry";
  btn.textContent = action.label;
  btn.addEventListener("click", (e) => {
    // 按钮在面板里，别让点击冒泡到画布/键盘
    e.preventDefault();
    e.stopPropagation();
    action.onClick();
  });
  hintEl.appendChild(btn);
}

function renderCands() {
  if (!candsEl) return;
  candsEl.textContent = "";
  if (!state.cands.length) return;
  state.cands.forEach((it, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cand";
    b.dataset.index = String(i);
    b.textContent = it.char;
    // 第一名标绿一点，让人一眼看到"最可能是这个"
    if (i === 0) b.dataset.kind = "whole";
    b.addEventListener("click", () => pick(it.char));
    candsEl.appendChild(b);
  });
}

function pick(ch) {
  if (!ch) return;
  dom?.onPick?.(ch);
  clearAll();
}

export function clearAll() {
  strokes = [];
  current = null;
  state.cands = [];
  clearTimeout(idleTimer);
  redraw();
  renderCands();
  setHint("");
}

/**
 * 建面板。只在第一次调用时创建，之后复用同一批 DOM ——
 * 否则每次 state 变化重建面板，用户写了一半的字就没了。
 */
export function createPanel({ onPick } = {}) {
  if (dom) {
    dom.onPick = onPick || dom.onPick;
    return dom.root;
  }

  const root = document.createElement("div");
  root.className = "hw";

  const head = document.createElement("div");
  head.className = "hw__head";
  candsEl = document.createElement("div");
  candsEl.className = "hw__cands";
  hintEl = document.createElement("div");
  hintEl.className = "hw__hint";
  hintEl.hidden = true;
  head.appendChild(candsEl);
  head.appendChild(hintEl);
  root.appendChild(head);

  const stage = document.createElement("div");
  stage.className = "hw__stage";
  canvas = document.createElement("canvas");
  canvas.className = "hw__canvas";
  const grid = document.createElement("div");
  grid.className = "hw__grid";
  stage.appendChild(canvas);
  stage.appendChild(grid);
  root.appendChild(stage);

  // 这里曾经有条「退一笔 / 清空」按钮，0.57.2 去掉了 ——
  // 键盘只有 290dp 高，那 28px 让给画布比给两个按钮值：
  // 画布高 40px，写「国」「圆」这种字才不用把笔画挤在一起。
  // 清空改由"关掉面板"承担（见 onPanelHidden），上屏本来就会自动清。

  ctx = canvas.getContext("2d", { willReadFrequently: true });

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", (e) => {
    // 手指滑出画布也要收笔，否则这一笔永远悬着
    if (current) onUp(e);
  });

  dom = { root, onPick: onPick || null };

  // 面板刚插进 DOM 时还没有尺寸，等一帧再算
  requestAnimationFrame(() => requestAnimationFrame(layoutCanvas));
  window.addEventListener("resize", layoutCanvas);

  setHint("");
  return root;
}

/**
 * 起一次加载。失败后不锁死：错误状态可以原地重试，
 * 不用关掉键盘再开（很多人根本不知道要那样做）。
 */
function startLoad() {
  if (state.status === "error") {
    state.status = "idle";
    state.error = "";
  }
  ensureModel((msg) => setHint(msg)).catch((err) => {
    // ensureModel 已经把原因翻译成人话了；这里只负责把按钮摆上
    setHint("识别引擎加载失败：" + (state.error || explainError(err)), {
      id: "retry",
      label: "重试",
      onClick: startLoad,
    });
  });
}

/** 面板每次显示都要重算画布尺寸（键盘高度可能变了）。 */
export function onPanelShown() {
  requestAnimationFrame(() => requestAnimationFrame(layoutCanvas));
  if (state.status === "idle" || state.status === "error") startLoad();
}

/**
 * 面板收起时调一次：把画布清干净。
 *
 * 去掉「清空」按钮之后，这是唯一的"重来"入口 ——
 * 写错了字，点 ✕ 关掉再点「手写」，出来就是白板。
 * 不清的话，错笔画会一直攒在画布上，下一个字被前面的残笔带歪，
 * 而用户手上没有任何办法擦掉它。
 */
export function onPanelHidden() {
  if (!dom) return;
  clearAll();
}

/** 供测试与调试查看内部状态。 */
export function _debug() {
  return {
    status: state.status,
    error: state.error,
    cands: state.cands.length,
    strokes: strokes.length,
    wasm: wasmSupport(),
  };
}

/* 测试钩子：浏览器测试要直接喂笔迹数据，绕开手势 ——
   用鼠标画"中"画不准，但喂 MMH 的标准笔迹就能精确验证识别链路。 */
if (typeof window !== "undefined") {
  window.__dshHandwrite = { recognize, normalizeInk, clearAll, _debug };
}
