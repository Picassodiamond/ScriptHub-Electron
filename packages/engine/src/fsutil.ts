/** Small filesystem helpers: atomic writes and tolerant reads (Windows refuses a rename onto a file that is open). */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function replaceWithRetry(src: string, dst: string, attempts = 60, delay = 25): void {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(src, dst)
      return
    } catch (e: any) {
      if (!RETRY_CODES.has(e?.code) || i === attempts - 1) throw e
      sleepSync(delay)
    }
  }
}

/** Write `text` so readers never see a half-written file. */
export function atomicWriteText(file: string, text: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, text)
    fs.fsyncSync(fd)
  } catch (e) {
    fs.closeSync(fd)
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw e
  }
  fs.closeSync(fd)
  try {
    replaceWithRetry(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw e
  }
}

export function atomicWriteJson(file: string, data: unknown): void {
  atomicWriteText(file, JSON.stringify(data, null, 2) + '\n')
}

/** Parsed JSON (a BOM is ignored). Throws on bad JSON or a missing file. */
export function readJson<T = any>(file: string): T {
  for (let i = 0; ; i++) {
    try {
      let text = fs.readFileSync(file, 'utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      return JSON.parse(text) as T
    } catch (e: any) {
      if (!RETRY_CODES.has(e?.code) || i >= 39) throw e
      sleepSync(25)
    }
  }
}

export function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

export function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
