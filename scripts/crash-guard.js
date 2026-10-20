/* ============================================================
   Crash guard — 全局错误捕获与保活

   问题背景：AI 执行任务时应用会突然退到桌面。
   原因之一是 WebView 渲染进程被系统 OOM 杀掉（原生侧已加兜底），
   另一类是 JS 侧的未捕获异常——它们往往悄无声息地让当前流程中断，
   界面停在"运行中"，用户既看不到原因也停不下来。

   这里做三件事：
     1. 捕获 error / unhandledrejection，写进诊断，供下次查看；
     2. 页面被切到后台时立刻落盘，避免进程被杀后丢记录；
     3. 页面隐藏 → 可见时，若发现状态里有"孤儿运行"，自动收尾。
   ============================================================ */

const CRASH_FLAG = "dsh.mobile.lastCrash.v1";

function recordCrash(kind, message, extra) {
  try {
    const prev = JSON.parse(localStorage.getItem(CRASH_FLAG) || "null");
    const entry = {
      kind,
      message: String(message || "").slice(0, 400),
      extra: String(extra || "").slice(0, 400),
      ts: Date.now(),
      count: (prev?.count || 0) + 1,
    };
    localStorage.setItem(CRASH_FLAG, JSON.stringify(entry));
  } catch {
    /* 忽略 */
  }
}

export function lastCrash() {
  try {
    return JSON.parse(localStorage.getItem(CRASH_FLAG) || "null");
  } catch {
    return null;
  }
}

export function clearCrash() {
  try {
    localStorage.removeItem(CRASH_FLAG);
  } catch {
    /* 忽略 */
  }
}

export function installCrashGuard() {
  window.addEventListener(
    "error",
    (e) => {
      recordCrash("error", e.message, `${e.filename}:${e.lineno}`);
    },
    true
  );
  window.addEventListener(
    "unhandledrejection",
    (e) => {
      const r = e.reason;
      recordCrash("unhandledrejection", r?.message || String(r), r?.stack || "");
    },
    true
  );

  // 切后台立刻落盘：进程被系统回收时，内存里正在流式的内容就不会白跑
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      try {
        window.dispatchEvent(new CustomEvent("dsh:flush"));
      } catch {
        /* 忽略 */
      }
    }
  });

  // 从后台回到前台：如果上一次运行是被系统打断的残留，UI 负责收尾
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      window.dispatchEvent(new CustomEvent("dsh:resume"));
    }
  });
}
