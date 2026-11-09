import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// Real-app tests: each file launches Electron; run them one at a time.
export default defineConfig({
  root,
  test: {
    include: ['apps/electron/e2e/**/*.e2e.ts'],
    setupFiles: ['apps/electron/e2e/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 120000,
    hookTimeout: 120000,
  },
})
