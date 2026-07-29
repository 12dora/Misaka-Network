/**
 * QR scan-loop policy for ScanModal.
 *
 * 08 P1: BarcodeDetector is constructed once per session; a native miss must
 * NOT fall through to jsQR on the same tick (that dual-decode path overheated
 * phones). jsQR is only used when native is unavailable or has failed for the
 * session.
 */

export const SCAN_INTERVAL_MS = 200

export interface QrDetector {
  detect(image: ImageBitmapSource): Promise<{ rawValue: string }[]>
}

export interface QrScanLoop {
  /** How many times the native detector factory ran (0 or 1 for a healthy session). */
  readonly detectorConstructCount: number
  /** True when the loop will use native for the next eligible tick. */
  usesNative(): boolean
  /**
   * Attempt one throttled decode. Returns the raw QR string when found,
   * otherwise null. Counts detector/jsQR invocations for tests.
   */
  tick(
    now: number,
    video: HTMLVideoElement | null,
    opts?: { hidden?: boolean },
  ): Promise<string | null>
  /** Test hooks */
  readonly stats: { nativeCalls: number; jsQrCalls: number }
}

export interface CreateQrScanLoopOptions {
  createDetector: () => QrDetector | null
  scanWithJsQR: (video: HTMLVideoElement) => string | null | Promise<string | null>
  intervalMs?: number
}

export function createQrScanLoop(options: CreateQrScanLoopOptions): QrScanLoop {
  const intervalMs = options.intervalMs ?? SCAN_INTERVAL_MS
  let detector: QrDetector | null = null
  let nativeUnavailable = false
  let constructCount = 0
  // -Infinity so the first eligible tick is never throttled away.
  let lastScanAt = Number.NEGATIVE_INFINITY
  const stats = { nativeCalls: 0, jsQrCalls: 0 }

  try {
    detector = options.createDetector()
    constructCount += 1
    if (!detector) nativeUnavailable = true
  } catch {
    detector = null
    nativeUnavailable = true
    constructCount += 1
  }

  return {
    get detectorConstructCount() {
      return constructCount
    },
    usesNative() {
      return !!detector && !nativeUnavailable
    },
    stats,
    async tick(now, video, opts) {
      if (opts?.hidden) return null
      if (!video) return null
      if (now - lastScanAt < intervalMs) return null
      lastScanAt = now

      if (detector && !nativeUnavailable) {
        stats.nativeCalls += 1
        try {
          const codes = await detector.detect(video)
          if (codes.length > 0) return codes[0].rawValue
          // Miss is normal — do NOT fall through to jsQR when native works.
          return null
        } catch {
          nativeUnavailable = true
          detector = null
          return null
        }
      }

      stats.jsQrCalls += 1
      return (await options.scanWithJsQR(video)) ?? null
    },
  }
}
