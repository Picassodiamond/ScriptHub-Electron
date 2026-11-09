/**
 * A transport for `npm run dev:ui`: every page of the app shows data. The answers are the engine's real answers for the
 * sample scripts (demoData.json, rebuilt by packages/engine/test/demoFixtures.test.ts); what the user changes in the
 * page (create / rename / delete a sequence, star it, save settings) is kept in memory for the session.
 */
import type { ShellState } from '@scripthub/protocol'
import { demoTransport } from './demo.js'
import { MockTransport } from './mock.js'
import data from './demoData.json'

type Dict = Record<string, any>
const D = data as unknown as {
  global: Dict
  scripts: Record<string, Dict>
  runs: Record<string, Dict>
  sequences: Record<string, Dict>
  sequenceRuns: Record<string, Dict>
  projects: Record<string, Dict>
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const first = <T>(o: Record<string, T>): T => Object.values(o)[0]
const pick = <T>(o: Record<string, T>, key: unknown): T => (typeof key === 'string' && o[key]) || first(o)

export function richDemoTransport(): MockTransport {
  const shell: ShellState = clone(D.global['app.shell'])
  const t = demoTransport(shell)

  // ------------------------------------------------------------------ global
  for (const name of ['app.info', 'workspace.overview', 'scripts.tree', 'scripts.list', 'settings.dataOverview', 'project.samples', 'runs.running', 'runs.recent', 'runs.query', 'newScript.options'] as const)
    t.on(name, () => clone(D.global[name]))

  // ------------------------------------------------------------ sequences (in memory)
  let seqList: Dict[] = clone(D.global['sequences.list'].sequences)
  const seqRuns: Dict[] = clone(D.global['sequences.list'].runs)
  const firstSlug = Object.keys(D.sequences)[0]
  const known = (slug: unknown) => typeof slug === 'string' && !!D.sequences[slug]
  const syncShell = () => {
    shell.sequenceList = clone(seqList) as any
    shell.sequences = seqList.filter((s) => !s.error).map((s) => ({ slug: s.slug, name: s.name }))
  }
  t.on('app.shell', () => { syncShell(); return clone(shell) })
  t.on('sequences.list', () => ({ sequences: clone(seqList), runs: clone(seqRuns) }))
  t.on('sequences.create', ({ name }: Dict) => {
    const n = String(name ?? '').trim()
    if (!n) return { ok: false, error: 'Enter a name for the sequence.' }
    if (seqList.some((s) => s.name.toLowerCase() === n.toLowerCase())) return { ok: false, error: `A sequence named '${n}' already exists.` }
    let slug = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sequence'
    while (seqList.some((s) => s.slug === slug)) slug += '-2'
    seqList.push({ slug, name: n, steps: 0, saved_at: '', saved_display: '', error: '', favorite: false })
    return { ok: true, slug }
  })
  t.on('sequences.rename', ({ slug, name }: Dict) => {
    const s = seqList.find((x) => x.slug === slug)
    const n = String(name ?? '').trim()
    if (!s || !n) return { ok: false, error: 'Enter a name for the sequence.' }
    s.name = n
    return { ok: true }
  })
  t.on('sequences.delete', ({ slug }: Dict) => {
    const before = seqList.length
    seqList = seqList.filter((s) => s.slug !== slug)
    return { deleted: seqList.length < before }
  })
  t.on('sequences.favorite', ({ slug, on }: Dict) => {
    const s = seqList.find((x) => x.slug === slug)
    if (s) s.favorite = !!on
    return { ok: !!s }
  })

  const emptyGraph = () => ({ ...clone(D.sequences[firstSlug]['sequences.graph']), steps: [], links: [] })
  const detail = (slug: unknown) => {
    if (known(slug)) return clone(D.sequences[slug as string]['sequences.get'])
    const d = clone(D.sequences[firstSlug]['sequences.get'])
    const item = seqList.find((s) => s.slug === slug)
    return { ...d, seq: { ...d.seq, slug, name: item?.name ?? slug, steps: [], links: [] }, graph: emptyGraph(), runs: [], activeRun: null }
  }
  t.on('sequences.get', ({ slug }: Dict) => detail(slug))
  t.on('sequences.graph', ({ slug }: Dict) => (known(slug) ? clone(D.sequences[slug]['sequences.graph']) : emptyGraph()))
  t.on('sequences.graphOp', ({ slug }: Dict) => ({ ok: true, graph: known(slug) ? clone(D.sequences[slug]['sequences.graph']) : emptyGraph() }))
  t.on('sequences.step', ({ slug, stepId }: Dict) => {
    const steps = D.sequences[known(slug) ? slug : firstSlug].steps as Record<string, Dict>
    return clone(steps[stepId] ?? first(steps))
  })
  t.on('sequences.saveStep', () => ({ ok: true }))
  t.on('sequences.start', () => ({ ok: true, run: Object.keys(D.sequenceRuns)[0], token: `demo-${Date.now()}` }))
  t.on('sequences.runs', () => clone(seqRuns))
  t.on('sequences.run', ({ id }: Dict) => clone(pick(D.sequenceRuns, id)['sequences.run']))
  t.on('sequences.runStatus', ({ id }: Dict) => clone(pick(D.sequenceRuns, id)['sequences.runStatus']))
  for (const name of ['sequences.stop', 'sequences.pause', 'sequences.resume', 'sequences.hold', 'sequences.watchRun', 'sequences.unwatchRun'] as const)
    t.on(name, () => ({ ok: true }))
  t.on('sequences.deleteRun', () => ({ deleted: true }))

  // ---------------------------------------------------------------- scripts
  for (const name of ['scripts.get', 'scripts.doc', 'editor.read', 'runs.form', 'presets.list', 'presets.grid'] as const)
    t.on(name, (a: Dict) => clone(pick(D.scripts, a?.id ?? a?.scriptId)[name]))
  t.on('scripts.source', (a: Dict) => {
    const doc = pick(D.scripts, a?.id)['scripts.doc'] as Dict
    return clone(doc.source ?? { text: '', lines: [], truncated: false, error: null, language: 'python', size: 0 })
  })
  t.on('scripts.saveInfo', (a: Dict) => ({ ok: true, id: a?.id ?? '' }))
  t.on('scripts.saveParameters', (a: Dict) => ({ ok: true, id: a?.id ?? '' }))
  t.on('scripts.filePath', () => ({ path: 'C:/ScriptHub/samples/basics/hello.py', name: 'hello.py' }))
  t.on('scripts.setEnabledEditing', (a: Dict) => ({ enabled: !!a?.enabled }))
  t.on('editor.save', (a: Dict) => ({ ok: true, changed: true, warning: null, id: a?.id ?? '' }))
  t.on('editor.restore', (a: Dict) => ({ ok: true, id: a?.id ?? '' }))
  t.on('editor.versions', (a: Dict) => clone(pick(D.scripts, a?.id)['editor.read'].versions ?? []))
  t.on('editor.versionText', () => ({ text: '# an earlier version of the script (demo)\n' }))
  t.on('newScript.create', (a: Dict) => ({ ok: true, id: first(D.scripts)['scripts.get'].script?.id ?? 'demo', path: `C:/ScriptHub/samples/${a?.subfolder ? `${a.subfolder}/` : ''}${a?.filename ?? 'new.py'}` }))

  // ------------------------------------------------------------------- runs
  const firstRun = Object.keys(D.runs)[0]
  t.on('runs.start', () => ({ ok: true, runId: firstRun }))
  t.on('runs.console', ({ id }: Dict) => clone(pick(D.runs, id)['runs.console']))
  t.on('runs.status', ({ id, out = 0, err = 0 }: Dict) => {
    const s = clone(pick(D.runs, id)['runs.status'])
    if (out >= s.stdout_next) { s.stdout = ''; s.stdout_next = out }
    if (err >= s.stderr_next) { s.stderr = ''; s.stderr_next = err }
    return s
  })
  t.on('runs.stop', () => ({ stopped: false, active: false }))
  t.on('runs.stopTrace', () => ({ ok: false }))
  t.on('runs.debug', () => ({ ok: false, debug: null, error: 'Nothing is being debugged in the demo.' }))
  t.on('runs.logPath', (a: Dict) => ({ path: `C:/ScriptHub/runs/${a?.id ?? ''}/${a?.stream ?? 'stdout'}.log`, name: `${a?.id ?? 'run'}-${a?.stream ?? 'stdout'}.log` }))
  t.on('runs.watch', () => ({ ok: true }))
  t.on('runs.unwatch', () => ({ ok: true }))
  t.on('runs.delete', () => ({ deleted: true }))
  t.on('runs.deleteOlder', () => ({ runs: 0, sequences: 0 }))
  t.on('runs.applyRetention', () => ({ runs_removed: 0, logs_removed: 0, sequences_removed: 0 }))

  // ---------------------------------------------------------------- presets
  t.on('presets.save', () => ({ ok: true, slug: 'demo-preset', updated: false }))
  t.on('presets.rename', (a: Dict) => ({ ok: true, slug: String(a?.newName ?? 'demo').toLowerCase().replace(/[^a-z0-9]+/g, '-') }))
  t.on('presets.delete', () => ({ removed: true }))

  // --------------------------------------------------------------- settings
  let settings: Dict = clone(D.global['settings.get'])
  t.on('settings.get', () => clone(settings))
  t.on('settings.save', ({ form }: Dict) => {
    settings = { ...settings, form: { ...settings.form, ...form } }
    return { ok: true, form: clone(settings.form) }
  })
  t.on('settings.testHost', ({ host }: Dict) => ({ ok: true, message: `Connected to ${host ?? 'the host'} (demo).` }))
  t.on('settings.clear', ({ kind }: Dict) => ({ messages: [`Cleared ${kind ?? 'data'} (demo: nothing was deleted).`], errors: [] }))

  // ---------------------------------------------------------------- project
  t.on('project.open', () => clone(first(D.projects)))
  t.on('project.openSample', ({ name }: Dict) => clone(pick(D.projects, name)))
  t.on('project.install', () => ({ folder: 'C:/ScriptHub/samples', files: 12, sequences: ['Nightly checks'], presets: 2, kept: [], warnings: [] }))
  t.on('project.export', () => ({ path: 'C:/ScriptHub/project.scripthub', report: { summary: '12 files, 1 sequence, 2 presets' } }))
  t.on('project.cancel', () => ({ ok: true }))
  t.on('project.close', () => ({ ok: true }))

  // -------------------------------------------------------------------- app
  t.on('app.recover', () => ({ runs: [], sequences: [] }))
  t.on('app.reveal', () => ({ ok: false }))
  return t
}
