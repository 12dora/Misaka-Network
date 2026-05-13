import { useEffect, useRef, useState } from 'react'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import jsQR from 'jsqr'

interface Props {
  onClose: () => void
}

// BarcodeDetector is not in all TypeScript libs
declare class BarcodeDetector {
  constructor(opts: { formats: string[] })
  static getSupportedFormats(): Promise<string[]>
  detect(image: ImageBitmapSource): Promise<{ rawValue: string }[]>
}

export default function ScanModal({ onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hasCamera, setHasCamera] = useState(true)
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment')
  const [detected, setDetected] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animRef = useRef<number>(0)

  useEffect(() => {
    startCamera()
    return () => stopCamera()
  }, [facingMode])

  async function startCamera() {
    stopCamera()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 640 }, height: { ideal: 640 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setHasCamera(true)
      startScanning()
    } catch {
      setHasCamera(false)
    }
  }

  function stopCamera() {
    if (animRef.current) {
      cancelAnimationFrame(animRef.current)
      animRef.current = 0
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  }

  function startScanning() {
    const BarcodeDetectorCtor = (window as unknown as Record<string, unknown>).BarcodeDetector as typeof BarcodeDetector | undefined

    async function scanWithBarcodeDetector() {
      if (!videoRef.current || !BarcodeDetectorCtor) return false
      try {
        const detector = new BarcodeDetectorCtor({ formats: ['qr_code'] })
        const codes = await detector.detect(videoRef.current)
        if (codes.length > 0) {
          setDetected(codes[0].rawValue)
          return true
        }
      } catch { /* fall through */ }
      return false
    }

    async function scanWithJsQR() {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.readyState < 2) return false
      const ctx = canvas.getContext('2d')
      if (!ctx) return false
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(imageData.data, imageData.width, imageData.height)
      if (code) {
        setDetected(code.data)
        return true
      }
      return false
    }

    async function tick() {
      if (!streamRef.current) return
      const found = await scanWithBarcodeDetector()
      if (!found) await scanWithJsQR()
      animRef.current = requestAnimationFrame(tick)
    }

    // Small delay to let camera warm up
    setTimeout(() => {
      if (streamRef.current) tick()
    }, 500)
  }

  function switchCamera() {
    setFacingMode(prev => prev === 'environment' ? 'user' : 'environment')
  }

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) {
      stopCamera()
      onClose()
    }
  }

  function handleClose() {
    stopCamera()
    onClose()
  }

  // When QR detected, navigate
  useEffect(() => {
    if (detected) {
      stopCamera()
      // Parse URL and navigate
      try {
        new URL(detected)
        // Redirect to join flow
        window.location.href = detected
      } catch {
        // Not a URL, try custom protocol: misaka://join?...
        if (detected.startsWith('misaka://')) {
          const httpUrl = detected.replace('misaka://', `${location.origin}/`)
          window.location.href = httpUrl
        }
      }
    }
  }, [detected])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(14,42,107,0.55)', backdropFilter: 'blur(8px)' }}
      onClick={handleBackdrop}
    >
      <div
        className="relative flex flex-col items-center gap-4 rounded-2xl p-6"
        style={{
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-float)',
          maxWidth: 340,
          width: '100%',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2">
          <MisakaKanjiBlock char="読" size="md" />
          <div>
            <div className="font-kanji font-bold text-base text-[var(--text-on-white)]">
              扫描节点 QR
            </div>
            <div className="font-jp text-xs text-[var(--text-on-white-2)]">
              スキャン
            </div>
          </div>
        </div>

        {/* Accent line */}
        <div className="w-12 h-0.5" style={{ background: 'var(--accent-cyan)' }} />

        {/* Camera view */}
        <div className="corner-frame relative w-full aspect-square rounded-xl overflow-hidden" style={{ background: '#000' }}>
          {hasCamera ? (
            <>
              <video
                ref={videoRef}
                className="w-full h-full object-cover"
                playsInline
                muted
              />
              <canvas ref={canvasRef} className="hidden" />
              {/* Scan line */}
              <div className="scan-line" />
            </>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2">
              <MisakaKanjiBlock char="禁" size="lg" />
              <p className="font-kanji text-sm text-[var(--text-on-blue-2)]">无法访问摄像头</p>
              <p className="font-kanji text-xs text-[var(--text-muted)]">请检查权限设置</p>
            </div>
          )}
          {detected && (
            <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,194,138,0.15)' }}>
              <span className="font-kanji font-bold text-sm" style={{ color: 'var(--state-success)' }}>✓ 已识别</span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 w-full">
          {hasCamera && (
            <MisakaButton variant="pill" size="sm" fullWidth onClick={switchCamera}>
              切换摄像头
            </MisakaButton>
          )}
          <MisakaButton variant="pill" size="sm" fullWidth onClick={handleClose}>
            取消
          </MisakaButton>
        </div>
      </div>
    </div>
  )
}
