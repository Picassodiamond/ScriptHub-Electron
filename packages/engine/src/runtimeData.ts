/**
 * What ScriptHub keeps in its data folder, how large each kind is, and clearing it
 * (Settings -> Data). Port of runner/runtime_data.py. Queued and running runs are never removed;
 * the secret key, locks and script id aliases are internal and not offered.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DataDirs, RuntimeMode } from './paths.js'
import type { History, HistoryOps } from './history.js'

export class RuntimeDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeDataError'
  }
}

export const KINDS: ReadonlyArray<readonly [string, string, string]> = [
  ['history', 'Run history and logs', 'Finished script and sequence runs. Queued and running ones stay.'],
  ['presets', 'Saved values', 'Presets and recent values of every script.'],
  ['sequences', 'Sequences', 'Every sequence (their runs are under run history).'],
  ['backups', 'Script backups', 'Previous versions kept when a script is saved.'],
  ['metadata', 'Metadata of read-only scripts', 'Metadata stored here because the script could not be written.'],
  ['workspace', 'Open folder, recent and favourites', 'Closes the folder and opened files, forgets recent and favourites.'],
  ['imports', 'Uploaded project files', 'Project files waiting to be opened (removed after 24 hours anyway).'],
  ['desktop', 'Desktop window profile', "The app window's browser profile and the desktop log."],
  ['settings', 'Settings', 'Back to the defaults.'],
]
export const KEYS: readonly string[] = KINDS.map((k) => k[0])

/** The sequence-run store, injected (sequences are ported elsewhere). */
export interface SequenceRunsPort {
  list(): Array<{ id?: string }>
  delete(id: string): boolean
  /** Truthy while a sequence is running. */
  active(): unknown
}

export interface RuntimeDataDeps {
  dirs: DataDirs
  history: History
  historyOps: HistoryOps
  mode?: RuntimeMode
  sequenceRuns?: SequenceRunsPort
  /** Called after workspace.json was removed (re-scan the now empty workspace). */
  onWorkspaceCleared?: () => void
}

function size(p: string): [number, number] {
  let st: fs.Stats
  try {
    st = fs.statSync(p)
  } catch {
    return [0, 0]
  }
  if (st.isFile()) return [st.size, 1]
  let total = 0
  let count = 0
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name !== '.gitkeep') {
        try {
          total += fs.statSync(full).size
          count++
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(p)
  return [total, count]
}

/** Remove what is in `dir` (the folder stays). Returns how many entries could not be removed. */
function emptyDir(dir: string): number {
  let left = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    try {
      fs.rmSync(path.join(dir, e.name), { recursive: true, force: false })
    } catch {
      left++
    }
  }
  return left
}

function unlink(p: string): number {
  try {
    fs.rmSync(p, { force: true })
    return 0
  } catch {
    return 1
  }
}

export function human(n: number): string {
  for (const unit of ['bytes', 'KB', 'MB', 'GB']) {
    if (n < 1024 || unit === 'GB') return unit === 'bytes' ? `${n} bytes` : `${n.toFixed(1)} ${unit}`
    n /= 1024
  }
  return `${n} bytes`
}

export class RuntimeData {
  constructor(private d: RuntimeDataDeps) {}

  private paths(key: string): string[] {
    const { dirs } = this.d
    const r = dirs.runtime
    const table: Record<string, string[]> = {
      history: [dirs.executions, dirs.sequenceRuns],
      presets: [dirs.presets],
      sequences: [dirs.sequences],
      backups: [dirs.backups],
      metadata: [dirs.metadataOverride],
      workspace: [dirs.workspaceFile],
      imports: [dirs.imports],
      desktop: [path.join(r, 'desktop-profile'), path.join(r, 'desktop.log')],
      settings: [dirs.configFile, dirs.configFile + '.bak'],
    }
    return table[key]
  }

  overview(): Array<{ key: string; label: string; help: string; bytes: number; files: number }> {
    return KINDS.map(([key, label, help]) => {
      let bytes = 0
      let files = 0
      for (const p of this.paths(key)) {
        const [b, n] = size(p)
        bytes += b
        files += n
      }
      return { key, label, help, bytes, files }
    })
  }

  /** Clear one kind of data; returns a sentence for the user. Throws RuntimeDataError for an unknown kind or when it cannot be cleared now. */
  clear(key: string): string {
    if (!KEYS.includes(key)) throw new RuntimeDataError(`Unknown kind of data: ${key}`)
    const { history, historyOps, sequenceRuns } = this.d
    if (key === 'history') {
      let removed = 0
      let kept = 0
      for (const id of history.listRunIds()) historyOps.deleteRun(id) ? removed++ : kept++
      for (const data of sequenceRuns?.list() ?? []) sequenceRuns!.delete(data.id ?? '') ? removed++ : kept++
      return `Removed ${removed} run${removed !== 1 ? 's' : ''}` + (kept ? `; ${kept} still running or unreadable.` : '.')
    }
    if (key === 'sequences' && sequenceRuns?.active())
      throw new RuntimeDataError('A sequence is running: stop it or wait, then clear the sequences.')
    let left = 0
    if (key === 'workspace') {
      left = unlink(this.paths(key)[0])
      this.d.onWorkspaceCleared?.()
    } else if (key === 'settings') left = this.paths(key).reduce((n, p) => n + unlink(p), 0)
    else
      for (const p of this.paths(key)) {
        let isFile = false
        try {
          isFile = fs.statSync(p).isFile()
        } catch {
          /* missing */
        }
        left += isFile ? unlink(p) : emptyDir(p)
      }
    const label = KINDS.find((k) => k[0] === key)![1]
    if (left) return `${label}: cleared, except ${left} item${left !== 1 ? 's' : ''} in use (close what uses them and try again).`
    return `${label}: cleared.`
  }

  location(): { path: string; how: string } {
    const how = { env: 'set by SCRIPTHUB_HOME', portable: 'portable: the runtime folder next to the code', user: 'your user data folder' }
    return { path: this.d.dirs.runtime, how: how[this.d.mode ?? 'user'] }
  }
}
