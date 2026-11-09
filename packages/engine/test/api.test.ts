/**
 * The protocol handlers: a contract test over every call name, and behaviour tests through the Engine
 * (real python subprocesses, throwaway data folder, host stubbed).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError, callNames, calls, eventNames, makeClient, parseArgs, type EventName } from '@scripthub/protocol'
import { registerHandlers, type Handlers } from '../src/api/index.js'
import { Engine } from '../src/engine.js'
import { PY, waitFor } from './execCase.js'
import { tmpDir } from './helpers.js'

const GREET = `# --- scripthub ---
# name: Greeter
# parameters:
#   - name: who
#     type: text
#     default: world
#     flag: --who
# --- end scripthub ---
import sys
print("hello", sys.argv[sys.argv.index("--who") + 1])
`
const SLOW = '# --- scripthub ---\n# name: Slow\n# --- end scripthub ---\nimport time\ntime.sleep(1.0)\n'

const toDispose: Handlers[] = []
afterEach(() => {
  for (const h of toDispose.splice(0)) h.dispose()
})

function setup(opts: { config?: Record<string, any> } = {}) {
  const home = tmpDir('sh-api-home-')
  const scripts = tmpDir('sh-api-scripts-')
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ interpreters: { '.py': PY }, ...opts.config }))
  const events: Array<{ event: string; payload: any }> = []
  const engine = new Engine({ runtimeDir: home, appDir: scripts, pythonExecutable: PY })
  const host = { clientId: 'api-test', pickFolder: async () => scripts, pickFiles: async () => [path.join(scripts, 'greet.py')] }
  const handlers = registerHandlers(engine, host, (event, payload) => events.push({ event, payload }))
  toDispose.push(handlers)
  const put = (name: string, body: string) => {
    fs.writeFileSync(path.join(scripts, name), body)
    return path.join(scripts, name)
  }
  const call = <T = any>(name: string, args: unknown = {}) => handlers.call(name, args) as Promise<T>
  const eventsOf = (name: string) => events.filter((e) => e.event === name).map((e) => e.payload)
  return { engine, handlers, scripts, home, put, call, events, eventsOf }
}

async function opened(s: ReturnType<typeof setup>) {
  s.put('greet.py', GREET)
  await s.call('workspace.open', { paths: [s.scripts] })
  await s.engine.discovery.scan(true)
  const tree = await s.call('scripts.tree')
  return tree[0].scripts[0].id as string
}

describe('contract', () => {
  it('has a handler for every protocol call and no others', () => {
    const { handlers } = setup()
    expect(Object.keys(handlers.table).sort()).toEqual([...callNames].sort())
    expect(callNames.length).toBeGreaterThan(80)
    expect(new Set(callNames).size).toBe(callNames.length)
    for (const n of eventNames) expect(typeof n).toBe('string')
  })

  it('validates arguments with zod before any handler runs', async () => {
    const { call } = setup()
    for (const name of callNames) {
      const needsArgs = !calls[name].args.safeParse({}).success
      if (needsArgs) {
        const err = await call(name, {}).catch((e) => e)
        expect(err, `${name} with {}`).toBeInstanceOf(ApiError)
        expect(err.code, name).toBe('invalid')
      }
    }
    // wrong types are refused too
    for (const [name, bad] of [['runs.status', { id: 5 }], ['runs.status', { id: 'RUN-1', out: -1 }], ['workspace.open', { paths: [] }],
      ['sequences.graphOp', { slug: 'x', op: { op: 'explode' } }], ['runs.debug', { id: 'a', action: 'fly' }],
      ['runs.deleteOlder', { days: 99999 }], ['settings.clear', { kind: 7 }]] as const) {
      const err = await call(name, bad).catch((e) => e)
      expect(err, name).toBeInstanceOf(ApiError)
      expect(err.code).toBe('invalid')
    }
    const unknown = await call('nope.nothing').catch((e) => e)
    expect(unknown.code).toBe('unknown_call')
  })

  it('normalises arguments (defaults applied) and parseArgs exposes them', () => {
    expect(parseArgs('runs.status', { id: 'x' })).toEqual({ id: 'x', out: 0, err: 0 })
    expect(parseArgs('runs.query', {})).toMatchObject({ page: 1, q: '' })
    expect(parseArgs('sequences.hold', { id: 'a', step: 's1' })).toEqual({ id: 'a', step: 's1', on: true })
  })

  it('serialises every result as JSON (no class instances)', async () => {
    const s = setup()
    const id = await opened(s)
    for (const [name, args] of [['app.info', {}], ['app.shell', {}], ['scripts.list', {}], ['scripts.get', { id }], ['scripts.doc', { id }],
      ['runs.form', { scriptId: id }], ['settings.get', {}], ['workspace.overview', {}], ['sequences.list', {}], ['runs.query', {}]] as const) {
      const out = await s.call(name, args)
      expect(JSON.parse(JSON.stringify(out)), name).toEqual(out)
    }
  })
})

describe('workspace, scripts and the shell', () => {
  it('opens a folder, scans it and lists the scripts (explorer tree, library, palette)', async () => {
    const s = setup()
    s.put('greet.py', GREET)
    s.put('notes.txt', 'x')
    const r = await s.call('workspace.open', { paths: [s.scripts] })
    expect(r.errors).toEqual([])
    expect(r.opened.length).toBe(1)
    await s.engine.discovery.scan(true)

    const shell = await s.call('app.shell')
    expect(shell.tree.map((g: any) => g.name)).toEqual(['General'])
    expect(shell.palette[0]).toMatchObject({ name: 'Greeter', ext: 'py', run: true })
    expect(shell.folder.folder.path).toBe(r.opened[0])
    expect(shell.editingEnabled).toBe(true)

    const lib = await s.call('scripts.list')
    expect(lib.scripts.map((x: any) => x.name)).toEqual(['Greeter'])
    expect(lib.scripts[0]).toMatchObject({ metaValid: true, parameterCount: 1, language: 'python', lastRun: null })
    expect(lib.languages).toEqual([['python', 'Python']])
    expect(s.eventsOf('workspace.changed').length).toBeGreaterThan(0)
  })

  it('reports bad paths as data, and closes the folder', async () => {
    const s = setup()
    const r = await s.call('workspace.open', { paths: [path.join(s.scripts, 'nope')] })
    expect(r.opened).toEqual([])
    expect(r.errors[0]).toMatch(/Not an existing folder/)
    await s.call('workspace.open', { paths: [s.scripts] })
    expect((await s.call('workspace.closeFolder')).scripts).toBe(0)
    expect((await s.call('workspace.overview')).folder).toBeNull()
  })

  it('opens a single file and answers with its script id; the host dialogs are reachable', async () => {
    const s = setup()
    const f = s.put('greet.py', GREET)
    const r = await s.call('workspace.open', { paths: [f] })
    expect(r.scriptId).toBeTruthy()
    expect((await s.call('scripts.get', { id: r.scriptId })).script.name).toBe('Greeter')
    expect(await s.call('workspace.pickFolder')).toBe(s.scripts)
    expect(await s.call('workspace.pickFiles')).toEqual([f])
    expect((await s.call('workspace.closeFile', { path: f })).closed).toBe(true)
    expect((await s.call('workspace.closeFile', { path: f })).closed).toBe(false)
    expect((await s.call('workspace.browse', { path: s.scripts })).files.map((x: any) => x.name)).toEqual(['greet.py'])
  })

  it('favourites and forgets folders', async () => {
    const s = setup()
    await s.call('workspace.open', { paths: [s.scripts] })
    await s.call('workspace.favorite', { path: s.scripts, on: true })
    expect((await s.call('workspace.overview')).favorites.length).toBe(1)
    await s.call('workspace.favorite', { path: s.scripts, on: false })
    await s.call('workspace.forget', { path: s.scripts })
    expect((await s.call('workspace.overview')).recent).toEqual([])
  })

  it('unknown script ids are not_found errors', async () => {
    const s = setup()
    await opened(s)
    for (const [n, a] of [['scripts.get', { id: 'ffffffffffff' }], ['runs.form', { scriptId: 'ffffffffffff' }], ['scripts.source', { id: 'x' }]] as const)
      expect((await s.call(n, a).catch((e) => e)).code).toBe('not_found')
    expect((await s.call('runs.status', { id: 'RUN-20200101-001' }).catch((e) => e)).code).toBe('not_found')
    expect((await s.call('runs.status', { id: '../x' }).catch((e) => e)).code).toBe('not_found')
  })

  it('edits script info and parameters, and returns validation errors as data', async () => {
    const s = setup()
    const id = await opened(s)
    const detail = await s.call('scripts.get', { id })
    expect(detail.form.name).toBe('Greeter')
    expect(detail.params[0].name).toBe('who')
    expect(detail.typeInfo.text.label).toBeTruthy()

    const ok = await s.call('scripts.saveInfo', { id, form: { ...detail.form, name: 'Renamed', category: 'Ops', environment: 'A=1' } })
    expect(ok.ok).toBe(true)
    const again = await s.call('scripts.get', { id: ok.id })
    expect(again.script).toMatchObject({ name: 'Renamed', category: 'Ops' })
    expect(again.form.environment).toBe('A=1')

    const badEnv = await s.call('scripts.saveInfo', { id: ok.id, form: { ...detail.form, environment: 'nonsense' } })
    expect(badEnv).toMatchObject({ ok: false })
    expect(badEnv.errors[0]).toMatch(/NAME=value/)

    const params = [...again.params, { name: 'times', type: 'number', default: 2, flag: '--times' }]
    expect((await s.call('scripts.saveParameters', { id: ok.id, parameters: params })).ok).toBe(true)
    expect((await s.call('scripts.get', { id: ok.id })).params.length).toBe(2)
    const bad = await s.call('scripts.saveParameters', { id: ok.id, parameters: [{ name: 'x y', type: 'bogus' }] })
    expect(bad.ok).toBe(false)
    expect(bad.errors.length).toBeGreaterThan(0)
  })

  it('reads the source and builds the document context', async () => {
    const s = setup()
    const id = await opened(s)
    const src = await s.call('scripts.source', { id })
    expect(src.text).toContain('print("hello"')
    expect(src.language).toBe('python')
    const doc = await s.call('scripts.doc', { id })
    expect(doc.editor.hash).toMatch(/^[0-9a-f]+$/)
    expect(doc.grid).toHaveProperty('rows')
    expect((await s.call('scripts.filePath', { id })).name).toBe('greet.py')
  })
})

describe('editor', () => {
  it('saves with conflict detection, keeps versions and restores', async () => {
    const s = setup()
    const id = await opened(s)
    const read = await s.call('editor.read', { id })
    const saved = await s.call('editor.save', { id, text: read.info.text + '# edit\n', baseHash: read.info.hash })
    expect(saved).toMatchObject({ ok: true, changed: true })
    const stale = await s.call('editor.save', { id: saved.id, text: 'x = 1\n', baseHash: read.info.hash })
    expect(stale).toMatchObject({ ok: false, conflict: true })
    const forced = await s.call('editor.save', { id: saved.id, text: 'x = 1\n', baseHash: read.info.hash, force: true })
    expect(forced.ok).toBe(true)
    const versions = await s.call('editor.versions', { id: forced.id })
    expect(versions.length).toBeGreaterThan(0)
    // the text of a saved version (the side-by-side diff in Versions…): the newest backup is what was on disk before the last save
    const text = await s.call('editor.versionText', { id: forced.id, version: versions[0].name })
    expect(text.text).toContain('# edit')
    expect((await s.call('editor.versionText', { id: forced.id, version: 'nope.bak' }).catch((e) => e)).code).toBe('not_found')
    const restored = await s.call('editor.restore', { id: forced.id, previous: true })
    expect(restored.ok).toBe(true)
    expect((await s.call('editor.read', { id: restored.id })).info.text).toContain('# edit')
  })

  it('refuses edits when editing is turned off (and says so once through the setting)', async () => {
    const s = setup()
    const id = await opened(s)
    expect(await s.call('scripts.setEnabledEditing', { enabled: false })).toEqual({ enabled: false })
    for (const [n, a] of [['editor.read', { id }], ['editor.save', { id, text: 'x', baseHash: 'h' }], ['editor.restore', { id }], ['editor.versionText', { id, version: 'x' }], ['newScript.options', {}]] as const)
      expect((await s.call(n, a).catch((e) => e)).code, n).toBe('forbidden')
    expect((await s.call('scripts.doc', { id })).editor).toBeNull()
    expect((await s.call('app.info')).editingEnabled).toBe(false)
  })
})

describe('runs', () => {
  it('shows the run form, starts a run, and pages its output by offset', async () => {
    const s = setup()
    const id = await opened(s)
    const form = await s.call('runs.form', { scriptId: id })
    expect(form.blocked).toBeNull()
    expect(form.hosts).toContain('local')
    expect(form.fields[0].name).toBe('who')
    expect(form.modesSupported).toBe(true)

    const start = await s.call('runs.start', { scriptId: id, values: { who: 'api' }, token: 'tk1' })
    expect(start.ok).toBe(true)
    expect((await s.call('runs.start', { scriptId: id, values: { who: 'api' }, token: 'tk1' })).runId).toBe(start.runId)
    await s.engine.manager.waitFinished(start.runId, 20000)
    await s.engine.manager.waitIdle(20000)

    const st1 = await s.call('runs.status', { id: start.runId })
    expect(st1).toMatchObject({ status: 'success', active: false, exit_code: 0, status_label: 'Success', trace: null, debug: null })
    expect(st1.stdout).toContain('hello api')
    const st2 = await s.call('runs.status', { id: start.runId, out: st1.stdout_next })
    expect(st2.stdout).toBe('')
    expect(st2.stdout_next).toBe(st1.stdout_next)

    const con = await s.call('runs.console', { id: start.runId })
    expect(con.paramRows).toEqual([['who', 'api']])
    expect(con.active).toBe(false)
    expect((await s.call('runs.logPath', { id: start.runId, stream: 'stdout' })).name).toBe(`${start.runId}-stdout.log`)
    expect((await s.call('runs.stop', { id: start.runId }))).toEqual({ stopped: false, active: false })
    expect((await s.call('runs.stopTrace', { id: start.runId })).ok).toBe(false)
    expect((await s.call('runs.debug', { id: start.runId, action: 'step' }).catch((e) => e)).code).toBe('conflict')

    const recent = await s.call('runs.form', { scriptId: id, preset: '@0' })
    expect(recent.source.kind).toBe('recent')
    expect(recent.recent.length).toBe(1)
  })

  it('returns form errors as data and starts nothing', async () => {
    const s = setup()
    const id = await opened(s)
    const r = await s.call('runs.start', { scriptId: id, host: 'not-a-host', values: { who: 'x' } })
    expect(r.ok).toBe(false)
    expect(r.hostError).toMatch(/listed hosts/)
    expect(r.fields[0].name).toBe('who')
    expect(s.engine.manager.activeIds()).toEqual([])
  })

  it('pushes status and output events for a watched run, ending with the final status', async () => {
    const s = setup()
    s.put('slow.py', SLOW)
    s.put('greet.py', GREET)
    await s.call('workspace.open', { paths: [s.scripts] })
    await s.engine.discovery.scan(true)
    const slow = (await s.call('scripts.list')).scripts.find((x: any) => x.name === 'Slow').id
    const { runId } = await s.call('runs.start', { scriptId: slow })
    await s.call('runs.watch', { id: runId })
    expect(await waitFor(() => s.eventsOf('run.status').some((e) => e.id === runId && e.status === 'success'), 20000)).toBe(true)
    const statuses = s.eventsOf('run.status').filter((e) => e.id === runId).map((e) => e.status)
    expect(statuses[statuses.length - 1]).toBe('success')
    expect(statuses.length).toBeGreaterThanOrEqual(2) // running, then success
  })

  it('delivers output chunks in order with continuing offsets', async () => {
    const s = setup()
    s.put('chatty.py', '# --- scripthub ---\n# name: Chatty\n# --- end scripthub ---\nimport time\nfor i in range(3):\n    print("line", i, flush=True)\n    time.sleep(0.4)\n')
    await s.call('workspace.open', { paths: [s.scripts] })
    await s.engine.discovery.scan(true)
    const id = (await s.call('scripts.tree'))[0].scripts[0].id
    const { runId } = await s.call('runs.start', { scriptId: id })
    await s.call('runs.watch', { id: runId })
    expect(await waitFor(() => s.eventsOf('run.status').some((e) => e.status === 'success'), 20000)).toBe(true)
    const outs = s.eventsOf('run.output').filter((e) => e.id === runId)
    expect(outs.map((e) => e.stdout).join('')).toBe('line 0\nline 1\nline 2\n'.replace(/\n/g, process.platform === 'win32' ? '\r\n' : '\n'))
    for (let i = 1; i < outs.length; i++) expect(outs[i].stdout_next).toBeGreaterThan(outs[i - 1].stdout_next)
  })

  it('queries history (filters, paging, merged sequence runs), deletes and applies retention', async () => {
    const s = setup()
    const id = await opened(s)
    const a = await s.call('runs.start', { scriptId: id, values: { who: 'one' } })
    await s.engine.manager.waitFinished(a.runId, 20000)
    const page = await s.call('runs.query', {})
    expect(page.total).toBe(1)
    expect(page.runs[0]).toMatchObject({ kind: 'script', id: a.runId, status_label: 'Success', active: false })
    expect(page.statuses.length).toBeGreaterThan(3)
    expect(page.scripts).toEqual([[id, 'Greeter']])
    expect((await s.call('runs.query', { q: 'zzz-no-match' })).total).toBe(0)
    expect((await s.call('runs.query', { status: 'failed' })).total).toBe(0)
    expect((await s.call('runs.query', { kind: 'sequences' })).total).toBe(0)
    expect((await s.call('runs.query', { script: id })).filtered).toBe(true)
    expect((await s.call('runs.running')).activeTotal).toBe(0)
    expect((await s.call('runs.recent', { limit: 5 })).length).toBe(1)
    expect((await s.call('runs.applyRetention'))).toMatchObject({ runs_removed: 0 })
    expect((await s.call('runs.delete', { id: a.runId })).deleted).toBe(true)
    expect((await s.call('runs.query', {})).total).toBe(0)
    expect(await s.call('runs.deleteOlder', { days: 0 })).toEqual({ runs: 0, sequences: 0 })
  })
})

describe('runs.changed (pushed instead of polled)', () => {
  it('tells the UI when a run starts and when it finishes, with the new counts', async () => {
    const s = setup()
    const id = await opened(s)
    const start = await s.call('runs.start', { scriptId: id, values: { who: 'push' }, token: 'push-1' })
    expect(start.ok).toBe(true)
    await s.engine.manager.waitFinished(start.runId, 20000)
    await s.engine.manager.waitIdle(20000)
    const ev = s.eventsOf('runs.changed')
    expect(ev.some((e) => e.started.includes(start.runId))).toBe(true)
    expect(ev.some((e) => e.finished.includes(start.runId))).toBe(true)
    expect(ev[ev.length - 1].counts).toEqual({ running: 0, queued: 0 })
    expect(ev.find((e) => e.started.includes(start.runId))!.counts.running + ev.find((e) => e.started.includes(start.runId))!.counts.queued).toBeGreaterThan(0)
  })

  it('also reports a sequence run starting and finishing', async () => {
    const s = setup()
    const id = await opened(s)
    const slug = (await s.call('sequences.create', { name: 'Push' })).slug
    await s.call('sequences.graphOp', { slug, op: { op: 'add', script: id, x: 0, y: 0 } })
    const run = await s.call('sequences.start', { slug, token: 'seq-push' })
    expect(run.ok).toBe(true)
    expect(await s.engine.sequencer.waitIdle(30000)).toBe(true)
    const ev = s.eventsOf('runs.changed')
    expect(ev.some((e) => e.sequences.started.includes(run.run))).toBe(true)
    expect(ev.some((e) => e.sequences.finished.includes(run.run))).toBe(true)
  })

  it('stays quiet when nothing changed', async () => {
    const s = setup()
    await opened(s)
    expect(s.eventsOf('runs.changed')).toEqual([])
  })
})

describe('presets', () => {
  it('saves, lists, renames, grids and deletes saved values', async () => {
    const s = setup()
    const id = await opened(s)
    const saved = await s.call('presets.save', { scriptId: id, name: 'Production', values: { who: 'prod' } })
    expect(saved).toMatchObject({ ok: true, updated: false })
    expect((await s.call('presets.save', { scriptId: id, name: ' production ', values: { who: 'prod2' } })).updated).toBe(true)
    expect((await s.call('presets.list', { scriptId: id })).presets.map((p: any) => p.name)).toEqual(['production']) // saving again under the same name replaces it, taking the new spelling
    const form = await s.call('runs.form', { scriptId: id, preset: saved.slug })
    expect(form.source).toMatchObject({ kind: 'preset', slug: saved.slug })
    expect(form.fields[0].value ?? form.fields[0].raw ?? JSON.stringify(form.fields[0])).toContain('prod2')
    expect((await s.call('presets.grid', { scriptId: id })).rows.length).toBeGreaterThan(0)
    const renamed = await s.call('presets.rename', { scriptId: id, slug: saved.slug, newName: 'Staging' })
    expect(renamed.ok).toBe(true)
    expect((await s.call('presets.rename', { scriptId: id, slug: renamed.slug, newName: '' })).ok).toBe(false)
    expect((await s.call('presets.save', { scriptId: id, name: '', values: {} })).ok).toBe(false)
    expect((await s.call('presets.delete', { scriptId: id, slug: renamed.slug })).removed).toBe(true)
    expect((await s.call('presets.delete', { scriptId: id, slug: renamed.slug })).removed).toBe(false)
  })
})

describe('sequences', () => {
  async function seqSetup() {
    const s = setup()
    s.put('greet.py', GREET)
    s.put('slow.py', SLOW)
    await s.call('workspace.open', { paths: [s.scripts] })
    await s.engine.discovery.scan(true)
    const list = (await s.call('scripts.list')).scripts
    const idOf = (n: string) => list.find((x: any) => x.name === n).id as string
    return { ...s, greet: idOf('Greeter'), slow: idOf('Slow') }
  }

  it('creates, favourites, renames and deletes sequences (name errors as data)', async () => {
    const s = await seqSetup()
    const c = await s.call('sequences.create', { name: 'Nightly' })
    expect(c).toMatchObject({ ok: true, slug: 'nightly' })
    expect((await s.call('sequences.create', { name: 'nightly' })).ok).toBe(false)
    expect((await s.call('sequences.create', { name: '  ' })).error).toMatch(/Enter a name/)
    await s.call('sequences.favorite', { slug: 'nightly', on: true })
    const list = await s.call('sequences.list')
    expect(list.sequences[0]).toMatchObject({ slug: 'nightly', favorite: true, steps: 0 })
    expect((await s.call('sequences.rename', { slug: 'nightly', name: 'Weekly' })).ok).toBe(true)
    expect((await s.call('sequences.rename', { slug: 'nope', name: 'x' }).catch((e) => e)).code).toBe('not_found')
    expect((await s.call('sequences.delete', { slug: 'nightly' })).deleted).toBe(true)
    expect((await s.call('sequences.delete', { slug: 'nightly' }).catch((e) => e)).code).toBe('not_found')
    expect((await s.call('app.shell')).sequenceList).toEqual([])
  })

  it('edits the graph one operation at a time, answering with the graph after it', async () => {
    const s = await seqSetup()
    await s.call('sequences.create', { name: 'Graph' })
    const a = await s.call('sequences.graphOp', { slug: 'graph', op: { op: 'add', script: s.greet, x: 40, y: 40 } })
    const b = await s.call('sequences.graphOp', { slug: 'graph', op: { op: 'add', script: s.slow, x: 40, y: 160 } })
    expect([a.id, b.id]).toEqual(['s1', 's2'])
    expect(b.graph.steps.map((x: any) => x.name)).toEqual(['Greeter', 'Slow'])
    const link = await s.call('sequences.graphOp', { slug: 'graph', op: { op: 'link', from: 's1', to: 's2', when: 'always' } })
    expect(link.graph.links).toEqual([{ from: 's1', to: 's2', when: 'always' }])
    expect(link.graph.steps[1].incoming).toBe(1)
    const loop = await s.call('sequences.graphOp', { slug: 'graph', op: { op: 'link', from: 's2', to: 's1' } })
    expect(loop.ok).toBe(false)
    expect(loop.error).toMatch(/loop/)
    expect(loop.graph.links.length).toBe(1) // unchanged
    const moved = await s.call('sequences.graphOp', { slug: 'graph', op: { op: 'move', positions: { s1: [100, 100] } } })
    expect(moved.graph.steps[0]).toMatchObject({ x: 100, y: 100 })
    expect((await s.call('sequences.graphOp', { slug: 'graph', op: { op: 'add', script: 'ffffffffffff' } })).error).toMatch(/not in the open folder/)
    expect((await s.call('sequences.graphOp', { slug: 'graph', op: { op: 'unlink', from: 's2', to: 's1' } })).ok).toBe(false)
    const removed = await s.call('sequences.graphOp', { slug: 'graph', op: { op: 'remove', id: 's2' } })
    expect(removed.graph.links).toEqual([])
    expect((await s.call('sequences.graph', { slug: 'graph' })).steps.length).toBe(1)
    const detail = await s.call('sequences.get', { slug: 'graph' })
    expect(detail).toMatchObject({ activeRun: null, maxSteps: 50 })
    expect(detail.token).toMatch(/^[0-9a-f]{32}$/)
  })

  it('edits a step (values, preset, host, join) and validates', async () => {
    const s = await seqSetup()
    await s.call('sequences.create', { name: 'Steps' })
    await s.call('sequences.graphOp', { slug: 'steps', op: { op: 'add', script: s.greet } })
    const form = await s.call('sequences.step', { slug: 'steps', stepId: 's1' })
    expect(form.fields[0].name).toBe('who')
    expect(form.problem).toBeNull()
    expect(form.hosts).toContain('local')
    expect((await s.call('sequences.saveStep', { slug: 'steps', stepId: 's1', source: 'values', values: { who: 'step' }, join: 'any' })).ok).toBe(true)
    let g = await s.call('sequences.get', { slug: 'steps' })
    expect(g.seq.steps[0]).toMatchObject({ join: 'any', values: { who: 'step' } })
    expect(g.graph.steps[0].source).toBe('Saved with the step')
    expect((await s.call('sequences.saveStep', { slug: 'steps', stepId: 's1', host: 'bad host' })).error).toMatch(/listed hosts/)
    expect((await s.call('sequences.saveStep', { slug: 'steps', stepId: 's1', source: 'nope' })).error).toMatch(/preset was not found/)
    const preset = await s.call('presets.save', { scriptId: s.greet, name: 'P1', values: { who: 'from preset' } })
    expect((await s.call('sequences.saveStep', { slug: 'steps', stepId: 's1', source: preset.slug })).ok).toBe(true)
    g = await s.call('sequences.get', { slug: 'steps' })
    expect(g.graph.steps[0].source).toBe('Preset: P1')
    expect((await s.call('sequences.step', { slug: 'steps', stepId: 'zz' }).catch((e) => e)).code).toBe('not_found')
  })

  it('starts a sequence, reports its status and events, and stops it', async () => {
    const s = await seqSetup()
    await s.call('sequences.create', { name: 'Run it' })
    await s.call('sequences.graphOp', { slug: 'run-it', op: { op: 'add', script: s.slow } })
    await s.call('sequences.graphOp', { slug: 'run-it', op: { op: 'add', script: s.greet } })
    await s.call('sequences.graphOp', { slug: 'run-it', op: { op: 'link', from: 's1', to: 's2' } })

    const bad = await s.call('sequences.start', { slug: 'run-it', only: 'zz' })
    expect(bad).toMatchObject({ ok: false })
    const start = await s.call('sequences.start', { slug: 'run-it' })
    expect(start.ok).toBe(true)
    const rid = start.run
    expect(await waitFor(() => s.eventsOf('sequence.status').some((e) => e.id === rid), 5000)).toBe(true)
    const live = await s.call('sequences.runStatus', { id: rid })
    expect(live).toMatchObject({ active: true, total: 2 })
    expect(live.graph.links).toEqual([{ from: 's1', to: 's2', when: 'success' }])
    expect((await s.call('sequences.hold', { id: rid, step: 's2' })).ok).toBe(true)
    expect((await s.call('sequences.pause', { id: rid })).ok).toBe(true)
    expect((await s.call('sequences.resume', { id: rid })).ok).toBe(true)
    expect((await s.call('sequences.stop', { id: rid })).ok).toBe(true)
    expect(await waitFor(() => s.eventsOf('sequence.status').some((e) => e.id === rid && !e.active), 30000)).toBe(true)
    const done = await s.call('sequences.run', { id: rid })
    expect(done.run.status).toBe('cancelled')
    expect(done.seqExists).toBe(true)
    expect((await s.call('sequences.stop', { id: rid })).ok).toBe(false) // no longer running
    expect((await s.call('sequences.runs', { slug: 'run-it' })).length).toBe(1)
    expect((await s.call('runs.query', { kind: 'sequences' })).total).toBe(1)
    expect((await s.call('runs.query', { script: 'seq:run-it' })).total).toBeGreaterThanOrEqual(1)
    expect((await s.call('sequences.deleteRun', { id: rid })).deleted).toBe(true)
    expect((await s.call('sequences.runStatus', { id: rid }).catch((e) => e)).code).toBe('not_found')
  })

  it('refuses to start a sequence whose steps are not runnable', async () => {
    const s = await seqSetup()
    await s.call('sequences.create', { name: 'Empty' })
    const r = await s.call('sequences.start', { slug: 'empty' })
    expect(r).toEqual({ ok: false, errors: ['The sequence has no steps.'] })
  })
})

describe('settings', () => {
  it('returns the form as text, validation errors as data, and saves', async () => {
    const s = setup()
    const st = await s.call('settings.get')
    expect(st.form.interpreters).toContain(`.py=${PY}`)
    expect(st.form.max_concurrent_executions).toBe(3)
    expect(st.dataRows.map((r: any) => r.key)).toContain('history')
    expect(st.dataLocation.path).toBe(s.engine.dirs.runtime)

    const bad = await s.call('settings.save', { form: { ...st.form, max_concurrent_executions: 'lots', polling_interval: '10', interpreters: 'broken line', environment: '1x=a' } })
    expect(bad.ok).toBe(false)
    expect(bad.errors.join('\n')).toMatch(/Max concurrent executions must be a whole number/)
    expect(bad.errors.join('\n')).toMatch(/Interpreters, line 1: use the form key=value/)
    expect(bad.errors.join('\n')).toMatch(/Polling interval \(ms\) must be between/)
    expect(bad.errors.length).toBeGreaterThanOrEqual(4)
    expect(s.engine.config.load().polling_interval).toBe(2000) // nothing saved

    const ok = await s.call('settings.save', { form: { ...st.form, max_concurrent_executions: '5', environment: 'FOO=bar' } })
    expect(ok.ok).toBe(true)
    expect(s.engine.config.load()).toMatchObject({ max_concurrent_executions: 5, environment: { FOO: 'bar' } })
    expect(ok.form.environment).toBe('FOO=bar')
  })

  it('tests hosts, and clears one kind of data or all of it', async () => {
    const s = setup()
    expect((await s.call('settings.testHost', { host: 'local' })).message).toBe('Unknown SSH host.')
    expect((await s.call('settings.testHost', { host: 'nowhere' })).ok).toBe(false)
    const id = await opened(s)
    await s.call('presets.save', { scriptId: id, name: 'X', values: {} })
    const one = await s.call('settings.clear', { kind: 'presets' })
    expect(one.errors).toEqual([])
    expect(one.messages.length).toBe(1)
    expect((await s.call('presets.list', { scriptId: id })).presets).toEqual([])
    const bad = await s.call('settings.clear', { kind: 'bogus' })
    expect(bad.errors.length).toBe(1)
    const all = await s.call('settings.clear', { kind: 'all' })
    expect(all.errors).toEqual([])
    expect((await s.call('settings.dataOverview')).every((r: any) => r.bytes >= 0)).toBe(true)
  })
})

describe('project files and new script (the real services, and swappable ports)', () => {
  it('creates a script through the real NewScript service', async () => {
    const s = setup()
    await opened(s)
    const opts = await s.call('newScript.options', {})
    expect(opts.languages).toEqual([['.py', 'Python'], ['.sh', 'Shell']]) // local + remote interpreters
    expect(opts.maxDepth).toBe(3)
    const made = await s.call('newScript.create', { language: '.py', filename: 'made', name: 'Made one' })
    expect(made.ok).toBe(true)
    expect((await s.call('scripts.get', { id: made.id })).script.name).toBe('Made one')
    expect(fs.existsSync(path.join(s.scripts, 'made.py'))).toBe(true)
    const dup = await s.call('newScript.create', { language: '.py', filename: 'made' })
    expect(dup.ok).toBe(false)
    expect(dup.errors[0]).toMatch(/already exists/)
    expect((await s.call('newScript.create', { language: '.zzz', filename: 'a' })).errors[0]).toMatch(/Choose a language/)
    expect((await s.call('newScript.create', { language: '.py', filename: '../evil' })).ok).toBe(false)
    s.engine.workspace.closeFolder()
    expect((await s.call('newScript.create', { language: '.py', filename: 'x' }).catch((e) => e)).code).toBe('no_folder')
  })

  it('exports the open folder as a project, previews it and installs it elsewhere', async () => {
    const s = setup()
    await opened(s)
    const out = path.join(tmpDir('sh-api-out-'), 'demo.scripthub')
    const exp = await s.call('project.export', { name: 'Demo project', destination: out })
    expect(exp.path).toBe(out)
    expect(exp.report.files).toBeGreaterThanOrEqual(1)
    expect(fs.readFileSync(out).subarray(0, 2).toString()).toBe('PK')

    const pv = await s.call('project.open', { path: out })
    expect(pv).toMatchObject({ fileName: 'demo.scripthub', folderName: 'Demo project' })
    expect(pv.preview.name).toBe('Demo project')
    const dest = path.join(tmpDir('sh-api-dest-'), 'unpacked')
    const inst = await s.call('project.install', { token: pv.token, destination: dest })
    expect(inst.files).toBeGreaterThanOrEqual(1)
    expect(s.engine.workspace.same(s.engine.workspace.current()!, dest)).toBe(true)
    expect((await s.call('scripts.list')).scripts.map((x: any) => x.name)).toEqual(['Greeter'])
    // the token is used up
    expect((await s.call('project.install', { token: pv.token, destination: dest + '2' }).catch((e) => e)).code).toBe('invalid')

    const pv2 = await s.call('project.open', { path: out })
    expect((await s.call('project.cancel', { token: pv2.token })).ok).toBe(true)
    expect((await s.call('project.open', { path: path.join(s.scripts, 'greet.py') }).catch((e) => e)).code).toBe('invalid')
    expect((await s.call('project.open', { path: path.join(s.scripts, 'missing.scripthub') }).catch((e) => e)).code).toBe('invalid')
    expect(await s.call('project.samples')).toEqual([])
    expect((await s.call('project.close')).ok).toBe(true)
    expect(s.engine.workspace.current()).toBeNull()
  })

  it('answers unavailable when a host leaves a port unset, and delegates to a substitute', async () => {
    const s = setup()
    await opened(s)
    ;(s.engine as any).projects = undefined
    ;(s.engine as any).newScript = undefined
    for (const [n, a] of [['project.open', { path: 'x.scripthub' }], ['project.openSample', { name: 'x' }], ['project.install', { token: 't', destination: 'd' }],
      ['project.export', { destination: 'd' }], ['newScript.create', { language: '.py', filename: 'a' }]] as const)
      expect((await s.call(n, a).catch((e) => e)).code, n).toBe('unavailable')
    expect(await s.call('project.samples')).toEqual([])
    expect((await s.call('project.cancel', { token: 't' })).ok).toBe(true)

    const forgotten: string[] = []
    ;(s.engine as any).projects = {
      sampleProjects: () => [{ name: 'demo' }],
      saveUploadFromFile: (f: string) => { if (f.endsWith('bad.scripthub')) throw new Error('Not a project file'); return 'tok1' },
      importSample: () => 'tok2',
      uploadPath: (t: string) => `/uploads/${t}.scripthub`,
      inspect: (f: string) => ({ name: 'Demo project', file: f }),
      defaultDestination: (n: string) => `C:\proj\${n}`,
      install: (_f: string, dest: string) => { fs.mkdirSync(dest, { recursive: true }); return { folder: dest, files: 0, sequences: [], presets: 0, kept: [], warnings: [] } },
      forgetUpload: (t: string) => forgotten.push(t),
      saveCurrent: () => ({ bytes: new Uint8Array([1, 2]), fileName: 'f.scripthub', report: { files: 1 }, summary: '1 file' }),
    }
    expect(await s.call('project.samples')).toEqual([{ name: 'demo' }])
    expect(await s.call('project.openSample', { name: 'demo' })).toMatchObject({ token: 'tok2', fileName: 'demo.scripthub' })
    expect((await s.call('project.open', { path: 'bad.scripthub' }).catch((e) => e)).code).toBe('invalid')
    const dest = path.join(s.scripts, 'unpacked')
    expect((await s.call('project.install', { token: 'tok1', destination: dest })).folder).toBe(dest)
    expect(forgotten).toContain('tok1')
    const out = path.join(s.scripts, 'x.scripthub')
    expect((await s.call('project.export', { destination: out })).report).toMatchObject({ files: 1, summary: '1 file' })
    expect([...fs.readFileSync(out)]).toEqual([1, 2])

    ;(s.engine as any).newScript = { blocked: () => null, create: async (f: any) => ({ path: path.join(s.scripts, f.filename), id: 'aaaaaaaaaaaa' }) }
    expect(await s.call('newScript.create', { language: '.py', filename: 'q.py' })).toEqual({ ok: true, id: 'aaaaaaaaaaaa', path: path.join(s.scripts, 'q.py') })
    ;(s.engine as any).newScript = { blocked: () => 'Open a script folder first', create: async () => ({ path: '', id: '' }) }
    expect((await s.call('newScript.create', { language: '.py', filename: 'q' }).catch((e) => e)).code).toBe('no_folder')
  })
})

describe('client over a transport', () => {
  it('makeClient calls handlers and subscribes to events', async () => {
    const s = setup()
    const listeners = new Map<string, Array<(p: any) => void>>()
    const emitted: string[] = []
    const engine = s.engine
    const handlers = registerHandlers(engine, {}, (event, payload) => (listeners.get(event) ?? []).forEach((cb) => cb(payload)))
    toDispose.push(handlers)
    const client = makeClient({
      request: (name, args) => handlers.call(name, args),
      subscribe: <E extends EventName>(event: E, cb: (p: any) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), cb])
        return () => listeners.set(event, (listeners.get(event) ?? []).filter((x) => x !== cb))
      },
    })
    client.on('workspace.changed', (p) => emitted.push(p.reason))
    s.put('greet.py', GREET)
    const r = await client['workspace.open']({ paths: [s.scripts] })
    expect(r.opened.length).toBe(1)
    expect(emitted).toContain('open')
    expect((await client['app.info']({})).runtimeDir).toBe(engine.dirs.runtime)
    await expect(client['runs.status']({ id: 'RUN-20200101-001' })).rejects.toMatchObject({ code: 'not_found' })
  })
})
