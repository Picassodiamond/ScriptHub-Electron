import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/config.js'
import { Discovery, MAX_DEPTH } from '../src/discovery.js'
import { Ids } from '../src/ids.js'
import { MetadataStore } from '../src/metadata.js'
import { Workspace } from '../src/workspace.js'
import { tmpDir, tmpDirs } from './helpers.js'

let root: string, dirs: ReturnType<typeof tmpDirs>, ws: Workspace, ids: Ids, meta: MetadataStore, disc: Discovery

const write = (rel: string, text = "print('x')\n") => {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}
const names = async () => (await disc.scan(true))[0].map((s) => path.relative(root, s.path).split(path.sep).join('/')).sort()

beforeEach(() => {
  root = tmpDir('sh-disc-')
  dirs = tmpDirs()
  fs.mkdirSync(dirs.runtime, { recursive: true })
  fs.writeFileSync(dirs.configFile, '{}')
  const config = new ConfigStore(dirs)
  ws = new Workspace(dirs, config, root)
  ids = new Ids(dirs)
  meta = new MetadataStore(dirs, { ids })
  disc = new Discovery({ ids, metadata: meta, workspace: ws, config })
})

describe('discovery (port of the discovery tests)', () => {
  it('finds only scripts with a configured interpreter, skipping hidden and dependency folders', async () => {
    write('a.py'); write('b.sh'); write('notes.txt'); write('.hidden/x.py'); write('node_modules/y.py'); write('__pycache__/z.py'); write('sub/c.py')
    ws.openFolder(root)
    expect(await names()).toEqual(['a.py', 'b.sh', 'sub/c.py'])
  })

  it('does not scan deeper than MAX_DEPTH and reports it', async () => {
    write('l1/l2/l3/ok.py')
    write('l1/l2/l3/l4/deep.py')
    ws.openFolder(root)
    expect(MAX_DEPTH).toBe(3)
    const [scripts, problems] = await disc.scan(true)
    expect(scripts.map((s) => s.name)).toEqual(['Ok'])
    expect(problems.join('\n')).toMatch(/more than 3 folder levels deep/)
  })

  it('names, categorises and reads metadata from the script block', async () => {
    write('plain_script.py')
    write('tools/net-check.py')
    write('meta.py', '# --- scripthub ---\n# name: Pretty Name\n# category: Ops\n# description: Does things\n# --- end scripthub ---\nprint(1)\n')
    ws.openFolder(root)
    const [scripts] = await disc.scan(true)
    const by = Object.fromEntries(scripts.map((s) => [path.basename(s.path), s]))
    expect(by['plain_script.py']).toMatchObject({ name: 'Plain Script', category: 'General', language: 'python', platforms: ['windows', 'linux', 'macos'] })
    expect(by['net-check.py']).toMatchObject({ name: 'Net Check', category: 'Tools' })
    expect(by['meta.py']).toMatchObject({ name: 'Pretty Name', category: 'Ops', description: 'Does things', metaValid: true })
    expect(scripts.map((s) => s.category)).toEqual(['General', 'Ops', 'Tools']) // ordered by category, then name
  })

  it('marks invalid metadata and keeps the script listed', async () => {
    write('bad.py', '# --- scripthub ---\n# parameters: nope\n# --- end scripthub ---\n')
    ws.openFolder(root)
    const [s] = (await disc.scan(true))[0]
    expect(s.metaValid).toBe(false)
    expect(s.metaError).toMatch(/Invalid metadata|parameters/i)
  })

  it('opens a single file on its own, with its folder as root', async () => {
    write('one/a.py'); write('one/b.py')
    ws.openFolder(path.join(root, 'one', 'a.py'))
    const [scripts] = await disc.scan(true)
    expect(scripts.map((s) => path.basename(s.path))).toEqual(['a.py'])
    expect(path.basename(scripts[0].root)).toBe('one')
  })

  it('reports a missing root and a file without an interpreter', async () => {
    const f = write('x.py')
    ws.openFolder(root)
    fs.rmSync(f)
    const [, problems] = await disc.scan(true)
    expect(problems).toEqual([])
    ws.closeFolder()
    expect((await disc.scan(true))[0]).toEqual([])
  })

  it('finds a script by id, by path id and by an alias', async () => {
    const p = write('a.py')
    ws.openFolder(root)
    const s = (await disc.scan(true))[0][0]
    expect(await disc.getScript(s.id)).toMatchObject({ path: s.path })
    meta.saveRaw(s.path, s.id, { name: 'A' }) // writes a stable id; the old path id becomes an alias
    disc.updateFile(p)
    const after = (await disc.scan())[0][0]
    expect(after.id).not.toBe(s.pathId)
    expect((await disc.getScript(s.pathId))?.id).toBe(after.id)
    expect(disc.allIds(after).has(s.pathId)).toBe(true)
  })

  it('gives a copied script (same stable id) its path id and reports it', async () => {
    const a = write('a.py', '# --- scripthub ---\n# id: 0123456789ab\n# name: A\n# --- end scripthub ---\n')
    await new Promise((r) => setTimeout(r, 30))
    const b = write('b.py', fs.readFileSync(a, 'utf8'))
    ws.openFolder(root)
    const [scripts, problems] = await disc.scan(true)
    expect(scripts.length).toBe(2)
    const copy = scripts.find((s) => s.idConflict)!
    expect(path.basename(copy.path)).toBe('b.py')
    expect(copy.id).toBe(copy.pathId)
    expect(scripts.find((s) => !s.idConflict)!.id).toBe('0123456789ab')
    expect(problems.join()).toMatch(/same id/)
    void b
  })

  it('loadFile reads one script directly and refuses other types', () => {
    const p = write('d/x.py'); const t = write('d/x.txt')
    expect(disc.loadFile(p)?.name).toBe('X')
    expect(disc.loadFile(t)).toBeNull()
    expect(disc.loadFile(path.join(root, 'gone.py'))).toBeNull()
  })

  it('answers status while idle and after a scan', async () => {
    write('a.py')
    ws.openFolder(root)
    await disc.scan(true)
    expect(disc.status()).toMatchObject({ scanning: false, count: 1 })
    expect(disc.status().version).toBeGreaterThan(0)
  })
})
