/* ============================================================
   Markdown — 轻量渲染器（无外部依赖，离线可用）
   支持：标题、段落、列表、引用、代码块、表格、分隔线、行内样式
   安全：先转义 HTML，仅恢复内容层允许的 delta 标记
   ============================================================ */

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const ALLOWED_SPAN = /<span class="delta-(up|down)">([\s\S]*?)<\/span>/g;

function inline(text) {
  const keep = [];
  let src = String(text).replace(ALLOWED_SPAN, (_, dir, inner) => {
    keep.push(`<span class="delta-${dir}">${escapeHtml(inner)}</span>`);
    return `\u0000${keep.length - 1}\u0000`;
  });

  // 行内代码先保护，避免内部符号被当作强调
  const codes = [];
  src = src.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0001${codes.length - 1}\u0001`;
  });

  src = escapeHtml(src);

  src = src
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(（])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  src = src
    .replace(/\u0001(\d+)\u0001/g, (_, i) => codes[+i])
    .replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);

  return src;
}

const isBlockStart = (line) =>
  /^(#{1,4}\s|```|>\s?|\s*([-*+]|\d+\.)\s+|\|)/.test(line) ||
  /^(---|\*\*\*|___)\s*$/.test(line);

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function renderMarkdown(source) {
  if (!source) return "";
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, "").trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束围栏
      out.push(
        `<pre${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeHtml(
          buf.join("\n")
        )}</code></pre>`
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // 分隔线
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // 引用（支持多行）
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // 表格
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1].trim())) {
      const head = splitRow(line);
      const sep = splitRow(lines[i + 1]);
      const align = sep.map((c) => {
        if (/^:.*:$/.test(c)) return "center";
        if (/^:$/.test(c)) return "right";
        return "left";
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = head
        .map((c, idx) => `<th style="text-align:${align[idx] || "left"}">${inline(c)}</th>`)
        .join("");
      const tb = rows
        .map(
          (r) =>
            `<tr>${r
              .map((c, idx) => `<td style="text-align:${align[idx] || "left"}">${inline(c)}</td>`)
              .join("")}</tr>`
        )
        .join("");
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    // 列表
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (!m) break;
        items.push(m[3]);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }

    // 段落
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }

  return out.join("");
}

export function plainText(md, max = 90) {
  const text = String(md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*`|_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
