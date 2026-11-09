/** What the workbench chrome shows: the explorer tree, folders, sequences, scan progress and the running count. */
import { signal } from '@preact/signals'
import type { ScanStatus, ShellState } from '@scripthub/protocol'
import { api, errorText, hostCall } from './api'
import { nativeMenu } from './layout'
import { loadWorkspaceTabs, pruneTabs, renameTab, tabs, workspaceKey } from './tabs'

export interface HostInfo { desktop: boolean; nativeMenu: boolean; platform: string }

export const shell = signal<ShellState | null>(null)
export const scan = signal<ScanStatus>({ scanning: false, version: 0, count: 0 })
export const counts = signal({ running: 0, queued: 0 })
export const hostInfo = signal<HostInfo | null>(null)
export const shellError = signal<string | null>(null)

/** 'none' (nothing open), 'files' (only files) or the open folder's path. */
export function workspaceId(s: ShellState): string {
  if (s.folder.folder) return s.folder.folder.path
  return s.folder.files.length ? 'files' : 'empty'
}

let pending: Promise<void> | null = null

export function refreshShell(): Promise<void> {
  if (pending) return pending
  pending = (async () => {
    try {
      const s = await api['app.shell']({})
      shell.value = s
      scan.value = s.scan
      counts.value = s.counts
      shellError.value = null
      const ws = workspaceId(s)
      if (ws !== workspaceKey.value) loadWorkspaceTabs(ws)
      syncTabs(s)
    } catch (e) {
      shellError.value = errorText(e)
    } finally {
      pending = null
    }
  })()
  return pending
}

/** Keep tab titles current, and close tabs of scripts/sequences that are gone (not while still scanning). */
function syncTabs(s: ShellState): void {
  const names = new Map(s.palette.map((p) => [p.id, p.name]))
  const seqNames = new Map(s.sequenceList.map((q) => [q.slug, q.name]))
  for (const t of tabs.value) {
    if (t.kind === 'script' && t.id && names.has(t.id)) renameTab(t.key, names.get(t.id)!)
    if (t.kind === 'sequence' && t.id && seqNames.has(t.id)) renameTab(t.key, seqNames.get(t.id)!)
  }
  const settled = !s.scan.scanning
  pruneTabs({
    script: settled && (s.palette.length > 0 || !s.folder.folder) ? new Set(names.keys()) : undefined,
    sequence: new Set(seqNames.keys()),
  })
}

export async function loadHostInfo(): Promise<void> {
  try {
    hostInfo.value = (await hostCall<HostInfo>('host.info')) ?? null
  } catch {
    hostInfo.value = null
  }
  nativeMenu.value = !!hostInfo.value?.nativeMenu
}

export async function pollRunning(): Promise<void> {
  try {
    const r = await api['runs.running']({})
    const active = r.active ?? []
    const running = active.filter((x: any) => x.status === 'running').length
    counts.value = { running, queued: Math.max(0, (r.activeTotal ?? active.length) - running) }
  } catch {
    /* the status bar keeps the last numbers */
  }
}
