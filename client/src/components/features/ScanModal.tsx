import { useEffect, useId, useRef, useState } from 'react'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import MisakaDialog from '@/components/ui/MisakaDialog'
import { useModalExit } from '@/hooks/useModalExit'
import { createCameraController } from '@/hooks/useCameraStream'
import { parseJoinLink, describeJoinLinkRejection } from '@/components/features/joinLink'
import { createQrScanLoop, SCAN_INTERVAL_MS } from '@/lib/qrScanLoop'
import { network as netCopy } from '@/copy/zh-CN/network'
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
      case 'NotAllowedError':       return netCopy.scan.permissionDenied
      case 'NotFoundError':         return netCopy.scan.notFound
      case 'NotReadableError':      return netCopy.scan.inUse
      case 'OverconstrainedError':  return netCopy.scan.overconstrained
      case 'SecurityError':         return netCopy.scan.security
      case 'AbortError':            return netCopy.scan.aborted
    }
  }
  // UX-COPY-004: never surface the raw exception text — it used to print
  // browser-internal messages straight into the modal.
  return netCopy.scan.genericFail
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
  const [acquiring, setAcquiring] = useState(false)
  const modal = useModalExit(onClose)
  const animRef = useRef<number>(0)
  const warmTimerRef = useRef<number>(0)
  /** Bumped by stopScanLoop so an in-flight tick/warm-up aborts. */
  const scanGenRef = useRef(0)
  const inputId = useId()

  // SECURITY-012: one controller owns the camera for the whole lifetime of
  // the modal. Every acquisition path (mount, facing-mode change, Retry)
  // goes through it, so a stream that arrives after the modal closed is
  // stopped by its own request generation instead of being orphaned on a
  // detached ref.
  const cameraRef = useRef(createCameraController())

  // A FRESH controller per effect run, disposing only the superseded one.
  // Reusing one controller for the modal's whole lifetime looked simpler, but
  // dispose() is permanent: switching 摄像头 re-ran this effect, whose cleanup
  // disposed the shared controller, and every acquisition afterwards resolved
  // `stale` — the scanner was dead until the modal was reopened. React 18
  // StrictMode's mount/unmount/mount replay broke it the same way in dev.
  useEffect(() => {
    const camera = createCameraController()
    cameraRef.current = camera
    void startCamera()
    return () => {
      stopScanLoop()
      // dispose() bumps the generation synchronously, so a getUserMedia
      // still sitting on the permission prompt is already stale when it
      // resolves and stops its own tracks.
      camera.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode])

  function stopScanLoop() {
    scanGenRef.current += 1
    if (warmTimerRef.current) {
      window.clearTimeout(warmTimerRef.current)
      warmTimerRef.current = 0
    }
    if (animRef.current) {
      cancelAnimationFrame(animRef.current)
      animRef.current = 0
    }
  }

  async function startCamera() {
    const camera = cameraRef.current
    stopScanLoop()

    if (!navigator.mediaDevices?.getUserMedia) {
      setHasCamera(false)
      setCameraError(netCopy.scan.unsupported)
      return
    }
    if (!window.isSecureContext) {
      setHasCamera(false)
      setCameraError(netCopy.scan.needSecureContext)
      return
    }

    setAcquiring(true)
    try {
      // Use 'ideal' so the browser falls back to any available camera when
      // the requested facing mode is missing (common on desktops with only
      // a webcam).
      const result = await camera.acquire({
        video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 640 } },
        audio: false,
      })

      // Overlapping requests are refused by the controller; a double-tap on
      // Retry must not open a second camera.
      if (result.status === 'busy') return
      // The modal closed (or the facing mode changed) while the permission
      // prompt was open. The controller has already stopped the tracks.
      if (result.status === 'stale') return
      if (result.status === 'error') {
        setHasCamera(false)
        setCameraError(describeCameraError(result.error))
        return
      }

      if (videoRef.current) {
        videoRef.current.srcObject = result.stream
        try {
          await videoRef.current.play()
        } catch {
          // Some browsers reject play() until user gesture — the video element
          // will still render frames; ignore so scanning can proceed.
        }
      }
      // The play() await is another window in which the modal can close.
      if (camera.current() !== result.stream) return

      setHasCamera(true)
      setCameraError(null)
      // Probe device list after permission is granted — pre-permission the
      // browser returns blank labels and may hide some devices. We only show
      // the "切换摄像头" button when there is actually something to switch to.
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        if (camera.current() !== result.stream) return
        setCameraCount(devices.filter(d => d.kind === 'videoinput').length)
      } catch {
        setCameraCount(1)
      }
      startScanning(result.stream)
    } finally {
      setAcquiring(false)
    }
  }

  function stopCamera() {
    stopScanLoop()
    cameraRef.current.stop()
  }

  function startScanning(stream: MediaStream) {
    const camera = cameraRef.current
    const BarcodeDetectorCtor = (window as unknown as Record<string, unknown>).BarcodeDetector as typeof BarcodeDetector | undefined
    const gen = scanGenRef.current

    // 08 P1: detector once per session; native miss does not dual-decode.
    const loop = createQrScanLoop({
      intervalMs: SCAN_INTERVAL_MS,
      createDetector: () => {
        if (!BarcodeDetectorCtor) return null
        try {
          return new BarcodeDetectorCtor({ formats: ['qr_code'] })
        } catch {
          return null
        }
      },
      scanWithJsQR: (video) => {
        const canvas = canvasRef.current
        if (!canvas || video.readyState < 2) return null
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return null
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(imageData.data, imageData.width, imageData.height)
        return code?.data ?? null
      },
    })

    async function tick(now: number) {
      // Identity check, not just "is there a stream": after a facing-mode
      // switch the old loop must die rather than scan the new camera twice.
      if (scanGenRef.current !== gen || camera.current() !== stream) return
      const found = await loop.tick(now, videoRef.current, {
        hidden: typeof document !== 'undefined' && document.hidden,
      })
      // Root cause A: revalidate AFTER the await. A detector that resolves
      // during the 180 ms exit animation must not call setDetected — that
      // effect navigates even though the user already closed the modal.
      if (scanGenRef.current !== gen || camera.current() !== stream) return
      if (found) setDetected(found)
      if (scanGenRef.current !== gen || camera.current() !== stream) return
      animRef.current = requestAnimationFrame(tick)
    }

    // Small delay to let camera warm up
    warmTimerRef.current = window.setTimeout(() => {
      if (scanGenRef.current === gen && camera.current() === stream) {
        animRef.current = requestAnimationFrame(tick)
      }
    }, 500)
  }

  function switchCamera() {
    setFacingMode(prev => prev === 'environment' ? 'user' : 'environment')
  }

  function handleClose() {
    stopCamera()
    modal.requestClose()
  }

  // SECURITY-006 — the ONLY navigation path out of this modal.
  //
  // The old implementation handed anything `new URL()` accepted to
  // `window.location.href`: a foreign HTTPS origin navigated away from the
  // app, and `javascript:` / `data:` values were left to the browser and
  // CSP to stop. `parseJoinLink` allow-lists scheme, credentials, origin,
  // the exact join route and every query parameter, and returns a relative
  // path we build ourselves — the raw value never reaches the assignment.
  function openDetectedUrl(raw: string): boolean {
    const parsed = parseJoinLink(raw)
    if (!parsed.ok) {
      setManualError(describeJoinLinkRejection(parsed.reason))
      return false
    }
    window.location.href = parsed.path
    return true
  }

  function handleManualJoin() {
    setManualError(null)
    openDetectedUrl(manualUrl.trim())
  }

  // When QR detected, navigate. P1-7: openDetectedUrl returns false for
  // arbitrary QR codes (a Wi-Fi QR, a non-misaka URL, etc.). Previously
  // that branch silently no-op'd while the modal stayed open with the
  // "✓ 已识别" overlay — the user assumed the app was hung. Clear the
  // detected state, keep the camera alive so the user can try another code.
  useEffect(() => {
    if (!detected) return
    const ok = openDetectedUrl(detected)
    if (ok) {
      stopCamera()
      return
    }
    setDetected(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detected])

  return (
    <MisakaDialog
      title={netCopy.qr.scanNode}
      description={netCopy.qr.scanDescription}
      onRequestClose={handleClose}
      backdropClass={modal.backdropClass}
      panelClass={modal.panelClass}
      backdropStyle={{ background: 'rgba(14,42,107,0.55)', backdropFilter: 'blur(8px)' }}
      panelClassName="relative flex flex-col items-center gap-4 rounded-2xl p-5 xs:p-6 misaka-dialog-panel"
      panelStyle={{
        background: 'var(--surface)',
        boxShadow: 'var(--shadow-float)',
        width: 'min(340px, 100% - 8px)',
        overflowY: 'auto',
      }}
      renderHeader={({ titleId, descriptionId }) => (
        <div className="flex items-center gap-2">
          <MisakaKanjiBlock char="読" size="md" />
          <div>
            <h2 id={titleId} className="font-kanji font-bold text-base text-[var(--text-on-white)] m-0">
              {netCopy.qr.scanNode}
            </h2>
            <p id={descriptionId} className="font-kanji text-xs text-[var(--text-on-white-2)] m-0">
              {netCopy.qr.scanDescription}
            </p>
          </div>
        </div>
      )}
    >
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
            <p className="font-kanji text-xs text-[var(--text-on-blue-2)] break-words">
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
            <MisakaButton
              variant="pill"
              size="sm"
              onClick={() => { void startCamera() }}
              disabled={acquiring}
              className="mt-2"
            >
              {acquiring ? '启动中…' : '重试'}
            </MisakaButton>
          </div>
        )}
        {detected && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(14,42,107,0.72)' }}>
            {/* A11Y-002: this overlay sits on dark video, so it takes the
                on-blue variant, not the on-light one. */}
            <span className="font-kanji font-bold text-sm" style={{ color: 'var(--state-success-on-blue)' }}>✓ 已识别</span>
          </div>
        )}
      </div>

      {/* Manual entry — A11Y-004: real label association */}
      <div className="w-full rounded-xl p-3" style={{ background: 'var(--surface-tint)' }}>
        <label htmlFor={inputId} className="block font-kanji text-xs text-[var(--text-on-white-2)] mb-2">
          {netCopy.qr.pasteJoinLink}
        </label>
        <div className="flex gap-2">
          <input
            id={inputId}
            value={manualUrl}
            onChange={e => { setManualUrl(e.target.value); setManualError(null) }}
            onKeyDown={e => { if (e.key === 'Enter') handleManualJoin() }}
            placeholder={netCopy.qr.pasteJoinLink}
            aria-invalid={manualError ? true : undefined}
            aria-describedby={manualError ? `${inputId}-error` : undefined}
            className="misaka-input text-xs flex-1 min-w-0"
          />
          <MisakaButton variant="primary" size="sm" onClick={handleManualJoin} disabled={!manualUrl.trim()}>
            接入
          </MisakaButton>
        </div>
        {manualError && (
          <p
            id={`${inputId}-error`}
            className="font-kanji text-[11px] mt-2 leading-snug"
            style={{ color: 'var(--state-danger-on-light)' }}
            role="alert"
          >
            {manualError}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 w-full">
        {hasCamera && cameraCount > 1 && (
          <MisakaButton variant="pill" size="sm" fullWidth onClick={switchCamera} disabled={acquiring}>
            切换摄像头
          </MisakaButton>
        )}
        <MisakaButton variant="pill" size="sm" fullWidth onClick={handleClose}>
          取消
        </MisakaButton>
      </div>
    </MisakaDialog>
  )
}
