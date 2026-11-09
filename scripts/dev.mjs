// Development: Vite dev server for the UI (hot reload) + Electron, restarted when the main process code changes.
// Data goes to SCRIPTHUB_HOME if set, else the normal data folder. Usage: npm run dev
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import { createServer } from 'vite'
import { options } from './build-electron.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = (await import('node:module')).createRequire(import.meta.url)('electron')
// Electron must not start as plain Node (some shells, e.g. VS Code's terminal, set ELECTRON_RUN_AS_NODE).
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.ELECTRON_RUN_AS_NODE; return e }

const server = await createServer({ root: path.join(root, 'packages', 'ui'), configFile: path.join(root, 'packages', 'ui', 'vite.config.ts'), server: { port: 5173, strictPort: true, host: '127.0.0.1' } })
await server.listen()
const url = `http://127.0.0.1:${server.config.server.port}/`
console.log(`[dev] UI at ${url}`)

let child = null
let restarting = false
function start() {
  child = spawn(electronBin, [path.join(root, 'apps', 'electron')], {
    stdio: 'inherit', env: cleanEnv({ SCRIPTHUB_DEV_URL: url }),
  })
  child.on('exit', (code) => {
    if (!restarting) {
      console.log(`[dev] Electron exited (${code}); stopping`)
      shutdown()
    }
  })
}
function restart() {
  if (!child) return start()
  restarting = true
  child.once('exit', () => {
    restarting = false
    start()
  })
  child.kill()
}
let first = true
const ctx = await esbuild.context(options([{
  name: 'restart', setup(b) {
    b.onEnd((r) => {
      if (r.errors.length) return
      if (first) { first = false; start() } else { console.log('[dev] main process rebuilt, restarting Electron'); restart() }
    })
  },
}]))
await ctx.watch()

async function shutdown() {
  await ctx.dispose()
  await server.close()
  child?.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
