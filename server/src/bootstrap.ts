// ── Single startup entry point ───────────────────────────────────────
// Every documented way of starting the signaling server goes through this
// file: `npm run dev`, `npm start` and the Docker image CMD. It loads the
// env file(s) BEFORE the static import of ./index.js so config.ts sees the
// values, then hands over.
//
// Search order — the FIRST file that exists in each slot is loaded, and an
// env var that is already present in `process.env` always wins over any
// file (Node's `process.loadEnvFile` never overwrites an existing value).
// That ordering is what lets docker-compose `environment:` entries override
// a baked-in file, and lets `MISAKA_ENV_FILE` override everything:
//
//   1. $MISAKA_ENV_FILE      explicit override (absolute or relative path)
//   2. <repo>/server/.env    server-local config — see server/.env.example
//   3. <repo>/.env           repo-root secrets shared with docker-compose.yml
//
// `dist/index.js` remains importable on its own for callers that inject a
// complete environment themselves (the integration tests and the Playwright
// webServer do exactly that, on purpose, so a stray developer .env can never
// leak into a test run).

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))   // server/src (tsx) or server/dist (built)
const serverDir = join(here, '..')
const repoRoot = join(serverDir, '..')

const candidates = [
  process.env.MISAKA_ENV_FILE,
  join(serverDir, '.env'),
  join(repoRoot, '.env'),
]

for (const candidate of candidates) {
  if (!candidate) continue
  const file = resolve(candidate)
  if (!existsSync(file)) continue
  process.loadEnvFile(file)
  console.log(`[bootstrap] loaded env file: ${file}`)
}

await import('./index.js')
