/* Service Worker — 壳缓存，保证断网也能打开；接口请求不缓存 */

const CACHE = "dsh-mobile-v0.84.0";
const SHELL = [
  "./",
  "./index.html",
  // 自检页：界面起不来时唯一的出口，断网时也必须能打开
  "./diagnose.html",
  "./layout-probe.html",
  "./scripts/diagnose.js",
  "./manifest.webmanifest",
  // 启动动画 —— 少了它，断网打开时第一帧是空白而不是动画
  "./splash/dsh-splash.css",
  "./splash/dsh-splash.js",
  "./styles/tokens.css",
  "./styles/base.css",
  "./styles/components.css",
  "./styles/effort.css",
  "./styles/screens.css",
  "./styles/ui-host.css",
  "./scripts/app.js",
  "./scripts/ui.js",
  "./scripts/ui-host.js",
  "./scripts/store.js",
  "./scripts/runtime.js",
  // 协议适配层：store.js 在启动时就要用它做格式兜底，
  // 少这一条的话断网打开会在 import 阶段直接白屏。
  "./scripts/formats.js",
  "./scripts/retry.js",
  "./scripts/native-http.js",
  "./scripts/hud.js",
  "./scripts/tools.js",
  "./scripts/markdown.js",
  "./scripts/screens.js",
  "./scripts/icons.js",
  "./scripts/effort-slider.js",
  "./scripts/context.js",
  "./scripts/prompt.js",
  "./scripts/memory.js",
  "./scripts/inject.js",
  "./scripts/mcp.js",
  "./scripts/dsh-ball.js",
  "./scripts/fs.js",
  "./scripts/node-runtime.js",
  "./scripts/image.js",
  "./scripts/ime.js",
  // 办公导出与 PDF 的依赖链：tools.js 静态 import 它们，
  // 断网首启时少一个模块就是白屏。字体也一起缓存 —— 否则第一次
  // 在飞机上生成 PDF 会卡在「字体加载失败」。
  "./scripts/office.js",
  "./scripts/pptx.js",
  "./scripts/zip.js",
  "./scripts/pdf.js",
  "./scripts/pdf-write.js",
  "./scripts/apikeys.js",
  "./scripts/crash-guard.js",
  "./scripts/keep-alive.js",
  "./scripts/llm-bridge.js",
  "./scripts/mcp-local.js",
  "./scripts/node-plugins.js",
  "./scripts/npm-deps.js",
  "./scripts/plugin-caps.js",
  "./scripts/plugin-catalog.js",
  "./scripts/plugin-host.js",
  "./scripts/plugin-install.js",
  "./scripts/plugin-install-node.js",
  "./scripts/plugin-manifest.js",
  "./scripts/safety.js",
  "./scripts/semver-lite.js",
  "./scripts/toolargs.js",
  "./scripts/traj.js",
  "./scripts/voice.js",
  "./scripts/fonts/noto-sans-sc.ttf",
  "./scripts/fonts/dejavu-symbols.ttf",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/whale-white.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 模型接口与字体走网络

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
    )
  );
});
