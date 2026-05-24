// Bump CACHE_VERSION on every release; the activate handler nukes any older
// cache buckets so stale chunked JS doesn't poison the new shell.
const CACHE_VERSION = 'misaka-shell-v4'
const APP_SHELL = [
  './',
  './index.html',
  './404.html',
  './config.json',
  './assets/misaka-logo.webp',
]

// During install we (a) prime the cache with the static shell and (b) parse
// the freshly-fetched index.html to discover the Vite-hashed bundle URLs
// (`/assets/index-<hash>.js` etc.) so the very first offline visit has
// everything it needs. Vite doesn't emit a manifest.json by default at
// runtime and modifying the build config is out of scope, so we extract the
// asset list straight from the served HTML.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION)
    try {
      await cache.addAll(APP_SHELL)
    } catch (err) {
      console.warn('[sw] shell prime failed', err)
    }
    try {
      const res = await fetch('./index.html', { cache: 'no-cache' })
      if (res.ok) {
        const html = await res.text()
        // Match both <script src="..."> and <link href="..."> inside the
        // current document. We intentionally restrict to same-origin (./ or /)
        // so cross-origin CDNs don't get cached without a CORS path.
        const urls = new Set()
        const reSrc = /<script[^>]+src=["']([^"']+)["']/g
        const reHref = /<link[^>]+href=["']([^"']+)["']/g
        let m
        while ((m = reSrc.exec(html))) urls.add(m[1])
        while ((m = reHref.exec(html))) urls.add(m[1])
        const sameOrigin = []
        for (const u of urls) {
          try {
            const abs = new URL(u, self.location.href)
            if (abs.origin === self.location.origin) sameOrigin.push(abs.pathname)
          } catch { /* ignore malformed */ }
        }
        await Promise.allSettled(sameOrigin.map((p) => cache.add(p)))
      }
    } catch (err) {
      console.warn('[sw] asset discovery failed', err)
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
