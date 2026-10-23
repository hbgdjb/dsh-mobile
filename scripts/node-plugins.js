/* ============================================================
   Node 插件的接入层 —— 把 Node 里注册的工具并进 AI 的工具表

   ============ 为什么单独一层 ============

   现有的插件（iframe 沙箱那套）在 WebView 里跑，工具通过
   plugin-host.js 的 postMessage 通道执行。而 Node 插件跑在另一个
   JS 引擎里，工具要走原生通道执行。

   两套执行路径不同，但 AI 助手只认一种工具表。所以这里把
   Node 插件的工具**伪装成和 iframe 插件一样的形状**：

     工具名    plugin__<pluginId>__<toolName>
     schema    { type:"function", function:{ name, description, parameters } }
     调用      callPluginTool(name, args) 统一分发到对应那套运行时

   这样 tools.js 一个字都不用改 —— 它已经按
   `plugin__xxx__yyy` 的约定去找执行入口了。

   ============ 工具表是动态的 ============

   插件是运行时才加载的（Node 起来之后才知道有哪些工具），
   所以工具表必须在每次取用前重新算，不能缓存成静态表。
   ============================================================ */

import {
  nodeBridgeAvailable,
  nodeStatus,
  nodeCall,
  nodeCallTool,
  nodeOnEvent,
} from "./node-runtime.js";

/** Node 侧注册的工具（由 tools.changed 推送更新）。 */
let nodeTools = [];

/** Node 插件的 id 前缀 —— 与 iframe 插件区分开，避免同名撞车。 */
const NODE_PREFIX = "plugin__node__";

/** 是否已经订阅过推送。 */
let subscribed = false;

/**
 * 订阅 Node 的工具变更推送。
 *
 * 幂等 —— 多次调用只订阅一次。
 */
export function ensureNodeToolSubscription() {
  if (subscribed) return;
  if (!nodeBridgeAvailable()) return;
  subscribed = true;
  try {
    nodeOnEvent((event, data) => {
      if (event !== "tools.changed") return;
      const list = Array.isArray(data?.tools) ? data.tools : [];
      nodeTools = list.map((t) => ({
        ...t,
        // Node 侧的插件 id 统一加前缀，避免和 iframe 插件同名
        pluginId: `node__${t.pluginId || "unknown"}`,
        pluginName: t.pluginName || t.pluginId || "Node 插件",
      }));
    });
  } catch {
    subscribed = false;
  }
}

/**
 * Node 插件注册的工具（schema 形态）。
 *
 * 与 iframe 插件的工具合并返回 —— 宿主只认一种形状。
 */
export function nodeToolSchemas() {
  ensureNodeToolSubscription();
  const out = [];
  for (const t of nodeTools) {
    out.push({
      type: "function",
      function: {
        name: `${NODE_PREFIX}${t.name}`,
        description: `[Node 插件 · ${t.pluginName}] ${t.description || t.name}`,
        parameters: t.parameters || { type: "object", properties: {} },
      },
    });
  }
  return out;
}

/**
 * 调 Node 插件的工具。
 *
 * 名字形如 plugin__node__<toolName>。
 */
export async function callNodeTool(fullName, args) {
  const prefix = `${NODE_PREFIX}`;
  if (!String(fullName || "").startsWith(prefix)) {
    return { ok: false, output: `不是 Node 插件工具：${fullName}` };
  }
  const toolName = String(fullName).slice(prefix.length);
  if (!toolName) {
    return { ok: false, output: "缺少工具名" };
  }
  // 通道没连上就别试了 —— 直接说清楚原因，比让用户等超时好
  const st = nodeStatus();
  if (!st.channelConnected) {
    return {
      ok: false,
      output:
        "Node 插件运行时未就绪（通道未连接）。请在设置里确认「插件运行时」已启动，" +
        "并已下载运行时。",
    };
  }
  try {
    const r = await nodeCallTool(toolName, args || {});
    return {
      ok: true,
      output: typeof r === "string" ? r : JSON.stringify(r),
    };
  } catch (err) {
    return { ok: false, output: `Node 插件调用失败：${err?.message || err}` };
  }
}

/** 供设置页展示：Node 侧的工具清单。 */
export function nodeToolList() {
  ensureNodeToolSubscription();
  return nodeTools.map((t) => ({
    name: t.name,
    description: t.description,
    pluginId: t.pluginId,
    pluginName: t.pluginName,
  }));
}

/**
 * 主动从 Node 拉一次工具清单。
 *
 * 推送可能因为 Node 晚启动而错过（页面先加载、Node 后起来），
 * 所以设置页打开时要主动拉一次补齐。
 *
 * ============ 这里只读，不加载 ============
 *
 * 之前这里顺手调了一次 `plugins.load` —— 那会把**已经加载好的插件**
 * 再 apply 一遍，出现两个实例同时跑、宿主服务注册撞车的问题。
 *
 * 现在分成两个明确的操作：
 *   · refreshNodeTools()   —— 只读列表
 *   · loadNewNodePlugins() —— 只加载没加载过的（装完新插件时用）
 *
 * @param {{load?:boolean}} [opts] load=true 时顺带加载新插件
 * @returns {Promise<Array<object>>} 插件列表
 */
export async function refreshNodeTools(opts = {}) {
  ensureNodeToolSubscription();
  if (!nodeBridgeAvailable()) return [];
  try {
    const r = await nodeCall("plugins.list", {});
    if (opts.load) {
      await nodeCall("plugins.loadnew", {});
    }
    return r?.plugins || [];
  } catch {
    return [];
  }
}

/**
 * 只加载还没加载过的插件。
 *
 * 装完新插件时用 —— 已在跑的那些绝不能重跑。
 */
export async function loadNewNodePlugins() {
  if (!nodeBridgeAvailable()) return { loaded: 0, failed: [] };
  try {
    return await nodeCall("plugins.loadnew", {});
  } catch {
    return { loaded: 0, failed: [] };
  }
}

/**
 * 一个插件的详情：它注册了哪些工具、提供了哪些模型、卡在哪个依赖上。
 *
 * 列表里只有「名字 + 版本 + 工具数」——装完插件，用户第一个问题
 * 恰恰是「它到底带来了什么」。
 */
export async function nodePluginDetail(id) {
  return await nodeCall("plugins.detail", { id: String(id || "") });
}
