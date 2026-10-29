'use strict';

/**
 * 界面宿主服务 —— 插件声明界面，宿主用原生 DOM 画出来。
 *
 * ============ 它解决的是什么问题 ============
 *
 * 桌面版插件写 `ctx.slots.register(def, Component)`，Component 是
 * React 组件函数。手机上没有 React，也没有「同一个进程」这件事：
 * 插件跑在 libnode 里，界面跑在 WebView 里，中间隔着一条 TCP 通道。
 *
 * 函数过不去，能过去的只有 JSON。所以这里把「注册组件」换成
 * 「挂载一棵界面树」：
 *
 *   ctx.slots.mount('composer.toolbar', {
 *     type: 'row',
 *     children: [{ type: 'button', label: '润色', action: 'polish' }],
 *   });
 *
 * 树的形状在 `scripts/ui-host.js` 里被翻译成原生元素。
 * 插件的交互回来走 `ctx.slots.onAction(id, fn)`：
 *
 *   ctx.slots.onAction(id, async (action, value) => {
 *     if (action !== 'polish') return null;
 *     return { type: 'text', text: '已润色' };  // 返回树 = 局部更新
 *   });
 *
 * ============ 为什么不让插件直接操作 DOM ============
 *
 * 插件是第三方代码。给它 DOM 等于给它宿主的凭据、会话内容、
 * 以及往任意位置塞东西的能力 —— 那和把它放进宿主进程没区别。
 * 声明式树把它的能力限死在「我这块卡片里能显示什么」。
 *
 * ============ 权限 ============
 *
 * 和工具注册同一套规矩：清单里写了 `permissions: ["ui.slot"]`
 * 才给挂。没写就明确报错 —— 静默不显示是最难查的失败方式。
 */

/** 挂载点白名单。和 WebView 侧的 SLOT_NAMES 必须一致。 */
const SLOT_NAMES = ['shell.overlay', 'composer.toolbar', 'sidebar.footer', 'settings.section'];

/** 一个插件最多挂几个界面。防止插件在 apply 里循环挂满整个页面。 */
const MAX_PER_PLUGIN = 12;

/** 界面树的字符串上限（跟 WebView 侧对齐，超了先截断再发，省通道带宽）。 */
const MAX_TEXT = 2000;

/**
 * 构造 slots 服务。
 *
 * @param {object} opts
 *   opts.ctx    容器根上下文（用来判断「现在是谁在 apply」）
 *   opts.host   插件宿主（读清单权限）
 *   opts.log    日志 (level, scope, message)
 *   opts.send   推送给页面的函数 (event, data)
 * @returns {object} slots 服务
 */
function createUiService(opts) {
  const ctx = opts.ctx || null;
  const host = opts.host || null;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const send = typeof opts.send === 'function' ? opts.send : () => {};

  /** id → { id, slot, pluginId, pluginName, order, tree, handlers } */
  const mounts = new Map();

  /** 旧接口 register 的记录（组件函数渲染不了，但要能列出、能说清原因）。 */
  const legacy = new Map();

  let seq = 0;

  /** 当前正在 apply 的插件 id。 */
  function currentOwner() {
    try {
      const scope = ctx && typeof ctx.currentScope === 'function' ? ctx.currentScope() : null;
      return scope && scope.pluginId ? String(scope.pluginId) : '';
    } catch (e) {
      return '';
    }
  }

  /** 当前作用域对象（拿 onDispose 挂卸载钩子）。 */
  function currentScope() {
    try {
      return ctx && typeof ctx.currentScope === 'function' ? ctx.currentScope() : null;
    } catch (e) {
      return null;
    }
  }

  function permissionsOf(pluginId) {
    if (!host || typeof host.manifestOf !== 'function') return null;
    try {
      return host.manifestOf(pluginId);
    } catch (e) {
      return null;
    }
  }

  /**
   * 校验一次挂载能不能做。
   * @returns {string} 空串表示通过，否则是拒绝原因
   */
  function checkPermission(pluginId, slot) {
    if (!pluginId) return '拿不到插件身份（不在 apply 里调用？）';
    // 没有宿主（单测 / 内置界面）时不拦 —— 没有清单可查，也就没有规矩可依
    if (!host || typeof host.manifestOf !== 'function') return '';
    const man = host.manifestOf(pluginId);
    if (!man) {
      // 查不到清单 ≠ 没声明权限。这两件事的处置完全不同：
      // 前者说明 id 对不上（插件被改名、或还没扫到），
      // 说成「未声明 ui.slot」会让人去翻清单找一个根本不存在的问题。
      return `找不到插件 ${pluginId} 的清单，无法确认它可以挂界面`;
    }
    if (!man.permissions.includes('ui.slot')) {
      return `插件 ${pluginId} 未在清单里声明权限「ui.slot」，不能挂界面`;
    }
    // 声明了 surfaces 就按声明来；没声明则允许任意挂载点（老插件兼容）
    if (man.surfaces.length && !man.surfaces.includes(slot)) {
      return `插件 ${pluginId} 声明的是 ${man.surfaces.join('、')}，不能挂到 ${slot}`;
    }
    return '';
  }

  function countOf(pluginId) {
    let n = 0;
    for (const m of mounts.values()) {
      if (m.pluginId === pluginId) n += 1;
    }
    return n;
  }

  /**
   * 挂载一棵界面树。
   *
   * 两种写法都收：
   *   mount('composer.toolbar', tree, { id, order })
   *   mount({ slot: 'composer.toolbar', tree, id, order })
   *
   * @returns {{ok:boolean, id?:string, error?:string}}
   */
  function mount(slotOrDef, tree, extra) {
    let slot = '';
    let body = tree;
    let conf = extra || {};

    if (slotOrDef && typeof slotOrDef === 'object') {
      conf = slotOrDef;
      slot = String(conf.slot || '');
      body = conf.tree !== undefined ? conf.tree : conf.children;
    } else {
      slot = String(slotOrDef || '');
    }

    if (!SLOT_NAMES.includes(slot)) {
      return { ok: false, error: `未知挂载点：${slot || '(空)'}` };
    }

    const pluginId = String(conf.pluginId || currentOwner() || '');
    const deny = checkPermission(pluginId, slot);
    if (deny) {
      log('warn', pluginId, deny);
      return { ok: false, error: deny };
    }

    if (countOf(pluginId) >= MAX_PER_PLUGIN) {
      return { ok: false, error: `一个插件最多挂 ${MAX_PER_PLUGIN} 个界面` };
    }

    const id = String(conf.id || `ui:${pluginId || 'host'}:${++seq}`);
    const record = {
      id,
      slot,
      pluginId,
      pluginName: String(conf.pluginName || ''),
      order: Number(conf.order) || 0,
      tree: body,
      handlers: new Map(),
    };
    mounts.set(id, record);
    send('ui.mount', {
      id,
      slot,
      tree: body,
      pluginId,
      pluginName: record.pluginName,
      order: record.order,
    });

    // 插件卸载 / 热重载时，界面必须跟着消失。
    // 不挂这个钩子的话，重载后屏幕上会叠着两份旧界面：
    // 点旧的那份，handler 已经跟着 fiber 一起没了 —— 点了没反应。
    const scope = currentScope();
    if (scope && typeof scope.onDispose === 'function') {
      scope.onDispose(() => unmount(id, 'dispose'));
    }

    return { ok: true, id };
  }

  /** 局部更新一棵已挂载的树。 */
  function update(id, tree) {
    const m = mounts.get(String(id || ''));
    if (!m) return { ok: false, error: `没有这个挂载：${id}` };
    m.tree = tree;
    send('ui.update', { id: m.id, tree });
    return { ok: true };
  }

  /** 卸载。 */
  function unmount(id, reason) {
    const key = String(id || '');
    const m = mounts.get(key);
    if (!m) return { ok: false, error: `没有这个挂载：${key}` };
    mounts.delete(key);
    send('ui.unmount', { id: key });
    if (reason !== 'dispose') log('info', m.pluginId, `界面已卸载：${key}`);
    return { ok: true };
  }

  /** 卸载某个插件的全部界面（重载时用）。 */
  function unmountPlugin(pluginId) {
    const pid = String(pluginId || '');
    let n = 0;
    for (const [id, m] of Array.from(mounts.entries())) {
      if (m.pluginId !== pid) continue;
      mounts.delete(id);
      send('ui.unmount', { id });
      n += 1;
    }
    if (n) log('info', pid, `已清理 ${n} 个界面挂载`);
    return n;
  }

  /**
   * 注册交互回调。
   *
   * @param {string} id     挂载 id
   * @param {Function} fn   (action, value, meta) => tree|void|Promise
   */
  function onAction(id, fn) {
    const m = mounts.get(String(id || ''));
    if (!m) return { ok: false, error: `没有这个挂载：${id}` };
    if (typeof fn !== 'function') return { ok: false, error: 'onAction 需要函数' };
    m.handlers.set('action', fn);
    return { ok: true };
  }

  /**
   * 页面上的点击回来了。
   *
   * 插件回调可以返回一棵新树 —— 那就是局部更新，
   * 不用卸载重挂（重挂会让滚动位置和输入焦点一起丢掉）。
   *
   * @param {object} payload { id, action, name, value }
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function handleAction(payload) {
    const id = String(payload?.id || '');
    const m = mounts.get(id);
    if (!m) return { ok: false, error: `界面已不存在：${id}` };

    const fn = m.handlers.get('action');
    if (!fn) return { ok: false, error: `这个界面没有注册 onAction：${id}` };

    try {
      const next = await fn(String(payload.action || ''), payload.value, {
        name: String(payload.name || ''),
        slot: m.slot,
      });
      // 返回树 = 更新；返回别的（含 undefined）就当纯事件处理
      if (next && typeof next === 'object') {
        m.tree = next;
        send('ui.update', { id: m.id, tree: next });
      }
      return { ok: true };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      log('error', m.pluginId, `界面回调出错：${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * 旧接口：register(def, component)。
   *
   * ============ 这里必须如实 ============
   *
   * 桌面版传进来的是 React 组件函数。手机端渲染不了它 ——
   * 函数跨不了进程。以前这里记一笔就完事，界面永远不出现，
   * 而日志里写着「插槽已注册」，用户和插件作者都会以为成功了。
   *
   * 现在分两种情况：
   *   · component 是对象  → 当成界面树挂上去（真的会显示）
   *   · component 是函数  → 记录下来，但标注 rendered:false 并给出原因
   *
   * 宁可让作者看到「函数渲染不了，请改用 mount」，也不要假成功。
   */
  function register(def, component) {
    const id = (def && def.id) || `slot-${legacy.size + 1}`;
    const slot = String((def && (def.slot || def.name)) || '');

    if (component && typeof component === 'object') {
      const r = mount(slot, component, {
        id,
        order: def && def.order,
        pluginId: (def && def.pluginId) || currentOwner(),
      });
      if (r.ok) return r.id;
      log('warn', currentOwner(), r.error);
      return null;
    }

    legacy.set(id, {
      id,
      slot,
      label: (def && def.label) || '',
      order: (def && def.order) || 0,
      rendered: false,
      reason:
        typeof component === 'function'
          ? '组件函数无法跨进程渲染，请改用 ctx.slots.mount(slot, 界面树)'
          : '没有提供可渲染的内容',
      registeredAt: Date.now(),
    });
    log(
      'warn',
      currentOwner(),
      `插槽 ${id} 已记录但不会显示：${legacy.get(id).reason}`
    );
    return id;
  }

  function unregister(id) {
    const key = String(id || '');
    if (mounts.delete(key)) {
      send('ui.unmount', { id: key });
      return true;
    }
    return legacy.delete(key);
  }

  /**
   * 当前挂载清单（供页面和诊断工具）。
   *
   * 只注册未渲染的老式插槽也列出来 —— 它们确实"注册成功"了，
   * 只是画不出来。诊断页要能同时看到「有几个挂上了」和
   * 「有几个注册了但没显示」，否则用户面对空界面无从判断。
   */
  function list() {
    const out = Array.from(mounts.values()).map((m) => ({
      id: m.id,
      slot: m.slot,
      pluginId: m.pluginId,
      pluginName: m.pluginName,
      order: m.order,
      rendered: true,
      hasAction: m.handlers.has('action'),
    }));
    for (const l of legacy.values()) {
      out.push({
        id: l.id,
        slot: l.slot,
        pluginId: '',
        pluginName: '',
        order: l.order,
        rendered: false,
        reason: l.reason,
        hasAction: false,
      });
    }
    return out;
  }

  /**
   * 全量快照（带界面树）。
   *
   * 页面重载 / 切后台被杀之后，Node 这边的插件还活着、
   * 挂载也还在 —— 但 WebView 是全新的一张白纸。
   * 页面连上时拉一次快照，界面就回来了，不用让插件重新 apply。
   */
  function snapshot() {
    return Array.from(mounts.values()).map((m) => ({
      id: m.id,
      slot: m.slot,
      tree: m.tree,
      pluginId: m.pluginId,
      pluginName: m.pluginName,
      order: m.order,
    }));
  }

  /** 旧接口兼容：inject(name, fn)。 */
  function inject(name, fn) {
    if (typeof fn !== 'function') return null;
    try {
      const r = fn();
      return typeof r === 'function' ? r : null;
    } catch (e) {
      log('warn', '', `插槽 ${name} 的注入函数出错：${e && e.message}`);
      return null;
    }
  }

  return {
    // 新接口
    mount,
    update,
    unmount,
    unmountPlugin,
    onAction,
    handleAction,
    // 旧接口（保留，不让已有插件因为改名而崩）
    register,
    unregister,
    inject,
    list,
    snapshot,
    /** 挂载点清单，插件可以据此提示用户。 */
    slots: SLOT_NAMES.slice(),
  };
}

module.exports = { createUiService, SLOT_NAMES };
