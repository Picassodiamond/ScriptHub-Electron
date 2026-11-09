/**
 * Script discovery: builds the catalogue of runnable scripts (nothing is ever executed here).
 * Port of runner/discovery.py. The scan is asynchronous (it yields between folders) so a big
 * folder never blocks the app; progress is readable while it runs.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ConfigStore } from './config.js'
import { isFile } from './fsutil.js'
import { normcase, pathId as computePathId, valid as validId, type Ids } from './ids.js'
import type { MetadataStore } from './metadata.js'
import { validateMetadata } from './parameters.js'
import { ValidationError } from './validators.js'
import type { Workspace } from './workspace.js'

export const SKIP_DIRS = new Set(['__pycache__', 'node_modules', 'venv', '.venv', 'site-packages', 'env'])
export const CACHE_TTL = 2.0 // seconds; new scripts appear without a restart
export const MAX_DEPTH = 3 // sub-folder levels below the open folder that are scanned (root = 0)
export const AUTO_WAIT = 1.0 // a page waits this long for a scan it needs, then shows what is there
export const RESCAN_WAIT = 1.5
export const SLOW_FACTOR = 10 // a scan that took t seconds is repeated after at most every SLOW_FACTOR*t

export const LANGUAGES: Record<string, [string, string]> = {
  '.py': ['python', 'Python'],
  '.sh': ['shell', 'Shell'], '.bash': ['shell', 'Shell'],
  '.bat': ['batch', 'Batch'], '.cmd': ['batch', 'Batch'],
  '.ps1': ['powershell', 'PowerShell'],
}
export const PLATFORM_LABELS: Record<string, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS' }
export const ALL_PLATFORMS = ['windows', 'linux', 'macos']
const DEFAULT_PLATFORMS: Record<string, string[]> = {
  '.sh': ['linux', 'macos'], '.bash': ['linux', 'macos'], '.bat': ['windows'], '.cmd': ['windows'],
}

export function languageOf(ext: string): [string, string] {
  const e = ext.toLowerCase()
  if (e in LANGUAGES) return LANGUAGES[e]
  const word = e.replace(/^\.+/, '') || 'other'
  return [word, word.toUpperCase()]
}

export const defaultPlatforms = (ext: string): string[] => [...(DEFAULT_PLATFORMS[ext.toLowerCase()] ?? ALL_PLATFORMS)]

export interface Script {
  /** The stable id from the metadata block when present, else the path id. */
  id: string
  path: string
  root: string
  name: string
  description: string
  category: string
  interpreter: string
  extension: string
  metaSource: string | null
  metaError: string | null
  parameterCount: number
  meta: Record<string, any>
  metaValid: boolean
  language: string
  languageLabel: string
  platforms: string[]
  pathId: string
  /** Path of another script with the same stable id (this one is a copy). */
  idConflict: string
}

export const platformLabels = (s: Script): string[] => s.platforms.map((p) => PLATFORM_LABELS[p] ?? p)
export function relativePath(s: Script): string {
  const rel = path.relative(s.root, s.path)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.basename(s.path)
}
export const location = (s: Script): string => path.dirname(s.path)

export interface ScanStatus {
  scanning: boolean
  version: number
  count: number
  folder?: string
  dirs?: number
  found?: number
  current?: string
  elapsed?: number
  first?: boolean
}

const pretty = (stem: string): string =>
  stem.replaceAll('_', ' ').replaceAll('-', ' ').trim().replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()) || stem

const skipDir = (name: string): boolean => name.startsWith('.') || name.startsWith('$') || SKIP_DIRS.has(name)
const now = (): number => performance.now() / 1000
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

function inside(child: string, root: string): boolean {
  const rel = path.relative(normcase(root), normcase(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function created(p: string): number {
  try {
    const st = fs.statSync(p)
    return process.platform === 'win32' ? st.birthtimeMs : st.ctimeMs
  } catch {
    return Infinity
  }
}

interface State { key: string | null; scripts: Map<string, Script>; problems: string[]; time: number; duration: number; version: number }

class Job {
  scripts = new Map<string, Script>()
  problems: string[] = []
  dirs = 0
  current = ''
  started = now()
  cancelled = false
  done: Promise<void>
  private finish!: () => void
  finished = false

  constructor(public key: string, public roots: string[], private d: Discovery) {
    this.done = new Promise<void>((r) => (this.finish = r))
    void this.run()
  }

  private async run(): Promise<void> {
    try {
      await this.walk()
    } catch (e: any) {
      this.problems.push(`Scan failed: ${e?.message ?? e}`)
    } finally {
      this.d._jobFinished(this)
      this.finished = true
      this.finish()
    }
  }

  private async walk(): Promise<void> {
    const interpreters = this.d._interpreters()
    const seen = new Set<string>()
    for (const root of this.roots) {
      if (isFile(root)) {
        // a single script opened on its own
        if (path.extname(root).toLowerCase() in interpreters) this.d._place(this.scripts, this.d._build(root, path.dirname(root), interpreters), this.problems)
        else this.problems.push(`Not a script type with an interpreter: ${root}`)
        continue
      }
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        this.problems.push(`Not found: ${root}`)
        continue
      }
      const tooDeep: string[] = []
      const stack: Array<[string, number]> = [[root, 0]]
      while (stack.length) {
        const [dir, depth] = stack.pop()!
        if (this.cancelled) return
        this.dirs++
        this.current = dir
        await tick()
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          continue
        }
        let dirnames = entries.filter((e) => e.isDirectory() && !skipDir(e.name)).map((e) => e.name).sort(cmp)
        if (dirnames.length && depth >= MAX_DEPTH) {
          tooDeep.push(...dirnames.map((n) => path.join(dir, n)))
          dirnames = []
        }
        for (const n of [...dirnames].reverse()) stack.push([path.join(dir, n), depth + 1])
        for (const e of entries.filter((x) => !x.isDirectory()).map((x) => x.name).sort(cmp)) {
          if (e.startsWith('.')) continue
          const p = path.join(dir, e)
          if (!(path.extname(p).toLowerCase() in interpreters)) continue
          const real = realPath(p)
          if (!inside(real, root)) {
            this.problems.push(`Skipped (outside its directory): ${p}`) // a symlink escaping the root
            continue
          }
          if (!isFile(real)) continue
          const k = normcase(real)
          if (seen.has(k)) continue // overlapping roots: the same file twice
          seen.add(k)
          this.d._place(this.scripts, this.d._build(real, root, interpreters), this.problems)
        }
      }
      if (tooDeep.length) {
        const more = tooDeep.length > 1 ? ` (and ${tooDeep.length - 1} more)` : ''
        this.problems.push(`Not scanned, more than ${MAX_DEPTH} folder levels deep: ${tooDeep[0]}${more}`)
      }
    }
  }
}

export class Discovery {
  private state: State = { key: null, scripts: new Map(), problems: [], time: 0, duration: 0, version: 0 }
  private job: Job | null = null

  constructor(private deps: { ids: Ids; metadata: MetadataStore; workspace: Workspace; config: ConfigStore }) {}

  /** Lower-cased extension -> interpreter. */
  _interpreters(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.deps.config.load().interpreters as Record<string, string>)) out[k.toLowerCase()] = v
    return out
  }

  private roots(): [string, string[]] {
    const roots = this.deps.workspace.roots().map(realPath)
    return [roots.join('\0'), roots]
  }

  // -------------------------------------------------------------- building ---
  _build(file: string, root: string, interpreters: Record<string, string>): Script {
    const pid = computePathId(file)
    const ext = path.extname(file).toLowerCase()
    const loaded = this.deps.metadata.loadRaw(file, pid)
    let data: Record<string, any> = loaded.data ?? {}
    let err = loaded.error
    const source = loaded.source
    const sid = validId(data.id) ? data.id : pid
    const stem = path.basename(file, path.extname(file))
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : pretty(stem)
    let category: string = data.category
    if (typeof category !== 'string' || !category.trim()) {
      const rel = path.dirname(file) !== root ? path.relative(root, path.dirname(file)) : ''
      const first = rel.split(path.sep).filter(Boolean)[0]
      category = first ? pretty(first) : 'General'
    }
    let interp = data.interpreter
    if (typeof interp !== 'string' || !interp.trim()) interp = interpreters[ext] ?? ''
    let metaValid = true
    if (!err && source !== null) {
      try {
        data = validateMetadata(data)
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e
        metaValid = false
        err = 'Invalid metadata: ' + e.errors.join('; ')
      }
    } else if (err) metaValid = false
    const params = data.parameters
    const [langKey, langLabel] = languageOf(ext)
    let platforms = data.platforms
    if (!(Array.isArray(platforms) && platforms.length && platforms.every((p) => p in PLATFORM_LABELS))) platforms = defaultPlatforms(ext)
    return {
      id: sid, path: file, root, name,
      description: typeof data.description === 'string' ? data.description : '',
      category: category.trim(), interpreter: interp, extension: ext, metaSource: source, metaError: err,
      parameterCount: Array.isArray(params) ? params.length : 0, meta: data, metaValid, language: langKey,
      languageLabel: langLabel, platforms: ALL_PLATFORMS.filter((p) => platforms.includes(p)), pathId: pid, idConflict: '',
    }
  }

  /** Of two scripts with the same stable id, is `a` the original (b the copy)? */
  private isOriginal(a: Script, b: Script): boolean {
    const aHome = this.deps.ids.canonical(a.pathId) === a.id
    const bHome = this.deps.ids.canonical(b.pathId) === b.id
    if (aHome !== bHome) return aHome
    const [ca, cb] = [created(a.path), created(b.path)]
    return ca !== cb ? ca < cb : a.path <= b.path
  }

  /** Add `script`; of two with the same stable id the copy keeps its path id. */
  _place(scripts: Map<string, Script>, script: Script, problems?: string[]): void {
    const other = scripts.get(script.id)
    if (other && other.path !== script.path) {
      const [original, copy] = this.isOriginal(script, other) ? [script, other] : [other, script]
      if (copy === other) scripts.delete(other.id)
      copy.idConflict = original.path
      copy.id = copy.pathId
      scripts.set(copy.id, copy)
      scripts.set(original.id, original)
      const msg = `${copy.path} has the same id as ${original.path} (a copy?); it gets a new id the next time it is saved.`
      if (problems && !problems.includes(msg)) problems.push(msg)
      return
    }
    scripts.set(script.id, script)
  }

  _jobFinished(job: Job): void {
    if (!job.cancelled) {
      const t = now()
      const changed = this.state.key !== job.key || !sameKeys(this.state.scripts, job.scripts)
      this.state = {
        key: job.key, scripts: new Map(job.scripts), problems: [...job.problems], time: t, duration: t - job.started,
        version: this.state.version + (changed ? 1 : 0),
      }
    }
    if (this.job === job) this.job = null
  }

  // --------------------------------------------------------------- scanning ---
  private start(key: string, roots: string[]): Job {
    if (this.job) this.job.cancelled = true
    this.job = new Job(key, roots, this)
    return this.job
  }

  private ordered(scripts: Map<string, Script>): Script[] {
    return [...scripts.values()].sort((a, b) => cmp(a.category.toLowerCase(), b.category.toLowerCase()) || cmp(a.name.toLowerCase(), b.name.toLowerCase()))
  }

  private result(key: string): [Script[], string[]] {
    if (this.state.key === key) return [this.ordered(this.state.scripts), [...this.state.problems]]
    if (this.job && this.job.key === key) return [this.ordered(this.job.scripts), [...this.job.problems]]
    return [[], []]
  }

  private stale(): boolean {
    return now() - this.state.time > Math.max(CACHE_TTL, SLOW_FACTOR * this.state.duration)
  }

  private waitFor(job: Job, seconds: number): Promise<boolean> {
    if (job.finished) return Promise.resolve(true)
    return Promise.race([job.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), Math.max(0, seconds) * 1000))])
  }

  /**
   * (scripts, problems). A page waits up to `wait` seconds for a scan it needs, then shows the last results
   * (or, for a newly opened folder, what has been found so far). `force` rescans and waits for the result.
   */
  async scan(force = false, wait?: number): Promise<[Script[], string[]]> {
    const [key, roots] = this.roots()
    let job = this.job && this.job.key === key ? this.job : null
    let started = false
    if (force || (!job && (this.state.key !== key || this.stale()))) {
      job = this.start(key, roots)
      started = true
    }
    if (job) {
      if (force) await job.done
      else if (started || this.state.key !== key) await this.waitFor(job, (wait ?? AUTO_WAIT) - (now() - job.started))
    }
    return this.result(key)
  }

  /** Scan again without blocking for long (Rescan, after opening a folder). Returns [scripts, problems, finished]. */
  async rescan(wait?: number): Promise<[Script[], string[], boolean]> {
    const [key, roots] = this.roots()
    const job = this.job && this.job.key === key ? this.job : this.start(key, roots)
    const finished = await this.waitFor(job, wait ?? RESCAN_WAIT)
    const [scripts, problems] = this.result(key)
    return [scripts, problems, finished]
  }

  /** Refresh one script after it was created, edited or reconfigured, without rescanning the folder. */
  updateFile(file: string): void {
    const [key, roots] = this.roots()
    const p = realPath(file)
    const interpreters = this._interpreters()
    let root = roots.find((r) => normcase(r) === normcase(p) || inside(p, r)) ?? null
    if (root !== null && normcase(root) === normcase(p)) root = path.dirname(p) // a single script opened on its own
    const script = root !== null && path.extname(p).toLowerCase() in interpreters && isFile(p) ? this._build(p, root, interpreters) : null
    const targets: Array<[Map<string, Script>, boolean]> = []
    if (this.state.key === key) targets.push([this.state.scripts, true])
    if (this.job && this.job.key === key) targets.push([this.job.scripts, false])
    for (const [scripts, isState] of targets) {
      for (const [k, s] of [...scripts]) if (normcase(s.path) === normcase(p)) scripts.delete(k) // its id may have changed
      if (script) {
        if (isState) this.state.version++
        this._place(scripts, { ...script }, isState ? this.state.problems : undefined)
      }
    }
  }

  /** Scan progress for the status bar. */
  status(): ScanStatus {
    const [key] = this.roots()
    const out: ScanStatus = {
      scanning: this.job !== null, version: this.state.version, count: this.state.key === key ? this.state.scripts.size : 0,
    }
    if (this.job) {
      Object.assign(out, {
        folder: this.job.key.split('\0').join(', '), dirs: this.job.dirs, found: this.job.scripts.size, current: this.job.current,
        elapsed: Math.floor(now() - this.job.started), first: this.state.key !== this.job.key,
      })
    }
    return out
  }

  /** By id; an old id (its path id, or one that became an alias) finds it too. */
  async getScript(sid: string, force = false): Promise<Script | null> {
    const [scripts] = await this.scan(force)
    return this.findIn(scripts, sid)
  }

  findIn(scripts: Script[], sid: string): Script | null {
    const byId = scripts.find((s) => s.id === sid) ?? scripts.find((s) => s.pathId === sid)
    if (byId) return byId
    const stable = this.deps.ids.canonical(sid)
    return stable !== sid ? scripts.find((s) => s.id === stable) ?? null : null
  }

  /** The last scan's scripts without waiting (empty before the first scan). */
  current(): Script[] {
    const [key] = this.roots()
    return this.result(key)[0]
  }

  /** A synchronous view for `Sequences.resolve`: the last scan's results plus direct file loads. */
  lookup(): { getScript(id: string): Script | null; loadFile(p: string): Script | null } {
    return { getScript: (id) => this.findIn(this.current(), id), loadFile: (p) => this.loadFile(p) }
  }

  /** One script file read directly (a sequence step outside the open folder). Null when gone or without an interpreter. */
  loadFile(file: string): Script | null {
    const interpreters = this._interpreters()
    try {
      const real = realPath(file)
      if (!isFile(real) || !(path.extname(real).toLowerCase() in interpreters)) return null
      return this._build(real, path.dirname(real), interpreters)
    } catch {
      return null
    }
  }

  /** Every id runs or links may use for `script`: its id, its path id, and old ids that now alias to it. */
  allIds(script: Script): Set<string> {
    const out = new Set([script.id, script.pathId].filter(Boolean))
    for (const old of Object.keys(this.deps.ids.aliases())) if (this.deps.ids.canonical(old) === script.id) out.add(old)
    return out
  }
}

function sameKeys(a: Map<string, unknown>, b: Map<string, unknown>): boolean {
  if (a.size !== b.size) return false
  for (const k of a.keys()) if (!b.has(k)) return false
  return true
}
