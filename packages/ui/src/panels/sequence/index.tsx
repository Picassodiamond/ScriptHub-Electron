/**
 * The sequence editor: the diagram (scripts dragged in from the explorer, arrows between them), run / pause / resume / stop
 * in place with live step statuses, and the right-hand column (the sequence, a step's settings, or a step's console).
 * Port of templates/runner/sequence.html + the editor part of static/js/sequence.js. Better than before: undo / redo,
 * live status over events (no polling), keyboard nudging, a mini-map, and the step console without an iframe.
 */
import { useUid } from '../../core/ids'
import type { SequenceGraph, SequenceRunStatus } from '@scripthub/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Icon } from '../../components/Icon'
import { api, confirm, errorText, refreshShell, registerPanel, shell, toast, useApi, useCommand, useEvent, type PanelProps, openTab } from '../../core'
import { Diagram, type BoxAction, type DiagramHandle, type DiagramStep } from './Diagram'
import { RunsTable, statusClass } from './RunsTable'
import { StepConsole } from './StepConsole'
import { StepSettings } from './StepSettings'
import { tidyPositions, valuesOfFields, type Pt, type When } from './geometry'
import { UndoStack, type Entry, type Op, type StepSnap } from './undo'

type Overlay = Record<string, { status: string; status_label: string; run_id: string | null; error: string | null; hold: boolean; held: boolean }>
interface RunState {
  id: string | null
  active: boolean
  paused: boolean
  status?: string
  status_label?: string
  done?: number
  total?: number
  duration?: string
  error?: string | null
}
const NO_RUN: RunState = { id: null, active: false, paused: false }
const EMPTY: SequenceGraph = { steps: [], links: [], passwords: [] }

/** Passwords are typed in the right column as `pw_<step id>_<parameter>`; the engine wants {step id: {parameter: value}}. */
export function groupPasswords(values: Record<string, string>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const [input, v] of Object.entries(values)) {
    const rest = input.replace(/^pw_/, '')
    const i = rest.indexOf('_')
    if (i < 1) continue
    ;(out[rest.slice(0, i)] ??= {})[rest.slice(i + 1)] = v
  }
  return out
}

function SequenceEditor({ tab, active }: PanelProps) {
  const uid = useUid('sq')
  const slug = tab.id!
  const detail = useApi('sequences.get', { slug }, [slug])
  const [graph, setGraph] = useState<SequenceGraph>(EMPTY)
  const graphRef = useRef(graph)
  graphRef.current = graph
  const [name, setName] = useState(tab.title)
  const [token, setToken] = useState('')
  const [maxSteps, setMaxSteps] = useState(50)
  const [runs, setRuns] = useState<Array<Record<string, any>>>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [mode, setMode] = useState<'settings' | 'console'>('settings')
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [run, setRun] = useState<RunState>(NO_RUN)
  const runRef = useRef(run)
  runRef.current = run
  const overlayRef = useRef(overlay)
  overlayRef.current = overlay
  const pinned = useRef(false)
  const busy = useRef(0)
  const [starting, setStarting] = useState(false)
  const [pw, setPw] = useState<Record<string, string>>({})
  const [renaming, setRenaming] = useState(false)
  const handle = useRef<DiagramHandle>(null)
  const undo = useRef(new UndoStack())
  const [, bump] = useState(0)
  const rerender = () => bump((n) => n + 1)

  // ---------------------------------------------------------------- loading
  const applyGraph = useCallback((g: SequenceGraph) => {
    setGraph(g)
    setCurrent((c) => (c && !g.steps.some((s) => s.id === c) ? null : c))
  }, [])
  const refresh = useCallback(async () => {
    try { applyGraph(await api['sequences.graph']({ slug })) } catch { /* the next change retries */ }
  }, [slug, applyGraph])
  const loadRuns = useCallback(async () => {
    try { setRuns(await api['sequences.runs']({ slug, limit: 10 })) } catch { /* shown next time */ }
  }, [slug])

  useEffect(() => {
    const d = detail.data
    if (!d) return
    applyGraph(d.graph)
    setName(String(d.seq?.name ?? tab.title))
    setToken(d.token)
    setMaxSteps(d.maxSteps)
    setRuns(d.runs)
    if (d.activeRun && !runRef.current.active) void watch(d.activeRun)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data])

  // --------------------------------------------------------------- running
  const apply = useCallback((d: SequenceRunStatus) => {
    const was = runRef.current.active
    const ov: Overlay = {}
    for (const s of d.graph.steps) ov[s.id] = { status: s.status, status_label: s.status_label, run_id: s.run_id, error: s.error, hold: !!s.hold, held: !!s.held }
    setOverlay(ov)
    overlayRef.current = ov
    setRun({ id: d.id, active: d.active, paused: !!d.paused, status: d.status, status_label: d.status_label, done: d.done, total: d.total, duration: d.duration, error: d.error })
    runRef.current = { ...runRef.current, id: d.id, active: d.active, paused: !!d.paused }
    if (!pinned.current && (d.active || was)) follow(ov)
    if (was && !d.active) {
      if (d.status !== 'success') toast.error(d.status_label + (d.error ? `: ${d.error}` : '.'))
      void refresh()
      void loadRuns()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, loadRuns])

  async function watch(id: string): Promise<void> {
    pinned.current = false
    setRun({ id, active: true, paused: false })
    runRef.current = { id, active: true, paused: false }
    setOverlay({})
    overlayRef.current = {}
    try {
      await api['sequences.watchRun']({ id })
      apply(await api['sequences.runStatus']({ id }))
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  useEvent('sequence.status', (p) => { if (p.id === runRef.current.id) apply(p) })

  const follow = (ov: Overlay) => {
    let pick: { id: string; running: boolean } | null = null
    for (const s of graphRef.current.steps) {
      const o = ov[s.id]
      if (!o?.run_id) continue
      const running = o.status === 'running' || o.status === 'queued'
      if (!pick || !pick.running || running) pick = { id: s.id, running }
    }
    if (pick && !(currentRef.current === pick.id && modeRef.current === 'console')) openStep(pick.id, 'console', ov)
  }

  // ----------------------------------------------------- the right column
  const currentRef = useRef(current)
  currentRef.current = current
  const modeRef = useRef(mode)
  modeRef.current = mode

  function openStep(id: string | null, want?: 'settings' | 'console', ov: Overlay | null = overlayRef.current): void {
    if (!id) return closeStep()
    const o = ov?.[id]
    const hasRun = !!o?.run_id
    let m: 'settings' | 'console' = want ?? (hasRun ? 'console' : 'settings')
    if (m === 'console' && !hasRun) m = 'settings'
    if (m === 'settings' && runRef.current.active) {
      // settings are locked during a run
      setCurrent(id)
      if (!hasRun) return
      m = 'console'
    }
    setCurrent(id)
    setMode(m)
  }
  function closeStep(): void {
    setCurrent(null)
  }

  // ---------------------------------------------------------------- graph edits
  const send = useCallback(async (op: any) => {
    if (runRef.current.active) {
      toast.error('The sequence is running: stop it or wait before changing it.')
      return null
    }
    if (overlayRef.current) {
      // a change: the last run's statuses no longer describe the diagram
      setOverlay(null)
      overlayRef.current = null
      if (modeRef.current === 'console') setCurrent(null)
    }
    busy.current++
    try {
      const r = await api['sequences.graphOp']({ slug, op })
      applyGraph(r.graph)
      if (!r.ok) toast.error(r.error)
      return r
    } catch (e) {
      toast.error(errorText(e))
      void refresh()
      return null
    } finally {
      busy.current--
    }
  }, [slug, applyGraph, refresh])

  const stepOf = (id: string) => graphRef.current.steps.find((s) => s.id === id)

  /** Runs one symbolic operation through the engine; false when it failed. */
  const exec = useCallback(async (op: Op): Promise<boolean> => {
    if (op.t === 'move') return !!(await send({ op: 'move', positions: op.positions }))?.ok
    if (op.t === 'link') return !!(await send({ op: 'link', from: op.from, to: op.to, when: op.when }))?.ok
    if (op.t === 'unlink') return !!(await send({ op: 'unlink', from: op.from, to: op.to }))?.ok
    if (op.t === 'remove') return !!(await send({ op: 'remove', id: op.id }))?.ok
    const snap = op.snap
    const r = await send({ op: 'add', script: snap.script, x: snap.x, y: snap.y })
    if (!r?.ok || !r.id) return false
    const newId = r.id
    undo.current.remap(snap.id, newId)
    if (snap.values || snap.host || snap.join !== 'all' || snap.source !== 'values') {
      try {
        await api['sequences.saveStep']({ slug, stepId: newId, source: snap.source, host: snap.host, join: snap.join, ...(snap.source === 'values' && snap.values ? { values: snap.values } : {}) })
      } catch { /* the step is back, with default values */ }
    }
    for (const l of snap.links) {
      const from = l.from === snap.id ? newId : l.from
      const to = l.to === snap.id ? newId : l.to
      if (graphRef.current.steps.some((s) => s.id === from) && graphRef.current.steps.some((s) => s.id === to)) await send({ op: 'link', from, to, when: l.when })
    }
    await refresh()
    return true
  }, [send, slug, refresh])

  const doUndo = async (redo = false) => {
    const u = undo.current
    const entry = redo ? u.peekRedo() : u.peekUndo()
    if (!entry || runRef.current.active) return
    for (const op of redo ? entry.redo : entry.undo) {
      if (!(await exec(op))) {
        u.clear()
        rerender()
        return
      }
    }
    if (redo) u.doneRedo()
    else u.doneUndo()
    rerender()
    void refreshShell()
  }
  const record = (e: Entry) => { undo.current.push(e); rerender() }

  const onMove = (id: string, x: number, y: number) => {
    const s = stepOf(id)
    if (!s) return
    const before: Pt = [s.x, s.y]
    setGraph((g) => ({ ...g, steps: g.steps.map((t) => (t.id === id ? { ...t, x, y } : t)) })) // no jump back while the engine answers
    void send({ op: 'move', positions: { [id]: [x, y] } }).then((r) => {
      if (r?.ok) record({ label: 'move', undo: [{ t: 'move', positions: { [id]: before } }], redo: [{ t: 'move', positions: { [id]: [x, y] } }] })
    })
  }
  const onLink = (from: string, to: string, when: When) => {
    const prev = graphRef.current.links.find((k) => k.from === from && k.to === to)
    void send({ op: 'link', from, to, when }).then((r) => {
      if (r?.ok) record({ label: 'arrow', undo: [prev ? { t: 'link', from, to, when: prev.when } : { t: 'unlink', from, to }], redo: [{ t: 'link', from, to, when }] })
    })
  }
  const onUnlink = (from: string, to: string) => {
    const prev = graphRef.current.links.find((k) => k.from === from && k.to === to)
    void send({ op: 'unlink', from, to }).then((r) => {
      if (r?.ok && prev) record({ label: 'remove arrow', undo: [{ t: 'link', from, to, when: prev.when }], redo: [{ t: 'unlink', from, to }] })
    })
  }
  const onRemove = async (id: string) => {
    const s = stepOf(id)
    if (!s || runRef.current.active) return void (runRef.current.active && toast.error('The sequence is running: stop it or wait before changing it.'))
    if (!(await confirm({ message: `Remove step ${s.n} (${s.name}) and its arrows?`, danger: true, confirmLabel: 'Remove' }))) return
    // remember the step's settings so Undo can bring it back as it was
    let values: Record<string, any> | null = null
    let join = s.join || 'all'
    let source = s.source && s.source !== 'values' ? s.source : 'values'
    let host = ''
    try {
      const f = await api['sequences.step']({ slug, stepId: id })
      values = f.script && !f.problem ? valuesOfFields(f.fields) : null
      join = f.join || join
      source = f.source || source
      host = f.host || ''
    } catch { /* restored with default values */ }
    const snap: StepSnap = {
      id, script: s.script, x: s.x, y: s.y, host, join, source, values,
      links: graphRef.current.links.filter((k) => k.from === id || k.to === id).map((k) => ({ ...k })),
    }
    const r = await send({ op: 'remove', id })
    if (r?.ok) {
      record({ label: 'remove step', undo: [{ t: 'create', snap }], redo: [{ t: 'remove', id }] })
      void refreshShell()
    }
  }
  const onAdd = (script: string, x: number, y: number) => {
    if (!script) return
    if (graphRef.current.steps.length >= maxSteps) return void toast.error(`A sequence has at most ${maxSteps} steps.`)
    void send({ op: 'add', script, x, y }).then((r) => {
      if (r?.ok && r.id) {
        const id = r.id
        record({ label: 'add step', undo: [{ t: 'remove', id }], redo: [{ t: 'create', snap: { id, script, x, y, host: '', join: 'all', source: 'values', values: null, links: [] } }] })
        openStep(id)
        void refreshShell()
      }
    })
  }
  const tidy = () => {
    const steps = graphRef.current.steps
    if (!steps.length) return
    if (runRef.current.active) return void toast.error('The sequence is running: stop it or wait before changing it.')
    const pos = tidyPositions(steps, graphRef.current.links)
    const before = Object.fromEntries(steps.map((s) => [s.id, [s.x, s.y] as Pt]))
    setGraph((g) => ({ ...g, steps: g.steps.map((s) => (pos[s.id] ? { ...s, x: pos[s.id][0], y: pos[s.id][1] } : s)) }))
    handle.current?.fit()
    void send({ op: 'move', positions: pos }).then((r) => {
      if (r?.ok) record({ label: 'tidy up', undo: [{ t: 'move', positions: before }], redo: [{ t: 'move', positions: pos }] })
    })
  }

  // ------------------------------------------------------------------ run controls
  const play = async (only?: string) => {
    const r0 = runRef.current
    if (r0.active) {
      if (!only) void control(r0.paused ? 'sequences.resume' : 'sequences.pause')
      return
    }
    const g = graphRef.current
    if (!g.steps.length || starting) return
    const missing = g.passwords.filter((p) => p.required && !pw[p.input] && (!only || p.input.startsWith(`pw_${only}_`)))
    if (missing.length) {
      closeStep()
      toast.error('Enter the passwords in the right-hand column first (they are never saved).')
      document.getElementById(`${uid}-${missing[0].input}`)?.focus()
      return
    }
    setStarting(true)
    try {
      const r = await api['sequences.start']({ slug, ...(only ? { only } : {}), passwords: groupPasswords(pw), token })
      if (!r.ok) {
        toast.error(r.errors.slice(0, 3).join(' · ') + (r.errors.length > 3 ? ` · … and ${r.errors.length - 3} more` : ''))
        return
      }
      setToken(r.token)
      setPw({})
      await watch(r.run)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setStarting(false)
    }
  }

  const control = async (call: 'sequences.stop' | 'sequences.pause' | 'sequences.resume') => {
    const id = runRef.current.id
    if (!id) return
    if (call === 'sequences.stop' && !(await confirm({ message: 'Stop this sequence? The running steps are stopped and the remaining steps are skipped.', danger: true, confirmLabel: 'Stop' }))) return
    try {
      const r = await api[call]({ id })
      if (!r.ok && r.error) toast.error(r.error)
    } catch (e) {
      toast.error(errorText(e))
    }
    try { apply(await api['sequences.runStatus']({ id })) } catch { /* the event brings it */ }
  }

  const boxAction = (s: DiagramStep): BoxAction | null => {
    if (!run.active) return { icon: 'play', title: 'Run this step only' }
    if (s.status !== 'pending') return null
    return s.hold ? { icon: 'pause', title: 'The run pauses before this step: click to take that back', on: true } : { icon: 'pause', title: 'Pause the run before this step' }
  }
  const onBoxAction = async (id: string) => {
    const r = runRef.current
    if (!r.active) return void play(id)
    const o = overlayRef.current?.[id]
    if (!o || o.status !== 'pending' || !r.id) return
    const on = !o.hold
    const next = { ...overlayRef.current!, [id]: { ...o, hold: on } }
    setOverlay(next)
    overlayRef.current = next // at once; the next status confirms it
    try {
      const res = await api['sequences.hold']({ id: r.id, step: id, on })
      if (!res.ok && res.error) toast.error(res.error)
    } catch (e) {
      toast.error(errorText(e))
    }
    try { apply(await api['sequences.runStatus']({ id: r.id })) } catch { /* the event brings it */ }
  }

  const openScript = (id: string) => {
    const s = stepOf(id)
    if (!s) return
    const known = (shell.value?.tree ?? []).flatMap((g) => g.scripts).find((x) => x.id === s.script)
    if (!known) return void toast.error(`"${s.name}" is not in the open folder: open its folder to view it${s.path ? ` (${s.path}).` : '.'}`)
    openTab({ kind: 'script', id: s.script, title: known.name })
  }

  const rename = async (value: string) => {
    setRenaming(false)
    const v = value.trim()
    if (!v || v === name) return
    try {
      const r = await api['sequences.rename']({ slug, name: v })
      if (!r.ok) return void toast.error(r.error)
      setName(v)
      await refreshShell()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  // ------------------------------------------------------------ keyboard + misc
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)
      const mod = e.ctrlKey || e.metaKey
      if (mod && !typing && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void doUndo(e.shiftKey)
      } else if (mod && !typing && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        void doUndo(true)
      } else if (e.key === 'Escape' && currentRef.current && !e.defaultPrevented && !document.querySelector('.palette, dialog[open], .modal')) {
        if (runRef.current.active) pinned.current = true
        closeStep()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pw, token, starting])

  // Ctrl+Enter, `r` and Run > Run: run / pause / resume, like the toolbar button
  useCommand('run.run', () => void play(), active)

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (busy.current) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [])

  // ------------------------------------------------------------------ view
  const steps: DiagramStep[] = useMemo(() => graph.steps.map((s) => (overlay?.[s.id] ? { ...s, ...overlay[s.id] } : s)), [graph, overlay])
  const startsAtOnce = graph.steps.filter((s) => !graph.links.some((k) => k.to === s.id)).length
  const n = graph.steps.length
  const currentStep = current ? steps.find((s) => s.id === current) : null
  const hasRun = !!(currentStep && overlay?.[currentStep.id]?.run_id)
  const playLabel = !run.active ? 'Run' : run.paused ? 'Resume' : 'Pause'

  if (detail.error && !detail.data) return <div class="page"><div class="flash flash-error"><span>{detail.error}</span></div></div>

  return (
    <div class="seq-editor" data-slug={slug} data-testid="seq-editor">
      <section class="panel seq-board">
        <div class="seq-toolbar">
          <button
            type="button" id="seq-play" class={`btn btn-sm seq-play ${playLabel === 'Pause' ? '' : 'btn-primary'}`} disabled={(!run.active && !n) || starting}
            title={playLabel === 'Run' ? 'Run the sequence  (Ctrl+Enter)' : playLabel === 'Resume' ? 'Resume: the next steps start  (Ctrl+Enter)' : 'Pause: the running steps finish, the next ones wait  (Ctrl+Enter)'}
            onClick={() => void play()}
          >
            <Icon name={playLabel === 'Pause' ? 'pause' : 'play'} /><span>{playLabel}</span>
          </button>
          {run.active && (
            <button type="button" id="seq-stop" class="btn btn-sm btn-danger" title="Stop: the running steps are stopped, the rest are skipped" onClick={() => void control('sequences.stop')}>
              <Icon name="stop" /><span>Stop</span>
            </button>
          )}
          {run.id && (
            <a class="seq-live" id="seq-live" href="#" title="Open this run's page" onClick={(e) => { e.preventDefault(); openTab({ kind: 'sequence-run', id: run.id!, title: run.id! }) }}>
              <span class={statusClass({ status: run.status, paused: run.paused })}>{run.paused ? 'Paused' : run.status_label ?? 'Running'}</span>
              <span class="small muted">{run.done ?? 0}/{run.total ?? n} · {run.duration ?? ''}</span>
            </a>
          )}
          <span class="spacer" />
          <button type="button" class="btn btn-ghost btn-icon btn-sm" id="seq-undo" disabled={!undo.current.canUndo || run.active} title={undo.current.canUndo ? `Undo ${undo.current.undoLabel}  (Ctrl+Z)` : 'Nothing to undo'} aria-label="Undo" onClick={() => void doUndo(false)}>
            <svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
          </button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" id="seq-redo" disabled={!undo.current.canRedo || run.active} title={undo.current.canRedo ? `Redo ${undo.current.redoLabel}  (Ctrl+Shift+Z)` : 'Nothing to redo'} aria-label="Redo" onClick={() => void doUndo(true)}>
            <svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg>
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-seq="tidy" title="Lay the steps out in rows, following the arrows" disabled={!n || run.active} onClick={tidy}>Tidy up</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-seq="out" title="Zoom out  (Ctrl+wheel)" aria-label="Zoom out" onClick={() => handle.current?.zoom(1 / 1.2)}>−</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-seq="in" title="Zoom in  (Ctrl+wheel)" aria-label="Zoom in" onClick={() => handle.current?.zoom(1.2)}>+</button>
          <button type="button" class="btn btn-ghost btn-sm" data-seq="fit" title="Show all steps" onClick={() => handle.current?.fit()}>Fit</button>
        </div>
        <Diagram
          handle={handle} steps={steps} links={graph.links} editable locked={run.active} selected={current} viewKey={`sr.seqView.${slug}`}
          emptyTitle="Drag scripts here" emptyText="Drag scripts from the panel on the left onto this page, then connect them: drag the dot under a step onto the step that comes next."
          boxAction={boxAction} onBoxAction={(id) => void onBoxAction(id)}
          onSelect={(id) => { if (run.active) pinned.current = true; openStep(id) }}
          onOpen={openScript} onMove={onMove} onLink={onLink} onUnlink={onUnlink} onRemove={(id) => void onRemove(id)} onAdd={onAdd}
        />
        <div class="seq-hint small muted">Drag scripts here from the left · drag the dot under a step onto another step to connect them · click an arrow's label to change when it applies · double-click a step to open its script</div>
      </section>

      <aside class="seq-side" aria-label="Sequence">
        <div class="seq-side-main" id="seq-side-main" hidden={!!current}>
          <form class="panel" id="seq-run-form" autocomplete="off" onSubmit={(e) => { e.preventDefault(); void play() }}>
            <div class="panel-head">
              <Icon name="sequence" class="faint" />
              {renaming ? (
                <input
                  class="input input-sm seq-rename" autofocus defaultValue={name} aria-label="Sequence name" maxLength={60}
                  onKeyDown={(e) => { if (e.key === 'Enter') void rename((e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(false) }}
                  onBlur={(e) => void rename((e.target as HTMLInputElement).value)}
                />
              ) : <h2 class="seq-title" title={name}>{name}</h2>}
              <span class="spacer" />
              {!renaming && <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Rename" aria-label="Rename sequence" onClick={() => setRenaming(true)}><Icon name="edit" /></button>}
            </div>
            {graph.passwords.length > 0 && (
              <div class="panel-body" id="seq-passwords">
                <p class="small muted">Passwords are asked for each run and never saved.</p>
                {graph.passwords.map((p) => (
                  <div class="field" key={p.input}>
                    <label class="field-label" for={`${uid}-${p.input}`}>Step {p.step} · {p.script} · {p.label}{p.required && <span class="req" title="Required">*</span>}</label>
                    <input class="input" type="password" id={`${uid}-${p.input}`} name={p.input} autocomplete="new-password" value={pw[p.input] ?? ''} onInput={(e) => setPw((o) => ({ ...o, [p.input]: (e.target as HTMLInputElement).value }))} />
                  </div>
                ))}
              </div>
            )}
            <div class="panel-body small muted" id="seq-summary">
              {!n ? 'No steps yet: drag scripts onto the page.' : `${n} step${n === 1 ? '' : 's'}, ${startsAtOnce} starting at once (no arrow into them). Every step is checked before anything starts.`}
            </div>
          </form>
          {runs.length > 0 && (
            <section class="panel">
              <div class="panel-head"><h2>Runs of this sequence</h2></div>
              <RunsTable runs={runs} />
            </section>
          )}
        </div>

        <section class="panel seq-step-panel" id="seq-side-step" hidden={!current}>
          <div class="panel-head">
            <h2 id="seq-step-title">{currentStep ? `Step ${currentStep.n} · ${currentStep.name}${mode === 'console' ? ' · console' : ''}` : 'Step'}</h2>
            <span class="spacer" />
            {hasRun && !run.active && (
              <button type="button" class="btn btn-ghost btn-sm" id="seq-step-view" onClick={() => setMode(mode === 'console' ? 'settings' : 'console')}>{mode === 'console' ? 'Settings' : 'Console'}</button>
            )}
            <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Back to the sequence  (Esc)" aria-label="Close step" onClick={() => { if (run.active) pinned.current = true; closeStep() }}><Icon name="x" /></button>
          </div>
          <div class="seq-step-body">
            {current && mode === 'console' && overlay?.[current]?.run_id && <StepConsole key={overlay[current].run_id!} runId={overlay[current].run_id!} title={`Step ${currentStep?.n} · ${currentStep?.name}`} />}
            {current && mode === 'settings' && !run.active && <StepSettings key={current} slug={slug} stepId={current} onSaved={() => { void refresh(); void refreshShell() }} />}
          </div>
        </section>
      </aside>
    </div>
  )
}

registerPanel('sequence', SequenceEditor, { fill: true })
