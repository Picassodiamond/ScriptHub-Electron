/**
 * Every action of the app is a command: the HTML menu bar, the native menu (it sends the command id), the palette
 * and the keyboard all run the same ones. Keys: 'ctrl+k', a chord 'g l', or a single key 'r'.
 */
import { api, errorText, hostCall } from './api'
import { emitCommand } from './bus'
import { confirm } from './confirm'
import { sideOn, showSideView, toggleBottom, toggleSide, toggleSide2, type SideView } from './layout'
import { helpOpen, menuFocus, paletteOpen } from './overlays'
import { hostInfo, refreshShell, shell } from './shellState'
import { activeTab, closeTab, nextTab, openTab } from './tabs'
import { toggleTheme } from './theme'
import { toast } from './toast'

export interface Command {
  id: string
  title: string
  group: 'File' | 'View' | 'Run' | 'Help' | 'Tab'
  /** Keyboard shortcuts (any of them runs the command); shown in menus and the help sheet. */
  keys?: string[]
  /** Shown in the palette and the help sheet; commands without a title are internal. */
  palette?: boolean
  run(args?: any): unknown
}

const registry = new Map<string, Command>()
export const defineCommand = (c: Command): void => { registry.set(c.id, c) }
export const allCommands = (): Command[] => [...registry.values()]
export const getCommand = (id: string): Command | undefined => registry.get(id)

export async function runCommand(id: string, args?: any): Promise<void> {
  const c = registry.get(id)
  if (!c) return
  try {
    await c.run(args)
  } catch (e) {
    toast.error(errorText(e))
  }
}

/** Pretty key hint: 'ctrl+k' -> 'Ctrl K', 'g l' -> 'g l'. */
export function keyHint(spec: string): string {
  return spec.includes('+') ? spec.split('+').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ').replace('Enter', '↵') : spec
}

// ------------------------------------------------------------- helpers ---
const isDesktop = () => !!hostInfo.value?.desktop

/** Open folders and script files through the engine, then show what happened. */
export async function openPaths(paths: string[]): Promise<{ opened: string[]; errors: string[] }> {
  if (!paths.length) return { opened: [], errors: [] }
  const r = await api['workspace.open']({ paths })
  for (const e of r.errors) toast.error(e)
  await refreshShell()
  if (r.opened.length) {
    const name = r.opened[0].split(/[\\/]/).filter(Boolean).pop() ?? r.opened[0]
    toast.success(r.opened.length === 1 ? `Opened ${name}` : `Opened ${r.opened.length} items`)
    if (r.scriptId) openTab({ kind: 'script', id: r.scriptId })
    else openTab({ kind: 'library' }, { background: true })
  }
  return { opened: r.opened, errors: r.errors }
}

const go = (kind: Parameters<typeof openTab>[0]['kind'], view?: SideView) => () => {
  openTab({ kind })
  if (view) showSideView(view)
}

const scriptId = (): string | undefined => {
  const t = activeTab.value
  return t && t.kind === 'script' ? t.id : undefined
}

// ------------------------------------------------------------ commands ---
export function registerBuiltinCommands(): void {
  const c = (cmd: Command) => defineCommand(cmd)

  // Sent by the desktop shell when a "run finished" notification is clicked: open that run's console.
  c({ id: 'run.open', title: 'Open run', group: 'Run', run: (args?: { id?: string; scriptId?: string; title?: string }) => {
    if (args?.id) openTab({ kind: 'run', id: args.id, title: args.title || args.id, params: { scriptId: args.scriptId } })
  } })

  c({ id: 'file.newScript', title: 'New script', group: 'File', keys: ['g n'], palette: true, run: () => {
    if (!shell.value?.editingEnabled) return void toast.info('Script editing is off in Settings.')
    if (!shell.value.folder.folder) return void toast.info('Open a folder first: new scripts are created in it.')
    openTab({ kind: 'new-script', params: { from: scriptId() ?? '' } })
  } })
  c({ id: 'file.openFile', title: 'Open file…', group: 'File', palette: true, run: async () => {
    if (!isDesktop()) return void openTab({ kind: 'folder' })
    await openPaths(await api['workspace.pickFiles']({}))
  } })
  c({ id: 'file.openFolder', title: 'Open folder…', group: 'File', keys: ['g f'], palette: true, run: async () => {
    if (!isDesktop()) return void openTab({ kind: 'folder' })
    const p = await api['workspace.pickFolder']({})
    if (p) await openPaths([p])
  } })
  c({ id: 'file.openPath', title: 'Open folder or file by path', group: 'File', run: (a: { path: string }) => openPaths([a.path]) })
  c({ id: 'file.manageFolders', title: 'Manage folders…', group: 'File', palette: true, run: () => openTab({ kind: 'folder' }) })
  c({ id: 'file.favorite', title: 'Toggle favourite folder', group: 'File', run: async (a?: { path: string; on: boolean }) => {
    const f = shell.value?.folder.folder
    const path = a?.path ?? f?.path
    if (!path) return
    await api['workspace.favorite']({ path, on: a?.on ?? !f?.favorite })
    await refreshShell()
  } })
  c({ id: 'file.closeFolder', title: 'Close folder', group: 'File', palette: true, run: async () => {
    await api['workspace.closeFolder']({})
    await refreshShell()
  } })
  c({ id: 'file.closeFiles', title: 'Close opened files', group: 'File', palette: true, run: async () => {
    await api['workspace.closeFile']({ all: true })
    await refreshShell()
  } })
  c({ id: 'file.openProject', title: 'Open project…', group: 'File', palette: true, run: async () => {
    if (isDesktop()) {
      const path = await hostCall<string | null>('host.openProject')
      if (path) openTab({ kind: 'project-open', params: { path, nonce: Date.now() } })
    } else openTab({ kind: 'project-open' })
  } })
  c({ id: 'file.saveProject', title: 'Save project as…', group: 'File', palette: true, run: async () => {
    if (!shell.value?.folder.folder) return void toast.info('Open a folder first.')
    if (!isDesktop()) return void toast.info('Saving a project file needs the desktop app.')
    const r = await hostCall<{ path: string } | null>('host.saveProject')
    if (r) toast.success(`Saved ${r.path}`)
  } })
  c({ id: 'file.closeProject', title: 'Close project', group: 'File', palette: true, run: async () => {
    if (!(await confirm({ title: 'Close project', message: 'Close the folder and every opened file?', confirmLabel: 'Close' }))) return
    await api['project.close']({})
    await refreshShell()
  } })
  c({ id: 'file.settings', title: 'Settings', group: 'File', keys: ['g s'], palette: true, run: go('settings') })

  c({ id: 'view.palette', title: 'Command palette', group: 'View', keys: ['ctrl+k'], run: () => { paletteOpen.value = !paletteOpen.value } })
  c({ id: 'view.home', title: 'Home', group: 'View', keys: ['g o'], palette: true, run: go('home') })
  c({ id: 'view.library', title: 'Library', group: 'View', keys: ['g l'], palette: true, run: go('library', 'explorer') })
  c({ id: 'view.sequences', title: 'Sequences', group: 'View', keys: ['g q'], palette: true, run: go('sequences', 'sequences') })
  c({ id: 'view.runs', title: 'Runs', group: 'View', keys: ['g h', 'g j'], palette: true, run: go('history', 'runs') })
  c({ id: 'view.side', title: 'Toggle side panel', group: 'View', keys: ['ctrl+b'], palette: true, run: toggleSide })
  c({ id: 'view.side2', title: 'Toggle right column', group: 'View', keys: ['ctrl+alt+b'], palette: true, run: toggleSide2 })
  c({ id: 'view.bottom', title: 'Toggle bottom panel', group: 'View', keys: ['ctrl+j'], palette: true, run: toggleBottom })
  c({ id: 'view.collapse', title: 'Collapse explorer', group: 'View', palette: true, run: () => {
    showSideView('explorer')
    emitCommand('tree.collapse')
  } })
  c({ id: 'view.theme', title: 'Light / dark theme', group: 'View', palette: true, run: toggleTheme })

  c({ id: 'run.run', title: 'Run script or sequence', group: 'Run', keys: ['r', 'ctrl+enter'], palette: true, run: (a?: { mode?: string }) => {
    const t = activeTab.value
    if (!t || (t.kind !== 'script' && t.kind !== 'sequence')) return void toast.info('Open a script or a sequence first.')
    if (!emitCommand('run.run', { mode: a?.mode ?? 'normal', tab: t })) toast.info(`This ${t.kind} page cannot run yet.`)
  } })
  c({ id: 'run.rescan', title: 'Rescan folder', group: 'Run', palette: true, run: async () => {
    const r = await api['workspace.rescan']({})
    await refreshShell()
    toast.success(`Found ${r.count} script${r.count === 1 ? '' : 's'}`)
  } })

  c({ id: 'tab.close', title: 'Close tab', group: 'Tab', keys: ['ctrl+w'], palette: true, run: () => { if (activeTab.value) closeTab(activeTab.value.key) } })
  c({ id: 'tab.next', title: 'Next tab', group: 'Tab', keys: ['ctrl+pagedown'], run: () => nextTab(1) })
  c({ id: 'tab.prev', title: 'Previous tab', group: 'Tab', keys: ['ctrl+pageup'], run: () => nextTab(-1) })
  c({ id: 'menu.focus', title: 'Menu bar', group: 'View', keys: ['f10'], run: () => { menuFocus.value++ } })

  c({ id: 'help.shortcuts', title: 'Keyboard shortcuts', group: 'Help', keys: ['?'], palette: true, run: () => { helpOpen.value = !helpOpen.value } })
  c({ id: 'help.dataFolder', title: 'Show data folder', group: 'Help', palette: true, run: async () => {
    if (isDesktop()) await hostCall('host.dataFolder')
    else toast.info((await api['app.info']({})).runtimeDir)
  } })
}

export const sideIsOn = (): boolean => sideOn.value
