/** View-level glue shared by the handlers: DTOs, decorating run records, settings text forms. */
import path from 'node:path'
import type { ScriptDto } from '@scripthub/protocol'
import type { Script } from '../discovery.js'
import { platformLabels, relativePath, location } from '../discovery.js'
import type { Engine } from '../engine.js'
import * as history from '../history.js'

export const APP_VERSION = '2.0'

/** Script -> plain DTO. */
export function scriptDto(s: Script): ScriptDto {
  return {
    id: s.id, name: s.name, path: s.path, root: s.root, relative: relativePath(s), location: location(s), category: s.category,
    description: s.description, extension: s.extension, ext: s.extension.replace(/^\./, ''), interpreter: s.interpreter,
    language: s.language, languageLabel: s.languageLabel, platforms: [...s.platforms], platformLabels: platformLabels(s),
    metaValid: s.metaValid, metaError: s.metaError, parameterCount: s.parameterCount, idConflict: s.idConflict, pathId: s.pathId,
  }
}

export function ago(iso: unknown, now = new Date()): string {
  const when = history.parseIso(iso)
  if (!when) return ''
  const secs = Math.floor((now.getTime() - when.getTime()) / 1000)
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`
  return `${Math.floor(secs / 86400)} d ago`
}

/** A run record for display (status label, duration, "ago", queue position). */
export function decorate(engine: Engine, meta: Record<string, any>): Record<string, any> {
  const m: Record<string, any> = { ...meta }
  m.status_label = history.STATUS_LABELS[m.status] ?? m.status
  const seconds = m.duration_seconds
  m.duration = history.formatDuration(seconds !== null && seconds !== undefined ? seconds : history.durationSeconds(m))
  m.ago = ago(m.finished_at || m.started_at || m.queued_at)
  m.position = engine.manager.queuePosition(m.id)
  return m
}

export function activeRuns(engine: Engine): Record<string, any>[] {
  const active = engine.history.listRuns({ limit: 60 }).filter(history.isActive).map((m) => decorate(engine, m))
  active.sort((a, b) => Number(a.status !== history.RUNNING) - Number(b.status !== history.RUNNING) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return active
}

export const LANGUAGES: Record<string, string> = { '.py': 'python', '.sh': 'bash', '.bash': 'bash', '.bat': 'batch', '.cmd': 'batch', '.json': 'json' }
export const MAX_SOURCE_BYTES = 512 * 1024

import fs from 'node:fs'
/** [text, truncated, error]; refuses binary content. */
export function readTextLimited(file: string): [string, boolean, string | null] {
  let blob: Buffer
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(MAX_SOURCE_BYTES + 1)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      blob = buf.subarray(0, n)
    } finally {
      fs.closeSync(fd)
    }
  } catch (e: any) {
    return ['', false, `Could not read file: ${e?.message ?? e}`]
  }
  const truncated = blob.length > MAX_SOURCE_BYTES
  blob = blob.subarray(0, MAX_SOURCE_BYTES)
  if (blob.includes(0)) return ['', false, 'This file looks binary and cannot be displayed.']
  let text = blob.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return [text, truncated, null]
}

export const splitText = (text: string): string[] => (text === '' ? [] : text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n'))

// ----------------------------------------------------- text <-> map forms ---
export const mapToText = (m: Record<string, string> | null | undefined): string =>
  m && typeof m === 'object' ? Object.entries(m).map(([k, v]) => `${k}=${v}`).join('\n') : ''

/** 'key=value' lines -> [map, errors] (both sides non-empty). */
export function textToMap(text: string, what: string): [Record<string, string>, string[]] {
  const out: Record<string, string> = {}
  const errors: string[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const idx = line.indexOf('=')
    const key = idx < 0 ? '' : line.slice(0, idx).trim()
    const value = idx < 0 ? '' : line.slice(idx + 1).trim()
    if (idx < 0 || !key || !value) errors.push(`${what}, line ${i + 1}: use the form key=value.`)
    else out[key] = value
  })
  return [out, errors]
}

/** 'NAME=value' lines -> [map, errors] (the value may be empty and is kept as typed). */
export function textToEnv(text: string): [Record<string, string>, string[]] {
  const env: Record<string, string> = {}
  const errors: string[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const idx = line.indexOf('=')
    const key = idx < 0 ? '' : line.slice(0, idx).trim()
    if (idx < 0 || !key) errors.push(`Environment line ${i + 1} must look like NAME=value.`)
    else env[key] = line.slice(idx + 1)
  })
  return [env, errors]
}

export const posix = (p: string): string => p.split(path.sep).join('/')

export function localDateOf(d: Date): string {
  return history.localDate(d)
}

/** Form fields as plain JSON: a Set of selected values becomes an array, a missing error null. */
export function fieldsDto(fields: unknown[]): Record<string, any>[] {
  return (fields as Array<Record<string, any>>).map((f) => ({
    ...f,
    selected: f.selected instanceof Set ? [...f.selected].sort() : f.selected,
    error: f.error ?? null,
  }))
}
