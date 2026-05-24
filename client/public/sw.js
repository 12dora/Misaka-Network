// Bump CACHE_VERSION on every release; the activate handler nukes any older
// cache buckets so stale chunked JS doesn't poison the new shell.
const CACHE_VERSION = 'misaka-shell-v5'
const APP_SHELL = [
  './',
  './index.html',
  './404.html',
  './config.json',
  './assets/misaka-logo.webp',
]

// On install we prime ONLY the static shell. The previous version also parsed
// index.html and aggressively prefetched every chunk-hashed JS/CSS asset; on
// first visit that doubled the network load (the page is already fetching
// those same assets to render) and noticeably slowed the very first paint on
// constrained uplinks. Instead the runtime `fetch` handler populates the
// cache opportunistically — by the time the user navigates a second time,
// the same-cache path is hot anyway, without ever competing with the first
// render.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION)
    try {
      await cache.addAll(APP_SHELL)
    } catch (err) {
      console.warn('[sw] shell prime failed', err)
    }
  })())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    await self.clients.claim()
    // Notify every controlled client that a new SW has taken over so the UI
    // can offer a "reload to apply update" banner instead of forcing the
    // user to F5 by hand. Sending after claim() guarantees postMessage hits
    // the same client we now control.
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of clientList) {
      try { client.postMessage({ type: 'sw-updated', version: CACHE_VERSION }) } catch { /* ignore */ }
    }
  })())
})

// Allow the page to ask the SW to activate immediately (skip waiting for the
// "waiting" worker to take over) once the user acks the update banner.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') {
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req)
        const cache = await caches.open(CACHE_VERSION)
        cache.put('./index.html', fresh.clone()).catch(() => {})
        return fresh
      } catch {
        const cached = await caches.match('./index.html')
        if (cached) return cached
        return new Response('Offline', { status: 503, statusText: 'Offline' })
      }
    })())
    return
  }

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req)
      if (fresh.ok && (req.destination === 'script' || req.destination === 'style' || req.destination === 'image' || req.destination === 'font')) {
        const cache = await caches.open(CACHE_VERSION)
        cache.put(req, fresh.clone()).catch(() => {})
      }
      return fresh
    } catch {
      const cached = await caches.match(req)
      if (cached) return cached
      return new Response('Offline', { status: 503, statusText: 'Offline' })
    }
  })())
})
