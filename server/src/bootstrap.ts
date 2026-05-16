// Load .env before all static imports so config.ts sees the env vars.
import { existsSync } from 'fs'
const envPath = new URL('../../.env', import.meta.url).pathname
if (existsSync(envPath)) process.loadEnvFile(envPath)
await import('./index.js')
