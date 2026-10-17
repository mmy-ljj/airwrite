/**
 * AirWrite service worker — 只做一件事：把重资产缓存下来。
 *
 * 为什么需要它：首次打开要下 9.4 MB wasm + 7.8 MB 手部模型，手机上走蜂窝网络
 * 要好几十秒，用户会以为页面卡死。缓存之后第二次打开（离线也行）是秒开。
 *
 * 缓存策略刻意保守：
 *   - 只有本站 GET 请求才接管；
 *   - `/vendor/` 下的大文件（wasm / 模型）用 cache-first，它们随构建更新，
 *     换模型时把 CACHE 版本号 +1 即可；
 *   - 其余请求放行（浏览器自己的 HTTP 缓存处理），避免把 index.html 或
 *     源码钉死在旧版本上 —— 部署新版本后用户刷新就能拿到。
 */

const CACHE = 'airwrite-assets-v1';
const CORE = ['./', './index.html', './styles.css', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // 单个文件失败不该让整个安装失败（比如 manifest 被删了）
      Promise.all(CORE.map((url) => cache.add(url).catch(() => {}))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const heavy = /\/vendor\/(lib|models)\//.test(url.pathname) || /\/vendor\/.*\.(wasm|task)$/.test(url.pathname);
  if (!heavy) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok && res.status === 200) cache.put(request, res.clone()).catch(() => {});
      return res;
    })(),
  );
});
