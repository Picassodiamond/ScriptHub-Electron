/**
 * Port of runner/test_sample_scripts.py: the sample scripts (samples/sample_scripts) and sample projects
 * (samples/sample_projects/*.scripthub, built by the Python app's tools/build_sample_projects.py).
 * The shipped .scripthub files are the Python-built ones: opening them here is the compatibility test.
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildSampleProjects } from '../../../tools/buildSampleProjects.js'
import { Engine } from '../src/engine.js'
import { which } from '../src/executor.js'
import { MAX_DEPTH } from '../src/discovery.js'
import * as parameters from '../src/parameters.js'
import { EXT, ProjectError, ProjectFiles } from '../src/projectFiles.js'
import { tmpDir } from './helpers.js'

const SAMPLES_ROOT = fileURLToPath(new URL('../../../samples', import.meta.url))
const SAMPLES = path.join(SAMPLES_ROOT, 'sample_scripts')
const PROJECTS = path.join(SAMPLES_ROOT, 'sample_projects')
const PY = which('python') ?? which('python3') ?? 'python'

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])).sort()
}
const scripts = () => walk(SAMPLES).filter((p) => ['.py', '.sh', '.bat'].includes(path.extname(p)))
const rel = (p: string) => path.relative(SAMPLES, p).split(path.sep).join('/')

function makeEngine(extra: Record<string, any> = {}) {
  const home = tmpDir('sr-samples-')
  const runtime = path.join(home, 'runtime')
  fs.mkdirSync(runtime)
  fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({ interpreters: { '.py': PY, '.sh': 'bash', '.bat': 'cmd' }, default_timeout: 60, ...extra }))
  const engine = new Engine({ runtimeDir: runtime, appDir: home, pythonExecutable: PY })
  const projects = new ProjectFiles({
    dirs: engine.dirs, config: engine.config, discovery: engine.discovery, workspace: engine.workspace, sequences: engine.sequences,
    presets: engine.presets, appDir: path.join(home, 'app'), samplesDir: PROJECTS, homeDir: path.join(home, 'home'),
  })
  return { home, engine, projects }
}

function run(file: string, args: string[], env: Record<string, string> = {}, cwd?: string) {
  const p = path.join(SAMPLES, file)
  const r = spawnSync(PY, [p, ...args], { cwd: cwd ?? path.dirname(p), encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONUTF8: '1', ...env } })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** argv and env the way ScriptHub builds them from the defaults (+ overrides, raw form values). */
function defaultArgv(engine: Engine, file: string, overrides: Record<string, any> = {}): [string[], Record<string, string>] {
  const script = engine.discovery.loadFile(path.join(SAMPLES, file))!
  const params = script.meta.parameters
  const raw = { ...parameters.defaultsRaw(params), ...overrides }
  const [values, errors] = parameters.cleanValues(params, raw)
  expect(errors).toEqual({})
  return parameters.buildArguments(params, values)
}

describe('sample script metadata', () => {
  it('every sample has valid metadata, a category and a description, and no stable id', () => {
    const { engine } = makeEngine()
    expect(scripts().length).toBeGreaterThanOrEqual(15)
    for (const p of scripts()) {
      const s = engine.discovery.loadFile(p)
      expect(s && s.metaValid, `${rel(p)}: ${s?.metaError}`).toBe(true)
      expect(s!.meta.description && s!.meta.category, rel(p)).toBeTruthy()
      expect(s!.meta, rel(p)).not.toHaveProperty('id') // ids are given on first save, per copy
    }
  })

  it('stays within the discovery depth and has the right line endings', () => {
    for (const p of scripts()) {
      expect(rel(p).split('/').length - 1).toBeLessThanOrEqual(MAX_DEPTH)
      const data = fs.readFileSync(p)
      const lf = data.filter((b) => b === 0x0a).length
      const crlf = data.toString('latin1').split('\r\n').length - 1
      if (p.endsWith('.bat')) expect(crlf, path.basename(p)).toBe(lf)
      else expect(crlf, path.basename(p)).toBe(0)
    }
  })

  it('the parameter tour uses every type and way of passing', () => {
    const { engine } = makeEngine()
    const params: any[] = engine.discovery.loadFile(path.join(SAMPLES, 'basics', 'parameter_tour.py'))!.meta.parameters
    expect(new Set(params.map((p) => p.type))).toEqual(new Set(Object.keys(parameters.TYPES)))
    expect(new Set(params.map((p) => p.pass_as ?? 'flag'))).toEqual(new Set(parameters.PASS_AS))
  })
})

describe('python samples', () => {
  it('every python sample runs with its defaults or simple values', () => {
    const { engine, home } = makeEngine()
    const src = path.join(home, 'src')
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, 'a.txt'), 'hello')
    const needs: Record<string, Record<string, any>> = {
      'files/clean_old_files.py': { folder: src },
      'files/backup_folder.py': { source: src, destination: path.join(home, 'bak') },
      'files/file_checksum.py': { file: path.join(src, 'a.txt') },
      'system/disk_space.py': { max_used: '100' },
      'system/log_message.py': { log_file: path.join(home, 'messages.log') },
      'basics/outcome.py': { seconds: '0' },
    }
    const skip = new Set(['network/check_port.py', 'network/http_check.py']) // tested offline below
    for (const p of walk(SAMPLES).filter((f) => f.endsWith('.py'))) {
      const r = rel(p)
      if (skip.has(r)) continue
      const [argv, env] = defaultArgv(engine, r, needs[r])
      const out = run(r, argv, env)
      expect(out.code, `${r}: ${out.stderr}`).toBe(0)
      expect(out.stdout.trim(), r).not.toBe('')
    }
  }, 120000)

  it('the parameter tour shows what arrives and hides the secret', () => {
    const { engine } = makeEngine()
    const [argv, env] = defaultArgv(engine, 'basics/parameter_tour.py', { api_token: 's3cret' })
    const r = run('basics/parameter_tour.py', argv, env)
    for (const s of ["'demo'", "['logs', 'metrics']", "'dev'", '******']) expect(r.stdout).toContain(s)
    expect(r.stdout).not.toContain('s3cret')
  })

  it('outcome failure uses the exit code', () => {
    expect(run('basics/outcome.py', ['--outcome', 'failure', '--seconds', '0', '--exit-code', '7']).code).toBe(7)
  })

  it('clean_old_files lists by default and deletes only old matches; refuses a root', () => {
    const dir = tmpDir('sr-clean-')
    const [old, fresh, other] = ['old.log', 'new.log', 'old.txt'].map((n) => path.join(dir, n))
    for (const p of [old, fresh, other]) fs.writeFileSync(p, 'x')
    const past = new Date(Date.now() - 40 * 86400_000)
    for (const p of [old, other]) fs.utimesSync(p, past, past)
    let r = run('files/clean_old_files.py', ['--folder', dir, '--days', '30'])
    expect(r.stdout).toContain('old.log')
    expect(fs.existsSync(old)).toBe(true)
    r = run('files/clean_old_files.py', ['--folder', dir, '--days', '30', '--delete'])
    expect(r.code, r.stderr).toBe(0)
    expect([fs.existsSync(old), fs.existsSync(fresh), fs.existsSync(other)]).toEqual([false, true, true])
    expect(run('files/clean_old_files.py', ['--folder', path.parse(dir).root]).code).not.toBe(0)
  })

  it('backup keeps the newest and refuses a target inside the source', () => {
    const dir = tmpDir('sr-bak-')
    const src = path.join(dir, 'notes')
    const dest = path.join(dir, 'bak')
    fs.mkdirSync(src)
    fs.mkdirSync(dest)
    fs.writeFileSync(path.join(src, 'a.txt'), 'a')
    for (const stamp of ['20200101-000000', '20200102-000000', '20200103-000000']) fs.writeFileSync(path.join(dest, `notes-${stamp}.zip`), 'old')
    const r = run('files/backup_folder.py', ['--source', src, '--destination', dest, '--keep', '2'])
    expect(r.code, r.stderr).toBe(0)
    const left = fs.readdirSync(dest).sort()
    expect(left.length).toBe(2)
    expect(left).toContain('notes-20200103-000000.zip')
    expect(Buffer.from(unzipSync(fs.readFileSync(path.join(dest, left[left.length - 1])))['a.txt']).toString()).toBe('a')
    expect(run('files/backup_folder.py', ['--source', src, '--destination', path.join(src, 'inner')]).code).not.toBe(0)
  })

  it('checksum mismatch fails', () => {
    const f = path.join(tmpDir('sr-sum-'), 'f.bin')
    fs.writeFileSync(f, 'abc')
    const ok = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    expect(run('files/file_checksum.py', ['--file', f, '--expected', ok]).code).toBe(0)
    expect(run('files/file_checksum.py', ['--file', f, '--expected', '00']).code).toBe(1)
  })

  it('data samples read their files next to them', () => {
    let r = run('data/csv_summary.py', ['--file', 'sales.csv', '--group-by', 'product'])
    expect(r.stdout).toContain('Laptop')
    r = run('data/log_search.py', ['--file', 'app.log', '--pattern', 'CRITICAL', '--fail-if-found'])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('database connection lost')
    expect(run('data/csv_summary.py', ['--file', 'sales.csv', '--group-by', 'nope']).code).not.toBe(0)
  })

  it('network checks work against a local server', async () => {
    const server = http.createServer((req, res) => {
      const body = '<h1>ScriptHub test page</h1>'
      res.writeHead(req.url === '/' ? 200 : 404, { 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = String((server.address() as net.AddressInfo).port)
    const url = `http://127.0.0.1:${port}/`
    try {
      // the scripts run in another process: do not block the event loop that serves them
      const runAsync = (file: string, args: string[]) => new Promise<number | null>((resolve) => {
        import('node:child_process').then(({ spawn }) => {
          const c = spawn(PY, [path.join(SAMPLES, file), ...args], { env: { ...process.env, PYTHONUTF8: '1' } })
          c.on('close', resolve)
        })
      })
      expect(await runAsync('network/check_port.py', ['--host', '127.0.0.1', '--port', port])).toBe(0)
      expect(await runAsync('network/http_check.py', ['--url', url, '--contains', 'test page'])).toBe(0)
      expect(await runAsync('network/http_check.py', ['--url', url, '--contains', 'missing'])).toBe(1)
      expect(await runAsync('network/http_check.py', ['--url', url + 'x'])).toBe(1)
    } finally {
      server.close()
    }
    const closed = await new Promise<string>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = String((s.address() as net.AddressInfo).port)
        s.close(() => resolve(p)) // a port that is surely closed now
      })
    })
    expect(run('network/check_port.py', ['--host', '127.0.0.1', '--port', closed, '--timeout', '2']).code).toBe(1)
  }, 60000)
})

describe.skipIf(os.platform() !== 'win32')('batch samples', () => {
  const bat = (file: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync('cmd', ['/c', path.join(SAMPLES, file), ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } })

  it('run', () => {
    expect(bat('basics/hello.bat', ['Ada']).stdout).toContain('Hello, Ada!')
    const r = bat('system/list_directory.bat', [path.join(SAMPLES, 'system')], { LIST_MODE: 'brief' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('list_directory.bat')
    expect(bat('system/list_directory.bat', [path.join(tmpDir('sr-nope-'), 'nope')]).status).not.toBe(0)
  })
})

describe('sample projects', () => {
  let ctx: ReturnType<typeof makeEngine>
  beforeEach(() => { ctx = makeEngine() })

  const projects = () => {
    const found = fs.readdirSync(PROJECTS).filter((f) => f.endsWith(EXT)).sort().map((f) => path.join(PROJECTS, f))
    expect(found.length).toBeGreaterThanOrEqual(3)
    return found
  }

  it('hold the current sample scripts (rebuild with SCRIPTHUB_REBUILD_SAMPLES=1 when a sample changed)', async () => {
    if (process.env.SCRIPTHUB_REBUILD_SAMPLES) await buildSampleProjects({ samplesDir: SAMPLES, outDir: PROJECTS, python: PY, log: console.log })
    for (const p of projects()) {
      const z = unzipSync(fs.readFileSync(p))
      const manifest = JSON.parse(Buffer.from(z['manifest.json']).toString())
      for (const f of manifest.files)
        expect(Buffer.from(z['files/' + f.path]).equals(fs.readFileSync(path.join(SAMPLES, ...f.path.split('/')))), `${path.basename(p)}: ${f.path} is outdated`).toBe(true)
      expect(manifest.sequences.length && manifest.presets.length).toBeTruthy()
    }
  })

  it('open cleanly (Python-built files), and their sequences find their scripts', async () => {
    const { engine, projects: pf, home } = ctx
    let n = 0
    for (const p of projects()) {
      expect(pf.inspect(p).warnings, path.basename(p)).toEqual([])
      const result = pf.install(p, path.join(home, `p${n++}`))
      engine.workspace.openFolder(result.folder)
      await engine.discovery.scan(true)
      for (const slug of result.sequences) expect(engine.sequencer.prepare(engine.sequences.load(slug)).errors, `${path.basename(p)} / ${slug}`).toEqual([])
      expect(result.presets).toBeGreaterThan(0)
    }
    engine.workspace.closeFolder()
  })

  it('built by the TypeScript tool they pass the same checks and match the Python-built contents', async () => {
    const out = tmpDir('sr-built-')
    const written = await buildSampleProjects({ samplesDir: SAMPLES, outDir: out, python: PY })
    expect(written.map((p) => path.basename(p)).sort()).toEqual(projects().map((p) => path.basename(p)).sort())
    const { engine, projects: pf, home } = ctx
    let n = 0
    for (const built of written) {
      const shipped = projects().find((p) => path.basename(p) === path.basename(built))!
      const [a, b] = [pf.inspect(built), pf.inspect(shipped)]
      expect(a.warnings).toEqual([])
      expect({ ...a, created_at: '', scripthub: '' }).toEqual({ ...b, created_at: '', scripthub: '' })
      const result = pf.install(built, path.join(home, `t${n++}`))
      engine.workspace.openFolder(result.folder)
      await engine.discovery.scan(true)
      for (const slug of result.sequences) expect(engine.sequencer.prepare(engine.sequences.load(slug)).errors).toEqual([])
    }
    engine.workspace.closeFolder()
  }, 60000)

  it('are listed and opened by name only, never by path', () => {
    const { projects: pf, home } = ctx
    expect(pf.sampleProjects().map((s) => s.name)).toEqual(['Files and data', 'Getting started', 'Health check'])
    const token = pf.importSample('Getting started')
    const preview = pf.inspect(pf.uploadPath(token)) // the preview, nothing written yet
    expect(preview.sequences.map((s) => s.name)).toEqual(['Try a sequence'])
    // never suggested inside the code folder; ~/ScriptHub projects when nothing is open
    expect(pf.defaultDestination(preview.name)).toBe(path.join(home, 'home', 'ScriptHub projects', 'Getting started'))
    const dest = path.join(home, 'Getting started')
    pf.install(pf.uploadPath(token), dest)
    expect(fs.existsSync(path.join(dest, 'basics', 'hello.py'))).toBe(true)
    expect(ctx.engine.sequences.list().map((s) => s.name)).toEqual(['Try a sequence'])
    for (const bad of ['../README', 'nope', '']) expect(() => pf.importSample(bad), bad).toThrow(ProjectError)
  })

  it('suggest a folder next to the open one, with a free name', () => {
    const { engine, projects: pf, home } = ctx
    const parent = path.join(home, 'work')
    fs.mkdirSync(path.join(parent, 'cur'), { recursive: true })
    fs.mkdirSync(path.join(parent, 'Getting started'))
    engine.workspace.openFolder(path.join(parent, 'cur'))
    expect(pf.defaultDestination('Getting started')).toBe(path.join(parent, 'Getting started (2)'))
  })
})
