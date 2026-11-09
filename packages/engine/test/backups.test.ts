import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BackupError, Backups, KEEP } from '../src/backups.js'
import { tmpDir, tmpDirs } from './helpers.js'

const SID = '0123456789ab'

describe('backups (port of runner/backups.py)', () => {
  it('stores the newest first and names files with a timestamp', () => {
    const b = new Backups(tmpDirs())
    b.add(SID, 'a.py', Buffer.from('v1'))
    b.add(SID, 'a.py', Buffer.from('v2'))
    const v = b.versions(SID)
    expect(v).toHaveLength(2)
    expect(v[0].name).toMatch(/^\d{8}-\d{6}-\d{6}__a\.py$/)
    expect(v[0].when).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(v[0].size).toBe(2)
    expect(v[0].file).toBe('a.py')
    expect(b.read(SID).toString()).toBe('v2')
    expect(b.read(SID, v[1].name).toString()).toBe('v1')
  })

  it('never collides when two backups land on the same instant', () => {
    const b = new Backups(tmpDirs())
    const when = Date.now()
    const first = b.add(SID, 'a.py', Buffer.from('1'), when)
    const second = b.add(SID, 'a.py', Buffer.from('2'), when)
    expect(first).not.toBe(second)
    expect(b.read(SID).toString()).toBe('2')
  })

  it('keeps only the newest KEEP versions', () => {
    const b = new Backups(tmpDirs())
    for (let i = 0; i < KEEP + 3; i++) b.add(SID, 'a.py', Buffer.from(`v${i}`))
    const v = b.versions(SID)
    expect(v).toHaveLength(KEEP)
    expect(b.read(SID).toString()).toBe(`v${KEEP + 2}`)
    expect(b.read(SID, v[v.length - 1].name).toString()).toBe('v3')
  })

  it('refuses bad ids, unknown versions and an empty history', () => {
    const b = new Backups(tmpDirs())
    expect(() => b.add('../x', 'a.py', Buffer.from('x'))).toThrow(BackupError)
    expect(b.versions('../x')).toEqual([])
    expect(() => b.read(SID)).toThrow('no previous version')
    b.add(SID, 'a.py', Buffer.from('x'))
    expect(() => b.read(SID, '../../etc/passwd')).toThrow('no longer exists')
  })

  it('ignores files that are not backups', () => {
    const dirs = tmpDirs()
    const b = new Backups(dirs)
    b.add(SID, 'a.py', Buffer.from('x'))
    fs.writeFileSync(path.join(dirs.backups, SID, 'notes.txt'), 'hi')
    fs.writeFileSync(path.join(dirs.backups, SID, '.tmp-abc.part'), 'half')
    expect(b.versions(SID)).toHaveLength(1)
  })

  it('moves an old .bak in and removes it once the copy reads back', () => {
    const b = new Backups(tmpDirs())
    const dir = tmpDir('sh-bak-')
    const script = path.join(dir, 'a.py')
    fs.writeFileSync(script, 'current')
    expect(b.migrateSideBak(SID, script)).toBe(false) // no .bak
    fs.writeFileSync(script + '.bak', 'old version')
    expect(b.migrateSideBak(SID, script)).toBe(true)
    expect(fs.existsSync(script + '.bak')).toBe(false)
    expect(b.read(SID).toString()).toBe('old version')
  })

  it('leaves the .bak alone when it cannot be copied', () => {
    const b = new Backups(tmpDirs())
    const dir = tmpDir('sh-bak-')
    const script = path.join(dir, 'a.py')
    fs.writeFileSync(script + '.bak', 'precious')
    b.add = () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    }
    expect(b.migrateSideBak(SID, script)).toBe(false)
    expect(fs.readFileSync(script + '.bak', 'utf8')).toBe('precious')
  })
})
