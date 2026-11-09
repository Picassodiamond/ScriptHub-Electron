/**
 * The tab model: open pages in the editor area, persisted per workspace in localStorage
 * (`scripthub.openTabs.<workspace>`, like the old designer.js `scripthub.openScripts.<ws>`).
 */
import { batch, computed, effect, signal } from '@preact/signals'
import type { PanelKind } from './panels'
import { readJson, writeJson } from './storage'

export interface Tab {
  /** Unique: `<kind>:<id>`; opening the same kind and id again just activates the tab. */
  key: string
  kind: PanelKind
  id?: string
  title: string
  icon: string
  params: Record<string, any>
}

export interface OpenSpec {
  kind: PanelKind
  id?: string
  title?: string
  icon?: string
  params?: Record<string, any>
}

export const KIND_META: Record<PanelKind, { title: string; icon: string; single?: boolean }> = {
  home: { title: 'Home', icon: 'home', single: true },
  script: { title: 'Script', icon: 'file' },
  run: { title: 'Run', icon: 'terminal' },
  history: { title: 'Runs', icon: 'pulse', single: true },
  settings: { title: 'Settings', icon: 'gear', single: true },
  sequences: { title: 'Sequences', icon: 'sequence', single: true },
  sequence: { title: 'Sequence', icon: 'sequence' },
  'sequence-run': { title: 'Sequence run', icon: 'pulse' },
  'project-open': { title: 'Open project', icon: 'download', single: true },
  folder: { title: 'Open folder', icon: 'folder-open', single: true },
  'new-script': { title: 'New script', icon: 'plus', single: true },
  library: { title: 'Library', icon: 'files', single: true },
}

export const tabs = signal<Tab[]>([])
export const activeKey = signal<string | null>(null)
export const activeTab = computed(() => tabs.value.find((t) => t.key === activeKey.value) ?? null)
/** Which workspace (open folder, or 'files') the tab list belongs to. */
export const workspaceKey = signal('none')

const storageKey = (ws: string) => `scripthub.openTabs.${ws}`
interface Saved { tabs: Array<Pick<Tab, 'kind' | 'id' | 'title' | 'icon' | 'params'>>; active: string | null }

const keyOf = (kind: PanelKind, id?: string) => `${kind}:${id ?? ''}`

function makeTab(spec: OpenSpec): Tab {
  const meta = KIND_META[spec.kind]
  return {
    key: keyOf(spec.kind, meta.single ? undefined : spec.id), kind: spec.kind, id: meta.single ? undefined : spec.id,
    title: spec.title || meta.title, icon: spec.icon || meta.icon, params: spec.params ?? {},
  }
}

/** Open a tab (or activate the existing one; new params replace the old ones). */
export function openTab(spec: OpenSpec, opts: { background?: boolean } = {}): Tab {
  const t = makeTab(spec)
  const i = tabs.value.findIndex((x) => x.key === t.key)
  if (i >= 0) {
    const old = tabs.value[i]
    const merged: Tab = { ...old, title: spec.title || old.title, params: spec.params ? { ...old.params, ...spec.params } : old.params }
    if (merged.title !== old.title || merged.params !== old.params) tabs.value = tabs.value.map((x, j) => (j === i ? merged : x))
    if (!opts.background) activeKey.value = t.key
    return merged
  }
  // a new tab opens next to the active one
  const at = tabs.value.findIndex((x) => x.key === activeKey.value)
  const list = tabs.value.slice()
  list.splice(at >= 0 ? at + 1 : list.length, 0, t)
  tabs.value = list
  if (!opts.background || !activeKey.value) activeKey.value = t.key
  return t
}

export function activateTab(key: string): void {
  if (tabs.value.some((t) => t.key === key)) activeKey.value = key
}

// ------------------------------------------------------------ close guards ---
/** Return true to let the tab close, false to keep it (a panel may ask the user first). */
export type CloseGuard = () => boolean | PromiseLike<boolean>
const guards = new Map<string, Set<CloseGuard>>()
const closing = new Map<string, Promise<boolean>>()

/** A panel registers a guard for its tab (see `useCloseGuard`). Returns the unregister function. */
export function registerCloseGuard(key: string, guard: CloseGuard): () => void {
  let set = guards.get(key)
  if (!set) guards.set(key, (set = new Set()))
  set.add(guard)
  return () => {
    set!.delete(guard)
    if (!set!.size) guards.delete(key)
  }
}

const hasGuard = (key: string): boolean => (guards.get(key)?.size ?? 0) > 0

const isThenable = (v: unknown): v is PromiseLike<boolean> => !!v && typeof (v as any).then === 'function'

/**
 * Ask the guards one after the other. A guard that answers at once (a clean page) costs nothing: the result is a plain
 * boolean and the tab closes synchronously. Only a guard that asks the user makes this a promise.
 */
function check(key: string): boolean | Promise<boolean> {
  const list = [...(guards.get(key) ?? [])]
  const step = (i: number): boolean | Promise<boolean> => {
    if (i >= list.length) return true
    let r: boolean | PromiseLike<boolean>
    try {
      r = list[i]()
    } catch {
      return false // a guard that fails keeps the tab: nothing is lost
    }
    if (isThenable(r)) return Promise.resolve(r).then((ok) => (ok === false ? false : step(i + 1)), () => false)
    return r === false ? false : step(i + 1)
  }
  return step(0)
}

/** Remove the tab without asking (the page closes itself after finishing, or its script is gone). */
export function forceCloseTab(key: string): void {
  const list = tabs.value
  const i = list.findIndex((t) => t.key === key)
  if (i < 0) return
  const rest = list.filter((t) => t.key !== key)
  tabs.value = rest
  if (activeKey.value === key) activeKey.value = (rest[i] ?? rest[i - 1] ?? null)?.key ?? null
}

/**
 * Close a tab, unless its guard says no (x / middle-click / Ctrl+W / the menu all come here). Without a guard the tab
 * is gone when the call returns; the promise tells whether it closed.
 */
export function closeTab(key: string): Promise<boolean> {
  if (!tabs.value.some((t) => t.key === key)) return Promise.resolve(true)
  const running = closing.get(key)
  if (running) return running // a second Ctrl+W while the question is open
  const res = hasGuard(key) ? check(key) : true
  if (typeof res === 'boolean') {
    if (res) forceCloseTab(key)
    return Promise.resolve(res)
  }
  const p = res.then((ok) => {
    closing.delete(key)
    if (ok) forceCloseTab(key)
    return ok
  })
  closing.set(key, p)
  return p
}

/** Close several tabs: unguarded ones at once, guarded ones one after the other (each may say no). */
async function closeMany(keys: string[], keep: string | null): Promise<void> {
  const plain = keys.filter((k) => !hasGuard(k))
  if (plain.length) {
    const set = new Set(plain)
    tabs.value = tabs.value.filter((t) => !set.has(t.key))
  }
  for (const k of keys.filter(hasGuard)) await closeTab(k)
  if (keep && tabs.value.some((t) => t.key === keep)) activeKey.value = keep
  else if (!tabs.value.some((t) => t.key === activeKey.value)) activeKey.value = tabs.value[0]?.key ?? null
}

export function closeOthers(key: string): Promise<void> {
  return closeMany(tabs.value.filter((t) => t.key !== key).map((t) => t.key), key)
}

export function closeAll(): Promise<void> {
  return closeMany(tabs.value.map((t) => t.key), null)
}

export function moveTab(from: number, to: number): void {
  const list = tabs.value.slice()
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return
  const [t] = list.splice(from, 1)
  list.splice(to, 0, t)
  tabs.value = list
}

export function renameTab(key: string, title: string): void {
  if (tabs.value.some((t) => t.key === key && t.title !== title)) tabs.value = tabs.value.map((t) => (t.key === key ? { ...t, title } : t))
}

export function nextTab(step: 1 | -1): void {
  const list = tabs.value
  if (!list.length) return
  const i = list.findIndex((t) => t.key === activeKey.value)
  activeKey.value = list[(i + step + list.length) % list.length].key
}

/** Close tabs whose script or sequence no longer exists (after a scan finished). `known` = ids by kind. */
export function pruneTabs(known: { script?: Set<string>; sequence?: Set<string> }): void {
  const keep = tabs.value.filter((t) => {
    if (t.kind === 'script' && known.script && t.id && !known.script.has(t.id)) return false
    if (t.kind === 'sequence' && known.sequence && t.id && !known.sequence.has(t.id)) return false
    return true
  })
  if (keep.length !== tabs.value.length) {
    tabs.value = keep
    if (!keep.some((t) => t.key === activeKey.value)) activeKey.value = keep[0]?.key ?? null
  }
}

/**
 * Switch to another workspace's tabs (its saved list, or Home). Read first and change everything in one batch: the
 * persistence effect must never see the new workspace key together with the old workspace's tabs.
 */
export function loadWorkspaceTabs(ws: string): void {
  const saved = readJson<Saved | null>(storageKey(ws), null)
  const list = (saved?.tabs ?? []).filter((t) => t && t.kind in KIND_META).map((t) => makeTab(t))
  batch(() => {
    workspaceKey.value = ws
    tabs.value = list
    activeKey.value = list.some((t) => t.key === saved?.active) ? saved!.active : list[0]?.key ?? null
    if (!list.length) openTab({ kind: 'home' })
  })
}

/** Persist the tab list on every change. Returns a stop function. */
export function persistTabs(): () => void {
  return effect(() => {
    const ws = workspaceKey.value
    const list = tabs.value
    const active = activeKey.value
    if (ws === 'none') return
    writeJson(storageKey(ws), { tabs: list.map(({ kind, id, title, icon, params }) => ({ kind, id, title, icon, params })), active } satisfies Saved)
  })
}
