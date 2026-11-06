/* ============================================================
   PDF 生成 — 纯 JS，无第三方依赖

   ============ 定位：原语，不是模板 ============
   不做「封面 + 目录 + 章节」那种固定版式。给模型的是一组排版原语
   （标题/段落/列表/引用/代码/表格/分隔线/分页/图片），由它自己组合。
   AI 想放什么、按什么顺序放，这里不替它决定。

   ============ 中文字体怎么办 ============
   PDF 里不嵌字体，中文就是豆腐块；嵌完整中文字体，每个文件 2 MB。
   做法：随包带一份 Noto Sans SC（OFL），生成时按实际用到的字做子集，
   只嵌入这些字形 —— 一份 30 页中文报告的字体通常 40–90 KB。
   箭头、勾选、方块这类符号 Noto Sans SC 没有，再用一份 DejaVu 符号子集补上。

   ============ 边界 ============
   · 不支持彩色 emoji（两份字体里都没有，会落到 .notdef 并报告）
   · 图片只收 JPEG 与无透明通道的 PNG
   · 不做图文混排环绕、不做分栏、不做脚注
   ============================================================ */

const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const INK = [0.1, 0.12, 0.15];
const BODY = [0.16, 0.18, 0.21];
const MUTED = [0.42, 0.45, 0.5];
const ACCENT = [0.13, 0.35, 0.72];
const LINE = [0.85, 0.87, 0.9];
const SOFT = [0.955, 0.965, 0.975];
const VERTICAL_BAR = [0.78, 0.81, 0.86];
const CODE_BG = [0.965, 0.97, 0.978];
const CODE_FG = [0.24, 0.27, 0.32];

/* ---------------- TTF ---------------- */

const tag = (dv, off) => String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));

export function parseTTF(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < numTables; i += 1) {
    const p = 12 + i * 16;
    tables[tag(dv, p)] = { offset: dv.getUint32(p + 8), length: dv.getUint32(p + 12) };
  }
  const unitsPerEm = dv.getUint16(tables.head.offset + 18);
  const indexToLocFormat = dv.getInt16(tables.head.offset + 50);
  const numGlyphs = dv.getUint16(tables.maxp.offset + 4);
  const numberOfHMetrics = dv.getUint16(tables.hhea.offset + 34);
  const ascent = dv.getInt16(tables.hhea.offset + 4);
  const descent = dv.getInt16(tables.hhea.offset + 6);

  const loca = [];
  const locaOff = tables.loca.offset;
  for (let i = 0; i <= numGlyphs; i += 1) {
    loca.push(indexToLocFormat === 0 ? dv.getUint16(locaOff + i * 2) * 2 : dv.getUint32(locaOff + i * 4));
  }
  const glyfOff = tables.glyf.offset;

  const advance = (gid) => {
    if (!numberOfHMetrics) return unitsPerEm * 0.5;
    const i = Math.min(gid, numberOfHMetrics - 1);
    return dv.getUint16(tables.hmtx.offset + i * 4);
  };

  return {
    bytes,
    tables,
    unitsPerEm: unitsPerEm || 1000,
    numGlyphs,
    ascent,
    descent,
    advance,
    glyph: (gid) =>
      gid < 0 || gid >= numGlyphs ? new Uint8Array(0) : bytes.subarray(glyfOff + loca[gid], glyfOff + loca[gid + 1]),
    cmap: parseCmap(dv, tables.cmap.offset),
    bbox: [
      dv.getInt16(tables.head.offset + 36),
      dv.getInt16(tables.head.offset + 38),
      dv.getInt16(tables.head.offset + 40),
      dv.getInt16(tables.head.offset + 42),
    ],
  };
}

function parseCmap(dv, base) {
  const map = new Map();
  const n = dv.getUint16(base + 2);
  const subtables = [];
  for (let i = 0; i < n; i += 1) {
    const p = base + 4 + i * 8;
    subtables.push({
      platform: dv.getUint16(p),
      encoding: dv.getUint16(p + 2),
      offset: base + dv.getUint32(p + 4),
    });
  }
  // 只认 format 4 / 12。format 14 是变体选择子表（(0,5) 很常见），
  // 按编码挑会把整张表读空 —— 之前就踩过这个坑。
  const withFormat = subtables.map((s) => ({ ...s, format: dv.getUint16(s.offset) }));
  const pick =
    withFormat.find((s) => s.platform === 3 && s.encoding === 10 && s.format === 12) ||
    withFormat.find((s) => s.platform === 3 && s.encoding === 1 && s.format === 4) ||
    withFormat.find((s) => s.format === 12) ||
    withFormat.find((s) => s.format === 4);
  if (!pick) return map;
  const p = pick.offset;
  if (pick.format === 4) {
    const segX2 = dv.getUint16(p + 6);
    const segs = segX2 / 2;
    const endBase = p + 14;
    const startBase = endBase + segX2 + 2;
    const deltaBase = startBase + segX2;
    const rangeBase = deltaBase + segX2;
    for (let i = 0; i < segs; i += 1) {
      const end = dv.getUint16(endBase + i * 2);
      const start = dv.getUint16(startBase + i * 2);
      const delta = dv.getInt16(deltaBase + i * 2);
      const rangeOffset = dv.getUint16(rangeBase + i * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end && c !== 0xffff; c += 1) {
        let gid;
        if (rangeOffset === 0) gid = (c + delta) & 0xffff;
        else {
          gid = dv.getUint16(rangeBase + i * 2 + rangeOffset + (c - start) * 2);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid) map.set(c, gid);
      }
    }
  } else {
    const groups = dv.getUint32(p + 12);
    for (let i = 0; i < groups; i += 1) {
      const q = p + 16 + i * 12;
      const start = dv.getUint32(q);
      const end = dv.getUint32(q + 4);
      const gid = dv.getUint32(q + 8);
      for (let c = start; c <= end && c - start < 70000; c += 1) map.set(c, gid + (c - start));
    }
  }
  return map;
}

/** 复合字形里引用的子字形也要一起收进来，否则轮廓是空的。 */
function compositeRefs(glyphBytes) {
  const refs = [];
  if (glyphBytes.length < 10) return refs;
  const dv = new DataView(glyphBytes.buffer, glyphBytes.byteOffset, glyphBytes.byteLength);
  if (dv.getInt16(0) >= 0) return refs;
  let i = 10;
  for (let guard = 0; guard < 64 && i + 4 <= glyphBytes.length; guard += 1) {
    const flags = dv.getUint16(i);
    refs.push(dv.getUint16(i + 2));
    i += 4;
    i += flags & 0x0001 ? 4 : 2;
    if (flags & 0x0008) i += 2;
    else if (flags & 0x0040) i += 4;
    else if (flags & 0x0080) i += 8;
    if (!(flags & 0x0020)) break;
  }
  return refs;
}

function buildCmap4(pairs) {
  const segs = [];
  for (const [cp, gid] of pairs) {
    if (cp > 0xffff) continue;
    const last = segs[segs.length - 1];
    if (last && cp === last.end + 1 && gid === last.gidStart + (cp - last.start)) last.end = cp;
    else segs.push({ start: cp, end: cp, gidStart: gid });
  }
  segs.push({ start: 0xffff, end: 0xffff, gidStart: 0 });
  const segCount = segs.length;
  const length = 16 + segCount * 8;
  const bytes = new Uint8Array(length);
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0, 4);
  dv.setUint16(2, length);
  dv.setUint16(4, 0);
  dv.setUint16(6, segCount * 2);
  const entrySelector = Math.floor(Math.log2(segCount));
  dv.setUint16(8, 2 * Math.pow(2, entrySelector));
  dv.setUint16(10, segCount * 2 - 2 * Math.pow(2, entrySelector));
  let o = 14;
  for (const s of segs) {
    dv.setUint16(o, s.end);
    o += 2;
  }
  o += 2;
  for (const s of segs) {
    dv.setUint16(o, s.start);
    o += 2;
  }
  for (const s of segs) {
    dv.setUint16(o, (s.gidStart - s.start) & 0xffff);
    o += 2;
  }
  for (let i = 0; i < segCount; i += 1) {
    dv.setUint16(o, 0);
    o += 2;
  }
  return bytes;
}

function remapComposite(glyphBytes, oldToNew) {
  if (glyphBytes.length < 10) return glyphBytes;
  const out = glyphBytes.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (dv.getInt16(0) >= 0) return out;
  let i = 10;
  for (let guard = 0; guard < 64 && i + 4 <= out.length; guard += 1) {
    const flags = dv.getUint16(i);
    const ng = oldToNew.get(dv.getUint16(i + 2));
    if (ng != null) dv.setUint16(i + 2, ng);
    i += 4;
    i += flags & 0x0001 ? 4 : 2;
    if (flags & 0x0008) i += 2;
    else if (flags & 0x0040) i += 4;
    else if (flags & 0x0080) i += 8;
    if (!(flags & 0x0020)) break;
  }
  return out;
}

/** 子集化：只保留用到的码位，返回可直接写进 PDF 的 TTF 字节。 */
export function subsetFont(ttf, codepoints) {
  const wanted = [...new Set(codepoints)].filter((cp) => ttf.cmap.has(cp)).sort((a, b) => a - b);
  const order = [];
  const seen = new Set();
  const push = (g) => {
    if (seen.has(g)) return;
    seen.add(g);
    order.push(g);
  };
  for (const cp of wanted) push(ttf.cmap.get(cp));
  for (let i = 0; i < order.length; i += 1) {
    for (const ref of compositeRefs(ttf.glyph(order[i]))) push(ref);
  }

  const newGid = new Map();
  let next = 1;
  for (const g of order) {
    if (g === 0 || newGid.has(g)) continue;
    newGid.set(g, next);
    next += 1;
  }
  const numGlyphs = next;

  const glyphs = new Array(numGlyphs).fill(null);
  glyphs[0] = new Uint8Array(0);
  for (const [oldG, newG] of newGid) glyphs[newG] = remapComposite(ttf.glyph(oldG), newGid);

  const parts = [];
  const locaOffsets = [0];
  let total = 0;
  for (let i = 0; i < numGlyphs; i += 1) {
    let g = glyphs[i] || new Uint8Array(0);
    if (g.length % 4) {
      const pad = new Uint8Array(g.length + (4 - (g.length % 4)));
      pad.set(g);
      g = pad;
    }
    parts.push(g);
    total += g.length;
    locaOffsets.push(total);
  }

  const hmtx = new Uint8Array(numGlyphs * 4);
  const hdv = new DataView(hmtx.buffer);
  for (const [oldG, newG] of newGid) hdv.setUint16(newG * 4, ttf.advance(oldG));

  const cmapPairs = wanted.map((cp) => [cp, newGid.get(ttf.cmap.get(cp)) || 0]).filter((p) => p[1]);
  const cmapSub = buildCmap4(cmapPairs);
  const cmap = new Uint8Array(12 + cmapSub.length);
  const cdv = new DataView(cmap.buffer);
  cdv.setUint16(4, 3);
  cdv.setUint16(6, 1);
  cdv.setUint32(8, 12);
  cmap.set(cmapSub, 12);

  const head = ttf.bytes.slice(ttf.tables.head.offset, ttf.tables.head.offset + ttf.tables.head.length);
  const hdvHead = new DataView(head.buffer, head.byteOffset, head.byteLength);
  hdvHead.setUint32(8, 0);
  hdvHead.setInt16(50, 1);

  const hhea = ttf.bytes.slice(ttf.tables.hhea.offset, ttf.tables.hhea.offset + ttf.tables.hhea.length);
  new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).setUint16(34, numGlyphs);

  const maxp = ttf.bytes.slice(ttf.tables.maxp.offset, ttf.tables.maxp.offset + ttf.tables.maxp.length);
  new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).setUint16(4, numGlyphs);

  const loca = new Uint8Array((numGlyphs + 1) * 4);
  const ldv = new DataView(loca.buffer);
  locaOffsets.forEach((v, i) => ldv.setUint32(i * 4, v));

  const outTables = { cmap, glyf: concat(parts), head, hhea, hmtx, loca, maxp };
  for (const k of ["OS/2", "name", "post"]) {
    const t = ttf.tables[k];
    if (t) outTables[k] = ttf.bytes.slice(t.offset, t.offset + t.length);
  }

  const widths = new Map();
  for (const [oldG, newG] of newGid) widths.set(newG, ttf.advance(oldG));

  return {
    bytes: buildSfnt(outTables),
    gidOf: (cp) => {
      const g = ttf.cmap.get(cp);
      return g == null ? 0 : newGid.get(g) || 0;
    },
    widths,
    unitsPerEm: ttf.unitsPerEm,
    ascent: ttf.ascent,
    descent: ttf.descent,
    bbox: ttf.bbox,
    numGlyphs,
  };
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function buildSfnt(tables) {
  const names = Object.keys(tables).sort();
  let size = 12 + names.length * 16;
  const records = [];
  for (const name of names) {
    const data = tables[name];
    const padded = (data.length + 3) & ~3;
    records.push({ name, offset: size, length: data.length, data });
    size += padded;
  }
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000);
  dv.setUint16(4, names.length);
  const entrySelector = Math.floor(Math.log2(names.length));
  dv.setUint16(6, 16 * Math.pow(2, entrySelector));
  dv.setUint16(8, entrySelector);
  dv.setUint16(10, names.length * 16 - 16 * Math.pow(2, entrySelector));
  records.forEach((r, i) => {
    const p = 12 + i * 16;
    for (let k = 0; k < 4; k += 1) out[p + k] = r.name.charCodeAt(k);
    dv.setUint32(p + 4, checksum(r.data));
    dv.setUint32(p + 8, r.offset);
    dv.setUint32(p + 12, r.length);
    out.set(r.data, r.offset);
  });
  return out;
}

function checksum(data) {
  let sum = 0;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i + 3 < data.length; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
  if (data.length % 4) {
    let tail = 0;
    const start = data.length - (data.length % 4);
    for (let i = 0; i < 4; i += 1) tail = (tail << 8) | (data[start + i] || 0);
    sum = (sum + tail) >>> 0;
  }
  return sum;
}

/* ---------------- 字体加载 ---------------- */

let fontPromise = null;
let symbolPromise = null;
let fontOverride = null;
let symbolOverride = null;

export function setFontBytes(main, symbols = null) {
  fontOverride = main;
  symbolOverride = symbols;
  fontPromise = null;
  symbolPromise = null;
}

/**
 * 字体直接以 .ttf 存放，不再套一层 gzip。
 * 原因：Android 打包时 assets 里的 .gz 会被 aapt 解压成同名 .ttf，
 * 前端按 `xxx.ttf.gz` 去 fetch 就是 404 —— 手机上生成 PDF 会全部失败。
 * APK 的 assets 本来就会压缩，套 gzip 也省不下空间。
 */
async function fetchFont(name) {
  const url = new URL(`./fonts/${name}`, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`字体加载失败：${name} HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function loadFont() {
  if (fontOverride) return parseTTF(fontOverride);
  if (!fontPromise) fontPromise = fetchFont("noto-sans-sc.ttf").then(parseTTF);
  return fontPromise;
}

export async function loadSymbolFont() {
  if (symbolOverride) return parseTTF(symbolOverride);
  if (!symbolPromise) {
    symbolPromise = fetchFont("dejavu-symbols.ttf")
      .then(parseTTF)
      .catch(() => null);
  }
  return symbolPromise;
}

/* ---------------- 文本编码与度量 ---------------- */

function hex4(gid) {
  return gid.toString(16).padStart(4, "0");
}

/** 主字体 + 符号字体的分工：主字体缺哪个字，就交给符号字体。 */
function makeFontSet(fonts) {
  const list = fonts.filter(Boolean);
  const pick = (cp) => {
    for (const f of list) if (f.subset.gidOf(cp)) return f;
    return list[0];
  };
  const measureText = (text, size) => {
    let w = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0) === 0x3000 ? 0x20 : ch.codePointAt(0);
      const f = pick(cp);
      const gid = f.subset.gidOf(cp);
      w += ((f.subset.widths.get(gid) || f.subset.unitsPerEm * 0.5) / f.subset.unitsPerEm) * size;
    }
    return w;
  };
  const runs = (text) => {
    const out = [];
    let cur = null;
    let missing = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const tcp = cp === 0x3000 ? 0x20 : cp;
      const f = pick(tcp);
      const gid = f.subset.gidOf(tcp);
      if (!gid) missing += ch;
      if (cur && cur.font === f) {
        cur.text += ch;
        cur.hex += hex4(gid);
      } else {
        cur = { font: f, text: ch, hex: hex4(gid) };
        out.push(cur);
      }
    }
    return { runs: out.filter((r) => r.text), missing };
  };
  return { list, pick, measureText, runs, main: list[0] };
}

/* ---------------- 折行 ---------------- */

const NO_LINE_START = "，。、；：？！）】》」』〉’”%‰℃·…—.,;:?!)]}>";
const NO_LINE_END = "（【《「『〈‘“([{<";

function tokenize(text) {
  const tokens = [];
  const re = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]|[^\s\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]+|\s+/g;
  let m;
  while ((m = re.exec(text))) tokens.push(m[0]);
  return tokens;
}

/** 折行：中文按字断，英文按词断，做最基本的避头尾。 */
function wrapText(text, maxWidth, size, fs) {
  const lines = [];
  for (const rawLine of String(text).split("\n")) {
    if (!rawLine.trim()) {
      lines.push("");
      continue;
    }
    const tokens = tokenize(rawLine);
    let cur = "";
    let curW = 0;
    const pushLine = () => {
      lines.push(cur.replace(/\s+$/, ""));
      cur = "";
      curW = 0;
    };
    for (const tk of tokens) {
      if (/^\s+$/.test(tk)) {
        if (!cur) continue;
        const w = fs.measureText(" ", size);
        if (curW + w <= maxWidth) {
          cur += " ";
          curW += w;
        }
        continue;
      }
      const w = fs.measureText(tk, size);
      if (curW + w <= maxWidth + 0.01) {
        cur += tk;
        curW += w;
        continue;
      }
      if (w > maxWidth) {
        for (const ch of tk) {
          const cw = fs.measureText(ch, size);
          if (curW + cw > maxWidth) pushLine();
          cur += ch;
          curW += cw;
        }
        continue;
      }
      if (NO_LINE_START.includes(tk) && cur.length > 1) {
        cur += tk;
        curW += w;
        pushLine();
        continue;
      }
      if (NO_LINE_END.includes(cur.slice(-1)) && cur.length > 1) {
        const last = cur.slice(-1);
        cur = cur.slice(0, -1);
        pushLine();
        cur = last + tk;
        curW = fs.measureText(cur, size);
        continue;
      }
      pushLine();
      cur = tk;
      curW = w;
    }
    if (cur.trim()) lines.push(cur.replace(/\s+$/, ""));
    else if (!lines.length) lines.push("");
  }
  return lines;
}

/* ---------------- PDF 构建 ---------------- */

const num = (v) => (Math.round(v * 1000) / 1000).toString();
const rgb = (c, op = "rg") => `${num(c[0])} ${num(c[1])} ${num(c[2])} ${op}`;
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

class Doc {
  constructor(fs, opts = {}) {
    this.fs = fs;
    this.opts = opts;
    this.size = PAGE_SIZES[opts.pageSize] || PAGE_SIZES.a4;
    this.margin = opts.margin ?? 56;
    this.width = this.size[0] - this.margin * 2;
    this.top = this.size[1] - this.margin;
    this.bottom = this.margin + (opts.footer === false ? 0 : 24);
    this.pages = [];
    this.ops = [];
    this.y = this.top;
    this.images = [];
    this.missing = new Set();
    this.newPage();
  }

  newPage() {
    if (this.ops.length) this.pages.push(this.ops);
    this.ops = [];
    this.y = this.top;
  }

  need(h) {
    if (this.y - h < this.bottom) this.newPage();
  }

  line(x, y, x2, y2, color = LINE, w = 0.7) {
    this.ops.push(`${num(w)} w ${rgb(color, "RG")} ${num(x)} ${num(y)} m ${num(x2)} ${num(y2)} l S`);
  }

  rect(x, y, w, h, fill) {
    this.ops.push(`${rgb(fill)} ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`);
  }

  text(str, x, y, { size = 10.5, color = BODY, bold = false } = {}) {
    if (!str) return;
    const { runs, missing } = this.fs.runs(str);
    for (const ch of missing) this.missing.add(ch);
    const tr = bold ? "2 Tr 0.34 w" : "0 Tr";
    let cx = x;
    for (const r of runs) {
      this.ops.push(
        `BT ${tr} ${rgb(color)} /${r.font.name} ${num(size)} Tf 1 0 0 1 ${num(cx)} ${num(y)} Tm <${r.hex}> Tj ET`
      );
      cx += this.fs.measureText(r.text, size);
    }
  }

  /** 一个文本块：自动折行、自动分页。 */
  block(text, { size = 10.5, color = BODY, leading = 1.72, gap = 0, indent = 0 } = {}) {
    const x = this.margin + indent;
    const maxW = this.width - indent;
    const lines = wrapText(text, maxW, size, this.fs);
    const lh = size * leading;
    let baseline = this.y - size * 0.82;
    for (const ln of lines) {
      if (baseline - size * 1.1 < this.bottom) {
        this.newPage();
        baseline = this.y - size * 0.82;
      }
      this.drawLine(ln, x, baseline, size, color);
      baseline -= lh;
    }
    this.y = baseline + lh - size * 0.62 - gap;
  }

  drawLine(line, x, baseline, size, color) {
    const parts = String(line).split(/(\*\*[^*]+\*\*)/g).filter((s) => s !== "");
    let cx = x;
    for (const part of parts) {
      const bold = /^\*\*[^*]+\*\*$/.test(part);
      const txt = bold ? part.slice(2, -2) : part;
      this.text(txt, cx, baseline, { size, color, bold });
      cx += this.fs.measureText(txt, size);
    }
  }

  heading(level, text) {
    const conf =
      level <= 1
        ? { size: 19, before: 2, after: 10, color: INK, rule: true }
        : level === 2
        ? { size: 14.5, before: 13, after: 6, color: INK, rule: false }
        : { size: 12, before: 9, after: 4, color: ACCENT, rule: false };
    this.y -= conf.before;
    // 标题不能孤零零留在页底 —— 至少给后面的正文留 3 行，
    // 否则会出现「标题在上一页、内容从下一页开始」的断头。
    this.need(conf.size * 1.6 + 66);
    this.block(text, { size: conf.size, color: conf.color, leading: 1.32, gap: conf.after });
    if (conf.rule) this.line(this.margin, this.y + 3, this.margin + this.width, this.y + 3, LINE, 0.6);
  }

  bullet(text, marker, indent = 12) {
    const size = 10.5;
    const gap = 12;
    const maxW = this.width - indent - gap;
    const lines = wrapText(text, maxW, size, this.fs);
    const lh = size * 1.62;
    this.need(lines.length * lh + 3);
    const top = this.y;
    this.text(marker, this.margin + 2, top - size * 0.82, { size, color: ACCENT });
    let baseline = top - size * 0.82;
    for (const ln of lines) {
      this.drawLine(ln, this.margin + indent + gap, baseline, size, BODY);
      baseline -= lh;
    }
    this.y = top - lines.length * lh - 5;
  }

  quote(text) {
    const size = 10.5;
    const lines = wrapText(text, this.width - 24, size, this.fs);
    const lh = size * 1.64;
    const h = lines.length * lh;
    this.need(h + 8);
    const top = this.y;
    let baseline = top - size * 0.82;
    for (const ln of lines) {
      this.drawLine(ln, this.margin + 18, baseline, size, MUTED);
      baseline -= lh;
    }
    this.ops.push(
      `${num(2.2)} w ${rgb(VERTICAL_BAR, "RG")} ${num(this.margin + 4)} ${num(top)} m ${num(this.margin + 4)} ${num(
        top - h + size * 0.4
      )} l S`
    );
    this.y = top - h - 2;
  }

  code(text) {
    const size = 9;
    const lh = size * 1.6;
    const pad = 9;
    const wrapped = [];
    for (const ln of String(text).split("\n")) {
      wrapped.push(...wrapText(ln || " ", this.width - pad * 2, size, this.fs));
    }
    let i = 0;
    while (i < wrapped.length) {
      const avail = Math.max(1, Math.floor((this.y - this.bottom - pad * 2) / lh));
      const slice = wrapped.slice(i, i + avail);
      const h = slice.length * lh + pad * 2;
      this.ops.push(`${rgb(CODE_BG)} ${num(this.margin)} ${num(this.y - h)} ${num(this.width)} ${num(h)} re f`);
      let baseline = this.y - pad - size * 0.82;
      for (const ln of slice) {
        this.text(ln.replace(/\t/g, "    "), this.margin + pad, baseline, { size, color: CODE_FG });
        baseline -= lh;
      }
      this.y -= h + 8;
      i += slice.length;
      if (i < wrapped.length) this.newPage();
    }
  }

  table(rows, header = true) {
    if (!rows.length) return;
    const cols = Math.max(...rows.map((r) => r.length));
    const size = 9.5;
    const pad = 6;
    const cellPad = 8;
    const natural = new Array(cols).fill(0);
    for (const row of rows) {
      for (let c = 0; c < cols; c += 1) {
        const cell = String(row[c] ?? "");
        natural[c] = Math.max(natural[c], Math.min(this.fs.measureText(cell, size) + cellPad * 2, this.width * 0.55));
      }
    }
    const total = natural.reduce((a, b) => a + b, 0);
    const scale = total > this.width ? this.width / total : 1;
    const widths = natural.map((w) => w * scale);
    const used = widths.reduce((a, b) => a + b, 0);
    if (used < this.width) widths[cols - 1] += this.width - used;

    const plan = rows.map((row) => {
      const cellLines = [];
      for (let c = 0; c < cols; c += 1) {
        cellLines.push(wrapText(String(row[c] ?? ""), widths[c] - cellPad * 2, size, this.fs).slice(0, 10));
      }
      const n = Math.max(...cellLines.map((l) => l.length), 1);
      return { cellLines, h: n * size * 1.45 + pad * 2 };
    });

    const paint = (index, isHead) => {
      const { cellLines, h } = plan[index];
      const top = this.y;
      if (isHead) this.rect(this.margin, top - h, this.width, h, SOFT);
      let cx = this.margin;
      for (let c = 0; c < cols; c += 1) {
        let baseline = top - pad - size * 0.82;
        for (const ln of cellLines[c]) {
          this.text(ln, cx + cellPad, baseline, { size, color: isHead ? INK : BODY, bold: isHead });
          baseline -= size * 1.45;
        }
        cx += widths[c];
      }
      this.line(this.margin, top - h, this.margin + this.width, top - h, LINE, 0.6);
      this.y = top - h;
    };

    for (let i = 0; i < rows.length; i += 1) {
      // 一行都放不下就换页；换页后把表头带过去，不然第二页的表格没有列名。
      const headH = header && i > 0 ? plan[0].h : 0;
      if (this.y - plan[i].h - 4 < this.bottom) {
        this.newPage();
        if (headH) paint(0, true);
      }
      paint(i, header && i === 0);
    }
    this.y -= 10;
  }

  async image(img, { width = null, caption = "" } = {}) {
    if (!img) return false;
    const maxW = this.width;
    let w = width || Math.min(maxW, img.width);
    let h = (img.height / img.width) * w;
    const maxH = this.top - this.bottom - 30;
    if (h > maxH) {
      h = maxH;
      w = (img.width / img.height) * maxH;
    }
    this.need(h + 12);
    const index = this.images.length + 1;
    this.images.push({ ...img, name: `Im${index}` });
    const x = this.margin + (this.width - w) / 2;
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.y - h)} cm /Im${index} Do Q`);
    this.y -= h + (caption ? 4 : 12);
    if (caption) this.block(caption, { size: 8.6, color: MUTED, leading: 1.4, gap: 10 });
    return true;
  }

  finish() {
    if (this.ops.length) this.pages.push(this.ops);
    if (!this.pages.length) this.pages.push([]);
    return this.pages;
  }
}

/* ---------------- 图片 ---------------- */

/** JPEG / PNG → PDF 图像字典。透明通道的 PNG 直接拒绝。 */
export function parseImage(bytes) {
  if (!bytes || bytes.length < 8) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    let i = 8;
    let ihdr = null;
    let plte = null;
    const idat = [];
    while (i + 8 <= bytes.length) {
      const len = dv.getUint32(i);
      const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
      const start = i + 8;
      if (type === "IHDR") {
        ihdr = {
          width: dv.getUint32(start),
          height: dv.getUint32(start + 4),
          depth: bytes[start + 8],
          colorType: bytes[start + 9],
          interlace: bytes[start + 12],
        };
      } else if (type === "PLTE") {
        plte = bytes.subarray(start, start + len);
      } else if (type === "IDAT") {
        idat.push(bytes.subarray(start, start + len));
      } else if (type === "IEND") break;
      i = start + len + 4;
    }
    if (!ihdr || !idat.length) return null;
    if (ihdr.interlace) return { error: "隔行扫描的 PNG 暂不支持，请另存为普通 PNG 或 JPEG" };
    if (ihdr.colorType === 4 || ihdr.colorType === 6) {
      return { error: "带透明通道的 PNG 暂不支持，请导出为 JPEG 或去掉透明" };
    }
    const channels = { 0: 1, 2: 3, 3: 1 }[ihdr.colorType];
    if (!channels) return null;
    let colorSpace = "/DeviceRGB";
    if (ihdr.colorType === 0) colorSpace = "/DeviceGray";
    if (ihdr.colorType === 3) {
      if (!plte) return null;
      let hex = "";
      for (const b of plte) hex += b.toString(16).padStart(2, "0");
      colorSpace = `[/Indexed /DeviceRGB ${plte.length / 3 - 1} <${hex}>]`;
    }
    return {
      width: ihdr.width,
      height: ihdr.height,
      colorSpace,
      filter: "/FlateDecode",
      data: concat(idat),
      decodeParms: `/DecodeParms << /Predictor 15 /Colors ${channels} /BitsPerComponent ${ihdr.depth} /Columns ${ihdr.width} >>`,
    };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    let sof = null;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        sof = { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8], comps: bytes[i + 9] };
        break;
      }
      if (len <= 0) break;
      i += 2 + len;
    }
    if (!sof) return null;
    return {
      width: sof.width,
      height: sof.height,
      colorSpace: sof.comps === 1 ? "/DeviceGray" : sof.comps === 4 ? "/DeviceCMYK" : "/DeviceRGB",
      filter: "/DCTDecode",
      data: bytes,
    };
  }
  return null;
}

/* ---------------- 块归一化 ---------------- */

/** 把 AI 可能给的几种写法统一成 block 数组。 */
export function normalizeBlocks(input) {
  if (typeof input === "string") return markdownToBlocks(input);
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const b of input) {
    if (b == null) continue;
    if (typeof b === "string") out.push({ type: "p", text: b });
    else out.push({ ...b, type: String(b.type || b.t || "p").toLowerCase() });
  }
  return out;
}

/** Markdown → blocks。只做语法映射，不做版式设计。 */
export function markdownToBlocks(md) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ type: "p", text: para.join("\n").trim() });
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", text: buf.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ type: `h${Math.min(3, h[1].length)}`, text: h[2].trim() });
      i += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "bullets", items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "numbers", items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: buf.join("\n") });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i]
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i += 1;
      }
      blocks.push({ type: "table", rows });
      continue;
    }
    const img = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      flush();
      blocks.push({ type: "image", src: img[2], caption: img[1] });
      i += 1;
      continue;
    }
    if (!line.trim()) {
      flush();
      i += 1;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flush();
  return blocks;
}

/* ---------------- 输出 ---------------- */

function writer() {
  const chunks = [];
  let length = 0;
  const push = (bytes) => {
    chunks.push(bytes);
    length += bytes.length;
  };
  const ascii = (s) => {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) b[i] = s.charCodeAt(i) & 0xff;
    push(b);
  };
  return {
    push,
    ascii,
    get length() {
      return length;
    },
    done: () => concat(chunks),
  };
}

async function deflate(bytes) {
  if (typeof CompressionStream !== "function") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function toUnicodeCMap(subset, cps) {
  const entries = [];
  for (const cp of cps) {
    const gid = subset.gidOf(cp);
    if (!gid) continue;
    entries.push(`<${gid.toString(16).toUpperCase().padStart(4, "0")}> <${cp.toString(16).toUpperCase().padStart(4, "0")}>`);
  }
  let out = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
`;
  for (let i = 0; i < entries.length; i += 100) {
    const slice = entries.slice(i, i + 100);
    out += `${slice.length} beginbfchar\n${slice.join("\n")}\nendbfchar\n`;
  }
  out += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
  return out;
}

const bytesOf = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/**
 * 主入口。
 * @param {Array|string} blocks
 * @param {object} opts { pageSize, margin, footer, title, images, imageLoader }
 */
export async function buildPdf(blocks, opts = {}) {
  const mainTTF = await loadFont();
  const symTTF = await loadSymbolFont();
  const list = normalizeBlocks(blocks);

  const chars = new Set();
  const collect = (s) => {
    for (const ch of String(s ?? "")) chars.add(ch.codePointAt(0) === 0x3000 ? 0x20 : ch.codePointAt(0));
  };
  for (const b of list) {
    if (b.text) collect(b.text);
    if (b.title) collect(b.title);
    if (Array.isArray(b.items)) b.items.forEach(collect);
    if (Array.isArray(b.rows)) b.rows.forEach((r) => r.forEach(collect));
    if (b.caption) collect(b.caption);
  }
  for (const ch of "•0123456789/ ") collect(ch);

  const mainSubset = subsetFont(mainTTF, [...chars]);
  const rest = [...chars].filter((cp) => !mainSubset.gidOf(cp));
  const symSubset = symTTF ? subsetFont(symTTF, rest) : null;
  // 没有符号要补时不要带一份空字体 —— 每个字体都是 5 个对象 + 一条字体流，
  // 小文档会白白多出 10 KB。
  const useSym = symSubset && symSubset.numGlyphs > 1;
  const fs = makeFontSet([
    { name: "F1", base: "NotoSansSC", subset: mainSubset, cps: [...chars].filter((cp) => mainSubset.gidOf(cp)) },
    useSym
      ? { name: "F2", base: "DejaVuSansSym", subset: symSubset, cps: rest.filter((cp) => symSubset.gidOf(cp)) }
      : null,
  ]);

  const doc = new Doc(fs, opts);
  const imageCache = new Map();
  const getImage = async (src) => {
    if (imageCache.has(src)) return imageCache.get(src);
    let bytes = null;
    if (opts.images && opts.images[src]) bytes = opts.images[src];
    else if (opts.imageLoader) bytes = await opts.imageLoader(src);
    const img = bytes ? parseImage(bytes) : null;
    imageCache.set(src, img || null);
    return img || null;
  };

  for (const b of list) {
    const type = b.type;
    if (/^h[1-6]$/.test(type)) {
      doc.heading(Number(type[1]), b.text || "");
    } else if (type === "p" || type === "paragraph" || type === "text") {
      doc.block(b.text || "", { size: b.size || 10.5, color: BODY, gap: 9 });
    } else if (type === "bullets" || type === "bullet" || type === "ul") {
      const items = b.items || (b.text ? [b.text] : []);
      items.forEach((it) => doc.bullet(it, "•"));
      doc.y -= 7;
    } else if (type === "numbers" || type === "number" || type === "ol") {
      const items = b.items || (b.text ? [b.text] : []);
      items.forEach((it, i) => doc.bullet(it, `${i + 1}.`));
      doc.y -= 7;
    } else if (type === "quote" || type === "blockquote") {
      doc.quote(b.text || "");
      doc.y -= 8;
    } else if (type === "code" || type === "pre") {
      doc.code(b.text || "");
    } else if (type === "table") {
      doc.table(b.rows || [], b.header !== false);
    } else if (type === "rule" || type === "hr") {
      doc.need(16);
      doc.y -= 7;
      doc.line(doc.margin, doc.y, doc.margin + doc.width, doc.y, LINE, 0.6);
      doc.y -= 11;
    } else if (type === "pagebreak" || type === "page-break") {
      doc.newPage();
    } else if (type === "space") {
      doc.y -= Number(b.height || 12);
    } else if (type === "image" || type === "img") {
      const img = await getImage(b.src || b.path);
      if (img && img.error) doc.block(`（${img.error}：${b.src || b.path}）`, { size: 9, color: MUTED, gap: 8 });
      else if (!img) doc.block(`（图片未能读取：${b.src || b.path}）`, { size: 9, color: MUTED, gap: 8 });
      else await doc.image(img, { width: b.width, caption: b.caption || "" });
    } else if (b.text) {
      doc.block(b.text, { size: 10.5, color: BODY, gap: 9 });
    }
  }

  const pages = doc.finish();
  if (opts.footer !== false) {
    pages.forEach((ops, i) => {
      const label = `${i + 1} / ${pages.length}`;
      const size = 8.5;
      const w = fs.measureText(label, size);
      const { runs } = fs.runs(label);
      let cx = (doc.size[0] - w) / 2;
      for (const r of runs) {
        ops.push(
          `BT ${rgb(MUTED)} /${r.font.name} ${num(size)} Tf 1 0 0 1 ${num(cx)} ${num(doc.margin - 13)} Tm <${r.hex}> Tj ET`
        );
        cx += fs.measureText(r.text, size);
      }
    });
  }

  const bytes = await serialize({ pages, fs, images: doc.images, opts });

  return {
    bytes,
    pages: pages.length,
    missing: [...doc.missing],
    size: doc.size,
    fonts: fs.list.map((f) => ({ name: f.base, kb: Math.round(f.subset.bytes.length / 1024) })),
  };
}

async function serialize({ pages, fs, images, opts }) {
  const w = writer();
  const offsets = [];
  let objCount = 0;
  const obj = () => {
    objCount += 1;
    offsets[objCount] = w.length;
    w.ascii(`${objCount} 0 obj\n`);
    return objCount;
  };
  const end = () => w.ascii("endobj\n");
  const streamObj = async (dict, data) => {
    const packed = await deflate(data);
    const use = packed && packed.length < data.length ? packed : data;
    obj();
    w.ascii(`<< ${dict} /Length ${use.length}${packed && packed.length < data.length ? " /Filter /FlateDecode" : ""} >>\nstream\n`);
    w.push(use);
    w.ascii("\nendstream\n");
    end();
  };

  w.ascii("%PDF-1.7\n");
  w.push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  obj();
  w.ascii("<< /Type /Catalog /Pages 2 0 R >>\n");
  end();

  obj();
  const firstPage = 3 + fs.list.length * 5;
  const pageNums = pages.map((_, i) => firstPage + i * 2);
  const contentNums = pages.map((_, i) => firstPage + i * 2 + 1);
  w.ascii(`<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>\n`);
  end();

  // 每份字体 5 个对象：Type0 / CIDFont / Descriptor / FontFile2 / ToUnicode
  for (const font of fs.list) {
    const base = font.base;
    const type0 = objCount + 1;
    obj();
    w.ascii(
      `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /Identity-H /DescendantFonts [${
        type0 + 1
      } 0 R] /ToUnicode ${type0 + 4} 0 R >>\n`
    );
    end();

    obj();
    const wArr = [];
    const gids = [...font.subset.widths.keys()].sort((a, b) => a - b);
    for (const gid of gids) if (gid) wArr.push(`${gid} [${font.subset.widths.get(gid)}]`);
    w.ascii(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${
        type0 + 2
      } 0 R /DW 1000 /W [${wArr.join(" ")}] /CIDToGIDMap /Identity >>\n`
    );
    end();

    const bbox = font.subset.bbox || [0, font.subset.descent, font.subset.unitsPerEm, font.subset.ascent];
    obj();
    w.ascii(
      `<< /Type /FontDescriptor /FontName /${base} /Flags 4 /FontBBox [${bbox.map(num).join(" ")}] /ItalicAngle 0 /Ascent ${
        font.subset.ascent
      } /Descent ${font.subset.descent} /CapHeight ${Math.round(font.subset.unitsPerEm * 0.7)} /StemV 80 /FontFile2 ${
        type0 + 3
      } 0 R >>\n`
    );
    end();

    await streamObj(`/Length1 ${font.subset.bytes.length}`, font.subset.bytes);
    await streamObj("", bytesOf(toUnicodeCMap(font.subset, font.cps)));
  }

  const imageNums = images.map((_, i) => firstPage + pages.length * 2 + i);

  pages.forEach((ops, i) => {
    const content = bytesOf(ops.join("\n"));
    const resources = [
      `/Font << ${fs.list.map((f, k) => `/${f.name} ${3 + k * 5} 0 R`).join(" ")} >>`,
      imageNums.length ? `/XObject << ${images.map((im, k) => `/${im.name} ${imageNums[k]} 0 R`).join(" ")} >>` : "",
    ]
      .filter(Boolean)
      .join(" ");
    obj();
    const pw = PAGE_SIZES[opts.pageSize]?.[0] || 595.28;
    const ph = PAGE_SIZES[opts.pageSize]?.[1] || 841.89;
    w.ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pw)} ${num(ph)}] /Resources << ${resources} >> /Contents ${
        contentNums[i]
      } 0 R >>\n`
    );
    end();

    obj();
    w.ascii(`<< /Length ${content.length} >>\nstream\n`);
    w.push(content);
    w.ascii("\nendstream\n");
    end();
  });

  images.forEach((im) => {
    obj();
    w.ascii(
      `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace ${im.colorSpace} /BitsPerComponent 8 ${
        im.filter ? `/Filter ${im.filter}` : ""
      } ${im.decodeParms || ""} /Length ${im.data.length} >>\nstream\n`
    );
    w.push(im.data);
    w.ascii("\nendstream\n");
    end();
  });

  const infoNum = obj();
  w.ascii(`<< /Producer (DSH Mobile) /Creator (DSH Mobile)${opts.title ? ` /Title (${esc(opts.title)})` : ""} >>\n`);
  end();

  const xref = w.length;
  w.ascii(`xref\n0 ${objCount + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= objCount; i += 1) w.ascii(`${String(offsets[i] || 0).padStart(10, "0")} 00000 n \n`);
  w.ascii(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R /Info ${infoNum} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return w.done();
}
