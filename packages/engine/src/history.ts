/**
 * Execution records and their housekeeping. Port of runner/history.py + runner/history_ops.py.
 *
 *   runtime/executions/RUN-YYYYMMDD-NNN/{metadata.json, stdout.log, stderr.log}
 *
 * History (records) and HistoryOps (queries, deletion, retention) take the data folders and,
 * where Python reached into other modules, a small injected hook (script-id aliases, sequence-run
 * retention) so this file depends on nothing else in the engine except fsutil/paths.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DataDirs } from './paths.js'
import { ensureRuntimeDirs } from './paths.js'
import { atomicWriteJson, readJson, sleepSync } from './fsutil.js'

export type RunMeta = Record<string, any>

export const RUN_ID_RE = /^RUN-\d{8}-\d{3,}$/

export const QUEUED = 'queued'
export const RUNNING = 'running'
export const SUCCESS = 'success'
export const FAILED = 'failed'
export const TIMED_OUT = 'timed_out'
export const CANCELLED = 'cancelled'
export const INTERRUPTED = 'interrupted'
export const ACTIVE_STATUSES: readonly string[] = [QUEUED, RUNNING]
export const FINAL_STATUSES: readonly string[] = [SUCCESS, FAILED, TIMED_OUT, CANCELLED, INTERRUPTED]
export const ALL_STATUSES: readonly string[] = [...ACTIVE_STATUSES, ...FINAL_STATUSES]
export const STATUS_LABELS: Record<string, string> = {
  [QUEUED]: 'Queued', [RUNNING]: 'Running', [SUCCESS]: 'Success', [FAILED]: 'Failed',
  [TIMED_OUT]: 'Timed out', [CANCELLED]: 'Cancelled', [INTERRUPTED]: 'Interrupted',
}
export const MAX_CHUNK = 256 * 1024
export const RETENTION_INTERVAL = 3600 // seconds between automatic sweeps

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Local date as YYYY-MM-DD. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local time as ISO text to the second ("2026-11-08T20:44:13", no zone), like Python's isoformat(timespec="seconds"). */
export function nowIso(d: Date = new Date()): string {
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function parseIso(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null
  let v = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v += 'T00:00:00' // a bare date is local midnight (JS would say UTC)
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 'YYYY-MM-DD' (a real calendar date) or null. */
export function parseDate(value: unknown): string | null {
  const v = String(value ?? '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return null
  const d = new Date(+m[1], +m[2] - 1, +m[3])
  return localDate(d) === v ? v : null
}

export function validRunId(runId: unknown): runId is string {
  return typeof runId === 'string' && RUN_ID_RE.test(runId)
}

/** Is a process alive? (signal 0: EPERM still means it exists.) */
export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

export interface IdsLike {
  canonical(sid: string): string
}

export function durationSeconds(meta: RunMeta, now: Date = new Date()): number | null {
  const start = parseIso(meta.started_at)
  if (!start) return null
  let end = parseIso(meta.finished_at)
  if (!end) {
    if (meta.status !== RUNNING) return null
    end = now
  }
  return Math.max(0, (end.getTime() - start.getTime()) / 1000)
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  const s0 = Math.trunc(seconds)
  const h = Math.floor(s0 / 3600)
  const m = Math.floor((s0 % 3600) / 60)
  const s = s0 % 60
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`
  if (m) return `${m}m ${pad(s)}s`
  return `${s}s`
}

/** (text, new offset) from `file`, never splitting a UTF-8 character at the end of the chunk. */
export function readChunk(file: string, offset = 0, limit = MAX_CHUNK): [string, number] {
  let blob: Buffer
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(limit)
      const n = fs.readSync(fd, buf, 0, limit, Math.max(0, offset))
      blob = buf.subarray(0, n)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ['', offset]
  }
  if (!blob.length) return ['', offset]
  let end = blob.length
  for (let back = 1; back < 4; back++) {
    if (end - back < 0) break
    const b = blob[end - back]
    if ((b & 0xc0) === 0x80) continue // continuation byte, keep looking
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    if (need > back) end -= back // incomplete sequence: leave it for the next poll
    break
  }
  return [new TextDecoder('utf-8').decode(blob.subarray(0, end)), offset + end]
}

export class History {
  constructor(readonly dirs: DataDirs, private ids: IdsLike | null = null) {}

  runDir(runId: string): string {
    if (!validRunId(runId)) throw new Error('Invalid run id')
    return path.join(this.dirs.executions, runId)
  }

  metaPath(runId: string): string {
    return path.join(this.runDir(runId), 'metadata.json')
  }

  logPath(runId: string, stream: string): string {
    if (stream !== 'stdout' && stream !== 'stderr') throw new Error('Unknown stream')
    return path.join(this.runDir(runId), `${stream}.log`)
  }

  /** Create the next RUN-YYYYMMDD-NNN folder. */
  allocateRunDir(now: Date = new Date()): { runId: string; dir: string } {
    ensureRuntimeDirs(this.dirs)
    const prefix = `RUN-${localDate(now).replaceAll('-', '')}-`
    let highest = 0
    for (const name of fs.readdirSync(this.dirs.executions)) {
      if (!name.startsWith(prefix)) continue
      const rest = name.slice(prefix.length)
      if (/^\d+$/.test(rest)) highest = Math.max(highest, parseInt(rest, 10))
    }
    for (let n = highest + 1; ; n++) {
      const runId = `${prefix}${pad(n, 3)}`
      const dir = path.join(this.dirs.executions, runId)
      try {
        fs.mkdirSync(dir)
        return { runId, dir }
      } catch (e: any) {
        if (e?.code !== 'EEXIST') throw e
      }
    }
  }

  /** Metadata of a run, or null. A brief failure while another writer swaps the file in is retried. */
  readMeta(runId: string): RunMeta | null {
    let exists = false
    try {
      exists = fs.statSync(this.runDir(runId)).isDirectory()
    } catch {
      exists = false
    }
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

  listRunIds(newestFirst = true): string[] {
    let ids: string[]
    try {
      ids = fs.readdirSync(this.dirs.executions, { withFileTypes: true })
        .filter((e) => e.isDirectory() && validRunId(e.name)).map((e) => e.name)
    } catch {
      return []
    }
    ids.sort()
    return newestFirst ? ids.reverse() : ids
  }

  /** A run's script_id as the script is known now (an old path id resolves to its stable id). */
  canonicalScript(meta: RunMeta): RunMeta {
    if (meta.script_id && this.ids) meta.script_id = this.ids.canonical(meta.script_id)
    return meta
  }

  canonicalId(sid: string): string {
    return this.ids ? this.ids.canonical(sid) : sid
  }

  /** Newest first; `scriptId` (any id of the script) keeps only its runs. */
  listRuns(opts: { limit?: number; statuses?: readonly string[]; scriptId?: string } = {}): RunMeta[] {
    const out: RunMeta[] = []
    const scriptId = opts.scriptId ? this.canonicalId(opts.scriptId) : ''
    for (const runId of this.listRunIds()) {
      const meta = this.readMeta(runId)
      if (!meta) continue
      if (meta.id === undefined) meta.id = runId
      this.canonicalScript(meta)
      if (opts.statuses?.length && !opts.statuses.includes(meta.status)) continue
      if (scriptId && meta.script_id !== scriptId) continue
      out.push(meta)
      if (opts.limit && out.length >= opts.limit) break
    }
    return out
  }

  /** {script_id: newest metadata} from the most recent runs. */
  lastRunByScript(scanLimit = 400): Record<string, RunMeta> {
    const latest: Record<string, RunMeta> = {}
    for (const meta of this.listRuns({ limit: scanLimit })) {
      const k = String(meta.script_id)
      if (!(k in latest)) latest[k] = meta
    }
    return latest
  }

  /**
   * Mark runs left queued/running by an application that is no longer alive as interrupted.
   * `isTracked(runId)` says whether this process still handles the run.
   */
  recoverInterrupted(opts: { selfPid?: number; alive?: (pid: unknown) => boolean; isTracked?: (runId: string) => boolean } = {}): string[] {
    const me = opts.selfPid ?? process.pid
    const alive = opts.alive ?? pidAlive
    const fixed: string[] = []
    for (const meta of this.listRuns({ statuses: ACTIVE_STATUSES })) {
      const runId = meta.id as string
      if (opts.isTracked?.(runId)) continue
      const owner = meta.owner_pid
      if (owner === me || alive(owner)) continue // owned by a live application instance
      let note = 'The application stopped before this run finished.'
      const pid = meta.pid
      if (meta.status === RUNNING && meta.host === 'local' && alive(pid))
        note += ` The script process (PID ${pid}) may still be running.`
      this.updateMeta(runId, { status: INTERRUPTED, finished_at: nowIso(), error: note })
      fixed.push(runId)
    }
    return fixed
  }
}

// ---------------------------------------------------------------- queries ---
export interface QueryOptions {
  q?: string
  scriptId?: string
  status?: string
  /** 'YYYY-MM-DD' (local); see parseDate */
  dateFrom?: string | null
  dateTo?: string | null
  page?: number
  perPage?: number
}

export interface RetentionConfig {
  history_retention_days: number
  log_retention_days: number
}

export interface HistoryOpsHooks {
  /** Retention config; defaults must come from the caller (ConfigStore.load). */
  config: () => RetentionConfig
  /** Sequence-run records follow the same history retention; returns how many were removed. */
  sequenceRunsOlderThan?: (days: number, now?: Date) => number
}

function referenceTime(meta: RunMeta): Date | null {
  for (const k of ['finished_at', 'started_at', 'queued_at']) {
    const t = parseIso(meta[k])
    if (t) return t
  }
  return null
}

function haystack(meta: RunMeta): string {
  const parts = [
    meta.id ?? '', meta.script_name ?? '', meta.host ?? '', meta.status ?? '', STATUS_LABELS[meta.status] ?? '',
    meta.command || '', meta.error || '', meta.initiator || '', meta.adhoc ? 'ad-hoc adhoc' : '',
    JSON.stringify(meta.parameters || {}),
  ]
  return parts.map(String).join(' ').toLowerCase()
}

export const isActive = (meta: RunMeta): boolean => ACTIVE_STATUSES.includes(meta.status)

export class HistoryOps {
  private lastRetention = 0

  constructor(readonly history: History, private hooks: HistoryOpsHooks) {}

  /** (runs on the page, total matches), newest first. */
  queryRuns(o: QueryOptions = {}): [RunMeta[], number] {
    const q = (o.q ?? '').trim().toLowerCase()
    const scriptId = o.scriptId ? this.history.canonicalId(o.scriptId) : ''
    const matches: RunMeta[] = []
    for (const runId of this.history.listRunIds()) {
      const meta = this.history.readMeta(runId)
      if (!meta) continue
      if (meta.id === undefined) meta.id = runId
      this.history.canonicalScript(meta)
      if (scriptId && meta.script_id !== scriptId) continue
      if (o.status && meta.status !== o.status) continue
      if (o.dateFrom || o.dateTo) {
        const when = referenceTime(meta)
        if (!when) continue
        const day = localDate(when)
        if (o.dateFrom && day < o.dateFrom) continue
        if (o.dateTo && day > o.dateTo) continue
      }
      if (q && !haystack(meta).includes(q)) continue
      matches.push(meta)
    }
    const page = Math.max(1, o.page ?? 1)
    const perPage = o.perPage ?? 20
    const start = (page - 1) * perPage
    return [matches.slice(start, start + perPage), matches.length]
  }

  /** [script id, script name] for runs present in history (names as recorded), by name. */
  scriptChoices(): Array<[string, string]> {
    const seen = new Map<string, string>()
    for (const runId of this.history.listRunIds()) {
      const meta = this.history.readMeta(runId)
      if (meta) this.history.canonicalScript(meta)
      if (meta && meta.script_id && !seen.has(meta.script_id)) seen.set(meta.script_id, meta.script_name || meta.script_id)
    }
    return [...seen.entries()].sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase()))
  }

  /** Delete one finished run. Queued and running runs are refused. */
  deleteRun(runId: string): boolean {
    if (!validRunId(runId)) return false
    const meta = this.history.readMeta(runId)
    if (!meta || isActive(meta)) return false
    fs.rmSync(this.history.runDir(runId), { recursive: true, force: true })
    return true
  }

  /** Delete finished runs older than `days` days. Returns how many. */
  deleteOlderThan(days: number, now: Date = new Date()): number {
    if (days < 0) return 0
    const cutoff = now.getTime() - days * 86400_000
    let removed = 0
    for (const runId of this.history.listRunIds()) {
      const meta = this.history.readMeta(runId)
      if (!meta || isActive(meta)) continue
      const when = referenceTime(meta)
      if (when && when.getTime() < cutoff) {
        fs.rmSync(this.history.runDir(runId), { recursive: true, force: true })
        removed++
      }
    }
    return removed
  }

  /** Remove stdout/stderr of finished runs older than `days` days but keep the record. */
  deleteLogsOlderThan(days: number, now: Date = new Date()): number {
    const cutoff = now.getTime() - days * 86400_000
    let cleaned = 0
    for (const runId of this.history.listRunIds()) {
      const meta = this.history.readMeta(runId)
      if (!meta || isActive(meta) || meta.logs_deleted) continue
      const when = referenceTime(meta)
      if (!when || when.getTime() >= cutoff) continue
      for (const stream of ['stdout', 'stderr']) {
        try {
          fs.unlinkSync(this.history.logPath(runId, stream))
        } catch (e: any) {
          if (e?.code === 'ENOENT') continue
          continue
        }
      }
      this.history.updateMeta(runId, { logs_deleted: true })
      cleaned++
    }
    return cleaned
  }

  /** Apply the configured retention: whole runs first, then logs, then sequence-run records. */
  applyRetention(cfg: RetentionConfig = this.hooks.config(), now: Date = new Date()) {
    const runs = this.deleteOlderThan(cfg.history_retention_days, now)
    const logs = this.deleteLogsOlderThan(cfg.log_retention_days, now)
    const sequences = this.hooks.sequenceRunsOlderThan?.(cfg.history_retention_days, now) ?? 0
    return { runs_removed: runs, logs_removed: logs, sequences_removed: sequences }
  }

  /** Rate-limited automatic sweep (startup and when History is opened); never throws. */
  maybeApplyRetention(nowMs: number = Date.now()): boolean {
    if (this.lastRetention && nowMs - this.lastRetention < RETENTION_INTERVAL * 1000) return false
    this.lastRetention = nowMs
    try {
      this.applyRetention()
    } catch {
      /* housekeeping must never break a page */
    }
    return true
  }
}
