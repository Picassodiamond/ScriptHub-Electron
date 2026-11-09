/**
 * In-process execution manager: queue, concurrency limits, cancel and timeout. No database, no task queue:
 * everything durable lives in runtime/executions/. Port of runner/process_manager.py.
 *
 * If the application stops, running scripts are not supervised any more. On the next start such runs are
 * marked "interrupted" (`recoverInterrupted`).
 *
 * History is reached through the small `RunStore` interface; `FileRunStore` implements it on the
 * runtime/executions/RUN-YYYYMMDD-NNN/ layout, so a fuller history module can replace it later.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.js'
import * as executor from './executor.js'
import * as sshHosts from './sshHosts.js'
import { ExecutionError, type ExecutionSpec } from './executor.js'
import { atomicWriteJson, readJson, sleepSync } from './fsutil.js'
import type { DataDirs } from './paths.js'
import { ensureRuntimeDirs } from './paths.js'

export const TRACE_LOG_MAX = 1_000_000 // bytes of trace.log kept per run
export const TOKEN_TTL = 600_000 // ms a submit token is remembered (double-click guard)
export const DEBUG_ACTIONS = ['step', 'continue', 'pause', 'detach', 'breakpoints'] as const
export type DebugAction = (typeof DEBUG_ACTIONS)[number]
export const MAX_BREAKPOINTS = 1000

export const Status = {
  QUEUED: 'queued', RUNNING: 'running', SUCCESS: 'success', FAILED: 'failed',
  TIMED_OUT: 'timed_out', CANCELLED: 'cancelled', INTERRUPTED: 'interrupted',
} as const
export const ACTIVE_STATUSES: string[] = [Status.QUEUED, Status.RUNNING]
export const FINAL_STATUSES: string[] = [Status.SUCCESS, Status.FAILED, Status.TIMED_OUT, Status.CANCELLED, Status.INTERRUPTED]

export type RunMeta = Record<string, any>

/** The part of the history layer the manager needs. */
export interface RunStore {
  /** Create the next RUN-YYYYMMDD-NNN folder. */
  allocateRunDir(): { runId: string; runDir: string }
  runDir(runId: string): string
  logPath(runId: string, stream: 'stdout' | 'stderr'): string
  readMeta(runId: string): RunMeta | null
  writeMeta(runId: string, data: RunMeta): void
  updateMeta(runId: string, fields: RunMeta): RunMeta
  /** Newest first. */
  listRuns(opts?: { statuses?: string[] }): RunMeta[]
  nowIso(): string
  parseIso(value: unknown): Date | null
}

const RUN_ID_RE = /^RUN-\d{8}-\d{3,}$/
export const validRunId = (id: unknown): id is string => typeof id === 'string' && RUN_ID_RE.test(id)

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Filesystem run records (same layout and metadata as the Python app). */
export class FileRunStore implements RunStore {
  constructor(private dirs: DataDirs) {}

  nowIso(): string {
    const d = new Date()
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  parseIso(value: unknown): Date | null {
    if (!value || typeof value !== 'string') return null
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }

  runDir(runId: string): string {
    if (!validRunId(runId)) throw new Error('Invalid run id')
    return path.join(this.dirs.executions, runId)
  }

  logPath(runId: string, stream: 'stdout' | 'stderr'): string {
    if (stream !== 'stdout' && stream !== 'stderr') throw new Error('Unknown stream')
    return path.join(this.runDir(runId), `${stream}.log`)
  }

  private metaPath(runId: string): string {
    return path.join(this.runDir(runId), 'metadata.json')
  }

  allocateRunDir(): { runId: string; runDir: string } {
    ensureRuntimeDirs(this.dirs)
    const d = new Date()
    const prefix = `RUN-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
    let highest = 0
    for (const name of fs.readdirSync(this.dirs.executions)) {
      if (!name.startsWith(prefix)) continue
      const n = parseInt(name.slice(prefix.length), 10)
      if (Number.isFinite(n)) highest = Math.max(highest, n)
    }
    for (let n = highest + 1; ; n++) {
      const runId = `${prefix}${pad(n, 3)}`
      try {
        fs.mkdirSync(path.join(this.dirs.executions, runId))
        return { runId, runDir: path.join(this.dirs.executions, runId) }
      } catch (e: any) {
        if (e?.code !== 'EEXIST') throw e
      }
    }
  }

  readMeta(runId: string): RunMeta | null {
    const exists = fs.existsSync(this.runDir(runId))
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const data = readJson(this.metaPath(runId))
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null
      } catch {
        if (!exists || attempt === 7) return null
        sleepSync(20)
      }
    }
    return null
  }

  writeMeta(runId: string, data: RunMeta): void {
    atomicWriteJson(this.metaPath(runId), data)
  }

  updateMeta(runId: string, fields: RunMeta): RunMeta {
    let data: RunMeta
    try {
      const cur = readJson(this.metaPath(runId))
      data = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}
    } catch {
      data = {}
    }
    Object.assign(data, fields)
    atomicWriteJson(this.metaPath(runId), data)
    return data
  }

  listRuns(opts: { statuses?: string[] } = {}): RunMeta[] {
    let names: string[]
    try {
      names = fs.readdirSync(this.dirs.executions, { withFileTypes: true }).filter((e) => e.isDirectory() && validRunId(e.name)).map((e) => e.name)
    } catch {
      return []
    }
    const out: RunMeta[] = []
    for (const id of names.sort().reverse()) {
      const meta = this.readMeta(id)
      if (!meta) continue
      meta.id ??= id
      if (opts.statuses && !opts.statuses.includes(meta.status)) continue
      out.push(meta)
    }
    return out
  }
}

export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
  return true
}

export interface DebugState {
  state: 'starting' | 'paused' | 'running' | 'detached'
  line: number | null
  scopes: any[]
  stack: any[]
  breakpoints: number[]
}

const debugBlank = (state: DebugState['state'] = 'starting'): DebugState => ({ state, line: null, scopes: [], stack: [], breakpoints: [] })

class Active {
  proc: ChildProcess | null = null
  remotePid: number | null = null
  reason: null | 'cancelled' | 'timed_out' = null
  /** Step debugger: state shown in the console. */
  dbg: DebugState | null
  /** Control lines sent before the debuggee first paused. */
  pending: string[] = []
  stdinOpen = false
  private cancelResolve!: () => void
  readonly cancelled = new Promise<void>((r) => (this.cancelResolve = r))

  constructor(readonly runId: string, readonly spec: ExecutionSpec) {
    this.dbg = spec.debug ? debugBlank() : null
  }

  requestCancel(): void {
    this.cancelResolve()
  }
}

export interface ManagerOptions {
  store: RunStore
  /** Current settings (max_concurrent_*, ssh_*, interpreters…); read for every dispatch and run. */
  getConfig: () => Config
  pythonExecutable?: string
  /** Recorded as owner_pid (tests may fake another owner). */
  ownerPid?: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class ExecutionManager {
  private queue: string[] = []
  private specs = new Map<string, ExecutionSpec>() // queued run id -> spec
  private active = new Map<string, Active>() // running run id -> Active
  private tokens = new Map<string, { runId: string; at: number }>()
  private events = new EventEmitter()
  private store: RunStore
  private getConfig: () => Config
  private opts: ManagerOptions

  constructor(opts: ManagerOptions) {
    this.opts = opts
    this.store = opts.store
    this.getConfig = opts.getConfig
    this.events.setMaxListeners(0)
  }

  /** Subscribe to "a run left the queue / the active set" (the `changed` event). */
  onChanged(cb: () => void): () => void {
    this.events.on('changed', cb)
    return () => this.events.off('changed', cb)
  }

  // ------------------------------------------------------------ public ---
  submit(spec: ExecutionSpec, initiator = 'local'): string {
    const now = Date.now()
    for (const [t, v] of this.tokens) if (now - v.at >= TOKEN_TTL) this.tokens.delete(t)
    if (spec.token && this.tokens.has(spec.token)) return this.tokens.get(spec.token)!.runId // duplicate submission
    if (spec.debug && spec.trace === null) spec.trace = {} // debugging always reports the running line too
    const { runId, runDir } = this.store.allocateRunDir()
    if (spec.trace !== null) {
      // What the console shows next to the output: the source as it was when the run started.
      try {
        fs.writeFileSync(path.join(runDir, 'trace_source'), fs.readFileSync(spec.scriptPath).subarray(0, 512 * 1024))
      } catch { /* ignore */ }
    }
    this.store.writeMeta(runId, {
      id: runId,
      script_id: spec.scriptId,
      script_name: spec.scriptName,
      script_path: spec.scriptPath,
      host: spec.host,
      interpreter: spec.interpreter,
      command: spec.displayCommand,
      parameters: spec.parameters,
      status: Status.QUEUED,
      queued_at: this.store.nowIso(),
      started_at: null,
      finished_at: null,
      duration_seconds: null,
      exit_code: null,
      pid: null,
      remote_pid: null,
      timeout: spec.timeout,
      initiator,
      trace: spec.trace !== null ? { enabled: true, stopped: false } : null,
      debug: spec.debug ? { enabled: true } : null,
      owner_pid: this.opts.ownerPid ?? process.pid,
      error: null,
      ...(spec.sequence ? { sequence: { ...spec.sequence } } : {}),
    })
    this.specs.set(runId, spec)
    this.queue.push(runId)
    if (spec.token) this.tokens.set(spec.token, { runId, at: now })
    this.dispatch()
    this.events.emit('changed') // a run was queued or started: listeners (the UI's counts) learn at once
    return runId
  }

  /** Cancel a queued or running execution. False if it is not active. */
  cancel(runId: string): boolean {
    if (this.specs.has(runId)) {
      this.queue.splice(this.queue.indexOf(runId), 1)
      this.specs.delete(runId)
      this.store.updateMeta(runId, { status: Status.CANCELLED, finished_at: this.store.nowIso(), error: 'Cancelled while queued.' })
      this.events.emit('changed')
      return true
    }
    const active = this.active.get(runId)
    if (!active) return false
    active.reason ??= 'cancelled'
    active.requestCancel()
    return true
  }

  /** Stop line tracing for the rest of a running script (it then runs at full speed). */
  stopTrace(runId: string): boolean {
    const active = this.active.get(runId)
    if (!active || active.spec.trace === null) return false
    if (active.spec.debug) return this.debugCommand(runId, 'detach')
    const spec = active.spec
    if (spec.host === executor.LOCAL) {
      const stopfile = spec.trace!.stopfile
      if (!stopfile) return false
      try {
        fs.writeFileSync(stopfile, 'stop')
      } catch {
        return false
      }
    } else {
      const pid = active.remotePid
      if (typeof pid !== 'number' || pid <= 1) return false
      const cfg = this.getConfig()
      // fire and forget, like the Python daemon thread
      void sshHosts.runRemote(spec.host, `kill -USR1 ${Math.trunc(pid)} 2>/dev/null; true`, cfg, 30).catch(() => {})
    }
    this.store.updateMeta(runId, { trace: { enabled: true, stopped: true } })
    return true
  }

  // ------------------------------------------------------------- debugger ---
  /** What the step debugger of a run is doing, or null if it is not a debug run managed here (finished runs included). */
  debugState(runId: string): DebugState | null {
    const active = this.active.get(runId)
    if (active?.dbg) {
      const d = active.dbg
      return { state: d.state, line: d.line, scopes: [...d.scopes], stack: [...d.stack], breakpoints: [...d.breakpoints] }
    }
    const spec = this.specs.get(runId)
    if (spec?.debug) return debugBlank()
    return null
  }

  /** Send step / continue / pause / detach / breakpoints to a running debug run. */
  debugCommand(runId: string, action: string, lines: Iterable<number | string> = []): boolean {
    if (!(DEBUG_ACTIONS as readonly string[]).includes(action)) return false
    const active = this.active.get(runId)
    if (!active || !active.dbg) return false
    let bps: number[] = []
    let text: string
    if (action === 'breakpoints') {
      bps = [...new Set([...lines].map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n) && n >= 1))].sort((a, b) => a - b).slice(0, MAX_BREAKPOINTS)
      text = 'bp ' + bps.join(',')
    } else text = action
    const d = active.dbg
    if (d.state === 'detached' || active.reason) return false
    const queued = d.state === 'starting' // sent when the debuggee first stops
    if (action === 'breakpoints') d.breakpoints = bps
    else if (action === 'detach') d.state = 'detached'
    else if ((action === 'step' || action === 'continue') && d.state === 'paused') d.state = 'running' // set before writing: the next 'P' must win
    if (queued) active.pending.push(text)
    const ok = queued || this.writeControl(active, [text])
    if (ok && action === 'detach') this.store.updateMeta(runId, { trace: { enabled: true, stopped: true } })
    return ok
  }

  private writeControl(active: Active, lines: string[]): boolean {
    const stdin = active.proc?.stdin
    if (!stdin || !active.stdinOpen || stdin.destroyed || !stdin.writable) return false
    try {
      stdin.write(Buffer.from(lines.map((t) => t + '\n').join(''), 'ascii'))
      return true
    } catch {
      return false
    }
  }

  /** Marker callback (stderr pump): P paused, R resumed, V variables. */
  private debugEvent(active: Active): (kind: 'P' | 'R' | 'V', value: any) => void {
    return (kind, value) => {
      const d = active.dbg!
      let pending: string[] = []
      if (kind === 'P') {
        if (d.state !== 'detached') d.state = 'paused'
        d.line = value
        d.scopes = []
        d.stack = []
        pending = active.pending
        active.pending = []
      } else if (kind === 'R') {
        if (d.state === 'paused') d.state = 'running'
      } else {
        d.scopes = Array.isArray(value?.scopes) ? value.scopes : []
        d.stack = Array.isArray(value?.stack) ? value.stack : []
      }
      if (pending.length) this.writeControl(active, pending)
    }
  }

  queuePosition(runId: string): number | null {
    const i = this.queue.indexOf(runId)
    return i < 0 ? null : i + 1
  }

  isActive(runId: string): boolean {
    return this.active.has(runId) || this.specs.has(runId)
  }

  private waitChanged(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.events.off('changed', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.events.on('changed', done)
    })
  }

  /** Resolves once `runId` is neither queued nor running (its metadata then holds the final status); false on timeout. */
  async waitFinished(runId: string, timeoutMs?: number): Promise<boolean> {
    const end = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs
    while (this.isActive(runId)) {
      const wait = Math.min(1000, end - Date.now())
      if (wait <= 0) return false
      await this.waitChanged(wait)
    }
    return true
  }

  /** Resolves when at least one of `runIds` has finished (or the timeout passed); returns those that are neither queued nor running. */
  async waitAny(runIds: string[], timeoutMs?: number): Promise<string[]> {
    const end = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs
    for (;;) {
      const done = runIds.filter((r) => !this.isActive(r))
      if (done.length || !runIds.length) return done
      const wait = Math.min(1000, end - Date.now())
      if (wait <= 0) return []
      await this.waitChanged(wait)
    }
  }

  counts(): { running: number; queued: number } {
    return { running: this.active.size, queued: this.queue.length }
  }

  activeIds(): string[] {
    return [...this.active.keys()]
  }

  /** Queued and running run ids. */
  liveIds(): string[] {
    return [...new Set([...this.active.keys(), ...this.specs.keys()])]
  }

  /** Resolves when nothing is running or queued (used by tests). */
  async waitIdle(timeoutMs = 30000): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (!this.active.size && !this.queue.length) return true
      await sleep(50)
    }
    return false
  }

  /** Mark runs left queued/running by a stopped app as interrupted. */
  recoverInterrupted(): string[] {
    const fixed: string[] = []
    const me = this.opts.ownerPid ?? process.pid
    for (const meta of this.store.listRuns({ statuses: ACTIVE_STATUSES })) {
      const runId = meta.id
      const owner = meta.owner_pid
      if (this.active.has(runId) || this.specs.has(runId)) continue
      if (owner === me || pidAlive(owner)) continue // owned by a live application instance
      let note = 'The application stopped before this run finished.'
      const pid = meta.pid
      if (meta.status === Status.RUNNING && meta.host === 'local' && pidAlive(pid)) note += ` The script process (PID ${pid}) may still be running.`
      this.store.updateMeta(runId, { status: Status.INTERRUPTED, finished_at: this.store.nowIso(), error: note })
      fixed.push(runId)
    }
    return fixed
  }

  // ---------------------------------------------------------- internals ---
  private canStart(spec: ExecutionSpec, cfg: Config): boolean {
    if (this.active.size >= cfg.max_concurrent_executions) return false
    let sameHost = 0
    for (const a of this.active.values()) if (a.spec.host === spec.host) sameHost++
    if (sameHost >= cfg.max_concurrent_per_host) return false
    if (!spec.allowConcurrent && [...this.active.values()].some((a) => a.spec.scriptId === spec.scriptId)) return false
    return true
  }

  private dispatch(): void {
    const cfg = this.getConfig()
    let started = false
    for (const runId of [...this.queue]) {
      const spec = this.specs.get(runId)!
      if (!this.canStart(spec, cfg)) continue // blocked runs are skipped, not waited on
      this.queue.splice(this.queue.indexOf(runId), 1)
      this.specs.delete(runId)
      const active = new Active(runId, spec)
      this.active.set(runId, active)
      started = true
      void this.run(active)
    }
    if (started && this.active.size) this.events.emit('changed') // a queued run began: running / queued counts moved
  }

  private finish(active: Active, status: string, exitCode: number | null, error: string | null = null): void {
    const now = this.store.nowIso()
    const meta = this.store.readMeta(active.runId) ?? {}
    const started = this.store.parseIso(meta.started_at)
    let duration: number | null = null
    if (started) {
      const secs = Math.max(0, (this.store.parseIso(now)!.getTime() - started.getTime()) / 1000)
      duration = Math.round(secs * 10) / 10
    }
    this.store.updateMeta(active.runId, { status, exit_code: exitCode, finished_at: now, duration_seconds: duration, error })
  }

  private writeStderr(runId: string, text: string): void {
    try {
      fs.appendFileSync(this.store.logPath(runId, 'stderr'), text)
    } catch { /* ignore */ }
  }

  private traceWriter(runId: string): (nums: number[]) => void {
    const folder = this.store.runDir(runId)
    return (nums) => {
      try {
        const log = path.join(folder, 'trace.log')
        if (!fs.existsSync(log) || fs.statSync(log).size < TRACE_LOG_MAX) fs.appendFileSync(log, nums.join('\n') + '\n')
        fs.writeFileSync(path.join(folder, 'trace.last'), String(nums[nums.length - 1]))
      } catch { /* ignore */ }
    }
  }

  private async run(active: Active): Promise<void> {
    const { spec, runId } = active
    const cfg = this.getConfig()
    try {
      this.store.updateMeta(runId, { status: Status.RUNNING, started_at: this.store.nowIso() })
      if (spec.trace !== null) spec.trace.stopfile = path.join(this.store.runDir(runId), 'trace.stop')
      let cmd: executor.Command
      try {
        cmd = executor.buildCommand(spec, cfg, { pythonExecutable: this.opts.pythonExecutable })
      } catch (e) {
        if (!(e instanceof ExecutionError)) throw e
        this.writeStderr(runId, `[scripthub] ${e.message}\n`)
        this.finish(active, Status.FAILED, null, e.message)
        return
      }

      const proc = spawn(cmd.args[0], cmd.args.slice(1), {
        shell: false,
        stdio: [cmd.stdin !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        cwd: cmd.cwd ?? undefined,
        env: cmd.env,
        windowsHide: true,
        detached: process.platform !== 'win32', // own process group, so the whole tree can be stopped
      })
      proc.on('error', () => { /* start failures are handled below; later ones (kill) are ignored */ })
      proc.stdin?.on('error', () => { /* the process may exit before reading its stdin */ })
      const exitP = new Promise<number | null>((resolve) => {
        proc.once('exit', (code, signal) => resolve(code ?? (signal ? -1 : null)))
        proc.once('error', () => resolve(null))
      })
      const outP = executor.pump(proc.stdout!, this.store.logPath(runId, 'stdout'), {
        onMarker: cmd.remote ? (pid) => { active.remotePid = pid; this.store.updateMeta(runId, { remote_pid: pid }) } : null,
      })
      const errP = executor.pump(proc.stderr!, this.store.logPath(runId, 'stderr'), {
        onTrace: spec.trace !== null ? this.traceWriter(runId) : null,
        onEvent: active.dbg ? this.debugEvent(active) : null,
      })
      try {
        await new Promise<void>((resolve, reject) => {
          proc.once('spawn', resolve)
          proc.once('error', reject)
        })
      } catch (e: any) {
        const msg = `Could not start the process: ${e?.message ?? e}`
        this.writeStderr(runId, `[scripthub] ${msg}\n`)
        this.finish(active, Status.FAILED, null, msg)
        return
      }
      active.proc = proc
      active.stdinOpen = cmd.keepStdinOpen
      this.store.updateMeta(runId, { pid: proc.pid })

      if (cmd.keepStdinOpen) {
        // Debug runs: write the initial bytes and keep stdin open for control lines.
        try {
          if (cmd.stdin && cmd.stdin.length) proc.stdin!.write(cmd.stdin)
        } catch { /* ignore */ }
      } else if (cmd.stdin !== null) executor.feedStdin(proc, cmd.stdin)

      const timer = new Promise<'timeout'>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), spec.timeout * 1000)
        t.unref()
        void exitP.then(() => clearTimeout(t))
      })
      const outcome = await Promise.race([exitP.then(() => 'exit' as const), active.cancelled.then(() => 'cancel' as const), timer])
      if (outcome !== 'exit') {
        if (outcome === 'timeout') active.reason ??= 'timed_out'
        await executor.stop(spec, proc, active.remotePid, cfg)
        const settled = await Promise.race([exitP.then(() => true), sleep(10000).then(() => false)])
        if (!settled) {
          try { proc.kill('SIGKILL') } catch { /* ignore */ }
          await exitP
        }
      }

      if (cmd.keepStdinOpen) {
        active.stdinOpen = false
        try { proc.stdin?.end() } catch { /* ignore */ }
      }
      await Promise.race([Promise.all([outP, errP]), sleep(5000)])
      for (const s of [proc.stdout, proc.stderr]) try { s?.destroy() } catch { /* ignore */ }

      const code = await exitP
      if (active.reason === 'cancelled') this.finish(active, Status.CANCELLED, code, 'Stopped by user.')
      else if (active.reason === 'timed_out') this.finish(active, Status.TIMED_OUT, code, `Exceeded the ${spec.timeout}s timeout and was stopped.`)
      else if (cmd.remote && code === 255)
        this.finish(active, Status.FAILED, code, 'SSH connection failed (see stderr). Check that the host is reachable and key-based login works.')
      else if (code === 0) this.finish(active, Status.SUCCESS, 0)
      else this.finish(active, Status.FAILED, code, `Exited with code ${code}.`)
    } catch (e: any) {
      // never leave a run stuck in 'running'
      this.writeStderr(runId, `[scripthub] internal error: ${e?.stack ?? e}\n`)
      this.finish(active, Status.FAILED, null, `Internal error: ${e?.message ?? e}`)
    } finally {
      this.active.delete(runId)
      this.events.emit('changed')
      this.dispatch()
    }
  }
}
