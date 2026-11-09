/** Hooks for panels. */
import type { CallName, Client, EventName, Events } from '@scripthub/client'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { api, errorText, onEvent } from './api'
import { onCommand } from './bus'
import { activateTab, activeKey, closeTab, openTab, registerCloseGuard, tabs, type CloseGuard } from './tabs'

type Args<K extends CallName> = Parameters<Client[K]>[0]
type Result<K extends CallName> = Awaited<ReturnType<Client[K]>>

export interface ApiState<T> { data: T | undefined; error: string | null; loading: boolean; reload(): Promise<void> }

/** Load a call's result; reloads when `deps` change. `reload()` refreshes by hand. Stale answers are ignored. */
export function useApi<K extends CallName>(name: K, args: Args<K>, deps: unknown[] = [], enabled = true): ApiState<Result<K>> {
  const [data, setData] = useState<Result<K>>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled)
  const seq = useRef(0)
  const argsRef = useRef(args)
  argsRef.current = args

  const reload = useCallback(async () => {
    const n = ++seq.current
    setLoading(true)
    try {
      const r = await (api as any)[name](argsRef.current)
      if (n === seq.current) {
        setData(r)
        setError(null)
      }
    } catch (e) {
      if (n === seq.current) setError(errorText(e))
    } finally {
      if (n === seq.current) setLoading(false)
    }
  }, [name])

  useEffect(() => {
    if (enabled) void reload()
    return () => { seq.current++ }
  }, [reload, enabled, ...deps])
  return { data, error, loading, reload }
}

/** Subscribe to an engine event while mounted. */
export function useEvent<E extends EventName>(event: E, cb: (payload: Events[E]) => void): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => onEvent(event, (p) => ref.current(p)), [event])
}

/** Handle a page command (`run.run`, …) while `active`. */
export function useCommand(name: string, cb: (payload: any) => void, active = true): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => (active ? onCommand(name, (p) => ref.current(p)) : undefined), [name, active])
}

/** Call `fn` every `ms` while `active` and the window is visible (a refresh when it becomes visible again). */
export function usePoll(fn: () => void | Promise<void>, ms: number, active = true): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    const tick = () => { if (!document.hidden) void ref.current() }
    const t = setInterval(tick, ms)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [ms, active])
}

/** The tab list and the actions on it (the signals themselves are in core/tabs). */
export function useTabs() {
  return { tabs: tabs.value, activeKey: activeKey.value, open: openTab, close: closeTab, activate: activateTab }
}

/**
 * Ask before this page's tab closes (x, middle-click, Ctrl+W, Close others / all). Return false to keep the tab.
 * `guard` is read when the tab is closed, so it always sees the page's latest state.
 */
export function useCloseGuard(tabKey: string, guard: CloseGuard): void {
  const ref = useRef(guard)
  ref.current = guard
  useEffect(() => registerCloseGuard(tabKey, () => ref.current()), [tabKey])
}
