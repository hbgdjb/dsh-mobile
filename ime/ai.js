/* ============================================================
   AI 改写 —— 键盘里唯一会往外发请求的地方

   ============ 边界 ============
   
   输入法能看到用户输入的一切，所以这里的规矩是硬的：

     · 只在用户**显式点了某个动作**之后才发请求
     · 发的内容就是输入框里的文本，不夹带上下文、不夹带历史
     · 结果先预览，用户点"替换"才写回输入框
     · 请求可以取消，且取消要真的断掉连接

   ============ 为什么提示词是固定的 ============
   
   五类任务各有一段固定 system prompt。固定意味着前缀稳定，
   DeepSeek 的原生前缀缓存能命中，改写的首字会快不少。
   ============================================================ */

import { nativeStream, nativeHttpAvailable } from "../scripts/native-http.js";
import { withRetry } from "../scripts/retry.js";

/** 五类改写。instruction 是给模型的任务描述，越短越稳。 */
export const TASKS = {
  polish: {
    label: "润色",
    instruction: "润色下面这段文字：让它更通顺、更自然，保持原意与语气，不要添加新信息。只输出改写后的文字。",
  },
  fix: {
    label: "纠错",
    instruction: "找出下面这段文字里的错别字、语病和标点错误并改正。只输出改正后的文字，不要解释改了什么。",
  },
  shorten: {
    label: "缩写",
    instruction: "把下面这段文字压缩到原来的一半左右，保留关键信息，去掉重复和修饰。只输出结果。",
  },
  expand: {
    label: "扩写",
    instruction: "把下面这段文字展开写清楚，补充必要的细节和过渡，但不要编造事实。只输出结果。",
  },
  translate: {
    label: "翻译",
    instruction:
      "如果下面这段文字是中文，翻译成地道的英文；如果是英文，翻译成自然的中文。只输出译文，不要解释。",
  },
};

/** 所有任务共用的角色设定。放在最前面，保持稳定以利于缓存。 */
const SYSTEM_BASE = "你是一个中文写作助手，输出必须干净：不要加引号、不要加「改写后：」这类前缀、不要解释。";

/**
 * 拼请求地址。
 *
 * 用户填的 baseUrl 可能是 `https://api.x.com/v1`，也可能直接
 * 填了完整端点 —— 两种都要能用，否则"测试连接成功但改写失败"。
 */
function endpointFor(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return "";
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/chat/completions`;
}

/** 默认的传输：走原生 HTTP（绕开 WebView 的 CORS），没有就退 fetch。 */
async function defaultRequest({ url, headers, body, signal, timeoutSec = 30 }) {
  if (nativeHttpAvailable()) {
    return await new Promise((resolve, reject) => {
      let raw = "";
      const started = nativeStream({
        url,
        headers,
        body,
        signal,
        timeoutSec,
        onStatus: (s) => {
          if (s >= 400) {
            // 让错误带上状态码，重试层才知道该不该再试
            const err = new Error(`HTTP ${s}`);
            err.httpStatus = s;
          }
        },
        onChunk: (t) => {
          if (raw.length < 2000000) raw += t;
        },
        onEnd: () => resolve(raw),
        onError: (err) => reject(err),
      });
      if (!started) {
        reject(Object.assign(new Error("原生网络不可用"), { httpStatus: 0 }));
      }
    });
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.httpStatus = res.status;
    e.body = text;
    throw e;
  }
  return text;
}

/**
 * 从返回里抽正文。
 *
 * 端点可能给 SSE，也可能忽略 stream:true 直接回整包 JSON ——
 * 两种都得认，否则会出现"改写成功但面板空白"。
 */
function extractText(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s);
      return String(o?.choices?.[0]?.message?.content || "").trim();
    } catch {
      /* 落到按行解析 */
    }
  }

  let out = "";
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const o = JSON.parse(payload);
      const delta = o?.choices?.[0]?.delta?.content;
      if (delta) out += delta;
      const msg = o?.choices?.[0]?.message?.content;
      if (msg) out += msg;
    } catch {
      /* 半截 JSON 忽略 */
    }
  }
  return out.trim();
}

/**
 * 执行一次改写。
 *
 * @param {string} task    TASKS 里的键
 * @param {string} text    要改写的原文
 * @param {object} opts
 *   opts.config   { baseUrl, apiKey, apiModel, temperature }
 *   opts.signal   AbortSignal
 *   opts.request  自定义传输（测试注入）
 * @returns {Promise<string>} 改写结果
 */
export async function rewrite(task, text, opts = {}) {
  const def = TASKS[task];
  if (!def) throw new Error(`未知的改写任务：${task}`);

  const source = String(text || "").trim();
  if (!source) throw new Error("没有可改写的文字");

  const cfg = opts.config || {};
  const baseUrl = String(cfg.baseUrl || "");
  const apiKey = String(cfg.apiKey || "");
  const model = String(cfg.apiModel || "");

  if (!baseUrl || !apiKey || !model) {
    throw new Error("还没有配置模型：到 DSH → 设置 → 当前模型里选一个");
  }

  const request = opts.request || defaultRequest;
  const url = endpointFor(baseUrl);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const body = {
    model,
    stream: true,
    temperature: Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 0.3,
    messages: [
      { role: "system", content: SYSTEM_BASE },
      { role: "system", content: def.instruction },
      { role: "user", content: source },
    ],
  };

  const raw = await withRetry(
    async () => await request({ url, headers, body, signal: opts.signal, timeoutSec: 30 }),
    { signal: opts.signal, attempts: 3 }
  );

  const out = extractText(raw);
  if (!out) throw new Error("模型没有返回内容");
  return out;
}
