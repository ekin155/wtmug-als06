const CACHE = 'yoklama-v1';
const ASSETS = [
  './', './index.html', './hoca.html', './ogrenci.html', './rapor.html',
  './manifest.json', './js/dtmf.js', './lib/qrcode.min.js', './lib/jsQR.min.js',
  './data/students.json', './data/courses.json'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
