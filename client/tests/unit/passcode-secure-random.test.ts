// SECURITY-019: the 6-digit pass code (and the node id) must come from a
// CSPRNG, not `Math.random()`.
//
// The code space is only ~20 bits to begin with; drawing it from a
// non-cryptographic PRNG (V8's xorshift128+, seeded per tab and trivially
// recoverable from a few outputs) means an attacker who watches one
// regenerate can predict the next. `crypto.getRandomValues()` plus rejection
// sampling fixes both the source and the modulo bias.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { secureRandomInt, generatePassCode } from '../../src/lib/passcode'

describe('secureRandomInt', () => {
  it('draws from crypto.getRandomValues, never Math.random', () => {
    const cryptoSpy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    const mathSpy = vi.spyOn(Math, 'random')
    secureRandomInt(0, 999999)
    expect(cryptoSpy).toHaveBeenCalled()
    expect(mathSpy).not.toHaveBeenCalled()
  })

  it('stays inside the inclusive range over many draws', () => {
    for (let i = 0; i < 500; i++) {
      const v = secureRandomInt(1, 20001)
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(20001)
      expect(Number.isInteger(v)).toBe(true)
    }
  })

  it('rejects (re-draws) samples that would bias the modulo fold', () => {
    // range = 1_000_000 → limit = floor(2^32 / 1e6) * 1e6 = 4_294_000_000.
    // The first draw sits above the limit and MUST be discarded; a naive
    // `% range` implementation would return 500_000 instead of re-drawing.
    const draws = [4_294_500_000, 42]
    let i = 0
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((arr) => {
      ;(arr as Uint32Array)[0] = draws[Math.min(i++, draws.length - 1)]
      return arr
    })
    expect(secureRandomInt(0, 999999)).toBe(42)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('handles a single-value range without looping forever', () => {
    expect(secureRandomInt(7, 7)).toBe(7)
  })

  it('throws on an inverted range instead of silently returning NaN', () => {
    expect(() => secureRandomInt(10, 1)).toThrow(RangeError)
  })

  it('rejects a range larger than 2^32 instead of spinning forever', () => {
    expect(() => secureRandomInt(0, 0x1_0000_0000)).toThrow(RangeError)
  })
})

describe('generatePassCode', () => {
  it('always returns exactly six digits, zero-padded', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePassCode()).toMatch(/^\d{6}$/)
    }
  })

  it('zero-pads small draws instead of emitting a short code', () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((arr) => {
      ;(arr as Uint32Array)[0] = 7
      return arr
    })
    expect(generatePassCode()).toBe('000007')
  })
})

describe('auth store credential regeneration', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.resetModules()
  })

  it('regeneratePassCode / regenerateNodeId never touch Math.random', async () => {
    vi.resetModules()
    const mathSpy = vi.spyOn(Math, 'random')
    const { useAuthStore } = await import('../../src/store/auth')
    mathSpy.mockClear()

    useAuthStore.getState().regeneratePassCode()
    useAuthStore.getState().regenerateNodeId()

    expect(mathSpy).not.toHaveBeenCalled()
    expect(useAuthStore.getState().identity.passCode).toMatch(/^\d{6}$/)
    expect(useAuthStore.getState().identity.nodeId).toBeGreaterThanOrEqual(1)
  })
})
