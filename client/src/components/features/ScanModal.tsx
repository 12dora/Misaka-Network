import { useEffect, useRef, useState } from 'react'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import { useModalExit } from '@/hooks/useModalExit'
import { appUrl } from '@/lib/appBase'
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

function describeCameraError(err: unknown): string {
  if (typeof err === 'object' && err && 'name' in err) {
    const name = (err as { name: string }).name
    switch (name) {
      case 'NotAllowedError':       return '摄像头权限被拒绝，请在浏览器设置中允许'
      case 'NotFoundError':         return '未检测到摄像头设备'
      case 'NotReadableError':      return '摄像头被其他应用占用，请先关闭再试'
      case 'OverconstrainedError':  return '当前设备不支持所选摄像头方向，正在切换…'
      case 'SecurityError':         return '需要 HTTPS 或 localhost 才能使用摄像头'
      case 'AbortError':            return '摄像头启动被中断，请重试'
    }
    if ('message' in err) return String((err as { message: string }).message)
  }
  return String(err)
}

// P1: surface the "where do I open the camera permission" question with a
// concrete platform hint. Without this the only fallback the modal offered
// was a generic "请在浏览器设置中允许" — leaving mobile users hunting through
// system settings with no idea which menu hides the toggle.
function permissionHelpHint(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/iPhone|iPad|iPod/.test(ua)) {
    return 'iOS：设置 → Safari → 摄像头 → 改为「询问」或「允许」，然后回到本页点击重试。'
  }
  if (/Android/.test(ua)) {
    return 'Android：长按地址栏左侧的锁形图标 → 网站设置 → 摄像头 → 允许，然后刷新页面。'
  }
  if (/Mac OS X/.test(ua)) {
    return 'macOS：Safari/Chrome → 偏好设置/设置 → 网站 → 摄像头 → 允许本站。'
  }
  return '在浏览器地址栏点击锁形图标 → 网站设置 → 摄像头 → 允许，然后刷新页面。'
}

// Default to user-facing camera (most desktops only have one); user can toggle to rear.
type FacingMode = 'user' | 'environment'

export default function ScanModal({ onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hasCamera, setHasCamera] = useState(true)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [facingMode, setFacingMode] = useState<FacingMode>('user')
  const [detected, setDetected] = useState<string | null>(null)
  const [manualUrl, setManualUrl] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)
  const [cameraCount, setCameraCount] = useState(0)
  const modal = useModalExit(onClose)
  const streamRef = useRef<MediaStream | null>(null)
  const animRef = useRef<number>(0)

  useEffect(() => {
    startCamera()
    return () => stopCamera()
  }, [facingMode])

  async function startCamera() {
    stopCamera()

    if (!navigator.mediaDevices?.getUserMedia) {
      setHasCamera(false)
      setCameraError('此浏览器不支持摄像头 API')
      return
    }
    if (!window.isSecureContext) {
      setHasCamera(false)
      setCameraError('需要 HTTPS 或 localhost 才能使用摄像头')
      return
    }

    // Use 'ideal' so the browser falls back to any available camera when the
    // requested facing mode is missing (common on desktops with only a webcam).
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 640 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        try {
          await videoRef.current.play()
        } catch {
          // Some browsers reject play() until user gesture — the video element
          // will still render frames; ignore so scanning can proceed.
        }
      }
      setHasCamera(true)
      setCameraError(null)
      // Probe device list after permission is granted — pre-permission the
      // browser returns blank labels and may hide some devices. We only show
      // the "切换摄像头" button when there is actually something to switch to.
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        setCameraCount(devices.filter(d => d.kind === 'videoinput').length)
      } catch {
        setCameraCount(1)
      }
      startScanning()
    } catch (err) {
      setHasCamera(false)
      setCameraError(describeCameraError(err))
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
      modal.requestClose()
    }
  }

  function handleClose() {
    stopCamera()
    modal.requestClose()
  }

  function openDetectedUrl(raw: string) {
    try {
      const url = new URL(raw)
      const sameOrigin = url.origin === location.origin
      window.location.href = sameOrigin ? `${url.pathname}${url.search}${url.hash}` : raw
      return true
    } catch {
      if (raw.startsWith('misaka://')) {
        const path = raw.slice('misaka://'.length) || '/'
        window.location.href = appUrl(path.startsWith('/') ? path : `/${path}`)
        return true
      }
    }
    return false
  }

  function handleManualJoin() {
    setManualError(null)
    if (!openDetectedUrl(manualUrl.trim())) {
      setManualError('请输入有效的御坂网络 QR 链接')
    }
  }

  // When QR detected, navigate
  useEffect(() => {
    if (detected) {
      stopCamera()
      openDetectedUrl(detected)
    }
  }, [detected])

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center p-4 ${modal.backdropClass}`}
      style={{ background: 'rgba(14,42,107,0.55)', backdropFilter: 'blur(8px)' }}
      onClick={handleBackdrop}
    >
      <div
        className={`relative flex flex-col items-center gap-4 rounded-2xl p-5 xs:p-6 ${modal.panelClass}`}
        style={{
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-float)',
          // P0-2: gracefully shrink on 320px-class devices instead of relying
          // on width: 100% inside a fixed-padding backdrop.
          width: 'min(340px, 100% - 8px)',
          // P1-13: landscape phone / split-view iPad — without a maxHeight the
          // aspect-square camera + URL input + buttons overflow and the
          // "接入" / "取消" actions are off-screen.
          maxHeight: '90svh',
          overflowY: 'auto',
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
            <div className="font-kanji text-xs text-[var(--text-on-white-2)]">
              扫描或粘贴接入链接
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
            <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-4 text-center">
              <MisakaKanjiBlock char="禁" size="lg" />
              <p className="font-kanji text-sm text-[var(--text-on-blue-2)]">无法访问摄像头</p>
              <p className="font-kanji text-xs text-[var(--text-muted)] break-words">
                {cameraError ?? '请检查权限设置'}
              </p>
              {/* P1: platform-specific guidance when the user previously
                  denied the prompt — otherwise they're stuck (the browser
                  won't re-prompt) with no path forward. */}
              {cameraError?.includes('权限') && (
                <p className="font-kanji text-[10px] text-[var(--text-on-blue-2)] break-words leading-snug px-2 mt-1">
                  {permissionHelpHint()}
                </p>
              )}
              <MisakaButton variant="pill" size="sm" onClick={startCamera} className="mt-2">
                重试
              </MisakaButton>
            </div>
          )}
          {detected && (
            <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,194,138,0.15)' }}>
              <span className="font-kanji font-bold text-sm" style={{ color: 'var(--state-success)' }}>✓ 已识别</span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="w-full rounded-xl p-3" style={{ background: 'var(--surface-tint)' }}>
          <label className="block font-kanji text-xs text-[var(--text-on-white-2)] mb-2">
            粘贴 QR 链接
          </label>
          <div className="flex gap-2">
            <input
              value={manualUrl}
              onChange={e => setManualUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleManualJoin() }}
              placeholder="http://localhost:5173/join?..."
              className="misaka-input text-xs flex-1"
            />
            <MisakaButton variant="primary" size="sm" onClick={handleManualJoin} disabled={!manualUrl.trim()}>
              接入
            </MisakaButton>
          </div>
          {manualError && (
            <p className="font-kanji text-[10px] text-[var(--state-danger)] mt-2">{manualError}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 w-full">
          {hasCamera && cameraCount > 1 && (
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
