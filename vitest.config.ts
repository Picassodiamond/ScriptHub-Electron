import path from 'node:path'
import { defineConfig } from 'vitest/config'

const p = (...s: string[]) => path.resolve(__dirname, ...s)
// Workspace packages are used from their sources (no separate package build), here as in the app bundles.
export default defineConfig({
  resolve: {
    alias: {
      '@scripthub/protocol': p('packages/protocol/src/index.ts'),
      '@scripthub/engine': p('packages/engine/src/index.ts'),
      '@scripthub/client': p('packages/client/src/index.ts'),
    },
  },
  test: { include: ['packages/*/test/**/*.test.ts'], testTimeout: 20000 },
})
