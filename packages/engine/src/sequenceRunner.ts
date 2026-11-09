/**
 * Running a sequence: steps connected by arrows, each step a normal run. Port of runner/sequence_runner.py
 * (see its docstring for the rules). Records live in runtime/sequence_runs/SEQ-YYYYMMDD-NNN/metadata.json.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Script } from './discovery.js'
import { ExecutionError, type ExecutionSpec } from './executor.js'
import { atomicWriteJson, readJson, sleepSync } from './fsutil.js'
import * as history from './history.js'
import * as parameters from './parameters.js'
import type { DataDirs } from './paths.js'
import type { ExecutionManager } from './processManager.js'
import type { Presets } from './presets.js'
import { GRID, type Link, type SequenceData, type Sequences, type Step } from './sequences.js'
import * as sshHosts from './sshHosts.js'
import type { RunService } from './runs.js'

const SEQ_RUN_RE = /^SEQ-\d{8}-\d{3,}$/
export const PENDING = 'pending'
export const SKIPPED = 'skipped'
export const STEP_LABELS: Record<string, string> = { ...history.STATUS_LABELS, [PENDING]: 'Pending', [SKIPPED]: 'Skipped' }
const TOKEN_TTL = 600_000
const FINAL_OR_SKIPPED = [...history.FINAL_STATUSES, SKIPPED]
const NODE_H = 60
const LAYER_GAP = 60

export const validRunId = (rid: unknown): rid is string => typeof rid === 'string' && SEQ_RUN_RE.test(rid)
type Rec = Record<string, any>
export interface PreparedStep { step: Step; script: Script; spec: ExecutionSpec }

/** True when the arrow lets its step run, false when it never will, null while its source has not finished. */
export function linkState(link: Link, statuses: Record<string, string>): boolean | null {
  const s = statuses[link.from]
  if (s === SKIPPED) return false
  if (s === history.SUCCESS) return link.when === 'success' || link.when === 'always'
  if (history.FINAL_STATUSES.includes(s)) return link.when === 'failure' || link.when === 'always'
  return null
}

/** 'run', 'skip' or null (wait) for a pending step, from the arrows leading into it. */
export function decide(step: { join?: string }, linksIn: Link[], statuses: Record<string, string>): 'run' | 'skip' | null {
  if (!linksIn.length) return 'run'
  const states = linksIn.map((k) => linkState(k, statuses))
  if (step.join === 'any') {
    if (states.some((s) => s === true)) return 'run'
    return states.every((s) => s === false) ? 'skip' : null
  }
  if (states.some((s) => s === false)) return 'skip'
  return states.every((s) => s === true) ? 'run' : null
}

class RunState {
  cancel = false
  pause = false
  holds = new Set<string>()
  current = new Set<string>()
  private waker: (() => void) | null = null
  wake(): void {
    this.waker?.()
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms)
      const self = this
      function done() {
        clearTimeout(t)
        self.waker = null
        resolve()
      }
      this.waker = done
    })
  }
}

export interface SequenceRunnerDeps {
  dirs: DataDirs
  manager: ExecutionManager
  history: history.History
  sequences: Sequences
  presets: Presets
  runs: RunService
}

export class SequenceRunner {
  private runs = new Map<string, RunState>()
  private tokens = new Map<string, { rid: string; at: number }>()
  private listeners = new Set<() => void>()

  constructor(private d: SequenceRunnerDeps) {}

  /** Called when a sequence run starts or finishes. Returns the unsubscribe function. */
  onChanged(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb()
      } catch {
        /* a failing listener must not stop the run */
      }
    }
  }

  // --------------------------------------------------------------- records ---
  runDir(rid: string): string {
    if (!validRunId(rid)) throw new Error('Invalid sequence run id')
    return path.join(this.d.dirs.sequenceRuns, rid)
  }

  private allocate(): string {
    fs.mkdirSync(this.d.dirs.sequenceRuns, { recursive: true })
    const t = new Date()
    const prefix = `SEQ-${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}-`
    let highest = 0
    for (const n of fs.readdirSync(this.d.dirs.sequenceRuns)) {
      if (n.startsWith(prefix)) {
        const v = parseInt(n.slice(prefix.length), 10)
        if (Number.isFinite(v)) highest = Math.max(highest, v)
      }
    }
    for (let n = highest + 1; ; n++) {
      const rid = `${prefix}${String(n).padStart(3, '0')}`
      try {
        fs.mkdirSync(path.join(this.d.dirs.sequenceRuns, rid))
        return rid
      } catch (e: any) {
        if (e?.code !== 'EEXIST') throw e
      }
    }
  }

  readRun(rid: string): Rec | null {
    if (!validRunId(rid)) return null
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const data = readJson(path.join(this.runDir(rid), 'metadata.json'))
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null
      } catch {
        if (!fs.existsSync(this.runDir(rid)) || attempt === 7) return null
        sleepSync(20)
      }
    }
    return null
  }

  private writeRun(rid: string, data: Rec): void {
    atomicWriteJson(path.join(this.runDir(rid), 'metadata.json'), data)
  }

  /** Update top-level fields and/or steps ({index: {field: value}}). */
  private updateRun(rid: string, fields: Rec = {}, steps: Record<number, Rec> = {}): Rec {
    const data = this.readRun(rid) ?? {}
    Object.assign(data, fields)
    for (const [i, change] of Object.entries(steps)) Object.assign(data.steps[Number(i)], change)
    this.writeRun(rid, data)
    return data
  }

  /** Sequence runs, newest first (optionally of one sequence). */
  listRuns(slug?: string, limit?: number): Rec[] {
    let names: string[]
    try {
      names = fs.readdirSync(this.d.dirs.sequenceRuns).filter(validRunId).sort().reverse()
    } catch {
      return []
    }
    const out: Rec[] = []
    for (const rid of names) {
      const data = this.readRun(rid)
      if (!data || (slug && data.sequence !== slug)) continue
      out.push(data)
      if (limit && out.length >= limit) break
    }
    return out
  }

  /** A run record of the first version (steps with on_failure) as a chain. */
  private asGraph(data: Rec): void {
    if ('links' in data) return
    const steps: Rec[] = data.steps ?? []
    const links: Rec[] = []
    steps.forEach((s, i) => {
      s.id ??= `s${i + 1}`
      s.x ??= 2 * GRID
      s.y ??= 2 * GRID + i * (NODE_H + LAYER_GAP)
      if (i) links.push({ from: steps[i - 1].id, to: s.id, when: steps[i - 1].on_failure === 'continue' ? 'always' : 'success' })
    })
    data.links = links
  }

  /** When a sequence run happened (History's dates, order and retention). */
  referenceTime(data: Rec): Date | null {
    for (const k of ['finished_at', 'started_at', 'queued_at']) {
      const t = history.parseIso(data[k])
      if (t) return t
    }
    return null
  }

  /** Delete one finished sequence run's record (its step runs stay in History). Active ones are refused. */
  deleteRun(rid: string): boolean {
    const data = this.readRun(rid)
    if (!data || history.ACTIVE_STATUSES.includes(data.status)) return false
    fs.rmSync(this.runDir(rid), { recursive: true, force: true })
    return true
  }

  /** Delete finished sequence-run records older than `days` days. Returns how many. */
  deleteOlderThan(days: number, now = new Date()): number {
    if (days < 0) return 0
    const cutoff = new Date(now.getTime() - days * 86400_000)
    let removed = 0
    for (const data of this.listRuns()) {
      const when = this.referenceTime(data)
      if (!history.ACTIVE_STATUSES.includes(data.status) && when && when < cutoff && this.deleteRun(data.id ?? '')) removed++
    }
    return removed
  }

  activeRuns(): Rec[] {
    return this.listRuns().filter((d) => history.ACTIVE_STATUSES.includes(d.status)).map((d) => this.liveView(d))
  }

  /** A sequence run for display: queued/running steps show their run's live status. */
  liveView(raw: Rec): Rec {
    const data: Rec = { ...raw, steps: (raw.steps ?? []).map((s: Rec) => ({ ...s })) }
    this.asGraph(data)
    for (const s of data.steps) {
      s.ext ??= path.extname(s.script_path || '').replace(/^\./, '').toLowerCase()
      if (s.run_id && !FINAL_OR_SKIPPED.includes(s.status)) {
        const meta = history.validRunId(s.run_id) ? this.d.history.readMeta(s.run_id) : null
        if (meta) s.status = meta.status ?? s.status
      }
      s.status_label = STEP_LABELS[s.status] ?? s.status
    }
    data.status_label = STEP_LABELS[data.status] ?? data.status
    data.active = history.ACTIVE_STATUSES.includes(data.status)
    data.paused = !!(data.active && data.paused)
    if (data.paused) data.status_label = 'Paused'
    const holds = new Set<string>(data.active ? data.holds ?? [] : [])
    for (const s of data.steps) {
      s.hold = holds.has(s.id)
      s.held = !!(data.paused && s.id === data.held_at)
      if (s.held) s.status_label = 'Paused here'
    }
    data.done = data.steps.filter((s: Rec) => FINAL_OR_SKIPPED.includes(s.status)).length
    data.started_display = String(data.started_at ?? '').replace('T', ' ').slice(0, 16)
    const started = history.parseIso(data.started_at)
    if (started) {
      const end = history.parseIso(data.finished_at) ?? new Date()
      data.duration = history.formatDuration(Math.max(0, (end.getTime() - started.getTime()) / 1000))
    } else data.duration = '—'
    return data
  }

  // --------------------------------------------------------------- prepare ---
  stepHost(step: Step, script: Script): string {
    return step.host || script.meta.host || sshHosts.LOCAL
  }

  passwordParams(script: Script): any[] {
    return script.metaValid ? (script.meta.parameters ?? []).filter((p: any) => p.type === 'password' && (p.editable_at_runtime ?? true)) : []
  }

  /** [raw values, warnings, error] for a step: from its preset or its stored values. */
  stepRaw(step: Step, script: Script): [Record<string, any>, string[], string | null] {
    const params = script.metaValid ? script.meta.parameters ?? [] : []
    let stored: any
    if (step.preset) {
      stored = this.d.presets.getPreset({ id: script.id, path: script.path }, step.preset)
      if (!stored) return [parameters.defaultsRaw(params), [], `the preset '${step.preset}' was not found`]
    } else stored = { values: step.values ?? {} }
    let [raw, warnings] = this.d.presets.applyPreset(params, stored)
    if (!step.preset) warnings = warnings.filter((w) => !w.includes('is new since')) // an unstored parameter takes its default
    return [raw, warnings, null]
  }

  /**
   * Resolve and validate every step before anything runs. `passwords`: {step id: {parameter name: value}}.
   * Returns the prepared steps (empty when there are errors) and the errors.
   */
  prepare(data: SequenceData, passwords: Record<string, Record<string, string>> = {}): { items: PreparedStep[]; errors: string[] } {
    const items: PreparedStep[] = []
    const errors: string[] = []
    if (!data.steps.length) errors.push('The sequence has no steps.')
    data.steps.forEach((step, i) => {
      const label = `Step ${i + 1} (${step.name || step.script})`
      const script = this.d.sequences.resolve(step) as Script | null
      if (!script) return void errors.push(`${label}: the script was not found (open its folder, or remove the step).`)
      if (!script.metaValid) return void errors.push(`${label}: the script's metadata is invalid (${script.metaError}).`)
      const params: any[] = script.meta.parameters ?? []
      const [raw, , err] = this.stepRaw(step, script)
      if (err) return void errors.push(`${label}: ${err}.`)
      for (const p of this.passwordParams(script)) raw[p.name] = passwords[step.id]?.[p.name] ?? ''
      const [values, fieldErrors] = parameters.cleanValues(params, raw)
      if (Object.keys(fieldErrors).length) {
        const labels = Object.fromEntries(params.map((p) => [p.name, p.label]))
        for (const [k, v] of Object.entries(fieldErrors)) errors.push(`${label}: ${labels[k] ?? k}: ${v}`)
        return
      }
      const host = this.stepHost(step, script)
      const hostError = this.d.runs.checkHost(script, host, sshHosts.allowedHosts([script.meta.host ?? sshHosts.LOCAL]))
      if (hostError) return void errors.push(`${label}: host '${host}': ${hostError}`)
      try {
        items.push({ step, script, spec: this.d.runs.buildSpec(script, host, params, values) })
      } catch (e) {
        if (!(e instanceof ExecutionError)) throw e
        errors.push(`${label}: ${e.message}`)
      }
    })
    return { items: errors.length ? [] : items, errors }
  }

  // ---------------------------------------------------------------- runner ---
  /** Start a prepared sequence; returns the sequence run id. A repeated `token` returns the same run. */
  start(data: SequenceData, items: PreparedStep[], initiator = 'local', token?: string | null): string {
    const now = Date.now()
    for (const [t, v] of this.tokens) if (now - v.at >= TOKEN_TTL) this.tokens.delete(t)
    if (token && this.tokens.has(token)) return this.tokens.get(token)!.rid // a double submit
    const rid = this.allocate()
    const links = (data.links ?? []).map((k) => ({ ...k }))
    this.writeRun(rid, {
      id: rid, sequence: data.slug, name: data.name, status: history.RUNNING, queued_at: history.nowIso(), started_at: history.nowIso(),
      finished_at: null, initiator, owner_pid: process.pid, error: null, links,
      steps: items.map(({ step, script, spec }, n) => ({
        index: n + 1, id: step.id, x: step.x, y: step.y, join: step.join ?? 'all', script_id: script.id, script_name: script.name,
        script_path: script.path, ext: path.extname(script.path).replace(/^\./, '').toLowerCase(), host: spec.host, status: PENDING,
        run_id: null, error: null,
      })),
    })
    const state = new RunState()
    this.runs.set(rid, state)
    if (token) this.tokens.set(token, { rid, at: now })
    void this.run(rid, data.name, items, links, initiator)
    this.notify()
    return rid
  }

  /** Stop a running sequence: the steps running now are stopped, the rest are skipped. */
  cancel(rid: string): boolean {
    const state = this.runs.get(rid)
    if (!state) return false
    state.cancel = true
    state.wake()
    for (const runId of [...state.current]) this.d.manager.cancel(runId)
    return true
  }

  /** Pause between steps: running steps finish, no new step starts until resume(). */
  pause(rid: string): boolean {
    const state = this.runs.get(rid)
    if (!state || state.cancel) return false
    state.pause = true
    this.updateRun(rid, { paused: true })
    return true
  }

  resume(rid: string): boolean {
    const state = this.runs.get(rid)
    if (!state || state.cancel) return false
    state.pause = false
    this.updateRun(rid, { paused: false, held_at: null })
    state.wake()
    return true
  }

  /** Pause the run before a step that has not started yet (or no longer). */
  hold(rid: string, stepId: string, on = true): boolean {
    const state = this.runs.get(rid)
    const data = state && !state.cancel ? this.readRun(rid) : null
    const step = (data?.steps ?? []).find((s: Rec) => s.id === stepId)
    if (!state || !step || step.status !== PENDING) return false
    if (on) state.holds.add(stepId)
    else state.holds.delete(stepId)
    this.updateRun(rid, { holds: [...state.holds].sort() })
    return true
  }

  isPaused(rid: string): boolean {
    return !!this.runs.get(rid)?.pause
  }

  isActive(rid: string): boolean {
    return this.runs.has(rid)
  }

  /** Resolves when no sequence is running (tests). */
  async waitIdle(timeoutMs = 30000): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (!this.runs.size) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  }

  private submitReady(
    rid: string, name: string, state: RunState, items: PreparedStep[], index: Record<string, number>,
    statuses: Record<string, string>, linksIn: Record<string, Link[]>, running: Map<string, string>, initiator: string,
  ): void {
    let changed = true
    while (changed) {
      changed = false
      for (const { step, spec } of items) {
        const sid = step.id
        if (statuses[sid] !== PENDING) continue
        const what = decide(step, linksIn[sid], statuses)
        if (what === 'skip') {
          statuses[sid] = SKIPPED
          this.updateRun(rid, {}, { [index[sid]]: { status: SKIPPED } })
          changed = true
          continue
        }
        if (what !== 'run' || state.pause) continue
        if (state.holds.has(sid)) {
          // ⏸ on this box: pause here, Resume starts it
          state.holds.delete(sid)
          state.pause = true
          this.updateRun(rid, { paused: true, held_at: sid, holds: [...state.holds].sort() })
          continue
        }
        if (state.cancel) return
        spec.sequence = { run: rid, step: index[sid] + 1, name }
        let runId: string
        try {
          runId = this.d.manager.submit(spec, initiator)
        } catch (e: any) {
          statuses[sid] = history.FAILED
          this.updateRun(rid, {}, { [index[sid]]: { status: history.FAILED, error: `Could not start: ${e?.message ?? e}` } })
          changed = true
          continue
        }
        state.current.add(runId)
        running.set(runId, sid)
        statuses[sid] = history.QUEUED
        this.updateRun(rid, {}, { [index[sid]]: { status: history.QUEUED, run_id: runId } })
      }
    }
  }

  private async run(rid: string, name: string, items: PreparedStep[], links: Link[], initiator: string): Promise<void> {
    const state = this.runs.get(rid)!
    const index = Object.fromEntries(items.map(({ step }, i) => [step.id, i]))
    const statuses: Record<string, string> = Object.fromEntries(items.map(({ step }) => [step.id, PENDING]))
    const linksIn: Record<string, Link[]> = Object.fromEntries(Object.keys(statuses).map((sid) => [sid, links.filter((k) => k.to === sid)]))
    const running = new Map<string, string>() // run id -> step id
    try {
      for (;;) {
        if (!state.cancel) this.submitReady(rid, name, state, items, index, statuses, linksIn, running, initiator)
        if (!running.size) {
          if (state.pause && !state.cancel && Object.values(statuses).some((v) => v === PENDING)) {
            await state.sleep(500) // paused with nothing running: wait for resume / stop
            continue
          }
          break
        }
        for (const runId of await this.d.manager.waitAny([...running.keys()], 1000)) {
          const sid = running.get(runId)!
          running.delete(runId)
          const meta = this.d.history.readMeta(runId) ?? {}
          let status: string = meta.status || history.FAILED
          if (!history.FINAL_STATUSES.includes(status)) status = history.FAILED
          statuses[sid] = status
          this.updateRun(rid, {}, { [index[sid]]: { status, error: meta.error ?? null } })
          state.current.delete(runId)
        }
      }
    } catch (e: any) {
      this.updateRun(rid, { error: `Internal error: ${e?.message ?? e}` })
      state.cancel = true
      for (const runId of running.keys()) this.d.manager.cancel(runId)
    } finally {
      this.finish(rid, state, links)
    }
  }

  private finish(rid: string, state: RunState, links: Link[]): void {
    const data = this.readRun(rid) ?? { steps: [] }
    const skipped: Record<number, Rec> = {}
    data.steps.forEach((s: Rec, i: number) => {
      if (!FINAL_OR_SKIPPED.includes(s.status)) skipped[i] = { status: SKIPPED }
    })
    const handled = new Set(links.filter((k) => k.when === 'failure').map((k) => k.from))
    const failed = data.steps.filter((s: Rec) => history.FINAL_STATUSES.includes(s.status) && s.status !== history.SUCCESS && !handled.has(s.id))
    const nSkipped = data.steps.filter((s: Rec) => s.status === SKIPPED).length + Object.keys(skipped).length
    const note = nSkipped ? ` ${nSkipped} step${nSkipped !== 1 ? 's were' : ' was'} skipped.` : ''
    let status: string
    let error: string | null
    if (state.cancel) [status, error] = [history.CANCELLED, data.error || 'Stopped by user.']
    else if (failed.length === 1) [status, error] = [history.FAILED, `Step ${failed[0].index} (${failed[0].script_name}) did not succeed.${note}`]
    else if (failed.length) [status, error] = [history.FAILED, `${failed.length} of ${data.steps.length} steps did not succeed.${note}`]
    else [status, error] = [history.SUCCESS, null]
    this.updateRun(rid, { status, error, finished_at: history.nowIso(), paused: false, held_at: null, holds: [] }, skipped)
    this.runs.delete(rid)
    this.notify()
  }

  /** Sequence runs left running by a stopped application are marked interrupted. */
  recoverInterrupted(): string[] {
    const fixed: string[] = []
    for (const data of this.listRuns()) {
      const rid = data.id
      if (!history.ACTIVE_STATUSES.includes(data.status) || !validRunId(rid) || this.isActive(rid)) continue
      if (data.owner_pid === process.pid || history.pidAlive(data.owner_pid)) continue
      const steps: Record<number, Rec> = {}
      ;(data.steps ?? []).forEach((s: Rec, i: number) => {
        if (s.status === PENDING) steps[i] = { status: SKIPPED }
      })
      this.updateRun(rid, { status: history.INTERRUPTED, finished_at: history.nowIso(), error: 'The application stopped before this sequence finished.' }, steps)
      fixed.push(rid)
    }
    return fixed
  }
}
