/**
 * End to end through the Engine facade: discover a script, start it from "form" values, read the history,
 * and run a sequence with success / failure arrows. Real python subprocesses, throwaway data folder.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine.js'
import { PY, waitFor } from './execCase.js'
import { tmpDir } from './helpers.js'

function setup() {
  const home = tmpDir('sh-engine-home-')
  const scripts = tmpDir('sh-engine-scripts-')
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ interpreters: { '.py': PY } }))
  const engine = new Engine({ runtimeDir: home, appDir: scripts, pythonExecutable: PY })
  const put = (name: string, body: string) => {
    fs.writeFileSync(path.join(scripts, name), body)
    return path.join(scripts, name)
  }
  return { engine, scripts, put }
}

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

const FAIL = `# --- scripthub ---
# name: Failer
# --- end scripthub ---
import sys
sys.exit(3)
`

describe('Engine end to end', () => {
  it('starts a discovered script from form values and records history and recent values', async () => {
    const { engine, scripts, put } = setup()
    put('greet.py', GREET)
    engine.workspace.openFolder(scripts)
    const [found] = await engine.discovery.scan(true)
    expect(found.map((s) => s.name)).toEqual(['Greeter'])
    const script = found[0]
    expect(script.metaValid).toBe(true)

    const bad = engine.runs.start(script, { raw: { who: '' } })
    expect(bad.ok).toBe(true) // empty text falls back to its default / is allowed

    const res = engine.runs.start(script, { raw: { who: 'electron' }, token: 'tok-1' })
    if (!res.ok) throw new Error(JSON.stringify(res))
    expect(await engine.manager.waitFinished(res.runId, 20000)).toBe(true)
    await engine.manager.waitIdle(20000)
    const meta = engine.history.readMeta(res.runId)!
    expect(meta.status).toBe('success')
    expect(fs.readFileSync(engine.history.logPath(res.runId, 'stdout'), 'utf8')).toContain('hello electron')

    // the same submit token does not start a second run
    const again = engine.runs.start(script, { raw: { who: 'electron' }, token: 'tok-1' })
    expect(again.ok && again.runId).toBe(res.runId)

    const recent = engine.presets.getRecent({ id: script.id, path: script.path }, 0)!
    expect(recent.values.who).toBe('electron')
    const [rows, total] = engine.historyOps.queryRuns({ scriptId: script.id })
    expect(total).toBeGreaterThanOrEqual(2)
    expect(rows[0].script_name).toBe('Greeter')
  })

  it('shows validation and host errors without starting anything', async () => {
    const { engine, scripts, put } = setup()
    put('greet.py', GREET)
    engine.workspace.openFolder(scripts)
    const script = (await engine.discovery.scan(true))[0][0]
    const r = engine.runs.start(script, { host: 'not-a-host', raw: { who: 'x' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.hostError).toMatch(/listed hosts/)
    expect(engine.manager.activeIds()).toEqual([])
  })

  it('runs a sequence: success arrow, failure arrow, and a skipped step', async () => {
    const { engine, scripts, put } = setup()
    const okPath = put('ok.py', GREET)
    const failPath = put('fail.py', FAIL)
    const cleanup = put('cleanup.py', GREET.replace('Greeter', 'Cleanup'))
    const never = put('never.py', GREET.replace('Greeter', 'Never'))
    engine.workspace.openFolder(scripts)
    const found = (await engine.discovery.scan(true))[0]
    const by = (p: string) => found.find((s) => s.path === fs.realpathSync(p))!

    const slug = engine.sequences.create('Pipeline')
    const mk = (script: any, x: number, y: number, values: Record<string, any> = {}) =>
      engine.sequences.addStep(slug, engine.sequences.newStep(script, values, '', x, y))
    const a = mk(by(okPath), 40, 40, { who: 'seq' })
    const f = mk(by(failPath), 40, 160)
    const c = mk(by(cleanup), 240, 160)
    const n = mk(by(never), 240, 280)
    engine.sequences.link(slug, a, f, 'success')
    engine.sequences.link(slug, f, c, 'failure') // runs because the failer failed
    engine.sequences.link(slug, f, n, 'success') // never applies: skipped

    const { items, errors } = engine.sequencer.prepare(engine.sequences.load(slug))
    expect(errors).toEqual([])
    const rid = engine.sequencer.start(engine.sequences.load(slug), items, 'test')
    expect(await engine.sequencer.waitIdle(60000)).toBe(true)

    const rec = engine.sequencer.readRun(rid)!
    const status = Object.fromEntries(rec.steps.map((s: any) => [s.id, s.status]))
    expect(status).toEqual({ [a]: 'success', [f]: 'failed', [c]: 'success', [n]: 'skipped' })
    expect(rec.status).toBe('success') // the failure was handled by a failure arrow
    const stepRun = engine.history.readMeta(rec.steps.find((s: any) => s.id === a).run_id)!
    expect(stepRun.sequence).toMatchObject({ run: rid, step: 1, name: 'Pipeline' })
    expect(engine.sequencer.liveView(rec).done).toBe(4)
  })

  it('fails a sequence whose failed step has no failure arrow, and refuses to start with bad steps', async () => {
    const { engine, scripts, put } = setup()
    const failPath = put('fail.py', FAIL)
    engine.workspace.openFolder(scripts)
    const script = (await engine.discovery.scan(true))[0].find((s) => s.path === fs.realpathSync(failPath))!
    const slug = engine.sequences.create('Bad')
    expect(engine.sequencer.prepare(engine.sequences.load(slug)).errors).toEqual(['The sequence has no steps.'])
    engine.sequences.addStep(slug, engine.sequences.newStep(script, {}))
    const { items } = engine.sequencer.prepare(engine.sequences.load(slug))
    const rid = engine.sequencer.start(engine.sequences.load(slug), items)
    await engine.sequencer.waitIdle(30000)
    const rec = engine.sequencer.readRun(rid)!
    expect(rec.status).toBe('failed')
    expect(rec.error).toMatch(/Step 1 \(Failer\) did not succeed/)

    fs.rmSync(failPath)
    await engine.discovery.scan(true)
    expect(engine.sequencer.prepare(engine.sequences.load(slug)).errors.join()).toMatch(/not found/)
  })

  it('pauses between steps and resumes, and a hold pauses before its step', async () => {
    const { engine, scripts, put } = setup()
    const slow = put('slow.py', '# --- scripthub ---\n# name: Slow\n# --- end scripthub ---\nimport time\ntime.sleep(1.0)\n')
    const quick = put('quick.py', GREET.replace('Greeter', 'Quick'))
    engine.workspace.openFolder(scripts)
    const found = (await engine.discovery.scan(true))[0]
    const by = (p: string) => found.find((s) => s.path === fs.realpathSync(p))!
    const slug = engine.sequences.create('Pausable')
    const a = engine.sequences.addStep(slug, engine.sequences.newStep(by(slow), {}, '', 0, 0))
    const b = engine.sequences.addStep(slug, engine.sequences.newStep(by(quick), { who: 'x' }, '', 0, 100))
    engine.sequences.link(slug, a, b)
    const data = engine.sequences.load(slug)
    const rid = engine.sequencer.start(data, engine.sequencer.prepare(data).items)
    expect(engine.sequencer.pause(rid)).toBe(true)
    expect(await waitFor(() => engine.sequencer.readRun(rid)!.steps[0].status === 'success', 15000)).toBe(true)
    await new Promise((r) => setTimeout(r, 1200))
    expect(engine.sequencer.readRun(rid)!.steps[1].status).toBe('pending') // paused: step 2 did not start
    expect(engine.sequencer.liveView(engine.sequencer.readRun(rid)!).status_label).toBe('Paused')
    expect(engine.sequencer.resume(rid)).toBe(true)
    expect(await engine.sequencer.waitIdle(30000)).toBe(true)
    expect(engine.sequencer.readRun(rid)!.status).toBe('success')

    const rid2 = engine.sequencer.start(data, engine.sequencer.prepare(data).items)
    expect(engine.sequencer.hold(rid2, b)).toBe(true)
    expect(await waitFor(() => engine.sequencer.readRun(rid2)!.held_at === b, 15000)).toBe(true)
    expect(engine.sequencer.readRun(rid2)!.steps[1].status).toBe('pending')
    engine.sequencer.cancel(rid2)
    await engine.sequencer.waitIdle(30000)
    expect(engine.sequencer.readRun(rid2)!.status).toBe('cancelled')
  })

  it('marks sequence runs of a dead owner as interrupted on recover()', () => {
    const { engine } = setup()
    const dir = path.join(engine.dirs.sequenceRuns, 'SEQ-20260101-001')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
      id: 'SEQ-20260101-001', sequence: 'x', name: 'X', status: 'running', owner_pid: 2 ** 22 + 12345,
      steps: [{ id: 's1', status: 'pending' }], links: [],
    }))
    expect(engine.recover().sequences).toEqual(['SEQ-20260101-001'])
    const rec = engine.sequencer.readRun('SEQ-20260101-001')!
    expect(rec.status).toBe('interrupted')
    expect(rec.steps[0].status).toBe('skipped')
  })
})
