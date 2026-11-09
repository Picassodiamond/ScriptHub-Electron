/**
 * Script ids. A script has a stable id (12 hex chars) stored in its metadata block, or, until
 * ScriptHub first writes the block, a path id (sha1 of its normalised path, cut to 12).
 * When a stable id replaces a path id the old one is kept as an alias in script_ids.json.
 * Port of runner/ids.py.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DataDirs } from './paths.js'
import { atomicWriteJson, readJson } from './fsutil.js'

const ID_RE = /^[0-9a-f]{12}$/

/** Python's os.path.normcase: on Windows lower-case with backslashes, elsewhere unchanged. */
export function normcase(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.replaceAll('/', '\\').toLowerCase() : p
}

export function pathId(p: string, platform: NodeJS.Platform = process.platform): string {
  return crypto.createHash('sha1').update(normcase(p, platform), 'utf8').digest('hex').slice(0, 12)
}

export function newId(): string {
  return crypto.randomBytes(6).toString('hex')
}

export function valid(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

export class Ids {
  private cache: { mtime: number | null; aliases: Record<string, string> } = { mtime: null, aliases: {} }

  constructor(private dirs: DataDirs) {}

  /** {old id: stable id}. Cached until the file changes; never throws. */
  aliases(): Record<string, string> {
    let mtime: number
    try {
      mtime = fs.statSync(this.dirs.scriptIdsFile).mtimeMs
    } catch {
      return {}
    }
    if (this.cache.mtime !== mtime) {
      let table: Record<string, string> = {}
      try {
        const data = readJson(this.dirs.scriptIdsFile)
        const raw = data && typeof data === 'object' ? data.aliases : null
        if (raw && typeof raw === 'object')
          for (const [k, v] of Object.entries(raw)) if (valid(k) && valid(v)) table[k] = v as string
      } catch {
        table = {}
      }
      this.cache = { mtime, aliases: table }
    }
    return { ...this.cache.aliases }
  }

  /** The current id for `sid` (an old path id resolves to its stable id). */
  canonical<T extends string | null | undefined>(sid: T): T {
    if (!sid) return sid
    const table = this.aliases()
    const seen = new Set<string>()
    let cur: string = sid
    while (cur in table && !seen.has(cur)) {
      seen.add(cur)
      cur = table[cur]
    }
    return cur as T
  }

  addAlias(old: string, next: string): void {
    if (!valid(old) || !valid(next) || old === next) return
    const table = this.aliases()
    table[old] = next
    atomicWriteJson(this.dirs.scriptIdsFile, { _comment: 'Old script ids -> stable ids (ScriptHub).', aliases: table })
    this.cache.mtime = null
  }

  /** `old` is now `next`: saved values and backups follow, the old id becomes an alias. */
  adopt(old: string, next: string): void {
    if (!valid(old) || !valid(next) || old === next) return
    for (const base of [this.dirs.presets, this.dirs.backups]) {
      try {
        moveDir(path.join(base, old), path.join(base, next))
      } catch {
        /* best effort */
      }
    }
    this.addAlias(old, next)
  }
}

/** Move src's files into dst (rename when dst does not exist; never overwrites). */
function moveDir(src: string, dst: string): void {
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.renameSync(src, dst)
    return
  }
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) {
        const target = path.join(dst, path.relative(src, full))
        if (!fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.renameSync(full, target)
        }
      }
    }
  }
  walk(src)
  fs.rmSync(src, { recursive: true, force: true })
}
