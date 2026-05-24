// P1-4: ICE restart used to bail out silently when signalingState was
// anything other than 'stable' (mid offer/answer roundtrip). Without a way
// to re-queue the restart, the connection sat in `disconnected` until the
// next user action. Expose a helper that resolves the next time the PC
// transitions back to 'stable'.

import { describe, it, expect, vi } from 'vitest'
import { whenSignalingStable } from '../../src/lib/webrtc'

function makePcStub(initial: RTCSignalingState) {
  const listeners = new Set<(ev?: Event) => void>()
  const pc: any = {
    signalingState: initial,
    addEventListener: vi.fn((evt: string, cb: (ev?: Event) => void) => {
      if (evt === 'signalingstatechange') listeners.add(cb)
    }),
    removeEventListener: vi.fn((evt: string, cb: (ev?: Event) => void) => {
      if (evt === 'signalingstatechange') listeners.delete(cb)
    }),
    _transition: (next: RTCSignalingState) => {
      pc.signalingState = next
      for (const cb of [...listeners]) cb()
    },
  }
  return pc
}

describe('whenSignalingStable', () => {
  it('resolves immediately when the PC is already stable', async () => {
    const pc = makePcStub('stable')
    await expect(whenSignalingStable(pc)).resolves.toBeUndefined()
  })

  it('waits for the next "signalingstatechange" → stable transition', async () => {
    const pc = makePcStub('have-local-offer')
    let resolved = false
    const promise = whenSignalingStable(pc).then(() => { resolved = true })

    // Spurious intermediate transition that is not stable — must not resolve.
    pc._transition('have-remote-pranswer')
    await Promise.resolve()
    expect(resolved).toBe(false)

    pc._transition('stable')
    await promise
    expect(resolved).toBe(true)
  })

  it('detaches its listener after resolving', async () => {
    const pc = makePcStub('have-local-offer')
    const p = whenSignalingStable(pc)
    pc._transition('stable')
    await p
    expect(pc.removeEventListener).toHaveBeenCalledWith('signalingstatechange', expect.any(Function))
  })

  it('rejects if the optional AbortSignal aborts before stable', async () => {
    const pc = makePcStub('have-local-offer')
    const ctrl = new AbortController()
    const p = whenSignalingStable(pc, { signal: ctrl.signal })
    ctrl.abort()
    await expect(p).rejects.toThrow(/abort/i)
  })

  it('respects a timeout option and rejects if stable never arrives', async () => {
    vi.useFakeTimers()
    try {
      const pc = makePcStub('have-local-offer')
      const p = whenSignalingStable(pc, { timeoutMs: 100 })
      // Surface unhandled-rejection warnings as test failures by attaching now.
      const tracked = p.then(
        () => { throw new Error('should not resolve') },
        (err) => err,
      )
      vi.advanceTimersByTime(150)
      const err = await tracked
      expect(String(err)).toMatch(/timeout/i)
    } finally {
      vi.useRealTimers()
    }
  })
})
