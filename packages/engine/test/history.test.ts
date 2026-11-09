import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  History, HistoryOps, formatDuration, localDate, nowIso, parseDate, parseIso, readChunk, durationSeconds, validRunId,
} from '../src/history.js'
import { Ids } from '../src/ids.js'
import { tmpDirs } from './helpers.js'

const daysAgo = (n: number, hours = 0) => nowIso(new Date(Date.now() - (n * 24 + hours) * 3600_000))

function setup() {
  const dirs = tmpDirs()
  const ids = new Ids(dirs)
  const history = new History(dirs, ids)
  const ops = new HistoryOps(history, { config: () => ({ history_retention_days: 30, log_retention_days: 7 }) })
  const makeRun = (runId: string, o: { status?: string; scriptId?: string; name?: string; ageDays?: number; params?: any; error?: string | null; host?: string; logs?: boolean } = {}) => {
    const { status = 'success', scriptId = 'aaaaaaaaaaaa', name = 'Backup', ageDays = 0, params = {}, error = null, host = 'local', logs = true } = o
    fs.mkdirSync(history.runDir(runId), { recursive: true })
    const when = daysAgo(ageDays)
    const active = status === 'queued' || status === 'running'
    history.writeMeta(runId, {
      id: runId, script_id: scriptId, script_name: name, host, status, queued_at: when, started_at: when,
      finished_at: active ? null : when, exit_code: status === 'success' ? 0 : null, parameters: params, error, command: `python ${name}.py`,
    })
    if (logs) {
      fs.writeFileSync(history.logPath(runId, 'stdout'), 'out\n')
      fs.writeFileSync(history.logPath(runId, 'stderr'), 'err\n')
    }
  }
  return { dirs, ids, history, ops, makeRun }
}

describe('history records', () => {
  it('validates run ids and keeps traversal out', () => {
    expect(validRunId('RUN-20260101-001')).toBe(true)
    expect(validRunId('RUN-20260101-1234')).toBe(true)
    for (const bad of ['../../etc', 'RUN-1-1', '', null, 'RUN-20260101-01']) expect(validRunId(bad)).toBe(false)
    const { history } = setup()
    expect(() => history.runDir('../x')).toThrow()
    expect(() => history.logPath('RUN-20260101-001', 'other')).toThrow()
  })

  it('allocates consecutive run folders per day', () => {
    const { history } = setup()
    const d = new Date(2026, 10, 9, 10, 0, 0)
    const a = history.allocateRunDir(d)
    const b = history.allocateRunDir(d)
    expect([a.runId, b.runId]).toEqual(['RUN-20261109-001', 'RUN-20261109-002'])
    expect(fs.statSync(a.dir).isDirectory()).toBe(true)
    expect(history.listRunIds()).toEqual(['RUN-20261109-002', 'RUN-20261109-001'])
    expect(history.listRunIds(false)).toEqual(['RUN-20261109-001', 'RUN-20261109-002'])
  })

  it('reads, writes and updates metadata; unreadable metadata is null', () => {
    const { history, makeRun } = setup()
    makeRun('RUN-20260101-001')
    expect(history.readMeta('RUN-20260101-001')!.script_name).toBe('Backup')
    history.updateMeta('RUN-20260101-001', { status: 'failed' })
    expect(history.readMeta('RUN-20260101-001')).toMatchObject({ status: 'failed', script_name: 'Backup' })
    fs.mkdirSync(history.runDir('RUN-20260101-002'))
    fs.writeFileSync(history.metaPath('RUN-20260101-002'), '{ broken')
    expect(history.readMeta('RUN-20260101-002')).toBeNull()
    expect(history.readMeta('RUN-20260101-009')).toBeNull()
  })

  it('lists runs newest first, filtered by status and by any id of a script', () => {
    const { history, ids, makeRun } = setup()
    const old = '111111111111'
    const stable = '222222222222'
    makeRun('RUN-20260101-001', { scriptId: old })
    makeRun('RUN-20260101-002', { scriptId: stable, status: 'failed' })
    makeRun('RUN-20260101-003', { scriptId: 'cccccccccccc', status: 'running' })
    ids.addAlias(old, stable)
    expect(history.listRuns().map((m) => m.id)).toEqual(['RUN-20260101-003', 'RUN-20260101-002', 'RUN-20260101-001'])
    expect(history.listRuns({ scriptId: old }).map((m) => m.id)).toEqual(['RUN-20260101-002', 'RUN-20260101-001'])
    expect(history.listRuns({ statuses: ['running', 'queued'] }).map((m) => m.id)).toEqual(['RUN-20260101-003'])
    expect(history.listRuns({ limit: 1 })).toHaveLength(1)
    expect(history.listRuns({ scriptId: stable })[0].script_id).toBe(stable)
    expect(Object.keys(history.lastRunByScript()).sort()).toEqual([stable, 'cccccccccccc'])
    expect(history.lastRunByScript()[stable].id).toBe('RUN-20260101-002')
  })

  it('formats durations and parses dates like Python', () => {
    expect(formatDuration(null)).toBe('—')
    expect([formatDuration(5), formatDuration(65), formatDuration(3725)]).toEqual(['5s', '1m 05s', '1h 02m 05s'])
    expect(durationSeconds({ started_at: '2026-01-01T10:00:00', finished_at: '2026-01-01T10:01:05' })).toBe(65)
    expect(durationSeconds({ started_at: '2026-01-01T10:00:00', status: 'success' })).toBeNull()
    expect(durationSeconds({ started_at: '2026-01-01T10:00:00', status: 'running' }, new Date(2026, 0, 1, 10, 0, 7))).toBe(7)
    expect(parseIso('garbage')).toBeNull()
    expect(localDate(parseIso('2026-03-04')!)).toBe('2026-03-04') // a bare date is local, not UTC
    expect(parseDate(' 2026-02-30 ')).toBeNull()
    expect(parseDate('2026-02-28')).toBe('2026-02-28')
    expect(nowIso(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02T03:04:05')
  })

  it('reads a log chunk without splitting a UTF-8 character', () => {
    const { dirs } = setup()
    const f = path.join(dirs.runtime, 'log.txt')
    fs.writeFileSync(f, Buffer.from('ab€cd', 'utf8')) // € is 3 bytes
    const [t1, o1] = readChunk(f, 0, 4) // 'ab' + 2 of the 3 euro bytes
    expect([t1, o1]).toEqual(['ab', 2])
    const [t2, o2] = readChunk(f, o1, 100)
    expect([t2, o2]).toEqual(['€cd', 7])
    expect(readChunk(f, 99)).toEqual(['', 99])
    expect(readChunk(path.join(dirs.runtime, 'missing.log'), 3)).toEqual(['', 3])
  })

  it('marks runs of a dead owner interrupted and leaves live ones alone', () => {
    const { history, makeRun } = setup()
    makeRun('RUN-20260101-001', { status: 'running' })
    makeRun('RUN-20260101-002', { status: 'queued' })
    makeRun('RUN-20260101-003', { status: 'running' })
    makeRun('RUN-20260101-004', { status: 'success' })
    history.updateMeta('RUN-20260101-001', { owner_pid: 4_194_304 + 12345, pid: 777, host: 'local' })
    history.updateMeta('RUN-20260101-002', { owner_pid: 4_194_304 + 12345 })
    history.updateMeta('RUN-20260101-003', { owner_pid: 4242 }) // alive
    const fixed = history.recoverInterrupted({ selfPid: 1, alive: (p) => p === 4242 || p === 777 })
    expect(fixed.sort()).toEqual(['RUN-20260101-001', 'RUN-20260101-002'])
    const m = history.readMeta('RUN-20260101-001')!
    expect(m.status).toBe('interrupted')
    expect(m.error).toContain('may still be running')
    expect(history.readMeta('RUN-20260101-002')!.error).toBe('The application stopped before this run finished.')
    expect(history.readMeta('RUN-20260101-003')!.status).toBe('running')
    expect(history.readMeta('RUN-20260101-004')!.status).toBe('success')
    // tracked by this process: untouched
    makeRun('RUN-20260101-005', { status: 'running' })
    history.updateMeta('RUN-20260101-005', { owner_pid: 4_194_304 + 999 })
    expect(history.recoverInterrupted({ selfPid: 1, alive: (p) => p === 4242, isTracked: (r) => r === 'RUN-20260101-005' })).toEqual([])
  })
})

describe('history queries (port of HistoryQueryTests)', () => {
  const make = () => {
    const s = setup()
    s.makeRun('RUN-20260101-001', { status: 'success', name: 'Backup', params: { database: 'prod' } })
    s.makeRun('RUN-20260101-002', { status: 'failed', name: 'Cleanup', scriptId: 'bbbbbbbbbbbb', error: 'disk full' })
    s.makeRun('RUN-20260101-003', { status: 'success', name: 'Backup', ageDays: 10, params: { database: 'dev' } })
    s.makeRun('RUN-20260101-004', { status: 'running', name: 'Backup' })
    const ids = (o = {}) => {
      const [runs, total] = s.ops.queryRuns(o)
      expect(runs.length).toBe(total)
      return runs.map((r) => r.id)
    }
    return { ...s, ids }
  }
  const day = (n: number) => localDate(new Date(Date.now() - n * 86400_000))

  it('newest first with no filter', () => {
    expect(make().ids()).toEqual(['RUN-20260101-004', 'RUN-20260101-003', 'RUN-20260101-002', 'RUN-20260101-001'])
  })

  it('filters by script and status', () => {
    const { ids } = make()
    expect(ids({ scriptId: 'bbbbbbbbbbbb' })).toEqual(['RUN-20260101-002'])
    expect(ids({ status: 'success' })).toEqual(['RUN-20260101-003', 'RUN-20260101-001'])
    expect(ids({ scriptId: 'aaaaaaaaaaaa', status: 'failed' })).toEqual([])
  })

  it('searches parameters, errors and names', () => {
    const { ids } = make()
    expect(ids({ q: 'prod' })).toEqual(['RUN-20260101-001'])
    expect(ids({ q: 'DISK FULL' })).toEqual(['RUN-20260101-002'])
    expect(ids({ q: 'cleanup' })).toEqual(['RUN-20260101-002'])
    expect(ids({ q: 'running' })).toEqual(['RUN-20260101-004'])
    expect(ids({ q: 'nothing-matches' })).toEqual([])
  })

  it('filters by date range', () => {
    const { ids } = make()
    expect(ids({ dateFrom: day(2) })).toEqual(['RUN-20260101-004', 'RUN-20260101-002', 'RUN-20260101-001'])
    expect(ids({ dateTo: day(5) })).toEqual(['RUN-20260101-003'])
    expect(ids({ dateFrom: day(12), dateTo: day(8) })).toEqual(['RUN-20260101-003'])
  })

  it('pages', () => {
    const { ops } = make()
    const [p1, total] = ops.queryRuns({ page: 1, perPage: 3 })
    const [p2] = ops.queryRuns({ page: 2, perPage: 3 })
    expect([p1.length, p2.length, total]).toEqual([3, 1, 4])
  })

  it('lists scripts present in history by name', () => {
    expect(make().ops.scriptChoices()).toEqual([['aaaaaaaaaaaa', 'Backup'], ['bbbbbbbbbbbb', 'Cleanup']])
  })
})

describe('delete and retention (port of DeleteAndRetentionTests)', () => {
  it('refuses to delete active runs and bad ids', () => {
    const { history, ops, makeRun } = setup()
    makeRun('RUN-20260101-001', { status: 'running' })
    makeRun('RUN-20260101-002', { status: 'queued' })
    makeRun('RUN-20260101-003', { status: 'success' })
    expect(ops.deleteRun('RUN-20260101-001')).toBe(false)
    expect(ops.deleteRun('RUN-20260101-002')).toBe(false)
    expect(ops.deleteRun('RUN-20260101-003')).toBe(true)
    expect(fs.existsSync(history.runDir('RUN-20260101-001'))).toBe(true)
    expect(fs.existsSync(history.runDir('RUN-20260101-003'))).toBe(false)
    expect(ops.deleteRun('../../etc')).toBe(false)
  })

  it('deleteOlderThan never removes active runs', () => {
    const { history, ops, makeRun } = setup()
    makeRun('RUN-20260101-001', { ageDays: 40 })
    makeRun('RUN-20260101-002', { ageDays: 5 })
    makeRun('RUN-20260101-003', { status: 'running', ageDays: 90 })
    expect(ops.deleteOlderThan(30)).toBe(1)
    expect(history.listRunIds().sort()).toEqual(['RUN-20260101-002', 'RUN-20260101-003'])
    expect(ops.deleteOlderThan(-1)).toBe(0)
  })

  it('retention removes logs first, then whole runs; idempotent', () => {
    const { history, ops, makeRun } = setup()
    makeRun('RUN-20260101-001', { ageDays: 40 }) // beyond history retention (30): gone
    makeRun('RUN-20260101-002', { ageDays: 10 }) // beyond log retention (7): logs gone, record stays
    makeRun('RUN-20260101-003', { ageDays: 1 }) // recent: untouched
    expect(ops.applyRetention()).toEqual({ runs_removed: 1, logs_removed: 1, sequences_removed: 0 })
    expect(fs.existsSync(history.runDir('RUN-20260101-001'))).toBe(false)
    expect(history.readMeta('RUN-20260101-002')!.logs_deleted).toBe(true)
    expect(fs.existsSync(history.logPath('RUN-20260101-002', 'stdout'))).toBe(false)
    expect(fs.existsSync(history.logPath('RUN-20260101-003', 'stdout'))).toBe(true)
    expect(ops.applyRetention()).toEqual({ runs_removed: 0, logs_removed: 0, sequences_removed: 0 })
  })

  it('includes sequence-run retention through the hook and rate-limits the automatic sweep', () => {
    const { history } = setup()
    const calls: number[] = []
    const ops = new HistoryOps(history, {
      config: () => ({ history_retention_days: 30, log_retention_days: 7 }),
      sequenceRunsOlderThan: (days) => (calls.push(days), 2),
    })
    expect(ops.applyRetention().sequences_removed).toBe(2)
    expect(ops.maybeApplyRetention(1_000_000)).toBe(true)
    expect(ops.maybeApplyRetention(1_000_000 + 60_000)).toBe(false)
    expect(ops.maybeApplyRetention(1_000_000 + 3_600_001)).toBe(true)
    expect(calls).toEqual([30, 30, 30])
  })
})
