/**
 * Settings model: the editable form, its conversion to the protocol's text form, client-side validation that
 * mirrors the engine (packages/engine validators.ts + api handlers), mapping of the engine's error strings back
 * to fields, section defaults, import/export and the unsaved-draft storage. Pure; no Preact in here.
 */
import type { SettingsForm } from '@scripthub/protocol'

export interface Row { id: number; key: string; value: string }

export const INT_NAMES = [
  'max_concurrent_executions', 'max_concurrent_per_host', 'default_timeout', 'polling_interval',
  'history_retention_days', 'log_retention_days', 'ssh_connect_timeout',
] as const
export type IntName = (typeof INT_NAMES)[number]
export type ListName = 'interpreters' | 'remote_interpreters' | 'environment'

export interface Draft {
  max_concurrent_executions: string
  max_concurrent_per_host: string
  default_timeout: string
  polling_interval: string
  history_retention_days: string
  log_retention_days: string
  ssh_connect_timeout: string
  enable_script_editing: boolean
  ssh_executable: string
  interpreters: Row[]
  remote_interpreters: Row[]
  environment: Row[]
}
export type FieldName = keyof Draft

export interface IntMeta { name: IntName; label: string; min: number; max: number; step?: number; unit?: string; help: string; section: SectionId }

export const INTS: IntMeta[] = [
  { name: 'max_concurrent_executions', label: 'Max concurrent executions', min: 1, max: 64, section: 'execution', help: 'More than this are queued.' },
  { name: 'max_concurrent_per_host', label: 'Max per host', min: 1, max: 64, section: 'execution', help: 'Applies to “local” and to each SSH host.' },
  { name: 'default_timeout', label: 'Default timeout (seconds)', min: 1, max: 7 * 86400, section: 'execution', unit: 's', help: 'Used when a script sets none. Up to 7 days (604800).' },
  { name: 'polling_interval', label: 'Console polling (ms)', min: 500, max: 60000, step: 100, section: 'execution', unit: 'ms', help: 'Fallback refresh rate for panels that cannot receive live events.' },
  { name: 'history_retention_days', label: 'Keep executions for (days)', min: 1, max: 36500, section: 'retention', unit: 'days', help: 'Older executions are deleted completely.' },
  { name: 'log_retention_days', label: 'Keep logs for (days)', min: 1, max: 36500, section: 'retention', unit: 'days', help: 'After this, only the record stays (no stdout/stderr).' },
  { name: 'ssh_connect_timeout', label: 'SSH connect timeout (seconds)', min: 1, max: 300, section: 'ssh', unit: 's', help: 'How long to wait for a host to answer before giving up.' },
]

// ------------------------------------------------------------- sections ---
export type SectionId = 'features' | 'execution' | 'retention' | 'interpreters' | 'ssh' | 'hosts' | 'data' | 'appearance' | 'about'

export interface SectionMeta { id: SectionId; title: string; icon: string; form: boolean; keywords: string }
export const SECTIONS: SectionMeta[] = [
  { id: 'features', title: 'Features', icon: 'zap', form: true, keywords: 'edit script editing create new login security' },
  { id: 'execution', title: 'Execution', icon: 'play', form: true, keywords: 'concurrent concurrency parallel queue limit timeout polling host' },
  { id: 'retention', title: 'Retention', icon: 'clock', form: true, keywords: 'history logs cleanup delete days keep old' },
  { id: 'interpreters', title: 'Interpreters', icon: 'code', form: true, keywords: 'python bash cmd powershell extension command remote linux' },
  { id: 'ssh', title: 'SSH & environment', icon: 'terminal', form: true, keywords: 'ssh executable connect timeout environment variables env path' },
  { id: 'hosts', title: 'SSH hosts', icon: 'server', form: false, keywords: 'ssh config host test connection remote' },
  { id: 'data', title: 'Data', icon: 'files', form: false, keywords: 'runtime folder clear history presets sequences backups storage disk size location' },
  { id: 'appearance', title: 'Appearance', icon: 'sun', form: false, keywords: 'theme dark light system colour color' },
  { id: 'about', title: 'About', icon: 'gear', form: false, keywords: 'version runtime location platform shortcuts help' },
]

/** What the search box looks at: every labelled setting, with the section it lives in. */
export interface SearchItem { section: SectionId; label: string; text: string }
export const SEARCH_ITEMS: SearchItem[] = [
  { section: 'features', label: 'Create and edit scripts', text: 'enable script editing new script editor security no login' },
  ...INTS.map((i) => ({ section: i.section, label: i.label, text: `${i.label} ${i.help} ${i.name.replaceAll('_', ' ')}` })),
  { section: 'interpreters', label: 'On this computer', text: 'local interpreters extension command .py .bat .ps1 python' },
  { section: 'interpreters', label: 'On SSH hosts (Linux)', text: 'remote interpreters extension command python3 bash' },
  { section: 'ssh', label: 'SSH command', text: 'ssh executable command ~/.ssh/config password' },
  { section: 'ssh', label: 'Environment variables', text: 'environment variables env NAME value every run' },
  { section: 'hosts', label: 'SSH hosts', text: 'hosts test connection ssh config' },
  { section: 'data', label: 'Data', text: 'data location clear history presets sequences backups imports metadata workspace settings' },
  { section: 'appearance', label: 'Theme', text: 'theme dark light system colour' },
  { section: 'about', label: 'About', text: 'version runtime location platform mode keyboard shortcuts' },
]

/** Sections matching `query` (empty = all), and for form sections which items matched. */
export function searchSections(query: string): Set<SectionId> {
  const q = query.trim().toLowerCase()
  if (!q) return new Set(SECTIONS.map((s) => s.id))
  const words = q.split(/\s+/)
  const hit = (hay: string) => words.every((w) => hay.includes(w))
  const out = new Set<SectionId>()
  for (const s of SECTIONS) if (hit(`${s.title} ${s.keywords}`.toLowerCase())) out.add(s.id)
  for (const it of SEARCH_ITEMS) if (hit(`${it.label} ${it.text}`.toLowerCase())) out.add(it.section)
  return out
}

/**
 * For a section, should the field `label` show? An empty query shows everything. When some fields of the section match
 * the query only those show; when the section matched by its title or keywords alone, all its fields show.
 */
export function itemVisible(query: string, section: SectionId, label: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const words = q.split(/\s+/)
  const hit = (it: SearchItem) => words.every((w) => `${it.label} ${it.text}`.toLowerCase().includes(w))
  const items = SEARCH_ITEMS.filter((i) => i.section === section)
  if (!items.some(hit)) return true
  return items.some((i) => i.label === label && hit(i))
}

// -------------------------------------------------------------- defaults ---
export const FIELDS_OF: Record<SectionId, FieldName[]> = {
  features: ['enable_script_editing'],
  execution: ['max_concurrent_executions', 'max_concurrent_per_host', 'default_timeout', 'polling_interval'],
  retention: ['history_retention_days', 'log_retention_days'],
  interpreters: ['interpreters', 'remote_interpreters'],
  ssh: ['ssh_executable', 'ssh_connect_timeout', 'environment'],
  hosts: [], data: [], appearance: [], about: [],
}

let rowSeq = 1
export const newRow = (key = '', value = ''): Row => ({ id: rowSeq++, key, value })
const rows = (pairs: Array<[string, string]>): Row[] => pairs.map(([k, v]) => newRow(k, v))

/** The engine's defaults (packages/engine config.ts defaultConfig) for the given platform. */
export function defaultsDraft(platform = 'win32'): Draft {
  const win = platform === 'win32'
  return {
    max_concurrent_executions: '3', max_concurrent_per_host: '3', default_timeout: '3600', polling_interval: '2000',
    history_retention_days: '90', log_retention_days: '30', ssh_connect_timeout: '10', enable_script_editing: true,
    ssh_executable: 'ssh',
    interpreters: rows([['.py', win ? 'python' : 'python3'], ['.sh', 'bash'], ...(win ? [['.bat', 'cmd'] as [string, string]] : [])]),
    remote_interpreters: rows([['.py', 'python3'], ['.sh', 'bash']]),
    environment: [],
  }
}

/** `draft` with the fields of `section` set back to the defaults. */
export function restoreSection(draft: Draft, section: SectionId, platform: string): Draft {
  const d = defaultsDraft(platform)
  const next: any = { ...draft }
  for (const f of FIELDS_OF[section]) next[f] = (d as any)[f]
  return next
}

// ------------------------------------------------- text <-> rows <-> form ---
/** `key=value` lines. `env`: the value is kept as typed; otherwise both sides are trimmed. Comment and blank lines are skipped. */
export function parseLines(text: string, env = false): Row[] {
  const out: Row[] = []
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx < 0) out.push(newRow(line, ''))
    else out.push(newRow(line.slice(0, idx).trim(), env ? line.slice(idx + 1) : line.slice(idx + 1).trim()))
  }
  return out
}

/** Rows as `key=value` lines; completely empty rows are left out, half-filled ones are kept so the checks can name them. */
export function linesOf(list: Row[]): string {
  return list.filter((r) => r.key.trim() !== '' || r.value !== '').map((r) => `${r.key.trim()}=${r.value}`).join('\n')
}

export function fromForm(f: SettingsForm): Draft {
  const d: any = { enable_script_editing: !!f.enable_script_editing, ssh_executable: f.ssh_executable ?? '' }
  for (const n of INT_NAMES) d[n] = String(f[n] ?? '')
  d.interpreters = parseLines(f.interpreters)
  d.remote_interpreters = parseLines(f.remote_interpreters)
  d.environment = parseLines(f.environment, true)
  return d as Draft
}

export function toForm(d: Draft): SettingsForm {
  const f: any = { enable_script_editing: d.enable_script_editing, ssh_executable: d.ssh_executable.trim() }
  for (const n of INT_NAMES) f[n] = d[n].trim()
  f.interpreters = linesOf(d.interpreters)
  f.remote_interpreters = linesOf(d.remote_interpreters)
  f.environment = linesOf(d.environment)
  return f as SettingsForm
}

const same = (a: SettingsForm, b: SettingsForm) => JSON.stringify(a) === JSON.stringify(b)
export const isDirty = (a: Draft, b: Draft): boolean => !same(toForm(a), toForm(b))

/** Which fields differ (drives the "changed" markers and the counter). */
export function changedFields(a: Draft, b: Draft): Set<FieldName> {
  const fa = toForm(a) as any
  const fb = toForm(b) as any
  const out = new Set<FieldName>()
  for (const k of Object.keys(fa)) if (fa[k] !== fb[k]) out.add(k as FieldName)
  return out
}

// ------------------------------------------------------------ validation ---
const EXT_RE = /^\.[A-Za-z0-9_]{1,10}$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export interface Problems {
  /** one message per field (the first problem) */
  fields: Partial<Record<FieldName, string>>
  /** per row messages of the three list editors, by row id */
  rows: Record<ListName, Record<number, string>>
  count: number
}

export function validate(d: Draft): Problems {
  const fields: Problems['fields'] = {}
  const rowErrors: Problems['rows'] = { interpreters: {}, remote_interpreters: {}, environment: {} }
  for (const m of INTS) {
    const t = d[m.name].trim()
    if (!/^[-+]?\d+$/.test(t)) fields[m.name] = 'Must be a whole number.'
    else {
      const v = parseInt(t, 10)
      if (v < m.min || v > m.max) fields[m.name] = `Must be between ${m.min} and ${m.max}.`
    }
  }
  if (!d.ssh_executable.trim()) fields.ssh_executable = 'Enter the ssh command or a full path.'

  const checkMap = (name: 'interpreters' | 'remote_interpreters', required: boolean) => {
    const list = d[name].filter((r) => r.key.trim() !== '' || r.value.trim() !== '')
    if (required && !list.length) fields[name] = 'Add at least one file extension with its interpreter.'
    const seen = new Set<string>()
    for (const r of list) {
      const ext = r.key.trim().toLowerCase()
      if (!EXT_RE.test(ext)) rowErrors[name][r.id] = `“${r.key.trim() || '…'}” is not a file extension (use e.g. .py).`
      else if (!r.value.trim()) rowErrors[name][r.id] = `Enter the command that runs ${ext} files.`
      else if (seen.has(ext)) rowErrors[name][r.id] = `${ext} is listed twice.`
      seen.add(ext)
    }
    if (!fields[name] && Object.keys(rowErrors[name]).length) fields[name] = 'Fix the highlighted lines.'
  }
  checkMap('interpreters', true)
  checkMap('remote_interpreters', false)

  const envSeen = new Set<string>()
  for (const r of d.environment.filter((x) => x.key.trim() !== '' || x.value !== '')) {
    const k = r.key.trim()
    if (!ENV_NAME_RE.test(k)) rowErrors.environment[r.id] = `“${k || '…'}” is not a valid variable name (letters, digits and _, not starting with a digit).`
    else if (r.value.includes('\0')) rowErrors.environment[r.id] = 'The value contains an invalid character.'
    else if (envSeen.has(k)) rowErrors.environment[r.id] = `${k} is listed twice.`
    envSeen.add(k)
  }
  if (Object.keys(rowErrors.environment).length) fields.environment = 'Fix the highlighted variables.'

  const count = Object.keys(fields).length
  return { fields, rows: rowErrors, count }
}

// ---------------------------------------------- engine errors -> fields ---
const INT_LABELS: Array<[string, IntName]> = [
  // longest first: "Max concurrent executions per host" starts with "Max concurrent executions"
  ['Max concurrent executions per host', 'max_concurrent_per_host'],
  ['Max concurrent executions', 'max_concurrent_executions'],
  ['SSH connect timeout', 'ssh_connect_timeout'],
  ['Default timeout', 'default_timeout'],
  ['Polling interval', 'polling_interval'],
  ['History retention', 'history_retention_days'],
  ['Log retention', 'log_retention_days'],
]

/** The field an engine error message belongs to, or null (shown only in the list above the form). */
export function fieldOfError(msg: string): FieldName | null {
  for (const [label, name] of INT_LABELS) if (msg.startsWith(label)) return name
  if (/^Remote interpreters?\b|^Invalid remote file extension|^remote_interpreters\b/.test(msg)) return 'remote_interpreters'
  if (/^Interpreters?\b|^Invalid file extension|^interpreters\b/.test(msg)) return 'interpreters'
  if (/^Environment\b|^Invalid environment variable/.test(msg)) return 'environment'
  if (/^ssh_executable\b/.test(msg)) return 'ssh_executable'
  if (/^enable_script_editing\b/.test(msg)) return 'enable_script_editing'
  return null
}

export function mapServerErrors(errors: string[]): Partial<Record<FieldName, string[]>> {
  const out: Partial<Record<FieldName, string[]>> = {}
  for (const e of errors) {
    const f = fieldOfError(e)
    if (f) (out[f] ??= []).push(e)
  }
  return out
}

// --------------------------------------------------------- import/export ---
export const EXPORT_FORMAT = 'scripthub-settings'

/** A config.json-shaped object (interpreters and environment as maps, numbers as numbers). */
export function exportSettings(d: Draft): Record<string, any> {
  const map = (list: Row[], env = false) => {
    const o: Record<string, string> = {}
    for (const r of list) if (r.key.trim() !== '') o[env ? r.key.trim() : r.key.trim().toLowerCase()] = env ? r.value : r.value.trim()
    return o
  }
  const out: Record<string, any> = { _format: EXPORT_FORMAT, _version: 1, enable_script_editing: d.enable_script_editing, ssh_executable: d.ssh_executable.trim() }
  for (const n of INT_NAMES) out[n] = /^[-+]?\d+$/.test(d[n].trim()) ? parseInt(d[n], 10) : d[n]
  out.interpreters = map(d.interpreters)
  out.remote_interpreters = map(d.remote_interpreters)
  out.environment = map(d.environment, true)
  return out
}

export interface ImportResult { draft: Draft; applied: string[]; ignored: string[] }

/**
 * Apply settings from parsed JSON onto `base`. Accepts this panel's export, a plain config.json, or the protocol
 * form (interpreters and environment as `key=value` text). Throws Error with a message when it is not settings at all.
 */
export function importSettings(json: unknown, base: Draft): ImportResult {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('This file is not a settings file (a JSON object is expected).')
  const src = json as Record<string, any>
  const draft: Draft = { ...base }
  const applied: string[] = []
  const ignored: string[] = []
  const known = new Set<string>([...INT_NAMES, 'enable_script_editing', 'ssh_executable', 'interpreters', 'remote_interpreters', 'environment'])
  const listOf = (v: unknown, env: boolean): Row[] | null => {
    if (typeof v === 'string') return parseLines(v, env)
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.entries(v as Record<string, unknown>).map(([k, x]) => newRow(k, String(x ?? '')))
    return null
  }
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith('_') || k === 'script_directories' || k === 'enable_adhoc') continue
    if (!known.has(k)) { ignored.push(k); continue }
    if ((INT_NAMES as readonly string[]).includes(k)) {
      if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) { (draft as any)[k] = String(v); applied.push(k) } else ignored.push(k)
    } else if (k === 'enable_script_editing') {
      if (typeof v === 'boolean') { draft.enable_script_editing = v; applied.push(k) } else ignored.push(k)
    } else if (k === 'ssh_executable') {
      if (typeof v === 'string') { draft.ssh_executable = v; applied.push(k) } else ignored.push(k)
    } else {
      const l = listOf(v, k === 'environment')
      if (l) { (draft as any)[k] = l; applied.push(k) } else ignored.push(k)
    }
  }
  if (!applied.length) throw new Error('Nothing in this file matches a ScriptHub setting.')
  return { draft, applied, ignored }
}

// ------------------------------------------------------- unsaved draft ---
export const DRAFT_KEY = 'scripthub.settingsDraft'

export function draftToJson(d: Draft): string {
  return JSON.stringify(toForm(d))
}

/** A stored draft as a form, or null when missing or unreadable. */
export function draftFromJson(text: string | null): Draft | null {
  if (!text) return null
  try {
    const f = JSON.parse(text)
    if (!f || typeof f !== 'object' || typeof f.ssh_executable !== 'string' || typeof f.interpreters !== 'string') return null
    return fromForm(f as SettingsForm)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- misc ---
/** What the engine reports as how the data folder was chosen. */
export function howText(how: string): string {
  return ({ env: 'set by SCRIPTHUB_HOME', portable: 'portable: next to the program', user: "your user's data folder" } as Record<string, string>)[how] ?? how
}

/** Kinds that must never be offered for clearing, whatever the engine lists (secret key, locks, id aliases). */
const NEVER = /^(secret|secret_key|locks?|script_ids)$/
export const clearable = <T extends { key: string }>(rows: T[]): T[] => rows.filter((r) => !NEVER.test(r.key))
