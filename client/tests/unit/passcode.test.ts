// Tests for the 6-digit pass-code input helpers.
//
// These cover two regressions the QA pass uncovered:
//
//   1. `setPassCode(text.padEnd(6, ''))` — `padEnd` with an empty pad string
//      is a no-op per spec, so the call was dead code masquerading as
//      "pad to 6 chars". sanitisePastedPassCode now just slices to 6.
//
//   2. Backspace inside an empty cell used to also clear the *previous*
//      cell's digit, so a user fixing the last entry would wipe an earlier
//      one. applyBackspace must only move focus in that case.

import { describe, it, expect } from 'vitest'
import {
  getPassChars,
  sanitisePastedPassCode,
  sanitiseDigit,
  applyDigit,
  applyBackspace,
} from '@/lib/passcode'

describe('getPassChars', () => {
  it('always returns 6 entries, padding with empty strings', () => {
    expect(getPassChars('')).toEqual(['', '', '', '', '', ''])
    expect(getPassChars('12')).toEqual(['1', '2', '', '', '', ''])
    expect(getPassChars('123456')).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('ignores characters past index 6', () => {
    expect(getPassChars('1234567890')).toEqual(['1', '2', '3', '4', '5', '6'])
  })
})

describe('sanitisePastedPassCode', () => {
  it('strips non-digits and caps at 6 characters', () => {
    expect(sanitisePastedPassCode('  12 34-56  ')).toBe('123456')
    expect(sanitisePastedPassCode('abc123def')).toBe('123')
    expect(sanitisePastedPassCode('9876543210')).toBe('987654')
  })

  it('preserves partial pastes verbatim (no bogus padding)', () => {
    // Regression: the old code called String.prototype.padEnd(6, '') which
    // is a no-op but signalled intent to pad — making future maintainers
    // think 3-digit pastes would be padded. They are not, and that is fine
    // because validation downstream rejects anything shorter than 6 digits.
    expect(sanitisePastedPassCode('123')).toBe('123')
    expect(sanitisePastedPassCode('123').length).toBe(3)
  })

  it('returns empty string for inputs with no digits', () => {
    expect(sanitisePastedPassCode('abc--')).toBe('')
    expect(sanitisePastedPassCode('')).toBe('')
  })
})

describe('sanitiseDigit', () => {
  it('returns the last digit of the input or empty string', () => {
    expect(sanitiseDigit('5')).toBe('5')
    expect(sanitiseDigit('a5b')).toBe('5')
    expect(sanitiseDigit('12')).toBe('2')
    expect(sanitiseDigit('a')).toBe('')
    expect(sanitiseDigit('')).toBe('')
  })
})

describe('applyDigit', () => {
  it('writes the digit at the given cell and advances focus', () => {
    expect(applyDigit('', 0, '4')).toEqual({ next: '4', focusIdx: 1 })
    expect(applyDigit('12', 2, '3')).toEqual({ next: '123', focusIdx: 3 })
  })

  it('overwrites an existing digit without shifting siblings', () => {
    expect(applyDigit('123456', 2, '9')).toEqual({ next: '129456', focusIdx: 3 })
  })

  it('does not advance past the last cell', () => {
    expect(applyDigit('12345', 5, '6')).toEqual({ next: '123456', focusIdx: 5 })
  })

  it('is a no-op when the digit is empty', () => {
    expect(applyDigit('12', 2, '')).toEqual({ next: '12', focusIdx: 2 })
  })
})

describe('applyBackspace', () => {
  it('clears the current cell when it has a digit and stays in place', () => {
    const r = applyBackspace('123456', 5)
    expect(r.next).toBe('12345')
    expect(r.focusIdx).toBe(5)
    expect(r.preventDefault).toBe(true)
  })

  it('does NOT clear the previous cell when the current cell is empty', () => {
    // The fix for the QA regression: pressing Backspace in an empty cell
    // should only move focus back. Clearing was previously destructive and
    // erased the user's earlier digits.
    const r = applyBackspace('123', 5)
    expect(r.next).toBe('123')   // unchanged
    expect(r.focusIdx).toBe(4)   // focus moved back one cell
    expect(r.preventDefault).toBe(true)
  })

  it('stops at index 0 without going negative', () => {
    const r = applyBackspace('', 0)
    expect(r.next).toBe('')
    expect(r.focusIdx).toBe(0)
  })

  it('clearing in the middle compacts the suffix off (intended for last-cell edits)', () => {
    // When the user clicks back into an earlier cell and presses Backspace,
    // we clear that cell — chars.join('') with a hole at idx produces a
    // shorter string. The component's controlled input redraws from there.
    const r = applyBackspace('123456', 2)
    // idx 2 had '3'; we clear it. join('') collapses the empty slot.
    expect(r.next).toBe('12456')
    expect(r.focusIdx).toBe(2)
  })
})
