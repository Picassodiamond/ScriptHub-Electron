import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/config.js'
import { MAX_RECENT, Workspace } from '../src/workspace.js'
import { tmpDir, tmpDirs } from './helpers.js'

let root: string, dirs: ReturnType<typeof tmpDirs>, ws: Workspace, a: string, b: string

function folder(name: string, script: string): string {
  const d = path.join(root, name)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, script), "print('x')\n")
  return d
}
const state = () => JSON.parse(fs.readFileSync(dirs.workspaceFile, 'utf8'))

beforeEach(() => {
  root = tmpDir('sh-folders-')
  dirs = tmpDirs()
  fs.mkdirSync(dirs.runtime, { recursive: true })
  fs.writeFileSync(dirs.configFile, '{}')
  ws = new Workspace(dirs, new ConfigStore(dirs), root)
  a = folder('alpha', 'one.py')
  b = folder('beta', 'two.py')
})

describe('workspace (port of runner/test_folders.py)', () => {
  it('has nothing open on a fresh install', () => {
    expect(ws.current()).toBeNull()
    expect(ws.roots()).toEqual([])
    expect(fs.existsSync(dirs.workspaceFile)).toBe(false)
  })

  it('seeds the state from the old script_directories setting without writing', () => {
    fs.writeFileSync(dirs.configFile, JSON.stringify({ script_directories: [path.join(root, 'gone'), a, b] }))
    expect(ws.same(ws.current()!, a)).toBe(true)
    expect(ws.load().recent.length).toBe(3)
    expect(fs.existsSync(dirs.workspaceFile)).toBe(false)
  })

  it('keeps a de-duplicated recent list', () => {
    ws.openFolder(a)
    ws.openFolder(b)
    ws.openFolder(a)
    const st = state()
    expect(ws.same(st.folder, a)).toBe(true)
    expect(st.recent.length).toBe(2)
    expect(ws.same(st.recent[0], a)).toBe(true)
  })

  it('caps the recent list', () => {
    for (let i = 0; i < MAX_RECENT + 3; i++) ws.openFolder(folder(`f${i}`, 's.py'))
    expect(state().recent.length).toBe(MAX_RECENT)
  })

  it('rejects missing paths and non-scripts', () => {
    ws.openFolder(a)
    fs.writeFileSync(path.join(a, 'notes.txt'), 'x')
    for (const bad of [path.join(root, 'nope'), path.join(a, 'notes.txt'), '', '  ']) expect(() => ws.openFolder(bad)).toThrow()
    expect(ws.same(state().folder, a)).toBe(true)
  })

  it('opens a single script file on its own', () => {
    ws.openFolder(path.join(b, 'two.py'))
    expect(ws.currentIsFile()).toBe(true)
    expect(ws.roots().map((p) => path.basename(p))).toEqual(['two.py'])
    expect(state().recent[0].endsWith('two.py')).toBe(true)
  })

  it('opens files next to a folder and closes them on their own', () => {
    ws.openFolder(a)
    ws.openFolder(path.join(b, 'two.py'))
    expect(ws.roots().length).toBe(2)
    expect(ws.currentIsFile()).toBe(false)
    ws.openFolder(folder('gamma', 'three.py')) // another folder: files stay
    expect(ws.openFiles().length).toBe(1)
    expect(ws.closeFile(path.join(b, 'two.py'))).toBe(true)
    expect(ws.closeFile(path.join(b, 'two.py'))).toBe(false)
    ws.openFolder(path.join(b, 'two.py'))
    ws.closeAllFiles()
    expect(state().files).toEqual([])
  })

  it('does not scan a file already inside the open folder twice', () => {
    ws.openFolder(a)
    ws.openFolder(path.join(a, 'one.py'))
    expect(ws.roots()).toEqual([ws.current()])
  })

  it('handles favourites, sequence favourites and forget', () => {
    ws.openFolder(a)
    ws.setFavorite(a, true)
    expect(ws.overview().favorites[0].favorite).toBe(true)
    expect(ws.overview().recent).toEqual([])
    ws.setFavorite(a, false)
    ws.forget(a)
    expect(ws.load().recent).toEqual([])
    ws.setSequenceFavorite('nightly', true)
    ws.setSequenceFavorite('nightly', true)
    expect(ws.sequenceFavorites()).toEqual(['nightly'])
    ws.setSequenceFavorite('nightly', false)
    expect(ws.sequenceFavorites()).toEqual([])
  })

  it('browses folders for scripts', () => {
    fs.mkdirSync(path.join(a, 'sub'))
    fs.mkdirSync(path.join(a, '.hidden'))
    const r = ws.browse(a)
    expect(r.dirs.map((d) => d.name)).toEqual(['sub'])
    expect(r.files.map((d) => d.name)).toEqual(['one.py'])
    expect(ws.browse('').path).toBe('')
  })
})
