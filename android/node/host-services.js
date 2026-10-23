'use strict';

/**
 * 桌面宿主服务的手机端实现。
 *
 * ============ 为什么要有这个文件 ============
 *
 * 插件通过 `inject` 声明自己要用哪些服务。cordis 的语义是：
 * **声明了但宿主没提供 → fiber 停在 PENDING，apply 根本不执行**，
 * 而且不报错。
 *
 * 我们原来只提供 `logger / tools / slots / sessions / modelDirectories / remote`。
 * 抽查 24 个真实插件，高频用到的还有：
 *
 *   settings(7)  llm(7)  sessionQuery(5)  commands  systemPrompt  web
 *
 * 缺了它们，插件装上就是「列表里显示等依赖，然后什么也没发生」。
 *
 * ============ 接口从哪来 ============
 *
 * 全部照抄桌面版包里的实现，不猜：
 *
 *   ctx.settings      @deepseek-ai/dsh-settings@0.0.1-rc.1
 *   ctx.web           @deepseek-ai/dsh-web@0.0.1-rc.1
 *   ctx.commands      @deepseek-ai/dsh-commands@0.0.1-rc.1
 *   ctx.systemPrompt  @deepseek-ai/dsh-system-prompt@0.0.1-rc.1
 *   ctx.sessionQuery  @deepseek-ai/dsh-session-query@0.0.1-rc.1
 *
 * ============ 哪些是真实现，哪些是壳 ============
 *
 * 「注册类」API 全部真实现 —— 插件 apply 期间干的就是注册，
 * 那一步成功，插件的能力就落到了我们能用的地方：
 *
 *   settings.register(ns, schema)      真：值存在工作区，重启不丢
 *   web.registerSearchProvider(p)      真：provider 进表，search() 能选中它
 *   commands.register(def)             真：命令进表，列表能看见
 *   systemPrompt.section/context       真：assemble() 拼得出结果
 *
 * 「执行类」API 里，凡是依赖桌面版的会话/agent 运行时的，给明确错误
 * 而不是假装成功 —— 静默失败比报错难查得多。
 */

const fs = require('fs');
const path = require('path');

/* ============================================================
   工具
   ============================================================ */

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 和桌面版一致的深比较：用来判断「值真的变了吗」。 */
function deepEqualJson(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqualJson(x, b[i]));
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => k in b && deepEqualJson(a[k], b[k]));
}

/** 只接受 JSON 能表达的值。Date / Map / 函数一律拒绝，而不是存进去后悄悄变样。 */
function cloneJsonShaped(value, where) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`settings 值里有非有限数字（${where}）`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => cloneJsonShaped(v, `${where}[${i}]`));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = cloneJsonShaped(v, `${where}.${k}`);
    }
    return out;
  }
  throw new TypeError(`settings 只接受 JSON 能表达的值，${where} 是 ${typeof value}`);
}

/** 浅层覆盖：对象递归合并，其它值（含数组）整体替换。 */
function mergeLayers(under, over) {
  if (over === undefined) return under;
  if (!isPlainObject(under) || !isPlainObject(over)) return over;
  const merged = { ...under };
  for (const [k, v] of Object.entries(over)) {
    merged[k] = k in merged ? mergeLayers(merged[k], v) : v;
  }
  return merged;
}

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

/**
 * 把一段清理逻辑挂到「当前正在跑 apply 的插件」上。
 *
 * ============ 为什么不能用 ctx.effect ============
 *
 * 服务对象是全局的，它手上的 ctx 是根上下文，根上下文没有 fiber，
 * `ctx.effect` 无处可挂。而桌面版的语义是：**注册挂在调用者的 fiber 上**，
 * 插件卸载 → 它注册的命名空间/provider/命令跟着消失。
 *
 * 容器的 currentScope() 正好给的是「现在是谁在 apply」。
 */
function onCallerDispose(ctx, fn) {
  try {
    if (ctx && typeof ctx.onDispose === 'function') {
      if (ctx.onDispose(fn)) return;
    }
    const scope = ctx && typeof ctx.currentScope === 'function' ? ctx.currentScope() : null;
    if (scope && typeof scope.onDispose === 'function') {
      scope.onDispose(fn);
      return;
    }
  } catch {
    /* 挂不上就不挂 —— 注册本身仍然有效，只是卸载后残留 */
  }
}

/** 写文件先写临时文件再 rename —— 断电不会留下半个 JSON。 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/* ============================================================
   ctx.settings
   ============================================================ */

/**
 * 用户设置。
 *
 * 桌面版是 `Settings` 类（extends Service），provider 子类负责 load/persist。
 * 手机端只有一个 provider：工作区里的一个 JSON 文件。
 *
 * 分层顺序和桌面版一致：schema 默认值 → 插件组合时的 base → 用户文档。
 *
 * @param {object} opts
 *   opts.ctx    根上下文（用来 emit 和挂 effect）
 *   opts.file   持久化文件路径
 *   opts.log    日志函数
 */
function createSettingsService(opts) {
  const ctx = opts.ctx;
  const file = opts.file;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  /** 原始用户文档：ns → section。 */
  let document = {};

  /** ns → 注册信息（0.0.x 的命名空间模型，老插件用）。 */
  const registrations = new Map();

  /**
   * 插件实例 → 设置页策略（0.2.x 的 `configure`）。
   *
   * ============ 这两个模型为什么并存 ============
   *
   * dsh-settings 在 0.2 里换了模型：配置不再由插件自建命名空间，而是
   * 存在 profile 的 entry config 里，插件只用 `configure({auto:false})`
   * 声明「我自带设置页，别自动生成表单」。
   *
   * 真实插件（dsh-free-search）两个模型都用：它调 `configure`，
   * 也调 `describe()` 去读 `web` 这个 entry 的配置。
   *
   * 我们两个都实现：`configure` 只记录策略（我们没有自动表单，
   * 记录它只为不报错、并让 describe 能说出「这个插件自带设置页」）；
   * 命名空间模型保留给老插件。
   */
  const presentations = new Map();

  function readDocument() {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(text);
      document = isPlainObject(parsed) ? parsed : {};
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        // 文件坏了不能拖着不启动 —— 用空的，但要说出来
        log('warn', 'settings', `设置文件读不了（${e.message}），本次按空设置运行`);
      }
      document = {};
    }
  }

  function persist() {
    try {
      writeAtomic(file, JSON.stringify(document, null, 2));
    } catch (e) {
      log('warn', 'settings', `设置保存失败：${e.message}`);
    }
  }

  function section(ns) {
    const s = document[ns];
    if (s === undefined) return undefined;
    if (!isPlainObject(s)) throw new TypeError(`settings 段「${ns}」必须是一个对象`);
    return s;
  }

  /**
   * 算出某个命名空间的有效值。
   *
   * schema 是插件给的 schemastery schema：**调用它**就会应用默认值并校验。
   * 不是函数就跳过校验（有些插件传的是字面量）。
   */
  function resolve(reg, sec) {
    const merged = mergeLayers(reg.base, sec);
    if (typeof reg.schema === 'function') {
      const out = reg.schema(merged);
      return out === undefined ? merged : out;
    }
    return merged;
  }

  function emitUpdated(ns, next, prev) {
    try {
      ctx.emit('settings/updated', ns, next, prev, 'local');
    } catch (e) {
      log('warn', 'settings', `settings/updated 监听器出错：${e.message}`);
    }
  }

  async function write(ns, apply) {
    const reg = registrations.get(ns);
    if (!reg) throw new Error(`settings 命名空间「${ns}」还没有注册`);

    const before = section(ns);
    const draft = apply(before === undefined ? {} : before);
    const nextSection = cloneJsonShaped(draft, `settings.${ns}`, 0);

    // 先校验再落盘 —— 存进去才知道不对就晚了
    let nextValue;
    try {
      nextValue = deepFreeze(resolve(reg, nextSection));
    } catch (e) {
      throw new Error(`settings「${ns}」的值不合法：${(e && e.message) || e}`);
    }

    document[ns] = nextSection;
    persist();

    const prevValue = reg.resolved;
    reg.resolved = nextValue;
    if (!deepEqualJson(nextValue, prevValue)) emitUpdated(ns, nextValue, prevValue);
    else if (!deepEqualJson(before, nextSection)) emitUpdated(ns, nextValue, prevValue);

    return nextValue;
  }

  function applyOps(section, ops) {
    let out = { ...section };
    for (const op of ops) {
      const parts = Array.isArray(op.path) ? op.path : [];
      if (!parts.length) {
        if (op.op === 'unset') {
          out = {};
          continue;
        }
        if (!isPlainObject(op.value)) throw new TypeError('settings mutate：设置整体时值必须是对象');
        out = { ...op.value };
        continue;
      }
      // 逐层写下去（每层都是新对象，不改传进来的）
      const walk = (node, i) => {
        const key = parts[i];
        const copy = { ...node };
        if (i === parts.length - 1) {
          if (op.op === 'unset') delete copy[key];
          else copy[key] = op.value;
          return copy;
        }
        const child = isPlainObject(node[key]) ? node[key] : {};
        copy[key] = walk(child, i + 1);
        return copy;
      };
      out = walk(out, 0);
    }
    return out;
  }

  readDocument();

  return {
    /** 手机端的设置永远可写（存在工作区里）。 */
    writable: true,

    /** 设置文件在哪 —— 插件可能把它显示给用户。 */
    get documentPath() {
      return file;
    },

    prepareDocument() {
      return Promise.resolve(file);
    },

    /**
     * 注册一个命名空间。
     *
     * 返回的 scope 是插件唯一的读写入口。注册本身挂在这个插件的
     * fiber 上：插件卸载，命名空间跟着消失（和桌面版一致）。
     */
    register(ns, schema, options) {
      const name = String(ns || '');
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        throw new TypeError(`settings 命名空间「${name}」必须是小写短横线格式`);
      }
      if (registrations.has(name)) {
        throw new Error(`settings 命名空间「${name}」已经被注册过了`);
      }

      const reg = {
        ns: name,
        schema,
        base: options && options.base,
        validate: options && options.validate,
        resolved: undefined,
        watchers: new Set(),
      };

      let initial;
      try {
        initial = deepFreeze(resolve(reg, section(name)));
      } catch (e) {
        // 存着的旧值和新 schema 对不上：用默认值，但别让插件起不来
        log('warn', 'settings', `「${name}」存的旧值不合法，改用默认值：${e.message}`);
        try {
          initial = deepFreeze(resolve(reg, undefined));
        } catch {
          initial = deepFreeze({});
        }
        delete document[name];
        persist();
      }
      reg.resolved = initial;
      registrations.set(name, reg);

      onCallerDispose(ctx, () => registrations.delete(name));

      return {
        get: () => reg.resolved,
        watch: (callback) => {
          const watcher = { callback, active: true };
          reg.watchers.add(watcher);
          return () => {
            watcher.active = false;
            reg.watchers.delete(watcher);
          };
        },
        update: (patch) => this.update(name, patch),
        replace: (next) => this.replace(name, next),
      };
    },

    /**
     * 声明这个插件实例的设置页策略。
     *
     * 桌面版签名：`configure(presentation, owner = ctx.fiber)`。
     * 插件通常写成 `sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))`，
     * 所以**必须返回 disposer**。
     */
    configure(presentation, owner) {
      const key = owner || null;
      if (presentations.has(key)) {
        throw new Error("这个插件实例已经配置过设置页策略了");
      }
      const policy = { ...(presentation || {}) };
      presentations.set(key, policy);
      return () => {
        if (presentations.get(key) === policy) presentations.delete(key);
      };
    },

    /** 已声明设置页策略的插件实例数（排查用）。 */
    presentationCount() {
      return presentations.size;
    },

    /** 已注册命名空间的清单（设置页可以用它渲染表单）。 */
    describe() {
      return [...registrations.values()].map((reg) => ({
        ns: reg.ns,
        schema: typeof reg.schema === 'object' && reg.schema && typeof reg.schema.toJSON === 'function'
          ? reg.schema.toJSON()
          : undefined,
        value: reg.resolved,
        ...(reg.base === undefined ? {} : { base: structuredClone(reg.base) }),
        ...(section(reg.ns) === undefined ? {} : { user: structuredClone(section(reg.ns)) }),
      }));
    },

    get(ns) {
      const reg = registrations.get(String(ns || ''));
      return reg ? reg.resolved : undefined;
    },

    async update(ns, patch) {
      if (!isPlainObject(patch)) throw new TypeError(`settings update「${ns}」只接受对象`);
      return write(String(ns), (current) => mergeLayers(current, patch));
    },

    async replace(ns, next) {
      if (!isPlainObject(next)) throw new TypeError(`settings replace「${ns}」只接受对象`);
      return write(String(ns), () => next);
    },

    async mutate(ns, ops) {
      if (!Array.isArray(ops)) throw new TypeError(`settings mutate「${ns}」只接受操作数组`);
      for (const op of ops) {
        if (!isPlainObject(op) || (op.op !== 'set' && op.op !== 'unset')) {
          throw new TypeError(`settings mutate「${ns}」的操作必须是 {op:'set'|'unset', path}`);
        }
      }
      return write(String(ns), (current) => applyOps(current, ops));
    },
  };
}

/* ============================================================
   ctx.web
   ============================================================ */

/**
 * 网页能力接缝。
 *
 * ============ 这个服务对手机端特别重要 ============
 *
 * 「联网搜索」类插件（`dsh-free-search` 就是）**不是使用者，是提供者**：
 * 它们在 apply 里 `ctx.web.registerSearchProvider(...)` 注册自己的搜索实现。
 *
 * 我们原来没有 ctx.web，它们 inject 里一写就整插件挂起 ——
 * 明明是最该能在手机上跑的一类插件（有依赖但不多、能力全在 Node 侧）。
 *
 * search()/fetch() 的执行语义照抄桌面版：调用时选 provider，
 * 有多个可用且没配置就报 AMBIGUOUS，而不是悄悄用第一个。
 */
function createWebService(opts) {
  const ctx = opts && opts.ctx;
  const log = typeof (opts && opts.log) === 'function' ? opts.log : () => {};

  const searchProviders = new Map();
  const fetchProviders = new Map();

  function webError(message, code) {
    const err = new Error(message);
    err.name = 'WebError';
    err.code = code;
    return err;
  }

  function register(store, provider, kind) {
    if (!provider || typeof provider !== 'object' || !provider.id) {
      throw webError(`web ${kind} provider 必须有 id`, 'WEB_INVALID_PROVIDER');
    }
    if (store.has(provider.id)) {
      throw webError(`web ${kind} provider「${provider.id}」已经注册过了`, 'WEB_DUPLICATE_PROVIDER');
    }
    store.set(provider.id, provider);
    log('info', 'web', `搜索${kind === 'search' ? '' : '抓取'}provider 已注册：${provider.id}`);

    return () => {
      // 同一个 id 可能已经被后注册的顶掉了，别误删
      if (store.get(provider.id) === provider) store.delete(provider.id);
    };
  }

  function pick(store, configuredId, kind) {
    if (configuredId !== undefined) {
      const p = store.get(configuredId);
      if (!p) throw webError(`配置的 web ${kind} provider「${configuredId}」没有注册`, 'WEB_PROVIDER_CONFIGURED_MISSING');
      if (typeof p.available === 'function' && !p.available()) {
        throw webError(`web ${kind} provider「${configuredId}」注册了但当前不可用`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE');
      }
      return p;
    }
    const usable = [...store.values()].filter((p) => (typeof p.available === 'function' ? p.available() : true));
    if (!usable.length) throw webError(`没有可用的 web ${kind} provider`, 'WEB_PROVIDER_UNAVAILABLE');
    if (usable.length > 1) {
      throw webError(
        `注册了多个可用的 web ${kind} provider（${usable.map((p) => p.id).join('、')}），需要显式指定一个`,
        'WEB_PROVIDER_AMBIGUOUS'
      );
    }
    return usable[0];
  }

  return {
    registerSearchProvider(provider) {
      const dispose = register(searchProviders, provider, 'search');
      onCallerDispose(ctx, dispose);
      return dispose;
    },

    registerFetchProvider(provider) {
      const dispose = register(fetchProviders, provider, 'fetch');
      onCallerDispose(ctx, dispose);
      return dispose;
    },

    async search(request, signal) {
      const p = pick(searchProviders, this.searchProvider, 'search');
      const result = await p.search(request, signal);
      // 桌面版会在这一层强制 maxResults
      const max = request && request.maxResults;
      if (max !== undefined && result && Array.isArray(result.sources) && result.sources.length > max) {
        return { ...result, sources: result.sources.slice(0, max), truncated: true };
      }
      return result;
    },

    async fetch(request, signal) {
      const p = pick(fetchProviders, this.fetchProvider, 'fetch');
      return p.fetch(request, signal);
    },

    /** 已注册的 provider 概览（设置页/详情页用得上）。 */
    listProviders() {
      return {
        search: [...searchProviders.values()].map((p) => ({ id: p.id, available: typeof p.available === 'function' ? p.available() : true })),
        fetch: [...fetchProviders.values()].map((p) => ({ id: p.id, available: typeof p.available === 'function' ? p.available() : true })),
      };
    },

    searchProvider: undefined,
    fetchProvider: undefined,
  };
}

/* ============================================================
   ctx.commands
   ============================================================ */

/**
 * 命令注册表。
 *
 * 桌面版里命令是「斜杠命令」：用户输入 `/export`，宿主找到处理器执行。
 * 手机端没有那个输入框 —— 但**注册必须成功**，否则插件整棵挂起。
 *
 * 所以注册真实现，执行给明确错误：让用户看到「这个命令需要一个
 * 桌面端的会话」比看到「插件没反应」好得多。
 */
function createCommandsService(opts) {
  const ctx = opts && opts.ctx;
  const log = typeof (opts && opts.log) === 'function' ? opts.log : () => {};

  /** 命令名 → 定义。 */
  const items = new Map();

  return {
    register(definition) {
      if (!definition || typeof definition !== 'object') throw new TypeError('命令定义必须是一个对象');
      const name = String(definition.name || '').trim();
      if (!name) throw new TypeError('命令必须有 name');
      if (items.has(name)) throw new Error(`命令「${name}」已经被注册过了`);

      items.set(name, definition);
      log('info', 'commands', `命令已注册：${name}`);

      const dispose = () => {
        if (items.get(name) === definition) items.delete(name);
      };
      onCallerDispose(ctx, dispose);
      return dispose;
    },

    list() {
      return [...items.values()].map((d) => ({
        name: d.name,
        description: d.description || '',
      }));
    },

    find(_agent, name) {
      return items.get(String(name || ''));
    },

    view() {
      return [...items.values()].map((d) => ({ name: d.name, description: d.description || '' }));
    },

    async execute(_agent, line) {
      const raw = String(line || '').trim().replace(/^\//, '');
      const name = raw.split(/\s+/)[0];
      if (!items.has(name)) throw new Error(`没有这个命令：${name}`);
      throw new Error(
        `命令「${name}」需要桌面端的会话上下文，手机端暂不支持执行。` +
          '它已经注册成功了，只是这里没有可以执行它的会话。'
      );
    },
  };
}

/* ============================================================
   ctx.systemPrompt
   ============================================================ */

/**
 * 系统提示词拼装。
 *
 * 桌面版把各插件贡献的段落（section）、上下文（context）、工具说明（tools）
 * 拼成一段文本，交给模型。
 *
 * 手机端的系统提示词在页面侧组装，但插件贡献的段落可以先收着 ——
 * `assemble()` 能把它们拼出来，至少插件那边的逻辑是通的。
 */
function createSystemPromptService(opts) {
  const ctx = opts && opts.ctx;

  const sections = [];
  const contexts = [];
  const toolProviders = [];
  const variables = new Map();

  function push(list, value) {
    list.push(value);
    const dispose = () => {
      const i = list.indexOf(value);
      if (i >= 0) list.splice(i, 1);
    };
    onCallerDispose(ctx, dispose);
    return dispose;
  }

  return {
    /** 追加一段固定文本。 */
    section(value) {
      return push(sections, value);
    },

    /** 追加一段「上下文」——桌面版会按会话再过滤，这里原样收集。 */
    context(value) {
      return push(contexts, value);
    },

    /** 追加一个工具说明提供方（函数，返回该工具的描述）。 */
    tools(provider) {
      return push(toolProviders, provider);
    },

    /** 注册一个变量（如当前日期、工作区路径）。 */
    variable(name, provider) {
      const key = String(name || '');
      variables.set(key, provider);
      const dispose = () => variables.delete(key);
      onCallerDispose(ctx, dispose);
      return dispose;
    },

    async assemble() {
      const parts = [];

      for (const s of sections) {
        const text = typeof s === 'function' ? await s() : s;
        if (text) parts.push(String(text));
      }
      for (const c of contexts) {
        const text = typeof c === 'function' ? await c() : c;
        if (text) parts.push(String(text));
      }
      for (const [name, provider] of variables) {
        try {
          const value = typeof provider === 'function' ? await provider() : provider;
          if (value !== undefined && value !== null && value !== '') parts.push(`${name}: ${value}`);
        } catch {
          /* 单个变量取不到不影响整段 */
        }
      }
      for (const p of toolProviders) {
        try {
          const text = typeof p === 'function' ? await p() : p;
          if (text) parts.push(String(text));
        } catch {
          /* 同上 */
        }
      }

      return parts.length ? parts.join('\n\n') : '';
    },

    /** 当前收集到的段落数（排查「插件到底贡献了什么」用）。 */
    size() {
      return sections.length + contexts.length + toolProviders.length + variables.size;
    },
  };
}

/* ============================================================
   ctx.sessionQuery
   ============================================================ */

/**
 * 会话查询。
 *
 * 桌面版能列出所有历史会话、读标题、按条件筛。
 * 手机端只有单会话（页面侧管理），所以这里给出最小诚实实现：
 * 列得出「当前会话」，其余查询返回空。
 *
 * 它的价值主要在于**让插件不挂起** —— 导出类插件 inject 了它。
 */
function createSessionQueryService(opts) {
  const current = (opts && opts.currentSession) || { id: 'default', title: '当前会话' };

  return {
    async listSessions() {
      return [current];
    },

    async readSession(sessionId) {
      if (String(sessionId || '') !== String(current.id)) return null;
      return { meta: current, messages: [] };
    },

    async filterSessions() {
      // 手机端没有历史会话索引，如实返回空
      return [];
    },

    async readTitle(sessionId) {
      return String(sessionId || '') === String(current.id) ? current.title : '';
    },

    async readTitleSnapshot(sessionId) {
      return { id: String(sessionId || ''), title: await this.readTitle(sessionId) };
    },

    async readTitleSnapshots(ids) {
      const list = Array.isArray(ids) ? ids : [];
      const out = [];
      for (const id of list) out.push(await this.readTitleSnapshot(id));
      return out;
    },
  };
}

/* ============================================================
   组装
   ============================================================ */

/**
 * 造齐这一批服务。
 *
 * @param {object} opts
 *   opts.ctx            根上下文（emit / effect 用）
 *   opts.dataDir        应用数据目录（settings.json 放这里 —— 不放工作区，
 *                       免得用户的文件列表里凭空多一个我们自己的配置文件）
 *   opts.workspace      工作区根目录（dataDir 没给时的兜底）
 *   opts.log            日志函数 (level, scope, message)
 *   opts.currentSession 当前会话（单会话模型）
 */
function createHostServices(opts = {}) {
  const ctx = opts.ctx;
  const workspace = opts.workspace || process.cwd();
  const log = opts.log;

  const settings = createSettingsService({
    ctx,
    file: path.join(opts.dataDir || workspace, 'settings.json'),
    log,
  });

  const web = createWebService({ ctx, log });
  const commands = createCommandsService({ ctx, log });
  const systemPrompt = createSystemPromptService({ ctx });
  const sessionQuery = createSessionQueryService({ currentSession: opts.currentSession });

  return { settings, web, commands, systemPrompt, sessionQuery };
}

module.exports = { createHostServices, deepEqualJson, mergeLayers, cloneJsonShaped };
