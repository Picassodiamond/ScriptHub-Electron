import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Ids, newId, pathId, valid } from '../src/ids.js'
import { tmpDirs } from './helpers.js'

describe('ids (port of runner/test_ids.py)', () => {
  it('makes 12-hex ids; path ids follow the path', () => {
    expect(valid(newId())).toBe(true)
    expect(newId()).not.toBe(newId())
    expect(pathId('/t/a.py')).toBe(pathId('/t/a.py'))
    expect(pathId('/t/a.py')).not.toBe(pathId('/t/b.py'))
    for (const bad of ['', 'ABCDEF123456', 'abc', '../../etc/x', null, 5]) expect(valid(bad)).toBe(false)
  })

  it('matches the Python path id on Windows (case and slash insensitive)', () => {
    expect(pathId('C:/Scripts/A.py', 'win32')).toBe(pathId('c:\\scripts\\a.py', 'win32'))
    // sha1("c:\\scripts\\a.py")[:12], as the Python app computes it
    expect(pathId('C:\\Scripts\\A.py', 'win32')).toBe('68342ac86369')
  })

  it('resolves alias chains and keeps them next to the config', () => {
    const dirs = tmpDirs()
    const ids = new Ids(dirs)
    const [a, b, c] = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']
    ids.addAlias(a, b)
    ids.addAlias(b, c)
    expect(ids.canonical(a)).toBe(c)
    expect(ids.canonical(c)).toBe(c)
    expect(JSON.parse(fs.readFileSync(dirs.scriptIdsFile, 'utf8')).aliases).toEqual({ [a]: b, [b]: c })
    ids.addAlias('../bad', c)
    expect(ids.aliases()).not.toHaveProperty('../bad')
  })

  it('adopt moves saved values without overwriting', () => {
    const dirs = tmpDirs()
    const ids = new Ids(dirs)
    const [old, next] = ['111111111111', '222222222222']
    const put = (p: string, t: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t) }
    put(path.join(dirs.presets, old, 'recent', 'RUN-20260101-001.yaml'), 'values: {}\n')
    put(path.join(dirs.presets, old, 'prod.yaml'), 'name: Prod\n')
    put(path.join(dirs.presets, next, 'prod.yaml'), 'name: Kept\n')
    put(path.join(dirs.backups, old, 'x.py'), 'v1')
    ids.adopt(old, next)
    expect(fs.readFileSync(path.join(dirs.presets, next, 'prod.yaml'), 'utf8')).toBe('name: Kept\n')
    expect(fs.existsSync(path.join(dirs.presets, next, 'recent', 'RUN-20260101-001.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(dirs.presets, old))).toBe(false)
    expect(fs.readFileSync(path.join(dirs.backups, next, 'x.py'), 'utf8')).toBe('v1')
    expect(ids.canonical(old)).toBe(next)
  })
})
