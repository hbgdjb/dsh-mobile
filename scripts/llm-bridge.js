/* ============================================================
   llm 桥接 —— 把 Node 侧注册的模型供应方并进手机端的模型表

   ============ 这条链路的全貌 ============

   插件（Node 侧）
     └─ ctx.llm.registerAdapter(['our-free-model'], adapter)
          ↓
   Node 侧 llm 服务（android/node/llm-service.js）
     └─ 维护路由表：provider → adapter
          ↓ 通道事件 llm.routes
   页面侧（本文件）
     └─ 把路由表并进 state.settings.customModels
          ↓
   模型选择器 —— 用户能选到插件提供的模型

   ============ 为什么必须走 Node 侧 ============

   adapter 是插件的闭包 —— 只有加载了插件的 Node 进程能执行它。
   模型表在页面侧，调用在 Node 侧。所以模型条目要在页面侧建，
   执行要走 Node。

   ============ 模型条目的形状 ============

   手机端的 customModels 里每一项长这样（见 scripts/store.js）：

     { id, name, apiModel, baseUrl, provider, ctx, maxTokens, ... }

   插件提供的模型没有 baseUrl（那是 HTTP 端点），它的端点在 Node 侧的
   adapter 里。所以这里的条目用一种特殊形状：

     { id, name, provider: "node__<provider>", nodeProvider: "<provider>",
       ctx, maxTokens, source: "node-llm" }

   页面侧的模型调用流程看到 source === "node-llm" 就知道
   「这个模型要交给 Node 的 adapter 去跑」，而不是直接发 HTTP。
   ============================================================ */

import {
  nodeBridgeAvailable,
  nodeOnEvent,
  nodeListModels,
  nodeLlmRoutes,
  nodeLlmChat,
  nodeLlmAbort,
} from "./node-runtime.js";
import { upsertCustomModel } from "./store.js";

/** Node 侧注册的路由表（provider → { provider, name }）。 */
let nodeRoutes = [];

/** 是否已经订阅过路由推送。 */
let subscribed = false;

/** 订阅 Node 的路由变更推送。幂等。 */
export function ensureLlmRouteSubscription() {
  if (subscribed) return;
  if (!nodeBridgeAvailable()) return;
  subscribed = true;
  try {
    nodeOnEvent((event, data) => {
      if (event !== "llm.routes") return;
      const list = Array.isArray(data?.routes) ? data.routes : [];
      nodeRoutes = list.map((r) => ({
        provider: String(r?.provider || ""),
        name: String(r?.name || r?.provider || ""),
      }));
      // ============ 为什么不能只 syncLlmModels() ============
      //
      // 只更新路由表的话，模型条目一条都不会新增 —— syncLlmModels 拿不到
      // 模型清单，它只按「已知的发现结果」插入条目。
      //
      // 而路由变化最常见的场景恰恰是「用户刚装好/刚重新加载了插件」：
      // 那时候模型一条都还没进模型表。只同步路由的后果是
      // 用户装完插件、重新加载，选择器里空空如也 —— 会以为没装上。
      //
      // 所以这里重新走一遍完整同步：问每个路由「你眼下有哪些模型」。
      syncNodeLlmModels().catch(() => {});
    });
  } catch {
    subscribed = false;
  }
}

/** 当前 Node 侧的路由表。 */
export function llmRoutes() {
  return nodeRoutes.slice();
}

/**
 * 模型条目 id。
 *
 * 插件侧的模型 id 是插件自己的（可能是 "deepseek-v4.1-flash" 这种），
 * 但手机端的 customModels 按 id 去重，所以要加前缀区分来源。
 */
function modelEntryId(provider, modelId) {
  return `node__${provider}__${modelId}`;
}

/**
 * 把 Node 侧的路由同步进手机端模型表。
 *
 * ============ 这里做了什么、没做什么 ============
 *
 * 做了：把「哪个供应方存在」这件事落到手机端的模型表里，
 * 让用户能在选择器里看到「我们的免费模型」这个分组。
 *
 * 没做：**还没有把插件真正提供的模型清单拉下来**。
 * 插件的模型清单要通过 `registerModelDiscovery` 注册的发现函数去问，
 * 那是一次网络请求，要等插件的探测流程跑完才有结果。
 * 桌面版是在设置页点「检测模型」按钮时问的。
 *
 * 所以这一阶段先落「供应方」这一层 —— 分组能显示出来，
 * 具体模型条目等发现流程接通后再补。这是诚实的分步，
 * 不是假装模型已经能用。
 *
 * @param {object} opts
 *   opts.models  要并入的模型清单 [{ id, name, provider, contextWindow, maxTokens }]
 */
export function syncLlmModels(opts = {}) {
  ensureLlmRouteSubscription();
  if (!nodeRoutes.length) return [];

  const discovered = Array.isArray(opts.models) ? opts.models : [];
  const added = [];

  for (const route of nodeRoutes) {
    if (!route.provider) continue;

    // 该供应方下已知的模型
    const models = discovered.filter((m) => m.provider === route.provider);

    // 没有发现结果时**不塞占位条目** ——
    // 一个点了就报错的空模型，比看不见更糟。
    for (const m of models) {
      const id = modelEntryId(route.provider, m.id);
      const entry = {
        id,
        // label 是手机端所有界面读取的显示名（模型卡标题、抽屉底部、
        // 设置摘要都用它）。少了它，界面上会显示成 undefined ——
        // 用户看到的就是「模型没切换过来」。
        label: m.name || m.id,
        name: m.name || m.id,
        apiModel: m.id,
        provider: `node__${route.provider}`,
        nodeProvider: route.provider,
        source: "node-llm",
        pending: false,
        ctx: Number(m.contextWindow) || 0,
        maxTokens: Number(m.maxTokens) || 0,
        inputModalities: Array.isArray(m.inputModalities) ? m.inputModalities : [],
      };
      upsertCustomModel(entry);
      added.push(entry);
    }
  }

  return added;
}

/**
 * 这个模型条目是不是由 Node 侧的 llm 插件提供的。
 *
 * 模型调用流程用它决定「走 HTTP 还是走 Node adapter」。
 */
export function isNodeLlmModel(model) {
  if (!model) return false;
  if (model.source === "node-llm") return true;
  return String(model.provider || "").startsWith("node__");
}

/** 取模型条目对应的 Node 侧供应方名。 */
export function nodeProviderOf(model) {
  if (!model) return "";
  if (model.nodeProvider) return String(model.nodeProvider);
  const p = String(model.provider || "");
  return p.startsWith("node__") ? p.slice("node__".length) : "";
}

/* ============================================================
   调用 —— 让插件提供的模型真的跑起来

   ============ 为什么不能直接用 HTTP 那条路 ============

   插件提供的模型没有 baseUrl（HTTP 端点）—— 它的端点在 Node 侧的
   adapter 里，而 adapter 是插件自己的闭包。页面拿不到它，只能请 Node 代跑。

   ============ 数据怎么流回来 ============

     nodeLlmChat(callId, ...)  →  Node 起跑，立刻返回
     Node: llm.chunk 事件，一次带一批 StreamChunk
     Node: llm.done 事件，收尾（成功/失败/被用户停掉）

   页面按 callId 对号入座 —— 同时跑多个生成也不会串台。
   ============================================================ */

/** callId → { onChunk, onDone, timer } */
const running = new Map();

/** 是否已订阅过流式推送。 */
let streamSubscribed = false;

/** 多久没有任何数据就认为链路死了（毫秒）。 */
const IDLE_TIMEOUT_MS = 300000;

let callSeq = 0;

function nextCallId() {
  callSeq += 1;
  return `c_${Date.now().toString(36)}_${callSeq}`;
}

/** 订阅 Node 的流式推送。幂等。 */
function ensureStreamSubscription() {
  if (streamSubscribed) return;
  if (!nodeBridgeAvailable()) return;
  streamSubscribed = true;
  try {
    nodeOnEvent((event, data) => {
      if (event !== "llm.chunk" && event !== "llm.done") return;
      const callId = String(data?.callId || "");
      const entry = running.get(callId);
      if (!entry) return;
      entry.touch();
      if (event === "llm.chunk") {
        const chunks = Array.isArray(data?.chunks) ? data.chunks : [];
        for (const chunk of chunks) entry.onChunk(chunk);
        return;
      }
      // done：不管成功失败，这条链路到此为止
      running.delete(callId);
      entry.onDone({
        ok: data?.ok === true,
        aborted: data?.aborted === true,
        finish: String(data?.finish || "stop"),
        error: data?.error ? String(data.error) : "",
        code: data?.code ? String(data.code) : "",
        usage: data?.usage || null,
      });
    });
  } catch {
    streamSubscribed = false;
  }
}

/**
 * 用插件提供的 adapter 跑一次生成。
 *
 * 返回的形状与 `chatOnce` 里走 HTTP 那条路一致：`{ calls, finish }`，
 * `calls` 是 `[{ id, name, args }]`（args 是 JSON 字符串）。
 * 所以调用方不需要为两条路写两套下游逻辑。
 *
 * @param {object} opts
 *   opts.provider         路由名（adapter 的注册名）
 *   opts.model            模型 id
 *   opts.messages         OpenAI 形状的消息
 *   opts.tools            工具定义
 *   opts.system           系统提示词
 *   opts.temperature      温度
 *   opts.maxTokens        输出上限
 *   opts.reasoningEffort  推理档位
 *   opts.signal           AbortSignal
 *   opts.onText / onReasoning / onUsage / onToolDelta  与 HTTP 那条路同签名
 * @returns {Promise<{ calls: Array, finish: string }>}
 */
export async function streamViaNode(opts = {}) {
  if (!nodeBridgeAvailable()) throw new Error("当前环境没有 Node 运行时");
  ensureStreamSubscription();

  const callId = nextCallId();
  const calls = [];
  let usage = null;

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      running.delete(callId);
      opts.signal?.removeEventListener?.("abort", onAbort);
      fn(value);
    };

    /** 有数据就续命 —— 长回答不该被「总时长」掐断，只该被「一直没动静」掐断。 */
    const touch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        settle(reject, new Error("Node 侧的模型调用长时间没有响应，已中断"));
        nodeLlmAbort(callId).catch(() => {});
      }, IDLE_TIMEOUT_MS);
    };

    const onAbort = () => {
      // 告诉 Node 停下来 —— 不然额度还在烧，只是页面不显示了
      nodeLlmAbort(callId).catch(() => {});
      settle(reject, Object.assign(new Error("已停止生成"), { name: "AbortError" }));
    };

    if (opts.signal?.aborted) {
      reject(Object.assign(new Error("已停止生成"), { name: "AbortError" }));
      return;
    }
    opts.signal?.addEventListener?.("abort", onAbort, { once: true });

    running.set(callId, {
      touch,
      onChunk(chunk) {
        if (!chunk || typeof chunk !== "object") return;
        if (chunk.type === "text-delta") {
          if (chunk.text) opts.onText?.(String(chunk.text));
          return;
        }
        if (chunk.type === "reasoning-delta") {
          if (chunk.text) opts.onReasoning?.(String(chunk.text));
          return;
        }
        if (chunk.type === "tool-call-delta") {
          const i = Number.isInteger(chunk.index) ? chunk.index : calls.length;
          if (!calls[i]) calls[i] = { id: "", name: "", args: "" };
          if (chunk.id) calls[i].id = String(chunk.id);
          if (chunk.name) calls[i].name = String(chunk.name);
          if (chunk.argumentsDelta) calls[i].args += String(chunk.argumentsDelta);
          // 页面上的「正在调用工具」提示靠这个回调驱动
          opts.onToolDelta?.([
            {
              index: i,
              id: calls[i].id || undefined,
              function: calls[i].name ? { name: calls[i].name } : undefined,
            },
          ]);
          return;
        }
        if (chunk.type === "block-end") {
          const block = chunk.block;
          if (!block || block.type !== "tool-call") return;
          // block-end 带的是**装配好的**块，以它为准 ——
          // 增量可能因为断流少了尾巴，而这里一定是最终形态。
          const i = Number.isInteger(chunk.index) ? chunk.index : calls.length;
          calls[i] = {
            id: String(block.id || ""),
            name: String(block.name || ""),
            args: String(block.arguments || "{}"),
          };
          return;
        }
        if (chunk.type === "usage" && chunk.usage) {
          usage = chunk.usage;
          opts.onUsage?.({
            prompt_tokens: Number(chunk.usage.inputTokens) || 0,
            completion_tokens: Number(chunk.usage.outputTokens) || 0,
            total_tokens: Number(chunk.usage.totalTokens) || 0,
          });
        }
      },
      onDone(info) {
        if (info.usage) {
          opts.onUsage?.({
            prompt_tokens: Number(info.usage.inputTokens) || 0,
            completion_tokens: Number(info.usage.outputTokens) || 0,
            total_tokens: Number(info.usage.totalTokens) || 0,
          });
        }
        if (!info.ok) {
          if (info.aborted) {
            settle(reject, Object.assign(new Error("已停止生成"), { name: "AbortError" }));
            return;
          }
          settle(reject, new Error(info.error || "模型调用失败"));
          return;
        }
        settle(resolve, { finish: info.finish || "stop" });
      },
    });

    touch();

    nodeLlmChat({
      callId,
      provider: String(opts.provider || ""),
      model: String(opts.model || ""),
      messages: Array.isArray(opts.messages) ? opts.messages : [],
      tools: Array.isArray(opts.tools) ? opts.tools : [],
      system: String(opts.system || ""),
      temperature: typeof opts.temperature === "number" ? opts.temperature : undefined,
      maxTokens: Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : undefined,
      reasoningEffort: opts.reasoningEffort ? String(opts.reasoningEffort) : undefined,
    }).catch((err) => {
      settle(reject, err);
    });
  });

  return {
    // 无名无参的残留块不算调用 —— 执行它只会得到「未知工具」
    calls: calls.filter((c) => c && c.name),
    finish: result.finish,
    usage,
  };
}

/**
 * 完整同步：问 Node 侧要供应方和模型清单，然后并进手机端模型表。
 *
 * 这是页面侧在「通道刚连上」和「用户点刷新」时调用的入口。
 *
 * @returns {Promise<Array>} 并入的模型条目
 */
export async function syncNodeLlmModels() {
  if (!nodeBridgeAvailable()) return [];
  ensureLlmRouteSubscription();

  let routes = [];
  try {
    const r = await nodeLlmRoutes();
    routes = r.routes;
  } catch {
    return [];
  }

  // 路由表也更新一份（事件推送可能还没到）
  if (routes.length) {
    nodeRoutes = routes.map((r) => ({
      provider: String(r?.provider || ""),
      name: String(r?.name || r?.provider || ""),
    }));
  }

  // 逐个路由问「你眼下提供哪些模型」
  // 用路由问而不是用发现命名空间问 —— adapter 返回的每一项自带
  // provider，路由名天然一致；发现命名空间是另一套标识（插件 id），
  // 两者对不上。
  const all = [];
  for (const route of nodeRoutes) {
    if (!route.provider) continue;
    try {
      const models = await nodeListModels(route.provider);
      for (const m of models) {
        all.push({ ...m, provider: m.provider || route.provider });
      }
    } catch {
      // 一个供应方问失败不影响其它
    }
  }

  return syncLlmModels({ models: all });
}
