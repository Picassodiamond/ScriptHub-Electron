/**
 * Turns polling into pushed events: watched runs (status, output chunks, debugger state), watched sequence
 * runs, and the folder scan progress. One timer runs only while something is being watched.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DebugState, EventName, Events } from '@scripthub/protocol'
import type { Engine } from '../engine.js'
import * as history from '../history.js'
import { ago } from './util.js'

export type Emit = <E extends EventName>(event: E, payload: Events[E]) => void

const TICK_MS = 250

function lastLine(engine: Engine, runId: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(path.join(engine.history.runDir(runId), 'trace.last'), 'utf8').trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export function debugStateOf(engine: Engine, runId: string, meta: Record<string, any>): DebugState | null {
  if (!meta.debug) return null
  if (history.isActive(meta)) {
    const s = engine.manager.debugState(runId)
    if (s) return s as unknown as DebugState
  }
  return { state: 'ended', line: lastLine(engine, runId), scopes: [], stack: [], breakpoints: [] }
}

/** The status payload of a run, with output chunks read from the given offsets (execution_status). */
export function runStatusOf(engine: Engine, runId: string, meta: Record<string, any>, outOffset: number, errOffset: number) {
  const [stdout, stdoutNext] = history.readChunk(engine.history.logPath(runId, 'stdout'), outOffset)
  const [stderr, stderrNext] = history.readChunk(engine.history.logPath(runId, 'stderr'), errOffset)
  let seconds: number | null = history.durationSeconds(meta)
  if (meta.duration_seconds !== null && meta.duration_seconds !== undefined) seconds = meta.duration_seconds
  const trace = meta.trace
    ? { line: lastLine(engine, runId), stopped: !!meta.trace.stopped }
    : null
  return {
    status: meta.status,
    status_label: history.STATUS_LABELS[meta.status] ?? meta.status,
    active: history.isActive(meta),
    exit_code: meta.exit_code ?? null,
    started_at: meta.started_at ?? null,
    finished_at: meta.finished_at ?? null,
    queued_at: meta.queued_at ?? null,
    duration: history.formatDuration(seconds),
    duration_seconds: seconds,
    queue_position: engine.manager.queuePosition(runId),
    error: meta.error ?? null,
    pid: meta.pid ?? null,
    stdout, stdout_next: stdoutNext, stderr, stderr_next: stderrNext,
    trace,
    debug: debugStateOf(engine, runId, meta),
  }
}

interface RunWatch { out: number; err: number; last: string; lastDebug: string }

export class Watcher {
  private runs = new Map<string, RunWatch>()
  private seqs = new Map<string, string>()
  private scanning = false
  private lastScan = ''
  private timer: NodeJS.Timeout | null = null
  private unsub: (() => void) | null = null

  constructor(private engine: Engine, private emit: Emit, private sequenceStatus: (id: string) => Events['sequence.status'] | null) {}

  private ensure(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
    this.unsub ??= this.engine.manager.onChanged(() => this.tick())
  }

  private maybeStop(): void {
    if (this.timer && !this.runs.size && !this.seqs.size && !this.scanning) {
      clearInterval(this.timer)
      this.timer = null
      this.unsub?.()
      this.unsub = null
    }
  }

  watchRun(id: string, out = 0, err = 0): void {
    this.runs.set(id, { out, err, last: '', lastDebug: '' })
    this.ensure()
    this.tick()
  }
  unwatchRun(id: string): void {
    this.runs.delete(id)
    this.maybeStop()
  }
  watchSequence(id: string): void {
    this.seqs.set(id, '')
    this.ensure()
    this.tick()
  }
  unwatchSequence(id: string): void {
    this.seqs.delete(id)
    this.maybeStop()
  }
  /** A scan was started: report its progress until it ends. */
  watchScan(): void {
    this.scanning = true
    this.lastScan = ''
    this.ensure()
    this.tick()
  }

  tick(): void {
    for (const [id, w] of [...this.runs]) {
      const meta = this.engine.history.readMeta(id)
      if (!meta) {
        this.runs.delete(id)
        continue
      }
      const s = runStatusOf(this.engine, id, meta, w.out, w.err)
      if (s.stdout || s.stderr) {
        this.emit('run.output', { id, stdout: s.stdout, stdout_next: s.stdout_next, stderr: s.stderr, stderr_next: s.stderr_next })
        w.out = s.stdout_next
        w.err = s.stderr_next
      }
      const { stdout, stdout_next, stderr, stderr_next, debug, ...status } = s
      void stdout; void stdout_next; void stderr; void stderr_next
      const key = JSON.stringify(status)
      if (key !== w.last) {
        w.last = key
        this.emit('run.status', { id, ...status } as Events['run.status'])
      }
      const dkey = JSON.stringify(debug)
      if (meta.debug && dkey !== w.lastDebug) {
        w.lastDebug = dkey
        this.emit('debug.state', { id, debug })
      }
      if (!s.active) this.runs.delete(id) // everything up to the end has been sent
    }
    for (const [id, last] of [...this.seqs]) {
      const st = this.sequenceStatus(id)
      if (!st) {
        this.seqs.delete(id)
        continue
      }
      const key = JSON.stringify(st)
      if (key !== last) {
        this.seqs.set(id, key)
        this.emit('sequence.status', st)
      }
      if (!st.active) this.seqs.delete(id)
    }
    if (this.scanning) {
      const st = this.engine.discovery.status()
      const key = JSON.stringify(st)
      if (key !== this.lastScan) {
        this.lastScan = key
        this.emit('scan.progress', st)
      }
      if (!st.scanning) this.scanning = false
    }
    this.maybeStop()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsub?.()
    this.unsub = null
    this.runs.clear()
    this.seqs.clear()
    this.scanning = false
  }
}

export { ago }
