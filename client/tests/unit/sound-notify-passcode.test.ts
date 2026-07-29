// sound / notify / passcode edge fixes
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { playSound, setSoundEnabled, isSoundEnabled } from '../../src/lib/sound'
import { notifyIncomingFile } from '../../src/lib/notify'
import { secureRandomInt } from '../../src/lib/passcode'

describe('playSound never rejects', () => {
  beforeEach(() => {
    localStorage.clear()
    setSoundEnabled(true)
  })

  it('swallows AudioContext constructor failure', async () => {
    const w = window as typeof window & { __misakaAudio?: AudioContext }
    delete w.__misakaAudio
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: class { constructor() { throw new Error('blocked') } },
    })
    await expect(playSound('complete')).resolves.toBeUndefined()
  })

  it('setSoundEnabled survives localStorage throw and keeps memory preference', () => {
    const shim = localStorage
    const realSet = shim.setItem.bind(shim)
    shim.setItem = () => { throw new Error('quota') }
    const r = setSoundEnabled(true)
    expect(r.persisted).toBe(false)
    expect(isSoundEnabled()).toBe(true)
    shim.setItem = realSet
  })

  it('disabling sound disposes the audio context', async () => {
    const close = vi.fn(async () => {})
    const w = window as typeof window & { __misakaAudio?: AudioContext }
    w.__misakaAudio = { close, state: 'running' } as unknown as AudioContext
    setSoundEnabled(false)
    expect(close).toHaveBeenCalled()
    expect(w.__misakaAudio).toBeUndefined()
  })
})

describe('notifyIncomingFile tag includes transfer id', () => {
  it('uses distinct tags for same fileName different transfers', () => {
    const notes: Array<{ tag?: string }> = []
    // @ts-expect-error test stub
    globalThis.Notification = class {
      static permission = 'granted'
      constructor(_title: string, opts?: { tag?: string }) {
        notes.push({ tag: opts?.tag })
      }
    }
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })

    notifyIncomingFile({ peerNodeId: 1, fileName: 'report.pdf', fileSize: 100, transferId: 't-a' })
    notifyIncomingFile({ peerNodeId: 2, fileName: 'report.pdf', fileSize: 200, transferId: 't-b' })

    expect(notes[0].tag).toBe('misaka-file-t-a')
    expect(notes[1].tag).toBe('misaka-file-t-b')
    expect(notes[0].tag).not.toBe(notes[1].tag)
  })
})

describe('secureRandomInt range contract', () => {
  it('rejects ranges larger than 2^32', () => {
    expect(() => secureRandomInt(0, 0x1_0000_0000)).toThrow(RangeError)
  })

  it('rejects unsafe integers', () => {
    expect(() => secureRandomInt(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError)
  })
})
