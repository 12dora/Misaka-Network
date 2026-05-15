import { useEffect, useRef, useState, useCallback } from 'react'
import QRCode from 'qrcode'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import { useAuthStore } from '@/store/auth'
import { apiUrl } from '@/config'
import { playSound } from '@/lib/sound'
import { appUrl } from '@/lib/appBase'

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
  const session = useAuthStore(s => s.session)

  const fetchToken = useCallback(async () => {
    if (!session?.token) return
    setLoading(true)
    try {
      const qrUrl = apiUrl('/api/qr-token')
      const qp = new URL(qrUrl, location.origin)
      if (passCode) qp.searchParams.set('passCode', passCode)
      const res = await fetch(qp.toString(), {
        headers: { Authorization: `Bearer ${session.token}` },
      })
      if (res.ok) {
        const data = await res.json() as { qrToken: string; channelId: string; expiresAt: number }
        setQrToken(data.qrToken)
        setExpiresAt(data.expiresAt)
        playSound('scan')
        // No channel-switch needed: clusters are now identity-scoped, so a
        // scanner who joins with the same nodeId+passcode lands automatically.
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [session?.token])

  useEffect(() => {
    fetchToken()
  }, [fetchToken])

  // Draw QR
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !qrToken) return
    const url = buildURL(qrType, nodeId, qrToken, includePass ? passCode : undefined, fileSessionId, channelId)
    QRCode.toCanvas(canvas, url, {
      width: 220,
      margin: 2,
      color: { dark: '#0E2A6B', light: '#FFFFFF' },
    })
  }, [qrToken, nodeId, passCode, includePass, qrType, fileSessionId, channelId])

  function handleCopy() {
    if (!qrToken) return
    const url = buildURL(qrType, nodeId, qrToken, includePass ? passCode : undefined, fileSessionId, channelId)
    navigator.clipboard.writeText(url).catch(() => {})
  }

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  const qrLabel = {
    node: '节点 QR',
    file: '文件 QR',
    channel: '批次 QR',
  }[qrType]

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(14,42,107,0.75)', backdropFilter: 'blur(10px)' }}
      onClick={handleBackdrop}
    >
      <div
        className="relative flex flex-col items-center gap-5 rounded-2xl p-8"
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
          onClick={onClose}
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
          ) : (
            <>
              <canvas ref={canvasRef} />
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
          <MisakaButton variant="pill" size="sm" fullWidth onClick={fetchToken}>
            刷新 QR
          </MisakaButton>
          <MisakaButton variant="pill" size="sm" fullWidth onClick={handleCopy}>
            复制链接
          </MisakaButton>
        </div>

        <MisakaButton variant="pill" size="sm" fullWidth onClick={onClose}>
          关闭
        </MisakaButton>
      </div>
    </div>
  )
}
