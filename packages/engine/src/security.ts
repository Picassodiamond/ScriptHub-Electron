/** Path safety helpers. Port of runner/security.py. */
import fs from 'node:fs'
import path from 'node:path'

function real(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** True if `child` resolves to a location inside `parent`. */
export function isWithin(child: string, parent: string): boolean {
  const c = real(child)
  const p = real(parent)
  const rel = path.relative(process.platform === 'win32' ? p.toLowerCase() : p, process.platform === 'win32' ? c.toLowerCase() : c)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Normalise a user-typed directory path; throws Error with a user message if unusable. */
export function cleanDirectoryInput(value: string): string {
  let v = (value ?? '').trim()
  v = v.replace(/^["']+|["']+$/g, '').trim()
  if (!v) throw new Error('Enter a directory path.')
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(v)) throw new Error('The path contains invalid characters.')
  return v
}
