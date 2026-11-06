/* ============================================================
   API Key 归一化与诊断

   「同一把 Key 在电脑上有效、在手机上提示 Key 无效」最常见的成因
   不在网络，而在**粘贴进来的那串字符**：

     · 从聊天软件 / 备忘录复制，首尾带空格、中间带换行
     · 从客户端配置里连 `Bearer ` 或整行 `Authorization: Bearer xxx` 一起复制
     · 带中文引号、全角空格、零宽字符（Word / 微信常见）
     · 输入法把 `-` 换成全角、或补了一个不可见字符

   桌面客户端通常会替用户 trim 或容错，APK 里直接拼进
   `Authorization: Bearer ${key}`，于是变成
   `Bearer Bearer sk-…`、`Bearer sk-…\n` —— 服务端一律回 401，
   界面再把它仓促标成「Key 无效」。

   还有一种不在字符里、而在地址里：Agnes 有国内站（.cn）与国际站（.com）
   两套互不通用的 Key，同一把 Key 打错站，报错与「Key 无效」完全一致。
   自查清单里把「Key 与站点同源」放在第一条 —— 它比清洗字符更能解决问题。

   这里做两件事：
     1. 在请求发出前把 Key 洗成服务端能认的形态（兼容旧存档里的脏值）
     2. 给出脱敏诊断，让用户能判断「到底填的是不是同一把 Key」
   ============================================================ */

/** 全角空格 / NBSP / 零宽字符 / BOM —— trim() 不认这些。 */
const INVISIBLE = /[\u00a0\u1680\u2000-\u200d\u202f\u205f\u3000\ufeff]/g;

/** 中英文成对引号。只剥最外一层，不碰 Key 内部的字符。 */
function stripWrapper(s) {
  const t = s.trim();
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["`", "`"],
  ];
  for (const [a, b] of pairs) {
    if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) return t.slice(1, -1);
  }
  return s;
}

/**
 * 把用户填的 Key 洗成可直接放进 Authorization 头的形态。
 * @returns {{key:string, changed:boolean, notes:string[]}}
 */
export function normalizeApiKey(raw) {
  const original = String(raw ?? "");
  let key = original;
  const notes = [];

  const visible = key.replace(INVISIBLE, " ");
  if (visible !== key) {
    key = visible;
    notes.push("去掉了不可见空格");
  }

  const unwrapped = stripWrapper(key);
  if (unwrapped !== key) {
    key = unwrapped;
    notes.push("去掉了包裹的引号");
  }

  // 整行 `Authorization: Bearer xxx` 或光一个 `Bearer xxx`
  const bearer = /^\s*(?:authorization\s*:\s*)?bearer\s+/i;
  if (bearer.test(key)) {
    key = key.replace(bearer, "");
    notes.push("去掉了多余的 Bearer 前缀");
  }

  const compact = key.replace(/\s+/g, "");
  if (compact !== key) {
    key = compact;
    notes.push("去掉了空格或换行");
  }

  return { key: key.trim(), changed: key !== original, notes };
}

/** 脱敏后的 Key 形态，用于错误提示，绝不回显原文。 */
export function keyShape(key) {
  const k = String(key || "");
  return {
    length: k.length,
    prefix: k.slice(0, 3),
    masked:
      k.length <= 8
        ? k.slice(0, 2) + "…"
        : `${k.slice(0, 3)}…${k.slice(-4)}（${k.length} 位）`,
    empty: !k,
    hasWhitespace: /\s/.test(k),
    nonAscii: /[^\x20-\x7e]/.test(k),
    looksPrefixed: /^(?:authorization\s*:|bearer\s+)/i.test(k),
  };
}

/**
 * 服务商专属的 401 自查清单。
 *
 * 通用提示「请重新填写 Key」几乎没用 —— 用户刚填完、而且电脑上验证过。
 * 这里把「哪几种情况会让一把有效 Key 在移动端被拒」说清楚。
 */
export function authChecklist(providerKey, detail = "") {
  const common = [
    "确认复制的是完整 Key，没有带 `Bearer ` 前缀、空格或换行（本版会自动清理，旧存档也会）",
    "确认填在了当前模型所属服务的槽位里；切过供应方的话，Key 是分槽保存的",
  ];
  const d = String(detail || "").toLowerCase();
  if (/token not provided|missing|未提供|no.*token/i.test(d)) {
    common.unshift("服务端说「没有收到 Token」：请求头里根本没有 Key，检查槽位是否填对");
  }
  if (providerKey === "agnes") {
    return [
      "Key 必须与站点一致：国内站（platform.agnes-ai.cn）的 Key 配 https://apihub.agnes-ai.cn/v1，国际站（platform.agnes-ai.com）的 Key 配 https://apihub.agnes-ai.com/v1。两站 Key 不通用，配错只会回 401「Invalid token」，看起来和「Key 是假的」一模一样",
      "地址只写到 `/v1`，不要填成完整的 `/chat/completions`；国内站是 `.cn`，不是 `.com`",
      "端点请选「标准 · OpenAI 兼容」；选了「Anthropic 兼容」会走 `/v1/messages`，鉴权与请求体都不同",
      "Key 从对应站点的 API Key 页复制；别把整行 `AGNES_API_KEY=…` 或「密钥名称」一起粘进来",
      "确认该账号已开通所选模型且有余额：权限或额度问题同样会返回 401 / 403",
      ...common,
    ];
  }
  return [
    "确认 Base URL 与电脑端用的是同一个地址（有些平台网页版和 API 网关不是同一个域名）",
    ...common,
  ];
}
