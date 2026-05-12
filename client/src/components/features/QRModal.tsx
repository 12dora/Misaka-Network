import { useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'

interface Props {
  nodeId: number
  passCode: string
  onClose: () => void
}

function buildPayload(nodeId: number, passCode: string) {
  return `misaka://join?node=${nodeId}&pass=${passCode}`
}

export default function QRModal({ nodeId, passCode, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    QRCode.toCanvas(canvas, buildPayload(nodeId, passCode), {
      width: 220,
      margin: 2,
      color: { dark: '#0E2A6B', light: '#FFFFFF' },
    })
  }, [nodeId, passCode])

  // Close on backdrop click
  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(14,42,107,0.75)', backdropFilter: 'blur(10px)' }}
      onClick={handleBackdrop}
    >
      {/* Modal card */}
      <div
        className="relative flex flex-col items-center gap-6 rounded-2xl p-8"
        style={{
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-float)',
          minWidth: 300,
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
          <MisakaKanjiBlock char="御" size="md" />
          <div>
            <div className="font-kanji font-bold text-base text-[var(--text-on-white)]">
              御坂 {nodeId} 号
            </div>
            <div className="font-jp text-xs text-[var(--text-on-white-2)]">
              みさか {nodeId} ごう
            </div>
          </div>
        </div>

        {/* QR code with corner frame + scan line */}
        <div
          className="corner-frame relative"
          style={{ padding: 12, background: '#FFFFFF', borderRadius: 8 }}
        >
          <canvas ref={canvasRef} />
          {/* Scan line animation */}
          <div className="scan-line" />
          {/* Center "御" watermark */}
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            style={{ opacity: 0.12 }}
          >
            <MisakaKanjiBlock char="御" size="xl" />
          </div>
        </div>

        {/* Pass code */}
        <div className="text-center">
          <div className="font-kanji text-xs text-[var(--text-on-white-2)] mb-1">通行码</div>
          <div className="font-mono font-bold text-xl tracking-[0.25em] text-[var(--text-on-white)]">
            {passCode}
          </div>
        </div>

        {/* Hint */}
        <p className="font-kanji text-xs text-[var(--text-on-white-2)] text-center leading-relaxed max-w-[220px]">
          让对方扫码或手动输入编号与通行码即可建立连接
        </p>

        <MisakaButton variant="pill" size="sm" fullWidth onClick={onClose}>
          关闭
        </MisakaButton>
      </div>
    </div>
  )
}
