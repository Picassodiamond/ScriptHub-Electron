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
  /** Key of the upper tab this one belongs to. Set for run tabs: they are the temporary lower tabs of their script or sequence. */
  owner?: string
}

export interface OpenSpec {
  kind: PanelKind
  id?: string
  title?: string
  icon?: string
  params?: Record<string, any>
  /** Force the owning upper tab (otherwise a run finds it from `params.scriptId` / `params.sequence` or the active page). */
  owner?: string
}

/** Kinds that are shown as lower tabs of another tab instead of in the upper strip. */
export const CHILD_KINDS: ReadonlySet<PanelKind> = new Set<PanelKind>(['run', 'sequence-run'])
/** At most this many lower (run) tabs per upper tab; opening one more closes the oldest that is not shown. */
export const MAX_CHILDREN = 8

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

export const upperTabs = computed(() => tabs.value.filter((t) => !t.owner))
/** The upper tab of what is shown: the active tab itself, or the owner of the active run tab. */
export const activeUpperKey = computed(() => {
  const t = activeTab.value
  return t ? t.owner ?? t.key : null
})
export const childrenOf = (ownerKey: string | null | undefined): Tab[] => (ownerKey ? tabs.value.filter((t) => t.owner === ownerKey) : [])
/** Status of run tabs (set by the run pages), shown as an icon on the lower tab and a dot on the upper one. */
export type TabStatus = 'running' | 'ok' | 'failed' | 'paused' | 'other'
export const tabStatus = signal<Record<string, TabStatus>>({})
export function setTabStatus(key: string, status: TabStatus | null): void {
  const cur = tabStatus.value
  if ((cur[key] ?? null) === status) return
  const next = { ...cur }
  if (status) next[key] = status
  else delete next[key]
  tabStatus.value = next
}

/** What was shown last in each upper tab (its own page, or one of its run tabs): clicking the upper tab returns there. */
const lastView = new Map<string, string>()

const storageKey = (ws: string) => `scripthub.openTabs.${ws}`
interface Saved { tabs: Array<Pick<Tab, 'kind' | 'id' | 'title' | 'icon' | 'params' | 'owner'>>; active: string | null }

const keyOf = (kind: PanelKind, id?: string) => `${kind}:${id ?? ''}`

function makeTab(spec: OpenSpec): Tab {
  const meta = KIND_META[spec.kind]
  return {
    key: keyOf(spec.kind, meta.single ? undefined : spec.id), kind: spec.kind, id: meta.single ? undefined : spec.id,
    title: spec.title || meta.title, icon: spec.icon || meta.icon, params: spec.params ?? {}, owner: spec.owner,
  }
}

/** Which upper tab a new run tab belongs to: its script's or sequence's tab (opened in the background when needed), else the page in front. */
function resolveOwner(spec: OpenSpec): string | undefined {
  if (spec.owner) return spec.owner
  const has = (key: string) => tabs.value.some((x) => x.key === key && !x.owner)
  const front = activeUpperKey.value ?? undefined
  if (spec.kind === 'run') {
    const sid = spec.params?.scriptId
    if (typeof sid === 'string' && sid) {
      const key = keyOf('script', sid)
      if (!has(key)) openTab({ kind: 'script', id: sid }, { background: true })
      return key
    }
  } else if (spec.kind === 'sequence-run') {
    const slug = spec.params?.sequence
    if (typeof slug === 'string' && slug && has(keyOf('sequence', slug))) return keyOf('sequence', slug)
  }
  return front ?? (has('history:') ? 'history:' : undefined)
}

const viewOf = (key: string): string => {
  const v = lastView.get(key)
  return v && tabs.value.some((t) => t.key === v && (t.key === key || t.owner === key)) ? v : key
}

/** Open a tab (or activate the existing one; new params replace the old ones). */
export function openTab(spec: OpenSpec, opts: { background?: boolean } = {}): Tab {
  const t = makeTab(spec)
  const i = tabs.value.findIndex((x) => x.key === t.key)
  if (i >= 0) {
    const old = tabs.value[i]
    const params = spec.params ? { ...old.params, ...spec.params } : old.params
    let owner = old.owner
    // a run learns its sequence after it opened (the page asks the engine): move it under that sequence's tab if it is open
    if (old.kind === 'sequence-run' && spec.params?.sequence) {
      const o = resolveOwner({ ...spec, kind: old.kind })
      if (o && o !== old.key && tabs.value.some((x) => x.key === o && !x.owner)) owner = o
    }
    const merged: Tab = { ...old, title: spec.title || old.title, params, owner }
    if (merged.title !== old.title || merged.params !== old.params || merged.owner !== old.owner) tabs.value = tabs.value.map((x, j) => (j === i ? merged : x))
    if (!opts.background) activeKey.value = t.key
    return merged
  }
  if (CHILD_KINDS.has(spec.kind)) {
    const owner = resolveOwner(spec)
    if (owner) {
      const child: Tab = { ...t, owner }
      const count = tabs.value.filter((x) => x.owner === owner).length + 1
      const list = tabs.value.slice()
      // right after the owner's last run tab
      const last = list.map((x) => x.key === owner || x.owner === owner).lastIndexOf(true)
      list.splice(last >= 0 ? last + 1 : list.length, 0, child)
      tabs.value = list
      // keep the strip short: drop the oldest run tabs that are not in front
      for (let n = count; n > MAX_CHILDREN; n--) {
        const old = tabs.value.find((x) => x.owner === owner && x.key !== child.key && x.key !== activeKey.value)
        if (old) forceCloseTab(old.key)
      }
      if (!opts.background || !activeKey.value) activeKey.value = child.key
      return child
    }
  }
  // a new tab opens next to the active one
  const at = tabs.value.findIndex((x) => x.key === activeKey.value)
  const list = tabs.value.slice()
  list.splice(at >= 0 ? at + 1 : list.length, 0, t)
  tabs.value = list
  if (!opts.background || !activeKey.value) activeKey.value = t.key
  return t
}

/** Show a tab. An upper tab comes back to what was last shown in it (its page or one of its run tabs) unless `exact`. */
export function activateTab(key: string, opts: { exact?: boolean } = {}): void {
  const t = tabs.value.find((x) => x.key === key)
  if (t) activeKey.value = t.owner || opts.exact ? key : viewOf(key)
}

effect(() => {
  const k = activeKey.value
  const t = k ? tabs.peek().find((x) => x.key === k) : null
  if (t) lastView.set(t.owner ?? t.key, t.key)
})

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
  const gone = list[i]
  // closing an upper tab closes its run tabs with it (the runs stay in History)
  const rest = list.filter((t) => t.key !== key && t.owner !== key)
  const was = activeKey.value
  tabs.value = rest
  lastView.delete(key)
  if (was && !rest.some((t) => t.key === was)) {
    if (gone.owner && rest.some((t) => t.key === gone.owner)) {
      const sib = rest.filter((t) => t.owner === gone.owner)
      activeKey.value = (sib[sib.length - 1] ?? rest.find((t) => t.key === gone.owner))!.key
    } else {
      const near = list.slice(i + 1).find((t) => !t.owner && rest.includes(t)) ?? [...list.slice(0, i)].reverse().find((t) => !t.owner && rest.includes(t))
      activeKey.value = near ? viewOf(near.key) : null
    }
  }
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
    tabs.value = tabs.value.filter((t) => !set.has(t.key) && !(t.owner && set.has(t.owner)))
  }
  for (const k of keys.filter(hasGuard)) await closeTab(k)
  if (keep && tabs.value.some((t) => t.key === keep)) activeKey.value = keep
  else if (!tabs.value.some((t) => t.key === activeKey.value)) activeKey.value = tabs.value[0]?.key ?? null
}

export function closeOthers(key: string): Promise<void> {
  const keep = tabs.value.find((t) => t.key === key)?.owner ?? key
  return closeMany(tabs.value.filter((t) => !t.owner && t.key !== keep).map((t) => t.key), keep)
}

export function closeAll(): Promise<void> {
  return closeMany(tabs.value.filter((t) => !t.owner).map((t) => t.key), null)
}

/** Reorder the upper tabs (indexes into `upperTabs`); each one keeps its run tabs right after it. */
export function moveTab(from: number, to: number): void {
  const up = upperTabs.value.slice()
  if (from < 0 || from >= up.length || to < 0 || to >= up.length || from === to) return
  const [t] = up.splice(from, 1)
  up.splice(to, 0, t)
  const all = tabs.value
  tabs.value = up.flatMap((u) => [u, ...all.filter((c) => c.owner === u.key)])
}

export function renameTab(key: string, title: string): void {
  if (tabs.value.some((t) => t.key === key && t.title !== title)) tabs.value = tabs.value.map((t) => (t.key === key ? { ...t, title } : t))
}

export function nextTab(step: 1 | -1): void {
  const list = upperTabs.value
  if (!list.length) return
  const i = list.findIndex((t) => t.key === activeUpperKey.value)
  activateTab(list[(i + step + list.length) % list.length].key)
}

/** Close tabs whose script or sequence no longer exists (after a scan finished). `known` = ids by kind. */
export function pruneTabs(known: { script?: Set<string>; sequence?: Set<string> }): void {
  const keep = tabs.value.filter((t) => {
    if (t.kind === 'script' && known.script && t.id && !known.script.has(t.id)) return false
    if (t.kind === 'sequence' && known.sequence && t.id && !known.sequence.has(t.id)) return false
    return true
  }).filter((t, _i, all) => !t.owner || all.some((o) => o.key === t.owner))
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
  const made = (saved?.tabs ?? []).filter((t) => t && t.kind in KIND_META).map((t) => makeTab(t))
  const list = made.filter((t) => !t.owner || made.some((o) => o.key === t.owner && !o.owner))
  batch(() => {
    workspaceKey.value = ws
    tabs.value = list
    activeKey.value = list.some((t) => t.key === saved?.active) ? saved!.active : list.find((t) => !t.owner)?.key ?? null
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
    writeJson(storageKey(ws), { tabs: list.map(({ kind, id, title, icon, params, owner }) => ({ kind, id, title, icon, params, owner })), active } satisfies Saved)
  })
}
