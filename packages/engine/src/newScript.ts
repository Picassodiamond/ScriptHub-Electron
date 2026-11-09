/**
 * New script: create a file (from a short starter, with its metadata block at the top) in the open script
 * folder. Port of runner/new_views.py (the engine part; the page is the UI's job).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Config, ConfigStore } from './config.js'
import { languageOf, MAX_DEPTH, relativePath, type Discovery, type Script } from './discovery.js'
import { isDirectory } from './fsutil.js'
import { pathId } from './ids.js'
import { withBlock, withId } from './metadata.js'
import { isWithin } from './security.js'
import { CRLF_EXTENSIONS, normaliseText } from './scriptEditor.js'
import type { Workspace } from './workspace.js'

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/
export const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,60}$/

export const STARTERS: Record<string, string> = {
  '.py': 'import sys\n\nprint("Hello from ScriptHub")\nprint("arguments:", sys.argv[1:])\n',
  '.sh': '#!/usr/bin/env bash\nset -euo pipefail\n\necho "Hello from $(hostname)"\necho "arguments: $*"\n',
  '.bat': '@echo off\r\necho Hello from ScriptHub\r\necho arguments: %*\r\n',
}

/** A message for the user (bad name, existing file, ...). */
export class NewScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NewScriptError'
  }
}

/** [extension, label] for every script type that can run somewhere. */
export function languages(cfg: Config): Array<[string, string]> {
  const exts = [...new Set([...Object.keys(cfg.interpreters), ...Object.keys(cfg.remote_interpreters)])].sort()
  return exts.map((e) => [e, languageOf(e)[1]])
}

/** Existing sub-folders and categories of the open folder (for the suggestions). */
export function suggestions(scripts: Script[]): { folders: string[]; categories: string[] } {
  const ci = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase())
  const folders = [...new Set(scripts.map((s) => path.posix.dirname(relativePath(s))))].filter((f) => f !== '.').sort(ci)
  const categories = [...new Set(scripts.map((s) => s.category).filter(Boolean))].sort(ci)
  return { folders, categories }
}

/** Python's str.title() for plain names. */
const titleCase = (s: string): string => s.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())

/**
 * Write a new script and its metadata under `root`. Throws NewScriptError (message for the user).
 * Never overwrites: the file is opened with 'wx'.
 */
export function createScript(root: string, ext: string, filename: string, subfolder: string, name = '', category = ''): string {
  ext = ext.toLowerCase()
  filename = filename.trim()
  if (filename.toLowerCase().endsWith(ext)) filename = filename.slice(0, filename.length - ext.length)
  if (!NAME_RE.test(filename))
    throw new NewScriptError('The file name may contain letters, digits, dots, hyphens and underscores, and must start with a letter or digit.')
  const rawSub = subfolder.trim()
  const parts = rawSub.split(/[\\/]+/).filter(Boolean)
  if (rawSub[0] === '/' || rawSub[0] === '\\' || /^[A-Za-z]:/.test(rawSub))
    throw new NewScriptError('Give the sub-folder relative to the script folder (no leading slash or drive).')
  if (parts.some((p) => !FOLDER_RE.test(p) || p === '.' || p === '..'))
    throw new NewScriptError('The sub-folder may only contain letters, digits, spaces, dots, hyphens and underscores.')
  if (parts.length > MAX_DEPTH)
    throw new NewScriptError(`The sub-folder may be at most ${MAX_DEPTH} levels deep (deeper folders are not scanned for scripts).`)
  let resolved: string
  try {
    resolved = fs.realpathSync.native(root)
  } catch {
    resolved = path.resolve(root)
  }
  const folder = parts.length ? path.join(resolved, ...parts) : resolved
  const target = path.join(folder, `${filename}${ext}`)
  if (!isDirectory(resolved) || !isWithin(folder, resolved)) throw new NewScriptError('That location is outside the script folder.')
  if (fs.existsSync(target))
    throw new NewScriptError(`${path.basename(target)} already exists there; pick another name. Existing files are never overwritten.`)
  const meta: Record<string, any> = {
    name: (name.trim() || titleCase(filename.replaceAll('_', ' ').replaceAll('-', ' '))).slice(0, 120),
    description: '',
    parameters: [],
  }
  if (category.trim()) meta.category = category.trim().slice(0, 60)
  const withIdData = withId(meta) // a new script gets its stable id right away
  const newline = CRLF_EXTENSIONS.includes(ext) ? '\r\n' : '\n'
  const text = withBlock(normaliseText(STARTERS[ext] ?? '', ext), withIdData, target, newline)
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.from(text, 'utf8'), { flag: 'wx' }) // one write: starter + metadata block, never overwrites
  } catch (e: any) {
    if (e?.code === 'EEXIST') throw new NewScriptError(`${path.basename(target)} already exists there; pick another name.`)
    throw new NewScriptError(`Could not create the script: ${e?.message ?? e}`)
  }
  return target
}

export interface NewScriptForm { language: string; filename: string; subfolder: string; name?: string; category?: string }

export interface NewScriptDeps { workspace: Workspace; config: ConfigStore; discovery: Discovery }

/** The New script use case: checks the settings and the open folder, creates the file, refreshes discovery. */
export class NewScript {
  constructor(private d: NewScriptDeps) {}

  languages(): Array<[string, string]> {
    return languages(this.d.config.load())
  }

  /** Why New script is unavailable, or null. */
  blocked(): string | null {
    if (!this.d.config.load().enable_script_editing) return 'Creating and editing scripts from the browser is turned off in Settings.'
    const root = this.d.workspace.current()
    if (!root || !isDirectory(root))
      return this.d.workspace.currentIsFile()
        ? 'Only script files are open; open a folder to create new scripts in it.'
        : 'Open a script folder first; new scripts are saved in it.'
    return null
  }

  /** Form defaults for "+" next to a script: the same folder, language and category. */
  defaultsFrom(base: Script | null): Required<Omit<NewScriptForm, 'language'>> & { language: string } {
    const form = { language: '.py', filename: '', subfolder: '', name: '', category: '' }
    if (base) {
      const sub = path.posix.dirname(relativePath(base))
      form.language = base.extension
      form.subfolder = sub === '.' ? '' : sub
      form.category = base.metaValid ? base.meta.category ?? '' : ''
    }
    return form
  }

  /** Create the script; returns its path and the id it is known by. Throws NewScriptError. */
  async create(form: NewScriptForm): Promise<{ path: string; id: string }> {
    const reason = this.blocked()
    if (reason) throw new NewScriptError(reason)
    if (!this.languages().some(([e]) => e === form.language.toLowerCase())) throw new NewScriptError('Choose a language from the list.')
    const root = this.d.workspace.current()!
    const target = createScript(root, form.language, form.filename, form.subfolder, form.name ?? '', form.category ?? '')
    this.d.discovery.updateFile(target)
    const real = fs.realpathSync.native(target)
    const found = (await this.d.discovery.scan()) [0].find((s) => s.path === real || s.path === target)
    return { path: target, id: found?.id ?? pathId(real) }
  }
}
