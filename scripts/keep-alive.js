/* ============================================================
   Keep alive — 后台保活

   用户反馈："切到后台任务就会自动停止"。
   追下来发现**不是权限不够**，而是三处机制没接上：

   1) **WebView 渲染进程被降级回收**（主因）
      Android 8.0 起 WebView 跑在独立进程。WebView 不可见时系统会把渲染进程
      降级到 RENDERER_PRIORITY_WAIVED，内存紧张时第一个被回收。
      渲染进程一死，JS 上下文整个消失，正在跑的流式请求全部归零。
      已在 MainActivity 用 setRendererPriorityPolicy(IMPORTANT, false) 修掉。

   2) **CPU 休眠打断流式读取**
      后台待久后 CPU 休眠，SSE socket 读事件不再投递，任务卡住不动。
      已在 DshKeepAliveService 里持 PARTIAL_WAKE_LOCK 修掉。

   3) **电池优化 / 国产 ROM 省电策略**（应用层无法自行绕过）
      Android Doze 会限制后台网络与唤醒；MIUI / ColorOS / EMUI / OriginOS
      更有各自的"后台管理""自启动"开关。
      这一层只能引导用户去系统设置里放行 —— 这里提供探测与引导入口。

   浏览器 / PWA 没有原生桥，全部降级为 no-op。
   ============================================================ */

const bridge = () => (typeof window !== "undefined" ? window.DshKeepAlive : null);
const power = () => (typeof window !== "undefined" ? window.DshPower : null);

export function keepAliveAvailable() {
  const b = bridge();
  return !!b && typeof b.start === "function";
}

/** 是否具备后台保活引导能力（APK 才有）。 */
export function powerAvailable() {
  const p = power();
  return !!p && typeof p.status === "function";
}

/** 开始保活。 */
export function keepAliveStart() {
  const b = bridge();
  if (!b) return;
  try {
    b.start();
  } catch {
    /* 原生侧不可用时忽略 */
  }
}

/** 结束保活。 */
export function keepAliveStop() {
  const b = bridge();
  if (!b) return;
  try {
    b.stop();
  } catch {
    /* 忽略 */
  }
}

/**
 * 读取后台保活状态。
 * @returns {{batteryIgnored:boolean, keepAlive:boolean, manufacturer:string, sdk:number, model:string}}
 */
export function powerStatus() {
  const p = power();
  if (!p || typeof p.status !== "function") {
    return { batteryIgnored: false, keepAlive: false, manufacturer: "", sdk: 0, model: "", available: false };
  }
  try {
    const raw = p.status();
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw || {};
    return { ...obj, available: true };
  } catch {
    return { batteryIgnored: false, keepAlive: false, manufacturer: "", sdk: 0, model: "", available: false };
  }
}

/** 弹系统面板：请用户把应用加入"忽略电池优化"白名单。 */
export function requestBatteryExemption() {
  const p = power();
  if (!p || typeof p.requestIgnoreBatteryOptimizations !== "function") return false;
  try {
    return !!p.requestIgnoreBatteryOptimizations();
  } catch {
    return false;
  }
}

/** 打开厂商的省电策略 / 后台管理页。 */
export function openBatterySettings() {
  const p = power();
  if (!p || typeof p.openBatterySettings !== "function") return false;
  try {
    return !!p.openBatterySettings();
  } catch {
    return false;
  }
}

/** 打开厂商的"自启动"管理页（部分厂商与后台管理分开）。 */
export function openAutoStartSettings() {
  const p = power();
  if (!p || typeof p.openAutoStartSettings !== "function") return false;
  try {
    return !!p.openAutoStartSettings();
  } catch {
    return false;
  }
}
