// Pure helpers for the 6-digit pass-code OTP-style input in LoginCard.
//
// Extracted so the keystroke / paste behaviour can be unit-tested without
// pulling in @testing-library. The component just calls these and applies
// the returned next state.

export interface PassCodeKeyResult {
  next: string
  focusIdx: number
  preventDefault: boolean
}

const PASS_LEN = 6

// ── Credential generation ────────────────────────────────────────────
// SECURITY-019: the pass code is only ~20 bits of entropy to begin with, so
// the generator must at least not be *predictable* on top of being small.
// `Math.random()` is xorshift128+, seeded per tab and recoverable from a
// handful of outputs — one observed regenerate is enough to guess the next.
// Draw from the CSPRNG instead, and reject the tail of the 2^32 range that
// wouldn't divide evenly so `% range` introduces no bias toward low values.

const UINT32_SPACE = 0x1_0000_0000

/** Uniform integer in [min, max] (inclusive) from `crypto.getRandomValues`. */
export function secureRandomInt(min: number, max: number): number {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
    throw new RangeError(`secureRandomInt: invalid range ${min}..${max}`)
  }
  const range = max - min + 1
  if (range === 1) return min
  // Largest multiple of `range` that fits in 2^32; anything at or above it is
  // re-drawn. The expected number of draws is < 2 for any sane range.
  const limit = Math.floor(UINT32_SPACE / range) * range
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) return min + (buf[0] % range)
  }
}

/** Six-digit, zero-padded pass code drawn from the CSPRNG. */
export function generatePassCode(): string {
  return String(secureRandomInt(0, 999999)).padStart(PASS_LEN, '0')
}

export function getPassChars(passCode: string, len: number = PASS_LEN): string[] {
  const chars: string[] = []
  for (let i = 0; i < len; i++) chars.push(passCode[i] ?? '')
  return chars
}

/** Sanitise a pasted value: digits only, capped at 6 chars. */
export function sanitisePastedPassCode(raw: string, len: number = PASS_LEN): string {
  return raw.replace(/\D/g, '').slice(0, len)
}

/** Sanitise a single keystroke into a digit, returns '' if not a digit. */
export function sanitiseDigit(raw: string): string {
  return raw.replace(/\D/g, '').slice(-1)
}

/**
 * Apply a digit at `idx`. Returns the new pass code and the next focus index.
 * The caller is responsible for actually moving DOM focus.
 */
export function applyDigit(passCode: string, idx: number, digit: string): { next: string; focusIdx: number } {
  if (!digit) return { next: passCode, focusIdx: idx }
  const chars = getPassChars(passCode)
  chars[idx] = digit
  return { next: chars.join(''), focusIdx: Math.min(idx + 1, PASS_LEN - 1) }
}

/**
 * Compute the result of pressing Backspace inside cell `idx`.
 *
 * Convention (OTP-style): if the current cell has a digit, clear it and stay.
 * If the cell is already empty, only move focus back — do NOT also clear the
 * previous digit (so users can fix a typo at the end without wiping earlier
 * cells). The user can then press Backspace again to clear that cell.
 */
export function applyBackspace(passCode: string, idx: number): PassCodeKeyResult {
  const chars = getPassChars(passCode)
  if (chars[idx]) {
    chars[idx] = ''
    return { next: chars.join(''), focusIdx: idx, preventDefault: true }
  }
  if (idx > 0) {
    return { next: passCode, focusIdx: idx - 1, preventDefault: true }
  }
  return { next: passCode, focusIdx: 0, preventDefault: true }
}
