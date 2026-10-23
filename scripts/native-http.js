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
  } else if (evt.type === "bytes") {
    item.onBytes?.(String(evt.base64 || ""), Number(evt.status) || 0, String(evt.mime || ""));
  } else if (evt.type === "end") {
    item.finish();
  } else if (evt.type === "error") {
    // 原生侧抛上来的是 Java 异常，比如
    //   `ConnectException: Failed to connect to cdn.jsdelivr.net/104.17.207.5:443`
    // 把它原样塞进提示里，用户看到的是类名和 IP。翻成人话。
    const err = new Error(
      humanizeNetworkError(evt.message) ||
        (evt.status ? `HTTP ${evt.status}` : "原生网络请求失败")
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

/**
 * 把原生侧的 Java 异常翻成人话。
 *
 * ============ 为什么值得单独一个函数 ============
 *
 * 用户报过一次「没能加载目录 ConnectException: Failed to connect to
 * cdn.jsdelivr.net/104.17.207.5:443」。这句话里没有一个字是给他看的：
 * 类名是给开发者看的，IP 和端口对判断毫无帮助，而真正有用的信息
 * 只有一条 —— **连不上哪个主机**。
 *
 * 翻完是「连不上 cdn.jsdelivr.net」。短、准、能据此决定下一步。
 *
 * @param {string} raw 原生侧传来的 message
 * @returns {string}
 */
export function humanizeNetworkError(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";

  const hostOf = (s) => {
    const m = s.match(/(?:connect to |resolve host "?)([^/\s":]+)/i);
    return m ? m[1] : "";
  };

  if (/Failed to connect to|ConnectException|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(text)) {
    const h = hostOf(text);
    return h ? `连不上 ${h}` : "连不上服务器";
  }
  if (/Unable to resolve host|UnknownHostException|ENOTFOUND/i.test(text)) {
    const h = hostOf(text);
    return h ? `解析不到 ${h}（域名解析失败，可能断网或被拦截）` : "域名解析失败";
  }
  if (/SSLHandshake|CertPathValidatorException|certificate/i.test(text)) {
    return "安全连接建立失败（证书异常，可能被代理拦截）";
  }
  if (/Read timed out|SocketTimeout|timed out|timeout/i.test(text)) {
    const h = hostOf(text);
    return h ? `${h} 响应超时` : "服务器响应超时";
  }
  if (/Network is unreachable|network unreachable/i.test(text)) return "网络不可达";

  // 没有命中就把类名前缀去掉，至少不留 `FooException: ` 这种噪音
  return text.replace(/^[A-Za-z0-9_.$]+(?:Exception|Error):\s*/, "");
}

/** Base64 → 字节。自己写，免得为了 10 行把 office.js 拖进来。 */
function base64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 取一个二进制资源（GET），返回字节。
 *
 * ============ 为什么不能用 nativeGetText ============
 *
 * 那条通道按 UTF-8 解码每一块。zip 里全是 0x80 以上的字节，
 * 解码一次就回不去了 —— 拿到的「文本」再编码成字节，内容已经坏了。
 *
 * 所以原生侧单独读字节、Base64 编码后整段回传。
 *
 * APK 内走原生（绕开 CORS）；浏览器里回退 fetch，此时只能装同源
 * 或允许跨域的地址 —— 这已经是浏览器环境能做的全部了。
 *
 * @param {string} url
 * @param {object} [opts] { timeoutSec, signal }
 * @returns {Promise<{bytes:Uint8Array, mime:string}>}
 */
export async function nativeGetBytes(url, { timeoutSec = 120, signal } = {}) {
  if (!nativeHttpAvailable()) {
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      const e = new Error("连不上这个地址：" + (err?.message || err));
      e.httpStatus = 0;
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.httpStatus = res.status;
      throw e;
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mime: String(res.headers.get("content-type") || ""),
    };
  }

  return await new Promise((resolve, reject) => {
    const id = `b${Date.now().toString(36)}_${seq++}`;
    let settled = false;

    const cleanup = () => {
      pending.delete(id);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      try {
        bridge()?.abort?.(id);
      } catch {
        /* 原生侧可能已结束 */
      }
      fail(Object.assign(new DOMException("Aborted", "AbortError")));
    };

    const timer = setTimeout(() => fail(new Error("下载超时")), (timeoutSec + 10) * 1000);

    pending.set(id, {
      onBytes: (b64, status, mime) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        try {
          resolve({ bytes: base64ToBytes(b64), mime: String(mime || "") });
        } catch (err) {
          reject(new Error("下载到的内容无法解码：" + (err?.message || err)));
        }
      },
      finish: () => {},
      fail: (err) => {
        clearTimeout(timer);
        fail(err);
      },
    });

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      bridge().getBinary(id, url, Math.max(15, Math.min(300, Number(timeoutSec) || 120)));
    } catch (err) {
      clearTimeout(timer);
      fail(err);
    }
  });
}
