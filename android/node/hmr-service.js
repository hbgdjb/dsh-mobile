'use strict';

/**
 * ctx.hmr —— 给插件的热重载接口。
 *
 * ============ 为什么是宿主提供，而不是插件自带 ============
 *
 * 桌面版的 `ctx.loader` / `ctx.hmr` 来自两个独立 npm 包
 * （`@deepseek-ai/cordis-plugin-loader` / `-hmr`）。
 * 它们一个依赖需要编译的原生 addon，一个依赖 chokidar ——
 * 手机端的 npm 安装不编译原生模块，装上必然跑不起来。
 *
 * 但热重载本身是我们自己实现的（见 plugin-reload.js），
 * 所以顺手把它包成一个服务给插件用，是水到渠成的事。
 *
 * ============ 语义照谁 ============
 *
 * 照 cordis：插件必须在 `inject` 里声明 `'hmr'` 才拿得到这个服务。
 * 所以它**不进** cordis-lite 的 INTRINSIC_SERVICES，
 * 而是走 `container.provide('hmr', svc)` ——
 * 不声明就不给，和 settings / web / commands 一个规矩。
 *
 * ============ 权限边界 ============
 *
 * 默认**只允许重载自己**。
 *
 * 理由很实在：热重载会销毁并重建 fiber。如果任何插件都能重载别的插件，
 * 一个第三方插件就能反复把宿主服务（settings / web / commands）的注册
 * 掀掉再装上 —— 那等于给了任意插件一个「干扰其它插件」的能力。
 *
 * 跨插件重载留给宿主配置（`allowOthers`），默认关闭。
 */

/**
 * @param {object} opts
 * @param {object} opts.ctx 根上下文（用来拿 currentScope 和 emit）
 * @param {object} opts.host 插件宿主（提供 reloadOne）
 * @param {boolean} [opts.allowOthers] 是否允许跨插件重载，默认 false
 * @returns {object} hmr 服务
 */
function createHmrService(opts) {
  const ctx = (opts && opts.ctx) || null;
  const host = (opts && opts.host) || null;
  const allowOthers = Boolean(opts && opts.allowOthers);

  /** 当前调用者的插件 id。 */
  function selfId() {
    // 工具的 handler 是在 apply 之后被调用的 ——
    // 那时 cordis-lite 的活动作用域已经恢复成 null，
    // currentScope() 拿不到任何东西。
    // 宿主在调用工具期间记了归属，从那儿拿。
    if (host && typeof host.callerId === 'function') {
      const id = host.callerId();
      if (id) return String(id);
    }
    try {
      const scope = ctx && typeof ctx.currentScope === 'function' ? ctx.currentScope() : null;
      return scope && scope.pluginId ? String(scope.pluginId) : '';
    } catch (e) {
      return '';
    }
  }

  /** 发事件。 */
  function emit(name, data) {
    try {
      if (ctx && typeof ctx.emit === 'function') ctx.emit(name, data);
    } catch (e) {
      /* 事件发不出去不影响重载本身 */
    }
  }

  async function runReload(id) {
    if (!host || typeof host.reloadOne !== 'function') {
      throw new Error('当前运行时没有热重载能力');
    }
    const r = await host.reloadOne(id);
    if (r && r.ok) emit('hmr/plugin:reloaded', { id });
    else emit('hmr/plugin:reload-failed', { id, error: (r && r.error) || '重载失败' });
    return r;
  }

  return {
    /**
     * 重载调用者自己。
     *
     * 插件改了自己的代码，想立刻生效时调它。
     *
     * @returns {Promise<object>} {ok, mode, error?, restored?}
     */
    async reloadSelf() {
      const id = selfId();
      if (!id) throw new Error('拿不到调用者身份，无法重载自己');
      return await runReload(id);
    },

    /**
     * 重载指定插件。
     *
     * 默认只能重载自己 —— 传别的 id 会报错。
     *
     * @param {string} [id] 插件 id；不传就是自己
     * @returns {Promise<object>}
     */
    async reload(id) {
      const target = String(id || '');
      const self = selfId();
      if (!target) return await runReload(self);
      if (target !== self && !allowOthers) {
        throw new Error('只能重载自己（宿主未开放跨插件重载）');
      }
      return await runReload(target);
    },

    /**
     * 订阅重载事件。
     *
     * 事件名：
     *   · `hmr/plugin:reloaded`     —— 某个插件重载成功
     *   · `hmr/plugin:reload-failed` —— 某个插件重载失败
     *
     * @param {string} name 事件名
     * @param {Function} cb 回调
     * @returns {Function} 退订函数
     */
    on(name, cb) {
      if (!ctx || typeof ctx.on !== 'function') return () => {};
      return ctx.on(String(name || ''), cb);
    },
  };
}

module.exports = { createHmrService };
