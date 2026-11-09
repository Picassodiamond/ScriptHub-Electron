/**
 * Script metadata: a YAML block in a comment at the top of the script itself.
 *
 *     #!/usr/bin/env python3
 *     # --- scripthub ---
 *     # name: Directory Backup
 *     # parameters:
 *     #   - name: source
 *     #     type: directory
 *     # --- end scripthub ---
 *
 * Batch files use `::`. Blocks written as JSON by older versions are still read and become YAML on the next
 * save. Saving rewrites only the block (atomically, keeping line endings and a BOM; the previous version goes
 * to runtime/backups/<id>/). The first save writes a stable `id`. Old sidecars `<stem>.json` are read until
 * the next save; an unwritable script falls back to runtime/metadata_overrides/. Port of runner/metadata.py.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DataDirs } from './paths.js'
import { atomicWriteJson, isFile, readJson } from './fsutil.js'
import { Ids, newId, pathId, valid as validId } from './ids.js'
import { BackupError, Backups, isFsError, writeBytesAtomic } from './backups.js'
import * as yamlish from './yamlish.js'

export const START = '--- scripthub ---'
export const END = '--- end scripthub ---'
export const BATCH = ['.bat', '.cmd']
/** The block is near the top; never read more than this. */
export const MAX_SCAN = 256 * 1024

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const MARK = new RegExp(`^\\s*(?:#|::|rem\\b)\\s*(${escapeRe(START)}|${escapeRe(END)})\\s*$`, 'i')
const PREFIX = /^\s*(?:#|::|rem\b) ?/i
const KEEP_FIRST = /^(#!|#.*coding[:=]|@echo\s+off\b)/i
const YAML_LINE = /\bline (\d+)\b/
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

type Data = Record<string, any>

/** Python's str.splitlines(): splits on \n \r\n \r and a few other line boundaries; no trailing empty line. */
export function splitlines(text: string): string[] {
  if (!text) return []
  const parts = text.split(new RegExp('\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]'))
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

const extOf = (p: string) => path.extname(p).toLowerCase()

export function prefixFor(scriptPath: string): string {
  return BATCH.includes(extOf(scriptPath)) ? '::' : '#'
}

/** Old location (before 2.1): <stem>.json next to the script. */
export function sidecarPath(scriptPath: string): string {
  const ext = path.extname(scriptPath)
  return ext ? scriptPath.slice(0, -ext.length) + '.json' : scriptPath + '.json'
}

/** realpath that also works for paths that do not exist yet (like Python's Path.resolve()). */
export function resolveLoose(p: string): string {
  p = path.resolve(p)
  try {
    return fs.realpathSync.native(p)
  } catch {
    const parent = path.dirname(p)
    if (parent === p) return p
    return path.join(resolveLoose(parent), path.basename(p))
  }
}

// ----------------------------------------------------------------- block ---
/** [start, end] line indexes of the block's marker lines, or null. */
export function findBlock(lines: string[]): [number, number] | null {
  let start: number | null = null
  for (let i = 0; i < lines.length; i++) {
    const m = MARK.exec(lines[i])
    if (!m) continue
    const which = m[1].toLowerCase()
    if (which === START && start === null) start = i
    else if (which === END && start !== null) return [start, i]
  }
  return null
}

/** [data, error]: data is null when the script has no block. */
export function parseBlock(text: string): [Data | null, string | null] {
  const lines = splitlines(text)
  const span = findBlock(lines)
  if (span === null) return [null, null]
  const body = lines.slice(span[0] + 1, span[1]).map((l) => l.replace(PREFIX, '')).join('\n')
  const where = `lines ${span[0] + 1}-${span[1] + 1}`
  if (body.trimStart().startsWith('{')) {
    // written as JSON by an older version
    let data: any
    try {
      data = JSON.parse(body)
    } catch (e: any) {
      return [{}, `Invalid metadata block (${where}, JSON): ${e.message}`]
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data))
      return [{}, 'The metadata block must contain a JSON object {…}.']
    return [data, null]
  }
  try {
    return [yamlish.load(body), null]
  } catch (e: any) {
    if (!(e instanceof yamlish.YamlError)) throw e
    const msg = e.message.replace(YAML_LINE, (_m, n) => `line ${Number(n) + span[0] + 1}`)
    return [{}, `Invalid metadata block (${where}): ${msg}`]
  }
}

/** The block's lines: YAML, one key per line, short lists such as `choices` on one line. */
export function formatBlock(data: Data, prefix = '#'): string[] {
  const body = Object.keys(data).length ? splitlines(yamlish.dump(data, '', true)) : []
  return [`${prefix} ${START}`, ...body.map((l) => `${prefix} ${l}`.trimEnd()), `${prefix} ${END}`]
}

function detectNewline(text: string, scriptPath: string): string {
  if (text.includes('\r\n')) return '\r\n'
  return BATCH.includes(extOf(scriptPath)) && !text.includes('\n') ? '\r\n' : '\n'
}

/** [text, bom, newline] of the start of the script; throws on I/O errors. */
function readScript(scriptPath: string): [string, boolean, string] {
  const fd = fs.openSync(scriptPath, 'r')
  let blob: Buffer
  try {
    const buf = Buffer.alloc(MAX_SCAN + 1)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    blob = buf.subarray(0, n)
  } finally {
    fs.closeSync(fd)
  }
  const bom = blob.subarray(0, 3).equals(BOM)
  const text = blob.subarray(bom ? 3 : 0, MAX_SCAN).toString('utf8')
  return [text, bom, detectNewline(text, scriptPath)]
}

/** `content` (the whole script) with its metadata block replaced or inserted. */
export function withBlock(content: string, data: Data, scriptPath: string, newline: string): string {
  const lines = splitlines(content)
  const block = formatBlock(data, prefixFor(scriptPath))
  const span = findBlock(lines)
  if (span !== null) lines.splice(span[0], span[1] - span[0] + 1, ...block)
  else {
    let at = 0
    while (at < lines.length && at < 2 && KEEP_FIRST.test(lines[at])) at++
    lines.splice(at, 0, ...block)
  }
  const trailing = content.endsWith('\n') || content.endsWith('\r')
  return lines.join(newline) + (trailing || !content ? newline : '')
}

/** `data` with a stable id first: kept when valid, new when missing or a duplicate. */
export function withId(data: Data, conflict = false): Data {
  const current = data.id
  const sid = conflict || !validId(current) ? newId() : current
  const { id: _drop, ...rest } = data
  return { id: sid, ...rest }
}

/** True when the script's metadata lives in the script file. */
export function embedded(script: { path: string; metaSource?: string | null }): boolean {
  return !!script.metaSource && path.resolve(script.metaSource) === path.resolve(script.path)
}

class NotUtf8 extends Error {}

function decodeUtf8(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
  } catch {
    throw new NotUtf8('the script is not valid UTF-8')
  }
}

export interface LoadResult {
  data: Data
  /** The script itself when it has a block, else the sidecar/override file, else null. */
  source: string | null
  error: string | null
}

export class MetadataStore {
  readonly ids: Ids
  readonly backups: Backups

  constructor(private dirs: DataDirs, deps: { ids?: Ids; backups?: Backups } = {}) {
    this.ids = deps.ids ?? new Ids(dirs)
    this.backups = deps.backups ?? new Backups(dirs)
  }

  overridePath(scriptId: string): string {
    return path.join(this.dirs.metadataOverride, `${scriptId}.json`)
  }

  /** The override file is found by the script's path (it cannot carry an id in the file). */
  private overrideFor(scriptPath: string): string {
    return this.overridePath(pathId(resolveLoose(scriptPath)))
  }

  /** Never throws. */
  loadRaw(scriptPath: string, _scriptId = ''): LoadResult {
    let text = ''
    try {
      text = readScript(scriptPath)[0]
    } catch {
      /* unreadable: no block */
    }
    const [data, err] = parseBlock(text)
    if (data !== null) return { data, source: scriptPath, error: err }
    for (const candidate of [sidecarPath(scriptPath), this.overrideFor(scriptPath)]) {
      if (!isFile(candidate)) continue
      let loaded: any
      try {
        loaded = readJson(candidate)
      } catch (e: any) {
        return { data: {}, source: candidate, error: `Invalid metadata file ${path.basename(candidate)}: ${e.message}` }
      }
      if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded))
        return { data: {}, source: candidate, error: `${path.basename(candidate)} must contain a JSON object.` }
      return { data: loaded, source: candidate, error: null }
    }
    return { data: {}, source: null, error: null }
  }

  private writeScript(scriptPath: string, data: Data, sid: string): void {
    const raw = fs.readFileSync(scriptPath)
    const bom = raw.subarray(0, 3).equals(BOM)
    const content = decodeUtf8(raw.subarray(bom ? 3 : 0)) // not valid UTF-8: not ours to rewrite
    const newline = detectNewline(content, scriptPath)
    const next = withBlock(content, data, scriptPath, newline)
    const payload = Buffer.concat([bom ? BOM : Buffer.alloc(0), Buffer.from(next, 'utf8')])
    if (payload.equals(raw)) return
    this.backups.migrateSideBak(sid, scriptPath) // an old <script>.bak moves to runtime/backups/
    this.backups.add(sid, path.basename(scriptPath), raw) // "Restore previous" in the editor
    writeBytesAtomic(scriptPath, payload, scriptPath)
  }

  /**
   * Write the metadata into the script (moving an old sidecar in); falls back to runtime/metadata_overrides/
   * when the script cannot be written. Returns where it went.
   *
   * `scriptId` is what the script is known as now; when the stable id written here differs (first save, or a
   * duplicate given a new id) the script's saved values and backups move to it and the old id becomes an alias.
   */
  saveRaw(scriptPath: string, scriptId: string, data: Data, conflict = false): string {
    const pid = pathId(resolveLoose(scriptPath))
    const withIdData = withId(data, conflict)
    const sid: string = withIdData.id
    const previous = validId(scriptId) ? scriptId : pid
    if (previous !== sid) this.ids.adopt(previous, sid)
    try {
      this.writeScript(scriptPath, withIdData, sid)
    } catch (e) {
      if (!(isFsError(e) || e instanceof NotUtf8 || e instanceof BackupError)) throw e
      const target = this.overridePath(pid)
      atomicWriteJson(target, withIdData)
      return target
    }
    for (const old of [sidecarPath(scriptPath), this.overridePath(pid)]) {
      // now inside the script
      try {
        const loaded = readJson(old)
        if (loaded !== null && typeof loaded === 'object' && !Array.isArray(loaded)) fs.unlinkSync(old) // only a metadata object
      } catch {
        /* missing or not JSON: leave it */
      }
    }
    return scriptPath
  }
}
