import { useEffect, useRef, useState, useCallback } from 'react'
import QRCode from 'qrcode'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import MisakaDialog from '@/components/ui/MisakaDialog'
import { useAuthStore } from '@/store/auth'
import { authedFetch, AuthRequiredError } from '@/lib/api'
import { playSound } from '@/lib/sound'
import { appUrl } from '@/lib/appBase'
import { useModalExit } from '@/hooks/useModalExit'

interface Props {
  nodeId: number
  passCode: string
  qrType?: 'node' | 'file' | 'channel'
  fileSessionId?: string
  channelId?: string
  onClose: () => void
}

function buildURL(
  type: string,
  nodeId: number,
  qrToken: string,
  fileSessionId?: string,
  channelId?: string,
) {
  const base = appUrl('/join')
  const params = new URLSearchParams({ type, id: String(nodeId), t: qrToken })
  if (type === 'file' && fileSessionId) params.set('fid', fileSessionId)
  if (type === 'channel' && channelId) params.set('cid', channelId)
  return `${base}?${params.toString()}`
}

// UX-LAYOUT-006: the QR was a hard 220 px inside 12 px of padding, giving a
// 244 px frame against a ~232 px content box on a 320 px phone — it stuck
// out of the modal. Render at a responsive size, keeping the quiet zone
// (margin: 2 modules) intact so scanners still lock on.
const QR_MAX_PX = 220
const QR_RENDER_PX = 440   // render at 2× and downscale for crisp display

export default function QRModal({ nodeId, passCode, qrType = 'node', fileSessionId, channelId, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [qrToken, setQrToken] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [qrError, setQrError] = useState<string | null>(null)
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null)
  const [copyToast, setCopyToast] = useState<string | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)
  const [canShare, setCanShare] = useState(false)
  const linkRef = useRef<HTMLInputElement>(null)
  const session = useAuthStore(s => s.session)
  const modal = useModalExit(onClose)

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function')
  }, [])

  const fetchToken = useCallback(async () => {
    if (!session?.token) return
    setLoading(true)
    setQrError(null)
    try {
      const res = await authedFetch('/api/qr-token', { method: 'POST' })
      if (res.ok) {
        const data = await res.json() as { qrToken: string; channelId: string; expiresAt: number }
        setQrToken(data.qrToken)
        setExpiresAt(data.expiresAt)
        playSound('scan')
        // No channel-switch needed: clusters are now identity-scoped, so a
        // scanner who joins with the same nodeId+passcode lands automatically.
      } else {
        setQrError(`QR 令牌获取失败（HTTP ${res.status}）`)
      }
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        setQrError('会话已失效，请重新接入后再试')
      } else {
        setQrError('QR 令牌获取失败，请检查后端连接')
      }
    }
    setLoading(false)
  }, [session?.token])

  useEffect(() => {
    fetchToken()
  }, [fetchToken])

  const shareUrl = qrToken
    ? buildURL(qrType, nodeId, qrToken, fileSessionId, channelId)
    : ''

  // Draw QR
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !qrToken) return
    const url = buildURL(qrType, nodeId, qrToken, fileSessionId, channelId)
    setQrError(null)
    QRCode.toCanvas(canvas, url, {
      width: QR_RENDER_PX,
      margin: 2,
      color: { dark: '#0E2A6B', light: '#FFFFFF' },
    }, (err) => {
      if (!err) {
        setQrImageUrl(canvas.toDataURL('image/png'))
        return
      }
      QRCode.toDataURL(url, {
        width: QR_RENDER_PX,
        margin: 2,
        color: { dark: '#0E2A6B', light: '#FFFFFF' },
      })
        .then(setQrImageUrl)
        .catch(() => setQrError('QR 渲染失败，请刷新重试'))
    })
  }, [qrToken, nodeId, qrType, fileSessionId, channelId])

  // BUG-031: the old failure path told the user to "手动选取下方链接" — there
  // was no link anywhere in the modal. And the feedback lived in an
  // absolutely positioned `-bottom-10` div inside an `overflow-y: auto`
  // panel, so on a short viewport it was clipped out of existence.
  // The URL is now always rendered as a selectable read-only field, the
  // feedback sits in normal flow, and we offer the system share sheet
  // (which works in the WebView/iOS cases where clipboard is denied).
  async function handleCopy() {
    if (!shareUrl) return
    setCopyFailed(false)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(shareUrl)
      setCopyToast('链接已复制')
    } catch {
      setCopyFailed(true)
      setCopyToast('无法复制链接。请长按下方链接复制，或使用系统分享。')
      // Select the text so a long-press / Ctrl+C lands on the whole URL.
      try {
        linkRef.current?.focus()
        linkRef.current?.select()
      } catch { /* ignore */ }
    }
    window.setTimeout(() => setCopyToast(null), 4000)
  }

  async function handleShare() {
    if (!shareUrl) return
    try {
      await navigator.share({ url: shareUrl, title: '御坂网络接入链接' })
    } catch {
      // User cancelled the sheet, or share is unavailable — no error state,
      // the link is still on screen and copy is still offered.
    }
  }

  const qrLabel = {
    node: '节点 QR',
    file: '文件 QR',
    channel: '批次 QR',
  }[qrType]

  return (
    <MisakaDialog
      title="我的接入 QR"
      description="用于让其他设备接入当前节点"
      onRequestClose={modal.requestClose}
      backdropClass={modal.backdropClass}
      panelClass={modal.panelClass}
      backdropStyle={{ background: 'rgba(14,42,107,0.75)', backdropFilter: 'blur(10px)' }}
      panelClassName="relative flex flex-col items-center gap-5 rounded-2xl p-6 xs:p-8"
      panelStyle={{
        background: 'var(--surface)',
        boxShadow: 'var(--shadow-float)',
        // P0-2: drop the hard `minWidth: 300`. On a 320px-wide iPhone SE
        // with the outer `p-4` (16px) backdrop padding, available content
        // width is 288px — the old minWidth would force horizontal
        // overflow. Use a clamp so the modal still tries to be 360px on
        // wider screens but gracefully shrinks down on phones.
        width: 'min(360px, 100% - 8px)',
        // P1-13: previously had no maxHeight, so on iPhone landscape /
        // iPad split-view the QR + node info + buttons stack ran off the
        // viewport and the close / refresh / copy actions became
        // unreachable. Cap to 90svh with internal scroll.
        maxHeight: '90svh',
        overflowY: 'auto',
      }}
      renderHeader={({ titleId, descriptionId }) => (
        <>
          {/* Close */}
          <button
            className="tap-target absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-full cursor-pointer hover:opacity-70 transition-opacity"
            style={{ border: 'none', background: 'var(--surface-tint)', color: 'var(--text-on-white)' }}
            onClick={modal.requestClose}
            aria-label="关闭接入 QR"
          >
            ✕
          </button>

          {/* Header */}
          <div className="flex items-center gap-2">
            <MisakaKanjiBlock char="我" size="md" />
            <div>
              <h2 id={titleId} className="font-kanji font-bold text-base text-[var(--text-on-white)] m-0">
                我的接入 QR
              </h2>
              <p id={descriptionId} className="font-kanji text-xs text-[var(--text-on-white-2)] m-0">
                用于让其他设备接入当前节点
              </p>
            </div>
          </div>
        </>
      )}
    >
      {/* QR type badge */}
      <span
        className="font-kanji text-[11px] px-2 py-0.5 rounded-full"
        style={{ background: 'var(--surface-tint)', color: 'var(--text-on-white-2)' }}
      >
        {qrLabel}
      </span>

      {/* QR canvas — UX-LAYOUT-006: never wider than the content box. */}
      <div
        className="corner-frame relative w-full"
        style={{
          padding: 12,
          background: '#FFFFFF',
          borderRadius: 8,
          maxWidth: QR_MAX_PX + 24,
          margin: '0 auto',
        }}
      >
        {loading && !qrToken ? (
          <div className="w-full aspect-square flex items-center justify-center" style={{ maxWidth: QR_MAX_PX }}>
            <span className="font-kanji text-sm text-[var(--text-muted-on-light)]">生成中…</span>
          </div>
        ) : qrError ? (
          <div className="w-full aspect-square flex flex-col items-center justify-center gap-2 px-4 text-center" style={{ maxWidth: QR_MAX_PX }}>
            <MisakaKanjiBlock char="失" size="lg" />
            <span className="font-kanji text-sm" style={{ color: 'var(--state-danger-on-light)' }}>{qrError}</span>
          </div>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              width={QR_RENDER_PX}
              height={QR_RENDER_PX}
              className={qrImageUrl ? 'hidden' : 'block'}
              style={{ width: '100%', maxWidth: QR_MAX_PX, height: 'auto' }}
            />
            {qrImageUrl && (
              <img
                src={qrImageUrl}
                alt="接入 QR"
                style={{ width: '100%', maxWidth: QR_MAX_PX, height: 'auto', display: 'block' }}
              />
            )}
            {/* UX-MOTION-002: the animated scan line used to sweep across the
                *displayed* QR. It is pure decoration and it obscures
                machine-readable data — a scanner sampling mid-sweep sees a
                2 px band of cyan across the modules. Removed here; the
                scanner modal (where a sweep actually means something) keeps
                it. */}
            <div
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
              style={{ opacity: 0.12 }}
              aria-hidden="true"
            >
              <MisakaKanjiBlock char="御" size="xl" />
            </div>
          </>
        )}
      </div>

      {/* Node info */}
      <div className="text-center">
        <div className="font-kanji font-bold text-sm text-[var(--text-on-white)]">
          御坂 {nodeId} 号
        </div>
        <div className="font-kanji text-xs text-[var(--text-on-white-2)]">
          当前节点
        </div>
      </div>

      {/* Pass code */}
      <div className="text-center">
        <div className="font-kanji text-xs text-[var(--text-on-white-2)] mb-1">通行码</div>
        <div className="font-mono font-bold text-xl tracking-[0.25em] text-[var(--text-on-white)]">
          {passCode}
        </div>
      </div>

      <p className="font-kanji text-[11px] text-[var(--text-on-white-2)] leading-snug w-full m-0">
        链接仅包含一次性接入令牌，不包含可重复使用的通行码。扫码设备仍需单独输入通行码。
      </p>

      {/* Expiry */}
      {expiresAt > 0 && (
        <div className="font-mono text-[10px] text-[var(--text-muted-on-light)]">
          {new Date(expiresAt).toLocaleTimeString()} 前有效
        </div>
      )}

      {/* BUG-031: the link is ALWAYS on screen and selectable, so "长按下方
          链接复制" refers to something that exists. */}
      {shareUrl && (
        <div className="w-full flex flex-col gap-1">
          <label htmlFor="qr-share-url" className="font-kanji text-[11px] text-[var(--text-on-white-2)]">
            接入链接
          </label>
          <input
            id="qr-share-url"
            ref={linkRef}
            readOnly
            value={shareUrl}
            onFocus={e => e.currentTarget.select()}
            className="misaka-input font-mono"
            style={{ fontSize: 12 }}
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 w-full">
        {/* `loading` is set during BOTH first-fetch and refresh in fetchToken,
            so disabling here also prevents spam-clicking during refresh. */}
        <MisakaButton variant="pill" size="sm" fullWidth onClick={fetchToken} disabled={loading}>
          {loading && qrToken ? '刷新中…' : '刷新 QR'}
        </MisakaButton>
        <MisakaButton variant="pill" size="sm" fullWidth onClick={handleCopy} disabled={!qrToken || loading}>
          复制链接
        </MisakaButton>
      </div>

      {canShare && shareUrl && (
        <MisakaButton variant="pill" size="sm" fullWidth onClick={handleShare}>
          系统分享
        </MisakaButton>
      )}

      {/* Feedback in normal flow — never clipped by the panel's overflow. */}
      {copyToast && (
        <p
          className="w-full text-center px-3 py-1.5 rounded-md text-xs font-kanji leading-snug"
          style={{
            background: 'var(--surface-tint)',
            color: copyFailed ? 'var(--state-warn-on-light)' : 'var(--text-on-white)',
          }}
          role="status"
        >
          {copyToast}
        </p>
      )}

      <MisakaButton variant="pill" size="sm" fullWidth onClick={modal.requestClose}>
        关闭
      </MisakaButton>
    </MisakaDialog>
  )
}
