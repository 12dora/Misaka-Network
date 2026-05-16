// Mirrors the existing standalone tests/nat-classify.test.mjs but runs under
// Vitest so it counts towards `npm run test:unit` and coverage.
// Pure-function NAT classification — no DOM access, no module side effects.

import { describe, it, expect } from 'vitest'
import {
  parseCandidate,
  classifyNat,
  isPrivateAddress,
} from '../../src/lib/nat-classify'

describe('isPrivateAddress', () => {
  it.each([
    ['10.0.0.1', true],
    ['192.168.1.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['127.0.0.1', true],
    ['169.254.1.1', true],
    ['100.64.0.1', true],          // CGNAT
    ['::1', true],
    ['fc00::1', true],
    ['fe80::1', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
  ])('classifies %s → private=%s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected)
  })
})

describe('parseCandidate', () => {
  it('extracts host candidate fields', () => {
    const line = 'candidate:1 1 udp 2122260223 192.168.1.10 54321 typ host'
    const c = parseCandidate(line)
    expect(c).toMatchObject({
      type: 'host',
      protocol: 'udp',
      address: '192.168.1.10',
      port: 54321,
    })
  })

  it('extracts srflx candidate with related address', () => {
    const line =
      'candidate:2 1 udp 1686052607 203.0.113.5 33445 typ srflx raddr 192.168.1.10 rport 54321'
    const c = parseCandidate(line)
    expect(c).toMatchObject({
      type: 'srflx',
      address: '203.0.113.5',
      port: 33445,
      relatedAddress: '192.168.1.10',
      relatedPort: 54321,
    })
  })

  it('returns null on malformed line', () => {
    expect(parseCandidate('not a candidate')).toBeNull()
  })
})

describe('classifyNat', () => {
  it('returns "blocked" when no candidates seen', () => {
    expect(classifyNat([]).type).toBe('blocked')
  })

  it('returns "open" when host candidate has public IP', () => {
    const r = classifyNat([
      { type: 'host', protocol: 'udp', address: '203.0.113.5', port: 50000 },
    ])
    expect(r.type).toBe('open')
  })

  it('returns "cone" when one srflx endpoint observed', () => {
    const r = classifyNat([
      { type: 'host', protocol: 'udp', address: '192.168.1.10', port: 50000 },
      {
        type: 'srflx',
        protocol: 'udp',
        address: '203.0.113.5',
        port: 33445,
        relatedAddress: '192.168.1.10',
        relatedPort: 50000,
      },
    ])
    expect(r.type).toBe('cone')
    expect(r.publicEndpoints).toEqual(['203.0.113.5:33445'])
  })

  it('returns "symmetric" when two srflx endpoints differ for same local', () => {
    const r = classifyNat([
      {
        type: 'srflx',
        protocol: 'udp',
        address: '203.0.113.5',
        port: 33445,
        relatedAddress: '192.168.1.10',
        relatedPort: 50000,
      },
      {
        type: 'srflx',
        protocol: 'udp',
        address: '203.0.113.5',
        port: 33999,
        relatedAddress: '192.168.1.10',
        relatedPort: 50000,
      },
    ])
    expect(r.type).toBe('symmetric')
    expect(r.publicEndpoints).toHaveLength(2)
  })
})
