/**
 * sw.js — Pinpoint Service Worker
 * Strategy: Cache-first for all static/game assets, network-first for Supabase API.
 */

const CACHE_NAME = 'pinpoint-v3';

const STATIC_ASSETS = [
    './index.html',
    './js/daily.js',
    './js/game.js',
    './js/supabase.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './Databases/locations_database.json',
    './Databases/hints_database.json',
];

// ─── Install: pre-cache all static assets ──────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Pre-caching static assets');
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// ─── Activate: clean up old caches ─────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => {
                        console.log('[SW] Deleting old cache:', key);
                        return caches.delete(key);
                    })
            )
        )
    );
    self.clients.claim();
});

// ─── Fetch: cache-first for static, network-first for API ──
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Force network for speed round to bypass cache during testing
    if (url.searchParams.has('speed')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // Cache-first for everything else
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                // Cache valid responses
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            });
        })
    );
});

// ─── Push: handle background notifications ────────────────
self.addEventListener('push', (event) => {
    let data = { title: 'Pinpoint', body: 'A new clue has been revealed! 🌍' };
    try {
        if (event.data) data = event.data.json();
    } catch (e) {
        data.body = event.data.text();
    }

    const options = {
        body: data.body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        vibrate: [100, 50, 100],
        data: { url: './index.html' }
    };

    event.waitUntil(self.registration.showNotification(data.title, options));
});

// ─── Notification Click: open app ─────────────────────────
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            if (clientList.length > 0) {
                let client = clientList[0];
                for (let i = 0; i < clientList.length; i++) {
                    if (clientList[i].focused) client = clientList[i];
                }
                return client.focus();
            }
            return clients.openWindow('./index.html');
        })
    );
});
