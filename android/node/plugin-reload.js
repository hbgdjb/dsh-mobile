'use strict';

/**
 * Node 插件热重载。
 *
 * ============ 为什么要有这个文件 ============
 *
 * 插件的代码就放在工作区里：`<workspace>/plugins/<id>/`。
 * 改完代码不用重启应用，换上新代码继续用 —— 这是热重载的全部意义。
 *
 * ============ 为什么不用上游的 loader / hmr 插件 ============
 *
 * `@deepseek-ai/cordis-plugin-loader` peer 依赖 `node-addon-require-builtin`
 * —— 那是个需要编译的原生 addon。手机端的 npm 安装明确「不编译原生模块」，
 * 装上必然跑不起来。
 *
 * `@deepseek-ai/cordis-plugin-hmr` 依赖 chokidar，同样有原生依赖问题。
 *
 * 所以这一块自己写。写下来才发现真正难的只有一件事：**模块缓存**。
 *
 * ============ 模块缓存这件事 ============
 *
 * Node 加载一个模块后会把它缓存起来，第二次加载拿到的是同一个对象。
 * 不破缓存，重载就是假重载 —— 代码改了，但跑的还是旧的。
 *
 * 两套模块系统，两套破法：
 *
 *   CJS（CommonJS）
 *     `delete require.cache[path]` 就能破。子模块是逐文件各自缓存的，
 *     一起删掉即可。
 *
 *   ESM（ES Module）
 *     `delete require.cache[path]` **没有用** —— ESM 的缓存在模块加载器内部，
 *     不在 require.cache 里。
 *     入口加 `?v=<代际>` 查询串能破入口，但**子模块不会跟着破**：
 *     子模块的 URL 由解析器算出来，不带那个查询串。
 *     要让子模块也跟着换，得用 `module.registerHooks`（Node ≥ 22.15）
 *     在解析阶段把代际参数注入包内的相对依赖。
 *
 * 真机 libnode 是 22.23.2，`registerHooks` 可用。
 * 但本机 CI 是 22.13.1，没有 —— 所以这里做了能力探测，
 * **没有就如实说不行，不假装成功**。
 *
 * ============ 为什么不清 node_modules ============
 *
 * 依赖是安装期打好的固定版本，插件改代码极少同时改依赖。
 * 更重要的是：重新求值依赖会重建单例（http agent、DB client、SDK 全局状态），
 * 让插件行为漂移；而且手机端这些包体积大、构造慢。
 * 清理范围一旦越过 node_modules 边界，跨插件共享的依赖会被连带清掉。
 *
 * 所以清理只覆盖插件**自己写的那些文件**。
 */

const fs = require('fs');
const path = require('path');
const moduleApi = require('module');
const { pathToFileURL, fileURLToPath } = require('url');

/**
 * 真机 libnode 22.23.2 有 registerHooks；本机 CI 22.13.1 没有。
 * @type {boolean}
 */
const HAS_REGISTER_HOOKS = typeof moduleApi.registerHooks === 'function';

/** 代际参数名。进 URL，会出现在 import.meta.url 里。 */
const GEN_PARAM = 'dsh-reload';

/** 插件目录 → 当前代际串。 */
const generations = new Map();

/** resolve 钩子只装一次（装多次会叠加，反而互相干扰）。 */
let hooksInstalled = false;

/* ---------------- 小工具 ---------------- */

/** file:// URL → 绝对路径。 */
function fileOf(url) {
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/** 绝对路径 → 它所在的目录（带尾分隔符，便于前缀比较）。 */
function dirOf(filePath) {
  if (!filePath) return '';
  return path.resolve(path.dirname(filePath)) + path.sep;
}

/**
 * 判断一个插件是 ESM 还是 CJS。
 *
 * ============ 为什么不能用「require 失败就是 ESM」 ============
 *
 * Node 22.12 起 `require()` 已经能加载 ESM 了 —— 它会成功，
 * 返回一个带 `Symbol.toStringTag === 'Module'` 的命名空间对象。
 * 用「require 成败」判形态，ESM 插件会被误判成 CJS，
 * 于是走 `require.cache` 清理路径 —— 而那条路对 ESM **完全无效**，
 * 结果是「显示重载成功，代码根本没换」。这种假成功比直接报错难查得多。
 *
 * 所以这里只认三个硬事实：扩展名、package.json 的 type 字段、
 * 以及实际加载结果的 toStringTag。
 *
 * @param {string} entry 入口文件绝对路径
 * @param {string} dir 插件目录
 * @returns {'esm'|'cjs'}
 */
function detectModuleKind(entry, dir) {
  if (/\.mjs$/i.test(entry)) return 'esm';
  if (/\.cjs$/i.test(entry)) return 'cjs';
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    /* 没有或坏了的 package.json —— 下面按 CJS 处理 */
  }
  return pkg && pkg.type === 'module' ? 'esm' : 'cjs';
}

/**
 * 用加载结果交叉验证形态。
 *
 * require 一个 ESM 文件会成功，但返回值带 Module 标记 ——
 * 那是判定 ESM 最可靠的证据。
 *
 * @param {object} mod 加载结果
 * @param {'esm'|'cjs'} guessed 静态判定
 * @returns {'esm'|'cjs'}
 */
function refineModuleKind(mod, guessed) {
  try {
    if (mod && mod[Symbol.toStringTag] === 'Module') return 'esm';
  } catch {
    /* 取不到标记就用静态判定 */
  }
  return guessed;
}

/* ---------------- CJS 缓存清理 ---------------- */

/**
 * 清掉插件自己写的那些文件的 CJS 缓存。
 *
 * 显式排除 node_modules —— 理由见文件头的说明。
 *
 * @param {string} dir 插件目录
 * @returns {string[]} 被清掉的文件
 */
function purgeCjsCache(dir) {
  const prefix = path.resolve(dir) + path.sep;
  const nmSeg = path.sep + 'node_modules' + path.sep;
  const removed = [];
  for (const key of Object.keys(require.cache)) {
    if (!key.startsWith(prefix)) continue;
    if (key.includes(nmSeg)) continue;
    delete require.cache[key];
    removed.push(key);
  }
  return removed;
}

/* ---------------- ESM 缓存清理 ---------------- */

/**
 * 装上「代际注入」钩子。
 *
 * 钩子的作用：解析包内相对依赖时，把当前代际串加到 URL 上。
 * 这样入口和它的子模块会落在**不同**的缓存键上，重新求值。
 *
 * 只对「父文件在被重载的插件目录里」的解析生效 ——
 * 别的插件、以及插件依赖的第三方包，都不受影响。
 *
 * @returns {boolean} 是否装上了
 */
function installFreshHook() {
  if (!HAS_REGISTER_HOOKS || hooksInstalled) return false;
  moduleApi.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (!context.parentURL || !resolved.url || !resolved.url.startsWith('file:')) return resolved;
      const parentPath = fileOf(context.parentURL);
      if (!parentPath) return resolved;
      const gen = generations.get(dirOf(parentPath));
      if (!gen) return resolved;
      const resolvedPath = fileOf(resolved.url);
      if (!resolvedPath) return resolved;
      // 只处理「同一个插件目录内」的相对依赖
      if (!resolvedPath.startsWith(dirOf(parentPath))) return resolved;
      const target = new URL(resolved.url);
      target.searchParams.set(GEN_PARAM, gen);
      return Object.assign({}, resolved, { url: target.href });
    },
  });
  hooksInstalled = true;
  return true;
}

/**
 * 给某个插件目录开一个新代际。
 *
 * @param {string} dir 插件目录
 * @returns {{gen:string, hooked:boolean}}
 */
function newGeneration(dir) {
  const gen = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  generations.set(path.resolve(dir) + path.sep, gen);
  const hooked = installFreshHook();
  return { gen, hooked };
}

/**
 * 入口 URL（ESM 走它，带上代际参数）。
 *
 * @param {string} entry 入口绝对路径
 * @param {string} gen 代际串
 * @returns {string}
 */
function entryUrlWithGeneration(entry, gen) {
  const url = pathToFileURL(entry);
  url.searchParams.set(GEN_PARAM, gen);
  return url.href;
}

/* ---------------- 对外接口 ---------------- */

module.exports = {
  /** 当前运行时是否支持完整的 ESM 热重载。 */
  supportsEsmReload: HAS_REGISTER_HOOKS,

  detectModuleKind,
  refineModuleKind,
  purgeCjsCache,
  installFreshHook,
  newGeneration,
  entryUrlWithGeneration,

  /**
   * 加载模块，按指定形态走对应路径。
   *
   * CJS 走 require（清缓存后就是新的）。
   * ESM 走 import + 代际参数（需要 registerHooks 才能连带破子模块）。
   *
   * @param {string} entry 入口绝对路径
   * @param {'esm'|'cjs'} kind 模块形态
   * @param {string} [gen] ESM 代际串
   * @returns {Promise<object>} 模块导出
   */
  async loadFresh(entry, kind, gen) {
    if (kind === 'esm') {
      const href = gen ? entryUrlWithGeneration(entry, gen) : pathToFileURL(entry).href;
      return await import(href);
    }
    // CJS：require 会命中刚清过的缓存之外的新副本
    return require(entry);
  },
};
