import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Ids } from '../src/ids.js'
import { SequenceError, Sequences, parseText, dumpText, topoOrder, type ScriptLike } from '../src/sequences.js'
import { tmpDirs } from './helpers.js'

const script = (id: string, name = 'Backup'): ScriptLike => ({ id, pathId: id, path: `C:\\s\\${name}.py`, name })

function setup() {
  const dirs = tmpDirs()
  const seqs = new Sequences(dirs, new Ids(dirs))
  return { dirs, seqs }
}

describe('sequences storage (port of runner/test_sequences.py)', () => {
  it('creates, lists, renames and deletes with unique names and slugs', () => {
    const { seqs } = setup()
    const slug = seqs.create('Nightly maintenance')
    expect(slug).toBe('nightly-maintenance')
    expect(() => seqs.create('nightly MAINTENANCE')).toThrow(SequenceError)
    expect(seqs.create('Nightly  maintenance!')).toBe('nightly-maintenance-2') // same slug base, new name
    seqs.rename(slug, 'Weekly')
    expect(seqs.get(slug)!.name).toBe('Weekly')
    expect(seqs.list().map((s) => s.name)).toEqual(['Nightly maintenance!', 'Weekly'])
    expect(seqs.delete(slug)).toBe(true)
    expect(seqs.delete(slug)).toBe(false)
    expect(() => seqs.create('   ')).toThrow(SequenceError)
    expect(() => seqs.create('x'.repeat(61))).toThrow(SequenceError)
  })

  it('adds steps with growing ids that are never reused, and removes arrows with a step', () => {
    const { seqs } = setup()
    const slug = seqs.create('Seq')
    const a = seqs.addStep(slug, seqs.newStep(script('aaaaaaaaaaaa'), {}, '', 40, 40))
    const b = seqs.addStep(slug, seqs.newStep(script('bbbbbbbbbbbb'), { days: 3 }, '', 41, 200))
    expect([a, b]).toEqual(['s1', 's2'])
    seqs.link(slug, a, b, 'failure')
    seqs.removeStep(slug, b)
    expect(seqs.load(slug).links).toEqual([])
    // the highest remaining id is s1, so s2 is free again only because s2 was the last one removed
    expect(seqs.addStep(slug, seqs.newStep(script('cccccccccccc'), {}))).toBe('s2')
    expect(seqs.load(slug).steps[1].x).toBe(0)
  })

  it('snaps positions to the 20px grid (halves go to even, like Python round)', () => {
    const { seqs } = setup()
    const slug = seqs.create('Grid')
    const a = seqs.addStep(slug, seqs.newStep(script('aaaaaaaaaaaa'), {}))
    seqs.moveSteps(slug, { [a]: [10, 30] })
    const s = seqs.load(slug).steps[0]
    expect([s.x, s.y]).toEqual([0, 40])
    seqs.moveSteps(slug, { [a]: [99999, -5] })
    expect([seqs.load(slug).steps[0].x, seqs.load(slug).steps[0].y]).toEqual([20000, 0])
    expect(() => seqs.moveSteps(slug, { nope: [0, 0] })).toThrow(SequenceError)
  })

  it('refuses loops, self arrows, duplicates and unknown conditions; relinking changes the condition', () => {
    const { seqs } = setup()
    const slug = seqs.create('Loop')
    const [a, b, c] = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'].map((id) => seqs.addStep(slug, seqs.newStep(script(id), {})))
    seqs.link(slug, a, b)
    seqs.link(slug, b, c)
    expect(() => seqs.link(slug, c, a)).toThrow(/loop/)
    expect(() => seqs.link(slug, a, a)).toThrow(SequenceError)
    expect(() => seqs.link(slug, a, b, 'sometimes' as any)).toThrow(SequenceError)
    seqs.link(slug, a, b, 'always')
    expect(seqs.load(slug).links.filter((l) => l.from === a && l.to === b)).toEqual([{ from: a, to: b, when: 'always' }])
    expect(() => seqs.unlink(slug, c, a)).toThrow(SequenceError)
    seqs.unlink(slug, a, b)
    expect(seqs.load(slug).links.length).toBe(1)
  })

  it('orders steps by arrows, keeping list order where free', () => {
    const steps = ['s1', 's2', 's3', 's4'].map((id) => ({ id } as any))
    expect(topoOrder({ steps, links: [{ from: 's4', to: 's1', when: 'success' }] })).toEqual(['s2', 's3', 's4', 's1'])
    expect(topoOrder({ steps: steps.slice(0, 2), links: [{ from: 's1', to: 's2', when: 'success' }, { from: 's2', to: 's1', when: 'success' }] })).toBeNull()
  })

  it('reads first-version files (on_failure, no links) as a chain', () => {
    const text = 'name: Old\nsteps:\n  - script: aaaaaaaaaaaa\n    on_failure: continue\n  - script: bbbbbbbbbbbb\n    on_failure: stop\n  - script: cccccccccccc\n'
    const d = parseText(text)
    expect(d.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(d.links).toEqual([{ from: 's1', to: 's2', when: 'always' }, { from: 's2', to: 's3', when: 'success' }])
  })

  it('round-trips through text, stores values only without a preset, and never stores empty keys', () => {
    const d = parseText('name: N\nsteps:\n  - id: s1\n    script: aaaaaaaaaaaa\n    preset: prod\n    values:\n      a: 1\n    x: 20\n    y: 40\n  - id: s2\n    script: bbbbbbbbbbbb\n    values:\n      days: 30\n    join: any\n    x: 20\n    y: 160\nlinks:\n  - from: s1\n    to: s2\n    when: always\n')
    const text = dumpText(d)
    expect(text.startsWith('# Sequence for ScriptHub. Passwords are never stored.\n')).toBe(true)
    expect(text).not.toMatch(/host:/)
    const again = parseText(text)
    expect(again.steps[0].preset).toBe('prod')
    expect(again.steps[0].values).toEqual({}) // a preset replaces stored values
    expect(again.steps[1]).toMatchObject({ join: 'any', values: { days: 30 } })
    expect(text.split('values:').length - 1).toBe(1)
    expect(text).toMatch(/preset: prod\n\s+x: 20/)
  })

  it('rejects bad files with a reason and lists them as broken without overwriting', () => {
    const { dirs, seqs } = setup()
    fs.mkdirSync(dirs.sequences, { recursive: true })
    for (const bad of ['name: X\nsteps:\n  - script: zz\n', 'steps: []\n', 'name: X\nsteps:\n  - id: s1\n    script: aaaaaaaaaaaa\n  - id: s1\n    script: bbbbbbbbbbbb\n']) expect(() => parseText(bad)).toThrow(SequenceError)
    const broken = path.join(dirs.sequences, 'broken.yaml')
    fs.writeFileSync(broken, 'name: X\nsteps: nope\n')
    const item = seqs.list().find((s) => s.slug === 'broken')!
    expect(item.error).toMatch(/could not be read/)
    expect(seqs.get('broken')).toBeNull()
    expect(() => seqs.rename('broken', 'Y')).toThrow(SequenceError)
    expect(fs.readFileSync(broken, 'utf8')).toBe('name: X\nsteps: nope\n')
  })

  it('resolves a step by id, else by its last known path with the same id; refresh updates path and name', () => {
    const dirs = tmpDirs()
    const moved = { id: 'aaaaaaaaaaaa', pathId: '111111111111', path: 'D:\\new\\a.py', name: 'A2' }
    const other = { id: 'ffffffffffff', pathId: 'ffffffffffff', path: 'D:\\x.py', name: 'X' }
    const seqs = new Sequences(dirs, new Ids(dirs), { getScript: () => null, loadFile: (p) => (p === 'D:\\new\\a.py' ? moved : p === 'D:\\x.py' ? other : null) })
    const slug = seqs.create('R')
    const id = seqs.addStep(slug, { ...seqs.newStep(script('aaaaaaaaaaaa'), {}), path: 'D:\\new\\a.py' })
    const step = seqs.load(slug).steps[0]
    expect(seqs.resolve(step)?.name).toBe('A2')
    expect(seqs.resolve({ ...step, path: 'D:\\x.py' })).toBeNull() // different id there
    expect(seqs.resolve({ ...step, path: '' })).toBeNull()
    const data = seqs.load(slug)
    seqs.refresh(slug, data, [moved])
    expect(seqs.load(slug).steps.find((s) => s.id === id)).toMatchObject({ path: 'D:\\new\\a.py', name: 'A2' })
  })
})
