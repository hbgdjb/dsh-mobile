/* ============================================================
   Tools — 工具注册表、虚拟工作区、权限与审批
   每个工具都是可被模型调用的普通函数；敏感操作走审批闸门。
   ============================================================ */

import {
  state,
  readFile,
  writeFile,
  writeBinaryFile,
  deleteFile,
  listFiles,
  listLibrary,
  saveToLibrary,
  readDoc,
  addAutomation,
  installPlugin,
  fmtTime,
  currentMode,
  currentPreset,
  save,
  emit,
  matchFilePath,
  pathKey,
} from "./store.js";
import { isImagePath } from "./image.js";
import { markdownToDocx, csvToXlsx, bytesToBase64, base64ToBytes } from "./office.js";
import { buildDeck } from "./pptx.js";
import { readPdf } from "./pdf.js";
import { buildPdf, markdownToBlocks } from "./pdf-write.js";
import { unpackZip, unsafeEntry } from "./zip.js";
import { mimeOf } from "./fs.js";
import { scanDangerous, scanSecrets, scanScriptRisks } from "./safety.js";
import { mcpToolSchemas, findMcpTool, mcpCall, formatMcpError, toMcpError } from "./mcp.js";
import { pluginToolSchemas, callPluginTool } from "./plugin-install.js";
import { nodeToolSchemas, callNodeTool } from "./node-plugins.js";
import { installHostImpl } from "./plugin-host.js";

const MAX_OUT = 6000;
const clip = (s, n = MAX_OUT) => {
  const str = typeof s === "string" ? s : String(s);
  return str.length > n ? `${str.slice(0, n)}\n…（输出已截断，共 ${str.length} 字符）` : str;
};

/* ---------------- 简易 diff（LCS，行级） ---------------- */

export function makeDiff(before, after) {
  const a = String(before || "").split("\n");
  const b = String(after || "").split("\n");
  if (a.length * b.length > 160000) {
    return b.map((s) => ({ t: "add", s: `+ ${s}` }));
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: "del", s: `- ${a[i]}` });
      i++;
    } else {
      out.push({ t: "add", s: `+ ${b[j]}` });
      j++;
    }
  }
  while (i < a.length) out.push({ t: "del", s: `- ${a[i++]}` });
  while (j < b.length) out.push({ t: "add", s: `+ ${b[j++]}` });
  return out.slice(0, 120);
}

/* ---------------- 沙箱命令 ---------------- */

/* ---------------- 字节与文件结构 ----------------
   终端不是真 Linux：二进制既不能用 cat，也不该假装能 cp 到 /tmp 再用 od 看。
   这里提供一套“看得见”的原语：字节视图、ZIP 目录、类型识别。 */

const enc = new TextEncoder();

const fmtSize = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

/** 把 readFile 的结果还原成字节。 */
export function bytesOfDoc(doc) {
  if (!doc) return new Uint8Array(0);
  if (doc.encoding !== "base64") return enc.encode(String(doc.content ?? ""));
  const bin = atob(String(doc.content || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

const asciiOf = (b) => Array.from(b, (x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("");
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

/** 能按 UTF-8 完整解码、且没有 NUL 的，就当文本写（cat / grep 才能用）。 */
function isProbablyText(bytes) {
  if (!bytes || !bytes.length) return true;
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 压缩包内条目 ---------------- */

const ARCHIVE_RE = /\.(zip|apk|aab|docx|xlsx|pptx|jar)$/i;

/**
 * 把 `pkg.zip!a/b.md` 或 `pkg.zip/a/b.md` 拆成包与条目。
 *
 * 为什么要接这种写法：模型的脑子里「zip 是个目录」，读完 fs_inspect 的
 * 条目列表就会直接拼成 `uploads/x.zip/onetake/安装说明.md` 去读。与其
 * 每次都让它先解压，不如认出这个意图、把条目读出来 —— 少一轮往返，
 * 也少一次「文件不存在」。
 */
export function splitArchivePath(raw) {
  const p = String(raw || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const bang = p.indexOf("!");
  if (bang > 0) return { zip: p.slice(0, bang), inner: p.slice(bang + 1).replace(/^\/+/, "") };
  const m = p.match(/^(.*\.(?:zip|apk|aab|docx|xlsx|pptx|jar))\/(.+)$/i);
  if (m) return { zip: m[1], inner: m[2] };
  return null;
}

/** 包内条目名匹配：先精确，再忽略大小写，最后按 basename。 */
function pickEntry(entries, inner) {
  const want = String(inner || "").replace(/^\/+/, "");
  if (!want) return null;
  return (
    entries.find((e) => e.path === want) ||
    entries.find((e) => e.path.toLowerCase() === want.toLowerCase()) ||
    (want.includes("/") ? null : entries.find((e) => e.path.toLowerCase().endsWith("/" + want.toLowerCase())))
  );
}

/** 读压缩包里的一个条目。返回 null 表示「这条路不像包内路径」。 */
async function readArchiveEntry(raw) {
  const split = splitArchivePath(raw);
  if (!split || !split.inner) return null;
  const doc = await readFile(split.zip);
  if (!doc) {
    return { ok: false, output: `文件不存在：${split.zip}（压缩包本身不在工作区）` };
  }
  let entries;
  try {
    entries = await unpackZip(bytesOfDoc(doc));
  } catch (e) {
    return { ok: false, output: `${split.zip} 解不开：${e.message}` };
  }
  const hit = pickEntry(entries, split.inner);
  if (!hit) {
    const names = entries.slice(0, 30).map((e) => `  ${e.path}`).join("\n");
    return {
      ok: false,
      output: [
        `${split.zip} 里没有条目「${split.inner}」`,
        `包内共 ${entries.length} 个文件：`,
        names,
        entries.length > 30 ? `  … 还有 ${entries.length - 30} 个` : "",
        `条目名要跟上面完全一致；读法：fs_read(path="${split.zip}!条目名")`,
        `要整体落盘：shell 里执行 unzip ${split.zip} -d <目录>`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (isProbablyText(hit.bytes)) {
    return { ok: true, output: clip(new TextDecoder().decode(hit.bytes)) };
  }
  return { ok: true, output: describeBytes(hit.bytes, `${split.zip}!${hit.path}`) };
}

/**
 * 「文件不存在」要说清三件事：是不是把压缩包当目录了、shell 目录在哪、
 * 附近到底有什么。只回一句「文件不存在 + 一串路径」时，模型只能靠猜，
 * 猜错三次就开始整份重写 —— 这是返工的主要来源之一。
 */
function missingPathHint(raw) {
  const files = listFiles();
  const lines = [`文件不存在：${raw}`];
  const cwd = currentShellCwd();
  const clean = String(raw || "").replace(/^\.?\//, "");
  if (cwd && clean && !clean.startsWith(`${cwd}/`)) {
    lines.push(
      `当前 shell 目录是 ${cwd}/。fs_read / fs_inspect 的路径从工作区根算，` +
        `若文件相对 shell 目录，要写成 ${cwd}/${clean}`
    );
  }
  const split = splitArchivePath(raw);
  if (split) {
    lines.push(`${split.zip} 是压缩包（单个文件），内部条目不能当目录路径用。`);
    lines.push(`读法一：fs_read(path="${split.zip}!${split.inner}")`);
    lines.push(`读法二：shell 里 unzip ${split.zip} -d <目录>，之后再按普通文件读`);
  }
  const list = files.slice(0, 40).map((f) => {
    const tag = ARCHIVE_RE.test(f.path) ? "  [压缩包]" : f.encoding === "base64" ? "  [二进制]" : "";
    return `  ${f.path}${tag}`;
  });
  lines.push(
    files.length
      ? `可用文件${files.length > 40 ? `（前 40 个，共 ${files.length} 个）` : ""}：`
      : "工作区当前没有文件"
  );
  lines.push(...list);
  return lines.join("\n");
}

/** 字节 ↔ 单字节字符串（管道里传二进制用）。 */
const latin1Of = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
  return s;
};
const bytesOfLatin1 = (s) => {
  const str = String(s ?? "");
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) out[i] = str.charCodeAt(i) & 0xff;
  return out;
};

/** 行式十六进制视图（od / xxd 的简化版）。 */
export function hexDump(bytes, { offset = 0, length = 256, base = 0 } = {}) {
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const take = Math.max(1, Math.min(Number(length) || 256, 4096));
  const slice = bytes.subarray(start, start + take);
  const lines = [];
  for (let i = 0; i < slice.length; i += 16) {
    const row = slice.subarray(i, i + 16);
    lines.push(`${(start + i + base).toString(16).padStart(8, "0")}  ${hexOf(row).padEnd(47)}  |${asciiOf(row)}|`);
  }
  return lines.length ? lines.join("\n") : "（空）";
}

/** 读 ZIP 中央目录（APK / Office / 普通压缩包共用）。 */
export function zipEntries(bytes) {
  if (bytes.length < 22) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= floor; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const total = dv.getUint16(eocd + 10, true);
  const cd = dv.getUint32(eocd + 16, true);
  const out = [];
  let p = cd;
  for (let i = 0; i < total && p + 46 <= bytes.length; i += 1) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const comp = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const name = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, size, comp, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function detectKind(bytes, path = "") {
  const b = bytes;
  const ext = String(path).split(".").pop().toLowerCase();
  const isZip = b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05);
  if (isZip) {
    if (ext === "apk") return { kind: "zip", label: "Android APK" };
    if (ext === "aab") return { kind: "zip", label: "Android App Bundle" };
    if (/^(docx|xlsx|pptx)$/.test(ext)) return { kind: "zip", label: `Office 文档（${ext}）` };
    return { kind: "zip", label: "ZIP 压缩包" };
  }
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return { kind: "pdf", label: "PDF 文档" };
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { kind: "png", label: "PNG 图片" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "jpg", label: "JPEG 图片" };
  if (b.length >= 4 && b[0] === 0x64 && b[1] === 0x65 && b[2] === 0x78 && b[3] === 0x0a) return { kind: "dex", label: "Dalvik DEX" };
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return { kind: "elf", label: "ELF 可执行文件" };
  // 文本必须认出来。以前这里直接落到「二进制数据」—— 所有 .md / .js /
  // .json 都被判成二进制。截图里模型看到 `file SKILL.md → 二进制数据`，
  // 于是下结论「这个 SKILL.md 本身是坏的，中文被转成了非法字节」，
  // 差点放弃整包。文件没坏，是判断太粗。
  if (isProbablyText(b)) {
    const head = new TextDecoder().decode(b.subarray(0, 4096));
    if (/^\s*[\[{]/.test(head)) {
      try {
        JSON.parse(new TextDecoder().decode(b));
        return { kind: "json", label: "JSON" };
      } catch {
        /* 只是以 { 开头的文本，继续往下判 */
      }
    }
    if (/^\s*<(!doctype|html|\?xml)/i.test(head)) {
      return { kind: "html", label: ext === "svg" ? "SVG 图片（文本）" : "HTML / XML" };
    }
    if (/^#!/.test(head)) return { kind: "script", label: "可执行脚本（shebang）" };
    const byExt = {
      md: "Markdown",
      markdown: "Markdown",
      txt: "纯文本",
      log: "日志文本",
      js: "JavaScript",
      mjs: "JavaScript",
      cjs: "JavaScript",
      ts: "TypeScript",
      jsx: "JavaScript",
      tsx: "TypeScript",
      css: "CSS",
      scss: "CSS",
      html: "HTML",
      htm: "HTML",
      json: "JSON",
      py: "Python 源码",
      sh: "Shell 脚本",
      yml: "YAML",
      yaml: "YAML",
      csv: "CSV",
      tsv: "TSV",
      xml: "XML",
      svg: "SVG 图片（文本）",
      ini: "配置文件",
      toml: "配置文件",
      env: "配置文件",
    }[ext];
    return { kind: "text", label: byExt || "文本" };
  }
  return { kind: "bin", label: "二进制数据" };
}

/** 生成一份可直接放进上下文的结构化描述（不依赖模型去猜）。 */
export function describeBytes(bytes, path = "", { maxEntries = 24 } = {}) {
  const kind = detectKind(bytes, path);
  const lines = [`文件：${path}`, `类型：${kind.label}`, `大小：${fmtSize(bytes.length)}（${bytes.length} 字节）`];
  // 文本文件直接给前几行。以前不管什么类型都先甩 hex 头，
  // 模型看到一串 `2d 2d 2d 0a` 就以为「文件是二进制 / 编码坏了」，
  // 截图里那句「SKILL.md 本身是坏的」就是这么来的。
  const textLike = ["text", "json", "html", "script"].includes(kind.kind);
  if (textLike) {
    const all = new TextDecoder().decode(bytes).split(/\r?\n/);
    const preview = all.slice(0, 12);
    lines.push(`前 ${preview.length} 行：`);
    preview.forEach((l, i) => {
      const shown = l.length > 180 ? `${l.slice(0, 180)}…` : l;
      lines.push(`  ${String(i + 1).padStart(3)} | ${shown}`);
    });
    if (all.length > preview.length) lines.push(`  … 还有 ${all.length - preview.length} 行`);
    lines.push(`读全文：fs_read(path="${path}")；按行找：grep -n 关键词 ${path}`);
  } else {
    lines.push(`头 32 字节：${hexOf(bytes.subarray(0, 32)) || "（空）"}`, `可打印：|${asciiOf(bytes.subarray(0, 32))}|`);
  }
  if (kind.kind === "zip") {
    const entries = zipEntries(bytes);
    if (entries) {
      const unpacked = entries.reduce((s, e) => s + (Number(e.size) || 0), 0);
      const isApk = entries.some((e) => e.name === "AndroidManifest.xml") && entries.some((e) => e.name === "classes.dex");
      lines.push(`内容：${entries.length} 个条目，解压后约 ${fmtSize(unpacked)}${isApk ? "；含 AndroidManifest.xml 与 classes.dex，可判定为 APK" : ""}`);
      entries.slice(0, maxEntries).forEach((e) => lines.push(`  ${e.name}  ${fmtSize(Number(e.size) || 0)}`));
      if (entries.length > maxEntries) lines.push(`  … 还有 ${entries.length - maxEntries} 个条目`);
      lines.push(
        `以上是包内条目，不是工作区文件。读其中一个：fs_read(path="${path}!条目名")；` +
          `整体落盘：shell 里执行 unzip ${path} -d <目录>。`
      );
    } else {
      lines.push("内容：ZIP 目录未能解析（可能不是完整压缩包）");
    }
  } else if (kind.kind === "pdf") {
    const text = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 200000)));
    const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
    const version = (text.match(/%PDF-(\d\.\d)/) || [])[1] || "?";
    lines.push(`PDF 版本 ${version}${pages ? `，约 ${pages} 页` : ""}`);
  }
  if (!textLike) {
    lines.push(`看片段用 fs_read(path="${path}", offset=0, length=256, format="hex")；二进制不要用 cat，也不要用 cp 挪到 /tmp 再 od。`);
  }
  return lines.join("\n");
}

/**
 * 一次性取到文件的字节与描述，供工具和附件摘要复用。
 * opts.area：附件可能来自资料库（library），需按区域读取。
 */
export async function inspectPath(path, opts = {}) {
  const doc = opts.area === "library" ? await readDoc("library", path) : await readFile(path);
  if (!doc) return null;
  const bytes = bytesOfDoc(doc);
  return { doc, bytes, text: describeBytes(bytes, path, opts) };
}

/* ---------------- 命令分词 ---------------- */

/** 按 shell 习惯切分：支持单/双引号与反斜杠转义，括号、空格原样保留。 */
export function tokenizeCommand(input) {
  const src = String(input || "");
  const out = [];
  let cur = "";
  let quote = "";
  let touched = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = "";
      else if (ch === "\\" && quote === '"' && i + 1 < src.length) cur += src[(i += 1)];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      touched = true;
      continue;
    }
    if (ch === "\\" && i + 1 < src.length) {
      cur += src[(i += 1)];
      touched = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || touched) {
        out.push(cur);
        cur = "";
        touched = false;
      }
      continue;
    }
    cur += ch;
  }
  if (cur || touched) out.push(cur);
  return out;
}

/**
 * 切行：末尾那个换行不额外算一行。
 * `"a\nb\n".split("\n")` 是 3 段，但文件只有 2 行 —— 模型用
 * `wc -l` / `grep -c ''` 数行数时，多出来的 1 会让它误判文件被截断。
 */
const linesOf = (text) => {
  const s = String(text ?? "");
  if (!s) return [];
  const arr = s.split("\n");
  if (arr.length > 1 && arr[arr.length - 1] === "") arr.pop();
  return arr;
};

/**
 * 去掉 `2>/dev/null`、`2>&1` 这类 stderr 重定向。
 *
 * 沙箱没有独立的 stderr，错误本来就和正常输出一起返回；但模型习惯性会写
 * `ls -d a b 2>/dev/null` 来压掉"不存在"的抱怨。留着这些字符，它们会被
 * 当成普通参数 —— 截图里的 `cd ~ 2>/dev/null && pwd` 就是这样连 `cd`
 * 都识别不了，还回了句"沙箱终端不支持 cd"，整条 && 链全断。
 *
 * 只认这三种写法，不做通用剥离：`echo 2 > out` 里的 2 是参数，不能误伤。
 */
function stripStderr(text) {
  return String(text || "")
    .replace(/\s+2\s*>\s*&\s*[12]\b/g, " ")
    .replace(/\s+2\s*>\s*\/dev\/null\b/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function runOne(command, stdin = "", stdinBytes = null, cwd = "", clipOut = true) {
  const cmd = stripStderr(String(command || "").trim());
  if (!cmd) return { ok: false, output: "空命令" };
  // 管道中间那段不能截断：`head -n 700 文件 | tail -n 2` 若 head 先 clip 到
  // 6000 字，tail 拿到的就是第 178 行而不是第 700 行。只在最终输出处收口。
  const outClip = (s) => (clipOut ? clip(s) : String(s ?? ""));

  // 解析成 head + flags + args；引号包裹的 "base(1).apk" 会作为整体保留
  const tokens = tokenizeCommand(cmd);
  const head = tokens.shift();
  const isFlag = (t) => /^-{1,2}[A-Za-z]/.test(t);
  const flags = tokens.filter(isFlag);
  const args = tokens.filter((t) => !isFlag(t));
  const files = listFiles();
  const paths = files.map((f) => f.path);
  const rel = (v) =>
    String(v || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/^\/+/, "")
      .replace(/^workspace\//i, "")
      .replace(/\/+$/, "");
  // 宽松解析：括号全半角、空格、大小写、URL 编码差异都能对上。
  // `cd <目录> && …` 时优先按 cwd 前缀找，避免同名文件被别的目录抢走。
  // `../` 先折掉：模型在子目录里会用 `../../a.md` 回外层，字面拼接找不到。
  const resolve = (raw) => {
    const v = rel(raw);
    // `.` 是"当前目录"，不是根。normalizeCwd 把 "." 归零是给 `cd .` 用的
    // 语义，套到路径解析上会让 `cd pkg; realpath .` 回答 /workspace。
    const joined = v === "." || v === "" ? cwd : normalizeCwd(cwd, v);
    return (joined ? matchFilePath(paths, joined) : "") || matchFilePath(paths, raw) || joined;
  };
  const flagOn = (ch) => flags.some((f) => f.replace(/^-+/, "").includes(ch));
  // `ls *.zip`、`cat parts/*.html` 是模型的高频写法。以前整串被当成
  // 字面路径，回一句「*.zip/ 下没有文件」，它只能改成逐个列文件名。
  const globRe = (pat) =>
    new RegExp(
      "^" +
        pat
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]") +
        "$"
    );
  const expand = (raw) => {
    const p = rel(raw);
    if (!p) return [];
    if (!/[*?]/.test(p)) return [resolve(raw)];
    const re = globRe(p);
    return paths.filter((x) => re.test(x)).sort();
  };
  const missing = (name, raw) => {
    const p = rel(raw);
    // 把目录当文件用：`cat pkg`、`head pkg`、`wc pkg` 都会走到这里。
    // 只回「文件不存在」会让模型以为目录没建成，然后重试别的写法。
    if (p && paths.some((x) => x.startsWith(`${p}/`))) {
      return `${name}: ${p} 是目录，不是文件。查看里面有什么：ls ${p}`;
    }
    const key = pathKey(raw);
    const near =
      key.length >= 3
        ? paths
            .filter((p) => {
              const kp = pathKey(p);
              return kp.includes(key) || key.includes(kp);
            })
            .slice(0, 4)
        : [];
    const list = (near.length ? near : paths.slice(0, 12)).map((p) => `  ${p}`).join("\n") || "  （空）";
    return `${name}: ${rel(raw) || "(未指定文件)"} 文件不存在${near.length ? "\n你可能想找：" : "\n现有文件："}\n${list}`;
  };
  const fmtTime = (ts) => new Date(Number(ts) || Date.now()).toISOString().slice(0, 16).replace("T", " ");

  /** sort / uniq / cut 这类过滤命令的通用输入：给了文件读文件，没给读管道。 */
  const readArgText = async (name, list) => {
    if (!list || !list.length) return { ok: true, text: String(stdin || "") };
    const parts = [];
    for (const raw of list) {
      const d = await readFile(resolve(raw));
      if (!d) return { ok: false, output: missing(name, raw) };
      if (d.encoding === "base64") return { ok: false, output: `${name}: ${rel(raw)} 是二进制文件；用 od / xxd 看字节` };
      parts.push(String(d.content || ""));
    }
    return { ok: true, text: parts.join("") };
  };

  switch (head) {
    case "pwd":
      return { ok: true, output: cwd ? `/workspace/${cwd}` : "/workspace" };

    // `… || true` 的落点。没有它，模型写的兜底反而成了新的失败源。
    case "true":
      return { ok: true, output: "" };
    case "false":
      return { ok: false, output: "" };

    /* ---------------- 文本与路径工具 ----------------
       模型处理插件包时，一半以上的命令是「列出 → 过滤 → 去重 → 看 basename」。
       缺一个 sort 就能让整条管道失败（截图里 `grep … | sort -u` 就是），
       它再换个写法重试，失败率就这么堆起来了。这里补齐高频的几种。 */
    case "sort": {
      const got = await readArgText("sort", args);
      if (!got.ok) return got;
      const lines = got.text.split("\n");
      const tailEmpty = lines.length > 0 && lines[lines.length - 1] === "";
      const arr = tailEmpty ? lines.slice(0, -1) : lines;
      const numeric = flagOn("n");
      const fold = flagOn("f");
      const reverse = flagOn("r");
      const unique = flagOn("u");
      const keyFlag = flags.find((f) => /^-k\d/.test(f));
      const keyIdx = keyFlag ? Math.max(1, parseInt(keyFlag.slice(2), 10)) - 1 : 0;
      const cmp = (a, b) => {
        const av = keyIdx ? String(a).split(/\s+/)[keyIdx] || "" : a;
        const bv = keyIdx ? String(b).split(/\s+/)[keyIdx] || "" : b;
        if (numeric) {
          const an = parseFloat(av);
          const bn = parseFloat(bv);
          return (Number.isNaN(an) ? 0 : an) - (Number.isNaN(bn) ? 0 : bn);
        }
        const as = fold ? String(av).toLowerCase() : String(av);
        const bs = fold ? String(bv).toLowerCase() : String(bv);
        return as < bs ? -1 : as > bs ? 1 : 0;
      };
      let out = arr.slice().sort(cmp);
      if (unique) out = out.filter((v, i) => i === 0 || cmp(out[i - 1], v) !== 0);
      if (reverse) out = out.slice().reverse();
      return { ok: true, output: outClip(out.join("\n")) };
    }

    case "uniq": {
      const got = await readArgText("uniq", args);
      if (!got.ok) return got;
      const count = flagOn("c");
      const onlyDup = flagOn("d");
      const onlyUnique = flagOn("u");
      const rows = [];
      const src = got.text.endsWith("\n") ? got.text.slice(0, -1) : got.text;
      for (const line of src.split("\n")) {
        const last = rows[rows.length - 1];
        if (last && last.v === line) last.n += 1;
        else rows.push({ v: line, n: 1 });
      }
      let picked = rows;
      if (onlyDup) picked = picked.filter((r) => r.n > 1);
      if (onlyUnique) picked = picked.filter((r) => r.n === 1);
      const out = picked.map((r) => (count ? `${String(r.n).padStart(7)} ${r.v}` : r.v));
      return { ok: true, output: outClip(out.join("\n")) };
    }

    case "basename": {
      const raw = args[0];
      if (!raw) return { ok: false, output: "用法：basename 路径 [后缀]" };
      const parts = rel(raw).split("/").filter(Boolean);
      let base = parts.length ? parts[parts.length - 1] : rel(raw) || "/";
      const suffix = args[1];
      if (suffix && suffix !== base && base.endsWith(suffix)) base = base.slice(0, -suffix.length);
      return { ok: true, output: base };
    }

    case "dirname": {
      const raw = args[0];
      if (!raw) return { ok: false, output: "用法：dirname 路径" };
      const parts = rel(raw).split("/").filter(Boolean);
      parts.pop();
      return { ok: true, output: parts.length ? parts.join("/") : "." };
    }

    case "cut": {
      const list = [...args];
      let delim = "\t";
      let fields = "";
      let chars = "";
      const dJoin = flags.find((f) => /^-d.+$/.test(f));
      if (dJoin) delim = dJoin.slice(2);
      else if (flags.includes("-d") && list.length && list[0].length === 1) delim = list.shift();
      const fJoin = flags.find((f) => /^-f.+$/.test(f));
      if (fJoin) fields = fJoin.slice(2);
      else if (flags.includes("-f") && list.length) fields = list.shift();
      const cJoin = flags.find((f) => /^-c.+$/.test(f));
      if (cJoin) chars = cJoin.slice(2);
      if (!fields && !chars) return { ok: false, output: "用法：cut -d 分隔符 -f 1,3 文件（或 cut -c1-5 文件）" };
      const got = await readArgText("cut", list);
      if (!got.ok) return got;
      const span = (len, spec) => {
        const picks = [];
        for (const part of String(spec).split(",")) {
          const m = part.match(/^(\d+)(?:-(\d*))?$/);
          if (!m) continue;
          const a = Number(m[1]);
          const b = m[2] === undefined ? a : m[2] === "" ? len : Number(m[2]);
          for (let i = a; i <= b; i += 1) picks.push(i - 1);
        }
        return picks;
      };
      const src = got.text.endsWith("\n") ? got.text.slice(0, -1) : got.text;
      const out = src.split("\n").map((line) => {
        if (chars) {
          const arr = [...line];
          return span(arr.length, chars).map((i) => arr[i] ?? "").join("");
        }
        const cols = line.split(delim);
        return span(cols.length, fields).map((i) => cols[i] ?? "").join(delim);
      });
      return { ok: true, output: outClip(out.join("\n")) };
    }

    case "tr": {
      const del = flagOn("d");
      const unescape = (s) =>
        String(s || "")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\r/g, "\r")
          .replace(/\\\\/g, "\\");
      const expandSet = (s) => {
        const src = unescape(s);
        let out = "";
        for (let i = 0; i < src.length; i += 1) {
          if (src[i + 1] === "-" && i + 2 < src.length) {
            const a = src.charCodeAt(i);
            const b = src.charCodeAt(i + 2);
            for (let c = a; c <= b; c += 1) out += String.fromCharCode(c);
            i += 2;
          } else {
            out += src[i];
          }
        }
        return out;
      };
      const from = expandSet(args[0]);
      if (!from) return { ok: false, output: "用法：tr [-d] 字符集 [替换字符集]（从管道读输入）" };
      const text = String(stdin || "");
      if (del) {
        const drop = new Set([...from]);
        return { ok: true, output: outClip([...text].filter((ch) => !drop.has(ch)).join("")) };
      }
      const to = expandSet(args[1]);
      if (!to) return { ok: false, output: "用法：tr 字符集 替换字符集" };
      const map = new Map();
      [...from].forEach((ch, i) => map.set(ch, to[i] ?? to[to.length - 1]));
      return { ok: true, output: outClip([...text].map((ch) => map.get(ch) ?? ch).join("")) };
    }

    case "stat": {
      const target = args.find((a) => !String(a).includes("%")) || args[args.length - 1];
      if (!target) return { ok: false, output: "用法：stat [-c 格式] 文件" };
      const p = resolve(target);
      const f = files.find((x) => x.path === p);
      if (!f) return { ok: false, output: missing("stat", target) };
      const fmtRaw = args.find((a) => String(a).includes("%")) || "%n %s";
      const fmt = String(fmtRaw).replace(/^["']|["']$/g, "");
      const out = fmt
        .replace(/%n/g, f.path)
        .replace(/%s/g, String(Number(f.size) || 0))
        .replace(/%y/g, fmtTime(f.updatedAt))
        .replace(/%F/g, "regular file");
      return { ok: true, output: out };
    }

    case "du": {
      const base = args[0] ? rel(args[0]) : cwd || "";
      const kids = base ? files.filter((f) => f.path === base || f.path.startsWith(`${base}/`)) : files;
      if (!kids.length) return { ok: false, output: missing("du", args[0] || base || ".") };
      const total = kids.reduce((n, f) => n + (Number(f.size) || 0), 0);
      const human = (n) => (flagOn("h") ? (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}K`) : String(n));
      const shown = human(total);
      if (flagOn("a")) {
        const rows = kids
          .map((f) => [f.path, Number(f.size) || 0])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 60)
          .map(([p, n]) => `${human(n)}\t${p}`);
        return { ok: true, output: outClip([...rows, `${shown}\t${base || "."}`].join("\n")) };
      }
      return { ok: true, output: `${shown}\t${base || "."}` };
    }

    case "realpath": {
      // `.` / `..` / 目录本身以前一律报「文件不存在」：这里只查了
      // paths.includes(p)，而 paths 里全是文件。截图里模型 `cd /workspace`
      // 之后跑 `realpath .` 想确认自己站在哪，结果拿到一个失败卡片，
      // 只好改用 pwd —— 一条本不该存在的绕路。
      const raw = args[0] || ".";
      const key = pathKey(resolve(raw));
      const isFile = key ? paths.includes(key) : false;
      const isDir = !key || paths.some((x) => x.startsWith(`${key}/`));
      if (!isFile && !isDir) return { ok: false, output: missing("realpath", raw) };
      return { ok: true, output: `/workspace${key ? `/${key}` : ""}` };
    }

    case "find": {
      // 只实现最常用的三件：-name / -type / -maxdepth。
      // 复杂表达式（-o、-exec）不猜，按"没找到"返回，让模型换写法。
      const startM = cmd.match(/^find\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
      let base = startM ? rel(startM[1] || startM[2] || startM[3]) : cwd || "";
      if (base === "." || base === "./") base = cwd || "";
      if (String(base).startsWith("-")) base = cwd || "";
      const nameM = cmd.match(/-name\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
      const pat = nameM ? nameM[1] || nameM[2] || nameM[3] : "";
      const typeM = cmd.match(/-type\s+([fd])/);
      const depthM = cmd.match(/-maxdepth\s+(\d+)/);
      let list = files.filter((f) => !base || f.path === base || f.path.startsWith(`${base}/`));
      if (pat) {
        const re = globRe(pat);
        list = list.filter((f) => re.test(f.path.split("/").pop()));
      }
      if (depthM) {
        const max = Number(depthM[1]);
        list = list.filter((f) => {
          const rest = base ? f.path.slice(base.length + 1) : f.path;
          return rest.split("/").length <= max;
        });
      }
      if (typeM && typeM[1] === "d") {
        const dirs = new Set();
        for (const f of list) {
          const rest = base ? f.path.slice(base.length + 1) : f.path;
          const parts = rest.split("/");
          parts.pop();
          for (let i = 1; i <= parts.length; i += 1) {
            dirs.add((base ? `${base}/` : "") + parts.slice(0, i).join("/"));
          }
        }
        const rows = [...dirs].sort().map((p) => (base ? p : `./${p}`));
        return { ok: true, output: outClip(rows.join("\n")) };
      }
      // 和真 find 一样：给了起点就把起点带上（find pkg → pkg/a.md），
      // 起点是 "." 才用 ./ 前缀。以前一律加 ./，模型照着读又找不到。
      const rows = list.sort().map((f) => (base ? f.path : `./${f.path}`));
      return { ok: true, output: outClip(rows.join("\n")) };
    }

    case "ls": {
      const long = flagOn("l");
      // cd 之后按**相对当前目录**显示。以前不管 cwd 都打印全路径，模型
      // 看到 `onetake-install/onetake/SKILL.md` 就以为 cd 没生效（日志里
      // 的原话是「cd 似乎没有跨调用保留」），于是后面每条命令都重写全路径。
      const fromCwd = (p) => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);
      const listOne = (f) =>
        long
          ? `${String(Number(f.size) || 0).padStart(9)} B  ${fmtTime(f.updatedAt)}  ${fromCwd(f.path)}`
          : fromCwd(f.path);
      const raw = args[0] || "";
      // `ls -d a b` 只回答「这些路径在不在」，不展开内容。
      // 模型用它探测目录（配置目录、插件目录），以前 -d 被忽略，
      // 结果是列出一堆文件，它反而判断不出目录是否存在。
      if (flagOn("d")) {
        const items = args.length ? args : ["."];
        const rows = [];
        const gone = [];
        for (const a of items) {
          const cands = /[*?]/.test(a) ? expand(a) : [resolve(a)];
          for (const c of cands) {
            const k = pathKey(c);
            const isDir = paths.some((x) => x.startsWith(`${k}/`));
            const isFile = paths.includes(k);
            if (!isDir && !isFile) gone.push(a);
            else rows.push(rel(c) || ".");
          }
        }
        // 全都不存在 = 失败。以前这里返回 ok:true 并把「不存在」写进输出，
        // 结果是 `ls -d skills … 2>/dev/null || echo "没有"` 里的 echo 永远
        // 不执行，模型还得自己从五行「不存在」里推断结论（截图就是这样）。
        // 真 ls 也是非零退出，只是把错误写到 stderr。
        if (!rows.length) {
          return {
            ok: false,
            output: gone.map((a) => `ls: 无法访问 '${a}': 没有那个文件或目录`).join("\n"),
          };
        }
        // 部分存在：只列存在的，和真 ls 的 stdout 一致；缺的那些走 stderr，
        // 已经在上面按 `2>/dev/null` 的语义处理。
        return { ok: true, output: rows.join("\n") };
      }
      if (/[*?]/.test(raw)) {
        const hits = expand(raw);
        if (!hits.length) return { ok: true, output: `${raw}：没有匹配的文件` };
        return { ok: true, output: hits.map((p) => listOne(files.find((f) => f.path === p) || { path: p })).join("\n") };
      }
      const prefix = rel(raw || cwd);
      const key = pathKey(prefix);
      const hits = files.filter((f) => {
        if (!prefix) return true;
        const fp = pathKey(f.path);
        return fp === key || fp.startsWith(`${key}/`);
      });
      // 空目录不是失败。`mkdir x && ls x` 是很常见的写法，报 ok:false 会让
      // 模型以为目录没建成或命令出错，接着换写法重试 —— 失败率里有一截是
      // 这么来的。真正该说的是「这里确实没东西，以及附近有什么」。
      if (!hits.length) {
        const top = prefix ? prefix.split("/")[0] : "";
        const near = top ? paths.filter((p) => p.startsWith(`${top}/`)) : [];
        const tops = [...new Set(paths.map((p) => p.split("/")[0]))];
        return {
          ok: true,
          output: [
            `${prefix ? prefix + "/" : "/"} 下没有文件`,
            near.length
              ? `这个目录下现有：\n${near.slice(0, 12).map((p) => `  ${p}`).join("\n")}`
              : `现有顶层：${tops.slice(0, 12).join("、") || "（空工作区）"}`,
            "（目录按需创建：mkdir 只标记意图，真正落盘发生在写文件时）",
          ].join("\n"),
        };
      }
      return {
        ok: true,
        output: hits
          .slice()
          .sort((a, b) => a.path.localeCompare(b.path, "zh"))
          .map(listOne)
          .join("\n"),
      };
    }

    case "cat": {
      if (!args.length) return { ok: false, output: "用法：cat <文件> [更多文件…]" };
      const parts = [];
      for (const raw of args) {
        if (rel(raw) === "dev/null") continue;
        const list = expand(raw);
        if (!list.length) return { ok: false, output: `${raw}：没有匹配的文件` };
        for (const p of list) {
          const f = await readFile(p);
          if (!f) return { ok: false, output: missing("cat", p) };
          if (f.encoding === "base64") {
            return {
              ok: false,
              output: `cat: ${p} 是二进制（${((Number(f.size) || 0) / 1024).toFixed(1)} KB），不能按文本输出${isImagePath(p) ? "；这是图片，只能作为附件发给模型看" : ""}。`,
            };
          }
          parts.push(String(f.content || ""));
        }
      }
      // 真实 cat 多文件是**纯拼接**，不插文件名头、不补换行。
      // 0.70.0 之前这里套了 head/tail 的 `==> 文件 <==` 头，还用 "\n" join，
      // 模型拿 `cat parts/*.html > page.html` 拼页面时，产物里就混进了
      // 文件名头和多余空行 —— 它只好反复「重写分段再单文件重组」来绕。
      return { ok: true, output: outClip(parts.join("")) };
    }

    case "wc": {
      let text;
      if (args[0]) {
        const p = resolve(args[0]);
        const f = await readFile(p);
        if (!f) return { ok: false, output: missing("wc", args[0]) };
        if (f.encoding === "base64") return { ok: true, output: `${Number(f.size) || 0} 字节（二进制文件）` };
        text = String(f.content || "");
      } else {
        // `… | wc -l` 是数行数的常用写法，以前会直接报"用法"错误
        if (!stdin) return { ok: false, output: "用法：wc [-l] [-w] [-c] <文件>，或 … | wc -l" };
        text = String(stdin);
      }
      const lines = linesOf(text).length;
      const chars = [...text].length;
      const bytes = new TextEncoder().encode(text).length;
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      // -c 在 GNU wc 里是**字节数**，不是字符数。模型拿 `wc -c` 判断文件
      // 有多大、要不要分段读，之前回「36 字符」而实际 40 字节（中文占 3 字节），
      // 它会怀疑文件被写坏了；-m 才是字符数。
      const picked = [
        flagOn("l") ? `${lines} 行` : "",
        flagOn("w") ? `${words} 词` : "",
        flagOn("c") ? `${bytes} 字节` : "",
        flagOn("m") ? `${chars} 字符` : "",
      ].filter(Boolean);
      return { ok: true, output: picked.length ? picked.join(" · ") : `${lines} 行 · ${bytes} 字节` };
    }

    case "file": {
      if (!args[0]) return { ok: false, output: "用法：file <文件>" };
      const path = resolve(args[0]);
      const meta = files.find((f) => f.path === path);
      if (!meta) return { ok: false, output: missing("file", args[0]) };
      const size = Number(meta.size) || 0;
      let kind = "data";
      if (size <= 32 * 1024 * 1024) {
        const doc = await readFile(path);
        if (doc) kind = detectKind(bytesOfDoc(doc), path).label;
      }
      return { ok: true, output: `${path}: ${kind}, ${size} bytes` };
    }

    case "head":
    case "tail": {
      let n = 10;
      let bytesMode = 0;
      // 老式写法 `head -60` / `tail -40`：`-60` 不满足 isFlag（- 后必须是字母），
      // 会落进 args 里被当成文件名，报「-60 文件不存在」。模型很爱这么写，
      // 与其让它每轮重新学一次，不如在这里接住。
      const legacyN = args.find((a) => /^-\d+$/.test(a));
      if (legacyN) {
        n = Number(legacyN.slice(1));
        args.splice(args.indexOf(legacyN), 1);
      }
      const nFlag = flags.find((f) => /^-n?\d+$/.test(f));
      const cFlag = flags.find((f) => /^-c\d+$/.test(f));
      if (cFlag) bytesMode = Number(cFlag.slice(2));
      else if (flags.includes("-c") && /^\d+$/.test(args[0] || "")) bytesMode = Number(args.shift());
      else if (nFlag) n = Number(nFlag.match(/\d+/)[0]);
      else if (flags.includes("-n") && /^\d+$/.test(args[0] || "")) n = Number(args.shift());
      else if (args.length > 1 && /^\d+$/.test(args[0])) n = Number(args.shift());

      // 字节模式：给 od / xxd 做上游，二进制原样走管道
      if (bytesMode) {
        let bytes;
        const raw = args[0];
        if (raw) {
          const doc = await readFile(resolve(raw));
          if (!doc) return { ok: false, output: missing(head, raw) };
          bytes = bytesOfDoc(doc);
        } else {
          bytes = stdinBytes || bytesOfLatin1(stdin);
        }
        const slice = head === "head" ? bytes.subarray(0, bytesMode) : bytes.subarray(Math.max(0, bytes.length - bytesMode));
        return { ok: true, output: latin1Of(slice), bytes: slice };
      }

      const raw = args[0];
      if (!raw) {
        const lines = linesOf(stdin);
        const slice = head === "head" ? lines.slice(0, n) : lines.slice(-n);
        return { ok: true, output: outClip(slice.join("\n")) };
      }
      const p = resolve(raw);
      const f = await readFile(p);
      if (!f) return { ok: false, output: missing(head, raw) };
      if (f.encoding === "base64") return { ok: false, output: `${head}: ${p} 是二进制文件；用 od / xxd / fs_inspect 看字节` };
      const lines = linesOf(f.content);
      const slice = head === "head" ? lines.slice(0, n) : lines.slice(-n);
      return { ok: true, output: outClip(slice.join("\n")) };
    }

    case "sed": {
      // 接住模型最常写的子集：按行取片段、`s/旧/新/g` 替换、`-i` 原地写回。
      // 沙箱不是真 Linux，但 `sed -n '620,760p' file` 和 `sed -i 's/…/…/g' file`
      // 几乎每次长任务都会冒出来 —— 让它们失败一次，模型就会转而反复
      // 重写整个文件再拼接，那才是真正的返工来源。
      const script = args[0] || "";
      const src = args[1];
      const inPlace = flags.some((f) => /^-i/.test(f));
      let text;
      if (src) {
        const p = resolve(src);
        const f = await readFile(p);
        if (!f) return { ok: false, output: missing("sed", src) };
        if (f.encoding === "base64") return { ok: false, output: `sed: ${p} 是二进制文件；用 fs_inspect 看结构` };
        text = String(f.content || "");
      } else {
        text = String(stdin || "");
      }
      const lines = text.split("\n");

      // -i 是真正写回文件：写盘用未裁剪的 result，终端输出才走 outClip。
      // 0.70.0 之前 `-i` 被当成普通 flag 忽略，只把替换结果打印出来，
      // 模型以为改好了，下一次 cat 还是旧内容。
      const emit = async (result) => {
        if (!inPlace) return { ok: true, output: outClip(result) };
        if (state.settings.permission === "readonly") return { ok: false, output: "当前是只读权限，sed -i 不能写回文件" };
        if (!src) return { ok: false, output: "sed -i 需要指定文件名（不能对管道输入原地写回）" };
        await writeFile(resolve(src), result);
        return { ok: true, output: `已写回 ${rel(src)}（sed -i 不输出内容）` };
      };

      // 一条或多条 s///：用 matchAll 而不是按 ";" 硬切，因为分号本身
      // 完全可能是替换内容（`s/;/；/g`）。校验去掉所有 s/// 后只剩分号
      // 与空白，才认定是纯替换脚本，避免把 '620,760p' 误判进来。
      const subRe = () => /s\/((?:\\.|[^/])*)\/((?:\\.|[^/])*)\/([gI]*)/g;
      const subs = [...script.matchAll(subRe())];
      const residue = script.replace(subRe(), "").replace(/[;\s]/g, "");
      if (subs.length && !residue) {
        let out = lines;
        for (const sub of subs) {
          let re;
          try {
            re = new RegExp(sub[1].replace(/\\\//g, "/"), sub[3]?.includes("g") ? "g" : "");
          } catch {
            return { ok: false, output: `sed: 无效的替换表达式 ${script}` };
          }
          const to = sub[2].replace(/\\\//g, "/");
          out = out.map((l) => l.replace(re, to));
        }
        return emit(out.join("\n"));
      }

      const range = script.match(/^(\d+|\$)?(?:,(\d+|\$))?p$/);
      if (!range) {
        return {
          ok: false,
          output: `sed: 暂不支持脚本 \`${script}\`。可用 'A,Bp' 取行片段、's/旧/新/g' 替换（可加 -i 写回）；也可用 head -n N <文件> 或 grep 代替。`,
        };
      }
      const total = lines.length;
      const from = range[1] === "$" ? total : Math.max(1, Number(range[1] || 1));
      const to = range[2] ? Math.min(total, range[2] === "$" ? total : Number(range[2])) : from;
      if (to < from) return emit("");
      return emit(lines.slice(from - 1, to).join("\n"));
    }

    case "cp":
    case "mv": {
      if (args.length < 2) return { ok: false, output: `用法：${head} [-r] <源> <目标>` };
      if (state.settings.permission === "readonly") return { ok: false, output: "当前是只读权限，不能复制或移动文件" };
      const recursive = flags.some((f) => /[rR]/.test(f));
      const srcs = args.slice(0, -1).flatMap((a) => expand(a));
      const dstRaw = rel(args[args.length - 1]);
      if (!srcs.length) return { ok: false, output: `${head}: ${args[0]} 不存在` };
      // 目标是已有目录（或带尾斜杠）时，把源放进目录里，而不是覆盖目录名
      const dstIsDir = files.some((f) => f.path.startsWith(`${dstRaw}/`)) || /\/$/.test(args[args.length - 1]);
      const jobs = [];
      for (const src of srcs) {
        const isFile = files.some((f) => f.path === src);
        if (isFile) {
          jobs.push({ from: src, to: dstIsDir ? `${dstRaw}/${src.split("/").pop()}` : dstRaw });
          continue;
        }
        const kids = files.filter((f) => f.path.startsWith(`${src}/`));
        if (!kids.length) return { ok: false, output: missing(head, src) };
        // mv 移动目录本来就不需要 -r；只有 cp 需要。
        if (!recursive && head === "cp") return { ok: false, output: `cp: ${src} 是目录，加 -r 才能整体复制` };
        const prefix = dstIsDir ? `${dstRaw}/${src.split("/").pop()}` : dstRaw;
        for (const k of kids) jobs.push({ from: k.path, to: `${prefix}/${k.path.slice(src.length + 1)}` });
      }
      let moved = 0;
      let lastSize = 0;
      for (const j of jobs) {
        const doc = await readFile(j.from);
        if (!doc) continue;
        if (doc.encoding === "base64") {
          await writeBinaryFile(j.to, String(doc.content || ""), doc.mime || "application/octet-stream", Number(doc.size) || 0);
        } else {
          await writeFile(j.to, doc.content);
        }
        if (head === "mv") await deleteFile(j.from);
        lastSize = Number(doc.size) || 0;
        moved += 1;
      }
      if (!moved) return { ok: false, output: `${head}: 没有可${head === "cp" ? "复制" : "移动"}的文件` };
      return {
        ok: true,
        output:
          jobs.length === 1
            ? `${jobs[0].from} -> ${jobs[0].to}（${fmtSize(lastSize)}）`
            : `${head === "cp" ? "已复制" : "已移动"} ${moved} 个文件到 ${dstRaw || "/"}`,
      };
    }

    case "rm": {
      const recursive = flags.some((f) => /[rR]/.test(f));
      // `rm -rf 目录` 是清理时的标准起手式，目录本来就不存在时 GNU 也
      // 静默成功。以前回「不存在」还标红，一条 `rm -rf x; mkdir x; …`
      // 就从第一步开始失败，模型只好加一堆 `|| true` 重试。
      const force = flags.some((f) => f.includes("f"));
      const targets = args.flatMap((a) => expand(a));
      if (!targets.length) return { ok: false, output: "用法：rm [-r] <文件或目录>" };
      if (state.settings.permission === "readonly") return { ok: false, output: "当前是只读权限，不能删除文件" };
      const done = [];
      const notes = [];
      const seen = new Set();
      for (const t of targets) {
        const hit = files.find((f) => f.path === t);
        if (hit) {
          await deleteFile(hit.path);
          done.push(hit.path);
          seen.add(hit.path);
          continue;
        }
        const kids = files.filter((f) => f.path.startsWith(`${t}/`) && !seen.has(f.path));
        if (kids.length && recursive) {
          for (const k of kids) {
            await deleteFile(k.path);
            seen.add(k.path);
          }
          done.push(`${t}/（${kids.length} 个文件）`);
          continue;
        }
        if (kids.length) {
          notes.push(`${t} 是目录，加 -r 才能递归删除`);
        } else if (!force) {
          notes.push(`${t} 不存在`);
        }
      }
      if (!done.length) return force ? { ok: true, output: "（没有可删除的文件）" } : { ok: false, output: notes.join("；") || "没有可删除的文件" };
      return {
        ok: true,
        output: [`已删除 ${done.length} 项`, ...done.slice(0, 20).map((p) => `  ${p}`), ...notes.map((n) => `注意：${n}`)].join("\n"),
      };
    }

    case "mkdir":
      return { ok: true, output: `目录已就绪：${rel(args[0]) || "."}（工作区按需建目录，写文件时会自动出现）` };

    case "od":
    case "xxd": {
      const raw = args[0];
      let bytes;
      if (raw) {
        const doc = await readFile(resolve(raw));
        if (!doc) return { ok: false, output: missing(head, raw) };
        bytes = bytesOfDoc(doc);
      } else {
        bytes = stdinBytes || bytesOfLatin1(stdin);
      }
      const sizeFlag = flags.find((f) => /^-[Nn]?\d+$/.test(f));
      const len = sizeFlag ? Number(sizeFlag.match(/\d+/)[0]) : /^\d+$/.test(args[1] || "") ? Number(args[1]) : 256;
      return { ok: true, output: hexDump(bytes, { length: len }) };
    }

    case "base64": {
      const decode = flags.some((f) => f === "-d" || f === "--decode");
      if (decode) {
        let src = stdin;
        if (args[0]) {
          const doc = await readFile(resolve(args[0]));
          if (!doc) return { ok: false, output: missing("base64", args[0]) };
          src = doc.encoding === "base64" ? String(doc.content || "") : String(doc.content || "");
        }
        if (!src) return { ok: false, output: "base64: 没有输入" };
        try {
          const bytes = bytesOfLatin1(atob(src.replace(/\s+/g, "")));
          return { ok: true, output: new TextDecoder("utf-8", { fatal: false }).decode(bytes), bytes };
        } catch {
          return { ok: false, output: "base64: 输入不是有效的 Base64" };
        }
      }
      let bytes;
      if (args[0]) {
        const doc = await readFile(resolve(args[0]));
        if (!doc) return { ok: false, output: missing("base64", args[0]) };
        bytes = bytesOfDoc(doc);
      } else {
        bytes = stdinBytes || bytesOfLatin1(stdin);
      }
      return { ok: true, output: bytesToBase64(bytes) };
    }

    case "sha256sum": {
      let bytes;
      if (args[0]) {
        const doc = await readFile(resolve(args[0]));
        if (!doc) return { ok: false, output: missing("sha256sum", args[0]) };
        bytes = bytesOfDoc(doc);
      } else {
        bytes = stdinBytes || bytesOfLatin1(stdin);
      }
      try {
        const buf = await crypto.subtle.digest("SHA-256", bytes);
        const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
        return { ok: true, output: `${hex}  ${args[0] || "-"}` };
      } catch {
        return { ok: false, output: "sha256sum: 当前环境不支持 WebCrypto" };
      }
    }

    case "unzip": {
      // 0.75.0：真的解压。
      //
      // 之前只实现了 `-l` 列表，但 `unzip x.zip` 也会落进这个分支、返回
      // 条目列表且 ok:true —— 既不干活也不报错，是最坏的一种失败模式。
      // 用户传 zip 让模型装插件时，模型写完 `unzip ../uploads/x.zip` 看到
      // 「6 个条目」，以为解压成功，接着 `ls` 一个空目录，然后开始猜
      // `x.zip/onetake/安装说明.md` 这种根本不存在的路径。
      const argv = tokenizeCommand(cmd).slice(1);
      const listOnly = argv.some((t) => /^-[A-Za-z]*l/.test(t));
      let dest = "";
      const names = [];
      for (let i = 0; i < argv.length; i += 1) {
        const t = argv[i];
        if (t === "-d") {
          dest = argv[i + 1] || "";
          i += 1;
          continue;
        }
        if (/^-/.test(t)) continue;
        names.push(t);
      }
      const target = names[0];
      if (!target) {
        return {
          ok: false,
          output: "用法：unzip <压缩包> [-d 目标目录]（解压）｜unzip -l <压缩包>（只看条目）",
        };
      }
      const doc = await readFile(resolve(target));
      if (!doc) return { ok: false, output: missing("unzip", target) };
      const bytes = bytesOfDoc(doc);
      const entries = zipEntries(bytes);
      if (!entries) return { ok: false, output: `unzip: ${rel(target)} 不是可解析的 ZIP / APK` };

      if (listOnly) {
        const lines = [`${entries.length} 个条目：`];
        entries.slice(0, 80).forEach((e) => lines.push(`${String(Number(e.size) || 0).padStart(9)}  ${e.name}`));
        if (entries.length > 80) lines.push(`… 还有 ${entries.length - 80} 个条目`);
        lines.push("");
        lines.push("以上是包内条目，还没有落盘。要解压：unzip " + rel(target) + " -d <目录>");
        lines.push('只想读其中一个文件：fs_read(path="' + rel(target) + '!条目名")');
        return { ok: true, output: lines.join("\n") };
      }

      if (state.settings.permission === "readonly") {
        return { ok: false, output: "当前是只读权限，不能解压写文件" };
      }
      const totalSize = entries.reduce((n, e) => n + (Number(e.size) || 0), 0);
      if (totalSize > 96 * 1024 * 1024) {
        return { ok: false, output: `unzip: 解压后约 ${fmtSize(totalSize)}，超过 96 MB 上限；请指定 -d 到别处或先挑选条目` };
      }

      let filesOut = [];
      try {
        filesOut = await unpackZip(bytes);
      } catch (e) {
        return { ok: false, output: `unzip: ${rel(target)} 解不开 —— ${e.message}` };
      }

      const base = rel(dest || cwd);
      const before = new Set(files.map((f) => pathKey(f.path)));
      const written = [];
      let overwrote = 0;
      let skipped = 0;
      let failed = 0;
      for (const e of filesOut) {
        if (unsafeEntry(e.path)) {
          skipped += 1;
          continue;
        }
        const full = base ? `${base}/${e.path}` : e.path;
        try {
          if (isProbablyText(e.bytes)) {
            await writeFile(full, new TextDecoder().decode(e.bytes));
          } else {
            await writeBinaryFile(full, bytesToBase64(e.bytes), mimeOf(full), e.bytes.length);
          }
          if (before.has(pathKey(full))) overwrote += 1;
          written.push(full);
        } catch {
          failed += 1;
        }
      }

      if (!written.length) {
        return {
          ok: false,
          output: `unzip: ${rel(target)} 里有 ${entries.length} 个条目，但没有可写出的文件${skipped ? `（${skipped} 个路径不安全被跳过）` : ""}`,
        };
      }

      // 说出「实际落在哪」：zip 常见带一层顶层目录，模型若按自己以为的
      // 路径继续读，就会重演截图里那串「文件不存在」。
      const tops = new Set(written.map((p) => (base && p.startsWith(base + "/") ? p.slice(base.length + 1) : p).split("/")[0]));
      const lines = [
        `已解压 ${written.length} 个文件到 ${base ? base + "/" : "/"}${overwrote ? `（覆盖 ${overwrote} 个）` : ""}${skipped ? `，跳过 ${skipped} 个不安全路径` : ""}${failed ? `，${failed} 个写入失败` : ""}`,
      ];
      written.slice(0, 30).forEach((p) => lines.push(`  ${p}`));
      if (written.length > 30) lines.push(`  … 还有 ${written.length - 30} 个文件`);
      if (tops.size === 1 && written.every((p) => p.includes("/"))) {
        const top = [...tops][0];
        lines.push("");
        lines.push(`包内所有文件都在 ${top}/ 下，解压后的位置是 ${base ? base + "/" : ""}${top}/`);
      }
      lines.push("");
      lines.push(`下一步：fs_list(path="${base}") 看落盘结果，再读具体文件`);
      return { ok: true, output: clip(lines.join("\n")) };
    }

    case "grep": {
      // 空模式是合法写法：`grep -c '' 文件` 就是数行数（模型很爱用它
      // 和 wc -l 交叉验证）。以前 args[0] 为 "" 时被当成「没给模式」，
      // 直接回一句用法错误 —— 整条 `head; echo; wc; grep` 就全红失败。
      const pat = args.length ? args[0] : undefined;
      if (pat === undefined) return { ok: false, output: "用法：grep [-i] [-n] [-o] [-c] 模式 [文件…]（模式写 '' 表示匹配所有行）" };
      let re;
      // BRE 的 `a\|b` 在 JS 正则里是字面竖线，模型写 grep 时几乎必带。
      const jsPat = pat.replace(/\\\|/g, "|");
      try {
        re = new RegExp(jsPat, flags.some((f) => f.includes("i")) ? "i" : "");
      } catch {
        return { ok: false, output: `grep: 无效的正则 ${pat}` };
      }
      const srcs = args.slice(1);
      let sources = [{ path: "", text: String(stdin || "") }];
      if (srcs.length) {
        sources = [];
        // `grep -rn "关键词" .` 是模型找入口文件的标准写法。以前 "." 会被
        // 当成文件名去读，直接报「文件不存在」；-r 也完全没实现。
        let list = srcs;
        if (flagOn("r") || flagOn("R")) {
          list = [];
          for (const s of srcs) {
            const base = rel(s) === "." ? cwd || "" : rel(s);
            if (!base) {
              list.push(...paths);
              continue;
            }
            const kids = paths.filter((p) => p.startsWith(`${base}/`));
            list.push(...(kids.length ? kids : [base]));
          }
        }
        for (const s of list) {
          if (rel(s) === "dev/null") continue;
          const d = await readFile(resolve(s));
          if (!d) return { ok: false, output: missing("grep", s) };
          sources.push({ path: rel(s) || s, text: d.encoding === "base64" ? "" : String(d.content || "") });
        }
      }
      const numbered = flagOn("n");
      const only = flagOn("o");
      const countOf = (t) => linesOf(t).filter((line) => re.test(line)).length;
      // grep -c：0.70.0 之前没实现，模型拿到的是匹配**内容**而不是计数，
      // 于是它以为要改用 -n 取行号确认结构。单源给纯数字，多源按 GNU 习惯给 文件:计数。
      if (flagOn("c")) {
        if (sources.length === 1) return { ok: true, output: String(countOf(sources[0].text)) };
        return { ok: true, output: sources.map((s) => `${s.path}:${countOf(s.text)}`).join("\n") };
      }
      // 多源必须带文件名。以前把几个文件拼成一个大字符串再算行号，模型
      // 拿到的是一串「12: ...」—— 既不知道是哪个文件，行号也是拼接后的。
      const multi = sources.length > 1;
      const hits = [];
      for (const s of sources) {
        const arr = linesOf(s.text);
        for (let i = 0; i < arr.length; i += 1) {
          if (re.test(arr[i])) hits.push({ line: arr[i], i, path: s.path });
        }
      }
      const label = (x) => (multi && x.path ? `${x.path}:` : "");
      if (!hits.length) return { ok: true, output: "（没有匹配）" };
      if (only) {
        const global = new RegExp(re.source, `${re.flags}g`);
        const parts = [];
        for (const x of hits) parts.push(...(x.line.match(global) || []));
        return { ok: true, output: parts.slice(0, 200).join("\n") || "（没有匹配）" };
      }
      return {
        ok: true,
        output: hits
          .slice(0, 200)
          .map((x) => `${label(x)}${numbered ? `${x.i + 1}: ` : ""}${x.line}`)
          .join("\n"),
      };
    }

    case "echo":
      return { ok: true, output: cmd.slice(4).trim().replace(/^["']|["']$/g, "") };

    case "date":
      return { ok: true, output: new Date().toString() };

    case "tree":
      return {
        ok: true,
        output: files
          .map((f) => f.path.split("/").map((p, idx, arr) => (idx === arr.length - 1 ? `└─ ${p}` : `${"   ".repeat(idx)}${p}/`)).join("\n"))
          .join("\n"),
      };

    default:
      return {
        ok: false,
        output: `沙箱终端不支持 \`${head}\`。可用：pwd / ls [-l] [-d] [通配符] / cat / head -n N / tail -n N / wc / grep [-rn] [-c] [-o] [-E] / sort [-u] [-n] [-r] [-k N] / uniq [-c] [-d] / cut -d: -f1 / tr [-d] / basename / dirname / find . -name "*.md" [-type f] [-maxdepth N] / stat -c %s / du [-sh] / realpath / file / cp [-r] / mv / rm [-r] / mkdir / od / xxd / base64 / sha256sum / unzip <包> [-d 目录] / echo / date / tree / sed -n 'A,Bp' / sed -i 's/旧/新/g'；支持 | 管道、> 与 >> 重定向、cd <目录>（跨次调用保留）、2>/dev/null（会被忽略）。没有 awk / xargs / jq / curl / python，也没有变量展开与命令替换。cat 多文件是纯拼接；看二进制用 fs_inspect。`,
      };
  }
}

/* 简化 shell：按 ; 与 && 分段，段内支持 | 管道和 > / >> 重定向。 */
function splitTop(text, ops) {
  const src = String(text || "");
  const out = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      // 双引号里的 \" 是转义引号，不是引号结束。模型写
      // grep -o "id=\"[^\"]*\"" 时，少了这一句就会把后面的 | 也吞进引号，
      // 于是 grep 收到一个叫 `|` 的文件名。
      if (ch === "\\" && quote === '"' && i + 1 < src.length) {
        cur += ch + src[i + 1];
        i += 1;
      } else {
        cur += ch;
        if (ch === quote) quote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const hit = ops.find((o) => src.startsWith(o, i));
    if (hit) {
      out.push({ text: cur, op: hit });
      cur = "";
      i += hit.length - 1;
      continue;
    }
    cur += ch;
  }
  out.push({ text: cur, op: "" });
  return out;
}

const sanitizeOut = (s) =>
  String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

async function runPipeline(text, cwd = "", final = true) {
  const segs = splitTop(text, ["|"]);
  let stdin = "";
  let stdinBytes = null;
  const lastIdx = segs.reduce((acc, s, i) => (s.text.trim() ? i : acc), -1);
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    let cmd = seg.text.trim();
    if (!cmd) continue;
    // `2>/dev/null` 不只是"把这段字符去掉"：它的语义是**错误输出别给我看**，
    // 但退出码要保留 —— 否则 `ls -d a b 2>/dev/null || echo 没有` 里那个
    // echo 永远不执行。沙箱只有一个输出通道，所以记下标记，失败时清空文案。
    const muteError = /(^|\s)2\s*>\s*\/dev\/null\b/.test(cmd);
    // 常见写法：2>&1、>/dev/null —— 虚拟文件系统没有设备节点，直接丢弃
    cmd = cmd.replace(/2>&1/g, "").replace(/\d?>\s*\/dev\/null/g, "").trim();
    if (!cmd) continue;
    let redirect = null;
    // 输入重定向：`wc -l < file`、`grep x < file` 是真 shell 的常见写法。
    // 以前 `< file` 整段留在命令里，被当成一个叫 `<` 的文件名。
    let inPath = "";
    // 只认「空白 + < + 文件」这一种形状。不能见到 < 就当重定向：
    // `grep -n "<section" f` 里的 < 是模式内容，之前那样切会把整个
    // 模式删掉，grep 变成「拿文件名当模式」。
    const inM = cmd.match(/(^|\s)<\s*("[^"]+"|'[^']+'|\S+)/);
    if (inM && !cmd.includes("<<")) {
      inPath = inM[2].replace(/^["']|["']$/g, "");
      cmd = cmd.replace(inM[0], " ").trim();
    }
    const m = cmd.match(/(>>?)\s*("[^"]+"|'[^']+'|\S+)\s*$/);
    if (m) {
      redirect = { append: m[1] === ">>", path: m[2].replace(/^["']|["']$/g, "") };
      cmd = cmd.slice(0, m.index).trim();
    }
    let input = stdin;
    let inputBytes = stdinBytes;
    if (inPath) {
      const key = String(inPath).replace(/^\.\//, "");
      const doc = await readFile(cwd && !key.startsWith("/") ? `${cwd}/${key}` : key.replace(/^\/+/, ""));
      if (!doc) return { ok: false, output: `${inPath} 文件不存在（< 是从文件读输入，不是写文件）` };
      input = doc.encoding === "base64" ? "" : String(doc.content || "");
      inputBytes = null;
    }
    const r = await runOne(cmd, input, inputBytes, cwd, final && i === lastIdx && !redirect);
    if (!r.ok) return muteError ? { ok: false, output: "", muted: true } : r;
    if (redirect) {
      if (state.settings.permission === "readonly") return { ok: false, output: "当前是只读权限，不能重定向写文件" };
      const prev = redirect.append ? (await readFile(redirect.path))?.content || "" : "";
      await writeFile(redirect.path, prev + r.output);
    }
    stdin = r.output;
    stdinBytes = r.bytes || null;
  }
  return { ok: true, output: sanitizeOut(stdin) };
}

/* cd 要跨工具调用保留。模型常把 `cd parts` 和 `cat 01.html` 分成两次
   shell 调用，若每次都从 /workspace 重新开始，第二次就找不到文件 ——
   这就是日志里「cd 行为不稳定，我改用完整相对路径」的真正原因。

   0.73 起按会话分桶：工作区已经按会话隔离，cwd 若还是模块级单值，
   A 会话里 `cd parts` 之后切到 B，B 的 `cat 01.html` 会去找
   B 自己的 parts/01.html —— 找不到时模型会误判成「文件丢了」。
   分桶后切回 A，原来 cd 过的目录还在。 */
const shellCwds = new Map();
const shellCwdKey = () => state.activeSessionId || "";

/** 把 cd 的参数折成工作区内的相对路径：认 `..`、`.`、绝对路径与前导 workspace/。 */
function normalizeCwd(base, arg) {
  let raw = String(arg || "").replace(/\/+$/, "");
  // `cd ~` / `cd ~/x`：沙箱没有真实 HOME，工作区根就是家。
  // 以前 `~` 被当成字面目录名，cd 过去之后所有相对路径都读不到，
  // 模型只能一路试（截图里那条 `cd ~ 2>/dev/null && pwd` 就是这么来的）。
  if (raw === "~" || raw === "$HOME" || raw === "${HOME}") raw = "/";
  else if (raw.startsWith("~/")) raw = `/${raw.slice(2)}`;
  if (!raw || raw === "." || raw === "/") return "";
  const parts = (raw.startsWith("/") ? raw : `${base}/${raw}`).split("/");
  const out = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  if (out[0] === "workspace") out.shift();
  return out.join("/");
}

/** 当前会话的 shell 目录前缀（不含 /workspace/）。 */
export function currentShellCwd() {
  return shellCwds.get(shellCwdKey()) || "";
}

/** 会话删除时顺手清掉它的 cwd 记录。 */
export function forgetShellCwd(sessionId) {
  if (sessionId) shellCwds.delete(sessionId);
}

/**
 * sed 脚本没加引号时，替换内容里的分号会被 splitTop 当成语句分隔符：
 *   sed -i s/a;b/c/g file  →  ["sed -i s/a", "b/c/g file"]
 * 认出「上一段里的 sed 替换式还没闭合（斜杠数为奇数）」就拼回去。
 * 引号包住的部分先从判据里挖掉，避免把正常的 `"s/a;b/c/g"` 算成半截。
 */
function rejoinSedScripts(segs) {
  const out = [];
  const bare = (s) => String(s || "").replace(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g, "");
  for (const seg of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.op === ";") {
      const b = bare(prev.text);
      const open = /\bsed\b/.test(b) && (b.match(/\//g) || []).length % 2 === 1;
      if (open) {
        prev.text = `${prev.text};${seg.text}`;
        prev.op = seg.op;
        continue;
      }
    }
    out.push({ ...seg });
  }
  return out;
}

async function runShell(command) {
  const text = String(command || "").trim();
  if (!text) return { ok: false, output: "空命令" };
  // `||` 也认：模型清理目录时几乎必写 `rm -rf x || true`，
  // 以前整条被当成 "rm 的参数里有 ||"，清理步骤直接红掉。
  const segs = rejoinSedScripts(splitTop(text, ["&&", "||", ";"]));
  let last = { ok: true, output: "" };
  // 沙箱没有真正的 cwd。`cd <目录>` 里的目录被记成后续命令的路径前缀：
  // 既能让 `cd chenzhong && wc -l index.html` 找对文件，也避免同名文件
  // 被别的目录抢走（光靠 basename 兜底会选错）。
  const cwdKey = shellCwdKey();
  let cwd = shellCwds.get(cwdKey) || "";
  const lastBodyIdx = segs.reduce((acc, s, i) => (s.text.trim() ? i : acc), -1);
  // 一条命令里用 ; 串起好几步时，前面成功、最后一步失败很常见。
  // 以前只回最后一层的错误，前面 head/wc 的结果全被丢掉 —— 模型只好
  // 从头再跑一遍整串（截图里「失败」后面紧跟着重试，就是这么来的）。
  const recs = [];
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    // `cd ~ 2>/dev/null` 先剥掉 stderr 重定向，否则 cd 正则匹配不上，
    // 整段落进 runOne 的未知命令分支，报「不支持 cd」—— 见 stripStderr。
    const rawBody = seg.text.trim();
    const body = stripStderr(rawBody);
    if (!body) continue;
    const cd = body.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i);
    if (cd) {
      // `cd ../upload` / `cd a/b/..` 以前会被当成字面前缀，拼出
      // `pkg/../upload/x` 这种找不到的路径；模型只好退回全路径重写。
      const filesNow = listFiles();
      const exists = (p) => !p || filesNow.some((f) => f.path.startsWith(`${p}/`));
      const arg = cd[1] || cd[2] || cd[3] || "";
      let next = normalizeCwd(cwd, arg);
      // cwd 跨调用保留之后，模型常不看历史就再来一次 `cd pkg`，
      // 叠成 pkg/pkg 之后每条命令都找错文件。这里回落到「相对工作区根」
      // 再解析一次 —— 那多半才是它想表达的目录。
      if (next && !exists(next)) {
        const fromRoot = normalizeCwd("", arg);
        if (fromRoot && fromRoot !== next && exists(fromRoot)) next = fromRoot;
      }
      cwd = next;
      shellCwds.set(cwdKey, cwd);
      // 目录是拼错的还是刚 mkdir 的空目录，模型分不清就会一路往下试。
      // 这里明说一句，免得它把「空目录」当成「cd 没生效」。
      last = {
        ok: true,
        output: cwd
          ? `/workspace/${cwd}${exists(cwd) ? "" : "\n（这个目录还没有文件；mkdir 只是标记，写入时才创建）"}`
          : "/workspace",
      };
      continue;
    }
    // `a || b`：a 成功就跳过 b（和真 shell 一样）。
    // 注意看**前一段**的分隔符：splitTop 把 op 记在分隔符左边那一段上，
    // 用 seg.op 会永远读到 b 后面那个空串，条件从不成立。
    const prevOp = i > 0 ? segs[i - 1].op : "";
    if (prevOp === "||" && last.ok) continue;
    // 传 rawBody：`2>/dev/null` 要留给 runPipeline 判断"错误输出是否要吞掉"。
    // 传 body 的话它已经被 stripStderr 删干净，静默语义就丢了。
    last = await runPipeline(rawBody, cwd, i === lastBodyIdx);
    recs.push({ body, ok: last.ok, output: String(last.output || ""), muted: !!last.muted });
    if (!last.ok && seg.op === "&&") break;
  }
  // 被 2>/dev/null 吞掉错误的段，连「这一步失败」都不该出现 ——
  // 真 shell 里它就是一个沉默的非零退出码。只有全部失败都被吞掉时
  // 才看最后一段的退出码（和真 shell 一致）。
  if (recs.some((r) => !r.ok && !r.muted)) {
    // 单条命令失败时直接用它自己的报错，不加「这一步」前缀 —— 工具卡片
    // 已经标红了，再包一层只会让错误信息变长、可读性变差。
    if (recs.length === 1) {
      if (last.muted || !String(last.output || "").trim()) {
        return { ok: false, output: "命令失败（错误输出已按 2>/dev/null 丢弃）" };
      }
      return last;
    }
    const bad = recs.filter((r) => !r.ok && !r.muted);
    const notes = bad
      .map((r) => {
        const one = r.body.length > 80 ? `${r.body.slice(0, 80)}…` : r.body;
        return `[这一步失败] ${one}\n${r.output}`;
      })
      .join("\n\n");
    // 前面成功的输出保留，但给失败说明留出位置，别让它被长输出挤掉。
    const room = Math.max(400, MAX_OUT - notes.length - 8);
    const before = clip(recs.filter((r) => r.ok && r.output.trim()).map((r) => r.output).join("\n"), room);
    // 退出码跟真 shell 一致：以**最后一段**为准。`rm -rf x; mkdir x; ls`
    // 里第一步错了但后面都成功，整条仍算成功 —— 错的那一步照样在输出里
    // 标出来，模型能看到，不至于整条标红吓得重跑。
    return { ok: last.ok, output: before.trim() ? `${before}\n\n${notes}` : notes };
  }
  // 用 ; 串起来的多步命令，每一步的输出都该给模型（真 shell 就是这样）。
  // 之前只回最后一段的：`head …; echo ===; wc -c …` 拿到的是一个数字，
  // 模型只能拆成四次调用重跑 —— 截图里那条命令正是这个形状。
  if (recs.length <= 1) return last;
  if (!last.ok) {
    // 最后一段失败但错误被 2>/dev/null 吞了：保持非零退出，但别编造文案。
    const shown = recs.filter((r) => r.ok && r.output.trim()).map((r) => r.output).join("\n");
    return { ok: false, output: shown || "命令失败（错误输出已按 2>/dev/null 丢弃）" };
  }
  return { ok: true, output: clip(recs.filter((r) => r.output.trim()).map((r) => r.output).join("\n")) };
}

/* ---------------- run_code 的 SDK ---------------- */

export function makeSdk(log = () => {}) {
  const fsv = {
    list: async () => listFiles().map((f) => f.path),
    read: async (path) => {
      const f = await readFile(path);
      if (!f) throw new Error(`文件不存在：${path}`);
      return f.content;
    },
    write: async (path, content) => {
      if (state.settings.permission === "readonly") {
        throw new Error("当前权限为只读，脚本内不能写入文件");
      }
      await writeFile(path, content);
      log(`write ${path}`);
      return { path, bytes: String(content).length };
    },
    exists: async (path) => !!(await readFile(path)),
  };
  return {
    fs: fsv,
    calc: (expr) => {
      if (!/^[\d\s+\-*/().%]+$/.test(String(expr))) throw new Error("只支持算术表达式");
      // eslint-disable-next-line no-new-func
      return Function(`"use strict";return (${expr})`)();
    },
    now: () => new Date().toISOString(),
    log,
  };
}

/* ---------------- 工具定义 ---------------- */

/* ---------------- 技能包（SKILL.md） ---------------- */

/**
 * 技能包不是 npm 插件，也不是页面内插件。
 *
 * 它是 Claude Skills 那种形态：一个目录，根部一份 SKILL.md，
 * 旁边是 references / scripts / assets。SKILL.md 的 frontmatter
 * 写 name 与 description，正文是"怎么用我"。
 *
 * 之前 DSH 完全不认这种包。用户传一个 onetake 上来，模型翻完
 * 只能如实说「包内没有 plugin.json / 工作区没有 skills 目录 /
 * DSH 插件格式不匹配」—— 它说的每一条都是真话，但用户要的是
 * "装上"，不是"装不上"的诊断书。
 *
 * 这一版把技能包当成一等公民：
 *   · skill_install 把 .zip 或已解压目录装进 skills/<id>/
 *   · 系统提示里列出已装技能的名称与一句话说明
 *   · skill_read 按需读 SKILL.md 与它引用的文件
 */
const SKILL_META = ".dsh-skill.json";
const SKILL_MAX_FILES = 600;

/**
 * 解析 SKILL.md 开头的 YAML frontmatter。
 *
 * 只取顶层标量。嵌套的 metadata 跳过 —— 我们只用它做展示，
 * 不靠它做校验，解析得宽松一点比"严格但读不出"有用。
 */
function parseFrontmatter(text) {
  const m = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  let key = "";
  let block = false;
  for (const line of m[1].split(/\r?\n/)) {
    if (block) {
      if (!line.trim() || /^\s+\S/.test(line)) {
        if (line.trim()) out[key] = `${out[key] ? `${out[key]} ` : ""}${line.trim()}`;
        continue;
      }
      block = false;
    }
    if (/^\s/.test(line)) continue; // 嵌套字段（metadata.author 之类）
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v === "|" || v === ">") {
      out[key] = "";
      block = true;
      continue;
    }
    out[key] = v;
  }
  return out;
}

/** 技能 id：小写字母数字与连字符，跟插件保持一致。 */
function skillSlug(v) {
  const s = String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "skill";
}

/** 已装技能 + 磁盘上的实际文件数（元数据可能比文件旧）。 */
function skillCatalog() {
  const list = Array.isArray(state.skills) ? state.skills : [];
  const files = listFiles();
  return list.map((s) => {
    const own = files.filter((f) => f.path.startsWith(`skills/${s.id}/`));
    return { ...s, present: own.length > 0, fileCount: own.length };
  });
}

/**
 * 装一个技能包。
 * source 可以是 .zip，也可以是已经解压好的目录（模型常先 unzip 再装）。
 */
async function installSkill(source, opts = {}) {
  const src = String(source || "").trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!src) return { ok: false, output: '用法：skill_install(source="包.zip")，source 也可以是已解压的目录' };
  if (state.settings.permission === "readonly") return { ok: false, output: "当前是只读权限，不能安装技能" };

  const files = listFiles();
  let entries = [];
  let fromZip = false;

  const doc = await readFile(src);
  if (doc) {
    let bytes;
    try {
      bytes = bytesOfDoc(doc);
      entries = await unpackZip(bytes);
    } catch (e) {
      return { ok: false, output: `${src} 解不开：${e.message}。技能包应是 .zip，或先用 unzip 解压再传目录。` };
    }
    fromZip = true;
  } else {
    const inDir = files.filter((f) => f.path.startsWith(`${src}/`));
    if (!inDir.length) {
      return { ok: false, output: `找不到 ${src}。它应该是工作区里的 .zip，或已解压的技能目录。` };
    }
    if (inDir.length > SKILL_MAX_FILES) {
      return { ok: false, output: `${src} 有 ${inDir.length} 个文件，超过 ${SKILL_MAX_FILES} 上限 —— 确认这是技能包而不是整个工作区。` };
    }
    for (const f of inDir) {
      const d = await readFile(f.path);
      if (!d) continue;
      entries.push({ path: f.path.slice(src.length + 1), bytes: bytesOfDoc(d) });
    }
  }

  const mds = entries.filter((e) => /(^|\/)SKILL\.md$/i.test(e.path));
  if (!mds.length) {
    return {
      ok: false,
      output:
        `包内没有 SKILL.md，所以它不是技能包。\n` +
        `技能包的形状：根部一份 SKILL.md（含 name / description 的 frontmatter），旁边放 references/、scripts/ 等。\n` +
        `如果你要装的是 DSH 的 JS 插件，那需要 package.json / 插件清单，走插件页安装。`,
    };
  }
  // 取层级最浅的那份：包内 cases/ 里也可能有示例 SKILL.md。
  mds.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  const entry = mds[0];
  const prefix = entry.path.slice(0, entry.path.length - "SKILL.md".length);
  const mdText = new TextDecoder().decode(entry.bytes);
  const fm = parseFrontmatter(mdText);

  let id = skillSlug(opts.id || fm.name || prefix.split("/").filter(Boolean).pop() || "skill");
  const taken = (x) => listFiles().some((f) => f.path.startsWith(`skills/${x}/`));
  if (taken(id) && !opts.force) {
    let n = 2;
    while (taken(`${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }
  if (opts.force) {
    for (const f of listFiles().filter((x) => x.path.startsWith(`skills/${id}/`))) {
      await deleteFile(f.path);
    }
  }

  let written = 0;
  let skipped = 0;
  let failed = 0;
  const names = [];
  for (const e of entries) {
    let relPath = e.path;
    if (prefix && relPath.startsWith(prefix)) relPath = relPath.slice(prefix.length);
    relPath = relPath.replace(/^\/+/, "");
    if (!relPath || relPath.endsWith("/")) continue;
    if (unsafeEntry(relPath)) {
      skipped += 1;
      continue;
    }
    const full = `skills/${id}/${relPath}`;
    try {
      if (isProbablyText(e.bytes)) {
        await writeFile(full, new TextDecoder().decode(e.bytes));
      } else {
        await writeBinaryFile(full, bytesToBase64(e.bytes), mimeOf(full), e.bytes.length);
      }
      written += 1;
      if (names.length < 8) names.push(relPath);
    } catch {
      failed += 1;
    }
  }

  if (!written) {
    return { ok: false, output: `技能包里的 ${entries.length} 个条目都没写出来${skipped ? `（${skipped} 个路径不安全）` : ""}` };
  }

  const meta = {
    id,
    name: fm.name || id,
    version: fm.version || "",
    description: String(fm.description || "").slice(0, 1200),
    source: fromZip ? src : `${src}/`,
    installedAt: Date.now(),
    files: written,
  };
  await writeFile(`skills/${id}/${SKILL_META}`, JSON.stringify(meta, null, 2));
  state.skills = (Array.isArray(state.skills) ? state.skills : []).filter((x) => x.id !== id);
  state.skills.push(meta);
  save();
  emit({ type: "skill:install", id });

  // 技能里多半写着 "python3 scripts/xxx.py"。本机沙箱没有 python，
  // 与其等模型装完再一条条撞墙，不如装完就说清楚。
  const wants = [];
  if (/\bpython3?\b/i.test(mdText)) wants.push("python3");
  if (/\b(npx|npm|node)\b/.test(mdText)) wants.push("Node");
  if (/playwright/i.test(mdText)) wants.push("Playwright");
  if (/ffmpeg/i.test(mdText)) wants.push("ffmpeg");

  const desc = String(fm.description || "").replace(/\s+/g, " ").trim();
  const lines = [
    `已安装技能「${meta.name}」→ skills/${id}/（${written} 个文件${skipped ? `，跳过 ${skipped} 个不安全路径` : ""}${failed ? `，${failed} 个写入失败` : ""}）`,
    desc ? `说明：${desc.length > 220 ? `${desc.slice(0, 220)}…` : desc}` : "说明：（SKILL.md 没写 description）",
    "",
    `入口：skills/${id}/SKILL.md —— 用 skill_read(id="${id}") 读全文。`,
    `引用的资料：skill_read(id="${id}", path="references/xxx.md")。`,
    names.length ? `包内前几个文件：${names.join("、")}` : "",
  ];
  if (wants.length) {
    lines.push(
      "",
      `依赖提醒：这份技能提到 ${wants.join(" / ")}。本机沙箱只有白名单 shell（ls/cat/grep/sed/unzip 等），` +
        `没有 python3、npx、ffmpeg —— 需要它们的脚本跑不了；说明里的流程、参数、文案仍然可以照着执行。`
    );
  }
  return { ok: true, output: lines.filter((x) => x !== "").join("\n") };
}

/** "3-8,12" → Set(3..8, 12)。越界就截断，写错就回退到前 20 页。 */
function parsePageRange(spec, total) {
  const out = new Set();
  const max = Math.max(1, Math.min(total, 200));
  const fallback = () => {
    for (let i = 1; i <= Math.min(max, 20); i += 1) out.add(i);
    return out;
  };
  if (!spec) return fallback();
  for (const part of String(spec).split(/[,，、]/)) {
    const m = part.trim().match(/^(\d+)\s*(?:[-–~至]\s*(\d+))?$/);
    if (!m) continue;
    const a = Math.max(1, Math.min(max, Number(m[1])));
    const b = m[2] ? Math.max(1, Math.min(max, Number(m[2]))) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) out.add(i);
  }
  return out.size ? out : fallback();
}

export const TOOLS = {
  fs_list: {
    group: "fs",
    label: "列出工作区",
    description: "列出工作区内的文件路径。可选 path 前缀过滤。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "路径前缀，如 reports/" } },
    },
    preview: (a) => a.path || "工作区根目录",
    async run(a) {
      const prefix = (a.path || "").replace(/^\.\//, "");
      const files = listFiles().filter((f) => f.path.startsWith(prefix));
      return {
        ok: true,
        output: files.length
          ? files.map((f) => `${f.path}  ${f.size ?? 0}B  ${fmtTime(f.updatedAt)}`).join("\n")
          : "（没有匹配的文件）",
      };
    },
  },

  fs_read: {
    group: "fs",
    label: "读取文件",
    description:
      "读取工作区文件。文本返回正文；二进制可传 format=\"hex\"（配合 offset/length）查看字节片段，不会报“读不了”。压缩包内条目可直接读：path=\"包.zip!内部/路径\"，不必先解压。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径" },
        format: { type: "string", enum: ["text", "hex"], description: "text 返回正文；hex 返回十六进制片段" },
        offset: { type: "number", description: "hex 模式的起始字节，默认 0" },
        length: { type: "number", description: "hex 模式读取的字节数，默认 256，最大 4096" },
      },
      required: ["path"],
    },
    preview: (a) => a.path,
    async run(a) {
      const f = await readFile(a.path);
      if (!f) {
        // 模型常把 zip 条目写成 `x.zip/内部/文件.md`。与其回一句「不存在」，
        // 不如理解这个意图、直接把条目读出来。
        const inside = await readArchiveEntry(a.path);
        if (inside) return inside;
        return { ok: false, output: missingPathHint(a.path) };
      }
      const wantHex = a.format === "hex" || a.offset !== undefined || a.length !== undefined;
      if (wantHex) {
        const bytes = bytesOfDoc(f);
        const offset = Math.max(0, Number(a.offset) || 0);
        if (bytes.length && offset >= bytes.length) {
          return { ok: false, output: `offset ${offset} 超出文件大小（${bytes.length} 字节）` };
        }
        return {
          ok: true,
          output: `${a.path} · ${fmtSize(bytes.length)} · 起始 ${offset}\n${hexDump(bytes, { offset, length: Number(a.length) || 256 })}`,
        };
      }
      if (f.encoding === "base64") {
        if (isImagePath(a.path)) {
          return {
            ok: false,
            output: `${a.path} 是一张图片（${fmtSize(f.size)}），读不出文字。图片由宿主以 image_url 直接交给支持视觉的模型；若消息里已带这张图，你应能直接看到。\n若要检查字节，用 fs_read(path="${a.path}", format="hex")。`,
          };
        }
        return { ok: true, output: describeBytes(bytesOfDoc(f), a.path) };
      }
      return { ok: true, output: clip(f.content) };
    },
  },

  fs_inspect: {
    group: "fs",
    label: "查看文件结构",
    description:
      "查看任意文件的类型、大小、头部字节；ZIP / APK / Office 会列出内部条目，PDF 给出页数。检查二进制先用它，不要用 cat，也不要 cp 到 /tmp 再用 od。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径" },
        entries: { type: "number", description: "最多列出多少个压缩包条目，默认 24，最大 200" },
      },
      required: ["path"],
    },
    preview: (a) => a.path,
    async run(a) {
      const f = await readFile(a.path);
      if (!f) {
        const inside = await readArchiveEntry(a.path);
        if (inside) return inside;
        return { ok: false, output: missingPathHint(a.path) };
      }
      const limit = Math.max(4, Math.min(Number(a.entries) || 24, 200));
      return { ok: true, output: describeBytes(bytesOfDoc(f), a.path, { maxEntries: limit }) };
    },
  },

  fs_write: {
    group: "fs",
    label: "写入文件",
    description: "创建或覆盖工作区内的文件。写入前建议先读取原文件。",
    sensitive: true,
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径，可包含目录" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
    },
    preview: (a) => a.path,
    async run(a) {
      const prev = await readFile(a.path);
      const res = await writeFile(a.path, a.content);
      const diff = makeDiff(res.previous || "", a.content);
      return {
        ok: true,
        output: `写入成功 · ${a.path} · ${String(a.content).length} 字符${prev ? "（覆盖）" : "（新建）"}`,
        diff,
      };
    },
  },

  skill_list: {
    group: "fs",
    label: "列出技能",
    description: "列出已安装的技能包（skills/<id>/SKILL.md），含一句话说明与文件数。",
    parameters: { type: "object", properties: {} },
    preview: () => "技能清单",
    async run() {
      const list = skillCatalog();
      if (!list.length) {
        return { ok: true, output: '还没有安装技能。装一个：skill_install(source="包.zip")。' };
      }
      return {
        ok: true,
        output: [
          `${list.length} 个技能：`,
          ...list.map(
            (s) =>
              `${s.id}${s.name && s.name !== s.id ? `（${s.name}）` : ""}\t${s.fileCount} 个文件\t${String(s.description || "")
                .replace(/\s+/g, " ")
                .slice(0, 80)}${s.present ? "" : "（目录已丢失）"}`
          ),
        ].join("\n"),
      };
    },
  },

  skill_read: {
    group: "fs",
    label: "读取技能",
    description:
      "读技能包的 SKILL.md 或它引用的文件。id 用 skill_list 里的，path 默认 SKILL.md。文件较长时分页：先读默认的 6000 字符，按末尾提示用 offset 继续。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "技能 id" },
        path: { type: "string", description: "技能目录内的相对路径，默认 SKILL.md" },
        offset: { type: "number", description: "起始字符，默认 0" },
        limit: { type: "number", description: "本次读多少字符，默认 6000，最大 12000" },
      },
      required: ["id"],
    },
    preview: (a) => `${a.id || ""}${a.path ? `/${a.path}` : ""}`,
    async run(a) {
      const id = skillSlug(a.id);
      const p = String(a.path || "SKILL.md")
        .replace(/^\.\//, "")
        .replace(/^\/+/, "");
      if (!p || p.includes("..")) return { ok: false, output: "path 必须是技能目录内的相对路径" };
      const full = `skills/${id}/${p}`;
      const doc = await readFile(full);
      if (!doc) {
        const own = listFiles()
          .filter((f) => f.path.startsWith(`skills/${id}/`))
          .map((f) => f.path.slice(`skills/${id}/`.length));
        if (!own.length) {
          return { ok: false, output: `没有这个技能：${id}。用 skill_list 看已安装的技能。` };
        }
        return {
          ok: false,
          output: `${full} 不存在。这个技能有这些文件：\n${own.slice(0, 40).join("\n")}${
            own.length > 40 ? `\n… 还有 ${own.length - 40} 个` : ""
          }`,
        };
      }
      if (doc.encoding === "base64") {
        return { ok: false, output: `${p} 是二进制文件。用 fs_read(path="${full}", format="hex") 看字节。` };
      }
      // 不能直接 clip 到 6000：onetake 的 SKILL.md 有 23837 字符，
      // 一刀切掉四分之三，模型等于没读到"怎么用我"。
      // 分页返回，末尾告诉它下一段从哪开始。
      const text = String(doc.content || "");
      const offset = Math.max(0, Number(a.offset) || 0);
      const limit = Math.min(12000, Math.max(500, Number(a.limit) || 6000));
      if (offset >= text.length) {
        return { ok: false, output: `offset ${offset} 超出文件长度（${text.length} 字符）` };
      }
      const part = text.slice(offset, offset + limit);
      const rest = text.length - (offset + part.length);
      const head = `${full} · 共 ${text.length} 字符 · 本次 ${offset}–${offset + part.length}`;
      return {
        ok: true,
        output: rest > 0
          ? `${head}\n\n${part}\n\n… 还有 ${rest} 字符。继续读：skill_read(id="${id}", path="${p}", offset=${offset + part.length})`
          : `${head}\n\n${part}`,
      };
    },
  },

  skill_install: {
    group: "fs",
    label: "安装技能包",
    description:
      "把含 SKILL.md 的技能包装到 skills/<id>/。source 可以是 .zip，也可以是已解压的目录。装完用 skill_read 读全文。技能包不需要 package.json / plugin.json。",
    sensitive: true,
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "工作区里的 .zip 或已解压目录" },
        id: { type: "string", description: "可选，装成什么 id（默认取 SKILL.md 的 name）" },
        force: { type: "boolean", description: "覆盖同名技能" },
      },
      required: ["source"],
    },
    preview: (a) => a.source,
    async run(a) {
      return installSkill(a.source, { id: a.id, force: !!a.force });
    },
  },

  fs_delete: {
    group: "fs",
    label: "删除文件",
    description: "删除工作区内的文件。此操作不可撤销。",
    sensitive: true,
    risk: "delete",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    preview: (a) => a.path,
    async run(a) {
      if (!(await readFile(a.path))) return { ok: false, output: `文件不存在：${a.path}` };
      await deleteFile(a.path);
      return { ok: true, output: `已删除 ${a.path}` };
    },
  },

  library_list: {
    group: "library",
    label: "列出资料库",
    description:
      "列出资料库里长期保存的资料（用户收藏或从手机导入的重要文件）。可按关键词过滤路径。资料库跨会话可用。",
    parameters: {
      type: "object",
      properties: { keyword: { type: "string", description: "可选，按路径关键词过滤" } },
    },
    preview: (a) => a.keyword || "全部资料",
    async run(a) {
      const kw = String(a.keyword || "").trim().toLowerCase();
      const items = listLibrary().filter((f) => !kw || f.path.toLowerCase().includes(kw));
      if (!items.length) {
        return {
          ok: true,
          output: kw ? `资料库里没有匹配「${kw}」的文件。` : "（资料库为空：可在工作区把文件「存入资料库」，或从手机导入。）",
        };
      }
      return {
        ok: true,
        output: items
          .map((f) => `${f.path}  ${(f.size || 0)}B  ${fmtTime(f.updatedAt)}${f.mime ? `  ${f.mime}` : ""}`)
          .join("\n"),
      };
    },
  },

  library_read: {
    group: "library",
    label: "读取资料库文件",
    description: "读取资料库中某个文件的完整内容。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "资料库内的相对路径" } },
      required: ["path"],
    },
    preview: (a) => a.path,
    async run(a) {
      try {
        const path = matchFilePath(Object.keys(state.library || {}), a.path) || String(a.path || "");
        const doc = await readDoc("library", path);
        if (doc.encoding === "base64") {
          return { ok: false, output: `${a.path} 是二进制文件（${(doc.size / 1024).toFixed(1)} KB），无法按文本读取。` };
        }
        return { ok: true, output: clip(doc.content) };
      } catch {
        return {
          ok: false,
          output: `资料库中没有这个文件：${a.path}\n现有：\n${listLibrary().map((x) => x.path).join("\n") || "（空）"}`,
        };
      }
    },
  },

  library_save: {
    group: "library",
    label: "存入资料库",
    description: "把工作区里的文件复制到资料库长期保存（跨会话可用）。适合重要的结论、资料与需要反复引用的文件。",
    sensitive: true,
    risk: "write",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "工作区内的相对路径" } },
      required: ["path"],
    },
    preview: (a) => a.path,
    async run(a) {
      try {
        const target = await saveToLibrary(a.path);
        return { ok: true, output: `已存入资料库：${target}` };
      } catch (err) {
        return { ok: false, output: err.message || `存入失败：${a.path}` };
      }
    },
  },

  /**
   * 学习库：把一问一答的结论落到文件里。
   *
   * 为什么做成工具而不是让模型自己 fs_read + fs_write 拼字符串：
   * 追加要「先读、找到位置、拼接、写回」，四步里任何一步模型偷懒
   * （比如直接覆盖写）都会把之前几十条记录抹掉。这类事不该交给概率。
   */
  learn_add: {
    group: "library",
    label: "记入学习库",
    description:
      "把这一问的结论追加到学习库（按月归档，同时更新索引）。同一标题会覆盖旧条目，不会重复堆积。",
    sensitive: false,
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "问题标题，一句话，会成为条目小标题" },
        conclusion: { type: "string", description: "一句话结论" },
        points: {
          type: "array",
          items: { type: "string" },
          description: "2–4 条要点，每条不超过两行",
        },
        tags: { type: "array", items: { type: "string" }, description: "1–3 个标签，不带 #" },
        question: { type: "string", description: "用户原问题（可选，太长可省略）" },
      },
      required: ["title", "conclusion"],
    },
    preview: (a) => a.title,
    async run(a) {
      // store.readFile 返回的是 { path, encoding, content, ... }，不是字符串。
      // 直接当字符串用，第一次写（文件还不存在、readFile 返回 null）不会暴露，
      // 要到第二次记笔记才会炸 —— 这种错最难查，所以在这里一次性取对。
      const readText = async (path) => {
        const doc = await readFile(path);
        if (!doc) return "";
        return typeof doc === "string" ? doc : doc.content || "";
      };
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const ym = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
      const day = `${ym}-${pad(now.getDate())}`;

      // 标题要能当文件名用：斜杠、冒号这些在路径里会出事，直接替换掉
      const title =
        String(a.title || "")
          .replace(/[/\\:*?"<>|#]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60) || "未命名";
      const oneLine = (v) => String(v || "").replace(/\s*\n\s*/g, " ").trim();
      const conclusion = oneLine(a.conclusion);
      if (!conclusion) return { ok: false, output: "缺少结论，没有写入。" };

      const points = (Array.isArray(a.points) ? a.points : [])
        .map(oneLine)
        .filter(Boolean)
        .slice(0, 6);
      const tags = (Array.isArray(a.tags) ? a.tags : [])
        .map((t) => oneLine(t).replace(/^#/, ""))
        .filter(Boolean)
        .slice(0, 3);

      let block = `## ${title}\n\n- **日期**：${day}\n`;
      if (a.question) block += `- **问**：${oneLine(a.question)}\n`;
      block += `- **结论**：${conclusion}\n`;
      if (points.length) block += `- **要点**：\n${points.map((p) => `  - ${p}\n`).join("")}`;
      if (tags.length) block += `- **标签**：${tags.map((t) => `#${t}`).join(" ")}\n`;
      block += "\n";

      const monthPath = `学习库/${ym}.md`;
      const prev = (await readText(monthPath)) || `# 学习库 · ${ym}\n\n`;

      // 同名条目就地替换，不新增 —— 同一个问题问第二遍时应该更新而不是刷屏
      let next = "";
      let replaced = false;
      const hit = prev.indexOf(`## ${title}\n`);
      if (hit !== -1) {
        const after = prev.slice(hit + 1);
        const stop = after.indexOf("\n## ");
        const end = stop === -1 ? prev.length : hit + 1 + stop + 1;
        next = prev.slice(0, hit) + block + prev.slice(end);
        replaced = true;
      } else {
        next = `${prev.replace(/\s*$/, "\n\n")}${block}`;
      }
      await writeFile(monthPath, next);

      // 索引：一行一条，按时间倒序没有意义（追加即可，查看时再排）
      const indexPath = "学习库/INDEX.md";
      const idxPrev = (await readText(indexPath)) || "# 学习库索引\n\n";
      const idxLine = `- ${day} · ${title}${tags.length ? ` · ${tags.map((t) => `#${t}`).join(" ")}` : ""}`;
      const kept = idxPrev
        .split("\n")
        .filter((l) => !(l.startsWith("- ") && l.includes(` · ${title}`)))
        .join("\n")
        .replace(/\s*$/, "\n");
      await writeFile(indexPath, `${kept}${idxLine}\n`);

      const count = (next.match(/^## /gm) || []).length;
      return {
        ok: true,
        output: `${replaced ? "已更新" : "已记入"}学习库：${title}\n位置：${monthPath}（本月第 ${count} 条）`,
      };
    },
  },

  shell: {
    group: "shell",
    label: "终端",
    description:
      "在沙箱工作区执行命令。可用：pwd / ls [-l] [-d] [通配符] / cat / head -n N / tail -n N / wc / grep [-rn] [-c] [-o] [-E] / sort [-u] [-n] [-r] [-k N] / uniq [-c] [-d] / cut -d: -f1 / tr / basename / dirname / find . -name \"*.md\" [-type f] [-maxdepth N] / stat -c %s / du -sh / realpath / echo / date / tree / file / od / xxd / base64 / sha256sum / unzip <包> [-d 目录]（真解压到工作区）/ unzip -l <包> / cp [-r] / mv / rm [-r] / mkdir / sed -n 'A,Bp' / sed -i 's/旧/新/g'；支持 | 管道、> 与 >> 重定向、< 文件读入、2>/dev/null（忽略）、; / && / || 串多步（每步输出都返回，|| true 可兜底）、cd <目录>（只在当前会话内跨次调用保留，pwd 可查）。ls 与 cat 支持 * 通配符（ls parts/*.html）；grep -r 递归；cat 多文件是纯拼接、没有文件名头，拼页面直接 cat a b > out；改文件用 sed -i 原地写回；数行数用 wc -l 或 grep -c ''。不是真 Linux：没有 awk / xargs / jq / curl / python，也没有变量展开与 sed 高级脚本；看二进制用 fs_inspect，不要 cat。",
    sensitive: true,
    risk: "exec",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "完整命令" } },
      required: ["command"],
    },
    preview: (a) => a.command,
    async run(a) {
      const r = await runShell(a.command);
      return { ok: r.ok, output: clip(r.output) };
    },
  },

  run_code: {
    group: "code",
    label: "程序化调用",
    description:
      "用 JavaScript 一次性编排多步工具调用（dsh.fs / dsh.calc / dsh.log）。在应用 WebView 内执行——不是安全沙箱：禁止触碰浏览器存储、网络或 DOM，此类脚本会被 Safety Net 拦截。",
    sensitive: true,
    risk: "exec",
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["typescript", "javascript"] },
        code: { type: "string", description: "函数体代码，支持 await" },
      },
      required: ["code"],
    },
    preview: () => "执行编排脚本",
    async run(a) {
      if (!a.code) return { ok: false, output: "缺少 code" };
      const logs = [];
      const sdk = makeSdk((m) => logs.push(m));
      try {
        // 在应用 WebView 内执行（不是安全沙箱）：严格模式 + 遮蔽浏览器全局，
        // 堵住 localStorage / fetch / DOM 的直接访问；绕过行为由 Safety Net 拦截。
        const SHADOWED = [
          "localStorage", "sessionStorage", "indexedDB", "caches",
          "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts",
          "document", "window", "globalThis", "self", "parent", "top",
          "location", "navigator", "Function", "open", "alert", "confirm", "prompt",
        ];
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction("dsh", ...SHADOWED, `"use strict";\n${a.code}`);
        const result = await fn(sdk, ...SHADOWED.map(() => undefined));
        return {
          ok: true,
          output: clip(
            [
              logs.length ? `日志：\n${logs.join("\n")}` : "",
              `返回值：\n${typeof result === "string" ? result : JSON.stringify(result, null, 2)}`,
            ]
              .filter(Boolean)
              .join("\n\n")
          ),
          code: a.code,
        };
      } catch (err) {
        return { ok: false, output: `脚本执行失败：${err.message}`, code: a.code };
      }
    },
  },

  ops_status: {
    group: "ops",
    label: "运行时体检",
    description: "检查本地运行时的会话、文件占用、插件、安全拦截与失败的工具调用。",
    parameters: { type: "object", properties: {} },
    preview: () => "runtime",
    async run() {
      const sessions = state.sessions;
      const messages = sessions.reduce((n, s) => n + s.messages.length, 0);
      const files = listFiles();
      const bytes = files.reduce((n, f) => n + (f.size ?? f.content.length), 0);
      const tools = sessions.flatMap((s) => s.messages.flatMap((m) => m.tools || []));
      const failed = tools.filter((t) => ["error", "blocked", "denied"].includes(t.status));
      const enabled = state.plugins.filter((p) => p.enabled).length;

      return {
        ok: true,
        output: [
          `DSH Mobile 运行时 · ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
          `会话 ${sessions.length} · 消息 ${messages} · 文件 ${files.length}（${(bytes / 1024).toFixed(1)} KB）`,
          `插件 ${enabled}/${state.plugins.length} · 安全扫描 ${state.safety?.scans || 0} 次 · 拦截 ${state.safety?.blocked || 0} 次`,
          `工具调用 ${tools.length} 次 · 失败/拦截 ${failed.length} 次`,
          failed.length
            ? `最近异常：${failed[failed.length - 1].name} — ${String(failed[failed.length - 1].output || "").slice(0, 90)}`
            : "最近异常：无",
          failed.length ? "建议：到「任务」或对应会话查看轨迹，再决定是否清理导出产物。" : "状态正常。",
        ].join("\n"),
      };
    },
  },

  ops_cleanup: {
    group: "ops",
    label: "清理导出产物",
    description: "删除工作区 exports/ 下的所有导出文件，释放空间。不触碰源文件与会话记录。",
    sensitive: true,
    risk: "delete",
    parameters: {
      type: "object",
      properties: { scope: { type: "string", enum: ["exports"], description: "目前仅支持 exports" } },
    },
    preview: () => "exports/*",
    async run() {
      const targets = listFiles().filter((f) => f.path.startsWith("exports/"));
      if (!targets.length) return { ok: true, output: "exports/ 下没有可清理的文件。" };
      const bytes = targets.reduce((n, f) => n + (f.size ?? 0), 0);
      for (const f of targets) await deleteFile(f.path);
      return {
        ok: true,
        output: `已清理 ${targets.length} 个导出文件，释放 ${(bytes / 1024).toFixed(1)} KB。源文件与会话记录未受影响。`,
      };
    },
  },

  office_export: {
    group: "office",
    label: "导出 Office",
    description:
      "把工作区的 Markdown 导出为 Word（.docx）或 PowerPoint（.pptx），把 CSV 导出为 Excel（.xlsx）。产物写入 exports/，可在工作区打开与下载。\n" +
      "做 PPT 时先写一份 .md，再导出：第一个 `#` 是封面标题，紧跟的 `>` 是副标题；每个 `##` 是一页；页内 `- ` 是要点（一页 3–6 条最合适，超了会自动拆页）；`###` 是页内小标题；`|` 表格单独占一页；`---` 断开当前页。要点写短句，不要写成讲稿段落；`![说明](路径)` 只会保留图注文字，不嵌入图片。",
    sensitive: true,
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "源文件路径：.md（→ docx / pptx）或 .csv（→ xlsx）" },
        format: { type: "string", enum: ["docx", "xlsx", "pptx"], description: "目标格式，省略时按源文件类型推断" },
      },
      required: ["path"],
    },
    preview: (a) =>
      `${a.path} → ${{ xlsx: "Excel（.xlsx）", pptx: "PowerPoint（.pptx）" }[a.format] || "Word（.docx）"}`,
    async run(a) {
      const f = await readFile(a.path);
      if (!f) return { ok: false, output: `源文件不存在：${a.path}` };
      if (f.encoding === "base64") return { ok: false, output: "源文件是二进制，不能再导出为 Office 文件。" };

      const base = String(a.path).split("/").pop().replace(/\.[^.]+$/, "");
      const format = String(
        a.format || (/\.csv$/i.test(a.path) ? "xlsx" : /\.pptx$/i.test(a.path) ? "pptx" : "docx")
      ).toLowerCase();

      if (format === "xlsx" && !/\.csv$/i.test(a.path)) {
        return {
          ok: false,
          output: "Excel 导出需要 CSV 源文件。请先用 run_code 把数据写成 .csv，再导出。",
        };
      }
      if (format !== "xlsx" && /\.csv$/i.test(a.path)) {
        return { ok: false, output: "CSV 只能导出成 Excel；Word / PPT 需要 Markdown 源文件。" };
      }

      let bytes;
      let mime;
      let out;
      let note = "";
      if (format === "xlsx") {
        bytes = csvToXlsx(f.content, base);
        mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        out = `exports/${base}.xlsx`;
      } else if (format === "pptx") {
        const deck = buildDeck(f.content, base);
        bytes = deck.bytes;
        mime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        out = `exports/${base}.pptx`;
        note = `\n共 ${deck.slides.length} 页：${deck.slides
          .map((s) => (s.type === "title" ? `「${s.title}」封面` : `第${s.index}页 ${s.title}`))
          .slice(0, 6)
          .join("、")}${deck.slides.length > 6 ? " …" : ""}`;
        if (deck.slides.length === 1) note += "\n（只有封面：源文件里没有 `##` 分页，把每页内容拆到 `##` 下面再导出）";
      } else if (format === "docx") {
        bytes = markdownToDocx(f.content, base);
        mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        out = `exports/${base}.docx`;
      } else {
        return { ok: false, output: "只支持 docx / xlsx / pptx 三种格式。" };
      }

      await writeBinaryFile(out, bytesToBase64(bytes), mime, bytes.length);
      return {
        ok: true,
        output: `已导出 ${out} · ${(bytes.length / 1024).toFixed(1)} KB${note}\n可在「工作区 → exports/」点开并下载。`,
        export: { path: out, size: bytes.length, mime },
      };
    },
  },

  pdf_read: {
    group: "office",
    label: "读取 PDF",
    description:
      "读 PDF 的正文，按页返回。合同、报告、论文、说明书、发票都先用它，不要用 fs_read 硬读（那是二进制，只能看到乱码）。\n" +
      "不是每份都读得出来：扫描件只有图片层，会明确告诉你需要 OCR；加密文件也会说清楚。\n" +
      "只读要用的页：pages=\"3-8\" 或 \"2,5,9-12\"；省略时读前 20 页。长文档先读前几页摸结构，再按需翻页。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区里的 PDF 路径" },
        pages: { type: "string", description: "页码范围：\"1-5\" / \"3\" / \"2,7-9\"，省略则读前 20 页" },
        maxChars: { type: "number", description: "正文最多返回多少字符，默认 12000" },
      },
      required: ["path"],
    },
    preview: (a) => a.path,
    async run(a) {
      const f = await readFile(a.path);
      if (!f) return { ok: false, output: `文件不存在：${a.path}（先 fs_list 看看工作区里有什么）` };
      if (f.encoding !== "base64") {
        return { ok: false, output: `${a.path} 不是 PDF（按文本读出了内容）。PDF 之外的文本直接用 fs_read。` };
      }
      const bytes = bytesOfDoc(f);
      if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
        return { ok: false, output: `${a.path} 的文件头不是 %PDF，可能不是真正的 PDF。用 fs_inspect 确认类型。` };
      }

      let doc;
      try {
        doc = await readPdf(bytes);
      } catch (e) {
        return { ok: false, output: `解析失败：${e.message}。可以先 fs_inspect 看结构，或让用户重新导出这份 PDF。` };
      }

      const wanted = parsePageRange(a.pages, doc.totalPages);
      const limit = Math.max(1000, Math.min(Number(a.maxChars) || 12000, 40000));
      const head = [
        `${a.path} · ${doc.totalPages} 页 · PDF ${doc.version}`,
        doc.encrypted ? "注意：这份 PDF 带加密标记，文本可能不完整。" : "",
      ].filter(Boolean);

      if (doc.encrypted && doc.pages.every((p) => !p.text)) {
        return {
          ok: false,
          output: `${head.join("\n")}\n读不出正文：文件被加密了。请让用户另存为不加密的 PDF（打印为 PDF 通常可以），再读。`,
        };
      }
      if (!doc.pages.some((p) => p.text)) {
        return {
          ok: false,
          output: `${head.join("\n")}\n读不出正文：${doc.totalPages} 页都没有文本层${
            doc.scanned ? "，基本可以确定是扫描件" : ""
          }。\n需要 OCR（本机没有内置 OCR）。可选：让用户把 PDF 转成图片后由支持视觉的模型看图，或提供原始文档。`,
        };
      }

      const parts = [];
      let used = 0;
      let cut = false;
      for (const p of doc.pages) {
        if (!wanted.has(p.index)) continue;
        if (used >= limit) {
          cut = true;
          break;
        }
        const remain = limit - used;
        const body = p.text.length > remain ? `${p.text.slice(0, remain)}…` : p.text;
        used += body.length;
        parts.push(`（第 ${p.index} 页${p.text ? "" : " · 无文本"}）\n${body || ""}`);
      }

      const notes = [];
      const empties = doc.pages.filter((p) => !p.text).map((p) => p.index);
      if (empties.length) notes.push(`没有文本层的页：${empties.slice(0, 12).join("、")}${empties.length > 12 ? " 等" : ""}（多为图片/扫描页）`);
      if (doc.missingGlyphs) notes.push(`有 ${doc.missingGlyphs} 个字符缺少编码映射，正文里可能夹着乱码。`);
      if (cut) notes.push(`还有内容没返回（已到 ${limit} 字符上限）。用 pages 指定下一页，例如 pages="${Math.min(doc.totalPages, 21)}-${Math.min(doc.totalPages, 40)}"。`);

      return {
        ok: true,
        output: `${head.join("\n")}\n\n${parts.join("\n\n")}${notes.length ? `\n\n——\n${notes.join("\n")}` : ""}`,
      };
    },
  },

  pdf_create: {
    group: "office",
    label: "生成 PDF",
    description:
      "把内容排成 PDF，产物写到工作区，可直接下载或用 WPS / 系统阅读器打开。\n" +
      "给 blocks（排版原语数组）或 markdown（会被 1:1 映射成 blocks）。这里不套固定版式：没有自动封面、目录、页眉，\n" +
      "顺序和层级完全由你决定。可用原语：\n" +
      "  h1 / h2 / h3 标题；p 段落（支持 **粗体**）；bullets 无序列表（items 数组）；numbers 有序列表；\n" +
      "  quote 引用；code 代码块；table 表格（rows 二维数组，第一行当表头）；rule 分隔线；pagebreak 分页；\n" +
      "  image 图片（src 为工作区路径，支持 JPEG / 不带透明的 PNG，可给 caption）；space 留白（height 磅值）。\n" +
      "排版自动处理中文折行、避头尾、分页；A4 默认带页码（footer:false 关掉）。",
    sensitive: true,
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "输出路径，省略时写到 exports/<title 或 pdf>.pdf" },
        title: { type: "string", description: "文档标题（写入 PDF 元数据，也用作默认文件名）" },
        markdown: { type: "string", description: "Markdown 正文；与 blocks 二选一" },
        blocks: {
          type: "array",
          description: "排版原语数组；与 markdown 二选一，同时给时以 blocks 为准",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["h1", "h2", "h3", "p", "bullets", "numbers", "quote", "code", "table", "rule", "pagebreak", "image", "space"],
              },
              text: { type: "string", description: "p / h1-h3 / quote / code 的正文" },
              items: { type: "array", items: { type: "string" }, description: "bullets / numbers 的条目" },
              rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "table 的行" },
              src: { type: "string", description: "image 的图片路径" },
              caption: { type: "string", description: "image 的图注" },
              width: { type: "number", description: "image 的显示宽度（磅），省略按页面宽度" },
              height: { type: "number", description: "space 的高度（磅）" },
            },
            required: ["type"],
          },
        },
        pageSize: { type: "string", enum: ["a4", "letter"], description: "纸张，默认 a4" },
        footer: { type: "boolean", description: "是否显示页码，默认显示" },
      },
    },
    preview: (a) => `${a.path || a.title || "PDF"}${a.markdown ? " · Markdown" : ""}`,
    async run(a) {
      let blocks = Array.isArray(a.blocks) ? a.blocks : null;
      if (!blocks && a.markdown) blocks = markdownToBlocks(String(a.markdown));
      if (!blocks || !blocks.length) {
        return { ok: false, output: "没有内容。给 blocks 数组，或给 markdown 字符串。" };
      }

      // 图片：先从工作区把字节读出来，排版时直接嵌
      const images = {};
      const wanted = blocks.filter((b) => b && (b.type === "image" || b.type === "img") && b.src);
      for (const b of wanted) {
        const f = await readFile(b.src);
        if (f) images[b.src] = bytesOfDoc(f);
      }

      const base = String(a.title || a.path || "document").replace(/^.*\//, "").replace(/\.[^.]+$/, "") || "document";
      const out = String(a.path || `exports/${base}.pdf`).replace(/^\/+/, "");
      if (!/\.pdf$/i.test(out)) return { ok: false, output: `输出路径要以 .pdf 结尾：${out}` };

      let r;
      try {
        r = await buildPdf(blocks, {
          title: a.title || base,
          pageSize: a.pageSize === "letter" ? "letter" : "a4",
          footer: a.footer !== false,
          images,
        });
      } catch (e) {
        const hint = /字体/.test(String(e.message))
          ? "\n字体文件是随包带的；加载失败通常意味着安装包不完整，或首次使用断网且离线缓存未就绪。"
          : "";
        return { ok: false, output: `生成失败：${e.message}${hint}` };
      }

      await writeBinaryFile(out, bytesToBase64(r.bytes), "application/pdf", r.bytes.length);
      const kb = (r.bytes.length / 1024).toFixed(1);
      const notes = [];
      if (r.missing.length) {
        notes.push(
          `这些字符字体里没有，PDF 里会显示为空白：${r.missing.slice(0, 24).join("")}${r.missing.length > 24 ? " …" : ""}` +
            `（多半是 emoji；换成文字符号或删掉）`
        );
      }
      const imgs = Object.keys(images).length;
      return {
        ok: true,
        output:
          `已生成 ${out} · ${r.pages} 页 · ${kb} KB${imgs ? ` · 含 ${imgs} 张图` : ""}\n` +
          `字体只嵌入了用到的字形（${r.fonts.map((f) => `${f.name} ${f.kb}KB`).join("、")}），文件不会因为字体变大。\n` +
          `下载：工作区 → ${out}${notes.length ? `\n${notes.join("\n")}` : ""}`,
        export: { path: out, size: r.bytes.length, mime: "application/pdf" },
      };
    },
  },

  calc: {
    group: "util",
    label: "计算",
    description: "计算一个算术表达式，返回数值。",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
    preview: (a) => a.expression,
    async run(a) {
      const expr = String(a.expression || "");
      if (!/^[\d\s+\-*/().%]+$/.test(expr)) return { ok: false, output: "只支持算术表达式（数字与 + - * / ( ) %）" };
      try {
        // eslint-disable-next-line no-new-func
        const v = Function(`"use strict";return (${expr})`)();
        return { ok: true, output: `${expr} = ${v}` };
      } catch (err) {
        return { ok: false, output: `计算失败：${err.message}` };
      }
    },
  },

  now: {
    group: "util",
    label: "当前时间",
    description: "获取设备当前日期与时间。",
    parameters: { type: "object", properties: {} },
    preview: () => "date",
    async run() {
      return { ok: true, output: new Date().toLocaleString("zh-CN", { hour12: false }) };
    },
  },

  web_search: {
    group: "search",
    label: "网页搜索",
    description: "检索公开网页，返回标题、链接与摘要。需要先在设置中配置搜索服务。",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
    preview: (a) => a.query,
    async run(a) {
      const endpoint = state.settings.searchEndpoint;
      if (!endpoint) {
        return {
          ok: false,
          output:
            "搜索服务未配置。请到「设置 → 能力 → 搜索服务」填入兼容 SearXNG 的 JSON 接口地址（需允许跨域），或关闭网页搜索插件。",
        };
      }
      try {
        const url = `${endpoint}${endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(a.query)}&format=json`;
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const items = (data.results || []).slice(0, a.limit || 5);
        if (!items.length) return { ok: true, output: "没有找到结果。" };
        return {
          ok: true,
          output: items.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.content || "").slice(0, 180)}`).join("\n\n"),
        };
      } catch (err) {
        return { ok: false, output: `搜索失败：${err.message}。可能是接口未允许跨域，或网络不可达。` };
      }
    },
  },

  spawn_subagent: {
    group: "subagent",
    label: "子智能体",
    description: "把一段独立任务交给子 Agent 处理，返回其结论。子 Agent 拥有独立上下文。",
    sensitive: true,
    risk: "delegate",
    // 子 Agent 要等一次完整的模型请求；30s 的通用上限不够，会被误判成工具超时
    timeoutMs: 120000,
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "清晰、自包含的任务描述" } },
      required: ["task"],
    },
    preview: (a) => (a.task || "").slice(0, 40),
    async run(a, ctx) {
      if (!ctx.spawnSubagent) return { ok: false, output: "当前宿主未提供子 Agent 能力。" };
      const r = await ctx.spawnSubagent(a.task);
      return { ok: true, output: clip(r) };
    },
  },

  agent_team: {
    group: "subagent",
    label: "智能体团队",
    description:
      "把一个目标拆成 2-4 条互不依赖的任务，并行派给子 Agent；每条任务的结论会记到团队任务板。适合「同时查几件事再汇总」。",
    sensitive: true,
    risk: "delegate",
    timeoutMs: 120000,
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "团队要达成的总目标，一句话" },
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "2-4 条可以并行的独立任务，每条都要自包含",
        },
      },
      required: ["goal", "tasks"],
    },
    preview: (a) => a.goal || "",
    async run(a, ctx) {
      if (!ctx.spawnSubagent) return { ok: false, output: "当前宿主未提供子 Agent 能力。" };
      const goal = String(a.goal || "").slice(0, 120);
      const tasks = (Array.isArray(a.tasks) ? a.tasks : [])
        .map((t) => String(t || "").trim())
        .filter(Boolean)
        .slice(0, 4);
      if (tasks.length < 2) {
        return { ok: false, output: "团队至少需要两条任务。只有一条就直接用 spawn_subagent，别绕。" };
      }

      // 任务板先建好再跑：某条失败时，其它几条的进度仍然看得见。
      const board = {
        id: `team_${Date.now().toString(36)}`,
        goal,
        at: Date.now(),
        items: tasks.map((t) => ({
          title: t.length > 80 ? `${t.slice(0, 80)}…` : t,
          status: "running",
          output: "",
          ms: 0,
        })),
      };

      const started = Date.now();
      const results = await Promise.allSettled(
        tasks.map(async (task, i) => {
          const one = Date.now();
          try {
            const out = await ctx.spawnSubagent(task);
            board.items[i].status = "done";
            board.items[i].output = String(out || "").slice(0, 600);
            board.items[i].ms = Date.now() - one;
            return out;
          } catch (err) {
            board.items[i].status = "error";
            board.items[i].output = String(err?.message || "子 Agent 失败").slice(0, 300);
            board.items[i].ms = Date.now() - one;
            throw err;
          }
        })
      );

      // 落盘只留最近 5 次，避免任务板变成第二本会话记录。
      if (!state.team || !Array.isArray(state.team.runs)) state.team = { runs: [] };
      state.team.runs.unshift(board);
      state.team.runs = state.team.runs.slice(0, 5);
      save();
      emit({ type: "team" });

      const done = results.filter((r) => r.status === "fulfilled").length;
      const lines = [
        `团队任务板 · ${goal || "（未命名目标）"}`,
        `成员 ${tasks.length} · 完成 ${done} · 用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
        "",
      ];
      board.items.forEach((it, i) => {
        const mark = it.status === "done" ? "✓" : "✗";
        lines.push(`${i + 1}. ${mark} ${it.title}`);
        lines.push(`   ${it.output || "（没有返回内容）"}`);
      });
      if (done < tasks.length) {
        lines.push("", "有成员没跑完。可以只重派失败的那几条，不必整队重来。");
      }
      return { ok: done > 0, output: lines.join("\n"), board };
    },
  },

  task_schedule: {
    group: "schedule",
    label: "创建定时任务",
    description: "创建一个按计划重复运行的后台 Agent 任务。",
    sensitive: true,
    risk: "schedule",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string" },
        schedule: { type: "string", description: "自然语言计划，如「每天 09:00」" },
      },
      required: ["name", "prompt"],
    },
    preview: (a) => a.name,
    async run(a) {
      addAutomation({
        name: a.name,
        prompt: a.prompt,
        schedule: a.schedule || "每天 09:00",
        cron: "0 9 * * *",
      });
      return { ok: true, output: `已创建定时任务「${a.name}」，计划：${a.schedule || "每天 09:00"}` };
    },
  },

  plugin_inspect: {
    group: "creator",
    label: "检查运行时",
    description: "查看当前运行时的插件树、可用 UI 挂载点与工具注册表。",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
    },
    preview: (a) => a.query || "runtime",
    async run() {
      const installed = state.plugins.filter((p) => p.enabled);
      return {
        ok: true,
        output: [
          `模式：${currentMode().name} · 工具槽位：${currentMode().tools.join(", ")}`,
          `插件（${installed.length}）：${installed.map((p) => `${p.name}@${p.version}`).join(", ")}`,
          'UI 挂载点：["shell.overlay", "sidebar.footer", "composer.toolbar", "settings.section"]',
          '可用事件：["session:start", "tool:before", "tool:after", "run:end"]',
        ].join("\n"),
      };
    },
  },

  plugin_scaffold: {
    group: "creator",
    label: "创建插件",
    description: "在当前运行时中创建并热挂载一个 UI 插件。",
    sensitive: true,
    risk: "install",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "小写英文 id" },
        name: { type: "string" },
        description: { type: "string" },
        slot: { type: "string", enum: ["shell.overlay", "composer.toolbar", "sidebar.footer", "settings.section"] },
      },
      required: ["id", "name"],
    },
    preview: (a) => a.name || a.id,
    async run(a) {
      const safeId = String(a.id).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 24) || "plugin";
      installPlugin({
        id: safeId,
        name: a.name,
        desc: a.description || "由 Agent 在会话中创建并挂载的实验插件。",
        version: "0.1.0",
        scopes: ["ui.slot"],
      });
      await writeFile(
        `plugins/${safeId}/package.json`,
        JSON.stringify(
          {
            name: `dsh-plugin-${safeId}`,
            version: "0.1.0",
            dsh: { displayName: a.name, surfaces: [a.slot || "shell.overlay"], permissions: ["ui.slot"] },
          },
          null,
          2
        )
      );
      return {
        ok: true,
        output: `已创建 ${a.name}@0.1.0\n挂载点：${a.slot || "shell.overlay"}\n自检：manifest 可解析，UI slot 已注册`,
      };
    },
  },
};

/* ---------------- 可用工具装配 ---------------- */

const TOOLSETS = {
  standard: ["fs_list", "fs_read", "fs_inspect", "fs_write", "fs_delete", "library_list", "library_read", "library_save", "calc", "now", "skill_list", "skill_read", "skill_install"],
  minimal: ["fs_list", "fs_read", "fs_inspect", "fs_write", "shell"],
  ptc: ["fs_list", "fs_read", "fs_inspect", "fs_write", "fs_delete", "library_list", "library_read", "library_save", "calc", "now", "run_code", "skill_list", "skill_read", "skill_install"],
  creator: ["fs_list", "fs_read", "fs_inspect", "fs_write", "fs_delete", "library_list", "library_read", "library_save", "calc", "now", "plugin_inspect", "plugin_scaffold", "skill_list", "skill_read", "skill_install"],
};

export function availableToolNames() {
  const mode = state.settings.mode;
  const base = TOOLSETS[mode] || TOOLSETS.standard;
  // 学习模式的记录工具跟着会话走：别的模式用不上，多一个工具就多一份 schema 开销
  const preset = currentPreset();
  const presetTools = preset && preset.id === "learn" ? ["learn_add"] : [];
  const pluginMap = {
    terminal: ["shell"],
    websearch: ["web_search"],
    subagent: ["spawn_subagent"],
    teams: ["agent_team"],
    scheduler: ["task_schedule"],
    office: ["office_export", "pdf_read", "pdf_create"],
    ops: ["ops_status", "ops_cleanup"],
  };
  const extra = [];
  state.plugins.forEach((p) => {
    if (!p.enabled) return;
    (pluginMap[p.id] || []).forEach((t) => extra.push(t));
  });
  const mcpNames = mode === "minimal" ? [] : mcpToolSchemas().map((t) => t.function.name);
  // 插件注册的工具也进工具表 —— 它们是运行时才知道的，
  // 所以不能像 TOOLS 那样静态写在表里，只能动态取。
  const pluginNames = mode === "minimal" ? [] : pluginToolSchemas().map((t) => t.function.name);
  // Node 插件的工具同理（插件在 Node 进程里注册，运行时才知道）
  const nodeNames = mode === "minimal" ? [] : nodeToolSchemas().map((t) => t.function.name);
  const names = [...new Set([...base, ...extra, ...mcpNames, ...pluginNames, ...nodeNames, ...presetTools])];
  // 极简模式只保留两个能力：终端 + 文件编辑器。
  // 学习模式是例外 —— 记笔记的工具是它的全部意义，砍掉等于该模式失效。
  if (mode === "minimal") {
    return preset && preset.id === "learn" ? ["fs_read", "fs_write", "shell", "learn_add"] : ["fs_read", "fs_write", "shell"];
  }
  return names;
}

export function toolSchemas() {
  const base = availableToolNames()
    .map((name) => {
      const t = TOOLS[name];
      if (!t) return null;
      return {
        type: "function",
        function: {
          name,
          description: t.description,
          parameters: t.parameters || { type: "object", properties: {} },
        },
      };
    })
    .filter(Boolean);
  const mcp = state.settings.mode === "minimal" ? [] : mcpToolSchemas();
  const plugins = state.settings.mode === "minimal" ? [] : pluginToolSchemas();
  const nodePlugins = state.settings.mode === "minimal" ? [] : nodeToolSchemas();
  // 按名字排序，而不是按注册顺序。
  //
  // 工具表是请求内容的一部分，紧跟 system prompt —— 顺序一变，
  // 后面整段（包括全部历史）都命不中原生前缀缓存。
  // 而注册顺序并不可靠：插件热重载、MCP 服务器重连都会重排。
  // 排序之后，装不装插件只影响「多了哪几个」，不影响「原来的在哪」。
  return [...base, ...mcp, ...plugins, ...nodePlugins].sort((a, b) =>
    String(a?.function?.name || "").localeCompare(String(b?.function?.name || ""))
  );
}

/* ---------------- 执行闸门 ---------------- */

/**
 * 自动授权审查 —— 审批之外的第二道判断。
 *
 * ============ 它和 CC Safety Net 的分工 ============
 *
 * Safety Net 只扫两类东西：shell / run_code 里的破坏性命令，
 * 以及 fs_write 里的密钥。它**不碰路径**，也不看删除操作。
 * 于是这几件事能一路走到审批弹窗：
 *
 *   · rm -rf .（Safety Net 的模式只认 / ~ * ..，不认单独一个点）
 *   · fs_delete 传 ../ 或通配符
 *   · 写文件写到工作区外面
 *
 * 这一层只做「否决」：命中就拦，没命中就照常走审批。
 * 它不会替用户点允许 —— 自动放行是用户自己的选择，不是审查能代劳的。
 */
const REVIEW_RULES = [
  {
    id: "traversal",
    test: (name, target) =>
      /^fs_/.test(name) && (/(^|\/)\.\.(\/|$)/.test(target) || /^\/|^[a-zA-Z]:\\/.test(target.trim())),
    reason: "路径越出了工作区（含 .. 或绝对路径）",
  },
  {
    id: "wildcard-delete",
    test: (name, target, args) =>
      (name === "fs_delete" || name === "shell") && /(^|\s)(rm|del)\b[^\n]*(\*|\?|\.\s*$|\.\.\s*$)/.test(target),
    reason: "删除目标是通配符或当前目录，范围不可控",
  },
  {
    id: "root-delete",
    test: (name, target) =>
      (name === "fs_delete" || name === "shell") && /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~)(\s|$)/i.test(target),
    reason: "递归删除根目录或家目录",
  },
  {
    id: "find-delete",
    test: (name, target) => name === "shell" && /\bfind\b[^\n]*(-delete|-exec\s+rm)\b/.test(target),
    reason: "用 find 批量删除，范围由表达式决定，审批里看不清",
  },
  {
    id: "remote-shell",
    test: (name, target) => name === "shell" && /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)\b/i.test(target),
    reason: "把网络上下载的脚本直接交给 shell",
  },
];

function reviewToolCall(info) {
  const name = String(info?.name || "");
  const args = info?.args && typeof info.args === "object" ? info.args : {};
  const target = String(args.path || args.file || args.command || args.code || "").trim();
  if (!target) return { deny: false };

  for (const rule of REVIEW_RULES) {
    try {
      if (rule.test(name, target, args)) {
        return { deny: true, rule: rule.id, reason: rule.reason };
      }
    } catch {
      /* 单条规则异常不影响其它规则 */
    }
  }
  return { deny: false };
}

/**
 * 审批决策 —— 三条执行路径（内置工具 / MCP / 插件工具）共用这一个函数。
 *
 * ============ 为什么必须抽出来 ============
 *
 * 之前只有内置工具读了 `state.settings.approval`，MCP 和插件是**无条件**调
 * `ctx.requestApproval`。结果就是：
 *
 *   用户把审批策略切到「自动放行」→ 内置的 fs_write、shell 不再弹窗，
 *   但 MCP 工具（比如本机控制 app_launch）每次照弹不误。
 *
 * 用户的观感是「自动放行坏了」，实际上是只有一条路径认这个设置。
 *
 * 顺带修掉两个更隐蔽的问题：
 *
 *   1) `runMcpTool` 里写的是 `if (!ok) 拒绝`。在没有审批通道的上下文
 *      （子 Agent、后台任务）里 requestApproval 是 undefined，
 *      `!undefined` 为真 → **MCP 工具被无故拒绝**。
 *
 *   2) `runPluginTool` 里写的是 `if (ok === false) 拒绝`。同一个场景下
 *      `undefined === false` 为假 → **插件工具被静默放行**。
 *
 *      两处对"没有审批通道"的处理正好相反，而它们都不该是这个语义。
 *
 * 现在的语义是明确的：没有审批通道时，敏感操作一律不做。
 */
async function decideApproval(label, info, ctx) {
  const policy = state.settings.approval;

  if (policy === "never") {
    return { ok: false, output: "审批策略为「全部拒绝」，操作未执行。", status: "denied" };
  }

  // 自动授权审查：只否决，不放行。
  // 放在用户点「允许」之前 —— 否则这道审查等于没做。
  if (state.plugins.some((p) => p.id === "review" && p.enabled)) {
    const r = reviewToolCall(info);
    state.review = state.review || { scans: 0, blocked: 0 };
    state.review.scans += 1;
    if (r.deny) {
      state.review.blocked += 1;
      save();
      emit({ type: "review" });
      return {
        ok: false,
        status: "denied",
        output: `自动授权审查拦下了这次调用：${r.reason}。\n\n如果确实需要这么做，请在「插件」里关掉「自动授权审查」，或把操作缩小到具体文件。`,
      };
    }
    save();
  }
  // 用户明确选了自动放行 —— 三条路径一视同仁。
  // 破坏性命令仍会被 CC Safety Net 在前面拦掉，这里不再重复询问。
  if (policy === "auto") {
    return { ok: true };
  }

  // 逐次询问
  if (typeof ctx?.requestApproval !== "function") {
    // 子 Agent / 后台任务没有 UI 可弹。这种情况绝不能静默放行敏感操作 ——
    // 宁可跳过并说明原因，让模型自己换一条不需要授权的路。
    return {
      ok: false,
      output: "当前上下文没有审批通道（子 Agent / 后台任务），敏感操作已跳过。",
      status: "denied",
    };
  }

  const allowed = await ctx.requestApproval({
    name: info.name,
    label,
    preview: info.preview || "",
    args: info.args || {},
    safety: info.safety,
  });

  if (!allowed) {
    return { ok: false, output: "用户拒绝了该操作。", status: "denied" };
  }
  return { ok: true };
}

async function runMcpTool(name, args, ctx) {
  const startedAt = Date.now();
  const found = findMcpTool(name);
  if (!found) {
    return { ok: false, output: `未知 MCP 工具：${name}`, ms: 0, status: "error" };
  }
  const { server, tool } = found;
  if (state.settings.permission === "readonly") {
    return { ok: false, output: "当前权限为只读，MCP 工具可能会修改外部数据，已拒绝。", ms: 0, status: "denied" };
  }

  const gate = await decideApproval(
    `MCP · ${server.name} · ${tool.name}`,
    { name, preview: server.url, args: args || {} },
    ctx
  );
  if (!gate.ok) {
    return { ok: false, output: gate.output, ms: Date.now() - startedAt, status: gate.status };
  }
  try {
    const res = await mcpCall(server, tool.name, args || {});
    return {
      ok: !res.isError,
      output: res.text,
      ms: Date.now() - startedAt,
      status: res.isError ? "error" : "done",
    };
  } catch (err) {
    // 结构化错误：模型需要知道「该不该重试、要不要人介入、下一步干什么」。
    // 只给一句 `MCP 调用失败：xxx` 的话，它只能靠猜 —— 于是 401 也重试。
    const e = toMcpError(err);
    return {
      ok: false,
      output: formatMcpError(e),
      ms: Date.now() - startedAt,
      status: e.userActionRequired ? "needs_user" : "error",
      retryable: e.retryable,
      userActionRequired: e.userActionRequired,
    };
  }
}

/**
 * 执行插件注册的工具。
 *
 * 插件工具一律走审批 —— 第三方代码的能力不能免审。
 * 只读模式下也拒绝：插件可能通过 fs.write 之类做出修改。
 */
async function runPluginTool(name, args, ctx) {
  const startedAt = Date.now();
  const m = /^plugin__([a-z0-9_-]+)__(.+)$/.exec(String(name || ""));
  if (!m) {
    return { ok: false, output: `插件工具名不合法：${name}`, ms: 0, status: "error" };
  }
  const [, pluginId, toolName] = m;
  const plugin = state.plugins.find((p) => p.id === pluginId);
  if (!plugin || !plugin.enabled) {
    return { ok: false, output: `插件 ${pluginId} 未启用`, ms: 0, status: "error" };
  }
  if (state.settings.permission === "readonly") {
    return {
      ok: false,
      output: "当前权限为只读，插件工具已拒绝。",
      ms: 0,
      status: "denied",
    };
  }
  const gate = await decideApproval(
    `插件 · ${plugin.name} · ${toolName}`,
    { name, preview: plugin.source || plugin.desc || "", args: args || {} },
    ctx
  );
  if (!gate.ok) {
    return { ok: false, output: gate.output, ms: Date.now() - startedAt, status: gate.status };
  }
  const res = await callPluginTool(name, args);
  return {
    ok: res.ok,
    output: res.output,
    ms: Date.now() - startedAt,
    status: res.ok ? "done" : "error",
  };
}

/**
 * Node 插件工具的执行。
 *
 * ============ 为什么和 iframe 插件分开 ============
 *
 * 两者执行路径完全不同：
 *   · iframe 插件 → 工具在 WebView 沙箱里，靠 postMessage 往返
 *   · Node 插件  → 工具在 Node 进程里，靠原生通道往返
 *
 * 但**审批逻辑必须一样**：都是第三方代码的能力，一律走审批，
 * 只读模式下也拒绝。不能因为"跑在 Node 里"就绕过审批 ——
 * 那等于给插件开后门。
 */
async function runNodePluginTool(name, args, ctx) {
  const startedAt = Date.now();
  const toolName = String(name).slice("plugin__node__".length);
  if (!toolName) {
    return { ok: false, output: `Node 插件工具名不合法：${name}`, ms: 0, status: "error" };
  }
  if (state.settings.permission === "readonly") {
    return {
      ok: false,
      output: "当前权限为只读，Node 插件工具已拒绝。",
      ms: 0,
      status: "denied",
    };
  }
  const gate = await decideApproval(
    `Node 插件 · ${toolName}`,
    { name, preview: "Node 运行时内的插件工具", args: args || {} },
    ctx
  );
  if (!gate.ok) {
    return { ok: false, output: gate.output, ms: Date.now() - startedAt, status: gate.status };
  }
  const res = await callNodeTool(name, args);
  return {
    ok: res.ok,
    output: res.output,
    ms: Date.now() - startedAt,
    status: res.ok ? "done" : "error",
  };
}

export async function executeTool(name, args, ctx = {}) {
  if (String(name).startsWith("mcp__")) return runMcpTool(name, args, ctx);
  // Node 插件工具：plugin__node__<toolName>
  // 必须排在 iframe 插件之前 —— 它也是 plugin__ 开头。
  if (String(name).startsWith("plugin__node__")) return runNodePluginTool(name, args, ctx);
  // 插件工具：plugin__<pluginId>__<toolName>
  if (String(name).startsWith("plugin__")) return runPluginTool(name, args, ctx);
  const tool = TOOLS[name];
  const startedAt = Date.now();
  if (!tool) {
    return { ok: false, output: `未知工具：${name}`, ms: 0, status: "error" };
  }

  // CC Safety Net：破坏性命令直接拦截，疑似密钥在审批里提示
  let safety = null;
  if (state.plugins.some((p) => p.id === "safety" && p.enabled)) {
    state.safety.scans += 1;
    safety = { checked: true };
    if (name === "shell" || name === "run_code") {
      const hits = scanDangerous(args.command || args.code || "");
      if (name === "run_code") {
        const scriptHits = scanScriptRisks(args.code || "");
        hits.push(...scriptHits);
      }
      if (hits.length) {
        state.safety.blocked += 1;
        save();
        emit({ type: "safety" });
        return {
          ok: false,
          output: `CC Safety Net 拦截了这次调用：\n- ${hits.join("\n- ")}\n\n护栏不会自动放行破坏性操作。如确需执行，请在「插件」里关闭 CC Safety Net，或改写命令。`,
          ms: Date.now() - startedAt,
          status: "blocked",
          safety: { blocked: true, hits },
        };
      }
    }
    if (name === "fs_write") {
      const secrets = scanSecrets(args.content || "");
      if (secrets.length) safety = { checked: true, warn: true, secrets };
    }
    save();
    emit({ type: "safety" });
  }

  // 权限：只读模式下拒绝一切写入类操作
  if (tool.sensitive && state.settings.permission === "readonly") {
    return {
      ok: false,
      output: "当前权限为「只读」，宿主已拒绝该操作。请让用户在设置中切换为「工作区写入」。",
      ms: 0,
      status: "denied",
    };
  }

  // 审批（与 MCP / 插件走同一套决策）
  if (tool.sensitive) {
    const gate = await decideApproval(
      tool.label,
      { name, preview: tool.preview?.(args) || "", args: args || {}, safety },
      ctx
    );
    if (!gate.ok) {
      return { ok: false, output: gate.output, ms: 0, status: gate.status };
    }
  }

  try {
    const limit = Number(tool.timeoutMs) > 0 ? Number(tool.timeoutMs) : 30000;
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`工具执行超时（${Math.round(limit / 1000)}s）`)), limit)
    );
    const result = await Promise.race([tool.run(args, ctx), timeout]);
    return {
      ok: result.ok !== false,
      output: clip(result.output ?? ""),
      diff: result.diff,
      code: result.code,
      export: result.export,
      ms: Date.now() - startedAt,
      status: result.ok === false ? "error" : "done",
      safety,
    };
  } catch (err) {
    return { ok: false, output: `执行异常：${err.message}`, ms: Date.now() - startedAt, status: "error" };
  }
}
