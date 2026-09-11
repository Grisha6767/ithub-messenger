// ===== SERVICE WORKER для ITHub Messenger =====
// Минимальный, чтобы PWA устанавливалось на телефон.
// Кэшируем только иконки и манифест, чтобы не было проблем с обновлениями.

const CACHE_NAME = 'ithub-cache-v1';
const CACHE_URLS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Установка — кэшируем статику
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CACHE_URLS).catch(() => {
        // Если что-то не закэшировалось — не страшно
        console.log('Часть файлов не закэширована');
      });
    })
  );
  self.skipWaiting();
});

// Активация — удаляем старые кэши
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch — для HTML и JS всегда идём в сеть (чтобы обновления приходили сразу),
// для иконок отдаём из кэша.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Иконки и манифест — из кэша
  if (CACHE_URLS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((response) => {
        return response || fetch(event.request);
      })
    );
    return;
  }

  // Всё остальное — всегда из сети (никакого кэша)
  event.respondWith(fetch(event.request));
});