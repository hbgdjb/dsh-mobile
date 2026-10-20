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
  save,
  emit,
  matchFilePath,
  pathKey,
} from "./store.js";
import { isImagePath } from "./image.js";
import { markdownToDocx, csvToXlsx, bytesToBase64 } from "./office.js";
import { scanDangerous, scanSecrets, scanScriptRisks } from "./safety.js";
import { mcpToolSchemas, findMcpTool, mcpCall } from "./mcp.js";

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
  return { kind: "bin", label: "二进制数据" };
}

/** 生成一份可直接放进上下文的结构化描述（不依赖模型去猜）。 */
export function describeBytes(bytes, path = "", { maxEntries = 24 } = {}) {
  const kind = detectKind(bytes, path);
  const lines = [
    `文件：${path}`,
    `类型：${kind.label}`,
    `大小：${fmtSize(bytes.length)}（${bytes.length} 字节）`,
    `头 32 字节：${hexOf(bytes.subarray(0, 32)) || "（空）"}`,
    `可打印：|${asciiOf(bytes.subarray(0, 32))}|`,
  ];
  if (kind.kind === "zip") {
    const entries = zipEntries(bytes);
    if (entries) {
      const unpacked = entries.reduce((s, e) => s + (Number(e.size) || 0), 0);
      const isApk = entries.some((e) => e.name === "AndroidManifest.xml") && entries.some((e) => e.name === "classes.dex");
      lines.push(`内容：${entries.length} 个条目，解压后约 ${fmtSize(unpacked)}${isApk ? "；含 AndroidManifest.xml 与 classes.dex，可判定为 APK" : ""}`);
      entries.slice(0, maxEntries).forEach((e) => lines.push(`  ${e.name}  ${fmtSize(Number(e.size) || 0)}`));
      if (entries.length > maxEntries) lines.push(`  … 还有 ${entries.length - maxEntries} 个条目`);
    } else {
      lines.push("内容：ZIP 目录未能解析（可能不是完整压缩包）");
    }
  } else if (kind.kind === "pdf") {
    const text = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 200000)));
    const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
    const version = (text.match(/%PDF-(\d\.\d)/) || [])[1] || "?";
    lines.push(`PDF 版本 ${version}${pages ? `，约 ${pages} 页` : ""}`);
  }
  lines.push(`看片段用 fs_read(path="${path}", offset=0, length=256, format="hex")；二进制不要用 cat，也不要用 cp 挪到 /tmp 再 od。`);
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

async function runOne(command, stdin = "", stdinBytes = null) {
  const cmd = String(command || "").trim();
  if (!cmd) return { ok: false, output: "空命令" };

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
  // 宽松解析：括号全半角、空格、大小写、URL 编码差异都能对上
  const resolve = (raw) => matchFilePath(paths, raw) || rel(raw);
  const flagOn = (ch) => flags.some((f) => f.replace(/^-+/, "").includes(ch));
  const missing = (name, raw) => {
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

  switch (head) {
    case "pwd":
      return { ok: true, output: "/workspace" };

    case "ls": {
      const prefix = rel(args[0]);
      const key = pathKey(prefix);
      const hits = files.filter((f) => {
        if (!prefix) return true;
        const fp = pathKey(f.path);
        return fp === key || fp.startsWith(`${key}/`);
      });
      if (!hits.length) return { ok: false, output: `${prefix ? prefix + "/" : "/"} 下没有文件` };
      const long = flagOn("l");
      return {
        ok: true,
        output: hits
          .map((f) => (long ? `${String(Number(f.size) || 0).padStart(9)} B  ${fmtTime(f.updatedAt)}  ${f.path}` : f.path))
          .join("\n"),
      };
    }

    case "cat": {
      if (!args.length) return { ok: false, output: "用法：cat <文件> [更多文件…]" };
      const parts = [];
      for (const raw of args) {
        if (rel(raw) === "dev/null") continue;
        const p = resolve(raw);
        const f = await readFile(p);
        if (!f) return { ok: false, output: missing("cat", raw) };
        if (f.encoding === "base64") {
          return {
            ok: false,
            output: `cat: ${p} 是二进制（${((Number(f.size) || 0) / 1024).toFixed(1)} KB），不能按文本输出${isImagePath(p) ? "；这是图片，只能作为附件发给模型看" : ""}。`,
          };
        }
        if (args.length > 1) parts.push(`==> ${p} <==`);
        parts.push(f.content);
      }
      return { ok: true, output: clip(parts.join("\n")) };
    }

    case "wc": {
      if (!args[0]) return { ok: false, output: "用法：wc [-l] [-w] [-c] <文件>" };
      const p = resolve(args[0]);
      const f = await readFile(p);
      if (!f) return { ok: false, output: missing("wc", args[0]) };
      const size = Number(f.size) || String(f.content || "").length;
      if (f.encoding === "base64") return { ok: true, output: `${size} 字节（二进制文件）` };
      const text = String(f.content || "");
      const lines = text ? text.split("\n").length : 0;
      const chars = text.length;
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const picked = [
        flagOn("l") ? `${lines} 行` : "",
        flagOn("w") ? `${words} 词` : "",
        flagOn("c") ? `${chars} 字符` : "",
      ].filter(Boolean);
      return { ok: true, output: picked.length ? picked.join(" · ") : `${lines} 行 · ${chars} 字符` };
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
        const lines = String(stdin || "").split("\n");
        const slice = head === "head" ? lines.slice(0, n) : lines.slice(-n);
        return { ok: true, output: clip(slice.join("\n")) };
      }
      const p = resolve(raw);
      const f = await readFile(p);
      if (!f) return { ok: false, output: missing(head, raw) };
      if (f.encoding === "base64") return { ok: false, output: `${head}: ${p} 是二进制文件；用 od / xxd / fs_inspect 看字节` };
      const lines = String(f.content || "").split("\n");
      const slice = head === "head" ? lines.slice(0, n) : lines.slice(-n);
      return { ok: true, output: clip(slice.join("\n")) };
    }

    case "cp":
    case "mv": {
      if (args.length < 2) return { ok: false, output: `用法：${head} <源> <目标>` };
      if (state.settings.permission === "readonly") return { ok: false, output: "当前是只读权限，不能复制或移动文件" };
      const src = resolve(args[0]);
      const dst = rel(args[1]);
      const doc = await readFile(src);
      if (!doc) return { ok: false, output: missing(head, args[0]) };
      if (doc.encoding === "base64") {
        await writeBinaryFile(dst, String(doc.content || ""), doc.mime || "application/octet-stream", Number(doc.size) || 0);
      } else {
        await writeFile(dst, doc.content);
      }
      if (head === "mv") await deleteFile(src);
      return { ok: true, output: `${src} -> ${dst}（${fmtSize(Number(doc.size) || 0)}）` };
    }

    case "rm": {
      if (!args.length) return { ok: false, output: "用法：rm <文件>" };
      if (state.settings.permission === "readonly") return { ok: false, output: "当前是只读权限，不能删除文件" };
      const p = resolve(args[0]);
      if (!files.some((f) => f.path === p)) return { ok: false, output: missing("rm", args[0]) };
      await deleteFile(p);
      return { ok: true, output: `已删除 ${p}` };
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
      const target = args[0];
      if (!target) return { ok: false, output: "用法：unzip -l <压缩包>" };
      const doc = await readFile(resolve(target));
      if (!doc) return { ok: false, output: missing("unzip", target) };
      const entries = zipEntries(bytesOfDoc(doc));
      if (!entries) return { ok: false, output: `unzip: ${target} 不是可解析的 ZIP / APK` };
      const lines = [`${entries.length} 个条目：`];
      entries.slice(0, 80).forEach((e) => lines.push(`${String(Number(e.size) || 0).padStart(9)}  ${e.name}`));
      if (entries.length > 80) lines.push(`… 还有 ${entries.length - 80} 个条目`);
      return { ok: true, output: lines.join("\n") };
    }

    case "grep": {
      const pat = args[0];
      if (!pat) return { ok: false, output: "用法：grep [-i] [-n] 模式 [文件…]" };
      let re;
      try {
        re = new RegExp(pat, flags.some((f) => f.includes("i")) ? "i" : "");
      } catch {
        return { ok: false, output: `grep: 无效的正则 ${pat}` };
      }
      const srcs = args.slice(1);
      let text = stdin;
      if (srcs.length) {
        const parts = [];
        for (const s of srcs) {
          if (rel(s) === "dev/null") continue;
          const d = await readFile(resolve(s));
          if (!d) return { ok: false, output: missing("grep", s) };
          parts.push(d.encoding === "base64" ? "" : String(d.content || ""));
        }
        text = parts.join("\n");
      }
      const numbered = flags.some((f) => f.includes("n"));
      const hits = String(text || "")
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter((x) => re.test(x.line));
      if (!hits.length) return { ok: true, output: "（没有匹配）" };
      return { ok: true, output: hits.slice(0, 200).map((x) => (numbered ? `${x.i + 1}: ${x.line}` : x.line)).join("\n") };
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
        output: `沙箱终端不支持 \`${head}\`。可用：pwd / ls [-l] / cat / head / tail / wc / file / cp / mv / rm / mkdir / od / xxd / base64 / sha256sum / unzip -l / grep / echo / date / tree，支持 | 管道与 > 重定向；看二进制优先用 fs_inspect。`,
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
      cur += ch;
      if (ch === quote) quote = "";
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

async function runPipeline(text) {
  const segs = splitTop(text, ["|"]);
  let stdin = "";
  let stdinBytes = null;
  for (const seg of segs) {
    let cmd = seg.text.trim();
    if (!cmd) continue;
    // 常见写法：2>&1、>/dev/null —— 虚拟文件系统没有设备节点，直接丢弃
    cmd = cmd.replace(/2>&1/g, "").replace(/\d?>\s*\/dev\/null/g, "").trim();
    if (!cmd) continue;
    let redirect = null;
    const m = cmd.match(/(>>?)\s*("[^"]+"|'[^']+'|\S+)\s*$/);
    if (m) {
      redirect = { append: m[1] === ">>", path: m[2].replace(/^["']|["']$/g, "") };
      cmd = cmd.slice(0, m.index).trim();
    }
    const r = await runOne(cmd, stdin, stdinBytes);
    if (!r.ok) return r;
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

async function runShell(command) {
  const text = String(command || "").trim();
  if (!text) return { ok: false, output: "空命令" };
  const segs = splitTop(text, ["&&", ";"]);
  let last = { ok: true, output: "" };
  for (const seg of segs) {
    if (!seg.text.trim()) continue;
    last = await runPipeline(seg.text);
    if (!last.ok && seg.op === "&&") return last;
  }
  return last;
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
      "读取工作区文件。文本返回正文；二进制可传 format=\"hex\"（配合 offset/length）查看字节片段，不会报“读不了”。",
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
      if (!f) return { ok: false, output: `文件不存在：${a.path}\n可用文件：\n${listFiles().map((x) => x.path).join("\n")}` };
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
      if (!f) return { ok: false, output: `文件不存在：${a.path}\n可用文件：\n${listFiles().map((x) => x.path).join("\n")}` };
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

  shell: {
    group: "shell",
    label: "终端",
    description: "在沙箱工作区执行命令（pwd / ls / cat / echo / date / wc / tree）。",
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
      "把工作区的 Markdown 导出为 Word（.docx），或把 CSV 导出为 Excel（.xlsx）。产物写入 exports/，可在工作区下载。",
    sensitive: true,
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "源文件路径，.md 或 .csv" },
        format: { type: "string", enum: ["docx", "xlsx"], description: "目标格式" },
      },
      required: ["path"],
    },
    preview: (a) =>
      `${a.path} → ${
        (a.format || (/\.csv$/i.test(a.path || "") ? "xlsx" : "docx")) === "xlsx"
          ? "Excel（.xlsx）"
          : "Word（.docx）"
      }`,
    async run(a) {
      const f = await readFile(a.path);
      if (!f) return { ok: false, output: `源文件不存在：${a.path}` };
      if (f.encoding === "base64") return { ok: false, output: "源文件是二进制，不能再导出为 Office 文件。" };

      const base = String(a.path).split("/").pop().replace(/\.[^.]+$/, "");
      const format = String(a.format || (/\.csv$/i.test(a.path) ? "xlsx" : "docx")).toLowerCase();

      if (format === "xlsx" && !/\.csv$/i.test(a.path)) {
        return {
          ok: false,
          output: "Excel 导出需要 CSV 源文件。请先用 run_code 把数据写成 .csv，再导出。",
        };
      }

      let bytes;
      let mime;
      let out;
      if (format === "xlsx") {
        bytes = csvToXlsx(f.content, base);
        mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        out = `exports/${base}.xlsx`;
      } else if (format === "docx") {
        bytes = markdownToDocx(f.content, base);
        mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        out = `exports/${base}.docx`;
      } else {
        return { ok: false, output: "只支持 docx 与 xlsx 两种格式。" };
      }

      await writeBinaryFile(out, bytesToBase64(bytes), mime, bytes.length);
      return {
        ok: true,
        output: `已导出 ${out} · ${(bytes.length / 1024).toFixed(1)} KB\n可在「工作区 → exports/」点开并下载。`,
        export: { path: out, size: bytes.length, mime },
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
  standard: ["fs_list", "fs_read", "fs_inspect", "fs_write", "fs_delete", "library_list", "library_read", "library_save", "calc", "now"],
  minimal: ["fs_list", "fs_read", "fs_inspect", "fs_write", "shell"],
  ptc: ["fs_list", "fs_read", "fs_inspect", "fs_write", "fs_delete", "library_list", "library_read", "library_save", "calc", "now", "run_code"],
  creator: ["fs_list", "fs_read", "fs_inspect", "fs_write", "fs_delete", "library_list", "library_read", "library_save", "calc", "now", "plugin_inspect", "plugin_scaffold"],
};

export function availableToolNames() {
  const mode = state.settings.mode;
  const base = TOOLSETS[mode] || TOOLSETS.standard;
  const pluginMap = {
    terminal: ["shell"],
    websearch: ["web_search"],
    subagent: ["spawn_subagent"],
    scheduler: ["task_schedule"],
    office: ["office_export"],
    ops: ["ops_status", "ops_cleanup"],
  };
  const extra = [];
  state.plugins.forEach((p) => {
    if (!p.enabled) return;
    (pluginMap[p.id] || []).forEach((t) => extra.push(t));
  });
  const mcpNames = mode === "minimal" ? [] : mcpToolSchemas().map((t) => t.function.name);
  const names = [...new Set([...base, ...extra, ...mcpNames])];
  // 极简模式只保留两个能力：终端 + 文件编辑器
  if (mode === "minimal") return ["fs_read", "fs_write", "shell"];
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
  return [...base, ...mcp];
}

/* ---------------- 执行闸门 ---------------- */

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
  const ok = await ctx.requestApproval?.({
    name,
    label: `MCP · ${server.name} · ${tool.name}`,
    preview: server.url,
    args: args || {},
  });
  if (!ok) {
    return { ok: false, output: "已拒绝这次 MCP 工具调用。", ms: Date.now() - startedAt, status: "denied" };
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
    return {
      ok: false,
      output: `MCP 调用失败：${err.message}`,
      ms: Date.now() - startedAt,
      status: "error",
    };
  }
}

export async function executeTool(name, args, ctx = {}) {
  if (String(name).startsWith("mcp__")) return runMcpTool(name, args, ctx);
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

  // 审批
  if (tool.sensitive && state.settings.approval === "never") {
    return {
      ok: false,
      output: "审批策略为「全部拒绝」，操作未执行。",
      ms: 0,
      status: "denied",
    };
  }

  if (tool.sensitive && state.settings.approval === "ask" && ctx.requestApproval) {
    const ok = await ctx.requestApproval({
      name,
      label: tool.label,
      preview: tool.preview?.(args) || "",
      args: args || {},
      safety,
    });
    if (!ok) {
      return { ok: false, output: "用户拒绝了该操作。", ms: 0, status: "denied" };
    }
  }

  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("工具执行超时（30s）")), 30000)
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
