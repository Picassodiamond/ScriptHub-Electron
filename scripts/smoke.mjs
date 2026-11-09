// Smoke test: build the renderer and the main process, start the built app once (window hidden, throwaway
// data folder), wait for the page to report that the workbench rendered, and exit with 0 (ok) or 1 (failed).
// Usage: npm run smoke
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
// Electron must not start as plain Node (some shells, e.g. VS Code's terminal, set ELECTRON_RUN_AS_NODE).
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.ELECTRON_RUN_AS_NODE; return e }
const run = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

run([path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', path.join(root, 'packages', 'ui', 'vite.config.ts'), '--logLevel', 'warn'])
run([path.join(root, 'scripts', 'build-electron.mjs')])
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-smoke-'))
console.log(`[smoke] launching Electron with data folder ${home}`)
const child = spawn(electronBin, [path.join(root, 'apps', 'electron')], {
  cwd: root, env: cleanEnv({ SCRIPTHUB_HOME: home, SCRIPTHUB_SMOKE: '1', SCRIPTHUB_DEV_URL: '' }), stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
const onData = (d) => { out += d; process.stdout.write(d) }
child.stdout.on('data', onData)
child.stderr.on('data', onData)
const timer = setTimeout(() => { console.error('[smoke] timed out'); child.kill() }, 60000)
child.on('exit', (code) => {
  clearTimeout(timer)
  fs.rmSync(home, { recursive: true, force: true })
  const line = out.split('\n').find((l) => l.startsWith('SMOKE_RESULT '))
  if (code === 0 && line) console.log('[smoke] OK')
  else console.error(`[smoke] FAILED (exit ${code})`)
  process.exit(code === 0 && line ? 0 : 1)
})
