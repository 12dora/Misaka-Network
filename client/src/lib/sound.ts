const STORAGE_KEY = 'misaka.sound.enabled'

export type SoundEvent = 'scan' | 'complete' | 'error'

function getAudioContext(): AudioContext | null {
  const AudioCtor = window.AudioContext ?? (window as any).webkitAudioContext
  if (!AudioCtor) return null
  const w = window as typeof window & { __misakaAudio?: AudioContext }
  if (!w.__misakaAudio) w.__misakaAudio = new AudioCtor()
  return w.__misakaAudio
}

function readStoredPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

export function isSoundEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return readStoredPreference()
}

export function setSoundEnabled(enabled: boolean) {
  localStorage.setItem(STORAGE_KEY, String(enabled))
}

export function subscribeSoundPreference(listener: (enabled: boolean) => void): () => void {
  function handle(e: StorageEvent) {
    if (e.key === STORAGE_KEY) listener(readStoredPreference())
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

export async function playSound(event: SoundEvent) {
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
}
