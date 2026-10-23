'use strict';

/**
 * `llm` 服务 —— 手机端的模型供应方适配层。
 *
 * ============ 为什么需要这一层 ============
 *
 * `dsh-our-free-model` 是个**模型供应方**插件：它存在的意义是往 DSH 的
 * 模型注册表里塞一批模型。它的硬需求只有一个：
 *
 *     export const inject = ['llm']
 *     ...
 *     const registration = ctx.llm.registerAdapter([ROUTE_MAIN, ROUTE_REGION], adapter)
 *
 * 而 DSH 桌面版的 `llm` 服务是 `@deepseek-ai/dsh-llm` 提供的：它维护一张
 * 「provider 路由 → adapter」的表，模型选择器按路由分组显示。
 *
 * 手机端**没有**这张表 —— 手机端的模型表在页面侧：
 * `state.settings.models` + `state.settings.customModels`。
 * 两侧的数据结构、命名、生命周期都不一样。
 *
 * 所以要接住这类插件，就得有一层适配：把插件注册的 adapter
 * 翻译成手机端模型表里的条目。
 *
 * ============ 契约来自权威源码，不是猜的 ============
 *
 * `@deepseek-ai/dsh-llm` 是 restricted 包，拿不到实现，但 `lib/types/index.d.ts`
 * 里有完整类型定义，`lib/types/index.js` 里还有一份可读的参考实现。
 * 关键契约：
 *
 *   1. `registerAdapter(providers, adapter)` 返回 **AdapterRegistrationHandle**：
 *      一个**既是函数、又有 `.replace()` 方法**的东西。
 *        · 当函数调用 → 释放它当前占有的全部路由
 *        · `.replace(providers)` → 原子地把路由集换成新的
 *      ——插件正是这么用的：
 *          ctx.effect(() => () => { registration() }, 'adapter routes')
 *          registration.replace(routes())
 *      只返回普通函数会让 `registration.replace is not a function`。
 *
 *   2. `registerConfigurableProviders(entries)` 返回 DirectoryRegistrationHandle：
 *      同样是「函数 + .replace()」。
 *
 *   3. `registerModelDiscovery(settingsNs, discover)` 返回一个撤销函数。
 *
 * ============ 这一层现在做到哪一步 ============
 *
 * 本阶段（Stage 2 第 1 步）的目标是**容器不塌** —— 让真实插件能加载、
 * 能注册、能反注册，路由表与手机端模型表对齐。
 *
 * 但「注册进手机端模型表」这一步有个前提问题：模型表在**页面侧**（WebView），
 * 而这里在 **Node 侧**。跨进程要过通道。
 *
 * 所以这里的做法是：
 *   · Node 侧维护一张**权威路由表**（provider → adapter）；
 *   · 路由集变化时，通过回调把新路由集报给宿主（main.js），
 *     由宿主转成通道消息发给页面；
 *   · 页面侧收到后，把它并进手机端的模型表。
 *
 * 换句话说：**这一层是"接线"，真正把模型塞进选择器的是页面侧那一半**。
 * 接线这一半在本阶段完成，落地那一半见 llm-bridge。
 */

/**
 * 构造 llm 服务。
 *
 * @param {object} opts
 *   opts.ctx        容器（用于 ctx.effect）
 *   opts.log        日志函数 (level, scope, message)
 *   opts.onRoutes   路由集变化时的回调 (routes) —— 用来通知页面侧
 * @param {object} [opts.models]
 *   手机端已有的模型表（用于对账）。可选 —— 没它也不影响注册。
 */
function createLlmService(opts) {
  const options = opts || {};
  const log = typeof options.log === 'function' ? options.log : () => {};
  const onRoutes = typeof options.onRoutes === 'function' ? options.onRoutes : () => {};

  /**
   * provider 路由 → adapter。
   * 一条路由只能有一个 adapter（桌面版也是如此：重复注册抛
   * DUPLICATE_ADAPTER）。
   */
  const adapters = new Map();

  /** settingsNs → 发现函数。 */
  const discoveries = new Map();

  /** 可配置供应方目录：provider → 条目。 */
  const directory = new Map();

  /**
   * provider → 注册它的插件 id。
   *
   * 桌面版靠 fiber 归属天然知道「这个 adapter 是谁注册的」；
   * 我们这里靠 ctx.currentScope() 上的 pluginId —— 容器在
   * applyPlugin 期间把当前插件的作用域设为活动作用域。
   *
   * 插件详情页要用它把「模型」按插件分组。
   */
  const owners = new Map();

  /** 当前正在执行 apply 的插件 id（没有就是宿主自己）。 */
  function currentOwner() {
    try {
      const scope = options.ctx && typeof options.ctx.currentScope === 'function' ? options.ctx.currentScope() : null;
      return scope && scope.pluginId ? String(scope.pluginId) : '';
    } catch (e) {
      return '';
    }
  }

  /** 已释放的注册（release 之后 replace 要报错）。 */
  const released = new Set();

  /**
   * 通知路由拓扑变化。
   * 桌面版发的是 `llm/adapters-updated` 事件，插件在
   * `ctx.on?.('loader/volatile-update')` 和别处监听它。
   */
  function emitAdaptersUpdated() {
    try {
      if (options.ctx && typeof options.ctx.emit === 'function') {
        options.ctx.emit('llm/adapters-updated');
      }
    } catch (e) {
      // 一个坏掉的监听器不能连累路由提交
      log('warn', 'llm', 'adapters-updated 监听器出错：' + (e && e.message));
    }
    // 报给宿主（→ 页面侧模型表）
    try {
      onRoutes(listRoutes());
    } catch (e) {
      log('warn', 'llm', '路由上报出错：' + (e && e.message));
    }
  }

  /** 当前路由表（给宿主看）。 */
  function listRoutes() {
    return Array.from(adapters.keys()).map((provider) => {
      const adapter = adapters.get(provider);
      return {
        provider,
        name: (adapter && adapter.providerInfo && safeProviderInfo(adapter, provider)) || provider,
        pluginId: owners.get(provider) || '',
      };
    });
  }

  function safeProviderInfo(adapter, provider) {
    try {
      const info = adapter.providerInfo(provider);
      return info && (info.name || info.displayName) ? info.name || info.displayName : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 校验候选路由集。
   *
   * 对齐桌面版：全量校验，一个都不合法就整批拒绝，
   * 当前的路由集原封不动。
   *
   * @param {boolean} allowEmpty 是否允许空集（replace 允许，初始注册不允许）
   */
  function prepareRoutes(providers, adapter, owned, allowEmpty) {
    const unique = new Set();
    for (const provider of providers) {
      if (typeof provider !== 'string' || provider.length === 0) {
        throw new Error('INVALID_ADAPTER: provider 路由不能为空');
      }
      if (unique.has(provider)) {
        throw new Error('DUPLICATE_ADAPTER: 路由重复：' + provider);
      }
      unique.add(provider);
    }
    if (unique.size === 0 && !allowEmpty) {
      throw new Error('INVALID_ADAPTER: 至少要注册一个 provider 路由');
    }
    for (const provider of unique) {
      // 自己已经持有的路由不算冲突
      if (owned.has(provider)) continue;
      if (adapters.has(provider)) {
        throw new Error('DUPLICATE_ADAPTER: 路由已被占用：' + provider);
      }
    }
    // adapter 必须有 stream 方法 —— 这是唯一真正必需的能力
    if (!adapter || typeof adapter.stream !== 'function') {
      throw new Error('INVALID_ADAPTER: adapter 缺少 stream 方法');
    }
    return unique;
  }

  /** 原子提交路由集。 */
  function commitRoutes(owned, next) {
    for (const provider of owned) {
      adapters.delete(provider);
      // 只有仍归自己时才清归属（同一路由可能已被别的插件接管）
      if (owners.get(provider) === owned.owner) owners.delete(provider);
    }
    for (const provider of next) {
      adapters.set(provider, owned.adapter);
      if (owned.owner) owners.set(provider, owned.owner);
      else owners.delete(provider);
    }
    owned.clear();
    for (const provider of next) owned.add(provider);
  }

  /**
   * 把清理动作挂到当前插件的卸载钩子上。
   *
   * ============ 为什么需要 ============
   *
   * 桌面版的 `llm` 是 cordis `Service` 子类，它内部用
   * `this.ctx.effect(...)` 注册 —— 而 `this.ctx` 绑在**调用方插件的
   * fiber** 上，所以「插件卸载 → 注册自动消失」。
   *
   * 手机端的 `llm` 是宿主单例，不知道是谁在调。而真实插件
   * `dsh-our-free-model` 调 `registerConfigurableProviders` 之后
   * **把句柄丢了**（源码第 424 行没有赋值）—— 它指望自动回收。
   *
   * 所以这里显式把释放挂到插件作用域上。桌面版是「隐式自动」，
   * 这里是「显式挂载」，效果一致。
   *
   * @param {Function} release 释放函数
   */
  function bindToOwner(release) {
    if (options.ctx && typeof options.ctx.onDispose === 'function') {
      options.ctx.onDispose(release);
    }
  }

  const service = {
    /**
     * 注册一个 adapter。
     *
     * @param {string[]} providers 路由集
     * @param {object} adapter     adapter 实例
     * @returns {Function} 撤销函数，带 .replace()
     */
    /**
     * 当前所有供应方（桌面版 `ctx.llm.listProviders()` 的同名方法）。
     *
     * 桌面版返回 `[{ provider: {...} }]` 形状；我们这里 provider 是字符串，
     * 所以给对象包一层，字段名对齐（provider / name），插件读 name 不会 undefined。
     */
    listProviders() {
      return listRoutes().map((r) => ({ provider: r.provider, name: r.name }));
    },

    registerAdapter(providers, adapter) {
      const list = Array.isArray(providers) ? providers.slice() : [];
      /** 本次注册当前持有的路由。 */
      const owned = new Set();
      owned.adapter = adapter;
      owned.owner = currentOwner();
      let isReleased = false;

      // 立刻校验 —— 桌面版在 effect 体内校验，错误会同步抛给调用方
      let prepared;
      try {
        prepared = prepareRoutes(list, adapter, owned, false);
      } catch (e) {
        throw e;
      }
      commitRoutes(owned, prepared);
      emitAdaptersUpdated();

      /** 释放：撤销全部路由。 */
      const handle = function release() {
        if (isReleased) return;
        isReleased = true;
        released.add(handle);
        for (const provider of owned) adapters.delete(provider);
        owned.clear();
        emitAdaptersUpdated();
      };
      // 插件卸载时自动释放 —— 桌面版靠 fiber 绑定，这里显式挂上
      bindToOwner(handle);

      /**
       * 原子替换路由集。
       * 对齐桌面版：候选集先全量校验，一个不合法就整批拒绝，
       * 当前路由保持不变。空数组是合法的（设置清空后仍保持注册状态）。
       */
      handle.replace = function replace(next) {
        if (isReleased) {
          throw new Error('REGISTRATION_DISPOSED: 已释放的注册不能替换路由');
        }
        const candidate = Array.isArray(next) ? next.slice() : [];
        // 空数组合法，但初始注册不允许空
        const preparedNext = prepareRoutes(candidate, adapter, owned, true);
        commitRoutes(owned, preparedNext);
        emitAdaptersUpdated();
      };

      return handle;
    },

    /**
     * 注册可配置供应方目录条目。
     *
     * @returns {Function} 撤销函数，带 .replace()
     */
    registerConfigurableProviders(entries) {
      const list = Array.isArray(entries) ? entries.slice() : [];
      let held = [];
      let isReleased = false;

      const commit = (candidates) => {
        const own = new Set(held.map((e) => e.provider));
        const detached = [];
        for (const entry of candidates) {
          if (!entry || !entry.provider || !entry.displayName || !entry.settingsNs) {
            throw new Error('INVALID_DIRECTORY: 条目需要 provider、displayName、settingsNs');
          }
          if (directory.has(entry.provider) && !own.has(entry.provider)) {
            throw new Error('DUPLICATE_DIRECTORY: 供应方已存在：' + entry.provider);
          }
          detached.push({ ...entry, settingsPath: Array.isArray(entry.settingsPath) ? entry.settingsPath.slice() : [] });
        }
        for (const entry of held) directory.delete(entry.provider);
        for (const entry of detached) directory.set(entry.provider, entry);
        held = detached;
        emitAdaptersUpdated();
      };

      commit(list);

      const handle = function release() {
        if (isReleased) return;
        isReleased = true;
        for (const entry of held) directory.delete(entry.provider);
        held = [];
        emitAdaptersUpdated();
      };
      bindToOwner(handle);
      handle.replace = function replace(next) {
        if (isReleased) {
          throw new Error('REGISTRATION_DISPOSED: 已释放的注册不能替换条目');
        }
        commit(Array.isArray(next) ? next.slice() : []);
      };
      return handle;
    },

    /**
     * 注册模型发现函数。
     *
     * @param {string} settingsNs 命名空间
     * @param {Function} discover  发现函数
     * @returns {Function} 撤销函数
     */
    registerModelDiscovery(settingsNs, discover) {
      const ns = String(settingsNs || '');
      if (ns.length === 0) {
        throw new Error('INVALID_DISCOVERY: 命名空间不能为空');
      }
      if (discoveries.has(ns)) {
        throw new Error('DUPLICATE_DISCOVERY: 命名空间已被占用：' + ns);
      }
      discoveries.set(ns, discover);
      const dispose = function dispose() {
        discoveries.delete(ns);
      };
      bindToOwner(dispose);
      return dispose;
    },

    /* ---- 以下是手机端自己用的查询接口 ---- */

    /** 当前路由表。 */
    listRoutes,
    /** 当前可配置供应方目录。 */
    listDirectory() {
      return Array.from(directory.values()).map((e) => ({ ...e }));
    },
    /** 按路由取 adapter。 */
    getAdapter(provider) {
      return adapters.get(provider);
    },
    /** 某命名空间的发现函数。 */
    getDiscovery(settingsNs) {
      return discoveries.get(settingsNs);
    },
    /**
     * 问某个供应方「你眼下提供哪些模型」。
     *
     * 对齐桌面版的 `llm.listModels(provider)` —— 直接问 adapter。
     * 比走 `registerModelDiscovery` 更准：
     *   · adapter 知道自己眼下有哪些模型（随探测结果变化）；
     *   · 返回的每一项**自带 provider**，路由名天然一致，
     *     不用去做「发现命名空间 ↔ 路由名」的映射（那是两套标识）。
     *
     * @param {string} provider 路由名
     * @returns {Promise<Array>} 模型清单
     */
    async listModels(provider) {
      const adapter = adapters.get(String(provider));
      if (!adapter || typeof adapter.listModels !== 'function') return [];
      const found = await adapter.listModels(String(provider));
      if (!Array.isArray(found)) return [];
      // 去重 —— 同一个 id 只留一个
      const seen = new Set();
      const out = [];
      for (const m of found) {
        const id = String((m && m.id) || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          name: String(m.name || id),
          provider: String((m && m.provider) || provider),
          contextWindow: Number(m.contextWindow) || 0,
          maxTokens: Number(m.maxTokens) || 0,
          inputModalities: Array.isArray(m.inputModalities) ? m.inputModalities : [],
        });
      }
      return out;
    },
    /**
     * 问某个命名空间的发现函数「你提供哪些模型」。
     *
     * 桌面版是在设置页点「检测模型」按钮时问的。手机端由页面侧主动问。
     *
     * @param {string} settingsNs 命名空间
     * @returns {Promise<Array>} 模型清单
     */
    async discoverModels(settingsNs) {
      const discover = discoveries.get(String(settingsNs));
      if (!discover) return [];
      const found = await discover({});
      return Array.isArray(found) ? found : [];
    },
    /** 所有已注册的发现命名空间。 */
    listDiscoveryNamespaces() {
      return Array.from(discoveries.keys());
    },
    /** 路由数量。 */
    routeCount() {
      return adapters.size;
    },
  };

  return service;
}

/**
 * `replace` 用的路由校验 —— 与初始注册的区别只在于**允许空数组**。
 */
module.exports = { createLlmService };
