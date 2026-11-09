/**
 * Safe editing of catalogued script files. Port of runner/script_editor.py.
 *
 * - Only a path inside the given root is written.
 * - Saves are atomic; the previous version is kept in runtime/backups/<script id>/, never next to the script.
 * - A save is refused when the file changed on disk since it was opened (`baseHash`), unless forced.
 * - Line endings: `.bat` -> CRLF, `.sh` -> LF, others keep what the file used.
 * - Only UTF-8 text up to 512 KB is editable.
 * - After saving, a quick syntax check (never executing the script) gives warnings for Python and Bash.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { BackupError, Backups, isFsError, writeBytesAtomic } from './backups.js'
import { pathId } from './ids.js'
import { resolveLoose } from './metadata.js'

export const MAX_BYTES = 512 * 1024
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
export const CRLF_EXTENSIONS = ['.bat', '.cmd']
export const LF_EXTENSIONS = ['.sh', '.bash']

/** The file cannot be edited or saved (the message is shown to the user). */
export class EditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditError'
  }
}

/** The file changed on disk after it was opened. */
export class ConflictError extends EditError {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

export type NewlineStyle = 'crlf' | 'lf'

export interface EditInfo {
  text: string
  hash: string
  newline: NewlineStyle
  bom: boolean
  size: number
  writable: boolean
}

export interface SaveResult {
  changed: boolean
  warning: string | null
}

export function fileHash(data: Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** True if `child` resolves to a location inside `parent`. */
export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(resolveLoose(parent), resolveLoose(child))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

export function newlineStyle(data: Uint8Array): NewlineStyle {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let crlf = 0
  let lf = 0
  for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) {
    lf++
    if (i > 0 && buf[i - 1] === 0x0d) crlf++
  }
  return crlf > lf - crlf ? 'crlf' : 'lf'
}

/** Apply the line-ending policy to editor text. `ext` includes the dot. */
export function normaliseText(text: string, ext: string, originalStyle: NewlineStyle = 'lf'): string {
  text = text.replace(/\r\n|\r/g, '\n')
  ext = ext.toLowerCase()
  const style = CRLF_EXTENSIONS.includes(ext) ? 'crlf' : LF_EXTENSIONS.includes(ext) ? 'lf' : originalStyle
  return style === 'crlf' ? text.replaceAll('\n', '\r\n') : text
}

const PY_CHECK = `import sys
src = sys.stdin.buffer.read().decode("utf-8")
try:
    compile(src, "<script>", "exec")
except SyntaxError as exc:
    print("Python syntax error at line %s: %s" % (exc.lineno, exc.msg))
except ValueError as exc:
    print("Python could not parse this file: %s" % exc)
`

export interface EditorOptions {
  /** Python used for the syntax check of .py files (compile only, nothing runs). */
  python?: string
}

export class ScriptEditor {
  private python: string

  constructor(private backups: Backups, opts: EditorOptions = {}) {
    this.python = opts.python ?? (process.platform === 'win32' ? 'python' : 'python3')
  }

  hasBackup(sid: string): boolean {
    return this.backups.versions(sid).length > 0
  }

  private checkPath(file: string, root: string): void {
    if (!isWithin(file, root)) throw new EditError('This file is outside its configured script directory and cannot be edited.')
    let ok = false
    try {
      ok = fs.statSync(file).isFile()
    } catch {
      /* missing */
    }
    if (!ok) throw new EditError('The script file no longer exists.')
  }

  /** Load a script for the editor. Throws EditError if it cannot be edited. */
  readForEdit(file: string, root: string): EditInfo {
    this.checkPath(file, root)
    let data: Buffer
    try {
      data = fs.readFileSync(file)
    } catch (e: any) {
      throw new EditError(`Could not read the file: ${e.message}`)
    }
    if (data.length > MAX_BYTES) throw new EditError('This file is larger than 512 KB; open it in a real editor.')
    if (data.includes(0)) throw new EditError('This file looks binary and cannot be edited here.')
    const bom = data.subarray(0, 3).equals(BOM)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data.subarray(bom ? 3 : 0))
    } catch {
      throw new EditError('This file is not valid UTF-8, so it cannot be edited safely here.')
    }
    return {
      text: text.replace(/\r\n|\r/g, '\n'),
      hash: fileHash(data),
      newline: newlineStyle(data),
      bom,
      size: data.length,
      writable: writable(file),
    }
  }

  /** A human-readable syntax problem, or null. Never runs the script. */
  syntaxWarning(ext: string, text: string): string | null {
    ext = ext.toLowerCase()
    if (ext === '.py') {
      const done = spawnSync(this.python, ['-I', '-c', PY_CHECK], { input: Buffer.from(text, 'utf8'), timeout: 10_000, encoding: 'utf8' })
      if (done.error || done.status !== 0) return null // no Python to ask, or it failed: no warning
      const line = (done.stdout || '').trim()
      return line || null
    }
    if (LF_EXTENSIONS.includes(ext)) {
      const done = spawnSync('bash', ['-n'], { input: Buffer.from(text, 'utf8'), timeout: 10_000, encoding: 'utf8' })
      if (done.error || done.status === null) return null
      if (done.status !== 0) {
        const first = ((done.stderr || '').trim().split(/\r?\n/)[0]) || 'syntax error'
        return `Bash reports a syntax problem: ${first.replace('bash: ', '')}`
      }
    }
    return null
  }

  /** Keep `current` in runtime/backups/<sid>/ (moving an old <file>.bak in first), then write. */
  private writeWithBackup(file: string, newBytes: Uint8Array, current: Uint8Array, sid: string): void {
    try {
      this.backups.migrateSideBak(sid, file)
      this.backups.add(sid, path.basename(file), current)
    } catch (e: any) {
      if (isFsError(e) || e instanceof BackupError) throw new EditError(`Could not keep a backup, so nothing was saved: ${e.message}`)
      throw e
    }
    try {
      writeBytesAtomic(file, newBytes, file) // keeps the executable bit
    } catch (e: any) {
      if (e?.code === 'EPERM' || e?.code === 'EACCES') throw new EditError('The file or its folder is read-only, so it cannot be saved.')
      if (isFsError(e)) throw new EditError(`Could not save: ${e.message}`)
      throw e
    }
  }

  /** Save editor text. Returns {changed, warning}. */
  saveScript(file: string, root: string, text: string, baseHash: string, opts: { force?: boolean; sid?: string } = {}): SaveResult {
    this.checkPath(file, root)
    if (!writable(file)) throw new EditError('The file is read-only, so it cannot be saved.') // a rename would succeed even for a 0444 file in a writable folder
    let current: Buffer
    try {
      current = fs.readFileSync(file)
    } catch (e: any) {
      throw new EditError(`Could not read the file: ${e.message}`)
    }
    if (!opts.force && fileHash(current) !== baseHash)
      throw new ConflictError('The file was changed on disk after you opened it. Reload to see the new version, or overwrite it with yours.')
    if (text.includes('\0')) throw new EditError('The text contains a null character and cannot be saved.')
    const ext = path.extname(file)
    const body = Buffer.from(normaliseText(text, ext, newlineStyle(current)), 'utf8')
    if (body.length > MAX_BYTES) throw new EditError('The script would be larger than 512 KB; it was not saved.')
    const newBytes = Buffer.concat([current.subarray(0, 3).equals(BOM) ? BOM : Buffer.alloc(0), body])
    const warning = this.syntaxWarning(ext, body.toString('utf8'))
    if (newBytes.equals(current)) return { changed: false, warning }
    this.writeWithBackup(file, newBytes, current, opts.sid || pathIdOf(file))
    return { changed: true, warning }
  }

  /**
   * Put a backup back (`version` = its name, empty = the newest). What is there now is backed up first, so the
   * restore itself can be undone.
   */
  restoreBackup(file: string, root: string, opts: { sid?: string; version?: string } = {}): void {
    this.checkPath(file, root)
    if (!writable(file)) throw new EditError('The file is read-only, so it cannot be restored.')
    const sid = opts.sid || pathIdOf(file)
    this.backups.migrateSideBak(sid, file)
    let previous: Buffer
    let current: Buffer
    try {
      previous = this.backups.read(sid, opts.version ?? '')
      current = fs.readFileSync(file)
    } catch (e: any) {
      if (e instanceof BackupError) throw new EditError(e.message)
      if (isFsError(e)) throw new EditError(`Could not read the files: ${e.message}`)
      throw e
    }
    if (previous.equals(current)) throw new EditError('That version is the same as the current file.')
    this.writeWithBackup(file, previous, current, sid)
  }
}

function writable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function pathIdOf(file: string): string {
  return pathId(resolveLoose(file))
}
