import { describe, expect, it } from 'vitest'
import {
  SECRET_MASK, buildArguments, cleanValues, parseValue, rawFromPost, redact, validateMetadata, validateParameters,
} from '../src/parameters.js'
import { ValidationError } from '../src/validators.js'

function P(kw: Record<string, any> = {}) {
  const [clean, errors] = validateParameters([{ name: 'x', type: 'text', ...kw }])
  expect(errors).toEqual([])
  return clean[0]
}

describe('parameter values (port of ParameterValueTests)', () => {
  it('required text', () => {
    const p = P({ required: true })
    expect(parseValue(p, '')[1]).toBe('This field is required.')
    expect(parseValue(p, 'hi')).toEqual(['hi', null])
  })

  it('optional empty is null', () => {
    expect(parseValue(P(), '  ')).toEqual([null, null])
  })

  it('number range and type', () => {
    const p = P({ type: 'number', min: 1, max: 365 })
    expect(parseValue(p, '30')).toEqual([30, null])
    expect(parseValue(p, '0')[1]).toContain('at least')
    expect(parseValue(p, '366')[1]).toContain('at most')
    expect(parseValue(p, '3.5')[1]).toContain('whole number')
    expect(parseValue(p, 'abc')[1]).toContain('whole number')
    expect(parseValue(P({ type: 'number' }), '+007')).toEqual([7, null])
    expect(parseValue(P({ type: 'number' }), '123456789012345678')).toEqual(['123456789012345678', null]) // beyond 2^53: digits kept
  })

  it('decimal', () => {
    const p = P({ type: 'decimal', min: 0, max: 1 })
    expect(parseValue(p, '0.25')).toEqual(['0.25', null])
    expect(parseValue(p, 'NaN')[1]).toContain('valid decimal')
    expect(parseValue(p, '1.5')[1]).toContain('at most')
    const free = P({ type: 'decimal' })
    expect(parseValue(free, '1.50')[0]).toBe('1.50')
    expect(parseValue(free, '.5')[0]).toBe('0.5')
    expect(parseValue(free, '1E+2')[0]).toBe('100')
    expect(parseValue(free, '-2.5e-3')[0]).toBe('-0.0025')
  })

  it('boolean', () => {
    const p = P({ type: 'boolean' })
    expect(parseValue(p, true)).toEqual([true, null])
    expect(parseValue(p, false)).toEqual([false, null])
  })

  it('select and multiselect', () => {
    const p = P({ type: 'select', choices: ['a', { value: 'b', label: 'Bee' }] })
    expect(parseValue(p, 'b')).toEqual(['b', null])
    expect(parseValue(p, 'z')[1]).toContain('one of')
    const m = P({ type: 'multiselect', choices: ['a', 'b'] })
    expect(parseValue(m, ['a', 'b'])).toEqual([['a', 'b'], null])
    expect(parseValue(m, ['a', 'q'])[1]).toContain('not an available')
  })

  it('date and datetime', () => {
    expect(parseValue(P({ type: 'date' }), '2026-11-07')).toEqual(['2026-11-07', null])
    expect(parseValue(P({ type: 'date' }), '07/11/2026')[1]).toContain('valid date')
    expect(parseValue(P({ type: 'date' }), '2026-02-30')[1]).toContain('valid date')
    expect(parseValue(P({ type: 'datetime' }), '2026-11-07T10:30')).toEqual(['2026-11-07T10:30:00', null])
    expect(parseValue(P({ type: 'datetime' }), '2026-11-07 10:30:15.123')).toEqual(['2026-11-07T10:30:15', null])
    expect(parseValue(P({ type: 'datetime' }), 'tomorrow')[1]).toContain('valid date and time')
  })

  it('pattern and length', () => {
    const p = P({ pattern: '[a-z]+', max_length: 5 })
    expect(parseValue(p, 'abc')).toEqual(['abc', null])
    expect(parseValue(p, 'ABC')[1]).toContain('format')
    expect(parseValue(p, 'abcdefg')[1]).toContain('at most')
    expect(parseValue(P({ pattern: 'a|b' }), 'ab')[1]).toContain('format') // must match the whole string, alternatives included
  })

  it('paths reject control characters', () => {
    expect(parseValue(P({ type: 'directory' }), 'a\nb')[1]).toContain('invalid')
  })
})

describe('definition validation (port of DefinitionValidationTests)', () => {
  const check = (params: any[]) => validateParameters(params)[1]

  it('bad names and duplicates', () => {
    expect(check([{ name: '1bad' }]).length).toBeGreaterThan(0)
    expect(check([{ name: 'a' }, { name: 'a' }]).length).toBeGreaterThan(0)
  })

  it('unknown type', () => {
    expect(check([{ name: 'a', type: 'color' }].map((x) => x)).some((e) => e.includes('unknown type'))).toBe(true)
  })

  it('select needs choices', () => {
    expect(check([{ name: 'a', type: 'select' }]).length).toBeGreaterThan(0)
  })

  it('incompatible attribute', () => {
    expect(check([{ name: 'a', type: 'text', choices: ['x'] }]).some((e) => e.includes('not valid'))).toBe(true)
  })

  it('min greater than max and bad default', () => {
    expect(check([{ name: 'a', type: 'number', min: 5, max: 1 }]).some((e) => e.includes('greater'))).toBe(true)
    expect(check([{ name: 'a', type: 'number', max: 5, default: 9 }]).length).toBeGreaterThan(0)
  })

  it('bad pattern', () => {
    expect(check([{ name: 'a', pattern: '(' }]).some((e) => e.includes('pattern'))).toBe(true)
  })

  it('duplicate flag and position', () => {
    expect(check([{ name: 'a', arg: '--z' }, { name: 'b', arg: '--z' }]).length).toBeGreaterThan(0)
    expect(check([{ name: 'a', pass_as: 'positional', position: 1 }, { name: 'b', pass_as: 'positional', position: 1 }]).length)
      .toBeGreaterThan(0)
  })

  it('forbidden env', () => {
    expect(check([{ name: 'a', pass_as: 'env', env_name: 'PATH' }]).length).toBeGreaterThan(0)
  })

  it('keeps unknown keys', () => {
    const [clean, errors] = validateParameters([{ name: 'a', future_option: 42 }])
    expect(errors).toEqual([])
    expect(clean[0].future_option).toBe(42)
  })

  it('fills in defaults for label, required, editable and pass_as', () => {
    const [clean] = validateParameters([{ name: 'backup_path', type: 'directory' }])
    expect(clean[0]).toEqual({
      name: 'backup_path', type: 'directory', label: 'Backup Path', required: false, editable_at_runtime: true, pass_as: 'flag',
    })
  })

  it('metadata collects errors', () => {
    try {
      validateMetadata({ platforms: 'x', environment: 5, parameters: [{ name: '!' }] })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
      expect((e as ValidationError).errors.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('drops the removed per-script options', () => {
    expect(validateMetadata({ name: 'x', enabled: false, timeout: 'soon', allow_concurrent: 1 })).toEqual({ name: 'x', parameters: [] })
  })

  it('validates host, id and orders platforms', () => {
    expect(() => validateMetadata({ host: 'bad host!' })).toThrow(ValidationError)
    expect(() => validateMetadata({ id: 'XYZ' })).toThrow(ValidationError)
    expect(validateMetadata({ host: 'local', platforms: ['linux', 'windows'] }).platforms).toEqual(['windows', 'linux'])
    expect(() => validateMetadata({ environment: { PATH: 'x' } })).toThrow(ValidationError)
    expect(() => validateMetadata([])).toThrow(ValidationError)
  })
})

describe('arguments (port of ArgumentTests)', () => {
  const [PARAMS] = validateParameters([
    { name: 'database', type: 'text', default: 'mydb', required: true },
    { name: 'backup_path', type: 'directory', arg: '--backup-path' },
    { name: 'compress', type: 'boolean' },
    { name: 'tags', type: 'multiselect', choices: ['a', 'b'] },
    { name: 'token', type: 'password' },
    { name: 'target', type: 'text', pass_as: 'positional', position: 2 },
    { name: 'first', type: 'text', pass_as: 'positional', position: 1 },
    { name: 'region', type: 'text', pass_as: 'env', env_name: 'APP_REGION' },
  ])

  it('builds argv and env without a shell', () => {
    const values = { database: 'd b; rm -rf /', backup_path: '/b', compress: true, tags: ['a', 'b'], token: 's3cret', target: 'T', first: 'F', region: 'eu' }
    const [argv, env] = buildArguments(PARAMS, values)
    expect(argv).toEqual(['--database', 'd b; rm -rf /', '--backup-path', '/b', '--compress', '--tags', 'a', '--tags', 'b', '--token', 's3cret', 'F', 'T'])
    expect(env).toEqual({ APP_REGION: 'eu' })
  })

  it('omits a false boolean and empty values', () => {
    const [argv] = buildArguments(PARAMS, { compress: false, database: 'x', backup_path: null })
    expect(argv).toEqual(['--database', 'x'])
  })

  it('masks and redacts secrets', () => {
    const [argv] = buildArguments(PARAMS, { token: 's3cret' }, true)
    expect(argv).not.toContain('s3cret')
    expect(argv).toContain(SECRET_MASK)
    expect(redact(PARAMS, { token: 's3cret', database: 'x' }).token).toBe(SECRET_MASK)
    expect(redact(PARAMS, { token: '', database: 'x' }).token).toBe('')
  })

  it('round-trips a post and keeps locked values', () => {
    const [params] = validateParameters([
      { name: 'a', type: 'text', default: 'D' },
      { name: 'b', type: 'text', default: 'fixed', editable_at_runtime: false },
      { name: 'c', type: 'boolean', default: true },
    ])
    const raw = rawFromPost(params, { p_a: 'hello', p_b: 'hacked' }) // c unchecked
    expect(raw).toEqual({ a: 'hello', b: 'fixed', c: false })
    const [values, errors] = cleanValues(params, raw)
    expect(errors).toEqual({})
    expect(values.b).toBe('fixed')
  })

  it('reads a QueryDict-like post, multiselect included', () => {
    const [params] = validateParameters([{ name: 'm', type: 'multiselect', choices: ['x', 'y'] }, { name: 'on', type: 'boolean' }])
    const post = { get: (k: string) => (k === 'p_on' ? 'on' : undefined), getlist: (k: string) => (k === 'p_m' ? ['x', 'y'] : []) }
    expect(rawFromPost(params, post)).toEqual({ m: ['x', 'y'], on: true })
  })

  it('reports errors per field', () => {
    const [params] = validateParameters([{ name: 'n', type: 'number', required: true }])
    expect(cleanValues(params, { n: '' })[1]).toEqual({ n: 'This field is required.' })
  })
})
