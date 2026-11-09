/** Port of NewScriptTests (runner/test_folders.py): the use case behind the New script page. */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/config.js'
import { Discovery, MAX_DEPTH } from '../src/discovery.js'
import { Ids, valid } from '../src/ids.js'
import { MetadataStore } from '../src/metadata.js'
import { NewScript, NewScriptError, createScript, languages, suggestions, type NewScriptForm } from '../src/newScript.js'
import { Workspace } from '../src/workspace.js'
import { tmpDir, tmpDirs } from './helpers.js'

let root: string, a: string, dirs: ReturnType<typeof tmpDirs>, ws: Workspace, meta: MetadataStore, disc: Discovery, ns: NewScript, config: ConfigStore

const form = (over: Partial<NewScriptForm> = {}): NewScriptForm => ({ language: '.py', filename: 'cleanup_logs', subfolder: '', name: '', category: '', ...over })
const names = async () => (await disc.scan(true))[0].map((s) => path.relative(a, s.path).split(path.sep).join('/')).sort()

beforeEach(() => {
  root = tmpDir('sh-new-')
  a = path.join(root, 'alpha')
  fs.mkdirSync(a)
  fs.writeFileSync(path.join(a, 'one.py'), "print('x')\n")
  dirs = tmpDirs()
  fs.mkdirSync(dirs.runtime, { recursive: true })
  fs.writeFileSync(dirs.configFile, '{}')
  config = new ConfigStore(dirs)
  const ids = new Ids(dirs)
  ws = new Workspace(dirs, config, root)
  meta = new MetadataStore(dirs, { ids })
  disc = new Discovery({ ids, metadata: meta, workspace: ws, config })
  ns = new NewScript({ workspace: ws, config, discovery: disc })
})

describe('new script', () => {
  it('needs an open folder, or says only files are open', () => {
    expect(ns.blocked()).toMatch(/Open a script folder first/)
    ws.openFolder(path.join(a, 'one.py'))
    expect(ns.blocked()).toMatch(/Only script files are open/)
    ws.openFolder(a)
    expect(ns.blocked()).toBeNull()
  })

  it('creates the script with a metadata block and its stable id, no sidecar and no backup', async () => {
    ws.openFolder(a)
    const res = await ns.create(form({ subfolder: 'maint/daily', category: 'Maintenance' }))
    const target = path.join(a, 'maint', 'daily', 'cleanup_logs.py')
    expect(res.path).toBe(target)
    const bytes = fs.readFileSync(target, 'utf8')
    expect(bytes).toContain('Hello from ScriptHub')
    expect(bytes.split('\n')[0]).toMatch(/^# --- scripthub ---/) // the block at the top of the script
    const { data, error } = meta.loadRaw(target, '0'.repeat(12))
    expect(error).toBeNull()
    expect([data.name, data.category, data.parameters]).toEqual(['Cleanup Logs', 'Maintenance', []])
    expect(valid(data.id)).toBe(true) // a new script has its stable id
    expect(res.id).toBe(data.id)
    expect(fs.existsSync(target.replace(/\.py$/, '.json'))).toBe(false)
    expect(fs.existsSync(dirs.backups)).toBe(false) // nothing to back up yet
    expect(await names()).toContain('maint/daily/cleanup_logs.py')
  })

  it('never overwrites and rejects bad names and paths', async () => {
    ws.openFolder(a)
    const before = fs.readFileSync(path.join(a, 'one.py'))
    await expect(ns.create(form({ filename: 'one' }))).rejects.toThrow(/already exists/)
    expect(fs.readFileSync(path.join(a, 'one.py'))).toEqual(before)
    for (const bad of [{ filename: '../evil' }, { filename: 'a b' }, { filename: '' }, { subfolder: '../out' }, { subfolder: '/abs' }, { subfolder: 'C:/x' }, { language: '.exe' }])
      await expect(ns.create(form(bad)), JSON.stringify(bad)).rejects.toBeInstanceOf(NewScriptError)
    expect(fs.existsSync(path.join(root, 'out'))).toBe(false)
    expect(await names()).toEqual(['one.py'])
  })

  it('keeps the sub-folder within the depth limit', async () => {
    ws.openFolder(a)
    const levels = [...'bcdefghij']
    await expect(ns.create(form({ subfolder: levels.slice(0, MAX_DEPTH + 1).join('/') }))).rejects.toThrow(`at most ${MAX_DEPTH} levels deep`)
    expect(fs.existsSync(path.join(a, 'b'))).toBe(false)
    await ns.create(form({ subfolder: levels.slice(0, MAX_DEPTH).join('/') }))
    expect(await names()).toContain(`${levels.slice(0, MAX_DEPTH).join('/')}/cleanup_logs.py`)
  })

  it('handles line endings and the extension typed twice', async () => {
    ws.openFolder(a)
    await ns.create(form({ language: '.sh', filename: 'deploy.sh' }))
    expect(fs.readFileSync(path.join(a, 'deploy.sh')).includes('\r\n')).toBe(false) // .sh: LF, extension added once
    if (languages(config.load()).some(([e]) => e === '.bat')) {
      await ns.create(form({ language: '.bat', filename: 'win' }))
      expect(fs.readFileSync(path.join(a, 'win.bat'), 'latin1')).toContain('\r\n')
    }
    expect(fs.readFileSync(path.join(a, 'win.bat'), 'latin1').replace(/\r\n/g, '').includes('\n')).toBe(false)
  })

  it('prefills the place of the script "+" was clicked next to, and suggests existing folders', async () => {
    const b = path.join(root, 'beta')
    fs.mkdirSync(b)
    fs.writeFileSync(path.join(b, 'two.py'), "print('x')\n")
    ws.openFolder(root)
    const [scripts] = await disc.scan(true)
    const two = scripts.find((s) => path.basename(s.path) === 'two.py')!
    expect(ns.defaultsFrom(two)).toMatchObject({ language: '.py', subfolder: 'beta' })
    expect(ns.defaultsFrom(null)).toMatchObject({ language: '.py', subfolder: '' })
    expect(suggestions(scripts).folders).toEqual(['alpha', 'beta'])
  })

  it('is switched off with editing, and creates nothing', async () => {
    ws.openFolder(a)
    fs.writeFileSync(dirs.configFile, JSON.stringify({ enable_script_editing: false }))
    expect(ns.blocked()).toMatch(/turned off in Settings/)
    await expect(ns.create(form())).rejects.toThrow(/turned off/)
    expect(fs.existsSync(path.join(a, 'cleanup_logs.py'))).toBe(false)
  })

  it('createScript works on any folder and refuses a missing one', () => {
    expect(() => createScript(path.join(root, 'nope'), '.py', 'x', '')).toThrow(/outside the script folder/)
    const p = createScript(a, '.PY', 'plain-name.py', '', ' My Name ')
    expect(path.basename(p)).toBe('plain-name.py') // the extension is lower-cased, and typed twice only once
    expect(meta.loadRaw(p).data.name).toBe('My Name')
  })
})
