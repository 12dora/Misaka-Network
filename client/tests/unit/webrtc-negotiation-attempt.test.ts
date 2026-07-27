import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAnswer, createAnswer, createOffer } from '../../src/lib/webrtc'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

describe('WebRTC negotiation attempt guards', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCSessionDescription', class {
      type: RTCSdpType
      sdp?: string
      constructor(init: RTCSessionDescriptionInit) {
        this.type = init.type!
        this.sdp = init.sdp
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects an offer continuation replaced during setLocalDescription', async () => {
    const localDescription = deferred<void>()
    let current = true
    const pc = {
      createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'old-offer' })),
      setLocalDescription: vi.fn(() => localDescription.promise),
      localDescription: { toJSON: () => ({ type: 'offer', sdp: 'old-offer' }) },
    } as unknown as RTCPeerConnection

    const work = createOffer(pc, () => current)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    current = false
    localDescription.resolve()

    await expect(work).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not create an answer after replacement during setRemoteDescription', async () => {
    const remoteDescription = deferred<void>()
    let current = true
    const pc = {
      setRemoteDescription: vi.fn(() => remoteDescription.promise),
      createAnswer: vi.fn(async () => ({ type: 'answer', sdp: 'stale-answer' })),
      setLocalDescription: vi.fn(async () => {}),
      localDescription: { toJSON: () => ({ type: 'answer', sdp: 'stale-answer' }) },
    } as unknown as RTCPeerConnection

    const work = createAnswer(pc, { type: 'offer', sdp: 'remote-offer' }, () => current)
    current = false
    remoteDescription.resolve()

    await expect(work).rejects.toMatchObject({ name: 'AbortError' })
    expect(pc.createAnswer).not.toHaveBeenCalled()
    expect(pc.setLocalDescription).not.toHaveBeenCalled()
  })

  it('rejects an applied answer whose remote-description await became stale', async () => {
    const remoteDescription = deferred<void>()
    let current = true
    const pc = {
      setRemoteDescription: vi.fn(() => remoteDescription.promise),
    } as unknown as RTCPeerConnection

    const work = applyAnswer(pc, { type: 'answer', sdp: 'stale-answer' }, () => current)
    current = false
    remoteDescription.resolve()

    await expect(work).rejects.toMatchObject({ name: 'AbortError' })
  })
})
