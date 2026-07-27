import { useEffect, useState } from 'react'

// BUG-029 — "is it safe to reload right now?".
//
// The update banner reloads unconditionally, killing any in-flight transfer
// and every peer connection. It needs to know when work is in progress, but
// it lives in `App.tsx` (always mounted) while the transfer state lives in
// the lazily-loaded network store. Importing that store here would pull the
// whole WebRTC/transfer graph into the initial bundle.
//
// Instead, whoever owns live work registers a probe. No registration means
// "nothing in flight", which is exactly the state of a session that never
// opened the network page.

type Probe = () => boolean

const probes = new Set<Probe>()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) {
    try { fn() } catch { /* a broken listener must not block the others */ }
  }
}

/**
 * Register a predicate that reports whether this owner currently has work
 * that a page reload would destroy (an active transfer, a live handshake).
 * Returns an unregister function — call it on unmount.
 */
export function registerActiveWorkProbe(probe: Probe): () => void {
  probes.add(probe)
  notify()
  return () => {
    probes.delete(probe)
    notify()
  }
}

/** Tell subscribers to re-evaluate — call when work starts or finishes. */
export function notifyActiveWorkChanged() {
  notify()
}

/** True when any registered probe reports in-flight work. */
export function hasActiveWork(): boolean {
  for (const probe of probes) {
    try {
      if (probe()) return true
    } catch {
      // A throwing probe is treated as "unknown"; err on the safe side and
      // report busy rather than silently reloading over live work.
      return true
    }
  }
  return false
}

export function subscribeActiveWork(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * Reactive view of `hasActiveWork()`. Polls in addition to subscribing
 * because a transfer's progress is not required to call
 * `notifyActiveWorkChanged()` on every chunk — a 1 s poll is plenty for a
 * "should the reload button be armed" decision.
 */
export function useActiveWork(pollMs = 1000): boolean {
  const [busy, setBusy] = useState(hasActiveWork)

  useEffect(() => {
    const update = () => setBusy(hasActiveWork())
    update()
    const unsubscribe = subscribeActiveWork(update)
    const timer = window.setInterval(update, pollMs)
    return () => {
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [pollMs])

  return busy
}

/** Test helper — drop every registration. */
export function __resetActiveWork() {
  probes.clear()
  listeners.clear()
}
