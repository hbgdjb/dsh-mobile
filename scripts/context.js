/* ============================================================
   Context — 上下文窗口估算与裁剪
   独立模块，无 DOM 依赖，可直接在 Node 里断言。
   ============================================================ */

/** 中日韩字符：按字计；其余按约 3.6 字符 / token 计。 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.05 + other / 3.6) + 1;
}

/** 一条消息的内容 token 数；多模态数组里图片按固定额度估算，不把 base64 当文本数。 */
export function contentTokens(content) {
  if (typeof content === "string") return estimateTokens(content);
  if (!Array.isArray(content)) return estimateTokens(content ?? "");
  let n = 0;
  for (const part of content) {
    if (!part) continue;
    if (part.type === "text") n += estimateTokens(part.text || "");
    else if (part.type === "image_url") n += 1100;
    else n += estimateTokens(part);
  }
  return n;
}

export function messageTokens(message) {
  let n = 4;
  n += contentTokens(message.content ?? "");
  if (message.tool_calls) n += estimateTokens(message.tool_calls);
  return n;
}

/** 128000 → 128K；1000000 → 1M。 */
export function fmtContext(n) {
  const value = Number(n) || 0;
  if (value >= 1000000) {
    const m = value / 1000000;
    return `${Number(m.toFixed(1))}M`;
  }
  return `${Math.round(value / 1000)}K`;
}

/**
 * 把消息按「用户回合」分组：每条 user 开启新回合，assistant / tool 跟随其后。
 * 这样裁剪时不会留下没有对应 assistant.tool_calls 的孤立 tool 结果。
 */
function groupTurns(messages) {
  const turns = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) {
      turns.push([message]);
    } else {
      turns[turns.length - 1].push(message);
    }
  }
  return turns;
}

/**
 * 按预算裁剪较早的回合。
 * @param {Array} messages OpenAI 格式消息
 * @param {number} windowTokens 模型上下文窗口（token）
 * @param {{ reserve?: number }} [options] reserve = 给输出预留的比例，默认 0.28
 * @returns {{ messages: Array, removed: number, budget: number, used: number }}
 */
export function trimMessages(messages, windowTokens, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const window = Math.max(2048, Number(windowTokens) || 128000);
  const reserve = typeof options.reserve === "number" ? options.reserve : 0.28;
  const budget = Math.max(1536, Math.floor(window * (1 - reserve)));

  const system = list.filter((m) => m.role === "system");
  const rest = list.filter((m) => m.role !== "system");
  if (!rest.length) {
    return { messages: list, removed: 0, budget, used: 0 };
  }

  const turns = groupTurns(rest);
  let used = system.reduce((sum, m) => sum + messageTokens(m), 0);
  const kept = [];
  let cut = 0;

  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turnTokens = turns[i].reduce((sum, m) => sum + messageTokens(m), 0);
    // 至少保留最后一轮，哪怕它自己就超预算
    if (kept.length && used + turnTokens > budget) {
      cut = i + 1;
      break;
    }
    used += turnTokens;
    kept.unshift(...turns[i]);
  }

  if (!cut) {
    return { messages: list, removed: 0, budget, used };
  }

  const notice = {
    role: "system",
    content: `[上下文裁剪] 已省略较早的 ${cut} 轮对话，以适配当前约 ${fmtContext(window)} 的窗口。需要完整历史时，请调高上下文窗口或新开会话。`,
  };

  return {
    messages: [...system, notice, ...kept],
    removed: cut,
    budget,
    used: used + messageTokens(notice),
  };
}
