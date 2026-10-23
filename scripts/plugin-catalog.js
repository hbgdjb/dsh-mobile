/* ============================================================
   插件市场的数据层

   ============ 数据从哪来 ============

   DSH 生态有一个公开的插件目录：
     https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json

   格式 1，目前 3000+ 条，2.5 MB。每条有名字、中英描述、仓库、分类、
   以及版本列表（`versions[].version`、`publishTimestamp`）。

   注意：**这不是 dshmarket 那个插件**。dshmarket 是给 dsh web 宿主用的
   UI 插件（要 `window.__ModuleLoader__` + React + 宿主的组件库），
   我们跑不了它；但它的数据源是这个公开索引，我们能直接用。

   ============ 为什么不落盘 ============

   2.5 MB 的 JSON 塞进工作区会污染用户的文件列表，塞 localStorage
   又可能超配额。所以只做会话内缓存，30 分钟过期。用户要最新数据
   就点「刷新」。

   ============ 安装地址 ============

   npm 的 tarball 规则：
     普通包    https://registry.npmmirror.com/<name>/-/<name>-<ver>.tgz
     scoped 包 https://registry.npmmirror.com/@scope/<name>/-/<name>-<ver>.tgz

   两者都验证过（302 → 200）。走镜像而不是 registry.npmjs.org，
   因为国内手机直连官方源经常超时。
   ============================================================ */

/** 原先唯一可用的地址。保留成常量，便于排查时对照。 */
export const CATALOG_URL = "https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json";

/**
 * 目录的候选来源，按「国内手机上多半能通」排序。
 *
 * ============ 为什么要有这一摞 ============
 *
 * 原来只认 cdn.jsdelivr.net。它在国内经常整段连接超时 ——
 * 用户看到的是「没能加载目录：ConnectException: Failed to connect
 * to cdn.jsdelivr.net/104.17.207.5:443」。这句话对用户没有意义，
 * 而他其实只是需要换一个能通的地址。
 *
 * 所以这里排了一串，逐个试，第一个通的就用：
 *
 *   npmmirror   国内 npm 镜像。和装包用的是同一个域名（已验证可达），
 *               拿的是 tarball，解出里面的 index.json。
 *   fastly      jsDelivr 的 Fastly 节点。和主域名同源但走不同 CDN，
 *               国内可达性常常比主域名好。
 *   gcore       jsDelivr 的 Gcore 节点，同上。
 *   jsdelivr    主域名。放后面，因为它是最可能被墙的那个。
 *   unpkg       另一个 npm CDN，兜底。
 *
 * 顺序不是拍脑袋：境外 CDN 里 fastly 节点在国内的连通率明显高于主域名，
 * 而 npmmirror 是唯一「和装包同域、已确认能下」的那条，所以排第一。
 */
export const CATALOG_SOURCES = [
  { id: "npmmirror", label: "npmmirror", kind: "tgz", timeoutSec: 90 },
  {
    id: "fastly",
    label: "jsDelivr Fastly",
    kind: "json",
    url: "https://fastly.jsdelivr.net/npm/dsh-plugin-catalog/index.json",
    timeoutSec: 25,
  },
  {
    id: "gcore",
    label: "jsDelivr Gcore",
    kind: "json",
    url: "https://gcore.jsdelivr.net/npm/dsh-plugin-catalog/index.json",
    timeoutSec: 25,
  },
  {
    id: "jsdelivr",
    label: "jsDelivr",
    kind: "json",
    url: "https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json",
    timeoutSec: 25,
  },
  {
    id: "unpkg",
    label: "unpkg",
    kind: "json",
    url: "https://unpkg.com/dsh-plugin-catalog/index.json",
    timeoutSec: 25,
  },
];

/**
 * 上次成功的来源 id。
 *
 * 记住它，下次先试这个 —— 同一个网络环境下可达性不会突变，
 * 没必要每次都从第一个开始重走一遍失败。
 */
let preferredId = "";

/** 上次成功用的来源（没成功过返回空串）。 */
export function catalogSourceId() {
  return preferredId;
}

/** 缓存多久（毫秒）。 */
const TTL = 30 * 60 * 1000;

/** npm 镜像（下载包用）。 */
export const NPM_MIRROR = "https://registry.npmmirror.com";

/** { at:number, items:Array } */
let cache = null;

/**
 * 清掉缓存（用户点刷新时用）。
 *
 * @param {object} [opts]
 *   opts.forgetSource  连「上次用哪个源」的记忆一起清掉。
 *                      平时不清 —— 那是网络环境的记忆，清数据不等于忘了哪条路能走。
 */
export function clearCatalogCache(opts = {}) {
  cache = null;
  if (opts && opts.forgetSource) preferredId = "";
}

/**
 * 把原始索引压成我们要的形状。
 *
 * 只保留最新版本 —— 目录里 `versions` 是升序的，我们要的是「现在装哪个」。
 *
 * @param {object} raw index.json 的解析结果
 * @returns {Array<{name:string, title:string, desc:string, descEn:string, category:string, version:string, updatedAt:number, repo:string}>}
 */
export function normalizeCatalog(raw) {
  const list = Array.isArray(raw && raw.plugins) ? raw.plugins : [];
  const items = [];

  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const name = String(p.name || "").trim();
    if (!name) continue;

    const versions = Array.isArray(p.versions) ? p.versions : [];
    const last = versions.length ? versions[versions.length - 1] : null;
    const version = last && last.version ? String(last.version) : "";

    const d = p.description;
    const desc = typeof d === "string" ? d : d && typeof d.zh === "string" ? d.zh : "";
    const descEn = d && typeof d.en === "string" ? d.en : "";

    // title 常常是「作者/包名」，显示时去掉作者前缀；name 才是安装用的
    const rawTitle = String(p.title || name);
    const title = rawTitle.includes("/") ? rawTitle.split("/").slice(1).join("/") : rawTitle;

    items.push({
      name,
      title: title || name,
      desc,
      descEn,
      category: String((p.metadata && p.metadata.category) || ""),
      version,
      // publishTimestamp 是秒
      updatedAt: Number(last && last.publishTimestamp) || 0,
      repo: String((p.repository && p.repository.url) || p.homepage || ""),
    });
  }

  return items;
}

/**
 * 从一个来源读到原始索引对象。
 *
 * 两种形态：
 *   json  直接 GET 一份 index.json
 *   tgz   先问 npmmirror 要最新版本号，再下 tarball，解出 package/index.json
 */
async function readSource(src, fetchBytes) {
  if (src.kind === "tgz") {
    const metaGot = await fetchBytes(`${NPM_MIRROR}/dsh-plugin-catalog/latest`, { timeoutSec: 25 });
    const metaText = new TextDecoder("utf-8").decode(toBytes(metaGot));
    let meta;
    try {
      meta = JSON.parse(metaText);
    } catch {
      throw new Error("npm 元信息不是合法 JSON");
    }
    const ver = String((meta && meta.version) || "").trim();
    if (!ver) throw new Error("npm 元信息里没有版本号");

    const tgzGot = await fetchBytes(
      `${NPM_MIRROR}/dsh-plugin-catalog/-/dsh-plugin-catalog-${ver}.tgz`,
      { timeoutSec: 90 }
    );
    const tgz = toBytes(tgzGot);
    if (!tgz || tgz.length < 100) throw new Error("下到的 tarball 是空的");

    // 动态引：解包器在安装模块里，而安装模块不依赖本模块，不会成环
    const { unpackTarGz } = await import("./plugin-install-node.js");
    const entries = await unpackTarGz(tgz);
    const hit = entries.find((e) => {
      const p = String(e.path || "").replace(/^package\//, "");
      return p === "index.json";
    });
    if (!hit) throw new Error("tarball 里没有 index.json");
    return JSON.parse(new TextDecoder("utf-8").decode(hit.bytes));
  }

  const got = await fetchBytes(src.url, { timeoutSec: src.timeoutSec || 25 });
  const text = new TextDecoder("utf-8").decode(toBytes(got));
  return JSON.parse(text);
}

/** 注入的取字节函数可能直接返回 Uint8Array，也可能是 { bytes }。 */
function toBytes(got) {
  if (!got) return new Uint8Array(0);
  if (got.bytes || got instanceof Uint8Array) return got.bytes || got;
  return new Uint8Array(0);
}

/** 把一来源的失败压缩成一句能读的话。 */
function briefError(e) {
  const raw = String((e && e.message) || e || "未知错误");
  // Java 的异常类名对用户没有意义，只留「连不上哪个主机」
  const host = raw.match(/Failed to connect to ([^/\s:]+)/i);
  if (host) return `连不上 ${host[1]}`;
  const dns = raw.match(/Unable to resolve host "([^"]+)"/i);
  if (dns) return `解析不到 ${dns[1]}`;
  if (/timeout|超时/i.test(raw)) return "超时";
  if (/HTTP 403/.test(raw)) return "被拒绝（403）";
  if (/HTTP 404/.test(raw)) return "地址上没有文件（404）";
  return raw.length > 60 ? raw.slice(0, 60) + "…" : raw;
}

/**
 * 拉取目录。
 *
 * 依次试 CATALOG_SOURCES 里的来源，第一个成功的就用，并记住它 ——
 * 下次先试这个，不用每次把失败的都重走一遍。
 *
 * @param {object} [opts]
 *   opts.force       忽略缓存
 *   opts.fetchBytes  注入的取字节函数（测试用；默认走原生通道，绕 CORS）
 *   opts.onProgress  每换一个源时回调 (label, index, total)
 * @returns {Promise<Array>}
 */
export async function loadCatalog(opts = {}) {
  const now = Date.now();
  if (!opts.force && cache && now - cache.at < TTL) return cache.items;

  let fetchBytes = opts.fetchBytes;
  if (!fetchBytes) {
    const mod = await import("./native-http.js");
    // 超时由每个来源自己定 —— 2.6 MB 的 json 和 2.7 MB 的 tgz 不是一回事
    fetchBytes = (url, o) => mod.nativeGetBytes(url, { timeoutSec: (o && o.timeoutSec) || 25 });
  }

  const ordered = orderSources();
  const tried = [];
  let raw = null;
  let usedId = "";

  for (let i = 0; i < ordered.length; i += 1) {
    const src = ordered[i];
    try {
      opts.onProgress?.(src.label, i, ordered.length);
      raw = await readSource(src, fetchBytes);
      if (!raw || !Array.isArray(raw.plugins)) throw new Error("格式不对：没有 plugins 数组");
      usedId = src.id;
      break;
    } catch (e) {
      tried.push(`${src.label}：${briefError(e)}`);
      raw = null;
    }
  }

  if (!raw) {
    throw new Error(
      `所有 ${ordered.length} 个来源都不通（${tried.join("；")}）。` +
        "检查一下网络，或者连上 Wi-Fi 再试。"
    );
  }

  const items = normalizeCatalog(raw);
  if (!items.length) throw new Error("插件目录是空的");

  preferredId = usedId;
  cache = { at: now, items, source: usedId };
  return items;
}

/** 把上次成功的来源提到最前。 */
function orderSources() {
  if (!preferredId) return CATALOG_SOURCES.slice();
  const idx = CATALOG_SOURCES.findIndex((s) => s.id === preferredId);
  if (idx <= 0) return CATALOG_SOURCES.slice();
  const out = CATALOG_SOURCES.slice();
  const [hit] = out.splice(idx, 1);
  out.unshift(hit);
  return out;
}

/** 当前缓存的时间戳（没有缓存返回 0）。 */
export function catalogCachedAt() {
  return cache ? cache.at : 0;
}

/** 缓存来自哪个源（排查「为什么这次快了」时用）。 */
export function catalogCachedSource() {
  return cache ? cache.source || "" : "";
}

/**
 * 过滤。
 *
 * @param {Array} items
 * @param {object} opts { query, category }
 */
export function filterCatalog(items, opts = {}) {
  const q = String(opts.query || "").trim().toLowerCase();
  const cat = String(opts.category || "");

  return (items || []).filter((it) => {
    if (cat && it.category !== cat) return false;
    if (!q) return true;
    return (
      it.name.toLowerCase().includes(q) ||
      it.title.toLowerCase().includes(q) ||
      (it.desc && it.desc.toLowerCase().includes(q)) ||
      (it.descEn && it.descEn.toLowerCase().includes(q))
    );
  });
}

/** 分类统计，按数量从多到少。 */
export function categoriesOf(items) {
  const counts = new Map();
  for (const it of items || []) {
    if (!it.category) continue;
    counts.set(it.category, (counts.get(it.category) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * npm 包名 → 安装后的插件目录 id。
 *
 * 装完之后插件目录名不是 `@scope/name` —— 斜杠进不了目录名，
 * 所以安装器是 `@scope/name` → `scope-name`。
 *
 * 市场列表要靠它判断「这个装过了没有」。规则和安装器里的
 * normaliseId 必须一致，否则搜到已装的插件还会显示「安装」，
 * 点下去报「已存在」。测试里对着同一批输入比过两边的结果。
 */
export function pluginIdOf(name) {
  return String(name || "")
    .trim()
    .replace(/^@([^/]+)\//, "$1-")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 某个插件在 npm 上的 tarball 地址。
 *
 * scoped 包的文件名不含 scope：`@a/b@1.0.0` → `b-1.0.0.tgz`。
 */
export function npmTarballUrl(name, version) {
  const pkg = String(name || "").trim();
  const ver = String(version || "").trim();
  if (!pkg || !ver) throw new Error("缺少包名或版本");
  const base = pkg.startsWith("@") ? pkg.split("/")[1] : pkg;
  if (!base) throw new Error("包名不对：" + pkg);
  return `${NPM_MIRROR}/${pkg}/-/${base}-${ver}.tgz`;
}

/* ============================================================
   装前预检
   ============================================================ */

/**
 * 查一个包在 npm 上的真实样子。
 *
 * ============ 为什么详情页要查这个 ============
 *
 * 目录里一条只有名字、描述、分类、版本。但用户真正想知道的是
 * 「装上去能不能用」—— 而这件事目录里没有答案，答案在 package.json：
 *
 *   dependencies  非空 → 手机端不能 npm install，包里也不带 node_modules，
 *                 加载时多半 `Cannot find module`
 *   peerDependencies  这些通常是宿主提供的（cordis / react），
 *                 我们的容器给了 cordis 兼容层，一般不算问题
 *   exports["./client"]  有界面部分，而本机不渲染
 *
 * `/latest` 这个端点是精简的、只有几百字节到几 KB，不会像完整
 * packument 那样动辄几 MB。
 *
 * @param {string} name npm 包名
 * @param {object} [opts] { fetchBytes }
 * @returns {Promise<{name:string, version:string, main:string, deps:string[], peers:string[], hasClient:boolean, enginesNode:string}>}
 */
export async function inspectPackage(name, opts = {}) {
  const pkg = String(name || "").trim();
  if (!pkg) throw new Error("缺少包名");

  let fetchBytes = opts.fetchBytes;
  if (!fetchBytes) {
    const mod = await import("./native-http.js");
    fetchBytes = (url, o) => mod.nativeGetBytes(url, { timeoutSec: (o && o.timeoutSec) || 20 });
  }

  const got = await fetchBytes(`${NPM_MIRROR}/${pkg}/latest`, { timeoutSec: 20 });
  const text = new TextDecoder("utf-8").decode(toBytes(got));

  let meta;
  try {
    meta = JSON.parse(text);
  } catch {
    throw new Error("npm 返回的不是 JSON（可能被网关拦了）");
  }
  if (!meta || typeof meta !== "object" || !meta.version) {
    throw new Error("npm 上查不到这个包");
  }

  const exp = meta.exports;
  const hasClient = Boolean(
    (exp && typeof exp === "object" && exp["./client"]) ||
      (Array.isArray(meta.files) && meta.files.includes("client")) ||
      (meta.directories && meta.directories.client)
  );

  return {
    name: String(meta.name || pkg),
    version: String(meta.version),
    main: String(meta.main || ""),
    deps: Object.keys(meta.dependencies || {}),
    peers: Object.keys(meta.peerDependencies || {}),
    hasClient,
    enginesNode: String((meta.engines && meta.engines.node) || ""),
  };
}

/**
 * 「多久以前」。
 *
 * 目录里给的是 publishTimestamp（秒）。直接显示时间戳没意义，
 * 显示「3 天前」才知道这插件是不是还在维护。
 *
 * @param {number} tsSeconds
 * @param {number} [now] 测试注入
 */
export function formatAgo(tsSeconds, now = Date.now()) {
  const ts = Number(tsSeconds) || 0;
  if (!ts) return "";
  const diff = Math.max(0, now - ts * 1000);
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))} 个月前`;
  return `${Math.floor(diff / (365 * day))} 年前`;
}
