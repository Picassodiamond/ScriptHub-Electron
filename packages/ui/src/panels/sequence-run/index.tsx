/**
 * One run of a sequence: status, the diagram as it was when the run started with each step's live status, and the console of
 * the selected (else the running) step. Port of templates/runner/sequence_run.html + the run page of static/js/sequence.js.
 * Live over `sequence.status` events instead of polling; every step can be opened as a run tab of its own.
 */
import type { SequenceRunStatus } from '@scripthub/protocol'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../../components/Icon'
import { api, closeTab, confirm, errorText, openTab, registerPanel, setTabStatus, shell, toast, useApi, useEvent, type PanelProps } from '../../core'
import { Diagram, type DiagramHandle, type DiagramStep } from '../sequence/Diagram'
import { statusClass } from '../sequence/RunsTable'
import { StepConsole } from '../sequence/StepConsole'

const toStatus = (run: Record<string, any>, graph: SequenceRunStatus['graph']): SequenceRunStatus => ({
  id: run.id, status: run.status, status_label: run.status_label, active: !!run.active, paused: !!run.paused, error: run.error ?? null,
  duration: run.duration, done: run.done ?? 0, total: (run.steps ?? []).length, graph,
})

function SequenceRunPage({ tab, active }: PanelProps) {
  const id = tab.id!
  const data = useApi('sequences.run', { id }, [id])
  // remember which sequence this run belongs to, so the Sequences side panel can highlight it (`params.sequence`)
  const slugOfRun = data.data?.run?.sequence
  useEffect(() => {
    if (typeof slugOfRun === 'string' && slugOfRun && tab.params.sequence !== slugOfRun) openTab({ kind: 'sequence-run', id, params: { sequence: slugOfRun } }, { background: true })
  }, [slugOfRun, id])
  const [st, setSt] = useState<SequenceRunStatus | null>(null)
  const [seqExists, setSeqExists] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const pinned = useRef(false)
  const handle = useRef<DiagramHandle>(null)
  const stRef = useRef(st)
  stRef.current = st

  const follow = useCallback((s: SequenceRunStatus) => {
    if (pinned.current) return
    let pick: { id: string; live: boolean } | null = null
    for (const x of s.graph.steps) {
      if (!x.run_id) continue
      const live = x.status === 'running' || x.status === 'queued'
      if (!pick || !pick.live || live) pick = { id: x.id, live }
    }
    if (pick) setSelected(pick.id)
  }, [])

  useEffect(() => {
    const d = data.data
    if (!d) return
    const s = toStatus(d.run, d.graph)
    setSt(s)
    setSeqExists(d.seqExists)
    follow(s)
    if (s.active) void api['sequences.watchRun']({ id }).catch(() => undefined)
  }, [data.data, id, follow])

  useEvent('sequence.status', (p) => {
    if (p.id !== id) return
    setSt(p)
    follow(p)
  })
  useEffect(() => () => { void api['sequences.unwatchRun']({ id }).catch(() => undefined) }, [id])

  // a fit once the diagram is there
  const fitted = useRef(false)
  useEffect(() => {
    if (st && !fitted.current && st.graph.steps.length) {
      fitted.current = true
      const t = setTimeout(() => handle.current?.fit(), 0)
      return () => clearTimeout(t)
    }
  }, [st])

  const control = async (call: 'sequences.stop' | 'sequences.pause' | 'sequences.resume') => {
    if (call === 'sequences.stop' && !(await confirm({ message: 'Stop this sequence? The running steps are stopped and the remaining steps are skipped.', danger: true, confirmLabel: 'Stop' }))) return
    try {
      const r = await api[call]({ id })
      if (!r.ok && r.error) toast.error(r.error)
      setSt(await api['sequences.runStatus']({ id }))
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const remove = async () => {
    if (!(await confirm({ message: `Delete the record of ${id}? The runs of its steps stay in History.`, danger: true, confirmLabel: 'Delete' }))) return
    try {
      const r = await api['sequences.deleteRun']({ id })
      if (!r.deleted) return void toast.error('A running sequence cannot be deleted.')
      toast.success('Run deleted.')
      closeTab(tab.key)
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const openScript = (stepId: string) => {
    const s = st?.graph.steps.find((x) => x.id === stepId)
    if (!s) return
    const known = (shell.value?.tree ?? []).flatMap((g) => g.scripts).find((x) => x.id === s.script)
    if (!known) return void toast.error(`"${s.name}" is not in the open folder: open its folder to view it${s.path ? ` (${s.path}).` : '.'}`)
    openTab({ kind: 'script', id: s.script, title: known.name })
  }

  const seqState = st ? (st.paused ? 'paused' : st.status) : null
  useEffect(() => {
    setTabStatus(tab.key, !seqState ? null : seqState === 'paused' ? 'paused' : seqState === 'running' || seqState === 'queued' ? 'running' : seqState === 'success' ? 'ok' : seqState === 'failed' || seqState === 'timed_out' ? 'failed' : 'other')
  }, [tab.key, seqState])
  useEffect(() => () => setTabStatus(tab.key, null), [tab.key])

  if (data.error && !st) return <div class="page"><div class="flash flash-error"><span>{data.error}</span></div></div>
  if (!st) return <div class="page"><p class="muted">Loading…</p></div>

  const run = data.data?.run ?? {}
  const steps: DiagramStep[] = st.graph.steps.map((s) => ({ ...s }))
  const sel = selected ? st.graph.steps.find((s) => s.id === selected) : null
  const done = st.graph.steps.filter((s) => ['success', 'failed', 'timed_out', 'cancelled', 'interrupted', 'skipped'].includes(s.status)).length

  return (
    <div class="seq-runpage" data-testid="seq-run-page" data-active={active ? '1' : undefined}>
      <section class="panel seq-runhead">
        <div class="panel-head">
          <Icon name="sequence" class="faint" />
          {seqExists && run.sequence
            ? <a class="strong" href="#" onClick={(e) => { e.preventDefault(); openTab({ kind: 'sequence', id: run.sequence, title: run.name }) }}>{run.name}</a>
            : <span class="strong">{run.name}</span>}
          <span class="mono small faint">{id}</span>
          <span class={statusClass({ status: st.status, paused: st.paused })} id="seq-status">{st.paused ? 'Paused' : st.status_label}</span>
          <span class="small muted" id="seq-progress">{done}/{st.total} steps · <span id="seq-duration">{st.duration}</span></span>
          <span class="spacer" />
          {st.active && !st.paused && <button type="button" class="btn btn-sm" id="seq-pause" title="The running steps finish, the next ones wait" onClick={() => void control('sequences.pause')}><Icon name="pause" /> Pause</button>}
          {st.active && st.paused && <button type="button" class="btn btn-sm btn-primary" id="seq-resume" onClick={() => void control('sequences.resume')}><Icon name="play" /> Resume</button>}
          {st.active && <button type="button" class="btn btn-sm btn-danger" id="seq-stop" onClick={() => void control('sequences.stop')}><Icon name="stop" /> Stop</button>}
          {!st.active && seqExists && run.sequence && (
            <button type="button" class="btn btn-sm" id="seq-again" onClick={() => openTab({ kind: 'sequence', id: run.sequence, title: run.name })}><Icon name="play" /> Run again…</button>
          )}
          {!st.active && <button type="button" class="btn btn-ghost btn-icon btn-sm" id="seq-delete" title="Delete this run's record" aria-label="Delete run" onClick={() => void remove()}><Icon name="trash" /></button>}
        </div>
        {st.error && <div class="panel-body small error-text" id="seq-error">{st.error}</div>}
      </section>

      <div class="seq-run">
        <section class="panel seq-board">
          <div class="seq-toolbar">
            <span class="small muted seq-hint">Click a step to see its console · double-click to open its script</span>
            <span class="spacer" />
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-seq="out" title="Zoom out  (Ctrl+wheel)" aria-label="Zoom out" onClick={() => handle.current?.zoom(1 / 1.2)}>−</button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-seq="in" title="Zoom in  (Ctrl+wheel)" aria-label="Zoom in" onClick={() => handle.current?.zoom(1.2)}>+</button>
            <button type="button" class="btn btn-ghost btn-sm" data-seq="fit" title="Show all steps" onClick={() => handle.current?.fit()}>Fit</button>
          </div>
          <Diagram
            handle={handle} steps={steps} links={st.graph.links} selected={selected}
            onSelect={(sid) => { const s = sid ? st.graph.steps.find((x) => x.id === sid) : null; if (s?.run_id) { pinned.current = true; setSelected(s.id) } }}
            onOpen={openScript}
          />
          <details class="seq-steps">
            <summary class="small muted">Steps ({st.graph.steps.length})</summary>
            <div class="table-wrap">
              <table class="table table-dense">
                <thead><tr><th class="num">#</th><th>Step</th><th>Status</th><th class="hide-sm">Host</th><th>Run</th></tr></thead>
                <tbody>
                  {st.graph.steps.map((s) => (
                    <tr key={s.id} class={s.id === selected ? 'is-selected' : ''}>
                      <td class="num mono small">{s.n}</td>
                      <td class="strong">{s.name}{s.error && <div class="small error-text">{s.error}</div>}</td>
                      <td><span class={`st st-${s.held ? 'paused' : s.status}`}>{s.held ? 'Paused here' : s.status_label}</span></td>
                      <td class="small hide-sm">{s.host}</td>
                      <td class="mono small">
                        {s.run_id ? <a href="#" onClick={(e) => { e.preventDefault(); openTab({ kind: 'run', id: s.run_id!, title: `${s.name} · ${s.run_id}` }) }}>{s.run_id}</a> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>

        <section class="panel seq-console">
          {sel?.run_id
            ? <StepConsole key={sel.run_id} runId={sel.run_id} title={`${sel.name} · ${sel.run_id}`} />
            : <div class="empty" id="seq-empty"><h2>No step has started yet</h2><p class="small">The console of the running step appears here.</p></div>}
        </section>
      </div>
    </div>
  )
}

registerPanel('sequence-run', SequenceRunPage, { fill: true })
