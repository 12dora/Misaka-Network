import { defineConfig } from 'vitest/config'
import path from 'path'

// jsdom for code that touches DOM/window/sessionStorage (auth store,
// authedFetch). Pure-logic tests can still opt out with @vitest-environment.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.{ts,tsx,mjs}'],
    globals: false,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.ts', 'src/store/**/*.ts'],
      exclude: ['src/lib/sound.ts', 'src/lib/notify.ts'],
    },
  },
})
