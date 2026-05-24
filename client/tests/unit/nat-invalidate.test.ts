// P1-6: when the network changes (`online`, `visibilitychange`) the cached
// NAT verdict from the last probe is stale — the user might now be on a
// different uplink with completely different NAT semantics. Expose a way
// to invalidate the cache so the next detectNatType() re-probes.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  setDetectedNatType, getDetectedNatType, onNatTypeChange,
  invalidateDetectedNatType,
} from '../../src/lib/nat'

beforeEach(() => {
  invalidateDetectedNatType()
})

describe('invalidateDetectedNatType', () => {
  it('resets the cached NAT type to "unknown"', () => {
    setDetectedNatType('symmetric')
    expect(getDetectedNatType()).toBe('symmetric')

    invalidateDetectedNatType()
    expect(getDetectedNatType()).toBe('unknown')
  })

  it('fires onNatTypeChange listeners when invalidating a non-unknown verdict', () => {
    setDetectedNatType('cone')
    const seen: string[] = []
    const off = onNatTypeChange(t => seen.push(t))

    invalidateDetectedNatType()
    expect(seen).toEqual(['unknown'])

    off()
  })

  it('is a no-op when already unknown (no spurious listener fires)', () => {
    invalidateDetectedNatType() // make sure we start unknown
    let calls = 0
    const off = onNatTypeChange(() => { calls++ })

    invalidateDetectedNatType()
    expect(calls).toBe(0)

    off()
  })
})
