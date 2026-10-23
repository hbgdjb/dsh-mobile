import { initUI } from "./ui.js";
import { initFiles } from "./store.js";
import { installCrashGuard } from "./crash-guard.js";
import { mountPluginHost } from "./plugin-caps.js";
import { loadEnabledPlugins } from "./plugin-install.js";

// 先装兜底：越早装，越能抓到启动阶段的异常
installCrashGuard();

// 插件宿主能力必须在插件装载前挂好，
// 否则沙箱里的插件调用 dsh.host.* 会拿到「能力尚未挂载」。
mountPluginHost();

// Capacitor / Android WebView：系统状态栏已占据顶部空间，避免重复留白
if (window.Capacitor?.isNativePlatform?.()) {
  document.documentElement.classList.add("native");
}

// 先把真实目录 / IndexedDB 的文件索引准备好，再渲染界面
initFiles()
  .catch((err) => console.warn("文件系统初始化失败：", err))
  .finally(() => {
    // 已安装的第三方插件在这里装载。
    // 放在 initFiles 之后 —— 插件代码存在工作区文件里，
    // 文件系统没准备好就读不到。
    loadEnabledPlugins()
      .catch((err) => console.warn("插件装载失败：", err))
      .finally(() => {
        initUI();
        // 启动动画退场：等界面画出第一帧再交棒，
        // 否则淡出的时候后面还是空白，会闪一下。
        requestAnimationFrame(() =>
          requestAnimationFrame(() => window.DshSplash?.ready())
        );
      });
  });

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
