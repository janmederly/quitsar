const CACHE = 'quitsar-v13';
const FILES = [
  './',
  './index.html',
  './styles/app.css',
  './assets/icon.svg',
  './js/app.js',
  './js/dom.js',
  './js/i18n.js',
  './js/locales/sk.js',
  './js/locales/cs.js',
  './js/locales/de.js',
  './js/locales/es.js',
  './js/locales/fr.js',
  './js/storage.js',
  './js/account.js',
  './js/limits.js',
  './js/scoring.js',
  './js/spaced-repetition.js',
  './js/validation.js',
  './js/records.js',
  './js/autosave.js',
  './js/assets.js',
  './js/filters.js',
  './js/question.js',
  './js/transfer.js',
  './js/management.js',
  './js/study.js',
  './js/exam.js',
  './js/results.js',
  './banks/demo.json',
  './banks/images/annulus.svg',
  './banks/images/history-timeline.svg',
  './banks/images/cell-diagram.svg'
];
self.addEventListener('install', (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting())
  )
);
self.addEventListener('activate', (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('quitsar-') && k !== CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  )
);
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));
});
