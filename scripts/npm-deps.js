/* ============================================================
   在手机上「装」npm 依赖

   ============ 为什么需要这个 ============

   抽查 24 个真实 DSH 插件，**一半声明了 dependencies，而 npm 包不附带
   node_modules**。手机端没有 npm，所以这类插件装上后加载即报
   `Cannot find module`。

   验证 dsh-free-search 时，我手工往里塞了 8 个包才让它跑起来 ——
   这件事应该由程序做。

   ============ 我们做的不是 npm install ============

   而是它的一小部分：读 dependencies → 去 registry 查版本 → 下 tarball
   → 解包 → 放进 node_modules。

   少了 npm 的一大堆行为，其中两件是**故意**少的：

     · 不跑任何 install/postinstall 脚本（插件包里的脚本一律不执行）
     · 不处理 bin 链接、不处理 git 依赖、不处理 workspace 协议

   代价是少数包装不了（比如带原生编译的），收益是安装过程不会因为
   某个包的 postinstall 在用户手机上执行任意代码。

   ============ 版本冲突怎么办 ============

   照 Node 的解析规则：能放根 node_modules 就放根（扁平），
   放不下（版本已被别的包占用）就嵌到**需要它的那个包**下面。

     node_modules/a            a@1.0.0
     node_modules/b            b@1.0.0
     node_modules/b/node_modules/a   a@2.0.0  ← b 要的版本和根不同

   根部（插件自己直接依赖）出现版本冲突时我们**报错而不是硬塞** ——
   那种情况很少见，装错版本比装不上更难查。
   ============================================================ */

import { maxSatisfying, satisfies } from './semver-lite.js';

/** 单个依赖图的上限：包数量、深度、总下载字节。 */
const LIMITS = {
  packages: 120,
  depth: 10,
  bytes: 60 * 1024 * 1024,
};

/** 这些字段里的依赖要装。peer 不装 —— 那是宿主提供的。 */
/**
 * 一个包的 package.json 里，哪些依赖要装。
 *
 * ============ 为什么 peerDependencies 也要装 ============
 *
 * 在桌面版里 peer 是「宿主会提供，你别自己装」。手机端不是完整 DSH 宿主 ——
 * 我们提供的是**自己实现的服务**，但插件代码里是这么写的：
 *
 *     import { defineTool } from "@deepseek-ai/dsh-tools";
 *     import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
 *
 * 这些是**运行时的 import**，包不在就 `Cannot find module`。
 * 实测 dsh-free-search 要手工塞 8 个包才能跑，其中 7 个来自 peer。
 *
 * 所以：`@deepseek-ai/*` 的 peer 照装，装失败只警告（有些包可能没公开，
 * 比如 dsh-host-webserver）；`react` / `react-dom` 不装 —— 那是界面用的，
 * 本机不渲染界面。
 *
 * ============ 为什么只装根包的 peer ============
 *
 * 依赖的 peer 也递归装的话会滚雪球：dsh-settings peer 了 cordis，
 * cordis 又 peer 一堆。真装下来比插件本身大十倍，而大部分用不到。
 * 第一层装够用即可，缺了会有明确的 Cannot find module。
 */
function wantedDeps(pkg, { includePeers = true } = {}) {
  const out = new Map();

  // 先放可选，再放必须的 —— 同一个包两边都写了，以「必须」为准
  for (const key of ['optionalDependencies', 'dependencies']) {
    const table = pkg && pkg[key];
    if (!table || typeof table !== 'object') continue;
    for (const [name, range] of Object.entries(table)) {
      if (!name) continue;
      out.set(name, { range: String(range || '*'), optional: key === 'optionalDependencies' });
    }
  }

  if (includePeers) {
    const peers = pkg && pkg.peerDependencies;
    if (peers && typeof peers === 'object') {
      for (const [name, range] of Object.entries(peers)) {
        if (!name || out.has(name)) continue;
        if (name.startsWith('@types/')) continue;
        // 界面相关的都不装：本机不渲染界面，装了纯粹占地方。
        // dsh-client-ui-* 是给 dsh web 宿主渲染的组件包，
        // 实测一个插件能把 zod、dsh-timeout、dsh-typert-protocol 一路带进来。
        if (/^(react|react-dom|preact|vue)$/i.test(name)) continue;
        if (name.startsWith('@deepseek-ai/dsh-client-')) continue;
        // 只装 DSH 同源的（那几个是 import 的真依赖）
        if (!name.startsWith('@deepseek-ai/')) continue;
        out.set(name, { range: String(range || '*'), optional: true });
      }
    }
  }

  return out;
}

/**
 * 站在 `fromDir` 这个包的位置，能不能解析到装在 `installedDir` 的那份。
 *
 * Node 的查找规则：从当前目录开始，逐级向上找 `node_modules/<name>`。
 * 所以只要 installedDir 恰好是这条链上的某一站，就说明能复用。
 *
 * @param {string} name 包名
 * @param {string} fromDir 发起解析的包目录（相对插件根，'' 表示插件自己）
 * @param {string} installedDir 已装副本的目录
 */
function canResolveFrom(name, fromDir, installedDir) {
  let cur = fromDir;
  for (let guard = 0; guard < 32; guard += 1) {
    const candidate = cur ? `${cur}/node_modules/${name}` : `node_modules/${name}`;
    if (candidate === installedDir) return true;
    if (!cur) return false;
    const idx = cur.lastIndexOf('/node_modules/');
    cur = idx >= 0 ? cur.slice(0, idx) : '';
  }
  return false;
}

/**
 * 一个版本要装的全部依赖（用于递归）。
 *
 * ============ 为什么递归时也带 peer ============
 *
 * 一开始我只装「根包的 peer」，理由是怕滚雪球。实测不行：
 * `@deepseek-ai/dsh-tools` 的 peer 里有 11 个 dsh-* 包，而它内部是
 * `import { ... } from "@deepseek-ai/dsh-scope"` —— 那是真 import，
 * 不装就 `Cannot find module`。
 *
 * 所以 peer 一律带上。滚雪球由 limits.packages 兜底，不是靠「不装」。
 */
function metaDeps(meta, version) {
  const v = meta && meta.versions && meta.versions[version];
  if (!v) return [];

  const out = [];
  const seen = new Set();

  for (const [name, range] of Object.entries(v.dependencies || {})) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, range: String(range || '*'), optional: false });
  }

  for (const [name, range] of Object.entries(v.peerDependencies || {})) {
    if (!name || seen.has(name)) continue;
    if (name.startsWith('@types/')) continue;
    if (/^(react|react-dom|preact|vue)$/i.test(name)) continue;
    if (name.startsWith('@deepseek-ai/dsh-client-')) continue;
    // 只带 DSH 同源的 peer：其它 peer 多半是「宿主装别的版本也行」，
    // 而这几类里 dsh-* 是真的被 import 的
    if (!name.startsWith('@deepseek-ai/')) continue;
    seen.add(name);
    out.push({ name, range: String(range || '*'), optional: true });
  }

  return out;
}

function tarballOf(meta, version) {
  const v = meta && meta.versions && meta.versions[version];
  return v && v.dist && v.dist.tarball ? String(v.dist.tarball) : '';
}

/**
 * 算出「要装哪些包、各装到哪」。
 *
 * 只做求解，不下载也不写盘 —— 这样它能脱离网络单测（注入 fetchJson 即可）。
 *
 * @param {object} opts
 *   opts.rootPkg     插件自己的 package.json
 *   opts.fetchJson   (url) => Promise<object>，拿 package 元数据
 *   opts.onProgress  (msg) => void
 * @returns {Promise<{packages:Array, warnings:string[]}>}
 *   packages: [{ name, version, dir, tarball }]
 *   dir 是**相对插件目录**的路径，如 `node_modules/a`
 */
export async function resolveDependencyTree(opts = {}) {
  const rootPkg = opts.rootPkg || {};
  const fetchJson = opts.fetchJson;
  if (typeof fetchJson !== 'function') throw new Error('resolveDependencyTree 需要一个 fetchJson');

  const say = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const limits = { ...LIMITS, ...(opts.limits || {}) };

  /** 根 node_modules 里已占用的 name → version。 */
  const flat = new Map();
  /** name → packument（同一次解析里只查一次）。 */
  const metas = new Map();
  /** 已排入计划的 `${dir}|${name}`，防重复。 */
  const placed = new Map();
  /** `name@version` → 它被装到哪（判断「能不能复用」）。 */
  const installed = new Map();

  const packages = [];
  const warnings = [];

  /** 队列项：{ name, range, parentDir, depth, optional } */
  const queue = [];
  for (const [name, info] of wantedDeps(rootPkg, { includePeers: true })) {
    queue.push({ name, range: info.range, parentDir: '', depth: 0, optional: info.optional });
  }

  async function getMeta(name) {
    if (metas.has(name)) return metas.get(name);
    say(`查依赖 ${name}…`);
    const url = `https://registry.npmmirror.com/${name}`;
    const meta = await fetchJson(url);
    if (!meta || typeof meta !== 'object') throw new Error(`${name} 的元数据不是对象`);
    metas.set(name, meta);
    return meta;
  }

  while (queue.length) {
    if (packages.length >= limits.packages) {
      throw new Error(
        `依赖太多了（超过 ${limits.packages} 个包）。这个插件可能引了一大片依赖树，手机端装不动。`
      );
    }

    const job = queue.shift();
    const { name, range, parentDir, depth, optional } = job;

    if (depth > limits.depth) {
      warnings.push(`依赖层级超过 ${limits.depth} 层，${name} 及其下游没有继续解析。`);
      continue;
    }

    // 同一个位置同一个包只放一次
    const slot = `${parentDir}|${name}`;
    if (placed.has(slot)) continue;

    // ============ 提升 ============
    //
    // 根 node_modules 里已有满足范围的版本 → 直接复用，不管是谁要的。
    // 不做这一步的话，每个父包都会嵌一份自己的 cosmokit / cordis ——
    // 实测一个插件解出 25 个包，其中 10 个是同一个包的重复副本。
    if (flat.has(name) && satisfies(flat.get(name), range)) {
      placed.set(slot, flat.get(name));
      continue;
    }

    let meta;
    try {
      meta = await getMeta(name);
    } catch (e) {
      if (optional) {
        warnings.push(`${name} 是可选依赖，查不到就跳过了。`);
        continue;
      }
      throw new Error(`查不到依赖 ${name}：${(e && e.message) || e}`);
    }

    const versions = Object.keys((meta && meta.versions) || {});
    let version = maxSatisfying(versions, range);

    // 范围是什么都接受、但表里一个都匹配不上时，退到 latest
    if (!version) {
      const latest = meta['dist-tags'] && meta['dist-tags'].latest;
      if (latest && satisfies(latest, range)) version = latest;
    }

    if (!version) {
      const msg = `${name} 没有满足「${range}」的版本`;
      if (optional) {
        warnings.push(`${msg}（可选依赖，已跳过）`);
        continue;
      }
      throw new Error(
        `${msg}。这个包可能已经下架，或者插件要求的版本不在 npm 上。`
      );
    }

    // ============ 循环依赖 ============
    //
    // A 依赖 B、B 又依赖 A 的情况在 npm 生态里真实存在。照 Node 的
    // 解析规则，只要**已有那份副本在解析路径上**就能复用，不必再装一份；
    // 不然会一路套娃到深度上限。
    const key = `${name}@${version}`;
    if (installed.has(key) && canResolveFrom(name, parentDir, installed.get(key))) {
      placed.set(slot, version);
      continue;
    }

    // 决定装到哪：根层空着就放根（提升），根层被不兼容版本占了才嵌
    let dir;
    if (!flat.has(name)) {
      flat.set(name, version);
      dir = `node_modules/${name}`;
    } else if (parentDir) {
      dir = `${parentDir}/node_modules/${name}`;
    } else {
      // 插件自己直接要的包，根层已被另一个不兼容版本占住
      throw new Error(
        `插件同时要求 ${name} 的两个不兼容版本（已有 ${flat.get(name)}，又要 ${range}）。` +
          '这种情况手机端不支持，需要插件作者把它统一成一个版本。'
      );
    }

    placed.set(slot, version);
    installed.set(key, dir);

    const tarball = tarballOf(meta, version);
    if (!tarball) {
      if (optional) {
        warnings.push(`${name}@${version} 没有下载地址（可选依赖，已跳过）`);
        continue;
      }
      throw new Error(`${name}@${version} 没有 tarball 地址`);
    }

    packages.push({ name, version, dir, tarball, optional });

    // 递归它的依赖（含 peer —— 那些是真 import）
    for (const dep of metaDeps(meta, version)) {
      queue.push({
        name: dep.name,
        range: dep.range,
        parentDir: dir,
        depth: depth + 1,
        optional: dep.optional,
      });
    }
  }

  return { packages, warnings };
}

/**
 * 执行安装：下载、解包、写进 node_modules。
 *
 * @param {object} opts
 *   opts.id          插件 id（只用来写进度文案）
 *   opts.plan        resolveDependencyTree 的结果
 *   opts.fetchBytes  (url) => Promise<{bytes}>
 *   opts.unpack      (bytes) => Promise<[{path, bytes}]>，默认用 plugin-install-node 的解包器
 *   opts.writeFile   (relPath, bytes) => Promise<void>，relPath 相对插件目录
 *   opts.onProgress  (msg, done, total) => void
 *   opts.cache       { get(name, version) => bytes|null, put(name, version, bytes) => void }
 *                    按 name@version 缓存原始 tarball —— 同一个包装第二个插件时不再下载
 * @returns {Promise<{files:number, bytes:number, cached:number, downloaded:number, warnings:string[]}>}
 */
export async function installDependencyTree(opts = {}) {
  const plan = opts.plan || { packages: [], warnings: [] };
  const say = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const fetchBytes = opts.fetchBytes;
  const writeFile = opts.writeFile;
  const unpack = opts.unpack;
  const limits = { ...LIMITS, ...(opts.limits || {}) };

  if (typeof fetchBytes !== 'function') throw new Error('installDependencyTree 需要 fetchBytes');
  if (typeof writeFile !== 'function') throw new Error('installDependencyTree 需要 writeFile');
  if (typeof unpack !== 'function') throw new Error('installDependencyTree 需要 unpack');

  const cache = opts.cache || null;
  const warnings = Array.isArray(plan.warnings) ? [...plan.warnings] : [];
  let files = 0;
  let bytes = 0;
  let cached = 0;

  for (let i = 0; i < plan.packages.length; i += 1) {
    const p = plan.packages[i];
    const label = `${p.name}@${p.version}`;

    // ============ 先看缓存 ============
    //
    // 缓存的是**原始 tarball**，不是解包后的文件：命中时只需读一个文件，
    // 而读解包结果要 list + 逐文件读，一个包三十个文件就是六十次原生调用 ——
    // 59 个包会变成几千次，比重新下载还慢。
    let data = null;
    if (cache && typeof cache.get === 'function') {
      try {
        data = await cache.get(p.name, p.version);
      } catch {
        data = null;
      }
    }

    if (data && data.length) {
      cached += 1;
      say(`用缓存 ${label}（${i + 1}/${plan.packages.length}）`, i + 1, plan.packages.length);
    } else {
      // 传 i+1：正在下第 1 个时进度条就该有动静，而不是停在 0%
      say(`下载 ${label}（${i + 1}/${plan.packages.length}）`, i + 1, plan.packages.length);

      let got;
      try {
        got = await fetchBytes(p.tarball);
      } catch (e) {
        if (p.optional) {
          warnings.push(`${label} 下载失败，作为可选依赖跳过。`);
          continue;
        }
        throw new Error(`下载 ${label} 失败：${(e && e.message) || e}`);
      }

      data = got && got.bytes ? got.bytes : got;
      if (!data || !data.length) {
        if (p.optional) {
          warnings.push(`${label} 下载到空内容，作为可选依赖跳过。`);
          continue;
        }
        throw new Error(`${label} 下载到空内容`);
      }

      if (cache && typeof cache.put === 'function') {
        try {
          await cache.put(p.name, p.version, data);
        } catch {
          // 缓存写不进去不影响这次安装
        }
      }
    }

    bytes += data.length;
    if (bytes > limits.bytes) {
      throw new Error(
        `依赖太大（超过 ${Math.round(limits.bytes / 1024 / 1024)} MB），手机端装不动。`
      );
    }

    let entries;
    try {
      entries = await unpack(data);
    } catch (e) {
      if (p.optional) {
        warnings.push(`${p.name}@${p.version} 解不开，作为可选依赖跳过。`);
        continue;
      }
      throw new Error(`${p.name}@${p.version} 解不开：${(e && e.message) || e}`);
    }

    // tarball 里统一是 package/ 开头，剥掉
    for (const entry of entries) {
      const rel = String(entry.path || '')
        .replace(/\\/g, '/')
        .replace(/^package\//, '');
      if (!rel || rel.endsWith('/')) continue;
      // 不装这些：体积大且没用（文档/测试/类型声明保留，类型声明很小但插件可能读）
      if (/^(\.git|\.github|test|tests|__tests__)\//.test(rel)) continue;

      try {
        await writeFile(`${p.dir}/${rel}`, entry.bytes);
        files += 1;
      } catch (e) {
        throw new Error(`写入 ${p.dir}/${rel} 失败：${(e && e.message) || e}`);
      }
    }
  }

  say(
    `依赖装好了：${plan.packages.length} 个包、${files} 个文件${
      cached ? `（${cached} 个来自缓存）` : ""
    }`,
    plan.packages.length,
    plan.packages.length
  );
  return { files, bytes, cached, downloaded: plan.packages.length - cached, warnings };
}
