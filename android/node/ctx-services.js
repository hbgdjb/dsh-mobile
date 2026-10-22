'use strict';

/**
 * 宿主提供给插件的服务。
 *
 * ============ 为什么要有这一层 ============
 *
 * cordis 插件通过 `ctx.<服务名>` 使用宿主能力。手机上没有 DSH 主程序，
 * 所以这些服务得由我们自己提供 —— 不提供的话插件加载了但一调用就炸。
 *
 * 这里提供的服务按「手机上真的能实现」来选：
 *
 *   logger            日志（实现）
 *   tools             注册 AI 工具（实现 —— 这是插件生态的落点）
 *   slots             UI 插槽（部分实现：记录注册，渲染交给 WebView）
 *   sessions          会话（部分实现：单会话模型）
 *   modelDirectories  模型目录（实现：给出工作区路径）
 *   remote            远程调用（占位）
 *
 * 明确**不**实现的：那些需要桌面版宿主才有意义的服务
 * （如完整的 slots 渲染、React 组件树）。给它们占位，
 * 插件真用到时给出明确错误，而不是静默返回 undefined。
 */

/**
 * 构造宿主服务表。
 *
 * ============ 注意：tools 不在这里 ============
 *
 * 工具服务由插件宿主（plugin-host）独占提供 —— 因为工具的 handler
 * 是插件的闭包，只有加载了插件的进程能执行它。
 * 这里如果再造一份，两份表会各记各的，插件注册到的那份
 * 根本没人能调用。
 *
 * @param {object} opts
 *   opts.workspace  工作区根目录
 *   opts.log        日志函数 (level, scope, message)
 */
function createServices(opts) {
  const workspace = opts.workspace;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  /**
   * UI 插槽。
   *
   * 桌面版的 slots 是 React 组件树，手机上不是 —— 但插件的**注册行为**
   * 仍然可以记录下来并上报，让页面知道「有个插件想在这挂个控件」。
   *
   * register() 返回一个 id，插件拿它做后续操作（unregister 等）。
   */
  const slots = {
    _registry: new Map(),
    /**
     * 注入一个插槽提供者。
     * @param {string} name  插槽名
     * @param {Function} fn  返回注册函数的工厂
     */
    inject(name, fn) {
      if (typeof fn !== 'function') return null;
      try {
        const reg = fn();
        if (typeof reg === 'function') return reg;
        return null;
      } catch (e) {
        log('warn', `插槽 ${name} 的注入函数出错：${e && e.message}`);
        return null;
      }
    },
    /**
     * 注册一个插槽。
     * @returns {string} 注册 id
     */
    register(def, component) {
      const id = (def && def.id) || 'slot-' + (slots._registry.size + 1);
      slots._registry.set(id, {
        name: (def && def.name) || id,
        id,
        order: (def && def.order) || 0,
        label: (def && def.label) || '',
        component: component || null,
        registeredAt: Date.now(),
      });
      log('info', `插槽已注册：${id}`);
      return id;
    },
    /** 注销一个插槽。 */
    unregister(id) {
      return slots._registry.delete(id);
    },
    /** 当前已注册的插槽清单（供页面展示）。 */
    list() {
      return Array.from(slots._registry.values()).map((s) => ({
        id: s.id,
        name: s.name,
        order: s.order,
        label: typeof s.label === 'function' ? s.label() : s.label,
      }));
    },
  };

  /**
   * 会话。
   *
   * 桌面版是多会话模型（sessions.list / sessions.current）。
   * 手机上是单会话 —— 但接口形状保持一致，插件不用改代码。
   */
  const sessions = {
    _current: { id: 'default', title: '当前会话' },
    list() {
      return [sessions._current];
    },
    current() {
      return sessions._current;
    },
    get(id) {
      return id === sessions._current.id ? sessions._current : null;
    },
  };

  /**
   * 模型目录。
   *
   * 桌面版用来定位模型配置文件。手机上给工作区路径，
   * 插件要读配置至少有个地方可读。
   */
  const modelDirectories = {
    directoryFor(sessionId) {
      return workspace;
    },
    list() {
      return [workspace];
    },
  };

  /**
   * 远程调用。
   *
   * 桌面版用它连接远端 DSH 实例。手机上不实现 ——
   * 但提供 subscribe 之类的空实现，让插件的启动流程不炸。
   */
  const remote = {
    session: {
      // 子服务占位：真要用会给出明确错误
      _missing: true,
    },
    connect() {
      throw new Error('手机端不支持连接远端 DSH 实例');
    },
    subscribe() {
      return () => {};
    },
  };

  return { slots, sessions, modelDirectories, remote };
}

module.exports = { createServices };
