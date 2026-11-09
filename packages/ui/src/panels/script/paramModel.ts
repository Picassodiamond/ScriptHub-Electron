/**
 * The parameter editor's model: a draft per parameter (strings for every input), conversion to and from the
 * stored definition, a one-line summary, and live validation. Port of param_editor.js. Zod-free on purpose:
 * the server stays the judge, these checks only give early hints.
 */
import { termsOfDefinition } from './meta'

/** Keys the editor knows; anything else in a definition is kept untouched (`extra`). */
export const KNOWN = [
  'name', 'label', 'type', 'default', 'required', 'help', 'placeholder', 'choices', 'min', 'max', 'min_length', 'max_length', 'pattern',
  'editable_at_runtime', 'arg', 'pass_as', 'position', 'env_name',
]

export interface TypeInfo { label: string; allowed: string[] }

export interface ParamDraft {
  uid: number
  name: string
  label: string
  type: string
  /** Text of the default (multi-select: comma separated). */
  def: string
  defBool: boolean
  required: boolean
  editable: boolean
  help: string
  placeholder: string
  /** One choice per line: `value` or `value|Label`. */
  choices: string
  min: string
  max: string
  min_length: string
  max_length: string
  pattern: string
  pass_as: string
  arg: string
  position: string
  env_name: string
  extra: Record<string, any>
}

let nextUid = 1

/** A number when the text is one, the text itself otherwise, undefined when empty. */
export function num(s: string): number | string | undefined {
  const t = String(s).trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isNaN(n) ? t : n
}

export function choicesToText(ch: unknown): string {
  return ((ch as any[]) ?? [])
    .map((c) => {
      if (c && typeof c === 'object') return c.label && c.label !== c.value ? `${c.value}|${c.label}` : String(c.value)
      return String(c)
    })
    .join('\n')
}

export function textToChoices(t: string): Array<string | { value: string; label: string }> {
  return t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf('|')
    return i < 0 ? l : { value: l.slice(0, i).trim(), label: l.slice(i + 1).trim() }
  })
}

export function toDraft(p: Record<string, any>): ParamDraft {
  const extra: Record<string, any> = {}
  for (const k of Object.keys(p)) if (!KNOWN.includes(k)) extra[k] = p[k]
  const d = p.default
  const s = (k: string) => (p[k] !== undefined && p[k] !== null ? String(p[k]) : '')
  return {
    uid: nextUid++, name: p.name || '', label: p.label || '', type: p.type || 'text',
    def: Array.isArray(d) ? d.join(', ') : typeof d === 'boolean' || d === undefined || d === null ? '' : String(d),
    defBool: typeof d === 'boolean' ? d : false,
    required: !!p.required, editable: p.editable_at_runtime !== false, help: p.help || '', placeholder: p.placeholder || '',
    choices: choicesToText(p.choices), min: s('min'), max: s('max'), min_length: s('min_length'), max_length: s('max_length'),
    pattern: s('pattern'), pass_as: p.pass_as || 'flag', arg: s('arg'), position: s('position'), env_name: s('env_name'), extra,
  }
}

export const newDraft = (name: string): ParamDraft => toDraft({ name, label: '', type: 'text', required: false, editable_at_runtime: true })

/** The stored definition of a draft (what is sent to the server). */
export function fromDraft(d: ParamDraft, info: Record<string, TypeInfo>): Record<string, any> {
  const o: Record<string, any> = { ...d.extra }
  const t = d.type
  const allowed = info[t]?.allowed ?? []
  o.name = d.name.trim()
  if (d.label.trim()) o.label = d.label.trim()
  o.type = t
  if (t === 'boolean') o.default = d.defBool
  else if (d.def.trim() !== '' || (t === 'password' && d.def !== '')) {
    if (t === 'number') o.default = num(d.def)
    else if (t === 'multiselect') o.default = d.def.split(',').map((x) => x.trim()).filter(Boolean)
    else if (t === 'password' || t === 'textarea') o.default = d.def
    else o.default = d.def.trim()
  }
  if (t !== 'boolean') o.required = d.required
  o.editable_at_runtime = d.editable
  if (d.help.trim()) o.help = d.help.trim()
  if (d.placeholder.trim()) o.placeholder = d.placeholder.trim()
  if (allowed.includes('choices')) o.choices = textToChoices(d.choices)
  if (allowed.includes('min')) {
    if (num(d.min) !== undefined) o.min = num(d.min)
    if (num(d.max) !== undefined) o.max = num(d.max)
  }
  if (allowed.includes('min_length')) {
    if (num(d.min_length) !== undefined) o.min_length = num(d.min_length)
    if (num(d.max_length) !== undefined) o.max_length = num(d.max_length)
  }
  if (allowed.includes('pattern') && d.pattern) o.pattern = d.pattern
  o.pass_as = d.pass_as
  if (o.pass_as === 'flag' && d.arg.trim()) o.arg = d.arg.trim()
  if (o.pass_as === 'positional' && num(d.position) !== undefined) o.position = num(d.position)
  if (o.pass_as === 'env' && d.env_name.trim()) o.env_name = d.env_name.trim()
  return o
}

export interface Summary { label: string; name: string; type: string; def: string; req: string; rt: string; pass: string }

export function summaryOf(o: Record<string, any>): Summary {
  let d = o.default
  if (o.type === 'password') d = d ? '••••••' : ''
  else if (typeof d === 'boolean') d = d ? 'Yes' : 'No'
  else if (Array.isArray(d)) d = d.join(', ')
  const name = String(o.name ?? '')
  return {
    label: o.label || '—', name: name || '—', type: o.type,
    def: d === undefined || d === '' ? '—' : String(d),
    req: o.type === 'boolean' ? '—' : o.required ? 'Yes' : 'No',
    rt: o.editable_at_runtime ? 'Editable' : 'Fixed',
    pass: o.pass_as === 'flag' ? o.arg || `--${name.replace(/_/g, '-')}` : o.pass_as === 'env' ? `env ${o.env_name || name.toUpperCase()}` : `positional${o.position ? ` ${o.position}` : ''}`,
  }
}

export const termsOfDraft = (d: ParamDraft, info: Record<string, TypeInfo>): string[] => termsOfDefinition(fromDraft(d, info))

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** Early hints per draft (by uid): the server validates again when saving. */
export function checkDrafts(drafts: ParamDraft[], info: Record<string, TypeInfo>): Map<number, string[]> {
  const out = new Map<number, string[]>()
  const seen = new Map<string, number>()
  const positions = new Map<string, number>()
  for (const d of drafts) {
    const errs: string[] = []
    const name = d.name.trim()
    if (!name) errs.push('A parameter needs a name.')
    else if (!NAME_RE.test(name)) errs.push('The name may use letters, digits and underscores, and must not start with a digit.')
    else if (seen.has(name)) errs.push(`The name “${name}” is used by another parameter.`)
    else seen.set(name, d.uid)
    const allowed = info[d.type]?.allowed ?? []
    if (allowed.includes('choices') && !textToChoices(d.choices).length) errs.push('Add at least one choice (one per line).')
    if (allowed.includes('min')) {
      const [lo, hi] = [num(d.min), num(d.max)]
      for (const [what, v] of [['Minimum', lo], ['Maximum', hi]] as const) if (typeof v === 'string') errs.push(`${what} must be a number.`)
      if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) errs.push('The minimum is larger than the maximum.')
    }
    if (allowed.includes('min_length')) {
      for (const [what, v] of [['Min length', num(d.min_length)], ['Max length', num(d.max_length)]] as const)
        if (typeof v === 'string' || (typeof v === 'number' && (v < 0 || !Number.isInteger(v)))) errs.push(`${what} must be a whole number of 0 or more.`)
    }
    if (allowed.includes('pattern') && d.pattern) {
      try {
        new RegExp(`^(?:${d.pattern})$`)
      } catch {
        errs.push('The validation pattern is not a valid regular expression.')
      }
    }
    if (d.pass_as === 'flag' && d.arg.trim() && !/^-{1,2}[A-Za-z0-9]/.test(d.arg.trim())) errs.push('A flag starts with - or -- (for example --days).')
    if (d.pass_as === 'positional') {
      const pos = num(d.position)
      if (pos !== undefined && (typeof pos !== 'number' || !Number.isInteger(pos) || pos < 1)) errs.push('The position is a whole number from 1.')
      else if (pos !== undefined) {
        if (positions.has(String(pos))) errs.push(`Position ${pos} is used by another parameter.`)
        positions.set(String(pos), d.uid)
      }
    }
    if (d.pass_as === 'env' && d.env_name.trim() && !NAME_RE.test(d.env_name.trim())) errs.push('The variable name may use letters, digits and underscores.')
    if (errs.length) out.set(d.uid, errs)
  }
  return out
}
