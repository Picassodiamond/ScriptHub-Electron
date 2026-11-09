// Bundles the Electron main process and the preload script (TypeScript -> CommonJS) with esbuild.
// The engine and protocol packages are bundled from their sources, so no separate package build is needed.
// Usage: node scripts/build-electron.mjs [--watch]   (watch: used by scripts/dev.mjs, which restarts Electron)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = path.join(root, 'apps', 'electron')

export const options = (plugins = []) => ({
  entryPoints: { main: path.join(app, 'src', 'main.ts'), preload: path.join(app, 'src', 'preload.ts') },
  outdir: path.join(app, 'dist'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron'],
  alias: {
    '@scripthub/engine': path.join(root, 'packages', 'engine', 'src', 'index.ts'),
    '@scripthub/protocol': path.join(root, 'packages', 'protocol', 'src', 'index.ts'),
  },
  logLevel: 'info',
  plugins,
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await esbuild.build(options())
}
