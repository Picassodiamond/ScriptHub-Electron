/** Port of runner/test_projects.py (the web page tests become the use-case calls the pages make). */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { unzipSync, zipSync, type Zippable } from 'fflate'
import { beforeEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/engine.js'
import { ProjectError, ProjectFiles, EXT } from '../src/projectFiles.js'
import { tmpDir } from './helpers.js'

const TOOL = "import sys\nprint('hello', sys.argv[1:])\n"
const WITH_ID =
  '# --- scripthub ---\n# {"id": "a1b2c3d4e5f6", "name": "Alpha", "parameters": ' +
  '[{"name": "tag", "type": "text", "default": "x"}]}\n# --- end scripthub ---\n' + TOOL

let tmp: string, src: string, engine: Engine, pf: ProjectFiles

const real = (p: string) => fs.realpathSync.native(p)
const put = (p: string, data: string | Buffer) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
const script = async (name: string) => (await engine.discovery.scan(true))[0].find((s) => path.basename(s.path) === name)!
const unzip = (file: string) => unzipSync(fs.readFileSync(file))
const text = (d: Uint8Array) => new TextDecoder().decode(d)

function makeProjects(e: Engine, t: string) {
  return new ProjectFiles({
    dirs: e.dirs, config: e.config, discovery: e.discovery, workspace: e.workspace, sequences: e.sequences, presets: e.presets,
    appDir: path.join(t, 'app'), samplesDir: path.join(t, 'samples'), homeDir: path.join(t, 'home'),
  })
}

beforeEach(async () => {
  tmp = tmpDir('sr-proj-')
  const runtime = path.join(tmp, 'runtime')
  fs.mkdirSync(runtime)
  fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({ interpreters: { '.py': 'python', '.sh': 'bash' }, default_timeout: 60 }))
  engine = new Engine({ runtimeDir: runtime, appDir: tmp })
  pf = makeProjects(engine, tmp)
  // the folder to save: two scripts (one with a stable id, one with an old JSON sidecar), helpers, secrets
  src = path.join(tmp, 'ops')
  put(path.join(src, 'alpha.py'), WITH_ID)
  put(path.join(src, 'deploy', 'beta.sh'), '#!/bin/sh\necho beta\n')
  put(path.join(src, 'deploy', 'beta.json'), JSON.stringify({ name: 'Beta', parameters: [] }))
  put(path.join(src, 'data', 'hosts.csv'), 'name,ip\nweb,10.0.0.1\n')
  put(path.join(src, 'README.md'), '# ops\n')
  put(path.join(src, '.env'), 'PASSWORD=secret\n')
  put(path.join(src, 'server.pem'), '-----BEGIN PRIVATE KEY-----\n')
  put(path.join(src, '__pycache__', 'alpha.cpython-312.pyc'), Buffer.from([0]))
  put(path.join(src, '.git', 'HEAD'), 'ref\n')
  engine.workspace.openFolder(src)
  await engine.discovery.scan(true)
})

async function makeSequence(name = 'Release'): Promise<string> {
  const slug = engine.sequences.create(name)
  const a = await script('alpha.py')
  const b = await script('beta.sh')
  engine.sequences.addStep(slug, engine.sequences.newStep(a, { tag: 'prod' }))
  engine.sequences.addStep(slug, engine.sequences.newStep(b, {}))
  engine.sequences.link(slug, 's1', 's2', 'success')
  engine.presets.savePreset({ id: a.id, path: a.path }, 'Nightly', a.meta.parameters, { tag: 'night' }, 'local')
  return slug
}

function save(slugs: string[], files?: string[]) {
  const chosen = files ?? pf.folderFiles(src).included.map((f) => f.path)
  const { bytes, report } = pf.build(src, 'Ops project', chosen, slugs)
  const out = path.join(tmp, 'ops.scripthub')
  fs.writeFileSync(out, bytes)
  return { out, report }
}

describe('save and open', () => {
  it('leaves out secrets and tool folders', () => {
    const { included, leftOut } = pf.folderFiles(src)
    expect(new Set(included.map((f) => f.path))).toEqual(new Set(['alpha.py', 'deploy/beta.sh', 'deploy/beta.json', 'data/hosts.csv', 'README.md']))
    expect(new Set(included.filter((f) => f.isScript).map((f) => f.path))).toEqual(new Set(['alpha.py', 'deploy/beta.sh']))
    const reasons = Object.fromEntries(leftOut.map((l) => [l.path, l.reason]))
    expect(reasons['.env']).toBe('may hold secrets')
    expect(reasons['server.pem']).toBe('may hold secrets')
    expect(reasons).toHaveProperty(['__pycache__/'])
    expect(reasons).toHaveProperty(['.git/'])
  })

  it('round-trips to a new folder', async () => {
    const slug = await makeSequence()
    const { out, report } = save([slug])
    expect([report.files, report.scripts, report.sequences, report.presets]).toEqual([5, 2, 1, 1])
    const z = unzip(out)
    const names = Object.keys(z)
    const manifest = JSON.parse(text(z['manifest.json']))
    const seqText = text(z[`sequences/${slug}.yaml`])
    const presetText = text(z[manifest.presets[0].file])
    expect(names).toContain('files/alpha.py')
    expect(presetText.startsWith('# Preset for alpha.py (ScriptHub).')).toBe(true) // no local path in it
    expect(presetText).not.toContain(src)
    expect(presetText).toContain('tag: night')
    expect(names.some((n) => n.includes('.env') || n.includes('.pem') || n.includes('__pycache__'))).toBe(false)
    expect(manifest.format).toBe('scripthub-project')
    expect(seqText).toContain('path: files/deploy/beta.sh') // paths inside the project

    // "another computer": nothing of the sequence or presets left, the files open elsewhere
    engine.sequences.delete(slug)
    fs.rmSync(engine.dirs.presets, { recursive: true, force: true })
    const oldBetaId = (await script('beta.sh')).id
    const preview = pf.inspect(out)
    expect([preview.scripts, preview.files, preview.presets]).toEqual([2, 5, 1])
    expect(preview.sequences).toEqual([{ name: 'Release', as: 'Release', steps: 2 }])
    const dest = path.join(tmp, 'elsewhere', 'Ops')
    const result = pf.install(out, dest)
    expect([result.files, result.sequences.length, result.presets]).toEqual([5, 1, 1])
    expect(fs.readFileSync(path.join(dest, 'data', 'hosts.csv'), 'utf8')).toBe('name,ip\nweb,10.0.0.1\n')
    expect(fs.existsSync(path.join(dest, '.env'))).toBe(false)

    engine.workspace.openFolder(dest)
    await engine.discovery.scan(true)
    const data = engine.sequences.load(result.sequences[0])
    const found = data.steps.map((s) => engine.sequences.resolve(s)!)
    expect(found.map((s) => s.path)).toEqual([real(path.join(dest, 'alpha.py')), real(path.join(dest, 'deploy', 'beta.sh'))])
    expect(data.steps[0].script).toBe('a1b2c3d4e5f6') // the stable id travels
    expect(data.steps[1].script).not.toBe(oldBetaId) // a path id follows the new path
    expect(data.steps[1].script).toBe(found[1].id)
    expect(data.steps[0].values).toEqual({ tag: 'prod' })
    expect(data.links).toEqual([{ from: 's1', to: 's2', when: 'success' }])
    expect(engine.presets.listPresets({ id: found[0].id, path: found[0].path }).map((p: any) => p.name)).toEqual(['Nightly'])

    // opened twice: the destination must be new or empty, and the name is taken
    expect(() => pf.install(out, dest)).toThrow(ProjectError)
    const again = pf.install(out, path.join(tmp, 'second'))
    expect(engine.sequences.load(again.sequences[0]).name).toBe('Release (2)')
    expect(again.kept.join(' ')).toContain('exists already') // the preset there is kept
  })

  it('always includes the scripts a sequence needs, also from outside the folder', async () => {
    const slug = await makeSequence()
    const outside = path.join(tmp, 'elsewhere-scripts')
    put(path.join(outside, 'gamma.py'), TOOL)
    const gamma = engine.discovery.loadFile(path.join(outside, 'gamma.py'))!
    engine.sequences.addStep(slug, engine.sequences.newStep(gamma, {}))
    const { out, report } = save([slug], ['README.md']) // scripts not ticked
    const names = Object.keys(unzip(out))
    for (const n of ['files/alpha.py', 'files/deploy/beta.sh', 'files/_outside/gamma.py']) expect(names).toContain(n)
    expect(report.outside).toEqual([real(path.join(outside, 'gamma.py'))])
  })

  it('warns about hosts and paths of this computer', async () => {
    const slug = await makeSequence()
    engine.sequences.updateStep(slug, 's1', { values: { tag: 'C:\\nowhere\\at\\all' } })
    engine.sequences.updateStep(slug, 's2', { host: 'web-9' })
    const { out } = save([slug])
    const warnings = pf.inspect(out).warnings.join(' | ')
    expect(warnings).toContain("host 'web-9' is not in this ScriptHub's settings")
    expect(warnings).toContain('tag = C:\\nowhere\\at\\all does not exist on this computer')
  })

  it('saves, opens and installs the way the pages do', async () => {
    const slug = await makeSequence()
    const r = pf.saveCurrent('Ops project.scripthub') // what the Save As dialog passes
    expect(r.fileName).toBe('Ops project.scripthub')
    expect(r.summary).toBe('5 files (2 scripts), 1 sequences, 1 presets')
    const z = unzipSync(r.bytes)
    expect(JSON.parse(text(z['manifest.json'])).name).toBe('Ops project')
    expect(Object.keys(z)).toContain(`sequences/${slug}.yaml`) // sequences using the folder
    expect(Object.keys(z).some((n) => n.includes('.env') || n.includes('.pem'))).toBe(false)
    expect(pf.saveCurrent().fileName).toBe('ops.scripthub') // the folder name

    const token = pf.saveUpload(r.bytes)
    const preview = pf.inspect(pf.uploadPath(token))
    expect(preview.sequences[0]).toEqual({ name: 'Release', as: 'Release (2)', steps: 2 })
    const dest = path.join(tmp, 'unpacked')
    const result = pf.install(pf.uploadPath(token), dest)
    expect(fs.existsSync(path.join(dest, 'alpha.py'))).toBe(true)
    pf.forgetUpload(token)
    expect(fs.existsSync(path.join(pf.importsDir(), token + EXT))).toBe(false)
    expect(result.sequences.length).toBe(1)

    expect(() => pf.inspectBytes(Buffer.from('not a zip'))).toThrow(/Not a ScriptHub project file/)
    expect(() => pf.uploadPath('0'.repeat(24))).toThrow(/no longer available/)
    expect(() => pf.uploadPath('../../x')).toThrow(ProjectError)
  })

  it('forgets a cancelled upload, needs an open folder to save, and closes the project', async () => {
    await makeSequence()
    const { out } = save([])
    const token = pf.saveUploadFromFile(out)
    pf.forgetUpload(token)
    expect(() => pf.uploadPath(token)).toThrow(ProjectError)
    engine.workspace.openFolder(path.join(src, 'alpha.py')) // an opened file next to the folder
    await pf.closeProject()
    expect(engine.workspace.load().folder).toBeNull()
    expect(engine.workspace.load().files).toEqual([])
    expect(() => pf.saveCurrent()).toThrow(/Open a folder first/)
  })

  it('removes uploads older than a day', () => {
    const old = path.join(pf.importsDir(), 'a'.repeat(24) + EXT)
    put(old, 'x')
    const t = new Date(Date.now() - 3 * 86400_000)
    fs.utimesSync(old, t, t)
    pf.saveUpload(Buffer.from('y'))
    expect(fs.existsSync(old)).toBe(false)
  })
})

describe('unsafe files', () => {
  const MANIFEST = { format: 'scripthub-project', version: 1, files: [], sequences: [], presets: [] }

  function zipWith(entries: Record<string, string>, manifest: any = MANIFEST, symlink?: string): Uint8Array {
    const z: Zippable = {}
    for (const [n, d] of Object.entries(entries)) z[n] = Buffer.from(d)
    if (symlink) z[symlink] = [Buffer.from('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }]
    if (manifest !== false) z['manifest.json'] = Buffer.from(JSON.stringify(manifest))
    return zipSync(z)
  }

  it('refuses unsafe or damaged files', () => {
    const base = { sequences: [], presets: [] }
    const cases: Record<string, Uint8Array> = {
      parent: zipWith({ 'files/../evil.py': 'x' }),
      absolute: zipWith({ '/files/evil.py': 'x' }),
      drive: zipWith({ 'C:/files/evil.py': 'x' }),
      backslash: zipWith({ 'files\\..\\evil.py': 'x' }),
      unexpected: zipWith({ 'other/evil.py': 'x' }),
      link: zipWith({}, MANIFEST, 'files/link.py'),
      'no manifest': zipWith({ 'files/a.py': 'x' }, false),
      'other format': zipWith({}, { ...MANIFEST, format: 'zip' }),
      newer: zipWith({}, { ...MANIFEST, version: 99 }),
      changed: zipWith({ 'files/a.py': 'changed' }, { format: 'scripthub-project', version: 1, ...base, files: [{ path: 'a.py', size: 1, sha256: '0'.repeat(64) }] }),
      'manifest path': zipWith({}, { format: 'scripthub-project', version: 1, ...base, files: [{ path: '../../evil.py' }] }),
      'two names': zipWith({ 'files/a.py': 'x', 'files/A.py': 'y' }),
      'no lists': zipWith({}, { format: 'scripthub-project', version: 1 }),
    }
    for (const [label, bytes] of Object.entries(cases)) expect(() => pf.inspectBytes(bytes), label).toThrow(ProjectError)
    expect(() => pf.inspectBytes(Buffer.from('hello'))).toThrow(ProjectError)
    expect(() => pf.inspect(path.join(tmp, 'missing.scripthub'))).toThrow(ProjectError)
  })

  it('accepts a good minimal file', () => {
    const body = 'print(1)\n'
    const sha = createHash('sha256').update(body).digest('hex')
    const bytes = zipWith({ 'files/a.py': body }, { ...MANIFEST, files: [{ path: 'a.py', size: body.length, sha256: sha, script: true }] })
    expect(pf.inspectBytes(bytes).files).toBe(1)
  })

  it('refuses over-compressed members', () => {
    const big = Buffer.alloc(3 * 1024 * 1024)
    const bytes = zipWith({ 'files/zeros.bin': big.toString('latin1') }, { ...MANIFEST, files: [{ path: 'zeros.bin' }] })
    expect(() => pf.inspectBytes(bytes)).toThrow(/compressed suspiciously well/)
  })

  it('needs a new or empty destination outside the runtime folder', () => {
    put(path.join(tmp, 'full', 'x.txt'), 'x')
    for (const bad of [path.join(tmp, 'full'), 'relative/folder', path.join(engine.dirs.runtime, 'here'), '']) expect(() => pf.checkDestination(bad), bad).toThrow(ProjectError)
    fs.mkdirSync(path.join(tmp, 'empty'))
    expect(pf.checkDestination(path.join(tmp, 'empty'))).toBe(path.join(tmp, 'empty'))
  })
})
