import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PresetError, Presets, RECENT_MAX, type ParamDef, type ParamOps, type ScriptRef } from '../src/presets.js'
import { tmpDir, tmpDirs } from './helpers.js'

// A minimal stand-in for the parameter service (parameters.ts is ported separately).
const ops: ParamOps = {
  defaultsRaw(params) {
    const out: Record<string, any> = {}
    for (const p of params) out[p.name] = p.type === 'boolean' ? Boolean(p.default) : p.default == null ? '' : String(p.default)
    return out
  },
  parseValue(p, v) {
    if (p.type === 'number') {
      const n = Number(v)
      if (!Number.isFinite(n)) return [null, 'Enter a number.']
      if (p.min != null && n < p.min) return [null, `Must be at least ${p.min}.`]
      if (p.max != null && n > p.max) return [null, `Must be at most ${p.max}.`]
      return [n, null]
    }
    if (p.type === 'select' && !p.choices.includes(String(v))) return [null, 'Pick one of the choices.']
    return [v, null]
  },
}

const SID = '0123456789ab'
const RAW = { db: 'prod', days: '7', mode: 'full', zip: false, secret: 'hunter2', fixed: 'hacked' }

function params(extra: ParamDef[] = []): ParamDef[] {
  return [
    { name: 'db', label: 'Database', type: 'text', default: 'mydb', required: true },
    { name: 'days', label: 'Days', type: 'number', default: 30, min: 1, max: 365 },
    { name: 'mode', label: 'Mode', type: 'select', choices: ['fast', 'full'], default: 'fast' },
    { name: 'zip', label: 'Zip', type: 'boolean', default: true },
    { name: 'secret', label: 'Secret', type: 'password' },
    { name: 'fixed', label: 'Fixed', type: 'text', default: 'F', editable_at_runtime: false },
    ...extra,
  ]
}

function setup() {
  const dirs = tmpDirs()
  const scripts = tmpDir('sh-scripts-')
  const scriptFile = path.join(scripts, 'tool.py')
  fs.writeFileSync(scriptFile, 'print(1)\n')
  const s: ScriptRef = { id: SID, path: scriptFile, meta: {} }
  const presets = new Presets(dirs, ops)
  const dir = path.join(dirs.presets, SID)
  return { dirs, scripts, s, presets, dir, oldFile: path.join(scripts, 'tool.params.json') }
}

describe('presets (port of PresetStorageTests)', () => {
  it('saves and loads one YAML file without passwords or fixed values', () => {
    const { presets, s, dir, scripts } = setup()
    const p = params()
    const slug = presets.savePreset(s, 'Production Backup', p, RAW, 'prod-1')
    expect(slug).toBe('production-backup')
    const text = fs.readFileSync(path.join(dir, 'production-backup.yaml'), 'utf8')
    expect(text.startsWith('# Preset for ')).toBe(true)
    expect(text).toContain('name: Production Backup\n')
    expect(text).toContain('\nvalues:\n  db: prod\n')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('hacked')
    expect(fs.readdirSync(scripts)).toEqual(['tool.py']) // nothing next to the script
    const data = presets.getPreset(s, slug)!
    expect(data.host).toBe('prod-1')
    const [raw, warnings] = presets.applyPreset(p, data)
    expect([raw.db, raw.days, raw.mode, raw.zip]).toEqual(['prod', '7', 'full', false])
    expect(raw.fixed).toBe('F') // locked values never come from a preset
    expect(warnings).toEqual([])
  })

  it('lists, renames, deletes and enforces name rules', () => {
    const { presets, s } = setup()
    const p = params()
    presets.savePreset(s, 'Weekly', p, RAW, 'local')
    presets.savePreset(s, 'Daily', p, RAW, 'local')
    const names = () => presets.listPresets(s).map((x) => x.name)
    expect(names()).toEqual(['Daily', 'Weekly'])
    presets.renamePreset(s, 'weekly', 'Weekly Full')
    expect(names()).toEqual(['Daily', 'Weekly Full'])
    expect(() => presets.renamePreset(s, 'daily', 'weekly full')).toThrow(PresetError) // duplicate, case-insensitive
    expect(() => presets.savePreset(s, '   ', p, RAW, 'local')).toThrow(PresetError)
    expect(() => presets.savePreset(s, 'x'.repeat(61), p, RAW, 'local')).toThrow(PresetError)
    expect(() => presets.savePreset(s, 'Daily', p, RAW, 'local', false)).toThrow(/already exists/)
    expect(presets.deletePreset(s, 'daily')).toBe(true)
    expect(presets.deletePreset(s, 'daily')).toBe(false)
    expect(names()).toEqual(['Weekly Full'])
  })

  it('same name updates; different names get unique slugs', () => {
    const { presets, s } = setup()
    const p = params()
    const a = presets.savePreset(s, 'Nightly!', p, RAW, 'local')
    const b = presets.savePreset(s, 'Nightly?', p, RAW, 'local')
    expect(a).not.toBe(b)
    expect(presets.savePreset(s, 'nightly!', p, { ...RAW, db: 'other' }, 'local')).toBe(a)
    expect(presets.getPreset(s, a)!.values.db).toBe('other')
    expect(presets.listPresets(s)).toHaveLength(2)
  })

  it('refuses bad ids and slugs', () => {
    const { presets, s, dirs, scripts, dir, } = setup()
    const p = params()
    for (const id of ['../x', '..', 'a/b', '']) {
      const bad: ScriptRef = { id, path: s.path }
      expect(() => presets.savePreset(bad, 'n', p, RAW, 'local')).toThrow(PresetError)
      expect(presets.listPresets(bad)).toEqual([])
    }
    expect(presets.getPreset(s, '../../config')).toBeNull()
    expect(() => presets.deletePreset(s, '../evil')).toThrow(PresetError)
    expect(presets.savePreset(s, '../../evil name', p, RAW, 'local')).toBe('evil-name')
    expect(fs.readdirSync(scripts).sort()).toEqual(['tool.py'])
    expect(fs.readdirSync(dir).sort()).toEqual(['evil-name.yaml'])
    expect(fs.readdirSync(dirs.presets)).toEqual([SID])
  })

  it('handles removed, renamed and changed parameters with warnings', () => {
    const { presets, s } = setup()
    const slug = presets.savePreset(s, 'Old', params(), RAW, 'local')
    const data = presets.getPreset(s, slug)!
    const next: ParamDef[] = [
      { name: 'days', label: 'Days', type: 'number', default: 3, min: 1, max: 5 },
      { name: 'mode', label: 'Mode', type: 'select', choices: ['quick', 'deep'], default: 'quick' },
      { name: 'zip', label: 'Zip', type: 'boolean', default: true },
      { name: 'region', label: 'Region', type: 'text', default: 'eu' },
    ]
    const [raw, warnings] = presets.applyPreset(next, data)
    const text = warnings.join(' ')
    expect(text).toContain("'db' no longer exists")
    expect(text).toContain("'Days'") // 7 > new max 5
    expect(text).toContain("'Mode'") // 'full' is not a choice any more
    expect(text).toContain("'Region' is new")
    expect([raw.days, raw.mode, raw.region, raw.zip]).toEqual(['3', 'quick', 'eu', false])
  })

  it('skips a broken file and never overwrites it', () => {
    const { presets, s, dir } = setup()
    const p = params()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'good.yaml'), 'values: [1, 2')
    expect(presets.listPresets(s)).toEqual([])
    expect(presets.savePreset(s, 'Good', p, RAW, 'local')).toBe('good-2') // its own file
    expect(fs.readFileSync(path.join(dir, 'good.yaml'), 'utf8')).toBe('values: [1, 2')
    presets.recordRun(s, p, RAW, 'local', 'RUN-20260101-001')
    expect(presets.listPresets(s).map((x) => x.name)).toEqual(['Good'])
    expect(presets.recentRuns(s)).toHaveLength(1)
    // renaming an unreadable file is refused too
    expect(() => presets.renamePreset(s, 'good', 'Other')).toThrow(/could not be read/)
  })

  it('remembers recent runs newest first, de-duplicated, at most ten', () => {
    const { presets, s, dir } = setup()
    const p = params()
    presets.recordRun(s, p, RAW, 'local', 'RUN-20260101-001')
    presets.recordRun(s, p, { ...RAW, db: 'b' }, 'local', 'RUN-20260101-002')
    presets.recordRun(s, p, RAW, 'local', 'RUN-20260101-003') // same values as the first
    const runs = presets.recentRuns(s)
    expect(runs.map((r) => r.run_id)).toEqual(['RUN-20260101-003', 'RUN-20260101-002'])
    expect([runs[0].key, runs[0].label]).toEqual(['@0', 'Last run'])
    const files = fs.readdirSync(path.join(dir, 'recent')).sort()
    expect(files).toEqual(['RUN-20260101-002.yaml', 'RUN-20260101-003.yaml'])
    expect(files.map((f) => fs.readFileSync(path.join(dir, 'recent', f), 'utf8')).join('')).not.toContain('hunter2')
    for (let i = 0; i < 15; i++) presets.recordRun(s, p, { ...RAW, days: String(i + 1) }, 'local', `RUN-20260102-${String(i).padStart(3, '0')}`)
    expect(presets.recentRuns(s)).toHaveLength(RECENT_MAX)
    expect(fs.readdirSync(path.join(dir, 'recent'))).toHaveLength(RECENT_MAX) // older files removed
    const [raw] = presets.applyPreset(p, presets.getRecent(s, 0)!)
    expect(raw.days).toBe('15')
    expect(presets.getRecent(s, 99)).toBeNull()
  })

  it('compares presets and recent runs in a grid', () => {
    const { presets, s } = setup()
    const p = params()
    presets.savePreset(s, 'Prod', p, RAW, 'prod-1')
    presets.recordRun(s, p, { ...RAW, db: 'mydb' }, 'local', 'RUN-20260101-001')
    const g = presets.grid(s, p)
    expect(g.columns.map((c) => c.name)).toEqual(['Prod', 'Last run'])
    const rows = Object.fromEntries(g.rows.map((r) => [r.name, r]))
    expect(rows.db.cells.map((c: any) => c.text)).toEqual(['prod', 'mydb'])
    expect(rows.db.varies).toBe(true)
    expect(rows.db.cells.map((c: any) => c.changed)).toEqual([true, false]) // mydb is the default
    expect(rows.secret.cells[0].text).toBe('not saved')
    expect(rows.fixed.cells[0].text).toBe('fixed')
    expect(rows.host.varies).toBe(true)
  })

  it('migrates older layouts to YAML files and removes the old ones', () => {
    const { presets, s, dir, dirs, oldFile } = setup()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'weekly.json'),
      JSON.stringify({ name: 'Weekly', script_id: SID, host: 'local', values: { db: 'w' }, saved_at: '2026-01-01T00:00:00' }))
    fs.writeFileSync(oldFile, JSON.stringify({
      presets: { daily: { name: 'Daily', host: 'local', values: { db: 'd' } } },
      recent: [{ host: 'local', values: { db: 'r' }, saved_at: '2026-01-02T00:00:00', run_id: 'RUN-20260102-001' }],
    }))
    fs.writeFileSync(path.join(dirs.presets, `${SID}.json`), JSON.stringify({ presets: { ro: { name: 'Ro', values: { db: 'ro' } } }, recent: [] }))
    expect(presets.listPresets(s).map((x) => x.name)).toEqual(['Daily', 'Ro', 'Weekly'])
    expect(presets.getRecent(s, 0)!.values).toEqual({ db: 'r' })
    expect(fs.existsSync(oldFile)).toBe(false)
    expect(fs.existsSync(path.join(dirs.presets, `${SID}.json`))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'weekly.json'))).toBe(false)
    expect(fs.readdirSync(dir).sort()).toEqual(['daily.yaml', 'recent', 'ro.yaml', 'weekly.yaml'])
  })

  it('describes where the values live', () => {
    const { presets, s, dir } = setup()
    expect(presets.fileInfo(s)).toEqual({ path: dir, name: 'saved values' })
    expect(presets.fileInfo({ id: '', path: 'x' })).toEqual({})
  })
})
