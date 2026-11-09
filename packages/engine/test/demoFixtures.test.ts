/**
 * Builds packages/client/src/demoData.json: real answers of the protocol handlers for the sample scripts, so the UI in a
 * browser (`npm run dev:ui`) shows every page with data that has exactly the shape the engine produces.
 *
 *   SCRIPTHUB_REBUILD_DEMO=1 npx vitest run packages/engine/test/demoFixtures.test.ts
 *
 * Without the variable only the checks run (the committed file has every section the demo transport needs).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerHandlers } from '../src/api/index.js'
import { Engine } from '../src/engine.js'
import { PY, waitFor } from './execCase.js'
import { tmpDir } from './helpers.js'

const root = path.resolve(__dirname, '..', '..', '..')
const OUT = path.join(root, 'packages', 'client', 'src', 'demoData.json')
const REBUILD = !!process.env.SCRIPTHUB_REBUILD_DEMO

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name)
    const b = path.join(to, e.name)
    if (e.isDirectory()) copyDir(a, b)
    else fs.copyFileSync(a, b)
  }
}

describe('demo fixtures', () => {
  it.runIf(REBUILD)('rebuilds demoData.json from the sample scripts', async () => {
    const home = tmpDir('sh-demo-home-')
    const scripts = tmpDir('sh-demo-scripts-')
    copyDir(path.join(root, 'samples', 'sample_scripts'), scripts) // never touch the originals
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ interpreters: { '.py': PY, '.sh': 'bash', '.bat': 'cmd' } }))
    const engine = new Engine({ runtimeDir: home, appDir: scripts, pythonExecutable: PY, samplesDir: path.join(root, 'samples', 'sample_projects') })
    const handlers = registerHandlers(engine, { clientId: 'demo', pickFolder: async () => null, pickFiles: async () => [] }, () => {})
    const call = <T = any>(name: string, args: unknown = {}) => handlers.call(name, args) as Promise<T>

    await call('workspace.open', { paths: [scripts] })
    await engine.discovery.scan(true)
    const tree = await call<any[]>('scripts.tree')
    const all: any[] = tree.flatMap((g) => g.scripts)
    const byRel = (rel: string) => all.find((s) => s.relative.replaceAll('\\', '/') === rel)
    const picked = ['basics/hello.py', 'basics/outcome.py', 'basics/parameter_tour.py', 'files/file_checksum.py', 'files/find_large_files.py']
      .map(byRel).filter(Boolean)
    expect(picked.length).toBeGreaterThanOrEqual(3)

    const data: Record<string, any> = { global: {}, scripts: {}, runs: {}, sequences: {}, sequenceRuns: {}, projects: {} }

    // a run to show: the Hello script, then its recorded values become the "recent" run
    const hello = picked[0]
    await call('presets.save', { scriptId: hello.id, name: 'Greet the team', values: { name: 'Team' } })
    const started = await call<any>('runs.start', { scriptId: hello.id, values: { name: 'ScriptHub' }, token: 'demo-1' })
    expect(started.ok).toBe(true)
    await engine.manager.waitFinished(started.runId, 30000)
    const failing = picked[1]
    const second = await call<any>('runs.start', { scriptId: failing.id, values: {}, token: 'demo-2' })
    if (second.ok) await engine.manager.waitFinished(second.runId, 30000)

    for (const s of picked) {
      data.scripts[s.id] = {
        'scripts.get': await call('scripts.get', { id: s.id }),
        'scripts.doc': await call('scripts.doc', { id: s.id }),
        'editor.read': await call('editor.read', { id: s.id }),
        'runs.form': await call('runs.form', { scriptId: s.id }),
        'presets.list': await call('presets.list', { scriptId: s.id }),
        'presets.grid': await call('presets.grid', { scriptId: s.id }),
      }
    }

    // a sequence of three of them (success arrow, failure arrow), run once
    const slug = (await call<any>('sequences.create', { name: 'Nightly checks' })).slug
    const step = async (s: any, x: number, y: number) => (await call<any>('sequences.graphOp', { slug, op: { op: 'add', script: s.id, x, y } })).id as string
    const a = await step(picked[0], 40, 40)
    const b = await step(picked[2], 280, 40)
    const c = await step(picked[1], 280, 160)
    await call('sequences.graphOp', { slug, op: { op: 'link', from: a, to: b, when: 'success' } })
    await call('sequences.graphOp', { slug, op: { op: 'link', from: a, to: c, when: 'failure' } })
    await call('sequences.favorite', { slug, on: true })
    const seqRun = await call<any>('sequences.start', { slug, token: 'demo-seq' })
    expect(seqRun.ok, JSON.stringify(seqRun)).toBe(true)
    expect(await engine.sequencer.waitIdle(60000)).toBe(true)

    data.sequences[slug] = {
      'sequences.get': await call('sequences.get', { slug }),
      'sequences.graph': await call('sequences.graph', { slug }),
      steps: Object.fromEntries(await Promise.all([a, b, c].map(async (id) => [id, await call('sequences.step', { slug, stepId: id })]))),
    }
    data.sequenceRuns[seqRun.run] = {
      'sequences.run': await call('sequences.run', { id: seqRun.run }),
      'sequences.runStatus': await call('sequences.runStatus', { id: seqRun.run }),
    }

    for (const r of engine.history.listRuns({ limit: 10 })) {
      const id = String(r.id)
      data.runs[id] = { 'runs.console': await call('runs.console', { id }), 'runs.status': await call('runs.status', { id }) }
    }

    const samples = await call<any[]>('project.samples')
    for (const s of samples.slice(0, 2)) data.projects[s.name] = await call('project.openSample', { name: s.name })

    Object.assign(data.global, {
      'app.info': await call('app.info'),
      'app.shell': await call('app.shell'),
      'workspace.overview': await call('workspace.overview'),
      'scripts.tree': tree,
      'scripts.list': await call('scripts.list'),
      'settings.get': await call('settings.get'),
      'settings.dataOverview': await call('settings.dataOverview'),
      'project.samples': samples,
      'runs.running': await call('runs.running'),
      'runs.recent': await call('runs.recent', { limit: 40 }),
      'runs.query': await call('runs.query', { page: 1 }),
      'sequences.list': await call('sequences.list'),
      'newScript.options': await call('newScript.options', { from: hello.id }),
    })
    data.global['app.info'] = { ...data.global['app.info'], version: 'demo', runtimeMode: 'user' }

    // portable placeholders instead of this machine's temp folders
    let text = JSON.stringify(data)
    const esc = (p: string) => JSON.stringify(p).slice(1, -1)
    for (const [from, to] of [
      [path.join(root, 'samples', 'sample_scripts'), 'C:/ScriptHub/samples/sample_scripts'],
      [scripts, 'C:/ScriptHub/samples'], [home, 'C:/Users/demo/AppData/Local/ScriptHub'], [root, 'C:/ScriptHub'],
      [fs.realpathSync(os.tmpdir()), 'C:/Users/demo/Documents'], [os.homedir(), 'C:/Users/demo'],
    ] as const) {
      for (const v of new Set([from, from.replaceAll('\\', '/'), path.resolve(from)])) text = text.split(esc(v)).join(to)
    }
    text = text.split(path.basename(scripts)).join('samples').split(path.basename(home)).join('ScriptHub')
    fs.writeFileSync(OUT, JSON.stringify(JSON.parse(text), null, 1) + '\n')
    handlers.dispose()
  }, 180000)

  it('the committed fixture has every section the demo transport needs', () => {
    const d = JSON.parse(fs.readFileSync(OUT, 'utf8'))
    for (const k of ['app.info', 'app.shell', 'workspace.overview', 'scripts.tree', 'scripts.list', 'settings.get', 'settings.dataOverview',
      'project.samples', 'runs.running', 'runs.recent', 'runs.query', 'sequences.list', 'newScript.options']) expect(d.global[k], k).toBeTruthy()
    const scripts = Object.values<any>(d.scripts)
    expect(scripts.length).toBeGreaterThanOrEqual(3)
    for (const s of scripts) for (const k of ['scripts.get', 'scripts.doc', 'editor.read', 'runs.form', 'presets.list', 'presets.grid']) expect(s[k], k).toBeTruthy()
    expect(Object.keys(d.sequences).length).toBeGreaterThanOrEqual(1)
    expect(Object.keys(d.sequenceRuns).length).toBeGreaterThanOrEqual(1)
    expect(Object.keys(d.runs).length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(d)).not.toMatch(/sh-demo-|ScriptHub_Electron|Local[\\/]+Temp/) // no temp folders of the machine that built it
  })
})
