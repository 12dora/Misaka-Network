// SECURITY-012 — Camera Retry could leave capture running after the modal
// closed.
//
// Reproduction of the original bug: the mount effect passed a `cancelled`
// closure to `startCamera`, but the Retry button called `startCamera()` with
// no argument, so its lifecycle predicate defaulted to `() => false`. A
// retry still waiting on the permission prompt when the modal closed stored
// its stream on a ref nothing would ever stop — camera indicator on, capture
// live, after the dialog was gone.
//
// The controller replaces that per-call closure with a generation owned by
// the controller, so there is no way to acquire without a live predicate.
//
// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'
import { createCameraController } from '../../src/hooks/useCameraStream'

interface FakeTrack { stop: () => void; stopped: boolean }

function fakeStream(): MediaStream & { tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = [
    { stopped: false, stop() { this.stopped = true } },
    { stopped: false, stop() { this.stopped = true } },
  ]
  return { tracks, getTracks: () => tracks } as unknown as MediaStream & { tracks: FakeTrack[] }
}

const allStopped = (s: ReturnType<typeof fakeStream>) => s.tracks.every(t => t.stopped)

/** A getUserMedia we can resolve by hand — models the permission prompt. */
function deferredGetUserMedia() {
  let resolve!: (s: MediaStream) => void
  let reject!: (e: unknown) => void
  const calls: MediaStreamConstraints[] = []
  const fn = vi.fn((c: MediaStreamConstraints) => {
    calls.push(c)
    return new Promise<MediaStream>((res, rej) => { resolve = res; reject = rej })
  })
  return { fn, calls, resolve: (s: MediaStream) => resolve(s), reject: (e: unknown) => reject(e) }
}

const CONSTRAINTS: MediaStreamConstraints = { video: true, audio: false }

describe('SECURITY-012 happy path', () => {
  it('hands back a live stream and takes ownership of it', async () => {
    const stream = fakeStream()
    const controller = createCameraController(async () => stream)

    const result = await controller.acquire(CONSTRAINTS)

    expect(result).toEqual({ status: 'ok', stream })
    expect(controller.current()).toBe(stream)
    expect(allStopped(stream)).toBe(false)
  })

  it('stop() ends the tracks it owns', async () => {
    const stream = fakeStream()
    const controller = createCameraController(async () => stream)
    await controller.acquire(CONSTRAINTS)

    controller.stop()

    expect(allStopped(stream)).toBe(true)
    expect(controller.current()).toBeNull()
  })
})

describe('SECURITY-012: a stream that lands after teardown stops itself', () => {
  it('REGRESSION — dispose() during the permission prompt stops the late stream', async () => {
    const gum = deferredGetUserMedia()
    const controller = createCameraController(gum.fn)

    // Retry pressed: acquisition starts and parks on the prompt.
    const pending = controller.acquire(CONSTRAINTS)
    // Modal closes while the prompt is still open. This is the exact window
    // the old code had no predicate for.
    controller.dispose()

    // User then grants permission — the stream arrives with no owner.
    const late = fakeStream()
    gum.resolve(late)
    const result = await pending

    expect(result).toEqual({ status: 'stale' })
    // The whole point: the camera is actually released.
    expect(allStopped(late)).toBe(true)
    expect(controller.current()).toBeNull()
  })

  it('stop() during the prompt (facing-mode switch) also stops the late stream', async () => {
    const gum = deferredGetUserMedia()
    const controller = createCameraController(gum.fn)

    const pending = controller.acquire(CONSTRAINTS)
    controller.stop()

    const late = fakeStream()
    gum.resolve(late)

    expect(await pending).toEqual({ status: 'stale' })
    expect(allStopped(late)).toBe(true)
  })

  it('every acquisition after dispose() is stale and never calls getUserMedia', async () => {
    const gum = deferredGetUserMedia()
    const controller = createCameraController(gum.fn)
    controller.dispose()

    expect(await controller.acquire(CONSTRAINTS)).toEqual({ status: 'stale' })
    expect(gum.fn).not.toHaveBeenCalled()
  })
})

describe('SECURITY-012: overlapping requests are forbidden', () => {
  it('a second acquire while one is in flight is refused, not queued', async () => {
    const gum = deferredGetUserMedia()
    const controller = createCameraController(gum.fn)

    const first = controller.acquire(CONSTRAINTS)
    const second = await controller.acquire(CONSTRAINTS)

    expect(second).toEqual({ status: 'busy' })
    // Exactly one camera was opened — a double-tap on Retry must not produce
    // two streams where only the last one is tracked.
    expect(gum.fn).toHaveBeenCalledTimes(1)

    const stream = fakeStream()
    gum.resolve(stream)
    expect(await first).toEqual({ status: 'ok', stream })
  })

  it('a sequential re-acquire stops the previous stream before opening a new one', async () => {
    const a = fakeStream()
    const b = fakeStream()
    const queue = [a, b]
    const controller = createCameraController(async () => queue.shift() as MediaStream)

    await controller.acquire(CONSTRAINTS)
    await controller.acquire(CONSTRAINTS)

    expect(allStopped(a)).toBe(true)
    expect(allStopped(b)).toBe(false)
    expect(controller.current()).toBe(b)
  })
})

describe('SECURITY-012: error handling', () => {
  it('surfaces a rejection as a typed error while still live', async () => {
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    const controller = createCameraController(async () => { throw err })

    expect(await controller.acquire(CONSTRAINTS)).toEqual({ status: 'error', error: err })
  })

  it('reports a rejection that arrives after teardown as stale, not error', async () => {
    const gum = deferredGetUserMedia()
    const controller = createCameraController(gum.fn)

    const pending = controller.acquire(CONSTRAINTS)
    controller.dispose()
    gum.reject(new Error('aborted'))

    // Stale, so the closed modal's error state is never written.
    expect(await pending).toEqual({ status: 'stale' })
  })
})
