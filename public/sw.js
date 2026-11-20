// SW：导航/provenance network-first；assets/fonts cache-first；其余 SWR。
// CORE 缺项即安装失败；不自动 skipWaiting，activate 只清 quat-demo- 旧缓存。
const CACHE = "quat-demo-v5";
const CORE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/data/experiments.json",
  "/data/challenges.json",
  "/data/tour.json",
  "/data/activities.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== CACHE && k.startsWith("quat-demo-"))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

async function networkFirst(req, cache, allowShellFallback = true) {
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (!allowShellFallback) throw err;
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
      if (url.pathname === "/build-provenance.json") return networkFirst(req, cache, false);
      if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/")) {
        return cacheFirst(req, cache);
      }
      return staleWhileRevalidate(req, cache);
    })(),
  );
});
