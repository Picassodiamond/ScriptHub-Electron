/**
 * Everything the console needs to know about one run, pushed by the engine: the run's record (runs.console), the output
 * (run.output events, with an offset-based replay for a finished run or after a refresh), status, trace line and debugger
 * state. No polling: runs.watch starts the events, the offsets make every chunk arrive exactly once.
 */
import type { DebugState, RunConsole, RunStatus, TraceState } from '@scripthub/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { api, errorText, onEvent } from '../../core'
import { OutputBuffer } from './outputBuffer'

export type Link = 'connecting' | 'live' | 'finished' | 'error'
export type StatusFields = Omit<RunStatus, 'stdout' | 'stdout_next' | 'stderr' | 'stderr_next' | 'debug'>

const RENDER_MS = 40
const HISTORY_MAX = 200

export interface RunStream {
  info: RunConsole | null
  loadError: string | null
  status: StatusFields | null
  out: OutputBuffer
  err: OutputBuffer
  /** Changes whenever something shown changed (buffers are mutable). */
  version: number
  debug: DebugState | null
  trace: TraceState | null
  link: Link
  linkNote: string
  /** Seconds the run has been running, ticking while it runs; null before it started. */
  elapsed: number | null
  /** Lines reached by trace / debugger, oldest first (consecutive repeats collapsed), and how often each was seen. */
  lineHistory: number[]
  lineHits: Map<number, number>
  /** Fetch the output and status again from the offsets (and watch again when the run is still active). */
  refresh(): Promise<void>
  /** Take a debugger state that came back from a command. */
  setDebug(d: DebugState | null): void
}

export function useRunStream(runId: string | undefined, active: boolean): RunStream {
  const out = useMemo(() => new OutputBuffer(), [runId])
  const err = useMemo(() => new OutputBuffer(), [runId])
  const [info, setInfo] = useState<RunConsole | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusFields | null>(null)
  const [debug, setDebug] = useState<DebugState | null>(null)
  const [trace, setTrace] = useState<TraceState | null>(null)
  const [link, setLink] = useState<Link>('connecting')
  const [linkNote, setLinkNote] = useState('Connecting…')
  const [version, setVersion] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const base = useRef<{ seconds: number | null; at: number; running: boolean }>({ seconds: null, at: Date.now(), running: false })
  const offsets = useRef({ out: 0, err: 0 })
  const lineState = useRef({ last: null as number | null, history: [] as number[], hits: new Map<number, number>() })
  const statusRef = useRef<StatusFields | null>(null)
  const watching = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const render = useCallback(() => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      setVersion((v) => v + 1)
    }, RENDER_MS)
  }, [])

  const noteLine = useCallback((line: number | null | undefined) => {
    const ls = lineState.current
    if (!line || line === ls.last) return
    ls.last = line
    ls.hits.set(line, (ls.hits.get(line) ?? 0) + 1)
    ls.history.push(line)
    if (ls.history.length > HISTORY_MAX) ls.history.shift()
  }, [])

  const takeStatus = useCallback((s: StatusFields) => {
    statusRef.current = s
    setStatus(s)
    setTrace(s.trace)
    noteLine(s.trace?.line)
    base.current = { seconds: s.duration_seconds, at: Date.now(), running: s.status === 'running' }
  }, [noteLine])

  const takeDebug = useCallback((d: DebugState | null) => {
    setDebug(d)
    if (d && (d.state === 'paused' || d.state === 'ended')) noteLine(d.line)
    render()
  }, [noteLine, render])

  const applyOutput = useCallback((p: { stdout: string; stdout_next: number; stderr: string; stderr_next: number }) => {
    const o = offsets.current
    if (p.stdout_next > o.out) {
      out.append(p.stdout)
      o.out = p.stdout_next
    }
    if (p.stderr_next > o.err) {
      err.append(p.stderr)
      o.err = p.stderr_next
    }
    render()
  }, [out, err, render])

  /** Read everything after the offsets (the output can be longer than one chunk); returns the last status. */
  const drain = useCallback(async (id: string): Promise<RunStatus> => {
    for (let guard = 0; guard < 20_000; guard++) {
      const before = { ...offsets.current }
      const r = await api['runs.status']({ id, out: before.out, err: before.err })
      applyOutput(r)
      if (r.stdout_next <= before.out && r.stderr_next <= before.err) return r
      if (!r.stdout && !r.stderr) return r
    }
    return api['runs.status']({ id, out: offsets.current.out, err: offsets.current.err })
  }, [applyOutput])

  const unwatch = useCallback((id: string) => {
    if (!watching.current) return
    watching.current = false
    void api['runs.unwatch']({ id }).catch(() => {})
  }, [])

  const sync = useCallback(async (id: string) => {
    const r = await drain(id)
    const { stdout, stdout_next, stderr, stderr_next, debug: d, ...rest } = r
    void stdout; void stdout_next; void stderr; void stderr_next
    takeStatus(rest)
    if (d !== undefined) takeDebug(d)
    if (r.active) {
      await api['runs.watch']({ id, out: offsets.current.out, err: offsets.current.err })
      watching.current = true
      setLink('live')
      setLinkNote('Live')
    } else {
      unwatch(id)
      setLink('finished')
      setLinkNote('Finished')
    }
    render()
  }, [drain, takeStatus, takeDebug, unwatch, render])

  useEffect(() => {
    if (!runId) return
    let dead = false
    offsets.current = { out: 0, err: 0 }
    lineState.current = { last: null, history: [], hits: new Map() }
    statusRef.current = null
    setInfo(null); setStatus(null); setDebug(null); setTrace(null); setLoadError(null); setLink('connecting'); setLinkNote('Connecting…')

    const offOut = onEvent('run.output', (p) => { if (p.id === runId && !dead) applyOutput(p) })
    const offStatus = onEvent('run.status', (p) => {
      if (p.id !== runId || dead) return
      const { id, ...rest } = p
      void id
      const was = statusRef.current
      takeStatus(rest as StatusFields)
      if (!rest.active) {
        setLink('finished')
        setLinkNote('Finished')
        if (was?.active !== false) void drain(runId).then(() => { if (!dead) { unwatch(runId); render() } }).catch(() => {})
      } else {
        setLink('live')
        setLinkNote('Live')
      }
    })
    const offDebug = onEvent('debug.state', (p) => { if (p.id === runId && !dead) takeDebug(p.debug) })

    void (async () => {
      try {
        const c = await api['runs.console']({ id: runId })
        if (dead) return
        setInfo(c)
        await sync(runId)
      } catch (e) {
        if (dead) return
        setLoadError(errorText(e))
        setLink('error')
        setLinkNote('Could not load this run')
      }
    })()

    return () => {
      dead = true
      offOut(); offStatus(); offDebug()
      unwatch(runId)
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [runId])

  // the duration ticks every second while the run runs (and the tab is shown)
  useEffect(() => {
    if (!active || !status || status.status !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active, status?.status])

  const refresh = useCallback(async () => {
    if (!runId) return
    try {
      watching.current = false
      await sync(runId)
    } catch (e) {
      setLink('error')
      setLinkNote(`Connection problem: ${errorText(e)}`)
    }
  }, [runId, sync])

  const b = base.current
  const elapsed = status && b.seconds !== null ? (b.running ? b.seconds + (now - b.at) / 1000 : b.seconds) : null
  return {
    info, loadError, status, out, err, version, debug, trace, link, linkNote, elapsed,
    lineHistory: lineState.current.history, lineHits: lineState.current.hits, refresh, setDebug: takeDebug,
  }
}
