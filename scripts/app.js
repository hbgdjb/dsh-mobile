import { initUI } from "./ui.js";
import { initFiles } from "./store.js";
import { installCrashGuard } from "./crash-guard.js";

// 先装兜底：越早装，越能抓到启动阶段的异常
installCrashGuard();

// Capacitor / Android WebView：系统状态栏已占据顶部空间，避免重复留白
if (window.Capacitor?.isNativePlatform?.()) {
  document.documentElement.classList.add("native");
}

// 先把真实目录 / IndexedDB 的文件索引准备好，再渲染界面
initFiles()
  .catch((err) => console.warn("文件系统初始化失败：", err))
  .finally(() => initUI());

// Service Worker：
// - APK 内资源本来就是本地打包的，SW 只会在升级后继续喂旧脚本（表现为"装了新版还是旧行为"），
//   所以原生宿主里主动注销并清掉旧缓存；
// - PWA 才注册，用于断网打开。
const NATIVE_HOST = window.Capacitor?.isNativePlatform?.() === true;

if (NATIVE_HOST) {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .getRegistrations?.()
      .then((list) => list.forEach((reg) => reg.unregister().catch(() => {})))
      .catch(() => {});
  }
  if (window.caches?.keys) {
    caches
      .keys()
      .then((keys) => keys.forEach((k) => caches.delete(k)))
      .catch(() => {});
  }
} else if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("Service worker 注册失败：", err);
    });
  });
}
