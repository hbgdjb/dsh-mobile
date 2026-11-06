/* ============================================================
   工具参数解析 —— 模型给的 arguments 并不总是合法 JSON

   ============ 截图里的那条错误 ============

     shell 参数解析失败
     工具参数不是合法 JSON：Unexpected non-whitespace character
     after JSON at position 83 (line 1 column 84)

   `after JSON` 的意思是：JSON.parse 在位置 83 就已经读到一个**完整对象**，
   后面还有非空白字符。最常见三种来源：

     1. 模型把同一个对象输出了两遍（流式拼接时尤其常见）
     2. 对象后面跟了一句解释（"以上是参数"）
     3. 对象被 ```json 围栏包着

   这三种都不该让整次调用失败 —— 内容其实都在，只是多了点外壳。

   另一类是字符串里带了**裸换行**：模型想传多行 shell 命令，
   直接把换行敲进 JSON 字符串（JSON 规范不允许），报的是
   `Bad control character in string literal`。把它转义成 \n 即可。

   ============ 原则 ============

   只做**无损修复**：改完的文本必须仍然表达模型的原始意图。
   猜不出来的（少括号、引号不配对）不硬修 —— 那种情况宁可让它重发，
   也不要拿一个被猜歪的参数去执行写文件、删文件。
   ============================================================ */

/** 从第一个 { 或 [ 开始，取一段括号平衡的文本（跳过字符串内部）。 */
function firstBalanced(text) {
  const src = String(text || "");
  const start = src.search(/[{[]/);
  if (start < 0) return "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return "";
}

/**
 * 把字符串字面量里的裸控制字符转成转义序列。
 * 只动字符串内部：结构里的空白本来就合法。
 */
function escapeControls(text) {
  const src = String(text || "");
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        out += ch;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

/** 去掉对象/数组末尾多余的逗号：{"a":1,} */
function dropTrailingComma(text) {
  return String(text || "").replace(/,\s*([}\]])/g, "$1");
}

/**
 * 解析工具参数。
 *
 * @returns {{ok:true, value:object, repaired?:string, extra?:boolean}
 *          |{ok:false, error:string, text:string}}
 */
export function parseToolArgs(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, value: {} };

  const tryParse = (s) => {
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch (err) {
      return { ok: false, error: err };
    }
  };

  let r = tryParse(text);
  if (r.ok) return r;

  // 1) ```json … ``` 围栏
  const fenced = text
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  if (fenced !== text) {
    r = tryParse(fenced);
    if (r.ok) return { ...r, repaired: "去掉代码围栏" };
  }

  // 2) 只取第一个完整对象（"after JSON" 的正解）
  const block = firstBalanced(fenced);
  if (block && block !== fenced) {
    r = tryParse(block);
    if (r.ok) {
      return { ...r, repaired: "截取第一个完整对象", extra: fenced.length > block.length };
    }
  }

  // 3) 字符串里的裸换行 / 制表符
  const base = block || fenced;
  const escaped = escapeControls(base);
  if (escaped !== base) {
    r = tryParse(escaped);
    if (r.ok) return { ...r, repaired: "转义字符串里的换行" };
  }

  // 4) 尾逗号
  const tidy = dropTrailingComma(escaped);
  if (tidy !== escaped) {
    r = tryParse(tidy);
    if (r.ok) return { ...r, repaired: "去掉多余的逗号" };
  }

  const err = r.error || new Error("无法解析");
  return { ok: false, error: err.message, text };
}

/**
 * 给模型看的失败说明。
 *
 * 只说「不是合法 JSON」没有用 —— 模型不知道错在哪、下一步怎么改，
 * 下一轮往往原样再发一次。这里把原文开头也给它，便于自查。
 */
export function argsErrorText(message, raw) {
  const head = String(raw || "").trim().slice(0, 160).replace(/\s+/g, " ");
  return [
    `工具参数不是合法 JSON：${message}`,
    "已尝试去掉代码围栏、截取第一个完整对象、转义换行，仍无法解析。",
    '请重新调用：arguments 必须是**单个 JSON 对象**；字符串里的换行写成 \\n，双引号写成 \\"。',
    head ? `收到的原文开头：${head}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
