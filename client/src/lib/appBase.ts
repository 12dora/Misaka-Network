// ── The single deployment base ────────────────────────────────────────
// Asset URLs, the router basename, the GitHub Pages 404 redirect and every
// absolute link we hand out (QR invites, scanner navigation) must agree on
// ONE answer to "where is this app mounted". That answer is the Vite `base`
// the bundle was built with, exposed at runtime as `import.meta.env.BASE_URL`
// and substituted into `dist/404.html` by the `misaka-base-aware-404` plugin
// in vite.config.ts. CI sets it from the real Pages base path — see
// .github/workflows/deploy.yml.
//
// A relative base ('./', the default) means "served from the origin root"
// as far as routing goes, and normalizes to ''.

function normalizeBase(base?: string): string {
  if (!base) return ''
  const trimmed = base.trim()
  if (trimmed === '' || trimmed === '/' || trimmed === './' || trimmed === '.') return ''
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeading.replace(/\/+$/, '')
}

function buildBase(): string {
  return normalizeBase(import.meta.env.BASE_URL)
}

export function appBasePath(): string {
  return buildBase()
}

export function appPath(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${appBasePath()}${cleanPath}`
}

export function appUrl(path: string): string {
  return `${location.origin}${appPath(path)}`
}

// Resolve a file that lives in `public/`. Anchored on the deployment base
// rather than `document.baseURI`, so the result does not drift with the
// current route (`/network` vs `/network/` used to resolve differently).
export function publicAssetUrl(path: string): string {
  const cleanPath = path.replace(/^\/+/, '')
  return new URL(cleanPath, `${location.origin}${appBasePath()}/`).toString()
}
