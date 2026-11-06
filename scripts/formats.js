/* ============================================================
   接口协议适配层

   之前"发请求"这件事只有一种形状：OpenAI Chat Completions。
   payload 写死在 runtime.js，流解析只认 `data:` + `choices[0].delta`。
   Claude 官方、Gemini 官方、原生 Ollama 因此一个都接不进来。

   这里把"协议差异"单独收拢：一家一个适配器，负责四件事 ——
     ① 把内部统一的消息（OpenAI 形状）翻译成目标协议的 URL + 头 + body
     ② 把目标协议的流式分片翻译回统一回调
     ③ 把目标协议的非流式整包翻译回统一结果
     ④ 按自己的规矩列出可用模型

   内部结构（messages / tools / tool_calls）**始终是 OpenAI 形状**，
   转换只发生在出站前与入站后。这是兼容性的底线：历史消息、工具执行、
   插件模型都不用知道底下说的是哪种协议。

   本文件是纯函数模块：不 import store、不碰 window / localStorage，
   Node 里可以直接 import 来跑单测。
   ============================================================ */

export const FORMAT_IDS = ["openai", "anthropic", "gemini", "ollama"];

export const FORMAT_LABELS = {
  openai: "OpenAI 兼容",
  anthropic: "Anthropic Messages",
  gemini: "Google Gemini",
  ollama: "Ollama 原生",
};

export const FORMAT_SHORT = {
  openai: "OpenAI",
  anthropic: "Claude",
  gemini: "Gemini",
  ollama: "Ollama",
};

/** 端点形态各异，统一按这个顺序试。 */
export const FORMAT_HINTS = {
  openai: "任何说 OpenAI Chat Completions 的服务或网关：/chat/completions",
  anthropic: "Claude 官方 API 与 Anthropic 兼容中转：/v1/messages",
  gemini: "Google AI Studio / Vertex 的 generativelanguage 接口：models/{id}:generateContent",
  ollama: "本机或局域网的 Ollama 服务：/api/chat，不用 Key",
};

import { authChecklist } from "./apikeys.js";

export const trimSlash = (v) => String(v || "").trim().replace(/\/+$/, "");

export function normalizeFormat(id) {
  return FORMAT_IDS.indexOf(String(id || "")) >= 0 ? String(id) : "openai";
}

/** 诊断、错误文案里只用这个：去掉 query 与 hash，Key 不会漏进日志。 */
export function safeUrl(url) {
  const raw = String(url || "");
  const cut = raw.split("#")[0].split("?")[0];
  return cut.replace(/^https?:\/\//, "");
}

export function httpHint(status) {
  // 2xx 不是错误码。真走到这里说明上游把「连上了、但流断了」和
  // 「HTTP 200 这个错误」混在了一起 —— 给一句说得通的话，别再输出
  // 「请求失败（HTTP 200）」这种自相矛盾的文案。
  if (status >= 200 && status < 300) {
    return "请求已经连上，但响应没有正常结束（数据流中断）。";
  }
  return (
    {
      400: "请求格式被拒绝，请检查模型 ID 与参数。",
      // 别急着下「Key 无效」的结论：同一把 Key 在电脑上有效时，
      // 更可能是请求头没带上、槽位填错、选错协议或权限问题。
      401: "服务端未接受这次的 API Key（401）。",
      402: "账户余额不足，请前往服务商控制台充值。",
      403: "该 Key 没有访问此模型的权限，或服务端拒绝了请求来源。",
      404: "接口路径或模型 ID 不存在。模型一栏要填 ID（小写连字符，如 deepseek-v4.1-flash），不是「DeepSeek V4.1 Flash」这类显示名。",
      413: "请求体过大，可能是图片或上下文超出上限。",
      422: "参数被服务端拒绝，常见于工具定义或上下文超限。",
      429: "触发限流（429）：30–60 秒后再试；免费 / 低价档模型并发限制更严，连续多次请求也容易触发，请检查账户余额与限流规则。",
      500: "服务端内部错误，稍后重试。",
      502: "网关错误，服务端暂时不可用。",
      503: "服务端繁忙或过载，稍后重试。",
      529: "服务端过载（529），稍后重试。",
    }[status] || `请求失败（HTTP ${status}）。`
  );
}

/**
 * 401 / 403 的诊断正文。
 *
 * 「API Key 无效」这个结论下得太早：一把在电脑上验证过的 Key，
 * 到移动端被拒，常见原因是**没带上 / 填错槽 / 选错协议 / 没权限**，
 * 而不是字符错了。这里把服务端原文、当前读的槽位、脱敏的 Key 形态
 * 和自查清单摊开，用户才能自己判断差在哪。
 */
export function authFailureHint(status, detail, diag = {}) {
  const d = String(detail || "").trim();
  const lines = [];
  if (status === 403) {
    lines.push(
      `服务端拒绝了请求（403）。403 是权限 / 来源被拒，不等于 Key 拼错${d ? `；原文：${d}` : ""}。`
    );
    lines.push("常见于该 Key 没有开通所选模型、账户额度不足、或网关（含 Cloudflare）拦下了移动端来源。换 Wi-Fi / 移动数据各试一次。");
  } else if (/token not provided|missing.*token|no.*token|未提供|没有.*令牌/i.test(d)) {
    lines.push("服务端说「没有收到 Token」—— 请求头里根本没有 Key。多半是填到了别的服务槽位。");
  } else {
    lines.push(`服务端没有接受这把 Key${d ? `；原文：${d}` : ""}。`);
  }

  if (diag.slot) {
    lines.push(
      `当前模型读的是「${diag.slot}」槽：${diag.shape?.masked || "（空）"}。`
    );
    if (diag.filledElsewhere?.length) {
      lines.push(
        `你还在这些槽里填过 Key：${diag.filledElsewhere.join("、")}。如果填错了服务，请改到「${diag.slot}」。`
      );
    }
    if (diag.cleaned?.length) {
      lines.push(`本版已自动清理 Key 里的 ${diag.cleaned.join("、")}。`);
    }
  }
  // 逐条分行：窄屏上连成一大段「a；b；c」几乎读不下去，
  // 而这里每一条都是用户可以单独去核对的动作。
  lines.push("自查：");
  // 这里是纯文本面板，不是 Markdown —— 反引号只会显示成两个多余的字符。
  authChecklist(diag.providerKey || "", d).forEach((item, i) => {
    lines.push(`  ${i + 1}. ${item.replace(/`/g, "")}`);
  });
  return lines.join("\n");
}

/** 从各家形态各异的错误体里揪出一句能看的话。 */
export function errorDetail(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  // Cloudflare 拦截 / 人机校验 / 打错路径，返回的都是 HTML。原样截 240 字
  // 只会把半个 <!DOCTYPE html> 甩到用户脸上，既看不懂也帮不上忙。
  if (/^<!doctype\s+html|^<html[\s>]/i.test(raw)) {
    if (/cloudflare|__cf_chl|cf-challenge|just a moment|attention required/i.test(raw)) {
      return "网关返回了 Cloudflare 校验页而不是 API 响应；换一个网络（Wi-Fi / 移动数据）或稍后重试";
    }
    return "端点返回的是网页而不是 API 响应；Base URL 应指向接口地址（一般以 /v1 结尾）";
  }
  try {
    const body = JSON.parse(raw);
    if (typeof body === "string") return body.slice(0, 240);
    if (typeof body.error === "string") return body.error.slice(0, 240);
    const message =
      (body.error && (body.error.message || body.error.status)) || body.message || body.detail;
    if (message) return String(message).slice(0, 240);
    return JSON.stringify(body).slice(0, 240);
  } catch {
    return raw.slice(0, 240);
  }
}

/**
 * 工具调用分片聚合。
 *
 * 大部分网关每个分片都重复携带 id / name：必须覆盖而非拼接，
 * 否则聚合出 "call_Acall_A"、"calc_calc"。参数则相反，必须拼。
 */
export function accumulateToolCall(calls, d) {
  const i = d.index === undefined || d.index === null ? calls.length : d.index;
  const call = calls[i] || (calls[i] = { id: "", name: "", args: "" });
  // 两种形状都认：OpenAI 的原始分片是 {function:{name,arguments}}，
  // 适配器归一化之后是扁平的 {name,args}。
  const name = d.name || (d.function && d.function.name);
  const args = d.args !== undefined ? d.args : d.function && d.function.arguments;
  if (d.id) call.id = d.id;
  if (name) call.name = name;
  if (args) call.args += args;
  return call;
}

/**
 * 通用 SSE 分帧。
 *
 * 规范是"空行分帧"，但现实里两类网关都不老实：
 *   · OpenAI 兼容网关经常不补空行，只逐行发 data:
 *   · Anthropic 会先给 event: 再给 data:，事件类型在 data 外面
 *
 * 所以两套都认：data 行一进来就尝试 parse，成功就立刻派发（保证首字延迟
 * 不退化）；同时保留帧缓冲，遇到空行或 flush 时再兜底派发一次。
 */
export function createSSEFrames(onEvent) {
  let buffer = "";
  let eventName = "";
  let dataLines = [];
  let sawEvent = false;

  const dispatch = () => {
    if (!dataLines.length) {
      eventName = "";
      return;
    }
    const payload = dataLines.join("\n");
    const name = eventName;
    dataLines = [];
    eventName = "";
    if (!payload) return;
    sawEvent = true;
    onEvent(name, payload);
  };

  const tryInline = () => {
    const payload = dataLines.join("\n");
    if (!payload) return;
    if (payload === "[DONE]") {
      dispatch();
      return;
    }
    try {
      JSON.parse(payload);
    } catch {
      return;
    }
    dispatch();
  };

  const line = (raw) => {
    const l = raw.replace(/\r$/, "");
    if (!l) {
      dispatch();
      return;
    }
    if (l.charAt(0) === ":") return; // 注释 / 心跳
    if (l.indexOf("event:") === 0) {
      eventName = l.slice(6).trim();
      return;
    }
    if (l.indexOf("data:") === 0) {
      let v = l.slice(5);
      if (v.charAt(0) === " ") v = v.slice(1);
      dataLines.push(v);
      tryInline();
    }
    // id: / retry: 与本次解析无关
  };

  return {
    feed(text) {
      buffer += text;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    flush() {
      if (buffer) {
        line(buffer);
        buffer = "";
      }
      dispatch();
    },
    get sawEvent() {
      return sawEvent;
    },
  };
}

/* ============================================================
   OpenAI Chat Completions（原有行为，逐字段保持）
   ============================================================ */

/**
 * 有些网关（Agnes 的 FCC 兼容档就是一例）不开 reasoning_content，
 * 而是把思考过程直接内联在 content 里：
 *
 *   <think time="1.2s">用户要的是…</think>好的，我先…
 *
 * 原样透传会有两个后果：正文里冒出一大段自我独白；思考内容还会被
 * 当成正文写进历史，下一轮继续污染上下文。这里做一个流式拆分器，
 * 只在**消息开头**识别一次思考标签 —— 正文中间出现 `<think` 大概率
 * 是代码示例，不能碰。
 */
const THINK_OPEN_RE = /^<(think|thinking|reasoning)(?:\s[^>]*)?>/i;
const THINK_CLOSE_RE = /<\/(think|thinking|reasoning)\s*>/i;
/** 半截标签 `<thin` / `</think` 最长也就这么长，先扣住等下一片。 */
const THINK_PARTIAL = 16;

export function createThinkSplitter(handlers = {}) {
  const onText = handlers.onText;
  const onReasoning = handlers.onReasoning;
  let buf = "";
  let state = "lead"; // lead：还没判定开头；think：标签内；text：正文

  const emitText = (s) => {
    if (s) onText?.(s);
  };
  const emitReason = (s) => {
    if (s) onReasoning?.(s);
  };

  const drain = () => {
    for (;;) {
      if (state === "lead") {
        const lead = buf.replace(/^\s+/, "");
        if (!lead) {
          buf = "";
          return;
        }
        const m = THINK_OPEN_RE.exec(lead);
        if (m) {
          state = "think";
          buf = lead.slice(m[0].length);
          continue;
        }
        // 可能是标签的前半截（"<thi"），先别下结论
        if (/^<[a-z]*$/i.test(lead) && lead.length < THINK_PARTIAL) {
          buf = lead;
          return;
        }
        state = "text";
        emitText(buf);
        buf = "";
        return;
      }
      if (state === "text") {
        emitText(buf);
        buf = "";
        return;
      }
      const m = THINK_CLOSE_RE.exec(buf);
      if (m) {
        emitReason(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
        state = "text";
        continue;
      }
      // 闭合标签还没到：只扣住可能是 "</thi" 的尾巴，其余照常流出去
      const cut = Math.max(0, buf.length - THINK_PARTIAL);
      if (cut > 0) {
        emitReason(buf.slice(0, cut));
        buf = buf.slice(cut);
      }
      return;
    }
  };

  return {
    push(text) {
      buf += String(text || "");
      drain();
    },
    flush() {
      if (state === "think") emitReason(buf);
      else emitText(buf);
      buf = "";
      state = "text";
    },
  };
}

/**
 * Agnes 有两个站，域名不同、Key 不通用：
 *   国际站 https://apihub.agnes-ai.com/v1（Cloudflare，新加坡节点）
 *   国内站 https://apihub.agnes-ai.cn/v1 （境内部署，国内访问快）
 * 2026-07 国内站上线后，两套 Key 各自只认自己的域名 —— 配错就是 401，
 * 而服务端只说「Invalid token」，非常容易误判成「Key 是假的」。
 *
 * 所以这里必须同时认 .com 和 .cn：只认 .com 会让国内站端点拿不到
 * 双鉴权头、宽容首字节和参数裁剪，成为一条「能用但处处别扭」的路径。
 */
function isAgnesEndpoint(baseUrl) {
  // 结尾必须是路径 / 端口 / 查询串或字符串结束：`agnes-ai.com.evil.cn`
  // 这类后缀伪装在正则里会被 `\.com` 命中，换个域名就能冒充。
  return /(?:^|[/.])agnes-ai\.(?:com|cn)(?=$|[/:?#])/i.test(String(baseUrl || ""));
}

/** "cn" | "intl" | ""（不是 Agnes 端点）。 */
export function agnesSiteOf(baseUrl) {
  const s = String(baseUrl || "");
  if (!isAgnesEndpoint(s)) return "";
  return /agnes-ai\.cn/i.test(s) ? "cn" : "intl";
}

/**
 * 另一个站的同路径地址。用于 401 时的自动纠偏：
 * 同一把 Key 在另一个站上多半是好的，先试一次再下结论。
 * 只换主机名，路径（/v1）与协议保持不变。
 */
export function agnesAltBaseUrl(baseUrl) {
  const s = String(baseUrl || "");
  const site = agnesSiteOf(s);
  if (site === "cn") return s.replace(/agnes-ai\.cn/i, "agnes-ai.com");
  if (site === "intl") return s.replace(/agnes-ai\.com/i, "agnes-ai.cn");
  return "";
}

/**
 * 连接耐心值。
 *
 * Agnes 的节点在新加坡，且 3.0 系会先思考再吐字：首字节 30–60 秒很常见。
 * 原生桥原来的 45 秒首字节上限会把「模型正在思考」误判成「连接卡死」，
 * 用户看到的就是莫名其妙的超时重试。这里按服务商给出覆盖值，
 * 其余服务沿用原默认（45s / 8s），不拖慢真正的断网失败。
 */
export function connectionProfile(baseUrl) {
  if (isAgnesEndpoint(baseUrl)) return { firstByteSec: 90, connectSec: 12 };
  return { firstByteSec: 0, connectSec: 0 };
}

function openaiChatUrl(baseUrl) {
  const base = trimSlash(baseUrl);
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

const openai = {
  id: "openai",
  label: FORMAT_LABELS.openai,
  short: FORMAT_SHORT.openai,
  hint: FORMAT_HINTS.openai,
  supportsImages: true,
  supportsEffort: true,
  defaultBaseUrl: "",

  chatEndpoint(baseUrl) {
    return safeUrl(openaiChatUrl(baseUrl));
  },

  listEndpoint(baseUrl) {
    const base = trimSlash(baseUrl);
    return safeUrl(/\/v\d+$/i.test(base) ? `${base}/models` : `${base}/v1/models`);
  },

  buildRequest({ baseUrl, apiKey, modelId, messages, tools, stream, temperature, maxTokens, effort }) {
    const list = Array.isArray(tools) ? tools : [];
    // Agnes 的文档只列了 model / messages / temperature / top_p / max_tokens /
    // stream / tools / tool_choice / chat_template_kwargs。stream_options 与
    // reasoning_effort 都不在列 —— 部分严格网关遇到未知字段直接 400，
    // 表现就是「Key 是对的，但一连就报请求格式被拒绝」。
    const agnes = isAgnesEndpoint(baseUrl);
    const body = {
      model: modelId,
      messages,
      tools: list.length ? list : undefined,
      tool_choice: list.length ? "auto" : undefined,
      stream: stream !== false,
      ...(!agnes && stream !== false ? { stream_options: { include_usage: true } } : {}),
      temperature: typeof temperature === "number" ? temperature : 0.3,
      ...(Number(maxTokens) > 0 ? { max_tokens: Number(maxTokens) } : {}),
      // Agnes 没有 reasoning_effort，思考开关在 chat_template_kwargs 里。
      // effort 为空表示用户没开推理滑条，这时不传，按模型默认走。
      ...(effort
        ? agnes
          ? { chat_template_kwargs: { enable_thinking: effort !== "minimal" && effort !== "off" } }
          : { reasoning_effort: effort }
        : {}),
    };
    return {
      url: openaiChatUrl(baseUrl),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    };
  },

  createStreamParser(handlers) {
    const h = handlers || {};
    let finish = null;
    // 内联 think 标签在分片边界上会被切断，交给拆分器跨包处理。
    const split = createThinkSplitter({ onText: h.onText, onReasoning: h.onReasoning });
    const frames = createSSEFrames((name, payload) => {
      if (payload === "[DONE]") {
        if (!finish) finish = "stop";
        return;
      }
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        return;
      }
      if (!json) return;
      if (json.usage && h.onUsage) h.onUsage(json.usage);
      const choice = json.choices && json.choices[0];
      if (!choice) return;
      const delta = choice.delta || {};
      // 思维链字段各家不统一：DeepSeek / Qwen 系用 reasoning_content，
      // 聚合网关常见 reasoning / thought / thinking。以前只认第一个，
      // 其余的会被静默丢掉 —— 界面上就表现为"模型想了一分半却啥也没显示"。
      const reason = delta.reasoning_content ?? delta.reasoning ?? delta.thought ?? delta.thinking;
      if (typeof reason === "string" && reason && h.onReasoning) h.onReasoning(reason);
      if (delta.content) split.push(delta.content);
      if (delta.tool_calls && h.onToolDelta) h.onToolDelta(delta.tool_calls);
      if (choice.finish_reason) finish = choice.finish_reason;
    });
    return {
      feed: frames.feed,
      flush() {
        frames.flush();
        split.flush();
      },
      get finish() {
        return finish;
      },
      get sawEvent() {
        return frames.sawEvent;
      },
      get error() {
        return null;
      },
    };
  },

  /** 有些网关忽略 stream:true，直接回一整段 JSON。 */
  parseWhole(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!data) return null;
    const choice = data.choices && data.choices[0];
    const message = choice && choice.message;
    if (!message && !data.usage) return null;
    const toolCalls = Array.isArray(message && message.tool_calls)
      ? message.tool_calls.map((c, i) => ({
          id: c.id || `call_${i}`,
          name: (c.function && c.function.name) || "",
          args: (c.function && c.function.arguments) || "",
        }))
      : [];
    const wholeReason = message && (message.reasoning_content ?? message.reasoning ?? message.thought ?? message.thinking);
    // 网关忽略 stream:true 时也会把 think 标签塞在 content 里，同样要拆。
    const rawText = (message && message.content) || "";
    let text = rawText;
    let inlineReason = "";
    if (rawText) {
      text = "";
      const split = createThinkSplitter({
        onText: (t) => {
          text += t;
        },
        onReasoning: (r) => {
          inlineReason += r;
        },
      });
      split.push(rawText);
      split.flush();
    }
    const reason = [typeof wholeReason === "string" ? wholeReason : "", inlineReason]
      .filter(Boolean)
      .join("\n");
    return {
      text,
      reasoning: reason,
      toolCalls,
      finish: (choice && choice.finish_reason) || "stop",
      usage: data.usage || null,
    };
  },

  /**
   * 逐路径试 /models。
   *
   * 端点形态太杂：/v1、/compatible-mode/v1、/api/paas/v4、裸域名……
   * 先试 base 本身，再去掉尾部版本号试一次；不带版本号时补 /v1。
   */
  async listModels({ baseUrl, apiKey, request, signal }) {
    if (!trimSlash(baseUrl)) throw new Error("先填 Base URL");
    if (!apiKey) throw new Error("先填这个服务的 API Key，才能获取可用模型");

    const base = trimSlash(baseUrl);
    const roots = [];
    roots.push(base);
    const stripped = base.replace(/\/v\d+$/i, "");
    if (stripped !== base) roots.push(stripped);

    const urls = [];
    roots.forEach((r) => {
      urls.push(`${r}/models`);
      if (!/\/v\d+$/i.test(r)) urls.push(`${r}/v1/models`);
    });
    const unique = urls.filter((u, i) => urls.indexOf(u) === i).slice(0, 6);

    const tried = [];
    for (const url of unique) {
      try {
        const out = await request({
          url,
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
          timeoutSec: 30,
          signal,
        });
        if (out.status === 401 || out.status === 403 || out.status === 402) {
          const detail = errorDetail(out.text);
          const err = new Error(`${httpHint(out.status)}${detail ? ` · ${detail}` : ""}`);
          err.httpStatus = out.status;
          throw err;
        }
        if (out.status < 200 || out.status >= 300) {
          tried.push(`${safeUrl(url)} → HTTP ${out.status}`);
          continue;
        }
        const list = parseOpenAIModelList(out.text);
        if (!list.length) {
          tried.push(`${safeUrl(url)} → 200 但列表为空`);
          continue;
        }
        return { items: list, endpoint: safeUrl(url) };
      } catch (err) {
        if (err.httpStatus) throw err; // Key / 权限问题，换路径也没用
        tried.push(`${safeUrl(url)} → ${err.message || "请求失败"}`);
      }
    }
    throw new Error(
      `这个端点没有返回模型列表（${tried.slice(0, 3).join("；")}）。很多网关不提供 /models，直接点「常用模型」即可，不必手动填 ID。`
    );
  },
};

/**
 * 从各种常见响应结构里取出模型条目。
 *
 * 网关的字段命名很不统一：有的给 id，有的给 model_id / slug，有的只给 name，
 * 而 name 还可能是「DeepSeek V4.1 Flash」这种**显示名**。旧实现把 name 当 ID
 * 兜底，结果把显示名原样存进 model.apiModel 发到 /chat/completions，
 * 网关找不到模型直接回 404（OpenDesign 就是这么踩的）。
 *
 * 现在三条硬规矩：
 *   1. 只有长得像 ID（不含空格 / 中文）的值才进 id；
 *   2. 显示名一律放 label，id 留空，交给上层反查表纠正；
 *   3. 容器支持 data / models / result / response / items…，多个数组合并，
 *      避免嵌套一层就整个列表变空。
 */
const MODEL_ID_FIELDS = ["id", "model_id", "modelId", "slug", "model"];
const MODEL_LABEL_FIELDS = ["display_name", "displayName", "label", "title", "name", "id"];
const MODEL_LIST_KEYS = ["data", "models", "result", "response", "items", "list", "results"];
export const MODEL_ID_RE = /^[A-Za-z0-9._:/+@-]+$/;

function firstText(obj, fields) {
  for (const k of fields) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** 递归收集响应里所有可能的列表数组（限深度，避免异常结构失控）。 */
function collectModelLists(node, depth, out) {
  if (!node || typeof node !== "object" || depth > 4) return out;
  if (Array.isArray(node)) {
    out.push(node);
    return out;
  }
  for (const k of MODEL_LIST_KEYS) {
    const child = node[k];
    if (Array.isArray(child)) out.push(child);
    else if (child && typeof child === "object") collectModelLists(child, depth + 1, out);
  }
  return out;
}

export function parseOpenAIModelList(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const lists = collectModelLists(data, 0, []);
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const m of list) {
      if (typeof m === "string") {
        const id = m.trim();
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push({ id, label: "" });
        }
        continue;
      }
      if (!m || typeof m !== "object") continue;
      const label = firstText(m, MODEL_LABEL_FIELDS);
      let id = "";
      for (const k of MODEL_ID_FIELDS) {
        const v = m[k];
        if (typeof v === "string" && v.trim() && MODEL_ID_RE.test(v.trim())) {
          id = v.trim();
          break;
        }
      }
      // 有些网关直接把 ID 放在 name 里（{"name":"gpt-4o"}）：只有长得像 ID 才认
      if (!id && label && MODEL_ID_RE.test(label)) id = label;
      const key = id || label;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ id, label: label && label !== id ? label : "" });
    }
  }
  return out.sort((a, b) => String(a.id || a.label).localeCompare(String(b.id || b.label)));
}

/** 兼容旧调用：只要 ID 列表。 */
export function parseOpenAIModelIds(raw) {
  return parseOpenAIModelList(raw).map((it) => it.id).filter(Boolean);
}

/* ============================================================
   Anthropic Messages
   ============================================================ */

function anthropicRoot(baseUrl) {
  let b = trimSlash(baseUrl).replace(/\/messages$/i, "");
  if (!/\/v\d+$/i.test(b)) b += "/v1";
  return b;
}

function anthropicHeaders(apiKey, baseUrl = "") {
  const h = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    // 浏览器预览里直连官方 API 必须显式开这个；原生桥不看它，带上无害
    "anthropic-dangerous-direct-browser-access": "true",
  };
  // Agnes 的网关以 `Authorization: Bearer` 为主鉴权。它的 /v1/messages
  // 也吃 x-api-key，但 /v1/chat/completions 只认 Authorization，
  // 少了就回「Token not provided」→ 界面显示「Key 无效」。
  // 端点选到「Anthropic 兼容」时两种头一起发，避免同一个 Key
  // 在两种协议下得到不同结论（官方 Anthropic 会忽略多余的头）。
  if (isAgnesEndpoint(baseUrl)) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

function httpError(status, text) {
  const detail = errorDetail(text);
  const err = new Error(`${httpHint(status)}${detail ? ` · ${detail}` : ""}`);
  err.httpStatus = status;
  return err;
}

/** 消息内容里的纯文本（数组取 text part）。 */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && p.type === "text" ? p.text || "" : ""))
    .filter(Boolean)
    .join("\n");
}

function mapAnthropicStop(reason) {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "refusal") return "content_filter";
  return "stop";
}

/**
 * 内部 OpenAI 形状 → Anthropic 的 system + messages。
 *
 * 两个硬规矩：
 *   · system 必须提到顶层，不能混在 messages 里
 *   · user / assistant 严格交替，连续的 tool_result 要并进同一条 user
 */
function toAnthropicMessages(messages) {
  const system = [];
  const list = [];

  (messages || []).forEach((m) => {
    if (!m || !m.role) return;
    if (m.role === "system") {
      const t = contentText(m.content);
      if (t) system.push(t);
      return;
    }
    if (m.role === "assistant") {
      const blocks = [];
      const t = contentText(m.content);
      if (t) blocks.push({ type: "text", text: t });
      (m.tool_calls || []).forEach((c, i) => {
        const fn = c.function || {};
        let input = {};
        try {
          input = JSON.parse(fn.arguments || "{}");
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: c.id || `toolu_${i}`, name: fn.name || "tool", input });
      });
      if (blocks.length) list.push({ role: "assistant", content: blocks });
      return;
    }
    if (m.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: m.tool_call_id || "",
        content: contentText(m.content) || "（空结果）",
      };
      const last = list[list.length - 1];
      if (last && last.role === "user" && last.__results) last.content.push(block);
      else list.push({ role: "user", content: [block], __results: true });
      return;
    }
    // user
    if (typeof m.content === "string") {
      if (m.content) list.push({ role: "user", content: [{ type: "text", text: m.content }] });
      return;
    }
    const blocks = [];
    (Array.isArray(m.content) ? m.content : []).forEach((p) => {
      if (!p) return;
      if (p.type === "text" && p.text) blocks.push({ type: "text", text: p.text });
      else if (p.type === "image_url") {
        blocks.push({ type: "text", text: "（图片未发送：当前接口格式不支持图片输入）" });
      }
    });
    if (blocks.length) list.push({ role: "user", content: blocks });
  });

  // 合并相邻同角色（Anthropic 不接受连续两条 user / assistant）
  const merged = [];
  list.forEach((m) => {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      const a = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: prev.content }];
      const b = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
      prev.content = a.concat(b);
    } else {
      merged.push({ role: m.role, content: m.content, __results: m.__results });
    }
  });
  while (merged.length && merged[0].role !== "user") merged.shift();

  return {
    system: system.join("\n\n"),
    messages: merged.map((m) => ({ role: m.role, content: m.content })),
  };
}

const anthropic = {
  id: "anthropic",
  label: FORMAT_LABELS.anthropic,
  short: FORMAT_SHORT.anthropic,
  hint: FORMAT_HINTS.anthropic,
  supportsImages: false,
  supportsEffort: false,
  defaultBaseUrl: "https://api.anthropic.com",

  chatEndpoint(baseUrl) {
    return safeUrl(`${anthropicRoot(baseUrl)}/messages`);
  },

  listEndpoint(baseUrl) {
    return safeUrl(`${anthropicRoot(baseUrl)}/models`);
  },

  buildRequest({ baseUrl, apiKey, modelId, messages, tools, stream, temperature, maxTokens }) {
    const conv = toAnthropicMessages(messages);
    const list = Array.isArray(tools) ? tools : [];
    const body = {
      model: modelId,
      // Anthropic 的 max_tokens 是必填项，留空会被 400 拒掉
      max_tokens: Number(maxTokens) > 0 ? Number(maxTokens) : 8192,
      messages: conv.messages,
      stream: stream !== false,
      temperature: typeof temperature === "number" ? Math.max(0, Math.min(1, temperature)) : 0.3,
    };
    if (conv.system) body.system = conv.system;
    if (list.length) {
      body.tools = list.map((t) => {
        const fn = t.function || t;
        return {
          name: fn.name,
          description: fn.description || "",
          input_schema: fn.parameters || { type: "object", properties: {} },
        };
      });
      body.tool_choice = { type: "auto" };
    }
    return {
      url: `${anthropicRoot(baseUrl)}/messages`,
      method: "POST",
      headers: anthropicHeaders(apiKey, baseUrl),
      body,
    };
  },

  createStreamParser(handlers) {
    const h = handlers || {};
    let finish = null;
    let error = null;
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let sawUsage = false;
    let tools = 0;
    const blockToTool = {};

    const frames = createSSEFrames((event, payload) => {
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch {
        return;
      }
      if (!ev) return;
      const type = ev.type || event;

      if (type === "message_start") {
        const u = (ev.message && ev.message.usage) || {};
        usage.prompt_tokens = Number(u.input_tokens) || 0;
        sawUsage = true;
        return;
      }
      if (type === "content_block_start") {
        const block = ev.content_block || {};
        if (block.type === "tool_use") {
          const idx = tools++;
          blockToTool[ev.index] = idx;
          if (h.onToolDelta) h.onToolDelta([{ index: idx, id: block.id, name: block.name }]);
        }
        return;
      }
      if (type === "content_block_delta") {
        const d = ev.delta || {};
        if (d.type === "text_delta") {
          if (d.text && h.onText) h.onText(d.text);
        } else if (d.type === "thinking_delta" || d.type === "reasoning_delta") {
          const t = d.thinking ?? d.reasoning ?? d.text;
          if (t && h.onReasoning) h.onReasoning(t);
        } else if (d.type === "input_json_delta") {
          const idx = blockToTool[ev.index];
          if (idx !== undefined && d.partial_json && h.onToolDelta) {
            h.onToolDelta([{ index: idx, args: d.partial_json }]);
          }
        }
        return;
      }
      if (type === "message_delta") {
        if (ev.delta && ev.delta.stop_reason) finish = mapAnthropicStop(ev.delta.stop_reason);
        if (ev.usage) {
          usage.completion_tokens = Number(ev.usage.output_tokens) || 0;
          usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          sawUsage = true;
        }
        if (sawUsage && h.onUsage) h.onUsage(usage);
        return;
      }
      if (type === "error") {
        error = (ev.error && ev.error.message) || "Anthropic 返回了一个错误事件";
      }
    });

    return {
      feed: frames.feed,
      flush: frames.flush,
      get finish() {
        return finish;
      },
      get sawEvent() {
        return frames.sawEvent;
      },
      get error() {
        return error;
      },
    };
  },

  parseWhole(raw) {
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!d || !Array.isArray(d.content)) return null;
    let text = "";
    let reasoning = "";
    const toolCalls = [];
    d.content.forEach((b) => {
      if (!b) return;
      if (b.type === "text") text += b.text || "";
      else if (b.type === "thinking") reasoning += b.thinking || "";
      else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id || `toolu_${toolCalls.length}`,
          name: b.name || "tool",
          args: JSON.stringify(b.input || {}),
        });
      }
    });
    const u = d.usage || {};
    return {
      text,
      reasoning,
      toolCalls,
      finish: mapAnthropicStop(d.stop_reason),
      usage: {
        prompt_tokens: Number(u.input_tokens) || 0,
        completion_tokens: Number(u.output_tokens) || 0,
        total_tokens: (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0),
      },
    };
  },

  async listModels({ baseUrl, apiKey, request, pageToken }) {
    if (!apiKey) throw new Error("先填这个服务的 API Key，才能获取可用模型");
    const root = anthropicRoot(baseUrl);
    const items = [];
    let after = pageToken || "";
    for (let page = 0; page < 3; page++) {
      const url = `${root}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
      const out = await request({
        url,
        method: "GET",
        headers: anthropicHeaders(apiKey, baseUrl),
        timeoutSec: 30,
      });
      if (out.status < 200 || out.status >= 300) throw httpError(out.status, out.text);
      let data;
      try {
        data = JSON.parse(out.text);
      } catch {
        data = {};
      }
      (data.data || []).forEach((m) => {
        if (m && m.id) items.push({ id: String(m.id), label: m.display_name || "" });
      });
      if (!data.has_more || !data.last_id) break;
      after = data.last_id;
    }
    return { items, endpoint: safeUrl(`${root}/models`) };
  },
};

/* ============================================================
   Google Gemini（generativelanguage）
   ============================================================ */

function geminiRoot(baseUrl) {
  const b = trimSlash(baseUrl).replace(/\/models$/i, "");
  if (!/\/v\d+(alpha|beta)?$/i.test(b)) return `${b}/v1beta`;
  return b;
}

function geminiModelPath(modelId) {
  return String(modelId || "")
    .replace(/^models\//, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

function mapGeminiStop(reason) {
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "RECITATION" || reason === "BLOCKLIST" || reason === "PROHIBITED_CONTENT") {
    return "content_filter";
  }
  return "stop";
}

/** Gemini 的 JSON Schema 比 OpenAI 严：类型要大写、不认 additionalProperties。 */
function geminiSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "OBJECT", properties: {} };
  }
  const out = {};
  Object.keys(schema).forEach((k) => {
    const v = schema[k];
    if (k === "$schema" || k === "additionalProperties" || k === "default" || k === "examples") return;
    if (k === "type" && typeof v === "string") out.type = v.toUpperCase();
    else if (k === "properties" && v && typeof v === "object") {
      out.properties = {};
      Object.keys(v).forEach((p) => {
        out.properties[p] = geminiSchema(v[p]);
      });
    } else if (k === "items") out.items = geminiSchema(v);
    else if (k === "required") {
      if (Array.isArray(v) && v.length) out.required = v;
    } else out[k] = v;
  });
  return out;
}

/** 内部 OpenAI 形状 → Gemini 的 systemInstruction + contents。 */
function toGeminiContents(messages) {
  const system = [];
  const list = [];
  const nameById = {};

  (messages || []).forEach((m) => {
    if (!m || !m.role) return;
    if (m.role === "system") {
      const t = contentText(m.content);
      if (t) system.push(t);
      return;
    }
    if (m.role === "assistant") {
      const parts = [];
      const t = contentText(m.content);
      if (t) parts.push({ text: t });
      (m.tool_calls || []).forEach((c) => {
        const fn = c.function || {};
        let args = {};
        try {
          args = JSON.parse(fn.arguments || "{}");
        } catch {
          args = {};
        }
        if (c.id) nameById[c.id] = fn.name;
        parts.push({ functionCall: { name: fn.name || "tool", args } });
      });
      if (parts.length) list.push({ role: "model", parts });
      return;
    }
    if (m.role === "tool") {
      const name = nameById[m.tool_call_id] || "tool";
      list.push({
        role: "user",
        parts: [{ functionResponse: { name, response: { result: contentText(m.content) || "（空结果）" } } }],
      });
      return;
    }
    const parts = [];
    if (typeof m.content === "string") {
      if (m.content) parts.push({ text: m.content });
    } else {
      (Array.isArray(m.content) ? m.content : []).forEach((p) => {
        if (!p) return;
        if (p.type === "text" && p.text) parts.push({ text: p.text });
        else if (p.type === "image_url") {
          parts.push({ text: "（图片未发送：当前接口格式不支持图片输入）" });
        }
      });
    }
    if (parts.length) list.push({ role: "user", parts });
  });

  // 相邻同角色合并；Gemini 不接受以 model 开头
  const merged = [];
  list.forEach((m) => {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.parts = prev.parts.concat(m.parts);
    else merged.push({ role: m.role, parts: m.parts });
  });
  while (merged.length && merged[0].role !== "user") merged.shift();

  return { system: system.join("\n\n"), contents: merged };
}

function geminiUsage(u) {
  const prompt = Number(u.promptTokenCount) || 0;
  const out = (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: out,
    total_tokens: Number(u.totalTokenCount) || prompt + out,
  };
}

const gemini = {
  id: "gemini",
  label: FORMAT_LABELS.gemini,
  short: FORMAT_SHORT.gemini,
  hint: FORMAT_HINTS.gemini,
  supportsImages: false,
  supportsEffort: false,
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",

  chatEndpoint(baseUrl, modelId) {
    const id = modelId || "{model}";
    return safeUrl(`${geminiRoot(baseUrl)}/models/${geminiModelPath(id)}:generateContent`);
  },

  listEndpoint(baseUrl) {
    return safeUrl(`${geminiRoot(baseUrl)}/models`);
  },

  buildRequest({ baseUrl, apiKey, modelId, messages, tools, stream, temperature, maxTokens }) {
    const conv = toGeminiContents(messages);
    const list = Array.isArray(tools) ? tools : [];
    const body = {
      contents: conv.contents,
      generationConfig: {},
    };
    if (typeof temperature === "number") {
      body.generationConfig.temperature = Math.max(0, Math.min(2, temperature));
    }
    if (Number(maxTokens) > 0) body.generationConfig.maxOutputTokens = Number(maxTokens);
    if (conv.system) body.systemInstruction = { parts: [{ text: conv.system }] };
    if (list.length) {
      body.tools = [
        {
          functionDeclarations: list.map((t) => {
            const fn = t.function || t;
            return {
              name: fn.name,
              description: fn.description || "",
              parameters: geminiSchema(fn.parameters),
            };
          }),
        },
      ];
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }

    const path = `${geminiRoot(baseUrl)}/models/${geminiModelPath(modelId)}`;
    const url = stream !== false ? `${path}:streamGenerateContent?alt=sse` : `${path}:generateContent`;
    return {
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 放 header 而不是 ?key=：URL 会进代理日志与诊断
        "x-goog-api-key": apiKey,
      },
      body,
    };
  },

  createStreamParser(handlers) {
    const h = handlers || {};
    let finish = null;
    let error = null;
    let tools = 0;
    const emitted = {};

    const consume = (d) => {
      if (!d) return;
      if (d.error) {
        error = d.error.message || d.error.status || "Gemini 返回了一个错误";
        return;
      }
      if (d.promptFeedback && d.promptFeedback.blockReason) {
        error = `请求被 Gemini 的安全策略拦截：${d.promptFeedback.blockReason}`;
        return;
      }
      const cand = d.candidates && d.candidates[0];
      if (cand) {
        const parts = (cand.content && cand.content.parts) || [];
        parts.forEach((p) => {
          if (!p) return;
          if (p.functionCall) {
            const name = p.functionCall.name || "tool";
            const args = JSON.stringify(p.functionCall.args || {});
            const key = `${name}|${args}`;
            if (emitted[key]) return; // 同一次调用可能被重复推送
            emitted[key] = true;
            const idx = tools++;
            if (h.onToolDelta) h.onToolDelta([{ index: idx, id: `call_g_${idx}`, name, args }]);
            return;
          }
          if (typeof p.text === "string" && p.text) {
            if (p.thought) {
              if (h.onReasoning) h.onReasoning(p.text);
            } else if (h.onText) h.onText(p.text);
          }
        });
        if (cand.finishReason) finish = mapGeminiStop(cand.finishReason);
      }
      if (d.usageMetadata && h.onUsage) h.onUsage(geminiUsage(d.usageMetadata));
    };

    const frames = createSSEFrames((event, payload) => {
      let d;
      try {
        d = JSON.parse(payload);
      } catch {
        return;
      }
      consume(d);
    });

    return {
      feed: frames.feed,
      flush: frames.flush,
      get finish() {
        return finish;
      },
      get sawEvent() {
        return frames.sawEvent;
      },
      get error() {
        return error;
      },
    };
  },

  parseWhole(raw) {
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!d) return null;
    if (d.error) return null;
    const cand = d.candidates && d.candidates[0];
    if (!cand) return null;
    let text = "";
    let reasoning = "";
    const toolCalls = [];
    const parts = (cand.content && cand.content.parts) || [];
    parts.forEach((p) => {
      if (!p) return;
      if (p.functionCall) {
        toolCalls.push({
          id: `call_g_${toolCalls.length}`,
          name: p.functionCall.name || "tool",
          args: JSON.stringify(p.functionCall.args || {}),
        });
      } else if (typeof p.text === "string") {
        if (p.thought) reasoning += p.text;
        else text += p.text;
      }
    });
    return {
      text,
      reasoning,
      toolCalls,
      finish: mapGeminiStop(cand.finishReason),
      usage: d.usageMetadata ? geminiUsage(d.usageMetadata) : null,
    };
  },

  async listModels({ baseUrl, apiKey, request, pageToken }) {
    if (!apiKey) throw new Error("先填这个服务的 API Key，才能获取可用模型");
    const root = geminiRoot(baseUrl);
    const items = [];
    let token = pageToken || "";
    for (let page = 0; page < 3; page++) {
      const url = `${root}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
      const out = await request({
        url,
        method: "GET",
        headers: { "x-goog-api-key": apiKey },
        timeoutSec: 30,
      });
      if (out.status < 200 || out.status >= 300) throw httpError(out.status, out.text);
      let data;
      try {
        data = JSON.parse(out.text);
      } catch {
        data = {};
      }
      (data.models || []).forEach((m) => {
        if (!m || !m.name) return;
        const methods = m.supportedGenerationMethods;
        // 只列能聊天的：embedding / aqa 这些列出来只会让人点错
        if (Array.isArray(methods) && methods.length && methods.indexOf("generateContent") < 0) return;
        items.push({
          id: String(m.name).replace(/^models\//, ""),
          label: m.displayName || "",
          ctx: Number(m.inputTokenLimit) || 0,
        });
      });
      token = data.nextPageToken || "";
      if (!token) break;
    }
    return { items, endpoint: safeUrl(`${root}/models`) };
  },
};

/* ============================================================
   Ollama 原生（/api/chat + NDJSON）
   ============================================================ */

function ollamaRoot(baseUrl) {
  return trimSlash(baseUrl)
    .replace(/\/v1$/i, "")
    .replace(/\/api$/i, "");
}

/** 内部 OpenAI 形状 → Ollama 的 messages（它自己的工具调用没有 id）。 */
function toOllamaMessages(messages) {
  const nameById = {};
  const out = [];
  (messages || []).forEach((m) => {
    if (!m || !m.role) return;
    if (m.role === "assistant") {
      const item = { role: "assistant", content: contentText(m.content) || "" };
      const calls = [];
      (m.tool_calls || []).forEach((c) => {
        const fn = c.function || {};
        let args = {};
        try {
          args = JSON.parse(fn.arguments || "{}");
        } catch {
          args = {};
        }
        if (c.id) nameById[c.id] = fn.name;
        calls.push({ function: { name: fn.name || "tool", arguments: args } });
      });
      if (calls.length) item.tool_calls = calls;
      out.push(item);
      return;
    }
    if (m.role === "tool") {
      const item = { role: "tool", content: contentText(m.content) || "（空结果）" };
      const name = nameById[m.tool_call_id];
      if (name) item.tool_name = name;
      out.push(item);
      return;
    }
    if (m.role === "system") {
      out.push({ role: "system", content: contentText(m.content) });
      return;
    }
    let text = contentText(m.content);
    if (!text && Array.isArray(m.content)) text = "（图片未发送：当前接口格式不支持图片输入）";
    out.push({ role: "user", content: text });
  });
  return out;
}

const ollama = {
  id: "ollama",
  label: FORMAT_LABELS.ollama,
  short: FORMAT_SHORT.ollama,
  hint: FORMAT_HINTS.ollama,
  supportsImages: false,
  supportsEffort: false,
  defaultBaseUrl: "http://localhost:11434",

  chatEndpoint(baseUrl) {
    return safeUrl(`${ollamaRoot(baseUrl)}/api/chat`);
  },

  listEndpoint(baseUrl) {
    return safeUrl(`${ollamaRoot(baseUrl)}/api/tags`);
  },

  buildRequest({ baseUrl, apiKey, modelId, messages, tools, stream, temperature, maxTokens }) {
    const list = Array.isArray(tools) ? tools : [];
    const options = {};
    if (typeof temperature === "number") options.temperature = temperature;
    if (Number(maxTokens) > 0) options.num_predict = Number(maxTokens);
    const body = {
      model: modelId,
      messages: toOllamaMessages(messages),
      stream: stream !== false,
    };
    if (list.length) body.tools = list;
    if (Object.keys(options).length) body.options = options;
    const headers = { "Content-Type": "application/json" };
    // 本地服务一般不看 Key，但经过反代时可能要求；占位符不往外发
    if (apiKey && apiKey !== "ollama-local") headers.Authorization = `Bearer ${apiKey}`;
    return {
      url: `${ollamaRoot(baseUrl)}/api/chat`,
      method: "POST",
      headers,
      body,
    };
  },

  createStreamParser(handlers) {
    const h = handlers || {};
    let finish = null;
    let error = null;
    let buffer = "";
    let sawEvent = false;
    const seenCalls = {};

    const handle = (raw) => {
      const line = String(raw || "").trim();
      if (!line) return;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        return;
      }
      sawEvent = true;
      if (d.error) {
        error = String(d.error);
        return;
      }
      const msg = d.message || {};
      if (msg.content && h.onText) h.onText(msg.content);
      const thinkText = msg.thinking ?? msg.reasoning ?? msg.thought;
      if (thinkText && h.onReasoning) h.onReasoning(thinkText);
      (msg.tool_calls || []).forEach((c) => {
        const fn = c.function || {};
        const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {});
        const key = `${fn.name}|${args}`;
        // Ollama 会把同一批 tool_calls 重复推送，按内容去重，否则工具跑两遍
        if (seenCalls[key]) return;
        const idx = Object.keys(seenCalls).length;
        seenCalls[key] = true;
        if (h.onToolDelta) h.onToolDelta([{ index: idx, id: c.id, name: fn.name || "tool", args }]);
      });
      if (d.done) {
        finish = d.done_reason === "length" ? "length" : "stop";
        const prompt = Number(d.prompt_eval_count) || 0;
        const completion = Number(d.eval_count) || 0;
        if (h.onUsage && (prompt || completion)) {
          h.onUsage({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion });
        }
      }
    };

    return {
      feed(text) {
        buffer += text;
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          handle(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
      },
      flush() {
        if (buffer) {
          handle(buffer);
          buffer = "";
        }
      },
      get finish() {
        return finish;
      },
      get sawEvent() {
        return sawEvent;
      },
      get error() {
        return error;
      },
    };
  },

  parseWhole(raw) {
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!d || d.error) return null;
    const msg = d.message || {};
    const toolCalls = (msg.tool_calls || []).map((c, i) => {
      const fn = c.function || {};
      return {
        id: c.id || `call_o_${i}`,
        name: fn.name || "tool",
        args: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
      };
    });
    if (!msg.content && !msg.thinking && !toolCalls.length) return null;
    const prompt = Number(d.prompt_eval_count) || 0;
    const completion = Number(d.eval_count) || 0;
    return {
      text: msg.content || "",
      reasoning: msg.thinking || "",
      toolCalls,
      finish: d.done_reason === "length" ? "length" : "stop",
      usage: prompt || completion ? { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } : null,
    };
  },

  async listModels({ baseUrl, apiKey, request }) {
    const root = ollamaRoot(baseUrl);
    if (!root) throw new Error("先填 Base URL");
    const headers = {};
    if (apiKey && apiKey !== "ollama-local") headers.Authorization = `Bearer ${apiKey}`;
    const out = await request({
      url: `${root}/api/tags`,
      method: "GET",
      headers,
      timeoutSec: 20,
    });
    if (out.status < 200 || out.status >= 300) throw httpError(out.status, out.text);
    let data;
    try {
      data = JSON.parse(out.text);
    } catch {
      data = {};
    }
    const items = (data.models || [])
      .map((m) => (m && (m.name || m.model)) || "")
      .filter(Boolean)
      .map((id) => ({ id: String(id) }));
    return { items, endpoint: safeUrl(`${root}/api/tags`) };
  },
};

/* ============================================================
   注册表
   ============================================================ */

export const FORMATS = {
  openai,
  anthropic,
  gemini,
  ollama,
};

export function formatOf(id) {
  return FORMATS[normalizeFormat(id)] || FORMATS.openai;
}
