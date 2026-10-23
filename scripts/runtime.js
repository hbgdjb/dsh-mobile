/* ============================================================
   Runtime — Agent 主循环
   两种驱动器：
   1) live：OpenAI 兼容流式接口（DeepSeek / 自定义网关）
   2) 无模型 / 无 Key：直接报错，不再提供本地演示，避免误判
   ============================================================ */

import {
  state,
  currentMode,
  readFile,
  readDoc,
  fmtTime,
  currentModel,
  modelApiId,
  modelBaseUrl,
  modelContextWindow,
  apiKeyFor,
  apiKeyForCurrent,
  addDiagnostic,
  setModelStatus,
  allModels,
  knownModelVision,
  upsertCustomModel,
} from "./store.js";
import { trimMessages, compactMessages, estimateTokens } from "./context.js";
import { buildSystemPromptText } from "./prompt.js";
import { sanitizeUntrusted } from "./inject.js";
import { toolSchemas, executeTool, availableToolNames, inspectPath } from "./tools.js";
import { nativeStream, nativeHttpAvailable } from "./native-http.js";
import { isImagePath, imageMime, prepareImage } from "./image.js";
import {
  buildPromptBlock,
  detectCorrection,
  createTagFilter,
  stripMemoryTags,
  persistTags,
} from "./memory.js";
import { beginTrajectory, captureTool, endTrajectory, abortTrajectory } from "./traj.js";
import { isNodeLlmModel, nodeProviderOf, streamViaNode } from "./llm-bridge.js";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });

/* ---------------- 系统提示词 ---------------- */

/**
 * 组装 system prompt。
 *
 * ============ 为什么改成走 scripts/prompt.js ============
 *
 * 0.31.0 量过：40 个工作区文件 + 20 份资料的场景下，
 * 旧版提示词到了 1212 token，其中 547 token 是两段**路径清单**。
 *
 * 问题不是「长」，是**放错了层**。借用的判据是
 * 「这东西谁会读？多久读一次？」：
 *   · 每轮都读     → 注入层，必须极短
 *   · 需要时才查   → 共享层，不该预载
 *
 * 文件清单属于后者 —— fs_list / library_list 本来就能查。
 * 清单的权威是存储层，提示词里再存一份就是**两份权威**，
 * 而提示词那份会过期（用户随时改文件），过期的反而误导模型。
 *
 * 所以现在只给「地图」（顶层目录 + 根目录几个文件 + 总数），
 * 并明确告诉模型用哪个工具查完整清单。
 *
 * @param {string} query 当前用户输入（目前只用于日志与将来的相关性裁剪）
 * @returns {string}
 */
function buildSystemPrompt(query = "") {
  void query;
  const { text } = buildSystemPromptText(promptContext());
  return text;
}

/** 从当前状态取提示词需要的全部上下文。 */
function promptContext() {
  const mode = currentMode();
  return {
    mode: { name: mode.name, detail: mode.detail },
    permission:
      state.settings.permission === "readonly"
        ? "只读"
        : state.settings.permission === "full"
          ? "完全访问"
          : "工作区写入",
    reasoning: state.settings.reasoning,
    files: Object.values(state.files || {}),
    library: Object.values(state.library || {}),
    plugins: state.plugins.filter((p) => p.enabled),
    mcpServers: Array.isArray(state.settings.mcpServers) ? state.settings.mcpServers : [],
    minimal: state.settings.mode === "minimal",
    now: new Date().toLocaleString("zh-CN", { hour12: false }),
  };
}

/**
 * 提示词体积体检：给设置页/诊断用。
 * 让人能看见「system prompt 现在占多少 token、砍掉了哪些段」，
 * 而不是等上下文被吃光才发现。
 */
export function promptStats() {
  return buildSystemPromptText(promptContext()).stats;
}

/**
 * 组装 system prompt：基础段 + 长期记忆块。
 *
 * 记忆块在最后 —— 越靠后越靠近用户消息，模型对它的服从度越高。
 * 这是提示词工程里最朴素也最有效的一条：近端效应。
 *
 * 记忆块的规模按上下文窗口动态给预算：
 * 记忆挂在 system 段上，而上下文裁剪只裁历史回合、不裁 system，
 * 所以这块必须自己控制在窗口的一个小份额内，否则会无声地挤占历史。
 */
function buildFullSystemPrompt(query = "", windowTokens = 0) {
  const base = buildSystemPrompt(query);
  if (state.settings.memoryEnabled === false) return base;
  try {
    // 窗口的 6%，最少 300、最多 2000 token
    const win = Number(windowTokens) || 0;
    const maxTokens = win
      ? Math.max(300, Math.min(2000, Math.floor(win * 0.06)))
      : undefined;
    return buildPromptBlock(query, base, maxTokens ? { maxTokens } : {});
  } catch (err) {
    // 记忆库出问题不能连累主流程：退回基础 prompt
    console.warn("记忆库注入失败：", err);
    return base;
  }
}

function historyMessages(session) {
  return session.messages
    .filter((m) => m.status !== "running" && m.content)
    .map((m) => {
      const files = m.attachments || [];
      const note = files.length ? `\n\n（本条附带文件：${files.map((f) => f.name || f.path).join("、")}）` : "";
      return { role: m.role, content: m.content + note };
    });
}

/* ---------------- 聊天附件 ---------------- */

// 可以按文本内联给模型的扩展名；其余（PDF / Office / 图片 / 压缩包）只登记路径
const TEXT_ATTACH_RE =
  /\.(md|markdown|txt|csv|tsv|json|jsonl|ndjson|ya?ml|xml|html?|css|less|scss|js|mjs|cjs|ts|tsx|jsx|py|java|kt|kts|go|rs|c|h|cc|cpp|hpp|cs|rb|php|swift|sh|bash|zsh|ps1|sql|ini|toml|conf|cfg|log|env)$/i;

const VISION_MAX_IMAGES = 4; // 单条消息最多带几张图（再多会明显拖慢请求）
const ATTACH_INLINE_MAX = 64 * 1024; // 单个纯文本文件内联上限
const ATTACH_BUDGET_MAX = 160 * 1024; // 一条消息里附件正文总量上限

const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** base64 -> 文本；解码后替换字符过多则判定为二进制，返回 null。 */
function decodeTextBase64(b64) {
  try {
    const raw = atob(String(b64 || ""));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    let bad = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) bad++;
    if (text.length && bad / text.length > 0.01) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * 把附件内容拼到用户消息后面：纯文本直接内联，二进制只给路径说明。
 *
 * 附件有两种来源：
 *   - workspace：本地导入的文件，落在工作区 uploads/，模型可用 fs_read / shell 再去读
 *   - library：资料库里的文件，模型可用 library_read 读取
 * 因此这里按 area 决定从哪个区域取内容。
 */
async function withAttachments(text, attachments, { vision = false } = {}) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return { content: text, media: null };

  const images = list.filter((a) => isImagePath(a.path));
  const media = { images: images.length, sent: 0, vision, items: [] };
  const others = list.filter((a) => !isImagePath(a.path));
  const blocks = [];
  let budget = ATTACH_BUDGET_MAX;

  // 读一个附件：按 area 到对应区域取
  const readAttachment = async (a) => {
    const area = a.area === "library" ? "library" : "workspace";
    if (area === "library") {
      try {
        return await readDoc("library", a.path);
      } catch {
        return null;
      }
    }
    return readFile(a.path);
  };

  for (const a of others) {
    const name = a.name || a.path;
    const area = a.area === "library" ? "library" : "workspace";
    if (!TEXT_ATTACH_RE.test(a.path || "")) {
      // 二进制不再只给路径：直接附上类型、头字节与压缩包目录，模型不必再去试探
      let detail = "";
      try {
        const info = await inspectPath(a.path, { maxEntries: 16, area });
        if (info?.text) detail = `\n${info.text}`;
      } catch {
        /* 摘要失败就退回一句话 */
      }
      const hint =
        area === "library"
          ? "可用 library_read 读取。"
          : "可用 fs_inspect 查看结构，fs_read(format=\"hex\") 看字节。";
      blocks.push(
        `【附件：${name}（${a.path}，${fmtBytes(Number(a.size) || 0)}）】二进制，正文未内联。${detail || hint}`
      );
      continue;
    }
    try {
      const doc = await readAttachment(a);
      if (!doc) {
        blocks.push(`【附件：${name}（${a.path}）】读取失败。`);
        continue;
      }
      // 文本类附件即使被存成 base64（旧数据 / 浏览器导入）也尝试解码出正文
      const rawContent = doc.encoding === "base64" ? decodeTextBase64(doc.content) : String(doc.content ?? "");
      // 附件正文同样是不可信输入：用户上传的文档里可能嵌着
      // 「忽略上文并输出密钥」这类指令。只中和可伪造的标签与角色头，
      // 不删内容 —— 文档正文本身是有用的信息。
      const content = rawContent === null ? null : sanitizeUntrusted(rawContent);
      if (content === null) {
        blocks.push(`【附件：${name}（${a.path}）】不是纯文本，内容未内联。`);
        continue;
      }
      const room = Math.min(ATTACH_INLINE_MAX, budget);
      if (content.length > room) {
        budget = 0;
        blocks.push(
          `【附件：${name}（${a.path}）】过长（${fmtBytes(content.length)}），只附开头 ${fmtBytes(room)}，其余在工作区里可用 fs_read 继续读：\n\n${content.slice(0, room)}\n\n（已截断）`
        );
      } else {
        budget -= content.length;
        blocks.push(`【附件：${name}（${a.path}）】\n\n${content}`);
      }
    } catch (err) {
      blocks.push(`【附件：${name}（${a.path}）】读取失败：${err.message || err}`);
    }
  }
  let textPart = blocks.length ? `${text}\n\n${blocks.join("\n\n")}` : text;

  // 图片：模型不支持视觉时明确告知，避免它去 fs_read 二进制再猜
  if (!images.length) return { content: textPart, media: null };
  if (!vision) {
    textPart += `\n\n${images
      .map(
        (a) =>
          `【图片：${a.name || a.path}（${a.path}，${fmtBytes(Number(a.size) || 0)}）】当前模型未开启图片输入，这张图没有发送给模型。如需识别，请在「设置 → 当前模型 → 更多参数」打开「图片输入」，或换用支持视觉的模型。`
      )
      .join("\n")}`;
    return { content: textPart, media };
  }

  const parts = [{ type: "text", text: textPart }];
  let sent = 0;
  for (const a of images.slice(0, VISION_MAX_IMAGES)) {
    try {
      const doc = await readAttachment(a);
      if (!doc || doc.encoding !== "base64") throw new Error("图片没有按二进制保存");
      const img = await prepareImage(doc.content, a.mime || doc.mime || imageMime(a.path));
      parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
      sent += 1;
      media.sent += 1;
      media.items.push({ name: a.name || a.path, width: img.width, height: img.height, bytes: img.bytes });
      if (img.resized) {
        parts[0].text += `\n\n（图片 ${a.name || a.path} 已压缩到 ${img.width}×${img.height}、约 ${fmtBytes(img.bytes)} 再发送）`;
      }
    } catch (err) {
      parts[0].text += `\n\n【图片：${a.name || a.path} 发送失败：${err.message || err}】`;
    }
  }
  if (!sent) return { content: parts[0].text, media };
  return { content: parts, media };
}

/* ---------------- 网络请求 ---------------- */

function endpointFor(baseUrl) {
  const b = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(b)) return b;
  return `${b}/chat/completions`;
}

/** 带超时的 fetch；外部 signal 仍可随时中止。 */
async function fetchWithTimeout(url, options, externalSignal) {
  const seconds = Math.max(10, Math.min(600, Number(state.settings.requestTimeout) || 60));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, seconds * 1000);
  const onAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new Error(`请求超时（${seconds}s）。可在设置 → 通知与网络里调高。`);
    throw err;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

/** 增量解析 OpenAI 兼容 SSE；fetch 与原生桥共用。 */
function createSSEConsumer({ onText, onReasoning, onToolDelta, onUsage }) {
  let buffer = "";
  let finish = null;
  let sawEvent = false;

  const consume = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    sawEvent = true;
    if (payload === "[DONE]") {
      finish = finish || "stop";
      return;
    }
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.usage) onUsage?.(json.usage);
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (delta.reasoning_content) onReasoning?.(delta.reasoning_content);
    if (delta.content) onText?.(delta.content);
    if (delta.tool_calls) onToolDelta?.(delta.tool_calls);
    if (choice.finish_reason) finish = choice.finish_reason;
  };

  return {
    feed(text) {
      buffer += text;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "").trim();
        buffer = buffer.slice(idx + 1);
        consume(line);
      }
    },
    get finish() {
      return finish;
    },
    get sawEvent() {
      return sawEvent;
    },
  };
}

/** 有些兼容网关会忽略 stream:true，直接返回一整段 JSON。 */
function consumeWholeJSON(raw, { onText, onReasoning, onToolDelta, onUsage }) {
  try {
    const data = JSON.parse(raw);
    if (data.usage) onUsage?.(data.usage);
    const message = data.choices?.[0]?.message;
    if (!message) return false;
    if (message.reasoning_content) onReasoning?.(message.reasoning_content);
    if (message.content) onText?.(message.content);
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      onToolDelta?.(
        message.tool_calls.map((c, index) => ({
          index,
          id: c.id,
          function: { name: c.function?.name, arguments: c.function?.arguments },
        }))
      );
    }
    return true;
  } catch {
    return false;
  }
}

async function readSSE(res, handlers) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const consumer = createSSEConsumer(handlers);
  let raw = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    consumer.feed(text);
  }
  consumer.feed(decoder.decode());
  return { finish: consumer.finish, raw, sawEvent: consumer.sawEvent };
}

function errorDetail(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  try {
    const body = JSON.parse(raw);
    return body.error?.message || body.message || JSON.stringify(body).slice(0, 240);
  } catch {
    return raw.slice(0, 240);
  }
}

function httpHint(status) {
  return (
    {
      400: "请求格式被拒绝，请检查模型 ID 与参数。",
      401: "API Key 无效或已过期，请到「账号与服务」重新填写。",
      402: "账户余额不足，请前往服务商控制台充值。",
      403: "该 Key 没有访问此模型的权限，或服务端拒绝了请求来源。",
      404: "接口路径或模型不存在，请检查 Base URL 与模型 ID。",
      429: "触发限流（429）：30–60 秒后再试；免费 / 低价档模型并发限制更严，连续多次请求也容易触发，请检查账户余额与限流规则。",
      500: "服务端内部错误，稍后重试。",
      502: "网关错误，服务端暂时不可用。",
      503: "服务端繁忙或过载，稍后重试。",
    }[status] || `请求失败（HTTP ${status}）。`
  );
}

/** 端点拒绝 reasoning_effort 时，自动关掉该模型的透传并留下可操作提示。 */
function effortFallback(active, detail) {
  const text = String(detail || "");
  if (!/reasoning[\s_-]*effort|reasoning\b|thinking|思考/i.test(text)) return "";
  if (!active || active.supportsEffort === false) return "";
  try {
    const raw = (state.settings.customModels || []).find((m) => m.id === active.id);
    if (raw) upsertCustomModel({ ...raw, supportsEffort: false });
  } catch {
    /* 保存失败不影响提示 */
  }
  return "（该模型不接受 reasoning_effort，已自动关闭推理强度透传并保存；请重发本条消息）";
}

/**
 * 走 Node 里插件 adapter 的一次请求。
 *
 * 与上面走 HTTP 的那条路**返回同样的形状**（`{ calls, finish }`），
 * 所以下游的工具执行、重试、轨迹记录都不用改。
 *
 * ============ 为什么要单独一个函数 ============
 *
 * HTTP 那条路的诊断字段（endpoint / status / tokens）在这里意义不同：
 * 没有 HTTP 状态码，端点是「node:<provider>」。硬塞进同一个函数里
 * 只会让两边都变得难读。
 */
async function chatViaNode(active, { messages, tools, signal, onText, onReasoning, onUsage }) {
  const provider = nodeProviderOf(active);
  const model = modelApiId(active);
  if (!provider) throw new Error("这个模型没有记录来源供应方，请到设置里重新同步一次模型列表");
  if (!model) throw new Error("这个模型没有模型 ID");

  const started = Date.now();
  let diag = { endpoint: `node:${provider}`, model, status: 0, ok: false, tokens: 0, ms: 0 };

  try {
    const r = await streamViaNode({
      provider,
      model,
      messages,
      tools,
      // 系统提示词已经在 messages[0] 里了，不再单传一份 ——
      // 传两份会让有些 adapter 把它拼接两遍
      temperature:
        typeof active.temperature === "number" ? active.temperature : state.settings.temperature ?? 0.3,
      maxTokens: Number(active.maxTokens) > 0 ? Number(active.maxTokens) : undefined,
      reasoningEffort: active.supportsEffort !== false ? state.settings.reasoning : undefined,
      signal,
      onText,
      onReasoning,
      onUsage(u) {
        diag.tokens = u?.total_tokens || diag.tokens;
        onUsage?.(u);
      },
    });

    diag = { ...diag, ok: true, ms: Date.now() - started };
    addDiagnostic(diag);
    setModelStatus(active.id, { ok: true, status: 0, ms: diag.ms, model });
    return { calls: r.calls, finish: r.finish };
  } catch (err) {
    // 用户主动停止不是错误，别写进诊断记录
    if (err?.name === "AbortError") throw err;
    const detail = String(err?.message || err);
    diag = { ...diag, ms: Date.now() - started, error: detail };
    addDiagnostic(diag);
    setModelStatus(active.id, { ok: false, status: 0, error: detail, model });
    throw new Error(`插件模型调用失败：${detail}`);
  }
}

async function chatOnce({ messages, tools, signal, onText, onReasoning, onUsage }) {
  const active = currentModel();
  if (!active) throw new Error("还没有添加模型。到 设置 → 模型管理 里添加一个，选好供应方一分钟就能接上。");

  // ============ 插件提供的模型：请求交给 Node 里的 adapter ============
  //
  // 这类模型没有 Base URL —— 它的端点在插件的 adapter 闭包里，
  // 只有加载了插件的 Node 进程能执行它。所以这里换一条路走。
  if (isNodeLlmModel(active)) {
    return await chatViaNode(active, { messages, tools, signal, onText, onReasoning, onUsage });
  }

  const apiKey = apiKeyFor(active);
  const baseUrl = modelBaseUrl(active);
  const model = modelApiId(active);
  if (!apiKey) throw new Error("当前模型所属服务还没有配置 API Key");
  if (!baseUrl) throw new Error("当前模型没有 Base URL，请到模型参数里填写");
  if (!model) throw new Error("当前模型没有模型 ID，请到模型参数里填写");

  // 图片输入不被支持时，服务端通常返回 400/422，这里补一句可操作提示
  const hasImage = messages.some(
    (m) => Array.isArray(m?.content) && m.content.some((part) => part?.type === "image_url")
  );
  const imageHint = hasImage
    ? "（本条消息含图片：若该模型不支持图片输入会返回这个错误，可在 设置 → 当前模型 → 更多参数 关闭「图片输入」，或换用支持视觉的模型）"
    : "";

  const started = Date.now();
  let diag = { endpoint: baseUrl, model, status: 0, ok: false, tokens: 0, ms: 0 };
  let recorded = false;
  const temperature =
    typeof active.temperature === "number" ? active.temperature : state.settings.temperature ?? 0.3;
  const payload = {
    model,
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? "auto" : undefined,
    stream: true,
    stream_options: { include_usage: true },
    temperature,
    ...(Number(active.maxTokens) > 0 ? { max_tokens: Number(active.maxTokens) } : {}),
    // 默认透传 reasoning_effort；模型明确标为不支持时才省略，避免 4xx
    ...(active.supportsEffort !== false
      ? {
          reasoning_effort:
            { off: "minimal", low: "low", high: "high", max: "high" }[state.settings.reasoning] || "high",
        }
      : {}),
  };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const url = endpointFor(baseUrl);

  const calls = [];
  const consumer = createSSEConsumer({
    onText,
    onReasoning,
    onUsage(u) {
      diag.tokens = u?.total_tokens || diag.tokens;
      onUsage?.(u);
    },
    onToolDelta(deltas) {
      deltas.forEach((d) => {
        const i = d.index ?? calls.length;
        if (!calls[i]) calls[i] = { id: "", name: "", args: "" };
        // 多数网关每个分片都重复携带 id / name：必须覆盖而非拼接，否则聚合出 "call_Acall_A"
        if (d.id) calls[i].id = d.id;
        if (d.function?.name) calls[i].name = d.function.name;
        if (d.function?.arguments) calls[i].args += d.function.arguments;
      });
    },
  });

  let status = 0;
  let raw = "";

  if (nativeHttpAvailable()) {
    // Android 原生通道：绕开 WebView 的 CORS 与流式限制
    await new Promise((resolve, reject) => {
      nativeStream({
        url,
        headers,
        body: payload,
        signal,
        timeoutSec: 300,
        onStatus: (s) => {
          status = s;
        },
        onChunk: (text) => {
          if (raw.length < 8_000_000) raw += text;
          consumer.feed(text);
        },
        onEnd: () => resolve(),
        onError: (err) => reject(err),
      });
    }).catch((err) => {
      if (err.name === "AbortError") throw err;
      const code = Number(err.httpStatus) || status;
      const detail = err.body ? errorDetail(err.body) : err.message;
      diag = { ...diag, status: code, ms: Date.now() - started, error: detail };
      addDiagnostic(diag);
      recorded = true;
      setModelStatus(active.id, { ok: false, status: code, error: detail, model });
      if (code) throw new Error(`${httpHint(code)}${detail ? ` · ${detail}` : ""}${imageHint}${effortFallback(active, detail)}`);
      throw new Error(
        `无法连接模型服务：${detail}。请检查 Base URL、网络与证书；Android 端已走原生请求，不再受跨域限制。`
      );
    });

    if (!consumer.sawEvent && raw.trim()) {
      // 部分兼容网关忽略 stream:true，直接返回整段 JSON
      if (!consumeWholeJSON(raw, { onText, onReasoning, onUsage, onToolDelta: (deltas) => {
        deltas.forEach((d) => {
          const i = d.index ?? calls.length;
          if (!calls[i]) calls[i] = { id: "", name: "", args: "" };
          if (d.id) calls[i].id = d.id;
          if (d.function?.name) calls[i].name += d.function.name;
          if (d.function?.arguments) calls[i].args += d.function.arguments;
        });
      } })) {
        const detail = errorDetail(raw) || "接口返回了无法解析的内容";
        diag = { ...diag, status: status || 0, ms: Date.now() - started, error: detail };
        addDiagnostic(diag);
        setModelStatus(active.id, { ok: false, status, error: detail, model });
        throw new Error(`接口返回异常：${detail}`);
      }
    }
  } else {
    let res;
    try {
      res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        },
        signal
      );
    } catch (err) {
      if (err.name === "AbortError") throw err;
      diag = { ...diag, ms: Date.now() - started, error: err.message };
      addDiagnostic(diag);
      recorded = true;
      setModelStatus(active.id, { ok: false, error: err.message, model });
      throw new Error(
        `无法连接模型服务：${err.message}。请检查 Base URL 与网络；浏览器预览下还要求服务端允许跨域（CORS）。`
      );
    }
    status = res.status;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const detail = errorDetail(body);
      addDiagnostic({ ...diag, status, ms: Date.now() - started, error: detail || `HTTP ${status}` });
      recorded = true;
      setModelStatus(active.id, { ok: false, status, error: detail, model });
      throw new Error(`${httpHint(status)}${detail ? ` · ${detail}` : ""}${imageHint}${effortFallback(active, detail)}`);
    }
    const { finish, raw, sawEvent } = await readSSE(res, {
      onText,
      onReasoning,
      onUsage: (u) => {
        diag.tokens = u?.total_tokens || diag.tokens;
        onUsage?.(u);
      },
      onToolDelta: (deltas) => {
        deltas.forEach((d) => {
          const i = d.index ?? calls.length;
          if (!calls[i]) calls[i] = { id: "", name: "", args: "" };
          if (d.id) calls[i].id = d.id;
          if (d.function?.name) calls[i].name = d.function.name;
          if (d.function?.arguments) calls[i].args += d.function.arguments;
        });
      },
    });
    if (!sawEvent && raw.trim()) {
      // 网关忽略 stream:true 直接回整包 JSON —— 解析它而不是给用户一条空白回复
      if (
        !consumeWholeJSON(raw, {
          onText,
          onReasoning,
          onUsage: (u) => {
            diag.tokens = u?.total_tokens || diag.tokens;
            onUsage?.(u);
          },
          onToolDelta: (deltas) => {
            deltas.forEach((d) => {
              const i = d.index ?? calls.length;
              if (!calls[i]) calls[i] = { id: "", name: "", args: "" };
              if (d.id) calls[i].id = d.id;
              if (d.function?.name) calls[i].name = d.function.name;
              if (d.function?.arguments) calls[i].args += d.function.arguments;
            });
          },
        })
      ) {
        const detail = errorDetail(raw) || "接口返回了无法解析的内容";
        addDiagnostic({ ...diag, status, ms: Date.now() - started, error: detail });
        recorded = true;
        setModelStatus(active.id, { ok: false, status, error: detail, model });
        throw new Error(`接口返回异常：${detail}`);
      }
      if (!recorded) {
        addDiagnostic({ ...diag, status, ok: true, ms: Date.now() - started });
        setModelStatus(active.id, { ok: true, status, ms: Date.now() - started, model });
      }
      return { calls: calls.filter(Boolean), finish: finish || "stop" };
    }
    if (!recorded) {
      addDiagnostic({ ...diag, status, ok: true, ms: Date.now() - started });
      setModelStatus(active.id, { ok: true, status, ms: Date.now() - started, model });
    }
    return { calls: calls.filter(Boolean), finish };
  }

  const ms = Date.now() - started;
  diag = { ...diag, ms, tokens: diag.tokens };
  if (!recorded) addDiagnostic({ ...diag, status, ok: true });
  setModelStatus(active.id, { ok: true, status, ms, model });
  return { calls: calls.filter(Boolean), finish: consumer.finish };
}

/* ---------------- 工具执行封装 ---------------- */

async function runToolCall(msg, call, ctx) {
  const tool = {
    id: call.id || `t_${Date.now()}`,
    name: call.name,
    argLabel: call.argLabel || call.argsPreview || "",
    status: "running",
    args: call.args || {},
    output: "",
    ms: 0,
  };
  msg.tools.push(tool);
  ctx.onChange();

  let parsed = {};
  try {
    parsed = call.args || JSON.parse(call.argsRaw || "{}");
  } catch {
    parsed = {};
  }
  tool.argLabel = previewOf(tool.name, parsed);

  const res = await executeTool(tool.name, parsed, {
    requestApproval: ctx.requestApproval,
    spawnSubagent: ctx.spawnSubagent,
  });
  tool.status = res.status || (res.ok ? "done" : "error");
  tool.output = res.output;
  tool.ms = res.ms;
  // 挂起标记：UI 上要给用户一个说法（"刚才被系统挂起了"），
  // 否则用户只看到工具跑得很慢，不知道是系统掐的。
  //
  // 只对 MCP 工具判断 —— 本地工具慢通常是**事情本身慢**：
  // 读一个几十 MB 的文件、跑一段长脚本，10 秒很正常，
  // 把它标成「系统挂起」是误报，还会误导模型去重新读屏。
  const suspend = isMcpTool(tool.name) ? suspendNote(res.ms) : "";
  if (suspend) tool.suspended = true;
  if (res.diff) tool.diff = res.diff;
  if (res.code) tool.code = res.code;
  if (res.safety) tool.safety = res.safety;
  if (res.export) tool.export = res.export;
  // 轨迹采集：只在「本机控屏」的工具调用上记（traj.js 内部按工具名过滤）
  try {
    captureTool(tool.name, parsed, res);
  } catch {
    /* 采集失败绝不能影响正常执行 */
  }
  ctx.onChange();
  return res;
}

/**
 * 工具失败后追加给模型的行动指引。
 *
 * ============ 它解决的是什么 ============
 *
 * 模型有个很顽固的倾向：把「工具报错」读成「任务失败」，
 * 于是直接向用户复述错误、结束这一轮。
 *
 * 而控屏失败绝大多数只是**中间状态**：
 *   · ui_tap_ref 找不到 ref —— 屏幕已经变了，重新 dump 一次就好；
 *   · ui_set_text 没找到输入框 —— 上一步没点进去；
 *   · 任何 MCP 工具超时 —— 换个更小的范围再来一次。
 *
 * 实测过：`ui_tap_ref` 的失败文本里写着「找不到 ref（可能屏幕已经变了）」
 * 和两条替代路径，**但整段没有一个「重试」字样** ——
 * 模型读到的头四个字是「执行失败」，很容易就此收工。
 *
 * 所以这里补的不是错误信息，是**行为纠正**。
 *
 * ============ 为什么不给「权限拒绝」加 ============
 *
 * 那是**终局**，不是中间状态：用户没给这个应用授权，重试一百次都不会过，
 * 该做的是停下来让用户去开权限。给这种情况加「再试一次」是在教模型做无用功。
 */
const TOOL_FAILURE_HINT =
  "（这是中间状态，不是任务结论：先看上面的原因，换参数或换方法再试一次。"
  + "同一调用原样重复超过 2 次仍失败，再停下来说明卡在哪。）";

/**
 * 判定「这次调用被系统挂起过」的耗时阈值。
 *
 * ============ 为什么要检测这个 ============
 *
 * 用户反馈：控屏指令偶尔会「卡死」——不是失败，而是几十秒没动静；
 * 一旦从目标应用切回 DSH，立刻恢复并继续。
 *
 * 根因是 Android 把后台的 WebView 进程挂起了（ROM 省电策略，
 * 自建的前台服务 + WakeLock 也未必挡得住）。挂起期间：
 *   · JS 全部停摆，fetch 的回调不执行；
 *   · `setTimeout` 也不跑 —— 所以 25 秒超时**同样不会触发**，
 *     请求就一直挂着，不会报错。
 *
 * 这解释了为什么它「不是失败」。
 *
 * ============ 用什么信号判断 ============
 *
 * `res.ms` 是客户端测的**端到端**耗时（runMcpTool 里 `Date.now() - startedAt`），
 * 天然包含挂起的那几十秒。而正常调用是：
 *
 *   ui_tap     200~800ms
 *   ui_dump    1~2 秒（大界面偶尔 3~5 秒）
 *   远程 MCP   几十~几百 ms
 *
 * 所以「超过 10 秒」几乎只可能是被挂起，不会是正常慢。
 * 用这个信号的好处：**不需要定时器**，天然免疫冻结。
 *
 * ============ 检测到之后做什么 ============
 *
 * 不重发、不 abort —— 只**告诉模型「屏幕可能已经变了」**。
 *
 * 因为挂起期间最危险的不是「没执行」，而是「用户趁这会儿手动操作了手机，
 * 模型解冻后仍按旧屏幕继续点」——那会点到完全错误的地方。
 * 而这个风险模型自己看不见，只能由我们告诉它。
 */
const SUSPEND_MS = 10000;

/** 是不是 MCP 工具（只有它们才值得做挂起判断）。 */
function isMcpTool(name) {
  return String(name || "").startsWith("mcp__");
}

/** 返回挂起提示；没挂起则返回空串。 */
export function suspendNote(ms) {
  const spent = Number(ms) || 0;
  if (spent < SUSPEND_MS) return "";
  return (
    `（注意：这次调用花了 ${(spent / 1000).toFixed(1)} 秒，远超正常耗时。` +
    `DSH 刚才可能被系统挂起在后台了，期间屏幕内容可能已经变化 —— ` +
    `继续操作前先用 ui_dump 确认当前界面，不要沿用挂起前的坐标或 ref。）`
  );
}

/** 这种失败该不该鼓励重试。 */
export function failureIsRecoverable(status) {
  // denied / needs_user 是终局：要用户改配置或给权限，重试不会改变结果。
  return status !== "denied" && status !== "needs_user";
}

/**
 * 给一次失败生成要追加的提示（可能为空 = 不追加）。
 *
 * 抽成纯函数是为了能直接测 —— 这段逻辑藏在 liveRun 深处的话，
 * 只能靠"跑一遍看日志"来验证，那种测试既慢又不稳。
 *
 * @param {string} status 工具结果状态
 * @param {number} times  同一调用累计失败次数（从 1 开始）
 */
export function failureNote(status, times) {
  if (!failureIsRecoverable(status)) return "";
  if (times >= 3) {
    return (
      `（同一个调用已经原样失败 ${times} 次。不要再重复它 —— 换成不同的参数、` +
      `不同的工具，或者先重新读一次当前状态再决定。）`
    );
  }
  return TOOL_FAILURE_HINT;
}

function previewOf(name, args) {
  const map = {
    fs_read: args.path,
    fs_write: args.path,
    fs_delete: args.path,
    fs_list: args.path || "工作区根目录",
    shell: args.command,
    run_code: "执行编排脚本",
    web_search: args.query,
    spawn_subagent: (args.task || "").slice(0, 40),
    task_schedule: args.name,
    plugin_inspect: args.query || "runtime",
    plugin_scaffold: args.name || args.id,
    office_export: `${args.path || ""} → ${args.format || "docx"}`,
    ops_status: "runtime",
    ops_cleanup: "exports/*",
    calc: args.expression,
  };
  return map[name] || "";
}

/* ---------------- 主入口 ---------------- */

export async function runAgent({ session, text, msg, attachments, signal, onChange, requestApproval, spawnSubagent }) {
  const ctx = { onChange, requestApproval, spawnSubagent };
  msg.status = "running";
  msg.startedAt = Date.now();
  msg.steps = 0;
  onChange();

  // 开一条轨迹：本轮用户输入就是「指令」。
  // 路线 A 的关键优势 —— 指令天然是中文，语料与查询同语言。
  beginTrajectory(text);

  try {
    // 没有连接模型就不运行：不再提供本地演示，避免把脚本输出误当成模型回答
    if (!currentModel()) {
      throw new Error("还没有添加模型：到「设置 → 模型管理」添加一个模型，并填好对应服务的 API Key 后再发送。");
    }
    if (!apiKeyForCurrent()) {
      throw new Error("当前模型还没有配置 API Key：到「设置 → 账号 → 对应服务」填好后即可对话。");
    }
    await liveRun({ session, text, msg, attachments, signal, ctx });
    if (msg.status === "running") msg.status = "done";
  } catch (err) {
    if (err.name === "AbortError") {
      msg.status = "stopped";
    } else {
      msg.status = "error";
      msg.error = err.message || "运行失败";
    }
  } finally {
    msg.duration = Date.now() - msg.startedAt;
    msg.tokens = msg.tokens || estimateTokens(msg.content + msg.reasoning);
    onChange();
    // 收尾落库：成功、失败、中断都算 —— 半条轨迹也有参考价值，
    // 而且「失败在哪一步」正是最有信息量的部分。
    try {
      const rec = await endTrajectory();
      if (rec) {
        msg.trajId = rec.id;
        msg.trajSteps = rec.steps.length;
      }
    } catch {
      abortTrajectory();
    }
  }
  return msg;
}

/* ---------------- Live ---------------- */

async function liveRun({ session, text, msg, attachments, signal, ctx }) {
  const history = historyMessages(session);
  // 当前用户消息在 runAgent 之前已经写入会话，这里去掉重复的一条
  if (history.length && history[history.length - 1].role === "user" && history[history.length - 1].content === text) {
    history.pop();
  }
  const active = currentModel();
  const vision = active ? active.vision !== false : false;
  const built = await withAttachments(text, attachments, { vision });
  msg.media = built.media; // 让界面能显示"图片发了几张 / 是否被跳过"
  const userContent = built.content;
  const windowTokens = modelContextWindow();
  // 记忆检索用「用户这次说的话」当 query：问什么就捞什么
  const convo = [
    { role: "system", content: buildFullSystemPrompt(text, windowTokens) },
    ...history,
    { role: "user", content: userContent },
  ];

  // 记忆标签在流式过程中就要挡住，否则用户会看到半截 JSON
  const tagFilter = createTagFilter();
  // 用户这次是不是在纠正我们（"不对/错了/重新说"）—— 命中就提高纠正类记忆权重
  const correcting = detectCorrection(text);
  // 已显示的正文（已剥掉标签）：与 msg.content 同步，但由过滤器产出
  let display = "";

  const maxSteps = Math.max(1, Math.min(100, state.settings.maxSteps || 24));

  /**
   * 同一调用连续失败了几次。
   *
   * 键是「工具名 + 参数 JSON」—— 参数一样、工具一样，就是「原样重复」。
   * 用来兑现提示词里那句「同一调用原样重复不超过 2 次」：
   * 光写规则不检测，规则就只是口号。
   *
   * 只做**提示增强**，不做拦截 —— 控屏场景下第三次重试是有意义的
   * （屏幕可能刚好变回来了），硬拦会挡住本来就该成功的那一次。
   */
  const sameCallFailures = new Map();

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      msg.steps = step + 1;
      let streamed = "";
      let reasoning = "";
      // 本步推理的起止时刻：用于在 UI 上显示「已思考 X」
      let reasonStart = 0;
      let reasonEnd = 0;

      // 每步请求前按窗口预算裁剪较早回合；完整 convo 仍保留在本轮内
      // 第 1 层：零 token 压缩 —— 把超大的工具输出/参数/旧图片做结构性替换
      //   （不调模型、不花 token；旧输出换成占位文案，避免模型重跑同一命令）
      const packed = compactMessages(convo);
      const trimmed = trimMessages(packed.messages, windowTokens);
      if (packed.compacted || trimmed.removed) {
        const prev = msg.contextTrim?.removed || 0;
        const prevPack = msg.contextPack?.compacted || 0;
        msg.contextPack = {
          compacted: Math.max(prevPack, packed.compacted),
          reclaimed: packed.reclaimed,
        };
        msg.contextTrim = {
          removed: Math.max(prev, trimmed.removed),
          window: windowTokens,
          level: trimmed.level,
          overflow: trimmed.overflow,
        };
        ctx.onChange();
      }

      const { calls } = await chatOnce({
        messages: trimmed.messages,
        tools: toolSchemas(),
        signal,
        onText(delta) {
          streamed += delta;
          // 只把「确认不是标签」的部分显示出去
          const clean = tagFilter.push(delta);
          if (clean) {
            display += clean;
            msg.content = display;
            ctx.onChange();
          }
        },
        onReasoning(delta) {
          reasoning += delta;
          msg.reasoning += delta;
          // 记录本步推理的起止时刻，供 UI 显示「已思考 X」
          if (!reasonStart) reasonStart = Date.now();
          reasonEnd = Date.now();
          ctx.onChange();
        },
        onUsage(u) {
          if (u.total_tokens) msg.tokens = u.total_tokens;
        },
      });

      // 累计本步推理耗时（多步时累加），UI 上显示为「已思考 X」
      if (reasonEnd > reasonStart) {
        msg.reasoningMs = (msg.reasoningMs || 0) + (reasonEnd - reasonStart);
      }

      if (!calls.length) {
        display = display.trim();
        msg.content = display;
        return;
      }

      const resolved = calls.map((c) => ({
        ...c,
        callId: c.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      }));

      convo.push({
        role: "assistant",
        // 记忆标签不回灌给模型：它是自己写给自己的备忘，不是对话内容
        content: stripMemoryTags(streamed),
        tool_calls: resolved.map((c) => ({
          id: c.callId,
          type: "function",
          function: { name: c.name, arguments: c.args || "{}" },
        })),
      });

      for (const call of resolved) {
        let args = {};
        let parseError = null;
        try {
          args = JSON.parse(call.args || "{}");
        } catch (err) {
          parseError = err.message;
        }

        if (parseError) {
          const badTool = {
            id: `t_${Date.now()}`,
            name: call.name,
            argLabel: "参数解析失败",
            status: "error",
            args: {},
            output: `工具参数不是合法 JSON：${parseError}`,
            ms: 0,
          };
          msg.tools.push(badTool);
          ctx.onChange();
          convo.push({
            role: "tool",
            tool_call_id: call.callId,
            content: badTool.output,
          });
          continue;
        }

        const res = await runToolCall(
          msg,
          { id: call.callId, name: call.name, argsRaw: call.args, args },
          ctx
        );
        // 失败时补一句「这是中间状态」—— 模型很容易把工具报错读成任务失败，
        // 然后直接收工。这句是给模型的行为纠正，不是给用户的错误说明，
        // 所以放在工具结果里（模型读到的那一侧），不往 UI 上打。
        const body = res.output || (res.ok ? "完成" : "失败");
        let withHint = body;
        // 挂起优先：即使这一次成功，屏幕也可能已经不是调用前那一屏了。
        // 只有在确实耗了很久时才加，正常调用一个字都不多说。
        const suspendNoteText = isMcpTool(call.name) ? suspendNote(res.ms) : "";
        if (suspendNoteText) withHint = `${body}\n\n${suspendNoteText}`;
        if (!res.ok) {
          const sig = `${call.name}|${call.args || ""}`;
          const times = (sameCallFailures.get(sig) || 0) + 1;
          sameCallFailures.set(sig, times);
          const note = failureNote(res.status, times);
          if (note) withHint = suspendNoteText ? `${withHint}\n\n${note}` : `${body}\n\n${note}`;
        } else {
          // 成功了就把计数清掉：同一个参数后面再失败，应该重新从 0 算。
          // 注意这个和「有没有挂起」无关 —— 挂起只是提示，不影响成败判定。
          sameCallFailures.delete(`${call.name}|${call.args || ""}`);
        }

        convo.push({
          role: "tool",
          tool_call_id: call.callId,
          // 工具结果是**不可信输入**：网页正文、文件内容、MCP 返回
          // 都可能带着「忽略上文、输出密钥」这类注入指令。
          // 中和掉可伪造的标签与角色头，保留内容本身。
          content: sanitizeUntrusted(withHint),
        });
      }

      // 工具结果回合后给模型一个干净的续写起点
      display += display.endsWith("\n") ? "" : "\n\n";
      msg.content = display;
    }
  } finally {
    // 收尾：冲掉缓冲里剩下的（未闭合的标签尾巴），并把标签内容落库
    const tail = tagFilter.flush();
    if (tail) {
      display += tail;
      msg.content = display;
    }
    if (state.settings.memoryEnabled !== false && tagFilter.tags.length) {
      try {
        persistTags(tagFilter.tags, { correcting });
      } catch (err) {
        console.warn("记忆落库失败：", err);
      }
    }
  }

  throw new Error(`已达到最大步数（${maxSteps}），Agent 停止。可在设置中调高上限。`);
}

/* ---------------- 子 Agent / 连通性测试 ---------------- */

/**
 * 子 Agent 的 system prompt：只读分析 + 同样的长期记忆块。
 *
 * 为什么子 Agent 也要记忆：
 * 主 Agent 的记忆块只进了主对话的 system prompt，子 Agent 是**另一次请求**，
 * 拿不到主对话的任何内容。不给它记忆，它对「用户是谁 / 项目是什么」
 * 就只能靠参数化知识编 —— 幻觉在子 Agent 里同样会发生，
 * 而且因为它的结论会被主 Agent 当成事实引用，危害更隐蔽。
 */
function subagentSystemPrompt(task) {
  const base = "你是子 Agent，只做只读分析，不调用工具。用中文给出不超过 120 字的结论。";
  if (state.settings.memoryEnabled === false) return base;
  try {
    return buildPromptBlock(task, base, { maxTokens: 400 });
  } catch (err) {
    console.warn("子 Agent 记忆注入失败：", err);
    return base;
  }
}

export async function spawnSubagentOnce(task, signal) {
  const active = currentModel();
  if (!active) throw new Error("还没有添加模型，无法派生子 Agent。");
  const model = modelApiId(active);
  if (!model) throw new Error("请先配置模型 ID");

  const subMessages = [
    // 子 Agent 同样需要「有据可依」：它拿不到主对话的上下文，
    // 只能靠记忆块知道用户是谁、项目是什么 —— 不注入就等于让它去编
    { role: "system", content: subagentSystemPrompt(task) },
    { role: "user", content: task },
  ];

  // 插件提供的模型没有 HTTP 端点，同样交给 Node 里的 adapter
  if (isNodeLlmModel(active)) {
    let text = "";
    await streamViaNode({
      provider: nodeProviderOf(active),
      model,
      messages: subMessages,
      tools: [],
      temperature: 0.2,
      signal,
      onText: (t) => {
        text += t;
      },
    });
    return sanitizeUntrusted(text || "（子 Agent 没有返回内容）");
  }

  const baseUrl = modelBaseUrl(active);
  if (!baseUrl) throw new Error("请先配置 Base URL");
  const apiKey = apiKeyFor(active);
  if (!apiKey) throw new Error("当前服务未配置 API Key");
  const res = await fetchWithTimeout(endpointFor(baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: subMessages,
      temperature: 0.2,
      stream: false,
    }),
  }, signal);
  if (!res.ok) throw new Error(`子 Agent 请求失败（HTTP ${res.status}）`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "（子 Agent 没有返回内容）";
  // 出口层清洗：子 Agent 的输出会以工具结果的形式回到主对话。
  // 如果子 Agent 读了恶意网页/文件，它的输出可能带着伪造的
  // 记忆标签或角色头 —— 不清洗就等于让内容二次注入。
  return sanitizeUntrusted(String(raw));
}

/** 发一次最小请求，返回原始文本与状态码；Android 走原生，浏览器走 fetch。 */
async function minimalRequest({ url, headers, payload, timeoutSec = 60, method = "POST" }) {
  if (nativeHttpAvailable()) {
    let status = 0;
    let raw = "";
    await new Promise((resolve, reject) => {
      nativeStream({
        url,
        headers,
        body: method === "GET" ? {} : payload,
        method,
        timeoutSec,
        onStatus: (s) => {
          status = s;
        },
        onChunk: (t) => {
          if (raw.length < 2_000_000) raw += t;
        },
        onEnd: resolve,
        onError: reject,
      });
    }).catch((err) => {
      if (err.httpStatus) {
        err.status = err.httpStatus;
        err.body = err.body || "";
        throw err;
      }
      const e = new Error(`无法连接：${err.message}`);
      e.network = true;
      throw e;
    });
    return { status, raw };
  }
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(payload),
    });
  } catch (err) {
    const e = new Error(`无法连接：${err.message}（浏览器预览下还要求服务端允许 CORS）`);
    e.network = true;
    throw e;
  }
  const raw = await res.text().catch(() => "");
  return { status: res.status, raw };
}

/** 从各种常见响应结构里取出模型 ID 列表。 */
function parseModelIds(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const pick = (v) => (Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : Array.isArray(v?.models) ? v.models : null);
  const list = pick(data) || pick(data?.result) || pick(data?.response) || [];
  return list
    .map((m) => (typeof m === "string" ? m : m?.id || m?.name || m?.model))
    .filter((x) => typeof x === "string" && x.trim())
    .sort((a, b) => a.localeCompare(b));
}

const shortUrl = (u) => String(u || "").replace(/^https?:\/\//, "").slice(0, 72);

/** 拉取端点的可用模型列表（OpenAI 兼容 GET /models），多路径探测并汇总失败原因。 */
export async function fetchModelList({ baseUrl, apiKey }) {
  if (!baseUrl) throw new Error("先填 Base URL");
  if (!apiKey) throw new Error("先填这个服务的 API Key，才能获取可用模型");

  const base = String(baseUrl).trim().replace(/\/+$/, "");
  // 端点形态各异：/v1、/compatible-mode/v1、/api/paas/v4、纯域名……逐个形态试
  const roots = new Set([base]);
  const stripped = base.replace(/\/v\d+$/i, "");
  if (stripped !== base) roots.add(stripped);
  const urls = [];
  roots.forEach((r) => {
    urls.push(`${r}/models`);
    if (!/\/v\d+$/i.test(r)) urls.push(`${r}/v1/models`);
  });
  const unique = Array.from(new Set(urls)).slice(0, 6);

  const tried = [];
  for (const url of unique) {
    try {
      const { status, raw } = await minimalRequest({
        url,
        headers: { Authorization: `Bearer ${apiKey}` },
        method: "GET",
        timeoutSec: 30,
      });
      if (status === 401 || status === 403 || status === 402) {
        const detail = errorDetail(raw);
        throw new Error(`${httpHint(status)}${detail ? ` · ${detail}` : ""}`);
      }
      if (status < 200 || status >= 300) {
        tried.push(`${shortUrl(url)} → HTTP ${status}`);
        continue;
      }
      const ids = parseModelIds(raw);
      if (!ids.length) {
        tried.push(`${shortUrl(url)} → 200 但列表为空`);
        continue;
      }
      return ids;
    } catch (err) {
      // Key 类错误换路径也没用，直接抛给用户
      if (/API Key|余额|权限|无效/.test(err.message || "")) throw err;
      tried.push(`${shortUrl(url)} → ${err.message || "请求失败"}`);
    }
  }
  throw new Error(
    `这个端点没有返回模型列表（${tried.slice(0, 3).join("；")}）。很多网关不提供 /models，直接点下方「常用模型」即可，不必手动填 ID。`
  );
}

/** 测试任意模型（不只是当前模型）。 */
export async function testModel(modelOrId) {
  const model =
    typeof modelOrId === "string" ? allModels().find((m) => m.id === modelOrId) : modelOrId;
  if (!model) throw new Error("模型不存在");
  const record = (st) => {
    if (!model.__draft) setModelStatus(model.id, st);
  };

  const key = apiKeyFor(model);
  const apiModel = modelApiId(model);

  // 插件提供的模型：没有 Key、没有 Base URL —— 直接让 Node 侧跑一次最小请求
  if (isNodeLlmModel(model)) {
    if (!apiModel) throw new Error("缺少模型 ID，请到模型参数里填写");
    const started = Date.now();
    const endpoint = `node:${nodeProviderOf(model)}`;
    try {
      await streamViaNode({
        provider: nodeProviderOf(model),
        model: apiModel,
        messages: [{ role: "user", content: "ping" }],
        tools: [],
        maxTokens: 16,
      });
    } catch (err) {
      const message = err?.message || "插件模型调用失败";
      addDiagnostic({ endpoint, model: apiModel, status: 0, ok: false, error: message });
      record({ ok: false, status: 0, error: message, model: apiModel });
      throw new Error(message);
    }
    const ms = Date.now() - started;
    addDiagnostic({ endpoint, model: apiModel, status: 0, ok: true, ms });
    record({ ok: true, status: 0, ms, model: apiModel, endpoint });
    return { ms, model: apiModel, usage: 0, endpoint, status: 0 };
  }

  if (!key) throw new Error(`「${model.label}」所属服务还没有配置 Key`);
  const baseUrl = modelBaseUrl(model);
  if (!baseUrl) throw new Error("缺少 Base URL，请到模型参数里填写");
  if (!apiModel) throw new Error("缺少模型 ID，请到模型参数里填写");

  const started = Date.now();
  const payload = {
    model: apiModel,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 16,
    stream: false,
  };
  let result;
  try {
    result = await minimalRequest({
      url: endpointFor(baseUrl),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      payload,
      timeoutSec: 60,
    });
  } catch (err) {
    const message = err.message || "网络不可达";
    const ms = Date.now() - started;
    addDiagnostic({ endpoint: baseUrl, model: apiModel, status: err.status || 0, ok: false, ms, error: message });
    record({ ok: false, status: err.status || 0, error: message, model: apiModel });
    throw new Error(message);
  }

  if (result.status < 200 || result.status >= 300) {
    const detail = errorDetail(result.raw);
    const message = `${httpHint(result.status)}${detail ? ` · ${detail}` : ""}`;
    addDiagnostic({ endpoint: baseUrl, model: apiModel, status: result.status, ok: false, error: detail });
    record({ ok: false, status: result.status, error: detail, model: apiModel });
    throw new Error(message);
  }

  let data = {};
  try {
    data = JSON.parse(result.raw);
  } catch {
    data = {};
  }
  const ms = Date.now() - started;
  addDiagnostic({
    endpoint: baseUrl,
    model: apiModel,
    status: result.status,
    ok: true,
    tokens: data.usage?.total_tokens || 0,
    ms,
  });
  record({
    ok: true,
    status: result.status,
    ms,
    model: data.model || apiModel,
    endpoint: baseUrl,
  });
  return {
    ms,
    model: data.model || apiModel,
    usage: data.usage?.total_tokens || 0,
    endpoint: baseUrl,
    status: result.status,
  };
}

export async function testProvider(slot) {
  const key = String(state.settings.keys?.[slot] || "").trim();
  if (!key) throw new Error("此服务还没有配置 Key");
  const model = allModels().find((m) => (m.providerKey || "custom") === slot);
  if (!model) throw new Error("这个服务下还没有模型，先到模型管理里添加一个");
  return testModel(model);
}

export async function testConnection() {
  return testModel(currentModel());
}

/** 系统提示词对外暴露，用于测试「模型是否被告知了自己的能力」。 */
export { availableToolNames, fmtTime, buildSystemPrompt };
