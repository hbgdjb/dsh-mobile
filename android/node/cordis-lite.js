'use strict';

/**
 * 迷你 cordis 容器。
 *
 * ============ 为什么需要它 ============
 *
 * DSH（桌面版）的插件是 cordis 插件：导出 `apply(ctx)`，并用 `inject` 声明
 * 自己需要哪些服务。比如 dsh-codex-effort-slider：
 *
 *     var inject = ["slots", "sessions", "modelDirectories", "remote", "remote.session"];
 *     function apply(ctx) {
 *       ctx.slots.inject(SLOT_NAME, function () {
 *         return ctx.slots.register({ ... }, function SlotComponent(props) { ... });
 *       });
 *     }
 *
 * 也就是说：`ctx` 是一个**服务容器**，`ctx.slots` 是宿主提供的服务，
 * 插件按名字取用。宿主没提供的能力，插件就不该用。
 *
 * 手机上当然装不了完整 cordis（依赖树几百个包，跑在手机上也慢）。
 * 但插件真正用到的服务其实很少。
 *
 * ============ 语义来源 ============
 *
 * 这份实现不是照着感觉写的，而是照着**真实 cordis 源码**写的：
 * `@deepseek-ai/cordis@4.0.2`（DSH 桌面版用的那一份）的 src/context.ts、
 * src/reflect.ts、src/fiber.ts、src/events.ts、src/registry.ts。
 *
 * 对照依据来自真实插件 `dsh-our-free-model@2.5.9` 的源码实测 ——
 * 那份插件把 ctx 用得最狠，是最好的考卷。
 *
 * ============ ctx 的表面来自哪里 ============
 *
 * 桌面版 `@deepseek-ai/dsh-tool-cordis` 自己维护着一份 ctx API 目录
 * （`api-catalog` 里的 `INHERITED_CTX_API`），明确列出「cordis core +
 * loader/hmr/timer」的完整表面。本实现按那份目录逐项对照：
 *
 *   1. ctx.on / ctx.once
 *   2. ctx.emit / ctx.parallel / ctx.serial / ctx.bail / ctx.waterfall
 *   3. ctx.plugin / ctx.inject
 *   4. ctx.effect
 *   5. ctx.get / ctx.set / ctx.provide / ctx.accessor / ctx.mixin
 *   6. ctx.extend / ctx.isolate / ctx.intercept
 *   7. ctx.root / ctx.scope / ctx.fiber / ctx.registry / ctx.reflect
 *      / ctx.events / ctx.logger
 *   8. ctx.timer（+ interval/timeout/throttle/debounce/setTimeout/setInterval）
 *   9. ctx.loader —— **独立插件 `@deepseek-ai/cordis-plugin-loader` 的职责，不做**
 *  10. ctx.hmr —— **独立插件 `@deepseek-ai/cordis-plugin-hmr` 的职责，不做**
 *
 * 第 9、10 项不做，是因为它们**不在 cordis 核心里**
 * （cordis 4.0.2 全部源码里 grep loader 只有注释命中）。
 * 桌面版也是靠装独立插件才有它们的。
 *
 * ============ 三条从 DSH 生态事故里学来的纪律 ============
 *
 * 真实 DSH 插件的注释里明确写着（cordis.patch.yml 与 index.js）：
 *
 *   1. apply() 绝不抛错 —— 同步抛错会让该条目的 fiber 失败，
 *      启动审计会把它报成「Failed to load plugins」。
 *   2. inject 只声明确定存在的服务 —— 申明一个从未被 provide 的服务
 *      会让 fiber 停在 PENDING，从而拖累整棵插件树。
 *   3. 不打日志噪音 —— 加载成功不值得写一行日志。
 *
 * 迷你版把这三条都实现了，因为它们是插件能"活着加载"的底线。
 */

const { FiberState, stateName } = require('./fiber-state.js');

/** 宿主默认提供的服务。 */
const DEFAULT_SERVICES = ['logger'];

/**
 * 内在服务：无论插件有没有声明 inject，都一定能拿到。
 *
 * ============ 为什么 logger 和 tools 是内在的 ============
 *
 * cordis 的规矩是「声明了才有」—— 这是它能支持服务热插拔的前提。
 * 但手机端的 logger 与 tools 是**我们这个平台自己的 API 表面**，
 * 不是可选的宿主依赖：
 *
 *   · 插件想打日志，就必然要用 logger。桌面版的插件在 inject 里
 *     声明它，纯属 cordis 的形式要求，不是真的"可选"。
 *   · tools 是插件接入 AI 助手的唯一入口 —— 桌面版插件没有它
 *     就什么用都没有。
 *
 * 所以这两个直接给。其余服务（slots / sessions / modelDirectories / remote）
 * 仍然严格按 inject 给 —— 那些是真的宿主能力，给错了会导致
 * 插件以为自己有 UI 插槽，其实在手机上根本没有。
 */
const INTRINSIC_SERVICES = ['logger', 'tools'];

/**
 * 事件总线。
 *
 * 对应 cordis 的 `EventsService`（src/events.ts）。
 *
 * cordis 有五种派发模式，本实现全部对齐：
 *
 *   · emit      同步触发，不等返回的 Promise
 *   · parallel  并发触发全部，等全部结束；有失败则 AggregateError
 *   · serial    依次 await，第一个 bail 值即返回
 *   · bail      同步依次，第一个 bail 值即返回
 *   · waterfall 链式：监听器不调 next() 就否决后续
 *
 * 「bail 值」的定义（src/events.ts 第 13 行）：
 * `value !== null && value !== false && value !== undefined`。
 */
function createEventBus() {
  /** name → Set<listener> */
  const hooks = new Map();

  function on(name, listener, options) {
    if (typeof listener !== 'function') {
      throw new TypeError('事件监听器必须是函数');
    }
    let set = hooks.get(name);
    if (!set) {
      set = new Set();
      hooks.set(name, set);
    }
    // cordis 的 options.prepend 表示插到队首
    if (options === true || (options && options.prepend)) {
      const arr = Array.from(set);
      set.clear();
      set.add(listener);
      for (const item of arr) set.add(item);
    } else {
      set.add(listener);
    }
    // 返回退订函数 —— cordis 里叫 disposer
    return () => {
      const s = hooks.get(name);
      if (!s) return false;
      const removed = s.delete(listener);
      if (s.size === 0) hooks.delete(name);
      return removed;
    };
  }

  function once(name, listener, options) {
    const dispose = on(
      name,
      function (...args) {
        dispose();
        return listener.apply(this, args);
      },
      options
    );
    return dispose;
  }

  /** 取出监听器快照 —— 派发期间监听器列表可能变。 */
  function listenersOf(name) {
    const set = hooks.get(name);
    return set && set.size ? Array.from(set) : [];
  }

  function emit(name, ...args) {
    const results = [];
    // 复制一份再派发 —— 监听器里退订/订阅不能影响本次派发
    for (const listener of listenersOf(name)) {
      try {
        results.push(listener(...args));
      } catch (e) {
        // 一个监听器抛错不能连累其它监听器
        results.push(undefined);
      }
    }
    return results;
  }

  /** 并发派发，等全部结束；有失败则抛 AggregateError。 */
  async function parallel(name, ...args) {
    const results = await Promise.allSettled(
      listenersOf(name).map(async (cb) => cb(...args))
    );
    const errors = results.filter((r) => r.status === 'rejected');
    if (errors.length) {
      throw new AggregateError(errors.map((e) => e.reason));
    }
  }

  /** 依次 await，第一个 bail 值即返回。 */
  async function serial(name, ...args) {
    for (const cb of listenersOf(name)) {
      const result = await cb(...args);
      if (isBailed(result)) return result;
    }
    return undefined;
  }

  /** 同步依次，第一个 bail 值即返回。 */
  function bail(name, ...args) {
    for (const cb of listenersOf(name)) {
      const result = cb(...args);
      if (isBailed(result)) return result;
    }
    return undefined;
  }

  /**
   * 链式派发。
   *
   * 最后一个参数是内置的 next；监听器**不调 next() 就否决**后续，
   * 包括内置行为。这正是 cordis 插件表达「拦截/改写」的标准手法。
   */
  function waterfall(name, ...args) {
    const cbs = listenersOf(name);
    const inner = args.pop();
    const next = () => {
      const cb = cbs.shift() ?? inner;
      return cb(...args);
    };
    args.push(next);
    return next();
  }

  function off(name, listener) {
    const set = hooks.get(name);
    if (!set) return false;
    return set.delete(listener);
  }

  return { on, once, emit, off, parallel, serial, bail, waterfall };
}

/**
 * 判断一个事件返回值是否构成「bail」。
 *
 * 对齐 cordis src/events.ts 第 13 行的 `isBailed`。
 */
function isBailed(value) {
  return value !== null && value !== false && value !== undefined;
}

/**
 * 构造一个容器。
 *
 * @param {object} opts
 *   opts.services  额外提供的服务表 { name: value }
 *   opts.log       日志函数 (level, scope, message)
 */
function createContainer(opts) {
  const options = opts || {};
  const provided = new Map();
  const events = createEventBus();

  /**
   * 容器自身的引用（自引用）。
   *
   * 挂起的插件在服务到齐后要重新走 applyPlugin ——
   * 而 applyPlugin 需要容器。加这个自引用是为了让 flushPendingPlugins
   * 能在闭包里拿到它。
   */
  let selfContainer = null;

  // 日志器。cordis 的 logger 是"工厂函数"：ctx.logger(scope) 得到一个带
  // .info/.warn/.error 的对象。插件里两种写法都有：
  //   ctx.logger.info(...)          —— 直接用
  //   ctx.logger("scope").info(...) —— 带作用域
  const rootLog = typeof options.log === 'function' ? options.log : () => {};

  const logger = function (scope) {
    return makeLogger(scope);
  };
  // 直接当对象用时的快捷方式
  logger.info = (...a) => rootLog('info', '', a.join(' '));
  logger.warn = (...a) => rootLog('warn', '', a.join(' '));
  logger.error = (...a) => rootLog('error', '', a.join(' '));
  logger.debug = (...a) => rootLog('debug', '', a.join(' '));

  function makeLogger(scope) {
    const tag = scope ? String(scope) : '';
    return {
      info: (...a) => rootLog('info', tag, a.join(' ')),
      warn: (...a) => rootLog('warn', tag, a.join(' ')),
      error: (...a) => rootLog('error', tag, a.join(' ')),
      debug: (...a) => rootLog('debug', tag, a.join(' ')),
    };
  }

  provided.set('logger', logger);

  // 额外服务
  const extra = options.services || {};
  for (const key of Object.keys(extra)) {
    provided.set(key, extra[key]);
  }

  /**
   * 等待中的 `ctx.inject(deps, cb)` 回调。
   *
   * ============ 这里为什么必须有挂起机制 ============
   *
   * 真实 cordis 的 `ctx.inject(deps, cb)`（src/registry.ts 第 300 行）
   * 其实是 `this.plugin({ inject: deps, apply: cb })` —— 它开一个新的 fiber，
   * **只有当 deps 里的服务全部就绪时，cb 才会被调用**；缺任何一个就永远
   * PENDING（不报错、不执行）。
   *
   * 真实插件 `dsh-our-free-model` 正是靠这个语义做能力分层的：
   *
   *     ctx.inject(['credentials', 'commands', 'llm'], scoped => { ... })
   *     ctx.inject(['webServer'], scoped => { ... })
   *
   * 手机上没有 credentials / commands / webServer —— 按 cordis 语义，
   * 这两段回调**永远不执行**，插件其余部分照常跑。这正是我们要的：
   * 「装上就有用」的一部分，不因为缺可选能力而整条链路瘫掉。
   *
   * 如果我们把 `ctx.inject` 简单实现成「立刻调用 cb」，插件就会去拿
   * 不存在的服务、动态 import 一个 2.5MB 的 vendor 包，然后炸掉。
   */
  const pendingInjects = [];

  /**
   * 挂起的插件（依赖未齐，等服务到货）。
   *
   * 对应 cordis 里停在 PENDING 的 fiber ——
   * 服务到齐后自动启动（src/fiber.ts 的 _refresh / _setEpoch）。
   */
  const pendingPlugins = [];

  /** 服务到货 → 启动挂起的插件。 */
  function flushPendingPlugins() {
    for (let i = 0; i < pendingPlugins.length; i += 1) {
      const entry = pendingPlugins[i];
      if (!entry.handle.pending) {
        pendingPlugins.splice(i, 1);
        i -= 1;
        continue;
      }
      if (!depsReady(entry.deps)) continue;
      pendingPlugins.splice(i, 1);
      i -= 1;
      entry.handle.pending = false;
      const res = applyPlugin(selfContainer, entry.plugin);
      if (res && res.ok) {
        entry.handle.started = true;
        entry.handle.disposer = res.disposer;
      }
    }
  }

  /**
   * 注册一个新服务（供运行时后续扩展）。
   *
   * 对应 cordis 的 `ctx.provide`。手机端没有真正的 fiber 所有权，
   * 所以这里不实现「同一作用域重复 provide 报错」那套校验 ——
   * 宿主自己提供的服务本来就是全局的。
   *
   * @returns {Function} 撤销注册的函数
   */
  function provide(name, value) {
    provided.set(name, value);
    // 服务到货 → 唤醒可能正在等它的 inject 回调
    flushAll();
    return () => {
      provided.delete(name);
    };
  }

  /**
   * deps 里的服务是否全部就绪。
   *
   * 用 resolveService 而不是 provided.has —— 因为 deps 可以是点号路径
   * （"remote.session"），那是「remote 服务里的 session 子服务」，
   * 并不是一个独立注册的顶层服务。
   */
  function depsReady(deps) {
    for (const name of deps) {
      if (resolveService(name) === undefined) return false;
    }
    return true;
  }

  /** 检查等待中的 inject 回调，能跑的就跑。 */
  function flushPendingInjects() {
    for (let i = 0; i < pendingInjects.length; i += 1) {
      const entry = pendingInjects[i];
      if (entry.done) continue;
      if (!depsReady(entry.deps)) continue;
      entry.done = true;
      pendingInjects.splice(i, 1);
      i -= 1;
      try {
        entry.callback(entry.scope());
      } catch (e) {
        // 回调抛错不能拖垮别的插件
        rootLog('error', '', `inject 回调出错：${e && e.message ? e.message : e}`);
      }
    }
  }

  /**
   * 服务状态变化后的统一刷新入口。
   *
   * 两件事：
   *   · 唤醒在等服务的 `ctx.inject` 回调（插件内部的能力分层）
   *   · 启动依赖已齐的挂起插件（插件整体的生命周期）
   */
  function flushAll() {
    flushPendingInjects();
    flushPendingPlugins();
  }

  /**
   * 按名字找服务，支持点号路径。
   *
   * @returns {*} 服务实例；找不到返回 undefined
   */
  function resolveService(name) {
    if (provided.has(name)) return provided.get(name);
    const parts = String(name).split('.');
    if (parts.length < 2) return undefined;
    const parent = provided.get(parts[0]);
    if (parent === undefined || parent === null) return undefined;
    // 逐级往下找
    let cur = parent;
    for (let i = 1; i < parts.length; i += 1) {
      if (cur === undefined || cur === null) return undefined;
      cur = cur[parts[i]];
    }
    return cur === undefined ? undefined : cur;
  }

  /**
   * 注册表 —— 对应 cordis 的 `RegistryService`（src/registry.ts）。
   *
   * 桌面版 ctx API 目录第 7 组明写 `ctx.registry` 要在。
   *
   * 它按「插件身份（callback）」索引运行时记录：
   *
   *     runtime = { name, callback, fibers: Fiber[], Config }
   *
   * 同一插件可以被加载多次（不同 config），每次一个 fiber，
   * 都挂在同一个 runtime 下 —— 这是 cordis 的标准模型。
   */
  const runtimes = new Map();
  let fiberCounter = 0;

  const registry = {
    /** 下一个 fiber 的 uid（cordis 里是自增计数器）。 */
    get counter() {
      return ++fiberCounter;
    },
    /** 已注册的运行时数量。 */
    get size() {
      return runtimes.size;
    },
    /** 把一个插件形态解析成它的可执行回调。 */
    resolve(plugin) {
      if (!plugin) return undefined;
      if (typeof plugin === 'function') return plugin;
      if (typeof plugin.apply === 'function') return plugin.apply;
      return undefined;
    },
    /** 查某个插件的运行时记录。 */
    get(plugin) {
      const key = this.resolve(plugin);
      return key ? runtimes.get(key) : undefined;
    },
    /** 某个插件是否有运行时记录。 */
    has(plugin) {
      const key = this.resolve(plugin);
      return !!key && runtimes.has(key);
    },
    /** 卸载某插件的全部 fiber 并移除运行时记录。 */
    delete(plugin) {
      const key = this.resolve(plugin);
      if (!key) return undefined;
      const runtime = runtimes.get(key);
      if (!runtime) return undefined;
      runtimes.delete(key);
      for (const fiber of runtime.fibers.slice()) {
        try {
          fiber.dispose();
        } catch (e) {
          /* 忽略：卸载不该因为插件自己的清理失败而中断 */
        }
      }
      return runtime;
    },
    keys() {
      return runtimes.keys();
    },
    values() {
      return runtimes.values();
    },
    entries() {
      return runtimes.entries();
    },
    forEach(cb) {
      return runtimes.forEach(cb);
    },
  };

  /**
   * 反射层 —— 对应 cordis 的 `ReflectService`（src/reflect.ts）。
   *
   * 桌面版 ctx API 目录第 7 组明写 `ctx.reflect` 要在。
   *
   * 存的是「服务的实现记录」而不是裸值：
   *
   *     impl = { name, value, fiber, check }
   *
   * `fiber` 字段是 `ctx.set` 归属检查的依据 ——
   * cordis 规定只有提供该服务的 fiber 才能改它的值。
   */
  const reflectStore = new Map();

  const reflectService = {
    /** 服务实现记录：name → impl。 */
    store: reflectStore,
    /**
     * 读一个服务。
     *
     * `strict` 为 true 时，只返回提供方 fiber 仍处于 ACTIVE 的实现 ——
     * 这样「正在被卸载的服务」在卸载完成前就读不到了。
     */
    get(name, strict = true) {
      const impl = reflectStore.get(name);
      if (!impl) return undefined;
      if (strict && impl.fiber && impl.fiber.state !== FiberState.ACTIVE) {
        return undefined;
      }
      return impl.value;
    },
    /**
     * 覆盖一个已提供服务的值。
     *
     * cordis 的两条硬规则（src/reflect.ts 第 254-262 行）：
     *   · 没 provide 过 → 抛 `cannot set property "X" without provide`
     *   · 不是提供方 fiber → 抛 `cannot set property "X" in multiple fibers`
     */
    set(name, value, ownerFiber) {
      const impl = reflectStore.get(name);
      if (!impl) {
        throw new Error(`cannot set property "${name}" without provide`);
      }
      if (impl.fiber && ownerFiber && impl.fiber !== ownerFiber) {
        throw new Error(`cannot set property "${name}" in multiple fibers`);
      }
      impl.value = value;
      return true;
    },
    /**
     * 注册一个服务实现。
     *
     * @param {string} name  服务名
     * @param {*} value      服务值
     * @param {object} [opts] { fiber, check }
     */
    provide(name, value, opts = {}) {
      if (reflectStore.has(name)) {
        throw new Error(`service "${name}" has been registered already`);
      }
      const impl = {
        name,
        value,
        fiber: opts.fiber || null,
        check: opts.check || null,
      };
      reflectStore.set(name, impl);
      flushAll();
      return () => {
        reflectStore.delete(name);
        flushAll();
      };
    },
  };

  /**
   * 为一个插件构造 ctx。
   *
   * ============ ctx 是代理，不是普通对象 ============
   *
   * 这是本次重构最关键的一处语义修正。
   *
   * 真实 cordis 里 `ctx` 是**代理**（src/reflect.ts 第 133-171 行的 Proxy handler），
   * 读一个没在 inject 里声明的服务会**抛错**：
   *
   *     cannot get property "X" without inject
   *
   * 之前我们的实现是「读什么都返回 undefined / 占位对象」。
   * 看着宽容，实则危险 —— 插件会以为服务存在，走进本不该走的分支，
   * 然后在几百行之后以一个完全无关的错误崩掉。
   *
   * 真实插件 `dsh-our-free-model` 就被这个坑过一次（index.js 第 1463 行）：
   * 它读 `ctx.interval` 时，真实 cordis 抛了
   * `cannot get property "timer" without inject`，
   * **那一次读取让整个插件起不来**。作者为此把定时器链整个重写。
   *
   * 所以现在：读未声明的服务 → 抛错（与 cordis 一致）；
   * `ctx.get(name)` 仍是机会性查找 → 返回 undefined（cordis 的刻意区分）。
   *
   * @param {string[]} inject 插件声明的服务名
   * @param {object} [meta]   插件元信息 { id, name, version, apply }
   */
  function contextFor(inject, meta) {
    const info = meta || {};
    const wanted = Array.isArray(inject) ? inject.slice() : DEFAULT_SERVICES.slice();

    // 本次 ctx 的作用域：收集所有需要在插件卸载时清理的东西
    const scope = {
      disposers: [],
      disposed: false,
      /**
       * 这个作用域属于哪个插件。
       *
       * 宿主服务（llm / slots）在注册时读它，记下「是谁注册的」——
       * 插件详情页要按插件列出它提供的模型，没有这个字段就只能
       * 把所有路由摊在一起，分不清归属。
       */
      pluginId: String((info && (info.id || info.name)) || ''),
      pluginName: String((info && (info.name || info.id)) || ''),
      /** 登记一个「卸载时该做什么」。 */
      onDispose(fn) {
        if (typeof fn === 'function') scope.disposers.push(fn);
      },
    };

    // 声明过的服务名集合 —— 代理据此判断「这个读取是否合法」
    const declared = new Set();

    /**
     * 计算属性表 —— 对应 cordis 的 `ctx.accessor`。
     *
     * key → { name, get, set }
     */
    const accessors = new Map();
    for (const name of wanted) {
      const parts = String(name).split('.');
      declared.add(parts[0]);
    }
    // 内在服务无条件可读
    for (const name of INTRINSIC_SERVICES) declared.add(name);

    // ── fiber ───────────────────────────────────────────────────────────────
    //
    // 真实 cordis 的 fiber（src/fiber.ts）持有插件的完整生命周期信息。
    // 桌面版目录第 7 组明写 `ctx.fiber` 要在，
    // 插件热重载那套逻辑要读它的 runtime.fibers / entry / _config。

    /** 该 fiber 所属的运行时记录（同一插件多次加载会共用一个）。 */
    const runtime = {
      name: info.name || info.id || 'plugin',
      callback: info.apply || null,
      fibers: [],
      Config: info.Config || undefined,
    };

    /** 插件的 Entry（loader 概念）—— 插件用它拿自己的 id。 */
    const entry = {
      options: {
        id: info.id || info.name || 'plugin',
        config: info.config,
      },
      fiber: null,
    };

    const fiber = {
      uid: 0,
      name: runtime.name,
      parent: null,
      runtime,
      inject: wanted.slice(),
      config: info.config,
      _config: info.config,
      entry,
      state: FiberState.ACTIVE,
      /** 已解析的服务实现快照。 */
      store: Object.create(null),
      /** 等待 settle 的 promise。 */
      _settle: null,
      _resolve: null,
      _reject: null,
      /** 卸载时该做什么（插件 apply 返回的 disposer）。 */
      _pluginDisposer: null,
    };
    entry.fiber = fiber;
    runtime.fibers.push(fiber);

    fiber.await = function awaitFiber() {
      return new Promise((resolve, reject) => {
        if (fiber.state === FiberState.FAILED) {
          reject(fiber._error || new Error('fiber failed'));
          return;
        }
        if (fiber.state === FiberState.ACTIVE || fiber.state === FiberState.DISPOSED) {
          resolve(fiber);
          return;
        }
        // 还在加载/挂起 → 记下来，settle 时兑现
        fiber._waiters = fiber._waiters || [];
        fiber._waiters.push({ resolve, reject });
      });
    };

    fiber.dispose = function dispose() {
      if (fiber.state === FiberState.DISPOSED) return Promise.resolve();
      fiber.state = FiberState.UNLOADING;
      try {
        if (typeof fiber._pluginDisposer === 'function') fiber._pluginDisposer();
      } catch (e) {
        /* 忽略：卸载不该因为插件自己的清理失败而中断 */
      }
      disposeScope(scope);
      fiber.state = FiberState.DISPOSED;
      // 从 runtime 的 fiber 列表里摘掉
      const idx = runtime.fibers.indexOf(fiber);
      if (idx >= 0) runtime.fibers.splice(idx, 1);
      settleFiber(fiber, null);
      return Promise.resolve(fiber);
    };

    // ── ctx 的底层对象 ─────────────────────────────────────────────────────
    //
    // 代理的 target 放所有「无条件可读」的 API 与服务；
    // 代理的 get 钩子负责区分「声明过的服务」与「没声明的名字」。

    const target = Object.create(null);

    /** 拿到某个名字对应的真实值；拿不到返回 NOT_FOUND。 */
    const NOT_FOUND = Symbol('not-found');

    /**
     * 区分三种「读不到」的情况 —— 这与 cordis 的错误分类一致。
     *
     *   1. 声明了、宿主提供了     → 真值
     *   2. 声明了、宿主还没提供   → 占位对象（访问其方法时才报错）
     *   3. 压根没声明            → **抛错**（cordis 的代理语义）
     */
    function lookup(name) {
      // 1. 内在服务无条件可读
      if (INTRINSIC_SERVICES.includes(name)) {
        const v = provided.get(name);
        if (v !== undefined) return v;
      }
      // 声明过的服务（含点号路径的父级）
      if (declared.has(name)) {
        const v = resolveService(name);
        if (v !== undefined) return v;
        // 声明了但宿主没提供 → 给占位
        return missingService(name);
      }
      return NOT_FOUND;
    }

    const ctx = new Proxy(target, {
      get(t, prop, receiver) {
        // 符号属性是运行时探测用的（Symbol.toStringTag、Symbol.iterator…），
        // 不能在这里抛错 —— 否则一次无害的 console.log 就能把插件炸掉。
        if (typeof prop === 'symbol') {
          return Reflect.get(t, prop, receiver);
        }
        if (prop in t) {
          return Reflect.get(t, prop, receiver);
        }
        // accessor 优先 —— 它是声明式计算的，不走服务查找。
        const accessor = accessors.get(prop);
        if (accessor) {
          if (accessor.get) return accessor.get.call(ctx, ctx);
          return undefined;
        }
        const found = lookup(prop);
        if (found !== NOT_FOUND) return found;
        // 没声明过的名字 → 与 cordis 一致，抛错
        throw new Error(
          `cannot get property "${prop}" without inject` +
            (declared.size
              ? `（本插件声明的服务：${Array.from(declared).join('、')}）`
              : '（本插件没有声明任何服务）')
        );
      },
      has(t, prop) {
        if (typeof prop === 'symbol') return Reflect.has(t, prop);
        if (prop in t) return true;
        return lookup(prop) !== NOT_FOUND;
      },
      set(t, prop, value, receiver) {
        if (typeof prop === 'symbol') return Reflect.set(t, prop, value, receiver);
        // 服务属性允许插件挂自己的字段（cordis 的 accessor 行为）
        if (prop in t) return Reflect.set(t, prop, value, receiver);
        // accessor 有 set 钩子就调它
        const accessor = accessors.get(prop);
        if (accessor) {
          if (accessor.set) {
            accessor.set.call(ctx, value, ctx);
            return true;
          }
          return false;
        }
        const found = lookup(prop);
        if (found !== NOT_FOUND) {
          // 挂到服务对象上
          try {
            found[prop] = value;
          } catch (e) {
            /* 服务对象不可写 */
          }
          return true;
        }
        return Reflect.set(t, prop, value, receiver);
      },
    });

    // 声明过的服务，在 ctx 上先挂一份真值（点号路径的末梢挂到父服务上）
    for (const name of wanted) {
      const parts = String(name).split('.');
      const resolved = resolveService(name);
      if (parts.length === 1) {
        if (resolved !== undefined) target[parts[0]] = resolved;
        continue;
      }
      // 点号路径：父服务要先落在 ctx 上
      const parentName = parts[0];
      if (target[parentName] === undefined) {
        const parent = resolveService(parentName);
        if (parent !== undefined) target[parentName] = parent;
      }
      const parent = target[parentName];
      // 末梢服务挂不上去（比如父服务是个 Proxy 或不可写对象）就跳过 ——
      // 插件真用到它时会在访问处拿到明确的错误，不会静默拿到错东西。
      if (resolved === undefined) continue;
      try {
        parent[parts[1]] = resolved;
      } catch (e) {
        /* 父服务不可写（frozen 或 getter）—— 放弃这一项 */
      }
    }

    // 内在服务：无条件给
    for (const name of INTRINSIC_SERVICES) {
      if (target[name] === undefined && provided.has(name)) {
        target[name] = provided.get(name);
      }
    }

    // ── cordis 核心 API ────────────────────────────────────────────────────

    /**
     * 机会性查找。
     *
     * 对应 cordis 的 `ctx.get(name, strict=true)`（src/reflect.ts）：
     * 服务不存在时返回 **undefined**，而不是抛错、也不是给占位。
     * 真实插件正是靠这个区分「可选服务」与「必需服务」——
     * 注释写得很直白：「`ctx.get()` is the opportunistic lookup that
     * answers `undefined`」。
     *
     * ============ 这与直接读 ctx.x 是刻意的区别 ============
     *
     *   ctx.get('webServer')   → undefined（可选，插件自己判断）
     *   ctx.webServer          → 抛错（cordis 的代理语义）
     */
    target.get = function get(name) {
      return resolveService(String(name));
    };

    /**
     * 覆盖一个已提供服务的值（cordis 的 ctx.set）。
     *
     * cordis 的两条硬规则（src/reflect.ts 第 254-262 行）：
     *   · 没 provide 过 → 抛 `cannot set property "X" without provide`
     *   · 不是提供方 fiber → 抛 `cannot set property "X" in multiple fibers`
     *
     * 这两条防的是「静默错误」：两个插件抢同一个服务时，
     * 悄悄互相覆盖比抛错难查得多。
     */
    target.set = function set(name, value) {
      const key = String(name);
      const impl = reflectStore.get(key);
      if (impl) {
        reflectService.set(key, value, fiber);
      } else {
        // 宿主级服务（不是插件 provide 的）—— 允许覆盖
        provided.set(key, value);
        flushAll();
      }
    };

    /** 插件自己提供服务（cordis 的 ctx.provide）。 */
    target.provide = function provideOnCtx(name, value) {
      const key = String(name);
      // 已有同名实现 → cordis 会报错；这里选择覆盖（手机端场景更宽容）
      reflectStore.set(key, { name: key, value, fiber, check: null });
      flushAll();
      return () => {
        const cur = reflectStore.get(key);
        if (cur && cur.fiber === fiber) reflectStore.delete(key);
        flushAll();
      };
    };

    /**
     * 注册一个"卸载时该做什么"。
     *
     * 对应 cordis 的 `ctx.fiber.effect(execute, label)`（src/fiber.ts 第 415 行）。
     * 语义逐条对齐：
     *   · execute **立即执行**；
     *   · 它返回的函数是 disposer，插件卸载时按**逆序**执行；
     *   · 返回 undefined / null 表示"没有要清理的"；
     *   · 返回可迭代对象 → 里面每个函数都是一个 disposer；
     *   · 返回 Promise → 等它兑现后取 disposer；
     *   · 其它类型 → 抛 TypeError('Invalid effect')。
     *
     * 真实插件用了 8 处 ctx.effect，包括"启动后台轮询"和"注册后返回
     * 撤销函数"两种典型用法。
     */
    target.effect = function effect(execute, label) {
      if (typeof execute !== 'function') {
        throw new TypeError('ctx.effect 需要一个函数');
      }
      const collected = [];

      const collect = (value) => {
        if (typeof value === 'function') {
          collected.push(value);
        } else if (value !== undefined && value !== null) {
          throw new TypeError('Invalid effect');
        }
      };

      let result;
      // 记下当前作用域的 disposer 数量 —— 主体抛错时，
      // 期间新登记的东西（包括嵌套 effect）都要被清理掉。
      const mark = scope.disposers.length;
      try {
        result = execute();
      } catch (e) {
        // effect 主体抛错：已收集的 disposer 照样要跑
        runDisposers(collected.splice(0).reverse());
        const nested = scope.disposers.splice(mark).reverse();
        runDisposers(nested);
        throw e;
      }

      if (result && typeof result.then === 'function') {
        // 异步 effect：等它兑现
        const promise = Promise.resolve(result).then((value) => {
          collect(value);
          return value;
        });
        promise.catch(() => {});
        scope.disposers.push(() => promise);
      } else if (result && typeof result[Symbol.iterator] === 'function') {
        for (const item of result) collect(item);
      } else {
        collect(result);
      }

      // 返回 disposer：立刻清掉这一个 effect 已收集的东西
      // 逆序 —— 与 cordis 一致（src/fiber.ts dispose() 里的 splice(0).reverse()）
      const disposer = () => {
        const items = collected.splice(0).reverse();
        runDisposers(items);
      };
      scope.disposers.push(disposer);
      return disposer;
    };

    /**
     * "等这些服务都齐了再跑"。
     *
     * 对应 cordis 的 `ctx.inject(deps, callback)`。语义见上面
     * pendingInjects 的注释 —— 关键点是**缺服务时不执行**，
     * 服务到货后自动补跑。
     *
     * cordis 里它其实是 `ctx.plugin({inject, apply})` 的简写
     * （src/registry.ts 第 300 行），所以返回的句柄也有 fiber 的形状。
     *
     * @param {string[]} deps       依赖的服务名
     * @param {Function} callback   依赖满足后调用，参数是带作用域的 ctx
     * @returns {object} 一个带 dispose() 的句柄
     */
    target.inject = function inject(deps, callback) {
      const list = Array.isArray(deps) ? deps.slice() : [];
      const handle = {
        done: false,
        disposed: false,
        dispose() {
          this.disposed = true;
          this.done = true;
        },
        await: () => Promise.resolve(handle),
      };

      const makeScope = () => {
        // 作用域 ctx：继承本 ctx 的全部 API，额外把 deps 服务挂上去。
        //
        // ============ 这里必须用 defineProperty，不能直接赋值 ============
        //
        // ctx 是代理（P0-A 的语义），直接 `scoped.x = v` 会走代理的 set 钩子：
        //   · 若 x 是已声明的服务 → 挂到服务对象上（不对）
        //   · 否则 → 落到代理 target 上（会污染父 ctx，更不对）
        //
        // 作用域内的 deps 是「这次 inject 明确要的服务」，
        // 相当于 cordis 里那个子 fiber 自己的 inject 声明 ——
        // 所以它们必须是**自有属性**，直接定义，绕开代理的读取校验。
        const scoped = Object.create(ctx);
        const define = (key, value) => {
          Object.defineProperty(scoped, key, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        };
        for (const name of list) {
          const resolved = resolveService(name);
          if (resolved === undefined) continue;
          const parts = String(name).split('.');
          if (parts.length === 1) {
            define(parts[0], resolved);
            continue;
          }
          // 点号路径：末梢挂在父服务下。
          //
          // ============ 父服务必须从 resolveService 取，不能从 scoped 取 ============
          //
          // scoped 继承自代理 ctx，读 scoped['remote'] 会走代理的 get 钩子 ——
          // 而 'remote' 不在插件的 inject 声明里，会抛
          // `cannot get property "remote" without inject`，
          // 那会让整个 inject 回调静默地不执行。
          //
          // 所以：父服务直接向容器要，然后定义成 scoped 的自有属性。
          const parent = resolveService(parts[0]);
          if (parent === undefined || parent === null) continue;
          define(parts[0], parent);
          try {
            parent[parts[1]] = resolved;
          } catch (e) {
            /* 父服务不可写 */
          }
        }
        return scoped;
      };

      if (depsReady(list)) {
        handle.done = true;
        try {
          callback(makeScope());
        } catch (e) {
          rootLog('error', '', `inject 回调出错：${e && e.message ? e.message : e}`);
        }
      } else {
        pendingInjects.push({ deps: list, callback, scope: makeScope, done: false, handle });
      }
      return handle;
    };

    /**
     * 加载一个子插件。
     *
     * 对应 cordis 的 `ctx.plugin(plugin, config)`（src/registry.ts 第 319 行）。
     *
     * ============ 桌面版 ctx API 目录第 3 组明写它 ============
     *
     * 「`ctx.plugin / ctx.inject` —— Load a plugin / declare required services.」
     *
     * cordis 里它是「在当前上下文里起一个新 fiber」的入口 ——
     * 插件因此可以挂载子插件。这是 cordis 生态里很常见的能力，
     * 我们之前没有，插件调 `ctx.plugin` 会拿到 undefined。
     *
     * @param {object|Function} plugin  插件（{apply} 对象或函数）
     * @param {*} [config]               插件配置
     * @returns {object} 可 await 的 fiber 句柄
     */
    target.plugin = function plugin(pluginShape, config) {
      return loadChildPlugin(pluginShape, config, fiber);
    };

    // ── 事件 ────────────────────────────────────────────────────────────────
    //
    // cordis 有五种派发模式（src/events.ts），全部对齐 ——
    // 桌面版 ctx API 目录第 2 组把它们列成一行。
    target.on = (name, listener, opts) => events.on(name, listener, opts);
    target.once = (name, listener, opts) => events.once(name, listener, opts);
    target.emit = (name, ...args) => events.emit(name, ...args);
    target.off = (name, listener) => events.off(name, listener);
    target.parallel = (name, ...args) => events.parallel(name, ...args);
    target.serial = (name, ...args) => events.serial(name, ...args);
    target.bail = (name, ...args) => events.bail(name, ...args);
    target.waterfall = (name, ...args) => events.waterfall(name, ...args);

    // ── 上下文派生（cordis src/context.ts 第 99-175 行）────────────────────
    //
    // 桌面版 ctx API 目录第 6 组：`ctx.extend / ctx.isolate / ctx.intercept`。

    /**
     * 派生子上下文。
     *
     * cordis 的 `ctx.extend(meta)` 用 `Object.create` 造一个继承父级的子上下文，
     * 并把 meta 里的属性定义上去。父级不受影响。
     */
    target.extend = function extend(meta) {
      const child = Object.create(ctx);
      if (meta) {
        for (const key of Object.keys(meta)) {
          // 用 defineProperty 而不是赋值 ——
          // 赋值会走代理的 set 钩子，未声明的名字会被丢进代理 target，
          // 那会污染父级上下文。
          try {
            Object.defineProperty(child, key, {
              value: meta[key],
              writable: true,
              enumerable: true,
              configurable: true,
            });
          } catch (e) {
            /* 只读属性 */
          }
        }
      }
      return child;
    };

    /**
     * 定义一个计算属性。
     *
     * 对应 cordis 的 `ctx.accessor(name, { get, set })`
     * （src/reflect.ts 第 348 行）。
     *
     * ============ 用途 ============
     *
     * 让 ctx 上的某个属性由 get/set 钩子算出来 ——
     * 比如「当前正在被哪个插件调用」这类运行时状态，
     * 或者「某个服务的当前值」这种不该缓存的派生量。
     *
     * accessor 是**声明式**的：读 `ctx.foo` 时调 get，而不是拿一个快照。
     */
    target.accessor = function accessor(name, options) {
      const def = {
        name,
        get: typeof options?.get === 'function' ? options.get : null,
        set: typeof options?.set === 'function' ? options.set : null,
      };
      accessors.set(name, def);
      // accessor 必须在「声明过的名字」里 —— 否则代理会把它当未声明的名字抛错。
      declared.add(name);
      return () => {
        accessors.delete(name);
      };
    };

    /**
     * 把服务的成员直接摊到 ctx 上。
     *
     * 对应 cordis 的 `ctx.mixin(source, mixins)`
     * （src/reflect.ts 第 366 行）。
     *
     * 常见用法：`ctx.mixin('llm', ['listModels'])` ——
     * 之后 `ctx.listModels(...)` 就能直接调，不用写 `ctx.llm.listModels(...)`。
     */
    target.mixin = function mixin(source, mixins) {
      const entries = Array.isArray(mixins)
        ? mixins.map((key) => [key, key])
        : Object.entries(mixins);
      const disposers = [];
      for (const [key, value] of entries) {
        accessors.set(value, {
          name: value,
          get() {
            const svc = ctx[source];
            return svc ? svc[key] : undefined;
          },
          set(v) {
            const svc = ctx[source];
            if (svc) svc[key] = v;
          },
        });
        declared.add(value);
        disposers.push(() => accessors.delete(value));
      }
      return () => {
        for (const d of disposers) d();
      };
    };

    /**
     * 隔离一个服务的作用域。
     *
     * cordis 的 `ctx.isolate(name, label)` 让子上下文内该服务的读写
     * 走独立作用域 —— 同一插件在两个隔离域里可以各跑一份互不干扰。
     *
     * 手机端没有多实例场景，这里提供**语义等价的基础实现**：
     * 子上下文有自己的服务存储，提供同名服务不与父级冲突。
     */
    target.isolate = function isolate(name, label) {
      const child = Object.create(ctx);
      const scopeName = label ? `isolate:${String(label)}` : `isolate:${String(name)}`;
      // 隔离域有自己的存储 —— 同名服务在这里 provide 不与父级冲突。
      const local = new Map();
      child.__isolateScope = scopeName;
      child.provide = function provideInIsolate(n, value) {
        local.set(String(n), value);
        flushAll();
        return () => {
          local.delete(String(n));
          flushAll();
        };
      };
      // 隔离域里读服务：先看本域，再看父级。
      child.get = function getInIsolate(n) {
        const key = String(n);
        if (local.has(key)) return local.get(key);
        return resolveService(key);
      };
      return child;
    };

    /**
     * 给子上下文里的某个服务附加拦截配置。
     *
     * cordis 的 `ctx.intercept(name, config)` 让子上下文启动的插件
     * 看到合并后的服务配置。父级不受影响。
     */
    target.intercept = function intercept(name, config) {
      const child = Object.create(ctx);
      // __intercept 是内部元信息 —— 不能从代理上读（代理会按
      // 「未声明的服务」抛错），要从 target 上取。
      const base = target.__intercept || null;
      const configs = Object.create(base);
      configs[name] = config;
      child.__intercept = configs;
      return child;
    };

    // ── 上下文图上的把手（cordis src/context.ts 第 20-32 行）──────────────
    //
    // 桌面版 ctx API 目录第 7 组：
    // `ctx.root / ctx.scope / ctx.fiber / ctx.registry / ctx.reflect
    //  / ctx.events / ctx.logger`

    /** 根上下文。 */
    target.root = rootContext();
    /** 当前作用域（桌面版叫 scope，我们对应插件的 fiber 作用域）。 */
    target.scope = scope;
    /** 插件注册表。 */
    target.registry = registry;
    /** 反射层。 */
    target.reflect = reflectService;
    /** 事件总线。 */
    target.events = events;
    /** 日志器。 */
    target.logger = logger;

    /**
     * 计时器助手。
     *
     * 对应 `@deepseek-ai/cordis-plugin-timer`（桌面版 ctx API 目录第 8 组）。
     * 那是个独立插件（147 行），但它**只依赖 ctx.effect** ——
     * 我们已经有，所以直接实现最省事。
     *
     * ============ 为什么值得实现 ============
     *
     * 之前 P0-A 落地后，读 `ctx.interval` 会抛错 ——
     * 而 `dsh-our-free-model` 正是被这个坑过一次才把定时器链重写的。
     * 别的插件读 `ctx.interval` 会遇到同样的事。
     * 我们把它实现出来，那些插件就不用再绕路了。
     */
    target.timer = createTimerService(target);
    target.timeout = target.timer.timeout.bind(target.timer);
    target.interval = target.timer.interval.bind(target.timer);
    target.throttle = target.timer.throttle.bind(target.timer);
    target.debounce = target.timer.debounce.bind(target.timer);
    target.setTimeout = target.timer.setTimeout.bind(target.timer);
    target.setInterval = target.timer.setInterval.bind(target.timer);

    // ── fiber ───────────────────────────────────────────────────────────────
    //
    // fiber 挂在 ctx 上 —— 插件用 `ctx.fiber?.entry?.options?.id` 拿自己的 id，
    // 用 `ctx.fiber?.runtime?.callback` 拿热重载需要的插件身份。

    fiber.uid = registry.counter;
    fiber.parent = rootContext();
    fiber.scope = scope;
    fiber.state = FiberState.ACTIVE;
    fiber.isActive = () => fiber.state === FiberState.ACTIVE;
    fiber.stateName = () => stateName(fiber.state);
    target.fiber = fiber;

    /**
     * 插件卸载时清理这个 ctx 下的所有 effect。
     * 逆序执行 —— 与 cordis 的 fiber 一致（src/fiber.ts dispose()）。
     */
    target.__scope = scope;
    target.__dispose = function dispose() {
      return fiber.dispose();
    };
    target.__fiber = fiber;

    return ctx;
  }

  /** 根上下文 —— 只有一个，所有 fiber 的 parent 都指向它。 */
  let rootCtx = null;
  function rootContext() {
    if (rootCtx) return rootCtx;
    rootCtx = Object.create(null);
    // 根上下文带全套容器能力（对应 cordis 的 root context）
    rootCtx.get = (name) => resolveService(String(name));
    rootCtx.set = (name, value) => provided.set(String(name), value);
    rootCtx.provide = (name, value) => provide(String(name), value);
    rootCtx.on = events.on;
    rootCtx.once = events.once;
    rootCtx.emit = events.emit;
    rootCtx.off = events.off;
    rootCtx.parallel = events.parallel;
    rootCtx.serial = events.serial;
    rootCtx.bail = events.bail;
    rootCtx.waterfall = events.waterfall;
    rootCtx.registry = registry;
    rootCtx.reflect = reflectService;
    rootCtx.events = events;
    rootCtx.logger = logger;
    rootCtx.root = rootCtx;
    /**
     * 当前正在执行 apply 的插件作用域。
     *
     * 宿主服务（settings / web / commands）注册东西时要挂在**调用者**
     * 的 fiber 上 —— 插件卸载，它注册的命名空间/provider/命令跟着消失。
     * 服务对象是全局的，拿不到插件 ctx，只能从这里问。
     */
    rootCtx.currentScope = currentScope;
    /** 把清理动作挂到当前活跃的插件作用域（没有就返回 false）。 */
    rootCtx.onDispose = onDispose;
    return rootCtx;
  }

  /**
   * 加载一个子插件（`ctx.plugin` 的实现）。
   *
   * @param {object|Function} pluginShape
   * @param {*} config
   * @param {object} parentFiber
   * @returns {object} 可 await 的 fiber 句柄
   */
  function loadChildPlugin(pluginShape, config, parentFiber) {
    const apply =
      typeof pluginShape === 'function'
        ? pluginShape
        : pluginShape && typeof pluginShape.apply === 'function'
          ? pluginShape.apply
          : null;
    if (!apply) {
      throw new Error(
        'invalid plugin, expect function or object with an "apply" method, received ' +
          typeof pluginShape
      );
    }
    const inject = Array.isArray(pluginShape.inject)
      ? pluginShape.inject.slice()
      : DEFAULT_SERVICES.slice();

    const childCtx = contextFor(inject, {
      id: pluginShape.id || pluginShape.name || 'plugin',
      name: pluginShape.name,
      apply,
      config,
    });
    const childFiber = childCtx.__fiber;

    // 挂到运行时表里（同一插件多次加载共用一个 runtime）
    const key = apply;
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = {
        name: pluginShape.name,
        callback: key,
        fibers: [],
        Config: pluginShape.Config,
      };
      runtimes.set(key, runtime);
    }
    childFiber.runtime = runtime;
    runtime.fibers.push(childFiber);
    childFiber.parent = parentFiber ? parentFiber.ctx || parentFiber : rootContext();

    const handle = {
      ctx: childCtx,
      uid: childFiber.uid,
      fiber: childFiber,
      then(onFulfilled, onRejected) {
        return childFiber.await().then(onFulfilled, onRejected);
      },
      await: () => childFiber.await(),
      dispose: () => childFiber.dispose(),
    };

    // 立刻跑 apply
    const restore = beginScope(childCtx.__scope);
    try {
      const result = apply(childCtx, config);
      if (typeof result === 'function') childFiber._pluginDisposer = result;
    } catch (e) {
      childFiber._error = e;
      childFiber.state = FiberState.FAILED;
      disposeScope(childCtx.__scope);
      settleFiber(childFiber, e);
      throw e;
    } finally {
      restore();
    }

    settleFiber(childFiber, null);
    return handle;
  }

  /** 兑现一个 fiber 的等待者。 */
  function settleFiber(fiber, error) {
    const waiters = fiber._waiters || [];
    fiber._waiters = [];
    for (const w of waiters) {
      if (error) w.reject(error);
      else w.resolve(fiber);
    }
  }

  /**
   * 缺失服务的占位。
   *
   * ============ 什么时候会给占位 ============
   *
   * 插件**声明了**某个服务，但宿主还没提供它。
   * （压根没声明的服务不走这里 —— 那由代理直接抛错，语义更重。）
   *
   * cordis 的原行为是：这种情况 fiber 停在 PENDING，压根不启动。
   * 我们在 `applyPlugin` 里已经实现了那条（插件整体挂起），
   * 但 `ctx.inject(deps, cb)` 内部的能力分层是另一回事 ——
   * 那段回调缺服务时**不执行**，但插件其余部分照常跑，
   * 所以插件有可能在回调之外拿到某个已声明的服务。
   *
   * 占位对象的意义：**访问它的方法时才报错**，而不是拿到 undefined
   * 后在几百行之外以无关的错误崩掉。报错信息要说清楚是手机上没有这个能力。
   */
  function missingService(name) {
    const target = {};
    const handler = {
      get(_t, prop) {
        // 符号属性（Symbol.toStringTag、Symbol.iterator…）是运行时探测用的，
        // 不是插件真的在用服务 —— 不能在这里抛错，否则一个无害的
        // console.log 就能把插件炸掉。
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then' || prop === 'toJSON') return undefined;
        if (prop === '__dshMissing') return name;
        if (prop === 'inspect' || prop === 'toString') {
          return () => `[缺失服务 ${name}]`;
        }
        throw new Error(
          `宿主没有提供服务「${name}」的「${String(prop)}」能力。` +
            `这个插件在手机上可能无法正常工作（桌面上由 DSH 主程序提供）。`
        );
      },
      // 赋值要放行：插件可能给服务挂自己的字段。
      set(_t, prop, value) {
        target[prop] = value;
        return true;
      },
      has(_t, prop) {
        return prop in target;
      },
    };
    return new Proxy(target, handler);
  }

  /** 逆序执行一批 disposer，一个抛错不影响其它。 */
  function runDisposers(items) {
    for (const item of items) {
      try {
        item();
      } catch (e) {
        rootLog('warn', '', `清理失败：${e && e.message ? e.message : e}`);
      }
    }
  }

  /** 清理一个作用域的全部 disposer（逆序）。 */
  function disposeScope(scope) {
    if (!scope || scope.disposed) return;
    scope.disposed = true;
    const items = scope.disposers.splice(0).reverse();
    runDisposers(items);
  }

  /**
   * 当前正在 apply 的插件作用域。
   *
   * ============ 为什么需要它 ============
   *
   * 桌面版的 `llm` 服务是 cordis `Service` 的子类，它内部的
   * `this.ctx.effect(...)` 绑在**调用方插件的 fiber** 上 ——
   * 所以「插件卸载 → 注册随之消失」是自动的。
   *
   * 手机端的 `llm` 是宿主提供的单例，它不知道是谁在调自己。
   * 而真实插件 `dsh-our-free-model` 调用 `registerConfigurableProviders`
   * 之后**把句柄丢了**（源码第 424 行：`ctx.llm.registerConfigurableProviders?.([...])`
   * —— 没有赋值），它指望的是「卸载自动回收」。
   *
   * 所以这里暴露一个「当前作用域」，让宿主服务能把自己登记的东西
   * 挂到插件的卸载钩子上。
   */
  let activeScope = null;

  /** 当前作用域（无插件在 apply 时为 null）。 */
  function currentScope() {
    return activeScope;
  }

  /**
   * 进入一个插件作用域，返回一个恢复函数。
   * 供 applyPlugin 在调用 apply 期间设置用。
   */
  function beginScope(scope) {
    const prev = activeScope;
    activeScope = scope || null;
    return () => {
      activeScope = prev;
    };
  }

  /**
   * 登记一个「卸载时该做什么」。
   *
   * 宿主服务用它把自己在插件作用域里登记的资源挂上清理钩子。
   *
   * @param {Function} fn 清理函数
   */
  function onDispose(fn) {
    if (activeScope && typeof activeScope.onDispose === 'function') {
      activeScope.onDispose(fn);
      return true;
    }
    return false;
  }

  const container = {
    contextFor,
    provide,
    provided,
    logger,
    events,
    registry,
    reflect: reflectService,
    root: rootContext(),
    /**
     * deps 里的服务是否全部就绪。
     *
     * 供 applyPlugin 判断「插件整体能不能启动」。
     */
    depsReady,
    /**
     * 把一个依赖未齐的插件挂起，等服务到齐后自动启动。
     *
     * 对应 cordis 里 fiber 停在 PENDING、服务到齐后自动激活的语义
     * （src/fiber.ts 的 _refresh / _setEpoch）。
     *
     * @param {object} plugin { id, name, version, apply, inject }
     * @returns {object} 带 dispose() 的句柄
     */
    deferPlugin(plugin) {
      const deps = Array.isArray(plugin.inject) ? plugin.inject.slice() : [];
      const handle = {
        pending: true,
        started: false,
        disposer: null,
        dispose() {
          handle.pending = false;
          handle.started = false;
          if (handle.disposer) handle.disposer();
        },
      };
      pendingPlugins.push({ plugin, deps, handle });
      flushPendingPlugins();
      return handle;
    },
    // 当前作用域（供宿主服务挂卸载钩子）
    currentScope,
    onDispose,
    __beginScope: beginScope,
    // 容器本身也带事件能力 —— 对应 cordis 的根 context。
    // 宿主服务（比如 llm）拿的是容器，要从这里发事件。
    on: events.on,
    once: events.once,
    emit: events.emit,
    off: events.off,
    parallel: events.parallel,
    serial: events.serial,
    bail: events.bail,
    waterfall: events.waterfall,
    // 容器自己也能加载插件 —— 加载是容器的本职，
    // 外部（插件宿主）不该自己去拼 ctx 再调 apply。
    apply(plugin) {
      return applyPlugin(this, plugin);
    },
  };
  selfContainer = container;
  return container;
}

/**
 * 计时器服务 —— 对应 `@deepseek-ai/cordis-plugin-timer`。
 *
 * 只依赖 `ctx.effect`（所有计时器都随 fiber 卸载而清理），
 * 所以可以直接实现。
 */
function createTimerService(ctx) {
  function timeout(callback, delay) {
    if (typeof callback === 'function') {
      // disposer 要先声明 —— setTimeout 的回调里会引用它，
      // 若用 const 声明在后面，回调先跑就会撞上 TDZ。
      let dispose = () => {};
      dispose = ctx.effect(() => {
        const timer = setTimeout(() => {
          dispose();
          callback();
        }, delay);
        return () => clearTimeout(timer);
      }, 'ctx.timeout()');
      return dispose;
    }
    // 无回调 → 返回一个 delay 毫秒后兑现的 promise
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const dispose = ctx.effect(() => {
      const timer = setTimeout(resolveFn, delay);
      return () => {
        clearTimeout(timer);
        rejectFn(new Error('Context has been disposed'));
      };
    }, 'ctx.timeout()');
    return promise.finally(() => {
      try {
        dispose();
      } catch (e) {
        /* 忽略 */
      }
    });
  }

  function interval(callback, delay) {
    if (typeof callback === 'function') {
      return ctx.effect(() => {
        const timer = setInterval(callback, delay);
        return () => clearInterval(timer);
      }, 'ctx.interval()');
    }
    // 无回调 → 返回异步迭代器
    let done = null;
    let nextTask = null;
    const dispose = ctx.effect(() => {
      const timer = setInterval(() => {
        if (nextTask) nextTask.resolve({ done: false, value: undefined });
      }, delay);
      return () => {
        clearInterval(timer);
        if (done) return;
        done = { kind: 'throw', reason: new Error('Context has been disposed') };
        if (nextTask) nextTask.reject(done.reason);
      };
    }, 'ctx.interval()');

    const iterator = {
      next() {
        if (!done) {
          nextTask = {};
          nextTask.promise = new Promise((resolve, reject) => {
            nextTask.resolve = resolve;
            nextTask.reject = reject;
          });
          return nextTask.promise;
        }
        if (done.kind === 'return') {
          return Promise.resolve({ done: true, value: done.value });
        }
        return Promise.reject(done.reason);
      },
      return(value) {
        if (!done) done = { kind: 'return', value };
        if (nextTask) nextTask.resolve({ done: true, value });
        dispose();
        return Promise.resolve({ done: true, value });
      },
      throw(reason) {
        if (!done) done = { kind: 'throw', reason };
        if (nextTask) nextTask.reject(reason);
        dispose();
        return Promise.resolve({ done: false, value: undefined });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  }

  /** 节流 —— 返回一个带 dispose 的包装函数。 */
  function throttle(callback, delay) {
    let lastCall = -Infinity;
    let timer = null;
    const dispose = ctx.effect(
      () => () => {
        timer = null;
      },
      'ctx.throttle()'
    );
    const wrapper = (...args) => {
      const now = Date.now();
      const remaining = delay - (now - lastCall);
      if (remaining <= 0) {
        lastCall = now;
        callback(...args);
      } else if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          lastCall = Date.now();
          callback(...args);
        }, remaining);
      }
    };
    wrapper.dispose = dispose;
    return wrapper;
  }

  /** 防抖 —— 返回一个带 dispose 的包装函数。 */
  function debounce(callback, delay) {
    let timer = null;
    const dispose = ctx.effect(
      () => () => {
        if (timer) clearTimeout(timer);
        timer = null;
      },
      'ctx.debounce()'
    );
    const wrapper = (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        callback(...args);
      }, delay);
    };
    wrapper.dispose = dispose;
    return wrapper;
  }

  return {
    timeout,
    interval,
    throttle,
    debounce,
    setTimeout: timeout,
    setInterval: interval,
  };
}

/**
 * 加载一个插件。
 *
 * 加载失败（apply 抛错）**不影响其它插件** —— 每个插件独立成败。
 *
 * @param {object} container  容器
 * @param {object} plugin     { id, name, version, apply, inject }
 * @returns {object} { ok, error, id, disposer, fiber }
 */
function applyPlugin(container, plugin) {
  const id = String(plugin.id || 'unknown');
  let ctx = null;
  try {
    // ============ 依赖没齐 → fiber 停在 PENDING，apply 不执行 ============
    //
    // 这是 cordis 的核心语义（src/fiber.ts 第 314-318 行）：
    // 插件声明的 inject 服务没全部就绪时，fiber **不会启动**，
    // apply 压根不被调用。服务到齐后它才自动启动。
    //
    // ============ 为什么必须这么做 ============
    //
    // DSH 生态的纪律第二条明写（真实插件的 cordis.patch.yml）：
    //
    //   「inject 只声明确定存在的服务 —— 申明一个从未被 provide 的服务
    //     会让 fiber 停在 PENDING，从而拖累整棵插件树。」
    //
    // 反过来看：如果我们无视这一点、照样跑 apply，插件就会拿着一个
    // 占位对象往下走，在几百行之后以一个完全无关的错误崩掉。
    // 「明确不启动」比「假装启动然后炸掉」诚实得多。
    //
    // 注意这与 `ctx.inject(deps, cb)`（插件内部的能力分层）是两回事：
    // 那是插件**自己**声明的可选能力，缺了就跳过那一段；
    // 这里是插件**整体**的依赖，缺了整个插件都不启动。
    const inject = Array.isArray(plugin.inject) ? plugin.inject : [];
    if (!container.depsReady(inject)) {
      const pending = container.deferPlugin(plugin);
      return {
        ok: true,
        id,
        pending: true,
        disposer: () => pending.dispose(),
        // 把挂起句柄交出去 —— 宿主靠它知道「后来到底启动了没有」。
        // handle.pending / handle.started 会随服务到齐而变化。
        handle: pending,
        fiber: null,
        ctx: null,
      };
    }

    ctx = container.contextFor(plugin.inject, plugin);
    // 让宿主服务（如 llm）知道自己正被哪个插件调用 ——
    // 它们据此把注册挂到插件的卸载钩子上。
    const restore = container.__beginScope ? container.__beginScope(ctx.__scope) : null;
    let result;
    try {
      result = plugin.apply(ctx);
    } finally {
      if (restore) restore();
    }
    // apply 可以是同步的，也可以返回一个函数（cordis 的 disposer）。
    // 返回函数的话，视为「卸载时该做什么」。
    const fiber = ctx.__fiber;
    if (typeof result === 'function') {
      fiber._pluginDisposer = result;
    }
    return {
      ok: true,
      id,
      disposer: () => {
        fiber.dispose();
      },
      fiber,
      ctx,
    };
  } catch (e) {
    // 纪律 1：apply 抛错不能让整棵树塌掉。
    // 但已经注册的 effect 要清理掉 —— 否则定时器会一直跑。
    if (ctx && typeof ctx.__dispose === 'function') {
      try {
        ctx.__dispose();
      } catch (e2) {
        /* 忽略 */
      }
    }
    return { ok: false, id, error: String((e && e.message) || e) };
  }
}

module.exports = {
  createContainer,
  applyPlugin,
  createEventBus,
  isBailed,
  FiberState,
  DEFAULT_SERVICES,
  INTRINSIC_SERVICES,
};
