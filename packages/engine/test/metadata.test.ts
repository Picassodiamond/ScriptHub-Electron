import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Backups } from '../src/backups.js'
import { pathId, valid } from '../src/ids.js'
import { MetadataStore, embedded, parseBlock, resolveLoose, splitlines, withBlock } from '../src/metadata.js'
import { tmpDir, tmpDirs } from './helpers.js'

const DATA = {
  id: 'a1b2c3d4e5f6', name: 'Backup: nightly', category: 'Backup', platforms: ['windows', 'linux'],
  parameters: [
    { name: 'source', type: 'directory', required: true, arg: '--source' },
    { name: 'mode', type: 'select', choices: ['full', 'incremental'], default: 'full' },
    { name: 'notes', type: 'textarea', default: 'Line one\nLine two' },
  ],
}

describe('metadata block (port of runner/test_metadata_block.py)', () => {
  it('is written as YAML and read back', () => {
    const text = withBlock('#!/usr/bin/env python3\nprint(1)\n', DATA, 'x.py', '\n')
    expect(text.startsWith('#!/usr/bin/env python3\n# --- scripthub ---\n# id: a1b2c3d4e5f6\n')).toBe(true)
    expect(text).toContain('\n# name: "Backup: nightly"\n')
    expect(text).toContain('\n# parameters:\n#   - name: source\n#     type: directory\n#     required: true\n')
    expect(text).toContain('\n#     choices: [full, incremental]\n')
    expect(text).not.toContain('{')
    expect(text.endsWith('# --- end scripthub ---\nprint(1)\n')).toBe(true)
    expect(parseBlock(text)).toEqual([DATA, null])
  })

  it('uses the batch prefix and CRLF', () => {
    const text = withBlock('@echo off\r\necho hi\r\n', DATA, 'x.bat', '\r\n')
    expect(text).toContain('\r\n:: parameters:\r\n::   - name: source\r\n')
    expect(text.replaceAll('\r\n', '\n')).not.toContain('\n\n')
    expect(parseBlock(text)).toEqual([DATA, null])
  })

  it('still reads old JSON blocks and turns them into YAML', () => {
    const old = '# --- scripthub ---\n# {\n#   "name": "Old",\n#   "parameters": [\n' +
      '#     {"name": "a", "type": "text", "default": "x"}\n#   ]\n# }\n# --- end scripthub ---\nprint(1)\n'
    const [data, err] = parseBlock(old)
    expect(err).toBeNull()
    expect(data).toEqual({ name: 'Old', parameters: [{ name: 'a', type: 'text', default: 'x' }] })
    const next = withBlock(old, data!, 'x.py', '\n')
    expect(next).toContain('# name: Old\n# parameters:\n#   - name: a\n')
    expect(parseBlock(next)).toEqual([data, null])
  })

  it('reads hand-written YAML with comments and flow parameters', () => {
    const text = '# --- scripthub ---\n# name: Hand made   # a comment\n# # a whole comment line\n#\n' +
      '# parameters:\n# - {name: a, type: text}\n# - name: b\n#   type: number\n# --- end scripthub ---\n'
    expect(parseBlock(text)).toEqual([
      { name: 'Hand made', parameters: [{ name: 'a', type: 'text' }, { name: 'b', type: 'number' }] }, null])
  })

  it('names the line of the script in errors', () => {
    const text = '#!/bin/sh\n# --- scripthub ---\n# name: x\n#   bad: indent\n# --- end scripthub ---\n'
    const [data, err] = parseBlock(text)
    expect(data).toEqual({})
    expect(err).toContain('lines 2-5')
    expect(err).toContain('line 4:')
    expect(parseBlock('# --- scripthub ---\n# {"name": \n# --- end scripthub ---\n')[1]).toContain('JSON')
    expect(parseBlock('# --- scripthub ---\n# - a\n# --- end scripthub ---\n')[1]).toContain('mapping')
  })

  it('handles an empty block and a script without one', () => {
    const text = withBlock('print(1)\n', {}, 'x.py', '\n')
    expect(text).toBe('# --- scripthub ---\n# --- end scripthub ---\nprint(1)\n')
    expect(parseBlock(text)).toEqual([{}, null])
    expect(parseBlock('print(1)\n')).toEqual([null, null])
  })

  it('splitlines follows Python', () => {
    expect(splitlines('')).toEqual([])
    expect(splitlines('a\n')).toEqual(['a'])
    expect(splitlines('a\r\nb\rc\n\nd')).toEqual(['a', 'b', 'c', '', 'd'])
  })

  it('inserts after a shebang / encoding line and keeps a missing final newline', () => {
    const text = withBlock('#!/bin/sh\n# -*- coding: utf-8 -*-\necho x', { name: 'n' }, 'x.sh', '\n')
    expect(text).toBe('#!/bin/sh\n# -*- coding: utf-8 -*-\n# --- scripthub ---\n# name: n\n# --- end scripthub ---\necho x')
  })
})

describe('MetadataStore.saveRaw / loadRaw', () => {
  function setup() {
    const dirs = tmpDirs()
    const scripts = tmpDir('sh-scripts-')
    const store = new MetadataStore(dirs)
    const put = (name: string, content: string | Buffer) => {
      const p = path.join(scripts, name)
      fs.writeFileSync(p, content)
      return p
    }
    return { dirs, scripts, store, put }
  }

  it('first save writes a stable id; saved values and backups follow; the old id is an alias', () => {
    const { dirs, store, put } = setup()
    const p = put('a.py', 'print(1)\n')
    const pid = pathId(resolveLoose(p))
    fs.mkdirSync(path.join(dirs.presets, pid), { recursive: true })
    fs.writeFileSync(path.join(dirs.presets, pid, 'prod.yaml'), 'name: Prod\n')

    const target = store.saveRaw(p, pid, { name: 'A', parameters: [] })
    expect(target).toBe(p)
    const { data, source, error } = store.loadRaw(p)
    expect(error).toBeNull()
    expect(source).toBe(p)
    expect(valid(data.id)).toBe(true)
    expect(Object.keys(data)[0]).toBe('id')
    const sid = data.id as string
    expect(fs.existsSync(path.join(dirs.presets, sid, 'prod.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(dirs.presets, pid))).toBe(false)
    expect(store.ids.canonical(pid)).toBe(sid)
    // the previous version of the script was backed up under the new id
    expect(new Backups(dirs).read(sid).toString()).toBe('print(1)\n')
    expect(fs.readFileSync(p, 'utf8').endsWith('print(1)\n')).toBe(true)
  })

  it('keeps an existing id and does nothing when nothing changed', () => {
    const { dirs, store, put } = setup()
    const p = put('a.py', 'print(1)\n')
    store.saveRaw(p, pathId(resolveLoose(p)), { name: 'A' })
    const first = store.loadRaw(p).data
    const sid = first.id as string
    store.saveRaw(p, sid, first) // identical: no new backup
    expect(store.loadRaw(p).data.id).toBe(sid)
    expect(new Backups(dirs).versions(sid)).toHaveLength(1)
    store.saveRaw(p, sid, { ...first, name: 'B' })
    expect(new Backups(dirs).versions(sid)).toHaveLength(2)
  })

  it('a copy (conflict) gets a new id on its next save', () => {
    const { store, put } = setup()
    const p = put('a.py', 'print(1)\n')
    store.saveRaw(p, pathId(resolveLoose(p)), { name: 'A' })
    const sid = store.loadRaw(p).data.id as string
    store.saveRaw(p, pathId(resolveLoose(p)), store.loadRaw(p).data, true)
    const next = store.loadRaw(p).data.id as string
    expect(next).not.toBe(sid)
    expect(valid(next)).toBe(true)
  })

  it('moves an old sidecar into the script', () => {
    const { store, put, scripts } = setup()
    const p = put('a.py', 'print(1)\n')
    const side = path.join(scripts, 'a.json')
    fs.writeFileSync(side, JSON.stringify({ name: 'Sidecar', parameters: [] }))
    const before = store.loadRaw(p)
    expect(before.source).toBe(side)
    expect(before.data.name).toBe('Sidecar')
    store.saveRaw(p, pathId(resolveLoose(p)), before.data)
    expect(fs.existsSync(side)).toBe(false)
    const after = store.loadRaw(p)
    expect(after.source).toBe(p)
    expect(after.data.name).toBe('Sidecar')
  })

  it('leaves an unrelated JSON file alone and reports a broken sidecar', () => {
    const { store, put, scripts } = setup()
    const p = put('a.py', 'print(1)\n')
    const side = path.join(scripts, 'a.json')
    fs.writeFileSync(side, '[1, 2]')
    expect(store.loadRaw(p).error).toContain('must contain a JSON object')
    fs.writeFileSync(side, '{ nope')
    expect(store.loadRaw(p).error).toContain('Invalid metadata file a.json')
    store.saveRaw(p, pathId(resolveLoose(p)), { name: 'A' })
    expect(fs.existsSync(side)).toBe(true) // not a metadata object: never deleted
  })

  it('falls back to metadata_overrides when the script cannot be rewritten', () => {
    const { dirs, store, put } = setup()
    const p = put('latin.py', Buffer.from('print("caf\xe9")\n', 'latin1')) // not UTF-8: not ours to rewrite
    const target = store.saveRaw(p, pathId(resolveLoose(p)), { name: 'Override' })
    expect(target).toBe(path.join(dirs.metadataOverride, `${pathId(resolveLoose(p))}.json`))
    expect(Buffer.from(fs.readFileSync(p)).equals(Buffer.from('print("caf\xe9")\n', 'latin1'))).toBe(true)
    const loaded = store.loadRaw(p)
    expect(loaded.source).toBe(target)
    expect(loaded.data.name).toBe('Override')
    expect(valid(loaded.data.id)).toBe(true)
  })

  it('keeps a BOM and CRLF line endings', () => {
    const { store, put } = setup()
    const p = put('a.bat', Buffer.from('﻿@echo off\r\necho hi\r\n', 'utf8'))
    store.saveRaw(p, pathId(resolveLoose(p)), { name: 'Bat' })
    const raw = fs.readFileSync(p)
    expect(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true)
    const text = raw.subarray(3).toString('utf8')
    expect(text.startsWith('@echo off\r\n:: --- scripthub ---\r\n')).toBe(true)
    expect(text).not.toMatch(/[^\r]\n/)
    expect(store.loadRaw(p).data.name).toBe('Bat')
  })

  it('moves an old <script>.bak into the backups on save', () => {
    const { dirs, store, put, scripts } = setup()
    const p = put('a.py', 'v2\n')
    fs.writeFileSync(path.join(scripts, 'a.py.bak'), 'v1 old\n')
    store.saveRaw(p, pathId(resolveLoose(p)), { name: 'A' })
    expect(fs.existsSync(path.join(scripts, 'a.py.bak'))).toBe(false)
    const sid = store.loadRaw(p).data.id as string
    const b = new Backups(dirs)
    expect(b.versions(sid).map((v) => b.read(sid, v.name).toString())).toEqual(['v2\n', 'v1 old\n'])
  })

  it('embedded() is true only when the metadata lives in the script', () => {
    expect(embedded({ path: '/a/x.py', metaSource: '/a/x.py' })).toBe(true)
    expect(embedded({ path: '/a/x.py', metaSource: '/a/x.json' })).toBe(false)
    expect(embedded({ path: '/a/x.py', metaSource: null })).toBe(false)
  })
})
