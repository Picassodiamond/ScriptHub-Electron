/**
 * State shared between the script page and its bottom panel (the saved-values grid), which are two separate
 * components: change counters, the values the Run form currently shows, and requests from the grid to the page.
 */
import { signal } from '@preact/signals'

/** Increased whenever saved values change (a preset saved, renamed or deleted, a run started): the grid reloads. */
export const savedBump = signal(0)
export const bumpSaved = (): void => { savedBump.value++ }

/** Per script id: the key of the saved values the Run form was loaded from ('-' = defaults, '@0' = last run, or a preset slug). */
export const currentSource = signal<Record<string, string>>({})
export function setCurrentSource(id: string, key: string): void {
  if (currentSource.value[id] !== key) currentSource.value = { ...currentSource.value, [id]: key }
}

/** The grid asks the page to load a column into the Run form. */
export interface LoadRequest { id: string; key: string; nonce: number }
export const loadRequest = signal<LoadRequest | null>(null)
let nonce = 1
export const requestLoad = (id: string, key: string): void => { loadRequest.value = { id, key, nonce: nonce++ } }

/** Script ids with unsaved changes (the tab title shows a dot, see ScriptPage). */
export const dirtyIds = signal<Record<string, boolean>>({})
export function setDirty(id: string, on: boolean): void {
  if (!!dirtyIds.value[id] === on) return
  const next = { ...dirtyIds.value }
  if (on) next[id] = true
  else delete next[id]
  dirtyIds.value = next
}

/** A random token against double submits of the Run form. */
export function newToken(): string {
  const c: any = globalThis.crypto
  return typeof c?.randomUUID === 'function' ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

/** The tab title of a run opened from a script page: `run 003`. */
export const runTabTitle = (runId: string): string => runId.replace(/^RUN-\d{8}-/, 'run ')
