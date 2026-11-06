/* ============================================================
   IME 主机侧 —— 主应用与 DSH 键盘之间的接线

   ============ 这个文件解决什么 ============

   键盘（IME）是独立的一个 Android 输入法，它跑在同一个进程里，
   但有自己的 WebView 和自己的 JS 上下文。它拿不到主应用的状态，
   主应用也拿不到键盘里的东西。这个文件就是那条接线。

   三件事：

     1. 拍配置快照给键盘（模型 endpoint / key / 模型名）
     2. 接住键盘截的图，作为对话附件
     3. 给设置页提供输入法状态（已启用 / 正在使用）

   ============ 为什么拍"快照"而不是共享状态 ============

   键盘页如果 import store.js，会加载第二份全量 state —— 包括会话历史。
   两份内存副本迟早写出脏数据（一边改了另一边不知道）。

   所以：主应用把**改写功能真正需要的四个字段**拍成一个小 JSON，
   存进原生 SharedPreferences，键盘启动时读它。
   解析逻辑只留在 store.js 一处。
   ============================================================ */

import {
  state,
  subscribe,
  currentModel,
  modelApiId,
  apiKeyFor,
  modelBaseUrl,
} from "./store.js";

const host = () => (typeof window !== "undefined" ? window.DshImeHost || null : null);

/** 键盘的 AI 改写是否允许自动发送。默认关 —— 发不发是用户的决定。 */
const AUTO_SEND_KEY = "imeAutoSend";
/* ---------------- 配置快照 ---------------- */

/**
 * 拍一份改写用的最小配置。
 *
 * 只给四个字段：端点、Key、模型名、温度。
 * 不给会话历史、不给工具列表、不给任何聊天内容 ——
 * 键盘是全局的，它不该看见用户在其他会话里说过的话。
 */
export function imeConfigSnapshot() {
  const m = currentModel();
  if (!m) return {};
  const baseUrl = modelBaseUrl(m);
  const apiKey = apiKeyFor(m);
  const apiModel = modelApiId(m);
  const temp = m.temperature ?? m.defaults?.temperature ?? null;
  return {
    baseUrl: String(baseUrl || ""),
    apiKey: String(apiKey || ""),
    apiModel: String(apiModel || ""),
    temperature: temp === null || temp === undefined ? 0.3 : Number(temp),
    updatedAt: Date.now(),
  };
}

/**
 * 把快照推给原生（进而给键盘）。
 *
 * 模型切换、Key 改动之后都要再推一次 —— 否则键盘还在用旧配置改写。
 */
export function pushImeConfig() {
  const h = host();
  if (!h || typeof h.setConfig !== "function") return;
  try {
    h.setConfig(JSON.stringify(imeConfigSnapshot()));
  } catch (err) {
    console.warn("[ime] 推送配置快照失败：", err?.message || err);
  }
}

/* ---------------- 截图投递 ---------------- */

/**
 * 键盘截的图到了。
 *
 * 默认只加为附件 —— 不自动发消息。
 * 用户在别的应用里截了图，回 DSH 看到它躺在附件区，自己决定要不要发。
 * 这比"截完就自动发一条消息"安静得多。
 */
export function receiveImeShot(record) {
  if (!record || !record.path) return false;

  const item = {
    path: String(record.path),
    name: String(record.name || record.path.split("/").pop() || "screenshot.png"),
    size: Number(record.size) || 0,
    area: "workspace",
  };

  const added = addImeAttachment(item);
  if (!added) return false;

  if (state.settings?.[AUTO_SEND_KEY]) {
    // 用户明确选了"截完直接分析"
    window.setTimeout(() => {
      try {
        window.__dshSendImeShot?.();
      } catch {
        /* 页面还没准备好就算了 */
      }
    }, 60);
  }
  return true;
}

/**
 * 加附件。
 *
 * ui.js 的 addAttachment 是内部函数（没导出），所以这里通过
 * 页面级钩子走；钩子由 ui.js 在 initUI 时挂上。
 */
function addImeAttachment(item) {
  const fn = window.__dshAddAttachment;
  if (typeof fn !== "function") {
    console.warn("[ime] 附件钩子还没挂上，截图收不到");
    return false;
  }
  try {
    return !!fn(item);
  } catch {
    return false;
  }
}

/* ---------------- 状态 ---------------- */

/** 输入法状态：{ supported, enabled, current, serviceId } */
export function imeStatus() {
  const h = host();
  if (!h || typeof h.status !== "function") {
    return { supported: false, enabled: false, current: false, serviceId: "" };
  }
  try {
    const o = JSON.parse(h.status() || "{}");
    return {
      supported: true,
      enabled: !!o.enabled,
      current: !!o.current,
      serviceId: String(o.serviceId || ""),
    };
  } catch {
    return { supported: true, enabled: false, current: false, serviceId: "" };
  }
}

export function openImeSettings() {
  host()?.openImeSettings?.();
}

export function switchIme() {
  host()?.switchIme?.();
}

/* ---------------- 短语管理（设置页用） ---------------- */

export function listPhrases() {
  const h = host();
  try {
    return JSON.parse(h?.listPhrases?.() || "[]");
  } catch {
    return [];
  }
}

export function savePhrase(item) {
  host()?.savePhrase?.(JSON.stringify(item));
}

export function deletePhrase(id) {
  host()?.deletePhrase?.(String(id || ""));
}

export function listClipboard() {
  const h = host();
  try {
    return JSON.parse(h?.listClipboard?.() || "[]");
  } catch {
    return [];
  }
}

export function clearClipboard() {
  host()?.clearClipboard?.();
}

/* ---------------- 安装 ---------------- */

/**
 * 装上主机侧接线。
 *
 * 做三件事：
 *   1. 注册 __dshImeShot —— 原生推截图时调它
 *   2. 推一次配置快照
 *   3. 告诉原生"页面 ready"，把积压的截图补投出来
 */
export function installImeHost() {
  if (typeof window === "undefined") return;

  window.__dshImeShot = (json) => {
    let rec = null;
    try {
      rec = typeof json === "string" ? JSON.parse(json) : json;
    } catch {
      return;
    }
    receiveImeShot(rec);
  };

  pushImeConfig();

  const h = host();
  if (h && typeof h.ready === "function") {
    try {
      h.ready();
    } catch {
      /* 忽略 */
    }
  }

  // 模型、Key 或端点变了就重推快照 ——
  // 否则键盘还在用旧配置改写，用户会看到"改了设置没用"。
  subscribe((detail) => {
    const t = detail?.type || "";
    if (t === "settings" || t === "models" || t === "model") {
      pushImeConfig();
    }
  });
}
