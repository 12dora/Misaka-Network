// SECURITY-006 — the QR scanner used to hand any value `new URL()` accepted
// straight to `window.location.href`.
//
// Reproduction anchors (all must be rejected now, all navigated before):
//   - a foreign HTTPS origin  → off-app phishing navigation
//   - `javascript:` / `data:` → active scheme, execution left to the browser
//   - credentials in the URL  → `https://evil@our.origin/...`
//   - our origin, wrong route → any page in the app, not just /join
//
// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ORIGIN = 'https://misaka.example'
const JOIN = '/join'

// appBase reads `window`/`location`; stub it so this stays a pure test.
vi.mock('@/lib/appBase', () => ({
  appPath: (p: string) => p,
  appUrl: (p: string) => `${ORIGIN}${p}`,
  appBasePath: () => '',
  publicAssetUrl: (p: string) => p,
}))

import { parseJoinLink, describeJoinLinkRejection } from '../../src/components/features/joinLink'

const TOKEN = 'abcDEF0123456789'

function link(query: string, origin = ORIGIN, route = JOIN) {
  return parseJoinLink(query, origin, route)
}

describe('SECURITY-006 happy path', () => {
  it('accepts a well-formed same-origin node invite', () => {
    const r = link(`${ORIGIN}${JOIN}?type=node&id=10032&t=${TOKEN}`)
    expect(r).toEqual({ ok: true, path: `/join?type=node&id=10032&t=${TOKEN}` })
  })

  it('accepts file and channel invites with their opaque ids', () => {
    expect(link(`${ORIGIN}${JOIN}?type=file&id=1&t=${TOKEN}&fid=sess-01`)).toEqual({
      ok: true, path: `/join?type=file&id=1&t=${TOKEN}&fid=sess-01`,
    })
    expect(link(`${ORIGIN}${JOIN}?type=channel&id=20001&t=${TOKEN}&cid=chan_9`)).toEqual({
      ok: true, path: `/join?type=channel&id=20001&t=${TOKEN}&cid=chan_9`,
    })
  })

  it('rejects an embedded reusable passcode even when it is valid base64', () => {
    const c = Buffer.from('123456').toString('base64')
    const r = link(`${ORIGIN}${JOIN}?type=node&id=7&t=${TOKEN}&c=${c}`)
    expect(r).toEqual({ ok: false, reason: 'BAD_PARAM' })
  })

  it('rewrites the misaka:// app scheme onto our own origin', () => {
    const r = link(`misaka://join?type=node&id=42&t=${TOKEN}`)
    expect(r).toEqual({ ok: true, path: `/join?type=node&id=42&t=${TOKEN}` })
  })

  it('honours a non-root app base (GitHub Pages deployments)', () => {
    const base = '/Misaka-Network/join'
    const r = parseJoinLink(`${ORIGIN}${base}?type=node&id=1&t=${TOKEN}`, ORIGIN, base)
    expect(r).toEqual({ ok: true, path: `${base}?type=node&id=1&t=${TOKEN}` })
  })
})

describe('SECURITY-006 rejections — the exact values that used to navigate', () => {
  it.each([
    ['foreign https origin', `https://phishing.example${JOIN}?type=node&id=1&t=${TOKEN}`, 'FOREIGN_ORIGIN'],
    ['foreign origin, no path', 'https://phishing.example/', 'FOREIGN_ORIGIN'],
    ['javascript: scheme', 'javascript:alert(document.cookie)', 'BAD_SCHEME'],
    ['data: html payload', 'data:text/html,<script>alert(1)</script>', 'BAD_SCHEME'],
    ['blob: scheme', 'blob:https://misaka.example/abc', 'BAD_SCHEME'],
    ['file: scheme', 'file:///etc/passwd', 'BAD_SCHEME'],
    ['embedded credentials', `https://evil:pw@misaka.example${JOIN}?type=node&id=1&t=${TOKEN}`, 'HAS_CREDENTIALS'],
    ['same origin, other route', `${ORIGIN}/network?type=node&id=1&t=${TOKEN}`, 'WRONG_ROUTE'],
    ['same origin, root', `${ORIGIN}/`, 'WRONG_ROUTE'],
    // A Wi-Fi QR parses as a URL with a `wifi:` protocol — caught by the
    // scheme check rather than the parser, but rejected either way.
    ['a Wi-Fi provisioning QR', 'WIFI:S=home;T=WPA;P=hunter2;;', 'BAD_SCHEME'],
    ['not a URL at all', 'just some scanned text', 'MALFORMED'],
    ['empty', '   ', 'EMPTY'],
  ])('rejects %s', (_label, raw, reason) => {
    const r = link(raw)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe(reason)
  })

  it('rejects a misaka:// value that maps to a non-join route', () => {
    const r = link('misaka://network?x=1')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('WRONG_ROUTE')
  })
})

describe('SECURITY-006 parameter allow-list', () => {
  it.each([
    ['unknown parameter', `?type=node&id=1&t=${TOKEN}&redirect=https://evil.example`],
    ['duplicated parameter', `?type=node&id=1&id=2&t=${TOKEN}`],
    ['unknown type', `?type=admin&id=1&t=${TOKEN}`],
    ['missing token', '?type=node&id=1'],
    ['token with punctuation', '?type=node&id=1&t=../../etc/passwd'],
    ['token too short', '?type=node&id=1&t=abc'],
    ['missing id', `?type=node&t=${TOKEN}`],
    ['id below range', `?type=node&id=0&t=${TOKEN}`],
    ['id above range', `?type=node&id=20002&t=${TOKEN}`],
    ['non-numeric id', `?type=node&id=1e3&t=${TOKEN}`],
    ['non-base64 passcode', `?type=node&id=1&t=${TOKEN}&c=<script>`],
    ['fid with a slash', `?type=file&id=1&t=${TOKEN}&fid=a/b`],
  ])('rejects %s', (_label, query) => {
    const r = link(`${ORIGIN}${JOIN}${query}`)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('BAD_PARAM')
  })

  it('drops the fragment and rebuilds the query from validated values only', () => {
    const r = link(`${ORIGIN}${JOIN}?type=node&id=00042&t=${TOKEN}#/evil`)
    expect(r).toEqual({ ok: true, path: `/join?type=node&id=42&t=${TOKEN}` })
  })

  it('defaults a missing type to node rather than passing it through', () => {
    const r = link(`${ORIGIN}${JOIN}?id=5&t=${TOKEN}`)
    expect(r).toEqual({ ok: true, path: `/join?type=node&id=5&t=${TOKEN}` })
  })
})

describe('SECURITY-006 user-facing copy', () => {
  beforeEach(() => { /* no state */ })

  it('uses the prescribed wording and never echoes the rejected value', () => {
    expect(describeJoinLinkRejection('FOREIGN_ORIGIN'))
      .toBe('仅扫描御坂网络接入码。请扫描或粘贴本站生成的接入链接。')
    expect(describeJoinLinkRejection('BAD_SCHEME'))
      .toContain('仅扫描御坂网络接入码')
    expect(describeJoinLinkRejection('BAD_PARAM'))
      .toBe('请扫描或粘贴本站生成的接入链接。')
  })
})
