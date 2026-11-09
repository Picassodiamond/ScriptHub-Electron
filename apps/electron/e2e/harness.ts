/**
 * Launch the REAL built app (apps/electron/dist/main.cjs) with Playwright and drive its UI.
 * Every launch gets its own throwaway data folder (SCRIPTHUB_HOME), Electron profile and a copy of the sample
 * scripts, so nothing real is touched. Native dialogs are answered from a queue file (SCRIPTHUB_TEST_DIALOGS).
 */
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
export const ROOT = path.resolve(__dirname, '..', '..', '..')
export const APP = path.join(ROOT, 'apps', 'electron')
export const SHOTS = path.join(__dirname, 'screenshots')
export const PY = process.platform === 'win32' ? 'python' : 'python3'

const made: string[] = []
export const tmp = (prefix: string) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  made.push(d)
  return d
}
/** Remove only the throwaway folders THIS test file created (see setup.ts); nothing else in the temp folder is touched. */
export function cleanupTemp(): void {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function until<T>(fn: () => T | Promise<T>, what: string, ms = 20000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v as NonNullable<T>
    } catch (e) { last = e }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${what}${last ? ` (${String((last as Error).message ?? last).split('\n')[0]})` : ''}`)
}

export interface Launched {
  app: ElectronApplication
  page: Page
  home: string
  profile: string
  /** a writable copy of samples/sample_scripts */
  scripts: string
  /** a second, empty folder */
  work: string
  dialogs: { push(kind: 'pickFolder' | 'pickFiles' | 'openProject' | 'saveProject' | 'saveFile' | 'quit', value: unknown): void }
  /** click an item of the native application menu, e.g. menu('File', 'Open folder') */
  menu(...labels: string[]): Promise<void>
  shot(name: string): Promise<void>
  /** what the main process printed so far */
  logs: string[]
  /** resolves when the app process has exited */
  exited: Promise<void>
  /** console errors and uncaught exceptions of the page */
  errors: string[]
  close(): Promise<void>
}

export interface LaunchOptions {
  /** reuse these folders (a relaunch) */
  home?: string
  profile?: string
  scripts?: string
  work?: string
  /** extra files to create in the scripts folder before launch: name -> text */
  files?: Record<string, string>
}

export async function launch(opts: LaunchOptions = {}): Promise<Launched> {
  const home = opts.home ?? tmp('sh-e2e-home-')
  const profile = opts.profile ?? tmp('sh-e2e-profile-')
  const work = opts.work ?? tmp('sh-e2e-work-')
  let scripts = opts.scripts
  if (!scripts) {
    scripts = tmp('sh-e2e-scripts-')
    fs.cpSync(path.join(ROOT, 'samples', 'sample_scripts'), scripts, { recursive: true })
  }
  for (const [name, text] of Object.entries(opts.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(scripts, name)), { recursive: true })
    fs.writeFileSync(path.join(scripts, name), text)
  }
  const dialogFile = path.join(profile, 'dialogs.json')
  if (!fs.existsSync(dialogFile)) fs.writeFileSync(dialogFile, '{}')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  Object.assign(env, { SCRIPTHUB_HOME: home, SCRIPTHUB_TEST_DIALOGS: dialogFile, SCRIPTHUB_DEV_URL: '' })
  const app = await _electron.launch({
    executablePath: require('electron') as string,
    args: [APP, `--user-data-dir=${profile}`],
    env,
    timeout: 60000,
  })
  const logs: string[] = []
  const exited = new Promise<void>((resolve) => app.on('close', () => resolve()))
  app.process().stdout?.on('data', (d) => logs.push(String(d)))
  app.process().stderr?.on('data', (d) => logs.push(String(d)))
  const page = await app.firstWindow()
  await page.waitForSelector('.wb', { timeout: 30000 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  const l: Launched = {
    app, page, home, profile, scripts, work, logs, exited, errors,
    dialogs: {
      push(kind, value) {
        const data = JSON.parse(fs.readFileSync(dialogFile, 'utf8'))
        ;(data[kind] ??= []).push(value)
        fs.writeFileSync(dialogFile, JSON.stringify(data))
      },
    },
    async menu(...labels) {
      await app.evaluate(({ Menu }, path) => {
        let items: any[] = Menu.getApplicationMenu()!.items
        let found: any = null
        for (const label of path) {
          found = items.find((i: any) => String(i.label).replace(/&/g, '').startsWith(label))
          if (!found) throw new Error(`no menu item "${label}"`)
          items = found.submenu ? found.submenu.items : []
        }
        found.click()
      }, labels)
    },
    async shot(name) {
      fs.mkdirSync(SHOTS, { recursive: true })
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
    },
    async close() {
      await app.evaluate(({ app: a }) => { (globalThis as any).__forceQuit = true; a.exit(0) }).catch(() => {})
      await app.close().catch(() => {})
      if (errors.length) console.warn('[page errors]', errors.join('\n'))
    },
  }
  return l
}

/** Open a folder the way a user does: the native File menu answers with the queued folder. */
export async function openFolder(l: Launched, folder: string): Promise<void> {
  l.dialogs.push('pickFolder', folder)
  await l.menu('File', 'Open folder')
  await until(async () => (await l.page.locator('#tree .tree-item').count()) > 0, 'explorer to list scripts', 30000)
}
