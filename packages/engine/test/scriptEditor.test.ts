import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Backups, KEEP } from '../src/backups.js'
import { pathId } from '../src/ids.js'
import { resolveLoose } from '../src/metadata.js'
import { ConflictError, EditError, MAX_BYTES, ScriptEditor, isWithin } from '../src/scriptEditor.js'
import { tmpDir, tmpDirs } from './helpers.js'

const HAS_BASH = spawnSync('bash', ['-n'], { input: 'echo ok\n' }).status === 0
const IS_WIN = process.platform === 'win32'

describe('script editor service (port of EditorServiceTests)', () => {
  let tmp: string
  let root: string
  let backups: Backups
  let editor: ScriptEditor

  beforeEach(() => {
    tmp = tmpDir('sh-edit-')
    root = path.join(tmp, 'scripts')
    fs.mkdirSync(root)
    backups = new Backups(tmpDirs()) // never the real runtime/
    editor = new ScriptEditor(backups)
  })

  const make = (name: string, data: string | Buffer) => {
    const p = path.join(root, name)
    fs.writeFileSync(p, data)
    return p
  }
  const sidOf = (p: string) => pathId(resolveLoose(p))
  const newestBackup = (p: string) => backups.read(sidOf(p)).toString('utf8').replaceAll('\r\n', '\n')
  const hashOf = (p: string) => editor.readForEdit(p, root).hash

  it('normalises newlines and reports the style', () => {
    const info = editor.readForEdit(make('a.py', 'x = 1\r\ny = 2\r\n'), root)
    expect(info.text).toBe('x = 1\ny = 2\n')
    expect(info.newline).toBe('crlf')
    expect(editor.readForEdit(make('b.py', 'x\ny\n'), root).newline).toBe('lf')
  })

  it('refuses unsuitable files', () => {
    expect(() => editor.readForEdit(make('bin.py', Buffer.from('abc\0def')), root)).toThrow(EditError)
    expect(() => editor.readForEdit(make('latin.py', Buffer.from('caf\xe9', 'latin1')), root)).toThrow(/UTF-8/)
    expect(() => editor.readForEdit(make('big.py', '#'.repeat(MAX_BYTES + 1)), root)).toThrow(/512 KB/)
    expect(() => editor.readForEdit(path.join(root, 'missing.py'), root)).toThrow(EditError)
  })

  it('never touches files outside the root', () => {
    const outside = path.join(tmp, 'outside.py')
    fs.writeFileSync(outside, 'print(1)')
    expect(() => editor.readForEdit(outside, root)).toThrow(/outside/)
    expect(() => editor.saveScript(outside, root, 'print(2)', 'x', { force: true })).toThrow(EditError)
    expect(() => editor.saveScript(path.join(root, '..', 'outside.py'), root, 'print(2)', 'x', { force: true })).toThrow(EditError)
    expect(fs.readFileSync(outside, 'utf8')).toBe('print(1)')
    expect(isWithin(path.join(root, 'a.py'), root)).toBe(true)
    expect(isWithin(root, root)).toBe(true)
    expect(isWithin(path.join(root, '..'), root)).toBe(false)
  })

  it('saves the file and keeps a backup', () => {
    const p = make('a.py', "print('old')\n")
    const info = editor.readForEdit(p, root)
    const result = editor.saveScript(p, root, "print('new')\n", info.hash)
    expect(result.changed).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).toBe("print('new')\n")
    expect(newestBackup(p)).toBe("print('old')\n")
    expect(fs.readdirSync(root)).toEqual(['a.py']) // no .bak, no temp files next to it
  })

  it('an unchanged save does not touch the backup', () => {
    const p = make('a.py', 'print(1)\n')
    editor.saveScript(p, root, 'print(2)\n', hashOf(p))
    const before = newestBackup(p)
    const info = editor.readForEdit(p, root)
    const result = editor.saveScript(p, root, info.text, info.hash)
    expect(result.changed).toBe(false)
    expect(newestBackup(p)).toBe(before)
    expect(backups.versions(sidOf(p))).toHaveLength(1)
  })

  it('reports a conflict when the file changed after opening', () => {
    const p = make('a.py', 'v1\n')
    const stale = hashOf(p)
    fs.writeFileSync(p, 'someone else edited this\n')
    expect(() => editor.saveScript(p, root, 'mine\n', stale)).toThrow(ConflictError)
    expect(fs.readFileSync(p, 'utf8')).toBe('someone else edited this\n')
    editor.saveScript(p, root, 'mine\n', stale, { force: true }) // explicit overwrite
    expect(fs.readFileSync(p, 'utf8')).toBe('mine\n')
    expect(newestBackup(p)).toBe('someone else edited this\n')
  })

  it('applies the line-ending policy', () => {
    const browserText = 'line1\r\nline2\r\n'
    const sh = make('run.sh', 'echo a\n')
    editor.saveScript(sh, root, browserText, hashOf(sh))
    expect(fs.readFileSync(sh).includes(0x0d)).toBe(false) // shell scripts stay LF
    const bat = make('run.bat', '@echo off\r\n')
    editor.saveScript(bat, root, '@echo off\necho hi\n', hashOf(bat))
    expect(fs.readFileSync(bat).toString()).toBe('@echo off\r\necho hi\r\n') // batch files are CRLF
    const pyCrlf = make('w.py', 'a = 1\r\n')
    editor.saveScript(pyCrlf, root, 'a = 2\nb = 3\n', hashOf(pyCrlf))
    expect(fs.readFileSync(pyCrlf).toString()).toBe('a = 2\r\nb = 3\r\n') // other files keep their style
    const pyLf = make('l.py', 'a = 1\n')
    editor.saveScript(pyLf, root, 'a = 2\r\n', hashOf(pyLf))
    expect(fs.readFileSync(pyLf).toString()).toBe('a = 2\n')
  })

  it('preserves UTF-8 and a BOM', () => {
    const p = make('u.py', Buffer.from("﻿print('café')\n", 'utf8'))
    const info = editor.readForEdit(p, root)
    expect(info.bom).toBe(true)
    expect(info.text).toContain('café')
    editor.saveScript(p, root, "print('naïve ✓')\n", info.hash)
    const raw = fs.readFileSync(p)
    expect(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true)
    expect(raw.subarray(3).toString('utf8')).toBe("print('naïve ✓')\n")
  })

  it.skipIf(IS_WIN)('keeps the executable bit', () => {
    const p = make('tool.sh', 'echo a\n')
    fs.chmodSync(p, 0o755)
    editor.saveScript(p, root, 'echo b\n', hashOf(p))
    expect(fs.statSync(p).mode & 0o100).toBeTruthy()
  })

  it('does not overwrite a read-only file', () => {
    const p = make('ro.py', 'print(1)\n')
    const h = hashOf(p)
    fs.chmodSync(p, 0o444)
    try {
      expect(() => editor.saveScript(p, root, 'print(2)\n', h)).toThrow(/read-only/)
      expect(fs.readFileSync(p, 'utf8')).toBe('print(1)\n')
    } finally {
      fs.chmodSync(p, 0o666)
    }
  })

  it('rejects bad content', () => {
    const p = make('a.py', 'x\n')
    const h = hashOf(p)
    expect(() => editor.saveScript(p, root, 'a\0b', h)).toThrow(EditError)
    expect(() => editor.saveScript(p, root, '#'.repeat(MAX_BYTES + 10), h)).toThrow(EditError)
    expect(fs.readFileSync(p, 'utf8')).toBe('x\n')
  })

  it('warns about syntax errors without blocking the save and without running anything', () => {
    const marker = path.join(tmp, 'executed.txt')
    const p = make('a.py', 'x = 1\n')
    const result = editor.saveScript(p, root, `open(${JSON.stringify(marker)}, 'w').write('x')\nif True print(1)\n`, hashOf(p))
    expect(result.changed).toBe(true) // saved anyway
    expect(result.warning).toContain('Python syntax error at line 2')
    expect(fs.existsSync(marker)).toBe(false) // compile only, nothing ran
    const ok = editor.saveScript(p, root, 'print(1)\n', hashOf(p))
    expect(ok.warning).toBeNull()
  })

  it.skipIf(!HAS_BASH)('warns about Bash syntax errors', () => {
    const p = make('a.sh', 'echo ok\n')
    const result = editor.saveScript(p, root, 'if true; then\necho "unterminated\n', hashOf(p))
    expect(result.warning).toContain('Bash reports a syntax problem')
  })

  it('restore swaps with the backup, and is itself undoable', () => {
    const p = make('a.py', 'v1\n')
    editor.saveScript(p, root, 'v2\n', hashOf(p))
    editor.restoreBackup(p, root)
    expect(fs.readFileSync(p, 'utf8')).toBe('v1\n')
    editor.restoreBackup(p, root)
    expect(fs.readFileSync(p, 'utf8')).toBe('v2\n')
    expect(() => editor.restoreBackup(make('fresh.py', 'x\n'), root)).toThrow(EditError)
  })

  it('keeps the last ten versions and any can be restored', () => {
    const p = make('a.py', 'v0\n')
    for (let i = 1; i <= 12; i++) editor.saveScript(p, root, `v${i}\n`, hashOf(p))
    const sid = sidOf(p)
    const versions = backups.versions(sid)
    expect(versions).toHaveLength(KEEP)
    expect(backups.read(sid, versions[versions.length - 1].name).toString()).toBe('v2\n') // the oldest kept
    editor.restoreBackup(p, root, { sid, version: versions[versions.length - 1].name })
    expect(fs.readFileSync(p, 'utf8')).toBe('v2\n')
    expect(newestBackup(p)).toBe('v12\n') // what was replaced
    expect(() => editor.restoreBackup(p, root, { sid, version: '../../etc/passwd' })).toThrow(EditError)
  })

  it('refuses to restore a version identical to the current file', () => {
    const p = make('a.py', 'v1\n')
    editor.saveScript(p, root, 'v2\n', hashOf(p))
    fs.writeFileSync(p, 'v1\n')
    expect(() => editor.restoreBackup(p, root)).toThrow(/same as the current/)
  })

  it('moves an old .bak next to the script into the backups', () => {
    const p = make('a.py', 'v2\n')
    fs.writeFileSync(path.join(root, 'a.py.bak'), 'v1 from an older version\n')
    editor.saveScript(p, root, 'v3\n', hashOf(p))
    expect(fs.existsSync(path.join(root, 'a.py.bak'))).toBe(false)
    const sid = sidOf(p)
    expect(backups.versions(sid).map((v) => backups.read(sid, v.name).toString())).toEqual(['v2\n', 'v1 from an older version\n'])
  })

  it('leaves a .bak that cannot be copied alone and saves nothing', () => {
    const p = make('a.py', 'v2\n')
    fs.writeFileSync(path.join(root, 'a.py.bak'), 'precious\n')
    const spy = vi.spyOn(backups, 'add').mockImplementation(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    })
    expect(() => editor.saveScript(p, root, 'v3\n', hashOf(p))).toThrow(EditError) // no backup possible: nothing is saved
    spy.mockRestore()
    expect(fs.readFileSync(path.join(root, 'a.py.bak'), 'utf8')).toBe('precious\n')
    expect(fs.readFileSync(p, 'utf8')).toBe('v2\n')
  })

  it('hasBackup reflects the history', () => {
    const p = make('a.py', 'v1\n')
    expect(editor.hasBackup(sidOf(p))).toBe(false)
    editor.saveScript(p, root, 'v2\n', hashOf(p))
    expect(editor.hasBackup(sidOf(p))).toBe(true)
  })
})
