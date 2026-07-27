// BUG-026 — the candidate timer used to start before createOffer(), but the
// function still awaited createOffer first. A browser promise that never
// settled therefore made the entire NAT diagnostic hang forever.
//
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectNatType } from '../../src/lib/nat'
import { NAT_DETECTION_TIMEOUT_MS } from '../../src/constants'

const original = globalThis.RTCPeerConnection

afterEach(() => {
  globalThis.RTCPeerConnection = original
  vi.useRealTimers()
})

describe('BUG-026 NAT outer deadline', () => {
  it('rejects and closes when createOffer never resolves', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    globalThis.RTCPeerConnection = function () {
      return {
        createDataChannel: () => ({}),
        createOffer: () => new Promise(() => {}),
        setLocalDescription: async () => {},
        close,
      }
    } as unknown as typeof RTCPeerConnection

    const pending = detectNatType([])
    const assertion = expect(pending).rejects.toThrow('NAT_DETECTION_TIMEOUT')
    await vi.advanceTimersByTimeAsync(NAT_DETECTION_TIMEOUT_MS + 1)

    await assertion
    expect(close).toHaveBeenCalled()
  })
})
