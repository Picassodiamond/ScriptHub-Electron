import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { dataDirs } from '../src/paths.js'

const made: string[] = []

/** A throwaway data folder; tests never touch a real runtime/. */
export function tmpDir(prefix = 'sh-'): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  made.push(d)
  return d
}

export function tmpDirs() {
  return dataDirs(tmpDir('sh-data-'))
}

afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
