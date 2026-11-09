/**
 * Parameter and metadata schema: definition validation, value coercion and argument building.
 * Port of runner/parameter_service.py. Parameter types live in a small registry (`TYPES`).
 *
 * Value model: `raw` is what a form carries (strings, a list of strings, a bool); `value` is the validated
 * value: string, integer, bool or string[]. Decimal values are kept as canonical strings so they stay
 * JSON-serialisable and reach scripts untouched.
 */
import { ValidationError } from './validators.js'

export type Param = Record<string, any>

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,254}$/
export const ARG_RE = /^-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
export const FORBIDDEN_ENV = new Set([
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'IFS', 'SHELL', 'BASH_ENV', 'ENV',
])
export const MAX_TEXT = 100_000
export const MAX_PATH = 4096
export const PASS_AS = ['flag', 'positional', 'env'] as const
export const SECRET_MASK = '••••••'

export const KNOWN_KEYS = new Set([
  'name', 'label', 'type', 'default', 'required', 'help', 'placeholder',
  'choices', 'min', 'max', 'min_length', 'max_length', 'pattern',
  'editable_at_runtime', 'arg', 'pass_as', 'position', 'env_name',
])
/** Validation keys that only make sense for some types. */
export const TYPED_KEYS = ['choices', 'min', 'max', 'min_length', 'max_length', 'pattern']

/** Former per-script options; old metadata may still contain them, they are dropped on validation. */
export const REMOVED_KEYS = ['enabled', 'timeout', 'allow_concurrent']

// --------------------------------------------------------- python-isms ---
/** Python's str() for the scalars that occur in metadata. */
function pyStr(v: any): string {
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  return String(v)
}

/** Python's bool(): empty list/object/string, 0 and None are false. */
function pyBool(v: any): boolean {
  if (Array.isArray(v)) return v.length > 0
  if (v !== null && typeof v === 'object') return Object.keys(v).length > 0
  return Boolean(v)
}

const isBlank = (v: any) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
const isObj = (v: any): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)
const codePoints = (s: string) => [...s].length

/** str.title() for identifier-like text. */
function pyTitle(s: string): string {
  let out = ''
  let prevLetter = false
  for (const ch of s) {
    const letter = ch.toLowerCase() !== ch.toUpperCase()
    out += letter ? (prevLetter ? ch.toLowerCase() : ch.toUpperCase()) : ch
    prevLetter = letter
  }
  return out
}

/** A Python `re` pattern as a JS RegExp matching the whole string (fullmatch); throws on a bad pattern. */
function fullMatchRegex(pattern: string): RegExp {
  const js = pattern.replace(/\(\?P<([A-Za-z_]\w*)>/g, '(?<$1>').replace(/\(\?P=([A-Za-z_]\w*)\)/g, '\\k<$1>')
  return new RegExp(`^(?:${js})$`)
}

// ------------------------------------------------------------- decimals ---
/** Minimal exact decimal (value = coef * 10^exp), enough for range checks and canonical formatting. */
interface Dec {
  neg: boolean
  coef: bigint
  exp: number
}

function parseDec(raw: string): Dec | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(raw.trim())
  if (!m) return null
  const [, sign, int, frac = '', e] = m
  if (!int && !frac) return null
  return { neg: sign === '-', coef: BigInt((int + frac) || '0'), exp: (e ? parseInt(e, 10) : 0) - frac.length }
}

function decCmp(a: Dec, b: Dec): number {
  const exp = Math.min(a.exp, b.exp)
  const av = (a.neg ? -1n : 1n) * a.coef * 10n ** BigInt(a.exp - exp)
  const bv = (b.neg ? -1n : 1n) * b.coef * 10n ** BigInt(b.exp - exp)
  return av < bv ? -1 : av > bv ? 1 : 0
}

/** Python's format(Decimal, "f"). */
function decFixed(d: Dec): string {
  let digits = d.coef.toString()
  let out: string
  if (d.exp >= 0) out = digits + '0'.repeat(d.exp)
  else {
    const places = -d.exp
    digits = digits.padStart(places + 1, '0')
    out = digits.slice(0, digits.length - places) + '.' + digits.slice(digits.length - places)
  }
  return (d.neg ? '-' : '') + out
}

// ----------------------------------------------------------------- types ---
export class ParamValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParamValueError'
  }
}

export interface ParamType {
  key: string
  label: string
  /** Which widget the form renderer uses. */
  input: string
  /** Subset of TYPED_KEYS valid for this type. */
  allowed: ReadonlySet<string>
  parse(raw: any, p: Param): any
  toRaw(value: any): any
}

const baseToRaw = (v: any) => (v === null || v === undefined ? '' : pyStr(v))

function stringType(key: string, label: string, input: string, limit = MAX_TEXT, pathLike = false): ParamType {
  return {
    key, label, input,
    allowed: new Set(['min_length', 'max_length', 'pattern']),
    parse(raw, p) {
      const s = pyStr(raw)
      const len = codePoints(s)
      if (len > limit) throw new ParamValueError(`Must be at most ${limit} characters.`)
      if (s.includes('\0')) throw new ParamValueError('Contains an invalid character.')
      const lo = p.min_length
      const hi = p.max_length
      if (lo !== undefined && lo !== null && len < lo) throw new ParamValueError(`Must be at least ${lo} characters.`)
      if (hi !== undefined && hi !== null && len > hi) throw new ParamValueError(`Must be at most ${hi} characters.`)
      const pat = p.pattern
      if (pat && !fullMatchRegex(pat).test(s)) throw new ParamValueError('Does not match the required format.')
      if (pathLike && [...s].some((c) => c.codePointAt(0)! < 32)) throw new ParamValueError('Path contains invalid characters.')
      return s
    },
    toRaw: baseToRaw,
  }
}

function checkRange(d: Dec, p: Param): void {
  const lo = p.min
  const hi = p.max
  if (lo !== undefined && lo !== null) {
    const l = parseDec(pyStr(lo))
    if (l && decCmp(d, l) < 0) throw new ParamValueError(`Must be at least ${lo}.`)
  }
  if (hi !== undefined && hi !== null) {
    const h = parseDec(pyStr(hi))
    if (h && decCmp(d, h) > 0) throw new ParamValueError(`Must be at most ${hi}.`)
  }
}

const numberType: ParamType = {
  key: 'number', label: 'Number (integer)', input: 'number',
  allowed: new Set(['min', 'max']),
  parse(raw, p) {
    const s = pyStr(raw).trim()
    if (!/^[+-]?[0-9]{1,18}$/.test(s)) throw new ParamValueError('Enter a whole number.')
    const dec = parseDec(s)!
    checkRange(dec, p)
    const n = Number(s)
    if (n === 0) return 0
    // beyond 2^53 a JS number would be rounded: keep the digits as text (build_arguments passes them untouched)
    return Number.isSafeInteger(n) ? n : decFixed({ ...dec, neg: dec.neg })
  },
  toRaw: baseToRaw,
}

const decimalType: ParamType = {
  key: 'decimal', label: 'Decimal', input: 'decimal',
  allowed: new Set(['min', 'max']),
  parse(raw, p) {
    const d = parseDec(pyStr(raw))
    if (!d) throw new ParamValueError('Enter a valid decimal number.')
    checkRange(d, p)
    return decFixed(d)
  },
  toRaw: baseToRaw,
}

const booleanType: ParamType = {
  key: 'boolean', label: 'Boolean (checkbox)', input: 'checkbox',
  allowed: new Set(),
  parse: (raw) => pyBool(raw),
  toRaw: (v) => pyBool(v),
}

const selectType: ParamType = {
  key: 'select', label: 'Select (dropdown)', input: 'select',
  allowed: new Set(['choices']),
  parse(raw, p) {
    const s = pyStr(raw)
    if (!choiceValues(p).includes(s)) throw new ParamValueError('Choose one of the available options.')
    return s
  },
  toRaw: baseToRaw,
}

const multiSelectType: ParamType = {
  key: 'multiselect', label: 'Multi-select', input: 'multiselect',
  allowed: new Set(['choices']),
  parse(raw, p) {
    const items = Array.isArray(raw) ? [...raw] : [raw]
    const valid = new Set(choiceValues(p))
    for (const item of items) if (!valid.has(pyStr(item))) throw new ParamValueError(`'${pyStr(item)}' is not an available option.`)
    return items.map(pyStr)
  },
  toRaw: (v) => (Array.isArray(v) ? [...v] : v === null || v === undefined || v === '' ? [] : [pyStr(v)]),
}

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false
  const dt = new Date(Date.UTC(2000, m - 1, d))
  dt.setUTCFullYear(y)
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

const p2 = (n: number) => String(n).padStart(2, '0')

const dateType: ParamType = {
  key: 'date', label: 'Date', input: 'date',
  allowed: new Set(),
  parse(raw) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(pyStr(raw).trim())
    if (!m || !validDate(+m[1], +m[2], +m[3])) throw new ParamValueError('Enter a valid date (YYYY-MM-DD).')
    return `${m[1]}-${m[2]}-${m[3]}`
  },
  toRaw: baseToRaw,
}

const dateTimeType: ParamType = {
  key: 'datetime', label: 'Date and time', input: 'datetime-local',
  allowed: new Set(),
  parse(raw) {
    const s = pyStr(raw).trim().replace(/ /g, 'T')
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2})(?::(\d{2})(?:[.,]\d{1,6})?)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(s)
    const bad = () => new ParamValueError('Enter a valid date and time.')
    if (!m) throw bad()
    const [, y, mo, d, h = '00', mi = '00', se = '00', tz] = m
    if (!validDate(+y, +mo, +d) || +h > 23 || +mi > 59 || +se > 59) throw bad()
    let zone = ''
    if (tz) {
      if (tz === 'Z') zone = '+00:00'
      else {
        const digits = tz.slice(1).replace(':', '')
        const zh = digits.slice(0, 2)
        const zm = digits.slice(2) || '00'
        if (+zh > 23 || +zm > 59) throw bad()
        zone = `${tz[0]}${zh}:${zm}`
      }
    }
    return `${y}-${mo}-${d}T${p2(+h)}:${p2(+mi)}:${p2(+se)}${zone}`
  },
  toRaw: baseToRaw,
}

export const TYPES: Record<string, ParamType> = {}

/** Add a parameter type (extension point for future types). */
export function registerType(t: ParamType): void {
  TYPES[t.key] = t
}

for (const t of [
  stringType('text', 'Text', 'text'),
  stringType('textarea', 'Text area', 'textarea'),
  numberType,
  decimalType,
  booleanType,
  stringType('password', 'Password', 'password'),
  selectType,
  multiSelectType,
  dateType,
  dateTimeType,
  stringType('file', 'File path', 'text', MAX_PATH, true),
  stringType('directory', 'Directory path', 'text', MAX_PATH, true),
]) registerType(t)

// --------------------------------------------------------------- choices ---
/** Accept ["a", "b"] or [{value: "a", label: "A"}]; returns a list of {value, label}. */
export function normalizeChoices(raw: any): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = []
  for (const c of raw || []) {
    if (isObj(c)) out.push({ value: pyStr(c.value ?? ''), label: pyStr(c.label ?? c.value ?? '') })
    else out.push({ value: pyStr(c), label: pyStr(c) })
  }
  return out
}

export function choiceValues(p: Param): string[] {
  return normalizeChoices(p.choices).map((c) => c.value)
}

// ----------------------------------------------------------- definitions ---
const isNumberLike = (v: any) => (typeof v === 'number' || typeof v === 'string') && true

/**
 * Validate a list of parameter definitions. Returns `[cleanList, errors]`; unknown keys are preserved so
 * metadata stays forward-compatible.
 */
export function validateParameters(rawList: any): [Param[], string[]] {
  const errors: string[] = []
  if (!Array.isArray(rawList)) return [[], ["'parameters' must be a list."]]

  const cleanList: Param[] = []
  const names = new Set<string>()
  const args: Record<string, string> = {}
  const positions: Record<number, string> = {}
  rawList.forEach((raw, i) => {
    let where = `Parameter #${i + 1}`
    if (!isObj(raw)) {
      errors.push(`${where}: must be an object.`)
      return
    }
    const p: Param = { ...raw }
    const name = p.name
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      errors.push(`${where}: name must start with a letter/underscore and contain only letters, digits and underscores.`)
      return
    }
    where = `Parameter '${name}'`
    if (names.has(name)) {
      errors.push(`${where}: duplicate name.`)
      return
    }
    names.add(name)
    const nBefore = errors.length

    const label = p.label
    if (label === undefined || label === null || label === '') p.label = pyTitle(name.replace(/_/g, ' '))
    else if (typeof label !== 'string' || codePoints(label) > 120) errors.push(`${where}: label must be text up to 120 characters.`)

    const ptype = 'type' in p ? p.type : 'text'
    if (typeof ptype !== 'string' || !Object.hasOwn(TYPES, ptype)) {
      errors.push(`${where}: unknown type '${pyStr(ptype)}'. Supported: ${Object.keys(TYPES).join(', ')}.`)
      return
    }
    p.type = ptype
    const t = TYPES[ptype]

    for (const key of ['required', 'editable_at_runtime'])
      if (key in p && typeof p[key] !== 'boolean') errors.push(`${where}: '${key}' must be true or false.`)
    if (!('required' in p)) p.required = false
    if (!('editable_at_runtime' in p)) p.editable_at_runtime = true
    if (ptype === 'boolean') p.required = false

    for (const key of ['help', 'placeholder']) {
      if (p[key] === undefined || p[key] === null) delete p[key]
      else if (typeof p[key] !== 'string' || codePoints(p[key]) > 1000) errors.push(`${where}: '${key}' must be text up to 1000 characters.`)
    }

    // Type-specific keys
    for (const key of TYPED_KEYS) {
      if (t.allowed.has(key)) continue
      if (!isBlank(p[key])) errors.push(`${where}: '${key}' is not valid for type '${ptype}'.`)
      delete p[key]
    }
    for (const key of ['min', 'max']) {
      if (p[key] === undefined || p[key] === null || p[key] === '') delete p[key]
      else if (t.allowed.has(key)) {
        if (!isNumberLike(p[key]) || parseDec(pyStr(p[key])) === null) errors.push(`${where}: '${key}' must be a number.`)
      }
    }
    if ('min' in p && 'max' in p) {
      const lo = parseDec(pyStr(p.min))
      const hi = parseDec(pyStr(p.max))
      if (lo && hi && decCmp(lo, hi) > 0) errors.push(`${where}: min is greater than max.`)
    }
    for (const key of ['min_length', 'max_length']) {
      if (p[key] === undefined || p[key] === null || p[key] === '') delete p[key]
      else if (t.allowed.has(key)) {
        if (typeof p[key] !== 'number' || !Number.isInteger(p[key]) || p[key] < 0)
          errors.push(`${where}: '${key}' must be a non-negative whole number.`)
      }
    }
    if (p.pattern === undefined || p.pattern === null || p.pattern === '') delete p.pattern
    else if (t.allowed.has('pattern')) {
      if (typeof p.pattern !== 'string') errors.push(`${where}: invalid pattern (pattern must be text).`)
      else {
        try {
          fullMatchRegex(p.pattern)
        } catch (e: any) {
          errors.push(`${where}: invalid pattern (${e.message}).`)
        }
      }
    }
    if (ptype === 'select' || ptype === 'multiselect') {
      const ch = p.choices
      if (!Array.isArray(ch) || !ch.length) errors.push(`${where}: needs at least one choice.`)
      else {
        let ok = true
        for (const c of ch) {
          if (isObj(c)) {
            if (!['string', 'number', 'boolean'].includes(typeof c.value) || c.value === '') ok = false
          } else if (!['string', 'number'].includes(typeof c) || pyStr(c) === '') ok = false
        }
        if (!ok) errors.push(`${where}: each choice must be a non-empty value or {value, label}.`)
        else if (new Set(choiceValues(p)).size !== ch.length) errors.push(`${where}: duplicate choice values.`)
      }
    }

    // Passing to the script
    let passAs = 'pass_as' in p ? p.pass_as : 'flag'
    if (!(PASS_AS as readonly any[]).includes(passAs)) {
      errors.push(`${where}: pass_as must be one of ${PASS_AS.join(', ')}.`)
      passAs = 'flag'
    }
    p.pass_as = passAs
    if (passAs === 'flag') {
      const arg = p.arg || '--' + name.replace(/_/g, '-')
      if (typeof arg !== 'string' || !ARG_RE.test(arg)) errors.push(`${where}: arg must look like --option-name.`)
      else {
        if (Object.hasOwn(args, arg)) errors.push(`${where}: argument ${arg} is already used by '${args[arg]}'.`)
        args[arg] = name
      }
      delete p.env_name
      delete p.position
    } else if (passAs === 'positional') {
      if (ptype === 'boolean') errors.push(`${where}: boolean parameters cannot be positional.`)
      const pos = p.position
      if (pos !== undefined && pos !== null && pos !== '') {
        if (typeof pos !== 'number' || !Number.isInteger(pos) || pos < 1) errors.push(`${where}: position must be a whole number >= 1.`)
        else if (Object.hasOwn(positions, pos)) errors.push(`${where}: position ${pos} is already used by '${positions[pos]}'.`)
        else positions[pos] = name
      } else delete p.position
      delete p.arg
      delete p.env_name
    } else {
      const env = p.env_name || name.toUpperCase()
      if (typeof env !== 'string' || !ENV_RE.test(env)) errors.push(`${where}: env_name is not a valid variable name.`)
      else if (FORBIDDEN_ENV.has(env.toUpperCase())) errors.push(`${where}: environment variable ${env} may not be set from a parameter.`)
      p.env_name = env
      delete p.arg
      delete p.position
    }

    // The default must itself be valid for the type
    if ('default' in p && p.default !== null && p.default !== undefined && !(errors.length > nBefore)) {
      const problem = checkDefault(p)
      if (problem) errors.push(`${where}: default value — ${problem}`)
    }
    if (p.default === undefined || p.default === null) delete p.default

    cleanList.push(p)
  })
  return [cleanList, errors]
}

function checkDefault(p: Param): string | null {
  const t = TYPES[p.type]
  const d = p.default
  if (p.type === 'boolean') return typeof d === 'boolean' ? null : 'must be true or false.'
  if (p.type === 'multiselect' && !Array.isArray(d)) return 'must be a list of choices.'
  if (p.type !== 'multiselect' && (Array.isArray(d) || isObj(d))) return 'has the wrong type.'
  if (d === '' || (Array.isArray(d) && d.length === 0)) return null
  try {
    t.parse(d, p)
  } catch (e) {
    if (e instanceof ParamValueError) return e.message
    throw e
  }
  return null
}

/**
 * Validate a whole metadata document. Returns the cleaned object or throws ValidationError (validators.ts)
 * with every problem found.
 */
export function validateMetadata(data: any): Record<string, any> {
  const errors: string[] = []
  if (!isObj(data)) throw new ValidationError(['Metadata must be a JSON object.'])
  const clean: Record<string, any> = { ...data }
  const sid = clean.id
  if (sid !== undefined && sid !== null && !(typeof sid === 'string' && /^[0-9a-f]{12}$/.test(sid)))
    errors.push("'id' must be 12 lowercase hex characters (ScriptHub writes it; remove it to get a new one).")

  const text = (key: string, limit: number) => {
    const v = clean[key]
    if (v === undefined || v === null || v === '') delete clean[key]
    else if (typeof v !== 'string' || codePoints(v) > limit) errors.push(`'${key}' must be text up to ${limit} characters.`)
  }
  text('name', 120)
  text('description', 2000)
  text('category', 60)
  text('interpreter', 260)
  text('working_directory', 1000)
  text('host', 255)
  if ('host' in clean && typeof clean.host === 'string' && clean.host !== 'local' && !HOST_RE.test(clean.host))
    errors.push("'host' must be 'local' or an SSH host alias (letters, digits, dots, hyphens, underscores).")

  const plats = clean.platforms
  const PLATFORMS = ['windows', 'linux', 'macos']
  if (plats === undefined || plats === null || (Array.isArray(plats) && plats.length === 0)) delete clean.platforms
  else if (!Array.isArray(plats) || plats.some((x) => !PLATFORMS.includes(x)))
    errors.push("'platforms' must be a list containing any of: windows, linux, macos.")
  else clean.platforms = PLATFORMS.filter((x) => plats.includes(x))

  const env = clean.environment
  if (env === undefined || env === null || (isObj(env) && Object.keys(env).length === 0)) delete clean.environment
  else if (!isObj(env)) errors.push("'environment' must be an object of NAME: value pairs.")
  else {
    for (const [k, v] of Object.entries(env)) {
      if (!ENV_RE.test(k)) errors.push(`'environment' has an invalid variable name: '${k}'.`)
      else if (FORBIDDEN_ENV.has(k.toUpperCase())) errors.push(`'environment' may not set ${k}.`)
      else if (typeof v !== 'string' || v.includes('\0')) errors.push(`'environment' value for ${k} must be text.`)
    }
  }

  for (const key of REMOVED_KEYS) delete clean[key] // old per-script options; dropped on the next save

  const [params, perrors] = validateParameters('parameters' in clean ? clean.parameters : [])
  errors.push(...perrors)
  clean.parameters = params

  if (errors.length) throw new ValidationError(errors)
  return clean
}

// ---------------------------------------------------------------- values ---
function isEmptyRaw(raw: any, ptype: string): boolean {
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) return true
  return ptype !== 'password' && ptype !== 'textarea' && typeof raw === 'string' && raw.trim() === ''
}

/** `[value, error]`. `value` is null when an optional field is empty. */
export function parseValue(p: Param, raw: any): [any, string | null] {
  const ptype = p.type
  const t = TYPES[ptype]
  if (ptype === 'boolean') return [pyBool(raw), null]
  if (isEmptyRaw(raw, ptype)) return p.required ? [null, 'This field is required.'] : [null, null]
  try {
    return [t.parse(raw, p), null]
  } catch (e) {
    if (e instanceof ParamValueError) return [null, e.message]
    throw e
  }
}

/** Default value in raw (form) representation. */
export function defaultRaw(p: Param): any {
  return TYPES[p.type].toRaw(p.default)
}

export function defaultsRaw(params: Param[]): Record<string, any> {
  return Object.fromEntries(params.map((p) => [p.name, defaultRaw(p)]))
}

/** A submitted form: a QueryDict-like object or a plain record of strings / string lists. */
export type PostData =
  | { get(key: string): string | null | undefined; getlist(key: string): string[] }
  | Record<string, string | string[]>

function postGet(post: PostData, key: string): string {
  if (typeof (post as any).get === 'function') return (post as any).get(key) ?? ''
  const v = (post as Record<string, string | string[]>)[key]
  return Array.isArray(v) ? (v[v.length - 1] ?? '') : (v ?? '')
}

function postList(post: PostData, key: string): string[] {
  if (typeof (post as any).getlist === 'function') return (post as any).getlist(key)
  const v = (post as Record<string, string | string[]>)[key]
  return v === undefined ? [] : Array.isArray(v) ? v : [v]
}

/** Collect raw values from a submitted form. Locked parameters keep their default. */
export function rawFromPost(params: Param[], post: PostData, prefix = 'p_'): Record<string, any> {
  const raw: Record<string, any> = {}
  for (const p of params) {
    if (p.editable_at_runtime === false) {
      raw[p.name] = defaultRaw(p)
      continue
    }
    const field = prefix + p.name
    if (p.type === 'boolean') raw[p.name] = ['on', '1', 'true', 'True'].includes(postGet(post, field))
    else if (p.type === 'multiselect') raw[p.name] = postList(post, field)
    else raw[p.name] = postGet(post, field)
  }
  return raw
}

/** Validate every parameter. Returns `[values, errors]` keyed by name. */
export function cleanValues(params: Param[], raw: Record<string, any>): [Record<string, any>, Record<string, string>] {
  const values: Record<string, any> = {}
  const errors: Record<string, string> = {}
  for (const p of params) {
    const name = p.name
    const [value, err] = parseValue(p, name in raw ? raw[name] : defaultRaw(p))
    if (err) errors[name] = err
    else values[name] = value
  }
  return [values, errors]
}

export interface Field {
  p: Param
  name: string
  input_name: string
  input: string
  value: any
  selected: Set<string>
  choices: Array<{ value: string; label: string }>
  locked: boolean
  error: string | undefined
}

/** Form-ready field descriptions. */
export function buildFields(params: Param[], raw: Record<string, any>, errors: Record<string, string> = {}): Field[] {
  return params.map((p) => {
    const value = p.name in raw ? raw[p.name] : defaultRaw(p)
    return {
      p, name: p.name, input_name: 'p_' + p.name, input: TYPES[p.type].input, value,
      selected: new Set(Array.isArray(value) ? value : []),
      choices: normalizeChoices(p.choices),
      locked: p.editable_at_runtime === false,
      error: errors[p.name],
    }
  })
}

/** [name, value] pairs that carry a validated submission to a next step. */
export function hiddenPairs(params: Param[], raw: Record<string, any>): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const p of params) {
    if (p.editable_at_runtime === false) continue
    const v = raw[p.name]
    if (p.type === 'boolean') {
      if (v) pairs.push(['p_' + p.name, 'on'])
    } else if (p.type === 'multiselect') for (const x of v || []) pairs.push(['p_' + p.name, x])
    else pairs.push(['p_' + p.name, v === null || v === undefined ? '' : pyStr(v)])
  }
  return pairs
}

// ------------------------------------------------------------- arguments ---
function asText(value: any): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return value.join(',')
  return pyStr(value)
}

/**
 * Turn validated values into `[argv, env]`. Pure list building: nothing here is ever joined into a shell
 * string.
 */
export function buildArguments(params: Param[], values: Record<string, any>, maskSecrets = false): [string[], Record<string, string>] {
  const flags: string[] = []
  const positional: Array<[number, number, string[]]> = []
  const env: Record<string, string> = {}
  const order = new Map(params.map((p, i) => [p.name, i]))
  for (const p of params) {
    const name: string = p.name
    const value = values[name]
    const secret = p.type === 'password'
    const shown = (v: string) => (maskSecrets && secret ? SECRET_MASK : v)
    const mode = p.pass_as ?? 'flag'
    if (mode === 'flag') {
      const arg = p.arg || '--' + name.replace(/_/g, '-')
      if (p.type === 'boolean') {
        if (value) flags.push(arg)
      } else if (value === undefined || value === null) continue
      else if (Array.isArray(value)) for (const item of value) flags.push(arg, item)
      else flags.push(arg, shown(pyStr(value)))
    } else if (mode === 'positional') {
      if (value === undefined || value === null) continue
      const items: string[] = Array.isArray(value) ? value : [pyStr(value)]
      positional.push([p.position || 10_000 + order.get(name)!, order.get(name)!, items.map(shown)])
    } else {
      if (value === undefined || value === null) continue
      env[p.env_name || name.toUpperCase()] = shown(asText(value))
    }
  }
  const argv = [...flags]
  positional.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  for (const [, , items] of positional) argv.push(...items)
  return [argv, env]
}

/** A copy of `values` safe to store or display (passwords masked). */
export function redact(params: Param[], values: Record<string, any>): Record<string, any> {
  const secret = new Set(params.filter((p) => p.type === 'password').map((p) => p.name))
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, secret.has(k) && v !== null && v !== undefined && v !== '' ? SECRET_MASK : v]),
  )
}
