/**
 * What is running now, kept live without polling the list: the engine pushes `run.status` / `sequence.status` for
 * watched runs, so every active run is watched; `runs.changed` tells us when a NEW run
 * appeared, and a run that finishes triggers `onFinished` (the history list reloads to show how it ended).
 */
import type { RunningPanel } from '@scripthub/protocol'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { api, counts, onEvent } from '../../core'

const EMPTY: RunningPanel = { active: [], activeSeqs: [], activeTotal: 0 }

export function useRunning(active: boolean, seed: RunningPanel | undefined, onFinished: () => void) {
  const [data, setData] = useState<RunningPanel>(seed ?? EMPTY)
  const watched = useRef(new Set<string>())
  const known = useRef(new Set<string>())
  const finished = useRef(onFinished)
  finished.current = onFinished
  const alive = useRef(true)
  const seeded = useRef(false) // set as soon as any list was applied, so an older page snapshot never replaces it

  const apply = useCallback((r: RunningPanel) => {
    if (!alive.current) return
    seeded.current = true
    const now = new Set<string>([...r.active.map((x: any) => x.id), ...r.activeSeqs.map((x: any) => x.id)])
    const gone = [...known.current].some((id) => !now.has(id))
    known.current = now
    // watch what is new, forget what ended (the engine pushes status events for watched runs only)
    for (const x of r.active as any[]) {
      if (!watched.current.has(x.id)) {
        watched.current.add(x.id)
        void api['runs.watch']({ id: x.id }).catch(() => watched.current.delete(x.id))
      }
    }
    for (const x of r.activeSeqs as any[]) {
      if (!watched.current.has(x.id)) {
        watched.current.add(x.id)
        void api['sequences.watchRun']({ id: x.id }).catch(() => watched.current.delete(x.id))
      }
    }
    for (const id of [...watched.current]) {
      if (!now.has(id)) {
        watched.current.delete(id)
        void (id.startsWith('SEQ-') ? api['sequences.unwatchRun']({ id }) : api['runs.unwatch']({ id })).catch(() => {})
      }
    }
    setData(r)
    if (gone) finished.current()
  }, [])

  const load = useCallback(async () => {
    try {
      apply(await api['runs.running']({}))
    } catch {
      /* keep the last list */
    }
  }, [apply])

  // the list that came with the history page is only a fallback seed: `runs.running` (loaded on mount and whenever the
  // counts change) and the pushed events keep the panel current, so a page snapshot never overwrites newer data
  useEffect(() => {
    if (seed && !seeded.current) apply(seed)
  }, [seed])

  // pushed status changes of watched runs
  useEffect(() => {
    const offRun = onEvent('run.status', (p) => {
      if (!p.active) return void load()
      setData((d) => ({ ...d, active: d.active.map((r: any) => (r.id === p.id ? { ...r, status: p.status, status_label: p.status_label, duration: p.duration, position: p.queue_position } : r)) }))
    })
    const offSeq = onEvent('sequence.status', (p) => {
      if (!p.active) return void load()
      setData((d) => ({
        ...d,
        activeSeqs: d.activeSeqs.map((r: any) => (r.id === p.id ? { ...r, status: p.status, status_label: p.status_label, paused: p.paused, duration: p.duration, done: p.done } : r)),
      }))
    })
    // a run or a sequence run started / finished anywhere (the engine pushes it; no polling)
    const offAny = onEvent('runs.changed', () => void load())
    return () => { offRun(); offSeq(); offAny() }
  }, [load])

  // the counts also change (pushed by `runs.changed`) when a run starts elsewhere
  const c = counts.value
  useEffect(() => {
    if (active) void load()
  }, [c.running, c.queued, active])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      for (const id of watched.current) void (id.startsWith('SEQ-') ? api['sequences.unwatchRun']({ id }) : api['runs.unwatch']({ id })).catch(() => {})
      watched.current.clear()
    }
  }, [])

  return { running: data, reloadRunning: load }
}
