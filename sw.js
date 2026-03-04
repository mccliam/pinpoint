/**
 * sw.js — Pinpoint Service Worker
 * Strategy: Cache-first for all static/game assets, network-first for Supabase API.
 */

const CACHE_NAME = 'pinpoint-v1';

const STATIC_ASSETS = [
    './index.html',
    './js/daily.js',
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

    // Always go network for Supabase API calls
    if (url.hostname.includes('supabase.co') || url.hostname.includes('cdn.jsdelivr.net')) {
        event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })));
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
