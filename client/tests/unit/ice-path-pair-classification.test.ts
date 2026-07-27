// BUG-010: the relay diagnosis must classify the candidate *pair*, not just
// the local candidate.
//
// A host/srflx local candidate paired with a remote `relay` candidate IS a
// relayed path — the bytes still cross the TURN server, we still pay for
// them, and the privacy story ("your data is relayed") still applies. The
// old implementation looked only at `localCandidateId` and happily reported
// "直接信道（局域网）" for a fully relayed connection.

import { describe, it, expect } from 'vitest'
import { getSelectedIcePath, getSelectedChannelType } from '../../src/lib/webrtc'

type Stat = Record<string, unknown> & { id: string; type: string }

function statsPc(local: Partial<Stat>, remote: Partial<Stat>, pairOverrides: Partial<Stat> = {}) {
  const stats = new Map<string, Stat>()
  stats.set('local', { id: 'local', type: 'local-candidate', protocol: 'udp', ...local })
  stats.set('remote', { id: 'remote', type: 'remote-candidate', protocol: 'udp', ...remote })
  stats.set('pair', {
    id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true,
    localCandidateId: 'local', remoteCandidateId: 'remote', ...pairOverrides,
  })
  return { getStats: async () => stats } as unknown as RTCPeerConnection
}

describe('getSelectedIcePath — pair-level classification', () => {
  it('reports relay when only the REMOTE side is a relay candidate', async () => {
    const pc = statsPc({ candidateType: 'host' }, { candidateType: 'relay' })
    const path = await getSelectedIcePath(pc)
    expect(path?.channelType).toBe('relay')
    expect(path?.pathText).toContain('relay')
  })

  it('reports relay when only the LOCAL side is a relay candidate', async () => {
    const pc = statsPc({ candidateType: 'relay' }, { candidateType: 'srflx' })
    expect((await getSelectedIcePath(pc))?.channelType).toBe('relay')
  })

  it('reports stun when either side is server-reflexive and neither relays', async () => {
    const local = statsPc({ candidateType: 'host' }, { candidateType: 'srflx' })
    expect((await getSelectedIcePath(local))?.channelType).toBe('stun')
    const remote = statsPc({ candidateType: 'srflx' }, { candidateType: 'host' })
    expect((await getSelectedIcePath(remote))?.channelType).toBe('stun')
  })

  it('reports direct only for a host↔host pair', async () => {
    const pc = statsPc({ candidateType: 'host' }, { candidateType: 'host' })
    expect((await getSelectedIcePath(pc))?.channelType).toBe('direct')
  })

  it('treats peer-reflexive as a NAT-mapped (stun) path, not host', async () => {
    const pc = statsPc({ candidateType: 'prflx' }, { candidateType: 'host' })
    expect((await getSelectedIcePath(pc))?.channelType).toBe('stun')
  })

  it('ignores candidate pairs that are not succeeded+nominated', async () => {
    const pc = statsPc(
      { candidateType: 'relay' }, { candidateType: 'relay' },
      { state: 'in-progress', nominated: false },
    )
    expect(await getSelectedIcePath(pc)).toBeNull()
  })

  it('returns null instead of throwing when getStats rejects', async () => {
    const pc = { getStats: async () => { throw new Error('boom') } } as unknown as RTCPeerConnection
    expect(await getSelectedIcePath(pc)).toBeNull()
  })
})

describe('getSelectedChannelType — same pair semantics as getSelectedIcePath', () => {
  it('agrees with getSelectedIcePath on a remote-relay pair', async () => {
    const pc = statsPc({ candidateType: 'host' }, { candidateType: 'relay' })
    expect(await getSelectedChannelType(pc)).toBe('relay')
  })

  it('still reports direct for host↔host', async () => {
    const pc = statsPc({ candidateType: 'host' }, { candidateType: 'host' })
    expect(await getSelectedChannelType(pc)).toBe('direct')
  })
})
