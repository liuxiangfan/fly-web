/*
 * Service Worker：分策略缓存
 *
 * 1. 导航请求（HTML）→ **network-first**：部署后刷新一次就能拿到新 index.html，
 *    不再出现「旧 SW 一直回旧页面，必须手动清缓存」的开发事故；
 *    离线时才退回缓存（保证 PWA 仍可离线打开）。
 * 2. 带 hash 的构建产物（/assets/）与自托管字体（/fonts/）→ cache-first：
 *    文件名内容寻址，永不需要重新验证。
 * 3. 其它同源 GET → stale-while-revalidate。
 *
 * 改 CACHE 版本号即整体失效；activate 时删除旧缓存。
 */
const CACHE = "quat-demo-v2";
const CORE = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CORE).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

async function networkFirst(req, cache) {
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // SPA 兜底：任何导航都回首页外壳（本项目只有一个页面）
    const shell = await cache.match("/index.html");
    if (shell) return shell;
    throw err;
  }
}

async function cacheFirst(req, cache) {
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, cache) {
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (req.mode === "navigate") return networkFirst(req, cache);
      if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/")) {
        return cacheFirst(req, cache);
      }
      return staleWhileRevalidate(req, cache);
    })(),
  );
});
