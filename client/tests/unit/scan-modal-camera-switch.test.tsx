// SECURITY-012 regression at the COMPONENT level.
//
// The controller-only tests in scan-camera-lifecycle.test.ts passed while the
// scanner was completely broken in the browser, because they never exercised
// how ScanModal drives the controller.
//
// ScanModal held ONE controller in a ref for the modal's whole lifetime, and
// the acquisition effect (keyed on `facingMode`) disposed it in cleanup.
// dispose() is permanent — every later acquire() resolves `stale`. So tapping
// 切换摄像头 ran: cleanup -> dispose() -> effect -> acquire() -> stale, and the
// camera never came back. React 18 StrictMode's mount/unmount/mount replay
// broke the FIRST mount the same way in development.
//
// The fix is a fresh controller per effect run, disposing only the superseded
// one. This test asserts the observable consequence: after a facing switch the
// second stream stays live instead of being stopped as stale.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import ScanModal from '../../src/components/features/ScanModal'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface FakeTrack { stop: () => void; stopped: boolean }
interface FakeStream extends MediaStream { tracks: FakeTrack[] }

function fakeStream(): FakeStream {
  const tracks: FakeTrack[] = [{ stopped: false, stop() { this.stopped = true } }]
  return { tracks, getTracks: () => tracks } as unknown as FakeStream
}

const isLive = (s: FakeStream) => s.tracks.every(t => !t.stopped)

let container: HTMLDivElement
let root: Root
let streams: FakeStream[]
let getUserMedia: ReturnType<typeof vi.fn>

// Two video inputs, so ScanModal renders the 切换摄像头 button.
const DEVICES = [
  { kind: 'videoinput', deviceId: 'front' },
  { kind: 'videoinput', deviceId: 'back' },
] as unknown as MediaDeviceInfo[]

beforeEach(() => {
  streams = []
  getUserMedia = vi.fn(async () => {
    const s = fakeStream()
    streams.push(s)
    return s
  })

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => DEVICES),
    },
  })
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  // jsdom has no media element playback.
  HTMLMediaElement.prototype.play = vi.fn(async () => {})
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Let the chain of awaits inside startCamera() settle. */
async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() })
}

// The dialog is portalled to <body> (UX-LAYOUT-001), so it is not inside the
// render container.
function findSwitchButton(): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll('button')]
    .find(b => b.textContent?.includes('切换摄像头'))
  if (!btn) throw new Error('切换摄像头 button not rendered')
  return btn as HTMLButtonElement
}

describe('SECURITY-012: ScanModal camera switching', () => {
  it('REGRESSION — the camera still works after switching facing mode', async () => {
    await act(async () => { root.render(<ScanModal onClose={() => {}} />) })
    await settle()

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(isLive(streams[0])).toBe(true)

    await act(async () => { findSwitchButton().click() })
    await settle()

    // A second acquisition must happen AND survive. Before the fix the shared
    // controller was already disposed, so this resolved `stale` and the fresh
    // stream was stopped on arrival — a permanently dead scanner.
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(streams).toHaveLength(2)
    expect(isLive(streams[1])).toBe(true)

    // The superseded stream must not be left running.
    expect(isLive(streams[0])).toBe(false)
  })

  it('switching twice returns to a live camera each time', async () => {
    await act(async () => { root.render(<ScanModal onClose={() => {}} />) })
    await settle()

    await act(async () => { findSwitchButton().click() })
    await settle()
    await act(async () => { findSwitchButton().click() })
    await settle()

    expect(getUserMedia).toHaveBeenCalledTimes(3)
    expect(isLive(streams[2])).toBe(true)
    expect(isLive(streams[0])).toBe(false)
    expect(isLive(streams[1])).toBe(false)
  })

  it('unmounting stops the live stream', async () => {
    await act(async () => { root.render(<ScanModal onClose={() => {}} />) })
    await settle()
    expect(isLive(streams[0])).toBe(true)

    await act(async () => { root.render(<></>) })
    await settle()

    expect(isLive(streams[0])).toBe(false)
  })
})
