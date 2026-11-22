const CACHE = "yappie-v2";
const SHELL = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Hashed Vite assets are immutable — cache-first is always safe and makes
 *  offline reloads instant once the shell has been visited online once. */
function isImmutableAsset(pathname) {
  return pathname.startsWith("/assets/");
}

async function cachePut(req, res) {
  if (!res || !res.ok) return;
  try {
    const copy = res.clone();
    const cache = await caches.open(CACHE);
    await cache.put(req, copy);
  } catch {
    /* quota/private mode — best-effort */
  }
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    await cachePut(req, res);
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    if (req.mode === "navigate") {
      const shell = (await caches.match("/index.html")) || (await caches.match("/"));
      if (shell) return shell;
    }
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) {
    // Revalidate in the background so a new deploy still lands eventually.
    void fetch(req)
      .then((res) => cachePut(req, res))
      .catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    await cachePut(req, res);
    return res;
  } catch {
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function staleWhileRevalidate(req) {
  const cached = await caches.match(req);
  const network = fetch(req)
    .then((res) => cachePut(req, res))
    .catch(() => null);
  if (cached) {
    void network;
    return cached;
  }
  const res = await network;
  if (res) return res;
  return new Response("Offline", { status: 503, statusText: "Offline" });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (isImmutableAsset(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});
