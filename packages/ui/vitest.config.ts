import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = path.dirname(fileURLToPath(import.meta.url))

// UI component tests: jsdom + Preact. Run with: npx vitest run --config packages/ui/vitest.config.ts
export default defineConfig({
  root: here,
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  resolve: {
    alias: {
      '@scripthub/client': path.resolve(here, '../client/src/index.ts'),
      '@scripthub/protocol': path.resolve(here, '../protocol/src/web.ts'),
    },
  },
  test: { environment: 'jsdom', include: ['test/**/*.test.tsx'], setupFiles: ['test/setup.ts'], testTimeout: 15000 },
})
