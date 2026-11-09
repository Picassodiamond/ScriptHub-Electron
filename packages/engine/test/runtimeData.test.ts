import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../src/config.js'
import { History, HistoryOps } from '../src/history.js'
import { KEYS, RuntimeData, RuntimeDataError, human } from '../src/runtimeData.js'
import { tmpDirs } from './helpers.js'

function setup(opts: { seq?: { active?: boolean } } = {}) {
  const dirs = tmpDirs()
  const put = (p: string, text: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text)
  }
  put(dirs.configFile, JSON.stringify({ default_timeout: 77 }))
  const history = new History(dirs)
  const historyOps = new HistoryOps(history, { config: () => ({ history_retention_days: 90, log_retention_days: 30 }) })
  const run = (id: string, status: string) => {
    put(path.join(dirs.executions, id, 'metadata.json'), JSON.stringify({ id, status, script_id: 'x' }))
    put(path.join(dirs.executions, id, 'stdout.log'), 'out\n')
  }
  run('RUN-20260101-001', 'success')
  run('RUN-20260101-002', 'running')
  put(path.join(dirs.presets, 'abc123abc123', 'nightly.yaml'), 'name: Nightly\n')
  put(path.join(dirs.backups, 'abc123abc123', 'old.py'), 'print(1)\n')
  put(path.join(dirs.sequences, 'release.yaml'), 'name: Release\n')
  put(dirs.workspaceFile, '{"folder": "x"}')
  const seqRuns = new Map([['SEQ-20260101-001', 'success']])
  const onWorkspaceCleared = vi.fn()
  const data = new RuntimeData({
    dirs, history, historyOps, mode: 'env', onWorkspaceCleared,
    sequenceRuns: {
      list: () => [...seqRuns.keys()].map((id) => ({ id })),
      delete: (id) => seqRuns.delete(id),
      active: () => opts.seq?.active,
    },
  })
  put(path.join(dirs.sequenceRuns, 'SEQ-20260101-001', 'metadata.json'), '{}')
  const row = (key: string) => data.overview().find((r) => r.key === key)!
  return { dirs, data, row, history, onWorkspaceCleared, seqRuns }
}

describe('runtime data (port of ClearTests)', () => {
  it('counts files per kind', () => {
    const { row } = setup()
    expect(row('history').files).toBe(5) // 2 runs x (metadata + log) + 1 sequence-run record
    expect(row('presets').files).toBe(1)
    expect(row('sequences').files).toBe(1)
    expect(row('imports').files).toBe(0)
    expect(row('workspace').files).toBe(1)
    expect(row('settings').files).toBe(1)
    expect(setup().data.overview().map((r) => r.key)).toEqual([...KEYS])
  })

  it('history keeps active runs', () => {
    const { data, history, seqRuns } = setup()
    const msg = data.clear('history')
    expect(msg).toContain('Removed 2 runs') // one script run and one sequence run
    expect(history.listRunIds()).toEqual(['RUN-20260101-002'])
    expect(seqRuns.size).toBe(0)
  })

  it('reports runs that stay', () => {
    const { data, dirs } = setup()
    fs.rmSync(path.join(dirs.executions, 'RUN-20260101-001', 'metadata.json'))
    // run 1 is unreadable and run 2 is running: both stay; only the sequence run goes
    expect(data.clear('history')).toBe('Removed 1 run; 2 still running or unreadable.')
  })

  it('clears each kind, and settings go back to the defaults', () => {
    const { data, row, dirs, onWorkspaceCleared } = setup()
    for (const key of ['presets', 'backups', 'sequences']) {
      data.clear(key)
      expect(row(key).files, key).toBe(0)
    }
    const store = new ConfigStore(dirs)
    expect(store.load().default_timeout).toBe(77)
    expect(data.clear('settings')).toBe('Settings: cleared.')
    expect(store.load().default_timeout).toBe(3600)
    expect(fs.existsSync(dirs.workspaceFile)).toBe(true)
    data.clear('workspace')
    expect(fs.existsSync(dirs.workspaceFile)).toBe(false)
    expect(onWorkspaceCleared).toHaveBeenCalledOnce()
  })

  it('refuses an unknown kind and clearing sequences while one runs', () => {
    expect(() => setup().data.clear('secret_key')).toThrow(RuntimeDataError)
    const { data, row } = setup({ seq: { active: true } })
    expect(() => data.clear('sequences')).toThrow(/A sequence is running/)
    expect(row('sequences').files).toBe(1)
  })

  it('says where the data lives and formats sizes', () => {
    const { data, dirs } = setup()
    expect(data.location()).toEqual({ path: dirs.runtime, how: 'set by SCRIPTHUB_HOME' })
    expect([human(10), human(2048), human(5 * 1024 * 1024), human(3 * 1024 ** 3)]).toEqual(['10 bytes', '2.0 KB', '5.0 MB', '3.0 GB'])
  })
})
