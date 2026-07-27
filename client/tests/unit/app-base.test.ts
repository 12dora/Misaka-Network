// CONFIG-005 — asset base, router base, the Pages 404 fallback and every
// absolute link we hand out must all derive from ONE deployment base.
//
// `appBase.ts` used to carry a hard-coded `github.io` + `/Misaka-Network`
// fallback, so a fork (or a rename) got assets from one path and routes from
// another. It now derives from `import.meta.env.BASE_URL`, which Vite fills
// from the build's real base. `publicAssetUrl` was additionally anchored on
// `document.baseURI`, which drifts with the current route.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

async function loadAppBase() {
  vi.resetModules()
  return import('../../src/lib/appBase')
}

describe('CONFIG-005: appBasePath derives from the deployment base', () => {
  beforeEach(() => {
    delete window.__MISAKA_CONFIG__
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    delete window.__MISAKA_CONFIG__
  })

  it("a relative base ('./', the default) means origin root", async () => {
    vi.stubEnv('BASE_URL', './')
    const { appBasePath } = await loadAppBase()
    expect(appBasePath()).toBe('')
  })

  it('a subpath base is normalized without its trailing slash', async () => {
    vi.stubEnv('BASE_URL', '/repo/')
    const { appBasePath } = await loadAppBase()
    expect(appBasePath()).toBe('/repo')
  })

  it("a root base ('/') normalizes to the empty base", async () => {
    vi.stubEnv('BASE_URL', '/')
    const { appBasePath } = await loadAppBase()
    expect(appBasePath()).toBe('')
  })

  it('REGRESSION — an unknown host gets no hard-coded /Misaka-Network base', async () => {
    vi.stubEnv('BASE_URL', './')
    const { appBasePath, appPath } = await loadAppBase()
    expect(appBasePath()).toBe('')
    expect(appPath('/join')).toBe('/join')
  })

  it('runtime config cannot split routing from the build asset base', async () => {
    vi.stubEnv('BASE_URL', '/repo/')
    window.__MISAKA_CONFIG__ = { API_BASE: 'https://api.example' }
    const { appBasePath, appPath } = await loadAppBase()
    expect(appBasePath()).toBe('/repo')
    expect(appPath('join')).toBe('/repo/join')
  })
})

describe('CONFIG-005: publicAssetUrl is route-independent', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    delete window.__MISAKA_CONFIG__
    window.history.replaceState({}, '', '/')
  })

  it('REGRESSION — resolves identically from /network and from /network/', async () => {
    vi.stubEnv('BASE_URL', '/repo/')
    const { publicAssetUrl } = await loadAppBase()

    window.history.replaceState({}, '', '/repo/network')
    const fromRoute = publicAssetUrl('config.json')

    window.history.replaceState({}, '', '/repo/network/')
    const fromNestedRoute = publicAssetUrl('config.json')

    expect(fromRoute).toBe(fromNestedRoute)
    expect(fromRoute).toBe(`${location.origin}/repo/config.json`)
  })

  it('tolerates a leading slash in the asset path', async () => {
    vi.stubEnv('BASE_URL', '/repo/')
    const { publicAssetUrl } = await loadAppBase()
    expect(publicAssetUrl('/sw.js')).toBe(`${location.origin}/repo/sw.js`)
  })

  it('serves from the origin root when the base is relative', async () => {
    vi.stubEnv('BASE_URL', './')
    const { publicAssetUrl } = await loadAppBase()
    window.history.replaceState({}, '', '/network')
    expect(publicAssetUrl('config.json')).toBe(`${location.origin}/config.json`)
  })
})
