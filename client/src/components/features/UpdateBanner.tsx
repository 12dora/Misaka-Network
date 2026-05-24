import { useEffect, useState } from 'react'

/**
 * Listens for a {type:'sw-updated'} postMessage from the service worker and
 * surfaces a small fixed banner inviting the user to reload. The banner is
 * dismissible — some users explicitly don't want to be interrupted mid-task
 * and a stale shell is rarely a hard failure.
 *
 * The reload path also messages back to {type:'skip-waiting'} so a freshly
 * installed worker that was parked in 'waiting' can take over without the
 * user reopening the tab.
 */
export default function UpdateBanner() {
  const [available, setAvailable] = useState(false)
  const [dismissed, setDismissed] = useState(false)

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

  function reload() {
    // Best-effort: tell any 'waiting' worker to activate, then reload. Some
    // browsers don't expose `controller.postMessage` when no worker is
    // controlling yet; ignore failures and just reload.
    try {
      navigator.serviceWorker.getRegistration().then((reg) => {
        reg?.waiting?.postMessage({ type: 'skip-waiting' })
      })
    } catch { /* ignore */ }
    window.location.reload()
  }

  if (!available || dismissed) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 -translate-x-1/2 z-[130] px-4 py-2 rounded-lg shadow-lg flex items-center gap-3 font-kanji text-sm"
      style={{
        bottom: 'calc(env(safe-area-inset-bottom) + 16px)',
        background: 'var(--bg-deep)',
        color: '#fff',
        maxWidth: 'calc(100% - 32px)',
      }}
    >
      <span>新版本已就绪 — 刷新后立即生效</span>
      <button
        type="button"
        onClick={reload}
        className="text-xs underline decoration-dotted cursor-pointer"
        style={{ background: 'transparent', border: 'none', color: 'var(--accent-cyan)', padding: 0 }}
      >
        立即刷新
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="稍后提醒"
        className="text-xs cursor-pointer"
        style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.6)', padding: '0 4px' }}
      >
        稍后
      </button>
    </div>
  )
}
