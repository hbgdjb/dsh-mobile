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

/* ============================================================
   零 token 压缩（0-token compaction）

   为什么要在裁剪回合之前先做这一层：
   Agent 循环里真正吃 token 的**不是对话**，而是**工具输出** ——
   读一个 300 KB 的文件、grep 出 500 行、跑一次构建日志，
   一次就能顶掉几千 token 的对话历史。

   这一层做的事全是**结构性替换**，不调用模型、不花 token：
   - 重复的工具输出 → 指向第一次出现的指针
   - 旧的工具输出 → 占位文案（保留「调了什么」，否则模型会重跑同一命令）
   - 超大的工具输出 → 头尾截断
   - 超大的 tool_call 参数 → 截断
   - 旧图片 → 文本占位（一张图约 1100 token，比很多段对话都贵）

   参考：GitHub mashanglinyu/luanyujia-workbench
   09-改造参考/Hermes/02-主线/03-context-compaction.md
   —— 那边把它叫 proactive_prune / micro_summarize，同为零 token 层。

   ⚠️ 一个必须记住的坑：占位文案**不能删成空**。
   删空等于告诉模型「这个工具没输出过」，模型会重跑同一条命令。
   所以占位必须写明：调的是什么、清了多少、怎么拿回来。
   ============================================================ */

/** 工具名索引：tool_call_id → 工具名。用来给占位文案写清「调了什么」。 */
function toolNameIndex(messages) {
  const map = new Map();
  for (const m of messages) {
    if (!m?.tool_calls) continue;
    for (const c of m.tool_calls) {
      if (c?.id) map.set(c.id, c.function?.name || c.name || "工具");
    }
  }
  return map;
}

/** 内容指纹：用来判断两次工具输出是否字节相同。 */
function fingerprint(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c + i, 2246822519) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

/** 工具输出的占位文案 —— 必须写清「调了什么 / 清了多少 / 怎么拿回来」。 */
function clearedPlaceholder(name, chars) {
  return `[已清理的旧工具输出 · ${name} · 约 ${chars} 字符 · 如需详情请重新调用该工具]`;
}

/** 超长内容的头尾截断：中间通常是日志，模型真正要看的是头尾。 */
function headTail(text, limit) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n…（中间 ${cut} 字符已省略）…\n${text.slice(text.length - tail)}`;
}

/** 把多模态内容里的旧图片换成文本占位。 */
function evictImages(content, budget) {
  if (!Array.isArray(content)) return content;
  const out = [];
  let kept = 0;
  // 从后往前数：保留最近的若干张
  const imageIdx = [];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i]?.type === "image_url") imageIdx.push(i);
  }
  const keepFrom = Math.max(0, imageIdx.length - budget.keepImages);
  for (let i = 0; i < content.length; i += 1) {
    const part = content[i];
    if (part?.type === "image_url") {
      const order = imageIdx.indexOf(i);
      if (order < keepFrom) {
        out.push({ type: "text", text: "[旧图片已移除以节省上下文]" });
        continue;
      }
      kept += 1;
    }
    out.push(part);
  }
  void kept;
  return out;
}

/**
 * 零 token 压缩。
 *
 * @param {Array} messages OpenAI 格式消息
 * @param {Object} [options]
 * @param {number} [options.keepRecentTurns=2] 最近几轮的工具输出保持完整
 * @param {number} [options.maxToolChars=4000] 单条工具输出的字符上限
 * @param {number} [options.keepImages=3] 保留最近几张图片
 * @param {number} [options.maxArgsChars=2000] 单个 tool_call 参数的字符上限
 * @returns {{ messages: Array, compacted: number, reclaimed: number }}
 */
export function compactMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const opts = {
    keepRecentTurns: 2,
    maxToolChars: 4000,
    keepImages: 3,
    maxArgsChars: 2000,
    ...(options || {}),
  };
  if (!list.length) return { messages: list, compacted: 0, reclaimed: 0 };

  const names = toolNameIndex(list);
  const system = list.filter((m) => m.role === "system");
  const rest = list.filter((m) => m.role !== "system");
  const turns = groupTurns(rest);
  const recentFrom = Math.max(0, turns.length - opts.keepRecentTurns);
  const seen = new Map(); // 指纹 → 第一次出现的位置描述
  let compacted = 0;
  let reclaimed = 0;

  const outTurns = turns.map((turn, turnIdx) =>
    turn.map((m) => {
      if (m.role === "tool") {
        const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        const name = names.get(m.tool_call_id) || "工具";
        const isRecent = turnIdx >= recentFrom;
        // 已经是占位/指针的内容不再处理（压缩会被每一步重复调用，必须幂等）
        if (raw.includes("[已清理的旧工具输出") || raw.includes("[与之前相同的")) return m;

        // ① 重复输出 → 指针（无论新旧，重复的都省）
        const fp = fingerprint(raw);
        if (seen.has(fp)) {
          compacted += 1;
          reclaimed += estimateTokens(raw);
          return {
            ...m,
            content: `[与之前相同的${name}输出 · 约 ${raw.length} 字符 · 已省略，完整内容见上方第一次出现处]`,
          };
        }
        seen.set(fp, true);

        // ② 旧输出 → 占位
        if (!isRecent) {
          compacted += 1;
          reclaimed += estimateTokens(raw);
          return { ...m, content: clearedPlaceholder(name, raw.length) };
        }

        // ③ 近期但超大 → 头尾截断
        if (raw.length > opts.maxToolChars) {
          compacted += 1;
          reclaimed += estimateTokens(raw) - estimateTokens(headTail(raw, opts.maxToolChars));
          return { ...m, content: headTail(raw, opts.maxToolChars) };
        }
        return m;
      }

      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        let changed = false;
        const calls = m.tool_calls.map((c) => {
          const raw = JSON.stringify(c.function?.arguments ?? "");
          if (raw.length <= opts.maxArgsChars) return c;
          changed = true;
          reclaimed += estimateTokens(raw) - estimateTokens(raw.slice(0, opts.maxArgsChars));
          return {
            ...c,
            function: {
              ...c.function,
              arguments: JSON.stringify({
                __truncated: true,
                note: "参数过长已截断，完整参数见工具调用记录",
                preview: raw.slice(0, opts.maxArgsChars),
              }),
            },
          };
        });
        if (!changed) return m;
        compacted += 1;
        return { ...m, tool_calls: calls };
      }

      if (m.role === "user" && Array.isArray(m.content)) {
        const next = evictImages(m.content, opts);
        if (next !== m.content) {
          compacted += 1;
          reclaimed += 1100 * Math.max(0, m.content.filter((p) => p?.type === "image_url").length - opts.keepImages);
          return { ...m, content: next };
        }
        return m;
      }

      return m;
    })
  );

  return {
    messages: [...system, ...outTurns.flat()],
    compacted,
    reclaimed,
  };
}

/* ============================================================
   裁剪策略：双阈值 + 锚点保护（0.31.0）

   旧版是一次性「裁到底」：只要超预算就把最早的轮次一路砍掉。
   问题有三个：
   ① 没有分级 —— 用量 55% 就开始砍，而 55% 其实还很安全；
   ② 没有目标 —— 砍完刚好卡在预算线上，下一步又触发，又砍一轮；
   ③ 没有锚点 —— 最初的「任务锚点」（用户第一条真正的需求）
      和最近的「意图锚点」（最后一条真实用户消息）可能被一起砍掉，
      模型就不知道自己该干什么了。

   现在的策略（参考 Hermes 的 compaction 设计）：
   - 双阈值：prefill 超过 prepare（50%）开始预警；
                超过 trigger（70%）才真正动手。小窗口模型（<512K）放宽到 75%。
   - 目标比例：砍完压到 budget × targetRatio（默认 0.20），
                留出余量，避免「砍完刚好贴线 → 下一步又砍」。
   - 锚点保护：最早的 protectFirstN 轮（默认 3）+ 最近的 protectLastN 轮（默认 20）
                永不删除；尾部至少保留 minTailUserMessages 条真实用户消息。
   - 保护区放不下时，从「中间区」由旧到新丢弃整轮（整轮丢，不会出现
                孤立的 tool 结果，OpenAI 兼容接口不会因此报错）。
   ============================================================ */

/** 裁剪策略的默认参数。 */
export const TRIM_DEFAULTS = {
  reserve: 0.28,
  prepare: 0.5,
  trigger: 0.7,
  targetRatio: 0.2,
  protectFirstN: 3,
  protectLastN: 20,
  minTailUserMessages: 1,
};

/**
 * 按预算裁剪较早的回合（v2：双阈值 + 锚点保护）。
 * @param {Array} messages OpenAI 格式消息
 * @param {number} windowTokens 模型上下文窗口（token）
 * @param {Object} [options] 见 TRIM_DEFAULTS
 * @returns {{ messages: Array, removed: number, budget: number, used: number,
 *             level: string, prepared: boolean, overflow: boolean }}
 */
export function trimMessages(messages, windowTokens, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const window = Math.max(2048, Number(windowTokens) || 128000);
  const o = { ...TRIM_DEFAULTS, ...(options || {}) };

  // 小窗口模型留的余量本来就少，晚一点再动手
  const small = window < 512000;
  const prepare = small ? Math.max(o.prepare, 0.6) : o.prepare;
  const trigger = small ? Math.max(o.trigger, 0.75) : o.trigger;

  const budget = Math.max(1536, Math.floor(window * (1 - o.reserve)));
  const system = list.filter((m) => m.role === "system");
  const rest = list.filter((m) => m.role !== "system");
  const turnTokens = (turn) => turn.reduce((sum, m) => sum + messageTokens(m), 0);

  const turns = groupTurns(rest);
  const base = { budget, removed: 0, level: "none", prepared: false, overflow: false };

  if (!turns.length) {
    return { messages: list, used: system.reduce((s, m) => s + messageTokens(m), 0), ...base };
  }

  const systemTokens = system.reduce((s, m) => s + messageTokens(m), 0);
  const total = systemTokens + turns.reduce((s, t) => s + turnTokens(t), 0);

  // ① 双阈值判断：只有超过 trigger 才真的裁
  const ratio = total / window;
  if (ratio <= trigger) {
    return {
      messages: list,
      used: total,
      ...base,
      level: ratio > prepare ? "prepare" : "none",
      prepared: ratio > prepare,
    };
  }

  const n = turns.length;
  const isUserTurn = (i) => turns[i].some((m) => m.role === "user");
  const userTurns = [];
  for (let i = 0; i < n; i += 1) if (isUserTurn(i)) userTurns.push(i);

  // ② 尾部：从最新一轮往回装。
  //    预算内就装；预算不够时，仍要保住「最近 protectLastN 轮」，
  //    但为防无节制超限，允许的额外占用封顶为窗口的 25%。
  const keep = new Set();
  let used = systemTokens;
  const overflowCap = Math.floor(window * 0.25);
  let tailCount = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    const t = turnTokens(turns[i]);
    const protectedHead = i < o.protectFirstN;
    const inProtectedTail = n - i <= o.protectLastN;
    if (used + t > budget && keep.size && !protectedHead) {
      if (!inProtectedTail) break;
      if (used + t > budget + overflowCap) break;
    }
    keep.add(i);
    used += t;
    tailCount += 1;
  }
  void tailCount;

  // ③ 头部保护：最早的 protectFirstN 轮永不删
  for (let i = 0; i < Math.min(o.protectFirstN, n); i += 1) keep.add(i);

  // ④ 尾部至少保留 minTailUserMessages 条真实用户消息
  const keptUserTurns = userTurns.filter((i) => keep.has(i));
  if (keptUserTurns.length < o.minTailUserMessages && userTurns.length) {
    for (const i of userTurns.slice().reverse()) {
      if (keep.has(i)) break;
      keep.add(i);
      used += turnTokens(turns[i]);
    }
  }

  // ⑤ 中间区由旧到新丢弃，直到落进目标比例
  const target = Math.max(1536, Math.floor(budget * o.targetRatio));
  const middle = [];
  for (let i = 0; i < n; i += 1) if (!keep.has(i)) middle.push(i);
  for (const i of middle) {
    if (used <= target) break;
    keep.delete(i);
    used -= turnTokens(turns[i]);
  }

  // ⑥ 受保护区仍超预算 → 溢出（保留内容，交给上游降级）
  if (used > budget) base.overflow = true;

  const keptIdx = [...keep].sort((a, b) => a - b);
  const removed = n - keptIdx.length;
  if (!removed) {
    return { messages: list, used: total, ...base, level: ratio > prepare ? "prepare" : "none", prepared: ratio > prepare };
  }

  const notice = {
    role: "system",
    content: `[上下文裁剪] 已省略较早的 ${removed} 轮对话，以适配当前约 ${fmtContext(window)} 的窗口。需要完整历史时，请调高上下文窗口或新开会话。`,
  };

  const keptMessages = keptIdx.flatMap((i) => turns[i]);
  return {
    messages: [...system, notice, ...keptMessages],
    removed,
    budget,
    used: used + messageTokens(notice),
    level: "trim",
    prepared: true,
    overflow: base.overflow,
  };
}
