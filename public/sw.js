const CACHE_PREFIX = 'fileflow-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const SHELL = ['/', '/manifest.webmanifest', '/icons/fileflow-192.png', '/icons/fileflow-512.png', '/icons/fileflow-maskable-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(async response => {
      if (response.ok && response.type === 'basic') await (await caches.open(CACHE_NAME)).put('/', response.clone());
      return response;
    }).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }

  const isAppAsset = url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest';
  if (!isAppAsset) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(async response => {
    if (response.ok && response.type === 'basic') await (await caches.open(CACHE_NAME)).put(request, response.clone());
    return response;
  })));
});
