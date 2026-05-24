// P0: applyIceConfigToAll → pc.setConfiguration() used to throw
// InvalidModificationError on Chrome when the live RTCPeerConnection had
// already begun gathering (iceGatheringState !== 'new') because the new
// config still carried iceCandidatePoolSize > 0. The spec forbids changing
// the pool size after gathering starts.
//
// Fix: applyIceConfigToAll must hand setConfiguration() a config whose
// iceCandidatePoolSize is 0 for PCs whose gathering is no longer 'new'.
// (New PCs built via createPeerConnection() may still pre-warm with
// ICE_CANDIDATE_POOL_SIZE since iceGatheringState is 'new' at construction.)

import { describe, it, expect, beforeEach, vi } from 'vitest'

;(() => {
  const store = new Map<string, string>()
  const shim: Storage = {
    get length() { return store.size },
    clear() { store.clear() },
    getItem(k) { return store.has(k) ? store.get(k)! : null },
    setItem(k, v) { store.set(k, String(v)) },
    removeItem(k) { store.delete(k) },
    key(i) { return Array.from(store.keys())[i] ?? null },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true })
  Object.defineProperty(window, 'localStorage', { value: shim, configurable: true, writable: true })
})()

import { saveTurnSettings } from '../../src/lib/turn'
import { applyIceConfigToAll, buildIceConfig } from '../../src/lib/webrtc'

beforeEach(() => {
  localStorage.clear()
})

function makePcStub(iceGatheringState: RTCIceGatheringState) {
  // Real Chrome remembers the pool size from construction. If we land in
  // 'gathering'/'complete' state, simulate that pool was already 4.
  const initialPool = iceGatheringState === 'new' ? 0 : 4
  let currentCfg: RTCConfiguration = { iceServers: [], iceCandidatePoolSize: initialPool }
  const pc: any = {
    connectionState: 'connected' as RTCPeerConnectionState,
    iceGatheringState,
    getConfiguration: vi.fn(() => currentCfg),
    setConfiguration: vi.fn((cfg: RTCConfiguration) => {
      // Mirror real Chrome behaviour: throw if pool size differs from the
      // initial value once gathering has started.
      if (iceGatheringState !== 'new' && (cfg.iceCandidatePoolSize ?? 0) !== initialPool) {
        throw new DOMException('Attempted to modify iceCandidatePoolSize after gathering started', 'InvalidModificationError')
      }
      currentCfg = cfg
    }),
  }
  return pc
}

describe('applyIceConfigToAll: iceCandidatePoolSize handling', () => {
  it('does NOT throw on a PC that has already started gathering', () => {
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })

    const pcGathering = makePcStub('gathering')
    const pcComplete = makePcStub('complete')

    expect(() => applyIceConfigToAll([pcGathering, pcComplete])).not.toThrow()
    expect(pcGathering.setConfiguration).toHaveBeenCalledTimes(1)
    expect(pcComplete.setConfiguration).toHaveBeenCalledTimes(1)

    // The config passed in must carry the same iceCandidatePoolSize the PC
    // was constructed with (the only value Chrome will accept post-gather).
    const cfgG = pcGathering.setConfiguration.mock.calls[0][0] as RTCConfiguration
    const cfgC = pcComplete.setConfiguration.mock.calls[0][0] as RTCConfiguration
    expect(cfgG.iceCandidatePoolSize).toBe(4)
    expect(cfgC.iceCandidatePoolSize).toBe(4)
  })

  it('falls back to pool=0 when getConfiguration() throws or is missing', () => {
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })
    const pc: any = {
      connectionState: 'connected',
      iceGatheringState: 'gathering',
      // getConfiguration omitted on purpose to mimic older browsers
      setConfiguration: vi.fn(),
    }
    applyIceConfigToAll([pc])
    expect(pc.setConfiguration).toHaveBeenCalledTimes(1)
    const passed = pc.setConfiguration.mock.calls[0][0] as RTCConfiguration
    expect(passed.iceCandidatePoolSize).toBe(0)
  })

  it('updates iceServers on the live PC when TURN creds rotate', () => {
    saveTurnSettings({
      enabled: true,
      forceRelay: false,
      servers: [{
        id: 'm1', url: 'turn:t1.example.com:3478',
        username: 'u1', credential: 'c1', enabled: true,
      }],
    })

    const pc = makePcStub('gathering')
    applyIceConfigToAll([pc])

    // After apply, getConfiguration() reflects the new servers.
    const cfg = pc.getConfiguration()
    const urls = (cfg.iceServers ?? []).flatMap((s: RTCIceServer) =>
      Array.isArray(s.urls) ? s.urls : [s.urls],
    )
    expect(urls).toContain('turn:t1.example.com:3478')

    // Now swap the creds and re-apply.
    saveTurnSettings({
      enabled: true,
      forceRelay: false,
      servers: [{
        id: 'm1', url: 'turn:t2.example.com:3478',
        username: 'u2', credential: 'c2', enabled: true,
      }],
    })
    applyIceConfigToAll([pc])

    const cfg2 = pc.getConfiguration()
    const urls2 = (cfg2.iceServers ?? []).flatMap((s: RTCIceServer) =>
      Array.isArray(s.urls) ? s.urls : [s.urls],
    )
    expect(urls2).toContain('turn:t2.example.com:3478')
    expect(urls2).not.toContain('turn:t1.example.com:3478')
  })

  it('skips PCs in connectionState=closed', () => {
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })
    const closed: any = {
      connectionState: 'closed',
      iceGatheringState: 'complete',
      setConfiguration: vi.fn(),
      getConfiguration: vi.fn(),
    }
    applyIceConfigToAll([closed])
    expect(closed.setConfiguration).not.toHaveBeenCalled()
  })

  it('new PCs (iceGatheringState=new) still get the configured pool size', () => {
    saveTurnSettings({ enabled: false, forceRelay: false, servers: [] })
    const cfg = buildIceConfig()
    // buildIceConfig is the source of truth for newly-constructed PCs; it
    // should still pre-warm with the constants pool size.
    expect(cfg.iceCandidatePoolSize).toBeGreaterThan(0)
  })
})
