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

/** 插件目录名（相对工作区根）。 */
const PLUGIN_DIR = 'plugins';

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
        const main = pkg.main || 'index.js';
        const entry = path.join(dir, main);
        if (fs.existsSync(entry)) {
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
 * require 一个 ESM 文件会抛错，所以两种都要试。
 *
 * @returns {Promise<{apply:Function, inject?:string[]}>}
 */
async function loadModule(entry) {
  // 先试 CJS
  try {
    const mod = require(entry);
    return normalize(mod);
  } catch (e) {
    const err = String((e && e.message) || e);
    // ERR_REQUIRE_ESM 之类才需要换 ESM 试法；语法错误是插件自身的问题，
    // 但 ESM 解析同样会报语法错，所以两种都试一遍，取先成功的。
    try {
      const mod = await import(pathToFileURL(entry).href);
      return normalize(mod);
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

  /** 已加载的插件：id → { meta, disposer } */
  const loaded = new Map();
  /** 工具表：name → { name, description, parameters, pluginId } */
  const tools = new Map();

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
      tools.set(def.name, {
        name: def.name,
        description: def.description || '',
        parameters: def.parameters || { type: 'object', properties: {} },
        pluginId: def.pluginId || '',
        pluginName: def.pluginName || '',
        handler: fn,
      });
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
   * 载入全部插件。
   *
   * @returns {Promise<{loaded:number, failed:Array<{id:string,error:string}>}>}
   */
  async function loadAll() {
    const metas = listPlugins(workspace);
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
          log('error', `插件 ${meta.id} 加载失败：${res.error}`);
          continue;
        }
        loaded.set(meta.id, { meta, disposer: res.disposer });
        count += 1;
      } catch (e) {
        const err = String((e && e.message) || e);
        failed.push({ id: meta.id, error: err });
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

  /** 调用一个插件工具。 */
  async function callTool(name, args) {
    const t = tools.get(name);
    if (!t) throw new Error('没有这个工具：' + name);
    const result = await t.handler(args || {});
    return result === undefined ? null : result;
  }

  return {
    loadAll,
    unloadAll,
    listTools,
    callTool,
    listPlugins,
    toolsService,
    loadedCount: () => loaded.size,
  };
}

module.exports = { createHost, listPlugins, loadModule };
