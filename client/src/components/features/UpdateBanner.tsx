import { useEffect, useRef, useState } from 'react'
import { useActiveWork } from '@/hooks/activeWork'

/**
 * Listens for a {type:'sw-updated'} postMessage from the service worker and
 * surfaces a small fixed banner inviting the user to reload. The banner is
 * dismissible — some users explicitly don't want to be interrupted mid-task
 * and a stale shell is rarely a hard failure.
 *
 * BUG-029 — two problems with the old reload path:
 *   1. It fired `window.location.reload()` immediately, tearing down live
 *      peer connections and any in-flight transfer with no warning. The copy
 *      ("新版本已就绪 — 刷新后立即生效") didn't hint at the cost either.
 *   2. It posted `skip-waiting` and reloaded in the same tick. Activation is
 *      asynchronous, so the reload usually raced ahead of it and the fresh
 *      page came back controlled by the *old* worker — the update appeared
 *      not to apply, and the banner returned on the next navigation.
 *
 * UX-LAYOUT-009 — it was also `fixed` with a bespoke bottom offset and
 * z-[130], so it sat above open dialogs and over the mobile bottom action
 * bar. It now uses the shared `.misaka-notify` layer, which reserves the
 * action-bar + home-indicator space and hides itself while a dialog is open.
 */

const ACTIVATION_TIMEOUT_MS = 3_000

export default function UpdateBanner() {
  const [available, setAvailable] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [reloading, setReloading] = useState(false)
  const busy = useActiveWork()
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    function onMessage(event: MessageEvent) {
      const data = event.data as { type?: string } | undefined
      if (data?.type === 'sw-updated') setAvailable(true)
    }
    // controllerchange fires when the activating worker takes control; a
    // late-arriving update (installed while the tab was open and only
    // promoted to active on a navigate) lands here even if our message
    // listener missed the post.
    function onControllerChange() {
      setAvailable(true)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [])

  /** Resolve once the waiting worker has taken control, or on timeout. */
  function waitForActivation(): Promise<void> {
    return new Promise(resolve => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          navigator.serviceWorker.removeEventListener('controllerchange', done)
        } catch { /* ignore */ }
        resolve()
      }
      const timer = setTimeout(done, ACTIVATION_TIMEOUT_MS)
      try {
        navigator.serviceWorker.addEventListener('controllerchange', done, { once: true })
      } catch {
        done()
      }
    })
  }

  async function reload() {
    if (busy || reloading) return
    setReloading(true)
    try {
      const reg = await navigator.serviceWorker?.getRegistration?.()
      if (reg?.waiting) {
        const activated = waitForActivation()
        reg.waiting.postMessage({ type: 'skip-waiting' })
        // Wait for the new worker to control the page BEFORE reloading, so
        // the reloaded document is served by the version we just installed.
        await activated
      }
    } catch {
      // Some browsers don't expose getRegistration when no worker controls
      // the page yet — just reload.
    }
    window.location.reload()
  }

  if (!available || dismissed) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="misaka-notify px-4 py-2.5 rounded-lg shadow-lg flex flex-wrap items-center gap-x-3 gap-y-1 font-kanji text-sm"
      style={{ background: 'var(--bg-deep)', color: '#fff' }}
    >
      <span className="min-w-0">有新版本可用。刷新会中断当前连接，请先完成正在进行的传输。</span>
      <button
        type="button"
        onClick={() => { void reload() }}
        disabled={busy || reloading}
        // Disabled rather than hidden: the user can see the action exists
        // and why it isn't available yet.
        title={busy ? '有传输正在进行，完成后即可刷新' : undefined}
        className="text-xs underline decoration-dotted cursor-pointer disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60"
        style={{ background: 'transparent', border: 'none', color: 'var(--accent-cyan-on-blue)', padding: 0 }}
      >
        {reloading ? '刷新中…' : '安全时刷新'}
      </button>
      {busy && (
        <span className="text-[11px] w-full" style={{ color: 'var(--state-warn-on-blue)' }}>
          正在传输中，完成后再刷新
        </span>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="text-xs cursor-pointer"
        style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.75)', padding: '0 4px' }}
      >
        稍后
      </button>
    </div>
  )
}
