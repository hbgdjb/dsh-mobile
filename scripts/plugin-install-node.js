/* ============================================================
   Node 插件的安装器 —— 从网址 / 手机文件装一个 DSH 插件

   ============ 为什么需要它 ============

   插件的运行位置是 <工作区>/plugins/<id>/，而手机上没有「文件管理器
   直接往 Android/data 里放文件」这种操作（Android 11 起还锁了）。
   所以在补齐这个入口之前，用户装完 APK 根本没法把插件装进来 ——
   只能靠 adb push。这是真实的断点，不是「体验不够好」。

   ============ 支持什么 ============

     · .zip        —— GitHub Release 常见形态
     · .tar.gz     —— npm pack 出来的就是 .tgz，DSH 插件生态的原生形态
     · .js / .mjs  —— 单文件插件

   解压走浏览器内置的 DecompressionStream（WebView 自带），
   没有引入第三方库：一个 300 行的解包器不值得多背 100 KB。

   ============ 不做的事 ============

   · 不跑 npm install。手机上没有 npm，也无法为任意包解析依赖树。
     所以安装时会检查 package.json 的 dependencies：声明了依赖却没有
     内置 node_modules 的包，会在安装结果里明确标出来 ——
     那种包装上也会加载失败，不如提前说清楚。
   · 不校验签名。插件是任意 JS 代码，装了就等于把权限交给它 ——
     所以界面上必须先让用户明确同意。
   ============================================================ */

import { writeDoc, writeBinaryDoc, readDoc, deleteDoc, listDocs, clearArea, isTextPath, mimeOf } from "./fs.js";
import { nativeGetBytes } from "./native-http.js";
import { resolveDependencyTree, installDependencyTree } from "./npm-deps.js";

/** 这些文件/目录不装（打包工具和系统留下的垃圾）。 */
const IGNORE = [
  /(^|\/)__MACOSX\//,
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/,
  /(^|\/)\.git\//,
  /(^|\/)\.github\//,
  /(^|\/)\.npmignore$/,
  /(^|\/)\.gitignore$/,
];

/** 可当入口的文件名。 */
const ENTRY_NAMES = ["main.js", "index.js", "plugin.js"];

/* ---------------- base64 ---------------- */

/** Uint8Array → base64（分块，避免大文件爆栈）。 */
export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ---------------- 解压 ---------------- */

function needDecompression() {
  if (typeof DecompressionStream !== "function") {
    throw new Error(
      "这台设备的系统 WebView 太旧，不支持解压（缺少 DecompressionStream）。" +
        "到应用商店更新「Android System WebView」后再试，或改用单文件 .js 插件。"
    );
  }
}

async function inflateRaw(bytes) {
  needDecompression();
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  needDecompression();
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeName(bytes) {
  // zip 里的名字通常是 UTF-8（带 EFS 标志时）。非 UTF-8 会解成替换字符，
  // 对插件而言不影响加载（文件名只是路径）。
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * 解 zip。
 *
 * 走中央目录而不是顺序扫本地头：本地头里的 size 字段在「流式写入」的
 * zip 里可能是 0（真正的长度在数据描述符里），中央目录才是权威。
 *
 * 不支持 ZIP64（插件包不会超过 4 GB）。
 */
export async function unpackZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEocd = 22;
  if (bytes.length < minEocd) throw new Error("不是有效的 zip 文件");

  let eocd = -1;
  const floor = Math.max(0, bytes.length - minEocd - 65535);
  for (let i = bytes.length - minEocd; i >= floor; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 文件（找不到目录结尾）");

  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const out = [];

  for (let i = 0; i < count; i += 1) {
    if (off + 46 > bytes.length) break;
    if (view.getUint32(off, true) !== 0x02014b50) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = decodeName(bytes.subarray(off + 46, off + 46 + nameLen)).replace(/\\/g, "/");
    off += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if (localOff + 30 > bytes.length) continue;

    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);

    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`不支持的压缩方式（method=${method}）：${name}`);

    out.push({ path: name, bytes: data });
  }

  if (!out.length) throw new Error("这个 zip 里没有文件");
  return out;
}

/** tar 的定长字段：以 \0 结尾的字符串。 */
function tarString(block, from, len) {
  let end = from;
  const stop = from + len;
  while (end < stop && block[end] !== 0) end += 1;
  return new TextDecoder("utf-8").decode(block.subarray(from, end));
}

/** 解 tar.gz（npm pack 的 .tgz 就是它）。 */
export async function unpackTarGz(bytes) {
  const raw = await gunzip(bytes);
  const out = [];
  let off = 0;

  while (off + 512 <= raw.length) {
    const header = raw.subarray(off, off + 512);
    // 全零块 = 结束
    let empty = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) {
        empty = false;
        break;
      }
    }
    if (empty) break;

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const sizeText = tarString(header, 124, 12).trim();
    const size = parseInt(sizeText, 8) || 0;
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const full = (prefix ? `${prefix}/${name}` : name).replace(/\\/g, "/");

    off += 512;
    const data = raw.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;

    // '0' / '\0' = 普通文件；'5' = 目录；其余（链接、pax 头）跳过
    if (type !== "0" && type !== "7") continue;
    if (full.endsWith("/")) continue;
    out.push({ path: full, bytes: data.slice() });
  }

  if (!out.length) throw new Error("这个 tar.gz 里没有文件");
  return out;
}

/** 按文件名/内容判断打包格式，解出条目。 */
export async function unpackAny(name, bytes) {
  const lower = String(name || "").toLowerCase();
  // zip: 本地头签名 PK\x03\x04
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  // gzip: 1f 8b
  const isGz = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

  if (isZip || lower.endsWith(".zip")) return await unpackZip(bytes);
  if (isGz || lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) return await unpackTarGz(bytes);
  throw new Error("认不出这个包的格式（支持 .zip、.tar.gz、.tgz）");
}

/* ---------------- 规划安装 ---------------- */

function isIgnored(path) {
  return IGNORE.some((re) => re.test(path));
}

/**
 * 从一堆条目里认出「插件根」。
 *
 * 打包方式太多：GitHub 的 zip 外面裹一层 `<repo>-<tag>/`，
 * npm 的 tgz 裹一层 `package/`，用户自己压的可能什么都不裹。
 * 所以先算公共前缀，再按入口文件确认。
 *
 * @returns {{id:string, name:string, version:string, files:Array, entry:string, warnings:string[]}}
 */
export function planInstall(entries) {
  const items = entries
    .map((e) => ({ ...e, path: String(e.path || "").replace(/\\/g, "/").replace(/^\/+/, "") }))
    .filter((e) => e.path && !isIgnored(e.path));

  if (!items.length) throw new Error("包里没有可安装的文件");

  // 公共顶层目录：所有条目都在同一个第一段下才剥掉
  const firsts = new Set(items.map((e) => e.path.split("/")[0]));
  const hasNested = items.some((e) => e.path.includes("/"));
  let prefix = "";
  if (firsts.size === 1 && hasNested) {
    const only = [...firsts][0];
    // 只有当那个第一段本身是目录（所有路径都带 /）时才剥
    if (items.every((e) => e.path.startsWith(only + "/"))) prefix = only + "/";
  }

  const rel = items.map((e) => ({
    bytes: e.bytes,
    rel: prefix ? e.path.slice(prefix.length) : e.path,
  }));

  // 去掉包裹层后，可能还有一层（少见），只在没有入口时再试一次
  const findEntry = (list) =>
    list.find((f) => ENTRY_NAMES.includes(f.rel)) ||
    list.find((f) => f.rel.split("/").length === 1 && ENTRY_NAMES.includes(f.rel.split("/").pop()));

  let files = rel;
  let entry = findEntry(files);

  const pkgFile = files.find((f) => f.rel === "package.json");
  let pkg = null;
  if (pkgFile) {
    try {
      pkg = JSON.parse(new TextDecoder("utf-8").decode(pkgFile.bytes));
    } catch {
      pkg = null;
    }
  }

  if (!entry && pkg && typeof pkg.main === "string") {
    const main = pkg.main.replace(/^\.\//, "");
    if (files.some((f) => f.rel === main)) entry = { rel: main };
  }

  // 还没有入口 → 试试更深一层（比如一切都在 src/ 下）
  if (!entry) {
    const deeper = files.find((f) => /^(dist|lib|build|src)\/(main|index)\.js$/.test(f.rel));
    if (deeper) entry = deeper;
  }

  const warnings = [];
  if (!entry) {
    throw new Error(
      "这个包里找不到插件入口（需要 package.json 的 main，或根目录的 main.js / index.js / plugin.js）。" +
        "如果它是个普通 npm 库，那它不是 DSH 插件。"
    );
  }

  const id = normaliseId(pkg && pkg.name ? String(pkg.name) : prefix ? prefix.replace(/\/$/, "") : "plugin");

  const deps = pkg && pkg.dependencies && typeof pkg.dependencies === "object" ? Object.keys(pkg.dependencies) : [];
  if (deps.length) {
    const hasModules = files.some((f) => f.rel.startsWith("node_modules/"));
    if (!hasModules) {
      warnings.push(
        `package.json 声明了 ${deps.length} 个依赖（${deps.slice(0, 3).join("、")}${
          deps.length > 3 ? "…" : ""
        }），但包里没有 node_modules。手机端不能 npm install，这个插件很可能加载失败。`
      );
    }
  }

  if (!pkg) warnings.push("包里没有 package.json —— 只按入口文件安装，插件可能缺少元信息。");

  // ============ 有没有界面部分 ============
  //
  // DSH 生态里带 `client/` 的插件很多：那部分是给 dsh web 宿主渲染的
  // （要 window.__ModuleLoader__ + React + 宿主组件库）。手机端跑不了，
  // 所以装上之后「界面没变化」是正常的 —— 但必须提前说，
  // 否则用户会以为是装失败了。
  const hasClient =
    files.some((f) => f.rel === "client/client.js" || f.rel.startsWith("client/")) ||
    Boolean(pkg && pkg.exports && pkg.exports["./client"]);

  return {
    id,
    name: (pkg && (pkg.displayName || pkg.name)) || id,
    version: (pkg && pkg.version) || "0.0.0",
    entry: entry.rel,
    // 原始 package.json —— 装依赖时要用它的 dependencies
    pkg,
    hasClient,
    files: files.filter((f) => f.rel && !f.rel.endsWith("/")),
    warnings,
  };
}

/** 包名 → 可做目录名的 id。 */
export function normaliseId(raw) {
  let id = String(raw || "").trim();
  // @scope/name → scope-name（插件目录只用名字的最后一段会撞车）
  id = id.replace(/^@([^/]+)\//, "$1-");
  id = id.replace(/[^\w.\-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || "plugin";
}

/* ---------------- 安装 / 卸载 ---------------- */

/** 某个插件已占用的文件路径。 */
async function existingFiles(id) {
  try {
    const list = await listDocs("workspace", `plugins/${id}/`);
    return Array.isArray(list) ? list.map((f) => f.path) : [];
  } catch {
    return [];
  }
}

/**
 * 装一个插件。
 *
 * @param {object} opts
 *   opts.url   网址（http/https）
 *   opts.file  File 对象（二选一）
 *   opts.onProgress (text) => void
 * @returns {Promise<object>} plan 加上安装结果
 */
export async function installNodePlugin(opts = {}) {
  const say = typeof opts.onProgress === "function" ? opts.onProgress : () => {};

  let bytes;
  let filename = "";

  if (opts.file) {
    filename = String(opts.file.name || "plugin.bin");
    say("读取文件…");
    bytes = new Uint8Array(await opts.file.arrayBuffer());
  } else if (opts.url) {
    const input = String(opts.url).trim();
    if (!input) throw new Error("网址是空的");
    // 允许相对路径（同源），但最终必须是 http(s) —— data:/file:/javascript:
    // 这些协议不该出现在「装插件」的输入框里。
    let abs;
    try {
      abs = new URL(input, typeof location !== "undefined" ? location.href : undefined);
    } catch {
      throw new Error("网址格式不对：" + input);
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") {
      throw new Error("只支持 http / https 网址");
    }
    const url = abs.href;
    say("下载…");
    // ============ 为什么走原生而不是 fetch ============
    //
    // APK 里页面是从 capacitor://localhost 发请求的，拉第三方地址
    // 会被 CORS 挡住 —— JS 侧只看到一句 `Failed to fetch`，
    // 连状态码都没有。原生侧用 HttpURLConnection，没有同源策略。
    let got;
    try {
      got = await nativeGetBytes(url, { timeoutSec: 120 });
    } catch (e) {
      const status = Number(e && e.httpStatus) || 0;
      // 403 在分享链接里最常见的原因是「少了访问凭据」——
      // 说清楚，别让用户以为是插件包坏了。
      if (status === 403) {
        throw new Error(
          "下载被拒绝（HTTP 403）。如果这个地址来自分享链接，它通常需要末尾的 ?sharecode=… 访问凭据 —— " +
            "少那一段就会被网关拦掉。回到那个页面点「复制」拿完整地址。"
        );
      }
      if (status === 404) {
        throw new Error("下载失败（HTTP 404）：这个地址上没有文件，可能已被删除或改名。");
      }
      if (status) {
        throw new Error(`下载失败（HTTP ${status}）。这个地址可能需要登录，或已经失效。`);
      }
      const raw = String((e && e.message) || e);
      const crossOrigin = /failed to fetch|networkerror|load failed/i.test(raw);
      throw new Error(
        "连不上这个地址：" +
          raw +
          (crossOrigin
            ? "。浏览器预览里跨域请求会被拦（在手机上装则不受此限）；另外要确认它是直链。"
            : "。检查网络；另外要确认它是直链（点开就能下载文件），而不是一个需要点按钮的网页。")
      );
    }
    bytes = got.bytes;
    const tail = url.split("?")[0].split("/").pop() || "";
    filename = decodeURIComponent(tail);
  } else {
    throw new Error("要给一个网址或一个文件");
  }

  if (!bytes.length) throw new Error("内容是空的");
  if (bytes.length > 40 * 1024 * 1024) throw new Error("包太大了（>40 MB），手机端解不开");

  // 单文件插件：直接就是一段 JS
  if (/\.(m|c)?js$/i.test(filename) && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const base = filename.replace(/\.(m|c)?js$/i, "").replace(/[^\w.\-]+/g, "-") || "plugin";
    const id = normaliseId(base);
    const text = new TextDecoder("utf-8").decode(bytes);
    say("写入…");
    await writeDoc("workspace", `plugins/${id}/main.js`, text);
    return {
      id,
      name: id,
      version: "0.0.0",
      entry: "main.js",
      hasClient: false,
      files: [{ rel: "main.js", bytes }],
      warnings: ["这是个单文件插件 —— 没有 package.json，元信息按文件名推断。"],
      installed: 1,
    };
  }

  say("解开压缩包…");
  const entries = await unpackAny(filename, bytes);
  const plan = planInstall(entries);
  if (plan.files.length > 2000) throw new Error(`文件太多了（${plan.files.length} 个），这不像一个插件`);

  say(`写入 ${plan.files.length} 个文件…`);

  // 重装同一个 id：先清掉旧文件，避免残留
  const old = await existingFiles(plan.id);
  for (const p of old) {
    try {
      await deleteDoc("workspace", p);
    } catch {
      /* 删不掉就让它被覆盖 */
    }
  }

  let installed = 0;
  for (const f of plan.files) {
    const path = `plugins/${plan.id}/${f.rel}`;
    try {
      if (isTextPath(f.rel)) {
        await writeDoc("workspace", path, new TextDecoder("utf-8").decode(f.bytes));
      } else {
        await writeBinaryDoc("workspace", path, bytesToBase64(f.bytes), mimeOf(f.rel));
      }
      installed += 1;
    } catch (e) {
      throw new Error(`写入 ${f.rel} 失败：${(e && e.message) || e}`);
    }
  }

  // ============ 装依赖 ============
  //
  // npm 包不带 node_modules，而手机端没有 npm。不装的话，插件加载时
  // 直接 `Cannot find module` —— 一半的插件属于这一类。
  //
  // 失败不让整个安装失败：插件文件已经在磁盘上了，用户能在详情里看到
  // 「依赖没装成」，也可以卸载重来。比「装到一半全没了」好。
  let warnings = Array.isArray(plan.warnings) ? [...plan.warnings] : [];
  const depResult = await installDepsFor(plan, say);

  if (depResult.info) {
    // 依赖装上了，那条「包里没有 node_modules，很可能加载失败」就不成立了。
    // 留着会让用户以为还是坏的。
    warnings = warnings.filter((w) => !w.includes('但包里没有 node_modules'));
    if (depResult.note) warnings.push(depResult.note);
  }
  if (depResult.warnings.length) warnings.push(...depResult.warnings);

  return { ...plan, installed, warnings, deps: depResult.info };
}

/**
 * 依赖缓存的键。
 *
 * 用 `@scope__name@1.0.0.tgz` 而不是保留斜杠：斜杠会让缓存变成多层目录，
 * 清理和统计都要递归走，扁平化之后一个目录里一看就明白。
 */
export function depCacheKey(name, version) {
  const flat = String(name || "").replace(/\//g, "__");
  return `${flat}@${String(version || "")}.tgz`;
}

/**
 * 依赖缓存：按 name@version 存**原始 tarball**。
 *
 * 存在 `deps` 区（应用数据目录下的 deps-cache/），不进工作区 ——
 * 那是用户的文件空间，不该凭空多出几百个我们自己的缓存文件。
 */
const depCache = {
  async get(name, version) {
    try {
      const doc = await readDoc("deps", depCacheKey(name, version), true);
      const b64 = String((doc && doc.content) || "");
      if (!b64) return null;
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out.length ? out : null;
    } catch {
      // 没缓存是常态，不是错误
      return null;
    }
  },

  async put(name, version, bytes) {
    await writeBinaryDoc("deps", depCacheKey(name, version), bytesToBase64(bytes), "application/gzip");
  },
};

/** 缓存占了多少（字节）与多少个包 —— 设置页用来显示与清理。 */
export async function depCacheStats() {
  try {
    const rows = await listDocs("deps", "");
    let bytes = 0;
    let count = 0;
    for (const r of rows) {
      if (!String(r.path || "").endsWith(".tgz")) continue;
      count += 1;
      bytes += Number(r.size) || 0;
    }
    return { count, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

/** 清空依赖缓存。 */
export async function clearDepCache() {
  await clearArea("deps");
}

/**
 * 给一个刚装好的插件装依赖。
 *
 * @param {object} plan planInstall 的结果（带 pkg）
 * @param {function} say 进度回调
 */
async function installDepsFor(plan, say) {
  const pkg = plan.pkg;
  const out = { info: null, note: "", warnings: [] };

  if (!pkg || !pkg.dependencies || !Object.keys(pkg.dependencies).length) return out;
  // 包里自带 node_modules 就不用管了
  if ((plan.files || []).some((f) => f.rel.startsWith("node_modules/"))) return out;

  try {
    const tree = await resolveDependencyTree({
      rootPkg: pkg,
      fetchJson: async (url) => {
        const got = await nativeGetBytes(url, { timeoutSec: 30 });
        const bytes = got && got.bytes ? got.bytes : got;
        const text = new TextDecoder("utf-8").decode(bytes);
        try {
          return JSON.parse(text);
        } catch {
          throw new Error("npm 返回的不是 JSON（可能被网关拦了）");
        }
      },
      onProgress: (msg) => say(msg),
    });

    if (!tree.packages.length) return out;

    say(`装依赖：${tree.packages.length} 个包…`);
    const r = await installDependencyTree({
      id: plan.id,
      plan: tree,
      fetchBytes: (url) => nativeGetBytes(url, { timeoutSec: 90 }),
      unpack: unpackTarGz,
      cache: depCache,
      writeFile: async (rel, bytes) => {
        const target = `plugins/${plan.id}/${rel}`;
        if (isTextPath(rel)) {
          await writeDoc("workspace", target, new TextDecoder("utf-8").decode(bytes));
        } else {
          await writeBinaryDoc("workspace", target, bytesToBase64(bytes), mimeOf(rel));
        }
      },
      // done/total 一路透传给界面 —— 卡片里那条进度条靠它
      onProgress: (msg, done, total) => say(msg, done, total),
    });

    out.info = {
      packages: tree.packages.length,
      files: r.files,
      bytes: r.bytes,
      cached: r.cached || 0,
      downloaded: r.downloaded || 0,
    };
    out.warnings = r.warnings;
    out.note =
      `已自动安装 ${tree.packages.length} 个依赖包（${r.files} 个文件` +
      (r.cached ? `，其中 ${r.cached} 个来自缓存` : "") +
      "）。";
    return out;
  } catch (e) {
    out.warnings.push(
      `依赖没装成：${(e && e.message) || e}。这个插件大概率加载失败 —— 可以在插件详情里重试或卸载。`
    );
    return out;
  }
}

/** 卸载一个插件（删掉它目录下所有文件）。 */
export async function uninstallNodePlugin(id) {
  const files = await existingFiles(id);
  if (!files.length) return 0;
  let n = 0;
  for (const p of files) {
    try {
      await deleteDoc("workspace", p);
      n += 1;
    } catch {
      /* 单个文件删不掉不影响其它 */
    }
  }
  return n;
}
