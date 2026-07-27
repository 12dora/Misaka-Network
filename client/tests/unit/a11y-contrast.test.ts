// A11Y-002 — automated WCAG contrast check for the semantic colour tokens.
//
// The audit found the `--state-*` fills being used directly as 10–14 px text
// colours, producing ratios between 1.80:1 and 4.05:1 (AA needs 4.5:1). The
// fix introduced verified `*-on-light` / `*-on-blue` foreground variants;
// this test re-derives every ratio from the real hex values in index.css so
// a future token tweak can't silently drop back below AA.
//
// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CONTRAST_PAIRS, FILL_ONLY_TOKENS } from '../../src/constants'

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = join(here, '../../src/index.css')

/** Pull `--name: #RRGGBB;` declarations out of the `:root` block. */
function parseTokens(css: string): Record<string, string> {
  const root = css.slice(css.indexOf(':root'), css.indexOf('/* ── Base Reset'))
  const out: Record<string, string> = {}
  for (const m of root.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    out[m[1]] = m[2].toUpperCase()
  }
  return out
}

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg)
  const b = relativeLuminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const tokens = parseTokens(readFileSync(cssPath, 'utf8'))

describe('contrast helper', () => {
  it('matches the WCAG reference values for the extremes', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5)
  })
})

describe('index.css token table', () => {
  it('declares every token referenced by CONTRAST_PAIRS', () => {
    const missing = new Set<string>()
    for (const p of CONTRAST_PAIRS) {
      if (!tokens[p.fg]) missing.add(p.fg)
      if (!tokens[p.bg]) missing.add(p.bg)
    }
    expect([...missing]).toEqual([])
  })
})

describe('A11Y-002: every declared pair meets its WCAG minimum', () => {
  it.each(CONTRAST_PAIRS.map(p => [`${p.fg} on ${p.bg} (${p.usage})`, p] as const))(
    '%s',
    (_label, pair) => {
      const ratio = contrastRatio(tokens[pair.fg], tokens[pair.bg])
      expect(
        ratio,
        `--${pair.fg} (${tokens[pair.fg]}) on --${pair.bg} (${tokens[pair.bg]}) ` +
        `is ${ratio.toFixed(2)}:1, needs ≥ ${pair.minRatio}:1 for ${pair.usage}`,
      ).toBeGreaterThanOrEqual(pair.minRatio)
    },
  )
})

describe('A11Y-002 edge case: raw fill tokens stay unusable as small text', () => {
  // These are the exact tokens the audit caught being painted as 10–14 px
  // text. If one ever passes AA on white AND on blue the `*-on-light` /
  // `*-on-blue` split can be revisited — but that must be a deliberate
  // change, not an accident.
  it.each(FILL_ONLY_TOKENS)('%s fails AA on at least one core surface', (name) => {
    const surfaces = ['surface', 'surface-tint', 'bg-primary', 'bg-deep']
    const ratios = surfaces.map(s => contrastRatio(tokens[name], tokens[s]))
    expect(Math.min(...ratios)).toBeLessThan(4.5)
  })

  it('the AA-safe variant always beats the raw fill on its own surface', () => {
    for (const [raw, safe, bg] of [
      ['state-success', 'state-success-on-light', 'surface'],
      ['state-warn', 'state-warn-on-light', 'surface'],
      ['state-danger', 'state-danger-on-light', 'surface'],
      ['text-muted', 'text-muted-on-light', 'surface'],
      ['state-success', 'state-success-on-blue', 'bg-primary'],
      ['state-warn', 'state-warn-on-blue', 'bg-primary'],
      ['state-danger', 'state-danger-on-blue', 'bg-primary'],
      ['accent-cyan', 'accent-cyan-on-blue', 'bg-primary'],
    ] as const) {
      expect(
        contrastRatio(tokens[safe], tokens[bg]),
        `--${safe} should out-contrast --${raw} on --${bg}`,
      ).toBeGreaterThan(contrastRatio(tokens[raw], tokens[bg]))
    }
  })
})
