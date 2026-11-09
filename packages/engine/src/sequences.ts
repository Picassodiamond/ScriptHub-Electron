/**
 * Sequences: existing scripts connected by arrows. One YAML file per sequence in
 * runtime/sequences/<slug>.yaml. Port of runner/sequences.py (see its docstring for the file format).
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteText } from './fsutil.js'
import type { Ids } from './ids.js'
import type { DataDirs } from './paths.js'
import * as yamlish from './yamlish.js'

export const EXT = '.yaml'
export const NAME_MAX = 60
export const STEPS_MAX = 50
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const STEP_ID_RE = /^[a-z][a-z0-9]{0,15}$/
export const WHEN = ['success', 'failure', 'always'] as const
export const JOIN = ['all', 'any'] as const
const POS_MAX = 20000
export const GRID = 20
const NODE_H = 60
const LAYER_GAP = 60

export type When = (typeof WHEN)[number]
export type Join = (typeof JOIN)[number]

export interface Step {
  id: string
  script: string
  path: string
  name: string
  host: string
  preset: string
  values: Record<string, any>
  join: Join
  x: number
  y: number
}
export interface Link { from: string; to: string; when: When }
export interface SequenceData {
  name: string
  description: string
  saved_at: string
  steps: Step[]
  links: Link[]
  slug?: string
}
export interface SequenceListItem {
  slug: string; name: string; steps: number; saved_at: string; saved_display: string; error: string
}

/** What `resolve`/`refresh` need to know about a script (satisfied by discovery's Script). */
export interface ScriptLike { id: string; pathId: string; path: string; name: string }
export interface ScriptLookup {
  getScript(id: string): ScriptLike | null
  loadFile(path: string): ScriptLike | null
}

export class SequenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SequenceError'
  }
}

export function nowIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export const slugify = (name: string): string => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, 64).replace(/^-+|-+$/g, '') || 'sequence'
}

export function cleanName(name: string): string {
  const n = (name ?? '').split(/\s+/).filter(Boolean).join(' ')
  if (!n) throw new SequenceError('Enter a name for the sequence.')
  if (n.length > NAME_MAX) throw new SequenceError(`The name must be at most ${NAME_MAX} characters.`)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(n)) throw new SequenceError('The name contains invalid characters.')
  return n
}

export const validSlug = (slug: unknown): slug is string => typeof slug === 'string' && SLUG_RE.test(slug)

/** Python's round(): halves go to the even neighbour. */
function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

function pos(value: unknown, dflt = 0): number {
  let v = Math.trunc(Number(value))
  if (value === null || value === undefined || value === '' || !Number.isFinite(v)) v = dflt
  v = Math.max(0, Math.min(POS_MAX, v))
  return roundHalfEven(v / GRID) * GRID
}

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)

function cleanStep(raw: unknown): Step {
  if (!isObj(raw)) throw new SequenceError('a step is not a mapping')
  const sid = raw.script
  if (typeof sid !== 'string' || !/^[0-9a-f]{6,64}$/.test(sid)) throw new SequenceError("a step has no valid 'script' id")
  const stepId = raw.id
  if (typeof stepId !== 'string' || !STEP_ID_RE.test(stepId)) throw new SequenceError(`step of '${sid}': invalid or missing 'id'`)
  const preset = raw.preset || ''
  if (preset && !(typeof preset === 'string' && SLUG_RE.test(preset))) throw new SequenceError(`step '${stepId}': invalid preset`)
  let values = raw.values
  if (values === null || values === undefined) values = {}
  if (!isObj(values)) throw new SequenceError(`step '${stepId}': 'values' must be a mapping`)
  const join = raw.join || 'all'
  if (!(JOIN as readonly string[]).includes(join)) throw new SequenceError(`step '${stepId}': join must be all or any`)
  return {
    id: stepId, script: sid, path: String(raw.path || ''), name: String(raw.name || ''), host: String(raw.host || ''),
    preset, values, join, x: pos(raw.x), y: pos(raw.y),
  }
}

function cleanLink(raw: unknown, stepIds: string[]): Link {
  if (!isObj(raw)) throw new SequenceError('an arrow is not a mapping')
  const a = raw.from
  const b = raw.to
  const when = raw.when || 'success'
  if (!stepIds.includes(a) || !stepIds.includes(b)) throw new SequenceError(`the arrow ${a} -> ${b} refers to a step that does not exist`)
  if (a === b) throw new SequenceError(`the arrow ${a} -> ${b} leads to itself`)
  if (!(WHEN as readonly string[]).includes(when)) throw new SequenceError(`the arrow ${a} -> ${b}: when must be success, failure or always`)
  return { from: a, to: b, when }
}

/** A first-version file (steps in a list, on_failure on each) becomes a top-to-bottom chain. */
function legacy(steps: unknown[]): [any[], any[]] {
  const out: any[] = []
  const links: any[] = []
  let prevContinue = false
  steps.forEach((raw, i) => {
    if (!isObj(raw)) throw new SequenceError('a step is not a mapping')
    const step: Record<string, any> = { ...raw }
    const onFailure = step.on_failure || 'stop'
    delete step.on_failure
    if (onFailure !== 'stop' && onFailure !== 'continue') throw new SequenceError(`step ${i + 1}: on_failure must be stop or continue`)
    step.id ??= `s${i + 1}`
    step.x ??= 2 * GRID
    step.y ??= 2 * GRID + i * (NODE_H + LAYER_GAP)
    if (out.length) links.push({ from: out[out.length - 1].id, to: step.id, when: prevContinue ? 'always' : 'success' })
    out.push(step)
    prevContinue = onFailure === 'continue'
  })
  return [out, links]
}

function clean(raw: unknown): SequenceData {
  if (!isObj(raw)) throw new SequenceError('not a sequence file')
  const name = raw.name
  if (typeof name !== 'string' || !name.trim()) throw new SequenceError('the sequence has no name')
  let steps: any = raw.steps ?? []
  if (!Array.isArray(steps)) throw new SequenceError("'steps' must be a list")
  let links: any = raw.links
  if (links === null || links === undefined) [steps, links] = legacy(steps)
  if (!Array.isArray(links)) throw new SequenceError("'links' must be a list")
  const cleaned = steps.map(cleanStep) as Step[]
  const stepIds = cleaned.map((s) => s.id)
  if (new Set(stepIds).size !== stepIds.length) throw new SequenceError('two steps have the same id')
  const outLinks: Link[] = []
  const seen = new Set<string>()
  for (const l of links) {
    const link = cleanLink(l, stepIds)
    const k = `${link.from}\0${link.to}`
    if (seen.has(k)) throw new SequenceError(`the arrow ${link.from} -> ${link.to} is there twice`)
    seen.add(k)
    outLinks.push(link)
  }
  const data: SequenceData = {
    name: name.trim(), description: String(raw.description || ''), saved_at: String(raw.saved_at || ''),
    steps: cleaned, links: outLinks,
  }
  if (topoOrder(data) === null) throw new SequenceError('the arrows form a loop')
  return data
}

function dumpStep(step: Step): Record<string, any> {
  const out: Record<string, any> = { id: step.id, script: step.script }
  for (const k of ['path', 'name', 'host', 'preset'] as const) if (step[k]) out[k] = step[k]
  if (!step.preset) out.values = { ...(step.values ?? {}) }
  if ((step.join ?? 'all') !== 'all') out.join = step.join
  out.x = step.x
  out.y = step.y
  return out
}

/** The file text of a sequence (also used inside project files). */
export function dumpText(data: Pick<SequenceData, 'name' | 'steps'> & Partial<SequenceData>): string {
  const out: Record<string, any> = { name: data.name }
  if (data.description) out.description = data.description
  out.saved_at = nowIso()
  out.steps = data.steps.map(dumpStep)
  out.links = (data.links ?? []).map((l) => ({ ...l }))
  return yamlish.dump(out, 'Sequence for ScriptHub. Passwords are never stored.')
}

/** A sequence from file text (checked as a stored file is); throws SequenceError. */
export function parseText(text: string): SequenceData {
  try {
    return clean(yamlish.load(text))
  } catch (e) {
    if (e instanceof yamlish.YamlError) throw new SequenceError(e.message)
    throw e
  }
}

// ------------------------------------------------------------------ graph ---
/** Step ids so every arrow points forward (list order kept where possible); null on a loop. */
export function topoOrder(data: Pick<SequenceData, 'steps' | 'links'>): string[] | null {
  const ids = data.steps.map((s) => s.id)
  const indeg = new Map(ids.map((i) => [i, 0]))
  const out = new Map<string, string[]>(ids.map((i) => [i, []]))
  for (const l of data.links ?? []) {
    out.get(l.from)!.push(l.to)
    indeg.set(l.to, indeg.get(l.to)! + 1)
  }
  const order: string[] = []
  const ready = ids.filter((i) => indeg.get(i) === 0)
  const rank = new Map(ids.map((i, n) => [i, n]))
  while (ready.length) {
    ready.sort((a, b) => rank.get(a)! - rank.get(b)!)
    const cur = ready.shift()!
    order.push(cur)
    for (const nxt of out.get(cur)!) {
      indeg.set(nxt, indeg.get(nxt)! - 1)
      if (indeg.get(nxt) === 0) ready.push(nxt)
    }
  }
  return order.length === ids.length ? order : null
}

export const incoming = (data: Pick<SequenceData, 'links'>, stepId: string): Link[] => (data.links ?? []).filter((l) => l.to === stepId)
export const outgoing = (data: Pick<SequenceData, 'links'>, stepId: string): Link[] => (data.links ?? []).filter((l) => l.from === stepId)

function reaches(data: SequenceData, start: string, goal: string): boolean {
  const todo = [start]
  const seen = new Set<string>()
  while (todo.length) {
    const cur = todo.pop()!
    if (cur === goal) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    todo.push(...outgoing(data, cur).map((l) => l.to))
  }
  return false
}

export function find(data: SequenceData, stepId: string): number {
  const i = data.steps.findIndex((s) => s.id === stepId)
  if (i < 0) throw new SequenceError('That step does not exist.')
  return i
}

/** One more than the highest s<n> (a removed step's id is not reused). */
function newStepId(data: SequenceData): string {
  const taken = new Set(data.steps.map((s) => s.id))
  let n = 1 + Math.max(0, ...[...taken].filter((t) => /^s\d{1,6}$/.test(t)).map((t) => parseInt(t.slice(1), 10)))
  while (taken.has(`s${n}`)) n++
  return `s${n}`
}

// ----------------------------------------------------------------- store ---
export class Sequences {
  constructor(private dirs: DataDirs, private ids: Ids, private lookup?: ScriptLookup) {}

  folder(): string {
    return this.dirs.sequences
  }

  private file(slug: string): string {
    if (!validSlug(slug)) throw new SequenceError('Invalid sequence.')
    return path.join(this.folder(), `${slug}${EXT}`)
  }

  private read(slug: string, strict: true): SequenceData
  private read(slug: string, strict?: false): SequenceData | null
  private read(slug: string, strict = false): SequenceData | null {
    const file = this.file(slug)
    let data: SequenceData
    try {
      let text = fs.readFileSync(file, 'utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      data = clean(yamlish.load(text))
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        if (strict) throw new SequenceError('That sequence does not exist.')
        return null
      }
      if (strict) throw new SequenceError(`${path.basename(file)} could not be read (${e?.message ?? e}); fix or delete it first.`)
      return null
    }
    data.slug = slug
    return data
  }

  private write(slug: string, data: SequenceData): void {
    atomicWriteText(this.file(slug), dumpText(data))
  }

  /** By name; a broken file has `error` and is never overwritten. */
  list(): SequenceListItem[] {
    let files: string[]
    try {
      files = fs.readdirSync(this.folder()).filter((f) => f.endsWith(EXT)).sort()
    } catch {
      return []
    }
    const out: SequenceListItem[] = []
    for (const f of files) {
      const slug = f.slice(0, -EXT.length)
      if (!validSlug(slug)) continue
      try {
        const d = this.read(slug, true)
        out.push({ slug, name: d.name, steps: d.steps.length, saved_at: d.saved_at, saved_display: d.saved_at.replace('T', ' ').slice(0, 16), error: '' })
      } catch (e: any) {
        out.push({ slug, name: slug, steps: 0, saved_at: '', saved_display: '', error: e.message })
      }
    }
    return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  /** The sequence (with slug), or null when missing or unreadable. */
  get(slug: string): SequenceData | null {
    return validSlug(slug) ? this.read(slug) : null
  }

  /** Like get() but throws SequenceError with the reason. */
  load(slug: string): SequenceData {
    return this.read(slug, true)
  }

  private freeSlug(name: string): string {
    const base = slugify(name)
    let slug = base
    let n = 2
    while (fs.existsSync(this.file(slug))) slug = `${base.slice(0, 60)}-${n++}`
    return slug
  }

  create(name: string): string {
    name = cleanName(name)
    if (this.list().some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new SequenceError(`A sequence named '${name}' already exists.`)
    const slug = this.freeSlug(name)
    this.write(slug, { name, description: '', saved_at: '', steps: [], links: [] })
    return slug
  }

  /** Store a sequence read with parseText() under a new slug (its name must be free). */
  addImported(data: SequenceData): string {
    const name = cleanName(data.name)
    if (this.list().some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new SequenceError(`A sequence named '${name}' already exists.`)
    const slug = this.freeSlug(name)
    this.write(slug, { ...data, name })
    return slug
  }

  rename(slug: string, name: string): void {
    name = cleanName(name)
    const data = this.load(slug)
    if (this.list().some((s) => s.name.toLowerCase() === name.toLowerCase() && s.slug !== slug)) throw new SequenceError(`A sequence named '${name}' already exists.`)
    data.name = name
    this.write(slug, data)
  }

  delete(slug: string): boolean {
    try {
      fs.unlinkSync(this.file(slug))
      return true
    } catch (e: any) {
      if (e?.code === 'ENOENT') return false
      throw e
    }
  }

  newStep(script: ScriptLike, values: Record<string, any>, preset = '', x = 0, y = 0): Partial<Step> {
    return { id: 's0', script: script.id, path: String(script.path), name: script.name, preset, values, x, y }
  }

  /** Add a step anywhere on the page; returns its id. */
  addStep(slug: string, step: Partial<Step>): string {
    const data = this.load(slug)
    if (data.steps.length >= STEPS_MAX) throw new SequenceError(`A sequence has at most ${STEPS_MAX} steps.`)
    const s = cleanStep({ ...step, id: newStepId(data) })
    data.steps.push(s)
    this.write(slug, data)
    return s.id
  }

  updateStep(slug: string, stepId: string, fields: Partial<Step>): void {
    const { id: _ignored, ...rest } = fields as any
    const data = this.load(slug)
    const i = find(data, stepId)
    data.steps[i] = cleanStep({ ...data.steps[i], ...rest })
    this.write(slug, data)
  }

  /** Remove a step and the arrows to and from it. */
  removeStep(slug: string, stepId: string): void {
    const data = this.load(slug)
    data.steps.splice(find(data, stepId), 1)
    data.links = data.links.filter((k) => k.from !== stepId && k.to !== stepId)
    this.write(slug, data)
  }

  /** Place steps: {step id: [x, y]}; unknown ids throw. */
  moveSteps(slug: string, positions: Record<string, [number, number]>): void {
    const data = this.load(slug)
    for (const [id, [x, y]] of Object.entries(positions)) {
      const s = data.steps[find(data, id)]
      s.x = pos(x)
      s.y = pos(y)
    }
    this.write(slug, data)
  }

  /** Add an arrow a -> b, or change its condition when it is there already. */
  link(slug: string, a: string, b: string, when: When = 'success'): void {
    if (!(WHEN as readonly string[]).includes(when)) throw new SequenceError('Unknown condition.')
    const data = this.load(slug)
    find(data, a)
    find(data, b)
    if (a === b) throw new SequenceError('A step cannot lead to itself.')
    const existing = data.links.find((k) => k.from === a && k.to === b)
    if (existing) existing.when = when
    else {
      if (reaches(data, b, a)) throw new SequenceError('That arrow would make a loop: the steps would never finish.')
      data.links.push({ from: a, to: b, when })
    }
    this.write(slug, data)
  }

  unlink(slug: string, a: string, b: string): void {
    const data = this.load(slug)
    const before = data.links.length
    data.links = data.links.filter((k) => !(k.from === a && k.to === b))
    if (data.links.length === before) throw new SequenceError('That arrow does not exist.')
    this.write(slug, data)
  }

  /** The step's script: by id in the open folder, else from its last known path (same id only). */
  resolve(step: Step): ScriptLike | null {
    if (!this.lookup) return null
    const script = this.lookup.getScript(step.script)
    if (script) return script
    if (!step.path) return null
    const s = this.lookup.loadFile(step.path)
    if (!s) return null
    return step.script === s.id || step.script === s.pathId || this.ids.canonical(step.script) === s.id ? s : null
  }

  /** Remember where each step's script is now (path, name, id). `scripts` lines up with the steps. */
  refresh(slug: string, data: SequenceData, scripts: Array<ScriptLike | null>): void {
    const updates: Array<[string, string, Partial<Step>]> = []
    data.steps.forEach((step, i) => {
      const script = scripts[i]
      if (!script) return
      const next = { path: String(script.path), name: script.name, script: script.id }
      if ((Object.keys(next) as Array<keyof typeof next>).some((k) => step[k] !== next[k])) {
        updates.push([step.id, step.script, next])
        Object.assign(step, next)
      }
    })
    if (!updates.length) return
    let current: SequenceData
    try {
      current = this.load(slug)
    } catch {
      return
    }
    for (const [stepId, oldId, next] of updates)
      for (const s of current.steps) if (s.id === stepId && s.script === oldId) Object.assign(s, next)
    try {
      this.write(slug, current)
    } catch {
      /* best effort */
    }
  }
}
