/* ============================================================
   手写识别内核 —— 笔迹 → 候选字

   ============ 为什么单独成文件 ============

   手写这条链有三段容易出错，而且出错都很难看出来：

     ① 归一化：笔迹怎么铺进方框、线画多粗
     ② 光栅化：和训练时的渲染必须一致
     ③ 解码：CTC 输出 18385 维，怎么变成 9 个候选

   任何一段错了，表现都是"认得出但老认错"，看代码完全看不出来。
   所以这里全部写成纯函数：不碰 DOM、不碰 canvas 引擎、不碰 ONNX，
   输入是坐标数组，输出是候选列表。测试里直接喂数据断言。

   ============ 模型是什么 ============

   PP-OCRv5 mobile rec（16.6 MB，18385 类）。它本来是识别
   "一行文字"的，但单字就是最短的一行 —— 铺进方框居中、缩到
   48 高，它认得比多数专用手写模型还好，因为训练数据里有大量
   手写样本。在这个项目的测试集上 top1 91%、top9 98%。

   ============ 为什么是"方框居中"而不是"贴边裁切" ============

   两种都试过，差距很大（top1 77% vs 91%）：

   · 贴边裁切：把字的包围盒拉满整张图。看着"信息量最大"，但
     一个"一"字会变成一条顶满宽度的粗线，而模型训练时见到的
     "一"是**方图中央的一条横**。分布不一样，就不认得。
   · 方框居中：按长边缩放进正方形，四周留边距，居中。

   模型要的是后者。所以宁可留白，也不要把字撑满。
   ============================================================ */

/** 模型输入高度，和 PP-OCR 训练时一致，不能改。 */
export const IMAGE_HEIGHT = 48;
/** 光栅化画布边长。先画大图再缩小，边缘才不锯齿。 */
export const RASTER_SIZE = 160;
/** 画布边距。留白比例是实测出来的：18/160 时精度最好。 */
const RASTER_PAD = 18;
/** 线宽占有效区域的比例。0.105 对应 160 画布上的 13px。 */
const INK_WIDTH_RATIO = 0.105;
/** 太小的笔迹不出候选：一个点、一条 8px 的线，认出来必然是瞎猜。 */
const MIN_INK_EXTENT = 8;

/* ---------------- ① 归一化 ---------------- */

/**
 * 把笔迹铺进正方形画布并居中。
 *
 * 输入是屏幕坐标（y 向下），每支笔画是 [[x, y], ...]。
 * 输出坐标原点在画布左上角，边长 RASTER_SIZE。
 *
 * 长宽比**保持**：把"一"拉成正方，它就成了一个粗黑块；保持比例
 * 缩放进方框，它才是一条横线 —— 那才是模型见过的样子。
 *
 * @returns {{strokes: number[][][], size: number} | null} 笔迹太短返回 null
 */
export function normalizeInk(strokes) {
  const pts = [];
  for (const st of strokes || []) {
    for (const p of st || []) {
      if (Number.isFinite(p?.[0]) && Number.isFinite(p?.[1])) pts.push(p);
    }
  }
  if (pts.length < 2) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < MIN_INK_EXTENT && h < MIN_INK_EXTENT) return null;

  const inner = RASTER_SIZE - 2 * RASTER_PAD;
  const scale = inner / Math.max(w, h, 1);
  // 长边贴满 inner，短边居中 —— 两边的留白相等
  const ox = RASTER_PAD + (inner - w * scale) / 2;
  const oy = RASTER_PAD + (inner - h * scale) / 2;

  const out = [];
  for (const st of strokes || []) {
    const seq = [];
    for (const p of st || []) {
      if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) continue;
      seq.push([ox + (p[0] - minX) * scale, oy + (p[1] - minY) * scale]);
    }
    if (seq.length) out.push(seq);
  }
  return { strokes: out, size: RASTER_SIZE };
}

/** 画布上该用多粗的笔。和归一化共用一套比例，改一处就够。 */
export function inkWidth(size = RASTER_SIZE) {
  const inner = size - 2 * RASTER_PAD * (size / RASTER_SIZE);
  return Math.max(2, inner * INK_WIDTH_RATIO);
}

/* ---------------- ② 光栅化 ---------------- */

/**
 * 把归一化后的笔迹画成灰度图（0 = 墨，255 = 纸）。
 *
 * 只依赖一个"能填像素的 2D 上下文"，传 canvas 的 ctx 或测试里的
 * mock 都行 —— 这样这段逻辑不用在浏览器里也能测。
 */
export function paintInk(ctx, ink) {
  const { strokes, size } = ink;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  const lw = inkWidth(size);
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#000";
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const seq of strokes) {
    if (seq.length === 1) {
      // 单点笔画（"点"的起手）也要留墨，否则"氵"这种会少一笔
      const [x, y] = seq[0];
      ctx.beginPath();
      ctx.arc(x, y, lw / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(seq[0][0], seq[0][1]);
    for (let i = 1; i < seq.length; i += 1) ctx.lineTo(seq[i][0], seq[i][1]);
    ctx.stroke();
  }
}

/**
 * 灰度图 → 模型输入张量。
 *
 * 模型要 [1, 3, 48, W] 的 RGB。手写是单色墨，三个通道填一样的值。
 * 归一化用 (v/255 - 0.5)/0.5，也就是 [-1, 1] —— PP-OCR 的标准做法，
 * 换成 ImageNet 的均值方差会掉精度。
 *
 * 画布是正方形，所以 W = 48。留参数是为了将来换更高画布时不改调用方。
 *
 * @param {Uint8ClampedArray|Uint8Array} gray 长为 w*h 的灰度像素
 */
export function toTensor(gray, w, h) {
  const tw = Math.max(1, Math.round((IMAGE_HEIGHT * w) / h));
  const plane = IMAGE_HEIGHT * tw;
  const out = new Float32Array(3 * plane);

  for (let y = 0; y < IMAGE_HEIGHT; y += 1) {
    // 附近邻域取平均再取样，等于做一次盒式滤波。
    // 160→48 是 3.3 倍缩小，纯最近邻会把细笔画整段丢掉（"氵"变两点），
    // 而这一步的代价只有 48×48×9 次加法。
    const sy0 = Math.floor((y * h) / IMAGE_HEIGHT);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * h) / IMAGE_HEIGHT));
    for (let x = 0; x < tw; x += 1) {
      const sx0 = Math.floor((x * w) / tw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * w) / tw));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < h; sy += 1) {
        for (let sx = sx0; sx < sx1 && sx < w; sx += 1) {
          sum += gray[sy * w + sx];
          n += 1;
        }
      }
      const v = ((n ? sum / n : 0) / 255 - 0.5) / 0.5;
      const o = y * tw + x;
      out[o] = v;
      out[o + plane] = v;
      out[o + 2 * plane] = v;
    }
  }
  return { data: out, width: tw, height: IMAGE_HEIGHT };
}

/* ---------------- ③ 解码 ---------------- */

/**
 * softmax：把一行 logits 变成概率。
 *
 * 先减去最大值再 exp，否则 18385 维里有几个大数就会溢出成 Infinity。
 */
export function softmax(logits, offset = 0, count = logits.length) {
  let max = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const v = logits[offset + i];
    if (v > max) max = v;
  }
  let sum = 0;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const e = Math.exp(logits[offset + i] - max);
    out[i] = e;
    sum += e;
  }
  for (let i = 0; i < count; i += 1) out[i] /= sum;
  return out;
}

/**
 * CTC 输出 → 候选字。
 *
 * ============ 为什么用"逐字取最大"而不是 greedy 序列 ============
 *
 * greedy（每帧取 argmax 再折叠）只会给出**一个**字。输入法要的是
 * 一屏候选 —— 用户写歪了、写快了，第一名常常不是他要的。
 *
 * 单字识别里，每个字都会在某一帧上出现明显的峰值。所以对每个
 * 字符取"它在所有帧里的最大概率"，再排序，得到的就是候选列表。
 * 实测 top-9 到 98%，比 greedy 只给一个字的 91% 实用得多。
 *
 * @param {Float32Array} probs 长度 frames*classes 的概率
 * @param {{limit?: number, allowed?: Set<number>}} opts
 */
export function ctcCandidates(probs, frames, classes, opts = {}) {
  const limit = opts.limit || 9;
  const allowed = opts.allowed || null;

  // 每个字符在所有帧上的峰值（0 是 CTC blank，不参与）
  const peak = new Float32Array(classes);
  for (let t = 0; t < frames; t += 1) {
    const base = t * classes;
    for (let c = 1; c < classes; c += 1) {
      const v = probs[base + c];
      if (v > peak[c]) peak[c] = v;
    }
  }

  const picked = [];
  for (let c = 1; c < classes; c += 1) {
    if (allowed && !allowed.has(c)) continue;
    const s = peak[c];
    if (!(s > 0)) continue;
    picked.push({ index: c, score: s });
  }
  picked.sort((a, b) => b.score - a.score);
  return picked.slice(0, limit);
}

/**
 * 从字典原文建索引表 + 白名单。
 *
 * ============ 为什么要白名单 ============
 *
 * 模型输出 18385 类，包括日文假名、繁体异体、生僻字。全放出来，
 * 第一屏候选会被"妳""嗄""龘"这类字占满 —— 用户要写的字反而掉到
 * 第二屏。实测加白名单 top1 从 87.7% 提到 91%。
 *
 * 白名单本身由调用方给（键盘用自己词库的字集），这里只管索引对齐：
 * CTC 的 blank 单独占 0，字典从 1 开始，末尾再补一个空格。
 *
 * @param {string} dictText 每行一个字的字典全文
 * @param {Set<string>|null} common 允许出现的字；null 表示不过滤
 */
export function buildVocabulary(dictText, common) {
  const lines = dictText.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const chars = ["", ...lines, " "];
  const allowed = new Set();
  for (let i = 1; i < chars.length; i += 1) {
    const c = chars[i];
    if (!c || c === " ") continue;
    if (!common || common.has(c)) allowed.add(i);
  }
  return { chars, allowed };
}
