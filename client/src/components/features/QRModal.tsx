import { useEffect, useRef, useState, useCallback } from 'react'
import QRCode from 'qrcode'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
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
  passCode?: string,
  fileSessionId?: string,
  channelId?: string,
) {
  const base = appUrl('/join')
  const params = new URLSearchParams({ type, id: String(nodeId), t: qrToken })
  if (type === 'file' && fileSessionId) params.set('fid', fileSessionId)
  if (type === 'channel' && channelId) params.set('cid', channelId)
  if (passCode) params.set('c', btoa(passCode))
  return `${base}?${params.toString()}`
}

export default function QRModal({ nodeId, passCode, qrType = 'node', fileSessionId, channelId, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [qrToken, setQrToken] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number>(0)
  const [includePass, setIncludePass] = useState(false)
  const [loading, setLoading] = useState(true)
  const [qrError, setQrError] = useState<string | null>(null)
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null)
  const [copyToast, setCopyToast] = useState<string | null>(null)
  const session = useAuthStore(s => s.session)
  const modal = useModalExit(onClose)

  const fetchToken = useCallback(async () => {
    if (!session?.token) return
    setLoading(true)
    setQrError(null)
    try {
      const path = passCode
        ? `/api/qr-token?passCode=${encodeURIComponent(passCode)}`
        : '/api/qr-token'
      const res = await authedFetch(path)
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
  }, [session?.token, passCode])

  useEffect(() => {
    fetchToken()
  }, [fetchToken])

  // Draw QR
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !qrToken) return
    const url = buildURL(qrType, nodeId, qrToken, includePass ? passCode : undefined, fileSessionId, channelId)
    setQrError(null)
    QRCode.toCanvas(canvas, url, {
      width: 220,
      margin: 2,
      color: { dark: '#0E2A6B', light: '#FFFFFF' },
    }, (err) => {
      if (!err) {
        setQrImageUrl(canvas.toDataURL('image/png'))
        return
      }
      QRCode.toDataURL(url, {
        width: 220,
        margin: 2,
        color: { dark: '#0E2A6B', light: '#FFFFFF' },
      })
        .then(setQrImageUrl)
        .catch(() => setQrError('QR 渲染失败，请刷新重试'))
    })
  }, [qrToken, nodeId, passCode, includePass, qrType, fileSessionId, channelId])

  function handleCopy() {
    if (!qrToken) return
    const url = buildURL(qrType, nodeId, qrToken, includePass ? passCode : undefined, fileSessionId, channelId)
    // Clipboard API rejects in non-secure contexts and when permission is
    // denied — surface that to the user instead of silently failing so they
    // don't think they have a link they can paste.
    navigator.clipboard.writeText(url)
      .then(() => setCopyToast('链接已复制'))
      .catch(() => setCopyToast('复制失败，请手动选取下方链接'))
    window.setTimeout(() => setCopyToast(null), 2200)
  }

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) modal.requestClose()
  }

  const qrLabel = {
    node: '节点 QR',
    file: '文件 QR',
    channel: '批次 QR',
  }[qrType]

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center p-4 ${modal.backdropClass}`}
      style={{ background: 'rgba(14,42,107,0.75)', backdropFilter: 'blur(10px)' }}
      onClick={handleBackdrop}
    >
      <div
        className={`relative flex flex-col items-center gap-5 rounded-2xl p-8 ${modal.panelClass}`}
        style={{
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-float)',
          minWidth: 300,
          maxWidth: 360,
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Close */}
        <button
          className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-full cursor-pointer hover:opacity-70 transition-opacity"
          style={{ border: 'none', background: 'var(--surface-tint)', color: 'var(--text-on-white)' }}
          onClick={modal.requestClose}
          aria-label="关闭"
        >
          ✕
        </button>

        {/* Header */}
        <div className="flex items-center gap-2">
          <MisakaKanjiBlock char="我" size="md" />
          <div>
            <div className="font-kanji font-bold text-base text-[var(--text-on-white)]">
              我的接入 QR
            </div>
            <div className="font-kanji text-xs text-[var(--text-on-white-2)]">
              用于让其他设备接入当前节点
            </div>
          </div>
        </div>

        {/* QR type badge */}
        <span
          className="font-kanji text-[11px] px-2 py-0.5 rounded-full"
          style={{ background: 'var(--surface-tint)', color: 'var(--text-on-white-2)' }}
        >
          {qrLabel}
        </span>

        {/* QR canvas */}
        <div
          className="corner-frame relative"
          style={{ padding: 12, background: '#FFFFFF', borderRadius: 8 }}
        >
          {loading && !qrToken ? (
            <div className="w-[220px] h-[220px] flex items-center justify-center">
              <span className="font-kanji text-sm text-[var(--text-muted)]">生成中…</span>
            </div>
          ) : qrError ? (
            <div className="w-[220px] h-[220px] flex flex-col items-center justify-center gap-2 px-4 text-center">
              <MisakaKanjiBlock char="失" size="lg" />
              <span className="font-kanji text-sm text-[var(--state-danger)]">{qrError}</span>
            </div>
          ) : (
            <>
              <canvas ref={canvasRef} width={220} height={220} className={qrImageUrl ? 'hidden' : ''} />
              {qrImageUrl && <img src={qrImageUrl} alt="接入 QR" width={220} height={220} />}
              <div className="scan-line" />
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                style={{ opacity: 0.12 }}
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

        {/* Toggle: include passcode in QR */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={includePass}
            onChange={e => setIncludePass(e.target.checked)}
            className="w-4 h-4 rounded accent-[--bg-deep]"
          />
          <span className="font-kanji text-xs text-[var(--text-on-white-2)]">
            在 QR 中包含通行码（不安全）
          </span>
        </label>

        {/* Expiry */}
        {expiresAt > 0 && (
          <div className="font-mono text-[10px] text-[var(--text-muted)]">
            {new Date(expiresAt).toLocaleTimeString()} 前有效
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

        <MisakaButton variant="pill" size="sm" fullWidth onClick={modal.requestClose}>
          关闭
        </MisakaButton>

        {copyToast && (
          <div
            className="absolute -bottom-10 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md text-xs font-kanji whitespace-nowrap shadow-md"
            style={{ background: 'var(--bg-deep)', color: '#fff' }}
            role="status"
          >
            {copyToast}
          </div>
        )}
      </div>
    </div>
  )
}
