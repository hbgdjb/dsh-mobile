/* ============================================================
   Node 插件运行时 —— 通道客户端

   插件跑在 Node 里（真 Node API：node:fs / node:http / npm 包），
   但工具的调用入口在页面里（AI 助手在这儿）。
   两者之间由原生搭一条通道，本模块是页面侧的 Promise 封装。

   协议（原生 ↔ Node，行分隔 JSON）：
     页面 → 原生 → Node：{"id":"n1","method":"tool.call","params":{...}}
     Node → 原生 → 页面：{"id":"n1","ok":true,"result":{...}}

   为什么不让页面直接连 Node：
     Node 的端口是原生的、临时的，页面拿不到也不该管；
     而且原���还得负责超时、断线重连、错误分类。

   平台差异：
     APK        走 window.DshNode（原生桥）
     浏览器/PWA 没有这个对象 —— 一律返回"不可用"，不要假装支持
   ============================================================ */

/** 原生桥在不在（不是"Node 在不在"）。 */
export function nodeBridgeAvailable() {
  return typeof window !== "undefined" && typeof window.DshNode?.status === "function";
}

/**
 * 问一次状态。
 *
 * @returns {{native:boolean, available:boolean, running:boolean, reason?:string}}
 *   native          原生桥是否存在（浏览器里恒为 false）
 *   available       原生库是否加载成功（libnode.so + libdshnode.so）
 *   running         Node 进程当前是否在跑
 *   channelConnected 通道是否已连上（连上才说明插件能被调用）
 */
export function nodeStatus() {
  if (!nodeBridgeAvailable()) {
    return {
      native: false, available: false, running: false, installed: false,
      downloading: false, percent: 0, channelConnected: false,
    };
  }
  try {
    const raw = window.DshNode.status();
    const o = raw ? JSON.parse(String(raw)) : {};
    return {
      native: true,
      available: !!o.available,
      // running = Node 进程真的在；serviceRunning = 前台服务被要求启动过。
      // 两者分开，界面才能说出「服务活着但 Node 崩了」这种情况。
      running: !!o.running,
      serviceRunning: !!o.serviceRunning,
      installed: !!o.installed,
      downloading: !!o.downloading,
      percent: Number(o.percent) || 0,
      channelConnected: !!o.channelConnected,
      channelPort: Number(o.channelPort) || 0,
      reason: o.reason || undefined,
      runtimeError: o.runtimeError || undefined,
      error: o.error || undefined,
    };
  } catch (err) {
    return {
      native: true,
      available: false,
      running: false,
      error: String(err?.message || err),
    };
  }
}

/** 拉起运行时（幂等）。 */
export function nodeStart() {
  try {
    window.DshNode?.start();
    return true;
  } catch {
    return false;
  }
}

/**
 * 读 Node 自己的日志尾部（最后 8 KB）。
 *
 * 「运行中但通道未连接」只能靠它定位 —— 页面看不到 Android/data 下的文件。
 * 浏览器里没有原生桥，返回空串。
 */
export function nodeLogTail() {
  if (!nodeBridgeAvailable()) return "";
  try {
    if (typeof window.DshNode?.logTail !== "function") return "";
    return String(window.DshNode.logTail() || "");
  } catch {
    return "";
  }
}

/** 停掉运行时。 */
export function nodeStop() {
  try {
    window.DshNode?.stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * 只下载运行时，不启动。
 *
 * 88 MB 是一次性的开销，必须由用户明确点「下载运行时」才发生。
 * 应用启动时**不**自动调用这个 —— 否则用户装个 APK 就被偷偷下 88 MB。
 */
export function nodeDownload() {
  try {
    window.DshNode?.download();
    return true;
  } catch {
    return false;
  }
}

/* ============================================================
   通道
   ============================================================ */

/** 请求 id → { resolve, reject, timer } */
const pending = new Map();

/** Node 推送事件的订阅者。 */
const eventSubscribers = new Set();

let seq = 0;

function nextId() {
  seq += 1;
  return "w" + seq;
}

/**
 * 安装原生回调入口。
 *
 * 原生用 evaluateJavascript 直接调 window.__dshNodeResponse /
 * __dshNodeEvent / __dshNodeRequest —— 这几个函数必须挂在 window 上，
 * 所以这里是"全局副作用"，只能装一次。
 *
 * ============ 什么时候装 ============
 *
 * 必须在**模块加载时**就装，不能等到第一次 nodeCall。
 *
 * 因为原生可能在页面还没发起任何调用时，就派发一个反向调用
 * （比如 Node 里的插件启动时要读工作区文件）。
 * 那时如果钩子还没装，页面侧收不到这个调用，
 * Node 那边就一直等着 —— 表现为「插件加载时卡住」。
 */
function installNativeHooks() {
  if (typeof window === "undefined") return;
  // 判断依据是"钩子函数还在不在"，而不是一个标志位。
  //
  // 标志位会骗人：window 对象被换掉（页面重载、测试里替换全局）之后，
  // 标志还是 true，但 window.__dshNodeRequest 已经不存在了 ——
  // 原生派发反向调用时页面收不到，Node 那边就一直等着。
  if (typeof window.__dshNodeResponse === "function"
    && typeof window.__dshNodeEvent === "function"
    && typeof window.__dshNodeRequest === "function") {
    window.__dshNodeInstalled = true;
    return;
  }
  window.__dshNodeInstalled = true;

  /**
   * 收到 Node 的响应。
   * @param {string} id       请求 id
   * @param {boolean} ok      是否成功
   * @param {string} payload 结果（JSON 字符串）或错误原因
   */
  window.__dshNodeResponse = (id, ok, payload) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (ok) {
      p.resolve(parseMaybeJson(payload));
    } else {
      p.reject(new Error(String(payload || "Node 调用失败")));
    }
  };

  /** 收到 Node 的主动推送。 */
  window.__dshNodeEvent = (event, data) => {
    let parsed = parseMaybeJson(data);
    eventSubscribers.forEach((fn) => {
      try {
        fn(event, parsed);
      } catch (e) {
        console.error("[node] 事件处理失败：", e);
      }
    });
  };

  /**
   * Node 反向调用页面。
   *
   * 目前只有一类：插件在 Node 里，但某项能力实现在页面侧
   * （比如读工作区文件要过统一的权限白名单与审计）。
   * 没有注册处理器就直接回错误 —— 不能让 Node 那头一直等着。
   */
  window.__dshNodeRequest = (id, method, params) => {
    const handler = hostRequestHandlers.get(method);
    if (!handler) {
      try {
        window.DshNode?.respond(id, false, `宿主没有实现 ${method}`);
      } catch { /* ignore */ }
      return;
    }
    Promise.resolve()
      .then(() => handler(parseMaybeJson(params) || {}))
      .then((result) => {
        try {
          window.DshNode?.respond(id, true, JSON.stringify(result ?? null));
        } catch { /* ignore */ }
      })
      .catch((err) => {
        try {
          window.DshNode?.respond(id, false, String(err?.message || err));
        } catch { /* ignore */ }
      });
  };
}

/** 解析可能是 JSON 的字符串；不是就原样返回。 */
function parseMaybeJson(s) {
  if (typeof s !== "string") return s;
  const t = s.trim();
  if (!t) return null;
  if (t[0] === "{" || t[0] === "[") {
    try {
      return JSON.parse(t);
    } catch {
      return s;
    }
  }
  return s;
}

/**
 * 调用 Node 里的方法。
 *
 * @param {string} method 方法名
 * @param {object} params 参数
 * @param {object} opts   { timeoutMs }
 * @returns {Promise<any>}
 */
export function nodeCall(method, params = {}, opts = {}) {
  if (!nodeBridgeAvailable()) {
    return Promise.reject(new Error("当前环境没有 Node 运行时"));
  }
  installNativeHooks();

  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000;

  return new Promise((resolve, reject) => {
    let id = "";
    try {
      id = window.DshNode.call(method, JSON.stringify(params || {}));
    } catch (e) {
      reject(new Error(String(e?.message || e)));
      return;
    }
    if (!id) {
      reject(new Error("Node 通道未连接（运行时可能还没起来）"));
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Node 调用超时：${method}`));
    }, timeoutMs + 2000);
    pending.set(id, { resolve, reject, timer });
  });
}

/**
 * 订阅 Node 的推送事件。
 * @param {Function} fn  (event, data) => void
 * @returns {Function} 取消订阅
 */
export function nodeOnEvent(fn) {
  installNativeHooks();
  eventSubscribers.add(fn);
  return () => eventSubscribers.delete(fn);
}

/**
 * Node 反向调用的处理器表。
 *
 * 定义在 installNativeHooks 之前 —— 装钩子的时候要用它。
 */
const hostRequestHandlers = new Map();

/**
 * 确保原生回调钩子已装好。
 *
 * 导出出来是为了应对 window 对象被替换的场合
 * （页面重载、测试里替换全局）：那种情况下钩子会丢，
 * 而模块本身已经加载过、不会再执行一遍。
 *
 * @returns {boolean} 钩子是否可用
 */
export function ensureNodeHooks() {
  installNativeHooks();
  if (typeof window === "undefined") return false;
  return typeof window.__dshNodeRequest === "function";
}

/**
 * 注册一个"Node 请页面代做"的能力。
 *
 * @param {string} method 方法名
 * @param {Function} handler (params) => Promise<any>
 */
export function nodeOnHostRequest(method, handler) {
  installNativeHooks();
  hostRequestHandlers.set(method, handler);
}

// 模块一加载就装钩子 —— 见上面 installNativeHooks 的说明。
installNativeHooks();

/* ============================================================
   插件相关的高层封装
   ============================================================ */

/** 列出 Node 里可用的插件。 */
export async function nodeListPlugins() {
  const r = await nodeCall("plugins.list", {});
  return Array.isArray(r?.plugins) ? r.plugins : [];
}

/** 重新加载全部插件。 */
export async function nodeLoadPlugins() {
  return await nodeCall("plugins.load", {});
}

/**
 * 热重载插件。
 *
 * ============ 和 nodeLoadPlugins 的区别 ============
 *
 * `plugins.load` 只是再跑一遍 apply —— 不卸载旧的。
 * 于是模块缓存没破（代码改了但跑的还是旧的），
 * 旧 fiber 还在（同一个插件两个实例同时跑），
 * 宿主服务的注册还会撞车。
 *
 * `plugins.reload` 才是真重载：卸载 → 破缓存 → 重新加载。
 *
 * @param {string} [id] 插件 id；不传就重载全部
 * @returns {Promise<object>} {ok, results:[{id,ok,mode,error,restored}]}
 */
export async function nodeReloadPlugin(id) {
  return await nodeCall("plugins.reload", { id: String(id || "") });
}

/** 热重载全部插件。 */
export async function nodeReloadPlugins() {
  return await nodeCall("plugins.reload", {});
}

/** 卸载全部插件。 */
export async function nodeUnloadPlugins() {
  return await nodeCall("plugins.unload", {});
}

/** 调用一个插件注册的工具。 */
export async function nodeCallTool(name, args = {}) {
  return await nodeCall("tool.call", { name, args });
}

/** 运行时信息（版本、插件数、工具数）。 */
export async function nodeRuntimeInfo() {
  return await nodeCall("runtime.info", {});
}

/** 连通性自检。 */
export async function nodePing() {
  return await nodeCall("ping", {});
}

/* ============================================================
   模型供应方（llm）相关
   ============================================================ */

/** 问 Node 侧某个供应方提供了哪些模型。 */
export async function nodeDiscoverModels(settingsNs) {
  const r = await nodeCall("llm.discover", { settingsNs });
  return Array.isArray(r?.models) ? r.models : [];
}

/** 问 Node 侧某个路由（provider）眼下提供哪些模型。 */
export async function nodeListModels(provider) {
  const r = await nodeCall("llm.models", { provider });
  return Array.isArray(r?.models) ? r.models : [];
}

/** 列出 Node 侧的模型供应方。 */
export async function nodeLlmRoutes() {
  const r = await nodeCall("llm.routes", {});
  return {
    routes: Array.isArray(r?.routes) ? r.routes : [],
    directory: Array.isArray(r?.directory) ? r.directory : [],
    namespaces: Array.isArray(r?.namespaces) ? r.namespaces : [],
  };
}

/**
 * 让 Node 侧按插件提供的 adapter 跑一次生成。
 *
 * **立刻返回** —— 这不是「跑完给你结果」，是「开跑了」。
 * 正文通过 `llm.chunk` 事件流回来，收尾通过 `llm.done`。
 * 所以这里的超时给得很短：它只等「起跑」这一下，
 * 等整段生成的是事件订阅那一侧（见 scripts/llm-bridge.js）。
 *
 * @param {object} params { callId, provider, model, messages, tools, system, ... }
 */
export async function nodeLlmChat(params) {
  return await nodeCall("llm.chat", params, { timeoutMs: 30000 });
}

/** 停掉一次正在跑的生成。 */
export async function nodeLlmAbort(callId) {
  return await nodeCall("llm.abort", { callId });
}
