const STORAGE_KEY = 'misaka.sound.enabled'

export type SoundEvent = 'scan' | 'complete' | 'error'

/** In-memory preference so a storage failure still toggles audio this session. */
let memoryEnabled: boolean | null = null
let audioUnavailable = false

function getAudioContext(): AudioContext | null {
  if (audioUnavailable) return null
  try {
    const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtor) return null
    const w = window as typeof window & { __misakaAudio?: AudioContext }
    if (!w.__misakaAudio) w.__misakaAudio = new AudioCtor()
    return w.__misakaAudio
  } catch {
    audioUnavailable = true
    return null
  }
}

function disposeAudioContext() {
  const w = window as typeof window & { __misakaAudio?: AudioContext }
  const ctx = w.__misakaAudio
  if (!ctx) return
  try {
    // Prefer close(); fall back to suspend for older engines.
    if (typeof ctx.close === 'function') {
      void ctx.close().catch(() => {})
    } else if (typeof ctx.suspend === 'function') {
      void ctx.suspend().catch(() => {})
    }
  } catch { /* ignore */ }
  delete w.__misakaAudio
}

function readStoredPreference(): boolean {
  if (memoryEnabled !== null) return memoryEnabled
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function isSoundEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return readStoredPreference()
}

export interface SetSoundEnabledResult {
  persisted: boolean
}

export function setSoundEnabled(enabled: boolean): SetSoundEnabledResult {
  memoryEnabled = enabled
  if (!enabled) disposeAudioContext()
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled))
    return { persisted: true }
  } catch {
    // Keep the in-memory setting live; UI can show "本次有效但无法保存".
    return { persisted: false }
  }
}

export function subscribeSoundPreference(listener: (enabled: boolean) => void): () => void {
  function handle(e: StorageEvent) {
    if (e.key === STORAGE_KEY) {
      memoryEnabled = null
      listener(readStoredPreference())
    }
  }
  window.addEventListener('storage', handle)
  return () => window.removeEventListener('storage', handle)
}

function tone(ctx: AudioContext, start: number, frequency: number, duration: number, gainValue: number) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(frequency, start)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

/** Never rejects — callers are fire-and-forget. */
export async function playSound(event: SoundEvent): Promise<void> {
  try {
    if (!isSoundEnabled()) return
    const ctx = getAudioContext()
    if (!ctx) return
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})

    const now = ctx.currentTime
    if (event === 'scan') {
      tone(ctx, now, 880, 0.08, 0.035)
      tone(ctx, now + 0.075, 1320, 0.09, 0.03)
    } else if (event === 'complete') {
      tone(ctx, now, 660, 0.1, 0.035)
      tone(ctx, now + 0.09, 990, 0.12, 0.03)
      tone(ctx, now + 0.18, 1320, 0.16, 0.026)
    } else {
      tone(ctx, now, 220, 0.12, 0.045)
      tone(ctx, now + 0.11, 185, 0.16, 0.035)
    }
  } catch {
    audioUnavailable = true
  }
}
