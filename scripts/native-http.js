/* ============================================================
   Native HTTP bridge (Android)
   WebView 直连模型接口会遇到跨域、Cookie 策略与流式读取限制。
   APK 内由 DshHttpBridge.java 提供原生 POST 流，这里做 JS 适配：
     - 与 fetch 相同的调用形态（headers / body / abort）
     - 逐块回传 SSE 文本，交给 runtime 的解析器
     - 没有原生桥时（浏览器 / PWA）自动回退到 fetch
   ============================================================ */

const bridge = () => (typeof window !== "undefined" ? window.DshNative : null);

export function nativeHttpAvailable() {
  const b = bridge();
  return !!b && typeof b.postStream === "function";
}

let seq = 0;
const pending = new Map();

function emitToPending(raw) {
  let evt;
  try {
    evt = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return;
  }
  const item = pending.get(evt?.id);
  if (!item) return;
  if (evt.type === "status") {
    item.onStatus?.(Number(evt.status) || 0);
  } else if (evt.type === "chunk") {
    item.onChunk?.(String(evt.data ?? ""));
  } else if (evt.type === "end") {
    item.finish();
  } else if (evt.type === "error") {
    const err = new Error(
      evt.message || (evt.status ? `HTTP ${evt.status}` : "原生网络请求失败")
    );
    err.httpStatus = Number(evt.status) || 0;
    err.body = String(evt.body || "");
    err.native = true;
    item.fail(err, evt);
  }
}

if (typeof window !== "undefined") {
  window.__dshNativeEvent = emitToPending;
  window.__dshNativeReady = nativeHttpAvailable();
}

/**
 * 发起原生流式 POST。
 * @returns {boolean} 是否已交由原生桥处理（false 表示应回退 fetch）
 */
export function nativeStream({  url,
  headers,
  body,
  method = "POST",
  signal,
  timeoutSec = 120,
  onStatus,
  onChunk,
  onEnd,
  onError,
}) {
  if (!nativeHttpAvailable()) return false;
  const id = `n${Date.now().toString(36)}_${seq++}`;
  let done = false;

  const cleanup = () => {
    pending.delete(id);
    signal?.removeEventListener("abort", onAbort);
  };
  const finish = () => {
    if (done) return;
    done = true;
    cleanup();
    onEnd?.();
  };
  const fail = (err, meta) => {
    if (done) return;
    done = true;
    cleanup();
    onError?.(err, meta);
  };
  const onAbort = () => {
    try {
      bridge()?.abort?.(id);
    } catch {
      /* 原生侧可能已结束 */
    }
    fail(new DOMException("Aborted", "AbortError"), { aborted: true });
  };

  pending.set(id, { onStatus, onChunk, finish, fail });

  if (signal?.aborted) {
    onAbort();
    return true;
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    bridge().postStream(
      id,
      url,
      JSON.stringify(headers || {}),
      JSON.stringify(body || {}),
      Math.max(15, Math.min(600, Number(timeoutSec) || 120)),
      method || "POST"
    );
  } catch (err) {
    fail(err);
  }
  return true;
}

/**
 * 取一个纯文本资源（GET），返回完整字符串。
 *
 * 为什么需要它：WebView 里的 fetch 会被 CORS 挡住第三方域名
 * （预算是从 capacitor://localhost 发出的，第三方服务器不会放行）。
 * 而「从任意 URL 安装插件」必须能拉到清单与代码 —— 所以 APK 内走原生桥，
 * 原生侧用 HttpURLConnection，不受同源策略约束。
 *
 * 浏览器 / PWA 没有原生桥，回退到 fetch，此时只能装同源或允许跨域的地址。
 *
 * @returns {Promise<{ok:boolean, status:number, text:string, error?:string}>}
 */
export async function nativeGetText(url, { timeoutSec = 30, headers = {} } = {}) {
  if (!nativeHttpAvailable()) {
    try {
      const res = await fetch(url, { headers, redirect: "follow" });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text, error: res.ok ? "" : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, status: 0, text: "", error: err.message || String(err) };
    }
  }

  return new Promise((resolve) => {
    let text = "";
    let status = 0;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve({ ok: status >= 200 && status < 300, status, text });
    };
    nativeStream({
      url,
      method: "GET",
      headers: { Accept: "application/json, text/javascript, text/plain, */*", ...headers },
      timeoutSec,
      onStatus: (s) => {
        status = s;
      },
      onChunk: (c) => {
        text += c;
      },
      onEnd: done,
      onError: (err) => {
        if (settled) return;
        settled = true;
        resolve({
          ok: false,
          status: Number(err?.httpStatus) || 0,
          text,
          error: err?.message || "原生网络请求失败",
        });
      },
    });
  });
}
