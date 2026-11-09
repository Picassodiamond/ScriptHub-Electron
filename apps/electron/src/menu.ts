/** The native application menu: the same File / View / Run / Help as the old menu bar, each item sends a command to the UI. */
import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { WorkspaceOverview } from '@scripthub/protocol'

export interface MenuContext {
  overview: WorkspaceOverview
  editingEnabled: boolean
  version: string
  send(name: string, args?: Record<string, unknown>): void
  quit(): void
  isMac: boolean
}

type Item = MenuItemConstructorOptions

export function buildMenu(c: MenuContext): Menu {
  const f = c.overview.folder
  const cmd = (name: string, label: string, extra: Item = {}, args?: Record<string, unknown>): Item => ({
    label, click: () => c.send(name, args), ...extra,
  })
  // The renderer handles the keyboard itself; the accelerator is only shown (registerAccelerator: false).
  const hint = (accelerator: string): Item => ({ accelerator, registerAccelerator: false })

  const folderItems = (xs: WorkspaceOverview['recent']): Item[] =>
    xs.map((x) => ({ label: x.name + (x.exists ? '' : ' (not found)'), enabled: x.exists && !x.is_open, sublabel: x.path,
      click: () => c.send('file.openPath', { path: x.path }) }))

  const recent: Item[] = []
  if (c.overview.favorites.length) recent.push({ label: 'Favourites', enabled: false }, ...folderItems(c.overview.favorites))
  if (c.overview.recent.length) recent.push({ label: 'Recent', enabled: false }, ...folderItems(c.overview.recent))
  if (recent.length) recent.push({ type: 'separator' })
  recent.push(cmd('file.manageFolders', 'Manage folders…'))

  const file: Item[] = [
    cmd('file.newScript', 'New script', { enabled: c.editingEnabled && !!f, ...hint('G N') }),
    { type: 'separator' },
    cmd('file.openFile', 'Open file…'),
    cmd('file.openFolder', 'Open folder…', hint('G F')),
    { label: 'Open recent', submenu: recent },
  ]
  if (f) {
    file.push(
      { type: 'separator' },
      cmd('file.favorite', f.favorite ? 'Remove from favourites' : 'Add to favourites', {}, { path: f.path, on: !f.favorite }),
      cmd('file.closeFolder', 'Close folder'),
    )
  }
  if (c.overview.files.length) {
    if (!f) file.push({ type: 'separator' })
    file.push(cmd('file.closeFiles', `Close opened files (${c.overview.files.length})`))
  }
  file.push(
    { type: 'separator' },
    cmd('file.openProject', 'Open project…'),
    cmd('file.saveProject', 'Save project as…', { enabled: !!f }),
    cmd('file.closeProject', 'Close project', { enabled: !!f || c.overview.files.length > 0 }),
    { type: 'separator' },
    cmd('file.settings', 'Settings', hint('G S')),
    { type: 'separator' },
    { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => c.quit() },
  )

  const view: Item[] = [
    cmd('view.palette', 'Command palette', hint('CmdOrCtrl+K')),
    { type: 'separator' },
    cmd('view.home', 'Home', hint('G O')),
    cmd('view.library', 'Library', hint('G L')),
    cmd('view.sequences', 'Sequences', hint('G Q')),
    cmd('view.runs', 'Runs', hint('G H')),
    { type: 'separator' },
    cmd('view.side', 'Side panel', hint('CmdOrCtrl+B')),
    cmd('view.bottom', 'Bottom panel', hint('CmdOrCtrl+J')),
    cmd('view.collapse', 'Collapse explorer'),
    { type: 'separator' },
    cmd('view.theme', 'Light / dark theme'),
    { type: 'separator' },
    { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
    { role: 'togglefullscreen' },
    { type: 'separator' },
    { role: 'reload' }, { role: 'toggleDevTools' },
  ]

  const run: Item[] = [
    cmd('run.run', 'Run script', hint('CmdOrCtrl+Enter'), { mode: 'normal' }),
    cmd('run.run', 'Run with Trace', {}, { mode: 'trace' }),
    cmd('run.run', 'Run with Debug', {}, { mode: 'debug' }),
    { type: 'separator' },
    cmd('run.rescan', 'Rescan folder', { enabled: !!f || c.overview.files.length > 0 }),
    cmd('view.runs', 'Runs', hint('G H')),
  ]

  const help: Item[] = [
    cmd('help.shortcuts', 'Keyboard shortcuts', hint('?')),
    cmd('help.dataFolder', 'Show data folder'),
    { type: 'separator' },
    { label: `ScriptHub ${c.version}`, enabled: false },
  ]

  const template: Item[] = [
    { label: 'File', submenu: file },
    { label: 'View', submenu: view },
    { label: 'Run', submenu: run },
    { label: 'Help', submenu: help },
  ]
  if (c.isMac) template.unshift({ role: 'appMenu' })
  return Menu.buildFromTemplate(template)
}
