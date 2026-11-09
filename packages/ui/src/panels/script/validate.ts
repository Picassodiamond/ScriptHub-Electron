/**
 * Early hints for the run form, shown as you type. They are advisory: the engine validates again when the run
 * starts and its answer wins (so a check here can never block a valid run).
 */
export type RunValue = string | string[] | boolean

export interface FieldLike {
  name: string
  input: string
  p: Record<string, any>
  choices: Array<{ value: string; label: string }>
  locked: boolean
}

const isEmpty = (v: RunValue | undefined): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/** A hint for `value`, or null when it looks fine. */
export function checkValue(f: FieldLike, value: RunValue | undefined): string | null {
  if (f.locked || f.input === 'checkbox') return null
  const p = f.p
  if (isEmpty(value)) return p.required ? 'This field is required.' : null
  const s = Array.isArray(value) ? '' : String(value)
  const values = f.choices.map((c) => c.value)
  switch (f.input) {
    case 'number':
    case 'decimal': {
      const ok = f.input === 'number' ? /^[-+]?\d+$/.test(s.trim()) : /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s.trim())
      if (!ok) return f.input === 'number' ? 'Enter a whole number.' : 'Enter a number, for example 1.5.'
      const n = Number(s)
      if (typeof p.min === 'number' && n < p.min) return `Must be at least ${p.min}.`
      if (typeof p.max === 'number' && n > p.max) return `Must be at most ${p.max}.`
      return null
    }
    case 'select':
      return values.length && !values.includes(s) ? 'Choose one of the listed values.' : null
    case 'multiselect':
      return values.length && (value as string[]).some((x) => !values.includes(x)) ? 'Choose from the listed values.' : null
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? null : 'Enter a date as YYYY-MM-DD.'
    case 'datetime-local':
      return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) ? null : 'Enter a date and time.'
    default:
      break
  }
  if (typeof p.min_length === 'number' && s.length < p.min_length) return `Use at least ${p.min_length} characters.`
  if (typeof p.max_length === 'number' && s.length > p.max_length) return `Use at most ${p.max_length} characters.`
  if (p.pattern) {
    try {
      if (!new RegExp(`^(?:${String(p.pattern)})$`).test(s)) return 'Does not match the required format.'
    } catch {
      /* a pattern JavaScript cannot read (Python-only syntax): leave it to the server */
    }
  }
  return null
}

/** The values to post: every editable field, as the engine's form reader expects (booleans, arrays, strings). */
export function postValues(fields: FieldLike[], values: Record<string, RunValue>): Record<string, RunValue> {
  const out: Record<string, RunValue> = {}
  for (const f of fields) {
    if (f.locked) continue
    const v = values[f.name]
    out[f.name] = f.input === 'checkbox' ? !!v : f.input === 'multiselect' ? (Array.isArray(v) ? v : []) : v === undefined || v === null || Array.isArray(v) ? '' : String(v)
  }
  return out
}

/** Initial values of a form from the fields the engine sent. */
export function initialValues(fields: Array<FieldLike & { value: any; selected?: string[] }>): Record<string, RunValue> {
  const out: Record<string, RunValue> = {}
  for (const f of fields) {
    if (f.input === 'checkbox') out[f.name] = !!f.value
    else if (f.input === 'multiselect') out[f.name] = [...(f.selected ?? (Array.isArray(f.value) ? f.value : []))]
    else out[f.name] = f.value === null || f.value === undefined ? '' : String(f.value)
  }
  return out
}
