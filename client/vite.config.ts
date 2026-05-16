import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Relative asset URLs let one build work at a custom domain root,
  // a GitHub Pages repo path, or a self-hosted domain/path.
  base: process.env.VITE_BASE ?? './',
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
