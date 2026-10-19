/* Build replaces the two tokens below with the shipped public asset inventory. */
const CACHE_NAME = 'shard-atlas-shell-__SHARD_ATLAS_VERSION__';
const CACHE_PREFIX = 'shard-atlas-shell-';
const PRECACHE_FILES = __SHARD_ATLAS_ASSETS__;
const ALLOWED_PATHS = new Set(PRECACHE_FILES);

function privatePath(pathname) {
  return /^\/(?:api|assets)(?:\/|$)/.test(pathname);
}

self.addEventListener('install', event => {
  // A new version stays waiting until every existing app window is closed.
  // Automatically taking control could interrupt an unfinished editor.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_FILES.map(path => new Request(path, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function navigation(request, url) {
  const cache = await caches.open(CACHE_NAME);
  const shell = await cache.match('/index.html');
  // Keep this worker's HTML and fixed-path modules on the same release. A new
  // worker has its own complete cache and activates after old windows close.
  if (shell && (url.pathname === '/' || url.pathname === '/index.html')) return shell;
  try {
    return await fetch(request);
  } catch (error) {
    if (shell) return shell;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // Private records, imported images, writes, and third-party content are kept
  // out of Cache Storage. The app's local database owns personal information.
  if (request.method !== 'GET' || url.origin !== self.location.origin || privatePath(url.pathname)) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigation(request, url));
    return;
  }
  if (url.search || !ALLOWED_PATHS.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url.pathname);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put(url.pathname, response.clone());
    return response;
  })());
});
