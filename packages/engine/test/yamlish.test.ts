import { describe, expect, it } from 'vitest'
import { dump, load, YamlError } from '../src/yamlish.js'

describe('yamlish (port of runner/test_yamlish.py)', () => {
  it('round-trips awkward values', () => {
    const data = {
      name: 'Prod: backup #1', host: 'local', saved_at: '2026-11-08T20:44:13', nothing: null,
      values: {
        source: '/data/project', dest: 'C:\\backups', compress: true, count: 4, ratio: 0.5,
        looks_bool: 'yes', looks_int: '007', empty: '', quote: 'it\'s "x"', unicode: 'café ✓',
        tags: ['a', 'b c', 'true', '1'], none: [], trailing: 'x ', colon: 'a:b',
      },
    }
    const text = dump(data, 'Preset for x.py\nPasswords are never stored.')
    expect(text.startsWith('# Preset for x.py\n# Passwords are never stored.\n')).toBe(true)
    expect(text).toContain('\nvalues:\n  source: /data/project\n')
    expect(load(text)).toEqual(data)
  })

  it('reads hand-written forms', () => {
    const text = "# comment\n---\na: 1   # trailing comment\nb:\n- x\n- 'it''s'\nc: ~\nd:\n    e: \"q\"\n"
    expect(load(text)).toEqual({ a: 1, b: ['x', "it's"], c: null, d: { e: 'q' } })
  })

  it('raises on unsupported or broken input', () => {
    const bad = ['a:\n\t- x', 'a: [1, 2', 'a: [1 2]x', 'a: {k}', "a: ['x]", 'a: [&x]', 'a: &anchor x', '- x\n- y',
      'a: 1\n  b: 2', "a: 'open", 'a: "bad\\q"', 'a:\n  - b: 1\n    - c']
    for (const b of bad) expect(() => load(b), b).toThrow(YamlError)
  })

  it('round-trips lists of mappings', () => {
    const data = {
      name: 'Nightly',
      steps: [
        { script: '3f9a1c0b7d22', path: 'C:\\scripts\\db.py', values: { days: 30, tags: ['a', 'b'] }, on_failure: 'stop' },
        {},
        { script: '81be44f0a913', preset: 'prod', values: {}, on_failure: 'continue' },
      ],
      after: ['x', '- y', 'k: v'],
    }
    const text = dump(data)
    expect(text).toContain('steps:\n  - script: 3f9a1c0b7d22\n    path: C:\\scripts\\db.py\n    values:\n      days: 30\n')
    expect(text).toContain('\n  - {}\n')
    expect(load(text)).toEqual(data)
  })

  it('reads hand-written lists of mappings', () => {
    const text = 'steps:\n- script: abc\n  values:\n    a: 1\n-   script: def\n    on_failure: continue\n- plain\nend: 1\n'
    expect(load(text)).toEqual({
      steps: [{ script: 'abc', values: { a: 1 } }, { script: 'def', on_failure: 'continue' }, 'plain'], end: 1,
    })
  })

  it('refuses lists inside lists', () => {
    expect(() => dump({ a: [['x']] })).toThrow(YamlError)
  })

  it('reads flow collections', () => {
    const text = "a: [1, 'x''y', \"q,w\", {k: v, z: [true, null]}]\np:\n  - {name: a, type: text}\n  - [1, 2]\n" +
      'e: [ ]\nu: [http://x:80/a]\nt: [a, b, ]\n'
    expect(load(text)).toEqual({
      a: [1, "x'y", 'q,w', { k: 'v', z: [true, null] }],
      p: [{ name: 'a', type: 'text' }, [1, 2]], e: [], u: ['http://x:80/a'], t: ['a', 'b'],
    })
  })

  it('round-trips flow dumps', () => {
    const data = {
      name: 'Hello',
      parameters: [
        { name: 'greeting', type: 'select', default: 'on',
          choices: ['Hello', 'Hi, there', 'on', '5', '[x]', 'a: b', '', "it's", '{y}'] },
        { name: 'n', type: 'number', default: 1.5, min: -3, help: null },
      ],
      tags: [], nested: { a: [1, 2] }, lol: [[1, 2], ['a,b']], long: Array(5).fill('x'.repeat(30)),
    }
    const text = dump(data, '', true)
    expect(text).toContain('\n    choices: [Hello, "Hi, there", "on", "5", "[x]", "a: b", "", "it\'s", "{y}"]\n')
    expect(text).toContain('\nlong:\n  - xxx')
    expect(load(text)).toEqual(data)
    expect(dump({ a: ['x', 'y'] })).not.toContain('[')
  })
})
