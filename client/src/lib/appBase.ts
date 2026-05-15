const DEFAULT_REPO_BASE = '/Misaka-Network'

function normalizeBase(base?: string): string {
  if (!base || base === '/' || base === './') return ''
  const withLeading = base.startsWith('/') ? base : `/${base}`
  return withLeading.replace(/\/+$/, '')
}

function configuredBase(): string {
  const runtime = window.__MISAKA_CONFIG__?.APP_BASE
  return normalizeBase(runtime || import.meta.env.VITE_APP_BASE)
}

function githubPagesBase(): string {
  if (!location.hostname.endsWith('.github.io')) return ''

  const repoBase = normalizeBase(import.meta.env.VITE_REPO_BASE || DEFAULT_REPO_BASE)
  if (!repoBase) return ''

  return location.pathname === repoBase || location.pathname.startsWith(`${repoBase}/`)
    ? repoBase
    : ''
}

export function appBasePath(): string {
  return configuredBase() || githubPagesBase()
}

export function appPath(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${appBasePath()}${cleanPath}`
}

export function appUrl(path: string): string {
  return `${location.origin}${appPath(path)}`
}

export function publicAssetUrl(path: string): string {
  const cleanPath = path.replace(/^\/+/, '')
  return new URL(cleanPath, document.baseURI).toString()
}
