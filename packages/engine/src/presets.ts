/**
 * Saved parameters: named presets and the values of recent runs. Port of runner/presets.py.
 *
 *   runtime/presets/<script id>/<preset slug>.yaml       a named preset
 *   runtime/presets/<script id>/recent/<run id>.yaml     the values of a recent run (last 10 distinct)
 *
 * Passwords and fixed (non-editable) parameters are never written. A file that cannot be read is
 * never overwritten. Parameter-definition logic (defaults, value parsing) belongs to parameters.ts and is
 * injected through ParamOps so this module does not depend on it.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DataDirs } from './paths.js'
import { atomicWriteText, readJson } from './fsutil.js'
import { nowIso, validRunId } from './history.js'
import * as yamlish from './yamlish.js'

export const NAME_MAX = 60
export const RECENT_MAX = 10
export const EXT = '.yaml'
export const LEGACY_SUFFIX = '.params.json'
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const SID_RE = /^[0-9a-f]{6,64}$/

export class PresetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PresetError'
  }
}

/** What presets need to know about a script. */
export interface ScriptRef {
  id: string
  path: string
  meta?: Record<string, any>
}

export type ParamDef = Record<string, any>

/** The parts of the parameter service that presets use. */
export interface ParamOps {
  /** Raw default value of every parameter, by name. */
  defaultsRaw(params: ParamDef[]): Record<string, any>
  /** [parsed value, null] or [null, error message]. */
  parseValue(param: ParamDef, raw: unknown): [unknown, string | null]
}

type PresetSet = Record<string, any>

// -------------------------------------------------------------- helpers ---
export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, 64).replace(/^-+|-+$/g, '') || 'preset'
}

export function cleanName(name: string): string {
  const n = (name || '').split(/\s+/).filter(Boolean).join(' ')
  if (!n) throw new PresetError('Enter a name for the preset.')
  if (n.length > NAME_MAX) throw new PresetError(`The name must be at most ${NAME_MAX} characters.`)
  if ([...n].some((c) => c.charCodeAt(0) < 32)) throw new PresetError('The name contains invalid characters.')
  return n
}

/** The comment at the top of a saved set; project files use the script's relative path. */
export function headerText(name: string, what = 'Preset'): string {
  return `${what} for ${name} (ScriptHub). Passwords are never stored.`
}

/** The part of a submitted form that may be stored (no passwords, no fixed values). */
export function savableValues(params: ParamDef[], raw: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const p of params) {
    if (p.type === 'password' || p.editable_at_runtime === false) continue
    if (p.name in raw) {
      const v = raw[p.name]
      out[p.name] = Array.isArray(v) ? [...v] : v
    }
  }
  return out
}

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)

function listDir(dir: string, suffix: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith(suffix)).sort().map((n) => path.join(dir, n))
  } catch {
    return []
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Key-sorted JSON, so equal values compare equal whatever their key order. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  return JSON.stringify(v === undefined ? null : v)
}

let lastOrder = 0
/** Strictly increasing sort key written to recent-run files (Python uses time_ns; this stays within 2^53). */
function nextOrder(): number {
  lastOrder = Math.max(lastOrder + 1, Date.now() * 1000)
  return lastOrder
}

const pick = (src: Record<string, any>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in src).map((k) => [k, src[k]]))

export class Presets {
  constructor(private dirs: DataDirs, private params?: ParamOps) {}

  private ops(): ParamOps {
    if (!this.params) throw new Error('Presets was created without ParamOps')
    return this.params
  }

  // ---------------------------------------------------------------- paths ---
  private check(script: ScriptRef | null | undefined): void {
    if (!script || !SID_RE.test(script.id || '')) throw new PresetError('Invalid script.')
  }

  private checkSlug(slug: string): void {
    if (!SLUG_RE.test(slug || '')) throw new PresetError('Invalid preset.')
  }

  /** runtime/presets/<script id>/ */
  folder(script: ScriptRef): string {
    return path.join(this.dirs.presets, script.id)
  }

  private presetFile(script: ScriptRef, slug: string): string {
    return path.join(this.folder(script), slug + EXT)
  }

  private recentDir(script: ScriptRef): string {
    return path.join(this.folder(script), 'recent')
  }

  /** Old location (before 2.1): <folder>/<stem>.params.json next to the script. */
  fileNextTo(script: ScriptRef): string {
    const p = path.parse(script.path)
    return path.join(p.dir, p.name + LEGACY_SUFFIX)
  }

  // ----------------------------------------------------------- read/write ---
  /** One saved set (with a `values` mapping); null when missing or unusable. `strict`: an unreadable file throws. */
  private readSet(file: string, strict = false): PresetSet | null {
    let data: Record<string, any>
    try {
      let text = fs.readFileSync(file, 'utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      data = yamlish.load(text)
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null
      if (strict) throw new PresetError(`${path.basename(file)} could not be read (${e?.message ?? e}); fix or delete it first.`)
      return null
    }
    if (!isObj('values' in data ? data.values : {})) {
      if (strict) throw new PresetError(`${path.basename(file)} is not a saved-values file; fix or delete it first.`)
      return null
    }
    if (!('values' in data)) data.values = {}
    return data
  }

  private writeSet(script: ScriptRef, file: string, data: PresetSet, what: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    atomicWriteText(file, yamlish.dump(data, headerText(script.path, what)))
  }

  // ------------------------------------------------------------ migration ---
  private readOld(file: string): { presets: Record<string, any>; recent: any[] } | null {
    let data: any
    try {
      data = readJson(file)
    } catch {
      return null
    }
    if (!isObj(data)) return null
    const presets: Record<string, any> = {}
    if (isObj(data.presets))
      for (const [s, p] of Object.entries<any>(data.presets))
        if (SLUG_RE.test(String(s)) && isObj(p) && typeof p.name === 'string' && isObj('values' in p ? p.values : {})) presets[s] = p
    const recent = Array.isArray(data.recent) ? data.recent.filter((r: any) => isObj(r) && isObj('values' in r ? r.values : {})) : []
    return { presets, recent }
  }

  /** Move saved values from the older layouts into the YAML files (then remove the old files). */
  private migrate(script: ScriptRef): void {
    const oldFiles = [this.fileNextTo(script), path.join(this.dirs.presets, `${script.id}.json`)]
    const v1 = isDirectory(this.folder(script)) ? listDir(this.folder(script), '.json') : []
    if (!oldFiles.some(isFile) && !v1.length) return
    const done: string[] = []
    for (const file of oldFiles) {
      const old = isFile(file) ? this.readOld(file) : null
      if (!old) continue
      for (const [slug, p] of Object.entries(old.presets)) {
        const target = this.presetFile(script, slug)
        if (!fs.existsSync(target)) this.writeSet(script, target, pick(p, ['name', 'host', 'saved_at', 'values']), 'Preset')
      }
      old.recent.slice(0, RECENT_MAX).forEach((r, i) => {
        const rid = validRunId(String(r.run_id ?? '')) ? r.run_id : `migrated-${String(i).padStart(2, '0')}`
        const target = path.join(this.recentDir(script), rid + EXT)
        if (!fs.existsSync(target))
          this.writeSet(script, target, pick(r, ['host', 'saved_at', 'run_id', 'initiator', 'values']), 'Values of a recent run')
      })
      done.push(file)
    }
    for (const f of v1) {
      // version 1: one JSON file per preset
      let p: any
      try {
        p = readJson(f)
      } catch {
        continue
      }
      const stem = path.parse(f).name
      if (isObj(p) && typeof p.name === 'string' && SLUG_RE.test(stem)) {
        if (!fs.existsSync(this.presetFile(script, stem)))
          this.writeSet(script, this.presetFile(script, stem), pick(p, ['name', 'host', 'saved_at', 'values']), 'Preset')
        done.push(f)
      }
    }
    for (const f of done) {
      try {
        fs.unlinkSync(f)
      } catch {
        /* ignore */
      }
    }
  }

  /** {presets: {slug: set}, recent: [set, ...] newest first}. Unreadable files are skipped. */
  private load(script: ScriptRef): { presets: Record<string, PresetSet>; recent: PresetSet[] } {
    this.check(script)
    try {
      this.migrate(script)
    } catch {
      /* best effort */
    }
    const presets: Record<string, PresetSet> = {}
    const recent: PresetSet[] = []
    for (const f of listDir(this.folder(script), EXT)) {
      const stem = path.basename(f, EXT)
      const p = this.readSet(f)
      if (SLUG_RE.test(stem) && p && typeof p.name === 'string') presets[stem] = p
    }
    for (const f of listDir(this.recentDir(script), EXT)) {
      const r = this.readSet(f)
      if (!r) continue
      r._file = f
      try {
        r._mtime = fs.statSync(f).mtimeMs
      } catch {
        r._mtime = 0
      }
      recent.push(r)
    }
    // newest first: saved_at has seconds only; "order" (written by recordRun) and then the file time break ties
    recent.sort((a, b) => {
      const sa = String(a.saved_at ?? '')
      const sb = String(b.saved_at ?? '')
      if (sa !== sb) return sa < sb ? 1 : -1
      const oa = Number.isInteger(a.order) ? a.order : 0
      const ob = Number.isInteger(b.order) ? b.order : 0
      if (oa !== ob) return ob - oa
      return b._mtime - a._mtime
    })
    return { presets, recent }
  }

  private pub(entry: PresetSet): PresetSet {
    return Object.fromEntries(Object.entries(entry).filter(([k]) => !k.startsWith('_')))
  }

  // -------------------------------------------------------------- presets ---
  /** [{slug, name, saved_at, host}] sorted by name. */
  listPresets(script: ScriptRef): Array<{ slug: string; name: string; saved_at: string; host: string }> {
    let data
    try {
      data = this.load(script)
    } catch (e) {
      if (e instanceof PresetError) return []
      throw e
    }
    return Object.entries(data.presets)
      .map(([slug, p]) => ({ slug, name: p.name as string, saved_at: p.saved_at ?? '', host: p.host ?? '' }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  getPreset(script: ScriptRef, slug: string): PresetSet | null {
    try {
      this.checkSlug(slug)
      const p = this.load(script).presets[slug]
      return p ? this.pub(p) : null
    } catch (e) {
      if (e instanceof PresetError) return null
      throw e
    }
  }

  /** Create or overwrite a preset (its own file); returns its slug. */
  savePreset(script: ScriptRef, name: string, params: ParamDef[], raw: Record<string, any>, host: string, overwrite = true): string {
    name = cleanName(name)
    const data = this.load(script)
    const existing = new Map(Object.entries(data.presets).map(([s, p]) => [String(p.name).toLowerCase(), s]))
    if (!overwrite && existing.has(name.toLowerCase())) throw new PresetError(`A preset named '${name}' already exists.`)
    let slug = existing.get(name.toLowerCase())
    if (slug === undefined) {
      // a new name: a free slug (also not taken by an unreadable file)
      const base = (slug = slugify(name))
      let n = 2
      while (slug in data.presets || fs.existsSync(this.presetFile(script, slug))) slug = `${base}-${n++}`
    }
    const target = this.presetFile(script, slug)
    if (fs.existsSync(target)) this.readSet(target, true) // never overwrite a file that cannot be read
    this.writeSet(script, target, { name, host, saved_at: nowIso(), values: savableValues(params, raw) }, 'Preset')
    return slug
  }

  renamePreset(script: ScriptRef, slug: string, newName: string): string {
    newName = cleanName(newName)
    this.checkSlug(slug)
    const data = this.load(script)
    const target = this.presetFile(script, slug)
    const p = this.readSet(target, true)
    if (!p) throw new PresetError('That preset no longer exists.')
    for (const [s, other] of Object.entries(data.presets))
      if (s !== slug && String(other.name).toLowerCase() === newName.toLowerCase())
        throw new PresetError(`A preset named '${newName}' already exists.`)
    p.name = newName
    this.writeSet(script, target, p, 'Preset')
    return slug
  }

  deletePreset(script: ScriptRef, slug: string): boolean {
    this.checkSlug(slug)
    this.load(script) // migrates old files first
    try {
      fs.unlinkSync(this.presetFile(script, slug))
    } catch (e: any) {
      if (e?.code === 'ENOENT') return false
      throw new PresetError(`Could not delete the preset: ${e?.message ?? e}`)
    }
    return true
  }

  // --------------------------------------------------------- recent runs ---
  /** Remember the values a run was started with; the newest RECENT_MAX distinct sets are kept. */
  recordRun(script: ScriptRef, params: ParamDef[], raw: Record<string, any>, host: string, runId: string, initiator = ''): void {
    const values = savableValues(params, raw)
    const name = validRunId(runId || '') ? runId : 'run-' + nowIso().replaceAll(':', '')
    const data = this.load(script)
    for (const r of data.recent)
      if (stable([r.host ?? null, r.values ?? {}]) === stable([host, values])) fs.rmSync(r._file, { force: true })
    this.writeSet(
      script, path.join(this.recentDir(script), name + EXT),
      { host, saved_at: nowIso(), order: nextOrder(), run_id: runId, initiator, values }, 'Values of a recent run',
    )
    for (const r of this.load(script).recent.slice(RECENT_MAX)) fs.rmSync(r._file, { force: true })
  }

  /** Newest first; each entry also carries `key` ("@<n>", for ?preset=), `label` and `when`. */
  recentRuns(script: ScriptRef): PresetSet[] {
    let runs: PresetSet[]
    try {
      runs = this.load(script).recent.slice(0, RECENT_MAX)
    } catch (e) {
      if (e instanceof PresetError) return []
      throw e
    }
    return runs.map((r, i) => {
      const d = this.pub(r)
      d.key = `@${i}`
      d.label = i === 0 ? 'Last run' : r.run_id || `Run ${i + 1}`
      d.when = String(r.saved_at ?? '').replace('T', ' ').slice(0, 16)
      return d
    })
  }

  getRecent(script: ScriptRef, index: number): PresetSet | null {
    const runs = this.recentRuns(script)
    return index >= 0 && index < runs.length ? { ...runs[index] } : null
  }

  // ---------------------------------------------------------------- views ---
  /** Comparison of all saved parameter sets: rows = parameters, columns = presets + recent runs. */
  grid(script: ScriptRef, params: ParamDef[]): { columns: any[]; rows: any[] } {
    let data
    try {
      data = this.load(script)
    } catch (e) {
      if (e instanceof PresetError) return { columns: [], rows: [] }
      throw e
    }
    const cols: any[] = Object.entries(data.presets)
      .sort((a, b) => String(a[1].name).toLowerCase().localeCompare(String(b[1].name).toLowerCase()))
      .map(([s, p]) => ({
        kind: 'preset', key: s, name: p.name, host: p.host ?? '',
        saved_at: String(p.saved_at ?? '').replace('T', ' '), values: p.values || {},
      }))
    data.recent.slice(0, RECENT_MAX).forEach((r, i) =>
      cols.push({
        kind: 'recent', key: `@${i}`, name: i === 0 ? 'Last run' : r.run_id || `Run ${i + 1}`,
        run_id: r.run_id ?? '', host: r.host ?? '', saved_at: String(r.saved_at ?? '').replace('T', ' '), values: r.values || {},
      }))
    const defaults = this.ops().defaultsRaw(params)
    const defaultHost = script.meta?.host ?? 'local'
    const fmt = (v: unknown): string => {
      if (typeof v === 'boolean') return v ? 'Yes' : 'No'
      if (Array.isArray(v)) return v.map(String).join(', ') || '—'
      return v === null || v === undefined || v === '' ? '—' : String(v)
    }
    const varies = (cells: any[]) => new Set(cells.map((c) => c.text)).size > 1
    const hostCells = cols.map((c) => ({ text: c.host || '—', changed: (c.host || 'local') !== defaultHost }))
    const rows: any[] = [{ label: 'Target host', name: 'host', cells: hostCells, varies: varies(hostCells) }]
    for (const p of params) {
      let cells: any[]
      if (p.type === 'password') cells = cols.map(() => ({ text: 'not saved', muted: true }))
      else if (p.editable_at_runtime === false) cells = cols.map(() => ({ text: 'fixed', muted: true }))
      else
        cells = cols.map((c) => {
          if (p.name in c.values) {
            const t = fmt(c.values[p.name])
            return { text: t, changed: t !== fmt(defaults[p.name]) }
          }
          return { text: 'default', muted: true }
        })
      rows.push({ label: p.label, name: p.name, cells, varies: varies(cells) })
    }
    return { columns: cols, rows }
  }

  /** Where the saved values of a script live (shown as a tooltip). */
  fileInfo(script: ScriptRef): { path?: string; name?: string } {
    try {
      this.check(script)
    } catch {
      return {}
    }
    return { path: this.folder(script), name: 'saved values' }
  }

  /**
   * Merge stored values (a preset or a recent run) into the *current* parameter definitions.
   * Returns [raw values, warnings]: unknown parameters get defaults; values that no longer validate fall back
   * to the default; stored values for parameters that no longer exist are ignored. Each is reported.
   */
  applyPreset(params: ParamDef[], preset: PresetSet): [Record<string, any>, string[]] {
    const ops = this.ops()
    const stored: Record<string, any> = preset.values || {}
    const raw = ops.defaultsRaw(params)
    const warnings: string[] = []
    const current = new Set(params.map((p) => p.name))
    for (const name of Object.keys(stored))
      if (!current.has(name)) warnings.push(`'${name}' no longer exists in this script and was ignored.`)
    for (const p of params) {
      if (p.type === 'password' || p.editable_at_runtime === false) continue
      if (!(p.name in stored)) {
        warnings.push(`'${p.label}' is new since these values were saved; its default was used.`)
        continue
      }
      const candidate = stored[p.name]
      const [, err] = ops.parseValue(p, candidate)
      if (err) warnings.push(`'${p.label}' (saved value is no longer valid: ${err.replace(/\.+$/, '')}) was reset to its default.`)
      else raw[p.name] = p.type !== 'boolean' ? candidate : Boolean(candidate)
    }
    return [raw, warnings]
  }
}
