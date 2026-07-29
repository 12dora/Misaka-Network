// 08 P1 — Scan loop decoder policy (behavioural, not source-regex).
//
// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'
import { createQrScanLoop, SCAN_INTERVAL_MS } from '../../src/lib/qrScanLoop'

function fakeVideo(): HTMLVideoElement {
  return { readyState: 2 } as HTMLVideoElement
}

describe('08 P1: QR scan loop efficiency', () => {
  it('constructs the native detector once per session', async () => {
    const detect = vi.fn().mockResolvedValue([])
    const createDetector = vi.fn(() => ({ detect }))
    const scanWithJsQR = vi.fn(() => null)

    const loop = createQrScanLoop({ createDetector, scanWithJsQR, intervalMs: 0 })
    expect(loop.detectorConstructCount).toBe(1)
    expect(createDetector).toHaveBeenCalledTimes(1)

    const video = fakeVideo()
    await loop.tick(0, video)
    await loop.tick(10, video)
    await loop.tick(20, video)

    // Still a single construction; multiple ticks reuse it.
    expect(createDetector).toHaveBeenCalledTimes(1)
    expect(loop.stats.nativeCalls).toBe(3)
  })

  it('does not call jsQR after a native miss', async () => {
    const detect = vi.fn().mockResolvedValue([]) // miss
    const createDetector = vi.fn(() => ({ detect }))
    const scanWithJsQR = vi.fn(() => 'should-not-run')

    const loop = createQrScanLoop({ createDetector, scanWithJsQR, intervalMs: 0 })
    const result = await loop.tick(0, fakeVideo())

    expect(result).toBeNull()
    expect(loop.stats.nativeCalls).toBe(1)
    expect(loop.stats.jsQrCalls).toBe(0)
    expect(scanWithJsQR).not.toHaveBeenCalled()
  })

  it('falls back to jsQR only after native throws (session broken)', async () => {
    const detect = vi.fn()
      .mockRejectedValueOnce(new Error('native broke'))
    const createDetector = vi.fn(() => ({ detect }))
    const scanWithJsQR = vi.fn(() => 'from-jsqr')

    const loop = createQrScanLoop({ createDetector, scanWithJsQR, intervalMs: 0 })
    const video = fakeVideo()

    // First tick: native throws → disable for session, no jsQR same tick.
    expect(await loop.tick(0, video)).toBeNull()
    expect(loop.stats.jsQrCalls).toBe(0)
    expect(loop.usesNative()).toBe(false)

    // Second tick: jsQR only.
    expect(await loop.tick(10, video)).toBe('from-jsqr')
    expect(loop.stats.jsQrCalls).toBe(1)
    expect(detect).toHaveBeenCalledTimes(1)
  })

  it('uses jsQR when native is unavailable', async () => {
    const scanWithJsQR = vi.fn(() => 'only-js')
    const loop = createQrScanLoop({
      createDetector: () => null,
      scanWithJsQR,
      intervalMs: 0,
    })
    expect(await loop.tick(0, fakeVideo())).toBe('only-js')
    expect(loop.stats.nativeCalls).toBe(0)
    expect(loop.stats.jsQrCalls).toBe(1)
  })

  it('throttles to SCAN_INTERVAL_MS', async () => {
    const detect = vi.fn().mockResolvedValue([])
    const loop = createQrScanLoop({
      createDetector: () => ({ detect }),
      scanWithJsQR: () => null,
      intervalMs: SCAN_INTERVAL_MS,
    })
    const video = fakeVideo()
    await loop.tick(0, video)
    await loop.tick(SCAN_INTERVAL_MS - 1, video)
    expect(loop.stats.nativeCalls).toBe(1)
    await loop.tick(SCAN_INTERVAL_MS, video)
    expect(loop.stats.nativeCalls).toBe(2)
  })

  it('skips work while the document is hidden', async () => {
    const detect = vi.fn().mockResolvedValue([])
    const loop = createQrScanLoop({
      createDetector: () => ({ detect }),
      scanWithJsQR: () => null,
      intervalMs: 0,
    })
    await loop.tick(0, fakeVideo(), { hidden: true })
    expect(loop.stats.nativeCalls).toBe(0)
  })
})
