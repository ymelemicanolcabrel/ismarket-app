const CACHE = 'ismarket-v5';
const ASSETS = ['/', '/index.html', '/manifest.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('googleapis.com') || e.request.url.includes('cloudfunctions.net') || e.request.url.includes('cloudinary.com')) return;
  e.respondWith(caches.match(e.request).then(cached => { const net = fetch(e.request).then(res => { if (res && res.status === 200) { caches.open(CACHE).then(c => c.put(e.request, res.clone())); } return res; }).catch(() => cached); return cached || net; }));
});
self.addEventListener('push', e => {
  if (!e.data) return;
  const d = e.data.json();
  e.waitUntil(self.registration.showNotification(d.title || 'ISMarket', { body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-72.png', data: d.data || {} }));
});
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(clients.openWindow('/')); });
