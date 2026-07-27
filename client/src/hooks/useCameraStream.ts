// SECURITY-012 — camera acquisition with a lifecycle predicate.
//
// ScanModal used to guard `getUserMedia()` with a `cancelled` flag captured
// by the mount effect's closure. The Retry button called `startCamera()`
// with no argument, so its `isCancelled` defaulted to `() => false`: a retry
// that was still awaiting the permission prompt when the modal closed stored
// its stream on a detached ref that nothing would ever stop. The camera
// indicator stayed lit and capture continued after the dialog was gone.
//
// The controller below replaces the per-call closure with a monotonically
// increasing *request generation* owned by the controller itself. Every
// acquisition path — mount, facing-mode change, Retry — goes through it, so
// there is exactly one predicate and it can never default to "not cancelled".

export type AcquireResult =
  /** Stream is live and owned by the controller. */
  | { status: 'ok'; stream: MediaStream }
  /** A newer request (or stop/dispose) superseded this one. Tracks stopped. */
  | { status: 'stale' }
  /** Another acquisition is already in flight; this call did nothing. */
  | { status: 'busy' }
  /** getUserMedia rejected. */
  | { status: 'error'; error: unknown }

export interface CameraController {
  acquire(constraints: MediaStreamConstraints): Promise<AcquireResult>
  /** Stop the live stream and invalidate any in-flight acquisition. */
  stop(): void
  /** Permanent teardown — every later acquire resolves `stale`. */
  dispose(): void
  /** The stream currently owned by the controller, if any. */
  current(): MediaStream | null
  /** Test/diagnostic hook. */
  generation(): number
}

type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>

function stopTracks(stream: MediaStream | null | undefined) {
  if (!stream) return
  try {
    for (const track of stream.getTracks()) {
      try { track.stop() } catch { /* already ended */ }
    }
  } catch { /* not a real MediaStream — nothing to stop */ }
}

/**
 * @param getUserMedia injected so tests can drive the permission-prompt
 *        window deterministically. Defaults to the platform API.
 */
export function createCameraController(getUserMedia?: GetUserMedia): CameraController {
  const request: GetUserMedia = getUserMedia
    ?? ((c) => navigator.mediaDevices.getUserMedia(c))

  let generation = 0
  let acquiring = false
  let disposed = false
  let stream: MediaStream | null = null

  function invalidate() {
    // Bumping the generation is what makes an in-flight `await` stale. It
    // MUST happen before the await resolves, which is why stop() and
    // dispose() both do it synchronously.
    generation += 1
    stopTracks(stream)
    stream = null
  }

  return {
    async acquire(constraints) {
      if (disposed) return { status: 'stale' }
      // Overlapping requests are forbidden: two concurrent getUserMedia
      // calls produce two streams, and only the last one would be tracked.
      if (acquiring) return { status: 'busy' }

      invalidate()
      const mine = generation
      acquiring = true
      try {
        const got = await request(constraints)
        if (disposed || mine !== generation) {
          // The modal closed or a newer request started while the permission
          // prompt was open. We are the only owner of this stream, so we are
          // the only one who can stop it.
          stopTracks(got)
          return { status: 'stale' }
        }
        stream = got
        return { status: 'ok', stream: got }
      } catch (error) {
        if (disposed || mine !== generation) return { status: 'stale' }
        return { status: 'error', error }
      } finally {
        acquiring = false
      }
    },

    stop() {
      invalidate()
    },

    dispose() {
      disposed = true
      invalidate()
    },

    current() {
      return stream
    },

    generation() {
      return generation
    },
  }
}
