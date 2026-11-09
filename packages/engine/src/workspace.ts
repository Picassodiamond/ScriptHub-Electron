/**
 * The open script folder and any individually opened script files, plus recent and favourite
 * folders and files (runtime/workspace.json). UI state, not a setting. Port of runner/workspace.py.
 *
 * Installs that only have the old `script_directories` setting derive their state from it until
 * the first change.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConfigStore } from './config.js'
import { atomicWriteJson, isDirectory, isFile, readJson } from './fsutil.js'
import { normcase } from './ids.js'
import { ensureRuntimeDirs, type DataDirs } from './paths.js'
import { cleanDirectoryInput } from './security.js'

export const MAX_RECENT = 10
export const MAX_FAVORITES = 50
export const MAX_SEQ_FAVORITES = 100
export const MAX_FILES = 30

export interface WorkspaceState {
  folder: string | null
  files: string[]
  recent: string[]
  favorites: string[]
  sequence_favorites: string[]
}

export interface BrowseResult {
  path: string
  parent: string
  dirs: Array<{ path: string; name: string }>
  files: Array<{ path: string; name: string }>
  more?: boolean
  places: Array<{ path: string; name: string }>
  crumbs: Array<{ path: string; name: string }>
  error: string
}

export class Workspace {
  /** `baseDir`: relative paths in the settings resolve against it (the app folder). */
  constructor(private dirs: DataDirs, private config: ConfigStore, private baseDir: string = process.cwd()) {}

  stateFile(): string {
    return this.dirs.workspaceFile
  }

  /** Absolute, resolved path as stored. */
  normalize(value: string): string {
    let p = value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value
    p = p.replace(/%([^%]+)%/g, (m, n) => process.env[n] ?? m)
    if (!path.isAbsolute(p)) p = path.join(this.baseDir, p)
    return path.resolve(p)
  }

  private key(p: string): string {
    let r: string
    try {
      r = fs.realpathSync.native(p) // also C:\PROGRA~1 (8.3 short names) = C:\Program Files
    } catch {
      r = path.normalize(p)
    }
    return normcase(r)
  }

  same(a: string, b: string): boolean {
    return this.key(a) === this.key(b)
  }

  private dedupe(paths: unknown[], limit: number): string[] {
    const out: string[] = []
    for (const p of paths) if (typeof p === 'string' && p.trim() && !out.some((q) => this.same(p, q))) out.push(p)
    return out.slice(0, limit)
  }

  private slugs(values: unknown[], limit: number): string[] {
    const out: string[] = []
    for (const v of values) if (typeof v === 'string' && v.trim() && !out.includes(v)) out.push(v)
    return out.slice(0, limit)
  }

  private legacy(): WorkspaceState {
    const dirs = ((this.config.load().script_directories as string[] | undefined) ?? []).map((d) => this.normalize(d))
    const existing = dirs.filter(isDirectory)
    return {
      folder: existing[0] ?? null, files: [], recent: this.dedupe(dirs, MAX_RECENT), favorites: [], sequence_favorites: [],
    }
  }

  /** Never throws. */
  load(): WorkspaceState {
    const f = this.stateFile()
    if (!fs.existsSync(f)) return this.legacy()
    let data: any
    try {
      data = readJson(f)
    } catch {
      data = {}
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}
    let folder: string | null = typeof data.folder === 'string' && data.folder.trim() ? data.folder : null
    let files = this.dedupe(data.files ?? [], MAX_FILES)
    if (folder && isFile(folder)) {
      // a single file stored as "folder" (2.1 betas)
      files = this.dedupe([folder, ...files], MAX_FILES)
      folder = null
    }
    return {
      folder,
      files,
      recent: this.dedupe(data.recent ?? [], MAX_RECENT),
      favorites: this.dedupe(data.favorites ?? [], MAX_FAVORITES),
      sequence_favorites: this.slugs(data.sequence_favorites ?? [], MAX_SEQ_FAVORITES),
    }
  }

  private save(state: WorkspaceState): void {
    ensureRuntimeDirs(this.dirs)
    atomicWriteJson(this.stateFile(), state)
  }

  /** File types ScriptHub can run (the configured interpreters). */
  scriptExtensions(): Set<string> {
    return new Set(Object.keys(this.config.load().interpreters).map((k) => k.toLowerCase()))
  }

  /** The open folder (null when only files, or nothing, are open). */
  current(): string | null {
    return this.load().folder
  }

  openFiles(): string[] {
    return this.load().files
  }

  /** True when script files are open but no folder (New script then has nowhere to go). */
  currentIsFile(): boolean {
    const s = this.load()
    return !s.folder && s.files.length > 0
  }

  private inside(p: string, folder: string): boolean {
    const rel = path.relative(normcase(folder), normcase(p))
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }

  /** What to scan: the open folder, then each opened file not already inside it. */
  roots(): string[] {
    const s = this.load()
    const out: string[] = s.folder ? [s.folder] : []
    for (const f of s.files) if (!s.folder || !this.inside(f, s.folder)) out.push(f)
    return out
  }

  /**
   * Open an existing folder (replaces the open folder; opened files stay) or a script file with a
   * configured extension (added to the opened files). Goes first in the recent list.
   * Throws Error with a message for the user.
   */
  openFolder(value: string): string {
    const p = this.normalize(cleanDirectoryInput(value))
    const file = isFile(p)
    if (file) {
      if (!this.scriptExtensions().has(path.extname(p).toLowerCase()))
        throw new Error(`Not a script type ScriptHub can run (see Settings, Interpreters): ${path.basename(p)}`)
    } else if (!isDirectory(p)) throw new Error(`Not an existing folder or script file: ${p}`)
    const s = this.load()
    if (file) s.files = this.dedupe([...s.files, p], MAX_FILES)
    else s.folder = p
    s.recent = this.dedupe([p, ...s.recent], MAX_RECENT)
    this.save(s)
    return p
  }

  closeFolder(): void {
    const s = this.load()
    s.folder = null
    this.save(s)
  }

  /** Close an opened script file (not one that is part of the open folder). */
  closeFile(value: string): boolean {
    const s = this.load()
    const rest = s.files.filter((p) => !this.same(p, value))
    if (rest.length === s.files.length) return false
    s.files = rest
    this.save(s)
    return true
  }

  closeAllFiles(): void {
    const s = this.load()
    s.files = []
    this.save(s)
  }

  setFavorite(value: string, on: boolean): string {
    const p = this.normalize(value)
    const s = this.load()
    const rest = s.favorites.filter((q) => !this.same(q, p))
    s.favorites = on ? this.dedupe([...rest, p], MAX_FAVORITES) : rest
    this.save(s)
    return p
  }

  sequenceFavorites(): string[] {
    return this.load().sequence_favorites
  }

  setSequenceFavorite(slug: string, on: boolean): void {
    const s = this.load()
    const rest = s.sequence_favorites.filter((x) => x !== slug)
    s.sequence_favorites = on ? this.slugs([...rest, slug], MAX_SEQ_FAVORITES) : rest
    this.save(s)
  }

  /** Remove a folder from the recent list (not from favourites, not the open one). */
  forget(value: string): void {
    const s = this.load()
    s.recent = s.recent.filter((p) => !this.same(p, value))
    this.save(s)
  }

  /** The open folder and the lists, with existence and favourite flags. */
  overview() {
    const s = this.load()
    const favs = s.favorites
    const item = (p: string) => ({
      path: p,
      name: path.basename(p) || p,
      exists: fs.existsSync(p),
      is_file: isFile(p),
      favorite: favs.some((f) => this.same(p, f)),
      is_open: (!!s.folder && this.same(p, s.folder)) || s.files.some((f) => this.same(p, f)),
    })
    return {
      folder: s.folder ? item(s.folder) : null,
      files: s.files.map(item),
      favorites: favs.map(item),
      recent: s.recent.filter((p) => !favs.some((f) => this.same(p, f))).map(item),
    }
  }

  /** Sub-folders and script files of `value` for the in-page browser. Empty value: drives / home. */
  browse(value: string): BrowseResult {
    const places = [{ path: os.homedir(), name: 'Home' }]
    if (process.platform === 'win32') {
      for (const d of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (isDirectory(`${d}:\\`)) places.push({ path: `${d}:\\`, name: `${d}:` })
    } else places.push({ path: '/', name: '/' })

    let dir: string | null = null
    if (value) {
      try {
        const p = this.normalize(value)
        if (isDirectory(p)) dir = p
      } catch {
        dir = null
      }
    }
    if (dir === null) return { path: '', parent: '', dirs: [], files: [], places, crumbs: [], error: '' }

    const dirs: Array<{ path: string; name: string }> = []
    const files: Array<{ path: string; name: string }> = []
    let error = ''
    const exts = this.scriptExtensions()
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name.startsWith('$')) continue
        try {
          if (e.isDirectory()) dirs.push({ path: path.join(dir, e.name), name: e.name })
          else if (exts.has(path.extname(e.name).toLowerCase())) files.push({ path: path.join(dir, e.name), name: e.name })
        } catch {
          continue
        }
      }
    } catch (e: any) {
      error = `Cannot list this folder: ${e?.message ?? e}`
    }
    const byName = (a: { name: string }, b: { name: string }) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    dirs.sort(byName)
    files.sort(byName)
    const crumbs: Array<{ path: string; name: string }> = []
    for (let p = dir; ; p = path.dirname(p)) {
      crumbs.unshift({ path: p, name: path.basename(p) || p })
      if (path.dirname(p) === p) break
    }
    const parentDir = path.dirname(dir)
    return {
      path: dir, parent: parentDir !== dir ? parentDir : '', dirs: dirs.slice(0, 500), files: files.slice(0, 500),
      more: dirs.length > 500, places, crumbs, error,
    }
  }
}
