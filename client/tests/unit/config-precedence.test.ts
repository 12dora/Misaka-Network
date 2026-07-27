// CONFIG-006 — runtime config precedence was the inverse of its documented
// contract.
//
// `config.ts` documents:  window.__MISAKA_CONFIG__ > config.json > env > default
// `loadConfig()` did:     window.__MISAKA_CONFIG__ = data      ← wholesale replace
//
// Since `public/config.json` always ships with the official endpoints, an
// embedder that injected a private backend had it silently swapped for the
// public one the moment the JSON landed. Users connected to a signalling
// server the operator never chose.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mergeRuntimeConfig, validateConfig, loadConfig, getConfig, __resetConfig } from '../../src/config'

const INJECTED = { API_BASE: 'https://private.internal', WS_URL: 'wss://private.internal/ws' }
const PUBLIC_JSON = { API_BASE: 'https://misaka.konata.tv', WS_URL: 'wss://misaka.konata.tv/ws' }

describe('CONFIG-006: mergeRuntimeConfig precedence', () => {
  it('REGRESSION — host-injected values win over fetched config.json', () => {
    expect(mergeRuntimeConfig(INJECTED, PUBLIC_JSON)).toEqual(INJECTED)
  })

  it('fetched JSON fills only the fields the host did not inject', () => {
    expect(mergeRuntimeConfig({ API_BASE: 'https://private.internal' }, PUBLIC_JSON)).toEqual({
      API_BASE: 'https://private.internal',
      WS_URL: 'wss://misaka.konata.tv/ws',
    })
  })

  it('with nothing injected, config.json is used verbatim', () => {
    expect(mergeRuntimeConfig({}, PUBLIC_JSON)).toEqual(PUBLIC_JSON)
  })

  it('APP_BASE injected by the host survives a config.json that also sets it', () => {
    expect(mergeRuntimeConfig({ APP_BASE: '/embedded' }, { APP_BASE: '/Misaka-Network' }))
      .toEqual({ APP_BASE: '/embedded' })
  })
})

describe('CONFIG-006: schema validation', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })

  it('keeps well-formed absolute URLs', () => {
    expect(validateConfig(PUBLIC_JSON, 'test')).toEqual(PUBLIC_JSON)
  })

  it.each([
    ['relative API_BASE', { API_BASE: '/api' }],
    ['non-http API_BASE', { API_BASE: 'ftp://example.com' }],
    ['javascript: API_BASE', { API_BASE: 'javascript:alert(1)' }],
    ['numeric API_BASE', { API_BASE: 42 }],
    ['http WS_URL', { WS_URL: 'https://example.com/ws' }],
    ['garbage WS_URL', { WS_URL: 'not a url' }],
    ['absolute APP_BASE', { APP_BASE: 'https://evil.example/' }],
  ])('drops %s', (_label, raw) => {
    expect(validateConfig(raw, 'test')).toEqual({})
  })

  it('ignores non-object input entirely', () => {
    expect(validateConfig(null, 'test')).toEqual({})
    expect(validateConfig('nope', 'test')).toEqual({})
    expect(validateConfig(undefined, 'test')).toEqual({})
  })

  it('keeps the valid half of a partially bad object', () => {
    expect(validateConfig({ API_BASE: 'https://ok.example', WS_URL: 'garbage' }, 'test'))
      .toEqual({ API_BASE: 'https://ok.example' })
  })
})

describe('CONFIG-006: loadConfig end-to-end', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    __resetConfig()
    delete window.__MISAKA_CONFIG__
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    __resetConfig()
    delete window.__MISAKA_CONFIG__
  })

  function mockFetch(body: unknown, ok = true) {
    globalThis.fetch = vi.fn(async () => ({
      ok,
      json: async () => body,
    })) as unknown as typeof fetch
  }

  it('REGRESSION — an injected private backend survives a public config.json', async () => {
    window.__MISAKA_CONFIG__ = { ...INJECTED }
    mockFetch(PUBLIC_JSON)

    const cfg = await loadConfig()

    expect(cfg.API_BASE).toBe(INJECTED.API_BASE)
    expect(cfg.WS_URL).toBe(INJECTED.WS_URL)
    // The published object must reflect the same precedence for later readers
    // (appBase.ts reads APP_BASE straight off it).
    expect(window.__MISAKA_CONFIG__).toEqual(INJECTED)
  })

  it('uses config.json when the host injected nothing', async () => {
    mockFetch(PUBLIC_JSON)
    const cfg = await loadConfig()
    expect(cfg.API_BASE).toBe(PUBLIC_JSON.API_BASE)
  })

  it('rejects a malformed config.json rather than adopting it', async () => {
    mockFetch({ API_BASE: 'javascript:alert(1)', WS_URL: 'nope' })
    const cfg = await loadConfig()
    // Falls through to env/default (empty under `vite dev`, where the proxy
    // handles /api) instead of adopting the poisoned value.
    expect(cfg.API_BASE).not.toContain('javascript:')
    expect(cfg.WS_URL).not.toBe('nope')
    expect(window.__MISAKA_CONFIG__).toEqual({})
  })

  it('EDGE — a hanging config.json does not hang boot forever', async () => {
    // BUG-028: `loadConfig()` had no deadline, so a never-resolving request
    // blocked `boot()` and the page stayed blank.
    globalThis.fetch = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
      })) as unknown as typeof fetch

    const cfg = await loadConfig(20)

    expect(cfg).toBeDefined()
    expect(typeof cfg.API_BASE).toBe('string')
  })

  it('EDGE — a network failure still yields a usable config', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    const cfg = await loadConfig()
    expect(typeof cfg.API_BASE).toBe('string')
    expect(typeof cfg.WS_URL).toBe('string')
  })

  it('getConfig() before loadConfig() honours injected values and validates them', () => {
    window.__MISAKA_CONFIG__ = { API_BASE: 'https://private.internal', WS_URL: 'javascript:x' }
    const cfg = getConfig()
    expect(cfg.API_BASE).toBe('https://private.internal')
    expect(cfg.WS_URL).not.toContain('javascript:')
  })
})
