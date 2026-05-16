const CACHE_VERSION = 'misaka-shell-v3'
const APP_SHELL = [
  './',
  './index.html',
  './404.html',
  './config.json',
  './assets/misaka-logo.webp',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
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
