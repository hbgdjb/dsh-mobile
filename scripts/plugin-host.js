/* ============================================================
   插件运行层 —— 把第三方代码关进 iframe 沙箱

   为什么必须是 iframe 沙箱，而不是像 run_code 那样用
   new Function 遮蔽几个全局：

     run_code 的遮蔽是「约定式」的 —— 它把 fetch / document /
     localStorage 换成 undefined，但插件拿到的是**宿主同一个 realm**，
     仍然可以顺着 window 构造器、Error.prepareStackTrace、
     Proxy、getter 副作用等路径拿回真实引用。安全网（Safety Net）
     是事后正则扫描，挡不住刻意构造的绕过。

   iframe 沙箱是「结构式」的隔离：

     - iframe 带 sandbox="allow-scripts"，**不带 allow-same-origin**
       → 它的 origin 是 null，与宿主不同源
       → 拿不到宿主的 localStorage / indexedDB / cookie
       → 拿不到宿主的 document / window 引用（跨源限制）
       → 拿不到宿主的 fetch（跨源 XHR/fetch 会被 CORS 挡住，
         且宿主 WebView 的 Origin 头不匹配）
     - 宿主与沙箱之间只通过 postMessage 通信，
       且**只认带正确 token 的消息**

   沙箱里能做什么，取决于我们暴露了什么。目前只暴露：
     - dsh.registerTool(...)  注册工具
     - dsh.on(...)             订阅宿主事件
     - dsh.log(...)            日志回传
     - dsh.host.<能力>         受控的宿主能力（按清单声明的权限逐项开）

   沙箱里不能做（结构上做不到）：
     - 读宿主的模型 Key、localStorage、其它会话
     - 访问宿主 DOM
     - 直接发起网络请求（要联网必须走 dsh.host.net，且需要清单声明）
   ============================================================ */

/** 沙箱 iframe 的 sandbox 属性。注意：故意不加 allow-same-origin。 */
const SANDBOX_ATTR = "allow-scripts";

/** 单个插件的运行期最长时长（毫秒）。 */
const CALL_TIMEOUT = 30000;

/** 宿主能力清单：只有被插件清单显式声明的能力才会被开放。 */
const HOST_CAPABILITIES = {
  /* 读工作区文件 */
  "fs.read": {
    label: "读取工作区文件",
    risk: "read",
  },
  /* 写工作区文件 */
  "fs.write": {
    label: "写入工作区文件",
    risk: "write",
  },
  /* 发起网络请求 */
  "net": {
    label: "发起网络请求",
    risk: "net",
  },
};

/** 宿主侧实现的实际能力。由 tools.js 在启动时注入（避免循环依赖）。 */
let hostImpl = {
  fsRead: async () => ({ ok: false, output: "文件读取能力尚未挂载" }),
  fsWrite: async () => ({ ok: false, output: "文件写入能力尚未挂载" }),
  netFetch: async () => ({ ok: false, output: "网络能力尚未挂载" }),
};

export function installHostImpl(impl) {
  hostImpl = { ...hostImpl, ...(impl || {}) };
}

/** 列出所有宿主能力（供清单校验用）。 */
export function hostCapabilityNames() {
  return Object.keys(HOST_CAPABILITIES);
}

/** 能力的风险级别，供审批界面显示。 */
export function hostCapabilityRisk(name) {
  return HOST_CAPABILITIES[name]?.risk || "net";
}

/* ---------------- 沙箱内的引导脚本 ---------------- */

/**
 * 这段代码跑在 iframe 里，是插件唯一能看到的"世界"。
 *
 * 它只做三件事：
 *   1. 建立与宿主的 postMessage 通道（带 token 校验）
 *   2. 把 dsh API 交给插件
 *   3. 执行插件清单里指定的代码
 *
 * 注意这里刻意**不**暴露：window.parent、document.cookie、
 * localStorage 的任何引用、宿主函数的引用。
 */
function bootstrapScript(plugin, token) {
  // 插件代码走 base64 传输。
  // 原因很实际：代码里只要出现一个 "</script>" 就会把 srcdoc 的 HTML 提前截断，
  // 后面的引导代码全部失效 —— 而插件代码恰恰是不可控的第三方内容。
  const codeB64 = btoa(String(unescape(encodeURIComponent(plugin.code || ""))));
  return `
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var PLUGIN = ${JSON.stringify(plugin)};
  var CODE_B64 = ${JSON.stringify(codeB64)};
  var seq = 0;
  var pending = {};
  var toolHandlers = {};
  var listeners = {};

  function post(msg) {
    msg.__dshToken = TOKEN;
    try { parent.postMessage(msg, "*"); } catch (e) { /* 宿主已卸载 */ }
  }

  // 只接受 token 正确的宿主消息
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.__dshToken !== TOKEN) return;

    // 宿主下发工具调用
    if (d.__dshToolCall) {
      var handler = toolHandlers[d.__dshToolCall];
      if (!handler) {
        post({ __dshReply: d.__dshCallId, ok: false, error: "工具未注册：" + d.__dshToolCall });
        return;
      }
      Promise.resolve()
        .then(function () { return handler(d.args || {}); })
        .then(function (out) {
          var text = typeof out === "string" ? out : (out && out.output != null ? String(out.output) : JSON.stringify(out));
          post({ __dshReply: d.__dshCallId, ok: true, result: text });
        })
        .catch(function (err) {
          post({ __dshReply: d.__dshCallId, ok: false, error: String((err && err.message) || err) });
        });
      return;
    }

    if (d.__dshReply) {
      var p = pending[d.__dshReply];
      if (!p) return;
      delete pending[d.__dshReply];
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || "宿主调用失败"));
      return;
    }
    if (d.__dshEvent && listeners[d.__dshEvent]) {
      try { listeners[d.__dshEvent].forEach(function (fn) { fn(d.payload); }); } catch (e) {}
    }
  });

  function callHost(method, params) {
    return new Promise(function (resolve, reject) {
      var id = "c" + (++seq);
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error("宿主调用超时：" + method));
      }, ${CALL_TIMEOUT});
      pending[id] = {
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      };
      post({ __dshHostCall: method, __dshCallId: id, params: params || {} });
    });
  }

  // 只开放清单声明过的能力
  var granted = {};
  (PLUGIN.permissions || []).forEach(function (name) {
    if (name === "fs.read") granted.fsRead = function (p) { return callHost("fs.read", p); };
    if (name === "fs.write") granted.fsWrite = function (p) { return callHost("fs.write", p); };
    if (name === "net") granted.netFetch = function (p) { return callHost("net", p); };
  });

  var dsh = {
    plugin: { id: PLUGIN.id, name: PLUGIN.name, version: PLUGIN.version },

    registerTool: function (def, handler) {
      // 支持两种写法：
      //   dsh.registerTool({ name, description, parameters }, handler)
      //   dsh.registerTool({ name, description, parameters, handler })
      if (!def || !def.name) throw new Error("registerTool 需要 name");
      var fn = handler || def.handler;
      if (typeof fn !== "function") throw new Error("registerTool 需要 handler 函数");
      toolHandlers[def.name] = fn;
      post({ __dshRegisterTool: { name: def.name, description: def.description || "", parameters: def.parameters || { type: "object", properties: {} } } });
      return true;
    },

    on: function (event, fn) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
      return true;
    },

    log: function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        try { parts.push(typeof a === "string" ? a : JSON.stringify(a)); }
        catch (e) { parts.push(String(a)); }
      }
      post({ __dshLog: parts.join(" ") });
    },

    host: granted
  };

  try {
    var code = decodeURIComponent(escape(atob(CODE_B64)));
    var fn = new Function("dsh", "PLUGIN", code);
    fn(dsh, dsh.plugin);
    post({ __dshReady: true });
  } catch (err) {
    post({ __dshError: String((err && err.message) || err) });
  }
})();
`;
}

/* ---------------- 宿主侧运行时 ---------------- */

/**
 * 一个已加载插件的运行时。
 *
 * 生命周期：new → mount（建 iframe）→ 就绪 → 可调用 → unmount。
 * 插件被禁用或卸载时，unmount 会销毁 iframe —— 沙箱里的一切随之消失，
 * 包括任何残留的定时器。
 */
class PluginRuntime {
  constructor(plugin) {
    this.plugin = plugin;
    this.token = `p_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
    this.iframe = null;
    this.tools = new Map(); // name → { name, description, parameters }
    this.pendingCalls = new Map();
    this.ready = false;
    this.error = "";
    this.logs = [];
    this.callSeq = 0;
    this.onMessage = this.onMessage.bind(this);
  }

  get id() {
    return this.plugin.id;
  }

  /** 建 iframe 并把插件代码灌进去。 */
  mount(doc) {
    const d = doc || document;
    const iframe = d.createElement("iframe");
    iframe.setAttribute("sandbox", SANDBOX_ATTR);
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.display = "none";
    iframe.style.width = "0";
    iframe.style.height = "0";

    const bootstrap = bootstrapScript(
      {
        id: this.plugin.id,
        name: this.plugin.name,
        version: this.plugin.version,
        permissions: this.plugin.permissions || [],
        code: this.plugin.code || "",
      },
      this.token
    );

    // 用 srcdoc 承载引导脚本：整段 HTML 都在沙箱内自解析完成，
    // 不需要宿主动态写 iframe.contentDocument（那需要 allow-same-origin）。
    //
    // 注意：**不要**同时设 src="about:blank"。
    // src 与 srcdoc 各触发一次导航，两者提交顺序不保证 ——
    // 晚到的那次会替换掉已经跑起插件代码的文档，
    // 于是宿主这边工具表里还留着工具名，插件那边却已经没有对应的 handler，
    // 调用时报「工具未注册」。只设 srcdoc，导航就只有一次。
    const html = `<!doctype html><meta charset="utf-8"><script>${bootstrap}<\/script>`;
    iframe.srcdoc = html;

    d.body.appendChild(iframe);
    this.iframe = iframe;
    window.addEventListener("message", this.onMessage);
    return this;
  }

  onMessage(ev) {
    const d = ev.data;
    if (!d || d.__dshToken !== this.token) return;
    // 只接受来自自己 iframe 的消息
    if (this.iframe && ev.source !== this.iframe.contentWindow) return;

    if (d.__dshReady) {
      this.ready = true;
      return;
    }
    if (d.__dshError) {
      this.error = d.__dshError;
      this.ready = false;
      return;
    }
    if (d.__dshRegisterTool) {
      const t = d.__dshRegisterTool;
      this.tools.set(t.name, {
        name: t.name,
        description: t.description || "",
        parameters: t.parameters || { type: "object", properties: {} },
      });
      return;
    }
    if (d.__dshLog) {
      this.logs.push(String(d.__dshLog));
      if (this.logs.length > 200) this.logs.shift();
      return;
    }
    if (d.__dshHostCall) {
      this.handleHostCall(d.__dshHostCall, d.__dshCallId, d.params || {});
      return;
    }
    if (d.__dshReply) {
      const p = this.pendingCalls.get(d.__dshReply);
      if (!p) return;
      this.pendingCalls.delete(d.__dshReply);
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || "插件调用失败"));
    }
  }

  /** 插件请求宿主能力。逐项按已声明的权限放行。 */
  async handleHostCall(method, callId, params_) {
    const reply = (ok, result, error) => {
      this.post({ __dshReply: callId, ok, result, error });
    };
    const granted = new Set(this.plugin.permissions || []);
    if (!granted.has(method)) {
      reply(false, null, `插件未声明权限「${method}」，已拒绝`);
      return;
    }
    try {
      // ============ 这里原来有个 bug ============
      //
      // 写的是 `d.__dshHostCallParams` —— 但这个作用域里根本没有 `d`
      // （`d` 是 onMessage 里的局部变量，不是模块级变量）。
      // 一执行就抛 ReferenceError，被下面的 catch 吞掉，
      // 于是**所有**宿主能力调用（fs.read / fs.write / net）全部失败，
      // 而且失败信息是「d is not defined」—— 完全指不到真正的问题。
      //
      // 参数已经传进来了，直接用形参。
      const params = params_ || {};
      let out;
      if (method === "fs.read") out = await hostImpl.fsRead(this.plugin, params);
      else if (method === "fs.write") out = await hostImpl.fsWrite(this.plugin, params);
      else if (method === "net") out = await hostImpl.netFetch(this.plugin, params);
      else {
        reply(false, null, `未知能力：${method}`);
        return;
      }
      reply(out?.ok !== false, out?.result ?? out?.output ?? null, out?.error || "");
    } catch (err) {
      reply(false, null, err.message || String(err));
    }
  }

  post(msg) {
    if (!this.iframe || !this.iframe.contentWindow) return;
    try {
      this.iframe.contentWindow.postMessage({ ...msg, __dshToken: this.token }, "*");
    } catch {
      /* 沙箱已销毁 */
    }
  }

  /** 调用插件注册的工具。 */
  async call(toolName, args) {
    if (!this.ready) throw new Error(this.error || "插件尚未就绪");
    if (!this.tools.has(toolName)) throw new Error(`插件未注册工具：${toolName}`);
    const id = `t${++this.callSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`插件工具 ${toolName} 执行超时`));
      }, CALL_TIMEOUT);
      this.pendingCalls.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.post({ __dshToolCall: toolName, __dshCallId: id, args: args || {} });
    });
  }

  /** 销毁沙箱。iframe 一删，插件里的定时器、网络、闭包全部随之消失。 */
  unmount() {
    window.removeEventListener("message", this.onMessage);
    this.pendingCalls.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(new Error("插件已被卸载"));
    });
    this.pendingCalls.clear();
    if (this.iframe && this.iframe.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe);
    }
    this.iframe = null;
    this.ready = false;
    this.tools.clear();
  }
}

/* ---------------- 全局运行时表 ---------------- */

const runtimes = new Map();

/** 加载一个插件（会重建它的沙箱）。 */
export function loadPlugin(plugin, doc) {
  unloadPlugin(plugin.id);
  const rt = new PluginRuntime(plugin);
  rt.mount(doc);
  runtimes.set(plugin.id, rt);
  return rt;
}

export function unloadPlugin(id) {
  const rt = runtimes.get(id);
  if (!rt) return false;
  rt.unmount();
  runtimes.delete(id);
  return true;
}

export function isLoaded(id) {
  return runtimes.has(id);
}

export function runtimeOf(id) {
  return runtimes.get(id) || null;
}

/** 当前所有已加载插件注册的工具（宿主侧用来装配工具表）。 */
export function registeredTools() {
  const out = [];
  runtimes.forEach((rt) => {
    rt.tools.forEach((t) => {
      out.push({ ...t, pluginId: rt.id, pluginName: rt.plugin.name });
    });
  });
  return out;
}

/** 卸载全部插件（应用启动 / 状态重载时调用）。 */
export function unloadAll() {
  Array.from(runtimes.keys()).forEach((id) => unloadPlugin(id));
}

/** 供沙箱回传日志与错误。 */
export function pluginDiagnostics(id) {
  const rt = runtimes.get(id);
  if (!rt) return null;
  return {
    ready: rt.ready,
    error: rt.error,
    tools: Array.from(rt.tools.keys()),
    logs: rt.logs.slice(-20),
  };
}
