/**
 * Previous versions of scripts, kept out of the script folders:
 *
 *     runtime/backups/<script id>/20261108-214512-123456__ping_host.bat
 *
 * Every save (editor, restore, metadata block) stores the version it replaces here; the newest KEEP per
 * script are kept. An old `<script>.bak` next to a script (before 2.1) is moved in on the script's next
 * save, and only removed once the copy reads back identical. Port of runner/backups.py.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DataDirs } from './paths.js'
import { sleepSync } from './fsutil.js'
import { valid as validId } from './ids.js'

export const KEEP = 10
const NAME_RE = /^(\d{8}-\d{6}-\d{6})__([^/\\]+)$/
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

/** True for errors the Python code treated as OSError (a Node system error carries a string `code`). */
export function isFsError(e: unknown): boolean {
  return typeof (e as any)?.code === 'string'
}

/**
 * Write `data` to `file` through a hidden temp file in the same folder, so readers never see a half-written
 * file; retries briefly where Windows refuses the rename. `modeFrom`: copy that file's permission bits.
 */
export function writeBytesAtomic(file: string, data: Uint8Array | string, modeFrom?: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.tmp-${crypto.randomBytes(6).toString('hex')}.part`)
  const fd = fs.openSync(tmp, 'w')
  try {
    try {
      fs.writeFileSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (modeFrom) {
      try {
        fs.chmodSync(tmp, fs.statSync(modeFrom).mode & 0o7777)
      } catch {
        /* keep the default mode */
      }
    }
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file)
        return
      } catch (e: any) {
        if (!RETRY_CODES.has(e?.code) || i >= 59) throw e
        sleepSync(25)
      }
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw e
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** `whenUs`: microseconds since the epoch (integer). Local time, like the Python app. */
function stamp(whenUs: number): string {
  const sec = Math.floor(whenUs / 1e6)
  const us = whenUs - sec * 1e6
  const d = new Date(sec * 1000)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(us, 6)}`
}

export interface BackupVersion {
  name: string
  when: string
  size: number
  file: string
}

export class Backups {
  constructor(private dirs: DataDirs) {}

  folder(sid: string): string {
    if (!validId(sid)) throw new BackupError('Invalid script id.')
    return path.join(this.dirs.backups, sid)
  }

  /** Keep `data` (a version of `scriptName`) as the newest backup and prune old ones. `whenMs`: epoch ms. */
  add(sid: string, scriptName: string, data: Uint8Array, whenMs?: number): string {
    const base = this.folder(sid)
    let whenUs = Math.round((whenMs ?? Date.now()) * 1000)
    let target = path.join(base, `${stamp(whenUs)}__${scriptName}`)
    while (fs.existsSync(target)) {
      // same microsecond: move on a tick
      whenUs += 1
      target = path.join(base, `${stamp(whenUs)}__${scriptName}`)
    }
    writeBytesAtomic(target, data)
    this.prune(sid)
    return target
  }

  private files(sid: string): string[] {
    let base: string
    try {
      base = this.folder(sid)
    } catch {
      return []
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((e) => e.isFile() && NAME_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse()
  }

  /** Newest first. */
  versions(sid: string): BackupVersion[] {
    const base = this.folderOrNull(sid)
    return this.files(sid).map((name) => {
      const [, stampText, original] = NAME_RE.exec(name)!
      const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-\d{6}$/.exec(stampText)!
      let size = 0
      try {
        size = fs.statSync(path.join(base!, name)).size
      } catch {
        /* 0 */
      }
      return { name, when: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`, size, file: original }
    })
  }

  /** A backup's bytes; empty `name` = the newest. Throws BackupError. */
  read(sid: string, name = ''): Buffer {
    const files = this.files(sid)
    if (!files.length) throw new BackupError('There is no previous version to restore.')
    const base = this.folder(sid)
    if (!name) return fs.readFileSync(path.join(base, files[0]))
    if (files.includes(name)) return fs.readFileSync(path.join(base, name))
    throw new BackupError('That version no longer exists.')
  }

  prune(sid: string): void {
    const base = this.folderOrNull(sid)
    if (!base) return
    for (const name of this.files(sid).slice(KEEP)) {
      try {
        fs.unlinkSync(path.join(base, name))
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Move an old `<script>.bak` next to the script into the backups. The .bak is only removed when its copy was
   * written and reads back identical. Returns true when moved.
   */
  migrateSideBak(sid: string, scriptPath: string): boolean {
    const bak = scriptPath + '.bak'
    try {
      if (!fs.statSync(bak).isFile()) return false
    } catch {
      return false
    }
    try {
      const data = fs.readFileSync(bak)
      const copy = this.add(sid, path.basename(scriptPath), data, fs.statSync(bak).mtimeMs)
      if (!fs.readFileSync(copy).equals(data)) return false
      fs.unlinkSync(bak)
      return true
    } catch (e) {
      if (isFsError(e) || e instanceof BackupError) return false
      throw e
    }
  }

  private folderOrNull(sid: string): string | null {
    try {
      return this.folder(sid)
    } catch {
      return null
    }
  }
}
