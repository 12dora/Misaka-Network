// P2-8: STUN/TURN reachability failures arrive via `icecandidateerror`
// events. The store can read the latest one for the diagnostics UI via
// getLastIceError(pc) — no per-call-site listener management.

import { describe, it, expect, vi } from 'vitest'
import { installIceErrorListener, getLastIceError } from '../../src/lib/webrtc'

function makePc() {
  const listeners = new Map<string, ((ev?: any) => void)[]>()
  const pc: any = {
    addEventListener: vi.fn((evt: string, cb: (ev?: any) => void) => {
      const arr = listeners.get(evt) ?? []
      arr.push(cb)
      listeners.set(evt, arr)
    }),
    removeEventListener: vi.fn((evt: string, cb: (ev?: any) => void) => {
      const arr = listeners.get(evt) ?? []
      listeners.set(evt, arr.filter(f => f !== cb))
    }),
    _fire: (evt: string, payload: any) => {
      for (const cb of listeners.get(evt) ?? []) cb(payload)
    },
  }
  return pc
}

describe('getLastIceError', () => {
  it('returns null before any error fires', () => {
    const pc = makePc()
    installIceErrorListener(pc)
    expect(getLastIceError(pc)).toBeNull()
  })

  it('captures the most recent icecandidateerror payload', () => {
    const pc = makePc()
    installIceErrorListener(pc)

    pc._fire('icecandidateerror', {
      errorCode: 701,
      errorText: 'STUN host lookup failed',
      url: 'stun:stun.dead.example.com:3478',
      address: '192.168.1.10',
    })

    const err = getLastIceError(pc)
    expect(err).not.toBeNull()
    expect(err!.errorCode).toBe(701)
    expect(err!.url).toBe('stun:stun.dead.example.com:3478')
    expect(err!.hostCandidate).toBe('192.168.1.10')
    expect(err!.at).toBeTypeOf('number')
  })

  it('overwrites with the latest error on a second fire', () => {
    const pc = makePc()
    installIceErrorListener(pc)

    pc._fire('icecandidateerror', { errorCode: 701, url: 'stun:a', address: 'A' })
    pc._fire('icecandidateerror', { errorCode: 401, url: 'turn:b', hostCandidate: 'B' })

    const err = getLastIceError(pc)
    expect(err!.errorCode).toBe(401)
    expect(err!.url).toBe('turn:b')
    expect(err!.hostCandidate).toBe('B')
  })

  it('isolates per-PC errors — distinct PCs do not bleed', () => {
    const pcA = makePc()
    const pcB = makePc()
    installIceErrorListener(pcA)
    installIceErrorListener(pcB)

    pcA._fire('icecandidateerror', { errorCode: 701, url: 'stun:a' })
    expect(getLastIceError(pcB)).toBeNull()
    expect(getLastIceError(pcA)!.errorCode).toBe(701)
  })
})
