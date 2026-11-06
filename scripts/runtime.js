/* ============================================================
   Runtime — Agent 主循环
   两种驱动器：
   1) live：OpenAI 兼容流式接口（DeepSeek / 自定义网关）
   2) 无模型 / 无 Key：直接报错，不再提供本地演示，避免误判
   ============================================================ */

import {
  state,
  currentMode,
  currentPreset,
  readFile,
  readDoc,
  listFiles,
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
  modelFormat,
  upsertCustomModel,
  resolveDiscoveredModels,
  providerKeyOf,
  keyDiagnosis,
  saveModelOverride,
} from "./store.js";
import { trimMessages, compactMessages, estimateTokens } from "./context.js";
import { buildSystemPromptText } from "./prompt.js";
import { sanitizeUntrusted } from "./inject.js";
import { toolSchemas, executeTool, availableToolNames, inspectPath } from "./tools.js";
import { nativeStream, nativeHttpAvailable } from "./native-http.js";
import { withRetry } from "./retry.js";
import { parseToolArgs, argsErrorText } from "./toolargs.js";
import { isImagePath, imageMime, prepareImage } from "./image.js";
import {
  buildPromptBlock,
  buildMemoryBlock,
  RULES as MEMORY_RULES,
  detectCorrection,
  createTagFilter,
  stripMemoryTags,
  persistTags,
} from "./memory.js";
import { beginTrajectory, captureTool, endTrajectory, abortTrajectory } from "./traj.js";
import { isNodeLlmModel, nodeProviderOf, streamViaNode } from "./llm-bridge.js";
import {
  formatOf,
  normalizeFormat,
  accumulateToolCall,
  safeUrl,
  errorDetail as fmtErrorDetail,
  httpHint as fmtHttpHint,
  authFailureHint,
  connectionProfile,
  agnesSiteOf,
  agnesAltBaseUrl,
} from "./formats.js";

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
  const preset = currentPreset();
  return {
    mode: { name: mode.name, detail: mode.detail },
    // 只有选过工作模式才带；没选就是 undefined，那一段根本不会出现在 prompt 里
    preset: preset ? { name: preset.name, prompt: preset.prompt } : undefined,
    permission:
      state.settings.permission === "readonly"
        ? "只读"
        : state.settings.permission === "full"
          ? "完全访问"
          : "工作区写入",
    reasoning: state.settings.reasoning,
    // 只给模型看「当前会话的工作区视图」。state.files 是全量真实路径索引，
    // 直接塞进去会把别的会话的 sessions/<id>/… 路径也暴露出来。
    files: listFiles(),
    library: Object.values(state.library || {}),
    plugins: state.plugins.filter((p) => p.enabled),
    // 已装技能：只给清单，全文让模型自己 skill_read
    skills: Array.isArray(state.skills) ? state.skills : [],
    mcpServers: Array.isArray(state.settings.mcpServers) ? state.settings.mcpServers : [],
    minimal: state.settings.mode === "minimal",
    now: new Date().toLocaleString("zh-CN", { hour12: false }),
    // 记忆关掉时整段规则也不出现 —— 否则模型会去找一个不存在的库
    memoryRules: state.settings.memoryEnabled === false ? "" : MEMORY_RULES,
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
    // 只追加**数据块**。固定规则已经在 base 里（见 prompt.js 的 memory-rules 段）——
    // 分开之后，规则部分每轮都能命中原生前缀缓存，只有这一小块数据会 miss。
    const block = buildMemoryBlock(query, maxTokens ? { maxTokens } : {});
    return block ? `${base}\n\n${block}` : base;
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

/**
 * 流式读到底，喂给协议适配器。
 *
 * 适配器自己知道怎么切帧（SSE / NDJSON），这里只负责把字节搬过去，
 * 顺便留一份原文给「网关其实没走流」的回退用。
 */
async function readStream(res, parser) {
  let raw = "";
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (raw.length < 8000000) raw += text;
      parser.feed(text);
    }
    const tail = decoder.decode();
    if (tail) {
      if (raw.length < 8000000) raw += tail;
      parser.feed(tail);
    }
  } else {
    // 有些环境没有 stream API（老 WebView、被代理过的响应）
    raw = await res.text();
    parser.feed(raw);
  }
  parser.flush();
  return { raw };
}

function errorDetail(text) {
  return fmtErrorDetail(text);
}

function httpHint(status) {
  return fmtHttpHint(status);
}

/** 401 / 403 时把服务端原文、Key 槽位与自查清单组装成可展示的诊断。 */
function authDiagnosisFor(model, status, detail) {
  if (status !== 401 && status !== 403) return "";
  try {
    return authFailureHint(status, detail, {
      ...keyDiagnosis(model),
      providerKey: providerKeyOf(model),
    });
  } catch {
    return "";
  }
}

/**
 * 401 / 403 时判断该不该换一个 Agnes 站点重试。
 *
 * 为什么只在这一处判断：Agnes 是唯一「同一套 API、两套互不通用的 Key」
 * 的服务商。国内站的 Key 打到国际站，服务端只会说「Invalid token」——
 * 和「Key 打错了」在字面上完全一样，但换一个域名就好了。
 * 用户不会想到「端口填错了站」，只会以为应用把 Key 弄丢了。
 *
 * 返回 "" 表示不重试：非 Agnes 端点、已经重试过、或状态码不是鉴权类。
 */
function agnesSwitchTarget(model, baseUrl, status, alreadyRetried) {
  if (alreadyRetried) return "";
  if (status !== 401 && status !== 403) return "";
  const alt = agnesAltBaseUrl(baseUrl);
  if (!alt) return "";
  // 403 也可能是「这个模型没开通」，但代价只是多一次几百毫秒的请求，
  // 换来的结论明确得多：两站都不行就不是站点问题。
  return alt;
}

/**
 * 两站都试过之后，把结论说透。
 *
 * 只写「Key 无效」会让用户继续在字符上找问题；明确告诉他已经排除了站点，
 * 才能把注意力放回 Key 本身（是否被删除、是否属于另一个账号）。
 */
function withSiteNote(hint, retried) {
  if (!retried) return hint;
  const line =
    "已分别试过国内站（.cn）与国际站（.com），两站都拒绝 —— 问题不在站点选择，而在 Key 本身或账号状态。";
  return hint ? `${hint}\n${line}` : line;
}

/** 换站成功后的说明，拼进成功结果里给界面展示。 */
function siteNoteOf(baseUrl, alt, status) {
  const to = agnesSiteOf(alt);
  const from = agnesSiteOf(baseUrl);
  const where = (x) => (x === "cn" ? "国内站（.cn）" : "国际站（.com）");
  return `原端点 ${where(from)} 返回 ${status}，已自动切换到${where(to)}并保存。国内站与国际站的 Key 不通用，换站后即可正常对话。`;
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
async function chatViaNode(active, { messages, tools, signal, onText, onReasoning, onUsage, onPhase }) {
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
      onText: (d) => {
        onPhase?.("streaming");
        onText?.(d);
      },
      onReasoning: (d) => {
        onPhase?.("thinking");
        onReasoning?.(d);
      },
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

/* ---------------- 重试 ---------------- */

/**
 * 带重试的请求。
 *
 * 逻辑本身在 retry.js（可单独测）。这里只负责一件它做不到的事：
 * 判断「这一次尝试是不是已经输出过内容」—— 那要盯着流式回调，
 * 只有这一层看得见。
 *
 * 已经吐过字就不能重试：用户已经看到上半段了，重发会让
 * 同一段话在屏幕上出现两遍，还多花一次钱。
 */
async function chatOnce(opts) {
  let produced = false;
  // 一条消息最多回滚一次。第二次还断说明链路确实不行，
  // 再闪一次只是折磨人 —— 那时改成如实报错。
  let rolledBack = false;

  return await withRetry(
    async () => {
      produced = false;
      // 每次尝试从同一个起点重来，界面层在这里记快照
      opts.onAttemptStart?.();
      try {
        return await chatAttempt({
          ...opts,
          onText: (d) => {
            produced = true;
            opts.onText?.(d);
          },
          onReasoning: (d) => {
            produced = true;
            opts.onReasoning?.(d);
          },
        });
      } catch (err) {
        err.produced = produced;
        // ============ 断流 + 已经吐了字：撤回重发 ============
        //
        // 这是「已经输出过就不重试」的唯一例外。断流和 4xx 不一样：
        // 服务端没有拒绝，只是链路中途断了，重发一次大概率就好。
        //
        // 之所以敢撤回，是因为工具执行发生在 chatAttempt 返回之后 ——
        // 此刻一个工具都没跑过，把这几段文字抹掉重来不会产生副作用。
        // 不撤回的话，用户只能看着一条跑到 20 步的任务整轮失败。
        // 代价是文字会闪一下重新出现，所以限制为每条消息只回滚一次。
        const canRollback =
          produced && err.streamBroken && !rolledBack && typeof opts.onRollback === "function";
        if (canRollback) {
          rolledBack = true;
          opts.onRollback();
          produced = false;
          err.produced = false;
          err.rolledBack = true;
        } else if (produced && err.streamBroken) {
          // 已经回滚过一次还断：不重试，但要说清原因，
          // 别让人以为是程序卡住了。
          err.message += "（这条回复已经输出了一部分，为避免内容重复没有自动重试；直接再发一次即可）";
        }
        throw err;
      }
    },
    {
      signal: opts.signal,
      onRetry: opts.onRetry,
    }
  );
}

/**
 * 一轮对话请求的外层。
 *
 * 只做一件事：换站成功之后把新地址写回配置。失败的尝试一律不改配置 ——
 * 「两站都不通」时把用户填的地址悄悄换掉，只会让下次排查更难。
 */
async function chatAttempt(args) {
  const out = await chatAttemptOnce(args);
  if (args.siteRetry && args.forceBaseUrl) {
    const active = currentModel();
    if (active && active.id) {
      try {
        saveModelOverride(active.id, { baseUrl: args.forceBaseUrl });
      } catch {
        /* 存档失败不影响这一轮 */
      }
    }
  }
  return out;
}

async function chatAttemptOnce({
  messages,
  tools,
  signal,
  onText,
  onReasoning,
  onUsage,
  onPhase,
  // Agnes 换站重试：forceBaseUrl 直接指定这一轮要打的地址，
  // 不依赖 saveModelOverride 是否已经反映到 currentModel() 上。
  siteRetry = false,
  forceBaseUrl = "",
}) {
  const active = currentModel();
  if (!active) throw new Error("还没有添加模型。到 设置 → 模型管理 里添加一个，选好供应方一分钟就能接上。");

  // ============ 插件提供的模型：请求交给 Node 里的 adapter ============
  //
  // 这类模型没有 Base URL —— 它的端点在插件的 adapter 闭包里，
  // 只有加载了插件的 Node 进程能执行它。所以这里换一条路走。
  if (isNodeLlmModel(active)) {
    return await chatViaNode(active, { messages, tools, signal, onText, onReasoning, onUsage, onPhase });
  }

  const apiKey = apiKeyFor(active);
  const baseUrl = forceBaseUrl || modelBaseUrl(active);
  const model = modelApiId(active);
  if (!apiKey) throw new Error("当前模型所属服务还没有配置 API Key");
  if (!baseUrl) throw new Error("当前模型没有 Base URL，请到模型参数里填写");
  if (!model) throw new Error("当前模型没有模型 ID，请到模型参数里填写");

  // 协议：条目自己带的 format 优先；老条目没有这个字段，按 OpenAI 兼容处理。
  const format = normalizeFormat(active.format);
  const adapter = formatOf(format);

  // 图片输入不被支持时，服务端通常返回 400/422，这里补一句可操作提示
  const hasImage = messages.some(
    (m) => Array.isArray(m?.content) && m.content.some((part) => part?.type === "image_url")
  );
  const imageHint =
    hasImage && adapter.supportsImages
      ? "（本条消息含图片：若该模型不支持图片输入会返回这个错误，可在 设置 → 当前模型 → 更多参数 关闭「图片输入」，或换用支持视觉的模型）"
      : "";

  const started = Date.now();
  const temperature =
    typeof active.temperature === "number" ? active.temperature : state.settings.temperature ?? 0.3;

  const req = adapter.buildRequest({
    baseUrl,
    apiKey,
    modelId: model,
    messages,
    tools: Array.isArray(tools) ? tools : [],
    stream: true,
    temperature,
    maxTokens: Number(active.maxTokens) > 0 ? Number(active.maxTokens) : 0,
    // 默认透传推理强度；协议没有这个开关、或模型明确不支持时省略，避免 4xx
    effort:
      adapter.supportsEffort && active.supportsEffort !== false
        ? { off: "minimal", low: "low", high: "high", max: "high" }[state.settings.reasoning] || "high"
        : null,
  });

  let diag = {
    endpoint: adapter.chatEndpoint(baseUrl),
    format,
    model,
    status: 0,
    ok: false,
    tokens: 0,
    ms: 0,
  };
  let recorded = false;

  const calls = [];
  const handlers = {
    onText,
    onReasoning,
    onUsage(u) {
      diag.tokens = u?.total_tokens || diag.tokens;
      onUsage?.(u);
    },
    onToolDelta(deltas) {
      (deltas || []).forEach((d) => accumulateToolCall(calls, d));
    },
  };
  const parser = adapter.createStreamParser(handlers);

  let status = 0;
  let raw = "";
  let wholeFinish = null;

  /** 网关忽略 stream:true、直接回一整段 JSON 时，从整包里补出内容。 */
  const applyWhole = () => {
    const whole = adapter.parseWhole(raw);
    if (!whole) return false;
    if (whole.reasoning) handlers.onReasoning(whole.reasoning);
    if (whole.text) handlers.onText(whole.text);
    (whole.toolCalls || []).forEach((c, i) =>
      handlers.onToolDelta([{ index: i, id: c.id, name: c.name, args: c.args }])
    );
    if (whole.usage) handlers.onUsage(whole.usage);
    if (whole.finish) wholeFinish = whole.finish;
    return true;
  };

  /** Anthropic / Gemini / Ollama 会把错误塞进流里，而不是靠 HTTP 状态码。 */
  const throwStreamError = () => {
    if (!parser.error) return;
    const detail = String(parser.error);
    diag = { ...diag, status: status || 0, ms: Date.now() - started, error: detail };
    addDiagnostic(diag);
    setModelStatus(active.id, { ok: false, status: status || 0, error: detail, model });
    throw new Error(`接口返回错误：${detail}`);
  };

  if (nativeHttpAvailable()) {
    // Android 原生通道：绕开 WebView 的 CORS 与流式限制
    await new Promise((resolve, reject) => {
      nativeStream({
        url: req.url,
        headers: req.headers,
        body: req.body,
        signal,
        timeoutSec: 300,
        // 思考型端点（Agnes）首字节可能超过 45 秒；其他服务保持默认，
        // 断网时仍然很快给出结果，不用陪着等到 90 秒。
        ...connectionProfile(baseUrl),
        onStatus: (s) => {
          status = s;
          // 拿到 2xx 就说明请求已经送达、服务端已接受；
          // 之后再久都只是模型在思考，不是"连接失败"。
          if (s >= 200 && s < 300) onPhase?.("waiting");
        },
        onChunk: (text) => {
          if (raw.length < 8000000) raw += text;
          parser.feed(text);
        },
        onEnd: () => resolve(),
        onError: (err) => {
          // ============ 收尾阶段的断流不算失败 ============
          //
          // 不少网关发完最后一个 chunk（里面已经带了 finish_reason）
          // 就直接关连接，收尾的 `data: [DONE]` 根本发不出来。
          // 这时内容其实是完整的，报「请求失败」等于把已经生成好的结果
          // 扔掉，再让模型白跑一遍 —— 长工具循环里这一步特别疼。
          //
          // 判据要严：必须是 2xx、真的解析到过事件、并且拿到了明确的
          // 结束原因。缺一个都不算，宁可重试也不要拿半截结果去执行工具。
          if (status >= 200 && status < 300 && parser.sawEvent && parser.finish) {
            resolve();
            return;
          }
          reject(err);
        },
      });
    }).catch((err) => {
      if (err.name === "AbortError") throw err;
      const httpStatus = Number(err.httpStatus) || 0;
      // ============ 这里以前会把 200 当成错误码 ============
      //
      // `status` 是**这次请求收到过的**状态码。HTTP 200 意味着连接已建好、
      // 服务端已接受请求，此后再出错只可能是「流读到一半断了」，不是
      // 「HTTP 200 这个错误」。
      //
      // 老写法 `code = err.httpStatus || status` 把两者混成一个数，于是
      // 200 被一路带下去：
      //   · 文案变成「请求失败（HTTP 200）」，自相矛盾
      //   · 重试层看到 200 —— 既不是 4xx/5xx 也不是 0 —— 判定不可重试
      //   · 状态条显示「连接失败 · 200」，看起来像服务端返回了错误
      // 结果是：一次流抖动就把整轮对话打死，长工具循环里每多一步就多
      // 一次断流机会，越跑越容易失败。断流本身躲不掉，能修的是别把它
      // 当成终局。
      const gotOk = httpStatus === 0 && status >= 200 && status < 300;
      const code = httpStatus;
      const detail = err.body ? errorDetail(err.body) : err.message;
      const hint = authDiagnosisFor(active, code, detail);
      diag = { ...diag, status: code, ms: Date.now() - started, error: detail, hint };
      addDiagnostic(diag);
      recorded = true;
      setModelStatus(active.id, {
        ok: false,
        status: code,
        // 状态条据此区分「没连上」和「连上了但流断了」——
        // 后者不是 Key / 地址的问题，重试通常就好。
        phase: gotOk ? "stream" : "",
        httpStatus: gotOk ? status : code,
        error: detail,
        hint,
        model,
      });
      // httpStatus / retryAfter 要挂在错误上：外层据此判断该不该重试、等多久。
      // 以前这里只抛了文案，重试层拿不到状态码，只能一律不重试。
      if (code) {
        const alt = agnesSwitchTarget(active, baseUrl, code, siteRetry);
        if (alt) {
          // 换站重发；写回配置交给外层，成功才写。
          return chatAttempt({
            messages,
            tools,
            signal,
            onText,
            onReasoning,
            onUsage,
            onPhase,
            siteRetry: true,
            forceBaseUrl: alt,
          });
        }
        const e = new Error(
          `${httpHint(code)}${detail ? ` · ${detail}` : ""}${imageHint}${effortFallback(active, detail)}`
        );
        e.httpStatus = code;
        e.retryAfter = Number(err.retryAfter) || 0;
        e.hint = withSiteNote(hint, siteRetry);
        throw e;
      }
      if (gotOk) {
        // 看门狗掐断（流中间长时间没数据）和连接被重置要分开说：
        // 前者是"服务端还在想/卡住了"，后者是"链路断了"，处理方式不一样。
        const stalled = /空闲|超时|timeout/i.test(detail);
        const e = new Error(
          stalled
            ? `等待响应超时（HTTP ${status} 已连上，${detail}）。服务端长时间没有继续发送数据，可能是模型排队或网关卡住。`
            : `响应中途断开（HTTP ${status} 已连上，数据流在读取时中断${detail ? `：${detail}` : ""}）。` +
              "常见原因是网络切换、代理或网关重置长连接；这一轮没有收到完整回复。"
        );
        // 状态码留 0：这是网络层故障，不是服务端拒绝。
        // streamBroken 让重试层明确放行（已经吐过字时仍然不重试）。
        e.httpStatus = 0;
        e.streamBroken = true;
        throw e;
      }
      const e = new Error(
        `无法连接模型服务：${detail}。请检查 Base URL、网络与证书；Android 端已走原生请求，不再受跨域限制。`
      );
      e.httpStatus = 0;
      throw e;
    });

    parser.flush();
    throwStreamError();
    if (!parser.sawEvent && raw.trim() && !applyWhole()) {
      const detail = errorDetail(raw) || "接口返回了无法解析的内容";
      diag = { ...diag, status: status || 0, ms: Date.now() - started, error: detail };
      addDiagnostic(diag);
      setModelStatus(active.id, { ok: false, status, error: detail, model });
      throw new Error(`接口返回异常：${detail}`);
    }
  } else {
    let res;
    try {
      res = await fetchWithTimeout(
        req.url,
        { method: req.method, headers: req.headers, body: JSON.stringify(req.body) },
        signal
      );
    } catch (err) {
      if (err.name === "AbortError") throw err;
      diag = { ...diag, ms: Date.now() - started, error: err.message };
      addDiagnostic(diag);
      recorded = true;
      setModelStatus(active.id, { ok: false, error: err.message, model });
      const e = new Error(
        `无法连接模型服务：${err.message}。请检查 Base URL 与网络；浏览器预览下还要求服务端允许跨域（CORS）。`
      );
      e.httpStatus = 0;
      throw e;
    }
    status = res.status;
    if (res.ok) onPhase?.("waiting");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const detail = errorDetail(body);
      addDiagnostic({ ...diag, status, ms: Date.now() - started, error: detail || `HTTP ${status}` });
      recorded = true;
      setModelStatus(active.id, { ok: false, status, error: detail, model });
      const alt = agnesSwitchTarget(active, baseUrl, status, siteRetry);
      if (alt) {
        return chatAttempt({
          messages,
          tools,
          signal,
          onText,
          onReasoning,
          onUsage,
          onPhase,
          siteRetry: true,
          forceBaseUrl: alt,
        });
      }
      const e = new Error(
        `${httpHint(status)}${detail ? ` · ${detail}` : ""}${imageHint}${effortFallback(active, detail)}`
      );
      e.httpStatus = status;
      e.hint = withSiteNote(authDiagnosisFor(active, status, detail), siteRetry);
      // 浏览器分支拿 Retry-After 要显式读头，原生桥那边已经带回来了
      const ra = Number(res.headers.get("retry-after")) || 0;
      e.retryAfter = ra;
      throw e;
    }
    const out = await readStream(res, parser);
    raw = out.raw;
    throwStreamError();
    if (!parser.sawEvent && raw.trim()) {
      // 网关忽略 stream:true 直接回整包 JSON —— 解析它而不是给用户一条空白回复
      if (!applyWhole()) {
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
      return { calls: calls.filter(Boolean), finish: wholeFinish || parser.finish || "stop" };
    }
    if (!recorded) {
      addDiagnostic({ ...diag, status, ok: true, ms: Date.now() - started });
      setModelStatus(active.id, { ok: true, status, ms: Date.now() - started, model });
    }
    return { calls: calls.filter(Boolean), finish: parser.finish };
  }

  const ms = Date.now() - started;
  diag = { ...diag, ms, tokens: diag.tokens };
  if (!recorded) addDiagnostic({ ...diag, status, ok: true });
  setModelStatus(active.id, { ok: true, status, ms, model });
  return { calls: calls.filter(Boolean), finish: wholeFinish || parser.finish };
}

/* ---------------- 工具执行封装 ---------------- */

/**
 * 可以安全并行的只读工具。
 *
 * ============ 为什么只有这几个 ============
 *
 * 并行执行的前提是「互不影响」，而这需要很强的保证：
 *   · 只读 —— 两个写操作并行，谁后写谁赢，结果不可预期
 *   · 不弹审批 —— 同时弹三个确认框，用户根本不知道自己在批什么
 *   · 彼此独立 —— 同一批 tool_calls 是模型一步返回的，它还没看到
 *     任何结果，所以只读之间天然不依赖对方
 *
 * 网络类（web_search）、MCP、插件工具都不放进来：它们可能有速率
 * 限制或副作用，而这一层看不见。
 */
const PARALLEL_SAFE = new Set([
  "fs_list",
  "fs_read",
  "fs_inspect",
  "library_list",
  "library_read",
  "calc",
  "now",
]);

/**
 * 这个工具能不能和相邻的只读工具一起并行跑。
 *
 * 导出是为了让测试能直接守住这条线 —— 白名单里混进一个写操作，
 * 平时看不出来，出事就是「两个写同时落盘，谁后写谁赢」。
 */
export function isParallelSafeTool(name) {
  return PARALLEL_SAFE.has(String(name || ""));
}

/**
 * 建工具卡片占位（不执行）。
 *
 * ============ 为什么要拆成两步 ============
 *
 * 并行执行时，谁先跑完谁先 push，卡片顺序就跟着完成顺序乱跳 ——
 * 模型说了「先读 A、再读 B」，界面上却先出现 B。
 *
 * 所以位置在**开始执行前**就占好，执行完只回填内容。
 */
/* ---------------- 时间线 ---------------- */

/**
 * 把「思考 / 正文 / 工具」的真实发生顺序记下来。
 *
 * 早先只存三个桶：msg.reasoning 累积、msg.tools 追加、msg.content 累积。
 * 渲染时固定排成「思考 → 工具 → 正文」，可 Agent 的节奏根本不是这样 ——
 * 想一下、调一个工具、看结果、再想、再调。三桶一平铺，这个顺序就没了，
 * 用户看到的是一坨思考、一堆工具、一段结论，像三份互不相干的附录。
 *
 * 这里额外维护 msg.timeline，只记「哪段文字落在哪个位置」：
 *   { type: "reasoning" | "text", from, to }   to 为 null 表示还在增长
 *   { type: "tool", id }                       指向 msg.tools 里的同一张卡
 *
 * 刻意不把文本搬进 timeline：reasoning / content 仍是唯一副本。
 * 好处是 token 估算、持久化、旧会话降级渲染全都不用改，
 * 写坏的代价也小 —— timeline 丢了只是回到三桶布局，不会丢内容。
 */
function segLength(msg, type) {
  return type === "reasoning" ? (msg.reasoning || "").length : (msg.content || "").length;
}

/** 开始一段文本；类型变了就先把上一段封口。 */
function openSegment(msg, type) {
  const arr = msg.timeline || (msg.timeline = []);
  const last = arr[arr.length - 1];
  if (last && last.type === type && last.to === null) return;
  if (last && last.type !== "tool" && last.to === null) {
    last.to = segLength(msg, last.type);
  }
  arr.push({ type, from: segLength(msg, type), to: null });
}

/** 工具卡插进时间线。卡片位置按模型给出的顺序占好，不等执行完。 */
function pushToolSegment(msg, tool) {
  const arr = msg.timeline || (msg.timeline = []);
  const last = arr[arr.length - 1];
  if (last && last.type !== "tool" && last.to === null) {
    last.to = segLength(msg, last.type);
  }
  arr.push({ type: "tool", id: tool.id });
}

function prepareToolCall(msg, call, args) {
  const tool = {
    id: call.id || `t_${Date.now()}`,
    name: call.name,
    argLabel: call.argLabel || call.argsPreview || "",
    status: "running",
    // 存**解析后的对象**：call.args 在流式聚合阶段是原始 JSON 字符串，
    // 直接塞进去会让 UI 显示成一整行 JSON，也让执行层拿到字符串当对象用。
    args: args || {},
    output: "",
    ms: 0,
  };
  msg.tools.push(tool);
  pushToolSegment(msg, tool);
  return tool;
}

/** 执行一个已经占好位的工具卡片。 */
async function executePreparedTool(tool, call, args, ctx) {
  const parsed = args || {};
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
    agent_team: (args.goal || "").slice(0, 40),
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

/**
 * 运行中用户补充的指令包一层说明：它不是新开一轮任务，而是要求
 * 在**不丢已完成工作**的前提下调整后续步骤。模型看到裸文本容易
 * 把前半段成果推倒重来，这层包装是必要的。
 */
const steerMessage = (text) =>
  `[用户在执行过程中补充的指令 —— 保留已完成的工作，据此调整后续步骤]\n${text}`;

export async function runAgent({ session, text, msg, attachments, signal, onChange, requestApproval, spawnSubagent, pollSteer }) {
  const ctx = { onChange, requestApproval, spawnSubagent, pollSteer };
  msg.status = "running";
  msg.startedAt = Date.now();
  msg.steps = 0;
  // 运行阶段：connecting → waiting → thinking → streaming / acting。
  // 光有"工作中"+秒数不够 —— 服务端深度思考 90 秒时，
  // 用户需要一眼看出"已经连上了，只是模型还没吐字"。
  msg.phase = "connecting";
  // 时间线每轮重建：重发同一条消息时不能把上一轮的段落接在下面
  msg.timeline = [];
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
    // 失败收尾时把重试提示撤掉：它描述的是一个正在进行的动作，
    // 留在消息上会让人以为还在重试
    msg.retry = null;
  } finally {
    msg.duration = Date.now() - msg.startedAt;
    delete msg.phase;
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
  // 图片这一期只做 OpenAI 那一套 image_url；其它协议哪怕用户勾了也不发，
  // 否则 Anthropic / Gemini 的转换层会把 image_url 当成未知片段丢掉。
  // 判据取适配器自己的能力声明，以后哪个协议跟上了只改 formats.js。
  const vision = active ? active.vision !== false && !!formatOf(modelFormat(active)).supportsImages : false;
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

  // 运行中的输入引导：pollSteer 由界面提供，取出这段时间内用户追加的指令。
  // 不打断正在进行的请求 —— 在工具循环边界（下一步请求前）注入 convo，
  // 那既是模型能读到新指令的最早时机，也不会丢掉当前这一轮的流式输出。
  const takeSteer = () => {
    const list = typeof ctx.pollSteer === "function" ? ctx.pollSteer() : [];
    return (Array.isArray(list) ? list : []).map((s) => String(s || "").trim()).filter(Boolean);
  };
  const applySteer = (list) => {
    for (const t of list) convo.push({ role: "user", content: steerMessage(t) });
    msg.steerCount = (msg.steerCount || 0) + list.length;
    msg.steerPending = Math.max(0, (msg.steerPending || 0) - list.length);
    ctx.onChange();
  };

  // 记忆标签在流式过程中就要挡住，否则用户会看到半截 JSON
  const tagFilter = createTagFilter();
  // 用户这次是不是在纠正我们（"不对/错了/重新说"）—— 命中就提高纠正类记忆权重
  const correcting = detectCorrection(text);
  // 已显示的正文（已剥掉标签）：与 msg.content 同步，但由过滤器产出
  let display = "";

  // 工具调用步数不设上限：模型不再返回工具调用时循环自然结束（见下方 !calls.length）。
  // 0.67.0 之前这里夹在 4..100 之间，超了就抛错打断 —— 长任务跑到第 24 步
  // 被硬砍一刀，用户只能去设置里调数字。现在默认 Infinity。
  //
  // 只保留一条不在界面上暴露的内部限流：显式把 settings.maxSteps 设成正数才生效，
  // 给自动化测试限流用（它们的假上游会一直返回工具调用，否则永远不结束）。
  const configuredSteps = Number(state.settings.maxSteps);
  const maxSteps =
    Number.isFinite(configuredSteps) && configuredSteps > 0 ? Math.floor(configuredSteps) : Infinity;

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

  /** 阶段只在真的变化时推进 —— 每个流式 delta 都重绘整条消息太贵。 */
  const setPhase = (p) => {
    if (msg.status !== "running" || msg.phase === p) return;
    msg.phase = p;
    ctx.onChange();
  };

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      // 每个工具循环边界都收一次引导：执行工具期间用户补的指令，
      // 下一次请求就能读到，不必等整轮跑完再重新发一条消息。
      const steers = takeSteer();
      if (steers.length) applySteer(steers);
      msg.steps = step + 1;
      // 多步任务的每一步都是一次新的请求，阶段要回到"连接中"
      if (msg.phase !== "connecting") {
        msg.phase = "connecting";
        ctx.onChange();
      }
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

      // 断流回滚要用到「这次尝试开始时界面长什么样」。
      // 三个起点的含义不同，别混用：
      //   display      跨步累积的正文（msg.content 直接用它）
      //   reasoning    只属于本步，每步开头清空
      //   msg.reasoning 跨步累积，回滚要退回本步开头
      const attemptBase = { display: "", reasoning: "", msgReasoning: "", timeline: 0, tag: null };

      const { calls } = await chatOnce({
        messages: trimmed.messages,
        tools: toolSchemas(),
        signal,
        onPhase: setPhase,
        onAttemptStart() {
          attemptBase.display = display;
          attemptBase.reasoning = reasoning;
          attemptBase.msgReasoning = msg.reasoning || "";
          attemptBase.timeline = Array.isArray(msg.timeline) ? msg.timeline.length : 0;
          attemptBase.tag = tagFilter.snapshot();
        },
        onRollback() {
          display = attemptBase.display;
          msg.content = display;
          reasoning = attemptBase.reasoning;
          msg.reasoning = attemptBase.msgReasoning;
          streamed = "";
          if (Array.isArray(msg.timeline)) msg.timeline.length = attemptBase.timeline;
          tagFilter.restore(attemptBase.tag);
          if (msg.phase !== "connecting") msg.phase = "connecting";
          ctx.onChange();
        },
        onText(delta) {
          setPhase("streaming");
          streamed += delta;
          // 只把「确认不是标签」的部分显示出去
          const clean = tagFilter.push(delta);
          if (clean) {
            openSegment(msg, "text");
            display += clean;
            msg.content = display;
            ctx.onChange();
          }
        },
        onReasoning(delta) {
          // 正文已经开始后不再倒回"正在思考"，多段输出时标签才不会来回跳
          if (msg.phase !== "streaming") setPhase("thinking");
          openSegment(msg, "reasoning");
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
        onRetry(info) {
          // 界面上要说一声。悄悄重试的话，用户只会看到"卡了两秒才出字"，
          // 以为应用在发呆。
          msg.retry = info;
          ctx.onChange();
        },
      });

      // 这一次成功了 —— 重试提示要撤掉，不能留一条"正在重试"挂在消息底下
      if (msg.retry) {
        msg.retry = null;
        ctx.onChange();
      }

      // 累计本步推理耗时（多步时累加），UI 上显示为「已思考 X」
      if (reasonEnd > reasonStart) {
        msg.reasoningMs = (msg.reasoningMs || 0) + (reasonEnd - reasonStart);
      }

      if (!calls.length) {
        // 这里不再 trim。timeline 里的 from/to 是按**未裁剪**的字符串记的，
        // 一旦裁掉首尾空白，所有偏移就整体错位 —— 实测正文会被截掉半句。
        // 结尾的空行交给渲染层处理（那里本来就按段 trim）。
        msg.content = display;
        // 模型刚要收尾、但用户在这段时间里补了指令：不能让它就此结束。
        // 把这一轮的回答写进 convo，再把引导作为新一轮输入，继续循环。
        // 深度思考 90 秒的场景里，引导往往就是在这段"没反应"里输入的。
        const tailSteers = takeSteer();
        if (tailSteers.length) {
          convo.push({ role: "assistant", content: stripMemoryTags(streamed) || "（继续）" });
          applySteer(tailSteers);
          display += "\n\n";
          msg.content = display; // 与 display 同步，时间线偏移才不会错位
          ctx.onChange();
          continue;
        }
        return;
      }

      setPhase("acting");

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

      // ============ 分三步：占位 → 执行 → 组装 ============
      //
      // 拆开是因为"并行"和"顺序"必须解耦：
      //   · 卡片位置要在执行前按模型给的顺序占好，否则谁先跑完谁先出现
      //   · 执行可以并行（只读工具之间互不影响）
      //   · 但回灌给模型的 tool 结果必须严格按原顺序 —— 那是模型自己
      //     排好的，顺序变了它会看不懂「刚才那个结果对应哪次调用」
      const items = resolved.map((call) => {
        // 模型给的 arguments 不总是合法 JSON：可能是两个对象粘在一起、
        // 被 ```json 围栏包着、字符串里有裸换行。截图里那张
        // 「参数解析失败 · Unexpected non-whitespace character after JSON」
        // 就是第一种。先做无损修复，修不了才判失败。
        const parsed = parseToolArgs(call.args);
        const args = parsed.ok ? parsed.value : {};
        const parseError = parsed.ok ? null : parsed.error;

        // 修复是透明的：参数内容仍然是模型原本那一个对象。
        // 只留一行日志，方便排查"它到底发成了什么样"。
        if (parsed.ok && parsed.repaired) {
          console.warn(`[tool-args] ${call.name}: 已修复（${parsed.repaired}）`);
        }

        if (parseError) {
          const badTool = {
            id: `t_${Date.now()}`,
            name: call.name,
            argLabel: "参数解析失败",
            status: "error",
            args: {},
            output: argsErrorText(parseError, call.args),
            ms: 0,
          };
          msg.tools.push(badTool);
          pushToolSegment(msg, badTool);
          return { call, args, parseError, tool: badTool, res: null };
        }

        const tool = prepareToolCall(msg, call, args);
        return { call, args, parseError: null, tool, res: null };
      });
      ctx.onChange();

      // 紧挨着的只读调用合成一批并行跑；遇到写操作就切断，
      // 保证「读 → 写 → 读」的因果顺序不被并行打乱
      let cursor = 0;
      while (cursor < items.length) {
        const head = items[cursor];
        if (!head.parseError && PARALLEL_SAFE.has(head.call.name)) {
          let end = cursor;
          while (
            end < items.length &&
            !items[end].parseError &&
            PARALLEL_SAFE.has(items[end].call.name)
          ) {
            end += 1;
          }
          if (end - cursor > 1) {
            await Promise.all(
              items.slice(cursor, end).map(async (it) => {
                it.res = await executePreparedTool(it.tool, it.call, it.args, ctx);
              })
            );
            cursor = end;
            continue;
          }
        }
        if (!head.parseError) {
          head.res = await executePreparedTool(head.tool, head.call, head.args, ctx);
        }
        cursor += 1;
      }

      for (const it of items) {
        const call = it.call;

        if (it.parseError) {
          convo.push({
            role: "tool",
            tool_call_id: call.callId,
            content: it.tool.output,
          });
          continue;
        }

        const res = it.res || { ok: false, output: "工具没有执行", ms: 0 };
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

  // 只有显式设了内部限流才会走到这里；正常用户是无限循环，靠 !calls.length 收尾。
  throw new Error(`已达到内部设定的步数限流（${maxSteps}），Agent 停止。`);
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

  // 子 Agent 也必须按当前模型的协议发：它在 Anthropic 模型下用 OpenAI 形状
  // 请求只会拿到 400，而且报错会以「工具结果」的形式混进主对话。
  const adapter = formatOf(normalizeFormat(active.format));
  const req = adapter.buildRequest({
    baseUrl,
    apiKey,
    modelId: model,
    messages: subMessages,
    tools: [],
    stream: false,
    temperature: 0.2,
    maxTokens: 1024,
    effort: null,
  });
  const out = await minimalRequest({
    url: req.url,
    headers: req.headers,
    payload: req.body,
    timeoutSec: 120,
    signal,
  });
  if (out.status < 200 || out.status >= 300) {
    throw new Error(`子 Agent 请求失败（HTTP ${out.status}）${errorDetail(out.raw) ? `：${errorDetail(out.raw)}` : ""}`);
  }
  const whole = adapter.parseWhole(out.raw);
  const raw = (whole && whole.text) || "（子 Agent 没有返回内容）";
  // 出口层清洗：子 Agent 的输出会以工具结果的形式回到主对话。
  // 如果子 Agent 读了恶意网页/文件，它的输出可能带着伪造的
  // 记忆标签或角色头 —— 不清洗就等于让内容二次注入。
  return sanitizeUntrusted(String(raw));
}

/** 发一次最小请求，返回原始文本与状态码；Android 走原生，浏览器走 fetch。 */
async function minimalRequest({ url, headers, payload, timeoutSec = 60, method = "POST", signal }) {
  if (nativeHttpAvailable()) {
    let status = 0;
    let raw = "";
    // 读超时必须比「首字节耐心值」更长，否则 SocketTimeout 会先于看门狗
    // 触发，用户看到的是一条没有上下文的 SocketTimeoutException。
    // GET（模型列表）不抬：探测模型是轻请求，断网时应该 20 秒内失败，
    // 不该陪着聊天模型等 105 秒。
    const prof = connectionProfile(url);
    const readSec =
      method === "GET"
        ? Number(timeoutSec) || 60
        : Math.max(Number(timeoutSec) || 60, prof.firstByteSec > 0 ? prof.firstByteSec + 15 : 0);
    await new Promise((resolve, reject) => {
      nativeStream({
        url,
        headers,
        body: method === "GET" ? {} : payload,
        method,
        timeoutSec: readSec,
        ...prof,
        signal,
        onStatus: (s) => {
          status = s;
        },
        onChunk: (t) => {
          if (raw.length < 2000000) raw += t;
        },
        onEnd: resolve,
        onError: reject,
      });
    }).catch((err) => {
      if (err.name === "AbortError") throw err;
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
    res = await fetchWithTimeout(
      url,
      {
        method,
        headers,
        body: method === "GET" ? undefined : JSON.stringify(payload),
      },
      signal
    );
  } catch (err) {
    if (err.name === "AbortError") throw err;
    const e = new Error(`无法连接：${err.message}（浏览器预览下还要求服务端允许 CORS）`);
    e.network = true;
    throw e;
  }
  const raw = await res.text().catch(() => "");
  return { status: res.status, raw };
}

/**
 * 按协议探测端点的可用模型。
 *
 * 每家的端点、鉴权、响应结构都不一样，所以具体怎么试交给 formats.js；
 * 这里只提供一个「发请求」的能力，顺便把原生桥的 status/body 错误
 * 转回统一的 { status, text }，让适配器不必知道底下走的是哪条通道。
 */
export async function fetchModelList({ format = "openai", baseUrl, apiKey, signal, providerKey = "" } = {}) {
  const adapter = formatOf(format);
  const run = async (base) =>
    adapter.listModels({
      baseUrl: base,
      apiKey,
      signal,
      request: async (r) => {
        try {
          const out = await minimalRequest({
            url: r.url,
            headers: r.headers,
            method: r.method,
            timeoutSec: r.timeoutSec,
            signal,
          });
          return { status: out.status, text: out.raw };
        } catch (err) {
          if (err.status) return { status: err.status, text: err.body || "" };
          throw err;
        }
      },
    });

  // 拉列表和对话走的是同一对域名，也会撞上「Key 属于另一站」。
  // 这里没有模型 id 可以写回，只能把对的地址带回去让表单自己改 ——
  // 否则用户会卡在「填了 Key 却一个模型都列不出来」。
  let listed;
  let switchedTo = "";
  try {
    listed = await run(baseUrl);
  } catch (err) {
    const code = Number(err?.httpStatus || err?.status) || 0;
    const alt = code === 401 || code === 403 ? agnesAltBaseUrl(baseUrl) : "";
    if (!alt) throw err;
    listed = await run(alt);
    switchedTo = alt;
  }

  // 显示名在这里统一收口成可直接发送的真实 ID，UI 不必再关心上游字段命名。
  const out = { ...listed, items: resolveDiscoveredModels(providerKey, listed.items) };
  if (switchedTo) out.switchedTo = switchedTo;
  return out;
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
  const format = normalizeFormat(model.format);
  const adapter = formatOf(format);

  // ============ 先打配置里的地址，必要时再换一个 Agnes 站 ============
  //
  // 用户填的国际站地址 + 国内站生成的 Key，是最容易发生、也最难自查的
  // 一种 401：两站是同一套 API，报错文案一模一样，只有域名不同。
  // 所以这里不急着下结论 —— 先换另一个站试一次，再决定怎么报错。
  let site = baseUrl;
  let switchedFrom = "";
  let switchedStatus = 0;
  let result = null;
  let req = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // 用同一个适配器发 ping，测的才是聊天真正会走的那条路
    req = adapter.buildRequest({
      baseUrl: site,
      apiKey: key,
      modelId: apiModel,
      messages: [{ role: "user", content: "ping" }],
      tools: [],
      stream: false,
      temperature: 0.2,
      maxTokens: 16,
      effort: null,
    });

    let failure = null;
    try {
      result = await minimalRequest({
        url: req.url,
        headers: req.headers,
        payload: req.body,
        timeoutSec: 60,
      });
      if (result.status >= 200 && result.status < 300) break;
      failure = { code: result.status, detail: errorDetail(result.raw) };
    } catch (err) {
      // 原生桥把 4xx 的响应体放在 err.body，err.message 只有干巴巴的
      // "HTTP 401"。以前直接用它，服务端真正的原因（Invalid token /
      // Token not provided / 额度不足）全被丢掉，界面只剩「Key 无效」四个字，
      // 用户拿着电脑上验证过的 Key 无从查起。
      const code = Number(err.status || err.httpStatus) || 0;
      failure = { code, detail: errorDetail(err.body) || err.message || "网络不可达" };
    }

    const ms = Date.now() - started;
    addDiagnostic({
      endpoint: safeUrl(req.url),
      format,
      model: apiModel,
      status: failure.code,
      ok: false,
      ms,
      error: failure.detail,
    });

    const alt = agnesSwitchTarget(model, site, failure.code, attempt > 0);
    if (alt) {
      switchedFrom = site;
      switchedStatus = failure.code;
      site = alt;
      continue;
    }

    const hint = authDiagnosisFor(model, failure.code, failure.detail);
    const message = failure.code
      ? `${httpHint(failure.code)}${failure.detail ? ` · ${failure.detail}` : ""}`
      : failure.detail || "网络不可达";
    record({
      ok: false,
      status: failure.code,
      error: failure.detail,
      hint,
      model: apiModel,
      endpoint: safeUrl(req.url),
    });
    const e = new Error(message);
    e.hint = withSiteNote(hint, attempt > 0);
    e.httpStatus = failure.code;
    throw e;
  }

  if (!result || result.status < 200 || result.status >= 300) {
    throw new Error("连接失败：重试后仍未拿到可用响应");
  }

  const whole = adapter.parseWhole(result.raw);
  const usage = (whole && whole.usage && whole.usage.total_tokens) || 0;
  const ms = Date.now() - started;

  // 换站成功 → 写回配置，下次直接打对的地址，不再多花一次请求。
  if (switchedFrom) {
    try {
      saveModelOverride(model.id, { baseUrl: site });
    } catch {
      /* 存档失败不影响这次结论 */
    }
  }

  addDiagnostic({
    endpoint: safeUrl(req.url),
    format,
    model: apiModel,
    status: result.status,
    ok: true,
    tokens: usage,
    ms,
  });
  record({ ok: true, status: result.status, ms, model: apiModel, endpoint: safeUrl(req.url) });

  const out = { ms, model: apiModel, usage, endpoint: safeUrl(req.url), status: result.status };
  if (switchedFrom) {
    out.siteSwitched = true;
    out.site = agnesSiteOf(site);
    out.siteNote = siteNoteOf(switchedFrom, site, switchedStatus);
    record({
      ok: true,
      status: result.status,
      ms,
      model: apiModel,
      endpoint: safeUrl(req.url),
      siteNote: out.siteNote,
    });
  }
  return out;
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
