// Builds the Monaco probe page (packages/ui/probe) and loads it in Electron under the production CSP and app:// protocol.
// Prints the probe's own report and exits 0 when the editor, workers, decorations and breakpoints work. Usage: node scripts/probe-monaco.mjs
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
// Electron must not start as plain Node (some shells, e.g. VS Code's terminal, set ELECTRON_RUN_AS_NODE).
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.ELECTRON_RUN_AS_NODE; return e }
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-probe-ui-'))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-probe-home-'))

await build({
  configFile: path.join(root, 'packages', 'ui', 'vite.config.ts'), logLevel: 'warn',
  build: { outDir: out, emptyOutDir: true, rollupOptions: { input: path.join(root, 'packages', 'ui', 'probe', 'monaco.html') } },
})
spawnSync('node', [path.join(root, 'scripts', 'build-electron.mjs')], { stdio: 'ignore' })

const child = spawn(electronBin, [path.join(root, 'apps', 'electron')], {
  env: cleanEnv({ SCRIPTHUB_HOME: home, SCRIPTHUB_SMOKE: '0', SCRIPTHUB_UI_DIR: out, SCRIPTHUB_PAGE: 'probe/monaco.html', SCRIPTHUB_PROBE: '1', SCRIPTHUB_DEV_URL: '' }),
  stdio: ['ignore', 'pipe', 'pipe'],
})
let buf = ''
let result = null
const timer = setTimeout(() => { console.error('[probe] timed out'); child.kill() }, 60000)
const onData = (d) => {
  buf += d
  for (const line of String(d).split('\n')) {
    if (line.includes('PROBE_RESULT ')) {
      result = JSON.parse(line.slice(line.indexOf('PROBE_RESULT ') + 13))
      child.kill()
    } else if (line.trim()) console.log(line)
  }
}
child.stdout.on('data', onData)
child.stderr.on('data', onData)
child.on('exit', () => {
  clearTimeout(timer)
  fs.rmSync(out, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
  console.log('[probe] result:', JSON.stringify(result))
  const ok = result && result.editor && result.bpGlyphs >= 1 && result.paramLine >= 1 && result.lines >= 1 && !result.error
  console.log(ok ? '[probe] OK' : '[probe] FAILED')
  process.exit(ok ? 0 : 1)
})
