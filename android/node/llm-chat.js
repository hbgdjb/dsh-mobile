'use strict';

/**
 * 把一次「页面侧对话」翻译成 `llm` adapter 的调用。
 *
 * ============ 它解决什么问题 ============
 *
 * 插件注册的模型供应方（`ctx.llm.registerAdapter`）拿到的是 **DSH harness 的
 * GenerateOptions**：消息是带类型块的（`{type:'text'}` / `{type:'tool-call'}` /
 * `{type:'tool-result'}`），不是 OpenAI 的 `{role, content, tool_calls}`。
 *
 * 而手机端的对话主循环（`scripts/runtime.js`）一直是按 OpenAI 的形状攒消息的
 * —— 它要发给 HTTP 网关。
 *
 * 所以中间必须有一层翻译：
 *
 *     页面（OpenAI 形状）
 *       → toHarnessMessages()   ← 本文件
 *       → adapter.stream(options)
 *       → StreamChunk[]          ← harness 的「扁平索引块」协议
 *       → 页面再翻译回 {calls, finish}
 *
 * ============ StreamChunk 的协议是从哪来的 ============
 *
 * 不是猜的。真实插件 `dsh-our-free-model@2.5.9` 的 `src/stream.js` 顶部写着：
 *
 *   「The harness contract (packages/llm/llm/src/types.ts StreamChunk) is a flat
 *     indexed block protocol: every block is opened with `block-start`, fed with
 *     deltas, and closed with `block-end` carrying the assembled block.」
 *
 * 于是有这六种：
 *
 *   { type: 'block-start',     index, blockType: 'text'|'reasoning'|'tool-call' }
 *   { type: 'text-delta',      index, text }
 *   { type: 'reasoning-delta', index, text }
 *   { type: 'tool-call-delta', index, id?, name?, argumentsDelta }
 *   { type: 'block-end',       index, block: {...装配好的块} }
 *   { type: 'usage',           usage: { inputTokens, outputTokens, totalTokens } }
 *   { type: 'finish',          reason: { kind, failure? } }
 *
 * ============ 本文件不做的事 ============
 *
 * 不碰通道、不碰 setInterval、不认 provider —— 纯函数 + 一次迭代。
 * 这样它可以被单测直接喂假 adapter，不必起 Node 进程。
 */

/**
 * 把消息内容拍平成纯文本。
 *
 * OpenAI 允许 content 是字符串，也允许是 part 数组；
 * harness 的文本块只要文本本身。
 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (p && p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
  }
  return parts.join('\n');
}

/**
 * OpenAI Chat 消息 → harness 消息。
 *
 * 三种角色要特别处理：
 *   · assistant 的 `tool_calls` 要变成 `{type:'tool-call'}` 块
 *     （harness 不认 OpenAI 的 `tool_calls` 字段，它认内容块）；
 *   · `role:'tool'` 的 `tool_call_id` 要变成 `toolCallId`
 *     （harness 用这个字段把结果和调用配对）；
 *   · 图片要变成 `{type:'image', attachment:{url}}` ——
 *     插件的 `imageDataUrl()` 正是读 `block.attachment.url`。
 *
 * @param {Array} messages OpenAI 形状的消息
 * @returns {Array} harness 形状的消息
 */
function toHarnessMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    const role = String(m.role || 'user');

    if (role === 'system' || role === 'developer') {
      const text = textOf(m.content);
      if (text) out.push({ role: 'system', content: text });
      continue;
    }

    if (role === 'tool') {
      // 空 id 的工具结果在真 cordis 里会被整条丢弃（配不上任何调用），
      // 这里也直接跳过 —— 发上去只会换回一个 400。
      const callId = String(m.tool_call_id || '');
      if (!callId) continue;
      out.push({
        role: 'tool',
        toolCallId: callId,
        content: [{ type: 'text', text: textOf(m.content) || '(no output)' }],
      });
      continue;
    }

    if (role === 'assistant') {
      const blocks = [];
      const text = textOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const id = String((c && c.id) || '');
        const name = String((c && c.function && c.function.name) || '');
        if (!name) continue; // 无名调用不可执行，留着重放会毒化整段历史
        blocks.push({
          type: 'tool-call',
          id,
          name,
          arguments: String((c.function && c.function.arguments) || '{}'),
        });
      }
      if (!blocks.length) continue;
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    // user
    const blocks = [];
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    for (const p of Array.isArray(parts) ? parts : []) {
      if (!p) continue;
      if (p.type === 'text' && typeof p.text === 'string' && p.text) {
        blocks.push({ type: 'text', text: p.text });
      } else if (p.type === 'image_url') {
        const url = (p.image_url && p.image_url.url) || '';
        if (url) blocks.push({ type: 'image', attachment: { url: String(url) } });
      } else if (p.type === 'image') {
        const url = p.url || p.dataUrl || (p.attachment && p.attachment.url) || '';
        if (url) blocks.push({ type: 'image', attachment: { url: String(url) } });
      }
    }
    if (blocks.length) out.push({ role: 'user', content: blocks });
  }
  return out;
}

/**
 * 跑一次 adapter 的流式调用。
 *
 * 优先用 `prepareCall(provider, model)` —— 它会把模型元信息与分发闭包
 * **绑在同一个状态快照**上（插件自己的注释说：这样一次刷新不会把一代模型的
 * 容量和另一代的端点表混在一起）。没有 prepareCall 的 adapter 退回直接 `stream()`。
 *
 * @param {object} opts
 *   opts.adapter          adapter 实例
 *   opts.provider         路由名
 *   opts.model            模型 id
 *   opts.messages         OpenAI 形状的消息
 *   opts.tools            工具定义（OpenAI 或扁平定义都行，插件两种都认）
 *   opts.system           系统提示词（可选）
 *   opts.temperature      温度（可选）
 *   opts.maxTokens        输出上限（可选，0 表示用 adapter 的默认值）
 *   opts.reasoningEffort  'off' | 'low' | 'high' | 'max'（可选）
 *   opts.signal           AbortSignal（可选）
 *   opts.onChunk          (chunk) => void，每个 StreamChunk 调一次
 * @returns {Promise<{ finish: string, usage: object, model: object }>}
 */
async function runAdapterStream(opts) {
  const adapter = opts.adapter;
  const provider = String(opts.provider || '');
  const model = String(opts.model || '');

  if (!adapter || typeof adapter.stream !== 'function') {
    throw new Error('这个供应方没有可用的 adapter（缺少 stream 方法）');
  }

  const options = {
    model,
    messages: toHarnessMessages(opts.messages),
    tools: Array.isArray(opts.tools) ? opts.tools : [],
    signal: opts.signal,
  };
  if (typeof opts.system === 'string' && opts.system) options.system = opts.system;
  if (typeof opts.temperature === 'number' && Number.isFinite(opts.temperature)) {
    options.temperature = opts.temperature;
  }
  if (Number(opts.maxTokens) > 0) options.maxTokens = Number(opts.maxTokens);
  if (typeof opts.reasoningEffort === 'string' && opts.reasoningEffort) {
    options.reasoningEffort = opts.reasoningEffort;
  }

  let iterator = null;
  let resolvedModel = null;

  if (typeof adapter.prepareCall === 'function') {
    const prepared = await adapter.prepareCall(provider, model);
    if (prepared) {
      resolvedModel = prepared.model || null;
      // adapter 没给上限时，用它自己声明的默认值 —— 否则有些车道会按
      // 「不传就等于不给输出」处理，直接回空。
      if (options.maxTokens === undefined && resolvedModel && Number(resolvedModel.defaultMaxTokens) > 0) {
        options.maxTokens = Number(resolvedModel.defaultMaxTokens);
      }
      if (typeof prepared.stream === 'function') iterator = prepared.stream(options);
    }
  }
  if (!iterator) iterator = adapter.stream(options);

  let finish = 'stop';
  let usage = null;
  let failure = null;

  for await (const chunk of iterator) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'usage' && chunk.usage) {
      usage = chunk.usage;
    } else if (chunk.type === 'finish') {
      const reason = chunk.reason || {};
      finish = String(reason.kind || 'stop');
      if (reason.kind === 'error') {
        failure = reason.failure || { message: '模型调用失败' };
      }
    }
    if (typeof opts.onChunk === 'function') opts.onChunk(chunk);
  }

  return { finish, usage, failure, model: resolvedModel };
}

module.exports = { toHarnessMessages, runAdapterStream };
