import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// ── The single deployment base ────────────────────────────────────────
// One value drives asset URLs, `import.meta.env.BASE_URL` (which the router
// basename and every absolute link derive from — see src/lib/appBase.ts) and
// the GitHub Pages 404 redirect. CI sets VITE_BASE from the real Pages base
// path; see .github/workflows/deploy.yml.
//
// Default './' = relative asset URLs, which work at a custom-domain root, a
// self-hosted root, or a `file://`-style preview. For routing purposes a
// relative base means "mounted at the origin root".
function resolveBase(): string {
  const raw = process.env.VITE_BASE?.trim()
  if (!raw || raw === '.' || raw === './') return './'
  if (raw === '/') return '/'
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`
}

// Rewrites `%BASE_URL%` in the copied-verbatim public/404.html so the Pages
// SPA fallback redirects to the same base the bundle was built with. Runs in
// closeBundle, i.e. after Vite has copied publicDir into outDir.
function baseAware404(): Plugin {
  let base = './'
  let root = process.cwd()
  let outDir = 'dist'

  return {
    name: 'misaka-base-aware-404',
    apply: 'build',
    configResolved(config) {
      base = config.base
      root = config.root
      outDir = config.build.outDir
    },
    closeBundle() {
      const file = path.resolve(root, outDir, '404.html')
      if (!fs.existsSync(file)) return
      // A relative base means "origin root" as far as navigation goes.
      const navBase = base.startsWith('/') ? base : '/'
      const html = fs.readFileSync(file, 'utf8').split('%BASE_URL%').join(navBase)
      fs.writeFileSync(file, html)
    },
  }
}

export default defineConfig(() => ({
  plugins: [react(), baseAware404()],
  base: resolveBase(),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:9080',
      '/ws': { target: 'ws://localhost:9080', ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom', 'zustand'],
          qr: ['qrcode', 'jsqr'],
        },
      },
    },
  },
}))
