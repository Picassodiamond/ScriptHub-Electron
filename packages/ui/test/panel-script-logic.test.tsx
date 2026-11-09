import { describe, expect, it } from 'vitest'
import { changeCount, diffLines } from '../src/panels/script/diff'
import { blockOf, blockRange, cleanTerms, refLines, termsOfDefinition, termsOfParam } from '../src/panels/script/meta'
import { checkDrafts, fromDraft, newDraft, summaryOf, textToChoices, toDraft, type TypeInfo } from '../src/panels/script/paramModel'
import { checkValue, initialValues, postValues } from '../src/panels/script/validate'

const TYPES: Record<string, TypeInfo> = {
  text: { label: 'Text', allowed: ['min_length', 'max_length', 'pattern'] },
  number: { label: 'Number', allowed: ['min', 'max'] },
  boolean: { label: 'Boolean', allowed: [] },
  select: { label: 'Select', allowed: ['choices'] },
  multiselect: { label: 'Multi', allowed: ['choices'] },
  password: { label: 'Password', allowed: ['min_length', 'max_length'] },
}

describe('metadata block and parameter marking', () => {
  const py = '#!/usr/bin/env python3\n# --- scripthub ---\n# name: X\n# --- end scripthub ---\nprint(1)\n'
  it('finds the block in # and :: and rem comments, with CRLF', () => {
    expect(blockOf(py)).toBe('# --- scripthub ---\n# name: X\n# --- end scripthub ---')
    expect(blockOf(py.replace(/\n/g, '\r\n'))).toBe('# --- scripthub ---\n# name: X\n# --- end scripthub ---')
    expect(blockOf(':: --- scripthub ---\n:: name: X\n:: --- end scripthub ---\n')).toContain(':: name: X')
    expect(blockOf('REM --- scripthub ---\nREM name: X\nREM --- end scripthub ---')).toContain('REM name: X')
    expect(blockOf('print(1)\n')).toBe('')
    expect(blockOf('# --- scripthub ---\n# unfinished\n')).toBe('')
    expect(blockRange(py)).toEqual([2, 4])
    expect(blockRange('x')).toBeNull()
  })

  it('marks whole-word references only', () => {
    const src = 'days = int(args.days)\nmydays = 1\nprint("--days", days)\nenv = os.environ["DAYS"]\n'
    expect(refLines(src, ['days'])).toEqual([1, 3])
    expect(refLines(src, ['--days'])).toEqual([3])
    expect(refLines(src, ['DAYS'])).toEqual([4])
    expect(refLines(src, ['x'])).toEqual([]) // one-letter terms are ignored
    expect(cleanTerms(['a', '—', '12', 'ok'])).toEqual(['ok'])
  })

  it('derives terms from a parameter and from a definition with defaults', () => {
    expect(termsOfParam({ name: 'days', arg: '--n', env_name: 'DAYS' })).toEqual(['days', '--n', 'DAYS'])
    expect(termsOfDefinition({ name: 'max_size' })).toEqual(['max_size', '--max-size'])
    expect(termsOfDefinition({ name: 'max_size', pass_as: 'env' })).toEqual(['max_size', 'MAX_SIZE'])
    expect(termsOfDefinition({ name: 'src', pass_as: 'positional' })).toEqual(['src'])
  })
})

describe('parameter editor model', () => {
  it('round-trips a definition and keeps keys the editor does not know', () => {
    const p = { name: 'mode', label: 'Mode', type: 'select', default: 'fast', required: true, editable_at_runtime: true,
      choices: ['fast', { value: 'slow', label: 'Slow one' }], pass_as: 'flag', arg: '--mode', future_key: { a: 1 } }
    const d = toDraft(p)
    expect(d.choices).toBe('fast\nslow|Slow one')
    expect(fromDraft(d, TYPES)).toEqual(p)
  })

  it('writes defaults by type (number, multiselect, boolean, password) and drops options the type does not allow', () => {
    const base = { name: 'x', pass_as: 'flag', editable_at_runtime: true }
    expect(fromDraft(toDraft({ ...base, type: 'number', default: 5, min: 1, max: 9 }), TYPES)).toMatchObject({ default: 5, min: 1, max: 9, required: false })
    expect(fromDraft(toDraft({ ...base, type: 'multiselect', default: ['a', 'b'], choices: ['a', 'b', 'c'] }), TYPES).default).toEqual(['a', 'b'])
    const bool = fromDraft(toDraft({ ...base, type: 'boolean', default: true }), TYPES)
    expect(bool.default).toBe(true)
    expect('required' in bool).toBe(false)
    const text = toDraft({ ...base, type: 'text', default: 'hi', min: 3 })
    expect('min' in fromDraft({ ...text, min: '3' }, TYPES)).toBe(false)
    expect(fromDraft(toDraft({ ...base, type: 'password', default: '  pw ' }), TYPES).default).toBe('  pw ')
  })

  it('writes the pass-as options for the chosen mode only', () => {
    const d = { ...newDraft('src'), pass_as: 'positional', position: '2', arg: '--ignored', env_name: 'IGNORED' }
    const o = fromDraft(d, TYPES)
    expect(o).toMatchObject({ pass_as: 'positional', position: 2 })
    expect(o.arg).toBeUndefined()
    expect(fromDraft({ ...newDraft('e'), pass_as: 'env', env_name: ' TOKEN ' }, TYPES).env_name).toBe('TOKEN')
  })

  it('summarises a row like the old table', () => {
    expect(summaryOf({ name: 'max_size', type: 'number', default: 3, pass_as: 'flag', editable_at_runtime: true, required: true }))
      .toEqual({ label: '—', name: 'max_size', type: 'number', def: '3', req: 'Yes', rt: 'Editable', pass: '--max-size' })
    expect(summaryOf({ name: 'pw', type: 'password', default: 'x', pass_as: 'env', editable_at_runtime: false }).def).toBe('••••••')
    expect(summaryOf({ name: 'b', type: 'boolean', default: false, pass_as: 'positional', position: 1 })).toMatchObject({ def: 'No', req: '—', pass: 'positional 1' })
  })

  it('parses choices one per line', () => {
    expect(textToChoices('a\n b|Bee \n\n')).toEqual(['a', { value: 'b', label: 'Bee' }])
  })

  it('gives early hints for names, duplicates, choices, ranges, patterns, flags and positions', () => {
    const list = [
      { ...newDraft('ok'), type: 'text' },
      { ...newDraft('ok'), type: 'text' }, // duplicate
      { ...newDraft('1bad'), type: 'text' },
      { ...newDraft(''), type: 'text' },
      { ...newDraft('sel'), type: 'select', choices: '' },
      { ...newDraft('rng'), type: 'number', min: '9', max: '2' },
      { ...newDraft('pat'), type: 'text', pattern: '(' },
      { ...newDraft('flag'), arg: 'nodash' },
      { ...newDraft('p1'), pass_as: 'positional', position: '1' },
      { ...newDraft('p2'), pass_as: 'positional', position: '1' },
      { ...newDraft('env'), pass_as: 'env', env_name: '9X' },
    ]
    const r = checkDrafts(list, TYPES)
    const at = (i: number) => (r.get(list[i].uid) ?? []).join(' | ')
    expect(r.has(list[0].uid)).toBe(false)
    expect(at(1)).toMatch(/used by another parameter/)
    expect(at(2)).toMatch(/must not start with a digit/)
    expect(at(3)).toMatch(/needs a name/)
    expect(at(4)).toMatch(/at least one choice/)
    expect(at(5)).toMatch(/minimum is larger/)
    expect(at(6)).toMatch(/not a valid regular expression/)
    expect(at(7)).toMatch(/starts with -/)
    expect(r.has(list[8].uid)).toBe(false)
    expect(at(9)).toMatch(/Position 1 is used/)
    expect(at(10)).toMatch(/variable name/)
  })
})

describe('run form hints and values', () => {
  const f = (input: string, p: Record<string, any> = {}, choices: Array<{ value: string; label: string }> = []) => ({ name: 'x', input, p, choices, locked: false })
  it('checks required, numbers, ranges, choices, dates, lengths and patterns', () => {
    expect(checkValue(f('text', { required: true }), '')).toMatch(/required/)
    expect(checkValue(f('text', {}), '')).toBeNull()
    expect(checkValue(f('number', {}), '1.5')).toMatch(/whole number/)
    expect(checkValue(f('number', { min: 2 }), '1')).toMatch(/at least 2/)
    expect(checkValue(f('number', { max: 5 }), '9')).toMatch(/at most 5/)
    expect(checkValue(f('decimal', {}), '1.5')).toBeNull()
    expect(checkValue(f('decimal', {}), 'abc')).toMatch(/number/)
    expect(checkValue(f('select', {}, [{ value: 'a', label: 'A' }]), 'b')).toMatch(/listed/)
    expect(checkValue(f('multiselect', {}, [{ value: 'a', label: 'A' }]), ['a', 'z'])).toMatch(/listed/)
    expect(checkValue(f('multiselect', { required: true }, []), [])).toMatch(/required/)
    expect(checkValue(f('date', {}), '2026-13')).toMatch(/YYYY-MM-DD/)
    expect(checkValue(f('text', { min_length: 3 }), 'ab')).toMatch(/at least 3/)
    expect(checkValue(f('text', { max_length: 2 }), 'abc')).toMatch(/at most 2/)
    expect(checkValue(f('text', { pattern: '[a-z]+' }), 'AB')).toMatch(/format/)
    expect(checkValue(f('text', { pattern: '[a-z]+' }), 'ab')).toBeNull()
    expect(checkValue(f('text', { pattern: '(?P<n>x)' }), 'x')).toBeNull() // Python-only syntax: left to the server
    expect(checkValue({ ...f('text', { required: true }), locked: true }, '')).toBeNull()
    expect(checkValue(f('checkbox', { required: true }), false)).toBeNull()
  })

  it('posts every editable field in the shape the engine reads, and skips fixed ones', () => {
    const fields = [f('text'), { ...f('checkbox'), name: 'flag' }, { ...f('multiselect'), name: 'm' }, { ...f('text'), name: 'fixed', locked: true }]
    expect(postValues(fields, { x: 'hi', m: ['a'], fixed: 'zzz' })).toEqual({ x: 'hi', flag: false, m: ['a'] })
  })

  it('builds the initial values from the fields the engine sent', () => {
    const fields = [
      { ...f('text'), value: 'a' }, { ...f('checkbox'), name: 'c', value: true }, { ...f('multiselect'), name: 'm', value: ['q'], selected: ['q'] },
      { ...f('number'), name: 'n', value: 3 }, { ...f('text'), name: 'e', value: null },
    ]
    expect(initialValues(fields)).toEqual({ x: 'a', c: true, m: ['q'], n: '3', e: '' })
  })
})

describe('line diff', () => {
  it('aligns equal, changed, added and deleted lines', () => {
    const rows = diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n')
    expect(rows.map((r) => r.kind)).toEqual(['same', 'change', 'same', 'same', 'add'])
    expect(rows[1]).toMatchObject({ left: 2, right: 2, leftText: 'b', rightText: 'B' })
    expect(rows[4]).toMatchObject({ left: null, right: 5, rightText: 'e' })
    expect(changeCount(rows)).toBe(2)
  })

  it('shows pure deletions and ignores CRLF differences', () => {
    const rows = diffLines('x\r\ny\r\nz\r\n', 'x\nz\n')
    expect(rows.map((r) => r.kind)).toEqual(['same', 'del', 'same'])
    expect(rows[1]).toMatchObject({ left: 2, right: null, leftText: 'y' })
    expect(changeCount(diffLines('same\n', 'same\n'))).toBe(0)
    expect(diffLines('', '')).toEqual([])
  })
})
