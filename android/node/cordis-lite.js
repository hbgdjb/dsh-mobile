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
 * 但插件真正用到的服务其实很少 —— 从已知的 DSH 插件看，
 * 就是 logger / slots / sessions / modelDirectories / remote 这几类。
 *
 * 所以这里实现一个**语义正确的迷你版**：
 *   · 服务用 provide 注册，取用用 inject 声明
 *   · 声明了但宿主没提供 → 给一个"访问即报错"的占位，
 *     **而不是让整个插件加载失败**
 *   · apply() 抛错 → 记为该插件失败，不影响别的插件
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
 * 构造一个容器。
 *
 * @param {object} opts
 *   opts.services  额外提供的服务表 { name: value }
 *   opts.log       日志函数 (level, scope, message)
 */
function createContainer(opts) {
  const options = opts || {};
  const provided = new Map();

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
   * 为一个插件构造 ctx。
   *
   * 只放它 inject 声明过的服务（加上 logger —— 它是默认服务，
   * 真实 cordis 里 logger 也是通过 inject 拿的，但给不给差别不大，
   * 这里给上以免插件因为漏声明而拿不到）。
   *
   * 声明的名字可以是**点号路径**（"remote.session"）：那表示
   * 「remote 这个服务里的 session 子服务」。DSH 生态里确实有这种用法，
   * 比如 dsh-codex-effort-slider 声明
   * ["slots","sessions","modelDirectories","remote","remote.session"]。
   *
   * @param {string[]} inject 插件声明的服务名
   */
  function contextFor(inject) {
    const ctx = Object.create(null);
    const wanted = Array.isArray(inject) ? inject.slice() : DEFAULT_SERVICES.slice();

    for (const name of wanted) {
      const parts = name.split('.');
      const resolved = resolveService(name);

      if (parts.length === 1) {
        // 顶层服务：给真服务，或给缺失占位
        ctx[parts[0]] = resolved !== undefined ? resolved : missingService(parts[0]);
        continue;
      }

      // 点号路径：父服务要先落在 ctx 上
      const parentName = parts[0];
      if (ctx[parentName] === undefined) {
        const parent = provided.get(parentName);
        ctx[parentName] = parent !== undefined ? parent : missingService(parentName);
      }
      const parent = ctx[parentName];
      // 末梢服务挂不上去（比如父服务是个 Proxy 或不可写对象）就跳过 ——
      // 插件真用到它时会在访问处拿到明确的错误，不会静默拿到错东西。
      if (resolved === undefined) continue;
      try {
        parent[parts[1]] = resolved;
      } catch (e) {
        // 父服务不可写（frozen 或 getter）—— 放弃这一项
      }
    }

    // logger 兜底
    if (!ctx.logger) ctx.logger = logger;

    // 内在服务：声明与否都得到（前提是宿主确实提供了）
    for (const name of INTRINSIC_SERVICES) {
      if (ctx[name] === undefined && provided.has(name)) {
        ctx[name] = provided.get(name);
      }
    }

    return ctx;
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

  /** 缺失服务的占位。 */
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

  /** 注册一个新服务（供运行时后续扩展）。 */
  function provide(name, value) {
    provided.set(name, value);
  }

  return {
    contextFor,
    provide,
    provided,
    logger,
    // 容器自己也能加载插件 —— 加载是容器的本职，
    // 外部（插件宿主）不该自己去拼 ctx 再调 apply。
    apply(plugin) {
      return applyPlugin(this, plugin);
    },
  };
}

/**
 * 加载一个插件。
 *
 * 加载失败（apply 抛错）**不影响其它插件** —— 每个插件独立成败。
 *
 * @param {object} container  容器
 * @param {object} plugin     { id, name, version, apply, inject }
 * @returns {object} { ok, error, id }
 */
function applyPlugin(container, plugin) {
  const id = String(plugin.id || 'unknown');
  try {
    const ctx = container.contextFor(plugin.inject);
    const result = plugin.apply(ctx);
    // apply 可以是同步的，也可以返回一个函数（cordis 的 disposer）。
    // 返回函数的话，视为「卸载时该做什么」。
    if (typeof result === 'function') {
      return { ok: true, id, disposer: result };
    }
    return { ok: true, id };
  } catch (e) {
    // 纪律 1：apply 抛错不能让整棵树塌掉。
    return { ok: false, id, error: String((e && e.message) || e) };
  }
}

module.exports = { createContainer, applyPlugin, DEFAULT_SERVICES };
