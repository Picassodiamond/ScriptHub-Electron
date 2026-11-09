/**
 * ScriptHub desktop app: the Electron main process.
 * It owns the Engine (all script discovery, runs and history), exposes it to the page through one IPC channel
 * ('sh:request', see preload.ts) and provides the host services the engine cannot (dialogs, tray, menu, notifications).
 * There is no HTTP server: the page is loaded from the app:// protocol (or the Vite dev server in development).
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, session, shell, Tray, type IpcMainInvokeEvent,
} from 'electron'
import { ApiError, type EventName, type Events } from '@scripthub/protocol'
import { Engine, registerHandlers, type HostServices } from '@scripthub/engine'
import { buildMenu } from './menu.js'
import { loadWindowState, trackWindowState } from './windowState.js'

const DEV_URL = process.env.SCRIPTHUB_DEV_URL || ''
const SMOKE = process.env.SCRIPTHUB_SMOKE === '1'
const PROBE = process.env.SCRIPTHUB_PROBE === '1' // scripts/probe-monaco.mjs: load a probe page, no window, no tray
const IS_MAC = process.platform === 'darwin'
// End-to-end tests (apps/electron/e2e): a JSON file {pickFolder:[…], pickFiles:[[…]], openProject:[…], saveProject:[…], saveFile:[…],
// quit:[0|1]} whose queues answer the native dialogs in order. Inert unless this variable is set.
const TEST_DIALOGS = process.env.SCRIPTHUB_TEST_DIALOGS || ''
function testDialog(kind: string): { value: any } | null {
  if (!TEST_DIALOGS) return null
  let data: Record<string, unknown[]> = {}
  try { data = JSON.parse(fs.readFileSync(TEST_DIALOGS, 'utf8')) } catch { /* no queue: cancel */ }
  const q = Array.isArray(data[kind]) ? data[kind] : []
  const value = q.shift()
  data[kind] = q
  try { fs.writeFileSync(TEST_DIALOGS, JSON.stringify(data)) } catch { /* ignore */ }
  return { value: value === undefined ? null : value }
}
const log = (...a: unknown[]) => console.log('[main]', ...a)

// ------------------------------------------------------------------ paths ---
/** The monorepo root in development; the folder of the program when packaged (a `runtime` folder there = portable mode). */
const appDir = app.isPackaged ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath) : path.resolve(__dirname, '..', '..', '..')
const resources = app.isPackaged ? process.resourcesPath : appDir
const uiDir = process.env.SCRIPTHUB_UI_DIR || (app.isPackaged ? path.join(process.resourcesPath, 'ui') : path.join(appDir, 'packages', 'ui', 'dist'))
const samplesDir = path.join(resources, 'samples', 'sample_projects')
const assets = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(appDir, 'apps', 'electron', 'assets')

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

// ------------------------------------------------------------------ state ---
let win: BrowserWindow | null = null
let tray: Tray | null = null
let engine: Engine
let handlers: ReturnType<typeof registerHandlers>
let quitting = false
let trayHintShown = false

const CSP_PROD = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "worker-src 'self' blob:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ')
// Vite's dev server needs inline scripts (HMR preamble) and a websocket.
const CSP_DEV = CSP_PROD.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'self'", "connect-src 'self' ws: http:")

function isOurOrigin(url: string): boolean {
  if (url.startsWith('app://')) return true
  return !!DEV_URL && url.startsWith(DEV_URL)
}

// ------------------------------------------------------------ host services ---
const host: HostServices = {
  clientId: 'desktop',
  async pickFolder() {
    const t = testDialog('pickFolder')
    if (t) return t.value
    const r = await dialog.showOpenDialog(win!, { title: 'Open a script folder', properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0] ?? null
  },
  async pickFiles() {
    const t = testDialog('pickFiles')
    if (t) return Array.isArray(t.value) ? t.value : []
    const r = await dialog.showOpenDialog(win!, {
      title: 'Open script files', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Scripts', extensions: ['py', 'sh', 'bash', 'bat', 'cmd', 'ps1'] }, { name: 'All files', extensions: ['*'] }],
    })
    return r.canceled ? [] : r.filePaths
  },
  notify(title, body) {
    if (Notification.isSupported()) new Notification({ title, body, icon: path.join(assets, 'scripthub.png') }).show()
  },
  reveal(target) {
    shell.showItemInFolder(target)
  },
}

// ------------------------------------------------------------------ events ---
const FINAL = ['success', 'failed', 'timed_out', 'cancelled', 'interrupted']

function emit<E extends EventName>(event: E, payload: Events[E]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('sh:event', { event, payload })
  if (event === 'workspace.changed') void refreshMenu()
  if (event === 'run.status') {
    const p = payload as Events['run.status']
    if (FINAL.includes(String(p.status)) && win && !win.isFocused()) {
      const name = String((p as any).script_name ?? 'Run')
      notifyRun(`${name} — ${p.status_label ?? p.status}`, String(p.id), { id: String(p.id), scriptId: (p as any).script_id, title: name })
    }
  }
}

const send = (name: string, args?: Record<string, unknown>) => emit('app.command', { name, args })

/** A "run finished" notification; clicking it shows the window and opens that run (like the Django tray did). */
function notifyRun(title: string, body: string, run: Record<string, unknown>): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: path.join(assets, 'scripthub.png') })
  n.on('click', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    send('run.open', run)
  })
  n.show()
}

/** Start with Windows: the OS login item (packaged builds only; it starts the app hidden in the tray). */
const loginItemSupported = (): boolean => app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')
const BACKGROUND = process.argv.includes('--background')

// ------------------------------------------------------------- host calls ---
/** Calls only the desktop shell can answer (dialogs); they bypass the engine's protocol. */
async function hostCall(name: string, args: any): Promise<unknown> {
  switch (name) {
    case 'host.info':
      return { desktop: true, nativeMenu: true, platform: process.platform }
    case 'host.openProject': {
      const t = testDialog('openProject')
      if (t) return t.value
      const r = await dialog.showOpenDialog(win!, {
        title: 'Open a ScriptHub project', properties: ['openFile'], filters: [{ name: 'ScriptHub project', extensions: ['scripthub'] }],
      })
      return r.canceled ? null : r.filePaths[0] ?? null
    }
    case 'host.saveProject': {
      const overview = engine.workspace.overview()
      const base = String(args?.name || overview.folder?.name || 'project').replace(/[\\/:*?"<>|]+/g, '_')
      const t = testDialog('saveProject')
      const r = t ? { canceled: !t.value, filePath: t.value as string } : await dialog.showSaveDialog(win!, {
        title: 'Save project as', defaultPath: path.join(app.getPath('documents'), `${base}.scripthub`),
        filters: [{ name: 'ScriptHub project', extensions: ['scripthub'] }],
      })
      if (r.canceled || !r.filePath) return null
      return handlers.call('project.export', { name: args?.name, destination: r.filePath })
    }
    case 'host.saveFile': {
      // a text file the user asked to save (a log, an export): the native Save dialog, then write it
      const name = String(args?.suggestedName ?? 'file.txt').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'file.txt'
      const text = args?.text
      if (typeof text !== 'string' || text.length > 200 * 1024 * 1024) throw new ApiError('invalid', 'Nothing to save.')
      const ext = path.extname(name).replace(/^\./, '')
      const t = testDialog('saveFile')
      const r = t ? { canceled: !t.value, filePath: t.value as string } : await dialog.showSaveDialog(win!, {
        title: 'Save file', defaultPath: path.join(app.getPath('documents'), name),
        filters: [...(ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : []), { name: 'All files', extensions: ['*'] }],
      })
      if (r.canceled || !r.filePath) return null
      await fs.promises.writeFile(r.filePath, text, 'utf8')
      return { path: r.filePath }
    }
    case 'host.dataFolder':
      void shell.openPath(engine.dirs.runtime)
      return { ok: true }
    default:
      throw new ApiError('unknown_call', `Unknown host call: ${name}`)
  }
}

function wireError(e: unknown): { code: string; message: string; details?: unknown } {
  if (e instanceof ApiError) return e.toJSON()
  const x = e as any
  if (x && typeof x.code === 'string' && typeof x.message === 'string' && x.name === 'ApiError') return { code: x.code, message: x.message, details: x.details }
  log('unexpected error in a request:', x?.stack ?? x)
  return { code: 'internal', message: x?.message ? String(x.message) : 'Something went wrong.' }
}

function registerIpc(): void {
  ipcMain.handle('sh:request', async (e: IpcMainInvokeEvent, name: unknown, args: unknown) => {
    if (!isOurOrigin(e.senderFrame?.url ?? '')) return { ok: false, error: { code: 'forbidden', message: 'Request from an unknown page.' } }
    if (typeof name !== 'string') return { ok: false, error: { code: 'invalid', message: 'Missing call name.' } }
    try {
      const value = name.startsWith('host.') ? await hostCall(name, args) : await handlers.call(name, args)
      return { ok: true, value }
    } catch (err) {
      return { ok: false, error: wireError(err) }
    }
  })
  ipcMain.on('sh:drop', (e, paths: unknown) => {
    if (!isOurOrigin(e.senderFrame?.url ?? '') || !Array.isArray(paths)) return
    emit('app.drop', { paths: paths.filter((p): p is string => typeof p === 'string') })
  })
}

// ------------------------------------------------------------------- menu ---
async function refreshMenu(): Promise<void> {
  if (!engine) return
  const info = await handlers.call('app.info', {}).catch(() => null) as any
  Menu.setApplicationMenu(buildMenu({
    overview: engine.workspace.overview() as any, editingEnabled: !!info?.editingEnabled, version: info?.version ?? '', send, quit: () => void requestQuit(), isMac: IS_MAC,
  }))
}

// ------------------------------------------------------------------- quit ---
function activeJobs(): number {
  const c = engine.manager.counts()
  return c.running + c.queued + engine.sequencer.activeRuns().length
}

async function requestQuit(): Promise<void> {
  const n = activeJobs()
  if (n > 0) {
    const t = testDialog('quit')
    const r = t ? { response: Number(t.value ?? 1) } : await dialog.showMessageBox(win ?? undefined!, {
      type: 'question', buttons: ['Stop them and quit', 'Keep running'], defaultId: 1, cancelId: 1, title: 'ScriptHub',
      message: `${n} run${n === 1 ? ' is' : 's are'} still active.`, detail: 'Quitting stops them. Close the window instead to keep them running in the tray.',
    })
    if (r.response !== 0) return
    for (const run of engine.sequencer.activeRuns()) engine.sequencer.cancel(String(run.id))
    for (const id of engine.manager.activeIds()) engine.manager.cancel(id)
    await engine.manager.waitIdle(5000)
  }
  quitting = true
  app.quit()
}

// ------------------------------------------------------------------- tray ---
function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(assets, process.platform === 'win32' ? 'scripthub.ico' : 'scripthub.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  const show = () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  const update = () => {
    if (!tray || !engine) return
    const c = engine.manager.counts()
    tray.setToolTip(`ScriptHub — ${c.running} running · ${c.queued} queued`)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show ScriptHub', click: show },
      { label: `${c.running} running · ${c.queued} queued`, enabled: false },
      { type: 'separator' },
      ...(loginItemSupported() ? [{
        label: 'Start with Windows', type: 'checkbox' as const, checked: app.getLoginItemSettings().openAtLogin,
        click: (item: Electron.MenuItem) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: item.checked ? ['--background'] : [] })
          update()
        },
      }] : []),
      { label: 'Quit', click: () => void requestQuit() },
    ]))
  }
  tray.on('click', show)
  update()
  setInterval(update, 3000).unref()
}

// ----------------------------------------------------------------- window ---
function createWindow(): BrowserWindow {
  const st = loadWindowState()
  const w = new BrowserWindow({
    x: st.x, y: st.y, width: st.width, height: st.height, minWidth: 760, minHeight: 480, show: false,
    backgroundColor: '#0e1015', title: 'ScriptHub', icon: path.join(assets, process.platform === 'win32' ? 'scripthub.ico' : 'scripthub.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      spellcheck: false,
    },
  })
  if (st.maximized) w.maximize()
  trackWindowState(w)
  w.once('ready-to-show', () => {
    if (!SMOKE && !PROBE && !BACKGROUND) w.show() // --background (Start with Windows): tray only until opened
  })

  // Links go to the system browser; the window never navigates away from our page.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    if (!isOurOrigin(url)) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })
  w.webContents.on('console-message', (e) => {
    const m = e as any
    if ((m.level ?? m.details?.level) === 'error' || SMOKE || PROBE || DEV_URL) log('renderer:', m.message ?? m.details?.message)
  })
  w.webContents.on('did-finish-load', () => {
    log('page loaded:', w.webContents.getURL())
    if (DEV_URL) {
      setTimeout(() => {
        w.webContents.executeJavaScript("({ workbench: !!document.querySelector('.wb'), tabs: document.querySelectorAll('.vtab').length, scripts: document.querySelectorAll('#tree .tree-item').length })")
          .then((r) => log('workbench rendered:', JSON.stringify(r)), () => {})
      }, 2000)
    }
  })
  w.webContents.on('render-process-gone', (_e, d) => log('RENDERER GONE', d.reason))
  w.webContents.on('did-fail-load', (_e, code, desc, url) => log('LOAD FAILED', code, desc, url))

  // Closing the window keeps active runs alive in the tray; with nothing running it quits.
  w.on('close', (e) => {
    if (quitting) return
    if (activeJobs() > 0) {
      e.preventDefault()
      w.hide()
      if (!trayHintShown) {
        trayHintShown = true
        host.notify?.('ScriptHub is still running', 'Runs are active, so ScriptHub stays in the tray. Quit from the tray menu.')
      }
    } else {
      quitting = true
    }
  })
  w.on('closed', () => {
    if (win === w) win = null
  })

  void w.loadURL(DEV_URL || `app://ui/${process.env.SCRIPTHUB_PAGE || 'index.html'}`)
  return w
}

function setupSession(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  if (DEV_URL) {
    ses.webRequest.onHeadersReceived((d, cb) => {
      const h = { ...d.responseHeaders }
      if (d.url.startsWith(DEV_URL)) h['Content-Security-Policy'] = [CSP_DEV]
      cb({ responseHeaders: h })
    })
  }
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.ttf': 'font/ttf', '.map': 'application/json', '.wasm': 'application/wasm',
  }
  protocol.handle('app', async (req) => {
    const u = new URL(req.url)
    let p = decodeURIComponent(u.pathname)
    if (p === '/' || p === '') p = '/index.html'
    const file = path.normalize(path.join(uiDir, p))
    if (!file.startsWith(path.normalize(uiDir + path.sep))) return new Response('Forbidden', { status: 403 })
    if (!fs.existsSync(file)) return new Response('Not found', { status: 404 })
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    headers.set('Content-Type', types[path.extname(file).toLowerCase()] ?? headers.get('Content-Type') ?? 'application/octet-stream')
    headers.set('Content-Security-Policy', CSP_PROD)
    return new Response(res.body, { status: res.status, headers })
  })
}

// ---------------------------------------------------------------- startup ---
function pathsFromArgv(argv: string[]): string[] {
  // Packaged: argv[0] is the program. Development: `electron <app dir> <paths…>`; the app dir itself (wherever the
  // runner put it among its own flags) is never a path to open.
  const self = path.resolve(app.getAppPath())
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && path.resolve(a) !== self && fs.existsSync(a))
}

async function openArgvPaths(argv: string[]): Promise<void> {
  const paths = pathsFromArgv(argv)
  if (!paths.length) return
  try {
    await handlers.call('workspace.open', { paths })
  } catch (e) {
    log('could not open', paths, e)
  }
}

async function smokeCheck(w: BrowserWindow): Promise<void> {
  const result = await new Promise<unknown>((resolve) => {
    const started = Date.now()
    const probe = async () => {
      try {
        const r = await w.webContents.executeJavaScript(
          `({ bridge: typeof window.scripthub, shell: !!document.querySelector('.wb'), tabs: document.querySelectorAll('.vtab').length, menubar: !!document.querySelector('.menubar'), activity: document.querySelectorAll('.act').length,
              side: !!document.querySelector('.side'), title: document.title, theme: document.documentElement.getAttribute('data-theme') })`)
        if (r.shell || Date.now() - started > 15000) return resolve(r)
      } catch (e) {
        if (Date.now() - started > 15000) return resolve({ error: String(e) })
      }
      setTimeout(probe, 300)
    }
    void probe()
  })
  const info = (await handlers.call('app.info', {}).catch((e) => ({ error: String(e) }))) as any
  // End to end: open the sample scripts through the engine, and wait for the explorer to show them (events -> shell refresh -> DOM).
  let opened: unknown = null
  if (info?.samplesDir) {
    const r = (await handlers.call('workspace.open', { paths: [info.samplesDir] }).catch((e) => ({ error: String(e) }))) as any
    const started = Date.now()
    let items = 0
    while (Date.now() - started < 15000) {
      items = await w.webContents.executeJavaScript("document.querySelectorAll('#tree .tree-item').length").catch(() => 0)
      if (items > 0) break
      await new Promise((res) => setTimeout(res, 300))
    }
    const title = await w.webContents.executeJavaScript("document.querySelector('.side-title')?.textContent ?? ''").catch(() => '')
    opened = { engineScripts: r?.scripts, errors: r?.errors, explorerItems: items, explorerTitle: title }
  }
  console.log('SMOKE_RESULT ' + JSON.stringify({ page: result, engine: info, opened }))
  quitting = true
  app.exit((result as any)?.shell && (!opened || (opened as any).explorerItems > 0) ? 0 : 1)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    void openArgvPaths(argv)
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('org.sstn.scripthub')
    engine = new Engine({ appDir, samplesDir, pythonExecutable: undefined, host })
    handlers = registerHandlers(engine, host, emit)
    const fixed = engine.recover()
    if (fixed.runs.length || fixed.sequences.length) log('marked as interrupted:', fixed)
    log('data folder:', engine.dirs.runtime, `(${engine.mode})`)
    setupSession()
    registerIpc()
    await refreshMenu()
    await openArgvPaths(process.argv)
    win = createWindow()
    if (!SMOKE && !PROBE) createTray()
    else win.webContents.once('did-finish-load', () => void smokeCheck(win!))
    app.on('activate', () => {
      if (!win) win = createWindow()
      else win.show()
    })
  })

  app.on('window-all-closed', () => {
    if (quitting || !IS_MAC) app.quit()
  })
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => handlers?.dispose())
}
