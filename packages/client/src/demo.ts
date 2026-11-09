/** Sample data so the UI can run in a browser (npm run dev:ui) and in tests, without the engine. */
import type { ScanStatus, ShellState, WorkspaceOverview } from '@scripthub/protocol'
import { MockTransport } from './mock.js'

const item = (path: string, extra: Partial<WorkspaceOverview['recent'][number]> = {}) => ({
  path, name: path.split(/[\\/]/).pop() || path, exists: true, is_file: false, favorite: false, is_open: false, ...extra,
})

export function demoShell(over: Partial<ShellState> = {}): ShellState {
  const scan: ScanStatus = { scanning: false, version: 1, count: 3 }
  return {
    tree: [
      { name: 'General', scripts: [
        { id: 'aaaaaaaaaaaa', name: 'Hello World', ext: 'py', relative: 'hello.py', category: 'General', runnable: true, status: 'success', statusLabel: 'Succeeded' },
        { id: 'bbbbbbbbbbbb', name: 'Disk Report', ext: 'sh', relative: 'disk.sh', category: 'General', runnable: true, status: null, statusLabel: '' },
      ] },
      { name: 'Network', scripts: [
        { id: 'cccccccccccc', name: 'Ping Hosts', ext: 'py', relative: 'network/ping.py', category: 'Network', runnable: true, status: 'failed', statusLabel: 'Failed' },
      ] },
    ],
    palette: [
      { id: 'aaaaaaaaaaaa', name: 'Hello World', cat: 'General', ext: 'py', path: 'hello.py', run: true },
      { id: 'bbbbbbbbbbbb', name: 'Disk Report', cat: 'General', ext: 'sh', path: 'disk.sh', run: true },
      { id: 'cccccccccccc', name: 'Ping Hosts', cat: 'Network', ext: 'py', path: 'network/ping.py', run: true },
    ],
    folder: {
      folder: item('C:\\scripts', { is_open: true }), files: [],
      favorites: [item('C:\\scripts\\ops', { favorite: true })], recent: [item('C:\\work\\tools')],
    },
    folderPalette: [{ path: 'C:\\work\\tools', name: 'tools', favorite: false }],
    sequences: [{ slug: 'nightly', name: 'Nightly' }],
    sequenceList: [{ slug: 'nightly', name: 'Nightly', steps: 3, saved_at: '2026-11-09T21:10:00', saved_display: '2026-11-09 21:10', error: '', favorite: true }],
    scan, runs: [], counts: { running: 0, queued: 0 }, editingEnabled: true, pollingInterval: 2000, version: 'dev', ...over,
  }
}

/** A MockTransport answering the calls the shell and the Home/Folder panels make. */
export function demoTransport(shell: ShellState = demoShell()): MockTransport {
  const t = new MockTransport()
  t.on('app.shell', () => shell)
  t.on('app.info', () => ({ version: 'dev', runtimeDir: 'C:\\data', runtimeMode: 'user', platform: 'win32', editingEnabled: true, pollingInterval: 2000, samplesDir: 'C:/app/samples/sample_scripts' }))
  t.on('workspace.overview', () => shell.folder)
  t.on('workspace.scanStatus', () => shell.scan)
  t.on('scripts.tree', () => shell.tree)
  t.on('project.samples', () => [{ name: 'Maintenance' }])
  t.on('workspace.browse', ({ path }: { path: string }) => ({
    path, parent: '', dirs: path ? [{ path: path + '\\sub', name: 'sub' }] : [], files: [], places: [{ path: 'C:\\', name: 'C:' }],
    crumbs: path ? [{ path, name: path }] : [], error: '',
  }))
  t.on('workspace.open', () => ({ opened: [], errors: [], scripts: 0, problems: [], finished: true, scriptId: null }))
  t.on('workspace.rescan', () => ({ count: 3, problems: [], finished: true }))
  t.on('workspace.closeFolder', () => ({ scripts: 0 }))
  t.on('workspace.closeFile', () => ({ closed: true }))
  t.on('workspace.favorite', ({ path }: { path: string }) => ({ path }))
  t.on('workspace.forget', () => ({ ok: true }))
  t.on('workspace.pickFolder', () => null)
  t.on('workspace.pickFiles', () => [])
  t.on('runs.running', () => ({ active: [], activeSeqs: [], activeTotal: 0 }))
  t.on('runs.recent', () => [])
  return t
}
