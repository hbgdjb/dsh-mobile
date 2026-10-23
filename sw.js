/* Service Worker — 壳缓存，保证断网也能打开；接口请求不缓存 */

const CACHE = "dsh-mobile-v6.0.1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  // 启动动画 —— 少了它，断网打开时第一帧是空白而不是动画
  "./splash/dsh-splash.css",
  "./splash/dsh-splash.js",
  "./styles/tokens.css",
  "./styles/base.css",
  "./styles/components.css",
  "./styles/effort.css",
  "./styles/screens.css",
  "./scripts/app.js",
  "./scripts/ui.js",
  "./scripts/store.js",
  "./scripts/runtime.js",
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
