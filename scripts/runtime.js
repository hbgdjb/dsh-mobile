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
import { trimMessages, estimateTokens } from "./context.js";
import { toolSchemas, executeTool, availableToolNames, inspectPath } from "./tools.js";
import { nativeStream, nativeHttpAvailable } from "./native-http.js";
import { isImagePath, imageMime, prepareImage } from "./image.js";

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

function buildSystemPrompt() {
  const mode = currentMode();
  const files = Object.values(state.files)
    .map((f) => f.path)
    .slice(0, 40);
  const library = Object.values(state.library || {})
    .map((f) => f.path)
    .slice(0, 20);
  const plugins = state.plugins.filter((p) => p.enabled).map((p) => `${p.name}@${p.version}`);
  return [
    "你是 DeepSeek Harness（DSH），一个运行在 Android 上的 Agent 宿主。你的内核遵循「Model + Harness = Agent」：你负责思考，宿主为你提供文件、终端、搜索、插件等能力。",
    "",
    `【当前模式】${mode.name}模式 — ${mode.detail}`,
    `【权限】${state.settings.permission === "readonly" ? "只读" : state.settings.permission === "full" ? "完全访问" : "工作区写入"}`,
    `【工作区文件】${files.length ? files.join("、") : "空"}`,
    `【附件目录】uploads/ 里是用户随消息发来的文件：纯文本直接附在正文；APK / PDF / Office / 压缩包会附上类型、头部字节与内部条目摘要；图片按视觉消息发送。需要更多细节用 fs_inspect 或 fs_read(format="hex")，不要用 cat 读二进制。`,
    `【资料库】${
      library.length
        ? `${library.join("、")}（长期保存的重要资料，跨会话可用；先用 library_list 查看，再用 library_read 读取）`
        : "空（没有收藏或导入的资料）"
    }`,
    `【已启用插件】${plugins.join("、") || "无"}`,
    `【推理强度】${
      {
        off: "Off — 不展开推理，直接给结论与产物。",
        low: "Low — 直接给结论，少解释，能一次做完就一次做完。",
        high: "High — 结论先行，关键步骤简要说明。",
        max: "Max — 回答前先列出关键假设，工具调用前确认路径与影响，结论附上依据。",
      }[state.settings.reasoning] || "High — 结论先行，关键步骤简要说明。"
    }`,
    `【设备时间】${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
    "【行为准则】",
    "1. 需要看文件就先调用工具读取，绝不臆造文件内容或路径。",
    "2. 写文件前先确认原内容；一次只做必要的改动，保留原有结构。",
    "3. 路径一律使用相对路径，不带前导斜杠；不要访问工作区以外的路径。",
    "4. 工具失败时先解释原因，再换一条路径重试；不要重复完全相同的调用。",
    "5. 最终回答结论先行，中文，简洁；适合对比的内容用 Markdown 表格，不要堆砌客套话。",
    "6. 不要声称执行了没有实际调用的工具。",
    "7. 终端是白名单命令，不是完整 Linux：不要 cp 到 /tmp 再用 od；看二进制结构用 fs_inspect，看字节用 fs_read(format=\"hex\")，复制/移动/删除用 cp / mv / rm。",
  ].join("\n");
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
      const content = doc.encoding === "base64" ? decodeTextBase64(doc.content) : String(doc.content ?? "");
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

async function chatOnce({ messages, tools, signal, onText, onReasoning, onUsage }) {
  const active = currentModel();
  if (!active) throw new Error("还没有添加模型。到 设置 → 模型管理 里添加一个，选好供应方一分钟就能接上。");
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
  if (res.diff) tool.diff = res.diff;
  if (res.code) tool.code = res.code;
  if (res.safety) tool.safety = res.safety;
  if (res.export) tool.export = res.export;
  ctx.onChange();
  return res;
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
  }
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
  const convo = [
    { role: "system", content: buildSystemPrompt() },
    ...history,
    { role: "user", content: userContent },
  ];
  const windowTokens = modelContextWindow();

  const maxSteps = Math.max(1, Math.min(100, state.settings.maxSteps || 24));

  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    msg.steps = step + 1;
    let streamed = "";
    let reasoning = "";
    // 本步推理的起止时刻：用于在 UI 上显示「已思考 X」
    let reasonStart = 0;
    let reasonEnd = 0;

    // 每步请求前按窗口预算裁剪较早回合；完整 convo 仍保留在本轮内
    const trimmed = trimMessages(convo, windowTokens);
    if (trimmed.removed) {
      const prev = msg.contextTrim?.removed || 0;
      msg.contextTrim = {
        removed: Math.max(prev, trimmed.removed),
        window: windowTokens,
      };
      ctx.onChange();
    }

    const { calls } = await chatOnce({
      messages: trimmed.messages,
      tools: toolSchemas(),
      signal,
      onText(delta) {
        streamed += delta;
        msg.content += delta;
        ctx.onChange();
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
      msg.content = msg.content.trim();
      return;
    }

    const resolved = calls.map((c) => ({
      ...c,
      callId: c.id || `call_${Math.random().toString(36).slice(2, 10)}`,
    }));

    convo.push({
      role: "assistant",
      content: streamed,
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
      convo.push({
        role: "tool",
        tool_call_id: call.callId,
        content: res.output || (res.ok ? "完成" : "失败"),
      });
    }

    // 工具结果回合后给模型一个干净的续写起点
    msg.content += msg.content.endsWith("\n") ? "" : "\n\n";
  }

  throw new Error(`已达到最大步数（${maxSteps}），Agent 停止。可在设置中调高上限。`);
}

/* ---------------- 子 Agent / 连通性测试 ---------------- */

export async function spawnSubagentOnce(task, signal) {
  const active = currentModel();
  if (!active) throw new Error("还没有添加模型，无法派生子 Agent。");
  const baseUrl = modelBaseUrl(active);
  const model = modelApiId(active);
  if (!baseUrl || !model) throw new Error("请先配置 Base URL 与模型 ID");
  const apiKey = apiKeyFor(active);
  if (!apiKey) throw new Error("当前服务未配置 API Key");
  const res = await fetchWithTimeout(endpointFor(baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你是子 Agent，只做只读分析，不调用工具。用中文给出不超过 120 字的结论。" },
        { role: "user", content: task },
      ],
      temperature: 0.2,
      stream: false,
    }),
  }, signal);
  if (!res.ok) throw new Error(`子 Agent 请求失败（HTTP ${res.status}）`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "（子 Agent 没有返回内容）";
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
  if (!key) throw new Error(`「${model.label}」所属服务还没有配置 Key`);
  const baseUrl = modelBaseUrl(model);
  const apiModel = modelApiId(model);
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

export { availableToolNames, fmtTime };
