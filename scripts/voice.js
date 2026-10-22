/* ============================================================
   语音输入 —— 原生 SpeechRecognizer 的 JS 适配层

   ============ 为什么重写这一层 ============

   旧实现只有 30 行：

       const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
       if (!SR) { toast("此设备不支持语音输入", "err"); return; }
       const rec = new SR();
       rec.lang = "zh-CN";
       rec.onresult = ...append...
       rec.start();

   三个问题叠在一起，导致它在 APK 里**从来没有成功过**：

   1. **Android WebView 没有 Web Speech API。**
      `SpeechRecognition` / `webkitSpeechRecognition` 是 Chrome 浏览器
      自带的能力（后端接 Google 语音服务），WebView 不实现它。
      桌面 Chromium 里 `typeof` 是 "function"，手机 WebView 里是 "undefined"。
      所以那一行 `if (!SR)` 永远成立，用户只会看到「此设备不支持语音输入」。

   2. **manifest 里没有 RECORD_AUDIO。**
      就算哪天 WebView 支持了，没有这个权限也开不了麦。

   3. **没有状态、没有反馈、不能取消。**
      点一下只弹个 toast，说完之前完全不知道它在不在听；
      也没法中途放弃，识别器还一直占着麦克风。

   现在的做法：

     原生 SpeechRecognizer（DshSpeechBridge）
       ↓ window.__dshSpeechEvent
     本模块（统一状态机：idle / starting / listening / finishing）
       ↓ 回调
     UI（音量条、实时转写、可取消）

   浏览器 / PWA 没有原生桥时，回退到 Web Speech API（部分桌面浏览器可用），
   两者都没有就明确说清"为什么不可用"，而不是含糊地报错。
   ============================================================ */

const bridge = () => (typeof window !== "undefined" ? window.DshSpeech || null : null);

/** 当前是否有可用的语音识别能力。 */
export function voiceAvailable() {
  const b = bridge();
  if (b && typeof b.isAvailable === "function") {
    try {
      return !!b.isAvailable();
    } catch {
      return false;
    }
  }
  return typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** 是否已经有麦克风权限（原生桥才查得到；浏览器侧只能等实际报错）。 */
export function voicePermission() {
  const b = bridge();
  if (b && typeof b.hasPermission === "function") {
    try {
      return !!b.hasPermission();
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 语音自检：把"为什么用不了"摊开。
 *
 * 四种原因对外表现都是"没反应"，靠猜分不出来：
 *   ① 设备没有语音识别服务（国产 ROM 常见）
 *   ② 有服务但没有中文语言包
 *   ③ 录音权限被拒（勾了"不再询问"后系统不再弹窗）
 *   ④ 服务在，启动后立刻报错（麦克风被占用）
 *
 * @returns {{native:boolean, available:boolean, permission:boolean,
 *            services:string[], serviceCount:number, api:number, error?:string}}
 */
export function voiceDiagnose() {
  const b = bridge();
  const empty = {
    native: !!b,
    available: false,
    permission: false,
    services: [],
    serviceCount: 0,
    api: 0,
    onDevice: false,
    builtin: false,
    preferBuiltin: false,
    modelInstalled: false,
    modelBundled: false,
  };
  if (!b) return empty;
  if (typeof b.diagnose !== "function") {
    // 旧 APK 里的桥没有这个方法：退回最基本的两个判据
    return { ...empty, available: voiceAvailable(), permission: voicePermission() };
  }
  try {
    const raw = b.diagnose();
    const o = raw ? JSON.parse(String(raw)) : {};
    return {
      native: true,
      available: !!o.available,
      permission: !!o.permission,
      services: Array.isArray(o.services) ? o.services : [],
      serviceCount: Number(o.serviceCount) || 0,
      api: Number(o.api) || 0,
      // 能不能走本地识别：这是错误码 11（云端连不通）的唯一出路
      onDevice: !!o.onDevice,
      // 内置离线引擎是否已就绪，以及当前会不会优先用它
      builtin: !!o.builtin,
      preferBuiltin: !!o.preferBuiltin,
      modelInstalled: !!o.modelInstalled,
      modelBundled: !!o.modelBundled,
      error: o.error || undefined,
    };
  } catch (err) {
    return { ...empty, error: String(err?.message || err) };
  }
}

/**
 * 下载离线语音模型。
 *
 * 模型 42 MB，不打包进 APK —— 装的人不必为一个可选能力付体积。
 * 下载进度通过 onVoiceEvent 的 `download` 事件推出来。
 */
export function voiceDownloadModel() {
  const b = bridge();
  if (!b || typeof b.downloadModel !== "function") return false;
  try {
    b.downloadModel();
    return true;
  } catch {
    return false;
  }
}

/** 单独申请一次麦克风权限（设置页的「授权」按钮会用到）。 */
export function requestVoicePermission() {
  const b = bridge();
  if (!b || typeof b.requestPermission !== "function") return false;
  try {
    b.requestPermission();
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 状态机 ---------------- */

const listeners = new Set();

/** 订阅状态变化。返回退订函数。 */
export function onVoiceEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  listeners.forEach((fn) => {
    try {
      fn(event);
    } catch {
      /* 单个订阅者出错不影响其它人 */
    }
  });
}

/** idle | starting | listening | finishing */
let state = "idle";
/** 本次会话已确认的文字（final 结果会直接写进输入框） */
let session = null;
/**
 * 用户已经取消。
 *
 * 原生 cancel() 是异步的：很可能在它生效之前，系统的 onResults 已经在路上了
 * （用户说完最后一个字、同时点了取消 —— 这个窗口不算小）。
 * 那条迟到的 final 到达时如果照写，就会出现「点了取消，文字还是被塞进输入框」。
 */
let cancelled = false;

export function voiceState() {
  return state;
}

function setState(next) {
  if (state === next) return;
  state = next;
  armWatchdog();
  emit({ type: "state", state: next });
}

/* ============================================================
   看门狗：状态机的最后一道保险

   ============ 没有它会发生什么 ============

   原生 SpeechRecognizer 是"回调驱动"的，而它并不保证一定回调：

     · `startListening()` 成功返回，但 `onReadyForSpeech` 不来
       （麦克风被别的应用占着、语音服务刚被系统回收、部分 ROM 的权限弹窗吞掉了）
       → 状态停在 starting，界面显示「正在听…」，其实没在听。

     · `stopListening()` 之后，`onResults` / `onError` **两个都不来**
       → 状态停在 finishing，永远等不到 end。

   两种情况都会把状态机卡死，而且**越点越死**：
   卡在 finishing 后，用户再点麦克风 → `startVoice` 看到非 idle → 走 stopVoice
   → 原生侧已经在停了，stop 不生效 → 又等一次 end → 还是没有。
   用户唯一的出路是杀掉应用。

   ============ 所以 ============

   每个状态都有最长存活时间。超时就强制收尾：
   报一句人话、把状态推回 idle，让用户能再试一次。
   ============================================================ */

const WATCHDOG_MS = {
  starting: 5000,   // 5 秒还没 ready，基本可以判定麦克风没起来
  listening: 120000, // 一次说话超过 2 分钟，多半是用户忘了关
  finishing: 10000,  // 10 秒还没收到结果，系统那边不会给了
};

let wdTimer = null;

function armWatchdog() {
  if (wdTimer) {
    clearTimeout(wdTimer);
    wdTimer = null;
  }
  const ms = WATCHDOG_MS[state];
  if (!ms) return;
  wdTimer = setTimeout(() => {
    wdTimer = null;
    if (state === "starting") {
      emit({
        type: "error",
        code: "start_timeout",
        message: "麦克风没有在预期时间内就绪，可能被其他应用占用了，请稍后重试",
      });
      // 顺手把原生那次启动也停掉，别让它一直占着麦克风
      try {
        const b = bridge();
        if (b && typeof b.cancel === "function") b.cancel();
      } catch {
        /* ignore */
      }
      session = null;
      cancelled = true;
      setState("idle");
      emit({ type: "end", reason: "start_timeout" });
      return;
    }
    if (state === "finishing") {
      emit({
        type: "error",
        code: "result_timeout",
        message: "没有等到识别结果，请再说一次",
      });
      session = null;
      setState("idle");
      emit({ type: "end", reason: "result_timeout" });
      return;
    }
    if (state === "listening") {
      // 用户忘了关：直接走正常结束，尽量把已有结果取回来
      emit({
        type: "error",
        code: "too_long",
        message: "这次听得太久了，已自动结束",
      });
      stopVoice();
    }
  }, ms);
}

/** 收到任何原生事件都算"还活着"，重置计时。 */
function touchWatchdog() {
  if (state !== "idle") armWatchdog();
}

/* ---------------- 原生桥事件入口 ---------------- */

if (typeof window !== "undefined") {
  window.__dshSpeechEvent = (raw) => {
    let evt;
    try {
      evt = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!evt || !evt.type) return;

    // 只要还有事件进来，就说明原生侧还活着 —— 重置看门狗。
    // 放在 cancelled 判断**之前**：取消后如果原生还在慢慢吐事件，
    // 也不该被误判成"没响应"。
    touchWatchdog();

    if (cancelled && evt.type !== "end") return;

    if (evt.type === "ready") {
      setState("listening");
      emit({ type: "ready" });
      return;
    }
    if (evt.type === "volume") {
      emit({ type: "volume", level: Number(evt.rms) || 0 });
      return;
    }
    if (evt.type === "partial") {
      emit({ type: "partial", text: String(evt.text || "") });
      return;
    }
    if (evt.type === "final") {
      setState("finishing");
      emit({ type: "final", text: String(evt.text || "") });
      return;
    }
    if (evt.type === "error") {
      emit({ type: "error", code: String(evt.code || "unknown"), message: String(evt.message || "语音识别失败") });
      return;
    }
    if (evt.type === "end") {
      const finished = session;
      session = null;
      setState("idle");
      emit({ type: "end", reason: String(evt.reason || "") });
      if (finished && !finished.delivered) {
        // 一次都没有 final 就结束了：这不算错误，只是没听到内容
        emit({ type: "empty" });
      }
      return;
    }
    if (evt.type === "download") {
      // 模型下载：pct 0~100。state 只在最后有值（unzip / done）。
      emit({ type: "download", pct: Number(evt.pct) || 0, state: String(evt.state || "") });
      return;
    }
    if (evt.type === "preparing") {
      // 内置引擎首次启动要把 44 MB 模型从 assets 解出来 —— 几秒钟。
      // 必须告诉界面，否则用户盯着"正在听…"会以为卡死了。
      emit({ type: "preparing" });
      return;
    }
    if (evt.type === "permission") {
      emit({ type: "permission", granted: !!evt.granted });
    }
  };
}

/* ---------------- 对外接口 ---------------- */

/**
 * 开始一次识别。
 *
 * @param {object} opts
 * @param {string} [opts.lang="zh-CN"]
 * @param {boolean} [opts.interim=true] 是否把中间结果也推给 UI
 * @returns {{ok:boolean, reason?:string}}
 */
export function startVoice(opts = {}) {
  if (state === "finishing") {
    // ============ 卡在「等结果」时，再点麦克风必须能重开 ============
    //
    // 原来这里一律走 stopVoice()。但 finishing 状态下再 stop 是空操作
    // （原生那边已经在停了），结果又是等一次不会来的 end ——
    // 用户连点几下都毫无反应，只能杀进程。
    //
    // 用户此时点麦克风，意图很明确：我要重新说。直接复位重开。
    forceReset("restart");
  } else if (state !== "idle") {
    // 正在听 / 正在启动：再点一次当作「结束」而不是报错
    stopVoice();
    return { ok: true, reason: "restarted" };
  }
  if (!voiceAvailable()) {
    return { ok: false, reason: bridge() ? "no-service" : "no-api" };
  }

  session = { delivered: false };
  cancelled = false;
  setState("starting");

  const b = bridge();
  if (b && typeof b.start === "function") {
    try {
      b.start(opts.lang || "zh-CN");
      return { ok: true };
    } catch (err) {
      session = null;
      setState("idle");
      return { ok: false, reason: err.message || "start-failed" };
    }
  }

  // 回退：Web Speech API
  return startWebSpeech(opts);
}

/** 结束并等最终结果。 */
export function stopVoice() {
  if (state === "idle") return false;
  const b = bridge();
  if (b && typeof b.stop === "function") {
    setState("finishing");
    try {
      b.stop();
      return true;
    } catch {
      /* 落到下面兜底 */
    }
  }
  if (webRec) {
    setState("finishing");
    try {
      webRec.stop();
      return true;
    } catch {
      /* ignore */
    }
  }
  cancelVoice();
  return false;
}

/**
 * 强制把状态机推回 idle，不依赖原生回调。
 *
 * 用于「状态已经卡住」的场景：等不到 end、但用户明确要重新开始。
 * 只做本地收尾 + 通知原生取消，不订阅任何后续事件。
 */
function forceReset(reason) {
  if (wdTimer) {
    clearTimeout(wdTimer);
    wdTimer = null;
  }
  try {
    const b = bridge();
    if (b && typeof b.cancel === "function") b.cancel();
  } catch {
    /* ignore */
  }
  session = null;
  cancelled = true;
  setState("idle");
  emit({ type: "end", reason: reason || "reset" });
}

/** 立刻取消，不要结果。 */
export function cancelVoice() {
  const b = bridge();
  if (b && typeof b.cancel === "function") {
    try {
      b.cancel();
    } catch {
      /* ignore */
    }
  }
  if (webRec) {
    try {
      webRec.abort();
    } catch {
      /* ignore */
    }
    webRec = null;
  }
  session = null;
  cancelled = true;
  setState("idle");
  if (wdTimer) {
    clearTimeout(wdTimer);
    wdTimer = null;
  }
  emit({ type: "end", reason: "cancel" });
  return true;
}

/* ---------------- Web Speech API 回退 ---------------- */

let webRec = null;

function startWebSpeech(opts) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    session = null;
    setState("idle");
    return { ok: false, reason: "no-api" };
  }
  try {
    webRec = new SR();
  } catch (err) {
    session = null;
    setState("idle");
    return { ok: false, reason: err.message || "init-failed" };
  }
  const rec = webRec;
  rec.lang = opts.lang || "zh-CN";
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => setState("listening");
  rec.onresult = (e) => {
    let interim = "";
    let final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim) emit({ type: "partial", text: interim });
    if (final) {
      if (session) session.delivered = true;
      emit({ type: "final", text: final });
    }
  };
  rec.onerror = (e) => {
    emit({ type: "error", code: String(e.error || "unknown"), message: webSpeechMessage(e.error) });
  };
  rec.onend = () => {
    webRec = null;
    const finished = session;
    session = null;
    setState("idle");
    emit({ type: "end", reason: "stop" });
    if (finished && !finished.delivered) emit({ type: "empty" });
  };

  try {
    rec.start();
  } catch (err) {
    webRec = null;
    session = null;
    setState("idle");
    return { ok: false, reason: err.message || "start-failed" };
  }
  return { ok: true };
}

function webSpeechMessage(code) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "浏览器拒绝了麦克风权限";
    case "no-speech":
      return "没听到声音，再试一次";
    case "audio-capture":
      return "找不到麦克风设备";
    case "network":
      return "语音服务需要联网";
    case "aborted":
      return "已取消";
    default:
      return `语音识别失败（${code}）`;
  }
}
