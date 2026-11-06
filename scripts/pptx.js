/* ============================================================
   DSH PPTX — 无依赖的 Markdown → PowerPoint
   结构与 docx/xlsx 导出同源：直接拼 OOXML，再用 store 模式 ZIP 封装。
   目标不是「把大纲塞进文件」，而是一份打开就能讲的 16:9 幻灯片：
   封面 / 要点 / 表格 三种版式，统一配色与留白。
   ============================================================ */

import { zipStore } from "./office.js";

const EMU = 914400;
const IN = (v) => Math.round(v * EMU);
const W = 12192000; // 13.333in
const H = 6858000; // 7.5in
const MARGIN = IN(0.9);
const CW = W - MARGIN * 2;

const C = {
  ink: "1F2328",
  body: "333A45",
  muted: "6B7480",
  accent: "2F6FEB",
  line: "E1E6EE",
  soft: "F4F6FA",
};

const xml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** 把一行里的 **粗体** / `代码` 拆成 run，其余标记按纯文本处理。 */
function inlineRuns(text) {
  const clean = String(text ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    // 只剥内联排版标签。<tag> 这种合法正文不能连带吃掉。
    .replace(/<\/?(?:span|mark|b|i|strong|em|u|sub|sup|br|code)\b[^>]*>/gi, "");
  const runs = [];
  let rest = clean;
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/;
  let m;
  while ((m = re.exec(rest))) {
    if (m.index > 0) runs.push({ text: rest.slice(0, m.index) });
    if (m[0].startsWith("**")) runs.push({ text: m[2], bold: true });
    else runs.push({ text: m[3], mono: true });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) runs.push({ text: rest });
  return runs.length ? runs : [{ text: clean }];
}

/* ---------------- DrawingML ---------------- */

function aRun(run, { sz, color, bold }) {
  return `<a:r><a:rPr lang="zh-CN" altLang="en-US"${
    bold || run.bold ? ' b="1"' : ""
  } sz="${sz}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${
    run.mono
      ? '<a:latin typeface="Consolas"/><a:ea typeface="Consolas"/>'
      : '<a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/>'
  }</a:rPr><a:t>${xml(run.text)}</a:t></a:r>`;
}

/**
 * 一个段落。pPr 子元素顺序必须符合 schema：
 * lnSpc → spcBef → buClr → buFont → buChar。
 */
function aPara(text, opts = {}) {
  const {
    sz = 1800,
    color = C.body,
    bold = false,
    bullet = "",
    num = 0,
    level = 0,
    lnSpc = 132000,
    before = 700,
    align = "",
  } = opts;
  const marL = bullet || num ? 280000 + level * 300000 : 0;
  const indent = bullet || num ? -280000 : 0;
  // 有序列表必须逐段给 startAt：DrawingML 的自动编号每段都从 1 开始，
  // 不给起点的话三条要点会各自显示「1.」。
  const bu = num
    ? `<a:buClr><a:srgbClr val="${C.accent}"/></a:buClr><a:buSzPct val="100000"/><a:buFont typeface="Arial"/><a:buAutoNum type="arabicPeriod" startAt="${num}"/>`
    : bullet
    ? `<a:buClr><a:srgbClr val="${C.accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="${xml(
        bullet
      )}"/>`
    : "<a:buNone/>";
  const ppr =
    `<a:pPr${marL ? ` marL="${marL}" indent="${indent}"` : ""}${align ? ` algn="${align}"` : ""}>` +
    `<a:lnSpc><a:spcPct val="${lnSpc}"/></a:lnSpc>` +
    `<a:spcBef><a:spcPts val="${before}"/></a:spcBef>${bu}</a:pPr>`;
  const runs = inlineRuns(text)
    .map((r) => aRun(r, { sz, color, bold }))
    .join("");
  return `<a:p>${ppr}${runs || `<a:endParaRPr lang="zh-CN" sz="${sz}"/>`}</a:p>`;
}

function spText(id, name, x, y, cx, cy, paras, opts = {}) {
  const { anchor = "t" } = opts;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras.join(
    ""
  )}</p:txBody></p:sp>`;
}

function spRect(id, name, x, y, cx, cy, color) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>`;
}

/** 表格：表头浅底 + 主色下边线，正文只留细横线，避免满格网格。 */
function tblFrame(id, x, y, cx, rows, opts = {}) {
  const { sz = 1400, headSz = 1400 } = opts;
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const colW = Math.floor(cx / cols);
  const headH = IN(0.44);
  const rowH = IN(0.4);

  const cell = (text, r, c) => {
    const isHead = r === 0;
    const txt = inlineRuns(text)
      .map((run) => aRun(run, { sz: isHead ? headSz : sz, color: isHead ? C.ink : C.body, bold: isHead }))
      .join("");
    return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="l"/><a:spcBef><a:spcPts val="300"/></a:spcBef>${txt}</a:p></a:txBody><a:tcPr marL="${IN(
      0.12
    )}" marR="${IN(0.12)}" marT="${IN(0.04)}" marB="${IN(0.04)}" anchor="ctr"><a:lnL w="0"><a:noFill/></a:lnL><a:lnR w="0"><a:noFill/></a:lnR><a:lnT w="0"><a:noFill/></a:lnT><a:lnB w="${
      isHead ? 12700 : 6350
    }"><a:solidFill><a:srgbClr val="${isHead ? C.accent : C.line}"/></a:solidFill></a:lnB>${
      isHead ? `<a:solidFill><a:srgbClr val="${C.soft}"/></a:solidFill>` : "<a:noFill/>"
    }</a:tcPr></a:tc>`;
  };

  const trs = rows
    .map(
      (r, ri) =>
        `<a:tr h="${ri === 0 ? headH : rowH}">${Array.from({ length: cols }, (_, ci) =>
          cell(r[ci] ?? "", ri, ci)
        ).join("")}</a:tr>`
    )
    .join("");

  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${headH + rowH * (rows.length - 1)}"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
<a:tbl><a:tblPr firstRow="1"><a:tableStyleId>{2D5ABB26-0587-4C30-8999-92F81FD0307C}</a:tableStyleId></a:tblPr>
<a:tblGrid>${Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join("")}</a:tblGrid>${trs}</a:tbl>
</a:graphicData></a:graphic></p:graphicFrame>`;
}

/* ---------------- Markdown → 幻灯片结构 ---------------- */

const MAX_BULLETS = 6;

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * 把 Markdown 切成页。body 是一串有序条目（小标题 / 要点 / 段落），
 * 渲染时放进同一个文本框 —— 分成两个框会让「### 人力」跑到要点下面去。
 *
 * `#` 第一处 → 封面；后续 `#`/`##` → 新的一页；`###` 页内小标题。
 * `---` 只断开当前页。
 */
function parseDeck(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const slides = [];
  let cur = null;

  // `---` 之后若直接跟正文（没有新标题），沿用上一页的标题：
  // 生成一张没有标题的正文页，看起来就像标题渲染失败了。
  let lastTitle = "";
  const push = (type, title = "") => {
    if (title) lastTitle = title;
    cur = { type, title, subtitle: "", body: [], table: null };
    slides.push(cur);
    return cur;
  };
  const ensure = () => cur || push("body", lastTitle);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();

    if (/^\s*```/.test(line)) {
      i += 1;
      const buf = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i += 1;
      ensure().body.push({ t: "code", text: buf.slice(0, 12).join("\n") });
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      cur = null;
      i += 1;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const depth = h[1].length;
      const text = h[2].replace(/\s*#+\s*$/, "").trim();
      // 只有一级标题当封面。以 ## 开头的文档，第一页仍是正文页 ——
      // 否则最前面那页内容会被当成封面吞掉。
      if (!slides.length && depth === 1) push("title", text);
      else if (depth <= 2) push("body", text);
      else {
        const s = ensure();
        // 当前页还没有内容 → 当标题；否则页内小标题，跟后面的要点待在一起。
        if (!s.body.length && !s.title) s.title = text;
        else s.body.push({ t: "sub", text });
      }
      i += 1;
      continue;
    }

    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1].trim())) {
      const head = splitTableRow(line);
      i += 2;
      const rows = [head];
      while (i < lines.length && /^\|/.test(lines[i])) {
        if (rows.length < 9) rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      // 表格独占一页；若当前页只有标题还没正文，直接把它变成表格页。
      let s = cur;
      if (!s || s.body.length || s.table) s = push("body", cur ? cur.title : "");
      s.type = "table";
      s.table = rows;
      continue;
    }

    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      ensure().body.push({ t: "img", text: img[1] || img[2].split("/").pop(), path: img[2].trim() });
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "").trim());
      const s = ensure();
      const text = buf.filter(Boolean).join(" ");
      if (s.type === "title" && !s.subtitle) s.subtitle = text;
      else s.body.push({ t: "quote", text });
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const level = Math.min(1, Math.floor(li[1].replace(/\t/g, "  ").length / 2));
      ensure().body.push({ t: "li", text: li[3].trim(), level, ordered: /\d/.test(li[2]) });
      i += 1;
      continue;
    }

    const buf = [line.trim()];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|>|\||!\[|\s*([-*+]|\d+[.)])\s|-{3,}$)/.test(lines[i])
    ) {
      buf.push(lines[i].trim());
      i += 1;
    }
    const s = ensure();
    const text = buf.join(" ");
    if (s.type === "title" && !s.subtitle) s.subtitle = text;
    else s.body.push({ t: "p", text });
  }

  return slides.filter((s) => s.title || s.body.length || s.table);
}

/** 一条要点太长时按句读切一刀，避免一页只放得下两行字。 */
function splitLong(text, max = 92) {
  if (String(text).length <= max) return [text];
  const parts = [];
  let buf = "";
  for (const seg of String(text).split(/(?<=[。；;！？!?])/)) {
    if (buf && (buf + seg).length > max) {
      parts.push(buf.trim());
      buf = seg;
    } else buf += seg;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.slice(0, 2);
}

/** 要点超过一页容量就拆「（续）」，而不是把字号压到看不清。 */
function normalize(slides) {
  const out = [];
  slides.forEach((s) => {
    if (s.type !== "body" || !s.body.some((b) => b.t === "li")) {
      out.push(s);
      return;
    }
    const flat = [];
    s.body.forEach((b) => {
      if (b.t !== "li") return flat.push(b);
      splitLong(b.text).forEach((t, k) => flat.push({ ...b, text: t, level: k ? 1 : b.level }));
    });

    const chunks = [];
    let chunk = [];
    let count = 0;
    flat.forEach((b) => {
      if (b.t === "li" && count === MAX_BULLETS) {
        chunks.push(chunk);
        chunk = [];
        count = 0;
      }
      if (b.t === "li") count += 1;
      chunk.push(b);
    });
    if (chunk.length) chunks.push(chunk);

    chunks.forEach((c, k) => out.push({ ...s, title: k === 0 ? s.title : `${s.title}（续）`, body: c }));
  });
  return out;
}

/* ---------------- 版式 ---------------- */

function slideXml(shapes) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${shapes.join("")}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function titleSlide(s, id) {
  const shapes = [];
  // 右侧浅色块 + 一条主色竖线，给封面一个重心，
  // 否则整页只有两行字漂在中间。
  shapes.push(spRect(id++, "Panel", W - IN(4.05), 0, IN(4.05), H, C.soft));
  shapes.push(spRect(id++, "Accent", W - IN(4.05), 0, IN(0.075), H, C.accent));
  shapes.push(spRect(id++, "Rule", MARGIN, IN(2.62), IN(0.86), IN(0.07), C.accent));

  const paras = [aPara(s.title || "未命名演示", { sz: 4000, color: C.ink, bold: true, lnSpc: 108000, before: 0 })];
  if (s.subtitle) paras.push(aPara(s.subtitle, { sz: 1750, color: C.muted, before: 1200 }));
  shapes.push(spText(id++, "Title", MARGIN, IN(2.95), IN(7.35), IN(2.3), paras));

  shapes.push(
    spText(id++, "Meta", MARGIN, H - IN(1.02), IN(7.35), IN(0.36), [
      aPara(`${new Date().toLocaleDateString("zh-CN")}　·　DSH Mobile 导出`, { sz: 1050, color: C.muted, before: 0 }),
    ])
  );
  return shapes;
}

/**
 * 只有标题、没有正文的页，当作分节页：标题放大居左、去掉页脚页码。
 * 否则它看起来就是一张「忘了填内容」的空页。
 */
function dividerSlide(s, id) {
  const shapes = [];
  shapes.push(spRect(id++, "Mark", MARGIN, IN(2.62), IN(0.7), IN(0.06), C.accent));
  const paras = [aPara(s.title || "", { sz: 3400, color: C.ink, bold: true, lnSpc: 110000, before: 0 })];
  if (s.subtitle) paras.push(aPara(s.subtitle, { sz: 1600, color: C.muted, before: 1200 }));
  shapes.push(spText(id++, "Title", MARGIN, IN(2.95), IN(8.6), IN(2.0), paras));
  return shapes;
}

function bodySlide(s, id, page, total) {
  const shapes = [];

  shapes.push(spRect(id++, "Rule", MARGIN, IN(1.62), CW, 9525, C.line));
  shapes.push(spRect(id++, "Mark", MARGIN, IN(1.58), IN(1.05), IN(0.045), C.accent));
  shapes.push(
    spText(id++, "Title", MARGIN, IN(0.6), CW - IN(0.6), IN(0.92), [
      aPara(s.title || "", { sz: 3000, color: C.ink, bold: true, lnSpc: 104000, before: 0 }),
    ])
  );

  const y = IN(1.95);
  const room = H - y - IN(1.0);

  if (s.body.some((b) => b.t === "li" || b.t === "p" || b.t === "quote")) {
    const bullets = s.body.filter((b) => b.t === "li").length;
    const base = bullets <= 3 ? 2000 : bullets <= 5 ? 1800 : 1650;
    let seq = 0;
    const paras = s.body.map((b) => {
      if (b.t === "li") {
        if (b.ordered) {
          seq += 1;
          return aPara(b.text, {
            sz: b.level ? base - 200 : base,
            color: b.level ? C.muted : C.body,
            num: seq,
            level: b.level,
            before: 800,
          });
        }
        seq = 0;
        return aPara(b.text, {
          sz: b.level ? base - 200 : base,
          color: b.level ? C.muted : C.body,
          bullet: b.level ? "–" : "•",
          level: b.level,
          before: 800,
        });
      }
      seq = 0;
      if (b.t === "sub") {
        return aPara(b.text, { sz: 1600, color: C.accent, bold: true, before: 1100, lnSpc: 120000 });
      }
      if (b.t === "quote") {
        return aPara(b.text, { sz: 1400, color: C.muted, before: 700, lnSpc: 140000 });
      }
      if (b.t === "code") {
        return aPara(b.text, { sz: 1100, color: "5A6070", before: 2100, lnSpc: 118000 });
      }
      if (b.t === "img") {
        return aPara(`配图：${b.text}`, { sz: 1300, color: C.muted, before: 700 });
      }
      return aPara(b.text, { sz: 1450, before: 500, lnSpc: 140000 });
    });
    shapes.push(spText(id++, "Body", MARGIN, y, CW - IN(0.3), room, paras));
  }

  if (s.table) {
    const rows = s.table.slice(0, 8);
    const wide = rows.length > 6 || Math.max(...rows.map((r) => r.length)) > 4;
    const size = wide ? 1150 : 1350;
    shapes.push(tblFrame(id++, MARGIN, y + IN(0.05), CW, rows, { sz: size, headSz: size }));
  }

  // 页脚：细线 + 页码。总页数对讲者比「第几页」有用。
  shapes.push(spRect(id++, "FootRule", MARGIN, H - IN(0.82), CW, 9525, C.line));
  shapes.push(
    spText(id++, "Page", W - MARGIN - IN(2.2), H - IN(0.66), IN(2.2), IN(0.32), [
      aPara(`${page} / ${total}`, { sz: 950, color: C.muted, align: "r", before: 0 }),
    ])
  );
  return shapes;
}

/* ---------------- 包结构 ---------------- */

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="DSH">
<a:themeElements>
<a:clrScheme name="DSH"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2328"/></a:dk2><a:lt2><a:srgbClr val="F4F6FA"/></a:lt2><a:accent1><a:srgbClr val="2F6FEB"/></a:accent1><a:accent2><a:srgbClr val="1F9D74"/></a:accent2><a:accent3><a:srgbClr val="D9822B"/></a:accent3><a:accent4><a:srgbClr val="8B5CF6"/></a:accent4><a:accent5><a:srgbClr val="E5484D"/></a:accent5><a:accent6><a:srgbClr val="0EA5E9"/></a:accent6><a:hlink><a:srgbClr val="2F6FEB"/></a:hlink><a:folHlink><a:srgbClr val="8B5CF6"/></a:folHlink></a:clrScheme>
<a:fontScheme name="DSH"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="DSH">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="60000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="60000"/></a:schemeClr></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements></a:theme>`;

const EMPTY_TREE = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`;

const SLIDE_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;

const SLIDE_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank">${EMPTY_TREE}</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

export function buildDeck(markdown, title = "") {
  let slides = normalize(parseDeck(markdown));
  if (!slides.length) slides = [{ type: "title", title: title || "未命名演示", subtitle: "", body: [], table: null }];
  // 没有封面就补一页：直接进正文的演示，看着像缺了半截。
  if (slides[0].type !== "title") {
    slides.unshift({
      type: "title",
      title: title || slides[0].title || "未命名演示",
      subtitle: "",
      body: [],
      table: null,
    });
  }

  // 没有任何标题的页也要有个名字，否则页眉是空的。
  slides.forEach((s) => {
    if (!s.title && s.type !== "title") s.title = title || "未命名演示";
  });

  const total = slides.length;
  const parts = slides.map((s, idx) => {
    const bare = s.type === "body" && !s.body.length && !s.table;
    const shapes =
      s.type === "title" ? titleSlide(s, 2) : bare ? dividerSlide(s, 2) : bodySlide(s, 2, idx + 1, total);
    return { name: `ppt/slides/slide${idx + 1}.xml`, data: slideXml(shapes) };
  });

  const slideEntries = slides
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    )
    .join("");

  const presRels = slides
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${
          i + 1
        }.xml"/>`
    )
    .join("");

  const sldIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  const themeRid = slides.length + 2;

  const bytes = zipStore([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slideEntries}
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
    },
    {
      name: "ppt/presentation.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${sldIds}</p:sldIdLst>
<p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${presRels}
<Relationship Id="rId${themeRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`,
    },
    { name: "ppt/slideMasters/slideMaster1.xml", data: SLIDE_MASTER },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
    },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: SLIDE_LAYOUT },
    {
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
    },
    { name: "ppt/theme/theme1.xml", data: THEME },
    ...parts,
  ]);
  return { bytes, slides: slides.map((s, i) => ({ index: i + 1, title: s.title, type: s.type })) };
}
export function markdownToPptx(markdown, title = "") {
  return buildDeck(markdown, title).bytes;
}
