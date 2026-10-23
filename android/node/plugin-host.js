'use strict';

/**
 * Node 侧的插件宿主。
 *
 * ============ 它做什么 ============
 *
 * 1. 扫描插件目录，把每个插件加载起来（require 进来）；
 * 2. 按 cordis 约定调它的 apply(ctx)，注入宿主提供的服务；
 * 3. 插件注册的工具（ctx.tools.registerTool）转发给 WebView，
 *    这样 AI 助手在页面上就能看见并调用这些工具。
 *
 * ============ 插件从哪来 ============
 *
 * 页面的插件安装流程（plugin-install.js）把代码写到工作区：
 *
 *     <workspace>/plugins/<id>/main.js
 *
 * Node 和 WebView 在同一个应用里，**读的是同一个文件系统**，
 * 所以 Node 直接读那个目录就行 —— 不需要再传一遍代码，
 * 也就不需要在两边各维护一份格式。
 *
 * 插件有两种形态，都支持：
 *   · 单文件：<id>/main.js
 *   · npm 包：<id>/package.json（有 main 字段）+ 可选 node_modules/
 *     这种能真的用上 node:fs / node:http / 第三方依赖 —— 是 DSH 桌面版插件
 *     的原生形态。
 *
 * ============ 加载失败怎么办 ============
 *
 * 一个插件坏了不能拖垮其它的。所以每个插件独立成败，
 * 失败原因记下来能在设置页看到。
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const reload = require('./plugin-reload.js');

/** 插件目录名（相对工作区根）。 */
const PLUGIN_DIR = 'plugins';

/**
 * 解析 npm 包的入口文件。
 *
 * ============ 为什么不能只看 main ============
 *
 * 现代包爱用 `exports` 字段，而且常常**只写 exports 不写 main**：
 *
 *     "exports": { ".": { "import": "./lib/index.mjs" } }
 *
 * 这种包如果只按 `pkg.main` 找入口，就会「明明装了却显示 not-loaded」——
 * 这是最难查的那一类问题：包在、目录在、就是找不到入口。
 *
 * 所以 `exports` 的 "." 项优先于 `main`。
 *
 * @param {object} pkg package.json 内容
 * @returns {string} 相对入口路径；找不到返回空串
 */
function resolvePackageEntry(pkg) {
  const ex = pkg && pkg.exports;
  if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
    const dot = ex['.'];
    const pick = (v) => {
      if (typeof v === 'string') return v;
      if (!v || typeof v !== 'object') return '';
      // 条件导出：按 require → import → default 的顺序取
      return pick(v.require) || pick(v.import) || pick(v.default) || pick(v.node) || '';
    };
    const fromExports = pick(dot);
    if (fromExports) return fromExports.replace(/^\.\//, '');
  }
  if (typeof ex === 'string') return ex.replace(/^\.\//, '');
  if (pkg && typeof pkg.main === 'string' && pkg.main) return pkg.main;
  return 'index.js';
}

/**
 * 列出可加载的插件。
 *
 * @param {string} workspace 工作区根目录
 * @returns {Array<{id:string, dir:string, entry:string, kind:string}>}
 */
function listPlugins(workspace) {
  const base = path.join(workspace, PLUGIN_DIR);
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch (e) {
    return out;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = path.join(base, name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch (e) {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // 形态一：npm 包（有 package.json）
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const main = resolvePackageEntry(pkg);
        const entry = main ? path.join(dir, main) : '';
        if (entry && fs.existsSync(entry)) {
          out.push({
            id: pkg.id || pkg.name || name,
            name: pkg.name || name,
            version: pkg.version || '0.0.0',
            dir,
            entry,
            kind: 'package',
            inject: Array.isArray(pkg.dsh && pkg.dsh.inject) ? pkg.dsh.inject : null,
            declaredInject: pkg.inject || null,
          });
          continue;
        }
      } catch (e) {
        // package.json 坏了就当普通目录处理
      }
    }

    // 形态二：单文件
    for (const candidate of ['main.js', 'index.js', 'plugin.js']) {
      const entry = path.join(dir, candidate);
      if (fs.existsSync(entry)) {
        out.push({
          id: name,
          name: name,
          version: '0.0.0',
          dir,
          entry,
          kind: 'script',
          inject: null,
          declaredInject: null,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * 加载单个插件模块，取出它的 apply 与 inject。
 *
 * 插件可能是 ESM（`export function apply`）也可能是 CJS（`module.exports`）。
 * 两种都要试。
 *
 * ============ 顺带判定模块形态 ============
 *
 * 热重载要知道这个插件是 ESM 还是 CJS —— 两者的缓存破法完全不同。
 * 而判定**不能**靠「require 失败就是 ESM」：
 * Node 22.12 起 `require()` 已经能加载 ESM 了，它会成功，
 * 返回一个带 `Symbol.toStringTag === 'Module'` 的命名空间。
 * 照旧逻辑走，ESM 插件会被当成 CJS，
 * 于是清 `require.cache` —— 而那条路对 ESM 完全无效，
 * 结果是「显示重载成功，代码根本没换」。这种假成功比直接报错难查得多。
 *
 * 所以用 toStringTag 交叉验证（见 plugin-reload.js 的 refineModuleKind）。
 *
 * @returns {Promise<{apply:Function, inject?:string[], moduleKind:'esm'|'cjs'}>}
 */
async function loadModule(entry) {
  const guessed = reload.detectModuleKind(entry, path.dirname(entry));
  // 先试 CJS
  try {
    const mod = require(entry);
    const kind = reload.refineModuleKind(mod, guessed);
    return Object.assign(normalize(mod), { moduleKind: kind });
  } catch (e) {
    const err = String((e && e.message) || e);
    // ERR_REQUIRE_ESM 之类才需要换 ESM 试法；语法错误是插件自身的问题，
    // 但 ESM 解析同样会报语法错，所以两种都试一遍，取先成功的。
    try {
      const mod = await import(pathToFileURL(entry).href);
      return Object.assign(normalize(mod), { moduleKind: 'esm' });
    } catch (e2) {
      throw new Error(
        `加载失败：${err}${e2 && e2.message ? ` / ESM：${e2.message}` : ''}`
      );
    }
  }
}

/** 把模块导出整理成 { apply, inject }。 */
function normalize(mod) {
  if (!mod) throw new Error('模块没有导出任何东西');
  let apply = null;
  let inject = null;

  if (typeof mod.apply === 'function') {
    apply = mod.apply;
    inject = mod.inject;
  } else if (mod.default && typeof mod.default.apply === 'function') {
    apply = mod.default.apply;
    inject = mod.default.inject || mod.inject;
  } else if (typeof mod === 'function') {
    // 直接导出函数：当作 apply
    apply = mod;
  }

  if (!apply) throw new Error('模块没有导出 apply 函数');
  return { apply, inject: Array.isArray(inject) ? inject : null };
}

/**
 * 插件宿主。
 *
 * @param {object} opts
 *   opts.workspace  工作区根目录
 *   opts.container  cordis 迷你容器
 *   opts.onTools    工具注册变化时回调（转发给 WebView）
 *   opts.log        日志函数
 */
function createHost(opts) {
  const workspace = opts.workspace;
  const container = opts.container;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const onTools = typeof opts.onTools === 'function' ? opts.onTools : () => {};

  /** 已加载的插件：id → { meta, plugin, disposer, moduleKind, ... } */
  const loaded = new Map();
  /**
   * 加载失败的插件：id → { error, at }。
   *
   * ============ 为什么单独一张表 ============
   *
   * `loaded` 的语义是「有 fiber、有 disposer」—— 也就是能卸载、能重载。
   * 失败的插件根本没有 fiber，硬塞进 `loaded` 会让
   * `loadedCount` / `pendingCount` / `unloadAll` 全部算错
   * （卸载时会对一个不存在的 fiber 调 disposer）。
   *
   * 之前失败信息只存在于 `loadAll()` 的返回值里，函数一返回就没了 ——
   * 于是 `listStatus()` 里那个 'failed' 分支是**永远走不到的死代码**，
   * 界面只能显示 'not-loaded'，用户看不出到底是哪一步出的问题。
   */
  const failures = new Map();
  /** 工具表：name → { name, description, parameters, pluginId } */
  const tools = new Map();

  /** 根上下文：用来拿「现在是谁在 apply」。 */
  const rootCtx = container && container.root ? container.root : null;

  /**
   * 当前正在 apply 的插件 id（没有就是宿主自己）。
   *
   * 工具注册时用它记归属 —— 插件自己通常不填 pluginId。
   */
  function currentOwner() {
    try {
      const scope = rootCtx && typeof rootCtx.currentScope === 'function' ? rootCtx.currentScope() : null;
      return scope && scope.pluginId ? String(scope.pluginId) : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 给插件用的工具注册服务。
   *
   * 插件注册的工具会出现在 AI 助手的工具表里 —— 这是插件生态的落点：
   * 装一个插件，AI 就多一批能力。
   *
   * ============ 为什么工具表归这里管 ============
   *
   * 工具的**执行**必须在插件宿主手里：handler 是插件的闭包，
   * 只有加载了插件的进程才能调它。工具表是 handler 的索引，
   * 所以表和 handler 必须放在一起，不能拆到别处去 ——
   * 拆开就会出现「表里有、但没人能执行」的工具。
   */
  const toolsService = {
    registerTool(def, handler) {
      if (!def || !def.name) throw new Error('registerTool 需要 name');
      const fn = handler || def.handler;
      if (typeof fn !== 'function') throw new Error('registerTool 需要 handler 函数');
      const owner = String(def.pluginId || '') || currentOwner();
      tools.set(def.name, {
        name: def.name,
        description: def.description || '',
        parameters: def.parameters || { type: 'object', properties: {} },
        pluginId: owner,
        pluginName: def.pluginName || '',
        handler: fn,
      });
      // ============ 工具跟着插件的生命周期走 ============
      //
      // 插件被卸载（或被热重载替换）时，它注册的工具必须消失 ——
      // 否则工具表里留着旧 handler：模型会调到已经被换掉的旧代码，
      // 而且那个闭包引用的模块已经被清缓存了，行为不可预期。
      //
      // 挂到 scope 的 onDispose 上，插件卸载时自动清理。
      try {
        const scope = rootCtx && typeof rootCtx.currentScope === 'function' ? rootCtx.currentScope() : null;
        if (scope && typeof scope.onDispose === 'function') {
          scope.onDispose(() => {
            tools.delete(def.name);
          });
        }
      } catch (e) {
        /* 拿不到 scope 就靠 dropToolsOf 兜底 */
      }
      log('info', `插件注册工具：${def.name}`);
      onTools(listTools());
      return true;
    },
    unregisterTool(name) {
      if (tools.delete(name)) onTools(listTools());
      return true;
    },
    list() {
      return listTools();
    },
  };

  // 工具服务由本宿主独占提供 —— 插件拿到的 ctx.tools 一定是这一份，
  // 注册进去的 handler 一定能被执行到。
  container.provide('tools', toolsService);

  /**
   * 只加载「还没加载过」的插件。
   *
   * ============ 为什么需要它 ============
   *
   * 装完一个插件后要让它跑起来 —— 但不能再跑一遍 plugins.load：
   * 那会把**已经加载好的插件**也再 apply 一遍，于是同一个插件有两个实例
   * 同时在跑，而且宿主服务的注册会撞车（settings.register 抛
   * 「命名空间已经被注册过了」）。
   *
   * 所以装完只加载新来的那些，已在跑的绝不动。
   *
   * @returns {Promise<{loaded:number, failed:Array<{id:string,error:string}>}>}
   */
  async function loadNew() {
    const metas = listPlugins(workspace);
    const fresh = metas.filter((m) => !loaded.has(m.id));
    if (!fresh.length) return { loaded: 0, failed: [] };
    return await loadAll(fresh);
  }

  /**
   * 载入全部插件。
   *
   * @param {Array<object>} [only] 只加载这些插件（不给就是全部）
   * @returns {Promise<{loaded:number, failed:Array<{id:string,error:string}>}>}
   */
  async function loadAll(only) {
    let metas = listPlugins(workspace);
    if (Array.isArray(only)) {
      const want = new Set(only.map((m) => m.id));
      metas = metas.filter((m) => want.has(m.id));
    }
    const failed = [];
    let count = 0;

    for (const meta of metas) {
      try {
        const mod = await loadModule(meta.entry);
        // inject 优先用插件自己导出的，其次用清单里声明的
        const inject = mod.inject || meta.inject || meta.declaredInject;
        const plugin = {
          id: meta.id,
          name: meta.name,
          version: meta.version,
          apply: mod.apply,
          inject,
        };
        const res = container.apply(plugin);
        if (!res.ok) {
          failed.push({ id: meta.id, error: res.error });
          failures.set(meta.id, { error: String(res.error), at: Date.now() });
          log('error', `插件 ${meta.id} 加载失败：${res.error}`);
          continue;
        }
        // ============ 依赖未齐 → 插件挂起 ============
        //
        // cordis 的语义：插件声明的 inject 服务没全部就绪时，
        // fiber 停在 PENDING，apply 根本不执行（src/fiber.ts 第 314-318 行）。
        //
        // 手机端也一样 —— 不假装加载成功。服务到齐后容器会自动启动它。
        // 这里把它记进 loaded，这样：
        //   · 卸载时能一并取消（不能让它在卸载后又冒出来）
        //   · 设置页能看出「这个插件在等什么」
        if (res.pending) {
          loaded.set(meta.id, {
            meta,
            plugin,
            disposer: res.disposer,
            pending: true,
            pendingDeps: Array.isArray(inject) ? inject : [],
            // 挂起句柄：服务到齐后容器会把它翻成 started，
            // 宿主靠这个句柄判断「后来到底启动没有」——
            // 否则设置页会一直显示「在等依赖」，哪怕插件早就跑起来了。
            handle: res.handle || null,
            moduleKind: mod.moduleKind,
            entryUrl: meta.entry,
          });
          log(
            'info',
            `插件 ${meta.id} 挂起：等待 ${(Array.isArray(inject) ? inject : []).join('、')}`
          );
          continue;
        }
        loaded.set(meta.id, {
          meta,
          plugin,
          disposer: res.disposer,
          pending: false,
          moduleKind: mod.moduleKind,
          entryUrl: meta.entry,
        });
        failures.delete(meta.id);
        count += 1;
      } catch (e) {
        const err = String((e && e.message) || e);
        failed.push({ id: meta.id, error: err });
        failures.set(meta.id, { error: err, at: Date.now() });
        log('error', `插件 ${meta.id} 加载失败：${err}`);
      }
    }

    return { loaded: count, failed };
  }

  /** 卸载全部插件。 */
  function unloadAll() {
    for (const [, rt] of loaded) {
      if (typeof rt.disposer === 'function') {
        try {
          rt.disposer();
        } catch (e) {
          log('warn', `卸载 ${rt.meta.id} 时出错：${e && e.message}`);
        }
      }
    }
    loaded.clear();
    tools.clear();
    onTools([]);
  }

  /** 当前工具表（不含 handler）。 */
  function listTools() {
    return Array.from(tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      pluginId: t.pluginId,
      pluginName: t.pluginName,
    }));
  }

  /**
 * 当前正在被调用的工具属于哪个插件。
 *
 * ============ 为什么需要它 ============
 *
 * `ctx.currentScope()` 只在 apply 期间有效（那是 cordis-lite 的
 * 「活动作用域」）。而工具的 handler 是在 apply **之后**被调用的 ——
 * 此刻 currentScope() 返回 null，谁在调用就不知道了。
 *
 * 而 `ctx.hmr.reloadSelf()` 恰恰是在 handler 里调的：
 * 它必须知道「现在是谁在调我」才能重载正确的插件。
 *
 * 所以这里在 callTool 期间记一下工具的归属。
 */
let currentCaller = '';

/** 当前调用者的插件 id（不在工具调用里就是空串）。 */
function callerId() {
  return currentCaller;
}

  /** 调用一个插件工具。 */
  async function callTool(name, args) {
    const t = tools.get(name);
    if (!t) throw new Error('没有这个工具：' + name);
    const prev = currentCaller;
    currentCaller = t.pluginId || '';
    try {
      const result = await t.handler(args || {});
      return result === undefined ? null : result;
    } finally {
      currentCaller = prev;
    }
  }

  /* ---------------- 热重载 ---------------- */

  /**
   * 删掉某个插件注册的工具。
   *
   * 单插件重载时**不能** tools.clear() —— 那是全清，
   * 会把别的插件正在提供的工具也抹掉。工具表是所有插件共享的一张表。
   *
   * @param {string} pluginId 插件 id
   */
  function dropToolsOf(pluginId) {
    for (const [name, t] of Array.from(tools.entries())) {
      if (t.pluginId === pluginId) tools.delete(name);
    }
  }

  /**
   * 重载串行化。
   *
   * ============ 为什么必须串行 ============
   *
   * cordis-lite 的活动作用域（activeScope）是**全局单例**：
   * apply 期间它指向当前插件的 scope。
   * 两个 apply 一旦交错，工具、llm adapter 的归属就会串 ——
   * A 插件注册的工具会被记到 B 插件名下。
   *
   * 所以所有重载排成一条链，一个个来。
   */
  let reloadChain = Promise.resolve();

  /**
   * 真正执行一次重载（不排队）。
   *
   * @param {object} rt 旧的运行时记录
   * @returns {Promise<object>} {ok, mode, error?, restored?}
   */
  async function doReload(rt) {
    const id = rt.meta.id;
    const dir = rt.meta.dir;
    const kind = rt.moduleKind || reload.detectModuleKind(rt.entryUrl || rt.meta.entry, dir);

    // ---- ESM 的能力门槛 ----
    //
    // 破 ESM 子模块缓存必须有 registerHooks。没有它，
    // 只能换入口、换不了子模块 —— 那会出现「界面更新了、逻辑没更新」
    // 的半吊子状态，比明确失败更糟。
    if (kind === 'esm' && !reload.supportsEsmReload) {
      return {
        ok: false,
        degraded: true,
        restored: true,
        mode: 'esm-unsupported',
        error:
          '当前 Node 不支持 module.registerHooks（需 ≥22.15），无法热重载 ESM 插件：' +
          '入口能换、子模块换不了。旧版本仍在运行。',
      };
    }

    // ---- 1. 先卸载旧 fiber ----
    //
    // 顺序不能反。宿主服务（settings / web / commands）的注册都挂在
    // scope 的 onDispose 上，旧实例不先释放就重新 apply，
    // settings.register 会直接抛「命名空间已经被注册过了」。
    if (typeof rt.disposer === 'function') {
      try {
        rt.disposer();
      } catch (e) {
        log('warn', `重载 ${id} 时卸载旧版本出错：${e && e.message}`);
      }
    }
    dropToolsOf(id);

    // ---- 2. 破缓存 ----
    let mode = 'cjs';
    let gen = '';
    if (kind === 'esm') {
      const g = reload.newGeneration(dir);
      gen = g.gen;
      mode = 'esm-full';
    } else {
      const removed = reload.purgeCjsCache(dir);
      log('info', `重载 ${id}：清理 ${removed.length} 个模块缓存`);
    }

    // ---- 3. 重新加载 + apply ----
    let mod = null;
    let res = null;
    try {
      mod = await reload.loadFresh(rt.entryUrl || rt.meta.entry, kind, gen);
      const normalised = normalize(mod);
      const inject = normalised.inject || rt.plugin.inject || rt.meta.inject || rt.meta.declaredInject;
      const plugin = Object.assign({}, rt.plugin, {
        apply: normalised.apply,
        inject,
      });
      res = container.apply(plugin);
      if (!res.ok) throw new Error(res.error || 'apply 失败');
      if (res.pending) {
        // 依赖没齐 —— 和首次加载一样，插件挂在 PENDING。
        // 这不是失败，但也不能当「active」上报，否则界面会说它在跑。
        loaded.set(id, {
          meta: rt.meta,
          plugin,
          disposer: res.disposer,
          pending: true,
          pendingDeps: Array.isArray(inject) ? inject : [],
          handle: res.handle || null,
          moduleKind: kind,
          entryUrl: rt.entryUrl || rt.meta.entry,
          reloadedAt: Date.now(),
        });
        failures.delete(id);
        return { ok: true, mode: mode + '-pending' };
      }
    } catch (e) {
      const err = String((e && e.message) || e);
      // ---- 4. 回滚：把旧代码重新起起来 ----
      //
      // 旧 apply 函数还活着（闭包还在内存里），重新 apply 一下就能恢复。
      // 用户改坏代码不该导致插件彻底消失。
      let restored = false;
      try {
        const rb = container.apply(rt.plugin);
        if (rb && rb.ok) {
          loaded.set(id, Object.assign({}, rt, { disposer: rb.disposer }));
          restored = true;
        }
      } catch (e2) {
        log('error', `重载 ${id} 失败且回滚也失败：${e2 && e2.message}`);
      }
      if (!restored) {
        failures.set(id, { error: err, at: Date.now() });
      } else {
        failures.delete(id);
      }
      log('error', `重载 ${id} 失败：${err}${restored ? '（已回滚到旧版本）' : '（回滚也失败）'}`);
      return { ok: false, error: err, restored, mode };
    }

    // ---- 5. 成功：更新记录 ----
    loaded.set(id, {
      meta: rt.meta,
      plugin: Object.assign({}, rt.plugin, { apply: mod.apply }),
      disposer: res.disposer,
      pending: false,
      moduleKind: kind,
      entryUrl: rt.entryUrl || rt.meta.entry,
      reloadedAt: Date.now(),
    });
    failures.delete(id);
    log('info', `重载 ${id} 完成（${mode}）`);
    return { ok: true, mode };
  }

  /**
   * 重载一个插件。
   *
   * @param {string} id 插件 id
   * @returns {Promise<object>} {ok, mode, error?, restored?, degraded?}
   */
  function reloadOne(id) {
    const run = reloadChain.then(async () => {
      const rt = loaded.get(id);
      if (!rt) {
        // 没在跑 —— 那就是首次加载
        const r = await loadAll();
        const ok = !r.failed.some((f) => f.id === id);
        return {
          ok,
          mode: 'fresh-load',
          error: ok ? '' : (r.failed.find((f) => f.id === id) || {}).error || '加载失败',
          restored: false,
        };
      }
      return await doReload(rt);
    });
    reloadChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /**
   * 重载全部插件。
   *
   * 已加载的走真重载（换新代码）；没加载的走首次加载。
   * **不**先 unloadAll —— 那会把正在工作的插件全部掀掉，
   * 而单插件重载已经保证注册物先释放。
   *
   * @returns {Promise<object>} {ok, results:[...], failed:[...]}
   */
  async function reloadAll() {
    const metas = listPlugins(workspace);
    const results = [];
    for (const meta of metas) {
      const rt = loaded.get(meta.id);
      if (!rt) {
        const r = await loadAll();
        const f = r.failed.find((x) => x.id === meta.id);
        results.push({
          id: meta.id,
          ok: !f,
          mode: 'fresh-load',
          error: f ? f.error : '',
          restored: false,
        });
        continue;
      }
      results.push(Object.assign({ id: meta.id }, await doReload(rt)));
    }
    const failed = results.filter((r) => !r.ok);
    return { ok: failed.length === 0, results, failed };
  }

  return {
    loadAll,
    loadNew,
    unloadAll,
    listTools,
    callTool,
    listPlugins,
    toolsService,
    reloadOne,
    reloadAll,
    dropToolsOf,
    /** 当前工具调用属于哪个插件（不在工具调用里就是空串）。 */
    callerId,
    /** 当前运行时是否支持完整的 ESM 热重载。 */
    supportsEsmReload: reload.supportsEsmReload,
    loadedCount: () => loaded.size,
    /**
     * 插件的加载状态。
     *
     * 分三种：
     *   · active  —— 已加载并运行中
     *   · pending —— 依赖未齐，cordis 语义下 fiber 停在 PENDING
     *   · failed  —— 加载失败
     *
     * 设置页用它告诉用户「这个插件在等什么服务」，
     * 而不是含糊地说「没装上」。
     */
    listStatus() {
      const out = Array.from(loaded.values()).map((rt) => {
        // 挂起过的插件要看句柄的实时状态：
        // 服务到齐后容器会把它翻成 started，但宿主的这份记录不会自动更新。
        const started = rt.handle ? rt.handle.started === true : !rt.pending;
        const stillPending = rt.pending && !started;
        return {
          id: rt.meta.id,
          name: rt.meta.name,
          version: rt.meta.version,
          status: stillPending ? 'pending' : 'active',
          pendingDeps: stillPending ? rt.pendingDeps : [],
          error: '',
          moduleKind: rt.moduleKind || '',
        };
      });
      // 失败的插件单独并进来。
      // 它们不在 loaded 里（没有 fiber），但用户必须能看见「为什么没跑起来」。
      for (const [id, f] of failures) {
        const row = out.find((o) => o.id === id);
        if (row) {
          row.status = 'failed';
          row.error = f.error;
        } else {
          out.push({
            id,
            name: id,
            version: '',
            status: 'failed',
            pendingDeps: [],
            error: f.error,
            moduleKind: '',
          });
        }
      }
      return out;
    },
    /** 当前挂起（等依赖）的插件数量。 */
    pendingCount: () =>
      Array.from(loaded.values()).filter((rt) => {
        if (!rt.pending) return false;
        return !(rt.handle && rt.handle.started === true);
      }).length,
  };
}

/**
 * 报告「Node 眼里的插件目录长什么样」。
 *
 * ============ 为什么需要这个 ============
 *
 * 「未找到插件」这句话本身不提供任何信息 —— 可能是：
 *   · 页面把文件写到了别的地方（路径拼错、写进了资料库）；
 *   · Node 看到的 workspace 和页面看到的不是同一个（两边 root 不一致）；
 *   · plugins/ 目录压根没建出来；
 *   · 目录在，但里面是空壳（只有目录没有 main.js）。
 *
 * 这四种情况的修法完全不同，而用户看到的都是同一句话。
 * 所以把 Node 侧的真相原样报上去，让界面能说清楚卡在哪一步。
 *
 * @param {string} workspace 工作区根目录
 * @returns {{workspace:string, pluginsDir:string, exists:boolean, entries:string[], error:string}}
 */
function diagnose(workspace) {
  const dir = path.join(workspace, PLUGIN_DIR);
  let exists = false;
  let entries = [];
  let stray = [];
  let error = '';
  try {
    exists = fs.existsSync(dir);
    if (exists) {
      entries = fs
        .readdirSync(dir)
        .filter((name) => !name.startsWith('.'))
        .sort();
      // 目录在、但里面没有可加载的入口 —— 最常见的「明明放了文件却说找不到」。
      // 单独列出来，否则用户只会看到目录名，以为一切正常。
      for (const name of entries) {
        const full = path.join(dir, name);
        let stat = null;
        try {
          stat = fs.statSync(full);
        } catch (e) {
          continue;
        }
        if (!stat.isDirectory()) continue;
        const hasEntry = ['main.js', 'index.js', 'plugin.js'].some((f) =>
          fs.existsSync(path.join(full, f))
        );
        const hasPackage = fs.existsSync(path.join(full, 'package.json'));
        if (!hasEntry && !hasPackage) stray.push(name);
      }
    }
  } catch (e) {
    error = String((e && e.message) || e);
  }
  return {
    workspace: String(workspace || ''),
    pluginsDir: dir,
    exists,
    entries,
    stray,
    error,
  };
}

module.exports = { createHost, listPlugins, loadModule, diagnose };
