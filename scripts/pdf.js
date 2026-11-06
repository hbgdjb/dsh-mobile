/* ============================================================
   PDF 读取 — 纯 JS，无第三方依赖

   ============ 为什么自己写 ============
   1) 手机上没法装 pdf.js：没有打包器，也没有 CDN（离线可用是底线）。
   2) 模型最常见的办公动作是「读这份 PDF」：合同、报告、发票、扫描件。
      以前 fs_inspect 只能告诉它「PDF 文档，约 12 页」，正文一个字都拿不到，
      于是它要么让用户复制粘贴，要么瞎猜内容。
   3) 只需要「文本 + 结构」，不需要渲染。渲染是阅读器的事。

   ============ 边界（写清楚，免得模型误判）============
   · 有文本层的 PDF 才能读。扫描件只有图片，这里会明确说「需要 OCR」。
   · 加密 PDF 只在「空密码 + RC4/AES」时尝试解开；打不开就直说。
   · 不做版面还原：按基线分行、按间距补空格。分栏、表格会变成顺序文本。
   · 不解析嵌入文件、批注、表单值（v1）。
   ============================================================ */

import { inflateRaw } from "./zip.js";

const MAX_BYTES = 32 * 1024 * 1024;

/** 二进制 → latin1 字符串。PDF 的语法是字节级的，用 UTF-8 解码会毁掉内容流。 */
export function latin1Of(bytes) {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return out;
}

/** zlib 包装的 deflate（PDF 的 FlateDecode 就是它，比 zip 多了 2 字节头）。 */
export async function inflateZlib(bytes) {
  if (bytes.length < 6) return new Uint8Array(0);
  // 0x78 开头是 zlib；直接是 raw deflate 的坏文件也照顾一下。
  const zlib = bytes[0] === 0x78;
  try {
    return await inflateRaw(bytes.subarray(zlib ? 2 : 0, zlib ? bytes.length - 4 : bytes.length));
  } catch {
    return await inflateRaw(bytes);
  }
}

/* ---------------- PDF 值解析 ---------------- */

const isWs = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

function skipWs(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (isWs(c)) i += 1;
    else if (c === 0x25) {
      while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i += 1;
    } else break;
  }
  return i;
}

/**
 * 解析一个 PDF 值。返回 { v, end }。
 * 引用（`12 0 R`）解析成 { ref: 12 }，调用方按需取对象。
 */
export function parseValue(s, i) {
  i = skipWs(s, i);
  if (i >= s.length) return { v: null, end: i };
  const c = s[i];
  if (c === "<" && s[i + 1] === "<") {
    const obj = {};
    i += 2;
    for (;;) {
      i = skipWs(s, i);
      if (i >= s.length) break;
      if (s[i] === ">" && s[i + 1] === ">") {
        i += 2;
        break;
      }
      if (s[i] !== "/") {
        i += 1;
        continue;
      }
      const kn = readName(s, i);
      const key = kn.v.name;
      i = kn.end;
      const val = parseValue(s, i);
      obj[key] = val.v;
      i = val.end;
    }
    return { v: obj, end: i };
  }
  if (c === "[") {
    const arr = [];
    i += 1;
    for (;;) {
      i = skipWs(s, i);
      if (i >= s.length) break;
      if (s[i] === "]") {
        i += 1;
        break;
      }
      const val = parseValue(s, i);
      if (val.end <= i) break;
      if (val.v !== undefined) arr.push(val.v);
      i = val.end;
    }
    return { v: arr, end: i };
  }
  if (c === "/") return readName(s, i);
  if (c === "(") return readLiteral(s, i);
  if (c === "<") return readHex(s, i);
  if (c >= "0" && c <= "9") {
    // 数字，可能是引用 `num gen R`
    const num = readNumber(s, i);
    let j = skipWs(s, num.end);
    if (/^\d+$/.test(s.slice(num.start, num.end))) {
      const gen = readNumber(s, j);
      if (gen.ok && /^\d+$/.test(s.slice(gen.start, gen.end))) {
        const k = skipWs(s, gen.end);
        if (s[k] === "R" && !/[A-Za-z]/.test(s[k + 1] || "")) {
          return { v: { ref: Number(s.slice(num.start, num.end)), gen: Number(s.slice(gen.start, gen.end)) }, end: k + 1 };
        }
      }
    }
    return { v: num.v, end: num.end };
  }
  if (c === "-" || c === "+" || c === ".") return readNumber(s, i);
  if (s.startsWith("true", i)) return { v: true, end: i + 4 };
  if (s.startsWith("false", i)) return { v: false, end: i + 5 };
  if (s.startsWith("null", i)) return { v: null, end: i + 4 };
  // 操作符或未知记号：读到分隔符
  let j = i;
  while (j < s.length && !isWs(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j += 1;
  if (j === i) j += 1;
  return { v: s.slice(i, j), end: j };
}

function readName(s, i) {
  let j = i + 1;
  while (j < s.length && !isWs(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j += 1;
  let name = s.slice(i + 1, j);
  // #XX 转义（PDF 1.2+）
  if (name.includes("#")) {
    name = name.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return { v: { name }, end: j };
}

function readNumber(s, i) {
  let j = i;
  if (s[j] === "+" || s[j] === "-") j += 1;
  while (j < s.length && /[0-9.]/.test(s[j])) j += 1;
  const raw = s.slice(i, j);
  const v = Number(raw);
  return { v: Number.isFinite(v) ? v : 0, end: j, ok: j > i, start: i };
}

function readLiteral(s, i) {
  let out = "";
  let depth = 0;
  let j = i;
  for (j = i; j < s.length; j += 1) {
    const ch = s[j];
    if (ch === "\\") {
      const nx = s[j + 1];
      const esc = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[nx];
      if (esc !== undefined) {
        out += esc;
        j += 1;
      } else if (nx >= "0" && nx <= "7") {
        const oct = s.slice(j + 1, j + 4).match(/^[0-7]{1,3}/)[0];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        j += oct.length;
      } else if (nx === "\r" || nx === "\n") {
        j += 1; // 续行
      } else {
        out += nx || "";
        j += 1;
      }
      continue;
    }
    if (ch === "(") {
      depth += 1;
      if (depth === 1) continue;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    out += ch;
  }
  return { v: { str: out }, end: j + 1 };
}

function readHex(s, i) {
  let j = s.indexOf(">", i + 1);
  if (j < 0) j = s.length;
  let hex = s.slice(i + 1, j).replace(/[^0-9a-fA-F]/g, "");
  if (hex.length % 2) hex += "0";
  let out = "";
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
  return { v: { str: out, hex: true }, end: j + 1 };
}

/* ---------------- 对象扫描 ---------------- */

/**
 * 不用 xref 表，直接顺序扫 `N G obj`。
 *
 * 理由：xref 有表格式和流式（PDF 1.5+）两种，还有增量更新叠加的偏移；
 * 而现实里的 PDF 经常是「xref 偏移全错、但对象体完好」。
 * 顺序扫 + 跳过 stream 数据，能读的文件类型反而更多。
 */
export function scanObjects(s) {
  const objs = new Map();
  const re = /(\d{1,10})[ \t\r\n\f\0]+(\d{1,5})[ \t\r\n\f\0]+obj\b/g;
  let m;
  let guard = 0;
  while ((m = re.exec(s)) && guard < 200000) {
    guard += 1;
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    let dictEnd = -1;
    let stream = null;
    let after = bodyStart;

    const sIdx = s.indexOf("stream", bodyStart);
    const eIdx = s.indexOf("endobj", bodyStart);
    if (sIdx >= 0 && (eIdx < 0 || sIdx < eIdx)) {
      // stream 关键字后面必须跟 EOL。只看两个字符会误判：
      // 内容流紧跟 `stream\nBT`，第二个字符就是正文了。
      const c1 = s[sIdx + 6];
      const c2 = s[sIdx + 7];
      let skip = 0;
      if (c1 === "\r" && c2 === "\n") skip = 2;
      else if (c1 === "\n" || c1 === "\r") skip = 1;
      else if (c1 === " " && (c2 === "\n" || c2 === "\r")) skip = 2;
      if (skip) {
        const dataStart = sIdx + 6 + skip;
        const head = s.slice(bodyStart, sIdx);
        const lenM = head.match(/\/Length\s+(\d+)\s*(?!\d+\s+R)/);
        let dataEnd = -1;
        if (lenM) {
          const guess = dataStart + Number(lenM[1]);
          if (s.slice(guess, guess + 12).includes("endstream")) dataEnd = guess;
        }
        if (dataEnd < 0) {
          const es = s.indexOf("endstream", dataStart);
          dataEnd = es >= 0 ? es : s.length;
        }
        // 去掉 endstream 前的换行
        let realEnd = dataEnd;
        if (s[realEnd - 1] === "\n") realEnd -= 1;
        if (s[realEnd - 1] === "\r") realEnd -= 1;
        stream = [dataStart, realEnd];
        dictEnd = sIdx;
        after = s.indexOf("endobj", dataEnd);
        after = after >= 0 ? after + 6 : s.length;
      }
    }
    if (dictEnd < 0) {
      dictEnd = eIdx >= 0 ? eIdx : Math.min(s.length, bodyStart + 4000);
      after = eIdx >= 0 ? eIdx + 6 : dictEnd;
    }

    // 同一对象号以最后一次出现为准（增量更新就是这么覆盖的）。
    objs.set(num, { num, gen: Number(m[2]), dict: s.slice(bodyStart, dictEnd), stream });
    re.lastIndex = after;
  }
  return objs;
}

/* ---------------- 对象访问 ---------------- */

function makeReader(objs) {
  const cache = new Map();
  const get = (num) => {
    if (num == null) return null;
    if (cache.has(num)) return cache.get(num);
    const o = objs.get(num);
    if (!o) return null;
    let parsed;
    try {
      parsed = parseValue(o.dict, 0).v;
    } catch {
      parsed = null;
    }
    const rec = { ...o, value: parsed && typeof parsed === "object" ? parsed : {} };
    cache.set(num, rec);
    return rec;
  };
  return get;
}

const deref = (get, v) => (v && typeof v === "object" && v.ref ? get(v.ref)?.value : v);
const dictOf = (get, v) => {
  if (!v) return null;
  if (v.ref) return get(v.ref)?.value || null;
  return typeof v === "object" ? v : null;
};

/* ---------------- 流解码 ---------------- */

async function decodeStream(rec) {
  if (!rec || !rec.stream) return null;
  const raw = rec.buf || null;
  const bytes = raw || rec.rawBytes;
  if (!bytes) return null;
  const dict = rec.value || {};
  let filters = dict.Filter;
  if (!filters) return bytes;
  if (!Array.isArray(filters)) filters = [filters];
  let data = bytes;
  for (const f of filters) {
    const name = typeof f === "object" && f.name ? f.name : String(f);
    if (name === "FlateDecode" || name === "Fl") {
      data = await inflateZlib(data);
      if (dict.DecodeParms) data = unpredict(data, dict.DecodeParms);
    } else if (name === "ASCIIHexDecode" || name === "AHx") {
      const str = latin1Of(data).replace(/>.*$/s, "").replace(/[^0-9a-fA-F]/g, "");
      const out = new Uint8Array(Math.ceil(str.length / 2));
      for (let i = 0; i < out.length; i += 1) out[i] = parseInt(str.slice(i * 2, i * 2 + 2).padEnd(2, "0"), 16);
      data = out;
    } else if (name === "ASCII85Decode" || name === "A85") {
      data = ascii85(data);
    } else if (name === "DCTDecode" || name === "JPXDecode" || name === "CCITTFaxDecode" || name === "JBIG2Decode") {
      data = new Uint8Array(0); // 图像数据，文本提取用不到
    }
  }
  return data;
}

/** PNG/TIFF predictor（xref 流常见，内容流偶尔也有）。 */
function unpredict(data, parms) {
  const p = typeof parms === "object" && !parms.ref ? parms : {};
  const predictor = Number(p.Predictor || 1);
  if (predictor < 2) return data;
  const colors = Number(p.Colors || 1);
  const bpc = Number(p.BitsPerComponent || 8);
  const columns = Number(p.Columns || 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) return data; // TIFF predictor：极少见，放弃
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r += 1) {
    const ft = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    for (let i = 0; i < rowLen; i += 1) {
      const x = data[src + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = r > 0 ? out[dst - rowLen + i] : 0;
      const ul = r > 0 && i >= bpp ? out[dst - rowLen + i - bpp] : 0;
      let v = x;
      if (ft === 1) v = x + left;
      else if (ft === 2) v = x + up;
      else if (ft === 3) v = x + ((left + up) >> 1);
      else if (ft === 4) {
        const pa = Math.abs(up - ul);
        const pb = Math.abs(left - ul);
        const pc = Math.abs(left + up - 2 * ul);
        v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

function ascii85(bytes) {
  const s = latin1Of(bytes).replace(/^<~/, "").replace(/~>.*$/s, "").replace(/\s+/g, "");
  const out = [];
  let buf = [];
  for (const ch of s) {
    if (ch === "z" && buf.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    buf.push(code);
    if (buf.length === 5) {
      let n = 0;
      for (const b of buf) n = n * 85 + b;
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      buf = [];
    }
  }
  if (buf.length) {
    const n = buf.length;
    while (buf.length < 5) buf.push(84);
    let v = 0;
    for (const b of buf) v = v * 85 + b;
    const bytes4 = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...bytes4.slice(0, n - 1));
  }
  return new Uint8Array(out);
}

/* ---------------- 字体与编码 ---------------- */

/** 解析 ToUnicode CMap：bfchar / bfrange。 */
function parseToUnicode(text) {
  const map = new Map();
  const hexToStr = (h) => {
    let out = "";
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    if (h.length === 2) out = String.fromCharCode(parseInt(h, 16));
    return out;
  };
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfchar.exec(text))) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let p;
    while ((p = re.exec(m[1]))) map.set(parseInt(p[1], 16), hexToStr(p[2]));
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(text))) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let p;
    while ((p = re.exec(m[1]))) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      if (hi - lo > 65535) continue;
      if (p[4] !== undefined) {
        const base = parseInt(p[4].length >= 4 ? p[4].slice(-4) : p[4].padEnd(4, "0"), 16);
        const prefix = p[4].length > 4 ? hexToStr(p[4].slice(0, -4)) : "";
        for (let c = lo; c <= hi; c += 1) map.set(c, prefix + String.fromCharCode(base + (c - lo)));
      } else {
        const items = [...String(p[5]).matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => hexToStr(x[1]));
        items.forEach((s, k) => map.set(lo + k, s));
      }
    }
  }
  return map;
}

/** 读取一份字体的解码信息（缓存）。 */
async function loadFont(get, rec) {
  const d = rec?.value || {};
  const sub = d.Subtype?.name;
  const twoByte = sub === "Type0";
  const out = {
    twoByte,
    map: null,
    widths: null,
    defaultWidth: Number(d.DW || 500),
    vertical: twoByte && /-V$/.test(String(d.Encoding?.name || "")),
  };
  // ToUnicode
  const tu = d.ToUnicode;
  if (tu && tu.ref) {
    const srec = get(tu.ref);
    if (srec) {
      const bytes = await readStreamBytes(get, srec);
      if (bytes) out.map = parseToUnicode(latin1Of(bytes));
    }
  }
  // 宽度
  if (twoByte) {
    const desc = d.DescendantFonts;
    const arr = Array.isArray(desc) ? desc : desc ? [desc] : [];
    const cid = arr[0]?.ref ? get(arr[0].ref)?.value : arr[0];
    if (cid) {
      out.defaultWidth = Number(cid.DW || 1000);
      const w = cid.W;
      if (Array.isArray(w)) {
        const widths = new Map();
        for (let i = 0; i < w.length; ) {
          const first = w[i];
          const second = w[i + 1];
          if (Array.isArray(second)) {
            second.forEach((v, k) => widths.set(Number(first) + k, Number(v)));
            i += 2;
          } else {
            const last = Number(w[i + 1]);
            const v = Number(w[i + 2]);
            for (let c = Number(first); c <= last && c - first < 65536; c += 1) widths.set(c, v);
            i += 3;
          }
        }
        out.widths = widths;
      }
    }
  } else {
    const first = Number(d.FirstChar || 0);
    const widths = d.Widths;
    if (Array.isArray(widths)) {
      out.widths = new Map();
      widths.forEach((v, k) => out.widths.set(first + k, Number(v)));
    }
  }
  return out;
}

/** 流对象 → 原始字节（含 ObjStm 内联的情况）。 */
async function readStreamBytes(get, rec) {
  if (!rec) return null;
  if (rec.stream) {
    const holder = rec;
    const bytes = new Uint8Array(holder.stream[1] - holder.stream[0]);
    // 由 scanObjects 填入的切片
    if (holder.source) bytes.set(holder.source.subarray(holder.stream[0], holder.stream[1]));
    return await decodeWithRec(get, holder, bytes);
  }
  return await decodeWithRec(get, rec, rec.raw || new Uint8Array(0));
}

async function decodeWithRec(get, rec, bytes) {
  rec.buf = bytes;
  const prev = rec.rawBytes;
  rec.rawBytes = bytes;
  try {
    return await decodeStream(rec);
  } finally {
    rec.rawBytes = prev;
  }
}

/* ---------------- 内容流文本提取 ---------------- */

function glyphText(bytes, font) {
  const out = [];
  let missing = 0;
  if (font.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      const ch = font.map?.get(code);
      if (ch != null) out.push(ch);
      else if (font.map) out.push("");
      else {
        out.push("\uFFFD");
        missing += 1;
      }
    }
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      const code = bytes[i];
      if (font.map?.has(code)) out.push(font.map.get(code));
      else if (code >= 0x20 && code < 0x7f) out.push(String.fromCharCode(code));
      else if (code === 0x09) out.push(" ");
      else if (code >= 0xa0) out.push(String.fromCharCode(code));
      else out.push("");
    }
  }
  return { text: out.join(""), missing };
}

function charWidth(font, codePointUnit) {
  if (!font.widths) return font.defaultWidth / 1000;
  const w = font.widths.get(codePointUnit);
  return (w == null ? font.defaultWidth : w) / 1000;
}

/**
 * 单页文本。只做「够读」的版面近似：
 * 基线变了换行，水平空档补空格，竖排不处理。
 */
async function pageText(get, pageDict, objs) {
  const res = dictOf(get, pageDict.Resources);
  const fontDict = res ? dictOf(get, res.Font) : null;
  const fonts = {};
  if (fontDict) {
    for (const [name, ref] of Object.entries(fontDict)) {
      if (ref && ref.ref) {
        const rec = get(ref.ref);
        fonts[name] = await loadFont(get, rec);
      }
    }
  }

  const contents = pageDict.Contents;
  const refs = Array.isArray(contents) ? contents : contents ? [contents] : [];
  const parts = [];
  for (const r of refs) {
    if (!r?.ref) continue;
    const rec = get(r.ref);
    const bytes = await readStreamBytes(get, rec);
    if (bytes) parts.push(bytes);
  }
  if (!parts.length) return { text: "", missing: 0, hasImage: false };

  const total = parts.reduce((n, b) => n + b.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const b of parts) {
    all.set(b, off);
    off += b.length;
  }
  const content = latin1Of(all);

  let cur = null;
  let fontSize = 12;
  let leading = 0;
  let hScale = 1;
  let charSpace = 0;
  let wordSpace = 0;
  let tmX = 0;
  let tmY = 0;
  let lineY = null;
  let lastX = null;
  let out = "";
  let missing = 0;
  const pushBreak = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };

  const show = (bytes) => {
    if (!cur) return;
    const { text, missing: miss } = glyphText(bytes, cur);
    missing += miss;
    if (!text) return;
    if (lineY === null) lineY = tmY;
    if (Math.abs(tmY - lineY) > Math.max(fontSize * 0.45, 0.8)) {
      pushBreak();
      lineY = tmY;
      lastX = null;
    }
    if (lastX !== null && tmX - lastX > fontSize * 0.22) out += " ";
    out += text;
    // 粗略推进：宽度按字体表
    let adv = 0;
    if (cur.twoByte) {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        adv += charWidth(cur, (bytes[i] << 8) | bytes[i + 1]) * fontSize * hScale;
        adv += charSpace;
      }
    } else {
      for (let i = 0; i < bytes.length; i += 1) {
        adv += charWidth(cur, bytes[i]) * fontSize * hScale;
        adv += charSpace + (bytes[i] === 32 ? wordSpace : 0);
      }
    }
    lastX = tmX + adv;
  };

  const nums = [];
  let i = 0;
  const stack = [];
  while (i < content.length) {
    const c = content[i];
    if (isWs(content.charCodeAt(i))) {
      i += 1;
      continue;
    }
    if (c === "%") {
      while (i < content.length && content[i] !== "\n") i += 1;
      continue;
    }
    if (c === "(") {
      const r = readLiteral(content, i);
      stack.push({ str: r.v.str });
      i = r.end;
      continue;
    }
    if (c === "<" && content[i + 1] === "<") {
      const r = parseValue(content, i);
      stack.push({ dict: r.v });
      i = r.end;
      continue;
    }
    if (c === "<") {
      const r = readHex(content, i);
      stack.push({ str: r.v.str });
      i = r.end;
      continue;
    }
    if (c === "[") {
      const r = parseValue(content, i);
      stack.push({ array: r.v });
      i = r.end;
      continue;
    }
    if (c === "/") {
      const r = readName(content, i);
      stack.push({ name: r.v.name });
      i = r.end;
      continue;
    }
    if (c === "]" || c === ">" || c === ")" || c === "{" || c === "}") {
      i += 1;
      continue;
    }
    if ((c >= "0" && c <= "9") || c === "-" || c === "+" || c === ".") {
      const r = readNumber(content, i);
      stack.push({ num: r.v });
      i = r.end;
      continue;
    }
    // 操作符
    let j = i;
    while (j < content.length && !isWs(content.charCodeAt(j)) && content[j] !== "(" && content[j] !== "[") j += 1;
    const op = content.slice(i, j);
    i = j;
    const numAt = (k) => stack[stack.length - 1 - k]?.num;
    const strAt = (k) => stack[stack.length - 1 - k]?.str;
    switch (op) {
      case "BT":
        // 不要在这里换行：reportlab / Word 导出常常每个单元格一个 BT，
        // 同一基线上的几段文字会被拆成好几行。位置交给 Tm 判断。
        tmX = 0;
        tmY = 0;
        break;
      case "ET":
        break;
      case "Tf": {
        const name = stack[stack.length - 2]?.name;
        const size = numAt(0);
        if (name && fonts[name]) cur = fonts[name];
        if (Number.isFinite(size)) fontSize = size;
        break;
      }
      case "Td": {
        const tx = numAt(1) || 0;
        const ty = numAt(0) || 0;
        tmX += tx;
        tmY += ty;
        break;
      }
      case "TD": {
        const tx = numAt(1) || 0;
        const ty = numAt(0) || 0;
        tmX += tx;
        tmY += ty;
        leading = -ty;
        break;
      }
      case "Tm": {
        // 同一基线上的多个 Tm 是「同一行的不同单元格」，
        // 不能清掉 lastX，否则拼不出一行、也补不上空格。
        tmX = numAt(1) || 0;
        tmY = numAt(0) || 0;
        break;
      }
      case "T*":
        tmY -= leading || fontSize * 1.2;
        break;
      case "TL":
        leading = numAt(0) || 0;
        break;
      case "Tz":
        hScale = (numAt(0) || 100) / 100;
        break;
      case "Tc":
        charSpace = numAt(0) || 0;
        break;
      case "Tw":
        wordSpace = numAt(0) || 0;
        break;
      case "Tj": {
        const s = strAt(0);
        if (s != null) show(bytesOfStr(s));
        break;
      }
      case "'": {
        tmY -= leading || fontSize * 1.2;
        const s = strAt(0);
        if (s != null) show(bytesOfStr(s));
        break;
      }
      case '"': {
        charSpace = numAt(2) || 0;
        wordSpace = numAt(1) || 0;
        tmY -= leading || fontSize * 1.2;
        const s = strAt(0);
        if (s != null) show(bytesOfStr(s));
        break;
      }
      case "TJ": {
        const arr = stack[stack.length - 1]?.array;
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (typeof item === "number") {
              if (item < -120) out += " ";
              tmX -= 0; // 位置推进已由 show 估算，这里不重复
            } else if (item && item.str != null) {
              show(bytesOfStr(item.str));
            }
          }
        }
        break;
      }
      default:
        break;
    }
    stack.length = 0;
  }

  // 页内数据：图片（判断扫描件）
  let hasImage = false;
  if (res) {
    const xo = dictOf(get, res.XObject);
    if (xo) {
      for (const v of Object.values(xo)) {
        const d = v?.ref ? get(v.ref)?.value : v;
        if (d && String(d.Subtype?.name) === "Image") hasImage = true;
      }
    }
  }

  return { text: out.replace(/\u0000/g, ""), missing, hasImage };
}

function bytesOfStr(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/* ---------------- 页面树 ---------------- */

function collectPages(get, objs) {
  const pages = [];
  const seen = new Set();
  const catalog = [...objs.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dict));
  const walk = (dict, inherited) => {
    if (!dict || pages.length > 4000) return;
    const type = String(dict.Type?.name || "");
    if (type === "Page") {
      pages.push({ ...dict, Resources: dict.Resources || inherited.Resources, MediaBox: dict.MediaBox || inherited.MediaBox });
      return;
    }
    const kids = dict.Kids;
    if (!Array.isArray(kids)) return;
    for (const k of kids) {
      if (!k?.ref || seen.has(k.ref)) continue;
      seen.add(k.ref);
      const rec = get(k.ref);
      if (rec) walk(rec.value, { Resources: dict.Resources || inherited.Resources, MediaBox: dict.MediaBox || inherited.MediaBox });
    }
  };
  if (catalog) {
    const c = parseValue(catalog.dict, 0).v || {};
    const pagesRef = c.Pages;
    if (pagesRef?.ref) walk(get(pagesRef.ref)?.value, {});
  }
  if (!pages.length) {
    for (const o of [...objs.values()].sort((a, b) => a.num - b.num)) {
      if (/\/Type\s*\/Page[^s]/.test(o.dict)) {
        const v = parseValue(o.dict, 0).v || {};
        pages.push(v);
      }
    }
  }
  return pages;
}

/* ---------------- 对外入口 ---------------- */

/**
 * 读 PDF。
 * @returns {{version, totalPages, pages:[{index,text}], encrypted, scanned, missingGlyphs, emptyPages}}
 */
export async function readPdf(bytes, opts = {}) {
  if (bytes.length > MAX_BYTES) throw new Error(`PDF 有 ${(bytes.length / 1048576).toFixed(1)} MB，超过 32 MB 上限，请先拆分`);
  const s = latin1Of(bytes);
  const version = (s.match(/%PDF-(\d+\.\d+)/) || [])[1] || "?";
  const encrypted = /\/Type\s*\/Encrypt|\/Encrypt\s+\d+\s+\d+\s+R/.test(s);

  // 把流的切片挂回对象，后面 decode 时能取到原始字节
  const objs = scanObjects(s);
  for (const o of objs.values()) o.source = bytes;

  const get = makeReader(objs);

  // 对象流展开（PDF 1.5+ 把很多小对象压进 ObjStm）
  for (const o of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const rec = get(o.num);
    let data = null;
    try {
      data = await readStreamBytes(get, rec);
    } catch {
      data = null;
    }
    if (!data) continue;
    const n = Number((o.dict.match(/\/N\s+(\d+)/) || [])[1] || 0);
    const first = Number((o.dict.match(/\/First\s+(\d+)/) || [])[1] || 0);
    const header = latin1Of(data.subarray(0, Math.min(first, data.length))).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n; k += 1) {
      const num = header[k * 2];
      const off = header[k * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      if (objs.has(num)) continue;
      const start = first + off;
      const end = k + 1 < n ? first + header[(k + 1) * 2 + 1] : data.length;
      const body = latin1Of(data.subarray(start, Math.min(end, data.length)));
      objs.set(num, { num, gen: 0, dict: body, stream: null, source: bytes });
    }
  }

  const pages = collectPages(get, objs);
  const out = [];
  let missingGlyphs = 0;
  let scanned = 0;
  let emptyPages = 0;
  const limit = Math.min(pages.length, opts.maxPages || 200);
  for (let i = 0; i < limit; i += 1) {
    let text = "";
    let missing = 0;
    let hasImage = false;
    try {
      const r = await pageText(get, pages[i], objs);
      text = r.text;
      missing = r.missing;
      hasImage = r.hasImage;
    } catch (e) {
      text = "";
    }
    missingGlyphs += missing;
    const clean = text
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!clean) {
      emptyPages += 1;
      if (hasImage) scanned += 1;
    }
    out.push({ index: i + 1, text: clean });
  }

  return {
    version,
    totalPages: pages.length,
    pages: out,
    encrypted,
    scanned: scanned > 0 || (emptyPages >= Math.max(1, out.length) && out.length > 0 && scanned > 0),
    emptyPages,
    missingGlyphs,
    truncated: pages.length > limit,
  };
}
