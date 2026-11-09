/**
 * ScriptHub project files (.scripthub): a folder's scripts and files, its sequences and presets in one zip.
 * Port of runner/project_files.py (see its docstring for the format) and the engine parts of project_views.py.
 *
 * The archive is untrusted when opened: names that leave the archive (absolute, drive, `..`, links), oversized or
 * over-compressed members and a manifest that does not match the contents are refused.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unzipSync, zipSync, type Zippable } from 'fflate'
import type { ConfigStore } from './config.js'
import { isDirectory, isFile } from './fsutil.js'
import type { Presets } from './presets.js'
import { headerText } from './presets.js'
import { resolveLoose } from './metadata.js'
import type { DataDirs } from './paths.js'
import { cleanDirectoryInput } from './security.js'
import { nowIso, NAME_MAX, parseText, dumpText, SequenceError, type ScriptLike, type Sequences } from './sequences.js'
import * as sshHosts from './sshHosts.js'
import * as yamlish from './yamlish.js'
import { MAX_DEPTH } from './discovery.js'

export const EXT = '.scripthub'
export const FORMAT = 'scripthub-project'
export const VERSION = 1
export const MAX_FILES = 5000
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024
export const MAX_RATIO = 200 // uncompressed / compressed, for members above 1 MB
export const UPLOAD_TTL_MS = 24 * 3600 * 1000
export const SKIP_DIRS = new Set(['__pycache__', 'node_modules', 'venv', '.venv', 'env', '.git', '.svn', '.hg', '.idea', '.vscode'])
export const SECRET_RE = /(^\.env($|\.)|\.(pem|key|pfx|p12|jks|keystore|kdbx|ppk)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|^secrets?\.(txt|json|ya?ml|ini)$)/i
const SKIP_FILE_RE = /\.(pyc|pyo)$/i
const TOP = ['files/', 'sequences/', 'presets/']
const ABS_RE = /^([A-Za-z]:[\\/]|\\\\|\/[A-Za-z0-9_.-]+\/)/

export class ProjectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectError'
  }
}

/** A file-name-safe version of the project name. */
export function slugName(name: string): string {
  const s = (name ?? '').replace(/[^A-Za-z0-9._ -]+/g, '').replace(/^[ .]+|[ .]+$/g, '')
  return s.replace(/\s+/g, ' ').slice(0, 60) || 'project'
}

const sha = (data: Uint8Array | string): string => crypto.createHash('sha256').update(data).digest('hex')

function real(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return resolveLoose(p)
  }
}

export function isInside(child: string, root: string): boolean {
  const a = process.platform === 'win32' ? real(child).toLowerCase() : real(child)
  const b = process.platform === 'win32' ? real(root).toLowerCase() : real(root)
  const rel = path.relative(b, a)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export interface FolderFile { path: string; size: number; isScript: boolean }
export interface LeftOut { path: string; reason: string }
export interface BuildReport { files: number; scripts: number; sequences: number; presets: number; missing: string[]; outside: string[] }
export interface Preview {
  name: string; created_at: string; scripthub: string; folder: string; files: number; scripts: number; file_list: string[]
  sequences: Array<{ name: string; as: string; steps: number }>; presets: number; warnings: string[]
}
export interface InstallResult { folder: string; files: number; sequences: string[]; presets: number; kept: string[]; warnings: string[] }

export interface ProjectDeps {
  dirs: DataDirs
  config: ConfigStore
  discovery: { loadFile(file: string): ScriptLike | null; rescan?(): Promise<unknown> }
  workspace: { current(): string | null; closeFolder(): void; closeAllFiles(): void }
  sequences: Sequences
  presets: Presets
  /** The program's own folder: a default destination is never put inside it. */
  appDir: string
  /** Folder of the shipped sample projects (`*.scripthub`). */
  samplesDir?: string
  appVersion?: string
  homeDir?: string
  now?: () => Date
}

// ------------------------------------------------------------- zip reading ---
interface Info { name: string; compressed: number; size: number; attr: number }

/** The zip's central directory (names, sizes, attributes), without trusting anything else in the file. */
function centralDirectory(buf: Uint8Array): Info[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('no end of central directory')
  const count = dv.getUint16(eocd + 10, true)
  let off = dv.getUint32(eocd + 16, true)
  const out: Info[] = []
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || dv.getUint32(off, true) !== 0x02014b50) throw new Error('bad central directory')
    const nameLen = dv.getUint16(off + 28, true)
    const extraLen = dv.getUint16(off + 30, true)
    const commentLen = dv.getUint16(off + 32, true)
    out.push({
      compressed: dv.getUint32(off + 20, true), size: dv.getUint32(off + 24, true), attr: dv.getUint32(off + 38, true),
      name: new TextDecoder('utf-8').decode(buf.subarray(off + 46, off + 46 + nameLen)),
    })
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function checkName(name: string): string[] {
  const bad = () => new ProjectError(`Unsafe name in the project file: ${JSON.stringify(name)}`)
  if (!name || name.includes('\\') || name.startsWith('/') || name.includes('\0')) throw bad()
  const parts = name.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..') || parts[0].includes(':')) throw bad()
  if (!(name === 'manifest.json' || TOP.some((t) => name.startsWith(t)))) throw new ProjectError(`Unexpected entry in the project file: ${JSON.stringify(name)}`)
  return parts
}

class Archive {
  constructor(private buf: Uint8Array, readonly infos: Map<string, Info>, readonly manifest: Record<string, any>) {}

  read(name: string, sha256?: string): Uint8Array {
    const info = this.infos.get(name)
    if (!info) throw new ProjectError(`The project file lacks ${name}.`)
    let data: Uint8Array | undefined
    try {
      data = unzipSync(this.buf, { filter: (f) => f.name === name && f.originalSize <= MAX_FILE_BYTES })[name]
    } catch (e: any) {
      throw new ProjectError(`${name} cannot be unpacked (${e?.message ?? e}).`)
    }
    if (!data) throw new ProjectError(`The project file lacks ${name}.`)
    if (data.length > MAX_FILE_BYTES) throw new ProjectError(`A file is too large: ${name}`)
    if (sha256 && sha(data) !== sha256) throw new ProjectError(`${name} does not match the manifest: the project file is damaged or was changed.`)
    return data
  }
}

/** Every structural check; returns the archive and its manifest. Throws ProjectError. */
function openZip(buf: Uint8Array): Archive {
  let list: Info[]
  try {
    if (buf.length < 22) throw new Error('too small')
    list = centralDirectory(buf)
  } catch (e: any) {
    throw new ProjectError(`Not a ScriptHub project file (${e?.message ?? e}).`)
  }
  const infos = new Map<string, Info>()
  const seen = new Set<string>()
  let total = 0
  for (const info of list) {
    if (info.name.endsWith('/')) continue // a directory entry
    checkName(info.name)
    if (((info.attr >>> 16) & 0o170000) === 0o120000) throw new ProjectError(`The project file holds a link: ${info.name}`)
    const key = info.name.toLowerCase()
    if (seen.has(key)) throw new ProjectError(`A name is in the project file twice: ${info.name}`)
    seen.add(key)
    if (info.size > MAX_FILE_BYTES) throw new ProjectError(`A file is too large: ${info.name}`)
    if (info.size > 1024 * 1024 && info.size > MAX_RATIO * Math.max(1, info.compressed))
      throw new ProjectError(`A file is compressed suspiciously well: ${info.name}`)
    total += info.size
    infos.set(info.name, info)
  }
  if (infos.size > MAX_FILES + 2000) throw new ProjectError('The project file holds too many files.')
  if (total > MAX_TOTAL_BYTES) throw new ProjectError('The project file is too large when unpacked.')
  if (!infos.has('manifest.json')) throw new ProjectError('Not a ScriptHub project file (no manifest.json).')
  const archive = new Archive(buf, infos, {})
  let manifest: any
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(archive.read('manifest.json')))
  } catch (e) {
    if (e instanceof ProjectError) throw e
    throw new ProjectError("The project's manifest.json cannot be read.")
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.format !== FORMAT)
    throw new ProjectError('Not a ScriptHub project file (unknown format).')
  if (!Number.isInteger(manifest.version) || manifest.version > VERSION)
    throw new ProjectError('This project file was made by a newer ScriptHub: update ScriptHub to open it.')
  for (const k of ['files', 'sequences', 'presets']) if (!Array.isArray(manifest[k])) throw new ProjectError(`The project's manifest has no '${k}' list.`)
  return new Archive(buf, infos, manifest)
}

interface Entries { files: any[]; seqs: any[]; pres: any[] }

/** Validated files, sequences and presets lists of the manifest. */
function entries(manifest: Record<string, any>): Entries {
  const files: any[] = []
  for (const f of manifest.files) {
    if (f === null || typeof f !== 'object' || typeof f.path !== 'string') throw new ProjectError("The project's manifest lists a file without a path.")
    checkName('files/' + f.path)
    files.push(f)
  }
  const ok = (x: any) => x !== null && typeof x === 'object' && typeof x.file === 'string'
  const seqs = manifest.sequences.filter(ok)
  const pres = manifest.presets.filter(ok)
  for (const item of [...seqs, ...pres]) checkName(item.file)
  return { files, seqs, pres }
}

/** `name`, or "name (2)", "name (3)" ... when taken (case-insensitive); records the result. */
function freeName(name: string, taken: Set<string>): string {
  let out = name
  let n = 2
  while (taken.has(out.toLowerCase())) {
    const suffix = ` (${n})`
    out = name.slice(0, NAME_MAX - suffix.length) + suffix
    n++
  }
  taken.add(out.toLowerCase())
  return out
}

/** `name`, or name_2.ext, name_3.ext ... when taken (case-insensitive); records the result. */
function unique(name: string, taken: Set<string>): string {
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  let out = name
  let n = 2
  while (taken.has(out.toLowerCase())) out = `${stem.slice(0, 50)}_${n++}${ext}`
  taken.add(out.toLowerCase())
  return out
}

export class ProjectFiles {
  constructor(private d: ProjectDeps) {}

  importsDir(): string {
    return this.d.dirs.imports
  }

  private scriptExts(): Set<string> {
    return new Set(Object.keys(this.d.config.load().interpreters).map((e) => e.toLowerCase()))
  }

  // ------------------------------------------------------------------ save ---
  /** What a project of `root` would hold: files (relative posix path, size, is script) and what is left out and why. */
  folderFiles(root: string): { included: FolderFile[]; leftOut: LeftOut[] } {
    const exts = this.scriptExts()
    const included: FolderFile[] = []
    const leftOut: LeftOut[] = []
    const walk = (dir: string, relDir: string[]) => {
      let ents: fs.Dirent[]
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      const isDirEntry = (e: fs.Dirent) => e.isDirectory() || (e.isSymbolicLink() && isDirectory(path.join(dir, e.name)))
      const dirnames = ents.filter(isDirEntry).map((e) => e.name).sort()
      const filenames = ents.filter((e) => !isDirEntry(e)).map((e) => e.name).sort()
      const keep: string[] = []
      for (const d of dirnames) {
        const rel = [...relDir, d].join('/') + '/'
        if (d.startsWith('.') || d.startsWith('$') || SKIP_DIRS.has(d)) leftOut.push({ path: rel, reason: 'tool or hidden folder' })
        else if (relDir.length >= MAX_DEPTH) leftOut.push({ path: rel, reason: `more than ${MAX_DEPTH} folder levels deep` })
        else if (fs.lstatSync(path.join(dir, d)).isSymbolicLink()) leftOut.push({ path: rel, reason: 'a link' })
        else keep.push(d)
      }
      for (const f of filenames) {
        const p = path.join(dir, f)
        const rel = [...relDir, f].join('/')
        if (SECRET_RE.test(f)) leftOut.push({ path: rel, reason: 'may hold secrets' })
        else if (f.startsWith('.') || SKIP_FILE_RE.test(f)) leftOut.push({ path: rel, reason: 'hidden or compiled file' })
        else if (fs.lstatSync(p).isSymbolicLink()) leftOut.push({ path: rel, reason: 'a link' })
        else {
          let size: number
          try {
            size = fs.statSync(p).size
          } catch {
            leftOut.push({ path: rel, reason: 'cannot be read' })
            continue
          }
          if (size > MAX_FILE_BYTES) leftOut.push({ path: rel, reason: `larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB` })
          else included.push({ path: rel, size, isScript: exts.has(path.extname(f).toLowerCase()) })
        }
      }
      for (const d of keep) walk(path.join(dir, d), [...relDir, d])
    }
    walk(root, [])
    return { included, leftOut }
  }

  /** Every readable sequence, with `uses_folder`: a step's script is in `root` (those are offered ticked when saving). */
  sequencesFor(root: string): Array<{ slug: string; name: string; steps: number; uses_folder: boolean }> {
    const out = []
    for (const entry of this.d.sequences.list()) {
      if (entry.error) continue
      const data = this.d.sequences.get(entry.slug)
      if (!data) continue
      const uses = data.steps.some((step) => {
        const s = this.d.sequences.resolve(step)
        return s !== null && isInside(s.path, root)
      })
      out.push({ slug: entry.slug, name: data.name, steps: data.steps.length, uses_folder: uses })
    }
    return out
  }

  /**
   * Make the project file in memory. `files` = relative paths chosen from folderFiles(). The scripts the chosen
   * sequences use are always included (from outside the folder: under files/_outside/). Throws ProjectError.
   */
  build(root: string, name: string, files: string[], seqSlugs: string[], withPresets = true): { bytes: Uint8Array; report: BuildReport } {
    const included = new Map(this.folderFiles(root).included.map((f) => [f.path, f]))
    const chosen = files.filter((f) => included.has(f))
    const report: BuildReport = { files: 0, scripts: 0, sequences: 0, presets: 0, missing: [], outside: [] }
    const seqs: any[] = []
    const extra = new Map<string, string>() // archive path -> real path of a script outside the folder
    const taken = new Set(chosen.map((f) => f.toLowerCase()))
    const byReal = new Map<string, string>()
    const rootReal = real(root)
    for (const slug of seqSlugs) {
      const data = this.d.sequences.get(slug)
      if (!data) continue
      for (const step of data.steps) {
        const script = this.d.sequences.resolve(step)
        if (!script) {
          report.missing.push(`${data.name}: ${step.name || step.script}`)
          continue
        }
        const scriptReal = real(script.path)
        if (isInside(scriptReal, root)) {
          const rel = path.relative(rootReal, scriptReal).split(path.sep).join('/')
          if (!chosen.includes(rel) && included.has(rel)) {
            chosen.push(rel)
            taken.add(rel.toLowerCase())
          }
          step.path = 'files/' + rel
        } else {
          const key = scriptReal.toLowerCase()
          if (!byReal.has(key)) {
            const rel = '_outside/' + unique(path.basename(scriptReal), taken)
            byReal.set(key, rel)
            extra.set(rel, scriptReal)
            report.outside.push(scriptReal)
            const sidecar = scriptReal.slice(0, scriptReal.length - path.extname(scriptReal).length) + '.json' // an old sidecar travels along
            if (isFile(sidecar)) extra.set(rel.slice(0, rel.length - path.extname(rel).length) + '.json', sidecar)
          }
          step.path = 'files/' + byReal.get(key)
        }
        step.script = script.id
      }
      seqs.push(data)
    }

    if (chosen.length + extra.size > MAX_FILES) throw new ProjectError(`Too many files (at most ${MAX_FILES}).`)
    const total = chosen.reduce((n, f) => n + included.get(f)!.size, 0) + [...extra.values()].reduce((n, p) => n + fs.statSync(p).size, 0)
    if (total > MAX_TOTAL_BYTES) throw new ProjectError(`The files are larger than ${MAX_TOTAL_BYTES / (1024 * 1024)} MB together.`)

    const manifest: Record<string, any> = {
      format: FORMAT, version: VERSION, name, created_at: nowIso((this.d.now ?? (() => new Date()))()),
      scripthub: this.d.appVersion ?? '2.0', folder: path.basename(root), files: [], sequences: [], presets: [],
    }
    const zip: Zippable = {}
    const add = (arc: string, data: Uint8Array) => {
      zip[arc] = [data, { level: 6, mtime: (this.d.now ?? (() => new Date()))() }]
    }
    const exts = this.scriptExts()
    const sources: Array<[string, string]> = [...chosen].sort().map((rel) => [rel, path.join(root, ...rel.split('/'))] as [string, string])
    sources.push(...[...extra.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
    for (const [rel, file] of sources) {
      const data = fs.readFileSync(file)
      add('files/' + rel, data)
      const isScript = exts.has(path.extname(rel).toLowerCase())
      manifest.files.push({ path: rel, size: data.length, sha256: sha(data), script: isScript })
      report.files++
      report.scripts += isScript ? 1 : 0
    }
    for (const data of seqs) {
      const body = dumpText(data)
      add(`sequences/${data.slug}.yaml`, Buffer.from(body, 'utf8'))
      manifest.sequences.push({ file: `sequences/${data.slug}.yaml`, name: data.name, steps: data.steps.length, sha256: sha(body) })
      report.sequences++
    }
    if (withPresets) {
      const used = new Set<string>()
      let n = 0
      for (const [rel, file] of sources) {
        if (!exts.has(path.extname(rel).toLowerCase())) continue
        const script = this.d.discovery.loadFile(file)
        if (!script || used.has(script.id)) continue
        used.add(script.id)
        const pfolder = this.d.presets.folder({ id: script.id, path: script.path })
        if (!isDirectory(pfolder)) continue
        for (const pf of fs.readdirSync(pfolder).filter((f) => f.endsWith('.yaml')).sort()) {
          let body: Buffer
          try {
            // written anew: the header names the file here, not its full local path
            let text = fs.readFileSync(path.join(pfolder, pf), 'utf8')
            if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
            body = Buffer.from(yamlish.dump(yamlish.load(text), headerText(rel)), 'utf8')
          } catch {
            continue // an unreadable preset stays behind
          }
          n++
          const arc = `presets/${n}/${pf}`
          add(arc, body)
          manifest.presets.push({ file: arc, script: rel, sha256: sha(body) })
          report.presets++
        }
      }
    }
    add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
    return { bytes: zipSync(zip), report }
  }

  /**
   * The project of the open folder with the default contents (every file of the folder with secrets and tool folders
   * left out, the sequences that use its scripts and the scripts they need, the presets) - what File > Save project
   * writes. `name`: the project name (a file name typed in the Save dialog; an extension is dropped).
   */
  saveCurrent(name = ''): { bytes: Uint8Array; fileName: string; report: BuildReport; summary: string } {
    const root = this.d.workspace.current()
    if (!root) throw new ProjectError("Open a folder first: a project file holds the open folder's scripts and files.")
    let n = name.split(/\s+/).filter(Boolean).join(' ').slice(0, 80)
    if (n.toLowerCase().endsWith(EXT)) n = n.slice(0, n.length - EXT.length)
    n = n || path.basename(root)
    const { included } = this.folderFiles(root)
    const slugs = this.sequencesFor(root).filter((s) => s.uses_folder).map((s) => s.slug)
    const { bytes, report } = this.build(root, n, included.map((f) => f.path), slugs, true)
    return {
      bytes, report, fileName: slugName(n) + EXT,
      summary: `${report.files} files (${report.scripts} scripts), ${report.sequences} sequences, ${report.presets} presets`,
    }
  }

  // ------------------------------------------------------------------ open ---
  /** Check a project file (its bytes) and describe what opening it would do. Writes nothing. */
  inspectBytes(buf: Uint8Array, fallbackName = 'project'): Preview {
    const z = openZip(buf)
    const { files, seqs, pres } = entries(z.manifest)
    for (const f of files) z.read('files/' + f.path, f.sha256)
    const taken = new Set(this.d.sequences.list().map((s) => s.name.toLowerCase()))
    const hosts = new Set(sshHosts.allowedHosts())
    const rows: Preview['sequences'] = []
    const warnings: string[] = []
    for (const s of seqs) {
      const body = new TextDecoder().decode(z.read(s.file, s.sha256))
      let data
      try {
        data = parseText(body)
      } catch (e) {
        if (e instanceof SequenceError) throw new ProjectError(`${s.file} cannot be read: ${e.message}`)
        throw e
      }
      rows.push({ name: data.name, as: freeName(data.name, taken), steps: data.steps.length })
      data.steps.forEach((step, i) => {
        const label = `${data.name}, step ${i + 1} (${step.name || step.script})`
        if (!String(step.path ?? '').startsWith('files/')) warnings.push(`${label}: its script is not in the project; it needs to be on this computer.`)
        if (step.host && !hosts.has(step.host)) warnings.push(`${label}: host '${step.host}' is not in this ScriptHub's settings.`)
        for (const [k, v] of Object.entries(step.values ?? {}))
          if (typeof v === 'string' && ABS_RE.test(v) && !fs.existsSync(v)) warnings.push(`${label}: ${k} = ${v} does not exist on this computer.`)
      })
    }
    for (const p of pres) z.read(p.file, p.sha256)
    const m = z.manifest
    return {
      name: String(m.name || fallbackName), created_at: String(m.created_at || '').replace('T', ' '), scripthub: String(m.scripthub || ''),
      folder: String(m.folder || ''), files: files.length, scripts: files.filter((f) => f.script).length,
      file_list: files.map((f) => f.path), sequences: rows, presets: pres.length, warnings,
    }
  }

  inspect(file: string): Preview {
    return this.inspectBytes(readProject(file), path.basename(file, path.extname(file)))
  }

  /** The folder to unpack into: absolute, and missing or empty. Throws ProjectError. */
  checkDestination(value: string): string {
    let dest: string
    try {
      dest = cleanDirectoryInput(value || '')
    } catch (e: any) {
      throw new ProjectError(e.message)
    }
    if (!path.isAbsolute(dest) || (process.platform === 'win32' && !/^([A-Za-z]:|\\\\)/.test(dest)))
      throw new ProjectError('Choose a full folder path, e.g. C:\\ScriptHub\\My project.')
    if (fs.existsSync(dest) && (!isDirectory(dest) || fs.readdirSync(dest).length))
      throw new ProjectError(`${dest} is not empty: choose a new or empty folder (nothing is overwritten).`)
    if (isInside(dest, this.d.dirs.runtime)) throw new ProjectError("Choose a folder outside ScriptHub's runtime folder.")
    return dest
  }

  /** Unpack the project into `destination` and add its sequences and presets. Nothing runs; nothing is overwritten. */
  installBytes(buf: Uint8Array, destination: string): InstallResult {
    const dest = this.checkDestination(destination)
    const preview = this.inspectBytes(buf) // every check again, right before writing
    const z = openZip(buf)
    const result: InstallResult = { folder: dest, files: 0, sequences: [], presets: 0, kept: [], warnings: preview.warnings }
    const { files, seqs, pres } = entries(z.manifest)
    fs.mkdirSync(dest, { recursive: true })
    for (const f of files) {
      const target = path.join(dest, ...f.path.split('/'))
      if (!isInside(target, dest)) throw new ProjectError(`Unsafe name in the project file: ${JSON.stringify(f.path)}`)
      const data = z.read('files/' + f.path, f.sha256)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, data, { flag: 'wx' }) // never overwrites
      result.files++
    }
    const scriptAt = (rel: string) => this.d.discovery.loadFile(path.join(dest, ...rel.split('/')))
    const taken = new Set(this.d.sequences.list().map((s) => s.name.toLowerCase()))
    for (const s of seqs) {
      const data = parseText(new TextDecoder().decode(z.read(s.file, s.sha256)))
      for (const step of data.steps) {
        const p = String(step.path ?? '')
        if (p.startsWith('files/')) {
          const script = scriptAt(p.slice('files/'.length))
          if (script) Object.assign(step, { script: script.id, path: script.path, name: script.name })
          else step.path = path.join(dest, ...p.slice('files/'.length).split('/'))
        }
      }
      data.name = freeName(data.name, taken)
      result.sequences.push(this.d.sequences.addImported(data))
    }
    for (const p of pres) {
      const script = scriptAt(String(p.script ?? ''))
      if (!script) continue
      const body = z.read(p.file, p.sha256)
      try {
        yamlish.load(new TextDecoder('utf-8', { fatal: true }).decode(body).replace(/^\uFEFF/, ''))
      } catch {
        result.kept.push(`${p.file}: not readable, skipped`)
        continue
      }
      const target = path.join(this.d.presets.folder({ id: script.id, path: script.path }), path.posix.basename(p.file))
      if (fs.existsSync(target)) {
        result.kept.push(`${script.name}: preset ${path.basename(target, path.extname(target))} exists already, yours is kept`)
        continue
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, body)
      result.presets++
    }
    return result
  }

  install(file: string, destination: string): InstallResult {
    return this.installBytes(readProject(file), destination)
  }

  // --------------------------------------------------------------- uploads ---
  /** The uploads folder, without uploads older than a day. */
  private imports(): string {
    const folder = this.importsDir()
    fs.mkdirSync(folder, { recursive: true })
    const now = Date.now()
    for (const f of fs.readdirSync(folder)) {
      if (!f.endsWith(EXT)) continue
      try {
        if (now - fs.statSync(path.join(folder, f)).mtimeMs > UPLOAD_TTL_MS) fs.unlinkSync(path.join(folder, f))
      } catch {
        /* ignore */
      }
    }
    return folder
  }

  /** Keep a chosen project file (its bytes) for its preview and install; returns a token. */
  saveUpload(data: Uint8Array): string {
    if (data.length > MAX_TOTAL_BYTES) throw new ProjectError('The project file is too large.')
    const folder = this.imports()
    const token = crypto.randomBytes(12).toString('hex')
    fs.writeFileSync(path.join(folder, token + EXT), data)
    return token
  }

  /** Keep a project file from disk (File > Open project). */
  saveUploadFromFile(file: string): string {
    try {
      if (fs.statSync(file).size > MAX_TOTAL_BYTES) throw new ProjectError('The project file is too large.')
      return this.saveUpload(fs.readFileSync(file))
    } catch (e: any) {
      if (e instanceof ProjectError) throw e
      throw new ProjectError(`The project file cannot be read: ${e?.message ?? e}`)
    }
  }

  /** The project files that come with ScriptHub: [{name}]. */
  sampleProjects(): Array<{ name: string }> {
    const dir = this.d.samplesDir
    if (!dir || !isDirectory(dir)) return []
    return fs.readdirSync(dir).filter((f) => f.endsWith(EXT) && isFile(path.join(dir, f))).sort().map((f) => ({ name: f.slice(0, -EXT.length) }))
  }

  /** Treat a sample project like an upload (preview, then install); returns a token. Only names, never a path. */
  importSample(name: string): string {
    const match = this.sampleProjects().find((s) => s.name === name)
    if (!match || !this.d.samplesDir) throw new ProjectError('That sample project does not exist.')
    const token = crypto.randomBytes(12).toString('hex')
    fs.copyFileSync(path.join(this.d.samplesDir, match.name + EXT), path.join(this.imports(), token + EXT))
    return token
  }

  uploadPath(token: string): string {
    const msg = 'That upload is no longer available: choose the project file again.'
    if (typeof token !== 'string' || !/^[0-9a-f]{24}$/.test(token)) throw new ProjectError(msg)
    const p = path.join(this.importsDir(), token + EXT)
    if (!isFile(p)) throw new ProjectError(msg)
    return p
  }

  forgetUpload(token: string): void {
    try {
      fs.unlinkSync(this.uploadPath(token))
    } catch {
      /* gone already */
    }
  }

  /**
   * A new folder named after the project, next to the open folder; in ~/ScriptHub projects when nothing is open or the
   * open folder is part of ScriptHub's own code (e.g. the sample scripts).
   */
  defaultDestination(name: string): string {
    const base = this.d.workspace.current()
    let parent: string | null = base ? path.dirname(base) : null
    if (parent === null || isInside(parent, this.d.appDir)) parent = path.join(this.d.homeDir ?? os.homedir(), 'ScriptHub projects')
    let candidate = path.join(parent, slugName(name))
    for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(parent, `${slugName(name)} (${n})`)
    return candidate
  }

  /** File > Close project: close the folder and every opened file (stored data is kept). */
  async closeProject(): Promise<void> {
    this.d.workspace.closeFolder()
    this.d.workspace.closeAllFiles()
    await this.d.discovery.rescan?.()
  }
}

function readProject(file: string): Uint8Array {
  try {
    return fs.readFileSync(file)
  } catch (e: any) {
    throw new ProjectError(`Not a ScriptHub project file (${e?.message ?? e}).`)
  }
}
