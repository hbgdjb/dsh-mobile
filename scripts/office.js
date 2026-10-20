/* ============================================================
   DSH Office — 无依赖的 Office 导出
   生成标准 OOXML（.docx / .xlsx），ZIP 使用 store 模式，
   浏览器与 WebView 内均可直接产出可被 Word / WPS / Excel 打开的文件。
   ============================================================ */

/* ---------------- CRC32 / ZIP ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  entries.forEach(({ name, data }) => {
    const nameBytes = enc.encode(name);
    const body = typeof data === "string" ? enc.encode(data) : data;
    const crc = crc32(body);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 文件名
    lv.setUint16(8, 0, true); // store
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, body.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, body.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  });

  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const all = [...locals, ...centrals, eocd];
  const total = all.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  all.forEach((a) => {
    out.set(a, p);
    p += a.length;
  });
  return out;
}

/* ---------------- XML / Markdown ---------------- */

const xml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

function inlineRuns(text) {
  // 把 **粗体**、`代码` 拆成 run；其余标记直接去掉
  const clean = String(text)
    .replace(/<span class="[^"]*">(.*?)<\/span>/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/~~([^~]+)~~/g, "$1");

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

function runXml(run, extra = "") {
  const props = [];
  if (run.bold) props.push("<w:b/>");
  if (run.mono) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
  if (extra) props.push(extra);
  const rpr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  return `<w:r>${rpr}<w:t xml:space="preserve">${xml(run.text)}</w:t></w:r>`;
}

function paraXml(text, opts = {}) {
  const { size = 22, bold = false, indent = 0, before = 0, after = 120, color, align } = opts;
  const runs = inlineRuns(text)
    .map((r) => runXml({ ...r, bold: r.bold || bold }, `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`))
    .join("");
  const ppr = [
    `<w:spacing w:before="${before}" w:after="${after}" w:line="300" w:lineRule="auto"/>`,
    indent ? `<w:ind w:left="${indent}"/>` : "",
    align ? `<w:jc w:val="${align}"/>` : "",
    color ? `<w:color w:val="${color}"/>` : "",
  ]
    .filter(Boolean)
    .join("");
  return `<w:p><w:pPr>${ppr}</w:pPr>${runs}</w:p>`;
}

function tableXml(rows, header) {
  const cols = Math.max(...rows.map((r) => r.length));
  const width = Math.floor(9360 / cols);
  const cell = (text, isHead) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${
      isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="F1F3F6"/>' : ""
    }</w:tcPr>${paraXml(text, {
      size: isHead ? 20 : 20,
      bold: isHead,
      after: 40,
      before: 40,
    })}</w:tc>`;

  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>
    <w:top w:val="single" w:sz="4" w:color="D9DEE6"/>
    <w:left w:val="single" w:sz="4" w:color="D9DEE6"/>
    <w:bottom w:val="single" w:sz="4" w:color="D9DEE6"/>
    <w:right w:val="single" w:sz="4" w:color="D9DEE6"/>
    <w:insideH w:val="single" w:sz="4" w:color="D9DEE6"/>
    <w:insideV w:val="single" w:sz="4" w:color="D9DEE6"/>
  </w:tblBorders></w:tblPr>${rows
    .map((r, i) => `<w:tr>${Array.from({ length: cols }, (_, j) => cell(r[j] ?? "", i === 0 && header)).join("")}</w:tr>`)
    .join("")}</w:tbl>`;
}

export function markdownToDocx(markdown, title = "Document") {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const body = [];
  let i = 0;

  if (title) {
    body.push(paraXml(title, { size: 40, bold: true, after: 80 }));
    body.push(paraXml(new Date().toLocaleDateString("zh-CN"), { size: 18, color: "8A909C", after: 240 }));
  }

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      buf.forEach((code) =>
        body.push(
          paraXml(code, {
            size: 18,
            indent: 240,
            after: 0,
            before: 0,
          })
        )
      );
      body.push(paraXml("", { after: 80 }));
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const size = [36, 30, 26, 24][h[1].length - 1];
      body.push(paraXml(h[2], { size, bold: true, before: 200, after: 100 }));
      i++;
      continue;
    }

    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1].trim())) {
      const split = (l) =>
        l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = split(line);
      i += 2;
      const rows = [head];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(split(lines[i++]));
      body.push(tableXml(rows, true));
      body.push(paraXml("", { after: 100 }));
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      body.push(paraXml(buf.join(" "), { size: 21, indent: 240, color: "5A6070" }));
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      body.push(
        paraXml(`${ordered ? li[2] : "•"} ${li[3]}`, {
          size: 21,
          indent: 300,
          after: 60,
        })
      );
      i++;
      continue;
    }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\||\s*([-*+]|\d+\.)\s)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    body.push(paraXml(buf.join(" "), { size: 21 }));
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join("")}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1200" w:bottom="1440" w:left="1200" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;

  return zipStore([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    { name: "word/document.xml", data: document },
  ]);
}

/* ---------------- XLSX ---------------- */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  const src = String(text).replace(/\r\n/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

function columnName(n) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function csvToXlsx(csv, sheetName = "Sheet1") {
  const rows = parseCsv(csv);
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.min(42, Math.max(10, ...rows.map((r) => String(r[c] ?? "").length + 2)))
  );

  const sheetRows = rows
    .map((r, ri) => {
      const cells = Array.from({ length: cols }, (_, ci) => {
        const raw = String(r[ci] ?? "");
        const ref = `${columnName(ci + 1)}${ri + 1}`;
        const style = ri === 0 ? ' s="1"' : "";
        if (raw === "") return "";
        if (/^-?\d+(\.\d+)?$/.test(raw) && !/^0\d/.test(raw)) {
          return `<c r="${ref}"${style}><v>${raw}</v></c>`;
        }
        return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(raw)}</t></is></c>`;
      }).join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${sheetRows}</sheetData>
</worksheet>`;

  const safeName = xml(String(sheetName).replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Sheet1");

  return zipStore([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
    {
      name: "xl/styles.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`,
    },
  ]);
}

/* ---------------- 编码 / 下载 ---------------- */

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function downloadBase64(name, base64, mime = "application/octet-stream") {
  const blob = new Blob([base64ToBytes(base64)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
