import path from 'node:path'
import { fileURLToPath } from 'node:url'
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: here,
  base: './',
  plugins: [preact()],
  resolve: {
    alias: {
      '@scripthub/client': path.resolve(here, '../client/src/index.ts'),
      '@scripthub/protocol': path.resolve(here, '../protocol/src/web.ts'),
    },
  },
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome120', chunkSizeWarningLimit: 4000, sourcemap: false },
  server: { host: '127.0.0.1', port: 5173 },
})
